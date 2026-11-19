/* NIVA QUANT AI — analytics.js
   Computed ONLY from real stored trades/signals. Zero-state when none.
   Win rate = wins / closed trades only — open trades are never counted.
   Simulated P&L is paper P&L, labelled as such everywhere. */
'use strict';

import { loadTrades } from './trades.js';
import { loadSignalLog } from './signals.js';

export function zeroStats() {
  return {
    totalSignals: 0, active: 0, rejected: 0, expired: 0,
    closedTrades: 0, openTrades: 0,
    wins: 0, losses: 0, winRate: null,
    totalR: 0, avgR: null, avgWinR: null, avgLossR: null,
    profitFactor: null, expectancyR: null,
    simulatedPnl: 0, maxDrawdownR: 0, maxDrawdownUsd: 0,
    byDirection: {}, byCoin: {}, byTimeframe: {}, byMonth: {},
    hasData: false,
  };
}

function groupStats(trades) {
  const wins = trades.filter((t) => (t.realizedR || 0) > 0);
  const losses = trades.filter((t) => (t.realizedR || 0) <= 0);
  const totalR = trades.reduce((s, t) => s + (t.realizedR || 0), 0);
  const grossWin = wins.reduce((s, t) => s + (t.realizedR || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.realizedR || 0), 0));
  const pnl = trades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  return {
    trades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : null,
    totalR: +totalR.toFixed(2),
    avgR: trades.length ? +(totalR / trades.length).toFixed(3) : null,
    avgWinR: wins.length ? +(grossWin / wins.length).toFixed(3) : null,
    avgLossR: losses.length ? +(grossLoss / losses.length).toFixed(3) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null),
    simulatedPnl: +pnl.toFixed(2),
  };
}

export function computeAnalytics() {
  const trades = loadTrades();
  const signals = loadSignalLog();
  const stats = zeroStats();
  stats.totalSignals = signals.length;
  stats.active = signals.filter((s) => s.status === 'active').length;
  stats.rejected = signals.filter((s) => s.status === 'rejected').length;
  stats.expired = signals.filter((s) => s.status === 'expired').length;

  const closed = trades.filter((t) => t.state === 'CLOSED' && t.closeReason !== 'CANCELLED');
  const open = trades.filter((t) => ['ACTIVE', 'ENTRY LOCKED', 'SIGNAL CONFIRMED'].includes(t.state));
  stats.openTrades = open.length;
  stats.closedTrades = closed.length;
  if (!closed.length) return stats;
  stats.hasData = true;

  const g = groupStats(closed);
  Object.assign(stats, {
    wins: g.wins, losses: g.losses, winRate: g.winRate,
    totalR: g.totalR, avgR: g.avgR, avgWinR: g.avgWinR, avgLossR: g.avgLossR,
    profitFactor: g.profitFactor, expectancyR: g.avgR,
    simulatedPnl: g.simulatedPnl,
  });

  // Max drawdown (R and $) on the closed-trade equity curve, time-ordered.
  const ordered = closed.slice().sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  let peakR = 0, runR = 0, maxDDR = 0;
  let peakUsd = 0, runUsd = 0, maxDDUsd = 0;
  for (const t of ordered) {
    runR += t.realizedR || 0;
    if (runR > peakR) peakR = runR;
    maxDDR = Math.max(maxDDR, peakR - runR);
    runUsd += t.realizedPnl || 0;
    if (runUsd > peakUsd) peakUsd = runUsd;
    maxDDUsd = Math.max(maxDDUsd, peakUsd - runUsd);
  }
  stats.maxDrawdownR = +maxDDR.toFixed(2);
  stats.maxDrawdownUsd = +maxDDUsd.toFixed(2);

  // Breakdowns
  for (const dir of ['long', 'short']) {
    const sub = closed.filter((t) => t.dir === dir);
    if (sub.length) stats.byDirection[dir] = groupStats(sub);
  }
  const coins = {};
  for (const t of closed) { (coins[t.symbol] = coins[t.symbol] || []).push(t); }
  for (const [sym, sub] of Object.entries(coins)) stats.byCoin[sym] = groupStats(sub);
  const tfs = {};
  for (const t of closed) {
    const sig = signals.find((s) => s.id === t.signalId);
    const tf = (sig && sig.tf) || 'unknown';
    (tfs[tf] = tfs[tf] || []).push(t);
  }
  for (const [tf, sub] of Object.entries(tfs)) stats.byTimeframe[tf] = groupStats(sub);
  const months = {};
  for (const t of closed) {
    const d = new Date(t.closedAt || Date.now());
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    (months[key] = months[key] || []).push(t);
  }
  for (const [m, sub] of Object.entries(months)) stats.byMonth[m] = groupStats(sub);
  return stats;
}

/* Equity curve points for the Analytics chart (closed trades only). */
export function equityCurve() {
  const closed = loadTrades()
    .filter((t) => t.state === 'CLOSED' && t.closeReason !== 'CANCELLED')
    .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  let run = 0;
  return closed.map((t) => {
    run += t.realizedPnl || 0;
    return { t: t.closedAt, pnl: +run.toFixed(2), symbol: t.symbol, r: t.realizedR };
  });
}
