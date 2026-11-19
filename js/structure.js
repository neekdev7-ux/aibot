/* NIVA QUANT AI — structure.js
   Market structure from closed candles ONLY (non-repainting):
   swing H/L, BOS/CHoCH, HH/HL/LH/LL, S/R, liquidity pools, sweeps,
   FVG, order blocks, premium/discount, trend + sideways detection.
   Every feature is labelled confirmed (closed-candle) vs developing. */
'use strict';

import { atr } from './indicators.js';

/* Swing highs/lows with a confirmation window: a swing is only
   confirmed once `left` candles exist on both sides of the extreme.
   The last `left` candles can only hold developing swings. */
export function findSwings(candles, left = 2, right = 2) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isH = false;
      if (candles[j].l <= candles[i].l) isL = false;
    }
    if (isH) highs.push({ idx: i, price: candles[i].h, t: candles[i].t, confirmed: true });
    if (isL) lows.push({ idx: i, price: candles[i].l, t: candles[i].t, confirmed: true });
  }
  return { highs, lows };
}

/* Developing (unconfirmed) swing candidates at the right edge. */
export function developingSwings(candles, left = 2) {
  const out = { high: null, low: null };
  if (candles.length < left + 1) return out;
  const tail = candles.slice(-left - 1);
  let h = -Infinity, l = Infinity, hi = -1, li = -1;
  tail.forEach((c, k) => {
    if (c.h > h) { h = c.h; hi = k; }
    if (c.l < l) { l = c.l; li = k; }
  });
  out.high = { idx: candles.length - left - 1 + hi, price: h, t: tail[hi].t, confirmed: false };
  out.low = { idx: candles.length - left - 1 + li, price: l, t: tail[li].t, confirmed: false };
  return out;
}

/* HH/HL/LH/LL classification of the last two swing pairs. */
export function swingPattern(swings) {
  const { highs, lows } = swings;
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const ll = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
  const hl = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
  if (hh && hl) return 'HH/HL';
  if (ll && lh) return 'LL/LH';
  if (hh) return 'HH';
  if (ll) return 'LL';
  if (hl) return 'HL';
  if (lh) return 'LH';
  return '—';
}

/* BOS / CHoCH detection on closed candles.
   Bullish BOS: close above the last confirmed swing high while the
   prior structure was bullish. CHoCH: close above the last swing high
   after bearish structure (or vice versa). */
export function detectBosChoch(candles, swings) {
  const events = [];
  const { highs, lows } = swings;
  if (!highs.length || !lows.length) return events;
  // Walk closes; track the most recent broken level.
  let lastHigh = highs[0], lastLow = lows[0];
  let bias = null; // 'bull' | 'bear' — set by the first break
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const hiBefore = highs.filter((h) => h.idx < i).pop();
    const loBefore = lows.filter((l) => l.idx < i).pop();
    if (hiBefore) lastHigh = hiBefore;
    if (loBefore) lastLow = loBefore;
    if (c.c > lastHigh.price && lastHigh.idx < i) {
      const type = bias === 'bear' ? 'CHoCH' : 'BOS';
      events.push({ idx: i, t: c.t, type, dir: 'bull', level: lastHigh.price });
      bias = 'bull';
    } else if (c.c < lastLow.price && lastLow.idx < i) {
      const type = bias === 'bull' ? 'CHoCH' : 'BOS';
      events.push({ idx: i, t: c.t, type, dir: 'bear', level: lastLow.price });
      bias = 'bear';
    }
  }
  // Keep only the most recent event per break (dedupe consecutive closes
  // beyond the same level).
  const deduped = [];
  for (const e of events) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.type === e.type && prev.dir === e.dir && prev.level === e.level) continue;
    deduped.push(e);
  }
  return deduped;
}

/* Support/resistance: cluster confirmed swing levels within ATR*0.25. */
export function supportResistance(candles, swings, maxLevels = 6) {
  const a = atr(candles) || 0;
  const tol = Math.max(a * 0.25, 1e-12);
  const price = candles[candles.length - 1].c;
  const levels = [];
  const all = [
    ...swings.highs.map((h) => ({ price: h.price, kind: 'resistance', t: h.t })),
    ...swings.lows.map((l) => ({ price: l.price, kind: 'support', t: l.t })),
  ];
  all.sort((x, y) => x.price - y.price);
  for (const lv of all) {
    const near = levels.find((g) => Math.abs(g.price - lv.price) <= tol);
    if (near) { near.touches++; near.lastT = lv.t; }
    else levels.push({ price: lv.price, touches: 1, lastT: lv.t });
  }
  return levels
    .map((g) => ({
      price: g.price,
      touches: g.touches,
      kind: g.price > price ? 'resistance' : 'support',
      distancePct: price ? (g.price - price) / price * 100 : 0,
    }))
    .sort((x, y) => Math.abs(x.distancePct) - Math.abs(y.distancePct))
    .slice(0, maxLevels)
    .sort((x, y) => x.price - y.price);
}

/* Liquidity pools: clusters of swing highs (buy-side, above price) and
   swing lows (sell-side, below price) — resting stop clusters inferred
   from structure, not from the order book. */
export function liquidityPools(candles, swings) {
  const price = candles[candles.length - 1].c;
  const a = atr(candles) || 0;
  const tol = Math.max(a * 0.3, 1e-12);
  function cluster(points) {
    const sorted = points.slice().sort((x, y) => x.price - y.price);
    const groups = [];
    for (const p of sorted) {
      const g = groups.find((x) => Math.abs(x.price - p.price) <= tol);
      if (g) { g.count++; g.price = (g.price * (g.count - 1) + p.price) / g.count; }
      else groups.push({ price: p.price, count: 1 });
    }
    return groups.filter((g) => g.count >= 2).sort((x, y) => y.count - x.count);
  }
  return {
    buySide: cluster(swings.highs.filter((h) => h.price > price)),
    sellSide: cluster(swings.lows.filter((l) => l.price < price)),
  };
}

/* Sweep: a candle wicks beyond a pool level but closes back inside.
   Bullish sweep = sell-side liquidity taken (wick below, close above).
   Only closed candles — a sweep is confirmed at the close. */
export function detectSweeps(candles, pools) {
  const sweeps = [];
  if (!candles.length) return sweeps;
  const a = atr(candles) || 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    for (const pool of pools.sellSide) {
      if (c.l < pool.price && c.c > pool.price && c.c > c.o) {
        sweeps.push({ idx: i, t: c.t, dir: 'bull', level: pool.price, depth: pool.price - c.l, atr: a });
      }
    }
    for (const pool of pools.buySide) {
      if (c.h > pool.price && c.c < pool.price && c.c < c.o) {
        sweeps.push({ idx: i, t: c.t, dir: 'bear', level: pool.price, depth: c.h - pool.price, atr: a });
      }
    }
  }
  // Most recent sweep per direction, deduped by candle.
  const byIdx = new Map();
  for (const s of sweeps) byIdx.set(s.idx + s.dir, s);
  return [...byIdx.values()].sort((x, y) => y.idx - x.idx);
}

/* Fair value gaps: 3-candle imbalance (candle i-2 high < candle i low
   for bullish). Mitigation = a later close filling the gap. */
export function findFvg(candles, maxAge = 100) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2], b = candles[i - 1], c = candles[i];
    if (a.h < c.l) {
      fvgs.push({ idx: i, t: c.t, dir: 'bull', top: c.l, bottom: a.h, mid: (a.h + c.l) / 2, mitigated: false });
    } else if (a.l > c.h) {
      fvgs.push({ idx: i, t: c.t, dir: 'bear', top: a.l, bottom: c.h, mid: (a.l + c.h) / 2, mitigated: false });
    }
  }
  // Mitigation check: any later close inside the gap.
  for (const f of fvgs) {
    for (let j = f.idx + 1; j < candles.length; j++) {
      if (candles[j].c >= f.bottom && candles[j].c <= f.top) { f.mitigated = true; break; }
    }
  }
  const recent = fvgs.filter((f) => candles.length - f.idx <= maxAge);
  return recent.sort((x, y) => y.idx - x.idx);
}

/* Order blocks: the last opposite candle before a BOS displacement.
   Bullish OB = last down candle before a bullish BOS. */
export function findOrderBlocks(candles, bosEvents, maxAge = 100) {
  const obs = [];
  for (const e of bosEvents) {
    if (e.dir === 'bull') {
      for (let j = e.idx - 1; j >= Math.max(0, e.idx - 5); j--) {
        if (candles[j].c < candles[j].o) {
          obs.push({ idx: j, t: candles[j].t, dir: 'bull', top: candles[j].h, bottom: candles[j].l, bosIdx: e.idx, mitigated: false });
          break;
        }
      }
    } else {
      for (let j = e.idx - 1; j >= Math.max(0, e.idx - 5); j--) {
        if (candles[j].c > candles[j].o) {
          obs.push({ idx: j, t: candles[j].t, dir: 'bear', top: candles[j].h, bottom: candles[j].l, bosIdx: e.idx, mitigated: false });
          break;
        }
      }
    }
  }
  for (const ob of obs) {
    for (let j = ob.idx + 1; j < candles.length; j++) {
      const c = candles[j];
      if (ob.dir === 'bull' && c.l <= ob.top && c.c < ob.bottom) { ob.mitigated = true; break; }
      if (ob.dir === 'bear' && c.h >= ob.bottom && c.c > ob.top) { ob.mitigated = true; break; }
    }
  }
  return obs.filter((o) => candles.length - o.idx <= maxAge).sort((x, y) => y.idx - x.idx);
}

/* Premium/discount relative to the recent swing range (equilibrium 0.5). */
export function premiumDiscount(candles, swings) {
  const price = candles[candles.length - 1].c;
  const highs = swings.highs.slice(-5), lows = swings.lows.slice(-5);
  if (!highs.length || !lows.length) return { zone: 'unknown', position: 0.5, high: null, low: null };
  const high = Math.max(...highs.map((h) => h.price));
  const low = Math.min(...lows.map((l) => l.price));
  const range = high - low;
  if (range <= 0) return { zone: 'unknown', position: 0.5, high, low };
  const position = (price - low) / range;
  return {
    zone: position > 0.5 ? 'premium' : position < 0.5 ? 'discount' : 'equilibrium',
    position, high, low, equilibrium: (high + low) / 2,
  };
}

/* Trend + sideways detection from structure + ADX.
   Sideways: range-bound — price oscillating inside the swing range with
   weak ADX and no fresh BOS in the lookback. */
export function detectTrend(candles, swings, bosEvents, adxValue) {
  const pattern = swingPattern(swings);
  const recentBos = bosEvents.filter((e) => candles.length - e.idx <= 20);
  const lastBos = recentBos[recentBos.length - 1] || null;
  const pd = premiumDiscount(candles, swings);
  const range = pd.high != null && pd.low != null ? (pd.high - pd.low) / pd.low : 0;
  const a = atr(candles) || 0;
  const price = candles[candles.length - 1].c;
  const atrRatio = price ? range / (a / price || 1e-9) : 0;
  const sideways = (adxValue < 20 && !lastBos) || (atrRatio < 2.5 && !lastBos);
  let direction = 'sideways';
  if (!sideways) {
    if (pattern === 'HH/HL' || (lastBos && lastBos.dir === 'bull')) direction = 'bullish';
    else if (pattern === 'LL/LH' || (lastBos && lastBos.dir === 'bear')) direction = 'bearish';
    else if (lastBos) direction = lastBos.dir === 'bull' ? 'bullish' : 'bearish';
  }
  return {
    direction, pattern, sideways,
    adx: adxValue, lastBos, rangePct: range * 100,
    label: direction === 'bullish' ? 'Bullish trend'
      : direction === 'bearish' ? 'Bearish trend' : 'Sideways / ranging',
  };
}

/* One-call structure summary for a closed-candle array. */
export function analyzeStructure(candles, adxValue) {
  if (!candles || candles.length < 30) {
    return { insufficient: true, reason: 'Need 30+ closed candles for structure.' };
  }
  const swings = findSwings(candles);
  const bos = detectBosChoch(candles, swings);
  const sr = supportResistance(candles, swings);
  const pools = liquidityPools(candles, swings);
  const sweeps = detectSweeps(candles, pools);
  const fvgs = findFvg(candles);
  const obs = findOrderBlocks(candles, bos);
  const pd = premiumDiscount(candles, swings);
  const trend = detectTrend(candles, swings, bos, adxValue == null ? 20 : adxValue);
  const dev = developingSwings(candles);
  return {
    insufficient: false,
    swings, bos, sr, pools, sweeps, fvgs, obs, pd, trend,
    developing: dev,
    lastSweepBull: sweeps.find((s) => s.dir === 'bull') || null,
    lastSweepBear: sweeps.find((s) => s.dir === 'bear') || null,
    recentFvg: fvgs.filter((f) => !f.mitigated).slice(0, 3),
    recentOb: obs.filter((o) => !o.mitigated).slice(0, 3),
  };
}
