/* NIVA QUANT AI — binance.js
   Binance USDT-M Futures public REST client.
   Base fallback: data-api.binance.vision FIRST (api.binance.com is 451
   geo-blocked in agent cloud), then fapi.binance.com.
   Backoff on 429/418. No API key. No simulated data anywhere. */
'use strict';

import { BINANCE_BASES, STABLE_BASES, EXCLUDED_PATTERNS } from './config.js';
import { fetchJSON, sleep, logEvent } from './utils.js';

let backoffUntil = 0;
let lastBaseUsed = BINANCE_BASES[0];

export function getBackoffUntil() { return backoffUntil; }
export function getLastBaseUsed() { return lastBaseUsed; }

/* GET with base fallback + rate-limit backoff. Throws the last error. */
export async function binance(path, timeoutMs = 12000) {
  const now = Date.now();
  if (now < backoffUntil) {
    await sleep(backoffUntil - now);
  }
  let lastErr = null;
  for (const base of BINANCE_BASES) {
    try {
      const data = await fetchJSON(base + path, timeoutMs);
      lastBaseUsed = base;
      return data;
    } catch (e) {
      lastErr = e;
      if (e.status === 429 || e.status === 418) {
        // Binance bans aggressively on weight abuse: back off hard.
        const wait = e.status === 418 ? 120000 : 30000;
        backoffUntil = Date.now() + wait;
        logEvent('api', 'Binance rate limit (' + e.status + ') — backing off ' + (wait / 1000) + 's', path);
        await sleep(wait);
      }
    }
  }
  logEvent('api', 'Binance request failed on all bases: ' + (lastErr && lastErr.message), path);
  throw lastErr || new Error('Binance unreachable');
}

/* --- Stablecoin / peg guard ---
   A $1-pegged pair must never reach the scorer (RWUSD scored 97/100 on
   Nova while pinned to $1). Two guards: explicit pegged bases, and any
   pair whose 24h high-low range is under 0.2% of price is flat by
   definition, whatever its name. */
export function isStablePair(symbol, ticker) {
  if (!symbol.endsWith('USDT')) return true; // only USDT pairs are eligible
  const base = symbol.slice(0, -4);
  if (STABLE_BASES.has(base)) return true;
  if (EXCLUDED_PATTERNS.some((p) => symbol.includes(p))) return true;
  if (ticker && isFinite(+ticker.highPrice) && isFinite(+ticker.lowPrice) && isFinite(+ticker.lastPrice) && +ticker.lastPrice > 0) {
    const range = (+ticker.highPrice - +ticker.lowPrice) / +ticker.lastPrice;
    if (range < 0.002) return true; // <0.2% 24h range = pegged/flat
  }
  return false;
}

/* USDT perpetuals, TRADING status only. */
export async function getPerpetuals() {
  const info = await binance('/fapi/v1/exchangeInfo');
  return (info.symbols || []).filter((s) =>
    s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING'
      && !isStablePair(s.symbol, null));
}

export async function getTickers24h() {
  return binance('/fapi/v1/ticker/24hr');
}

export async function getTicker(symbol) {
  return binance('/fapi/v1/ticker/24hr?symbol=' + encodeURIComponent(symbol));
}

export async function getMarkPrice(symbol) {
  return binance('/fapi/v1/premiumIndex?symbol=' + encodeURIComponent(symbol));
}

export async function getOpenInterest(symbol) {
  return binance('/fapi/v1/openInterest?symbol=' + encodeURIComponent(symbol));
}

export async function getFundingRate(symbol, limit = 5) {
  return binance('/fapi/v1/fundingRate?symbol=' + encodeURIComponent(symbol) + '&limit=' + limit);
}

export function parseKlines(raw) {
  return (raw || []).map((k) => ({
    t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
    closeTime: k[6], quoteVol: +k[7], trades: k[8],
    takerBuyVol: +k[9], takerBuyQuote: +k[10],
  }));
}

/* limit is capped by Binance at 1500. */
export async function getKlines(symbol, interval, limit = 210) {
  const raw = await binance('/fapi/v1/klines?symbol=' + encodeURIComponent(symbol)
    + '&interval=' + interval + '&limit=' + Math.min(limit, 1500));
  return parseKlines(raw);
}

export async function getAggTrades(symbol, limit = 500) {
  const raw = await binance('/fapi/v1/aggTrades?symbol=' + encodeURIComponent(symbol)
    + '&limit=' + Math.min(limit, 1000));
  return (raw || []).map((t) => ({
    id: t.a, price: +t.p, qty: +t.q, time: t.T,
    isBuyerMaker: !!t.m, // true = seller was aggressive (taker sell)
  }));
}

export async function getDepth(symbol, limit = 100) {
  const d = await binance('/fapi/v1/depth?symbol=' + encodeURIComponent(symbol) + '&limit=' + limit);
  return {
    lastUpdateId: d.lastUpdateId,
    bids: (d.bids || []).map(([p, q]) => ({ price: +p, qty: +q })),
    asks: (d.asks || []).map(([p, q]) => ({ price: +p, qty: +q })),
  };
}

/* Order-book quality within `pct` of mid: depth $, imbalance, spread. */
export function bookQuality(depth, pct = 0.01) {
  if (!depth || !depth.bids.length || !depth.asks.length) {
    return { depthUsd: 0, imbalance: 50, spreadPct: null, bidUsd: 0, askUsd: 0 };
  }
  const bestBid = depth.bids[0].price;
  const bestAsk = depth.asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - pct), hi = mid * (1 + pct);
  let bidUsd = 0, askUsd = 0;
  for (const b of depth.bids) if (b.price >= lo) bidUsd += b.price * b.qty;
  for (const a of depth.asks) if (a.price <= hi) askUsd += a.price * a.qty;
  const total = bidUsd + askUsd;
  return {
    depthUsd: total,
    bidUsd, askUsd,
    imbalance: total > 0 ? 100 * bidUsd / total : 50,
    spreadPct: mid > 0 ? (bestAsk - bestBid) / mid * 100 : null,
    bestBid, bestAsk, mid,
  };
}

/* Candles strictly CLOSED (closeTime < now). The live candle is still
   forming — its volume/close would repaint, so analysis never uses it. */
export function closedCandles(candles) {
  const now = Date.now();
  return candles.filter((c) => c.closeTime < now);
}
