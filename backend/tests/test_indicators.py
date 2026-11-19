"""Indicator tests with hand-computed fixtures. No network, no DB."""
import math

import pytest

from app.indicators import (Candle, adx, atr, bollinger, ema_series, macd,
                            relative_volume, rsi, sma, vwap)


def mk_candle(close, high=None, low=None, volume=100.0, open_time=0):
    return Candle(open_time=open_time, open=close,
                  high=high if high is not None else close + 1,
                  low=low if low is not None else close - 1,
                  close=close, volume=volume, is_closed=True)


def test_ema_series_hand_computed():
    # k = 2/(3+1) = 0.5, seeded with first value 10.
    # e1 = 11*.5 + 10*.5 = 10.5; e2 = 12*.5 + 10.5*.5 = 11.25
    # e3 = 13*.5 + 11.25*.5 = 12.125; e4 = 14*.5 + 12.125*.5 = 13.0625
    out = ema_series([10, 11, 12, 13, 14], 3)
    assert out[0] is None and out[1] is None
    assert out[2] == pytest.approx(11.25)
    assert out[3] == pytest.approx(12.125)
    assert out[4] == pytest.approx(13.0625)


def test_sma():
    assert sma([1, 2, 3, 4, 5], 3) == pytest.approx(4.0)
    assert sma([1, 2], 3) is None


def test_rsi_all_gains_is_100_all_losses_is_0():
    assert rsi(list(range(1, 20)), 14) == 100.0
    assert rsi(list(range(19, 0, -1)), 14) == 0.0
    assert rsi([100.0] * 20, 14) == 50.0  # flat: no gain, no loss


def test_rsi_mixed_hand_computed():
    # 14 up moves of +1 then 1 down move of -7 (Wilder smoothing):
    # after 14 gains: avg_gain=1, avg_loss=0 -> RSI 100 at bar 14.
    # one more bar: avg_gain = (1*13+0)/14 = 13/14; avg_loss = (0*13+7)/14 = 0.5
    # rs = (13/14)/0.5 = 13/7; RSI = 100 - 100/(1+13/7) = 65.
    closes = [100 + i for i in range(15)] + [107.0]  # last move: 114 -> 107 = -7
    assert rsi(closes, 14) == pytest.approx(65.0)


def test_atr_hand_computed():
    # Every candle: TR = max(20, |110-100|, |90-100|) = 20 -> ATR = 20.
    candles = [Candle(open_time=i, open=100, high=110, low=90, close=100,
                      volume=10, is_closed=True) for i in range(16)]
    assert atr(candles, 14) == pytest.approx(20.0)
    assert atr(candles[:5], 14) is None  # insufficient data


def test_bollinger_hand_computed():
    # Closes 10..29 (20 values): mean 19.5, population variance (20^2-1)/12 = 33.25
    closes = [float(x) for x in range(10, 30)]
    bb = bollinger(closes, 20, 2.0)
    assert bb["mid"] == pytest.approx(19.5)
    assert bb["sd"] == pytest.approx(math.sqrt(33.25))
    assert bb["upper"] == pytest.approx(19.5 + 2 * math.sqrt(33.25))
    assert bb["lower"] == pytest.approx(19.5 - 2 * math.sqrt(33.25))
    assert bollinger(closes[:10], 20) is None


def test_macd_flat_series_is_zero():
    m = macd([100.0] * 60)
    assert m["hist"] == pytest.approx(0.0)
    assert m["line"] == pytest.approx(0.0)


def test_vwap_hand_computed():
    # tp1 = (12+10+11)/3 = 11 x100; tp2 = (14+12+13)/3 = 13 x100 -> 2400/200 = 12
    c1 = Candle(open_time=0, open=11, high=12, low=10, close=11, volume=100,
                is_closed=True)
    c2 = Candle(open_time=1, open=13, high=14, low=12, close=13, volume=100,
                is_closed=True)
    assert vwap([c1, c2]) == pytest.approx(12.0)
    assert vwap([]) is None


def test_relative_volume():
    candles = [mk_candle(100, volume=100.0) for _ in range(20)]
    candles.append(mk_candle(100, volume=300.0))
    assert relative_volume(candles, 20) == pytest.approx(3.0)


def test_adx_strong_uptrend_is_high():
    # Steady rise: +DM dominates, -DM = 0 -> DX = 100 -> ADX near 100.
    candles = []
    for i in range(40):
        candles.append(Candle(open_time=i, open=i + 0.5, high=i + 2, low=i,
                              close=i + 1, volume=10, is_closed=True))
    assert adx(candles, 14) > 80


def test_adx_flat_is_low():
    candles = [mk_candle(100.0) for _ in range(40)]
    assert adx(candles, 14) < 5
