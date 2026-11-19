/* NIVA QUANT AI — trades.js
   Paper-trade state machine, localStorage-persisted, survives reload.
   SCANNING → SETUP → SIGNAL CONFIRMED → ENTRY LOCKED → ACTIVE →
   TP/SL HIT → CLOSED → COOLDOWN → RE-ENTRY.
   Locked entry/SL/TP never move. One active signal per coin+direction.
   Partial TP1 (50%). Realized R. SL-first on same-candle TP+SL ambiguity.
   Paper trading only — real trading is NOT implemented. */
'use strict';

import { LS_KEYS } from './config.js';
import { logEvent } from './utils.js';

export const TRADE_STATES = [
  'SCANNING', 'SETUP', 'SIGNAL CONFIRMED', 'ENTRY LOCKED',
  'ACTIVE', 'TP/SL HIT', 'CLOSED', 'COOLDOWN', 'RE-ENTRY',
];

export function loadTrades() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS.trades) || '[]'); }
  catch (e) { return []; }
}

function saveTrades(trades) {
  try { localStorage.setItem(LS_KEYS.trades, JSON.stringify(trades.slice(0, 500))); }
  catch (e) {}
}

export function loadCooldowns() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS.cooldowns) || '{}'); }
  catch (e) { return {}; }
}

function saveCooldowns(map) {
  try { localStorage.setItem(LS_KEYS.cooldowns, JSON.stringify(map)); }
  catch (e) {}
}

export function cooldownKey(symbol, dir) { return symbol + '|' + dir; }

export function cooldownRemaining(symbol, dir, now = Date.now()) {
  const map = loadCooldowns();
  const until = map[cooldownKey(symbol, dir)];
  return until && until > now ? until - now : 0;
}

/* One active trade per coin+direction. */
export function hasActiveTrade(symbol, dir) {
  return loadTrades().some((t) =>
    t.symbol === symbol && t.dir === dir &&
    ['ACTIVE', 'ENTRY LOCKED', 'SIGNAL CONFIRMED'].includes(t.state));
}

/* Create a trade from a confirmed signal. Entry/SL/TP are LOCKED here
   and never change afterwards. */
export function openTradeFromSignal(signal, settings) {
  if (hasActiveTrade(signal.symbol, signal.dir)) {
    return { error: 'An active ' + signal.dir + ' trade already exists for ' + signal.symbol };
  }
  const cd = cooldownRemaining(signal.symbol, signal.dir);
  if (cd > 0) {
    return { error: signal.symbol + ' ' + signal.dir + ' is in cooldown for ' + Math.ceil(cd / 60000) + ' more minutes' };
  }
  const risk = Math.abs(signal.entry - signal.sl);
  const capital = settings.paperCapital || 10000;
  const riskUsd = capital * ((settings.riskPerTradePct || 1) / 100);
  const qty = risk > 0 ? riskUsd / risk : 0;
  const trade = {
    id: 'T-' + signal.symbol + '-' + signal.dir + '-' + Date.now(),
    signalId: signal.id,
    symbol: signal.symbol,
    dir: signal.dir,
    score: signal.score,
    state: 'ENTRY LOCKED',
    entry: signal.entry, sl: signal.sl, tp1: signal.tp1, tp2: signal.tp2,
    risk, qty: +qty.toFixed(6),
    riskUsd: +riskUsd.toFixed(2),
    paper: true,
    tp1Hit: false,
    tp1PartialR: 0,
    realizedR: 0,
    realizedPnl: 0,
    createdAt: Date.now(),
    lockedAt: Date.now(),
    activatedAt: null,
    closedAt: null,
    closeReason: null,
    closePrice: null,
    history: [{ ts: Date.now(), state: 'ENTRY LOCKED', note: 'Entry/SL/TP locked from signal ' + signal.score + '/100' }],
  };
  const trades = loadTrades();
  trades.unshift(trade);
  saveTrades(trades);
  logEvent('trade', 'Trade locked: ' + trade.symbol + ' ' + trade.dir.toUpperCase() + ' @ ' + trade.entry, trade.id);
  return { trade };
}

export function transition(trade, newState, note) {
  trade.state = newState;
  trade.history.push({ ts: Date.now(), state: newState, note: note || '' });
  const trades = loadTrades();
  const idx = trades.findIndex((t) => t.id === trade.id);
  if (idx >= 0) { trades[idx] = trade; saveTrades(trades); }
  logEvent('trade', trade.symbol + ' ' + trade.dir.toUpperCase() + ' → ' + newState, note || trade.id);
  return trade;
}

/* Activate a locked trade once live price touches entry (within 0.05%
   tolerance). Paper fill at the locked entry price. */
export function maybeActivate(trade, livePrice) {
  if (trade.state !== 'ENTRY LOCKED') return false;
  const tol = trade.entry * 0.0005;
  if (Math.abs(livePrice - trade.entry) <= tol
      || (trade.dir === 'long' && livePrice <= trade.entry)
      || (trade.dir === 'short' && livePrice >= trade.entry)) {
    trade.activatedAt = Date.now();
    transition(trade, 'ACTIVE', 'Filled at locked entry ' + trade.entry);
    return true;
  }
  return false;
}

/* Evaluate an ACTIVE trade against a live price tick.
   SL-first on same-tick TP+SL ambiguity: if both levels are touched by
   one tick, the SL is assumed hit first (conservative). */
export function evaluateTrade(trade, livePrice, settings) {
  if (trade.state !== 'ACTIVE') return null;
  const bull = trade.dir === 'long';
  const hitSL = bull ? livePrice <= trade.sl : livePrice >= trade.sl;
  const hitTP1 = !trade.tp1Hit && (bull ? livePrice >= trade.tp1 : livePrice <= trade.tp1);
  const hitTP2 = bull ? livePrice >= trade.tp2 : livePrice <= trade.tp2;
  const feePct = (settings.feePct || 0) / 100;
  const slipPct = (settings.slippagePct || 0) / 100;
  const feePerUnit = trade.entry * feePct * 2; // entry + exit
  const slipPerUnit = trade.entry * slipPct;

  // SL first — conservative on ambiguity.
  if (hitSL) {
    const pnlPerUnit = bull ? (trade.sl - trade.entry) : (trade.entry - trade.sl);
    return closeTrade(trade, trade.sl, 'SL HIT', pnlPerUnit, feePerUnit + slipPerUnit, settings);
  }
  if (hitTP1) {
    // Partial TP1: close 50% at TP1, bank 50% of the R, rest runs to TP2.
    trade.tp1Hit = true;
    const r1 = Math.abs(trade.tp1 - trade.entry) / trade.risk;
    const partialPnl = (Math.abs(trade.tp1 - trade.entry) - feePerUnit - slipPerUnit) * trade.qty * 0.5;
    trade.tp1PartialR = +(r1 * 0.5).toFixed(3);
    trade.realizedR = trade.tp1PartialR;
    trade.realizedPnl = +partialPnl.toFixed(2);
    trade.history.push({ ts: Date.now(), state: 'ACTIVE', note: 'TP1 hit — 50% closed at ' + trade.tp1 + ' (' + r1.toFixed(2) + 'R), rest runs to TP2' });
    const trades = loadTrades();
    const idx = trades.findIndex((t) => t.id === trade.id);
    if (idx >= 0) { trades[idx] = trade; saveTrades(trades); }
    logEvent('trade', trade.symbol + ' TP1 hit — 50% closed', trade.id);
    return { event: 'TP1', trade };
  }
  if (hitTP2) {
    const pnlPerUnit = bull ? (trade.tp2 - trade.entry) : (trade.entry - trade.tp2);
    return closeTrade(trade, trade.tp2, 'TP2 HIT', pnlPerUnit, feePerUnit + slipPerUnit, settings, true);
  }
  return null;
}

function closeTrade(trade, closePrice, reason, pnlPerUnit, costPerUnit, settings, isTP2 = false) {
  const remaining = trade.tp1Hit ? 0.5 : 1;
  const netPerUnit = pnlPerUnit - costPerUnit;
  const pnl = netPerUnit * trade.qty * remaining;
  const rFull = pnlPerUnit / trade.risk;
  const realizedR = trade.tp1Hit
    ? trade.tp1PartialR + rFull * 0.5
    : rFull;
  trade.closePrice = closePrice;
  trade.closeReason = reason;
  trade.closedAt = Date.now();
  trade.realizedR = +realizedR.toFixed(3);
  trade.realizedPnl = +((trade.realizedPnl || 0) + pnl).toFixed(2);
  transition(trade, 'TP/SL HIT', reason + ' at ' + closePrice);
  transition(trade, 'CLOSED', 'Realized ' + trade.realizedR.toFixed(2) + 'R (' + (trade.realizedPnl >= 0 ? '+' : '') + '$' + trade.realizedPnl.toFixed(2) + ')');
  // Cooldown starts at close.
  const map = loadCooldowns();
  map[cooldownKey(trade.symbol, trade.dir)] = Date.now() + (settings.cooldownMin || 30) * 60 * 1000;
  saveCooldowns(map);
  logEvent('trade', trade.symbol + ' closed: ' + reason + ' ' + trade.realizedR.toFixed(2) + 'R', trade.id);
  return { event: reason, trade };
}

/* Manual close (user-initiated) at the live price. */
export function manualClose(tradeId, livePrice, settings) {
  const trades = loadTrades();
  const trade = trades.find((t) => t.id === tradeId);
  if (!trade || trade.state !== 'ACTIVE') return { error: 'Trade is not active' };
  const bull = trade.dir === 'long';
  const pnlPerUnit = bull ? (livePrice - trade.entry) : (trade.entry - livePrice);
  const feePct = (settings.feePct || 0) / 100;
  const costPerUnit = trade.entry * feePct * 2 + trade.entry * ((settings.slippagePct || 0) / 100);
  return closeTrade(trade, livePrice, 'MANUAL CLOSE', pnlPerUnit, costPerUnit, settings);
}

/* Cancel a locked (not yet active) trade. */
export function cancelLocked(tradeId) {
  const trades = loadTrades();
  const trade = trades.find((t) => t.id === tradeId);
  if (!trade || trade.state !== 'ENTRY LOCKED') return { error: 'Trade is not in ENTRY LOCKED state' };
  transition(trade, 'CLOSED', 'Cancelled before fill — no P&L');
  trade.closeReason = 'CANCELLED';
  trade.closedAt = Date.now();
  const all = loadTrades();
  const idx = all.findIndex((t) => t.id === trade.id);
  if (idx >= 0) { all[idx] = trade; saveTrades(all); }
  return { trade };
}

/* Auto-close / activate all live trades against a price map { symbol: price }. */
export function tickTrades(priceMap, settings) {
  const trades = loadTrades();
  const events = [];
  for (const trade of trades) {
    const price = priceMap[trade.symbol];
    if (price == null) continue;
    if (trade.state === 'ENTRY LOCKED') {
      if (maybeActivate(trade, price)) events.push({ event: 'ACTIVATED', trade });
    } else if (trade.state === 'ACTIVE') {
      const ev = evaluateTrade(trade, price, settings);
      if (ev) events.push(ev);
    }
  }
  return events;
}

export function activeTrades() {
  return loadTrades().filter((t) => ['ACTIVE', 'ENTRY LOCKED', 'SIGNAL CONFIRMED'].includes(t.state));
}

export function closedTrades() {
  return loadTrades().filter((t) => t.state === 'CLOSED');
}
