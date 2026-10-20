"""FastAPI request telemetry — real per-minute API metrics.

Produced by an HTTP middleware in ``app.py``, accumulated in memory per
(route, minute bucket), and persisted to the MongoDB ``api_telemetry``
collection on a fixed cadence (see ``flush_and_reset``).

Strictly sanitized: only the method, route template, status-class counters,
average latency and a DB-flag are stored — never query strings, headers,
cookies, auth tokens or request bodies.

Consumed by ``services.ds_insights.api_telemetry_summary`` (percentiles,
success rates, per-endpoint breakdown) and the report/type-report layer.
"""
from __future__ import annotations

import asyncio
import bisect
import logging
import time
from datetime import datetime, timezone
from threading import Lock

logger = logging.getLogger("api_telemetry")

# Flusher lifecycle state (real in-process signal for the Data Center workers
# panel — NOT a fabricated health value).
_flusher_task: asyncio.Task | None = None
_flusher_running = False
_last_flush_at: str | None = None

# One accumulator per (minute-bucket, route).
_ACCUM: dict[tuple[str, str], dict] = {}
_LOCK = Lock()

# Latency histogram edges (ms). A latency falls into the smallest edge >= it.
# Bucket label = edge (e.g. 100 ms); `mid` is the midpoint to the next edge.
HISTOGRAM_EDGES_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000]


def _minute_bucket(now: datetime) -> str:
    return now.strftime("%Y-%m-%dT%H:%M")


def _histogram_bucket(latency_ms: float) -> int:
    return HISTOGRAM_EDGES_MS[bisect.bisect_left(HISTOGRAM_EDGES_MS, latency_ms)] \
        if latency_ms < HISTOGRAM_EDGES_MS[-1] else HISTOGRAM_EDGES_MS[-1]


def record_request(method: str, route: str, status_code: int,
                   duration_ms: float, *, db_related: bool = False) -> None:
    """Accumulate one completed request (thread-safe, non-blocking).

    ``route`` must be the sanitized route template (never a raw path with
    query strings or tokens baked in). ``status_code`` is the final status.
    """
    if not route:
        route = "/unknown"
    now = datetime.now(timezone.utc)
    bucket = _minute_bucket(now)
    key = (bucket, route)
    is_error = status_code >= 500 or (400 <= status_code < 500 and status_code != 404)
    is_4xx = 400 <= status_code < 500
    is_5xx = status_code >= 500
    histogram_key = _histogram_bucket(duration_ms)
    edges = HISTOGRAM_EDGES_MS
    idx = edges.index(histogram_key)
    mid = (edges[idx] + (edges[idx + 1] if idx + 1 < len(edges) else edges[idx] * 2)) / 2
    with _LOCK:
        acc = _ACCUM.get(key)
        if acc is None:
            acc = {
                "requests": 0, "errors": 0, "clientErrors": 0, "serverErrors": 0,
                "sum_latency_ms": 0.0, "num_latency": 0,
                "db_related_failures": 0,
                "latency_bucket": {},
            }
            _ACCUM[key] = acc
        acc["requests"] += 1
        if is_error:
            acc["errors"] += 1
        if is_4xx:
            acc["clientErrors"] += 1
        if is_5xx:
            acc["serverErrors"] += 1
        if db_related:
            acc["db_related_failures"] += 1
        acc["sum_latency_ms"] += duration_ms
        acc["num_latency"] += 1
        hb = acc["latency_bucket"]
        hb[histogram_key] = hb.get(histogram_key, 0) + 1


def _accum_to_docs() -> dict[tuple[str, str], dict]:
    """Snapshot and clear the in-memory accumulators (single writer)."""
    global _ACCUM
    with _LOCK:
        if not _ACCUM:
            return {}
        snapshot = {
            (bucket, route): {
                **acc,
                "latency_bucket": dict(acc["latency_bucket"]),
            }
            for (bucket, route), acc in _ACCUM.items()
        }
        _ACCUM = {}
    return snapshot


async def flush_and_reset() -> int:
    """Persist the accumulated buckets to MongoDB (called on the app loop).

    One document per (minute, route), written idempotently via ``$set`` so
    repeated flushes of the same bucket are harmless. Returns the number of
    documents written. Non-fatal when MongoDB is unavailable.
    """
    snapshot = _accum_to_docs()
    if not snapshot:
        return 0
    try:
        from database.connection import get_db, is_mongo_connected
        if not is_mongo_connected():
            return 0
        db = get_db()
    except Exception:
        return 0
    count = 0
    now = datetime.now(timezone.utc)
    for (bucket, route), acc in snapshot.items():
        try:
            hist = [{"bucket": edge, "mid": _mid(edge), "count": acc["latency_bucket"].get(edge, 0)}
                    for edge in HISTOGRAM_EDGES_MS]
            hist = [h for h in hist if h["count"] > 0]
            nb = acc["num_latency"]
            doc = {
                "bucket": bucket, "ts": now, "route": route,
                "requests": acc["requests"], "errors": acc["errors"],
                "clientErrors": acc["clientErrors"], "serverErrors": acc["serverErrors"],
                "avg_latency_ms": round(acc["sum_latency_ms"] / nb, 2) if nb else None,
                "num_latency": nb, "sum_latency_ms": round(acc["sum_latency_ms"], 2),
                "latency_bucket": hist,
                "db_related": acc["db_related_failures"] > 0,
            }
            await db["api_telemetry"].update_one(
                {"bucket": bucket, "route": route},
                {"$set": doc},
                upsert=True,
            )
            count += 1
        except Exception:
            logger.debug("api_telemetry flush row failed: %s", route, exc_info=True)
    return count


def _mid(edge: int) -> float:
    idx = HISTOGRAM_EDGES_MS.index(edge)
    nxt = HISTOGRAM_EDGES_MS[idx + 1] if idx + 1 < len(HISTOGRAM_EDGES_MS) else edge * 2
    return (edge + nxt) / 2


async def _background_flusher(interval_seconds: int = 60) -> None:
    """Periodic flusher run by the app loop (cancelled on shutdown)."""
    global _flusher_running, _last_flush_at
    _flusher_running = True
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await flush_and_reset()
            _last_flush_at = datetime.now(timezone.utc).isoformat()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("api telemetry flush skipped", exc_info=True)


def start_flusher(interval_seconds: int = 60) -> asyncio.Task:
    """Start the background flusher; returns the task (cancel on shutdown)."""
    global _flusher_task, _flusher_running
    _flusher_running = True
    _flusher_task = asyncio.get_event_loop().create_task(_background_flusher(interval_seconds))
    return _flusher_task


def flusher_status() -> dict:
    """Real in-process flusher state for the Data Center workers panel."""
    task = _flusher_task
    return {
        "running": bool(_flusher_running),
        "taskActive": bool(task is not None and not task.done()),
        "lastFlushAt": _last_flush_at,
    }