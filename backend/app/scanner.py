"""Async scan loop over eligible Binance USDT-M pairs.

Two-pass, like Nova Signals: pass 1 scores fast technicals (klines only)
for every eligible pair; pass 2 enriches candidates (either direction >=
candidate threshold) with orderflow (aggTrades + depth) and HTF bias
(4H + 1H EMA stacks), then runs the full 100-point scorer.

Filters: min 24h quote volume, min ATR%, max spread, and exclusions for
abnormal volatility, sideways markets, and insufficient data. No signal is
emitted for a pair in cooldown or with a live paper trade (checked by the
caller via TradeLockManager).
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

from .config import Settings, settings
from .footprint import build_footprint
from .indicators import Candle, atr, closed_candles, ema_last, relative_volume, vwap
from .liquidity import book_imbalance
from .market_data import BinanceClient
from .orderflow import (analyze_trades, detect_absorption_exhaustion,
                        detect_divergence, parse_agg_trades)
from .signals import Signal, SignalContext, score_direction, score_signal
from .structure import analyze_structure

log = logging.getLogger(__name__)

MIN_CANDLES = 60
ABNORMAL_MOVE_PCT = 15.0     # 24h move beyond this = abnormal volatility, skip
ATR_SPIKE_MULT = 3.0         # ATR vs its own 20-period median


@dataclass
class ScanResult:
    started_at: float = 0.0
    finished_at: float = 0.0
    scanned: int = 0
    candidates: int = 0
    signals: list[Signal] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=dict)  # reason -> count
    errors: list[str] = field(default_factory=list)

    @property
    def duration_seconds(self) -> float:
        return max(0.0, self.finished_at - self.started_at)


@dataclass
class _Candidate:
    symbol: str
    ticker: dict
    candles: list[Candle]
    tech_long: int
    tech_short: int


class Scanner:
    def __init__(self, cfg: Settings | None = None,
                 client: BinanceClient | None = None):
        self.cfg = cfg or settings
        self.client = client
        self._owns_client = client is None
        self.enabled = True
        self.running = False
        self.last_result: ScanResult | None = None
        self.last_scan_at: float | None = None
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    # -- lifecycle ------------------------------------------------------------
    async def start(self) -> None:
        if self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while not self._stop.is_set():
            if self.enabled:
                try:
                    await self.scan_once()
                except Exception:
                    log.exception("Scan failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.cfg.scan_interval_seconds)
            except asyncio.TimeoutError:
                continue

    # -- HTF bias ---------------------------------------------------------------
    @staticmethod
    def htf_bias(candles_4h: list[Candle], candles_1h: list[Candle]) -> str | None:
        """Bias from 4H + 1H EMA 9/21 stacks. Both must agree; else None."""
        votes: list[str] = []
        for candles in (candles_4h, candles_1h):
            closes = [c.close for c in closed_candles(candles)]
            if len(closes) < 21:
                continue
            e9, e21 = ema_last(closes, 9), ema_last(closes, 21)
            if e9 is None or e21 is None:
                continue
            votes.append("bullish" if e9 > e21 else "bearish")
        if len(votes) == 2 and votes[0] == votes[1]:
            return votes[0]
        return None

    # -- filters ----------------------------------------------------------------
    def _filter_reason(self, ticker: dict, candles: list[Candle]) -> str | None:
        """Return a skip reason, or None if the pair passes all filters."""
        closed = closed_candles(candles)
        if len(closed) < MIN_CANDLES:
            return "insufficient_data"
        change = abs(float(ticker.get("priceChangePercent", 0)))
        if change > ABNORMAL_MOVE_PCT:
            return "abnormal_volatility"
        a = atr(closed)
        price = closed[-1].close
        if a is None or price <= 0:
            return "insufficient_data"
        if a / price * 100 < self.cfg.scan_min_atr_pct:
            return "atr_too_low"
        # ATR spike vs its own recent median = abnormal volatility.
        atrs = [atr(closed[: i + 1]) for i in range(len(closed) - 20, len(closed))]
        atrs = [x for x in atrs if x]
        if atrs:
            med = sorted(atrs)[len(atrs) // 2]
            if med > 0 and a > med * ATR_SPIKE_MULT:
                return "abnormal_volatility"
        return None

    # -- pass 1: fast technicals --------------------------------------------------
    async def _pass1(self, client: BinanceClient, ticker: dict,
                     result: ScanResult) -> _Candidate | None:
        symbol = ticker["symbol"]
        try:
            candles = await client.klines(symbol, self.cfg.setup_tf, limit=210)
        except Exception as e:
            result.errors.append(f"{symbol}: klines failed ({e})")
            return None
        reason = self._filter_reason(ticker, candles)
        if reason:
            result.skipped[reason] = result.skipped.get(reason, 0) + 1
            return None
        closed = closed_candles(candles)
        st = analyze_structure(closed)
        if st.is_sideways:
            result.skipped["sideways"] = result.skipped.get("sideways", 0) + 1
            return None
        ctx = self._base_context(symbol, ticker, closed, st)
        parts_long, _ = score_direction("LONG", ctx)
        parts_short, _ = score_direction("SHORT", ctx)
        return _Candidate(symbol=symbol, ticker=ticker, candles=closed,
                          tech_long=sum(parts_long.values()),
                          tech_short=sum(parts_short.values()))

    def _base_context(self, symbol: str, ticker: dict, closed: list[Candle],
                      st) -> SignalContext:
        from .footprint import Footprint
        from .orderflow import OrderFlowStats
        return SignalContext(
            symbol=symbol,
            price=closed[-1].close,
            atr=atr(closed),
            structure=st,
            orderflow=OrderFlowStats(),
            footprint=Footprint(),
            volume_ratio=relative_volume(closed),
            vwap=vwap(closed[-20:]),
            tp_levels_long=st.resistances,
            tp_levels_short=st.supports,
        )

    # -- pass 2: orderflow + HTF enrichment ---------------------------------------
    async def _pass2(self, client: BinanceClient, cand: _Candidate,
                     result: ScanResult) -> Signal | None:
        symbol = cand.symbol
        st = analyze_structure(cand.candles)
        ctx = self._base_context(symbol, cand.ticker, cand.candles, st)
        # HTF bias (optional — failure leaves bias unknown, not wrong).
        try:
            kl_4h, kl_1h = await asyncio.gather(
                client.klines(symbol, self.cfg.bias_tf_1, limit=60),
                client.klines(symbol, self.cfg.bias_tf_2, limit=60),
            )
            ctx.htf_bias = self.htf_bias(kl_4h, kl_1h)
        except Exception as e:
            result.errors.append(f"{symbol}: HTF failed ({e})")
        # Orderflow + footprint + book (optional — failure leaves neutral values).
        try:
            raw_trades, depth = await asyncio.gather(
                client.agg_trades(symbol, limit=500),
                client.depth(symbol, limit=20),
            )
            trades = parse_agg_trades(raw_trades)
            of = analyze_trades(trades)
            closes = [t.price for t in trades]
            of.divergence = detect_divergence(closes, of.cvd) if len(closes) == len(of.cvd) else None
            move_pct = 0.0
            if len(closes) >= 2 and closes[0] > 0:
                move_pct = (closes[-1] - closes[0]) / closes[0] * 100
            of.absorption, of.exhaustion = detect_absorption_exhaustion(trades, move_pct)
            ctx.orderflow = of
            tick = float(cand.ticker.get("tick_size") or 0.0001)
            ctx.footprint = build_footprint(trades, tick)
            bids = {float(p): float(q) for p, q in depth.get("bids", [])}
            asks = {float(p): float(q) for p, q in depth.get("asks", [])}
            ctx.book_imbalance = book_imbalance(bids, asks)
            if bids and asks:
                mid = (max(bids) + min(asks)) / 2
                if mid > 0:
                    ctx.spread_bps = (min(asks) - max(bids)) / mid * 10_000
        except Exception as e:
            result.errors.append(f"{symbol}: orderflow failed ({e})")
        if ctx.spread_bps is not None and ctx.spread_bps > self.cfg.scan_max_spread_bps:
            result.skipped["spread_too_wide"] = result.skipped.get("spread_too_wide", 0) + 1
            return None
        return score_signal(ctx, min_score=self.cfg.scan_min_score,
                            min_rr=self.cfg.min_rr, timeframe=self.cfg.setup_tf)

    # -- full scan ------------------------------------------------------------------
    async def scan_once(self, client: BinanceClient | None = None) -> ScanResult:
        if self.running:
            raise RuntimeError("Scan already running")
        self.running = True
        result = ScanResult(started_at=time.time())
        own_client = client or self.client
        try:
            if own_client is None:
                own_client = BinanceClient(self.cfg)
                await own_client.__aenter__()
                close_after = True
            else:
                close_after = False
            try:
                tickers = await own_client.get_eligible_symbols(
                    top_n=self.cfg.scan_top_n,
                    min_quote_volume=self.cfg.scan_min_quote_volume_24h,
                )
                result.scanned = len(tickers)
                sem = asyncio.Semaphore(self.cfg.scan_concurrency)

                async def _p1(t: dict) -> _Candidate | None:
                    async with sem:
                        return await self._pass1(own_client, t, result)

                first = await asyncio.gather(*[_p1(t) for t in tickers])
                cands = [c for c in first if c is not None and
                         max(c.tech_long, c.tech_short) >= self.cfg.scan_candidate_threshold]
                result.candidates = len(cands)

                async def _p2(c: _Candidate) -> Signal | None:
                    async with sem:
                        return await self._pass2(own_client, c, result)

                enriched = await asyncio.gather(*[_p2(c) for c in cands])
                result.signals = sorted(
                    [s for s in enriched if s is not None],
                    key=lambda s: s.score, reverse=True,
                )
            finally:
                if close_after:
                    await own_client.__aexit__()
        finally:
            result.finished_at = time.time()
            self.last_result = result
            self.last_scan_at = result.finished_at
            self.running = False
        log.info("Scan done: %d scanned, %d candidates, %d signals in %.1fs",
                 result.scanned, result.candidates, len(result.signals),
                 result.duration_seconds)
        return result
