"""Order flow from Binance aggTrades: aggressive buy/sell, delta, CVD,
footprint aggregation by price+time, imbalance, divergence, absorption /
exhaustion, large trades, volume clusters.

Binance aggTrades carry `m` (buyer-is-maker): m=true means the trade was
initiated by a seller (aggressive sell), m=false an aggressive buy.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class AggTrade:
    price: float
    qty: float
    is_buyer_maker: bool
    time: int  # ms epoch

    @property
    def notional(self) -> float:
        return self.price * self.qty

    @property
    def is_aggressive_buy(self) -> bool:
        return not self.is_buyer_maker


def parse_agg_trades(raw: list[dict]) -> list[AggTrade]:
    out: list[AggTrade] = []
    for t in raw:
        try:
            out.append(AggTrade(
                price=float(t["p"]), qty=float(t["q"]),
                is_buyer_maker=bool(t["m"]), time=int(t["T"]),
            ))
        except (KeyError, TypeError, ValueError):
            continue
    return out


@dataclass
class OrderFlowStats:
    buy_notional: float = 0.0
    sell_notional: float = 0.0
    delta: float = 0.0               # buy - sell notional
    delta_ratio: float = 0.0         # delta / total, -1..1
    taker_buy_ratio: float = 0.5
    cvd: list[float] = field(default_factory=list)  # cumulative volume delta
    cvd_final: float = 0.0
    cvd_trend: str = "flat"          # 'rising' | 'falling' | 'flat'
    large_buy_count: int = 0
    large_sell_count: int = 0
    large_threshold: float = 0.0     # p90 notional
    trade_count: int = 0
    divergence: str | None = None    # 'bullish' | 'bearish' | None
    absorption: bool = False
    exhaustion: bool = False
    volume_clusters: list[dict] = field(default_factory=list)


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, math.floor(len(s) * pct)))
    return s[idx]


def analyze_trades(trades: list[AggTrade]) -> OrderFlowStats:
    """Aggregate a window of aggTrades into order-flow statistics."""
    stats = OrderFlowStats(trade_count=len(trades))
    if not trades:
        return stats
    notionals = [t.notional for t in trades]
    stats.large_threshold = _percentile(notionals, 0.90)
    running = 0.0
    for t in trades:
        signed = t.notional if t.is_aggressive_buy else -t.notional
        running += signed
        stats.cvd.append(running)
        if t.is_aggressive_buy:
            stats.buy_notional += t.notional
            if t.notional >= stats.large_threshold and t.notional > 0:
                stats.large_buy_count += 1
        else:
            stats.sell_notional += t.notional
            if t.notional >= stats.large_threshold and t.notional > 0:
                stats.large_sell_count += 1
    total = stats.buy_notional + stats.sell_notional
    stats.delta = stats.buy_notional - stats.sell_notional
    if total > 0:
        stats.delta_ratio = stats.delta / total
        stats.taker_buy_ratio = stats.buy_notional / total
    stats.cvd_final = stats.cvd[-1] if stats.cvd else 0.0
    # CVD trend: compare the last third of the CVD curve to the first third.
    n = len(stats.cvd)
    if n >= 9:
        first = sum(stats.cvd[: n // 3]) / (n // 3)
        last = sum(stats.cvd[-n // 3:]) / (n // 3)
        span = max(abs(stats.cvd_final), 1e-9)
        if (last - first) / span > 0.15:
            stats.cvd_trend = "rising"
        elif (first - last) / span > 0.15:
            stats.cvd_trend = "falling"
    stats.volume_clusters = volume_clusters(trades)
    return stats


def detect_divergence(prices: list[float], cvd: list[float]) -> str | None:
    """Price/CVD divergence over the window: price makes a higher high while
    CVD makes a lower high (bearish), or lower low vs higher low (bullish)."""
    if len(prices) < 6 or len(prices) != len(cvd):
        return None
    half = len(prices) // 2
    p1, p2 = prices[:half], prices[half:]
    c1, c2 = cvd[:half], cvd[half:]
    if max(p2) > max(p1) and max(c2) < max(c1):
        return "bearish"
    if min(p2) < min(p1) and min(c2) > min(c1):
        return "bullish"
    return None


def detect_absorption_exhaustion(trades: list[AggTrade], price_move_pct: float) -> tuple[bool, bool]:
    """Absorption: heavy one-sided aggressive flow with almost no price
    movement (a limit wall is absorbing it). Exhaustion: heavy flow in the
    direction of the move that then stalls — flagged when the move is large
    but the last-third delta flips against it."""
    if len(trades) < 20:
        return False, False
    stats = analyze_trades(trades)
    total = stats.buy_notional + stats.sell_notional
    if total <= 0:
        return False, False
    one_sided = abs(stats.delta_ratio) > 0.4
    absorption = one_sided and abs(price_move_pct) < 0.05  # <0.05% move on heavy flow
    # Exhaustion: strong early delta in the move's direction, late delta flips.
    third = len(trades) // 3
    late = analyze_trades(trades[-third:])
    early = analyze_trades(trades[:third])
    exhaustion = (
        abs(price_move_pct) > 0.3
        and early.delta_ratio * late.delta_ratio < 0
        and abs(early.delta_ratio) > 0.3
    )
    return absorption, exhaustion


def footprint_by_time(trades: list[AggTrade], bucket_ms: int,
                      tick_size: float) -> list[dict]:
    """Aggregate trades into time buckets, each with per-price bid/ask volume.

    Returns a list of buckets: {start, end, levels: {price: {bid, ask}},
    delta, total, buy_ratio}.
    """
    if not trades:
        return []
    buckets: dict[int, dict] = {}
    for t in trades:
        bucket = (t.time // bucket_ms) * bucket_ms
        # Round price to tick grid.
        price = round(t.price / tick_size) * tick_size if tick_size > 0 else t.price
        b = buckets.setdefault(bucket, {"start": bucket, "end": bucket + bucket_ms,
                                        "levels": {}, "delta": 0.0, "total": 0.0})
        lvl = b["levels"].setdefault(price, {"bid": 0.0, "ask": 0.0})
        if t.is_aggressive_buy:
            lvl["ask"] += t.qty
            b["delta"] += t.notional
        else:
            lvl["bid"] += t.qty
            b["delta"] -= t.notional
        b["total"] += t.notional
    out = [buckets[k] for k in sorted(buckets)]
    for b in out:
        b["buy_ratio"] = (0.5 + b["delta"] / b["total"] / 2) if b["total"] > 0 else 0.5
    return out


def volume_clusters(trades: list[AggTrade], n_clusters: int = 5,
                    bins: int = 20) -> list[dict]:
    """Price levels where traded volume concentrates (histogram over the
    window's price range). Returns top clusters by notional."""
    if not trades:
        return []
    prices = [t.price for t in trades]
    lo, hi = min(prices), max(prices)
    if hi <= lo:
        return [{"price": lo, "notional": sum(t.notional for t in trades), "share": 1.0}]
    width = (hi - lo) / bins
    buckets = [0.0] * bins
    for t in trades:
        idx = min(bins - 1, int((t.price - lo) / width))
        buckets[idx] += t.notional
    total = sum(buckets)
    if total <= 0:
        return []
    ranked = sorted(
        ({"price": lo + (i + 0.5) * width, "notional": v, "share": v / total}
         for i, v in enumerate(buckets) if v > 0),
        key=lambda d: d["notional"], reverse=True,
    )
    return ranked[:n_clusters]
