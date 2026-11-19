/* NIVA QUANT AI — indicators.js
   Pure functions over candle arrays. All inputs are closed candles only
   (callers filter via closedCandles) — nothing here repaints. */
'use strict';

import { clamp } from './utils.js';

export function closesOf(candles) { return candles.map((c) => c.c); }

/* EMA series; null until the period is seeded. */
export function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let e = null;
  for (let i = 0; i < values.length; i++) {
    e = e === null ? values[i] : values[i] * k + e * (1 - k);
    if (i >= period - 1) out[i] = e;
  }
  return out;
}

export function ema(values, period) {
  const s = emaSeries(values, period);
  return s[s.length - 1];
}

export function sma(values, period) {
  if (!values || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/* Wilder's RSI(14). */
export function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function macd(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const line = closes.map((_, i) =>
    (e12[i] === null || e26[i] === null) ? null : e12[i] - e26[i]);
  const valid = line.filter((v) => v !== null);
  const sigSeries = emaSeries(valid, 9);
  const sig = sigSeries[sigSeries.length - 1];
  const last = line[line.length - 1];
  const prev = line[line.length - 2];
  const prevSig = sigSeries[sigSeries.length - 2];
  return {
    line: last ?? 0,
    signal: sig ?? 0,
    hist: (last === null || sig == null) ? 0 : last - sig,
    histPrev: (prev === null || prevSig == null) ? 0 : prev - prevSig,
  };
}

export function trueRange(c, p) {
  return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
}

export function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += trueRange(candles[i], candles[i - 1]);
  }
  return sum / period;
}

export function bollinger(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd, sd };
}

/* ADX (Wilder smoothing) — trend strength 0-100. Returns { adx, plusDI, minusDI }. */
export function adx(candles, period = 14) {
  const fallback = { adx: 20, plusDI: 50, minusDI: 50 };
  if (!candles || candles.length < period * 2 + 1) return fallback;
  let tr = 0, plusDM = 0, minusDM = 0;
  for (let i = 1; i <= period; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.h - p.h, dn = p.l - c.l;
    plusDM += up > dn && up > 0 ? up : 0;
    minusDM += dn > up && dn > 0 ? dn : 0;
    tr += trueRange(c, p);
  }
  let dxSum = 0, dxCount = 0, prevAdx = null;
  let plusDI = 0, minusDI = 0;
  for (let i = period + 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.h - p.h, dn = p.l - c.l;
    const pDM = up > dn && up > 0 ? up : 0;
    const mDM = dn > up && dn > 0 ? dn : 0;
    const trI = trueRange(c, p);
    tr = tr - tr / period + trI;
    plusDM = plusDM - plusDM / period + pDM;
    minusDM = minusDM - minusDM / period + mDM;
    if (tr === 0) continue;
    plusDI = 100 * plusDM / tr;
    minusDI = 100 * minusDM / tr;
    const sum = plusDI + minusDI;
    const dx = sum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sum;
    if (prevAdx === null) {
      dxSum += dx; dxCount++;
      if (dxCount >= period) prevAdx = dxSum / period;
    } else {
      prevAdx = (prevAdx * (period - 1) + dx) / period;
    }
  }
  return {
    adx: clamp(prevAdx == null ? 20 : prevAdx, 0, 100),
    plusDI, minusDI,
  };
}

/* Session VWAP over the last `lookback` closed candles. */
export function vwap(candles, lookback = 50) {
  if (!candles || !candles.length) return null;
  const slice = candles.slice(-lookback);
  let pv = 0, vol = 0;
  for (const c of slice) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vol += c.v;
  }
  return vol > 0 ? pv / vol : null;
}

/* VWAP series (rolling, for charts): one value per candle. */
export function vwapSeries(candles, lookback = 50) {
  const out = new Array(candles.length).fill(null);
  let pv = 0, vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    pv += tp * candles[i].v;
    vol += candles[i].v;
    if (i >= lookback) {
      const old = candles[i - lookback];
      const otp = (old.h + old.l + old.c) / 3;
      pv -= otp * old.v;
      vol -= old.v;
    }
    if (i >= lookback - 1 && vol > 0) out[i] = pv / vol;
  }
  return out;
}

/* Relative volume: last closed candle volume vs 20-candle average.
   The live candle is excluded by the caller (closed candles only). */
export function relativeVolume(candles, period = 20) {
  if (!candles || candles.length < period + 1) return 1;
  const vols = candles.map((c) => c.v);
  const avg = sma(vols.slice(0, -1), period);
  if (!avg || avg <= 0) return 1;
  return vols[vols.length - 1] / avg;
}

/* Momentum: % change over `period` closed candles. */
export function momentumPct(closes, period = 10) {
  if (!closes || closes.length < period + 1) return 0;
  const a = closes[closes.length - 1 - period];
  const b = closes[closes.length - 1];
  if (!a) return 0;
  return (b - a) / a * 100;
}

/* ATR as % of price — used for volatility filters. */
export function atrPct(candles, period = 14) {
  const a = atr(candles, period);
  const price = candles && candles.length ? candles[candles.length - 1].c : 0;
  if (a == null || !price) return null;
  return a / price * 100;
}
