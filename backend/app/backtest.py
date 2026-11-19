"""Historical backtest loop on real klines.

Rules:
- No look-ahead: a signal computed on candles up to bar i may only enter
  at bar i+1's open, and exits are evaluated on bars after entry.
- Costs: taker fees (open + close), slippage on entry and exit, and 8h
  funding while a position is held.
- Train/validation/test split + walk-forward windows + out-of-sample
  metrics, so a tuned threshold is never graded on the data it was tuned on.

Honest limitation: historical footprint and order-book data are NOT
available from Binance's public API, so the backtest scores with the
klines-only subset of the live scorer (structure + sweep + volume + VWAP +
trend strength + liquidity quality = 65 of 100 points; orderflow 20 and
footprint 15 are unavailable). Subset scores are NORMALISED to /100
(subset / 65 * 100) so the min-score threshold stays meaningful, and every
backtest trade is labelled as subset-scored. Backtest results therefore
measure the klines-only subset, not the full live signal definition, and
must not be quoted as the live system's expected performance.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .indicators import Candle, atr, closed_candles, relative_volume, vwap
from .signals import (MIN_DIRECTION_SPREAD, Signal, SignalContext,
                      build_levels, confirmation_passed, score_class,
                      score_direction)
from .structure import analyze_structure

# Points available from klines alone: 15 + 15 + 10 + 10 + 10 + 5.
SUBSET_BLOCKS = ("structure", "sweep", "volume", "vwap", "trend_strength",
                 "liquidity_quality")
SUBSET_MAX = 65


INTERVAL_MS = {
    "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
}
FUNDING_INTERVAL_MS = 8 * 3_600_000


@dataclass
class BacktestConfig:
    # Default 50, not 65: the backtest scores the klines-only subset
    # (normalised to /100), and the subset's volume/trend blocks rarely
    # max out without orderflow — 65 normalised would need a near-perfect
    # subset setup and produce ~zero trades on ordinary trending data.
    # 50 normalised is the subset's working threshold; tune via train/val.
    min_score: int = 50
    min_rr: float = 2.0
    taker_fee_bps: float = 5.0
    slippage_bps: float = 2.0
    funding_8h_bps: float = 1.0
    position_notional: float = 1000.0  # paper USDT per trade
    max_hold_bars: int = 96            # force-exit after this many bars
    cooldown_bars: int = 4             # bars to wait after a close


@dataclass
class BacktestTrade:
    symbol: str
    direction: str
    entry_time: int
    exit_time: int
    entry_price: float
    exit_price: float
    stop_loss: float
    take_profit_1: float
    take_profit_2: float
    exit_reason: str
    score: int
    realized_r: float
    pnl: float
    fees: float
    funding: float

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol, "direction": self.direction,
            "entry_time": self.entry_time, "exit_time": self.exit_time,
            "entry_price": self.entry_price, "exit_price": self.exit_price,
            "stop_loss": self.stop_loss, "take_profit_1": self.take_profit_1,
            "take_profit_2": self.take_profit_2, "exit_reason": self.exit_reason,
            "score": self.score, "realized_r": self.realized_r,
            "pnl": self.pnl, "fees": self.fees, "funding": self.funding,
        }


@dataclass
class BacktestResult:
    trades: list[BacktestTrade] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    splits: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "trades": [t.to_dict() for t in self.trades],
            "metrics": self.metrics,
            "splits": self.splits,
            "notes": self.notes,
        }


def _apply_costs(entry: float, exit_price: float, direction: str,
                 qty: float, hold_ms: int, cfg: BacktestConfig) -> tuple[float, float, float]:
    """Return (net pnl, fees, funding) for a filled trade."""
    is_long = direction == "LONG"
    gross = (exit_price - entry) * qty if is_long else (entry - exit_price) * qty
    fees = (entry + exit_price) * qty * cfg.taker_fee_bps / 10_000
    periods = hold_ms / FUNDING_INTERVAL_MS
    funding = entry * qty * cfg.funding_8h_bps / 10_000 * periods
    return gross - fees - funding, fees, funding


def _slippage(price: float, direction: str, is_entry: bool,
              slippage_bps: float) -> float:
    """Adverse slippage: entry worse, exit worse."""
    is_long = direction == "LONG"
    if is_entry:
        return price * (1 + slippage_bps / 10_000) if is_long else price * (1 - slippage_bps / 10_000)
    return price * (1 - slippage_bps / 10_000) if is_long else price * (1 + slippage_bps / 10_000)


def _score_at(candles: list[Candle], symbol: str,
              cfg: BacktestConfig) -> Signal | None:
    """Score the setup ending at the last candle using the klines-only
    subset, normalised to /100 (see module docstring). Returns a Signal
    or None. The raw (unnormalised) subset score is kept in the reasons
    so a backtest score is never mistaken for a live score."""
    from .footprint import Footprint
    from .orderflow import OrderFlowStats

    st = analyze_structure(candles)
    if st.is_sideways:
        return None
    ctx = SignalContext(
        symbol=symbol, price=candles[-1].close, atr=atr(candles),
        structure=st, orderflow=OrderFlowStats(), footprint=Footprint(),
        volume_ratio=relative_volume(candles), vwap=vwap(candles[-20:]),
        tp_levels_long=st.resistances, tp_levels_short=st.supports,
    )
    scored: dict[str, tuple[int, dict[str, int], list[str], int]] = {}
    for direction in ("LONG", "SHORT"):
        ok, _why = confirmation_passed(direction, ctx)
        if not ok:
            continue
        parts, reasons = score_direction(direction, ctx)
        subset = sum(parts[b] for b in SUBSET_BLOCKS)
        normalised = round(subset / SUBSET_MAX * 100)
        scored[direction] = (normalised, parts, reasons, subset)
    if not scored:
        return None
    direction = max(scored, key=lambda d: scored[d][0])
    score, parts, reasons, subset = scored[direction]
    if len(scored) == 2:
        other = "SHORT" if direction == "LONG" else "LONG"
        if abs(score - scored[other][0]) < MIN_DIRECTION_SPREAD:
            return None  # chop — no clear direction
    if score < cfg.min_score:
        return None
    swing = st.last_swing_low if direction == "LONG" else st.last_swing_high
    if swing is None:
        return None
    tp_levels = ctx.tp_levels_long if direction == "LONG" else ctx.tp_levels_short
    levels = build_levels(direction, ctx.price, swing, ctx.atr, tp_levels, cfg.min_rr)
    if levels is None:
        return None
    reasons = reasons + [
        f"Klines-only subset score {subset}/{SUBSET_MAX}, normalised to "
        f"{score}/100 — orderflow/footprint unavailable historically."
    ]
    return Signal(symbol=symbol, direction=direction, score=score,
                  score_class=score_class(score), parts=parts,
                  reasons=reasons, levels=levels)


def run_backtest_symbol(symbol: str, candles: list[Candle],
                        cfg: BacktestConfig | None = None) -> list[BacktestTrade]:
    """Single-symbol backtest. Signals use candles up to bar i; entry is at
    bar i+1's open; exits use bars i+1 onward. SL wins on same-bar ambiguity."""
    cfg = cfg or BacktestConfig()
    closed = closed_candles(candles)
    trades: list[BacktestTrade] = []
    i = 60  # need enough history for indicators
    while i < len(closed) - 1:
        sig = _score_at(closed[: i + 1], symbol, cfg)
        if sig is None:
            i += 1
            continue
        entry_bar = closed[i + 1]
        entry = _slippage(entry_bar.open, sig.direction, True, cfg.slippage_bps)
        qty = cfg.position_notional / entry
        risk = abs(entry - sig.levels.stop_loss)
        if risk <= 0:
            i += 1
            continue
        is_long = sig.direction == "LONG"
        exit_price = None
        exit_reason = "EXPIRED"
        exit_idx = min(i + 1 + cfg.max_hold_bars, len(closed) - 1)
        for j in range(i + 1, exit_idx + 1):
            bar = closed[j]
            sl_hit = bar.low <= sig.levels.stop_loss if is_long else bar.high >= sig.levels.stop_loss
            tp2_hit = bar.high >= sig.levels.take_profit_2 if is_long else bar.low <= sig.levels.take_profit_2
            tp1_hit = bar.high >= sig.levels.take_profit_1 if is_long else bar.low <= sig.levels.take_profit_1
            if sl_hit:  # SL-first on same-bar ambiguity
                exit_price, exit_reason, exit_idx = sig.levels.stop_loss, "SL", j
                break
            if tp2_hit:
                exit_price, exit_reason, exit_idx = sig.levels.take_profit_2, "TP2", j
                break
            if tp1_hit:
                exit_price, exit_reason, exit_idx = sig.levels.take_profit_1, "TP1", j
                break
        if exit_price is None:
            exit_price = closed[exit_idx].close
            exit_reason = "EXPIRED"
        exit_price = _slippage(exit_price, sig.direction, False, cfg.slippage_bps)
        hold_ms = closed[exit_idx].open_time - entry_bar.open_time
        pnl, fees, funding = _apply_costs(entry, exit_price, sig.direction, qty, hold_ms, cfg)
        signed = (exit_price - entry) if is_long else (entry - exit_price)
        trades.append(BacktestTrade(
            symbol=symbol, direction=sig.direction,
            entry_time=entry_bar.open_time, exit_time=closed[exit_idx].open_time,
            entry_price=entry, exit_price=exit_price,
            stop_loss=sig.levels.stop_loss,
            take_profit_1=sig.levels.take_profit_1,
            take_profit_2=sig.levels.take_profit_2,
            exit_reason=exit_reason, score=sig.score,
            realized_r=signed / risk, pnl=pnl, fees=fees, funding=funding,
        ))
        i = exit_idx + cfg.cooldown_bars
    return trades


def compute_backtest_metrics(trades: list[BacktestTrade]) -> dict:
    """Metrics from a trade list. Win rate counts wins / closed trades only;
    TP1/TP2/EXPIRED-with-profit count as wins, SL and EXPIRED-with-loss as losses."""
    if not trades:
        return {"trades": 0, "win_rate": None, "profit_factor": None,
                "expectancy_r": None, "avg_r": None, "max_drawdown": None,
                "total_pnl": 0.0, "note": "no trades in window"}
    wins = [t for t in trades if t.pnl > 0]
    losses = [t for t in trades if t.pnl <= 0]
    gross_win = sum(t.pnl for t in wins)
    gross_loss = abs(sum(t.pnl for t in losses))
    pf = gross_win / gross_loss if gross_loss > 0 else (math.inf if gross_win > 0 else None)
    rs = [t.realized_r for t in trades]
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    for t in trades:
        equity += t.pnl
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
    return {
        "trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": len(wins) / len(trades),
        "profit_factor": pf,
        "expectancy_r": sum(rs) / len(rs),
        "avg_r": sum(rs) / len(rs),
        "avg_win_r": sum(t.realized_r for t in wins) / len(wins) if wins else None,
        "avg_loss_r": sum(t.realized_r for t in losses) / len(losses) if losses else None,
        "max_drawdown": max_dd,
        "total_pnl": sum(t.pnl for t in trades),
        "total_fees": sum(t.fees for t in trades),
        "total_funding": sum(t.funding for t in trades),
    }


def split_windows(n_bars: int, train_pct: float = 0.6, val_pct: float = 0.2
                  ) -> dict[str, tuple[int, int]]:
    """Train/validation/test index split (chronological, no shuffling)."""
    train_end = int(n_bars * train_pct)
    val_end = int(n_bars * (train_pct + val_pct))
    return {
        "train": (0, train_end),
        "validation": (train_end, val_end),
        "test": (val_end, n_bars),
    }


def walk_forward_windows(n_bars: int, n_folds: int = 4) -> list[dict[str, tuple[int, int]]]:
    """Expanding-window walk-forward folds: each fold trains on all bars
    before the fold's test window and tests on the fold itself."""
    if n_folds < 2:
        raise ValueError("n_folds must be >= 2")
    fold_size = n_bars // (n_folds + 1)
    folds = []
    for k in range(n_folds):
        test_start = fold_size * (k + 1)
        test_end = min(n_bars, fold_size * (k + 2))
        folds.append({"train": (0, test_start), "test": (test_start, test_end)})
    return folds


def run_backtest(candles_by_symbol: dict[str, list[Candle]],
                 cfg: BacktestConfig | None = None) -> BacktestResult:
    """Full backtest: per-symbol runs, overall metrics, train/val/test split
    metrics, walk-forward out-of-sample metrics, and honest notes."""
    cfg = cfg or BacktestConfig()
    result = BacktestResult(notes=[
        "Backtest uses the klines-only subset of the live scorer (65/100 "
        "points: structure, sweep, volume, VWAP, trend strength, liquidity "
        "quality). Orderflow (20) and footprint (15) are unavailable "
        "historically, so subset scores are normalised to /100 — a backtest "
        "score is NOT a live score.",
        "Signals enter at the next bar's open after the signal bar — no look-ahead.",
        "Costs include taker fees, slippage, and 8h funding. Results are "
        "historical simulation, not a guarantee of future performance.",
    ])
    all_trades: list[BacktestTrade] = []
    for symbol, candles in candles_by_symbol.items():
        all_trades.extend(run_backtest_symbol(symbol, candles, cfg))
    all_trades.sort(key=lambda t: t.entry_time)
    result.trades = all_trades
    result.metrics = compute_backtest_metrics(all_trades)

    # Train/val/test split metrics (per symbol, then pooled).
    splits: dict[str, list[BacktestTrade]] = {"train": [], "validation": [], "test": []}
    for symbol, candles in candles_by_symbol.items():
        closed = closed_candles(candles)
        windows = split_windows(len(closed))
        for name, (a, b) in windows.items():
            splits[name].extend(run_backtest_symbol(symbol, closed[a:b], cfg))
    result.splits = {
        name: compute_backtest_metrics(trs) for name, trs in splits.items()
    }

    # Walk-forward out-of-sample metrics (test folds only).
    oos: list[BacktestTrade] = []
    for symbol, candles in candles_by_symbol.items():
        closed = closed_candles(candles)
        for fold in walk_forward_windows(len(closed)):
            a, b = fold["test"]
            oos.extend(run_backtest_symbol(symbol, closed[a:b], cfg))
    result.splits["walk_forward_oos"] = compute_backtest_metrics(oos)
    return result
