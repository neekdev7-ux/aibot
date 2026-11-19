/* NIVA QUANT AI — app.js
   Wiring: state, navigation, scanning, live WebSocket ticks, paper-trade
   auto-close, coin analysis, footprint, liquidity, backtest, settings.
   Paper trading is the default and the only mode — real trading is NOT
   implemented. All prices, signals and histories come from real Binance
   public data or real stored trades. Nothing is simulated except P&L,
   which is always labelled simulated. */
'use strict';

import { DEFAULT_SETTINGS, LS_KEYS, loadSettings, saveSettings } from './config.js';
import { fmtPrice, timeAgo, logEvent, loadLogs, clearLogs, debounce } from './utils.js';
import { getKlines, getAggTrades, getDepth, getTicker, getMarkPrice, getOpenInterest, closedCandles, bookQuality, getBackoffUntil, getLastBaseUsed } from './binance.js';
import { atr, atrPct, vwap, adx, rsi, macd, relativeVolume, closesOf } from './indicators.js';
import { analyzeStructure } from './structure.js';
import { analyzeTrades, buildFootprint, findImbalances, deltaDivergence, absorptionExhaustion, volumeClusters } from './orderflow.js';
import { LocalBook } from './book.js';
import { scoreBoth } from './scoring.js';
import { loadSignalLog, expireStaleSignals } from './signals.js';
import { loadTrades, activeTrades, closedTrades, openTradeFromSignal, manualClose, cancelLocked, tickTrades } from './trades.js';
import { socket } from './ws.js';
import { runScan, loadScanCache, sortResults } from './scanner.js';
import { CoinChart, hasLightweightCharts, renderVolumeProfile } from './charts.js';
import { loadFootprint, renderFootprint } from './footprint.js';
import { runBacktest } from './backtest.js';
import { computeAnalytics, equityCurve } from './analytics.js';
import * as ui from './ui.js';

const state = {
  settings: loadSettings(),
  scan: loadScanCache(),
  sort: 'score',
  section: 'overview',
  coin: null, // loaded coin-analysis context
  coinTf: '15m',
  coinSymbol: null,
  liquidity: null,
  footprintData: null,
  backtest: null,
  wsStatus: 'disconnected',
  scanning: false,
  prices: {}, // symbol -> live price (WS)
  chart: null,
  book: null,
  scanTimer: null,
  refreshTimer: null,
};

const $ = (id) => document.getElementById(id);

/* ---------------- Context builders ---------------- */
function ctx() {
  const stats = computeAnalytics();
  return {
    stats,
    scan: state.scan,
    settings: state.settings,
    wsStatus: state.wsStatus,
    activeTrades: activeTrades(),
    closedTrades: closedTrades(),
    recentSignals: loadSignalLog().filter((s) => s.status === 'active').slice(0, 6),
    signals: loadSignalLog().filter((s) => s.status === 'active'),
    sort: state.sort,
    coin: state.coin,
    liquidity: state.liquidity,
    backtest: state.backtest,
    prices: state.prices,
    restBase: getLastBaseUsed(),
    backoffUntil: getBackoffUntil(),
    stale: socket.staleSymbols(),
    chartsOk: hasLightweightCharts(),
  };
}

function renderAll() {
  const c = ctx();
  ui.renderOverview(c);
  ui.renderScanner(c);
  ui.renderSignals(c);
  ui.renderOrderFlow(c);
  ui.renderLiquidity(c);
  ui.renderCoinAnalysis(c);
  ui.renderActiveTrades(c);
  ui.renderTradeHistory(c);
  ui.renderBacktest(c);
  ui.renderAnalytics(c);
  ui.renderLogs(loadLogs());
  ui.renderHealth(c);
  renderEquityCurve();
  updateBadges(c);
}

function updateBadges(c) {
  const activeCount = c.activeTrades.length;
  const sigCount = c.signals.length;
  const tb = $('badgeTrades');
  if (tb) { tb.textContent = activeCount || ''; tb.hidden = !activeCount; }
  const sb = $('badgeSignals');
  if (sb) { sb.textContent = sigCount || ''; sb.hidden = !sigCount; }
  const clock = $('clock');
  if (clock) clock.textContent = new Date().toLocaleTimeString('en-IN');
  const staleNote = $('staleNote');
  if (staleNote) {
    const stale = socket.staleSymbols();
    staleNote.hidden = !stale.length;
    if (stale.length) staleNote.textContent = 'Stale data (>60s): ' + stale.join(', ');
  }
}

function renderEquityCurve() {
  const canvas = $('equityCanvas');
  if (!canvas) return;
  const curve = equityCurve();
  const ctx2d = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);
  if (curve.length < 2) {
    ctx2d.fillStyle = '#8b93a1';
    ctx2d.font = '12px sans-serif';
    ctx2d.fillText('Equity curve appears after 2+ closed trades.', 10, 20);
    return;
  }
  const vals = curve.map((p) => p.pnl);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const range = hi - lo || 1;
  ctx2d.strokeStyle = '#38bdf8';
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  curve.forEach((p, i) => {
    const x = (i / (curve.length - 1)) * W;
    const y = H - ((p.pnl - lo) / range) * (H - 8) - 4;
    i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y);
  });
  ctx2d.stroke();
  // Zero line
  const zy = H - ((0 - lo) / range) * (H - 8) - 4;
  ctx2d.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath(); ctx2d.moveTo(0, zy); ctx2d.lineTo(W, zy); ctx2d.stroke();
}

/* ---------------- Scanning ---------------- */
async function doScan() {
  if (state.scanning) return;
  state.scanning = true;
  const btn = $('scanBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  const prog = $('scanProgress');
  if (prog) prog.hidden = false;
  try {
    const result = await runScan(state.settings, (pct, text) => {
      const fill = $('scanFill'), label = $('scanLabel');
      if (fill) fill.style.width = pct + '%';
      if (label) label.textContent = text;
    });
    state.scan = {
      scannedAt: result.scannedAt,
      scanned: result.scanned,
      stableFiltered: result.stableFiltered,
      excluded: result.excluded,
      rows: result.rows.map((r) => ({
        symbol: r.symbol, price: r.price, change24h: r.change24h, volume24h: r.volume24h,
        atrPct: r.atrPct, relVol: r.relVol, adx: r.adx, rsi: r.rsi,
        bestScore: r.bestScore, bestDir: r.bestDir,
        trend: r.structure.trend.label, htfBias: r.htfBias,
        flowDir: r.flow && !r.flow.insufficient ? r.flow.direction : null,
        deltaRatio: r.flow ? r.flow.deltaRatio : null,
        flow: r.flow && !r.flow.insufficient ? {
          takerBuyRatio: r.flow.takerBuyRatio, cvdSlope: r.flow.cvdSlope,
          largeBuy: r.flow.largeBuy, largeSell: r.flow.largeSell,
        } : null,
        book: r.book,
        vwapPos: r.vwap != null && r.price != null ? (r.price > r.vwap ? 'above' : 'below') : null,
        depthUsd: r.book ? r.book.depthUsd : null,
        spreadPct: r.book ? r.book.spreadPct : null,
        scored: r.scored,
      })),
    };
    // Watch the top pairs + active-trade symbols on the socket.
    const watch = [...new Set([
      ...state.scan.rows.slice(0, 12).map((r) => r.symbol),
      ...activeTrades().map((t) => t.symbol),
    ])];
    socket.watch(watch, state.coinTf);
    ui.toast('Scan complete: ' + state.scan.rows.length + ' pairs, ' + result.signals.length + ' new signal(s)', 'ok');
  } catch (e) {
    console.error(e);
    ui.toast('Scan failed: ' + (e.message || e), 'err');
  } finally {
    state.scanning = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Run scan'; }
    if (prog) prog.hidden = true;
    renderAll();
  }
}

function setupAutoScan() {
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.scanTimer = null;
  if (!state.settings.scannerOn) return;
  const mins = Math.max(1, state.settings.scanIntervalMin || 5);
  state.scanTimer = setInterval(() => {
    if (!document.hidden) doScan();
  }, mins * 60 * 1000);
}

/* ---------------- Coin analysis ---------------- */
async function loadCoin(symbol, tf) {
  state.coinSymbol = symbol;
  state.coinTf = tf || state.coinTf;
  const wrap = $('coinContent');
  if (wrap) wrap.innerHTML = '<p class="hint">Loading ' + symbol + ' (' + state.coinTf + ') — klines, structure, orderflow, funding…</p>';
  ui.showSection('coin');
  state.section = 'coin';
  try {
    const [raw, ticker, mark, oi] = await Promise.all([
      getKlines(symbol, state.coinTf, 210),
      getTicker(symbol),
      getMarkPrice(symbol).catch(() => null),
      getOpenInterest(symbol).catch(() => null),
    ]);
    const candles = closedCandles(raw);
    if (candles.length < 60) throw new Error('Only ' + candles.length + ' closed candles available');
    const closes = closesOf(candles);
    const price = +ticker.lastPrice;
    const adxVal = adx(candles).adx;
    const structure = analyzeStructure(candles, adxVal);
    const a = atr(candles);
    let flow = null, footprint = null, cvdSeries = null;
    try {
      const trades = await getAggTrades(symbol, 500);
      flow = analyzeTrades(trades, state.settings.largeTradeUsd);
      if (!flow.insufficient) {
        cvdSeries = flow.cvdSeries;
        const fp = buildFootprint(trades, 5 * 60 * 1000, a ? a / 10 : null);
        footprint = {
          rows: fp.rows,
          imbalances: findImbalances(fp.rows, state.settings.footprintImbalance),
          divergence: deltaDivergence(candles),
          clusters: volumeClusters(fp.rows, 5),
          ...absorptionExhaustion(candles, flow),
        };
      }
    } catch (e) { logEvent('api', 'Orderflow failed for ' + symbol, e.message); }
    let book = null;
    try {
      const depth = await getDepth(symbol, 100);
      book = bookQuality(depth, 0.01);
    } catch (e) {}
    const indicators = {
      price, atr: a, atrPct: atrPct(candles), vwap: vwap(candles, state.settings.vwapLookback),
      adx: adxVal, rsi: rsi(closes), macdHist: macd(closes).hist, relVol: relativeVolume(candles),
    };
    // HTF bias for the score panel
    let htfBias = null;
    try {
      const htfRaw = await getKlines(symbol, state.settings.biasTf, 60);
      const hc = closedCandles(htfRaw).map((c) => c.c);
      if (hc.length >= 21) {
        const e9 = hc.slice(-9).reduce((x, y) => x + y, 0) / 9;
        const e21 = hc.slice(-21).reduce((x, y) => x + y, 0) / 21;
        htfBias = e9 > e21 ? 'bull' : e9 < e21 ? 'bear' : null;
      }
    } catch (e) {}
    const scored = scoreBoth({
      structure: { ...structure, candleCount: candles.length },
      flow, footprint, book, htfBias, indicators,
    });
    state.coin = {
      symbol, tf: state.coinTf, price,
      change24h: +ticker.priceChangePercent,
      volume24h: +ticker.quoteVolume,
      candles, structure, indicators, flow, footprint, book, htfBias, scored,
      funding: mark ? +mark.fundingRate : null,
      oi: oi ? +oi.openInterest * price : null,
      cvdSeries,
    };
    // Liquidity map data (structure pools + live book walls)
    state.book = new LocalBook(symbol);
    try {
      await state.book.init();
      state.liquidity = {
        symbol, price,
        pools: structure.pools,
        sweeps: structure.sweeps,
        walls: state.book.walls(5, 5),
        spoof: state.book.spoof,
      };
      socket.subscribeDepth(symbol, (ev) => {
        if (state.book && state.book.applyEvent(ev) === 'gap') {
          state.book.init().catch(() => {});
        }
      });
    } catch (e) {
      state.liquidity = { symbol, price, pools: structure.pools, sweeps: structure.sweeps, walls: [], spoof: [] };
    }
    renderAll();
    renderCoinChart();
    renderScorePanel();
    renderFootprintPanel();
  } catch (e) {
    console.error(e);
    if (wrap) wrap.innerHTML = '<p class="hint">Could not load ' + symbol + ': ' + (e.message || e) + '</p>';
    ui.toast('Coin load failed: ' + (e.message || e), 'err');
  }
}

function renderCoinChart() {
  const el = $('coinChart');
  if (!el || !state.coin) return;
  if (!state.chart) state.chart = new CoinChart(el);
  const activeSignal = loadSignalLog().find((s) => s.status === 'active' && s.symbol === state.coin.symbol);
  state.chart.render({
    candles: state.coin.candles,
    structure: state.coin.structure,
    levels: activeSignal ? { entry: activeSignal.entry, sl: activeSignal.sl, tp1: activeSignal.tp1, tp2: activeSignal.tp2 } : null,
    vwapLookback: state.settings.vwapLookback,
    cvdSeries: state.coin.cvdSeries,
  });
  const vp = $('volumeProfile');
  if (vp && state.coin.footprint && state.coin.footprint.rows) {
    renderVolumeProfile(vp, state.coin.footprint.rows);
  }
}

function renderScorePanel() {
  const el = $('coinScore');
  if (!el || !state.coin) return;
  const s = state.coin.scored;
  if (!s) { el.innerHTML = ''; return; }
  const partRows = (parts) => Object.entries(parts).map(([k, v]) => {
    const max = { structure: 15, orderflow: 20, footprint: 15, sweep: 15, volume: 10, vwap: 10, trend: 10, liquidity: 5 }[k] || 10;
    return '<div class="bd-row"><span class="bd-name">' + k + '</span>' +
      '<div class="bd-bar"><div class="bd-fill" style="width:' + Math.round(v / max * 100) + '%"></div></div>' +
      '<span class="bd-val">' + v + '/' + max + '</span></div>';
  }).join('');
  el.innerHTML =
    '<div class="score-duo">' +
    '<div class="panel"><h4>LONG — ' + s.long.score + '/100 · ' + s.long.class + '</h4>' + partRows(s.long.parts) +
    '<ul class="reasons">' + s.long.reasons.map((r) => '<li>' + r + '</li>').join('') + '</ul></div>' +
    '<div class="panel"><h4>SHORT — ' + s.short.score + '/100 · ' + s.short.class + '</h4>' + partRows(s.short.parts) +
    '<ul class="reasons">' + s.short.reasons.map((r) => '<li>' + r + '</li>').join('') + '</ul></div>' +
    '</div>' +
    '<p class="hint">The confluence score measures how many independent conditions agree — it is NOT a win probability. ' +
    'Direction spread: ' + s.spread + ' pts (' + (s.clearDirection ? 'clear direction' : 'no clear direction — chop') + ').</p>';
}

async function renderFootprintPanel() {
  const el = $('footprintContent');
  if (!el) return;
  if (!state.coinSymbol) {
    el.innerHTML = '<p class="hint">Pick a coin first — the footprint is built from its recent executed trades.</p>';
    return;
  }
  el.innerHTML = '<p class="hint">Loading footprint for ' + state.coinSymbol + '…</p>';
  try {
    const data = await loadFootprint(state.coinSymbol, state.settings, 15);
    data.imbalanceThreshold = state.settings.footprintImbalance;
    state.footprintData = data;
    renderFootprint(el, data);
  } catch (e) {
    el.innerHTML = '<p class="hint">Footprint failed: ' + (e.message || e) + '</p>';
  }
}

/* ---------------- Backtest ---------------- */
async function doBacktest() {
  const coinsInput = $('btCoins');
  const tfSel = $('btTf');
  const symbols = (coinsInput.value || 'BTCUSDT,ETHUSDT,SOLUSDT')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const tf = tfSel ? tfSel.value : '15m';
  const btn = $('btRun');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  const prog = $('btProgress');
  if (prog) prog.hidden = false;
  try {
    state.backtest = await runBacktest(symbols, tf, state.settings, (d, t) => {
      const fill = $('btFill'), label = $('btLabel');
      if (fill) fill.style.width = Math.round(d / t * 100) + '%';
      if (label) label.textContent = 'Backtesting ' + d + '/' + t + ' coins…';
    });
    ui.toast('Backtest complete: ' + state.backtest.summary.trades + ' trades across ' + symbols.length + ' coin(s)', 'ok');
  } catch (e) {
    ui.toast('Backtest failed: ' + (e.message || e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Run backtest'; }
    if (prog) prog.hidden = true;
    renderAll();
  }
}

/* ---------------- Settings ---------------- */
const SETTING_FIELDS = [
  ['minScore', 'number'], ['watchlistScore', 'number'],
  ['minVolume24h', 'number'], ['minLiquidityUsd', 'number'],
  ['maxSpreadPct', 'number'], ['minAtrPct', 'number'], ['maxAtrPct', 'number'],
  ['minRR', 'number'], ['atrSlBuffer', 'number'], ['atrSlMultiplier', 'number'],
  ['vwapLookback', 'number'], ['cvdLookback', 'number'],
  ['footprintImbalance', 'number'], ['largeTradeUsd', 'number'],
  ['cooldownMin', 'number'], ['signalExpiryMin', 'number'],
  ['scanIntervalMin', 'number'], ['scanLimit', 'number'],
  ['feePct', 'number'], ['slippagePct', 'number'],
  ['paperCapital', 'number'], ['riskPerTradePct', 'number'],
  ['biasTf', 'text'], ['biasTf2', 'text'], ['setupTf', 'text'], ['entryTf', 'text'],
  ['paperTrading', 'checkbox'], ['scannerOn', 'checkbox'], ['fundingSim', 'checkbox'],
];

function fillSettingsForm() {
  for (const [key, type] of SETTING_FIELDS) {
    const el = $('set_' + key);
    if (!el) continue;
    if (type === 'checkbox') el.checked = !!state.settings[key];
    else el.value = state.settings[key];
  }
}

function readSettingsForm() {
  const next = { ...state.settings };
  for (const [key, type] of SETTING_FIELDS) {
    const el = $('set_' + key);
    if (!el) continue;
    if (type === 'checkbox') next[key] = el.checked;
    else if (type === 'number') { const v = parseFloat(el.value); if (isFinite(v)) next[key] = v; }
    else next[key] = el.value;
  }
  // Guards: paper trading cannot be switched off into real trading —
  // real trading is not implemented, so the toggle only pauses paper fills.
  if (!next.paperTrading) {
    ui.toast('Paper trading paused. Real trading is NOT implemented in this app.', 'warn');
  }
  state.settings = next;
  saveSettings(next);
  setupAutoScan();
  renderAll();
  ui.toast('Settings saved', 'ok');
}

/* ---------------- Live ticks → trade auto-close ---------------- */
function onPriceTick(symbol, price) {
  state.prices[symbol] = price;
  // Throttle trade evaluation: at most once per second per tick batch.
  if (onPriceTick._pending) return;
  onPriceTick._pending = true;
  setTimeout(() => {
    onPriceTick._pending = false;
    const events = tickTrades(state.prices, state.settings);
    if (events.length) {
      for (const ev of events) {
        ui.toast(ev.trade.symbol + ' ' + ev.event, ev.event.includes('SL') ? 'err' : 'ok');
      }
      renderAll();
    } else {
      // Cheap live refresh of the Active Trades table only.
      ui.renderActiveTrades(ctx());
    }
  }, 1000);
}

/* ---------------- Init ---------------- */
function bindNav() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.addEventListener('click', () => {
      state.section = b.dataset.section;
      ui.showSection(state.section);
      if (state.section === 'coin' && state.coin) renderCoinChart();
      if (state.section === 'footprint') renderFootprintPanel();
    });
  });
  document.querySelectorAll('[data-sort]').forEach((b) => {
    b.addEventListener('click', () => {
      state.sort = b.dataset.sort;
      document.querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('active', x === b));
      if (state.scan && state.scan.rows) state.scan.rows = sortResults(state.scan.rows, state.sort);
      ui.renderScanner(ctx());
    });
  });
}

function bindGlobalClicks() {
  document.addEventListener('click', (e) => {
    const coinRow = e.target.closest('[data-coin]');
    const tradeBtn = e.target.closest('[data-trade-signal]');
    const closeBtn = e.target.closest('[data-close-trade]');
    const cancelBtn = e.target.closest('[data-cancel-trade]');
    if (tradeBtn) {
      e.stopPropagation();
      const sig = loadSignalLog().find((s) => s.id === tradeBtn.dataset.tradeSignal);
      if (!sig) return;
      if (!state.settings.paperTrading) {
        ui.toast('Paper trading is paused in Settings — enable it to open paper trades.', 'warn');
        return;
      }
      const res = openTradeFromSignal(sig, state.settings);
      if (res.error) { ui.toast(res.error, 'err'); return; }
      socket.watch([...new Set([...socket.symbols].map((s) => s.toUpperCase()), sig.symbol)], state.coinTf);
      ui.toast('Paper trade locked: ' + sig.symbol + ' ' + sig.dir.toUpperCase(), 'ok');
      renderAll();
      return;
    }
    if (closeBtn) {
      const trades = loadTrades();
      const t = trades.find((x) => x.id === closeBtn.dataset.closeTrade);
      if (!t) return;
      const price = state.prices[t.symbol];
      if (price == null) { ui.toast('No live price for ' + t.symbol + ' yet — wait for the next tick.', 'warn'); return; }
      const res = manualClose(t.id, price, state.settings);
      if (res.error) ui.toast(res.error, 'err');
      else ui.toast(t.symbol + ' closed manually at ' + fmtPrice(price), 'ok');
      renderAll();
      return;
    }
    if (cancelBtn) {
      const res = cancelLocked(cancelBtn.dataset.cancelTrade);
      if (res.error) ui.toast(res.error, 'err');
      else ui.toast('Locked trade cancelled', 'ok');
      renderAll();
      return;
    }
    if (coinRow) {
      loadCoin(coinRow.dataset.coin, state.coinTf);
    }
  });
}

function bindControls() {
  const scanBtn = $('scanBtn');
  if (scanBtn) scanBtn.addEventListener('click', doScan);
  const sortSel = $('scanSort');
  if (sortSel) sortSel.addEventListener('change', () => {
    state.sort = sortSel.value;
    if (state.scan && state.scan.rows) state.scan.rows = sortResults(state.scan.rows, state.sort);
    ui.renderScanner(ctx());
  });
  document.querySelectorAll('[data-coin-tf]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-coin-tf]').forEach((x) => x.classList.toggle('active', x === b));
      if (state.coinSymbol) loadCoin(state.coinSymbol, b.dataset.coinTf);
    });
  });
  const btRun = $('btRun');
  if (btRun) btRun.addEventListener('click', doBacktest);
  const saveBtn = $('saveSettings');
  if (saveBtn) saveBtn.addEventListener('click', readSettingsForm);
  const resetBtn = $('resetSettings');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    state.settings = { ...DEFAULT_SETTINGS };
    saveSettings(state.settings);
    fillSettingsForm();
    setupAutoScan();
    renderAll();
    ui.toast('Settings reset to defaults', 'ok');
  });
  const clearLogsBtn = $('clearLogs');
  if (clearLogsBtn) clearLogsBtn.addEventListener('click', () => {
    clearLogs();
    ui.renderLogs([]);
  });
  const exportBtn = $('exportData');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const data = {
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      trades: loadTrades(),
      signals: loadSignalLog(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'niva-quant-ai-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const fpReload = $('fpReload');
  if (fpReload) fpReload.addEventListener('click', renderFootprintPanel);
  const liqReload = $('liqReload');
  if (liqReload) liqReload.addEventListener('click', () => {
    if (state.coinSymbol) loadCoin(state.coinSymbol, state.coinTf);
  });
  window.addEventListener('niva-log', debounce(() => ui.renderLogs(loadLogs()), 500));
}

function initSocket() {
  socket.onTick = onPriceTick;
  socket.onStatus = (status, detail) => {
    state.wsStatus = status + (detail ? ' (' + detail + ')' : '');
    const badge = $('wsStatusBadge');
    if (badge) badge.textContent = 'WS: ' + state.wsStatus;
    ui.renderHealth(ctx());
  };
  const watch = [...new Set([
    ...(state.scan && state.scan.rows ? state.scan.rows.slice(0, 12).map((r) => r.symbol) : ['BTCUSDT', 'ETHUSDT']),
    ...activeTrades().map((t) => t.symbol),
  ])];
  socket.watch(watch, state.coinTf);
  socket.connect();
}

function init() {
  bindNav();
  bindGlobalClicks();
  bindControls();
  fillSettingsForm();
  ui.showSection('overview');
  expireStaleSignals();
  renderAll();
  setupAutoScan();
  initSocket();
  // Clock + periodic light refresh (expiry, cooldowns, stale flags).
  state.refreshTimer = setInterval(() => {
    expireStaleSignals();
    updateBadges(ctx());
    if (state.section === 'overview') ui.renderOverview(ctx());
    if (state.section === 'trades') ui.renderActiveTrades(ctx());
  }, 30000);
  setInterval(() => { const c = $('clock'); if (c) c.textContent = new Date().toLocaleTimeString('en-IN'); }, 1000);
  // First scan on load so the app is useful immediately.
  if (state.settings.scannerOn) doScan();
  logEvent('app', 'NIVA QUANT AI started — paper trading ' + (state.settings.paperTrading ? 'ON' : 'OFF'));
}

document.addEventListener('DOMContentLoaded', init);
