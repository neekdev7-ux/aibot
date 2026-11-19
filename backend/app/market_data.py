"""Binance USDT-M Futures public market data client (async httpx).

Base fallback order: https://data-api.binance.vision FIRST
(api.binance.com is 451 geo-blocked in some clouds), then fapi.binance.com.
data-api.binance.vision serves both /api/v3 and /fapi/v1 market-data
endpoints. No API key — public endpoints only. Retries with backoff on
429/418; stale-data detection on every kline batch.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass

import httpx

from .config import Settings, settings
from .indicators import Candle

log = logging.getLogger(__name__)

# --- Stablecoin filter (mirrors Nova Signals) --------------------------------
# A $1-pegged coin cannot give a trade signal: its price barely moves, so
# indicator scores on its flat series are pure noise — RWUSD/USDT scored
# 97/100 while pinned to $1. Two guards: an explicit list of pegged-asset
# bases, and a peg guard — any pair whose 24h high-low range is under 0.2%
# of price is flat by definition, whatever its name.
STABLE_BASES = frozenset({
    "USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDP", "USD1", "USDE", "PYUSD",
    "BUSD", "USTC", "UST", "USDJ", "GUSD", "LUSD", "FRAX", "WUSD", "AEUR",
    "EURI", "EURS", "XUSD", "RWUSD", "USDD", "DUSD", "SUSD", "MIM",
})
PEG_RANGE_THRESHOLD = 0.002  # <0.2% 24h range = pegged/flat
LEVERAGED_MARKERS = ("UPUSDT", "DOWNUSDT", "BULL", "BEAR")

DEFAULT_TIMEOUT = 15.0
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 0.5


def is_stable_pair(symbol: str, ticker: dict | None = None) -> bool:
    """True if the pair is pegged: listed stable base, or <0.2% 24h range."""
    base = symbol[:-4] if symbol.endswith("USDT") else symbol
    if base in STABLE_BASES:
        return True
    if ticker:
        try:
            high, low, last = (
                float(ticker["highPrice"]),
                float(ticker["lowPrice"]),
                float(ticker["lastPrice"]),
            )
        except (KeyError, TypeError, ValueError):
            return False
        if last > 0 and (high - low) / last < PEG_RANGE_THRESHOLD:
            return True
    return False


def is_leveraged_token(symbol: str) -> bool:
    return any(m in symbol for m in LEVERAGED_MARKERS)


@dataclass
class SymbolInfo:
    symbol: str
    base_asset: str
    quote_asset: str
    status: str
    contract_type: str
    tick_size: float
    step_size: float
    min_notional: float


def parse_klines(raw: list, now_ms: int | None = None) -> list[Candle]:
    """Parse Binance kline arrays. A candle is closed when close_time <= now."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    out: list[Candle] = []
    for k in raw:
        close_time = int(k[6])
        out.append(Candle(
            open_time=int(k[0]),
            open=float(k[1]),
            high=float(k[2]),
            low=float(k[3]),
            close=float(k[4]),
            volume=float(k[5]),
            close_time=close_time,
            quote_volume=float(k[7]),
            trades=int(k[8]),
            taker_buy_volume=float(k[9]),
            is_closed=close_time <= now_ms,
        ))
    return out


def is_stale(candles: list[Candle], interval_ms: int, now_ms: int | None = None,
             max_missed: int = 2) -> bool:
    """True if the newest candle is older than `max_missed` intervals."""
    if not candles:
        return True
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    newest = max(c.open_time for c in candles)
    return now_ms - newest > interval_ms * max_missed


INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
    "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
    "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000,
    "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
}


class BinanceClient:
    """Async Binance public-data client with base fallback + retry/backoff."""

    def __init__(self, cfg: Settings | None = None, client: httpx.AsyncClient | None = None):
        self.cfg = cfg or settings
        self.bases = self.cfg.binance_base_list
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> "BinanceClient":
        if self._client is None:
            # trust_env=False: httpx crashes parsing some ambient NO_PROXY
            # values (bracketed IPv6 entries). Read the proxy URL explicitly
            # instead — None when unset, so direct connections still work.
            proxy = (
                os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
                or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
                or os.environ.get("ALL_PROXY") or os.environ.get("all_proxy")
            )
            # Honor SSL_CERT_FILE (TLS-intercepting egress proxies ship their
            # CA there); otherwise use httpx/certifi defaults. Never disable
            # verification.
            ca_bundle = os.environ.get("SSL_CERT_FILE")
            verify: bool | str = ca_bundle if (ca_bundle and os.path.exists(ca_bundle)) else True
            self._client = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT,
                                             trust_env=False,
                                             proxy=proxy or None,
                                             verify=verify)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _get(self, path: str, params: dict | None = None) -> object:
        """GET with per-base fallback and exponential backoff on 429/418."""
        last_err: Exception | None = None
        for base in self.bases:
            for attempt in range(MAX_RETRIES):
                try:
                    assert self._client is not None
                    resp = await self._client.get(base + path, params=params)
                    if resp.status_code in (429, 418):
                        retry_after = resp.headers.get("Retry-After")
                        wait = float(retry_after) if retry_after else BACKOFF_BASE_SECONDS * (2 ** attempt)
                        log.warning("Binance rate limit %s %s — backing off %.1fs",
                                    resp.status_code, base, wait)
                        await asyncio.sleep(wait)
                        continue
                    if resp.status_code in (301, 302, 303, 307, 308):
                        # Geo-block redirect (e.g. fapi1 -> www.binance.com):
                        # this base cannot serve the API here; try the next.
                        last_err = RuntimeError(
                            f"{base} redirected ({resp.status_code}) — likely geo-blocked")
                        break
                    resp.raise_for_status()
                    try:
                        return resp.json()
                    except ValueError:
                        last_err = RuntimeError(f"{base} returned non-JSON for {path}")
                        break
                except httpx.HTTPStatusError as e:
                    last_err = e
                    if e.response.status_code in (429, 418):
                        await asyncio.sleep(BACKOFF_BASE_SECONDS * (2 ** attempt))
                        continue
                    break  # other 4xx/5xx: try next base
                except (httpx.TransportError, httpx.TimeoutException) as e:
                    last_err = e
                    await asyncio.sleep(BACKOFF_BASE_SECONDS * (2 ** attempt))
                    continue
        raise RuntimeError(f"Binance unreachable for {path}: {last_err}")

    # --- reference data ------------------------------------------------------
    async def exchange_info(self) -> list[SymbolInfo]:
        data = await self._get("/fapi/v1/exchangeInfo")
        out: list[SymbolInfo] = []
        for s in data["symbols"]:
            if s["quoteAsset"] != "USDT" or s["contractType"] != "PERPETUAL":
                continue
            tick = step = min_not = 0.0
            for f in s.get("filters", []):
                if f["filterType"] == "PRICE_FILTER":
                    tick = float(f["tickSize"])
                elif f["filterType"] == "LOT_SIZE":
                    step = float(f["stepSize"])
                elif f["filterType"] == "MIN_NOTIONAL":
                    min_not = float(f.get("notional", 0))
            out.append(SymbolInfo(
                symbol=s["symbol"], base_asset=s["baseAsset"],
                quote_asset=s["quoteAsset"], status=s["status"],
                contract_type=s["contractType"],
                tick_size=tick or 0.0001, step_size=step or 0.001,
                min_notional=min_not,
            ))
        return out

    async def tickers_24h(self) -> list[dict]:
        data = await self._get("/fapi/v1/ticker/24hr")
        return data if isinstance(data, list) else [data]

    async def get_eligible_symbols(self, top_n: int = 60,
                                   min_quote_volume: float = 0.0) -> list[dict]:
        """USDT perpetuals, TRADING only, no leveraged tokens, no stables,
        ranked by 24h quote volume. Returns ticker dicts (with symbol info)."""
        infos = {s.symbol: s for s in await self.exchange_info()}
        tickers = await self.tickers_24h()
        eligible: list[dict] = []
        for t in tickers:
            sym = t["symbol"]
            info = infos.get(sym)
            if info is None or info.status != "TRADING":
                continue
            if is_leveraged_token(sym) or is_stable_pair(sym, t):
                continue
            if float(t.get("quoteVolume", 0)) < min_quote_volume:
                continue
            eligible.append({**t, "tick_size": info.tick_size,
                             "step_size": info.step_size})
        eligible.sort(key=lambda t: float(t.get("quoteVolume", 0)), reverse=True)
        return eligible[:top_n]

    # --- market data ---------------------------------------------------------
    async def klines(self, symbol: str, interval: str, limit: int = 210) -> list[Candle]:
        data = await self._get("/fapi/v1/klines", {
            "symbol": symbol, "interval": interval, "limit": limit})
        candles = parse_klines(data)
        interval_ms = INTERVAL_MS.get(interval)
        if interval_ms and is_stale(candles, interval_ms):
            log.warning("Stale klines for %s %s (newest candle >2 intervals old)",
                        symbol, interval)
        return candles

    async def agg_trades(self, symbol: str, limit: int = 500) -> list[dict]:
        data = await self._get("/fapi/v1/aggTrades", {"symbol": symbol, "limit": limit})
        return data if isinstance(data, list) else []

    async def depth(self, symbol: str, limit: int = 20) -> dict:
        return await self._get("/fapi/v1/depth", {"symbol": symbol, "limit": limit})

    async def premium_index(self, symbol: str | None = None) -> dict | list:
        params = {"symbol": symbol} if symbol else None
        return await self._get("/fapi/v1/premiumIndex", params)

    async def open_interest(self, symbol: str) -> dict:
        return await self._get("/fapi/v1/openInterest", {"symbol": symbol})

    async def funding_rate(self, symbol: str, limit: int = 1) -> list[dict]:
        data = await self._get("/fapi/v1/fundingRate", {"symbol": symbol, "limit": limit})
        return data if isinstance(data, list) else []

    async def ticker_price(self, symbol: str) -> float:
        data = await self._get("/fapi/v1/ticker/price", {"symbol": symbol})
        return float(data["price"])
