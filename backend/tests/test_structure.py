"""Market-structure tests on hand-built candle series. No network, no DB."""
from app.indicators import Candle
from app.structure import (analyze_structure, detect_bos_choch,
                           detect_sweeps, find_fvgs, find_swings,
                           premium_discount)


def mk_series(closes, lows=None, highs=None):
    out = []
    for i, c in enumerate(closes):
        out.append(Candle(
            open_time=i, open=c,
            high=(highs[i] if highs else c + 1),
            low=(lows[i] if lows else c - 1),
            close=c, volume=100.0, is_closed=True))
    return out


def test_find_swings():
    # Peak at index 5 (high 106), trough at index 7 (low 100).
    closes = [100, 101, 102, 103, 104, 105, 103, 101, 102, 103, 104]
    highs, lows = find_swings(mk_series(closes))
    assert any(s.index == 5 and s.price == 106 for s in highs)
    assert any(s.index == 7 and s.price == 100 for s in lows)


def test_bos_choch_close_above_swing_high():
    closes = [100, 101, 102, 103, 104, 105, 103, 101, 102, 103, 104, 105, 106, 107, 108]
    candles = mk_series(closes)
    highs, lows = find_swings(candles)
    events = detect_bos_choch(candles, highs, lows, trend="sideways")
    # Final closes (107, 108) break the swing high at 106 -> CHoCH (no trend).
    assert any(e.kind == "CHoCH" and e.broken_level == 106 for e in events)


def test_wick_alone_does_not_break_structure():
    # High pokes above the swing high but every close stays below it.
    closes = [100, 101, 102, 103, 104, 105, 103, 101, 102, 103, 104]
    highs = [c + 1 for c in closes]
    highs[9] = 110  # wick above the 106 swing high, close stays 103
    candles = mk_series(closes, highs=highs)
    sh, sl = find_swings(candles)
    events = detect_bos_choch(candles, sh, sl, trend="sideways")
    assert not any(e.kind in ("BOS", "CHoCH") for e in events)


def test_sweep_wick_below_low_close_back_inside():
    closes = [100, 99, 98, 97, 96, 95, 96, 97, 98, 99, 100]
    lows = [c - 1 for c in closes]
    lows[8] = 93.0  # wick below the 94 swing low, close 98 back inside
    candles = mk_series(closes, lows=lows)
    sh, sl = find_swings(candles)
    events = detect_sweeps(candles, sh, sl)
    assert any(e.kind == "SWEEP_LOW" and e.broken_level == 94 for e in events)


def test_fvg_bullish_gap():
    c0 = Candle(open_time=0, open=9.5, high=10, low=9, close=9.8, volume=10,
                is_closed=True)
    c1 = Candle(open_time=1, open=10.5, high=12, low=10.5, close=11.5, volume=10,
                is_closed=True)
    c2 = Candle(open_time=2, open=11.5, high=14, low=11, close=13, volume=10,
                is_closed=True)
    fvgs = find_fvgs([c0, c1, c2])
    assert len(fvgs) == 1
    assert fvgs[0].direction == "bullish"
    assert fvgs[0].bottom == 10 and fvgs[0].top == 11
    assert fvgs[0].filled is False


def test_premium_discount():
    assert premium_discount(150, 200, 100) == 0.5
    assert premium_discount(100, 200, 100) == 0.0
    assert premium_discount(200, 200, 100) == 1.0
    assert premium_discount(100, 100, 100) == 0.5  # degenerate range


def test_analyze_structure_uptrend():
    # Rising series with 3-bar pullbacks: swing highs 106/107/109/111 and
    # swing lows 99/101/103/105 -> HH/HL pattern, bullish trend.
    closes = [100, 102, 105, 103, 101, 100, 103, 106, 104, 102,
              105, 108, 106, 104, 107, 110, 108, 106, 109, 112]
    result = analyze_structure(mk_series(closes))
    assert result.trend == "bullish"
    assert result.pattern == "HH/HL"
    assert result.is_sideways is False
    assert result.last_swing_high is not None
    assert result.last_swing_low is not None


def test_analyze_structure_sideways_flat():
    closes = [100.0] * 30
    result = analyze_structure(mk_series(closes))
    assert result.is_sideways is True
    assert result.trend == "sideways"


def test_live_candle_is_ignored():
    # A forming candle must never create structure: identical analysis with
    # and without an unclosed candle appended.
    closes = [100, 102, 105, 103, 101, 100, 103, 106, 104, 102,
              105, 108, 106, 104, 107, 110, 108, 106, 109, 112]
    base = mk_series(closes)
    live = Candle(open_time=99, open=111, high=130, low=90, close=120,
                  volume=100, is_closed=False)
    a = analyze_structure(base)
    b = analyze_structure(base + [live])
    assert a.trend == b.trend
    assert a.last_swing_high == b.last_swing_high
