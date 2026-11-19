-- NIVA QUANT AI — PostgreSQL schema (TimescaleDB hypertable optional).
-- Paper trading only. All prices/signals come from real Binance public data;
-- nothing here stores simulated prices, signals, or win rates.
--
-- TimescaleDB: if the extension is installed, `klines` becomes a hypertable.
-- Plain postgres:16 (docker-compose default) works fine without it — the
-- DO block below only calls create_hypertable when the extension exists.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- symbols --
CREATE TABLE IF NOT EXISTS symbols (
    symbol          TEXT PRIMARY KEY,               -- e.g. BTCUSDT
    base_asset      TEXT NOT NULL,
    quote_asset     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'TRADING',
    contract_type   TEXT NOT NULL DEFAULT 'PERPETUAL',
    tick_size       NUMERIC NOT NULL,
    step_size       NUMERIC NOT NULL,
    min_notional    NUMERIC NOT NULL DEFAULT 0,
    is_stable       BOOLEAN NOT NULL DEFAULT FALSE, -- pegged base or <0.2% 24h range
    is_leveraged    BOOLEAN NOT NULL DEFAULT FALSE, -- UP/DOWN/BULL/BEAR tokens
    eligible        BOOLEAN NOT NULL DEFAULT TRUE,  -- tradable + not stable/leveraged
    quote_volume_24h NUMERIC,
    last_price      NUMERIC,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (quote_asset = 'USDT'),
    CHECK (tick_size > 0),
    CHECK (step_size > 0)
);
CREATE INDEX IF NOT EXISTS idx_symbols_eligible ON symbols (eligible, quote_volume_24h DESC NULLS LAST);

-- ----------------------------------------------------------------- klines --
-- One row per closed candle. open_time is the candle open (UTC, ms epoch in
-- source, stored as timestamptz). The live (unclosed) candle is never stored.
CREATE TABLE IF NOT EXISTS klines (
    symbol      TEXT NOT NULL REFERENCES symbols (symbol) ON DELETE CASCADE,
    timeframe   TEXT NOT NULL,                      -- 5m, 15m, 1h, 4h, 1d
    open_time   TIMESTAMPTZ NOT NULL,
    open        NUMERIC NOT NULL,
    high        NUMERIC NOT NULL,
    low         NUMERIC NOT NULL,
    close       NUMERIC NOT NULL,
    volume      NUMERIC NOT NULL,
    quote_volume NUMERIC NOT NULL DEFAULT 0,
    trades      INTEGER NOT NULL DEFAULT 0,
    taker_buy_volume NUMERIC NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, timeframe, open_time),
    CHECK (high >= low),
    CHECK (high >= open AND high >= close),
    CHECK (low <= open AND low <= close),
    CHECK (volume >= 0)
);
CREATE INDEX IF NOT EXISTS idx_klines_symbol_tf_time
    ON klines (symbol, timeframe, open_time DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        PERFORM create_hypertable('klines', 'open_time', if_not_exists => TRUE);
    END IF;
END $$;

-- ---------------------------------------------------------- trades_signals --
-- Every scored signal the scanner emits (including Watchlist/No-Trade rows
-- kept for audit). score is confluence 0-100, NOT a win probability.
CREATE TABLE IF NOT EXISTS trades_signals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol          TEXT NOT NULL REFERENCES symbols (symbol),
    direction       TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    score           INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    class           TEXT NOT NULL CHECK (class IN ('HIGH_CONFLUENCE', 'STRONG', 'WATCHLIST', 'NO_TRADE')),
    timeframe       TEXT NOT NULL,                  -- setup TF, e.g. 15m
    entry_price     NUMERIC,
    stop_loss       NUMERIC,
    take_profit_1   NUMERIC,
    take_profit_2   NUMERIC,
    risk_reward     NUMERIC,
    parts           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-block scores
    reasons         JSONB NOT NULL DEFAULT '[]'::jsonb,
    indicators      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- RSI/ADX/ATR/VWAP snapshot
    orderflow       JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'INVALIDATED')),
    paper_trade_id  UUID,                           -- set when a paper trade locks it
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    CHECK (entry_price IS NULL OR entry_price > 0),
    CHECK (risk_reward IS NULL OR risk_reward >= 0)
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_created ON trades_signals (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status_score ON trades_signals (status, score DESC);

-- ------------------------------------------------------------ paper_trades --
-- Paper-trade state machine:
--   SCANNING -> SETUP -> SIGNAL_CONFIRMED -> ENTRY_LOCKED -> ACTIVE
--   ACTIVE -> TP_SL_HIT -> CLOSED -> COOLDOWN -> RE_ENTRY (back to SETUP)
-- Locked levels (entry/sl/tp1/tp2) are immutable once ENTRY_LOCKED.
CREATE TABLE IF NOT EXISTS paper_trades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id       UUID REFERENCES trades_signals (id),
    symbol          TEXT NOT NULL REFERENCES symbols (symbol),
    direction       TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    status          TEXT NOT NULL DEFAULT 'SCANNING'
                    CHECK (status IN ('SCANNING','SETUP','SIGNAL_CONFIRMED','ENTRY_LOCKED',
                                     'ACTIVE','TP_SL_HIT','CLOSED','COOLDOWN','RE_ENTRY')),
    entry_price     NUMERIC,
    stop_loss       NUMERIC,
    take_profit_1   NUMERIC,
    take_profit_2   NUMERIC,
    size_qty        NUMERIC NOT NULL DEFAULT 0 CHECK (size_qty >= 0),
    risk_per_unit   NUMERIC,
    tp1_hit         BOOLEAN NOT NULL DEFAULT FALSE,
    tp1_partial_pct NUMERIC NOT NULL DEFAULT 0 CHECK (tp1_partial_pct BETWEEN 0 AND 100),
    exit_price      NUMERIC,
    exit_reason     TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('TP1','TP2','SL','MANUAL','EXPIRED')),
    realized_r      NUMERIC,                        -- realised P&L in R multiples
    realized_pnl    NUMERIC,                        -- realised P&L in USDT (paper)
    fees_paid       NUMERIC NOT NULL DEFAULT 0,
    funding_paid    NUMERIC NOT NULL DEFAULT 0,
    opened_at       TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,
    cooldown_until  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (entry_price IS NULL OR entry_price > 0),
    CHECK (stop_loss IS NULL OR stop_loss > 0),
    CHECK (realized_r IS NULL OR realized_r BETWEEN -10 AND 100)
);
-- No duplicate live trade per coin+direction (app also checks before insert).
CREATE UNIQUE INDEX IF NOT EXISTS ux_paper_trades_active
    ON paper_trades (symbol, direction)
    WHERE status IN ('SETUP', 'SIGNAL_CONFIRMED', 'ENTRY_LOCKED', 'ACTIVE', 'TP_SL_HIT');
CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades (symbol, created_at DESC);

-- ------------------------------------------------------------- trade_events --
-- Append-only audit log for every state transition / level change.
CREATE TABLE IF NOT EXISTS trade_events (
    id              BIGSERIAL PRIMARY KEY,
    trade_id        UUID NOT NULL REFERENCES paper_trades (id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,                  -- TRANSITION, TP1_HIT, SL_HIT, NOTE, ...
    from_status     TEXT,
    to_status       TEXT,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trade_events_trade ON trade_events (trade_id, created_at);

-- ------------------------------------------------------------- backtest_runs --
CREATE TABLE IF NOT EXISTS backtest_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    symbols         JSONB NOT NULL DEFAULT '[]'::jsonb,
    timeframe       TEXT NOT NULL,
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- fees/slippage/funding/min score
    metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- win rate, PF, expectancy, DD, ...
    trades          JSONB NOT NULL DEFAULT '[]'::jsonb,
    splits          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- train/val/test + walk-forward
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date >= start_date)
);

-- ------------------------------------------------------------------ settings --
CREATE TABLE IF NOT EXISTS settings (
    key             TEXT PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
    ('scanner_enabled', 'true'::jsonb),
    ('min_score', '65'::jsonb),
    ('cooldown_minutes', '30'::jsonb),
    ('min_rr', '2.0'::jsonb),
    ('paper_trading', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- --------------------------------------------------------------- system_logs --
CREATE TABLE IF NOT EXISTS system_logs (
    id              BIGSERIAL PRIMARY KEY,
    level           TEXT NOT NULL CHECK (level IN ('DEBUG','INFO','WARNING','ERROR','CRITICAL')),
    component       TEXT NOT NULL,                  -- scanner, ws_ingest, api, ...
    message         TEXT NOT NULL,
    context         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_component ON system_logs (component, created_at DESC);
