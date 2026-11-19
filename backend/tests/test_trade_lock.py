"""Trade state-machine tests against the in-memory store.
No network, no live Postgres. Async code is driven via asyncio.run so no
pytest-asyncio dependency is needed."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.trade_lock import (DuplicateLiveTradeError, InMemoryTradeStore,
                            InvalidTransitionError, LevelsLockedError,
                            TradeLockManager, TradeStatus)


def run(coro):
    return asyncio.run(coro)


def make_manager(**kwargs):
    return TradeLockManager(InMemoryTradeStore(), cooldown_minutes=30, **kwargs)


async def _live_trade(tm, symbol="BTCUSDT", direction="LONG"):
    """Drive a trade to ACTIVE: entry 100, SL 95, TP1 110 (2R), TP2 117.5 (3.5R)."""
    t = await tm.create_setup(symbol, direction)
    await tm.confirm_signal(t)
    await tm.lock_entry(t, entry=100.0, sl=95.0, tp1=110.0, tp2=117.5,
                        size_qty=1.0)
    await tm.activate(t)
    return t


def test_full_lifecycle_tp1_partial_then_tp2():
    tm = make_manager()

    async def _run():
        t = await _live_trade(tm)
        assert t.status == TradeStatus.ACTIVE
        # TP1 touch: 50% banks 2R x 50% = 1.0R; SL moves to breakeven.
        changed = await tm.on_price(t.id, 110.0)
        assert changed is not None and changed.tp1_hit is True
        assert changed.tp1_partial_pct == 50.0
        assert changed.stop_loss == 100.0  # breakeven
        assert changed.realized_r == pytest.approx(1.0)
        assert changed.status == TradeStatus.ACTIVE
        # TP2 touch on the remainder: 3.5R x 50% = 1.75R -> total 2.75R.
        closed = await tm.on_price(t.id, 117.5)
        assert closed.status == TradeStatus.CLOSED
        assert closed.exit_reason == "TP2"
        assert closed.realized_r == pytest.approx(2.75)
        assert closed.exit_price == 117.5
        return closed

    closed = run(_run())
    assert closed.closed_at is not None


def test_sl_hit_closes_at_minus_1r():
    tm = make_manager()

    async def _run():
        t = await _live_trade(tm)
        closed = await tm.on_price(t.id, 94.0)
        assert closed.status == TradeStatus.CLOSED
        assert closed.exit_reason == "SL"
        assert closed.realized_r == pytest.approx(-1.0)
        return closed

    run(_run())


def test_sl_wins_on_same_tick_ambiguity():
    # Overlapping levels (TP1 at 94, SL at 95): a 94 tick touches both —
    # the state machine must record SL, never TP1.
    tm = make_manager()

    async def _run():
        t = await tm.create_setup("BTCUSDT", "LONG")
        await tm.confirm_signal(t)
        await tm.lock_entry(t, entry=100.0, sl=95.0, tp1=94.0, tp2=90.0,
                            size_qty=1.0)
        await tm.activate(t)
        assert tm._hit(t, 94.0) == "SL"
        closed = await tm.on_price(t.id, 94.0)
        assert closed.exit_reason == "SL"

    run(_run())


def test_no_duplicate_live_trade_per_coin_and_direction():
    tm = make_manager()

    async def _run():
        await _live_trade(tm)
        with pytest.raises(DuplicateLiveTradeError):
            await tm.create_setup("BTCUSDT", "LONG")
        # Opposite direction is allowed.
        other = await tm.create_setup("BTCUSDT", "SHORT")
        assert other.status == TradeStatus.SETUP

    run(_run())


def test_invalid_transition_rejected():
    tm = make_manager()

    async def _run():
        t = await tm.create_setup("BTCUSDT", "LONG")
        with pytest.raises(InvalidTransitionError):
            await tm.activate(t)  # SETUP -> ACTIVE is not a legal edge
        with pytest.raises(InvalidTransitionError):
            await tm.start_cooldown(t)  # SETUP -> COOLDOWN is not a legal edge

    run(_run())


def test_levels_immutable_once_locked():
    tm = make_manager()

    async def _run():
        t = await _live_trade(tm)
        with pytest.raises(LevelsLockedError):
            t.set_levels(101.0, 96.0, 111.0, 118.0)
        assert t.entry_price == 100.0

    run(_run())


def test_cooldown_then_reentry():
    tm = make_manager()

    async def _run():
        t = await _live_trade(tm)
        await tm.on_price(t.id, 94.0)  # SL -> CLOSED
        cooled = await tm.start_cooldown(t)
        assert cooled.status == TradeStatus.COOLDOWN
        assert cooled.cooldown_until is not None
        assert await tm.is_in_cooldown("BTCUSDT", "LONG") is True
        with pytest.raises(InvalidTransitionError):
            await tm.re_entry(t)  # cooldown has not elapsed
        # Fast-forward past the cooldown.
        t.cooldown_until = datetime.now(timezone.utc) - timedelta(seconds=1)
        await tm.store.save(t)
        re = await tm.re_entry(t)
        assert re.status == TradeStatus.RE_ENTRY
        back = await tm._transition(re, TradeStatus.SETUP)
        assert back.status == TradeStatus.SETUP

    run(_run())


def test_manual_close_of_setup_trade():
    tm = make_manager()

    async def _run():
        t = await tm.create_setup("ETHUSDT", "SHORT")
        closed = await tm.close_manual(t.id, 3000.0)
        assert closed.status == TradeStatus.CLOSED
        assert closed.realized_r is None  # never entered, no R

    run(_run())


def test_restart_recovery_returns_live_trades():
    tm = make_manager()

    async def _run():
        live = await _live_trade(tm, "BTCUSDT", "LONG")
        live2 = await _live_trade(tm, "ETHUSDT", "SHORT")
        done = await _live_trade(tm, "SOLUSDT", "LONG")
        await tm.on_price(done.id, 94.0)  # closed
        recovered = await tm.recover_active()
        assert {t.id for t in recovered} == {live.id, live2.id}
        assert len(recovered) == 2

    run(_run())


def test_price_tick_on_non_active_trade_is_noop():
    tm = make_manager()

    async def _run():
        t = await tm.create_setup("BTCUSDT", "LONG")
        assert await tm.on_price(t.id, 50.0) is None
        assert await tm.on_price("nonexistent-id", 50.0) is None

    run(_run())


def test_audit_log_records_transitions():
    store = InMemoryTradeStore()
    tm = TradeLockManager(store)

    async def _run():
        t = await _live_trade(tm)
        await tm.on_price(t.id, 110.0)  # TP1 partial
        kinds = [e["event_type"] for e in store.events]
        assert "TRANSITION" in kinds
        assert "TP1_HIT" in kinds
        assert all(e["trade_id"] == t.id for e in store.events)

    run(_run())
