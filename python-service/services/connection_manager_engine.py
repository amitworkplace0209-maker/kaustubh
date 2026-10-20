"""Connection Manager Engine — central runtime communication & routing layer.

Wraps the existing mature ConnectionEngine (feed-routing + consumer registry) as
an EngineBase so the Service Control Center can observe/control it.

Design per docs/engines/connection-manager.md:
- Consumer connection registry (who needs what data, fields, source, delivery)
- Field requirement resolution (AVAILABLE/UNAVAILABLE/PARTIAL/NOT_READY)
- Routing from producers (Feature Engine, WebSocket Engine) to consumers
- Delivery health, backpressure, connection lifecycle
- State bridging (Engine Registry, notifications, orders, positions)

This facade is the SINGLE engine registered under ``connection_manager`` (the
legacy ``GatewayFacade`` duplicate was removed). It owns the underlying
``connection_engine`` lifecycle and reflects its real status/health.
"""

from __future__ import annotations

import logging
from typing import Any

from core.engines.engine_config import ConfigField, read_only
from core.engines.engine_base import (
    EngineBase,
    EngineHealth,
    EngineCategory,
    EngineState,
)

logger = logging.getLogger("app.connection_manager_engine")


class ConnectionManagerEngine(EngineBase):
    engine_id = "connection_manager"
    engine_name = "Connection Manager Engine"
    engine_category = EngineCategory.CONTROL
    engine_version = "1.0.0"

    config_fields = (
        read_only("channels", "Channels"),
        read_only("fieldSources", "Field Sources"),
        read_only("deliveryMethods", "Delivery Methods"),
        read_only("consumerTypes", "Consumer Types"),
    )

    def __init__(self) -> None:
        super().__init__()

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def _on_start(self) -> None:
        self.set_dependencies(["session_manager", "feature_engine", "websocket_engine", "scheduler"])
        self.set_config_summary({
            "channels": {
                "market": ["watchlist", "market_watch", "trading", "ai"],
                "state": ["positions", "orders", "notifications", "system", "data", "engines"],
            },
            "fieldSources": ["MARKET_DATA_WEBSOCKET", "FEATURE_ENGINE"],
            "deliveryMethods": ["WebSocket", "internal_stream", "snapshot"],
            "consumerTypes": ["UI", "STRATEGY", "MODEL", "MARKET_COACH", "WATCHLIST", "ALERT", "ANALYTICS"],
        })
        try:
            from connection_engine import connection_engine

            connection_engine.start()
        except Exception as exc:
            logger.warning("[CONNECTION-MANAGER-ENGINE] connection engine start failed: %s", exc)
        self._sync_status()
        logger.info("[CONNECTION-MANAGER-ENGINE] engine started")
        self.record_event()

    async def _on_stop(self) -> None:
        try:
            from connection_engine import connection_engine

            await connection_engine.shutdown()
        except Exception as exc:
            logger.warning("[CONNECTION-MANAGER-ENGINE] connection engine shutdown failed: %s", exc)
        self._sync_status()
        logger.info("[CONNECTION-MANAGER-ENGINE] engine stopped")

    # ------------------------------------------------------------------ #
    # Health
    # ------------------------------------------------------------------ #
    def _sync_status(self) -> None:
        """Mirror real ConnectionEngine signals onto the EngineBase status."""
        try:
            from connection_engine import connection_engine

            status = connection_engine.status()
            started = bool(status.get("started"))
            stats = status.get("stats") or {}
            freshness = status.get("freshness") or {}
            health = connection_engine.health() or {}
            self.set_metric("sessions", status.get("sessions", 0))
            self.set_metric("framesRouted", status.get("framesRouted", 0))
            self.set_metric("activeConnections", stats.get("activeConnections", 0))
            self.set_metric("messagesDelivered", stats.get("messagesDelivered", 0))
            self.set_metric("messagesDropped", stats.get("messagesDropped", 0))
            self.set_metric("feedFreshness", freshness.get("state", "NO_DATA"))
            self.set_metric("health", health.get("state", "UNKNOWN"))
            self.set_metric("feedLastTickAgeSeconds", freshness.get("lastTickAgeSeconds"))
            self._connection_state = health.get("state", "STOPPED")
            if started:
                self._set_state(EngineState.RUNNING)
            else:
                self._set_state(EngineState.STOPPED)
                self._set_health(EngineHealth.UNKNOWN, "gateway not started")
            self.heartbeat()
        except Exception as exc:
            self._set_health(EngineHealth.UNKNOWN, str(exc))

    async def _on_health_check(self) -> EngineHealth:
        self._sync_status()
        try:
            from database.connection import is_mongo_connected

            if not is_mongo_connected():
                self._set_health(EngineHealth.DEGRADED, "database not connected")
                return self._health
        except Exception:
            pass
        try:
            from connection_engine import connection_engine

            health = connection_engine.health() or {}
            state = health.get("state")
            reason = health.get("reason") or ""
            if self._state == EngineState.STOPPED:
                self._set_health(EngineHealth.UNKNOWN, "gateway not started")
            elif state in ("HEALTHY", "NO_DATA"):
                self._set_health(EngineHealth.HEALTHY, reason or f"state={state}")
            else:
                self._set_health(EngineHealth.DEGRADED, reason or f"state={state}")
        except Exception as exc:
            self._set_health(EngineHealth.DEGRADED, str(exc))
        return self._health

    # ------------------------------------------------------------------ #
    # Control
    # ------------------------------------------------------------------ #
    async def reconcile(self) -> dict[str, Any]:
        """Run broker subscription reconciliation."""
        from connection_engine import connection_engine
        from api.ws_engine import get_wired_engine

        engine = get_wired_engine()
        if engine and hasattr(engine, "reconcile_broker_subscriptions"):
            result = await engine.reconcile_broker_subscriptions()
            self.record_event()
            return {"ok": True, "reconcile": result}
        return {"ok": False, "reason": "engine not ready"}

    async def get_field_requirements(
        self,
        fields: list[str],
        instrument_token: str | None = None,
    ) -> dict[str, Any]:
        """Resolve field requirements for a consumer (connection-manager.md §10)."""
        from connection_engine import connection_engine
        from connection_engine import field_requirements as field_req

        feature_output = connection_engine._feature_output_for(instrument_token) if instrument_token else None
        result = field_req.resolve_requirements(
            fields,
            feature_output=feature_output,
            feature_source_ok=connection_engine._feature_source_ok(),
        )
        return {"ok": True, "data": result}

    async def get_available_fields(self) -> dict[str, Any]:
        """Catalogue of fields upstream sources can provide."""
        from connection_engine import field_requirements as field_req
        return {"ok": True, "data": field_req.available_fields()}

    # ------------------------------------------------------------------ #
    # Metrics / status
    # ------------------------------------------------------------------ #
    def status_snapshot(self) -> dict:
        self._sync_status()
        base = super().status_snapshot()
        base["metrics"]["custom"] = dict(self.get_metrics().get("custom", {}))
        base["realStatus"] = True

        try:
            from connection_engine import connection_engine

            base["connectionEngine"] = connection_engine.status()
            base["diagnostics"] = {
                "status": connection_engine.status(),
                "health": connection_engine.health(),
                "config": connection_engine.config(),
            }
        except Exception as exc:
            self.record_error("snapshot_error", str(exc))
            base["connectionEngine"] = None

        return base


# Module singleton
connection_manager_engine = ConnectionManagerEngine()