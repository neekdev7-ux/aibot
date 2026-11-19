"""REST routers. Paper trading only — there are no real-trading endpoints
anywhere in this API. Live market endpoints hit Binance public data;
analytics/history read stored paper trades only.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from . import analytics
from .admin import AdminService
from .backtest import BacktestConfig, run_backtest
from .config import settings
from .db import check_db, check_redis
from .footprint import build_footprint
from .indicators import Candle
from .liquidity import LocalBook, book_imbalance, find_walls
from .market_data import BinanceClient
from .orderflow import analyze_trades, parse_agg_trades
from .scanner import Scanner
from .trade_lock import TradeLockManager
from .ws_ingest import BinanceWSIngest

log = logging.getLogger(__name__)

router = APIRouter()


def get_scanner(request: Request) -> Scanner:
    return request.app.state.scanner


def get_trades(request: Request) -> TradeLockManager:
    return request.app.state.trade_manager


def get_admin(request: Request) -> AdminService:
    return request.app.state.admin


def get_ws(request: Request) -> BinanceWSIngest | None:
    return getattr(request.app.state, "ws_ingest", None)


def _signal_dict(s) -> dict:
    return {
        "symbol": s.symbol, "direction": s.direction, "score": s.score,
        "class": s.score_class, "parts": s.parts, "reasons": s.reasons,
        "entry": s.levels.entry, "stop_loss": s.levels.stop_loss,
        "take_profit_1": s.levels.take_profit_1,
        "take_profit_2": s.levels.take_profit_2,
        "risk": s.levels.risk, "rr_tp1": s.levels.rr_tp1,
        "rr_tp2": s.levels.rr_tp2, "timeframe": s.timeframe,
    }


# --- health ----------------------------------------------------------------------
@router.get("/api/health")
async def health(request: Request, admin: AdminService = Depends(get_admin)):
    ws = get_ws(request)
    components = {
        "db": await check_db(),
        "redis": await check_redis(),
        "ws_ingest": (ws.status() | {"status": "ok" if ws.connected else "error"})
        if ws else {"status": "disabled"},
        "scanner": {"status": "ok" if request.app.state.scanner.enabled else "disabled",
                    "last_scan_at": request.app.state.scanner.last_scan_at},
    }
    return admin.health(components)


# --- symbols ---------------------------------------------------------------------
@router.get("/api/symbols")
async def symbols(top_n: int = 60, min_quote_volume: float = 0.0):
    async with BinanceClient(settings) as client:
        try:
            rows = await client.get_eligible_symbols(
                top_n=min(top_n, 200), min_quote_volume=min_quote_volume)
        except Exception as e:
            raise HTTPException(502, f"Binance unreachable: {e}") from e
    return {"count": len(rows), "symbols": rows,
            "note": "USDT perpetuals, TRADING only; stablecoins and leveraged tokens excluded."}


# --- scanner ---------------------------------------------------------------------
@router.get("/api/scanner")
async def scanner_status(scanner: Scanner = Depends(get_scanner)):
    r = scanner.last_result
    return {
        "enabled": scanner.enabled,
        "running": scanner.running,
        "last_scan_at": scanner.last_scan_at,
        "last_result": None if r is None else {
            "scanned": r.scanned, "candidates": r.candidates,
            "signals": len(r.signals), "skipped": r.skipped,
            "errors": r.errors[:10],
            "duration_seconds": round(r.duration_seconds, 1),
        },
    }


@router.post("/api/scanner/scan")
async def scanner_scan(scanner: Scanner = Depends(get_scanner)):
    if scanner.running:
        raise HTTPException(409, "Scan already running")
    result = await scanner.scan_once()
    return {"scanned": result.scanned, "candidates": result.candidates,
            "signals": [_signal_dict(s) for s in result.signals],
            "skipped": result.skipped, "errors": result.errors[:10],
            "duration_seconds": round(result.duration_seconds, 1)}


@router.post("/api/scanner/enable")
async def scanner_enable(admin: AdminService = Depends(get_admin),
                         scanner: Scanner = Depends(get_scanner)):
    await admin.set_scanner_enabled(True)
    scanner.enabled = True
    return {"scanner_enabled": True}


@router.post("/api/scanner/disable")
async def scanner_disable(admin: AdminService = Depends(get_admin),
                          scanner: Scanner = Depends(get_scanner)):
    await admin.set_scanner_enabled(False)
    scanner.enabled = False
    return {"scanner_enabled": False}


# --- signals ---------------------------------------------------------------------
@router.get("/api/signals")
async def signals(scanner: Scanner = Depends(get_scanner)):
    r = scanner.last_result
    if r is None:
        return {"signals": [], "note": "No scan has run yet."}
    return {"signals": [_signal_dict(s) for s in r.signals],
            "scanned": r.scanned, "generated_at": r.finished_at}


# --- paper trades ----------------------------------------------------------------
@router.get("/api/trades")
async def list_trades(tm: TradeLockManager = Depends(get_trades), limit: int = 100):
    rows = await tm.store.list_all(limit=limit)
    return {"trades": [t.to_dict() for t in rows]}


@router.get("/api/trades/{trade_id}")
async def get_trade(trade_id: str, tm: TradeLockManager = Depends(get_trades)):
    trade = await tm.store.get(trade_id)
    if trade is None:
        raise HTTPException(404, "Trade not found")
    return trade.to_dict()


@router.post("/api/trades/{trade_id}/close")
async def close_trade(trade_id: str, tm: TradeLockManager = Depends(get_trades)):
    """Manually close a paper trade at the current live price."""
    trade = await tm.store.get(trade_id)
    if trade is None:
        raise HTTPException(404, "Trade not found")
    price = None
    async with BinanceClient(settings) as client:
        try:
            price = await client.ticker_price(trade.symbol)
        except Exception as e:
            raise HTTPException(502, f"Cannot fetch live price: {e}") from e
    try:
        closed = await tm.close_manual(trade_id, price)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return closed.to_dict()


# --- history / analytics -----------------------------------------------------------
@router.get("/api/history")
async def history(tm: TradeLockManager = Depends(get_trades), limit: int = 100):
    rows = await tm.store.list_all(limit=limit)
    closed = [t.to_dict() for t in rows if t.status.value in
              ("CLOSED", "COOLDOWN", "RE_ENTRY")]
    return {"trades": closed, "count": len(closed)}


@router.get("/api/analytics")
async def analytics_report(tm: TradeLockManager = Depends(get_trades)):
    rows = await tm.store.list_all(limit=1000)
    return analytics.full_report([t.to_dict() for t in rows])


# --- backtest ----------------------------------------------------------------------
_backtest_runs: dict[str, dict] = {}


@router.post("/api/backtest")
async def run_backtest_endpoint(request: Request):
    """Run a backtest on real klines. Body: {symbols, timeframe, limit,
    min_score, min_rr}. Runs in a worker thread; poll GET /api/backtest/{id}."""
    body = await request.json()
    symbols = body.get("symbols") or ["BTCUSDT", "ETHUSDT"]
    timeframe = body.get("timeframe", "15m")
    limit = min(int(body.get("limit", 1500)), 5000)
    cfg = BacktestConfig(
        # Backtest threshold defaults to the subset threshold (50), not the
        # live min score (65) — see BacktestConfig.
        min_score=int(body.get("min_score", BacktestConfig().min_score)),
        min_rr=float(body.get("min_rr", settings.min_rr)),
    )
    run_id = str(uuid.uuid4())
    _backtest_runs[run_id] = {"id": run_id, "status": "RUNNING",
                              "created_at": datetime.now(timezone.utc).isoformat()}

    async def _work() -> None:
        try:
            async with BinanceClient(settings) as client:
                klines: dict[str, list[Candle]] = {}
                for sym in symbols:
                    klines[sym] = await client.klines(sym, timeframe, limit=limit)
            result = await asyncio.to_thread(run_backtest, klines, cfg)
            _backtest_runs[run_id].update(
                {"status": "DONE", "result": result.to_dict()})
        except Exception as e:
            log.exception("Backtest %s failed", run_id)
            _backtest_runs[run_id].update({"status": "FAILED", "error": str(e)})

    asyncio.create_task(_work())
    return {"id": run_id, "status": "RUNNING"}


@router.get("/api/backtest/{run_id}")
async def get_backtest(run_id: str):
    run = _backtest_runs.get(run_id)
    if run is None:
        raise HTTPException(404, "Backtest run not found")
    return run


# --- admin -------------------------------------------------------------------------
@router.get("/api/admin/settings")
async def admin_settings(admin: AdminService = Depends(get_admin)):
    return await admin.get_settings()


@router.patch("/api/admin/settings")
async def admin_update_settings(request: Request,
                                admin: AdminService = Depends(get_admin)):
    body = await request.json()
    try:
        updated = await admin.update_settings(body)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    # Keep the scanner in sync with the stored flag.
    request.app.state.scanner.enabled = bool(updated.get("scanner_enabled", True))
    return updated


@router.get("/api/admin/logs")
async def admin_logs(admin: AdminService = Depends(get_admin),
                     level: str | None = None, component: str | None = None,
                     limit: int = 100):
    return {"logs": await admin.list_logs(level=level, component=component,
                                          limit=min(limit, 500))}


# --- live orderflow / footprint / book ----------------------------------------------
@router.get("/api/orderflow/{symbol}")
async def orderflow(symbol: str):
    symbol = symbol.upper()
    async with BinanceClient(settings) as client:
        try:
            raw = await client.agg_trades(symbol, limit=500)
            depth = await client.depth(symbol, limit=20)
        except Exception as e:
            raise HTTPException(502, f"Binance unreachable: {e}") from e
    trades = parse_agg_trades(raw)
    of = analyze_trades(trades)
    bids = {float(p): float(q) for p, q in depth.get("bids", [])}
    asks = {float(p): float(q) for p, q in depth.get("asks", [])}
    return {
        "symbol": symbol,
        "buy_notional": of.buy_notional, "sell_notional": of.sell_notional,
        "delta": of.delta, "delta_ratio": of.delta_ratio,
        "taker_buy_ratio": of.taker_buy_ratio,
        "cvd_final": of.cvd_final, "cvd_trend": of.cvd_trend,
        "large_buy_count": of.large_buy_count,
        "large_sell_count": of.large_sell_count,
        "large_threshold": of.large_threshold,
        "trade_count": of.trade_count,
        "book_imbalance": book_imbalance(bids, asks),
        "volume_clusters": of.volume_clusters,
    }


@router.get("/api/footprint/{symbol}")
async def footprint(symbol: str):
    symbol = symbol.upper()
    async with BinanceClient(settings) as client:
        try:
            raw = await client.agg_trades(symbol, limit=1000)
            infos = {s.symbol: s for s in await client.exchange_info()}
        except Exception as e:
            raise HTTPException(502, f"Binance unreachable: {e}") from e
    tick = infos[symbol].tick_size if symbol in infos else 0.01
    fp = build_footprint(parse_agg_trades(raw), tick)
    return {"symbol": symbol, **fp.to_dict()}


@router.get("/api/book/{symbol}")
async def book(symbol: str):
    symbol = symbol.upper()
    async with BinanceClient(settings) as client:
        try:
            depth = await client.depth(symbol, limit=100)
        except Exception as e:
            raise HTTPException(502, f"Binance unreachable: {e}") from e
    bids = {float(p): float(q) for p, q in depth.get("bids", [])}
    asks = {float(p): float(q) for p, q in depth.get("asks", [])}
    book_obj = LocalBook(symbol)
    from .liquidity import BookSnapshot
    book_obj.apply_snapshot(BookSnapshot(
        last_update_id=int(depth.get("lastUpdateId", 0)), bids=bids, asks=asks))
    return {
        "symbol": symbol,
        "best_bid": book_obj.best_bid, "best_ask": book_obj.best_ask,
        "mid": book_obj.mid, "spread_bps": book_obj.spread_bps(),
        "imbalance": book_imbalance(bids, asks),
        "bid_walls": find_walls(bids), "ask_walls": find_walls(asks),
        "bids": sorted([[p, q] for p, q in bids.items()], reverse=True)[:20],
        "asks": sorted([[p, q] for p, q in asks.items()])[:20],
    }
