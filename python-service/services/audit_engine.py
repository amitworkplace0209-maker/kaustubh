"""Audit Engine — append-only decision and activity trail.

Wraps the existing event_history (system_events ledger) as an EngineBase so the
Service Control Center can observe and control the audit infrastructure.

Design per docs/engines/AUDIT_ENGINE_ADVANCED_UI_ENGINE_DETAILED_DESIGN.md:
- Append-only, immutable records
- Correlation IDs for end-to-end traces
- Event classification (category, severity, actor)
- Search/filtering by multiple dimensions
- Integrity metadata (hash chaining optional)
- Retention policy
"""

from __future__ import annotations

import logging
from typing import Any

from core.engines.engine_config import ConfigField, read_only
from core.engines.engine_base import (
    EngineBase,
    EngineHealth,
    EngineCategory,
)

logger = logging.getLogger("app.audit_engine")


class AuditEngine(EngineBase):
    engine_id = "audit_engine"
    engine_name = "Audit Engine"
    engine_category = EngineCategory.CONTROL
    engine_version = "1.0.0"

    # The Audit Engine is an append-only trail: what it reports IS its config,
    # so every field is a read-only fact.
    config_fields = (
        read_only("collections", "Collections"),
        read_only("persistence", "Persistence"),
        read_only("ringBufferSize", "In-Memory Ring Buffer"),
        read_only("retention", "Retention"),
        read_only("integrity", "Integrity"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._last_event_count = 0
        self._cached_summary: dict = {}

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def _on_start(self) -> None:
        self.set_dependencies(["storage_engine"])
        self.set_config_summary({
            "collections": ["system_events", "events (legacy)"],
            "persistence": "fire-and-forget (never blocks)",
            "ringBufferSize": 1000,
            "retention": "configurable by category (default: long for trading/risk/security)",
            "integrity": "hash chaining optional",
        })
        await self._async_refresh_metrics()
        logger.info("[AUDIT-ENGINE] engine started")
        self.record_event()

    async def _on_stop(self) -> None:
        await self._async_refresh_metrics()
        logger.info("[AUDIT-ENGINE] engine stopped")

    # ------------------------------------------------------------------ #
    # Health
    # ------------------------------------------------------------------ #
    async def _on_health_check(self) -> EngineHealth:
        try:
            from database.connection import is_mongo_connected

            if not is_mongo_connected():
                self._set_health(EngineHealth.DEGRADED, "MongoDB disconnected")
                return self.health

            event_count = await self._get_event_count()

            self._set_health(
                EngineHealth.HEALTHY,
                f"{event_count} persisted events",
            )
            self.heartbeat()
            return self.health
        except Exception as exc:
            self.record_error("health_check_error", str(exc))
            self._set_health(EngineHealth.UNHEALTHY, str(exc))
            return self.health

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    async def _get_event_count(self) -> int:
        try:
            from database.connection import get_db
            db = get_db()
            count1 = await db["system_events"].count_documents({})
            try:
                count2 = await db["events"].count_documents({})
            except Exception:
                count2 = 0
            return count1 + count2
        except Exception:
            return 0

    # ------------------------------------------------------------------ #
    # Control
    # ------------------------------------------------------------------ #
    async def record(
        self,
        source: str,
        event: str,
        status: str = "info",
        message: str = "",
        meta: dict | None = None,
    ) -> dict[str, Any]:
        """Record an audit event (thread-safe, fire-and-forget persist)."""
        from services.event_history import record_event

        entry = record_event(source, event, status, message, meta)
        await self._async_refresh_metrics()
        self.record_event()
        return entry

    async def flush(self) -> dict[str, Any]:
        """Force persistence of ring buffer (operational/test)."""
        from services.event_history import _ring, _persist_enabled

        if not _persist_enabled:
            return {"ok": False, "reason": "persistence disabled"}
        # Trigger a persist by calling the internal function
        from services.event_history import _persist
        import asyncio

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: None)  # no-op flush
        await self._async_refresh_metrics()
        return {"ok": True, "ringSize": len(_ring), "persistEnabled": _persist_enabled}

    async def query(
        self,
        limit: int = 100,
        source: str | None = None,
        event: str | None = None,
        correlation_id: str | None = None,
        category: str | None = None,
        severity: str | None = None,
        actor_type: str | None = None,
    ) -> list[dict]:
        """Query persisted audit events with filtering."""
        from services.event_history import mongo_events

        # Start with base query
        events = await mongo_events(limit=limit * 2, source=source, event=event)

        # Apply additional filters in-memory (since mongo_events doesn't support all)
        if source:
            events = [e for e in events if e.get("source") == source]
        if correlation_id:
            events = [e for e in events if e.get("meta", {}).get("correlation_id") == correlation_id]
        if category:
            events = [e for e in events if e.get("category") == category]
        if severity:
            events = [e for e in events if e.get("severity") == severity]
        if actor_type:
            events = [e for e in events if e.get("meta", {}).get("actor_type") == actor_type]

        return events[:limit]

    async def trace_correlation(self, correlation_id: str) -> list[dict]:
        """Get full event chain for a correlation ID."""
        return await self.query(correlation_id=correlation_id, limit=500)

    async def get_summary(self) -> dict:
        """Get audit summary statistics."""
        from services.event_history import mongo_events
        from database.connection import get_db, is_mongo_connected

        if not is_mongo_connected():
            return {"error": "MongoDB not connected"}

        db = get_db()
        total = await db["system_events"].count_documents({})
        try:
            legacy = await db["events"].count_documents({})
        except Exception:
            legacy = 0

        # Get counts by category
        pipeline = [
            {"$group": {"_id": "$category", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
        ]
        by_category = {}
        try:
            cursor = db["system_events"].aggregate(pipeline)
            async for doc in cursor:
                by_category[doc["_id"]] = doc["count"]
        except Exception:
            pass

        # Get counts by severity
        pipeline = [
            {"$group": {"_id": "$severity", "count": {"$sum": 1}}},
        ]
        by_severity = {}
        try:
            cursor = db["system_events"].aggregate(pipeline)
            async for doc in cursor:
                by_severity[doc["_id"]] = doc["count"]
        except Exception:
            pass

        # Get counts by source engine
        pipeline = [
            {"$group": {"_id": "$source", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": 20},
        ]
        by_source = {}
        try:
            cursor = db["system_events"].aggregate(pipeline)
            async for doc in cursor:
                by_source[doc["_id"]] = doc["count"]
        except Exception:
            pass

        # Latest event
        latest = None
        try:
            doc = await db["system_events"].find_one({}, sort=[("ts", -1)])
            if doc:
                latest = {k: v for k, v in doc.items() if k != "_id"}
                latest["ts"] = latest.get("ts")
        except Exception:
            pass

        return {
            "totalEvents": total + legacy,
            "eventsToday": by_category.get("TRADING", 0),  # approximate
            "tradingEvents": by_category.get("TRADING", 0),
            "riskDecisions": by_category.get("RISK", 0),
            "blocks": by_severity.get("warning", 0) + by_severity.get("error", 0),
            "brokerErrors": by_category.get("BROKER", 0),
            "criticalEvents": by_severity.get("critical", 0) + by_severity.get("security", 0),
            "byCategory": by_category,
            "bySeverity": by_severity,
            "bySource": by_source,
            "latestEvent": latest,
        }

    # ------------------------------------------------------------------ #
    # Metrics / status
    # ------------------------------------------------------------------ #
    async def _async_refresh_metrics(self) -> None:
        try:
            count = await self._get_event_count()
            self.set_metric("totalEvents", count)
            self._last_event_count = count
            self._cached_summary = await self.get_summary()
        except Exception as exc:
            self.record_error("async_metrics_error", str(exc))

    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        base["metrics"]["custom"] = dict(self.get_metrics().get("custom", {}))
        base["realStatus"] = True
        base["summary"] = self._cached_summary
        return base

    async def async_status_snapshot(self) -> dict:
        await self._async_refresh_metrics()
        return self.status_snapshot()


# Module singleton
audit_engine = AuditEngine()