"""Engine Base — reusable lifecycle, health, metrics, and error tracking mixin.

Every engine in the system should inherit from ``EngineBase`` to get
standardized lifecycle state, health reporting, heartbeat, metrics,
error tracking, dependency management, and structured logging.  The
``EngineRegistry`` reads these properties to build the Phase 3 Service
Control Center.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from core.engines.engine_config import ConfigField, validate_patch


class EngineState(str, Enum):
    REGISTERED = "REGISTERED"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    STOPPING = "STOPPING"
    STOPPED = "STOPPED"
    RESTARTING = "RESTARTING"
    ERROR = "ERROR"
    DISCONNECTED = "DISCONNECTED"
    STALE = "STALE"
    DISABLED = "DISABLED"
    DEPENDENCY_ERROR = "DEPENDENCY_ERROR"


class EngineHealth(str, Enum):
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    UNHEALTHY = "UNHEALTHY"
    UNKNOWN = "UNKNOWN"


class EngineCategory(str, Enum):
    CORE = "CORE"
    TRADING = "TRADING"
    MARKET_DATA = "MARKET_DATA"
    DATA = "DATA"
    CONTROL = "CONTROL"
    STORAGE = "STORAGE"
    AI = "AI"


@dataclass
class EngineMetrics:
    event_count: int = 0
    error_count: int = 0
    warning_count: int = 0
    last_operation_at: float = 0.0
    last_operation_duration_ms: float = 0.0
    queue_size: int = 0
    workload: int = 0
    custom: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "eventCount": self.event_count,
            "errorCount": self.error_count,
            "warningCount": self.warning_count,
            "lastOperationAt": self.last_operation_at,
            "lastOperationDurationMs": self.last_operation_duration_ms,
            "queueSize": self.queue_size,
            "workload": self.workload,
            "custom": dict(self.custom),
        }


class EngineBase:
    """Mixin providing standardized lifecycle, health, metrics, and logging.

    Subclasses MUST set ``engine_id``, ``engine_name``, and ``engine_category``
    as class attributes.  They MAY override ``_on_start()``, ``_on_stop()``,
    ``_on_health_check()``.
    """

    engine_id: str = "base"
    engine_name: str = "Base Engine"
    engine_category: EngineCategory = EngineCategory.CORE
    engine_version: str = "1.0.0"

    # Declarative settings schema. Subclasses declare the knobs an operator may
    # change; see core/engines/engine_config.py for the field contract.
    config_fields: tuple = ()

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._state: EngineState = EngineState.REGISTERED
        self._health: EngineHealth = EngineHealth.UNKNOWN
        self._health_reason: str = ""
        self._started_at: float = 0.0
        self._last_heartbeat: float = 0.0
        self._metrics = EngineMetrics()
        self._recent_errors: deque[dict] = deque(maxlen=50)
        self._recent_activity: deque[dict] = deque(maxlen=100)
        self._dependencies: list[str] = []
        self._dependents: list[str] = []
        self._config_summary: dict[str, Any] = {}
        self._config_overrides: dict[str, Any] = {}
        self._connection_state: str = "NOT_APPLICABLE"
        self._logger = logging.getLogger(f"engine.{self.engine_id}")

    # ------------------------------------------------------------------
    # State management
    # ------------------------------------------------------------------
    @property
    def state(self) -> EngineState:
        return self._state

    @property
    def health(self) -> EngineHealth:
        return self._health

    @property
    def health_reason(self) -> str:
        return self._health_reason

    @property
    def is_running(self) -> bool:
        return self._state in (EngineState.RUNNING, EngineState.HEALTHY, EngineState.DEGRADED)

    def _set_state(self, state: EngineState, reason: str = "") -> None:
        with self._lock:
            old = self._state
            self._state = state
            if reason:
                self._health_reason = reason
            self._record_activity(f"state:{old.value}->{state.value}", reason)
            self._logger.info(
                "[ENGINE:%s] state %s -> %s%s",
                self.engine_id, old.value, state.value,
                f" ({reason})" if reason else "",
            )

    def _set_health(self, health: EngineHealth, reason: str = "") -> None:
        with self._lock:
            self._health = health
            self._health_reason = reason

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def start(self) -> bool:
        with self._lock:
            if self._state in (EngineState.RUNNING, EngineState.HEALTHY, EngineState.STARTING):
                return True
            self._set_state(EngineState.STARTING)
        try:
            await self._on_start()
            with self._lock:
                self._started_at = time.time()
                self._last_heartbeat = time.time()
                self._set_state(EngineState.RUNNING)
                self._set_health(EngineHealth.HEALTHY)
            return True
        except Exception as exc:
            self._set_state(EngineState.ERROR, str(exc))
            self._set_health(EngineHealth.UNHEALTHY, str(exc))
            self._record_error("start_failed", str(exc))
            self._logger.exception("[ENGINE:%s] start failed", self.engine_id)
            return False

    async def stop(self) -> bool:
        with self._lock:
            if self._state in (EngineState.STOPPED, EngineState.STOPPING):
                return True
            self._set_state(EngineState.STOPPING)
        try:
            await self._on_stop()
            with self._lock:
                self._set_state(EngineState.STOPPED)
                self._set_health(EngineHealth.UNKNOWN, "stopped")
            return True
        except Exception as exc:
            self._set_state(EngineState.ERROR, str(exc))
            self._record_error("stop_failed", str(exc))
            self._logger.exception("[ENGINE:%s] stop failed", self.engine_id)
            return False

    async def restart(self) -> bool:
        self._set_state(EngineState.RESTARTING)
        if await self.stop():
            return await self.start()
        return False

    async def _on_start(self) -> None:
        """Override in subclass for custom start logic."""

    async def _on_stop(self) -> None:
        """Override in subclass for custom stop logic."""

    # ------------------------------------------------------------------
    # Heartbeat
    # ------------------------------------------------------------------
    def heartbeat(self) -> None:
        with self._lock:
            self._last_heartbeat = time.time()

    @property
    def last_heartbeat(self) -> float:
        return self._last_heartbeat

    def heartbeat_age(self) -> float:
        if self._last_heartbeat <= 0:
            return -1.0
        return time.time() - self._last_heartbeat

    # ------------------------------------------------------------------
    # Health check
    # ------------------------------------------------------------------
    async def health_check(self) -> EngineHealth:
        try:
            result = await self._on_health_check()
            self._set_health(result)
            return result
        except Exception as exc:
            self._set_health(EngineHealth.UNHEALTHY, str(exc))
            return EngineHealth.UNHEALTHY

    async def _on_health_check(self) -> EngineHealth:
        if self._state in (EngineState.RUNNING, EngineState.HEALTHY):
            age = self.heartbeat_age()
            if 0 < age > 300:
                return EngineHealth.DEGRADED
            return EngineHealth.HEALTHY
        if self._state == EngineState.DEGRADED:
            return EngineHealth.DEGRADED
        if self._state == EngineState.ERROR:
            return EngineHealth.UNHEALTHY
        return EngineHealth.UNKNOWN

    # ------------------------------------------------------------------
    # Metrics
    # ------------------------------------------------------------------
    def record_event(self) -> None:
        with self._lock:
            self._metrics.event_count += 1
            self._metrics.last_operation_at = time.time()

    def record_error(self, error_code: str, message: str = "") -> None:
        self._record_error(error_code, message)

    def _record_error(self, error_code: str, message: str) -> None:
        with self._lock:
            self._metrics.error_count += 1
            entry = {
                "timestamp": time.time(),
                "code": error_code,
                "message": message,
            }
            self._recent_errors.append(entry)
            self._logger.warning("[ENGINE:%s] error: %s — %s", self.engine_id, error_code, message)

    def record_warning(self, message: str) -> None:
        with self._lock:
            self._metrics.warning_count += 1
            self._recent_activity.append({
                "timestamp": time.time(),
                "type": "warning",
                "message": message,
            })

    def _record_activity(self, event_type: str, message: str = "") -> None:
        with self._lock:
            self._recent_activity.append({
                "timestamp": time.time(),
                "type": event_type,
                "message": message,
            })

    def set_metric(self, key: str, value: Any) -> None:
        with self._lock:
            self._metrics.custom[key] = value

    def get_metrics(self) -> dict:
        with self._lock:
            return self._metrics.to_dict()

    def get_recent_errors(self, limit: int = 20) -> list[dict]:
        with self._lock:
            return list(self._recent_errors)[-limit:]

    def get_recent_activity(self, limit: int = 30) -> list[dict]:
        with self._lock:
            return list(self._recent_activity)[-limit:]

    # ------------------------------------------------------------------
    # Dependencies
    # ------------------------------------------------------------------
    def set_dependencies(self, deps: list[str]) -> None:
        with self._lock:
            self._dependencies = list(deps)

    def set_dependents(self, deps: list[str]) -> None:
        with self._lock:
            self._dependents = list(deps)

    def get_dependencies(self) -> list[str]:
        with self._lock:
            return list(self._dependencies)

    def get_dependents(self) -> list[str]:
        with self._lock:
            return list(self._dependents)

    def set_config_summary(self, config: dict[str, Any]) -> None:
        with self._lock:
            self._config_summary = dict(config)

    def refresh_config_summary(self) -> None:
        """Re-derive the published ``configSummary`` from LIVE settings.

        Default is a no-op: engines that compute their summary once in
        ``_on_start`` keep reporting it. Engines whose summary is a pure
        function of the settings store override this so the Control Center
        reflects a change immediately instead of waiting for a restart — and
        never claims a value the engine is not using.
        """

    # ------------------------------------------------------------------
    # Settings (declarative schema -> validated, persisted writes)
    # ------------------------------------------------------------------
    def config_snapshot(self) -> dict:
        """The engine's settings schema resolved against its LIVE values.

        ``value`` is what the engine is actually running with (read from its
        ``configSummary``), and ``applied`` is the last value written through
        this channel — so the UI can show when a change has not been taken up
        yet instead of claiming success.
        """
        with self._lock:
            summary = dict(self._config_summary)
            overrides = dict(self._config_overrides)

        fields: list[dict] = []
        for spec in self.config_fields:
            live_value = summary.get(spec.summary or spec.key)
            override = overrides.get(spec.key) if spec.key else None
            fields.append(spec.to_dict(override, applied=live_value))

        # Any configSummary entry the engine publishes but does not declare is
        # still surfaced — as a read-only fact — so nothing it reports is lost.
        declared = {f.summary or f.key for f in self.config_fields}
        for name, value in summary.items():
            if name not in declared:
                fields.append(
                    ConfigField(key="", label=name, summary=name, type="text", editable=False).to_dict(value)
                )

        return {
            "engineId": self.engine_id,
            "engineName": self.engine_name,
            "fields": fields,
            "editable": sum(1 for f in self.config_fields if f.editable and f.key),
            "readOnly": sum(1 for f in fields if not f.get("editable")),
        }

    async def _write_settings(self, clean: dict) -> tuple[dict, dict]:
        """Persist validated settings. Override when an engine owns a richer store.

        The default writes to the shared settings store (Mongo ``app_settings``,
        validated by ``settings_service``). Engines that already keep a dedicated,
        persisted config module (Session Manager, Storage Engine) override this
        so the Control Center and the engine's own settings page never disagree
        about where a value lives.
        """
        from services.settings_service import set_setting

        written: dict[str, Any] = {}
        failed: dict[str, str] = {}
        for key, value in clean.items():
            try:
                await set_setting(key, value)
                written[key] = value
            except ValueError as exc:
                failed[key] = str(exc)
            except Exception as exc:  # persistence failure must not look applied
                self.record_error("CONFIG_WRITE_FAILED", f"{key}: {exc}")
                failed[key] = f"could not persist {key}: {exc}"
        return written, failed

    async def apply_config_patch(self, patch: dict) -> dict:
        """Validate, persist and apply a settings patch for this engine.

        Named ``apply_config_patch`` rather than ``update_config`` because
        StorageEngine already owns a public ``update_config(patch, persist)``
        used by ``/api/services/storage/config`` — shadowing it would have
        broken that endpoint.

        Nothing is written unless it validates. Per-field errors are returned
        together so the form can highlight exactly which input was refused, and
        a field the settings store rejects never lands in Mongo.
        """
        clean, errors = validate_patch(self.config_fields, patch)
        if not clean:
            return {"ok": not errors, "engineId": self.engine_id, "errors": errors,
                    "config": self.config_snapshot()}

        try:
            written, failed = await self._write_settings(clean)
        except Exception as exc:
            self.record_error("CONFIG_WRITE_FAILED", str(exc))
            return {"ok": False, "engineId": self.engine_id,
                    "errors": {"*": f"could not save settings: {exc}"},
                    "config": self.config_snapshot()}

        if written:
            with self._lock:
                self._config_overrides.update(written)
            # Propagate to the TTL cache so an engine reading through rt_*
            # accessors sees the new value without a restart.
            try:
                from services.runtime_settings import refresh_runtime_settings
                await refresh_runtime_settings()
            except Exception as exc:
                self.record_warning(f"runtime settings refresh skipped: {exc}")
            self._record_activity("CONFIG_UPDATED", f"{', '.join(written)}")
            # Re-derive the published summary so the response reports what the
            # engine actually took, not just what was requested. Engines whose
            # summary is a pure function of settings re-read it here, which is
            # what turns a write into an immediately-visible change instead of a
            # "pending restart" the engine would never resolve on its own.
            try:
                self.refresh_config_summary()
            except Exception:
                pass

        merged = {**errors, **failed}
        return {
            "ok": bool(written) and not merged,
            "engineId": self.engine_id,
            "written": written,
            "errors": merged,
            "config": self.config_snapshot(),
        }

    # ------------------------------------------------------------------
    # Status snapshot (read by Engine Registry → Phase 3)
    # ------------------------------------------------------------------
    def status_snapshot(self) -> dict:
        with self._lock:
            now = time.time()
            return {
                "engineId": self.engine_id,
                "engineName": self.engine_name,
                "engineCategory": self.engine_category.value,
                "version": self.engine_version,
                "state": self._state.value,
                "health": self._health.value,
                "healthReason": self._health_reason,
                "startedAt": self._started_at,
                "startedAtAgo": round(now - self._started_at, 1) if self._started_at else None,
                "lastHeartbeat": self._last_heartbeat,
                "heartbeatAge": round(self.heartbeat_age(), 1) if self._last_heartbeat else None,
                "metrics": self._metrics.to_dict(),
                "recentErrors": self.get_recent_errors(5),
                "dependencies": list(self._dependencies),
                "dependents": list(self._dependents),
                "configSummary": dict(self._config_summary),
                "connectionState": self._connection_state,
            }

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} id={self.engine_id} state={self._state.value}>"
