"""Facade engines for pre-existing subsystems.

These thin ``EngineBase`` adapters register the existing, independently-wired
systems (Scheduler, Session Manager, Connection Manager, WebSocket Engine,
Order Engine, Position Engine, Notification Center) into the Engine Registry so
the Phase 3 Service Control Center can observe and control them uniformly.

They do NOT re-implement any engine logic and never duplicate app.py's startup.
Each facade reflects the *real* state of the underlying subsystem (read live at
snapshot time) and delegates start/stop only where a clean, safe API exists.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from core.engines.engine_base import (
    EngineBase,
    EngineState,
    EngineHealth,
    EngineCategory,
)
from core.engines.engine_config import ConfigField, read_only

logger = logging.getLogger("app.legacy_engine_facades")


class SchedulerFacade(EngineBase):
    """Adapts the SchedulerController singleton (scheduler/__init__.py)."""

    engine_id = "scheduler_engine"
    engine_name = "Scheduler"
    engine_category = EngineCategory.CONTROL
    engine_version = "1.0.0"

    # The scheduler's phases and times are owned by the `sched_*` settings and
    # edited on the Scheduler page; the facade reports the run state only.
    config_fields = (
        read_only("state", "Scheduler State"),
        read_only("marketStatus", "Market Status"),
        read_only("sessionActive", "Session Active"),
        read_only("websocketConnected", "WebSocket Connected"),
        read_only("jobs", "Scheduled Jobs"),
        read_only("inWsPrepWindow", "In WS Prep Window"),
    )

    async def _on_start(self) -> None:
        from scheduler import start_scheduler
        start_scheduler()
        self._sync_status()

    async def _on_stop(self) -> None:
        from scheduler import stop_scheduler
        stop_scheduler()

    def _sync_status(self) -> None:
        try:
            from scheduler import get_scheduler_info
            info = get_scheduler_info()
            running = bool(info.get("running"))
            state = info.get("state", "")
            ws_connected = bool(info.get("websocket_connected"))
            session_active = bool(info.get("session_active"))

            self._connection_state = ("WS_ACTIVE" if ws_connected else "NOT_CONNECTED")
            if running:
                self._set_state(EngineState.RUNNING)
                self.set_metric("state", state)
                self.set_metric("sessionActive", session_active)
                self.set_metric("websocketConnected", ws_connected)
                self.set_metric("marketStatus", info.get("market_status", ""))
                self.set_metric("inWsPrepWindow", bool(info.get("in_ws_prep_window")))
                self._sync_jobs_metrics()
                if state in ("LOGIN_FAILED", "ERROR"):
                    self._set_health(EngineHealth.UNHEALTHY, f"scheduler state={state}")
                elif state == "MARKET_CLOSED" or not ws_connected:
                    self._set_health(EngineHealth.DEGRADED, f"scheduler state={state}")
                else:
                    self._set_health(EngineHealth.HEALTHY)
                self.heartbeat()
            else:
                self._set_state(EngineState.STOPPED)
                self._set_health(EngineHealth.UNKNOWN, "scheduler not running")
        except Exception as exc:
            self._set_state(EngineState.ERROR)
            self._set_health(EngineHealth.UNKNOWN, str(exc))
            logger.warning("[FACADE:scheduler_engine] sync failed: %s", exc)

    def _sync_jobs_metrics(self) -> None:
        """Surface the scheduled-downloads job system (create/toggle/run/delete)."""
        try:
            from api.scheduled_downloads import scheduled_downloads_checker_status
            st = scheduled_downloads_checker_status() or {}
            self.set_metric("jobsCheckerRunning", bool(st.get("running", False)))
            self.set_metric("jobsTaskActive", bool(st.get("taskActive", False)))
            self.set_metric("jobsCheckerIntervalSeconds", st.get("intervalSeconds", 0))
        except Exception:
            pass

    async def _on_health_check(self) -> EngineHealth:
        self._sync_status()
        return self._health

    def status_snapshot(self) -> dict:
        self._sync_status()
        base = super().status_snapshot()
        base["managed"] = True
        try:
            from scheduler import get_scheduler_info
            base["realStatus"] = get_scheduler_info()
        except Exception:
            base["realStatus"] = None
        try:
            from scheduler import get_schedule
            base["schedule"] = get_schedule()
        except Exception:
            base["schedule"] = None
        try:
            from api.scheduled_downloads import scheduled_downloads_checker_status
            base["jobs"] = scheduled_downloads_checker_status() or {}
        except Exception:
            base["jobs"] = None
        return base


class SessionFacade(EngineBase):
    """Adapts CentralSessionManager (services/session/session_manager.py)."""

    engine_id = "session_manager"
    engine_name = "Session Manager"
    engine_category = EngineCategory.CORE
    engine_version = "2.2.0"

    async def _on_start(self) -> None:
        # Start is a no-op mutate: the manager runs as long as the app runs.
        # Forcing a reconcile here surfaces any pending real expiry promptly.
        try:
            from services.session.session_manager import session_manager
            import asyncio
            loop = asyncio.get_running_loop()
            loop.create_task(session_manager.reconcile())
        except Exception:
            pass
        self._sync_status()

    async def _on_stop(self) -> None:
        # The manager owns no connector to release; stopping only reflects that
        # the canonical engine is intentionally disabled for this app run.
        self._set_state(EngineState.REGISTERED)

    def _sync_status(self) -> None:
        try:
            from services.session.session_manager import session_manager
            snap = session_manager.snapshot()
            mode = snap.get("mode") or snap.get("broker") or "unknown"
            state = snap.get("state", "")
            active = bool(snap.get("active", session_manager.is_active()))
            sub_state = snap.get("subscriptionState") or {}
            counts = (sub_state.get("counts") or {})
            p3 = session_manager.phase3_snapshot()
            health = p3.get("health") or {}

            self._connection_state = state
            self.set_metric("mode", mode)
            self.set_metric("state", state)
            self.set_metric("expiresInSeconds", snap.get("expiresIn", 0))
            self.set_metric("loginSource", snap.get("loginSource", ""))
            self.set_metric("desiredSubscriptions", counts.get("desired", 0))
            self.set_metric("subscribed", counts.get("subscribed", 0))
            self.set_metric("pinned", counts.get("pinned", 0))
            self.set_metric("expired", counts.get("expired", 0))
            self.set_metric("inactive", counts.get("inactive", 0))
            self.set_metric("subscriptionRevision", counts.get("revision", 0))
            self.set_metric("routing", (sub_state.get("routing") or {}).get("state", ""))
            self.set_metric("activeInstruments", (p3.get("statusCounts") or {}).get("ACTIVE", 0))
            self.set_metric("notSubscribed", (p3.get("statusCounts") or {}).get("NOT_SUBSCRIBED", 0))
            self.set_metric("pinOnly", (p3.get("statusCounts") or {}).get("PINNED_ONLY", 0))
            self.set_metric("expiring", (p3.get("statusCounts") or {}).get("EXPIRING", 0))
            self.set_metric("feedL8", (p3.get("feedLevelCounts") or {}).get("L8", 0))
            self.set_metric("feedL16", (p3.get("feedLevelCounts") or {}).get("L16", 0))
            self.set_metric("connections", len(p3.get("connections") or []))
            self.set_metric("revisionDrift", int(bool((p3.get("revisionApply") or {}).get("lag") and
                                                      any(v > 0 for v in (p3.get("revisionApply") or {}).get("lag", {}).values()))))

            if active:
                self._set_state(EngineState.RUNNING)
                if health.get("ok"):
                    self._set_health(EngineHealth.HEALTHY)
                else:
                    self._set_health(EngineHealth.DEGRADED,
                                     ", ".join(health.get("reasons") or ["session active but degraded"]))
            elif state in ("EXPIRED", "LOGGED_OUT", "ERROR"):
                self._set_state(EngineState.STOPPED)
                self._set_health(EngineHealth.UNHEALTHY, f"session state={state}")
            else:
                self._set_state(EngineState.REGISTERED)
                self._set_health(EngineHealth.UNKNOWN, f"session state={state}")
            self.heartbeat()
        except Exception as exc:
            self._set_health(EngineHealth.UNKNOWN, str(exc))

    async def _on_health_check(self) -> EngineHealth:
        self._sync_status()
        return self._health

    def status_snapshot(self) -> dict:
        self._sync_status()
        base = super().status_snapshot()
        base["managed"] = True
        try:
            from services.session.session_manager import session_manager
            base["realStatus"] = session_manager.phase3_snapshot()
        except Exception:
            base["realStatus"] = None
        return base


class WebSocketFacade(EngineBase):
    """Adapts the central WebSocket Engine (WS #1 broker feed).

    The feed itself is supervised by the Scheduler; this facade only observes
    the wired engine's status and health so the Control Center reflects the
    real feed state. Stopping is gated by the registry safety check.
    """

    engine_id = "websocket_engine"
    engine_name = "WebSocket Engine (Feed)"
    engine_category = EngineCategory.MARKET_DATA
    engine_version = "1.0.0"

    def _wired_engine(self):
        try:
            from api.ws_engine import get_wired_engine
            return get_wired_engine()
        except Exception:
            return None

    def _sync_status(self) -> None:
        engine = self._wired_engine()
        if engine is None:
            self._set_state(EngineState.STOPPED)
            self._set_health(EngineHealth.UNKNOWN, "wired engine unavailable")
            return
        try:
            status = engine.status()
            health = engine.health()
            m = engine.metrics()
            owner_connected = bool(
                status.get("connection_connected")
                or (status.get("owner_status") or {}).get("connected")
            )
            sub_state = status.get("subscription_state") or {}
            self._connection_state = ("CONNECTED" if owner_connected else "NOT_CONNECTED")
            self.set_metric("ticksReceived", m.get("ticks_ingested", m.get("ticksReceived", 0)))
            self.set_metric("subscriptions", status.get("subscription_count", status.get("subscriptionCount", 0)))
            self.set_metric("desiredSubscriptions", status.get("desired_subscriptions", 0))
            self.set_metric("feedOk", health.get("feed_ok", health.get("feedOk", False)))
            self.set_metric("subscribed", sub_state.get("subscribed", 0))
            self.set_metric("pinned", sub_state.get("pinned", 0))
            self.set_metric("expired", sub_state.get("expired", 0))
            self.set_metric("inactive", sub_state.get("inactive", 0))
            self.set_metric("subscriptionRevision", sub_state.get("revision", 0))
            self.set_metric("routing", (sub_state.get("routing") or {}).get("state", ""))
            if owner_connected and status.get("feed_state", "RECEIVING") == "RECEIVING":
                self._set_state(EngineState.RUNNING)
                self._set_health(EngineHealth.HEALTHY)
            elif status.get("feed_state") in ("STALE",):
                self._set_state(EngineState.STALE)
                self._set_health(EngineHealth.DEGRADED, "feed stale")
            elif status.get("feed_state") in ("DEGRADED",):
                self._set_state(EngineState.DEGRADED)
                self._set_health(EngineHealth.DEGRADED, "feed degraded")
            elif owner_connected:
                self._set_state(EngineState.DISCONNECTED)
                self._set_health(EngineHealth.UNKNOWN, "connected but not receiving")
            else:
                self._set_state(EngineState.DISCONNECTED)
                self._set_health(EngineHealth.UNKNOWN, "not connected")
            self.heartbeat()
        except Exception as exc:
            self._set_health(EngineHealth.UNKNOWN, str(exc))

    async def _on_health_check(self) -> EngineHealth:
        self._sync_status()
        return self._health

    def status_snapshot(self) -> dict:
        self._sync_status()
        base = super().status_snapshot()
        base["managed"] = True
        engine = self._wired_engine()
        if engine is not None:
            try:
                base["realStatus"] = {
                    "status": engine.status(),
                    "health": engine.health(),
                }
            except Exception:
                base["realStatus"] = None
        return base


class OrderFacade(EngineBase):
    """Adapts the Order Engine (core/engines/order_engine.py) module.

    Stateless function module — the facade is always RUNNING and reports the
    adapter availability. Registry safety gate blocks unconditional stop.
    """

    engine_id = "order_engine"
    engine_name = "Order Engine"
    engine_category = EngineCategory.TRADING
    engine_version = "1.0.0"

    config_fields = (
        ConfigField(
            key="oe_requires_broker_confirmation",
            label="Require Broker Confirmation",
            summary="requiresBrokerConfirmation",
            type="boolean",
            group="Safety",
            help=(
                "Only report an order as accepted when the broker returned an "
                "order number. Turning this off is not recommended."
            ),
        ),
        read_only("terminal", "Active Terminal"),
        read_only("adapter", "Adapter"),
        read_only("brokerSession", "Broker Session"),
    )

    def _sync_status(self) -> None:
        try:
            from brokers.manager import get_adapter
            from brokers.broker_registry import get_broker_registry
            broker = get_broker_registry().get_trading_broker()
            adapter = get_adapter(broker)
            logged_in = bool(getattr(adapter, "is_logged_in", False))
            self._connection_state = ("AUTHENTICATED" if logged_in else "NOT_AUTHENTICATED")
            self.set_metric("broker", broker)
            self.set_metric("loggedIn", logged_in)
            self._set_state(EngineState.RUNNING)
            self._set_health(EngineHealth.HEALTHY if logged_in else EngineHealth.DEGRADED,
                             "" if logged_in else "trading broker not logged in")
            self.heartbeat()
        except Exception as exc:
            self._set_health(EngineHealth.UNKNOWN, str(exc))

    async def _on_health_check(self) -> EngineHealth:
        self._sync_status()
        return self._health

    def status_snapshot(self) -> dict:
        self._sync_status()
        base = super().status_snapshot()
        base["managed"] = True
        return base


class PositionFacade(EngineBase):
    """Adapts the Position Engine (core/engines/position_engine.py) module."""

    engine_id = "position_engine"
    engine_name = "Position Engine"
    engine_category = EngineCategory.TRADING
    engine_version = "1.0.0"

    # A read-only projection of the active broker's positions — there is
    # nothing an operator may configure here.
    config_fields = (
        read_only("terminal", "Active Terminal"),
        read_only("broker", "Broker"),
        read_only("positionCount", "Positions"),
        read_only("connected", "Broker Connected"),
    )

    def _sync_status(self) -> None:
        try:
            from brokers.manager import get_adapter
            from brokers.broker_registry import get_broker_registry
            broker = get_broker_registry().get_trading_broker()
            adapter = get_adapter(broker)
            logged_in = bool(getattr(adapter, "is_logged_in", False))
            self._connection_state = "AUTHENTICATED" if logged_in else "NOT_AUTHENTICATED"
            self.set_metric("broker", broker)
            self.set_metric("loggedIn", logged_in)
            self._set_state(EngineState.RUNNING)
            self._set_health(EngineHealth.HEALTHY if logged_in else EngineHealth.DEGRADED,
                             "" if logged_in else "trading broker not logged in")
            self.heartbeat()
        except Exception as exc:
            self._set_health(EngineHealth.UNKNOWN, str(exc))

    async def _on_health_check(self) -> EngineHealth:
        self._sync_status()
        return self._health

    def status_snapshot(self) -> dict:
        self._sync_status()
        base = super().status_snapshot()
        base["managed"] = True
        return base


class TargetEngineFacade(EngineBase):
    """Adapts the Target Engine (core/engines/target_engine.py) module.

    That module is a stateless function library, so without a facade it was the
    one engine with a Services page but no registry presence — no lifecycle
    control, no metrics, no visibility into what it was holding.
    """

    engine_id = "target_engine"
    engine_name = "Target Engine"
    engine_category = EngineCategory.TRADING
    engine_version = "1.0.0"

    # Targets are set per symbol from the Terminal / Positions pages; there is
    # no engine-level knob to expose here.
    config_fields = (
        read_only("terminal", "Active Terminal"),
        read_only("targetCount", "Active Targets"),
        read_only("symbols", "Symbols With Targets"),
    )

    async def _on_start(self) -> None:
        self._sync_status()

    async def _on_stop(self) -> None:
        # Targets live in the shared store and belong to the session, not to the
        # engine lifecycle — stopping the facade must NOT discard them.
        self._set_state(EngineState.STOPPED)

    def _sync_status(self) -> None:
        try:
            from brokers.manager import active_terminal
            from core.engines import target_engine

            terminal = active_terminal()
            self._connection_state = "ACTIVE"
            self._set_state(EngineState.RUNNING)
            self._set_health(EngineHealth.HEALTHY)

            # `_TARGETS` is the engine's own in-memory registry, so it is read
            # directly — status_snapshot() is synchronous and must never await.
            targets = list(getattr(target_engine, "_TARGETS", {}).values())
            symbols = sorted({str(t.get("symbol", "")).upper() for t in targets if t.get("symbol")})
            self.set_config_summary({
                "terminal": terminal,
                "targetCount": len(targets),
                "symbols": symbols[:50],
            })
            self.set_metric("targetCount", len(targets))
            self.heartbeat()
        except Exception as exc:
            self._set_state(EngineState.ERROR)
            self._set_health(EngineHealth.UNKNOWN, str(exc))
            logger.warning("[FACADE:target_engine] sync failed: %s", exc)

    def status_snapshot(self) -> dict:
        self._sync_status()
        base = super().status_snapshot()
        base["managed"] = True
        return base


class NotificationFacade(EngineBase):
    """Adapts the Notification Center (services/notification_center.py)."""

    engine_id = "notification_engine"
    engine_name = "Notification Center"
    engine_category = EngineCategory.CONTROL
    engine_version = "1.0.0"

    async def _on_start(self) -> None:
        try:
            from services.notification_center import init_notification_center
            await init_notification_center()
        except Exception:
            pass
        self._sync_status()

    def _sync_status(self) -> None:
        try:
            from services.notification_center import is_initialized
            init = bool(is_initialized()) if callable(is_initialized) else False
            self._connection_state = "INITIALIZED" if init else "NOT_INITIALIZED"
            self.set_metric("initialized", init)
            if init:
                self._set_state(EngineState.RUNNING)
                self._set_health(EngineHealth.HEALTHY)
            else:
                self._set_state(EngineState.REGISTERED)
                self._set_health(EngineHealth.UNKNOWN, "notification center not initialized")
            self.heartbeat()
        except Exception as exc:
            self._set_health(EngineHealth.UNKNOWN, str(exc))

    async def _on_health_check(self) -> EngineHealth:
        self._sync_status()
        return self._health

    def status_snapshot(self) -> dict:
        self._sync_status()
        base = super().status_snapshot()
        base["managed"] = True
        return base


# Module singletons (registered by app.py lifespan)
scheduler_engine = SchedulerFacade()
session_engine = SessionFacade()
websocket_facade = WebSocketFacade()
order_facade = OrderFacade()
position_facade = PositionFacade()
notification_facade = NotificationFacade()
target_facade = TargetEngineFacade()


# FACADES — only legacy subsystems without a dedicated first-class engine.
# websocket_engine, session_manager and notification_engine now have
# dedicated EngineBase implementations in services/*_engine.py (first-class
# engines). They were removed from FACADES (F2 fix) to avoid duplicate
# engine_id registration — app.py registers the first-class engines
# directly; these facade objects remain importable for backwards
# compatibility but are NOT auto-registered via FACADES.
FACADES = [
    scheduler_engine,
    order_facade,
    position_facade,
    # target_engine is a stateless function module with no dedicated engine
    # class, so this facade is its only registry presence.
    target_facade,
]