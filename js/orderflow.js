/* NIVA QUANT AI — orderflow.js
   Order flow from REAL aggTrades (executed trades only).
   Footprint aggregation is by price + time from TRADED volume — it is
   NOT resting liquidity (that lives in book.js). */
'use strict';

import { clamp } from './utils.js';

/* Aggressive buy/sell volume, bid/ask delta, CVD from aggTrades.
   isBuyerMaker=true means the buyer was the maker → aggressive seller. */
export function analyzeTrades(trades, largeTradeUsd = 50000) {
  if (!trades || !trades.length) {
    return { insufficient: true, reason: 'No trades returned.' };
  }
  let buyVol = 0, sellVol = 0, buyQty = 0, sellQty = 0;
  let largeBuy = 0, largeSell = 0, largeBuyUsd = 0, largeSellUsd = 0;
  const notionals = [];
  const cvdSeries = [];
  let cvd = 0;
  for (const t of trades) {
    const notional = t.price * t.qty;
    notionals.push(notional);
    if (t.isBuyerMaker) { sellVol += notional; sellQty += t.qty; cvd -= notional; }
    else { buyVol += notional; buyQty += t.qty; cvd += notional; }
    if (notional >= largeTradeUsd) {
      if (t.isBuyerMaker) { largeSell++; largeSellUsd += notional; }
      else { largeBuy++; largeBuyUsd += notional; }
    }
    cvdSeries.push({ t: t.time, cvd });
  }
  const total = buyVol + sellVol;
  const deltaRatio = total > 0 ? (buyVol - sellVol) / total : 0;
  const takerBuyRatio = total > 0 ? buyVol / total : 0.5;
  // CVD slope: compare first vs last third of the window.
  const n = cvdSeries.length;
  const third = Math.max(1, Math.floor(n / 3));
  const cvdStart = cvdSeries[third - 1].cvd;
  const cvdEnd = cvdSeries[n - 1].cvd;
  const cvdSlope = total > 0 ? (cvdEnd - cvdStart) / total : 0;
  return {
    insufficient: false,
    buyVol, sellVol, buyQty, sellQty, total,
    delta: buyVol - sellVol,
    deltaRatio, takerBuyRatio,
    cvd, cvdSlope, cvdSeries,
    largeBuy, largeSell, largeBuyUsd, largeSellUsd,
    tradeCount: trades.length,
    windowMs: trades.length > 1 ? trades[trades.length - 1].time - trades[0].time : 0,
    direction: deltaRatio > 0.05 ? 'bullish' : deltaRatio < -0.05 ? 'bearish' : 'neutral',
  };
}

/* Footprint: aggregate traded volume by price level within a time bucket.
   `tick` = price bucket size (derived from ATR if not given).
   Returns rows sorted by price desc: { price, bidVol, askVol, delta, total }. */
export function buildFootprint(trades, bucketMs, tick) {
  if (!trades || !trades.length) return { rows: [], buckets: [], tick: tick || 0 };
  if (!tick || tick <= 0) {
    const prices = trades.map((t) => t.price);
    const range = Math.max(...prices) - Math.min(...prices);
    tick = range > 0 ? range / 20 : Math.max(...prices) * 0.0001;
  }
  const buckets = new Map(); // bucketStart -> Map(priceLevel -> {bid, ask})
  for (const t of trades) {
    const b = Math.floor(t.time / bucketMs) * bucketMs;
    const level = Math.round(t.price / tick) * tick;
    if (!buckets.has(b)) buckets.set(b, new Map());
    const m = buckets.get(b);
    if (!m.has(level)) m.set(level, { bidVol: 0, askVol: 0, bidQty: 0, askQty: 0 });
    const row = m.get(level);
    if (t.isBuyerMaker) { row.bidVol += t.price * t.qty; row.bidQty += t.qty; }
    else { row.askVol += t.price * t.qty; row.askQty += t.qty; }
  }
  // Merge across buckets for the summary view.
  const merged = new Map();
  for (const m of buckets.values()) {
    for (const [level, r] of m) {
      if (!merged.has(level)) merged.set(level, { price: level, bidVol: 0, askVol: 0 });
      const row = merged.get(level);
      row.bidVol += r.bidVol;
      row.askVol += r.askVol;
    }
  }
  const rows = [...merged.values()].map((r) => ({
    ...r,
    delta: r.askVol - r.bidVol,
    total: r.askVol + r.bidVol,
  })).sort((a, b) => b.price - a.price);
  return {
    rows,
    buckets: [...buckets.keys()].sort((a, b) => a - b),
    bucketData: buckets,
    tick,
  };
}

/* Imbalance: a level is imbalanced when one side exceeds the other by
   `thresholdPct` (e.g. 300% = 3x). Diagonal imbalance compares a level's
   ask vs the level above's bid (classic footprint signal). */
export function findImbalances(rows, thresholdPct = 300) {
  const ratio = thresholdPct / 100;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.bidVol > 0 && r.askVol / r.bidVol >= ratio) {
      out.push({ price: r.price, type: 'stacked-bid', side: 'bull', askVol: r.askVol, bidVol: r.bidVol });
    } else if (r.askVol > 0 && r.bidVol / r.askVol >= ratio) {
      out.push({ price: r.price, type: 'stacked-ask', side: 'bear', askVol: r.askVol, bidVol: r.bidVol });
    }
    // Diagonal: this level's ask vs the level above's bid.
    if (i > 0) {
      const above = rows[i - 1];
      if (above.bidVol > 0 && r.askVol / above.bidVol >= ratio) {
        out.push({ price: r.price, type: 'diagonal-bid', side: 'bull', askVol: r.askVol, bidVol: above.bidVol });
      }
      if (r.bidVol > 0 && above.askVol / r.bidVol >= ratio) {
        out.push({ price: r.price, type: 'diagonal-ask', side: 'bear', askVol: above.askVol, bidVol: r.bidVol });
      }
    }
  }
  return out;
}

/* Delta divergence: price makes a new high/low while delta does not.
   Needs per-candle delta — computed from klines taker volumes when
   aggTrades history is unavailable. */
export function deltaDivergence(candles) {
  if (!candles || candles.length < 10) return { type: 'none', detail: 'Insufficient candles.' };
  const n = candles.length;
  const priceHigh1 = Math.max(...candles.slice(n - 10, n - 5).map((c) => c.h));
  const priceHigh2 = Math.max(...candles.slice(n - 5).map((c) => c.h));
  const priceLow1 = Math.min(...candles.slice(n - 10, n - 5).map((c) => c.l));
  const priceLow2 = Math.min(...candles.slice(n - 5).map((c) => c.l));
  const delta = (slice) => slice.reduce((s, c) => s + (2 * (c.takerBuyQuote || 0) - (c.quoteVol || 0)), 0);
  const d1 = delta(candles.slice(n - 10, n - 5));
  const d2 = delta(candles.slice(n - 5));
  if (priceHigh2 > priceHigh1 && d2 < d1) {
    return { type: 'bearish', detail: 'Price made a higher high but buy delta fell — buying is weakening.' };
  }
  if (priceLow2 < priceLow1 && d2 > d1) {
    return { type: 'bullish', detail: 'Price made a lower low but sell delta fell — selling is weakening.' };
  }
  return { type: 'none', detail: 'No delta divergence on the last 10 candles.' };
}

/* Absorption: large volume at a level with little price progress —
   aggressive flow is being absorbed by passive limit orders.
   Exhaustion: volume spike + shrinking range + delta flipping. */
export function absorptionExhaustion(candles, flow) {
  if (!candles || candles.length < 6) return { absorption: null, exhaustion: null };
  const last = candles[candles.length - 1];
  const prev = candles.slice(-6, -1);
  const avgRange = prev.reduce((s, c) => s + (c.h - c.l), 0) / prev.length;
  const avgVol = prev.reduce((s, c) => s + c.v, 0) / prev.length;
  const range = last.h - last.l;
  const volRatio = avgVol > 0 ? last.v / avgVol : 1;
  let absorption = null;
  if (volRatio > 1.5 && avgRange > 0 && range < avgRange * 0.8) {
    const side = flow && flow.deltaRatio > 0.1 ? 'sellers absorbing buys'
      : flow && flow.deltaRatio < -0.1 ? 'buyers absorbing sells' : 'two-sided absorption';
    absorption = {
      level: (last.h + last.l) / 2,
      volRatio: +volRatio.toFixed(2),
      detail: 'High volume (' + volRatio.toFixed(1) + 'x avg) with a narrow range — ' + side + '.',
    };
  }
  let exhaustion = null;
  const closesUp = candles.slice(-4).every((c, i, a) => i === 0 || c.c >= a[i - 1].c);
  const closesDn = candles.slice(-4).every((c, i, a) => i === 0 || c.c <= a[i - 1].c);
  if (volRatio > 1.8 && range < avgRange && ((closesUp && flow && flow.deltaRatio < 0) || (closesDn && flow && flow.deltaRatio > 0))) {
    exhaustion = {
      detail: 'Volume spike on a narrow range with delta against the move — trend may be exhausting.',
      volRatio: +volRatio.toFixed(2),
    };
  }
  return { absorption, exhaustion };
}

/* Volume clusters: price levels holding the most traded volume. */
export function volumeClusters(rows, topN = 5) {
  if (!rows || !rows.length) return [];
  const total = rows.reduce((s, r) => s + r.total, 0);
  return rows.slice()
    .sort((a, b) => b.total - a.total)
    .slice(0, topN)
    .map((r) => ({ price: r.price, total: r.total, pct: total > 0 ? r.total / total * 100 : 0, delta: r.delta }));
}

/* Point of control: the single highest-volume price level. */
export function pointOfControl(rows) {
  if (!rows || !rows.length) return null;
  return rows.reduce((best, r) => (r.total > (best ? best.total : -1) ? r : best), null);
}

export function flowScoreHint(flow) {
  if (!flow || flow.insufficient) return { score: 0, label: 'No orderflow data' };
  const s = clamp(Math.round(Math.abs(flow.deltaRatio) * 40 + Math.abs(flow.cvdSlope) * 20), 0, 20);
  return {
    score: s,
    label: flow.direction === 'bullish' ? 'Aggressive buying' : flow.direction === 'bearish' ? 'Aggressive selling' : 'Balanced flow',
  };
}
