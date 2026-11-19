"""Configuration from environment variables (pydantic-settings).

Defaults mirror the spec: bias on 4H+1H, setup on 15M, entry on 5M,
minimum 1:2 R:R, paper trading default, 30-minute cooldown, min score 65.
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Database / cache ---
    database_url: str = "postgresql+asyncpg://niva:niva_dev_password@localhost:5432/niva_quant"
    redis_url: str = "redis://localhost:6379/0"

    # --- Binance public market data (no API key) ---
    # data-api.binance.vision FIRST: api.binance.com is 451 geo-blocked in
    # some clouds. NOTE: vision serves spot /api/v3 only — it 404s /fapi/v1.
    # fapi1/2/3 are Binance's alternate futures hosts. Comma-separated list,
    # tried in order. In a geo-restricted network ALL futures hosts may fail
    # (451 / redirect to binance.com) — the scanner then reports the outage
    # honestly instead of fabricating data.
    binance_bases: str = ("https://data-api.binance.vision,https://fapi.binance.com,"
                          "https://fapi1.binance.com,https://fapi2.binance.com,"
                          "https://fapi3.binance.com")
    binance_ws_base: str = "wss://fstream.binance.com"

    # --- Scanner ---
    scan_interval_seconds: int = 300
    scan_top_n: int = 60
    scan_concurrency: int = 8
    scan_min_quote_volume_24h: float = 10_000_000
    scan_max_spread_bps: float = 20.0
    scan_min_atr_pct: float = 0.3
    scan_min_score: int = 65
    scan_candidate_threshold: int = 55  # pass-1 score needed for pass-2 enrichment

    # --- Timeframes ---
    bias_tf_1: str = "4h"
    bias_tf_2: str = "1h"
    setup_tf: str = "15m"
    entry_tf: str = "5m"

    # --- Risk / trade rules ---
    paper_trading: bool = True
    min_rr: float = 2.0
    cooldown_minutes: int = 30
    max_open_trades: int = 10
    taker_fee_bps: float = 5.0       # Binance USDT-M taker fee, 0.05%
    slippage_bps: float = 2.0        # assumed slippage for paper fills
    funding_8h_bps: float = 1.0      # assumed 8h funding rate for backtests

    # --- Server ---
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    cors_origins: str = "http://localhost:3000,http://localhost:8000"
    rate_limit_per_minute: int = 120
    ws_enabled: bool = True

    @property
    def binance_base_list(self) -> list[str]:
        return [b.strip() for b in self.binance_bases.split(",") if b.strip()]

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
