/* NIVA QUANT AI — signals.js
   Entry / SL / TP construction with hard confirmation gates.
   LONG requires: HTF bullish bias + bullish structure + sell-side sweep
   + positive flow + bullish footprint + VWAP. SHORT is mirrored.
   No signal is emitted if a valid SL/TP cannot be computed.
   SL = swing + ATR buffer. TP1/TP2 from liquidity/swing levels, min 1:2 R:R. */
'use strict';

import { LS_KEYS } from './config.js';
import { logEvent } from './utils.js';

/* Confirmation gates — all must pass, else the candidate is recorded
   as REJECTED (analytics counts rejections too). */
export function checkGates(dir, ctx, settings) {
  const bull = dir === 'long';
  const st = ctx.structure || {};
  const flow = ctx.flow || {};
  const ind = ctx.indicators || {};
  const gates = [];
  const fail = (name, detail) => gates.push({ name, pass: false, detail });
  const ok = (name, detail) => gates.push({ name, pass: true, detail });

  // 1. HTF bias
  if (ctx.htfBias === (bull ? 'bull' : 'bear')) ok('HTF bias', 'Bias timeframe agrees (' + ctx.htfBias + ')');
  else fail('HTF bias', 'Bias timeframe is ' + (ctx.htfBias || 'unknown') + ', need ' + (bull ? 'bull' : 'bear'));

  // 2. Structure direction
  const trendDir = st.trend ? st.trend.direction : null;
  if (trendDir === (bull ? 'bullish' : 'bearish')) ok('Structure', 'Structure ' + trendDir);
  else fail('Structure', 'Structure is ' + (trendDir || 'unknown'));

  // 3. Liquidity sweep (recent, <= 10 candles)
  const sweep = bull ? st.lastSweepBull : st.lastSweepBear;
  const sweepRecent = sweep && st.candleCount != null && (st.candleCount - sweep.idx) <= 10;
  if (sweepRecent) ok('Sweep', (bull ? 'Sell-side' : 'Buy-side') + ' sweep at ' + sweep.level);
  else fail('Sweep', 'No recent ' + (bull ? 'sell-side' : 'buy-side') + ' sweep');

  // 4. Order flow direction
  const delta = flow.deltaRatio == null ? 0 : flow.deltaRatio;
  const aligned = bull ? delta : -delta;
  if (aligned > 0.05) ok('Order flow', 'Delta ' + (delta * 100).toFixed(0) + '% in direction');
  else fail('Order flow', 'Delta ' + (delta * 100).toFixed(0) + '% — not aligned');

  // 5. Footprint: at least one aligned imbalance
  const imbs = (ctx.footprint && ctx.footprint.imbalances) || [];
  const alignedImb = imbs.filter((i) => i.side === (bull ? 'bull' : 'bear')).length;
  if (alignedImb >= 1) ok('Footprint', alignedImb + ' aligned imbalance(s)');
  else fail('Footprint', 'No aligned footprint imbalance');

  // 6. VWAP position
  if (ind.vwap != null && ind.price != null) {
    const above = ind.price > ind.vwap;
    if (bull ? above : !above) ok('VWAP', 'Price ' + (bull ? 'above' : 'below') + ' VWAP');
    else fail('VWAP', 'Price on the wrong side of VWAP');
  } else fail('VWAP', 'VWAP unavailable');

  // 7. Volume participation
  const relVol = ind.relVol == null ? 1 : ind.relVol;
  if (relVol >= 0.8) ok('Volume', 'Relative volume ' + relVol.toFixed(2) + 'x');
  else fail('Volume', 'Relative volume ' + relVol.toFixed(2) + 'x — too thin');

  // 8. Not sideways
  if (st.trend && !st.trend.sideways) ok('Trend', 'Not sideways');
  else fail('Trend', 'Sideways / ranging — no trend to follow');

  return gates;
}

/* Build entry/SL/TP. Returns null when a valid setup cannot be computed. */
export function buildLevels(dir, ctx, settings) {
  const bull = dir === 'long';
  const st = ctx.structure || {};
  const ind = ctx.indicators || {};
  const price = ind.price;
  const atrVal = ind.atr;
  if (price == null || !atrVal || atrVal <= 0) return null;

  const entry = price;
  const buffer = atrVal * (settings.atrSlBuffer ?? 0.25);

  // SL: beyond the nearest swing in the loss direction, plus ATR buffer.
  let swing = null;
  if (st.swings) {
    if (bull) {
      const lows = (st.swings.lows || []).filter((l) => l.price < price);
      swing = lows.length ? lows[lows.length - 1].price : null;
    } else {
      const highs = (st.swings.highs || []).filter((h) => h.price > price);
      swing = highs.length ? highs[highs.length - 1].price : null;
    }
  }
  let sl;
  if (swing != null) {
    sl = bull ? swing - buffer : swing + buffer;
    // SL must actually be on the loss side of entry.
    if (bull ? sl >= entry : sl <= entry) sl = bull ? entry - atrVal * settings.atrSlMultiplier : entry + atrVal * settings.atrSlMultiplier;
  } else {
    sl = bull ? entry - atrVal * settings.atrSlMultiplier : entry + atrVal * settings.atrSlMultiplier;
  }
  const risk = Math.abs(entry - sl);
  if (!risk || risk <= 0) return null;

  // TP1/TP2: nearest liquidity / swing levels in the profit direction,
  // falling back to R-multiples. TP1 must be >= minRR.
  const minRR = settings.minRR || 2;
  const levels = [];
  if (st.sr) {
    for (const lv of st.sr) {
      if (bull && lv.price > entry) levels.push(lv.price);
      if (!bull && lv.price < entry) levels.push(lv.price);
    }
  }
  if (st.pools) {
    const poolLevels = bull ? (st.pools.buySide || []) : (st.pools.sellSide || []);
    for (const p of poolLevels) levels.push(p.price);
  }
  levels.sort((a, b) => bull ? a - b : b - a);
  const tp1FromLevel = levels.find((p) => Math.abs(p - entry) / risk >= minRR) || null;
  const tp2FromLevel = levels.find((p) => Math.abs(p - entry) / risk >= minRR * 1.75) || null;
  const tp1 = tp1FromLevel != null ? tp1FromLevel : (bull ? entry + risk * minRR : entry - risk * minRR);
  const tp2 = tp2FromLevel != null ? tp2FromLevel : (bull ? entry + risk * minRR * 1.75 : entry - risk * minRR * 1.75);
  const rr1 = Math.abs(tp1 - entry) / risk;
  const rr2 = Math.abs(tp2 - entry) / risk;
  if (rr1 < minRR) return null; // cannot reach min R:R — no signal
  return {
    entry, sl, tp1, tp2, risk,
    rr1: +rr1.toFixed(2), rr2: +rr2.toFixed(2),
    tp1FromLevel: tp1FromLevel != null,
    tp2FromLevel: tp2FromLevel != null,
    swingUsed: swing,
  };
}

/* Full signal build: gates + score + levels. Returns a signal object or
   a rejection record (both are persisted for analytics). */
export function buildSignal(symbol, dir, scoreResult, ctx, settings) {
  const now = Date.now();
  const gates = checkGates(dir, ctx, settings);
  const failed = gates.filter((g) => !g.pass);
  const base = {
    id: symbol + '-' + dir + '-' + now,
    symbol, dir,
    score: scoreResult.score,
    scoreClass: scoreResult.class,
    parts: scoreResult.parts,
    reasons: scoreResult.reasons,
    gates: gates.map((g) => ({ name: g.name, pass: g.pass, detail: g.detail })),
    tf: settings.setupTf,
    entryTf: settings.entryTf,
    createdAt: now,
    expiresAt: now + (settings.signalExpiryMin || 60) * 60 * 1000,
    status: 'rejected',
  };
  if (scoreResult.score < settings.minScore) {
    return { ...base, rejectReason: 'Score ' + scoreResult.score + ' below minimum ' + settings.minScore };
  }
  if (failed.length) {
    return { ...base, rejectReason: 'Failed gates: ' + failed.map((g) => g.name).join(', ') };
  }
  const levels = buildLevels(dir, ctx, settings);
  if (!levels) {
    return { ...base, rejectReason: 'Could not compute valid SL/TP (min R:R ' + (settings.minRR || 2) + ':1 not reachable)' };
  }
  return { ...base, ...levels, status: 'active', price: ctx.indicators.price, atr: ctx.indicators.atr };
}

export function isExpired(signal, now = Date.now()) {
  return signal && signal.expiresAt != null && now > signal.expiresAt;
}

/* --- Signal log (ALL signals incl. rejected/expired) --- */
export function loadSignalLog() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS.signals) || '[]'); }
  catch (e) { return []; }
}

export function recordSignal(signal) {
  try {
    const log = loadSignalLog();
    log.unshift(signal);
    localStorage.setItem(LS_KEYS.signals, JSON.stringify(log.slice(0, 1000)));
  } catch (e) { /* storage unavailable */ }
  if (signal.status === 'active') {
    logEvent('signal', 'Signal: ' + signal.symbol + ' ' + signal.dir.toUpperCase() + ' ' + signal.score + '/100', 'Entry ' + signal.entry);
  }
}

export function updateSignalStatus(id, status, extra) {
  try {
    const log = loadSignalLog();
    const row = log.find((s) => s.id === id);
    if (!row) return;
    row.status = status;
    if (extra) Object.assign(row, extra);
    localStorage.setItem(LS_KEYS.signals, JSON.stringify(log));
  } catch (e) {}
}

export function expireStaleSignals() {
  const now = Date.now();
  let changed = false;
  try {
    const log = loadSignalLog();
    for (const s of log) {
      if (s.status === 'active' && isExpired(s, now)) { s.status = 'expired'; changed = true; }
    }
    if (changed) localStorage.setItem(LS_KEYS.signals, JSON.stringify(log));
  } catch (e) {}
  return changed;
}
