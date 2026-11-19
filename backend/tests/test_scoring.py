"""Scoring / levels tests with hand-computed expectations. No network, no DB."""
import pytest

from app.footprint import Footprint, FootprintLevel
from app.orderflow import OrderFlowStats
from app.signals import (WEIGHTS, build_levels, confirmation_passed,
                         score_class, score_direction, score_signal)
from app.signals import SignalContext
from app.structure import OrderBlock, StructureAnalysis


def test_weights_sum_to_100():
    assert sum(WEIGHTS.values()) == 100
    assert WEIGHTS == {
        "structure": 15, "orderflow": 20, "footprint": 15, "sweep": 15,
        "volume": 10, "vwap": 10, "trend_strength": 10, "liquidity_quality": 5,
    }


@pytest.mark.parametrize("score,expected", [
    (100, "HIGH_CONFLUENCE"), (85, "HIGH_CONFLUENCE"),
    (84, "STRONG"), (75, "STRONG"),
    (74, "WATCHLIST"), (65, "WATCHLIST"),
    (64, "NO_TRADE"), (0, "NO_TRADE"),
])
def test_score_class_boundaries(score, expected):
    assert score_class(score) == expected


def test_build_levels_long_hand_computed():
    # entry 100, swing 95, ATR 2 -> buffer 0.5, SL 94.5, risk 5.5.
    # TP1 target 111 -> nearest level beyond = 112; TP2 target 119.25 -> 120.
    lv = build_levels("LONG", 100.0, 95.0, 2.0, [112.0, 120.0])
    assert lv is not None
    assert lv.stop_loss == pytest.approx(94.5)
    assert lv.risk == pytest.approx(5.5)
    assert lv.take_profit_1 == pytest.approx(112.0)
    assert lv.take_profit_2 == pytest.approx(120.0)
    assert lv.rr_tp1 == pytest.approx(12 / 5.5)
    assert lv.rr_tp1 >= 2.0


def test_build_levels_short_hand_computed():
    # entry 100, swing 105, ATR 2 -> buffer 0.5, SL 105.5, risk 5.5.
    # TP1 target 89 -> nearest level at/below = 88; TP2 target 80.75 -> 80.
    lv = build_levels("SHORT", 100.0, 105.0, 2.0, [88.0, 80.0])
    assert lv is not None
    assert lv.stop_loss == pytest.approx(105.5)
    assert lv.take_profit_1 == pytest.approx(88.0)
    assert lv.take_profit_2 == pytest.approx(80.0)


def test_build_levels_invalid_returns_none():
    # Stop on the wrong side of entry (swing above entry for a long).
    assert build_levels("LONG", 100.0, 105.0, 2.0, [112.0]) is None
    assert build_levels("SHORT", 100.0, 95.0, 2.0, [88.0]) is None
    # Absurd risk (>10% of price).
    assert build_levels("LONG", 100.0, 80.0, 2.0, [130.0]) is None
    # Non-positive entry.
    assert build_levels("LONG", 0.0, 95.0, 2.0, [112.0]) is None


def _bullish_context() -> SignalContext:
    """Hand-scored bullish context. Expected LONG total = 87:
    structure 15 (8 BOS + 4 HH/HL + 3 OB) + orderflow 17 (10 delta + 5 CVD
    + 2 taker) + footprint 15 (8 stacked + 4 count + 3 POC) + sweep 12
    + volume 10 + vwap 10 + trend 3 (ADX 30 x 0.1) + liquidity 5."""
    st = StructureAnalysis(
        trend="bullish", pattern="HH/HL",
        bos_bullish=True, sweep_low=True,
        order_blocks=[OrderBlock(top=99, bottom=97, index=5, direction="bullish")],
        adx_value=30.0, atr_value=2.0,
        last_swing_high=110.0, last_swing_low=95.0,
        premium_discount=0.4,
    )
    of = OrderFlowStats(delta_ratio=0.5, taker_buy_ratio=0.7, cvd_trend="rising")
    fp = Footprint(
        levels=[FootprintLevel(price=99.0, bid=1.0, ask=5.0)],
        poc_price=98.0, imbalance_ask_count=4, stacked_imbalance="ask",
    )
    return SignalContext(
        symbol="BTCUSDT", price=100.0, atr=2.0, structure=st, orderflow=of,
        footprint=fp, volume_ratio=1.5, vwap=99.0, book_imbalance=65.0,
        spread_bps=5.0, htf_bias="bullish",
        tp_levels_long=[112.0, 120.0], tp_levels_short=[88.0, 80.0],
    )


def test_score_direction_bullish_hand_computed():
    parts, reasons = score_direction("LONG", _bullish_context())
    assert parts == {
        "structure": 15, "orderflow": 17, "footprint": 15, "sweep": 12,
        "volume": 10, "vwap": 10, "trend_strength": 3, "liquidity_quality": 5,
    }
    assert sum(parts.values()) == 87
    assert reasons  # reasons are populated, not empty


def test_score_signal_returns_high_confluence_long():
    sig = score_signal(_bullish_context(), min_score=65)
    assert sig is not None
    assert sig.direction == "LONG"
    assert sig.score == 87
    assert sig.score_class == "HIGH_CONFLUENCE"
    assert sig.levels.rr_tp1 >= 2.0
    assert sig.levels.stop_loss < sig.levels.entry < sig.levels.take_profit_1


def test_confirmation_gate_blocks_opposing_htf():
    ctx = _bullish_context()
    ctx.htf_bias = "bearish"
    ok, why = confirmation_passed("LONG", ctx)
    assert ok is False
    assert "HTF" in (why or "")
    # And the full scorer emits no LONG; SHORT also fails (no bearish trigger).
    assert score_signal(ctx, min_score=65) is None


def test_confirmation_gate_requires_trigger():
    ctx = _bullish_context()
    ctx.structure.bos_bullish = False
    ctx.structure.choch_bullish = False
    ctx.structure.sweep_low = False
    ok, why = confirmation_passed("LONG", ctx)
    assert ok is False
    assert "trigger" in (why or "").lower()


def test_no_signal_without_valid_levels():
    ctx = _bullish_context()
    ctx.structure.last_swing_low = None  # no swing to anchor the stop
    assert score_signal(ctx, min_score=65) is None


def test_no_signal_below_min_score():
    ctx = _bullish_context()
    assert score_signal(ctx, min_score=90) is None  # 87 < 90
