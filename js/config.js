/* NIVA QUANT AI — config.js
   Settings defaults, localStorage keys, Binance endpoints.
   No API key. All data from Binance public market data only. */
'use strict';

export const BINANCE_BASES = [
  'https://data-api.binance.vision', // FIRST: api.binance.com is 451 geo-blocked in agent cloud
  'https://fapi.binance.com',
];

export const WS_URLS = [
  'wss://fstream.binance.com',
  'wss://data-stream.binance.vision',
];

export const LS_KEYS = {
  settings: 'niva_settings_v1',
  trades: 'niva_trades_v1',
  signals: 'niva_signals_v1', // ALL signals incl. rejected/expired (analytics)
  scanCache: 'niva_scan_v1',
  cooldowns: 'niva_cooldowns_v1',
  logs: 'niva_logs_v1',
};

export const TIMEFRAMES = ['5m', '15m', '1h', '4h'];
export const HTF_MAP = { '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d' };

/* A $1-pegged coin cannot give a trade signal: its price barely moves, so
   indicator scores on its flat series are pure noise — RWUSD scored 97/100
   while pinned to $1 (Nova, 2026-11-15). Two guards: explicit pegged bases
   plus a <0.2% 24h range peg guard in binance.js. */
export const STABLE_BASES = new Set([
  'USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'USD1', 'USDE', 'PYUSD',
  'BUSD', 'USTC', 'UST', 'USDJ', 'GUSD', 'LUSD', 'FRAX', 'WUSD', 'AEUR',
  'EURI', 'EURS', 'XUSD', 'RWUSD', 'USDD', 'DUSD', 'SUSD', 'MIM',
]);

/* Leveraged-token bases never trade as perpetuals, but guard anyway. */
export const EXCLUDED_PATTERNS = ['UPUSDT', 'DOWNUSDT', 'BULL', 'BEAR'];

export const SCORE_WEIGHTS = {
  structure: 15,
  orderflow: 20,
  footprint: 15,
  sweep: 15,
  volume: 10,
  vwap: 10,
  trend: 10,
  liquidity: 5,
}; // total 100

export function scoreClass(score) {
  if (score >= 85) return 'High Confluence';
  if (score >= 75) return 'Strong Setup';
  if (score >= 65) return 'Watchlist';
  return 'No Trade';
}

export const DEFAULT_SETTINGS = {
  market: 'Binance USDT-M Futures',
  biasTf: '4h',        // HTF bias
  biasTf2: '1h',       // HTF bias confirmation
  setupTf: '15m',      // setup timeframe
  entryTf: '5m',       // entry timeframe
  minScore: 75,        // signals below this are recorded as rejected
  watchlistScore: 65,
  minVolume24h: 5_000_000, // USDT quote volume
  minLiquidityUsd: 50_000, // top-of-book depth (bids+asks, $) within 1%
  maxSpreadPct: 0.10,      // %
  minAtrPct: 0.10,         // % — below this the pair barely moves
  maxAtrPct: 8,            // % — above this is abnormal volatility
  minRR: 2,                // minimum risk:reward
  atrSlBuffer: 0.25,       // ATR added beyond the swing for SL
  atrSlMultiplier: 1.5,    // fallback SL distance when no swing exists
  vwapLookback: 50,        // candles for session VWAP
  cvdLookback: 100,        // aggTrades window for CVD slope
  footprintImbalance: 300, // % — stacked/diagonal imbalance threshold
  largeTradeUsd: 50_000,   // large-trade detection threshold
  cooldownMin: 30,         // minutes after a closed trade before re-entry
  signalExpiryMin: 60,     // minutes before an unfilled signal expires
  paperTrading: true,      // default ON — real trading is NOT implemented
  scannerOn: true,
  scanIntervalMin: 5,
  scanLimit: 60,           // top-N by volume scanned per pass
  maxConcurrent: 6,        // bounded concurrency for enrichment
  feePct: 0.04,            // taker fee % per side (backtest / paper fills)
  slippagePct: 0.02,       // slippage % per fill (backtest)
  fundingSim: true,        // simulate funding payments in backtest
  paperCapital: 10_000,    // simulated USDT starting capital
  riskPerTradePct: 1,      // simulated position sizing: % of capital risked
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEYS.settings) || '{}');
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(LS_KEYS.settings, JSON.stringify(settings));
  } catch (e) { /* storage full/blocked — settings stay in memory */ }
}
