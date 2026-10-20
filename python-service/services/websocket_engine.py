"""WebSocket Engine — dedicated live-market-data ingestion engine.

Wraps the existing mature WebSocketEngine + WebSocketManager as an EngineBase
so the Service Control Center can observe/control the broker feed ingestion.

Design per docs/engines/websocket-engine.md:
- Session Manager provides active subscription list
- Connects to broker WebSocket (Kotak Neo)
- Subscribes instruments, receives live feed
- Validates, deduplicates, normalizes
- Feed quality monitoring (speed, latency, stale detection)
- Hands clean standardized feed to Feature Engine
- Stops at 03:31 PM
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

logger = logging.getLogger("app.websocket_engine")


class WebSocketEngineWrapper(EngineBase):
    engine_id = "websocket_engine"
    engine_name = "Market Data WebSocket Engine"
    engine_category = EngineCategory.MARKET_DATA
    engine_version = "1.0.0"

    config_fields = (
        ConfigField(
            key="ws_feed_broker",
            label="Feed Source",
            summary="feedBroker",
            type="select",
            options=("kotak_neo_sfeed", "kotak_neo_ws", "dummy"),
            group="Feed",
            help="Which broker feed this engine consumes.",
        ),
        ConfigField(
            key="ws_enabled",
            label="Auto Connect",
            summary="autoConnect",
            type="boolean",
            group="Feed",
        ),
        ConfigField(
            key="ws_auto_reconnect",
            label="Auto Reconnect",
            summary="autoReconnect",
            type="boolean",
            group="Reconnect",
        ),
        ConfigField(
            key="ws_max_reconnect_attempts",
            label="Max Reconnect Attempts",
            summary="maxReconnectAttempts",
            type="number",
            min=0,
            max=100,
            group="Reconnect",
        ),
        ConfigField(
            key="ws_reconnect_delay_ms",
            label="Reconnect Delay",
            summary="reconnectDelayMs",
            type="number",
            min=100,
            max=120000,
            unit="ms",
            group="Reconnect",
        ),
        ConfigField(
            key="ws_backoff",
            label="Exponential Backoff",
            summary="backoff",
            type="boolean",
            group="Reconnect",
        ),
        ConfigField(
            key="ws_heartbeat",
            label="Heartbeat",
            summary="heartbeat",
            type="boolean",
            group="Reconnect",
        ),
        read_only("startTime", "Scheduled Start"),
        read_only("stopTime", "Scheduled Stop"),
        read_only("broker", "Broker"),
        read_only("feedTypes", "Feed Types"),
        read_only("handlers", "Handlers"),
        read_only("downstream", "Downstream"),
    )

    def __init__(self) -> None:
        super().__init__()

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def _on_start(self) -> None:
        self.set_dependencies(["session_manager", "connection_manager", "feature_engine", "scheduler"])
        self.set_config_summary({
            "startTime": "08:55 IST",
            "stopTime": "03:31 IST",
            "broker": "Kotak Neo",
            "feedTypes": ["L4", "L8", "L16", "INDEX"],
            "handlers": ["validate", "deduplicate", "normalize", "quality_monitor"],
            "downstream": ["feature_engine"],
        })
        logger.info("[WEBSOCKET-ENGINE] engine started")
        self.record_event()

    async def _on_stop(self) -> None:
        logger.info("[WEBSOCKET-ENGINE] engine stopped")

    # ------------------------------------------------------------------ #
    # Health
    # ------------------------------------------------------------------ #
    async def _on_health_check(self) -> EngineHealth:
        try:
            from ws_socket.engine.engine import engine as ws_engine
            from ws_socket.ws_manager import WebSocketManager
            from database.connection import is_mongo_connected

            if not is_mongo_connected():
                self._set_health(EngineHealth.DEGRADED, "MongoDB disconnected")
                return self.health

            health = ws_engine.health()
            connection_ok = health.get("connection_ok", False)
            feed_stale = health.get("feed_stale", False)
            ram_severity = health.get("ram", {}).get("severity", "UNKNOWN")

            if not connection_ok:
                self._set_health(EngineHealth.DEGRADED, "broker WebSocket disconnected")
            elif feed_stale:
                self._set_health(EngineHealth.DEGRADED, "feed stale")
            elif ram_severity in ("CRITICAL", "EMERGENCY"):
                self._set_health(EngineHealth.DEGRADED, f"RAM {ram_severity}")
            else:
                status = ws_engine.status()
                subscribed = status.get("subscription_count", 0)
                self._set_health(
                    EngineHealth.HEALTHY,
                    f"connected, {subscribed} instruments subscribed",
                )
            self.heartbeat()
            return self.health
        except Exception as exc:
            self.record_error("health_check_error", str(exc))
            self._set_health(EngineHealth.UNHEALTHY, str(exc))
            return self.health

    # ------------------------------------------------------------------ #
    # Control
    # ------------------------------------------------------------------ #
    async def reconcile(self) -> dict[str, Any]:
        """Run broker subscription reconciliation."""
        from ws_socket.engine.engine import engine as ws_engine
        result = await ws_engine.reconcile_broker_subscriptions()
        self.record_event()
        return result

    async def control_connection(self, action: str) -> dict[str, Any]:
        """Start/stop/reconnect the broker WebSocket."""
        from ws_socket.ws_manager import WebSocketManager
        from ws_socket.engine.engine import engine as ws_engine

        # The owner is set on ws_engine; delegate to it
        owner = ws_engine.owner
        if owner is None:
            return {"ok": False, "error": "no connection owner"}

        methods = {
            "connect": ("start_supervisor", "connect", "start"),
            "disconnect": ("stop_supervisor", "disconnect", "stop"),
            "reconnect": ("reconnect",),
        }
        fn_names = methods.get(action, ())
        for name in fn_names:
            fn = getattr(owner, name, None)
            if not callable(fn):
                continue
            try:
                result = fn()
                import asyncio
                if asyncio.iscoroutine(result):
                    result = await result
                self.record_event()
                return {"ok": True, "action": action, "method": name, "result": result}
            except Exception as exc:
                return {"ok": False, "action": action, "error": str(exc)}
        return {"ok": False, "action": action, "error": f"owner has no {action} control method"}

    async def set_pin(self, data: dict) -> dict[str, Any]:
        """Pin an instrument (feed intent)."""
        from ws_socket.engine.engine import engine as ws_engine
        pin = await ws_engine.set_pin(data)
        self.record_event()
        return pin

    async def unset_pin(self, instrument_key: str) -> dict[str, Any]:
        """Unpin an instrument."""
        from ws_socket.engine.engine import engine as ws_engine
        result = await ws_engine.unset_pin(instrument_key)
        self.record_event()
        return result

    # ------------------------------------------------------------------ #
    # Metrics / status
    # ------------------------------------------------------------------ #
    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        base["metrics"]["custom"] = dict(self.get_metrics().get("custom", {}))
        base["realStatus"] = True

        try:
            from ws_socket.engine.engine import engine as ws_engine
            from ws_socket.ws_manager import WebSocketManager

            # Engine status
            engine_status = ws_engine.status()
            base["engineStatus"] = engine_status

            # Feed quality
            quality = ws_engine.quality_snapshot()
            base["feedQuality"] = quality

            # Live feed metrics
            live = ws_engine.live_feed()
            base["liveFeed"] = live

            # Owner (WebSocketManager) status
            if ws_engine.owner and hasattr(ws_engine.owner, "status"):
                base["ownerStatus"] = ws_engine.owner.status()
            else:
                base["ownerStatus"] = None

            # Resources
            base["resources"] = ws_engine.resources_view()

        except Exception as exc:
            self.record_error("snapshot_error", str(exc))
            base["engineStatus"] = None
            base["feedQuality"] = None
            base["liveFeed"] = None
            base["ownerStatus"] = None

        return base


# Module singleton
websocket_engine = WebSocketEngineWrapper()