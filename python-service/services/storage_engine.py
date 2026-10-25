"""Storage Engine — infrastructure, runtime, storage and health observability.

Target contract: ``docs/engines/storage-engine.md`` (Advanced UI + Engine
Detailed Design). The Storage Engine is the project's **infrastructure-state,
runtime-health, resource-monitoring and storage-observability** authority. It
is explicitly NOT the owner of orders, positions, P&L, risk, broker execution
or business data.

What this engine owns
---------------------
- host resource monitoring (CPU / RAM / disk / network / load / uptime)
- backend runtime monitoring (PID, threads, CPU, memory, runtime, uptime)
- application-level health (host healthy does not imply app healthy)
- engine health aggregation (from the Engine Registry — read only)
- database/storage health (Mongo connectivity, read latency, write latency,
  queue/backlog, pending/failed writes from the persistence pipeline)
- current state + bounded short-interval history
- meaningful infrastructure events (threshold with duration, transitions)
- monitoring configuration + retention policy (validated + persisted)

What this engine does NOT own
-----------------------------
- order execution, risk decisions, P&L, position authority
- broker login/execution, trading strategy, AI decisions
- notification policy (it emits events; Notification Engine decides policy)
- audit ownership (it forwards meaningful events; Audit Engine owns the trail)
- persistence pipelines (DB Writer Engine owns application-data persistence;
  this engine only *observes* the pipeline's health)

Migration note
--------------
The previous ``StorageEngine`` was an unused audit write-queue (``write()`` had
no callers). That responsibility is now served by ``db_writer_engine`` +
``audit_engine``. Compatibility methods (``write`` / ``write_many`` / ``query``
/ ``queue_size``) are retained as thin, real shims to avoid breaking any
dynamic caller.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import socket
import sys
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Optional

from core.engines.engine_base import (
    EngineBase,
    EngineHealth,
    EngineCategory,
    EngineState,
)
from core.engines.engine_config import ConfigField

try:  # psutil is a declared dependency (requirements.txt) but never fatal.
    import psutil  # type: ignore
except Exception:  # pragma: no cover - import guard
    psutil = None  # type: ignore

logger = logging.getLogger("app.storage_engine")


# Infrastructure event types (meaningful transitions only — not raw samples).
class InfraEvents:
    BACKEND_STARTED = "BACKEND_STARTED"
    BACKEND_STOPPED = "BACKEND_STOPPED"
    HOST_CPU_HIGH = "HOST_CPU_HIGH"
    HOST_CPU_RECOVERED = "HOST_CPU_RECOVERED"
    HOST_MEMORY_HIGH = "HOST_MEMORY_HIGH"
    HOST_MEMORY_RECOVERED = "HOST_MEMORY_RECOVERED"
    DISK_SPACE_LOW = "DISK_SPACE_LOW"
    DISK_SPACE_CRITICAL = "DISK_SPACE_CRITICAL"
    DISK_SPACE_RECOVERED = "DISK_SPACE_RECOVERED"
    DATABASE_DISCONNECTED = "DATABASE_DISCONNECTED"
    DATABASE_RECONNECTED = "DATABASE_RECONNECTED"
    DATABASE_LATENCY_HIGH = "DATABASE_LATENCY_HIGH"
    DATABASE_LATENCY_RECOVERED = "DATABASE_LATENCY_RECOVERED"
    WRITE_BACKLOG_HIGH = "WRITE_BACKLOG_HIGH"
    WRITE_BACKLOG_RECOVERED = "WRITE_BACKLOG_RECOVERED"
    WRITE_FAILURE = "WRITE_FAILURE"
    ENGINE_DEGRADED = "ENGINE_DEGRADED"
    ENGINE_RECOVERED = "ENGINE_RECOVERED"


# Default configuration — every value validated + persisted (no magic numbers
# hard-coded inside collectors; collectors read from ``self._config``).
DEFAULT_CONFIG: dict[str, Any] = {
    "monitoringEnabled": True,
    "sampleIntervalSeconds": 5,
    "historyMax": 720,                 # bounded in-memory short-interval snapshots
    "retentionSeconds": 86400,         # history older than this is eligible for trim
    "thresholdDurationSamples": 3,     # a breach must persist N samples
    "cpuWarnPct": 85.0,
    "cpuCritPct": 95.0,
    "memWarnPct": 85.0,
    "memCritPct": 95.0,
    "diskWarnPct": 85.0,
    "diskCritPct": 95.0,
    "queueWarn": 5000,
    "queueCrit": 9000,
    "latencyWarnMs": 250.0,
    "latencyCritMs": 1000.0,
    "databasePingEnabled": True,
    "networkMetricsEnabled": True,
    "engineHealthAggregationEnabled": True,
}


def _iso(value: float | None) -> Optional[str]:
    if not value:
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    except Exception:
        return None


def _round(value: Any, digits: int = 1) -> Optional[float]:
    try:
        if value is None:
            return None
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


class StorageEngine(EngineBase):
    engine_id = "storage_engine"
    engine_name = "Storage Engine"
    engine_category = EngineCategory.STORAGE
    engine_version = "2.0.0"

    # Every knob maps to the engine's OWN persisted config (engine_config
    # collection), written through _write_settings below — so this channel and
    # /api/services/storage/config are the same store, never two.
    config_fields = (
        ConfigField(key="stg_monitoring_enabled", label="Monitoring", summary="monitoringEnabled",
                    type="boolean", group="Sampling"),
        ConfigField(key="stg_sample_interval_seconds", label="Sample Interval", summary="sampleIntervalSeconds",
                    type="number", min=1, max=300, unit="s", group="Sampling"),
        ConfigField(key="stg_history_max", label="History Samples", summary="historyMax",
                    type="number", min=10, max=100000, group="Sampling"),
        ConfigField(key="stg_retention_seconds", label="Retention", summary="retentionSeconds",
                    type="number", min=60, max=2592000, unit="s", group="Sampling"),
        ConfigField(key="stg_threshold_duration_samples", label="Breach Must Persist",
                    summary="thresholdDurationSamples", type="number", min=1, max=100,
                    group="Sampling", help="Consecutive samples a breach must hold before it alerts."),
        ConfigField(key="stg_cpu_warn_pct", label="CPU Warn", summary="cpuWarnPct",
                    type="number", min=1, max=100, unit="%", group="Thresholds"),
        ConfigField(key="stg_cpu_crit_pct", label="CPU Critical", summary="cpuCritPct",
                    type="number", min=1, max=100, unit="%", group="Thresholds"),
        ConfigField(key="stg_mem_warn_pct", label="Memory Warn", summary="memWarnPct",
                    type="number", min=1, max=100, unit="%", group="Thresholds"),
        ConfigField(key="stg_mem_crit_pct", label="Memory Critical", summary="memCritPct",
                    type="number", min=1, max=100, unit="%", group="Thresholds"),
        ConfigField(key="stg_disk_warn_pct", label="Disk Warn", summary="diskWarnPct",
                    type="number", min=1, max=100, unit="%", group="Thresholds"),
        ConfigField(key="stg_disk_crit_pct", label="Disk Critical", summary="diskCritPct",
                    type="number", min=1, max=100, unit="%", group="Thresholds"),
        ConfigField(key="stg_queue_warn", label="Queue Warn", summary="queueWarn",
                    type="number", min=1, max=1000000, group="Thresholds"),
        ConfigField(key="stg_queue_crit", label="Queue Critical", summary="queueCrit",
                    type="number", min=1, max=1000000, group="Thresholds"),
        ConfigField(key="stg_latency_warn_ms", label="Latency Warn", summary="latencyWarnMs",
                    type="number", min=1, max=60000, unit="ms", group="Thresholds"),
        ConfigField(key="stg_latency_crit_ms", label="Latency Critical", summary="latencyCritMs",
                    type="number", min=1, max=120000, unit="ms", group="Thresholds"),
        ConfigField(key="stg_database_ping_enabled", label="Ping Database", summary="databasePingEnabled",
                    type="boolean", group="Collectors"),
        ConfigField(key="stg_network_metrics_enabled", label="Network Metrics", summary="networkMetricsEnabled",
                    type="boolean", group="Collectors"),
        ConfigField(key="stg_engine_health_aggregation_enabled", label="Aggregate Engine Health",
                    summary="engineHealthAggregationEnabled", type="boolean", group="Collectors"),
    )

    async def _write_settings(self, clean: dict) -> tuple[dict, dict]:
        """Persist through this engine's own validated, durable config store."""
        try:
            result = await self.update_config(clean, persist=True)
        except Exception as exc:
            return {}, {key: str(exc) for key in clean}
        errors = result.get("errors") if isinstance(result, dict) else None
        if errors:
            return {}, {str(k): str(v) for k, v in (errors.items() if isinstance(errors, dict) else enumerate(errors))}
        return dict(clean), {}

    def __init__(self) -> None:
        super().__init__()
        self._config: dict[str, Any] = dict(DEFAULT_CONFIG)
        self._sample_task: asyncio.Task | None = None
        self._history: deque[dict] = deque(maxlen=int(DEFAULT_CONFIG["historyMax"]))
        self._events: deque[dict] = deque(maxlen=200)
        self._latest: dict[str, Any] = {}
        self._breach_count: dict[str, int] = {}
        self._breach_level: dict[str, str] = {}
        self._last_sample_at: float = 0.0
        self._last_sample_duration_ms: float = 0.0
        self._sample_errors: int = 0
        # Legacy compatibility counters (read by DB Writer Engine status).
        self._write_count: int = 0
        self._error_count: int = 0
        self._started_at_monotonic: float = 0.0
        self._process: Any = None

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def _on_start(self) -> None:
        self._started_at_monotonic = time.monotonic()
        self._process = psutil.Process(os.getpid()) if psutil else None
        if self._process is not None:
            try:
                # Prime cpu_percent so the first sample is not "0.0".
                self._process.cpu_percent(interval=None)
            except Exception:
                pass
        await self._load_config()
        self._sync_config_summary()
        if self._sample_task is None or self._sample_task.done():
            self._sample_task = asyncio.create_task(self._sample_loop())
        self.record_event()
        logger.info(
            "[STORAGE] engine started (sample every %ss)",
            self._config.get("sampleIntervalSeconds"),
        )

    async def _on_stop(self) -> None:
        task = self._sample_task
        self._sample_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        logger.info("[STORAGE] engine stopped")

    # ------------------------------------------------------------------ #
    # Sampling
    # ------------------------------------------------------------------ #
    async def _sample_loop(self) -> None:
        while True:
            interval = max(1, int(self._config.get("sampleIntervalSeconds", 5)))
            try:
                if self._config.get("monitoringEnabled", True):
                    await self.sample_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._sample_errors += 1
                self.record_error("sample_error", str(exc))
            await asyncio.sleep(interval)

    async def sample_once(self) -> dict[str, Any]:
        """Collect one normalized infrastructure snapshot."""
        started = time.monotonic()
        state = await asyncio.to_thread(self._collect_blocking)
        try:
            db_state = await self._collect_database()
        except Exception as exc:
            db_state = {"status": "UNAVAILABLE", "reason": str(exc)}
        state["database"] = db_state
        state["engines"] = self._aggregate_engines()
        state["application"] = self._application_health(state)
        state["updatedAt"] = datetime.now(timezone.utc).isoformat()
        state["host"]["uptimeSeconds"] = state["host"].get("uptimeSeconds")

        self._latest = state
        self._last_sample_at = time.time()
        self._last_sample_duration_ms = (time.monotonic() - started) * 1000.0
        self.set_metric("lastSampleDurationMs", round(self._last_sample_duration_ms, 2))
        self.set_metric("historyLength", len(self._history))
        self.set_metric("sampleErrors", self._sample_errors)
        self.set_metric("lastSampleAt", _iso(self._last_sample_at))

        self._append_history(state)
        self._evaluate_thresholds(state)
        self.heartbeat()
        return state

    def _append_history(self, state: dict[str, Any]) -> None:
        host = state.get("host", {})
        runtime = state.get("runtime", {})
        db = state.get("database", {})
        snapshot = {
            "ts": state.get("updatedAt"),
            "cpuPct": (host.get("cpu") or {}).get("usagePct"),
            "memPct": (host.get("memory") or {}).get("usagePct"),
            "diskPct": (host.get("disk") or {}).get("usagePct"),
            "netRxBytes": (host.get("network") or {}).get("rxBytes"),
            "netTxBytes": (host.get("network") or {}).get("txBytes"),
            "processMemMb": runtime.get("memoryMb"),
            "processCpuPct": runtime.get("cpuPct"),
            "queueDepth": db.get("queueDepth"),
            "dbReadLatencyMs": db.get("readLatencyMs"),
            "applicationState": (state.get("application") or {}).get("state"),
        }
        self._history.append(snapshot)
        self._trim_history()

    def _trim_history(self) -> None:
        retention = int(self._config.get("retentionSeconds", 86400))
        if retention <= 0:
            return
        cutoff = time.time() - retention
        while self._history:
            ts = self._history[0].get("ts")
            try:
                age = datetime.fromisoformat(ts).timestamp() if ts else 0
            except Exception:
                age = 0
            if age and age < cutoff:
                self._history.popleft()
            else:
                break

    # ------------------------------------------------------------------ #
    # Collectors
    # ------------------------------------------------------------------ #
    def _collect_blocking(self) -> dict[str, Any]:
        """psutil/platform collection in a worker thread (never block loop)."""
        state: dict[str, Any] = {
            "environment": self._environment(),
            "host": {
                "cpu": self._cpu_state(),
                "memory": self._memory_state(),
                "disk": self._disk_state(),
                "network": self._network_state(),
                "load": self._load_state(),
                "uptimeSeconds": self._host_uptime(),
            },
            "runtime": self._runtime_state(),
            "database": {},
            "engines": [],
            "application": {},
            "updatedAt": None,
        }
        return state

    def _environment(self) -> dict[str, Any]:
        env_type = "LOCALHOST"
        container_id = os.environ.get("HOSTNAME") if os.path.exists("/.dockerenv") else None
        if os.path.exists("/.dockerenv") or os.environ.get("KUBERNETES_SERVICE_HOST"):
            env_type = "CONTAINER"
        elif os.environ.get("WEBSITE_SITE_NAME") or os.environ.get("AWS_EXECUTION_ENV"):
            env_type = "CLOUD_RUNTIME"
        hostname = None
        try:
            hostname = socket.gethostname()
        except Exception:
            pass
        return {
            "type": env_type,
            "hostname": hostname,
            "instanceId": os.environ.get("INSTANCE_ID") or os.environ.get("HOSTNAME"),
            "containerId": container_id,
            "processId": os.getpid(),
            "runtime": "python",
            "runtimeVersion": platform.python_version(),
            "os": platform.system(),
            "architecture": platform.machine(),
            "timezone": time.tzname[0] if time.tzname else None,
            "startTime": _iso(self._started_at_monotonic and time.time() - (time.monotonic() - self._started_at_monotonic)),
        }

    def _cpu_state(self) -> dict[str, Any]:
        if psutil is None:
            return {"status": "UNAVAILABLE", "reason": "psutil not installed"}
        try:
            usage = psutil.cpu_percent(interval=0.1)
            times = psutil.cpu_times_percent(interval=None)
            freq = None
            try:
                freqs = psutil.cpu_freq()
                freq = _round(freqs.current, 0) if freqs else None
            except Exception:
                freq = None
            return {
                "status": "AVAILABLE",
                "usagePct": _round(usage),
                "userPct": _round(getattr(times, "user", None)),
                "systemPct": _round(getattr(times, "system", None)),
                "idlePct": _round(getattr(times, "idle", None)),
                "logicalCores": psutil.cpu_count(logical=True),
                "physicalCores": psutil.cpu_count(logical=False),
                "frequencyMhz": freq,
            }
        except Exception as exc:
            return {"status": "UNAVAILABLE", "reason": str(exc)}

    def _memory_state(self) -> dict[str, Any]:
        if psutil is None:
            return {"status": "UNAVAILABLE", "reason": "psutil not installed"}
        try:
            vm = psutil.virtual_memory()
            swap = psutil.swap_memory()
            return {
                "status": "AVAILABLE",
                "totalBytes": vm.total,
                "usedBytes": vm.used,
                "availableBytes": vm.available,
                "usagePct": _round(vm.percent),
                "swapTotalBytes": swap.total,
                "swapUsedBytes": swap.used,
                "swapUsagePct": _round(swap.percent),
            }
        except Exception as exc:
            return {"status": "UNAVAILABLE", "reason": str(exc)}

    def _disk_state(self) -> dict[str, Any]:
        if psutil is None:
            return {"status": "UNAVAILABLE", "reason": "psutil not installed"}
        try:
            root = os.getcwd()
            usage = psutil.disk_usage(root)
            io = None
            try:
                counters = psutil.disk_io_counters()
                if counters:
                    io = {
                        "readBytes": counters.read_bytes,
                        "writeBytes": counters.write_bytes,
                        "readCount": counters.read_count,
                        "writeCount": counters.write_count,
                    }
            except Exception:
                io = None
            return {
                "status": "AVAILABLE",
                "path": root,
                "filesystem": os.path.splitdrive(root)[0] or "/",
                "totalBytes": usage.total,
                "usedBytes": usage.used,
                "freeBytes": usage.free,
                "usagePct": _round(usage.percent),
                "io": io,
            }
        except Exception as exc:
            return {"status": "UNAVAILABLE", "reason": str(exc)}

    def _network_state(self) -> dict[str, Any]:
        if psutil is None or not self._config.get("networkMetricsEnabled", True):
            return {"status": "UNAVAILABLE", "reason": "disabled" if psutil else "psutil not installed"}
        try:
            counters = psutil.net_io_counters()
            return {
                "status": "AVAILABLE",
                "rxBytes": counters.bytes_recv,
                "txBytes": counters.bytes_sent,
                "rxPackets": counters.packets_recv,
                "txPackets": counters.packets_sent,
                "errors": counters.errin + counters.errout,
                "drops": counters.dropin + counters.dropout,
            }
        except Exception as exc:
            return {"status": "UNAVAILABLE", "reason": str(exc)}

    def _load_state(self) -> dict[str, Any]:
        load = None
        if hasattr(os, "getloadavg"):
            try:
                load = os.getloadavg()
            except Exception:
                load = None
        if load is None:
            return {"status": "UNAVAILABLE", "reason": "unsupported on this OS"}
        return {
            "status": "AVAILABLE",
            "load1m": _round(load[0], 2),
            "load5m": _round(load[1], 2),
            "load15m": _round(load[2], 2),
        }

    def _host_uptime(self) -> Optional[float]:
        if psutil is None:
            return None
        try:
            return round(time.time() - psutil.boot_time(), 0)
        except Exception:
            return None

    def _runtime_state(self) -> dict[str, Any]:
        proc = self._process
        if proc is None and psutil is not None:
            try:
                proc = self._process = psutil.Process(os.getpid())
            except Exception:
                proc = None
        if proc is None:
            return {
                "status": "UNAVAILABLE",
                "reason": "psutil not installed",
                "pid": os.getpid(),
                "runtime": "python",
                "version": platform.python_version(),
                "uptimeSeconds": round(time.monotonic() - self._started_at_monotonic, 0),
            }
        state: dict[str, Any] = {
            "status": "RUNNING",
            "pid": proc.pid,
            "runtime": "python",
            "version": platform.python_version(),
            "workers": int(os.environ.get("WEB_CONCURRENCY", 1) or 1),
        }
        try:
            state["startTime"] = _iso(proc.create_time())
            state["uptimeSeconds"] = round(time.time() - proc.create_time(), 0)
        except Exception:
            state["startTime"] = None
            state["uptimeSeconds"] = round(time.monotonic() - self._started_at_monotonic, 0)
        for key, fn, digits in (
            ("cpuPct", lambda: proc.cpu_percent(interval=None), 1),
            ("memoryMb", lambda: proc.memory_info().rss / (1024 * 1024), 1),
            ("threads", lambda: proc.num_threads(), 0),
        ):
            try:
                state[key] = _round(fn(), digits)
            except Exception:
                state[key] = None
        try:
            state["openFds"] = proc.num_fds()
        except Exception:
            state["openFds"] = None  # Unsupported (Windows) — never fabricated.
        return state

    async def _collect_database(self) -> dict[str, Any]:
        from database.connection import get_db, is_mongo_connected

        connected = False
        try:
            connected = bool(is_mongo_connected())
        except Exception:
            connected = False

        read_latency_ms = None
        if connected and self._config.get("databasePingEnabled", True):
            try:
                db = get_db()
                started = time.monotonic()
                await asyncio.wait_for(db.command("ping"), timeout=3.0)
                read_latency_ms = round((time.monotonic() - started) * 1000, 2)
            except Exception as exc:
                connected = False
                self._record_event(self._make_event(
                    InfraEvents.DATABASE_DISCONNECTED, "critical",
                    f"MongoDB ping failed: {exc}",
                ))

        pipeline = self._persistence_pipeline()
        write_latency = pipeline.get("lastFlushDurationMs")
        queue_depth = pipeline.get("queueDepth")
        return {
            "status": "CONNECTED" if connected else "DISCONNECTED",
            "connected": connected,
            "readLatencyMs": read_latency_ms,
            "writeLatencyMs": write_latency,
            "queueDepth": queue_depth,
            "pendingWrites": pipeline.get("pendingWrites"),
            "failedWrites": pipeline.get("failedWrites"),
            "backlog": queue_depth,
            "writeRate": pipeline.get("writeRate"),
            "lastSuccessfulWriteAt": _iso(pipeline.get("lastWriteAt")),
            "lastFailure": pipeline.get("lastError"),
            "pipelineRunning": pipeline.get("pipelineRunning"),
        }

    def _persistence_pipeline(self) -> dict[str, Any]:
        """Observe (never own) the DB Writer persistence pipeline."""
        try:
            from services import tick_buffer

            stats = tick_buffer.stats()
            self._write_count = int(stats.get("totalWritten", 0) or 0)
            self._error_count = int(stats.get("totalWriteErrors", 0) or 0)
            return {
                "queueDepth": stats.get("bufferLength"),
                "pendingWrites": stats.get("bufferLength"),
                "totalWritten": stats.get("totalWritten"),
                "failedWrites": stats.get("totalWriteErrors"),
                "writeRate": stats.get("writesPerSecond"),
                "lastWriteAt": stats.get("lastWriteAt"),
                "lastFlushDurationMs": stats.get("lastFlushDurationMs"),
                "lastError": stats.get("lastError"),
                "pipelineRunning": bool(stats.get("pipelineRunning")),
            }
        except Exception as exc:
            logger.debug("persistence pipeline read failed: %s", exc)
            return {
                "queueDepth": None,
                "pendingWrites": None,
                "totalWritten": None,
                "failedWrites": None,
                "writeRate": None,
                "lastWriteAt": None,
                "lastFlushDurationMs": None,
                "lastError": str(exc),
                "pipelineRunning": None,
            }

    def _aggregate_engines(self) -> list[dict[str, Any]]:
        if not self._config.get("engineHealthAggregationEnabled", True):
            return []
        try:
            from services.engine_registry import get_engine_registry

            registry = get_engine_registry()
            rows: list[dict[str, Any]] = []
            now = time.time()
            for status in registry.get_all_statuses():
                hb = status.get("lastHeartbeat") or 0
                rows.append({
                    "engineId": status.get("engineId"),
                    "engineName": status.get("engineName"),
                    "state": status.get("state"),
                    "health": status.get("health"),
                    "healthReason": status.get("healthReason"),
                    "uptimeSeconds": status.get("startedAtAgo"),
                    "lastHeartbeatAt": _iso(hb),
                    "heartbeatAgeSeconds": round(now - hb, 1) if hb else None,
                    "lastError": (status.get("recentErrors") or [{}])[-1].get("message") if status.get("recentErrors") else None,
                    "version": status.get("version"),
                    "category": status.get("engineCategory"),
                    "stateOwner": "registry",
                })
            rows.sort(key=lambda r: (r.get("health") or "", r.get("engineId") or ""))
            return rows
        except Exception as exc:
            logger.debug("engine aggregation failed: %s", exc)
            return []

    def _application_health(self, state: dict[str, Any]) -> dict[str, Any]:
        reasons: list[str] = []
        level = "HEALTHY"

        db = state.get("database") or {}
        if db.get("status") != "CONNECTED":
            reasons.append("Database unreachable")
            level = "CRITICAL"
        else:
            latency = db.get("readLatencyMs")
            warn = float(self._config.get("latencyWarnMs", 250))
            if latency is not None and latency >= warn:
                reasons.append(f"Database read latency elevated ({latency} ms)")
                level = _max_level(level, "DEGRADED")

        deadline = int(self._config.get("queueCrit", 9000))
        depth = db.get("queueDepth")
        if depth is not None and depth >= deadline:
            reasons.append(f"Write backlog critical ({depth})")
            level = _max_level(level, "CRITICAL")

        for eng in state.get("engines", []):
            if eng.get("state") in (EngineState.ERROR.value, EngineState.DISCONNECTED.value):
                reasons.append(f"{eng.get('engineName') or eng.get('engineId')} in state {eng.get('state')}")
                level = _max_level(level, "DEGRADED")
            elif eng.get("health") == "UNHEALTHY":
                reasons.append(f"{eng.get('engineName') or eng.get('engineId')} unhealthy")
                level = _max_level(level, "DEGRADED")

        if not reasons:
            reasons.append("All monitored components nominal")
        return {"state": level, "reasons": reasons}

    # ------------------------------------------------------------------ #
    # Threshold evaluation (duration-aware)
    # ------------------------------------------------------------------ #
    def _threshold_rules(self) -> list[tuple[str, float | int | None, float, float, str, str]]:
        return [
            ("cpu", (self._latest.get("host", {}).get("cpu") or {}).get("usagePct"),
             float(self._config["cpuWarnPct"]), float(self._config["cpuCritPct"]),
             InfraEvents.HOST_CPU_HIGH, InfraEvents.HOST_CPU_RECOVERED),
            ("memory", (self._latest.get("host", {}).get("memory") or {}).get("usagePct"),
             float(self._config["memWarnPct"]), float(self._config["memCritPct"]),
             InfraEvents.HOST_MEMORY_HIGH, InfraEvents.HOST_MEMORY_RECOVERED),
            ("disk", (self._latest.get("host", {}).get("disk") or {}).get("usagePct"),
             float(self._config["diskWarnPct"]), float(self._config["diskCritPct"]),
             InfraEvents.DISK_SPACE_LOW, InfraEvents.DISK_SPACE_RECOVERED),
            ("queue", self._latest.get("database", {}).get("queueDepth"),
             float(self._config["queueWarn"]), float(self._config["queueCrit"]),
             InfraEvents.WRITE_BACKLOG_HIGH, InfraEvents.WRITE_BACKLOG_RECOVERED),
        ]

    def _evaluate_thresholds(self, state: dict[str, Any]) -> None:
        duration = max(1, int(self._config.get("thresholdDurationSamples", 3)))
        for key, value, warn, crit, high_event, recovered_event in self._threshold_rules():
            if value is None:
                continue
            value = float(value)
            raw = "NORMAL"
            if value >= crit:
                raw = "CRITICAL"
            elif value >= warn:
                raw = "WARNING"

            committed = self._breach_level.get(key, "NORMAL")
            if raw == committed:
                self._breach_count[key] = 0
                continue
            self._breach_count[key] = self._breach_count.get(key, 0) + 1
            if self._breach_count[key] < duration:
                continue
            # Committed transition after the breach persisted long enough.
            self._breach_level[key] = raw
            self._breach_count[key] = 0
            if raw == "NORMAL":
                self._emit_infra_event(recovered_event, "info",
                                       f"{key} recovered to {value}")
            else:
                severity = "critical" if raw == "CRITICAL" else "warning"
                self._emit_infra_event(high_event, severity,
                                       f"{key} {raw}: {value}")

    # ------------------------------------------------------------------ #
    # Events → Notification Engine + Audit + Engine Event Bus
    # ------------------------------------------------------------------ #
    def _make_event(self, event_type: str, severity: str, message: str,
                    meta: dict | None = None) -> dict:
        return {
            "type": event_type,
            "source": "storage_engine",
            "severity": severity,
            "message": message,
            "meta": meta or {},
            "ts": time.time(),
        }

    def _record_event(self, event: dict) -> None:
        event["id"] = f"infra-{int(event['ts'] * 1000)}-{len(self._events)}"
        self._events.append(event)
        self.record_warning(event["message"]) if event["severity"] in ("warning", "critical") else None

    def _emit_infra_event(self, event_type: str, severity: str, message: str,
                          meta: dict | None = None) -> None:
        event = self._make_event(event_type, severity, message, meta)
        self._record_event(event)
        # Notification Engine owns policy (severity/dedupe/cooldown/delivery).
        try:
            from services.notification_center import emit_event

            status = {"info": "info", "warning": "warning", "critical": "error"}.get(severity, "info")
            emit_event("storage_engine", event_type, status=status, message=message,
                       meta={"severity": severity, **(meta or {})})
        except Exception as exc:
            logger.debug("notification emit failed: %s", exc)
        # Engine Event Bus fan-out (async; safe from the sample task).
        try:
            from services.engine_event_bus import EngineEvent, get_event_bus

            self._schedule_event(EngineEvent(
                event_type=event_type,
                source_engine="storage_engine",
                data={"message": message, "severity": severity, **(meta or {})},
                severity=severity if severity in ("info", "warning", "error", "critical") else "info",
            ))
        except Exception as exc:
            logger.debug("engine event publish failed: %s", exc)

    def _schedule_event(self, event: Any) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        try:
            from services.engine_event_bus import get_event_bus

            loop.create_task(get_event_bus().publish(event))
        except Exception:
            pass

    # ------------------------------------------------------------------ #
    # Configuration (validated + persisted)
    # ------------------------------------------------------------------ #
    _NUMERIC_RANGES: dict[str, tuple[float, float, bool]] = {
        "sampleIntervalSeconds": (1, 300, True),
        "historyMax": (10, 10000, True),
        "retentionSeconds": (60, 604800, True),
        "thresholdDurationSamples": (1, 100, True),
        "cpuWarnPct": (1, 100, False),
        "cpuCritPct": (1, 100, False),
        "memWarnPct": (1, 100, False),
        "memCritPct": (1, 100, False),
        "diskWarnPct": (1, 100, False),
        "diskCritPct": (1, 100, False),
        "queueWarn": (0, 1_000_000, True),
        "queueCrit": (0, 1_000_000, True),
        "latencyWarnMs": (1, 60000, False),
        "latencyCritMs": (1, 600000, False),
    }
    _BOOL_KEYS = {
        "monitoringEnabled", "databasePingEnabled",
        "networkMetricsEnabled", "engineHealthAggregationEnabled",
    }

    def get_config(self) -> dict[str, Any]:
        return dict(self._config)

    def validate_config(self, patch: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        clean: dict[str, Any] = {}
        errors: list[str] = []
        if not isinstance(patch, dict):
            return {}, ["configuration payload must be an object"]
        for key, value in patch.items():
            if key in self._BOOL_KEYS:
                if not isinstance(value, bool):
                    errors.append(f"{key} must be a boolean")
                    continue
                clean[key] = value
            elif key in self._NUMERIC_RANGES:
                low, high, integral = self._NUMERIC_RANGES[key]
                try:
                    num = float(value)
                except (TypeError, ValueError):
                    errors.append(f"{key} must be numeric")
                    continue
                if num < low or num > high:
                    errors.append(f"{key} must be between {low} and {high}")
                    continue
                clean[key] = int(num) if integral else num
            else:
                errors.append(f"unknown configuration key '{key}'")
        # Cross-field sanity: critical must be >= warning.
        merged = {**self._config, **clean}
        for warn_key, crit_key in (
            ("cpuWarnPct", "cpuCritPct"),
            ("memWarnPct", "memCritPct"),
            ("diskWarnPct", "diskCritPct"),
            ("queueWarn", "queueCrit"),
            ("latencyWarnMs", "latencyCritMs"),
        ):
            if merged.get(crit_key) is not None and merged.get(warn_key) is not None:
                if float(merged[crit_key]) < float(merged[warn_key]):
                    errors.append(f"{crit_key} must be >= {warn_key}")
        return clean, errors

    async def update_config(self, patch: dict[str, Any], persist: bool = True) -> dict[str, Any]:
        clean, errors = self.validate_config(patch)
        if errors:
            return {"ok": False, "errors": errors}
        self._config.update(clean)
        self._sync_config_summary()
        # Resize history ring if requested.
        if "historyMax" in clean:
            self._history = deque(self._history, maxlen=int(clean["historyMax"]))
        if persist:
            await self._save_config()
        # Auditable config change (meaningful, not a routine sample).
        self._record_event(self._make_event(
            "INFRA_CONFIG_UPDATED", "info",
            f"Storage engine configuration updated: {', '.join(sorted(clean)) or 'no changes'}",
            {"changed": sorted(clean)},
        ))
        return {"ok": True, "config": self.get_config()}

    async def _load_config(self) -> None:
        try:
            from database.connection import get_db, is_mongo_connected

            if not is_mongo_connected():
                return
            doc = await get_db().engine_config.find_one({"_id": self.engine_id})
            if doc and isinstance(doc.get("config"), dict):
                clean, errors = self.validate_config(doc["config"])
                if not errors:
                    self._config.update(clean)
        except Exception as exc:
            logger.debug("storage config load failed: %s", exc)

    async def _save_config(self) -> None:
        try:
            from database.connection import get_db, is_mongo_connected

            if not is_mongo_connected():
                return
            await get_db().engine_config.replace_one(
                {"_id": self.engine_id},
                {
                    "_id": self.engine_id,
                    "config": self.get_config(),
                    "updatedAt": datetime.now(timezone.utc),
                },
                upsert=True,
            )
        except Exception as exc:
            logger.debug("storage config save failed: %s", exc)

    def _sync_config_summary(self) -> None:
        # Publish the SAME flat config `status_snapshot()` reports. It used to
        # publish a 4-key subset with the thresholds nested, so the Control
        # Center and the settings form disagreed about what the engine was
        # actually configured with.
        self.set_config_summary(dict(self._config))

    # ------------------------------------------------------------------ #
    # Public read surface
    # ------------------------------------------------------------------ #
    def current_state(self) -> dict[str, Any]:
        return self._latest or {"updatedAt": None, "status": "NO_DATA"}

    def history(self, limit: int = 120) -> list[dict]:
        limit = max(1, min(int(limit or 120), int(self._config.get("historyMax", 720))))
        return list(self._history)[-limit:]

    def events(self, limit: int = 50) -> list[dict]:
        limit = max(1, min(int(limit or 50), 200))
        return list(self._events)[-limit:]

    def persistence_pipeline(self) -> dict[str, Any]:
        """Public accessor for the DB Writer persistence pipeline snapshot.

        Observes (never owns) the tick_buffer pipeline state for the audit
        section of the DB Writer Engine status.
        """
        return self._persistence_pipeline()

    # ------------------------------------------------------------------ #
    # Health
    # ------------------------------------------------------------------ #
    async def _on_health_check(self) -> EngineHealth:
        if not self._config.get("monitoringEnabled", True):
            self._set_health(EngineHealth.UNKNOWN, "monitoring disabled")
            return self.health
        if not self._latest:
            self._set_health(EngineHealth.UNKNOWN, "no sample collected yet")
            return self.health
        if self._sample_errors:
            self._set_health(EngineHealth.DEGRADED, f"{self._sample_errors} sample error(s)")
            return self.health
        app = self._latest.get("application") or {}
        app_state = app.get("state")
        if app_state == "CRITICAL":
            self._set_health(EngineHealth.DEGRADED,
                             "; ".join(app.get("reasons") or ["application critical"]))
        elif app_state == "DEGRADED":
            self._set_health(EngineHealth.DEGRADED,
                             "; ".join(app.get("reasons") or ["application degraded"]))
        else:
            self._set_health(EngineHealth.HEALTHY, "infrastructure nominal")
        return self.health

    # ------------------------------------------------------------------ #
    # Compatibility shims (previous StorageEngine audit queue)
    # ------------------------------------------------------------------ #
    def queue_size(self) -> Optional[int]:
        """Legacy accessor — now reports the real persistence queue depth."""
        return self._persistence_pipeline().get("queueDepth")

    async def write(self, collection: str, doc: dict) -> bool:
        """DEPRECATED: Storage Engine no longer owns application-data writes.

        Retained as a real, guarded shim so any dynamic caller still persists —
        but trading-critical collections (ticks, positions, orders) are rejected
        here so callers must go through the canonical DbWriter/Audit path.
        Prefer ``audit_engine`` / ``db_writer_engine``.
        """
        trading_collections = {"ticks", "positions", "orders", "holdings", "trades", "market_data"}
        if str(collection).lower() in trading_collections:
            logger.error("StorageEngine.write() BLOCKED for trading collection %s — use db_writer_engine/audit_engine (provenance violation)", collection)
            self.record_error("legacy_write_blocked_trading", collection)
            return False
        logger.warning("StorageEngine.write() is deprecated; use db_writer/audit (collection=%s)", collection)
        try:
            from database.connection import get_db, is_mongo_connected

            if not is_mongo_connected():
                return False
            await get_db()[collection].insert_one(dict(doc))
            return True
        except Exception as exc:
            self.record_error("legacy_write_error", str(exc))
            return False

    async def write_many(self, collection: str, docs: list[dict]) -> bool:
        """DEPRECATED: see :meth:`write`."""
        trading_collections = {"ticks", "positions", "orders", "holdings", "trades", "market_data"}
        if str(collection).lower() in trading_collections:
            logger.error("StorageEngine.write_many() BLOCKED for trading collection %s — use db_writer_engine", collection)
            self.record_error("legacy_write_many_blocked_trading", collection)
            return False
        if not docs:
            return True
        logger.warning("StorageEngine.write_many() is deprecated; use db_writer/audit (collection=%s count=%d)", collection, len(docs))
        try:
            from database.connection import get_db, is_mongo_connected

            if not is_mongo_connected():
                return False
            await get_db()[collection].insert_many([dict(d) for d in docs], ordered=False)
            return True
        except Exception as exc:
            self.record_error("legacy_write_many_error", str(exc))
            return False

    async def query(self, collection: str, filter_dict: dict | None = None,
                    limit: int = 100) -> list[dict]:
        try:
            from database.connection import get_db

            cursor = get_db()[collection].find(filter_dict or {}).sort("ts", -1).limit(limit)
            return await cursor.to_list(length=limit)
        except Exception as exc:
            self.record_error("query_error", str(exc))
            return []

    # ------------------------------------------------------------------ #
    # Status snapshot
    # ------------------------------------------------------------------ #
    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        latest = self._latest
        base["configSummary"] = dict(self._config)
        base["metrics"]["custom"].update({
            "historyLength": len(self._history),
            "eventsCount": len(self._events),
            "sampleErrors": self._sample_errors,
            "lastSampleAt": _iso(self._last_sample_at),
            "lastSampleDurationMs": round(self._last_sample_duration_ms, 2),
        })
        if latest:
            base["latest"] = {
                "environment": latest.get("environment"),
                "host": latest.get("host"),
                "runtime": latest.get("runtime"),
                "database": latest.get("database"),
                "application": latest.get("application"),
                "thresholds": dict(self._breach_level),
                "updatedAt": latest.get("updatedAt"),
            }
        else:
            base["latest"] = None
        base["engines"] = (latest or {}).get("engines", [])
        return base


def _max_level(current: str, candidate: str) -> str:
    order = {"HEALTHY": 0, "DEGRADED": 1, "CRITICAL": 2}
    return candidate if order.get(candidate, 0) > order.get(current, 0) else current


# Module singleton
storage_engine = StorageEngine()
