"""Paper-trade state machine with persistence.

    SCANNING -> SETUP -> SIGNAL_CONFIRMED -> ENTRY_LOCKED -> ACTIVE
    ACTIVE -> TP_SL_HIT -> CLOSED -> COOLDOWN -> RE_ENTRY (-> SETUP)

Rules enforced here (and mirrored by the DB CHECK constraint + unique
partial index):
- Locked levels (entry/SL/TP1/TP2) are immutable once ENTRY_LOCKED.
- No duplicate live trade per coin+direction (unique partial index in
  schema.sql + an app-level check before insert).
- Partial TP1: 50% closes at TP1, SL moves to breakeven on the remainder.
- Realized R is recorded on close; SL wins on same-candle TP/SL ambiguity.
- Restart-safe: ACTIVE / ENTRY_LOCKED trades are recovered from the store
  on startup via `recover_active`.
- Row-level locking (`SELECT ... FOR UPDATE`) prevents concurrent duplicate
  processing in the Postgres store; the in-memory store uses an asyncio lock.
"""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Protocol

TP1_PARTIAL_PCT = 50.0


class TradeStatus(str, Enum):
    SCANNING = "SCANNING"
    SETUP = "SETUP"
    SIGNAL_CONFIRMED = "SIGNAL_CONFIRMED"
    ENTRY_LOCKED = "ENTRY_LOCKED"
    ACTIVE = "ACTIVE"
    TP_SL_HIT = "TP_SL_HIT"
    CLOSED = "CLOSED"
    COOLDOWN = "COOLDOWN"
    RE_ENTRY = "RE_ENTRY"


ALLOWED_TRANSITIONS: dict[TradeStatus, set[TradeStatus]] = {
    TradeStatus.SCANNING: {TradeStatus.SETUP},
    TradeStatus.SETUP: {TradeStatus.SIGNAL_CONFIRMED, TradeStatus.CLOSED},
    TradeStatus.SIGNAL_CONFIRMED: {TradeStatus.ENTRY_LOCKED, TradeStatus.CLOSED},
    TradeStatus.ENTRY_LOCKED: {TradeStatus.ACTIVE, TradeStatus.CLOSED},
    TradeStatus.ACTIVE: {TradeStatus.TP_SL_HIT, TradeStatus.CLOSED},
    TradeStatus.TP_SL_HIT: {TradeStatus.CLOSED},
    TradeStatus.CLOSED: {TradeStatus.COOLDOWN},
    TradeStatus.COOLDOWN: {TradeStatus.RE_ENTRY},
    TradeStatus.RE_ENTRY: {TradeStatus.SETUP},
}

LIVE_STATUSES = frozenset({
    TradeStatus.SETUP, TradeStatus.SIGNAL_CONFIRMED, TradeStatus.ENTRY_LOCKED,
    TradeStatus.ACTIVE, TradeStatus.TP_SL_HIT,
})


class InvalidTransitionError(ValueError):
    pass


class DuplicateLiveTradeError(ValueError):
    pass


class LevelsLockedError(ValueError):
    pass


@dataclass
class PaperTrade:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    signal_id: str | None = None
    symbol: str = ""
    direction: str = "LONG"  # 'LONG' | 'SHORT'
    status: TradeStatus = TradeStatus.SCANNING
    entry_price: float | None = None
    stop_loss: float | None = None
    take_profit_1: float | None = None
    take_profit_2: float | None = None
    size_qty: float = 0.0
    risk_per_unit: float | None = None
    tp1_hit: bool = False
    tp1_partial_pct: float = 0.0
    exit_price: float | None = None
    exit_reason: str | None = None
    realized_r: float | None = None
    realized_pnl: float | None = None
    fees_paid: float = 0.0
    funding_paid: float = 0.0
    opened_at: datetime | None = None
    closed_at: datetime | None = None
    cooldown_until: datetime | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def levels_locked(self) -> bool:
        return self.status in (
            TradeStatus.ENTRY_LOCKED, TradeStatus.ACTIVE,
            TradeStatus.TP_SL_HIT, TradeStatus.CLOSED,
        )

    def set_levels(self, entry: float, sl: float, tp1: float, tp2: float) -> None:
        if self.levels_locked:
            raise LevelsLockedError(f"Trade {self.id} levels are locked ({self.status})")
        self.entry_price, self.stop_loss = entry, sl
        self.take_profit_1, self.take_profit_2 = tp1, tp2
        self.risk_per_unit = abs(entry - sl)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "signal_id": self.signal_id, "symbol": self.symbol,
            "direction": self.direction, "status": self.status.value,
            "entry_price": self.entry_price, "stop_loss": self.stop_loss,
            "take_profit_1": self.take_profit_1, "take_profit_2": self.take_profit_2,
            "size_qty": self.size_qty, "risk_per_unit": self.risk_per_unit,
            "tp1_hit": self.tp1_hit, "tp1_partial_pct": self.tp1_partial_pct,
            "exit_price": self.exit_price, "exit_reason": self.exit_reason,
            "realized_r": self.realized_r, "realized_pnl": self.realized_pnl,
            "fees_paid": self.fees_paid, "funding_paid": self.funding_paid,
            "opened_at": self.opened_at.isoformat() if self.opened_at else None,
            "closed_at": self.closed_at.isoformat() if self.closed_at else None,
            "cooldown_until": self.cooldown_until.isoformat() if self.cooldown_until else None,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class TradeStore(Protocol):
    """Persistence interface — in-memory for tests, Postgres in production."""

    async def save(self, trade: PaperTrade) -> None: ...
    async def get(self, trade_id: str) -> PaperTrade | None: ...
    async def get_for_update(self, trade_id: str) -> PaperTrade | None: ...
    async def has_live(self, symbol: str, direction: str) -> bool: ...
    async def list_live(self) -> list[PaperTrade]: ...
    async def list_all(self, limit: int = 100) -> list[PaperTrade]: ...
    async def log_event(self, trade_id: str, event_type: str,
                        from_status: str | None, to_status: str | None,
                        detail: dict | None = None) -> None: ...


class InMemoryTradeStore:
    """Thread-safe (asyncio-locked) in-memory store for tests and dev."""

    def __init__(self) -> None:
        self._trades: dict[str, PaperTrade] = {}
        self.events: list[dict] = []
        self._lock = asyncio.Lock()

    async def save(self, trade: PaperTrade) -> None:
        async with self._lock:
            trade.updated_at = datetime.now(timezone.utc)
            self._trades[trade.id] = trade

    async def get(self, trade_id: str) -> PaperTrade | None:
        return self._trades.get(trade_id)

    async def get_for_update(self, trade_id: str) -> PaperTrade | None:
        # Single-process store: the lock in save() serialises writes; a
        # production store uses SELECT ... FOR UPDATE (see PostgresTradeStore).
        return self._trades.get(trade_id)

    async def has_live(self, symbol: str, direction: str) -> bool:
        return any(
            t.symbol == symbol and t.direction == direction and t.status in LIVE_STATUSES
            for t in self._trades.values()
        )

    async def list_live(self) -> list[PaperTrade]:
        return [t for t in self._trades.values() if t.status in LIVE_STATUSES]

    async def list_all(self, limit: int = 100) -> list[PaperTrade]:
        return sorted(self._trades.values(), key=lambda t: t.created_at,
                      reverse=True)[:limit]

    async def log_event(self, trade_id: str, event_type: str,
                        from_status: str | None, to_status: str | None,
                        detail: dict | None = None) -> None:
        self.events.append({
            "trade_id": trade_id, "event_type": event_type,
            "from_status": from_status, "to_status": to_status,
            "detail": detail or {},
            "created_at": datetime.now(timezone.utc).isoformat(),
        })


class TradeLockManager:
    """State-machine operations. Every transition is validated, logged to
    the audit store, and persisted."""

    def __init__(self, store: TradeStore, cooldown_minutes: int = 30,
                 taker_fee_bps: float = 5.0):
        self.store = store
        self.cooldown_minutes = cooldown_minutes
        self.taker_fee_bps = taker_fee_bps

    async def _transition(self, trade: PaperTrade, to: TradeStatus,
                          detail: dict | None = None) -> PaperTrade:
        if to not in ALLOWED_TRANSITIONS.get(trade.status, set()):
            raise InvalidTransitionError(
                f"Cannot move trade {trade.id} {trade.status.value} -> {to.value}")
        from_status = trade.status
        trade.status = to
        await self.store.save(trade)
        await self.store.log_event(trade.id, "TRANSITION", from_status.value,
                                   to.value, detail)
        return trade

    async def create_setup(self, symbol: str, direction: str,
                           signal_id: str | None = None) -> PaperTrade:
        if await self.store.has_live(symbol, direction):
            raise DuplicateLiveTradeError(
                f"Live trade already exists for {symbol} {direction}")
        trade = PaperTrade(symbol=symbol, direction=direction,
                           signal_id=signal_id, status=TradeStatus.SCANNING)
        await self.store.save(trade)
        return await self._transition(trade, TradeStatus.SETUP)

    async def confirm_signal(self, trade: PaperTrade) -> PaperTrade:
        return await self._transition(trade, TradeStatus.SIGNAL_CONFIRMED)

    async def lock_entry(self, trade: PaperTrade, entry: float, sl: float,
                         tp1: float, tp2: float, size_qty: float) -> PaperTrade:
        """Set levels and lock them. After this call levels are immutable."""
        trade.set_levels(entry, sl, tp1, tp2)
        trade.size_qty = size_qty
        await self.store.save(trade)
        return await self._transition(trade, TradeStatus.ENTRY_LOCKED,
                                      {"entry": entry, "sl": sl, "tp1": tp1, "tp2": tp2})

    async def activate(self, trade: PaperTrade) -> PaperTrade:
        trade.opened_at = datetime.now(timezone.utc)
        await self.store.save(trade)
        return await self._transition(trade, TradeStatus.ACTIVE)

    def _hit(self, trade: PaperTrade, price: float) -> str | None:
        """Which level did `price` touch? SL wins on ambiguity (both levels
        touched in the same candle/tick batch)."""
        is_long = trade.direction == "LONG"
        sl_hit = trade.stop_loss is not None and (
            price <= trade.stop_loss if is_long else price >= trade.stop_loss)
        tp2_hit = trade.take_profit_2 is not None and (
            price >= trade.take_profit_2 if is_long else price <= trade.take_profit_2)
        tp1_hit = trade.take_profit_1 is not None and (
            price >= trade.take_profit_1 if is_long else price <= trade.take_profit_1)
        if sl_hit:
            return "SL"
        if tp2_hit:
            return "TP2"
        if tp1_hit:
            return "TP1"
        return None

    async def on_price(self, trade_id: str, price: float) -> PaperTrade | None:
        """Process a price tick for an ACTIVE trade. Returns the trade if its
        state changed, else None. Uses get_for_update to serialise ticks."""
        trade = await self.store.get_for_update(trade_id)
        if trade is None or trade.status != TradeStatus.ACTIVE:
            return None
        hit = self._hit(trade, price)
        if hit is None:
            return None
        # Fill at the LEVEL price, not the triggering tick: a stop/target
        # order fills at its level (consistent with the backtester), so a
        # clean SL close is exactly -1R and a TP1 close exactly +2R.
        level_price = {"SL": trade.stop_loss, "TP1": trade.take_profit_1,
                       "TP2": trade.take_profit_2}[hit]
        assert level_price is not None
        if hit == "TP1" and not trade.tp1_hit:
            await self._partial_tp1(trade, level_price)
            return trade
        # TP2, SL, or a second TP1 touch (remainder already running) closes it.
        return await self._close(trade, level_price, hit)

    async def _partial_tp1(self, trade: PaperTrade, price: float) -> PaperTrade:
        """Close 50% at TP1; move SL to breakeven on the remainder. The
        trade stays ACTIVE with tp1_hit set."""
        if trade.risk_per_unit and trade.risk_per_unit > 0:
            r = abs(price - (trade.entry_price or price)) / trade.risk_per_unit
            trade.realized_r = (trade.realized_r or 0.0) + r * (TP1_PARTIAL_PCT / 100)
        trade.tp1_hit = True
        trade.tp1_partial_pct = TP1_PARTIAL_PCT
        # Breakeven SL on the remainder (breakeven move is a level *update*,
        # not a re-lock: the original locked levels stay in the audit log).
        trade.stop_loss = trade.entry_price
        trade.size_qty *= (1 - TP1_PARTIAL_PCT / 100)
        await self.store.save(trade)
        await self.store.log_event(trade.id, "TP1_HIT", TradeStatus.ACTIVE.value,
                                   TradeStatus.ACTIVE.value,
                                   {"price": price, "partial_pct": TP1_PARTIAL_PCT,
                                    "sl_moved_to_breakeven": True})
        return trade

    async def _close(self, trade: PaperTrade, price: float, reason: str) -> PaperTrade:
        if trade.entry_price is not None and trade.risk_per_unit:
            is_long = trade.direction == "LONG"
            signed = (price - trade.entry_price) if is_long else (trade.entry_price - price)
            r = signed / trade.risk_per_unit
            # Remainder weight: if TP1 already banked 50%, the close applies
            # to the remaining 50%.
            weight = (1 - trade.tp1_partial_pct / 100) if trade.tp1_hit else 1.0
            trade.realized_r = (trade.realized_r or 0.0) + r * weight
            trade.realized_pnl = (trade.realized_pnl or 0.0) + signed * trade.size_qty
        notional = (trade.entry_price or 0) * trade.size_qty
        trade.fees_paid += notional * self.taker_fee_bps / 10_000 * 2  # open + close
        trade.exit_price = price
        trade.exit_reason = reason
        trade.closed_at = datetime.now(timezone.utc)
        await self.store.save(trade)
        await self._transition(trade, TradeStatus.TP_SL_HIT,
                               {"price": price, "reason": reason})
        return await self._transition(trade, TradeStatus.CLOSED,
                                      {"realized_r": trade.realized_r})

    async def close_manual(self, trade_id: str, price: float) -> PaperTrade:
        trade = await self.store.get_for_update(trade_id)
        if trade is None:
            raise ValueError(f"Unknown trade {trade_id}")
        if trade.status == TradeStatus.ACTIVE:
            return await self._close(trade, price, "MANUAL")
        if trade.status in (TradeStatus.SETUP, TradeStatus.SIGNAL_CONFIRMED,
                            TradeStatus.ENTRY_LOCKED):
            trade.closed_at = datetime.now(timezone.utc)
            await self.store.save(trade)
            return await self._transition(trade, TradeStatus.CLOSED, {"reason": "MANUAL"})
        raise InvalidTransitionError(f"Cannot manually close trade in {trade.status.value}")

    async def start_cooldown(self, trade: PaperTrade) -> PaperTrade:
        trade.cooldown_until = datetime.now(timezone.utc) + timedelta(minutes=self.cooldown_minutes)
        await self.store.save(trade)
        return await self._transition(trade, TradeStatus.COOLDOWN,
                                      {"until": trade.cooldown_until.isoformat()})

    async def re_entry(self, trade: PaperTrade) -> PaperTrade:
        """COOLDOWN -> RE_ENTRY, only after the cooldown has elapsed."""
        if trade.cooldown_until and datetime.now(timezone.utc) < trade.cooldown_until:
            raise InvalidTransitionError(
                f"Trade {trade.id} still in cooldown until {trade.cooldown_until}")
        return await self._transition(trade, TradeStatus.RE_ENTRY)

    async def recover_active(self) -> list[PaperTrade]:
        """Restart-safe recovery: return every live trade so the price-feed
        loop can resume watching it. No state is changed."""
        return await self.store.list_live()

    async def is_in_cooldown(self, symbol: str, direction: str) -> bool:
        for t in await self.store.list_all(limit=200):
            if (t.symbol == symbol and t.direction == direction
                    and t.status == TradeStatus.COOLDOWN and t.cooldown_until
                    and datetime.now(timezone.utc) < t.cooldown_until):
                return True
        return False
