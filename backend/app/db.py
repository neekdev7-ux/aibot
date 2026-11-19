"""Database (SQLAlchemy async) + Redis helpers.

Postgres is canonical (see schema.sql); `init_db` creates tables from the
SQLAlchemy metadata as a dev convenience. Redis is optional — the cache
helper returns None when Redis is unreachable instead of crashing startup.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncGenerator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import (AsyncSession, async_sessionmaker,
                                    create_async_engine)
from sqlalchemy.orm import DeclarativeBase

from .config import Settings, settings
from .trade_lock import LIVE_STATUSES, PaperTrade, TradeStatus

log = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine(cfg: Settings | None = None):
    global _engine
    if _engine is None:
        cfg = cfg or settings
        _engine = create_async_engine(cfg.database_url, pool_pre_ping=True,
                                      pool_size=5, max_overflow=10)
    return _engine


def get_session_factory(cfg: Settings | None = None) -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(get_engine(cfg), expire_on_commit=False)
    return _session_factory


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    factory = get_session_factory()
    async with factory() as session:
        yield session


async def init_db(cfg: Settings | None = None) -> None:
    """Create tables from models metadata (dev convenience; schema.sql is
    canonical for production deploys)."""
    from . import models  # noqa: F401  (registers models on Base)
    engine = get_engine(cfg)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def check_db() -> dict:
    try:
        from sqlalchemy import text
        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "detail": str(e)[:200]}


# --- Redis ---------------------------------------------------------------------
_redis_client = None


async def get_redis(cfg: Settings | None = None):
    """Lazy Redis client; returns None when Redis is unavailable."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    try:
        import redis.asyncio as aioredis
        cfg = cfg or settings
        client = aioredis.from_url(cfg.redis_url, decode_responses=True)
        await client.ping()
        _redis_client = client
        return client
    except Exception as e:
        log.warning("Redis unavailable: %s", e)
        return None


async def check_redis() -> dict:
    client = await get_redis()
    if client is None:
        return {"status": "error", "detail": "unreachable"}
    try:
        await client.ping()
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "detail": str(e)[:200]}


# --- Postgres trade store ---------------------------------------------------------
class PostgresTradeStore:
    """TradeStore backed by Postgres. `get_for_update` uses SELECT ... FOR
    UPDATE so concurrent price ticks cannot process the same trade twice.
    The unique partial index in schema.sql is the second line of defence
    against duplicate live trades."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession] | None = None):
        self.session_factory = session_factory or get_session_factory()

    @staticmethod
    def _to_row(trade: PaperTrade):
        from .models import PaperTradeRow
        return PaperTradeRow(
            id=uuid.UUID(trade.id),
            signal_id=uuid.UUID(trade.signal_id) if trade.signal_id else None,
            symbol=trade.symbol,
            direction=trade.direction, status=trade.status.value,
            entry_price=trade.entry_price, stop_loss=trade.stop_loss,
            take_profit_1=trade.take_profit_1, take_profit_2=trade.take_profit_2,
            size_qty=trade.size_qty, risk_per_unit=trade.risk_per_unit,
            tp1_hit=trade.tp1_hit, tp1_partial_pct=trade.tp1_partial_pct,
            exit_price=trade.exit_price, exit_reason=trade.exit_reason,
            realized_r=trade.realized_r, realized_pnl=trade.realized_pnl,
            fees_paid=trade.fees_paid, funding_paid=trade.funding_paid,
            opened_at=trade.opened_at, closed_at=trade.closed_at,
            cooldown_until=trade.cooldown_until,
        )

    @staticmethod
    def _from_row(row) -> PaperTrade:
        return PaperTrade(
            id=str(row.id), signal_id=str(row.signal_id) if row.signal_id else None,
            symbol=row.symbol, direction=row.direction,
            status=TradeStatus(row.status),
            entry_price=float(row.entry_price) if row.entry_price is not None else None,
            stop_loss=float(row.stop_loss) if row.stop_loss is not None else None,
            take_profit_1=float(row.take_profit_1) if row.take_profit_1 is not None else None,
            take_profit_2=float(row.take_profit_2) if row.take_profit_2 is not None else None,
            size_qty=float(row.size_qty or 0),
            risk_per_unit=float(row.risk_per_unit) if row.risk_per_unit is not None else None,
            tp1_hit=row.tp1_hit, tp1_partial_pct=float(row.tp1_partial_pct or 0),
            exit_price=float(row.exit_price) if row.exit_price is not None else None,
            exit_reason=row.exit_reason,
            realized_r=float(row.realized_r) if row.realized_r is not None else None,
            realized_pnl=float(row.realized_pnl) if row.realized_pnl is not None else None,
            fees_paid=float(row.fees_paid or 0),
            funding_paid=float(row.funding_paid or 0),
            opened_at=row.opened_at, closed_at=row.closed_at,
            cooldown_until=row.cooldown_until,
            created_at=row.created_at, updated_at=row.updated_at,
        )

    async def save(self, trade: PaperTrade) -> None:
        from .models import PaperTradeRow
        async with self.session_factory() as session:
            row = await session.get(PaperTradeRow, uuid.UUID(trade.id))
            if row is None:
                session.add(self._to_row(trade))
            else:
                new = self._to_row(trade)
                for col in ("signal_id", "symbol", "direction", "status",
                            "entry_price", "stop_loss", "take_profit_1",
                            "take_profit_2", "size_qty", "risk_per_unit",
                            "tp1_hit", "tp1_partial_pct", "exit_price",
                            "exit_reason", "realized_r", "realized_pnl",
                            "fees_paid", "funding_paid", "opened_at",
                            "closed_at", "cooldown_until"):
                    setattr(row, col, getattr(new, col))
            await session.commit()

    async def get(self, trade_id: str) -> PaperTrade | None:
        from .models import PaperTradeRow
        async with self.session_factory() as session:
            row = await session.get(PaperTradeRow, uuid.UUID(trade_id))
            return self._from_row(row) if row else None

    async def get_for_update(self, trade_id: str) -> PaperTrade | None:
        """Row-level lock: concurrent ticks serialise on the trade row."""
        from .models import PaperTradeRow
        async with self.session_factory() as session:
            async with session.begin():
                stmt = (select(PaperTradeRow)
                        .where(PaperTradeRow.id == uuid.UUID(trade_id))
                        .with_for_update())
                row = (await session.execute(stmt)).scalar_one_or_none()
                return self._from_row(row) if row else None

    async def has_live(self, symbol: str, direction: str) -> bool:
        from .models import PaperTradeRow
        async with self.session_factory() as session:
            stmt = (select(PaperTradeRow.id)
                    .where(PaperTradeRow.symbol == symbol,
                           PaperTradeRow.direction == direction,
                           PaperTradeRow.status.in_([s.value for s in LIVE_STATUSES]))
                    .limit(1))
            return (await session.execute(stmt)).scalar_one_or_none() is not None

    async def list_live(self) -> list[PaperTrade]:
        from .models import PaperTradeRow
        async with self.session_factory() as session:
            stmt = (select(PaperTradeRow)
                    .where(PaperTradeRow.status.in_([s.value for s in LIVE_STATUSES]))
                    .order_by(PaperTradeRow.created_at))
            rows = (await session.execute(stmt)).scalars().all()
            return [self._from_row(r) for r in rows]

    async def list_all(self, limit: int = 100) -> list[PaperTrade]:
        from .models import PaperTradeRow
        async with self.session_factory() as session:
            stmt = (select(PaperTradeRow)
                    .order_by(PaperTradeRow.created_at.desc())
                    .limit(limit))
            rows = (await session.execute(stmt)).scalars().all()
            return [self._from_row(r) for r in rows]

    async def log_event(self, trade_id: str, event_type: str,
                        from_status: str | None, to_status: str | None,
                        detail: dict | None = None) -> None:
        from .models import TradeEventRow
        async with self.session_factory() as session:
            session.add(TradeEventRow(
                trade_id=uuid.UUID(trade_id), event_type=event_type,
                from_status=from_status, to_status=to_status,
                detail=detail or {}))
            await session.commit()
