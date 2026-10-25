"""Session Manager Engine — canonical broker session & subscription authority.

Wraps the existing mature CentralSessionManager + instrument_store as an
EngineBase so the Service Control Center can observe/control it.

Design per docs/engines/session-manager.md:
- Broker session lifecycle (Kotak/Shoonya/Dummy, independent)
- Stock/instrument registry (metadata only, no live ticks)
- Subscription registry (subscriber tracking, deduplication)
- Expiry management (real wall-clock, auto EXPIRED transition)
- Phase 3 lifecycle vocabulary (ACTIVE/SUBSCRIBED/PINNED/EXPIRED/...)
- Real-time events via EngineEventBus + centralized state store
"""

from __future__ import annotations

import logging
from typing import Any

from core.engines.engine_base import (
    EngineBase,
    EngineHealth,
    EngineCategory,
)
from core.engines.engine_config import ConfigField, read_only

logger = logging.getLogger("app.session_manager_engine")


class SessionManagerEngine(EngineBase):
    engine_id = "session_manager"
    engine_name = "Session Manager Engine"
    engine_category = EngineCategory.CONTROL
    engine_version = "1.0.0"

    # Settings keys are the Session Manager's OWN config module keys, not the
    # shared settings store — see _write_settings below.
    config_fields = (
        ConfigField(
            key="session_lifetime_seconds",
            label="Session Lifetime",
            summary="sessionLifetimeSeconds",
            type="number",
            min=60,
            max=86400,
            unit="s",
            group="Session",
            help="How long a broker session stays valid without a refresh.",
        ),
        ConfigField(
            key="expiry_warning_seconds",
            label="Expiry Warning",
            summary="expiryWarningSeconds",
            type="number",
            min=30,
            max=7200,
            unit="s",
            group="Session",
            help="Warn this long before the session expires.",
        ),
        ConfigField(
            key="tick_active_window_seconds",
            label="Tick-Active Window",
            summary="tickActiveWindowSeconds",
            type="number",
            min=1,
            max=3600,
            unit="s",
            group="Session",
            help="A tick newer than this keeps the session marked active.",
        ),
        read_only("supportedBrokers", "Supported Brokers"),
        read_only("supportedExpiryTypes", "Supported Expiry Types"),
        read_only("supportedFeedLevels", "Supported Feed Levels"),
        read_only("canonicalCollections", "Canonical Collections"),
    )

    async def _write_settings(self, clean: dict) -> tuple[dict, dict]:
        """Write through the Session Manager's own persisted config module.

        It already owns a validated, Mongo-backed config store with its own audit
        trail — writing to the shared settings store instead would create a
        second source of truth for the same three knobs.
        """
        from services.session.session_manager_config import set_config

        try:
            result = await set_config(clean, updated_by="service-control-center")
        except Exception as exc:  # rejected or unpersistable -> report per key
            return {}, {key: str(exc) for key in clean}

        # set_config returns the full effective config ({key: {value, ...}}), so
        # a key counts as written only if it comes back at the requested value.
        applied = result if isinstance(result, dict) else {}
        written: dict[str, Any] = {}
        errors: dict[str, str] = {}
        for key, want in clean.items():
            got = applied.get(key)
            got_value = got.get("value") if isinstance(got, dict) else got
            if got_value is None:
                errors[key] = f"{key} was not accepted by the session config store"
                continue
            same = float(got_value) == float(want) if (
                isinstance(want, (int, float))
                and not isinstance(want, bool)
                and isinstance(got_value, (int, float))
            ) else got_value == want
            if same:
                written[key] = want
            else:
                errors[key] = f"{key} still reads {got_value!r} after save"
        return written, errors

    def __init__(self) -> None:
        super().__init__()

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def _on_start(self) -> None:
        self.set_dependencies(["connection_manager", "websocket_engine", "scheduler"])
        self.set_config_summary(self.config_summary())
        logger.info("[SESSION-MANAGER-ENGINE] engine started")
        self.record_event()

    def config_summary(self) -> dict[str, Any]:
        """Live config the engine actually consumes (never hard-coded raw)."""
        from services.session.session_manager_config import (
            expiry_warning_seconds,
            session_lifetime_seconds,
            tick_active_window_seconds,
        )
        return {
            "sessionLifetimeSeconds": int(session_lifetime_seconds()),
            "expiryWarningSeconds": int(expiry_warning_seconds()),
            "tickActiveWindowSeconds": float(tick_active_window_seconds()),
            "supportedBrokers": ["kotak", "shoonya", "dummy"],
            "supportedExpiryTypes": ["PERMANENT", "SESSION", "TRADE", "DURATION", "ONE_SHOT"],
            "supportedFeedLevels": [4, 8, 16],
            "canonicalCollections": ["session_manager_instruments", "session_manager_events", "session_manager_revisions"],
        }

    async def _on_stop(self) -> None:
        logger.info("[SESSION-MANAGER-ENGINE] engine stopped")

    # ------------------------------------------------------------------ #
    # Health
    # ------------------------------------------------------------------ #
    async def _on_health_check(self) -> EngineHealth:
        try:
            from database.connection import is_mongo_connected

            if not is_mongo_connected():
                self._set_health(EngineHealth.DEGRADED, "MongoDB disconnected")
                return self.health

            # Check session state
            from services.session.session_manager import session_manager
            snap = session_manager.phase3_snapshot()
            active = snap.get("active", False)
            counts = snap.get("counts", {})
            health = snap.get("health", {})

            if health.get("ok"):
                self._set_health(
                    EngineHealth.HEALTHY,
                    f"session={'active' if active else 'inactive'}, {counts.get('total', 0)} instruments",
                )
            else:
                self._set_health(
                    EngineHealth.DEGRADED,
                    "; ".join(health.get("reasons", ["unknown"])),
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
        """Run expiry sweep + request normalization."""
        import time
        from services.session.session_manager import session_manager
        result = await session_manager.reconcile(now_ts=time.time())
        self.record_event()
        return result

    async def set_mode(self, mode: str, broker: str | None = None, user_id: str | None = None) -> dict[str, Any]:
        """Switch active terminal context (no login/logout)."""
        from services.session.session_manager import session_manager
        session_manager.set_mode(mode, broker=broker, user_id=user_id)
        self.record_event()
        return {"ok": True, "mode": mode}

    async def login(
        self,
        mode: str,
        broker: str,
        user_id: str | None = None,
        session_ref: str | None = None,
        lifetime_seconds: int | None = None,
        source: str = "manual",
    ) -> dict[str, Any]:
        """Record a successful broker login (None lifetime = configured)."""
        from services.session.session_manager import session_manager
        result = session_manager.mark_login_success(
            mode=mode,
            broker=broker,
            user_id=user_id,
            session_ref=session_ref,
            lifetime_seconds=lifetime_seconds,
            source=source,
        )
        self.record_event()
        return {"ok": True, "session": result}

    async def logout(self, reason: str | None = None, mode: str | None = None) -> dict[str, Any]:
        """Record a session end with honest reason."""
        from services.session.session_manager import session_manager
        result = session_manager.mark_logout(reason=reason, mode=mode)
        self.record_event()
        return {"ok": True, "session": result}

    async def expire(self, reason: str | None = None) -> dict[str, Any]:
        """Record session expiry."""
        from services.session.session_manager import session_manager
        result = session_manager.mark_expired(reason=reason)
        self.record_event()
        return {"ok": True, "session": result}

    # ------------------------------------------------------------------ #
    # Metrics / status
    # ------------------------------------------------------------------ #
    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        base["metrics"]["custom"] = dict(self.get_metrics().get("custom", {}))
        base["realStatus"] = True
        base["configSummary"] = self.config_summary()

        try:
            from services.session.session_manager import session_manager
            base["phase3Snapshot"] = session_manager.phase3_snapshot()
            base["subscriptionSnapshot"] = session_manager.subscription_snapshot()
        except Exception as exc:
            self.record_error("snapshot_error", str(exc))
            base["phase3Snapshot"] = None
            base["subscriptionSnapshot"] = None

        return base


# Module singleton
session_manager_engine = SessionManagerEngine()