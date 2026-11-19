"""Market structure analysis — swings, BOS/CHoCH, S/R, sweeps, FVG,
order blocks, premium/discount, trend + sideways detection.

All functions operate on CONFIRMED (closed) candles only: the live candle
is dropped before any calculation, so a structure event can never be
"confirmed" by a candle that is still forming.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .indicators import Candle, adx, atr, closed_candles


@dataclass
class Swing:
    index: int
    price: float
    kind: str  # 'high' | 'low'


@dataclass
class StructureEvent:
    kind: str  # 'BOS' | 'CHoCH' | 'SWEEP_HIGH' | 'SWEEP_LOW'
    index: int
    price: float
    broken_level: float


@dataclass
class FVG:
    top: float
    bottom: float
    index: int          # index of the impulse candle (middle of the 3)
    direction: str      # 'bullish' | 'bearish'
    filled: bool = False


@dataclass
class OrderBlock:
    top: float
    bottom: float
    index: int
    direction: str      # 'bullish' | 'bearish'


@dataclass
class StructureAnalysis:
    swings_high: list[Swing] = field(default_factory=list)
    swings_low: list[Swing] = field(default_factory=list)
    events: list[StructureEvent] = field(default_factory=list)
    trend: str = "sideways"         # 'bullish' | 'bearish' | 'sideways'
    pattern: str = "none"           # HH/HL, LH/LL, mixed
    supports: list[float] = field(default_factory=list)
    resistances: list[float] = field(default_factory=list)
    fvgs: list[FVG] = field(default_factory=list)
    order_blocks: list[OrderBlock] = field(default_factory=list)
    liquidity_pools: list[float] = field(default_factory=list)
    premium_discount: float = 0.5   # 0 = discount extreme, 1 = premium extreme
    is_sideways: bool = False
    adx_value: float = 0.0
    atr_value: float | None = None
    last_swing_high: float | None = None
    last_swing_low: float | None = None
    bos_bullish: bool = False
    bos_bearish: bool = False
    choch_bullish: bool = False
    choch_bearish: bool = False
    sweep_high: bool = False
    sweep_low: bool = False


def find_swings(candles: list[Candle], left: int = 2, right: int = 2) -> tuple[list[Swing], list[Swing]]:
    """Fractal swings: a high (low) exceeding its `left`/`right` neighbours."""
    highs: list[Swing] = []
    lows: list[Swing] = []
    for i in range(left, len(candles) - right):
        h, l = candles[i].high, candles[i].low
        if all(h > candles[j].high for j in range(i - left, i + right + 1) if j != i):
            highs.append(Swing(index=i, price=h, kind="high"))
        if all(l < candles[j].low for j in range(i - left, i + right + 1) if j != i):
            lows.append(Swing(index=i, price=l, kind="low"))
    return highs, lows


def _classify_pattern(highs: list[Swing], lows: list[Swing]) -> tuple[str, str]:
    """HH/HL vs LH/LL from the last two swings of each kind."""
    if len(highs) >= 2 and len(lows) >= 2:
        hh = highs[-1].price > highs[-2].price
        hl = lows[-1].price > lows[-2].price
        lh = highs[-1].price < highs[-2].price
        ll = lows[-1].price < lows[-2].price
        if hh and hl:
            return "bullish", "HH/HL"
        if lh and ll:
            return "bearish", "LH/LL"
        return "sideways", "mixed"
    return "sideways", "none"


def _cluster_levels(prices: list[float], tolerance_pct: float) -> list[float]:
    """Merge nearby levels; return cluster means, most-touched first."""
    clusters: list[list[float]] = []
    for p in sorted(prices):
        placed = False
        for c in clusters:
            if abs(p - c[0]) / c[0] <= tolerance_pct:
                c.append(p)
                placed = True
                break
        if not placed:
            clusters.append([p])
    clusters.sort(key=len, reverse=True)
    return [sum(c) / len(c) for c in clusters]


def detect_bos_choch(candles: list[Candle], highs: list[Swing], lows: list[Swing],
                     trend: str) -> list[StructureEvent]:
    """Break of Structure (with-trend break) vs Change of Character
    (against-trend break). A break counts only on a candle CLOSE beyond the
    level — wicks alone do not break structure."""
    events: list[StructureEvent] = []
    if not candles or (not highs and not lows):
        return events
    last_high = highs[-1] if highs else None
    last_low = lows[-1] if lows else None
    # Only swings formed before the final candle can be broken by it.
    for i in range(max(1, len(candles) - 3), len(candles)):
        close = candles[i].close
        if last_high and last_high.index < i and close > last_high.price:
            kind = "BOS" if trend == "bullish" else "CHoCH"
            events.append(StructureEvent(kind, i, close, last_high.price))
        if last_low and last_low.index < i and close < last_low.price:
            kind = "BOS" if trend == "bearish" else "CHoCH"
            events.append(StructureEvent(kind, i, close, last_low.price))
    return events


def detect_sweeps(candles: list[Candle], highs: list[Swing], lows: list[Swing]) -> list[StructureEvent]:
    """Liquidity sweep: wick beyond a swing level, close back inside it."""
    events: list[StructureEvent] = []
    if len(candles) < 2:
        return events
    for i in range(max(1, len(candles) - 5), len(candles)):
        c = candles[i]
        for s in highs:
            if s.index < i and c.high > s.price and c.close <= s.price:
                events.append(StructureEvent("SWEEP_HIGH", i, c.high, s.price))
        for s in lows:
            if s.index < i and c.low < s.price and c.close >= s.price:
                events.append(StructureEvent("SWEEP_LOW", i, c.low, s.price))
    return events


def find_fvgs(candles: list[Candle]) -> list[FVG]:
    """Fair Value Gaps: 3-candle imbalance where candle[i-1].high < candle[i+1].low
    (bullish) or candle[i-1].low > candle[i+1].high (bearish)."""
    fvgs: list[FVG] = []
    for i in range(1, len(candles) - 1):
        prev, _, nxt = candles[i - 1], candles[i], candles[i + 1]
        if prev.high < nxt.low:
            fvgs.append(FVG(top=nxt.low, bottom=prev.high, index=i, direction="bullish"))
        elif prev.low > nxt.high:
            fvgs.append(FVG(top=prev.low, bottom=nxt.high, index=i, direction="bearish"))
    # A gap is filled if a later candle trades through it.
    for f in fvgs:
        for c in candles[f.index + 2:]:
            if c.low <= f.top and c.high >= f.bottom:
                f.filled = True
                break
    return fvgs


def find_order_blocks(candles: list[Candle], events: list[StructureEvent]) -> list[OrderBlock]:
    """Order block = last opposing candle before a BOS/CHoCH break."""
    blocks: list[OrderBlock] = []
    for ev in events:
        if ev.kind not in ("BOS", "CHoCH"):
            continue
        # Walk back from the break candle to the last opposite-coloured candle.
        direction = "bullish" if ev.price > ev.broken_level else "bearish"
        for j in range(ev.index - 1, max(-1, ev.index - 6), -1):
            c = candles[j]
            is_down = c.close < c.open
            if (direction == "bullish" and is_down) or (direction == "bearish" and not is_down):
                blocks.append(OrderBlock(top=c.high, bottom=c.low, index=j, direction=direction))
                break
    return blocks


def find_liquidity_pools(highs: list[Swing], lows: list[Swing],
                         tolerance_pct: float = 0.001) -> list[float]:
    """Equal highs / equal lows: 2+ swing levels within tolerance — resting
    stop clusters that price is drawn to sweep."""
    pools: list[float] = []
    for swings in (highs, lows):
        for i in range(len(swings)):
            for j in range(i + 1, len(swings)):
                if abs(swings[i].price - swings[j].price) / swings[i].price <= tolerance_pct:
                    pools.append((swings[i].price + swings[j].price) / 2)
    return sorted(set(round(p, 8) for p in pools))


def premium_discount(price: float, swing_high: float, swing_low: float) -> float:
    """Position inside the current swing range: 0 = at the low (discount),
    0.5 = equilibrium, 1 = at the high (premium)."""
    if swing_high <= swing_low:
        return 0.5
    return max(0.0, min(1.0, (price - swing_low) / (swing_high - swing_low)))


def analyze_structure(candles: list[Candle]) -> StructureAnalysis:
    """Full structure pass over confirmed candles only."""
    closed = closed_candles(candles)
    result = StructureAnalysis()
    if len(closed) < 10:
        return result
    highs, lows = find_swings(closed)
    result.swings_high, result.swings_low = highs, lows
    trend, pattern = _classify_pattern(highs, lows)
    result.trend, result.pattern = trend, pattern
    price = closed[-1].close
    tol = 0.002
    result.supports = _cluster_levels([s.price for s in lows if s.price < price], tol)[:5]
    result.resistances = _cluster_levels([s.price for s in highs if s.price > price], tol)[:5]
    result.liquidity_pools = find_liquidity_pools(highs, lows)
    result.fvgs = [f for f in find_fvgs(closed) if not f.filled][-5:]
    events = detect_bos_choch(closed, highs, lows, trend)
    events += detect_sweeps(closed, highs, lows)
    result.events = events
    result.order_blocks = find_order_blocks(closed, events)
    result.bos_bullish = any(e.kind == "BOS" and e.price > e.broken_level for e in events)
    result.bos_bearish = any(e.kind == "BOS" and e.price < e.broken_level for e in events)
    result.choch_bullish = any(e.kind == "CHoCH" and e.price > e.broken_level for e in events)
    result.choch_bearish = any(e.kind == "CHoCH" and e.price < e.broken_level for e in events)
    result.sweep_high = any(e.kind == "SWEEP_HIGH" for e in events)
    result.sweep_low = any(e.kind == "SWEEP_LOW" for e in events)
    if highs and lows:
        result.last_swing_high = highs[-1].price
        result.last_swing_low = lows[-1].price
        result.premium_discount = premium_discount(price, highs[-1].price, lows[-1].price)
    result.adx_value = adx(closed)
    result.atr_value = atr(closed)
    # Sideways: weak trend (ADX < 20) AND price oscillating inside the range
    # without a fresh swing break.
    result.is_sideways = result.adx_value < 20 and not (
        result.bos_bullish or result.bos_bearish or result.choch_bullish or result.choch_bearish
    )
    return result
