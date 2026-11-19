/* NIVA QUANT AI — book.js
   Local order book: REST snapshot + incremental depth sync (Binance
   depth stream rules). Out-of-order / gap handling included.
   A wall is reported as resting size only — NEVER as guaranteed S/R:
   walls can be pulled in milliseconds. */
'use strict';

import { getDepth } from './binance.js';
import { logEvent } from './utils.js';

/* Binance depth-sync rules (fapi):
   - Snapshot gives lastUpdateId.
   - Drop any event with u <= lastUpdateId.
   - First processed event must have U <= lastUpdateId+1 <= u.
   - Every next event must have U == previous u + 1, else resync. */
export class LocalBook {
  constructor(symbol) {
    this.symbol = symbol;
    this.bids = new Map(); // price -> qty
    this.asks = new Map();
    this.lastUpdateId = null;
    this.synced = false;
    this.resyncs = 0;
    this.eventsSeen = 0;
    this.lastEventTs = null;
    this.spoofFlags = []; // { ts, side, price, detail }
    this._recentCancels = []; // { ts, side, price, qty }
  }

  async init() {
    const snap = await getDepth(this.symbol, 100);
    this.bids = new Map(snap.bids.map((b) => [b.price, b.qty]));
    this.asks = new Map(snap.asks.map((a) => [a.price, a.qty]));
    this.lastUpdateId = snap.lastUpdateId;
    this.synced = true;
    this.eventsSeen = 0;
    return this;
  }

  /* Apply one depthUpdate event { U, u, b: [[p,q]...], a: [[p,q]...] }.
     Returns 'ok' | 'dropped' | 'gap' (caller must resync on gap). */
  applyEvent(ev) {
    this.eventsSeen++;
    this.lastEventTs = Date.now();
    if (!this.synced || this.lastUpdateId === null) return 'not-ready';
    if (ev.u <= this.lastUpdateId) return 'dropped'; // stale
    if (ev.U > this.lastUpdateId + 1) {
      this.synced = false;
      this.resyncs++;
      logEvent('ws', 'Order book gap on ' + this.symbol + ' — resyncing', 'U=' + ev.U + ' last=' + this.lastUpdateId);
      return 'gap';
    }
    const applySide = (map, levels, side) => {
      for (const [pStr, qStr] of levels) {
        const price = +pStr, qty = +qStr;
        const prev = map.get(price) || 0;
        if (qty === 0) {
          map.delete(price);
          if (prev > 0) this._trackCancel(side, price, prev);
        } else {
          map.set(price, qty);
        }
      }
    };
    applySide(this.bids, ev.b || [], 'bid');
    applySide(this.asks, ev.a || [], 'ask');
    this.lastUpdateId = ev.u;
    return 'ok';
  }

  /* Spoofing-like behaviour: a large order placed and cancelled within
     2s, repeatedly at the same level. This is a heuristic flag on public
     book data — it is NOT proof of spoofing. */
  _trackCancel(side, price, qty) {
    const now = Date.now();
    this._recentCancels.push({ ts: now, side, price, qty });
    this._recentCancels = this._recentCancels.filter((c) => now - c.ts < 10000);
    const same = this._recentCancels.filter((c) => c.side === side && c.price === price);
    if (same.length >= 3) {
      const last = this.spoofFlags[this.spoofFlags.length - 1];
      if (!last || last.price !== price || now - last.ts > 30000) {
        this.spoofFlags.push({
          ts: now, side, price,
          detail: 'Large ' + side + ' size at ' + price + ' placed and pulled ' + same.length + 'x in 10s — treat this level with caution.',
        });
        this.spoofFlags = this.spoofFlags.slice(-20);
      }
    }
  }

  bestBid() {
    let best = -Infinity;
    for (const p of this.bids.keys()) if (p > best) best = p;
    return best === -Infinity ? null : best;
  }
  bestAsk() {
    let best = Infinity;
    for (const p of this.asks.keys()) if (p < best) best = p;
    return best === Infinity ? null : best;
  }
  mid() {
    const b = this.bestBid(), a = this.bestAsk();
    return b != null && a != null ? (b + a) / 2 : null;
  }
  spreadPct() {
    const b = this.bestBid(), a = this.bestAsk(), m = this.mid();
    if (b == null || a == null || !m) return null;
    return (a - b) / m * 100;
  }

  sortedBids(n = 20) {
    return [...this.bids.entries()].sort((x, y) => y[0] - x[0]).slice(0, n)
      .map(([price, qty]) => ({ price, qty }));
  }
  sortedAsks(n = 20) {
    return [...this.asks.entries()].sort((x, y) => x[0] - y[0]).slice(0, n)
      .map(([price, qty]) => ({ price, qty }));
  }

  /* Depth $ within pct of mid + imbalance. */
  quality(pct = 0.01) {
    const mid = this.mid();
    if (mid == null) return { depthUsd: 0, imbalance: 50, bidUsd: 0, askUsd: 0 };
    const lo = mid * (1 - pct), hi = mid * (1 + pct);
    let bidUsd = 0, askUsd = 0;
    for (const [p, q] of this.bids) if (p >= lo) bidUsd += p * q;
    for (const [p, q] of this.asks) if (p <= hi) askUsd += p * q;
    const total = bidUsd + askUsd;
    return {
      depthUsd: total, bidUsd, askUsd,
      imbalance: total > 0 ? 100 * bidUsd / total : 50,
    };
  }

  /* Walls: single levels holding >= `multiple` x the median level size.
     Reported as resting size only — a wall can vanish before price
     reaches it, so it is never presented as guaranteed support/resistance. */
  walls(multiple = 5, topN = 5) {
    const sizes = [...this.bids.values(), ...this.asks.values()].sort((a, b) => a - b);
    if (!sizes.length) return [];
    const median = sizes[Math.floor(sizes.length / 2)] || 0;
    const threshold = median * multiple;
    const out = [];
    for (const [p, q] of this.bids) {
      if (q >= threshold) out.push({ price: p, qty: q, usd: p * q, side: 'bid', multiple: median > 0 ? q / median : 0 });
    }
    for (const [p, q] of this.asks) {
      if (q >= threshold) out.push({ price: p, qty: q, usd: p * q, side: 'ask', multiple: median > 0 ? q / median : 0 });
    }
    return out.sort((a, b) => b.usd - a.usd).slice(0, topN);
  }

  /* Concentration: share of depth held by the top 3 levels per side. */
  concentration() {
    const top = (map) => {
      const arr = [...map.entries()].map(([p, q]) => p * q).sort((a, b) => b - a);
      const total = arr.reduce((s, v) => s + v, 0);
      const top3 = arr.slice(0, 3).reduce((s, v) => s + v, 0);
      return total > 0 ? top3 / total * 100 : 0;
    };
    return { bidTop3Pct: top(this.bids), askTop3Pct: top(this.asks) };
  }

  get spoof() { return this.spoofFlags.slice(-5); }
}
