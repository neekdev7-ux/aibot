"""SQLAlchemy models matching schema.sql (PostgreSQL).

Table names and constraints mirror schema.sql; schema.sql is canonical for
production deploys, these models are the ORM view used by the app.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (JSON, Boolean, CheckConstraint, DateTime, ForeignKey,
                        Index, Integer, Numeric, Text)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class SymbolRow(Base):
    __tablename__ = "symbols"

    symbol: Mapped[str] = mapped_column(Text, primary_key=True)
    base_asset: Mapped[str] = mapped_column(Text, nullable=False)
    quote_asset: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="TRADING")
    contract_type: Mapped[str] = mapped_column(Text, nullable=False, default="PERPETUAL")
    tick_size: Mapped[float] = mapped_column(Numeric, nullable=False)
    step_size: Mapped[float] = mapped_column(Numeric, nullable=False)
    min_notional: Mapped[float] = mapped_column(Numeric, nullable=False, default=0)
    is_stable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_leveraged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    eligible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    quote_volume_24h: Mapped[float | None] = mapped_column(Numeric)
    last_price: Mapped[float | None] = mapped_column(Numeric)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class KlineRow(Base):
    __tablename__ = "klines"

    symbol: Mapped[str] = mapped_column(Text, ForeignKey("symbols.symbol"), primary_key=True)
    timeframe: Mapped[str] = mapped_column(Text, primary_key=True)
    open_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[float] = mapped_column(Numeric, nullable=False)
    high: Mapped[float] = mapped_column(Numeric, nullable=False)
    low: Mapped[float] = mapped_column(Numeric, nullable=False)
    close: Mapped[float] = mapped_column(Numeric, nullable=False)
    volume: Mapped[float] = mapped_column(Numeric, nullable=False)
    quote_volume: Mapped[float] = mapped_column(Numeric, nullable=False, default=0)
    trades: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    taker_buy_volume: Mapped[float] = mapped_column(Numeric, nullable=False, default=0)


class SignalRow(Base):
    __tablename__ = "trades_signals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    symbol: Mapped[str] = mapped_column(Text, ForeignKey("symbols.symbol"), nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    class_: Mapped[str] = mapped_column("class", Text, nullable=False)
    timeframe: Mapped[str] = mapped_column(Text, nullable=False)
    entry_price: Mapped[float | None] = mapped_column(Numeric)
    stop_loss: Mapped[float | None] = mapped_column(Numeric)
    take_profit_1: Mapped[float | None] = mapped_column(Numeric)
    take_profit_2: Mapped[float | None] = mapped_column(Numeric)
    risk_reward: Mapped[float | None] = mapped_column(Numeric)
    parts: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    reasons: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    indicators: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    orderflow: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="ACTIVE")
    paper_trade_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("score BETWEEN 0 AND 100", name="ck_signal_score"),
        CheckConstraint("direction IN ('LONG', 'SHORT')", name="ck_signal_direction"),
    )


class PaperTradeRow(Base):
    __tablename__ = "paper_trades"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    signal_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("trades_signals.id"))
    symbol: Mapped[str] = mapped_column(Text, ForeignKey("symbols.symbol"), nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="SCANNING")
    entry_price: Mapped[float | None] = mapped_column(Numeric)
    stop_loss: Mapped[float | None] = mapped_column(Numeric)
    take_profit_1: Mapped[float | None] = mapped_column(Numeric)
    take_profit_2: Mapped[float | None] = mapped_column(Numeric)
    size_qty: Mapped[float] = mapped_column(Numeric, nullable=False, default=0)
    risk_per_unit: Mapped[float | None] = mapped_column(Numeric)
    tp1_hit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tp1_partial_pct: Mapped[float] = mapped_column(Numeric, nullable=False, default=0)
    exit_price: Mapped[float | None] = mapped_column(Numeric)
    exit_reason: Mapped[str | None] = mapped_column(Text)
    realized_r: Mapped[float | None] = mapped_column(Numeric)
    realized_pnl: Mapped[float | None] = mapped_column(Numeric)
    fees_paid: Mapped[float] = mapped_column(Numeric, nullable=False, default=0)
    funding_paid: Mapped[float] = mapped_column(Numeric, nullable=False, default=0)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cooldown_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow)

    __table_args__ = (
        CheckConstraint(
            "status IN ('SCANNING','SETUP','SIGNAL_CONFIRMED','ENTRY_LOCKED',"
            "'ACTIVE','TP_SL_HIT','CLOSED','COOLDOWN','RE_ENTRY')",
            name="ck_trade_status"),
        Index("ux_paper_trades_active", "symbol", "direction",
              unique=True,
              postgresql_where=Text(
                  "status IN ('SETUP','SIGNAL_CONFIRMED','ENTRY_LOCKED','ACTIVE','TP_SL_HIT')")),
    )


class TradeEventRow(Base):
    __tablename__ = "trade_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trade_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("paper_trades.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    from_status: Mapped[str | None] = mapped_column(Text)
    to_status: Mapped[str | None] = mapped_column(Text)
    detail: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class BacktestRunRow(Base):
    __tablename__ = "backtest_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    symbols: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    timeframe: Mapped[str] = mapped_column(Text, nullable=False)
    start_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    metrics: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    trades: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    splits: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="PENDING")
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class SettingRow(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class SystemLogRow(Base):
    __tablename__ = "system_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    level: Mapped[str] = mapped_column(Text, nullable=False)
    component: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow)
