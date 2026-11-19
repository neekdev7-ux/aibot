"""NIVA QUANT AI — FastAPI application entrypoint.

Wires: CORS, per-IP rate-limit middleware, REST routers, /ws live endpoint,
and a lifespan that starts the scanner loop + Binance WS ingestion and
recovers ACTIVE paper trades after a restart. Paper trading only.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from .admin import AdminService
from .api import router as api_router
from .config import settings
from .db import PostgresTradeStore, check_db
from .scanner import Scanner
from .trade_lock import InMemoryTradeStore, TradeLockManager
from .ws_ingest import BinanceWSIngest

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Simple in-memory per-IP sliding-window rate limit."""

    def __init__(self, app, per_minute: int = 120):
        super().__init__(app)
        self.per_minute = per_minute
        self._hits: dict[str, list[float]] = defaultdict(list)

    async def dispatch(self, request: Request, call_next):
        if request.url.path in ("/api/health", "/health"):
            return await call_next(request)
        ip = request.client.host if request.client else "unknown"
        now = time.time()
        window = [t for t in self._hits[ip] if now - t < 60]
        if len(window) >= self.per_minute:
            return JSONResponse({"detail": "Rate limit exceeded"}, status_code=429)
        window.append(now)
        self._hits[ip] = window
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- startup ---
    app.state.admin = AdminService()
    app.state.scanner = Scanner(settings)

    db = await check_db()
    if db["status"] == "ok":
        log.info("Postgres connected — using Postgres trade store")
        store = PostgresTradeStore()
    else:
        log.warning("Postgres unavailable (%s) — using in-memory trade store; "
                    "paper trades will not survive a restart", db.get("detail"))
        store = InMemoryTradeStore()
    app.state.trade_manager = TradeLockManager(
        store, cooldown_minutes=settings.cooldown_minutes,
        taker_fee_bps=settings.taker_fee_bps)

    # Restart-safe recovery: resume watching every live trade.
    live = await app.state.trade_manager.recover_active()
    if live:
        log.info("Recovered %d live paper trades", len(live))
        await app.state.admin.log("INFO", "trade_lock",
                                  f"Recovered {len(live)} live trades on startup")

    # WS ingestion (optional, guarded by config).
    app.state.ws_ingest = None
    if settings.ws_enabled:
        ws = BinanceWSIngest(settings.binance_ws_base)
        ws.on_event(_on_ws_event)
        await ws.start()
        app.state.ws_ingest = ws

    await app.state.scanner.start()
    log.info("NIVA QUANT AI started (paper trading only)")
    yield

    # --- shutdown ---
    await app.state.scanner.stop()
    if app.state.ws_ingest is not None:
        await app.state.ws_ingest.stop()
    log.info("NIVA QUANT AI stopped")


async def _on_ws_event(event: dict) -> None:
    """Feed live prices into ACTIVE paper trades (TP/SL monitoring)."""
    # app.state access needs the app; the callback is bound at runtime via
    # a module-level reference set in create_app.
    app = _APP_REF.get("app")
    if app is None:
        return
    symbol = event.get("symbol")
    data = event.get("data", {})
    price = None
    if event["stream"].endswith("@aggTrade") and data.get("p"):
        price = float(data["p"])
    elif event["stream"].endswith("@markPrice") and data.get("p"):
        price = float(data["p"])
    if price is None or not symbol:
        return
    tm: TradeLockManager = app.state.trade_manager
    for trade in await tm.store.list_live():
        if trade.symbol == symbol and trade.status.value == "ACTIVE":
            try:
                await tm.on_price(trade.id, price)
            except Exception:
                log.exception("Price-tick processing failed for %s", trade.id)


_APP_REF: dict = {}


def create_app() -> FastAPI:
    app = FastAPI(
        title="NIVA QUANT AI",
        description="Institutional crypto trading scanner — Binance USDT-M "
                    "Futures, real public data only, paper trading.",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(RateLimitMiddleware, per_minute=settings.rate_limit_per_minute)
    app.include_router(api_router)
    _APP_REF["app"] = app

    @app.get("/health")
    async def root_health():
        return {"status": "ok", "paper_trading": True}

    @app.websocket("/ws")
    async def live_feed(ws: WebSocket):
        """Live feed: latest prices + latest scan signals, pushed every 5s."""
        await ws.accept()
        try:
            while True:
                scanner: Scanner = app.state.scanner
                ingest: BinanceWSIngest | None = app.state.ws_ingest
                payload = {
                    "type": "snapshot",
                    "ts": time.time(),
                    "scanner": {
                        "enabled": scanner.enabled,
                        "running": scanner.running,
                        "last_scan_at": scanner.last_scan_at,
                    },
                    "prices": dict(ingest.latest_price) if ingest else {},
                    "ws_connected": bool(ingest and ingest.connected),
                    "ws_stale": bool(ingest and ingest.is_stale()),
                    "signals": [
                        {"symbol": s.symbol, "direction": s.direction,
                         "score": s.score, "class": s.score_class,
                         "entry": s.levels.entry, "sl": s.levels.stop_loss,
                         "tp1": s.levels.take_profit_1,
                         "tp2": s.levels.take_profit_2}
                        for s in (scanner.last_result.signals
                                  if scanner.last_result else [])
                    ],
                }
                await ws.send_text(json.dumps(payload))
                await asyncio.sleep(5)
        except WebSocketDisconnect:
            pass

    return app


app = create_app()
