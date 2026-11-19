# NIVA QUANT AI

An institutional-style crypto trading scanner for **Binance USDT-M Futures**.
It scans the top USDT perpetuals by volume, scores each pair on an
8-factor 100-point confluence model (structure, order flow, footprint,
liquidity sweeps, volume, VWAP, trend strength, liquidity quality), and
produces paper-trading signals with locked entry / stop-loss / take-profit
levels at a minimum 1:2 risk:reward.

**Paper trading is the default and the only mode. Real trading is not
implemented anywhere in this repo — there is no order-placement code, no
API-key handling, and no way to turn paper trading off.**

All market data comes from Binance public endpoints only. No API key is
needed. The app never fabricates data: if Binance is unreachable (for
example a geo-restricted network), it reports the outage honestly and
shows empty state instead of inventing prices, signals, or history.

## Architecture

Two parts that work independently:

```
┌─────────────────────────────────────────────────────────────────┐
│  STATIC FRONTEND  (index.html + styles.css + js/)               │
│  Works standalone — open index.html or serve it statically.     │
│  Calls Binance public REST/WS directly from the browser.        │
│  State in localStorage. No backend required.                    │
│  Deploys to GitHub Pages as-is.                                 │
└─────────────────────────────────────────────────────────────────┘
                            (independent — no shared state)
┌─────────────────────────────────────────────────────────────────┐
│  OPTIONAL BACKEND  (backend/ — FastAPI + Postgres + Redis)      │
│  Same scanner/scoring logic in Python, plus a REST API, a /ws   │
│  live feed, persistent paper trades, backtests, and analytics.  │
│  Runs with: docker compose up                                   │
└─────────────────────────────────────────────────────────────────┘
```

The frontend does **not** call the backend — it is fully self-contained.
The backend is a separate deployment for anyone who wants server-side
scanning, persistent trades, and an API. Both implement the same scoring
weights and the same trade state machine.

## Features

### Frontend (`js/`)

| Module | What it does |
|---|---|
| `config.js` | Defaults, localStorage keys, Binance endpoints, stablecoin/leveraged-token exclusion lists, score weights |
| `binance.js` | Binance public REST client with base-URL fallback (vision → fapi), klines, aggTrades, depth, tickers, funding |
| `ws.js` | Live WebSocket streams (aggTrade / markPrice / depth) with reconnect and stale detection |
| `structure.js` | Market structure on confirmed candles: swings, BOS/CHoCH, liquidity pools, sweep detection |
| `orderflow.js` | Aggressive buy/sell volume, delta, CVD slope, large trades from real aggTrades |
| `footprint.js` | Price-level bid/ask traded volume, delta, stacked/diagonal imbalance, delta divergence |
| `book.js` | Local order book from REST snapshots + WS deltas; resting walls, imbalance, spread |
| `indicators.js` | ATR, EMA, RSI, VWAP, ADX, volume profile on candle series |
| `scoring.js` | 100-point confluence score, per-direction, with reasons and missing-data notes |
| `signals.js` | Signal gates (HTF bias, structure, sweep, flow, footprint, VWAP, volume, min 1:2 R:R) and expiry |
| `scanner.js` | Two-pass scan: fast technicals first, orderflow + HTF enrichment for candidates only |
| `trades.js` | Paper-trade state machine, locked levels, TP1 50% partial, conservative TP/SL handling |
| `backtest.js` | Backtests on real klines with fee/slippage/funding simulation |
| `analytics.js` | Win rate (closed trades only), profit factor, expectancy, equity curve, breakdowns |
| `charts.js` | TradingView Lightweight Charts (CDN) with a built-in canvas fallback |
| `ui.js` | All section rendering, KPIs, tables, toasts |
| `app.js` | Wiring: navigation, scan loop, WS subscriptions, settings, export |
| `utils.js` | Shared helpers (clamp, formatting, time) |

Sections in the UI: Overview, Live Scanner, AI Signals, Order Flow,
Footprint, Liquidity Map, Coin Analysis, Active Trades, Trade History,
Backtesting, Analytics, Settings.

### Backend (`backend/app/`)

| Module | What it does |
|---|---|
| `main.py` | FastAPI app: CORS, per-IP rate limit, REST router, `/ws` live feed, lifespan (scanner loop + WS ingest + trade recovery) |
| `api.py` | All REST endpoints (see [docs/API.md](docs/API.md)) |
| `scanner.py` | Two-pass server scanner, runs every `SCAN_INTERVAL_SECONDS` (default 300s) |
| `signals.py` | 100-point confluence scoring + SL/TP level construction (same weights as frontend) |
| `structure.py` | Swings, BOS/CHoCH, liquidity pools, sweeps (confirmed candles only) |
| `orderflow.py` | Delta, CVD, large trades from aggTrades |
| `footprint.py` | Footprint builder from aggTrades + tick size |
| `liquidity.py` | Local book, imbalance, wall detection |
| `indicators.py` | ATR, EMA, RSI, VWAP, ADX |
| `market_data.py` | Async Binance client with base-URL fallback |
| `ws_ingest.py` | Binance WS ingestion with auto-reconnect and staleness detection |
| `trade_lock.py` | Paper-trade state machine with persistence and restart recovery |
| `backtest.py` | Server backtests on real klines |
| `analytics.py` | Metrics + breakdowns from stored paper trades |
| `admin.py` | Settings CRUD, scanner enable/disable, health aggregation, event logs |
| `db.py` | Postgres trade store (canonical) + in-memory fallback + Redis health |
| `models.py` | SQLAlchemy models mirroring `schema.sql` |
| `config.py` | All settings from environment variables (pydantic-settings) |

## Scoring — exact 100-point weights

Identical in `js/config.js` (`SCORE_WEIGHTS`), `js/scoring.js`, and
`backend/app/signals.py` (`WEIGHTS`, asserted to sum to 100).

| Factor | Weight |
|---|---|
| Structure (BOS/CHoCH, swing alignment, HTF bias) | **15** |
| Order Flow / CVD (delta, CVD slope, taker ratio) | **20** |
| Footprint (imbalance, delta divergence) | **15** |
| Liquidity Sweep (recent sweep + reclaim) | **15** |
| Volume (relative volume vs average) | **10** |
| VWAP (price vs VWAP, distance) | **10** |
| Trend Strength (ADX) | **10** |
| Liquidity Quality (book depth, spread) | **5** |
| **Total** | **100** |

Score classes: **85–100** High Confluence · **75–84** Strong Setup ·
**65–74** Watchlist · **<65** No Trade. A signal also needs every gate to
pass (HTF bias, structure, sweep, flow, footprint, VWAP, volume) plus a
computable SL/TP at ≥ 1:2 R:R. Missing data scores 0 for that block and is
listed as missing — never guessed.

## Trade state machine

```
SCANNING → SETUP → SIGNAL_CONFIRMED → ENTRY_LOCKED → ACTIVE
   ↑                                                │
   │                                                ▼
   └────────── RE_ENTRY ← COOLDOWN ← CLOSED ← TP_SL_HIT
```

Any live state (`SETUP`, `SIGNAL_CONFIRMED`, `ENTRY_LOCKED`, `ACTIVE`) may
also transition directly to `CLOSED` (manual close / cancel). Rules:

- Entry/SL/TP1/TP2 **lock at creation and never move** (except the SL moves
  to breakeven on the remaining 50% after TP1).
- **TP1 closes 50%**; the rest runs to TP2.
- On a tick/candle that touches both TP and SL, the **SL is assumed hit
  first** (conservative).
- **No duplicate live trade** per coin + direction (unique partial index in
  `schema.sql` + app-level check).
- **30-minute cooldown** after a close before re-entry on the same pair.
- Backend restarts **recover ACTIVE / ENTRY_LOCKED trades** from the store.

## Quickstart

### Frontend only (no install)

```bash
# Option A: open index.html directly in a browser
# Option B: serve statically
npx serve .            # or:
python3 -m http.server 8080
# then open http://localhost:8080
```

No build step, no dependencies. The only external resource is the
TradingView Lightweight Charts CDN (charts fall back to a built-in canvas
renderer if it fails to load).

### Backend (optional)

```bash
cd backend
cp .env.example .env   # adjust if needed
cd ..
docker compose up -d   # Postgres + Redis + API on http://localhost:8000
curl http://localhost:8000/health
```

Without Docker: `python3 -m venv .venv && source .venv/bin/activate &&
pip install -r backend/requirements.txt`, then run Postgres/Redis yourself
and start with `uvicorn app.main:app --host 0.0.0.0 --port 8000` from
`backend/`. Full steps in [docs/INSTALL.md](docs/INSTALL.md).

## Configuration summary

Frontend settings live in the Settings panel (stored in localStorage);
backend settings are environment variables (see `backend/.env.example`).
Key defaults, shared across both:

| Setting | Default | Meaning |
|---|---|---|
| Bias timeframes | 4h + 1h | Higher-timeframe bias must agree |
| Setup timeframe | 15m | Where the setup is scored |
| Entry timeframe | 5m | Entry timing |
| Min score | 65 (backend) / 75 (frontend signal gate) | Below this: no signal |
| Min R:R | 2.0 | No signal without ≥ 1:2 SL/TP |
| Cooldown | 30 min | After a close, before re-entry |
| Scan interval | 5 min | Scanner cadence |
| Scan top-N | 60 | Top pairs by 24h quote volume |
| Paper trading | `true` | The only mode — cannot be disabled |

Full lists: `js/config.js` (`DEFAULT_SETTINGS`) and
`backend/.env.example`.

## Honesty — read this before using it

- **Paper trading only.** Real trading is not implemented. Nothing in this
  repo places orders, holds API keys, or touches an exchange account.
- **The confluence score is NOT a win probability.** A 90/100 signal is not
  a 90% chance of winning. It measures how many independent conditions
  agree — nothing more.
- **A 70% win rate is an unvalidated research target, not a claim.**
  No win rate is claimed for this system. The only win-rate figures the app
  ever shows come from real stored paper trades (closed trades only — open
  trades are never counted), or show as empty when there are none.
- **Backtests are historical simulations, not a guarantee of future
  performance.** They run on real klines with fee, slippage, and funding
  simulation — but past results do not predict future ones.
- **No simulated data.** Prices, signals, and histories come from real
  Binance public data or real stored paper trades. If Binance is
  unreachable, the app says so and shows empty state.
- **Signals are not financial advice.** Trade at your own risk.

## Repo layout

```
niva-quant-ai/
├── index.html            # UI shell (12 sections) + honesty footer
├── styles.css            # All styling
├── js/                   # Frontend ES modules (18 files, no build step)
├── package.json          # {"type":"module"} — only so node --check works
├── .nojekyll             # GitHub Pages: serve as-is, no Jekyll
├── docker-compose.yml    # db (Postgres 16) + redis (7) + api
├── README.md             # this file
├── docs/
│   ├── INSTALL.md        # prerequisites + first run
│   ├── DEPLOYMENT.md     # GitHub Pages + VPS/cloud backend
│   ├── API.md            # every backend endpoint
│   └── TESTING.md        # how to run every check
└── backend/
    ├── Dockerfile        # python:3.12-slim, uvicorn on :8000
    ├── requirements.txt  # FastAPI, httpx, SQLAlchemy/asyncpg, redis, pytest
    ├── .env.example      # config template (copy to .env)
    ├── schema.sql        # Postgres schema (canonical)
    ├── app/              # FastAPI application (18 modules)
    └── tests/            # pytest suite (49 tests)
```

## Docs

- [Installation](docs/INSTALL.md)
- [Deployment](docs/DEPLOYMENT.md)
- [API reference](docs/API.md)
- [Testing](docs/TESTING.md)
