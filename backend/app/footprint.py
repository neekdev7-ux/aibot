"""Footprint chart builder: per-price-level bid/ask/delta/total, imbalance
flags, and volume profile (POC + value area).

Built from aggTrades (each trade is classified by aggressor side). A level
is imbalanced when one side is >= 3x the other (the standard 300% rule).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .orderflow import AggTrade

IMBALANCE_RATIO = 3.0
VALUE_AREA_PCT = 0.70


@dataclass
class FootprintLevel:
    price: float
    bid: float = 0.0   # aggressive sell volume at this price
    ask: float = 0.0   # aggressive buy volume at this price

    @property
    def total(self) -> float:
        return self.bid + self.ask

    @property
    def delta(self) -> float:
        return self.ask - self.bid

    @property
    def imbalance(self) -> str | None:
        """'bid' | 'ask' | None — one side >= 3x the other."""
        if self.ask >= IMBALANCE_RATIO * max(self.bid, 1e-12) and self.ask > 0:
            return "ask"
        if self.bid >= IMBALANCE_RATIO * max(self.ask, 1e-12) and self.bid > 0:
            return "bid"
        return None


@dataclass
class Footprint:
    levels: list[FootprintLevel] = field(default_factory=list)
    total_volume: float = 0.0
    total_delta: float = 0.0
    poc_price: float | None = None          # point of control (max volume level)
    value_area_high: float | None = None
    value_area_low: float | None = None
    imbalance_ask_count: int = 0
    imbalance_bid_count: int = 0
    stacked_imbalance: str | None = None    # 'ask' | 'bid' | None (3+ stacked)

    def to_dict(self) -> dict:
        return {
            "levels": [
                {"price": l.price, "bid": l.bid, "ask": l.ask,
                 "delta": l.delta, "total": l.total, "imbalance": l.imbalance}
                for l in self.levels
            ],
            "total_volume": self.total_volume,
            "total_delta": self.total_delta,
            "poc_price": self.poc_price,
            "value_area_high": self.value_area_high,
            "value_area_low": self.value_area_low,
            "imbalance_ask_count": self.imbalance_ask_count,
            "imbalance_bid_count": self.imbalance_bid_count,
            "stacked_imbalance": self.stacked_imbalance,
        }


def build_footprint(trades: list[AggTrade], tick_size: float) -> Footprint:
    """Aggregate trades into price levels on the tick grid."""
    fp = Footprint()
    if not trades or tick_size <= 0:
        return fp
    by_price: dict[float, FootprintLevel] = {}
    for t in trades:
        price = round(t.price / tick_size) * tick_size
        lvl = by_price.setdefault(price, FootprintLevel(price=price))
        if t.is_aggressive_buy:
            lvl.ask += t.qty
        else:
            lvl.bid += t.qty
    fp.levels = [by_price[p] for p in sorted(by_price)]
    fp.total_volume = sum(l.total for l in fp.levels)
    fp.total_delta = sum(l.delta for l in fp.levels)
    fp.imbalance_ask_count = sum(1 for l in fp.levels if l.imbalance == "ask")
    fp.imbalance_bid_count = sum(1 for l in fp.levels if l.imbalance == "bid")
    fp.stacked_imbalance = _stacked_imbalance(fp.levels)
    poc, vah, val = volume_profile(fp.levels)
    fp.poc_price, fp.value_area_high, fp.value_area_low = poc, vah, val
    return fp


def _stacked_imbalance(levels: list[FootprintLevel]) -> str | None:
    """3+ consecutive levels imbalanced the same way = stacked imbalance."""
    for side in ("ask", "bid"):
        run = 0
        for l in levels:
            run = run + 1 if l.imbalance == side else 0
            if run >= 3:
                return side
    return None


def volume_profile(levels: list[FootprintLevel],
                   value_area_pct: float = VALUE_AREA_PCT
                   ) -> tuple[float | None, float | None, float | None]:
    """POC (max-volume level) and the value area: smallest contiguous band
    around the POC holding `value_area_pct` of total volume."""
    if not levels:
        return None, None, None
    total = sum(l.total for l in levels)
    if total <= 0:
        return None, None, None
    poc_idx = max(range(len(levels)), key=lambda i: levels[i].total)
    poc = levels[poc_idx].price
    target = total * value_area_pct
    acc = levels[poc_idx].total
    lo = hi = poc_idx
    while acc < target and (lo > 0 or hi < len(levels) - 1):
        up = levels[hi + 1].total if hi < len(levels) - 1 else -1
        dn = levels[lo - 1].total if lo > 0 else -1
        if up >= dn:
            hi += 1
            acc += levels[hi].total
        else:
            lo -= 1
            acc += levels[lo].total
    return poc, levels[hi].price, levels[lo].price
