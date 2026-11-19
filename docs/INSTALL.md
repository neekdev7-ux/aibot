# Installation

## Prerequisites

| Part | Needs |
|---|---|
| Static frontend | A modern browser. Nothing else. (Optional: any static file server.) |
| Backend (Docker path) | Docker + Docker Compose v2 |
| Backend (manual path) | Python 3.12, PostgreSQL 16, Redis 7 |

No API key is needed anywhere — all market data comes from Binance public
endpoints.

## Static frontend — no install

The frontend is plain HTML/CSS/ES-module JavaScript with no build step and
no dependencies. The only external resource is the TradingView Lightweight
Charts CDN (`unpkg.com`); if it fails to load, charts fall back to a
built-in canvas renderer.

```bash
# Option A: open index.html directly in a browser (file:// works)
# Option B: serve it statically — any of these:
python3 -m http.server 8080
npx serve .
npx http-server .
# then open http://localhost:8080
```

`package.json` exists only so `node --check` validates the ES modules
correctly (`{"type": "module"}`); there is nothing to `npm install`.

State (settings, paper trades, signals, logs) is stored in the browser's
localStorage under keys prefixed `niva_`. Clearing site data resets it.

## Backend — Docker (recommended)

```bash
cd backend
cp .env.example .env   # review the values; see "Configuration" below
cd ..
docker compose up -d
```

This starts three services:

- `db` — PostgreSQL 16, port 5432. `backend/schema.sql` is applied
  automatically on first boot (fresh volume only).
- `redis` — Redis 7, port 6379.
- `api` — the FastAPI app, built from `backend/Dockerfile`, port 8000.

Check it is up:

```bash
docker compose ps
curl http://localhost:8000/health
# {"status":"ok","paper_trading":true}
curl http://localhost:8000/api/health
```

To stop: `docker compose down`. To wipe the database and start fresh:
`docker compose down -v` (deletes the `niva_pgdata` / `niva_redisdata`
volumes).

## Backend — manual (no Docker)

```bash
# 1. Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# 2. Postgres + Redis — install and start them yourself, then:
createdb niva_quant
psql -d niva_quant -f backend/schema.sql

# 3. Environment
cp backend/.env.example backend/.env
# edit backend/.env: set DATABASE_URL / REDIS_URL to your local services

# 4. Run
cd backend
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

If Postgres is unavailable at startup, the API still boots and falls back
to an in-memory trade store (logged as a warning); paper trades then do not
survive a restart. `/api/health` reports the degraded state honestly —
see [API.md](API.md).

## Configuration

All backend settings are environment variables, documented in
`backend/.env.example`. The important ones:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://niva:niva_dev_password@localhost:5432/niva_quant` | Change the password for any non-local deploy |
| `REDIS_URL` | `redis://localhost:6379/0` | |
| `BINANCE_BASES` | vision, fapi, fapi1, fapi2, fapi3 | Comma-separated, tried in order |
| `BINANCE_WS_BASE` | `wss://fstream.binance.com` | |
| `SCAN_INTERVAL_SECONDS` | 300 | Server scan cadence |
| `SCAN_TOP_N` | 60 | Top pairs by 24h quote volume |
| `SCAN_MIN_SCORE` | 65 | Backend signal threshold |
| `PAPER_TRADING` | `true` | The only mode — setting it `false` is rejected |
| `MIN_RR` | 2.0 | Minimum risk:reward for a signal |
| `COOLDOWN_MINUTES` | 30 | Post-close cooldown before re-entry |
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:8000` | Add your frontend origin if you host it elsewhere |
| `RATE_LIMIT_PER_MINUTE` | 120 | Per-IP sliding window (`/health` exempt) |
| `WS_ENABLED` | `true` | Set `false` to disable Binance WS ingestion |

Frontend settings are edited in the app's Settings panel and stored in
localStorage; defaults are in `js/config.js` (`DEFAULT_SETTINGS`).

## First-run checklist

Frontend:

- [ ] `index.html` opens and the Overview section renders.
- [ ] A scan runs (Live Scanner → Run scan) and returns real pairs — or an
      honest error if Binance futures endpoints are unreachable from your
      network (see [DEPLOYMENT.md](DEPLOYMENT.md#geo-restrictions)).
- [ ] The WS badge shows a live connection, or a clear disconnected state.

Backend:

- [ ] `curl http://localhost:8000/health` returns `{"status":"ok","paper_trading":true}`.
- [ ] `curl http://localhost:8000/api/health` shows all components `ok`
      (with Docker; manual runs without Postgres/Redis show `degraded`
      with per-component detail — that is expected, not a bug).
- [ ] `curl http://localhost:8000/api/scanner` shows the scanner loop running.
- [ ] `curl -X POST http://localhost:8000/api/scanner/scan` returns a scan
      result (or Binance errors, honestly reported, in a geo-restricted
      network).
- [ ] `pytest backend/tests/ -q` passes (see [TESTING.md](TESTING.md)).
