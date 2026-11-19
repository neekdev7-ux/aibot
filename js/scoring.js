/* NIVA QUANT AI — scoring.js
   100-point confluence score. EXACT weights:
   Structure 15 | Order Flow/CVD 20 | Footprint 15 | Liquidity Sweep 15 |
   Volume 10 | VWAP 10 | Trend Strength 10 | Liquidity Quality 5.
   Classes: 85-100 High Confluence, 75-84 Strong Setup, 65-74 Watchlist,
   <65 No Trade.
   The confluence score is NOT a win probability. It measures how many
   independent conditions agree — nothing more. */
'use strict';

import { SCORE_WEIGHTS, scoreClass } from './config.js';
import { clamp } from './utils.js';

export { scoreClass };

/* Score ONE direction. `ctx` carries everything the scanner computed:
   structure, flow, footprint, book, indicators, htf bias, settings.
   Missing data scores 0 for that block and is listed in `missing`. */
export function scoreDirection(dir, ctx) {
  const W = SCORE_WEIGHTS;
  const parts = {};
  const reasons = [];
  const missing = [];
  const bull = dir === 'long';
  const st = ctx.structure || {};
  const flow = ctx.flow || {};
  const fp = ctx.footprint || {};
  const book = ctx.book || {};
  const ind = ctx.indicators || {};

  /* --- Structure (15) --- */
  let s = 0;
  if (st.insufficient) { missing.push('structure'); }
  else {
    const trendOk = bull ? st.trend.direction === 'bullish' : st.trend.direction === 'bearish';
    const patternOk = bull ? ['HH/HL', 'HH', 'HL'].includes(st.trend.pattern)
      : ['LL/LH', 'LL', 'LH'].includes(st.trend.pattern);
    const lastBos = st.trend.lastBos;
    const bosOk = lastBos && lastBos.dir === (bull ? 'bull' : 'bear');
    if (trendOk) s += 6;
    if (patternOk) s += 4;
    if (bosOk) s += 5;
    if (trendOk && bosOk) reasons.push('Structure ' + (bull ? 'bullish' : 'bearish') + ' with fresh ' + lastBos.type);
    if (st.trend.sideways) reasons.push('Sideways structure — trend score capped');
  }
  parts.structure = clamp(s, 0, W.structure);

  /* --- Order Flow / CVD (20) --- */
  s = 0;
  if (!flow || flow.insufficient) { missing.push('orderflow'); }
  else {
    const delta = flow.deltaRatio || 0;
    const aligned = bull ? delta : -delta;
    s += clamp(Math.round(aligned * 24), 0, 12); // delta up to 12
    const cvdSlope = bull ? (flow.cvdSlope || 0) : -(flow.cvdSlope || 0);
    s += clamp(Math.round(cvdSlope * 16), 0, 8); // CVD slope up to 8
    if (aligned > 0.15) reasons.push('Aggressive ' + (bull ? 'buying' : 'selling') + ' — delta ' + (delta * 100).toFixed(0) + '%');
    if (cvdSlope > 0.1) reasons.push('CVD rising in the signal direction');
    if (aligned < -0.05) reasons.push('Order flow is AGAINST this direction');
  }
  parts.orderflow = clamp(s, 0, W.orderflow);

  /* --- Footprint (15) --- */
  s = 0;
  if (!fp || fp.insufficient) { missing.push('footprint'); }
  else {
    const imbs = fp.imbalances || [];
    const alignedImb = imbs.filter((i) => i.side === (bull ? 'bull' : 'bear')).length;
    const againstImb = imbs.filter((i) => i.side !== (bull ? 'bull' : 'bear')).length;
    s += clamp(alignedImb * 4, 0, 10);
    if (fp.divergence && fp.divergence.type === (bull ? 'bullish' : 'bearish')) { s += 5; reasons.push('Delta divergence favours ' + dir); }
    if (fp.absorption && ((bull && fp.absorption.side === 'buyers') || (!bull && fp.absorption.side === 'sellers'))) s += 0;
    s -= clamp(againstImb * 2, 0, 5);
    if (alignedImb >= 2) reasons.push(alignedImb + ' footprint imbalances in the signal direction');
    if (againstImb >= 3) reasons.push('Footprint imbalances against this direction');
  }
  parts.footprint = clamp(s, 0, W.footprint);

  /* --- Liquidity Sweep (15) --- */
  s = 0;
  if (st.insufficient) { missing.push('sweep'); }
  else {
    const sweep = bull ? st.lastSweepBull : st.lastSweepBear;
    const recent = sweep && st.candleCount != null ? (st.candleCount - sweep.idx) <= 10 : !!sweep;
    if (sweep && recent) {
      s += 10;
      reasons.push('Recent ' + (bull ? 'sell-side' : 'buy-side') + ' liquidity sweep at ' + sweep.level);
      // Sweep + reclaim of the pool level is stronger than sweep alone.
      if (st.sweepReclaimed) { s += 5; reasons.push('Swept level reclaimed — trap confirmed'); }
    } else if (sweep) {
      s += 5; reasons.push('Older sweep — stale, partial credit only');
    }
  }
  parts.sweep = clamp(s, 0, W.sweep);

  /* --- Volume (10) --- */
  s = 0;
  const relVol = ind.relVol == null ? 1 : ind.relVol;
  s = clamp(Math.round((relVol - 0.5) * 10), 0, 10); // 1.0x avg = 5, 1.5x+ = 10
  if (relVol > 1.5) reasons.push('Volume ' + relVol.toFixed(1) + 'x average — move has fuel');
  if (relVol < 0.7) reasons.push('Volume thin (' + relVol.toFixed(1) + 'x) — weak participation');
  parts.volume = s;

  /* --- VWAP (10) --- */
  s = 0;
  if (ind.vwap == null || ind.price == null) { missing.push('vwap'); }
  else {
    const above = ind.price > ind.vwap;
    const distPct = Math.abs(ind.price - ind.vwap) / ind.vwap * 100;
    if (bull ? above : !above) {
      s += 6;
      if (distPct < 1) { s += 4; reasons.push('Price holding ' + (bull ? 'above' : 'below') + ' VWAP, close to value'); }
      else { s += 2; reasons.push('Price ' + (bull ? 'above' : 'below') + ' VWAP but extended (' + distPct.toFixed(1) + '%)'); }
    } else {
      reasons.push('Price on the wrong side of VWAP for ' + dir);
    }
  }
  parts.vwap = clamp(s, 0, W.vwap);

  /* --- Trend Strength (10) --- */
  s = 0;
  const adxVal = ind.adx == null ? 20 : ind.adx;
  const htfOk = ctx.htfBias === (bull ? 'bull' : 'bear');
  const htfAgainst = ctx.htfBias === (bull ? 'bear' : 'bull');
  s += clamp(Math.round(adxVal * 0.2), 0, 6); // ADX 30+ = 6
  if (htfOk) { s += 4; reasons.push('Higher-timeframe bias agrees (' + ctx.htfBias + ')'); }
  if (htfAgainst) { s -= 4; reasons.push('Higher-timeframe bias is AGAINST this direction'); }
  if (adxVal < 20) reasons.push('Weak trend (ADX ' + adxVal.toFixed(0) + ') — chop risk');
  parts.trend = clamp(s, 0, W.trend);

  /* --- Liquidity Quality (5) --- */
  s = 0;
  if (book.depthUsd == null) { missing.push('liquidity'); }
  else {
    if (book.depthUsd >= 200000) s += 3;
    else if (book.depthUsd >= 50000) s += 2;
    else if (book.depthUsd >= 10000) s += 1;
    if (book.spreadPct != null && book.spreadPct <= 0.05) s += 2;
    else if (book.spreadPct != null && book.spreadPct <= 0.10) s += 1;
    if (book.spreadPct != null && book.spreadPct > 0.10) reasons.push('Wide spread (' + book.spreadPct.toFixed(3) + '%) — slippage risk');
  }
  parts.liquidity = clamp(s, 0, W.liquidity);

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    dir, score: total, parts, reasons, missing,
    class: scoreClass(total),
  };
}

/* Score both directions; the winner needs a clear margin or it is chop. */
export function scoreBoth(ctx, minSpread = 8) {
  const long = scoreDirection('long', ctx);
  const short = scoreDirection('short', ctx);
  const best = long.score >= short.score ? long : short;
  const spread = Math.abs(long.score - short.score);
  return {
    long, short, best,
    spread,
    clearDirection: spread >= minSpread,
  };
}
