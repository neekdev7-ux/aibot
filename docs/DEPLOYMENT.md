# Deployment

The frontend and backend deploy independently. Most users only need the
frontend (GitHub Pages). Deploy the backend only if you want server-side
scanning, persistent trades, or the REST API.

## Static frontend — GitHub Pages

The repo is already Pages-ready: `index.html` at the root, `.nojekyll`
present (so GitHub serves the files as-is without Jekyll processing), no
build step, every file well under 100 KB.

1. Push the repo to GitHub (any branch; `main` is conventional).
2. Repo → **Settings → Pages**.
3. Under **Build and deployment → Source**, select **Deploy from a branch**.
4. Branch: `main`, folder: `/ (root)`. Save.
5. Wait for the Pages build; the site appears at
   `https://<user>.github.io/<repo>/`.

Notes:

- `.nojekyll` must stay at the repo root, or GitHub may skip files/dirs
  starting with `_` or `.`.
- The frontend calls Binance public endpoints directly from the visitor's
  browser, so it works from any static host (Netlify, Vercel, Cloudflare
  Pages, S3, nginx) — GitHub Pages is just the simplest.
- The only CDN dependency is TradingView Lightweight Charts
  (`unpkg.com/lightweight-charts@4.2.0`); charts fall back to a built-in
  canvas renderer if it fails to load.
- There is no server-side secret to configure for the frontend.

## Backend — VPS / cloud (Docker)

Prerequisites: a host with Docker + Docker Compose v2 and ports 80/443
(or 8000) open.

```bash
git clone <your-repo-url> niva-quant-ai
cd niva-quant-ai
cp backend/.env.example backend/.env
```

### 1. Configure `.env`

At minimum, change these from the dev defaults:

```bash
# Strong, unique Postgres password (also update it in docker-compose.yml,
# which sets POSTGRES_PASSWORD for the db service — the two must match).
DATABASE_URL=postgresql+asyncpg://niva:<strong-password>@db:5432/niva_quant

# Your frontend origin(s), so browsers may call the API.
CORS_ORIGINS=https://<your-frontend-domain>
```

Review the rest in `backend/.env.example` (scan cadence, thresholds,
rate limit). `PAPER_TRADING` must stay `true` — the app rejects `false`.

### 2. Start

```bash
docker compose up -d
docker compose ps
curl http://localhost:8000/health
curl http://localhost:8000/api/health
```

### 3. Reverse proxy (recommended)

Do not expose Postgres (5432) or Redis (6379) publicly. Put the API behind
a reverse proxy with TLS. Example nginx:

```nginx
server {
    listen 443 ssl;
    server_name api.example.com;
    # ssl_certificate / ssl_certificate_key here (e.g. certbot)

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket live feed
    location /ws {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### 4. Health checks

- `GET /health` — liveness: `{"status":"ok","paper_trading":true}`.
  Used by the compose healthcheck for the `api` service.
- `GET /api/health` — component detail: `db`, `redis`, `ws_ingest`,
  `scanner`, each `ok` / `error` / `disabled`; overall `status` is `ok`
  or `degraded`. Wire this into your monitoring/alerting.
- Compose already healthchecks Postgres (`pg_isready`) and Redis
  (`redis-cli ping`); the API waits for both before starting.

### 5. Backups

Postgres data lives in the `niva_pgdata` Docker volume (paper trades,
settings, logs). Back it up regularly:

```bash
# Logical backup (safe while running)
docker compose exec db pg_dump -U niva -d niva_quant > niva_quant_$(date +%F).sql

# Restore into a fresh stack
docker compose down -v
docker compose up -d db
docker compose exec -T db psql -U niva -d niva_quant < niva_quant_YYYY-MM-DD.sql
docker compose up -d
```

Redis (`niva_redisdata`) holds only cache — no backup needed.

### 6. Updates

```bash
git pull
docker compose up -d --build api
```

Database schema changes (if any in future versions) must be applied
manually — `schema.sql` runs only on first boot of a fresh volume.

## Geo restrictions

Binance USDT-M Futures REST (`fapi.binance.com`, `fapi1/2/3`) and WS
(`fstream.binance.com`) are **geo-restricted in some regions and clouds**:
from a blocked network, `fapi.binance.com` returns **HTTP 451**
("Service unavailable from a restricted location"), and the alternate
hosts may redirect. `data-api.binance.vision` is reachable from more
networks but serves **spot `/api/v3` only — it 404s all `/fapi/v1`
paths**, so it cannot supply futures data.

What this means in practice:

- The app tries every configured base URL in order (`BINANCE_BASES`) and
  uses the first that works. In an unrestricted network, `fapi.binance.com`
  works directly.
- In a restricted network (some clouds/VPS regions), **all** futures hosts
  may fail. The app then fails honestly: the scanner logs the Binance
  errors, `/api/scanner` reports them, REST endpoints return HTTP 502
  `Binance unreachable: ...`, and the frontend shows an error / empty
  state. **It never fabricates prices, signals, or history to fill the
  gap.**
- If you deploy the backend to a restricted region, the scanner will not
  produce signals until you move it to an unrestricted region or network.
  The frontend, running in each visitor's own browser, works wherever
  that visitor's network can reach Binance.

Verified from the author's environment (2026-11-19): vision
`/fapi/v1/ticker/24hr` → 404, vision `/api/v3/ticker/price` → 200
(spot control, real price returned), `fapi.binance.com` → 451.
