# API reference

Base URL: `http://localhost:8000` (or your deployed host). All responses are
JSON. Interactive docs are served by FastAPI at `/docs` (Swagger UI) and
`/redoc`.

**Paper trading only.** There are no real-trading endpoints anywhere in
this API — no order placement, no exchange credentials, no way to disable
paper trading (`PATCH /api/admin/settings` rejects `paper_trading: false`).

**No authentication.** The API has no auth layer; do not expose it to the
public internet without a reverse proxy with authentication in front of it.

## Error format

Errors use FastAPI's standard shape:

```json
{ "detail": "Trade not found" }
```

| Status | Meaning |
|---|---|
| 400 | Bad request — e.g. closing a non-live trade, unknown admin setting |
| 404 | Trade / backtest run not found |
| 409 | A scan is already running (`POST /api/scanner/scan`) |
| 429 | Per-IP rate limit exceeded (see Rate limiting) |
| 502 | Binance unreachable — the upstream error is included in `detail` |

## Rate limiting

Per-IP sliding window, `RATE_LIMIT_PER_MINUTE` (default 120 requests /
minute). `/health` and `/api/health` are exempt. Exceeding the limit
returns `429 {"detail": "Rate limit exceeded"}`. The limit is in-memory per
process (not shared across replicas).

## Health

### `GET /health`

Liveness probe. No dependencies checked.

```json
{ "status": "ok", "paper_trading": true }
```

### `GET /api/health`

Component health. Overall `status` is `ok`, or `degraded` if any component
reports `error`.

```json
{
  "status": "ok",
  "uptime_seconds": 1234.5,
  "paper_trading": true,
  "scanner_enabled": true,
  "components": {
    "db":      { "status": "ok" },
    "redis":   { "status": "ok" },
    "ws_ingest": { "status": "ok", "connected": true, "subscribed": 12 },
    "scanner": { "status": "ok", "last_scan_at": "2026-11-19T11:00:00+00:00" }
  },
  "checked_at": "2026-11-19T11:05:00.000000+00:00"
}
```

`ws_ingest` is `{"status": "disabled"}` when `WS_ENABLED=false`.

## Symbols

### `GET /api/symbols`

Eligible USDT perpetuals from Binance (live call).

| Param | Default | Notes |
|---|---|---|
| `top_n` | 60 | Capped at 200 |
| `min_quote_volume` | 0.0 | Minimum 24h quote volume (USDT) |

```json
{
  "count": 60,
  "symbols": [ { "symbol": "BTCUSDT", "quote_volume_24h": 123456789.0, "...": "..." } ],
  "note": "USDT perpetuals, TRADING only; stablecoins and leveraged tokens excluded."
}
```

Returns 502 if Binance is unreachable.

## Scanner

### `GET /api/scanner`

Current scanner state and the last scan summary.

```json
{
  "enabled": true,
  "running": false,
  "last_scan_at": "2026-11-19T11:00:00+00:00",
  "last_result": {
    "scanned": 60, "candidates": 12, "signals": 3,
    "skipped": 5, "errors": [],
    "duration_seconds": 42.1
  }
}
```

`last_result` is `null` until the first scan completes.

### `POST /api/scanner/scan`

Runs one scan synchronously and returns the result. Returns **409** if a
scan is already running.

```json
{
  "scanned": 60, "candidates": 12,
  "signals": [ { "symbol": "BTCUSDT", "direction": "long", "score": 87, "...": "..." } ],
  "skipped": 5, "errors": [], "duration_seconds": 42.1
}
```

Signal objects have the shape documented under `GET /api/signals`.

### `POST /api/scanner/enable` / `POST /api/scanner/disable`

Toggles the background scan loop (persisted in admin settings).

```json
{ "scanner_enabled": true }
```

## Signals

### `GET /api/signals`

Signals from the most recent scan.

```json
{
  "signals": [
    {
      "symbol": "BTCUSDT", "direction": "long", "score": 87,
      "class": "High Confluence",
      "parts": { "structure": 13, "orderflow": 18, "footprint": 12,
                 "sweep": 15, "volume": 8, "vwap": 9,
                 "trend_strength": 8, "liquidity_quality": 4 },
      "reasons": ["BOS confirmed on 15m", "Aggressive buying — delta 62%"],
      "entry": 64000.0, "stop_loss": 63200.0,
      "take_profit_1": 65600.0, "take_profit_2": 67200.0,
      "risk": 800.0, "rr_tp1": 2.0, "rr_tp2": 4.0,
      "timeframe": "15m"
    }
  ],
  "scanned": 60,
  "generated_at": "2026-11-19T11:00:00+00:00"
}
```

Before any scan runs: `{"signals": [], "note": "No scan has run yet."}`

## Paper trades

### `GET /api/trades`

| Param | Default | Notes |
|---|---|---|
| `limit` | 100 | Max rows returned |

```json
{ "trades": [ { "id": "...", "symbol": "BTCUSDT", "direction": "long",
                "status": "ACTIVE", "entry": 64000.0, "...": "..." } ] }
```

Trade `status` is one of: `SCANNING`, `SETUP`, `SIGNAL_CONFIRMED`,
`ENTRY_LOCKED`, `ACTIVE`, `TP_SL_HIT`, `CLOSED`, `COOLDOWN`, `RE_ENTRY`.
See the state machine in the [README](../README.md#trade-state-machine).

### `GET /api/trades/{trade_id}`

One trade. **404** if not found.

### `POST /api/trades/{trade_id}/close`

Manually closes a paper trade at the current live Binance price.
**404** if not found, **400** if the trade is not in a closeable state,
**502** if the live price cannot be fetched. Returns the closed trade.

## History / analytics

### `GET /api/history`

Closed trades only (`CLOSED`, `COOLDOWN`, `RE_ENTRY` statuses).

| Param | Default |
|---|---|
| `limit` | 100 |

```json
{ "trades": [ { "...": "..." } ], "count": 3 }
```

### `GET /api/analytics`

Full metrics report from stored paper trades. Win rate counts
**wins / closed trades only** — open trades are never counted; with no
closed trades, rate fields are `null`.

```json
{
  "generated_at": "2026-11-19T11:05:00.000000+00:00",
  "overall": {
    "closed_trades": 12, "live_trades": 2, "win_rate": 58.3,
    "profit_factor": 1.8, "expectancy_r": 0.42, "avg_r": 0.35,
    "avg_win_r": 1.9, "avg_loss_r": -0.9, "max_drawdown_r": -2.1,
    "total_realized_r": 4.2
  },
  "by_direction": { "long": { "...": "..." }, "short": { "...": "..." } },
  "by_coin":      { "BTCUSDT": { "...": "..." } },
  "by_timeframe": { "15m": { "...": "..." } },
  "by_month":     { "2026-11": { "...": "..." } }
}
```

## Backtest

Backtests run on real klines, asynchronously in a worker thread. Submit,
then poll.

### `POST /api/backtest`

Body (all optional):

```json
{
  "symbols": ["BTCUSDT", "ETHUSDT"],
  "timeframe": "15m",
  "limit": 1500,
  "min_score": 50,
  "min_rr": 2.0
}
```

| Field | Default | Notes |
|---|---|---|
| `symbols` | `["BTCUSDT", "ETHUSDT"]` | |
| `timeframe` | `"15m"` | |
| `limit` | `1500` | Candles per symbol, capped at 5000 |
| `min_score` | `50` | Backtest threshold defaults to the subset threshold (50), not the live min score (65) |
| `min_rr` | `settings.min_rr` (2.0) | |

Response (immediate):

```json
{ "id": "9b3f…", "status": "RUNNING" }
```

### `GET /api/backtest/{run_id}`

Polls the run. **404** if the id is unknown.

```json
{ "id": "9b3f…", "status": "DONE",
  "created_at": "2026-11-19T11:00:00+00:00",
  "result": { "...": "metrics + trades, same shape as the analytics report" } }
```

`status` is `RUNNING`, `DONE`, or `FAILED` (with an `error` field).
Backtest results are held in memory only — they do not survive a restart.

## Admin

### `GET /api/admin/settings`

```json
{
  "scanner_enabled": true, "min_score": 65, "cooldown_minutes": 30,
  "min_rr": 2.0, "paper_trading": true,
  "scan_interval_seconds": 300, "scan_top_n": 60
}
```

### `PATCH /api/admin/settings`

Updates known settings only. Unknown keys are rejected with **400**.
Setting `paper_trading` to anything but `true` is rejected with **400**
("paper_trading cannot be disabled — paper only"). Returns the full
updated settings object. Changing `scanner_enabled` also toggles the live
scanner loop.

```bash
curl -X PATCH http://localhost:8000/api/admin/settings \
  -H 'Content-Type: application/json' \
  -d '{"min_score": 70}'
```

### `GET /api/admin/logs`

In-memory event/audit log, newest first.

| Param | Default | Notes |
|---|---|---|
| `level` | — | Filter, e.g. `ERROR` |
| `component` | — | Filter, e.g. `trade_lock` |
| `limit` | 100 | Capped at 500 |

```json
{ "logs": [ { "level": "INFO", "component": "trade_lock",
              "message": "Recovered 2 live trades on startup",
              "context": {}, "created_at": "2026-11-19T11:00:00+00:00" } ] }
```

## Live order flow / footprint / book

These hit Binance live on every call and return **502** if Binance is
unreachable. `{symbol}` is uppercased automatically.

### `GET /api/orderflow/{symbol}`

From the last 500 aggTrades + a depth snapshot (limit 20).

```json
{
  "symbol": "BTCUSDT",
  "buy_notional": 1234567.0, "sell_notional": 987654.0,
  "delta": 246913.0, "delta_ratio": 0.11, "taker_buy_ratio": 0.56,
  "cvd_final": 12345.0, "cvd_trend": "rising",
  "large_buy_count": 3, "large_sell_count": 1, "large_threshold": 50000.0,
  "trade_count": 500, "book_imbalance": 0.08,
  "volume_clusters": [ { "...": "..." } ]
}
```

### `GET /api/footprint/{symbol}`

Footprint from the last 1000 aggTrades, bucketed by the symbol's tick size
from `exchangeInfo` (falls back to 0.01).

```json
{ "symbol": "BTCUSDT", "levels": [ { "...": "..." } ], "...": "..." }
```

### `GET /api/book/{symbol}`

Order book snapshot (depth limit 100) with resting-wall detection.

```json
{
  "symbol": "BTCUSDT",
  "best_bid": 63999.0, "best_ask": 64001.0, "mid": 64000.0,
  "spread_bps": 0.3, "imbalance": 0.08,
  "bid_walls": [ { "...": "..." } ], "ask_walls": [ { "...": "..." } ],
  "bids": [[63999.0, 1.23]], "asks": [[64001.0, 0.87]]
}
```

Walls are resting size only — never presented as guaranteed
support/resistance.

## WebSocket — `WS /ws`

Live feed: a JSON snapshot pushed every 5 seconds (no subscription
messages needed; connect and listen).

```json
{
  "type": "snapshot",
  "ts": 1795065600.0,
  "scanner": { "enabled": true, "running": false,
               "last_scan_at": "2026-11-19T11:00:00+00:00" },
  "prices": { "BTCUSDT": 64076.6 },
  "ws_connected": true,
  "ws_stale": false,
  "signals": [
    { "symbol": "BTCUSDT", "direction": "long", "score": 87,
      "class": "High Confluence", "entry": 64000.0, "sl": 63200.0,
      "tp1": 65600.0, "tp2": 67200.0 }
  ]
}
```

`prices` comes from the Binance WS ingest (empty when `WS_ENABLED=false`
or the ingest is disconnected — reported honestly via `ws_connected` /
`ws_stale`, never filled with stale or invented values). Connect with:

```bash
# websocat, or in JS: new WebSocket('ws://localhost:8000/ws')
websocat ws://localhost:8000/ws
```
