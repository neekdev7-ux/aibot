"""Analytics computed from STORED paper trades only — never from simulated
or invented history. Win rate counts wins / closed trades only; open trades
are excluded from every win-rate / profit-factor figure.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timezone


def _is_closed(trade: dict) -> bool:
    return trade.get("status") in ("CLOSED", "COOLDOWN", "RE_ENTRY") \
        and trade.get("closed_at") is not None


def _is_win(trade: dict) -> bool:
    r = trade.get("realized_r")
    return r is not None and r > 0


def compute_metrics(trades: list[dict]) -> dict:
    """Overall metrics from stored trades (closed trades only for rates)."""
    closed = [t for t in trades if _is_closed(t)]
    live = [t for t in trades if not _is_closed(t)]
    if not closed:
        return {"closed_trades": 0, "live_trades": len(live), "win_rate": None,
                "profit_factor": None, "expectancy_r": None, "avg_r": None,
                "avg_win_r": None, "avg_loss_r": None, "max_drawdown_r": None,
                "total_realized_r": 0.0}
    wins = [t for t in closed if _is_win(t)]
    losses = [t for t in closed if not _is_win(t)]
    rs = [t["realized_r"] for t in closed if t.get("realized_r") is not None]
    gross_win = sum(t["realized_r"] for t in wins if t.get("realized_r") is not None)
    gross_loss = abs(sum(t["realized_r"] for t in losses if t.get("realized_r") is not None))
    pf = gross_win / gross_loss if gross_loss > 0 else (math.inf if gross_win > 0 else None)
    # Max drawdown on the equity curve of realized R, in chronological order.
    ordered = sorted(closed, key=lambda t: t.get("closed_at") or "")
    equity = peak = max_dd = 0.0
    for t in ordered:
        equity += t.get("realized_r") or 0.0
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
    return {
        "closed_trades": len(closed),
        "live_trades": len(live),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": len(wins) / len(closed),
        "profit_factor": pf,
        "expectancy_r": sum(rs) / len(rs) if rs else None,
        "avg_r": sum(rs) / len(rs) if rs else None,
        "avg_win_r": (sum(t["realized_r"] for t in wins if t.get("realized_r") is not None)
                      / len(wins)) if wins else None,
        "avg_loss_r": (sum(t["realized_r"] for t in losses if t.get("realized_r") is not None)
                       / len(losses)) if losses else None,
        "max_drawdown_r": max_dd,
        "total_realized_r": sum(rs),
    }


def _bucket_metrics(trades: list[dict], key_fn) -> dict[str, dict]:
    buckets: dict[str, list[dict]] = defaultdict(list)
    for t in trades:
        buckets[key_fn(t)].append(t)
    return {k: compute_metrics(v) for k, v in sorted(buckets.items())}


def breakdowns(trades: list[dict]) -> dict:
    """Per-direction, per-coin, per-timeframe, and monthly breakdowns."""
    def _month(t: dict) -> str:
        ts = t.get("closed_at") or t.get("created_at") or ""
        return str(ts)[:7] if ts else "unknown"

    return {
        "by_direction": _bucket_metrics(trades, lambda t: t.get("direction", "UNKNOWN")),
        "by_coin": _bucket_metrics(trades, lambda t: t.get("symbol", "UNKNOWN")),
        "by_timeframe": _bucket_metrics(
            trades, lambda t: (t.get("timeframe") or "15m")),
        "by_month": _bucket_metrics(trades, _month),
    }


def full_report(trades: list[dict]) -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "overall": compute_metrics(trades),
        **breakdowns(trades),
    }
