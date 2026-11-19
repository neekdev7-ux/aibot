"""Admin services: settings CRUD, scanner enable/disable, system health,
and event/audit log access. Settings live in the `settings` table when a
database is available, otherwise in an in-memory store (dev/tests).
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

DEFAULT_SETTINGS = {
    "scanner_enabled": True,
    "min_score": 65,
    "cooldown_minutes": 30,
    "min_rr": 2.0,
    "paper_trading": True,
    "scan_interval_seconds": 300,
    "scan_top_n": 60,
}


@dataclass
class LogEntry:
    level: str
    component: str
    message: str
    context: dict = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {"level": self.level, "component": self.component,
                "message": self.message, "context": self.context,
                "created_at": self.created_at}


class AdminService:
    def __init__(self) -> None:
        self._settings: dict = dict(DEFAULT_SETTINGS)
        self._logs: list[LogEntry] = []
        self._lock = asyncio.Lock()
        self._started_at = time.time()

    # --- settings -------------------------------------------------------------
    async def get_settings(self) -> dict:
        async with self._lock:
            return dict(self._settings)

    async def get_setting(self, key: str):
        async with self._lock:
            return self._settings.get(key)

    async def update_settings(self, updates: dict) -> dict:
        """Update known settings only; unknown keys are rejected."""
        async with self._lock:
            unknown = set(updates) - set(DEFAULT_SETTINGS)
            if unknown:
                raise ValueError(f"Unknown settings: {sorted(unknown)}")
            if "paper_trading" in updates and updates["paper_trading"] is not True:
                raise ValueError("paper_trading cannot be disabled — paper only")
            self._settings.update(updates)
            return dict(self._settings)

    async def set_scanner_enabled(self, enabled: bool) -> bool:
        async with self._lock:
            self._settings["scanner_enabled"] = bool(enabled)
            return bool(enabled)

    @property
    def scanner_enabled(self) -> bool:
        return bool(self._settings.get("scanner_enabled", True))

    # --- health / logs ----------------------------------------------------------
    def health(self, components: dict[str, dict] | None = None) -> dict:
        """Aggregate system health. `components` carries per-component status
        dicts (db, redis, binance, ws, scanner) supplied by main.py."""
        comps = components or {}
        overall = "ok"
        for c in comps.values():
            if c.get("status") == "error":
                overall = "degraded"
                break
        return {
            "status": overall,
            "uptime_seconds": round(time.time() - self._started_at, 1),
            "paper_trading": True,
            "scanner_enabled": self.scanner_enabled,
            "components": comps,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    async def log(self, level: str, component: str, message: str,
                  context: dict | None = None) -> None:
        entry = LogEntry(level=level, component=component, message=message,
                         context=context or {})
        async with self._lock:
            self._logs.append(entry)
            self._logs = self._logs[-1000:]

    async def list_logs(self, level: str | None = None,
                        component: str | None = None,
                        limit: int = 100) -> list[dict]:
        async with self._lock:
            rows = list(reversed(self._logs))
        if level:
            rows = [r for r in rows if r.level == level]
        if component:
            rows = [r for r in rows if r.component == component]
        return [r.to_dict() for r in rows[:limit]]
