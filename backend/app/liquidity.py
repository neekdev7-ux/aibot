"""Local order-book sync (snapshot + delta), imbalance, walls /
concentration, spread monitor, and spoofing-like detection.

The book is maintained from REST snapshots plus WS depth deltas
(Binance `depthUpdate` events carry first/last update ids `U`/`u`; deltas
are applied only when they continue the snapshot's `lastUpdateId`).
Spoofing-like detection is heuristic only: a large order that appears and
vanishes within seconds without trading is flagged as *spoofing-like*,
never asserted as spoofing.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class BookSnapshot:
    last_update_id: int
    bids: dict[float, float]  # price -> qty
    asks: dict[float, float]


class LocalBook:
    """In-memory order book with snapshot + delta sync and staleness checks."""

    def __init__(self, symbol: str, max_levels: int = 100):
        self.symbol = symbol
        self.max_levels = max_levels
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.last_update_id: int | None = None
        self.last_update_ms: int = 0
        self.synced = False

    def apply_snapshot(self, snapshot: BookSnapshot, now_ms: int | None = None) -> None:
        self.bids = {p: q for p, q in snapshot.bids.items() if q > 0}
        self.asks = {p: q for p, q in snapshot.asks.items() if q > 0}
        self.last_update_id = snapshot.last_update_id
        self.last_update_ms = now_ms if now_ms is not None else int(time.time() * 1000)
        self.synced = True
        self._trim()

    def apply_delta(self, first_id: int, final_id: int,
                    bids: list[tuple[float, float]],
                    asks: list[tuple[float, float]],
                    now_ms: int | None = None) -> bool:
        """Apply a depth delta. Returns False if the delta does not continue
        the stream (caller must re-snapshot)."""
        if not self.synced or self.last_update_id is None:
            return False
        if final_id <= self.last_update_id:
            return True  # already applied
        if first_id > self.last_update_id + 1:
            self.synced = False
            return False
        for price, qty in bids:
            if qty == 0:
                self.bids.pop(price, None)
            else:
                self.bids[price] = qty
        for price, qty in asks:
            if qty == 0:
                self.asks.pop(price, None)
            else:
                self.asks[price] = qty
        self.last_update_id = final_id
        self.last_update_ms = now_ms if now_ms is not None else int(time.time() * 1000)
        self._trim()
        return True

    def _trim(self) -> None:
        if len(self.bids) > self.max_levels:
            keep = sorted(self.bids, reverse=True)[: self.max_levels]
            self.bids = {p: self.bids[p] for p in keep}
        if len(self.asks) > self.max_levels:
            keep = sorted(self.asks)[: self.max_levels]
            self.asks = {p: self.asks[p] for p in keep}

    @property
    def best_bid(self) -> float | None:
        return max(self.bids) if self.bids else None

    @property
    def best_ask(self) -> float | None:
        return min(self.asks) if self.asks else None

    @property
    def mid(self) -> float | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid + self.best_ask) / 2

    def spread_bps(self) -> float | None:
        """Spread in basis points of mid price."""
        mid = self.mid
        if mid is None or mid <= 0 or self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_ask - self.best_bid) / mid * 10_000

    def is_stale(self, now_ms: int | None = None, max_age_ms: int = 10_000) -> bool:
        if not self.synced:
            return True
        now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
        return now_ms - self.last_update_ms > max_age_ms


def book_imbalance(bids: dict[float, float], asks: dict[float, float],
                   depth_bps: float = 50.0) -> float:
    """Bid share of notional within `depth_bps` of mid: 0-100, 50 = balanced."""
    if not bids or not asks:
        return 50.0
    best_bid, best_ask = max(bids), min(asks)
    mid = (best_bid + best_ask) / 2
    band = mid * depth_bps / 10_000
    bid_vol = sum(q * p for p, q in bids.items() if p >= mid - band)
    ask_vol = sum(q * p for p, q in asks.items() if p <= mid + band)
    total = bid_vol + ask_vol
    return 100.0 * bid_vol / total if total > 0 else 50.0


def find_walls(book: dict[float, float], median_mult: float = 5.0,
               top_n: int = 5) -> list[dict]:
    """Levels whose size is >= `median_mult` x the median level size."""
    if not book:
        return []
    sizes = sorted(book.values())
    median = sizes[len(sizes) // 2]
    if median <= 0:
        return []
    walls = [
        {"price": p, "qty": q, "multiple": q / median}
        for p, q in book.items() if q >= median_mult * median
    ]
    walls.sort(key=lambda w: w["qty"], reverse=True)
    return walls[:top_n]


def concentration(book: dict[float, float], top_n: int = 3) -> float:
    """Share of total size held by the `top_n` largest levels (0-1)."""
    if not book:
        return 0.0
    total = sum(book.values())
    if total <= 0:
        return 0.0
    top = sorted(book.values(), reverse=True)[:top_n]
    return sum(top) / total


@dataclass
class SpreadReading:
    spread_bps: float
    timestamp_ms: int


class SpreadMonitor:
    """Tracks spread history and flags abnormal widening vs the rolling median."""

    def __init__(self, window: int = 60, widen_mult: float = 3.0):
        self.window = window
        self.widen_mult = widen_mult
        self.readings: list[SpreadReading] = []

    def add(self, spread_bps: float, timestamp_ms: int) -> None:
        self.readings.append(SpreadReading(spread_bps, timestamp_ms))
        self.readings = self.readings[-self.window:]

    def median_spread(self) -> float | None:
        if not self.readings:
            return None
        vals = sorted(r.spread_bps for r in self.readings)
        return vals[len(vals) // 2]

    def is_abnormally_wide(self) -> bool:
        med = self.median_spread()
        if med is None or not self.readings or med <= 0:
            return False
        return self.readings[-1].spread_bps > med * self.widen_mult


@dataclass
class _TrackedOrder:
    price: float
    qty: float
    side: str
    first_seen_ms: int
    last_seen_ms: int


class SpoofDetector:
    """Heuristic spoofing-like detection: a large order (vs median level
    size) that appears and disappears within `max_lifetime_ms` without
    trading is flagged. This is a heuristic signal for the liquidity-quality
    score, NOT an accusation of spoofing."""

    def __init__(self, size_mult: float = 5.0, max_lifetime_ms: int = 5_000):
        self.size_mult = size_mult
        self.max_lifetime_ms = max_lifetime_ms
        self._orders: dict[tuple[str, float], _TrackedOrder] = {}
        self.flags: list[dict] = []

    def observe(self, bids: dict[float, float], asks: dict[float, float],
                now_ms: int) -> list[dict]:
        """Feed a book state; returns newly flagged spoofing-like events."""
        new_flags: list[dict] = []
        current: dict[tuple[str, float], float] = {}
        for side, book in (("bid", bids), ("ask", asks)):
            sizes = sorted(book.values())
            median = sizes[len(sizes) // 2] if sizes else 0.0
            for price, qty in book.items():
                current[(side, price)] = qty
                if median > 0 and qty >= self.size_mult * median:
                    key = (side, price)
                    if key not in self._orders:
                        self._orders[key] = _TrackedOrder(price, qty, side, now_ms, now_ms)
                    else:
                        self._orders[key].last_seen_ms = now_ms
        # Orders that vanished: flag if they lived briefly.
        for key, order in list(self._orders.items()):
            if key not in current:
                lifetime = order.last_seen_ms - order.first_seen_ms
                if lifetime <= self.max_lifetime_ms:
                    flag = {"side": order.side, "price": order.price, "qty": order.qty,
                            "lifetime_ms": lifetime, "at_ms": now_ms}
                    self.flags.append(flag)
                    new_flags.append(flag)
                del self._orders[key]
        return new_flags
