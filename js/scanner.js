/* NIVA QUANT AI — scanner.js
   Two-pass scan (Nova pattern):
   Pass 1 — fast technicals on the top-N pairs by 24h volume.
   Pass 2 — orderflow + HTF enrichment for candidates only.
   Filters: min volume / liquidity / ATR / score, max spread, exclude
   abnormal volatility, sideways, insufficient data. Sortable results. */
'use strict';

import { LS_KEYS } from './config.js';
import {
  getPerpetuals, getTickers24h, getKlines, getAggTrades, getDepth,
  bookQuality, closedCandles, isStablePair,
} from './binance.js';
import { atr, atrPct, vwap, adx, rsi, macd, relativeVolume, momentumPct, closesOf } from './indicators.js';
import { analyzeStructure } from './structure.js';
import { analyzeTrades, buildFootprint, findImbalances, deltaDivergence, absorptionExhaustion, volumeClusters } from './orderflow.js';
import { scoreBoth } from './scoring.js';
import { buildSignal, recordSignal } from './signals.js';
import { pool, logEvent } from './utils.js';

export const SCAN_SORTS = ['score', 'volume', 'volatility', 'activity', 'change'];

export function sortResults(rows, sort) {
  const arr = rows.slice();
  if (sort === 'volume') arr.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
  else if (sort === 'volatility') arr.sort((a, b) => (b.atrPct || 0) - (a.atrPct || 0));
  else if (sort === 'activity') arr.sort((a, b) => (b.relVol || 0) - (a.relVol || 0));
  else if (sort === 'change') arr.sort((a, b) => Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0));
  else arr.sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0));
  return arr;
}

function htfBiasFromCandles(candles) {
  if (!candles || candles.length < 21) return null;
  const closes = closesOf(candles);
  const e9 = closes.slice(-9).reduce((a, b) => a + b, 0) / 9;
  const e21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;
  if (e9 > e21) return 'bull';
  if (e9 < e21) return 'bear';
  return null;
}

/* Pass 1: klines + technicals only (fast). */
async function pass1(candidates, tickers, settings, onProgress) {
  return pool(candidates, 8, async (symbol) => {
    try {
      const ticker = tickers[symbol];
      const raw = await getKlines(symbol, settings.setupTf, 210);
      const candles = closedCandles(raw);
      if (candles.length < 60) return { symbol, excluded: 'insufficient-data', reason: 'Only ' + candles.length + ' closed candles' };
      const closes = closesOf(candles);
      const price = +ticker.lastPrice;
      const a = atr(candles);
      const aPct = atrPct(candles);
      if (aPct == null) return { symbol, excluded: 'insufficient-data', reason: 'ATR unavailable' };
      if (aPct < settings.minAtrPct) return { symbol, excluded: 'low-volatility', reason: 'ATR ' + aPct.toFixed(2) + '% below min ' + settings.minAtrPct + '%' };
      if (aPct > settings.maxAtrPct) return { symbol, excluded: 'abnormal-volatility', reason: 'ATR ' + aPct.toFixed(2) + '% above max ' + settings.maxAtrPct + '%' };
      const adxVal = adx(candles).adx;
      const structure = analyzeStructure(candles, adxVal);
      if (structure.insufficient) return { symbol, excluded: 'insufficient-data', reason: structure.reason };
      if (structure.trend.sideways) return { symbol, excluded: 'sideways', reason: 'Sideways / ranging structure' };
      return {
        symbol, ticker, candles,
        price,
        change24h: +ticker.priceChangePercent,
        volume24h: +ticker.quoteVolume,
        atr: a, atrPct: aPct,
        relVol: relativeVolume(candles),
        momentum: momentumPct(closes, 10),
        rsi: rsi(closes),
        macdHist: macd(closes).hist,
        adx: adxVal,
        vwap: vwap(candles, settings.vwapLookback),
        structure,
      };
    } catch (e) {
      return { symbol, excluded: 'error', reason: e.message || 'fetch failed' };
    }
  }, (d, t) => onProgress && onProgress(Math.round(d / t * 55), 'Pass 1 — technicals ' + d + '/' + t));
}

/* Pass 2: orderflow + HTF + book for candidates only. */
async function pass2(rows, settings, onProgress) {
  const total = rows.length || 1;
  return pool(rows, settings.maxConcurrent || 6, async (row) => {
    let flow = null, footprint = null, book = null, htfBias = null;
    try {
      const trades = await getAggTrades(row.symbol, 500);
      flow = analyzeTrades(trades, settings.largeTradeUsd);
      if (!flow.insufficient) {
        const fp = buildFootprint(trades, 5 * 60 * 1000, row.atr ? row.atr / 10 : null);
        const imbs = findImbalances(fp.rows, settings.footprintImbalance);
        footprint = {
          rows: fp.rows,
          imbalances: imbs,
          divergence: deltaDivergence(row.candles),
          clusters: volumeClusters(fp.rows, 5),
          ...absorptionExhaustion(row.candles, flow),
        };
      }
    } catch (e) { logEvent('api', 'Orderflow failed for ' + row.symbol, e.message); }
    try {
      const depth = await getDepth(row.symbol, 100);
      book = bookQuality(depth, 0.01);
    } catch (e) { /* book optional */ }
    try {
      const htfRaw = await getKlines(row.symbol, settings.biasTf, 60);
      htfBias = htfBiasFromCandles(closedCandles(htfRaw));
      if (!htfBias) {
        const htf2 = await getKlines(row.symbol, settings.biasTf2, 60);
        htfBias = htfBiasFromCandles(closedCandles(htf2));
      }
    } catch (e) { /* HTF optional */ }

    const ctx = {
      structure: { ...row.structure, candleCount: row.candles.length },
      flow, footprint, book, htfBias,
      indicators: {
        price: row.price, atr: row.atr, vwap: row.vwap,
        adx: row.adx, relVol: row.relVol, rsi: row.rsi,
      },
    };
    const scored = scoreBoth(ctx);
    return { ...row, flow, footprint, book, htfBias, scored, bestScore: scored.best.score, bestDir: scored.best.dir };
  }, (d) => onProgress && onProgress(55 + Math.round(d / total * 40), 'Pass 2 — orderflow + HTF ' + d + '/' + total));
}

export async function runScan(settings, onProgress) {
  const started = Date.now();
  onProgress && onProgress(2, 'Loading perpetuals…');
  const tickersArr = await getTickers24h();
  const tickerMap = {};
  let stableFiltered = 0;
  for (const t of tickersArr) {
    if (!t.symbol.endsWith('USDT')) continue;
    if (isStablePair(t.symbol, t)) { stableFiltered++; continue; }
    tickerMap[t.symbol] = t;
  }
  let eligible = Object.keys(tickerMap);
  try {
    const perps = await getPerpetuals();
    const perpSet = new Set(perps.map((p) => p.symbol));
    eligible = eligible.filter((s) => perpSet.has(s));
  } catch (e) {
    logEvent('api', 'exchangeInfo failed — scanning from tickers only', e.message);
  }
  const ranked = eligible
    .map((s) => ({ symbol: s, vol: +tickerMap[s].quoteVolume }))
    .filter((x) => x.vol >= (settings.minVolume24h || 0))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, settings.scanLimit || 60)
    .map((x) => x.symbol);

  const first = await pass1(ranked, tickerMap, settings, onProgress);
  const excluded = first.filter((r) => r && r.excluded);
  // Candidates: either direction plausible — structure already passed,
  // so enrich everything that survived pass 1 (bounded by scanLimit).
  const survivors = first.filter((r) => r && !r.excluded);
  const enriched = await pass2(survivors, settings, onProgress);

  const rows = [];
  const signals = [];
  for (const row of enriched) {
    if (!row) continue;
    // Liquidity + spread filters (applied after enrichment, when the
    // book is known).
    if (row.book && row.book.depthUsd < (settings.minLiquidityUsd || 0)) {
      excluded.push({ symbol: row.symbol, excluded: 'low-liquidity', reason: 'Book depth $' + Math.round(row.book.depthUsd) + ' below min' });
      continue;
    }
    if (row.book && row.book.spreadPct != null && row.book.spreadPct > (settings.maxSpreadPct || 0.1)) {
      excluded.push({ symbol: row.symbol, excluded: 'wide-spread', reason: 'Spread ' + row.book.spreadPct.toFixed(3) + '% above max' });
      continue;
    }
    rows.push(row);
    if (row.scored && row.scored.clearDirection) {
      const sig = buildSignal(row.symbol, row.scored.best.dir, row.scored.best, {
        structure: { ...row.structure, candleCount: row.candles.length },
        flow: row.flow, footprint: row.footprint, htfBias: row.htfBias,
        indicators: { price: row.price, atr: row.atr, vwap: row.vwap, adx: row.adx, relVol: row.relVol },
      }, settings);
      recordSignal(sig);
      if (sig.status === 'active') signals.push(sig);
    }
  }
  const result = {
    rows: sortResults(rows, 'score'),
    signals,
    excluded,
    scanned: ranked.length,
    stableFiltered,
    durationMs: Date.now() - started,
    scannedAt: Date.now(),
  };
  try {
    const cache = {
      scannedAt: result.scannedAt,
      rows: result.rows.map((r) => ({
        symbol: r.symbol, price: r.price, change24h: r.change24h, volume24h: r.volume24h,
        atrPct: r.atrPct, relVol: r.relVol, adx: r.adx, rsi: r.rsi,
        bestScore: r.bestScore, bestDir: r.bestDir,
        trend: r.structure.trend.label, htfBias: r.htfBias,
        flowDir: r.flow && !r.flow.insufficient ? r.flow.direction : null,
        deltaRatio: r.flow ? r.flow.deltaRatio : null,
        vwapPos: r.vwap != null && r.price != null ? (r.price > r.vwap ? 'above' : 'below') : null,
        depthUsd: r.book ? r.book.depthUsd : null,
        spreadPct: r.book ? r.book.spreadPct : null,
        scored: r.scored,
      })),
      signals: result.signals,
      excluded: result.excluded,
      scanned: result.scanned, stableFiltered: result.stableFiltered,
    };
    localStorage.setItem(LS_KEYS.scanCache, JSON.stringify(cache));
  } catch (e) { /* cache optional */ }
  logEvent('scan', 'Scan complete: ' + rows.length + ' rows, ' + signals.length + ' signals, ' + stableFiltered + ' pegged excluded');
  return result;
}

export function loadScanCache() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS.scanCache) || 'null'); }
  catch (e) { return null; }
}
