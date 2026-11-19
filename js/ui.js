/* NIVA QUANT AI — ui.js
   Renders all 12 sections. Pure render functions over state passed in
   from app.js; no network calls here except via callbacks.
   Honesty rules: win rate always shows its closed-trade count, P&L is
   always labelled simulated/paper, and the confluence score is never
   presented as a win probability. */
'use strict';

import { fmtPrice, fmtPct, fmtNum, fmtCompact, fmtUsd, fmtR, fmtSigned, timeAgo, fmtTime, esc } from './utils.js';
import { scoreClass } from './config.js';
import { cooldownRemaining } from './trades.js';

export const SECTIONS = [
  ['overview', 'Overview'],
  ['scanner', 'Live Scanner'],
  ['signals', 'AI Signals'],
  ['orderflow', 'Order Flow'],
  ['footprint', 'Footprint'],
  ['liquidity', 'Liquidity Map'],
  ['coin', 'Coin Analysis'],
  ['trades', 'Active Trades'],
  ['history', 'Trade History'],
  ['backtest', 'Backtesting'],
  ['analytics', 'Analytics'],
  ['settings', 'Settings'],
];

export function showSection(id) {
  for (const [key] of SECTIONS) {
    const el = document.getElementById('sec-' + key);
    if (el) el.hidden = key !== id;
  }
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.section === id);
  });
  const titles = Object.fromEntries(SECTIONS);
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = titles[id] || id;
  window.scrollTo({ top: 0 });
}

export function toast(msg, kind = 'info') {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function dirBadge(dir) {
  return '<span class="badge ' + dir + '">' + (dir === 'long' ? '▲ LONG' : '▼ SHORT') + '</span>';
}

function scorePill(score) {
  const cls = score >= 85 ? 'elite' : score >= 75 ? 'strong' : score >= 65 ? 'watch' : 'no';
  return '<span class="score-pill ' + cls + '">' + score + ' · ' + scoreClass(score) + '</span>';
}

function kpi(label, value, sub) {
  return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div>' +
    '<div class="kpi-value">' + value + '</div>' +
    (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
}

/* ---------------- Overview ---------------- */
export function renderOverview(ctx) {
  const { stats, scan, settings, wsStatus } = ctx;
  const active = ctx.activeTrades || [];
  const longs = active.filter((t) => t.dir === 'long').length;
  const shorts = active.filter((t) => t.dir === 'short').length;
  const highConf = (scan && scan.rows ? scan.rows : []).filter((r) => (r.bestScore || 0) >= 85).length;
  const wr = stats.winRate == null ? '–' : stats.winRate.toFixed(1) + '%';
  const wrSub = stats.closedTrades ? 'on ' + stats.closedTrades + ' closed trade' + (stats.closedTrades === 1 ? '' : 's') + ' · open never counted' : 'no closed trades yet';
  const pf = stats.profitFactor == null ? '–' : (stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2));
  document.getElementById('overviewKpis').innerHTML =
    kpi('Coins scanned', scan ? scan.scanned : '–', scan ? 'last scan ' + timeAgo(scan.scannedAt) + ' · ' + (scan.stableFiltered || 0) + ' pegged excluded' : 'run a scan') +
    kpi('Active LONG / SHORT', longs + ' / ' + shorts, active.length + ' active paper trade' + (active.length === 1 ? '' : 's')) +
    kpi('High-confluence (85+)', highConf, 'of ' + (scan && scan.rows ? scan.rows.length : 0) + ' scanned pairs') +
    kpi('Active / Closed trades', active.length + ' / ' + stats.closedTrades, 'paper trading ' + (settings.paperTrading ? 'ON' : 'OFF')) +
    kpi('Win rate', wr, wrSub) +
    kpi('Profit factor', pf, stats.closedTrades ? 'gross wins ÷ gross losses' : 'no closed trades yet') +
    kpi('Simulated P&amp;L', '<span class="' + (stats.simulatedPnl >= 0 ? 'pos' : 'neg') + '">' + fmtUsd(stats.simulatedPnl) + '</span>', 'paper only — no real money') +
    kpi('Max drawdown', stats.maxDrawdownR ? '-' + stats.maxDrawdownR.toFixed(2) + 'R (' + fmtUsd(-stats.maxDrawdownUsd) + ')' : '–', 'closed trades only');

  const top = (scan && scan.rows ? scan.rows : []).slice(0, 8);
  document.getElementById('overviewTop').innerHTML = top.length
    ? '<table class="tbl"><thead><tr><th>Coin</th><th>Dir</th><th>Score</th><th>Price</th><th>24h</th><th>Vol 24h</th><th>Trend</th></tr></thead><tbody>' +
      top.map((r) => '<tr class="row-link" data-coin="' + esc(r.symbol) + '">' +
        '<td><b>' + esc(r.symbol) + '</b></td><td>' + dirBadge(r.bestDir || 'long') + '</td>' +
        '<td>' + scorePill(r.bestScore || 0) + '</td>' +
        '<td class="num">' + fmtPrice(r.price) + '</td>' +
        '<td class="num ' + ((r.change24h || 0) >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change24h || 0) + '</td>' +
        '<td class="num">$' + fmtCompact(r.volume24h || 0) + '</td>' +
        '<td>' + esc(r.trend || '–') + '</td></tr>').join('') + '</tbody></table>'
    : '<p class="hint">No scan data yet — press <b>Run scan</b> in Live Scanner.</p>';

  const recent = (ctx.recentSignals || []).slice(0, 6);
  document.getElementById('overviewSignals').innerHTML = recent.length
    ? recent.map((s) => '<div class="sig-row"><span><b>' + esc(s.symbol) + '</b> ' + dirBadge(s.dir) + '</span>' +
        '<span>' + scorePill(s.score) + '</span>' +
        '<span class="num">Entry ' + fmtPrice(s.entry) + '</span>' +
        '<span>' + timeAgo(s.createdAt) + '</span></div>').join('')
    : '<p class="hint">No active signals yet.</p>';
  const wsEl = document.getElementById('wsStatusBadge');
  if (wsEl) wsEl.textContent = 'WS: ' + wsStatus;
}

/* ---------------- Scanner ---------------- */
export function renderScanner(ctx) {
  const { scan, sort } = ctx;
  const wrap = document.getElementById('scannerTable');
  if (!scan || !scan.rows) {
    wrap.innerHTML = '<p class="hint">No scan yet. Press <b>Run scan</b> — pass 1 scores technicals on the top pairs by volume, pass 2 enriches candidates with orderflow and higher-timeframe bias.</p>';
    return;
  }
  const rows = scan.rows;
  document.getElementById('scanMeta').textContent =
    rows.length + ' pairs · ' + scan.scanned + ' scanned · ' + (scan.stableFiltered || 0) +
    ' pegged excluded · ' + (scan.excluded ? scan.excluded.length : 0) + ' filtered out · ' + timeAgo(scan.scannedAt);
  wrap.innerHTML = '<table class="tbl"><thead><tr>' +
    '<th>Coin</th><th>Dir</th><th>Score</th><th>Price</th><th>24h %</th><th>Vol 24h</th>' +
    '<th>Rel vol</th><th>ATR %</th><th>Trend</th><th>Flow</th><th>VWAP</th><th>Spread</th></tr></thead><tbody>' +
    rows.map((r) => {
      const cd = cooldownRemaining(r.symbol, r.bestDir || 'long');
      return '<tr class="row-link" data-coin="' + esc(r.symbol) + '">' +
      '<td><b>' + esc(r.symbol) + '</b>' + (cd > 0 ? ' <span class="tag">cooldown ' + Math.ceil(cd / 60000) + 'm</span>' : '') + '</td>' +
      '<td>' + dirBadge(r.bestDir || 'long') + '</td>' +
      '<td>' + scorePill(r.bestScore || 0) + '</td>' +
      '<td class="num">' + fmtPrice(r.price) + '</td>' +
      '<td class="num ' + ((r.change24h || 0) >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change24h || 0) + '</td>' +
      '<td class="num">$' + fmtCompact(r.volume24h || 0) + '</td>' +
      '<td class="num">' + (r.relVol != null ? r.relVol.toFixed(2) + 'x' : '–') + '</td>' +
      '<td class="num">' + (r.atrPct != null ? r.atrPct.toFixed(2) + '%' : '–') + '</td>' +
      '<td>' + esc(r.trend || '–') + '</td>' +
      '<td>' + esc(r.flowDir || '–') + (r.deltaRatio != null ? ' (' + fmtSigned(r.deltaRatio * 100, 0) + '%)' : '') + '</td>' +
      '<td>' + (r.vwapPos ? 'price ' + r.vwapPos + ' VWAP' : '–') + '</td>' +
      '<td class="num">' + (r.spreadPct != null ? r.spreadPct.toFixed(3) + '%' : '–') + '</td></tr>';
    }).join('') + '</tbody></table>';
  const excl = document.getElementById('scanExcluded');
  if (excl) {
    const list = (scan.excluded || []).slice(0, 12);
    excl.innerHTML = list.length
      ? '<b>Filtered out (' + scan.excluded.length + '):</b> ' + list.map((e) => esc(e.symbol) + ' — ' + esc(e.reason)).join(' · ')
      : '';
  }
}

/* ---------------- Signals ---------------- */
export function renderSignals(ctx) {
  const { signals } = ctx;
  const wrap = document.getElementById('signalsTable');
  if (!signals || !signals.length) {
    wrap.innerHTML = '<p class="hint">No active signals. Signals appear here when a pair scores ' + ctx.settings.minScore +
      '+ with every confirmation gate passed (HTF bias, structure, sweep, order flow, footprint, VWAP, volume). ' +
      'Rejected candidates are recorded under Analytics — nothing is hidden.</p>';
    return;
  }
  wrap.innerHTML = '<table class="tbl"><thead><tr><th>Coin</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>R:R</th><th>Score</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>' +
    signals.map((s) => '<tr class="row-link" data-coin="' + esc(s.symbol) + '">' +
      '<td><b>' + esc(s.symbol) + '</b></td><td>' + dirBadge(s.dir) + '</td>' +
      '<td class="num">' + fmtPrice(s.entry) + '</td>' +
      '<td class="num neg">' + fmtPrice(s.sl) + '</td>' +
      '<td class="num pos">' + fmtPrice(s.tp1) + '</td>' +
      '<td class="num pos">' + fmtPrice(s.tp2) + '</td>' +
      '<td class="num">1:' + (s.rr1 != null ? s.rr1.toFixed(1) : '–') + '</td>' +
      '<td>' + scorePill(s.score) + '</td>' +
      '<td><span class="status-' + s.status + '">' + esc(s.status) + '</span></td>' +
      '<td>' + (s.expiresAt ? Math.max(0, Math.round((s.expiresAt - Date.now()) / 60000)) + 'm left' : '–') + '</td>' +
      '<td><button class="btn small" data-trade-signal="' + esc(s.id) + '">Paper trade</button></td></tr>').join('') +
    '</tbody></table>';
}

/* ---------------- Order Flow ---------------- */
export function renderOrderFlow(ctx) {
  const wrap = document.getElementById('orderflowTable');
  const rows = (ctx.scan && ctx.scan.rows ? ctx.scan.rows : []).filter((r) => r.deltaRatio != null);
  if (!rows.length) {
    wrap.innerHTML = '<p class="hint">Order flow loads with a scan — run one from Live Scanner. Values come from real executed aggTrades.</p>';
    return;
  }
  const sorted = rows.slice().sort((a, b) => Math.abs(b.deltaRatio) - Math.abs(a.deltaRatio)).slice(0, 20);
  wrap.innerHTML = '<table class="tbl"><thead><tr><th>Coin</th><th>Flow</th><th>Delta</th><th>Taker buy</th><th>CVD slope</th><th>Large trades</th><th>Book imb.</th><th>Depth $</th></tr></thead><tbody>' +
    sorted.map((r) => {
      const f = r.flow || {};
      return '<tr class="row-link" data-coin="' + esc(r.symbol) + '"><td><b>' + esc(r.symbol) + '</b></td>' +
      '<td>' + esc(r.flowDir || '–') + '</td>' +
      '<td class="num ' + ((r.deltaRatio || 0) >= 0 ? 'pos' : 'neg') + '">' + fmtSigned((r.deltaRatio || 0) * 100, 0) + '%</td>' +
      '<td class="num">' + (f.takerBuyRatio != null ? (f.takerBuyRatio * 100).toFixed(0) + '%' : '–') + '</td>' +
      '<td class="num">' + (f.cvdSlope != null ? fmtSigned(f.cvdSlope * 100, 1) + '%' : '–') + '</td>' +
      '<td class="num">🟢 ' + (f.largeBuy || 0) + ' / 🔴 ' + (f.largeSell || 0) + '</td>' +
      '<td class="num">' + (r.book && r.book.imbalance != null ? r.book.imbalance.toFixed(0) + '% bid' : '–') + '</td>' +
      '<td class="num">$' + fmtCompact(r.depthUsd || 0) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

/* ---------------- Liquidity Map ---------------- */
export function renderLiquidity(ctx) {
  const wrap = document.getElementById('liquidityContent');
  const liq = ctx.liquidity;
  if (!liq) {
    wrap.innerHTML = '<p class="hint">Pick a coin in Coin Analysis first — the liquidity map shows its structure-derived pools, book walls and sweep history.</p>';
    return;
  }
  const pools = liq.pools || { buySide: [], sellSide: [] };
  const walls = liq.walls || [];
  const sweeps = liq.sweeps || [];
  wrap.innerHTML =
    '<h3>' + esc(liq.symbol) + ' — price ' + fmtPrice(liq.price) + '</h3>' +
    '<div class="liq-grid">' +
    '<div class="panel"><h4>Buy-side pools (stops above)</h4>' +
    (pools.buySide.length ? pools.buySide.map((p) => '<div class="liq-row"><span>' + fmtPrice(p.price) + '</span><span>' + p.count + ' swing highs</span></div>').join('') : '<p class="hint">None detected.</p>') + '</div>' +
    '<div class="panel"><h4>Sell-side pools (stops below)</h4>' +
    (pools.sellSide.length ? pools.sellSide.map((p) => '<div class="liq-row"><span>' + fmtPrice(p.price) + '</span><span>' + p.count + ' swing lows</span></div>').join('') : '<p class="hint">None detected.</p>') + '</div>' +
    '<div class="panel"><h4>Resting book walls</h4><p class="hint">Resting size only — a wall can be pulled in milliseconds and is never guaranteed support/resistance.</p>' +
    (walls.length ? walls.map((w) => '<div class="liq-row"><span>' + fmtPrice(w.price) + ' (' + w.side + ')</span><span>$' + fmtCompact(w.usd) + ' · ' + w.multiple.toFixed(1) + 'x median</span></div>').join('') : '<p class="hint">No walls detected.</p>') + '</div>' +
    '<div class="panel"><h4>Recent sweeps</h4>' +
    (sweeps.length ? sweeps.slice(0, 6).map((s) => '<div class="liq-row"><span>' + (s.dir === 'bull' ? '▲ Bullish' : '▼ Bearish') + ' sweep</span><span>' + fmtPrice(s.level) + ' · ' + fmtTime(s.t) + '</span></div>').join('') : '<p class="hint">No sweeps in the lookback.</p>') + '</div>' +
    '</div>' +
    (liq.spoof && liq.spoof.length
      ? '<div class="alert warn"><b>Rapid place/cancel detected:</b><br>' + liq.spoof.map((f) => esc(f.detail) + ' (' + timeAgo(f.ts) + ')').join('<br>') +
        '<br><span class="hint">Heuristic flag on public book data — not proof of spoofing.</span></div>'
      : '');
}

/* ---------------- Coin Analysis ---------------- */
export function renderCoinAnalysis(ctx) {
  const c = ctx.coin;
  const wrap = document.getElementById('coinContent');
  if (!c) {
    wrap.innerHTML = '<p class="hint">Click any coin in the Scanner, Signals or Overview tables to analyse it here.</p>';
    return;
  }
  const st = c.structure || {};
  const ind = c.indicators || {};
  const flow = c.flow || {};
  document.getElementById('coinTitle').textContent = c.symbol + ' — ' + (c.tf || '15m');
  wrap.innerHTML =
    '<div class="kpi-grid small">' +
    kpi('Price', fmtPrice(c.price), '24h ' + fmtPct(c.change24h || 0)) +
    kpi('Trend', esc(st.trend ? st.trend.label : '–'), st.trend ? 'pattern ' + st.trend.pattern + ' · ADX ' + (ind.adx != null ? ind.adx.toFixed(0) : '–') : '') +
    kpi('Premium / Discount', st.pd ? esc(st.pd.zone) + ' (' + (st.pd.position * 100).toFixed(0) + '%)' : '–', st.pd && st.pd.high ? 'range ' + fmtPrice(st.pd.low) + ' – ' + fmtPrice(st.pd.high) : '') +
    kpi('VWAP', ind.vwap != null ? fmtPrice(ind.vwap) : '–', ind.vwap != null && c.price != null ? (c.price > ind.vwap ? 'price above VWAP' : 'price below VWAP') : '') +
    kpi('RSI(14)', ind.rsi != null ? ind.rsi.toFixed(1) : '–', 'MACD hist ' + (ind.macdHist != null ? ind.macdHist.toFixed(4) : '–')) +
    kpi('ATR(14)', ind.atr != null ? fmtPrice(ind.atr) + ' (' + (ind.atrPct != null ? ind.atrPct.toFixed(2) : '–') + '%)' : '–', 'rel. volume ' + (ind.relVol != null ? ind.relVol.toFixed(2) + 'x' : '–')) +
    kpi('Order flow', flow.direction ? esc(flow.direction) : '–', flow.deltaRatio != null ? 'delta ' + fmtSigned(flow.deltaRatio * 100, 0) + '% · taker buy ' + (flow.takerBuyRatio != null ? (flow.takerBuyRatio * 100).toFixed(0) + '%' : '–') : '') +
    kpi('Funding / OI', (c.funding != null ? (c.funding * 100).toFixed(4) + '%' : '–') + ' / ' + (c.oi != null ? '$' + fmtCompact(c.oi) : '–'), 'funding per 8h · open interest $') +
    '</div>' +
    '<div class="two-col">' +
    '<div class="panel"><h4>Support / Resistance (confirmed swings)</h4>' +
    (st.sr && st.sr.length ? st.sr.map((lv) => '<div class="liq-row"><span>' + fmtPrice(lv.price) + ' · ' + lv.kind + '</span><span>' + lv.touches + ' touches · ' + fmtSigned(lv.distancePct, 2) + '% away</span></div>').join('') : '<p class="hint">No levels detected.</p>') +
    '<h4 style="margin-top:14px">Unmitigated FVGs / Order blocks</h4>' +
    ((st.recentFvg && st.recentFvg.length) ? st.recentFvg.map((f) => '<div class="liq-row"><span>FVG ' + f.dir + '</span><span>' + fmtPrice(f.bottom) + ' – ' + fmtPrice(f.top) + '</span></div>').join('') : '<p class="hint">No open FVGs.</p>') +
    ((st.recentOb && st.recentOb.length) ? st.recentOb.map((o) => '<div class="liq-row"><span>OB ' + o.dir + '</span><span>' + fmtPrice(o.bottom) + ' – ' + fmtPrice(o.top) + '</span></div>').join('') : '<p class="hint">No open order blocks.</p>') +
    '</div>' +
    '<div class="panel"><h4>Structure events (confirmed candles only)</h4>' +
    (st.bos && st.bos.length ? st.bos.slice(-8).reverse().map((e) => '<div class="liq-row"><span>' + e.type + ' ' + (e.dir === 'bull' ? '▲' : '▼') + '</span><span>' + fmtPrice(e.level) + ' · ' + fmtTime(e.t) + '</span></div>').join('') : '<p class="hint">No BOS/CHoCH in the lookback.</p>') +
    '<h4 style="margin-top:14px">Developing swings (unconfirmed)</h4><p class="hint">Right-edge swings that can still change — not used for signals.</p>' +
    (st.developing ? '<div class="liq-row"><span>Developing high</span><span>' + fmtPrice(st.developing.high.price) + '</span></div><div class="liq-row"><span>Developing low</span><span>' + fmtPrice(st.developing.low.price) + '</span></div>' : '') +
    '</div></div>';
}

/* ---------------- Trades ---------------- */
export function renderActiveTrades(ctx) {
  const trades = ctx.activeTrades || [];
  const wrap = document.getElementById('activeTradesTable');
  if (!trades.length) {
    wrap.innerHTML = '<p class="hint">No active paper trades. Open one from a signal in AI Signals — entry/SL/TP lock at creation and never move.</p>';
    return;
  }
  wrap.innerHTML = '<table class="tbl"><thead><tr><th>Coin</th><th>Dir</th><th>State</th><th>Entry</th><th>Live</th><th>SL</th><th>TP1</th><th>TP2</th><th>Unreal. R</th><th>Real. R</th><th></th></tr></thead><tbody>' +
    trades.map((t) => {
      const live = ctx.prices ? ctx.prices[t.symbol] : null;
      let unr = null;
      if (live != null && t.risk > 0) {
        unr = t.dir === 'long' ? (live - t.entry) / t.risk : (t.entry - live) / t.risk;
      }
      return '<tr><td><b>' + esc(t.symbol) + '</b></td><td>' + dirBadge(t.dir) + '</td>' +
      '<td><span class="state">' + esc(t.state) + '</span>' + (t.tp1Hit ? ' <span class="tag">TP1 banked</span>' : '') + '</td>' +
      '<td class="num">' + fmtPrice(t.entry) + '</td>' +
      '<td class="num">' + (live != null ? fmtPrice(live) : '–') + '</td>' +
      '<td class="num neg">' + fmtPrice(t.sl) + '</td>' +
      '<td class="num pos">' + fmtPrice(t.tp1) + '</td>' +
      '<td class="num pos">' + fmtPrice(t.tp2) + '</td>' +
      '<td class="num ' + (unr != null && unr >= 0 ? 'pos' : 'neg') + '">' + (unr != null ? fmtR(unr) : '–') + '</td>' +
      '<td class="num ' + ((t.realizedR || 0) >= 0 ? 'pos' : 'neg') + '">' + fmtR(t.realizedR || 0) + '</td>' +
      '<td>' + (t.state === 'ACTIVE'
        ? '<button class="btn small danger" data-close-trade="' + esc(t.id) + '">Close</button>'
        : '<button class="btn small" data-cancel-trade="' + esc(t.id) + '">Cancel</button>') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

export function renderTradeHistory(ctx) {
  const trades = ctx.closedTrades || [];
  const wrap = document.getElementById('historyTable');
  if (!trades.length) {
    wrap.innerHTML = '<p class="hint">No closed trades yet. Closed paper trades appear here with realized R and simulated P&amp;L.</p>';
    return;
  }
  wrap.innerHTML = '<table class="tbl"><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Reason</th><th>Real. R</th><th>Sim. P&amp;L</th><th>Closed</th></tr></thead><tbody>' +
    trades.map((t) => '<tr><td><b>' + esc(t.symbol) + '</b></td><td>' + dirBadge(t.dir) + '</td>' +
      '<td class="num">' + fmtPrice(t.entry) + '</td>' +
      '<td class="num">' + (t.closePrice != null ? fmtPrice(t.closePrice) : '–') + '</td>' +
      '<td>' + esc(t.closeReason || '–') + '</td>' +
      '<td class="num ' + ((t.realizedR || 0) >= 0 ? 'pos' : 'neg') + '">' + fmtR(t.realizedR || 0) + '</td>' +
      '<td class="num ' + ((t.realizedPnl || 0) >= 0 ? 'pos' : 'neg') + '">' + fmtUsd(t.realizedPnl || 0) + '</td>' +
      '<td>' + fmtTime(t.closedAt) + '</td></tr>').join('') + '</tbody></table>';
}

/* ---------------- Backtest ---------------- */
export function renderBacktest(ctx) {
  const res = ctx.backtest;
  const wrap = document.getElementById('backtestResults');
  if (!res) {
    wrap.innerHTML = '<p class="hint">Pick coins and a timeframe, then run a backtest. It replays real historical klines with fees, slippage and funding — confirmed candles only, no look-ahead. ' +
      'Historical footprint and order-book data are unavailable, so the backtest scores the structure/sweep/volume/VWAP/trend subset only.</p>';
    return;
  }
  const s = res.summary;
  const segRow = (name, g) => '<tr><td>' + name + '</td><td class="num">' + g.trades + '</td>' +
    '<td class="num">' + (g.winRate != null ? g.winRate.toFixed(1) + '%' : '–') + '</td>' +
    '<td class="num">' + fmtR(g.totalR) + '</td><td class="num">' + (g.avgR != null ? fmtR(g.avgR) : '–') + '</td>' +
    '<td class="num">' + (g.profitFactor == null ? '–' : g.profitFactor === Infinity ? '∞' : g.profitFactor.toFixed(2)) + '</td></tr>';
  wrap.innerHTML =
    '<div class="kpi-grid small">' +
    kpi('Trades (all)', s.trades, s.wins + 'W / ' + s.losses + 'L') +
    kpi('Win rate', s.winRate != null ? s.winRate.toFixed(1) + '%' : '–', 'closed backtest trades only') +
    kpi('Total R', fmtR(s.totalR), 'net of fees, slippage, funding') +
    kpi('Profit factor', s.profitFactor == null ? '–' : s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2), '') +
    kpi('Max drawdown', '-' + s.maxDrawdownR.toFixed(2) + 'R', 'on the backtest equity curve') +
    '</div>' +
    '<h4>Walk-forward segments (test = out-of-sample holdout)</h4>' +
    '<table class="tbl"><thead><tr><th>Segment</th><th>Trades</th><th>Win rate</th><th>Total R</th><th>Avg R</th><th>Profit factor</th></tr></thead><tbody>' +
    segRow('Train (first 50%)', s.bySegment.train) +
    segRow('Validation (50–75%)', s.bySegment.validation) +
    segRow('Test — out-of-sample (last 25%)', s.bySegment.test) +
    '</tbody></table>' +
    (res.failed.length ? '<p class="hint">Skipped: ' + res.failed.map((f) => esc(f.symbol) + ' (' + esc(f.reason) + ')').join(', ') + '</p>' : '') +
    '<p class="hint">' + esc(res.note) + '</p>' +
    '<h4 style="margin-top:14px">Trades (' + res.trades.length + ')</h4>' +
    (res.trades.length ? '<table class="tbl"><thead><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Outcome</th><th>R (net)</th><th>Segment</th><th>Date</th></tr></thead><tbody>' +
      res.trades.slice(-50).reverse().map((t) => '<tr><td><b>' + esc(t.symbol) + '</b></td><td>' + dirBadge(t.dir) + '</td>' +
        '<td class="num">' + fmtPrice(t.entry) + '</td><td class="num">' + fmtPrice(t.exitPrice) + '</td>' +
        '<td class="' + (t.outcome === 'win' ? 'pos' : 'neg') + '">' + t.outcome.toUpperCase() + '</td>' +
        '<td class="num ' + (t.r >= 0 ? 'pos' : 'neg') + '">' + fmtR(t.r) + '</td>' +
        '<td>' + t.segment + '</td><td>' + fmtTime(t.entryTime) + '</td></tr>').join('') + '</tbody></table>'
      : '<p class="hint">No trades triggered in this window.</p>');
}

/* ---------------- Analytics ---------------- */
export function renderAnalytics(ctx) {
  const stats = ctx.stats;
  const wrap = document.getElementById('analyticsContent');
  const breakdown = (title, obj) => {
    const keys = Object.keys(obj || {});
    if (!keys.length) return '';
    return '<h4>' + title + '</h4><table class="tbl"><thead><tr><th></th><th>Trades</th><th>Win rate</th><th>Total R</th><th>Avg R</th><th>Profit factor</th><th>Sim. P&amp;L</th></tr></thead><tbody>' +
      keys.map((k) => {
        const g = obj[k];
        return '<tr><td><b>' + esc(k) + '</b></td><td class="num">' + g.trades + '</td>' +
          '<td class="num">' + (g.winRate != null ? g.winRate.toFixed(1) + '%' : '–') + '</td>' +
          '<td class="num">' + fmtR(g.totalR) + '</td>' +
          '<td class="num">' + (g.avgR != null ? fmtR(g.avgR) : '–') + '</td>' +
          '<td class="num">' + (g.profitFactor == null ? '–' : g.profitFactor === Infinity ? '∞' : g.profitFactor.toFixed(2)) + '</td>' +
          '<td class="num ' + (g.simulatedPnl >= 0 ? 'pos' : 'neg') + '">' + fmtUsd(g.simulatedPnl) + '</td></tr>';
      }).join('') + '</tbody></table>';
  };
  wrap.innerHTML =
    '<div class="kpi-grid small">' +
    kpi('Signals recorded', stats.totalSignals, stats.active + ' active · ' + stats.rejected + ' rejected · ' + stats.expired + ' expired') +
    kpi('Win rate', stats.winRate != null ? stats.winRate.toFixed(1) + '%' : '–', stats.closedTrades ? 'wins / ' + stats.closedTrades + ' closed · open never counted' : 'no closed trades yet') +
    kpi('Expectancy', stats.expectancyR != null ? fmtR(stats.expectancyR) : '–', 'avg R per closed trade') +
    kpi('Avg win / loss', (stats.avgWinR != null ? fmtR(stats.avgWinR) : '–') + ' / ' + (stats.avgLossR != null ? '-' + stats.avgLossR.toFixed(2) + 'R' : '–'), '') +
    kpi('Profit factor', stats.profitFactor == null ? '–' : stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2), '') +
    kpi('Simulated P&amp;L', '<span class="' + (stats.simulatedPnl >= 0 ? 'pos' : 'neg') + '">' + fmtUsd(stats.simulatedPnl) + '</span>', 'paper only') +
    kpi('Max drawdown', stats.maxDrawdownR ? '-' + stats.maxDrawdownR.toFixed(2) + 'R' : '–', stats.maxDrawdownUsd ? fmtUsd(-stats.maxDrawdownUsd) : '') +
    kpi('Open trades', stats.openTrades, 'excluded from win rate') +
    '</div>' +
    (stats.hasData
      ? breakdown('By direction', stats.byDirection) + breakdown('By coin', stats.byCoin) +
        breakdown('By timeframe', stats.byTimeframe) + breakdown('By month', stats.byMonth)
      : '<p class="hint">No closed trades yet — analytics fill in as paper trades close. Every signal, including rejected and expired ones, is recorded.</p>');
}

/* ---------------- Settings / logs ---------------- */
export function renderLogs(logs) {
  const wrap = document.getElementById('eventLogs');
  if (!wrap) return;
  if (!logs || !logs.length) {
    wrap.innerHTML = '<p class="hint">No events yet.</p>';
    return;
  }
  wrap.innerHTML = logs.slice(0, 100).map((l) =>
    '<div class="log-row"><span class="log-ts">' + fmtTime(l.ts) + '</span>' +
    '<span class="log-type">' + esc(l.type) + '</span>' +
    '<span>' + esc(l.message) + (l.detail ? ' <span class="hint">' + esc(String(l.detail)) + '</span>' : '') + '</span></div>'
  ).join('');
}

export function renderHealth(ctx) {
  const el = document.getElementById('systemHealth');
  if (!el) return;
  el.innerHTML =
    '<div class="liq-row"><span>REST base in use</span><span>' + esc(ctx.restBase || '–') + '</span></div>' +
    '<div class="liq-row"><span>WebSocket</span><span>' + esc(ctx.wsStatus || '–') + '</span></div>' +
    '<div class="liq-row"><span>Stale symbols (&gt;60s)</span><span>' + (ctx.stale && ctx.stale.length ? esc(ctx.stale.join(', ')) : 'none') + '</span></div>' +
    '<div class="liq-row"><span>Rate-limit backoff</span><span>' + (ctx.backoffUntil && ctx.backoffUntil > Date.now() ? 'until ' + fmtTime(ctx.backoffUntil) : 'none') + '</span></div>' +
    '<div class="liq-row"><span>Last scan</span><span>' + (ctx.scan ? timeAgo(ctx.scan.scannedAt) : 'never') + '</span></div>' +
    '<div class="liq-row"><span>Charts library</span><span>' + (ctx.chartsOk ? 'Lightweight Charts loaded' : 'CDN unavailable — canvas fallback') + '</span></div>';
}
