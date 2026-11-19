"""Binance WebSocket multiplex ingestion: aggTrade + kline + markPrice +
bookTicker streams for the watched symbols.

Auto-reconnects with exponential backoff, detects stale streams (no message
within the threshold), and dispatches parsed events to registered callbacks.
Read-only market data — no trading, no auth.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import websockets

log = logging.getLogger(__name__)

STALE_AFTER_SECONDS = 30.0
MAX_BACKOFF_SECONDS = 60.0


class BinanceWSIngest:
    def __init__(self, ws_base: str = "wss://fstream.binance.com",
                 symbols: list[str] | None = None):
        self.ws_base = ws_base.rstrip("/")
        self.symbols = [s.lower() for s in (symbols or ["btcusdt"])]
        self.latest_price: dict[str, float] = {}
        self.latest_mark_price: dict[str, float] = {}
        self.last_message_at: float = 0.0
        self.connected = False
        self.reconnects = 0
        self._callbacks: list = []
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._lock = asyncio.Lock()

    @property
    def streams(self) -> list[str]:
        out: list[str] = []
        for s in self.symbols:
            out += [f"{s}@aggTrade", f"{s}@kline_5m", f"{s}@markPrice",
                    f"{s}@bookTicker"]
        return out

    @property
    def url(self) -> str:
        return f"{self.ws_base}/stream?streams={'/'.join(self.streams)}"

    def on_event(self, callback) -> None:
        """Register an async callback(event_dict)."""
        self._callbacks.append(callback)

    async def set_symbols(self, symbols: list[str]) -> None:
        async with self._lock:
            self.symbols = [s.lower() for s in symbols]
        # Reconnect to pick up the new stream set.
        if self._task is not None:
            self._task.cancel()

    def is_stale(self, now: float | None = None) -> bool:
        if not self.connected or self.last_message_at == 0:
            return True
        now = now if now is not None else time.time()
        return now - self.last_message_at > STALE_AFTER_SECONDS

    async def start(self) -> None:
        if self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.connected = False

    async def _run_loop(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                await self._connect_once()
                backoff = 1.0  # clean exit resets backoff
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("WS connection failed; reconnecting")
                self.connected = False
                self.reconnects += 1
            if self._stop.is_set():
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

    async def _connect_once(self) -> None:
        log.info("Connecting WS: %d streams", len(self.streams))
        async with websockets.connect(self.url, ping_interval=20, ping_timeout=20) as ws:
            self.connected = True
            self.last_message_at = time.time()
            async for raw in ws:
                self.last_message_at = time.time()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._dispatch(msg)

    async def _dispatch(self, msg: dict) -> None:
        stream = msg.get("stream", "")
        data = msg.get("data", {})
        symbol = (data.get("s") or "").upper()
        try:
            if stream.endswith("@aggTrade") and data.get("p"):
                self.latest_price[symbol] = float(data["p"])
            elif stream.endswith("@markPrice") and data.get("p"):
                self.latest_mark_price[symbol] = float(data["p"])
            elif stream.endswith("@bookTicker") and data.get("b"):
                self.latest_price[symbol] = (float(data["b"]) + float(data["a"])) / 2
        except (TypeError, ValueError):
            pass
        event = {"stream": stream, "symbol": symbol, "data": data,
                 "received_at": time.time()}
        for cb in self._callbacks:
            try:
                await cb(event)
            except Exception:
                log.exception("WS callback failed for %s", stream)

    def status(self) -> dict:
        return {
            "connected": self.connected,
            "symbols": len(self.symbols),
            "streams": len(self.streams),
            "reconnects": self.reconnects,
            "stale": self.is_stale(),
            "last_message_at": self.last_message_at or None,
            "prices_tracked": len(self.latest_price),
        }
