/* NIVA QUANT AI — charts.js
   TradingView Lightweight Charts (CDN, loaded in index.html):
   candles + volume + VWAP + entry/SL/TP lines + BOS/CHoCH labels +
   FVG/OB zones + sweep markers + CVD/delta panels + volume profile.
   Timeframes 5m/15m/1h/4h. Falls back to a canvas candle chart if the
   CDN library failed to load. */
'use strict';

import { vwapSeries } from './indicators.js';
import { fmtPrice } from './utils.js';

export function hasLightweightCharts() {
  return typeof window !== 'undefined' && !!window.LightweightCharts;
}

/* Convert our candles to Lightweight Charts format (seconds). */
function toSeries(candles) {
  return candles.map((c) => ({
    time: Math.floor(c.t / 1000),
    open: c.o, high: c.h, low: c.l, close: c.c,
  }));
}

function toVolume(candles) {
  return candles.map((c) => ({
    time: Math.floor(c.t / 1000),
    value: c.v,
    color: c.c >= c.o ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)',
  }));
}

export class CoinChart {
  constructor(container) {
    this.container = container;
    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.vwapSeries = null;
    this.cvdSeries = null;
    this.lines = [];
    this.markers = [];
    this.resizeObserver = null;
  }

  destroy() {
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
    if (this.chart) { this.chart.remove(); this.chart = null; }
    this.container.innerHTML = '';
  }

  /* opts: { candles, structure, levels, vwapLookback, cvdSeries, volumeProfile } */
  render(opts) {
    const candles = opts.candles || [];
    this.destroy();
    if (!candles.length) {
      this.container.innerHTML = '<div class="chart-empty">No candle data — select a coin and timeframe.</div>';
      return;
    }
    if (!hasLightweightCharts()) {
      this._renderCanvasFallback(candles, opts);
      return;
    }
    const { createChart, ColorType } = window.LightweightCharts;
    this.chart = createChart(this.container, {
      width: this.container.clientWidth || 800,
      height: 460,
      layout: { background: { type: ColorType.Solid, color: '#111318' }, textColor: '#c8ccd4', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderColor: '#2a2e37' },
      timeScale: { borderColor: '#2a2e37', timeVisible: true },
      crosshair: { mode: 0 },
    });
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444',
      borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    });
    this.candleSeries.setData(toSeries(candles));
    this.volumeSeries = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    this.volumeSeries.setData(toVolume(candles));

    // VWAP line
    const vw = vwapSeries(candles, opts.vwapLookback || 50);
    const vwData = candles.map((c, i) => vw[i] == null ? null : { time: Math.floor(c.t / 1000), value: vw[i] }).filter(Boolean);
    if (vwData.length) {
      this.vwapSeries = this.chart.addLineSeries({ color: '#38bdf8', lineWidth: 1, title: 'VWAP', priceLineVisible: false, lastValueVisible: false });
      this.vwapSeries.setData(vwData);
    }

    // Entry / SL / TP lines (locked levels only)
    const lv = opts.levels;
    if (lv) {
      const addLine = (price, color, title) => {
        if (price == null) return;
        const line = this.candleSeries.createPriceLine({
          price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title,
        });
        this.lines.push(line);
      };
      addLine(lv.entry, '#38bdf8', 'ENTRY ' + fmtPrice(lv.entry));
      addLine(lv.sl, '#ef4444', 'SL ' + fmtPrice(lv.sl));
      addLine(lv.tp1, '#22c55e', 'TP1 ' + fmtPrice(lv.tp1));
      addLine(lv.tp2, '#22c55e', 'TP2 ' + fmtPrice(lv.tp2));
    }

    // BOS / CHoCH + sweep markers
    const st = opts.structure;
    const markers = [];
    if (st && !st.insufficient) {
      for (const e of (st.bos || []).slice(-8)) {
        const c = candles[e.idx];
        if (!c) continue;
        markers.push({
          time: Math.floor(c.t / 1000),
          position: e.dir === 'bull' ? 'belowBar' : 'aboveBar',
          color: e.dir === 'bull' ? '#22c55e' : '#ef4444',
          shape: 'arrowUp',
          text: e.type + ' ' + (e.dir === 'bull' ? '▲' : '▼'),
        });
      }
      for (const s of (st.sweeps || []).slice(0, 4)) {
        const c = candles[s.idx];
        if (!c) continue;
        markers.push({
          time: Math.floor(c.t / 1000),
          position: s.dir === 'bull' ? 'belowBar' : 'aboveBar',
          color: '#f59e0b',
          shape: 'circle',
          text: 'SWEEP',
        });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    if (markers.length) this.candleSeries.setMarkers(markers);

    // CVD panel (separate scale, bottom)
    if (opts.cvdSeries && opts.cvdSeries.length > 2) {
      const cvdData = opts.cvdSeries.map((p) => ({ time: Math.floor(p.t / 1000), value: p.cvd }));
      this.cvdSeries = this.chart.addLineSeries({
        color: '#a78bfa', lineWidth: 1, title: 'CVD',
        priceScaleId: 'cvd', priceLineVisible: false, lastValueVisible: false,
      });
      this.chart.priceScale('cvd').applyOptions({ scaleMargins: { top: 0.72, bottom: 0.15 } });
      this.cvdSeries.setData(cvdData);
    }

    this.chart.timeScale().fitContent();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.chart) this.chart.applyOptions({ width: this.container.clientWidth });
    });
    this.resizeObserver.observe(this.container);
  }

  /* Canvas fallback: candles + VWAP + levels, no library needed. */
  _renderCanvasFallback(candles, opts) {
    const canvas = document.createElement('canvas');
    canvas.width = this.container.clientWidth || 800;
    canvas.height = 420;
    canvas.style.width = '100%';
    this.container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cs = candles.slice(-120);
    let lo = Infinity, hi = -Infinity;
    cs.forEach((c) => { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); });
    if (opts.levels) {
      for (const k of ['entry', 'sl', 'tp1', 'tp2']) {
        if (opts.levels[k] != null) { lo = Math.min(lo, opts.levels[k]); hi = Math.max(hi, opts.levels[k]); }
      }
    }
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad; hi += pad;
    const y = (p) => H - ((p - lo) / (hi - lo)) * H;
    const bw = W / cs.length;
    ctx.fillStyle = '#111318';
    ctx.fillRect(0, 0, W, H);
    cs.forEach((c, i) => {
      const x = i * bw + bw / 2;
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? '#22c55e' : '#ef4444';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      ctx.fillRect(x - bw * 0.32, top, bw * 0.64, Math.max(1, bot - top));
    });
    if (opts.levels) {
      const line = (price, color, label) => {
        if (price == null) return;
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(0, y(price)); ctx.lineTo(W, y(price)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color; ctx.font = 'bold 12px sans-serif';
        ctx.fillText(label + ' ' + fmtPrice(price), 8, y(price) - 6);
      };
      line(opts.levels.entry, '#38bdf8', 'ENTRY');
      line(opts.levels.sl, '#ef4444', 'SL');
      line(opts.levels.tp1, '#22c55e', 'TP1');
      line(opts.levels.tp2, '#22c55e', 'TP2');
    }
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'Lightweight Charts CDN unavailable — showing canvas fallback.';
    this.container.appendChild(note);
  }
}

/* Volume profile: horizontal bars of traded volume by price level.
   Rendered as a small canvas beside the chart. */
export function renderVolumeProfile(canvas, rows, maxBars = 24) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!rows || !rows.length) {
    ctx.fillStyle = '#8b93a1';
    ctx.font = '12px sans-serif';
    ctx.fillText('No footprint data', 10, 20);
    return;
  }
  const top = rows.slice().sort((a, b) => b.total - a.total).slice(0, maxBars)
    .sort((a, b) => b.price - a.price);
  const maxVol = Math.max(...top.map((r) => r.total));
  const barH = H / top.length;
  top.forEach((r, i) => {
    const w = maxVol > 0 ? (r.total / maxVol) * (W - 90) : 0;
    ctx.fillStyle = r.delta >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)';
    ctx.fillRect(0, i * barH + 2, w, barH - 4);
    ctx.fillStyle = '#c8ccd4';
    ctx.font = '10px sans-serif';
    ctx.fillText(fmtPrice(r.price), W - 86, i * barH + barH / 2 + 3);
  });
}
