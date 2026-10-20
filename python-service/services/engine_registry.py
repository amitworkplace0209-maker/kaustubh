"""Engine Registry — central source of truth for all engine lifecycle states.

The Phase 3 Service Control Center reads exclusively from this registry.
Every engine must be registered here via ``register()`` and its lifecycle
controlled through ``start() / stop() / restart()``.

The registry does NOT duplicate engine logic.  It holds references to
real engine instances and exposes their status/health/metrics.
"""

from __future__ import annotations

import logging
import time
import threading
from typing import Any, Optional

from core.engines.engine_base import EngineBase, EngineState, EngineHealth, EngineCategory

logger = logging.getLogger("app.engine_registry")

# LIFECYCLE_STATES — canonical states the registry understands
LIFECYCLE_STATES = tuple(s.value for s in EngineState)


class EngineRegistry:
    """Singleton registry holding all engine instances.

    Provides CRUD on engine registrations, lifecycle control (start/stop/
    restart), health checks, metrics, dependency graph, and status snapshots
    consumed by the Phase 3 Service Control Center.
    """

    def __init__(self) -> None:
        self._engines: dict[str, EngineBase] = {}
        self._lock = threading.RLock()
        self._registered_at: float = time.time()

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------
    def register(self, engine: EngineBase) -> None:
        with self._lock:
            if engine.engine_id in self._engines:
                logger.warning(
                    "[REGISTRY] engine %s already registered — replacing",
                    engine.engine_id,
                )
            self._engines[engine.engine_id] = engine
            logger.info(
                "[REGISTRY] registered engine: %s (%s) [%s]",
                engine.engine_id, engine.engine_name, engine.engine_category.value,
            )

    def unregister(self, engine_id: str) -> bool:
        with self._lock:
            if engine_id not in self._engines:
                return False
            del self._engines[engine_id]
            logger.info("[REGISTRY] unregistered engine: %s", engine_id)
            return True

    def get(self, engine_id: str) -> Optional[EngineBase]:
        with self._lock:
            return self._engines.get(engine_id)

    # ------------------------------------------------------------------
    # Lifecycle control
    # ------------------------------------------------------------------
    async def start(self, engine_id: str) -> dict:
        engine = self.get(engine_id)
        if not engine:
            return {"ok": False, "error": f"engine '{engine_id}' not found"}
        # Check dependencies
        dep_error = self._check_dependencies(engine_id)
        if dep_error:
            return {"ok": False, "error": dep_error}
        ok = await engine.start()
        return {"ok": ok, "state": engine.state.value, "health": engine.health.value}

    async def stop(self, engine_id: str) -> dict:
        engine = self.get(engine_id)
        if not engine:
            return {"ok": False, "error": f"engine '{engine_id}' not found"}
        # Safety check: warn if trading engines have active work
        safety = self._safety_check(engine_id)
        if safety:
            return {"ok": False, "error": safety, "requiresConfirmation": True}
        ok = await engine.stop()
        # Dependent engines may need to know
        self._notify_dependents(engine_id, "stopped")
        return {"ok": ok, "state": engine.state.value, "health": engine.health.value}

    async def restart(self, engine_id: str) -> dict:
        engine = self.get(engine_id)
        if not engine:
            return {"ok": False, "error": f"engine '{engine_id}' not found"}
        ok = await engine.restart()
        return {"ok": ok, "state": engine.state.value, "health": engine.health.value}

    # ------------------------------------------------------------------
    # Status / Health / Metrics
    # ------------------------------------------------------------------
    def get_status(self, engine_id: str) -> Optional[dict]:
        engine = self.get(engine_id)
        if not engine:
            return None
        return engine.status_snapshot()

    def get_all_statuses(self) -> list[dict]:
        with self._lock:
            engines = list(self._engines.values())
        return [e.status_snapshot() for e in engines]

    def get_health(self, engine_id: str) -> Optional[dict]:
        engine = self.get(engine_id)
        if not engine:
            return None
        return {
            "engineId": engine.engine_id,
            "health": engine.health.value,
            "reason": engine.health_reason,
            "state": engine.state.value,
        }

    def get_metrics(self, engine_id: str) -> Optional[dict]:
        engine = self.get(engine_id)
        if not engine:
            return None
        return engine.get_metrics()

    def get_dependencies(self, engine_id: str) -> dict:
        engine = self.get(engine_id)
        if not engine:
            return {}
        deps = engine.get_dependencies()
        dep_statuses = {}
        for dep_id in deps:
            dep = self.get(dep_id)
            if dep:
                dep_statuses[dep_id] = {
                    "state": dep.state.value,
                    "health": dep.health.value,
                }
            else:
                dep_statuses[dep_id] = {"state": "NOT_REGISTERED", "health": "UNKNOWN"}
        return {
            "engineId": engine_id,
            "dependencies": deps,
            "dependents": engine.get_dependents(),
            "statuses": dep_statuses,
        }

    # ------------------------------------------------------------------
    # Heartbeat
    # ------------------------------------------------------------------
    def heartbeat(self, engine_id: str) -> bool:
        engine = self.get(engine_id)
        if not engine:
            return False
        engine.heartbeat()
        return True

    def heartbeat_all(self) -> int:
        count = 0
        with self._lock:
            for engine in self._engines.values():
                if engine.is_running:
                    engine.heartbeat()
                    count += 1
        return count

    # ------------------------------------------------------------------
    # Health checks
    # ------------------------------------------------------------------
    async def health_check_all(self) -> dict[str, str]:
        results = {}
        with self._lock:
            engines = list(self._engines.values())
        for engine in engines:
            health = await engine.health_check()
            results[engine.engine_id] = health.value
        return results

    # ------------------------------------------------------------------
    # Dependency graph
    # ------------------------------------------------------------------
    def dependency_graph(self) -> dict:
        with self._lock:
            graph = {}
            for eid, engine in self._engines.items():
                graph[eid] = {
                    "name": engine.engine_name,
                    "category": engine.engine_category.value,
                    "state": engine.state.value,
                    "health": engine.health.value,
                    "dependencies": engine.get_dependencies(),
                    "dependents": engine.get_dependents(),
                }
            return graph

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    def summary(self) -> dict:
        with self._lock:
            total = len(self._engines)
            states = {}
            healths = {}
            for engine in self._engines.values():
                s = engine.state.value
                h = engine.health.value
                states[s] = states.get(s, 0) + 1
                healths[h] = healths.get(h, 0) + 1

            overall = "HEALTHY"
            if healths.get("UNHEALTHY", 0) > 0:
                overall = "ERROR"
            elif healths.get("DEGRADED", 0) > 0:
                overall = "DEGRADED"
            elif healths.get("UNKNOWN", 0) > 0 and healths.get("HEALTHY", 0) == 0:
                overall = "UNKNOWN"

            return {
                "overall": overall,
                "total": total,
                "states": states,
                "healths": healths,
                "registeredAt": self._registered_at,
            }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _check_dependencies(self, engine_id: str) -> str | None:
        engine = self.get(engine_id)
        if not engine:
            return f"engine '{engine_id}' not found"
        for dep_id in engine.get_dependencies():
            dep = self.get(dep_id)
            if not dep:
                return f"dependency '{dep_id}' is not registered"
            if dep.state in (EngineState.STOPPED, EngineState.ERROR, EngineState.DISABLED):
                return f"dependency '{dep_id}' is in state {dep.state.value}"
        return None

    def _safety_check(self, engine_id: str) -> str | None:
        """Safety gate: warn before stopping engines with active work."""
        engine = self.get(engine_id)
        if not engine:
            return None

        if engine_id == "position_engine":
            return "Stopping Position Engine while positions may be open requires confirmation"
        if engine_id == "order_engine":
            return "Stopping Order Engine while orders may be pending requires confirmation"
        if engine_id == "websocket_engine":
            from services import market_calendar
            if market_calendar.market_status() == "OPEN":
                return "Stopping WebSocket Engine during market hours requires confirmation"
        if engine_id == "connection_manager":
            return "Stopping Connection Manager while subscriptions may be active requires confirmation"
        if engine_id == "squareoff_engine":
            return "Triggering or stopping Square-Off Engine requires confirmation"
        return None

    def _notify_dependents(self, engine_id: str, event: str) -> None:
        with self._lock:
            for engine in self._engines.values():
                if engine_id in engine.get_dependencies():
                    engine._record_activity(
                        f"dependency_{event}",
                        f"dependency '{engine_id}' {event}",
                    )


# Module singleton
_registry: EngineRegistry | None = None


def get_engine_registry() -> EngineRegistry:
    global _registry
    if _registry is None:
        _registry = EngineRegistry()
    return _registry
