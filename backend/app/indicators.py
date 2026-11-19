"""Pure technical indicators — no I/O, fully unit-testable.

All functions operate on plain sequences. Candle is the shared OHLCV type
used by market_data, structure, signals, and the backtester.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Candle:
    """One OHLCV candle. `is_closed` is False for the live (forming) candle."""

    open_time: int          # ms epoch
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time: int = 0     # ms epoch
    quote_volume: float = 0.0
    trades: int = 0
    taker_buy_volume: float = 0.0
    is_closed: bool = True


def closed_candles(candles: list[Candle]) -> list[Candle]:
    """Return only confirmed (closed) candles — analysis never uses a live candle."""
    return [c for c in candles if c.is_closed]


def ema_series(values: list[float], period: int) -> list[float | None]:
    """EMA seeded with the first value; None until `period` values seen.

    Mirrors the Nova Signals implementation (seed = first close, k = 2/(n+1)).
    """
    if period < 1:
        raise ValueError("period must be >= 1")
    k = 2.0 / (period + 1)
    out: list[float | None] = [None] * len(values)
    e: float | None = None
    for i, v in enumerate(values):
        e = v if e is None else v * k + e * (1 - k)
        if i >= period - 1:
            out[i] = e
    return out


def ema_last(values: list[float], period: int) -> float | None:
    s = ema_series(values, period)
    return s[-1] if s else None


def sma(values: list[float], period: int) -> float | None:
    if len(values) < period or period < 1:
        return None
    return sum(values[-period:]) / period


def rsi(closes: list[float], period: int = 14) -> float:
    """Wilder's smoothed RSI. Returns 50 when there is not enough data."""
    if len(closes) < period + 1:
        return 50.0
    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for g, l in zip(gains[period:], losses[period:]):
        avg_gain = (avg_gain * (period - 1) + g) / period
        avg_loss = (avg_loss * (period - 1) + l) / period
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    """MACD line / signal / histogram (latest values)."""
    e_fast = ema_series(closes, fast)
    e_slow = ema_series(closes, slow)
    line = [
        (a - b) if (a is not None and b is not None) else None
        for a, b in zip(e_fast, e_slow)
    ]
    valid = [v for v in line if v is not None]
    sig_series = ema_series(valid, signal) if valid else []
    last = line[-1] if line else None
    prev = line[-2] if len(line) >= 2 else None
    sig = sig_series[-1] if sig_series else None
    prev_sig = sig_series[-2] if len(sig_series) >= 2 else None
    hist = (last - sig) if (last is not None and sig is not None) else 0.0
    hist_prev = (prev - prev_sig) if (prev is not None and prev_sig is not None) else 0.0
    return {"line": last or 0.0, "signal": sig or 0.0, "hist": hist, "hist_prev": hist_prev}


def _true_range(c: Candle, prev_close: float) -> float:
    return max(c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close))


def atr(candles: list[Candle], period: int = 14) -> float | None:
    """Wilder's smoothed ATR(14). None when there is not enough data."""
    if len(candles) < period + 1:
        return None
    trs = [_true_range(candles[i], candles[i - 1].close) for i in range(1, len(candles))]
    a = sum(trs[:period]) / period
    for tr in trs[period:]:
        a = (a * (period - 1) + tr) / period
    return a


def bollinger(closes: list[float], period: int = 20, mult: float = 2.0) -> dict | None:
    if len(closes) < period:
        return None
    window = closes[-period:]
    mid = sum(window) / period
    var = sum((x - mid) ** 2 for x in window) / period
    sd = math.sqrt(var)
    return {"mid": mid, "upper": mid + mult * sd, "lower": mid - mult * sd, "sd": sd}


def adx(candles: list[Candle], period: int = 14) -> float:
    """Wilder's ADX (trend strength 0-100). Returns 20 when data is insufficient."""
    if len(candles) < period * 2 + 1:
        return 20.0
    trs: list[float] = []
    plus_dm: list[float] = []
    minus_dm: list[float] = []
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        trs.append(_true_range(c, p.close))
        up, dn = c.high - p.high, p.low - c.low
        plus_dm.append(up if (up > dn and up > 0) else 0.0)
        minus_dm.append(dn if (dn > up and dn > 0) else 0.0)
    tr = sum(trs[:period])
    pdm = sum(plus_dm[:period])
    mdm = sum(minus_dm[:period])
    dxs: list[float] = []

    def _dx(tr_v: float, p_v: float, m_v: float) -> float:
        if tr_v == 0:
            return 0.0
        di_p, di_m = 100.0 * p_v / tr_v, 100.0 * m_v / tr_v
        return 0.0 if di_p + di_m == 0 else 100.0 * abs(di_p - di_m) / (di_p + di_m)

    dxs.append(_dx(tr, pdm, mdm))
    for i in range(period, len(trs)):
        tr = tr - tr / period + trs[i]
        pdm = pdm - pdm / period + plus_dm[i]
        mdm = mdm - mdm / period + minus_dm[i]
        dxs.append(_dx(tr, pdm, mdm))
    if len(dxs) < period:
        return float(sum(dxs) / len(dxs)) if dxs else 20.0
    a = sum(dxs[:period]) / period
    for d in dxs[period:]:
        a = (a * (period - 1) + d) / period
    return max(0.0, min(100.0, a))


def vwap(candles: list[Candle]) -> float | None:
    """Session VWAP from typical price x volume (over the candles given)."""
    pv = 0.0
    vol = 0.0
    for c in candles:
        tp = (c.high + c.low + c.close) / 3.0
        pv += tp * c.volume
        vol += c.volume
    return (pv / vol) if vol > 0 else None


def relative_volume(candles: list[Candle], period: int = 20) -> float:
    """Last closed candle volume / average of the previous `period` volumes."""
    if len(candles) < 2:
        return 1.0
    prev = candles[:-1]
    avg = sma([c.volume for c in prev], period)
    if not avg:
        return 1.0
    return candles[-1].volume / avg


def ema_stack_bullish(closes: list[float]) -> int:
    """Count of bullish EMA-stack conditions (price>9, 9>21, 21>50, 50>200)."""
    price = closes[-1]
    e9, e21, e50, e200 = (ema_last(closes, p) for p in (9, 21, 50, 200))
    checks = [
        e9 is not None and price > e9,
        e9 is not None and e21 is not None and e9 > e21,
        e21 is not None and e50 is not None and e21 > e50,
        e50 is not None and e200 is not None and e50 > e200,
    ]
    return sum(1 for c in checks if c)


def ema_stack_bearish(closes: list[float]) -> int:
    price = closes[-1]
    e9, e21, e50, e200 = (ema_last(closes, p) for p in (9, 21, 50, 200))
    checks = [
        e9 is not None and price < e9,
        e9 is not None and e21 is not None and e9 < e21,
        e21 is not None and e50 is not None and e21 < e50,
        e50 is not None and e200 is not None and e50 < e200,
    ]
    return sum(1 for c in checks if c)
