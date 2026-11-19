"""100-point confluence scoring + level construction.

Exact weights (spec):
  Structure 15 · Order Flow/CVD 20 · Footprint 15 · Liquidity Sweep 15 ·
  Volume 10 · VWAP 10 · Trend Strength 10 · Liquidity Quality 5.

Classes: 85-100 High Confluence, 75-84 Strong, 65-74 Watchlist, <65 No Trade.

The score is CONFLUENCE, not a win probability — a 90/100 signal is not a
90% chance of winning. A 70% win rate is an unvalidated research target for
the backtest programme, not a claim about this system.

No signal is emitted without valid SL/TP levels at >= 1:2 R:R, and every
direction must pass its confirmation gate (HTF bias, structure, no
opposing divergence) before it can score.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .footprint import Footprint
from .orderflow import OrderFlowStats
from .structure import StructureAnalysis

WEIGHTS = {
    "structure": 15,
    "orderflow": 20,
    "footprint": 15,
    "sweep": 15,
    "volume": 10,
    "vwap": 10,
    "trend_strength": 10,
    "liquidity_quality": 5,
}
assert sum(WEIGHTS.values()) == 100

MIN_DIRECTION_SPREAD = 8  # long-vs-short score gap; below it the market is chop


def score_class(score: int) -> str:
    if score >= 85:
        return "HIGH_CONFLUENCE"
    if score >= 75:
        return "STRONG"
    if score >= 65:
        return "WATCHLIST"
    return "NO_TRADE"


@dataclass
class SignalContext:
    symbol: str
    price: float
    atr: float | None
    structure: StructureAnalysis
    orderflow: OrderFlowStats
    footprint: Footprint
    volume_ratio: float = 1.0
    vwap: float | None = None
    book_imbalance: float = 50.0     # 0-100, >50 bid-heavy
    spread_bps: float | None = None
    htf_bias: str | None = None      # 'bullish' | 'bearish' | None
    spoof_flags: int = 0
    tp_levels_long: list[float] = field(default_factory=list)   # resistances above
    tp_levels_short: list[float] = field(default_factory=list)  # supports below


@dataclass
class Levels:
    entry: float
    stop_loss: float
    take_profit_1: float
    take_profit_2: float
    risk: float
    rr_tp1: float
    rr_tp2: float


@dataclass
class Signal:
    symbol: str
    direction: str                   # 'LONG' | 'SHORT'
    score: int
    score_class: str
    parts: dict[str, int]
    reasons: list[str]
    levels: Levels
    timeframe: str = "15m"


def _clamp_int(x: float, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(round(x))))


def score_direction(direction: str, ctx: SignalContext) -> tuple[dict[str, int], list[str]]:
    """Score one direction (LONG/SHORT) against the context. Returns parts + reasons."""
    is_long = direction == "LONG"
    st = ctx.structure
    of = ctx.orderflow
    fp = ctx.footprint
    parts: dict[str, int] = {}
    reasons: list[str] = []

    # --- Structure (15) ---
    s = 0
    if is_long and (st.bos_bullish or st.choch_bullish):
        s += 8
        reasons.append("Bullish BOS/CHoCH — structure broke up")
    if not is_long and (st.bos_bearish or st.choch_bearish):
        s += 8
        reasons.append("Bearish BOS/CHoCH — structure broke down")
    if is_long and st.pattern == "HH/HL":
        s += 4
        reasons.append("Higher highs + higher lows — uptrend structure")
    if not is_long and st.pattern == "LH/LL":
        s += 4
        reasons.append("Lower highs + lower lows — downtrend structure")
    ob = [b for b in st.order_blocks if b.direction == ("bullish" if is_long else "bearish")]
    fvg = [f for f in st.fvgs if f.direction == ("bullish" if is_long else "bearish")]
    if ob or fvg:
        s += 3
        reasons.append("Order block / FVG confluence in direction")
    parts["structure"] = _clamp_int(s, 0, WEIGHTS["structure"])

    # --- Order Flow / CVD (20) ---
    o = 0
    signed_delta = of.delta_ratio if is_long else -of.delta_ratio
    o += _clamp_int(max(0.0, signed_delta) * 20, 0, 10)  # delta up to 10
    if (is_long and of.cvd_trend == "rising") or (not is_long and of.cvd_trend == "falling"):
        o += 5
        reasons.append("CVD trending with direction")
    taker = of.taker_buy_ratio if is_long else 1 - of.taker_buy_ratio
    o += _clamp_int(max(0.0, taker - 0.5) * 10, 0, 5)
    if (is_long and of.divergence == "bearish") or (not is_long and of.divergence == "bullish"):
        o -= 8
        reasons.append("Price/CVD divergence against direction")
    if signed_delta > 0.15:
        reasons.append(f"Trade delta {'+' if is_long else ''}{of.delta_ratio * 100:+.0f}% — aggressive "
                       + ("buying" if is_long else "selling"))
    parts["orderflow"] = _clamp_int(o, 0, WEIGHTS["orderflow"])

    # --- Footprint (15) ---
    f = 0
    want = "ask" if is_long else "bid"
    if fp.stacked_imbalance == want:
        f += 8
        reasons.append("Stacked footprint imbalance in direction (3+ levels)")
    imb_count = fp.imbalance_ask_count if is_long else fp.imbalance_bid_count
    f += _clamp_int(imb_count, 0, 4)
    if fp.poc_price is not None:
        if is_long and ctx.price > fp.poc_price:
            f += 3
        elif not is_long and ctx.price < fp.poc_price:
            f += 3
    parts["footprint"] = _clamp_int(f, 0, WEIGHTS["footprint"])

    # --- Liquidity Sweep (15) ---
    w = 0
    if is_long and st.sweep_low:
        w += 12
        reasons.append("Sweep of swing lows + reclaim — liquidity grab, long")
    if not is_long and st.sweep_high:
        w += 12
        reasons.append("Sweep of swing highs + rejection — liquidity grab, short")
    if w == 0 and st.liquidity_pools:
        # Price sitting on a pool without sweeping it yet: partial credit only
        # when the pool is on the entry side.
        nearest = min(st.liquidity_pools, key=lambda p: abs(p - ctx.price))
        if abs(nearest - ctx.price) / ctx.price < 0.001:
            w += 4
            reasons.append("Price at a liquidity pool (equal highs/lows)")
    parts["sweep"] = _clamp_int(w, 0, WEIGHTS["sweep"])

    # --- Volume (10) ---
    v = _clamp_int((ctx.volume_ratio - 0.5) * 10, 0, 10)  # 1.0x avg = 5, 1.5x+ = 10
    if ctx.volume_ratio > 1.2:
        reasons.append(f"Volume {ctx.volume_ratio:.1f}x average — move has fuel")
    parts["volume"] = v

    # --- VWAP (10) ---
    vw = 5
    if ctx.vwap is not None:
        if is_long:
            vw = 10 if ctx.price > ctx.vwap else 2
        else:
            vw = 10 if ctx.price < ctx.vwap else 2
        if vw == 10:
            reasons.append("Price on the right side of VWAP")
    parts["vwap"] = vw

    # --- Trend Strength (10) ---
    adx_v = st.adx_value
    trend_agrees = (is_long and st.trend == "bullish") or (not is_long and st.trend == "bearish")
    htf_agrees = ctx.htf_bias == ("bullish" if is_long else "bearish")
    t = _clamp_int(adx_v * 0.1, 0, 10) if trend_agrees else _clamp_int(adx_v * 0.05, 0, 5)
    if htf_agrees and adx_v >= 25:
        reasons.append(f"HTF bias agrees · ADX {adx_v:.0f} — trend is real, not chop")
    parts["trend_strength"] = t

    # --- Liquidity Quality (5) ---
    lq = 0
    if ctx.spread_bps is not None and ctx.spread_bps <= 10:
        lq += 2
    elif ctx.spread_bps is not None and ctx.spread_bps <= 20:
        lq += 1
    imb = ctx.book_imbalance if is_long else 100 - ctx.book_imbalance
    if imb >= 60:
        lq += 2
        reasons.append(f"Order book {imb:.0f}% stacked in direction")
    elif imb >= 55:
        lq += 1
    if ctx.spoof_flags == 0:
        lq += 1
    parts["liquidity_quality"] = _clamp_int(lq, 0, WEIGHTS["liquidity_quality"])

    return parts, reasons


def confirmation_passed(direction: str, ctx: SignalContext) -> tuple[bool, str | None]:
    """Direction confirmation gate. A direction that fails this gate cannot
    produce a signal, whatever its score.

    LONG requires: HTF bias not bearish; structure not bearish unless a
    bullish CHoCH fired; price not at extreme premium without a BOS; no
    bearish price/CVD divergence; and at least one of BOS / sweep /
    CHoCH in direction. SHORT is mirrored.
    """
    is_long = direction == "LONG"
    st = ctx.structure
    htf_bad = ctx.htf_bias == ("bearish" if is_long else "bullish")
    if htf_bad:
        return False, "HTF bias opposes direction"
    if is_long and st.trend == "bearish" and not st.choch_bullish:
        return False, "Structure bearish with no bullish CHoCH"
    if not is_long and st.trend == "bullish" and not st.choch_bearish:
        return False, "Structure bullish with no bearish CHoCH"
    if is_long and st.premium_discount > 0.9 and not st.bos_bullish:
        return False, "Price at extreme premium without bullish BOS"
    if not is_long and st.premium_discount < 0.1 and not st.bos_bearish:
        return False, "Price at extreme discount without bearish BOS"
    if (is_long and ctx.orderflow.divergence == "bearish") or \
       (not is_long and ctx.orderflow.divergence == "bullish"):
        return False, "Price/CVD divergence opposes direction"
    trigger = (
        (st.bos_bullish or st.choch_bullish or st.sweep_low) if is_long
        else (st.bos_bearish or st.choch_bearish or st.sweep_high)
    )
    if not trigger:
        return False, "No BOS / CHoCH / sweep trigger in direction"
    return True, None


def build_levels(direction: str, entry: float, swing_price: float,
                 atr_value: float | None, tp_levels: list[float],
                 min_rr: float = 2.0) -> Levels | None:
    """SL = swing + ATR buffer (0.25x ATR). TP1/TP2 = nearest liquidity/swing
    level at or beyond the R:R target, else the R:R target itself.
    Returns None when no valid SL/TP exists (no signal without valid levels).
    """
    is_long = direction == "LONG"
    if entry <= 0 or swing_price <= 0:
        return None
    buffer = 0.25 * atr_value if atr_value else 0.0
    sl = swing_price - buffer if is_long else swing_price + buffer
    risk = (entry - sl) if is_long else (sl - entry)
    if risk <= 0:
        return None  # stop on the wrong side of entry
    if risk > entry * 0.10:
        return None  # absurd risk (>10% of price) — data or swing error
    tp1_target = entry + min_rr * risk if is_long else entry - min_rr * risk
    tp2_target = entry + 3.5 * risk if is_long else entry - 3.5 * risk

    def _nearest_beyond(target: float, levels: list[float]) -> float:
        cands = [lv for lv in levels
                 if (lv >= target if is_long else lv <= target)]
        if not cands:
            return target
        return min(cands) if is_long else max(cands)

    tp1 = _nearest_beyond(tp1_target, tp_levels)
    tp2 = _nearest_beyond(tp2_target, tp_levels)
    if is_long and not (tp2 > tp1 > entry):
        return None
    if not is_long and not (tp2 < tp1 < entry):
        return None
    rr1 = abs(tp1 - entry) / risk
    rr2 = abs(tp2 - entry) / risk
    if rr1 < min_rr:
        return None
    return Levels(entry=entry, stop_loss=sl, take_profit_1=tp1,
                  take_profit_2=tp2, risk=risk, rr_tp1=rr1, rr_tp2=rr2)


def score_signal(ctx: SignalContext, min_score: int = 65,
                 min_rr: float = 2.0, timeframe: str = "15m") -> Signal | None:
    """Score both directions, apply confirmation gates + chop filter, build
    levels. Returns None when there is no tradeable signal."""
    results: dict[str, tuple[int, dict[str, int], list[str]]] = {}
    for direction in ("LONG", "SHORT"):
        ok, _why = confirmation_passed(direction, ctx)
        if not ok:
            continue
        parts, reasons = score_direction(direction, ctx)
        results[direction] = (sum(parts.values()), parts, reasons)
    if not results:
        return None
    direction = max(results, key=lambda d: results[d][0])
    score, parts, reasons = results[direction]
    if len(results) == 2:
        other = "SHORT" if direction == "LONG" else "LONG"
        if abs(score - results[other][0]) < MIN_DIRECTION_SPREAD:
            return None  # chop — no clear direction
    if score < min_score:
        return None
    st = ctx.structure
    swing = st.last_swing_low if direction == "LONG" else st.last_swing_high
    if swing is None:
        return None
    tp_levels = ctx.tp_levels_long if direction == "LONG" else ctx.tp_levels_short
    levels = build_levels(direction, ctx.price, swing, ctx.atr, tp_levels, min_rr)
    if levels is None:
        return None
    return Signal(
        symbol=ctx.symbol, direction=direction, score=score,
        score_class=score_class(score), parts=parts, reasons=reasons,
        levels=levels, timeframe=timeframe,
    )
