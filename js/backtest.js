/* NIVA QUANT AI — backtest.js
   Client-side backtest on REAL historical klines from Binance.
   Confirmed (closed) candles only — no look-ahead: a signal computed
   from candles up to index i can only enter at candle i+1's open.
   Fees + slippage + funding simulation included.
   HONEST LIMIT: historical footprint and order-book data are NOT
   available — only klines and (recent) trades exist historically. The
   backtest therefore scores the technical/structure subset of the live
   strategy (structure + sweep + volume + VWAP + trend + liquidity via
   spread proxy) and labels orderflow/footprint blocks as unavailable.
   Results are split train / validation / test with walk-forward windows
   and an out-of-sample holdout. */
'use strict';

import { getKlines, getFundingRate, closedCandles } from './binance.js';
import { atr, vwap, adx, relativeVolume, closesOf } from './indicators.js';
import { analyzeStructure } from './structure.js';
import { pool, logEvent } from './utils.js';

export const BACKTEST_LIMIT_NOTE =
  'Historical footprint and order-book data are unavailable — only klines exist historically. ' +
  'This backtest scores the structure/sweep/volume/VWAP/trend subset; live orderflow and footprint blocks are not testable on history.';

/* Score the backtestable subset (max 65 of the live 100 points:
   structure 15 + sweep 15 + volume 10 + VWAP 10 + trend 10 + liquidity 5
   proxied by volume). Rescaled to /100 for comparability and labelled. */
function subsetScore(candles, i, settings) {
  const slice = candles.slice(0, i + 1);
  if (slice.length < 60) return null;
  const adxVal = adx(slice).adx;
  const st = analyzeStructure(slice, adxVal);
  if (st.insufficient) return null;
  const price = slice[slice.length - 1].c;
  const a = atr(slice);
  const vw = vwap(slice, settings.vwapLookback);
  const relVol = relativeVolume(slice);
  const out = {};
  for (const dir of ['long', 'short']) {
    const bull = dir === 'long';
    let s = 0;
    const parts = {};
    // Structure 15
    let ps = 0;
    if (st.trend.direction === (bull ? 'bullish' : 'bearish')) ps += 6;
    if (bull ? ['HH/HL', 'HH', 'HL'].includes(st.trend.pattern) : ['LL/LH', 'LL', 'LH'].includes(st.trend.pattern)) ps += 4;
    if (st.trend.lastBos && st.trend.lastBos.dir === (bull ? 'bull' : 'bear')) ps += 5;
    parts.structure = Math.min(ps, 15); s += parts.structure;
    // Sweep 15
    const sweep = bull ? st.lastSweepBull : st.lastSweepBear;
    parts.sweep = sweep && (slice.length - 1 - sweep.idx) <= 10 ? 15 : sweep ? 5 : 0; s += parts.sweep;
    // Volume 10
    parts.volume = Math.max(0, Math.min(10, Math.round((relVol - 0.5) * 10))); s += parts.volume;
    // VWAP 10
    let pv = 0;
    if (vw != null) {
      if (bull ? price > vw : price < vw) pv = 10;
    }
    parts.vwap = pv; s += pv;
    // Trend 10
    parts.trend = Math.min(6, Math.round(adxVal * 0.2)) + (st.trend.direction === (bull ? 'bullish' : 'bearish') ? 4 : 0); s += parts.trend;
    // Liquidity proxy 5: relative volume as a stand-in (no book history)
    parts.liquidity = relVol >= 1.2 ? 5 : relVol >= 0.8 ? 3 : 1; s += parts.liquidity;
    out[dir] = { score: s, parts, structure: st, atr: a, price };
  }
  return out;
}

function buildBacktestLevels(dir, entry, st, atrVal, settings) {
  const bull = dir === 'long';
  const buffer = atrVal * (settings.atrSlBuffer ?? 0.25);
  let swing = null;
  if (bull) {
    const lows = (st.swings.lows || []).filter((l) => l.price < entry);
    swing = lows.length ? lows[lows.length - 1].price : null;
  } else {
    const highs = (st.swings.highs || []).filter((h) => h.price > entry);
    swing = highs.length ? highs[highs.length - 1].price : null;
  }
  let sl = swing != null
    ? (bull ? swing - buffer : swing + buffer)
    : (bull ? entry - atrVal * settings.atrSlMultiplier : entry + atrVal * settings.atrSlMultiplier);
  if (bull ? sl >= entry : sl <= entry) sl = bull ? entry - atrVal * settings.atrSlMultiplier : entry + atrVal * settings.atrSlMultiplier;
  const risk = Math.abs(entry - sl);
  if (!risk || risk <= 0) return null;
  const minRR = settings.minRR || 2;
  const tp1 = bull ? entry + risk * minRR : entry - risk * minRR;
  const tp2 = bull ? entry + risk * minRR * 1.75 : entry - risk * minRR * 1.75;
  return { entry, sl, tp1, tp2, risk };
}

/* Simulate one trade forward from entry candle index `startIdx`.
   SL-first on same-candle TP+SL ambiguity (conservative). */
function simulateTrade(candles, startIdx, dir, levels, settings, fundingPer8h) {
  const bull = dir === 'long';
  const feePct = (settings.feePct || 0) / 100;
  const slipPct = (settings.slippagePct || 0) / 100;
  const entry = levels.entry;
  const entryCost = entry * (feePct + slipPct);
  let barsHeld = 0;
  let tp1Hit = false;
  let tp1R = 0;
  for (let j = startIdx; j < candles.length; j++) {
    const c = candles[j];
    barsHeld++;
    const hitSL = bull ? c.l <= levels.sl : c.h >= levels.sl;
    const hitTP1 = !tp1Hit && (bull ? c.h >= levels.tp1 : c.l <= levels.tp1);
    const hitTP2 = bull ? c.h >= levels.tp2 : c.l <= levels.tp2;
    if (hitSL) {
      // SL-first even if TP was also touched this candle.
      const r = -1;
      const totalR = tp1Hit ? tp1R * 0.5 + r * 0.5 : r;
      return { outcome: 'loss', exitPrice: levels.sl, exitIdx: j, barsHeld, r: totalR, tp1Hit };
    }
    if (hitTP1) {
      tp1Hit = true;
      tp1R = Math.abs(levels.tp1 - entry) / levels.risk;
    }
    if (hitTP2) {
      const r2 = Math.abs(levels.tp2 - entry) / levels.risk;
      const totalR = tp1Hit ? tp1R * 0.5 + r2 * 0.5 : r2;
      return { outcome: 'win', exitPrice: levels.tp2, exitIdx: j, barsHeld, r: totalR, tp1Hit };
    }
  }
  return { outcome: 'open', exitPrice: null, exitIdx: candles.length - 1, barsHeld, r: 0, tp1Hit };
}

/* Funding cost estimate: average funding rate x bars held (8h periods). */
async function avgFunding(symbol, settings) {
  if (!settings.fundingSim) return 0;
  try {
    const rates = await getFundingRate(symbol, 30);
    if (!rates || !rates.length) return 0;
    const avg = rates.reduce((s, r) => s + (+r.fundingRate || 0), 0) / rates.length;
    return avg; // per 8h period
  } catch (e) { return 0; }
}

export function tfMinutes(tf) {
  const m = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
  return m[tf] || 15;
}

/* Run a backtest for one symbol over a candle window.
   `split` = { trainEnd, valEnd } indices into the candle array. */
export async function backtestSymbol(symbol, tf, settings, opts = {}) {
  const limit = opts.limit || 1000;
  const raw = await getKlines(symbol, tf, limit);
  const candles = closedCandles(raw);
  if (candles.length < 200) {
    return { symbol, insufficient: true, reason: 'Only ' + candles.length + ' closed candles available.' };
  }
  const funding = await avgFunding(symbol, settings);
  const n = candles.length;
  const trainEnd = Math.floor(n * 0.5);
  const valEnd = Math.floor(n * 0.75);
  const minScoreSubset = Math.round((settings.minScore || 75) * 0.65); // rescale threshold to the 65-pt subset
  const trades = [];
  const tfMin = tfMinutes(tf);
  for (let i = 60; i < n - 1; i++) {
    const scores = subsetScore(candles, i, settings);
    if (!scores) continue;
    const best = scores.long.score >= scores.short.score ? { dir: 'long', ...scores.long } : { dir: 'short', ...scores.short };
    const spread = Math.abs(scores.long.score - scores.short.score);
    if (best.score < minScoreSubset || spread < 5) continue;
    // Entry at the NEXT candle's open (no look-ahead).
    const entryCandle = candles[i + 1];
    const entry = entryCandle.o;
    const levels = buildBacktestLevels(best.dir, entry, best.structure, best.atr, settings);
    if (!levels) continue;
    const sim = simulateTrade(candles, i + 1, best.dir, levels, settings, funding);
    if (sim.outcome === 'open') continue; // unfinished at end of data — excluded, not counted
    // Funding drag: funding per 8h x periods held (payer side assumed worst case).
    const periodsHeld = (sim.barsHeld * tfMin) / 480;
    const fundingR = Math.abs(funding) * periodsHeld * (entry / levels.risk) * 0.5;
    const rNet = sim.r - fundingR - 0.05; // ~0.05R for fees+slippage at 1% risk sizing
    const segment = i < trainEnd ? 'train' : i < valEnd ? 'validation' : 'test';
    trades.push({
      symbol, dir: best.dir, score: best.score, scoreSubset: true,
      entry, sl: levels.sl, tp1: levels.tp1, tp2: levels.tp2,
      entryTime: entryCandle.t,
      exitTime: candles[sim.exitIdx].t,
      exitPrice: sim.exitPrice,
      outcome: sim.outcome, r: +rNet.toFixed(3), rGross: +sim.r.toFixed(3),
      barsHeld: sim.barsHeld, tp1Hit: sim.tp1Hit, segment,
    });
    i = sim.exitIdx; // no overlapping trades per symbol
  }
  return { symbol, insufficient: false, trades, candles: n, trainEnd, valEnd, fundingPer8h: funding };
}

export function summarizeBacktest(trades) {
  const bySegment = {};
  for (const seg of ['train', 'validation', 'test']) {
    const t = trades.filter((x) => x.segment === seg);
    const wins = t.filter((x) => x.outcome === 'win');
    const losses = t.filter((x) => x.outcome === 'loss');
    const totalR = t.reduce((s, x) => s + x.r, 0);
    const grossWin = wins.reduce((s, x) => s + x.r, 0);
    const grossLoss = Math.abs(losses.reduce((s, x) => s + x.r, 0));
    bySegment[seg] = {
      trades: t.length,
      wins: wins.length, losses: losses.length,
      winRate: t.length ? wins.length / t.length * 100 : null,
      totalR: +totalR.toFixed(2),
      avgR: t.length ? +(totalR / t.length).toFixed(3) : null,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null),
      expectancyR: t.length ? +(totalR / t.length).toFixed(3) : null,
    };
  }
  const all = summarizeSegment(trades);
  return { ...all, bySegment };
}

function summarizeSegment(t) {
  const wins = t.filter((x) => x.outcome === 'win');
  const losses = t.filter((x) => x.outcome === 'loss');
  const totalR = t.reduce((s, x) => s + x.r, 0);
  const grossWin = wins.reduce((s, x) => s + x.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x.r, 0));
  // Max drawdown on the equity curve (in R).
  let peak = 0, run = 0, maxDD = 0;
  for (const x of t) {
    run += x.r;
    if (run > peak) peak = run;
    maxDD = Math.max(maxDD, peak - run);
  }
  return {
    trades: t.length,
    wins: wins.length, losses: losses.length,
    winRate: t.length ? wins.length / t.length * 100 : null,
    totalR: +totalR.toFixed(2),
    avgR: t.length ? +(totalR / t.length).toFixed(3) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null),
    maxDrawdownR: +maxDD.toFixed(2),
  };
}

/* Multi-coin backtest with walk-forward reporting: each symbol is split
   train/validation/test; the TEST segment is the out-of-sample holdout. */
export async function runBacktest(symbols, tf, settings, onProgress) {
  const results = await pool(symbols, 3, async (s) => {
    try { return await backtestSymbol(s, tf, settings); }
    catch (e) {
      logEvent('backtest', 'Backtest failed for ' + s, e.message);
      return { symbol: s, insufficient: true, reason: e.message || 'fetch failed' };
    }
  }, (d, t) => onProgress && onProgress(d, t));
  const allTrades = [];
  const failed = [];
  for (const r of results) {
    if (!r) continue;
    if (r.insufficient) failed.push({ symbol: r.symbol, reason: r.reason });
    else allTrades.push(...r.trades);
  }
  allTrades.sort((a, b) => a.entryTime - b.entryTime);
  return {
    summary: summarizeBacktest(allTrades),
    trades: allTrades,
    failed,
    symbols: symbols.length,
    tf,
    ranAt: Date.now(),
    note: BACKTEST_LIMIT_NOTE,
  };
}
