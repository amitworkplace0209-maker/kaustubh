"""Data Center — consolidated observability service for the Data SAVer backend.

Builds the real-measurement snapshot consumed by the Data Center UI:

  * System + runtime health  (psutil / process, real)
  * MongoDB inventory + per-collection health (collstats, real)
  * Tick pipeline + live throughput (tick_buffer, real)
  * WebSocket feed state (ws_manager, real)
  * Scheduler state + real per-day run history (schedule_runs, real)
  * API request telemetry (api_telemetry, real)
  * Daily write history (real document counts from the collections)
  * Worker statuses (real in-process signal sources)
  * Persisted snapshots for storage/DB-growth trends (data_center_snapshots)

Every value is derived from real sources. Anything that cannot be measured for
a historical window is surfaced as ``None`` so the frontend can render an honest
"unavailable" state instead of a fabricated number.

Health thresholds are centralized below as documented module constants.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from database.connection import get_db, is_mongo_connected

logger = logging.getLogger("data_center")

from core.timezones import IST
IST_TZ = "Asia/Kolkata"
NOW_UTC: Any = lambda: datetime.now(timezone.utc)

SNAPSHOT_COLL = "data_center_snapshots"
SNAPSHOT_INTERVAL_SEC = 600  # background capture cadence (10 minutes)
TREND_DAYS = 14              # default history window exposed by the snapshot API

# --------------------------------------------------------------------------- #
# Documented health thresholds
# --------------------------------------------------------------------------- #
# A time-series collection whose newest record is older than this (seconds)
# is considered STALE — no writes landed for 7+ days.
STALE_AFTER_SECONDS = 7 * 24 * 3600
# A collection whose storage exceeds this is flagged HIGH_STORAGE.
HIGH_STORAGE_BYTES = 16 * 1024 * 1024  # 16 MB
# indexBytes / dataBytes ratio above this flags an INDEX_HEAVY collection
# (only meaningful once the collection is above HIGH_STORAGE_BYTES).
INDEX_HEAVY_RATIO = 0.5
# Disk used% thresholds (host filesystem).
DISK_WARNING_PCT = 75.0
DISK_CRITICAL_PCT = 90.0
# Mongo ping thresholds (ms) — snapshot / live probe.
LATENCY_WARNING_MS = 250.0
LATENCY_CRITICAL_MS = 600.0

# Snapshot-loop lifecycle (real in-process signal for the workers panel).
_snapshot_task: asyncio.Task | None = None

# ──────────────────────────────────────────────────────────────────────────── #
# Cheap TTL memoization for the EXPENSIVE pure-DB reads used by the overview |
# snapshot. These (daily_write_history / daily_symbols / storage_trend) are   |
# full multi-collection aggregations; without a cache the overview rebuilds   |
# them every poll and the Data Center endpoint becomes the 20s+ bottleneck.   |
# ──────────────────────────────────────────────────────────────────────────── #
_EXPENSIVE_TTL_SEC = 30.0
# key -> (monotonic, days, value)
_exp_cache: dict[str, tuple[float, int, object]] = {}
_CACHE_LOCK = asyncio.Lock()


async def _expensive(key: str, days: int, builder):
    """Run ``builder`` at most once per (key, days) within TTL — dedupes the
    heavy aggregation across concurrent overview rebuilds and polls."""
    cached = _exp_cache.get(key)
    if cached is not None:
        at, cached_days, value = cached
        if cached_days == days and time.monotonic() - at < _EXPENSIVE_TTL_SEC:
            return value

    async with _CACHE_LOCK:
        cached = _exp_cache.get(key)
        if cached is not None:
            at, cached_days, value = cached
            if cached_days == days and time.monotonic() - at < _EXPENSIVE_TTL_SEC:
                return value
        value = await builder()
        _exp_cache[key] = (time.monotonic(), days, value)
        return value
_snapshot_running = False
_last_snapshot_at: str | None = None
_last_snapshot_ok: bool | None = None


# --------------------------------------------------------------------------- #
# Time helpers (IST business-day windows)
# --------------------------------------------------------------------------- #
def _ist_day(dt: datetime) -> str:
    return dt.astimezone(IST).strftime("%Y-%m-%d")


def recent_days(n: int) -> list[str]:
    """Newest-first IST day strings ending today (used for history queries)."""
    today = datetime.now(IST).date()
    return [(today - timedelta(days=i)).isoformat() for i in range(n)]


def _day_utc_range(day: str) -> tuple[datetime, datetime]:
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=IST).astimezone(timezone.utc)
    return start, start + timedelta(days=1)


def _iso(v: Any) -> str | None:
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.astimezone(IST).isoformat()
    return str(v) if v is not None else None


# --------------------------------------------------------------------------- #
# Mongo helpers
# --------------------------------------------------------------------------- #
async def _ping_mongo() -> float | None:
    if not is_mongo_connected():
        return None
    try:
        db = get_db()
        start = time.monotonic()
        await asyncio.wait_for(db.command("ping"), timeout=3.0)
        return round((time.monotonic() - start) * 1000, 2)
    except Exception as exc:
        logger.debug("data_center ping failed: %s", exc)
        return None


async def _bounded_agg(coll, pipeline: list[dict], *, allow_disk_use: bool = False) -> list[dict]:
    """Run a pipeline with disk use allowed; returns [] on any failure (real, bounded)."""
    try:
        cursor = coll.aggregate(pipeline, allowDiskUse=allow_disk_use)
        return await cursor.to_list(length=5000)
    except Exception as exc:
        logger.debug("data_center aggregation failed on %s: %s", getattr(coll, "name", "?"), exc)
        return []


async def _count(coll, query: dict) -> int:
    try:
        return int(await coll.count_documents(query))
    except Exception as exc:
        logger.debug("data_center count failed on %s: %s", getattr(coll, "name", "?"), exc)
        return 0


async def _mongo_stats():
    """Cached real Mongo stats (10s TTL in api.system) — inventory + totals."""
    from api.system import mongo_stats
    return await mongo_stats()


async def _system_snapshot():
    from api.system import _system_snapshot as _sys_snap
    try:
        return await _sys_snap()
    except Exception as exc:
        logger.debug("data_center system snapshot failed: %s", exc)
        return {}


async def _storage_dir_sizes():
    from api.system import _storage_dir_sizes as _sds
    try:
        return await _sds()
    except Exception as exc:
        logger.debug("data_center storage dirs failed: %s", exc)
        return {"dirs": []}


# --------------------------------------------------------------------------- #
# Collection health (real collstats-derived)
# --------------------------------------------------------------------------- #
def collection_health(stat: dict) -> dict:
    """Derive a health status for one collection from real collstats data.

    Priority (first match wins): ERROR -> STALE -> INDEX_HEAVY ->
    HIGH_STORAGE -> HEALTHY. ``reasons`` lists every observed condition.
    """
    reasons: list[str] = []
    status = "HEALTHY"
    if not stat:
        return {"status": "UNKNOWN", "reasons": ["no statistics available"]}

    last_record = stat.get("lastRecord")
    if last_record:
        try:
            dt = datetime.fromisoformat(str(last_record))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            age = (NOW_UTC() - dt).total_seconds()
            if age > STALE_AFTER_SECONDS:
                status = "STALE"
                reasons.append(
                    f"no writes in {round(age / 86400)} day(s) (last record {last_record})"
                )
        except (ValueError, TypeError):
            pass

    storage = int(stat.get("storageBytes") or 0)
    data = int(stat.get("dataSizeBytes") or storage)
    index = int(stat.get("indexSizeBytes") or 0)
    index_heavy = storage >= HIGH_STORAGE_BYTES and data > 0 and index / data >= INDEX_HEAVY_RATIO
    if index_heavy:
        if status == "HEALTHY":
            status = "INDEX_HEAVY"
        reasons.append(
            f"index data ratio {index / data:.2f} ≥ {INDEX_HEAVY_RATIO}"
        )
    if storage >= HIGH_STORAGE_BYTES:
        if status == "HEALTHY":
            status = "HIGH_STORAGE"
        reasons.append(f"storage {storage} bytes ≥ {HIGH_STORAGE_BYTES / 1024 / 1024:.0f} MB")

    if not reasons:
        reasons.append("no anomalies observed")
    return {"status": status, "reasons": reasons}


# --------------------------------------------------------------------------- #
# Daily write history (real per-day counts from MongoDB)
# --------------------------------------------------------------------------- #
async def daily_write_history(days: int = TREND_DAYS) -> list[dict]:
    """Per-IST-day counts of real writes across the persisted collections.

    Sourced from indexed ``ts``/``business_date`` ranges so every row is a real
    document count — nothing is fabricated for empty/unmeasured days.

    Memoized for EXPENSIVE_TTL_SEC: this is a multi-collection aggregation and
    the overview snapshot calls it on every rebuild.
    """
    days = max(1, min(int(days), 365))
    return await _expensive("history", days, lambda: _daily_write_history_impl(days))


async def _daily_write_history_impl(days: int) -> list[dict]:
    days_list = list(reversed(recent_days(days)))
    start, _ = _day_utc_range(days_list[0])
    if days_list:
        _, max_window_end = _day_utc_range(days_list[-1])

    if not is_mongo_connected():
        return [{"date": d, "ticksWritten": None} for d in days_list]

    db = get_db()
    ist_date = {"$dateToString": {"date": "$ts", "timezone": IST_TZ, "format": "%Y-%m-%d"}}
    out = {d: {
        "date": d,
        "ticksWritten": 0,
        "schedulerRuns": 0,
        "schedulerCompleted": 0,
        "schedulerFailed": 0,
        "apiRequests": 0,
        "apiErrors": 0,
        "apiClientErrors": 0,
        "apiServerErrors": 0,
        "apiAvgLatencyMs": None,
        "downloads": 0,
        "auditEntries": 0,
        "systemEvents": 0,
        "summaryTotalWrites": None,
        "summaryTotalTicks": None,
        "summaryErrorCount": None,
        "summarySubscribedStocks": None,
        "approxSizeBytes": None,
    } for d in days_list}

    # ticks per day (indexed ts)
    rows = await _bounded_agg(db.ticks, [
        {"$match": {"ts": {"$gte": start, "$lt": max_window_end}}},
        {"$group": {"_id": ist_date, "n": {"$sum": 1}}},
    ])
    for r in rows:
        d = r.get("_id")
        if d in out:
            out[d]["ticksWritten"] = int(r.get("n") or 0)

    # Scheduler executions grouped by (business_date, status) — real persisted
    # runs from ``scheduler_runs`` (indexed on business_date + status). The
    # legacy ``schedule_runs`` collection stores DOWNLOAD backfill runs and has
    # no ``business_date`` field, so scheduler counts come from scheduler_runs
    # only (as validated against the live kaustubh database).
    rows = await _bounded_agg(db.scheduler_runs, [
        {"$match": {"business_date": {"$in": days_list}}},
        {"$group": {"_id": {"date": "$business_date", "status": "$status"}, "n": {"$sum": 1}}},
    ])
    for r in rows:
        g = r.get("_id") or {}
        d = g.get("date")
        if d in out:
            n = int(r.get("n") or 0)
            out[d]["schedulerRuns"] += n
            status = str(g.get("status") or "")
            if status in ("COMPLETED", "SUCCESS", "ok", "completed"):
                out[d]["schedulerCompleted"] += n
            elif status in ("FAILED", "ERROR", "failed"):
                out[d]["schedulerFailed"] += n

    # api_telemetry per day (indexed ts) — real request/error/latency sums
    rows = await _bounded_agg(db.api_telemetry, [
        {"$match": {"ts": {"$gte": start, "$lt": max_window_end}}},
        {"$group": {
            "_id": ist_date,
            "requests": {"$sum": "$requests"},
            "errors": {"$sum": "$errors"},
            "clientErrors": {"$sum": "$clientErrors"},
            "serverErrors": {"$sum": "$serverErrors"},
            "sum_latency_ms": {"$sum": "$sum_latency_ms"},
            "num_latency": {"$sum": "$num_latency"},
        }},
    ])
    for r in rows:
        d = r.get("_id")
        if d in out:
            out[d]["apiRequests"] = int(r.get("requests") or 0)
            out[d]["apiErrors"] = int(r.get("errors") or 0)
            out[d]["apiClientErrors"] = int(r.get("clientErrors") or 0)
            out[d]["apiServerErrors"] = int(r.get("serverErrors") or 0)
            nl = int(r.get("num_latency") or 0)
            if nl:
                out[d]["apiAvgLatencyMs"] = round(float(r.get("sum_latency_ms") or 0) / nl, 2)

    # download_history per day (indexed ts)
    rows = await _bounded_agg(db.download_history, [
        {"$match": {"ts": {"$gte": start, "$lt": max_window_end}}},
        {"$group": {"_id": ist_date, "n": {"$sum": 1}}},
    ])
    for r in rows:
        d = r.get("_id")
        if d in out:
            out[d]["downloads"] = int(r.get("n") or 0)

    # system_events per day (indexed ts)
    rows = await _bounded_agg(db.system_events, [
        {"$match": {"ts": {"$gte": start, "$lt": max_window_end}}},
        {"$group": {"_id": ist_date, "n": {"$sum": 1}}},
    ])
    for r in rows:
        d = r.get("_id")
        if d in out:
            out[d]["systemEvents"] = int(r.get("n") or 0)

    # audit_trail per day — `ts` is a UTC ISO string. Scope the query
    # lexicographically (same offset => stable ordering), then bucket each
    # timestamp into its IST day in python (audit volume is small).
    try:
        cursor = db.audit_trail.find(
            {"ts": {"$gte": start.isoformat(), "$lt": max_window_end.isoformat()}},
            {"ts": 1, "_id": 0},
        )
        async for doc in cursor:
            raw = doc.get("ts")
            if isinstance(raw, datetime):
                _dt = raw
            else:
                try:
                    _dt = datetime.fromisoformat(str(raw))
                except (ValueError, TypeError):
                    continue
            if _dt.tzinfo is None:
                _dt = _dt.replace(tzinfo=timezone.utc)
            d = _dt.astimezone(IST).strftime("%Y-%m-%d")
            if d in out:
                out[d]["auditEntries"] += 1
    except Exception as exc:
        logger.debug("audit per-day scan failed: %s", exc)

    # authoritative per-day summary counters (daily_summaries, unique date index)
    try:
        cursor = db.daily_summaries.find({"date": {"$in": days_list}})
        async for s in cursor:
            d = str(s.get("date") or "")
            if d in out:
                out[d]["summaryTotalWrites"] = int(s.get("totalWrites") or 0)
                out[d]["summaryTotalTicks"] = int(s.get("totalTicks") or 0)
                out[d]["summaryErrorCount"] = int(s.get("errorCount") or 0)
                if s.get("subscribedStocks") is not None:
                    out[d]["summarySubscribedStocks"] = int(s.get("subscribedStocks") or 0)
    except Exception as exc:
        logger.debug("daily_summaries fetch failed: %s", exc)

    # Approximate per-day tick payload size: real average tick object size from
    # collstats multiplied by the real per-day tick count. A missing average
    # (empty ticks collection) yields None — never a fabricated byte count.
    try:
        ticks_stats = await db.command("collstats", "ticks")
        avg_tick_bytes = ticks_stats.get("avgObjSize")
        if isinstance(avg_tick_bytes, (int, float)) and avg_tick_bytes > 0:
            for d in days_list:
                n = out[d]["ticksWritten"] or 0
                if n:
                    out[d]["approxSizeBytes"] = int(n * avg_tick_bytes)
    except Exception as exc:
        logger.debug("ticks collstats for daily size estimate failed: %s", exc)

    return [out[d] for d in days_list]


async def daily_symbols(days: int = TREND_DAYS) -> dict[str, int]:
    """Distinct tick symbols observed per IST day (real distinct aggregation).

    Memoized for EXPENSIVE_TTL_SEC — this full distinct aggregation over the
    tick window is the single most expensive read in the snapshot.
    """
    days = max(1, min(int(days), 365))
    return await _expensive("symbols", days, lambda: _daily_symbols_impl(days))


async def _daily_symbols_impl(days: int) -> dict[str, int]:
    if not is_mongo_connected():
        return {}
    days_list = list(reversed(recent_days(days)))
    start, _ = _day_utc_range(days_list[0])
    if days_list:
        _, max_window_end = _day_utc_range(days_list[-1])
    db = get_db()
    rows = await _bounded_agg(db.ticks, [
        {"$match": {"ts": {"$gte": start, "$lt": max_window_end}}},
        {"$group": {"_id": {
            "day": {"$dateToString": {"date": "$ts", "timezone": IST_TZ, "format": "%Y-%m-%d"}},
            "symbol": "$symbol",
        }}},
        {"$group": {"_id": "$_id.day", "n": {"$sum": 1}}},
    ], allow_disk_use=True)
    return {str(r.get("_id") or ""): int(r.get("n") or 0) for r in rows if r.get("_id")}


# --------------------------------------------------------------------------- #
# DB growth / storage trend — from persisted data_center_snapshots
# --------------------------------------------------------------------------- #
async def storage_trend(days: int = TREND_DAYS) -> list[dict]:
    """Chronological DB/storage growth points from persisted snapshots.

    Empty when snapshots have not yet been captured (honest "unavailable").
    Memoized for EXPENSIVE_TTL_SEC.
    """
    days = max(1, min(int(days), 365))
    return await _expensive("trend", days, lambda: _storage_trend_impl(days))


async def _storage_trend_impl(days: int) -> list[dict]:
    if not is_mongo_connected():
        return []
    try:
        db = get_db()
        cutoff = NOW_UTC() - timedelta(days=days)
        cursor = db[SNAPSHOT_COLL].find(
            {"ts": {"$gte": cutoff}},
            {"ts": 1, "istDay": 1, "db": 1, "storage": 1},
        ).sort("ts", 1)
        docs = await cursor.to_list(length=500)
    except Exception as exc:
        logger.debug("storage trend failed: %s", exc)
        return []
    out = []
    for d in docs:
        out.append({
            "ts": _iso(d.get("ts")),
            "istDay": d.get("istDay"),
            "dbTotalStorageBytes": (d.get("db") or {}).get("totalStorageBytes"),
            "dbTotalIndexBytes": (d.get("db") or {}).get("totalIndexSizeBytes"),
            "diskUsedBytes": (d.get("storage") or {}).get("diskUsedBytes"),
            "diskPercent": (d.get("storage") or {}).get("diskPercent"),
        })
    return out


# --------------------------------------------------------------------------- #
# Worker statuses (real in-process signal sources)
# --------------------------------------------------------------------------- #
async def workers_snapshot() -> list[dict]:
    """Status of every background worker from its real in-process source."""
    workers: list[dict] = []

    # Tick ingest pipeline
    try:
        from services.tick_buffer import stats as tb_stats
        s = tb_stats()
        workers.append({
            "id": "tick_pipeline",
            "name": "Tick Ingest Pipeline",
            "category": "events",
            "status": "RUNNING" if s.get("pipelineRunning") else "IDLE",
            "running": bool(s.get("pipelineRunning")),
            "lastHeartbeat": _iso_from_epoch(s.get("pipelineStartedAt")),
            "detail": {
                "totalReceived": s.get("totalReceived"),
                "totalWritten": s.get("totalWritten"),
                "totalWriteErrors": s.get("totalWriteErrors"),
                "bufferLength": s.get("bufferLength"),
                "ticksPerSecond": s.get("ticksPerSecond"),
                "writesPerSecond": s.get("writesPerSecond"),
                "lastWriteAt": _iso_from_epoch(s.get("lastWriteAt")),
                "activeTickStocks": s.get("activeTickStocks"),
            },
        })
    except Exception as exc:
        workers.append(_worker_error("tick_pipeline", "Tick Ingest Pipeline", exc))

    # Scheduler worker
    try:
        from scheduler import get_scheduler_info
        info = get_scheduler_info()
        workers.append({
            "id": "scheduler",
            "name": "Market Scheduler",
            "category": "scheduler",
            "status": "RUNNING" if info.get("running") else "IDLE",
            "running": bool(info.get("running")),
            "lastHeartbeat": info.get("state_updated_at"),
            "detail": {
                "state": info.get("state"),
                "nextAction": info.get("next_action"),
                "isTradingDay": info.get("is_trading_day"),
            },
        })
    except Exception as exc:
        workers.append(_worker_error("scheduler", "Market Scheduler", exc))

    # WebSocket supervisor
    try:
        from ws_socket.ws_manager import ws_manager
        ws = ws_manager.status()
        ws_connected = bool(ws.get("connected"))
        workers.append({
            "id": "ws_supervisor",
            "name": "WebSocket Supervisor",
            "category": "events",
            "status": "RUNNING" if ws_connected else "DEGRADED",
            "running": True,
            "lastHeartbeat": ws.get("last_message_at") or ws.get("connected_at"),
            "detail": {
                "connected": ws_connected,
                "lifecycleState": ws.get("lifecycle_state"),
                "feedState": ws.get("feed_state"),
                "subscribedSymbols": ws.get("subscribed_symbols"),
                "reconnectCount": ws.get("reconnect_count"),
                "disconnectReason": ws.get("disconnect_reason"),
                "diagnostics": ws.get("diagnostics"),
            },
        })
    except Exception as exc:
        workers.append(_worker_error("ws_supervisor", "WebSocket Supervisor", exc))

    # Export job worker
    try:
        from api.export_jobs import export_worker_status
        st = export_worker_status()
        st.setdefault("running", False)
        workers.append({
            "id": "export_worker",
            "name": "Export Job Worker",
            "category": "downloads",
            "status": "RUNNING" if st.get("running") else ("IDLE" if st.get("taskActive") else "NOT_STARTED"),
            "running": bool(st.get("running")),
            "lastHeartbeat": None,
            "detail": st,
        })
    except Exception as exc:
        workers.append(_worker_error("export_worker", "Export Job Worker", exc))

    # Scheduled downloads checker
    try:
        from api.scheduled_downloads import scheduled_downloads_checker_status
        st = scheduled_downloads_checker_status()
        workers.append({
            "id": "downloads_checker",
            "name": "Scheduled Downloads Checker",
            "category": "downloads",
            "status": "RUNNING" if st.get("running") else ("IDLE" if st.get("taskActive") else "NOT_STARTED"),
            "running": bool(st.get("running")),
            "lastHeartbeat": None,
            "detail": st,
        })
    except Exception as exc:
        workers.append(_worker_error("downloads_checker", "Scheduled Downloads Checker", exc))

    # API telemetry flusher
    try:
        from services.api_telemetry import flusher_status
        st = flusher_status()
        workers.append({
            "id": "api_telemetry_flusher",
            "name": "API Telemetry Flusher",
            "category": "telemetry",
            "status": "RUNNING" if st.get("taskActive") else "IDLE",
            "running": bool(st.get("taskActive")),
            "lastHeartbeat": st.get("lastFlushAt"),
            "detail": st,
        })
    except Exception as exc:
        workers.append(_worker_error("api_telemetry_flusher", "API Telemetry Flusher", exc))

    # Data Center snapshot loop (this service)
    workers.append({
        "id": "data_center_snapshot",
        "name": "Data Center Snapshot Loop",
        "category": "telemetry",
        "status": "RUNNING" if _snapshot_running else "IDLE",
        "running": bool(_snapshot_running),
        "lastHeartbeat": _last_snapshot_at,
        "detail": {"lastSnapshotOk": _last_snapshot_ok, "intervalSeconds": SNAPSHOT_INTERVAL_SEC},
    })

    return workers


def _worker_error(wid: str, name: str, exc: Exception) -> dict:
    return {
        "id": wid, "name": name, "category": "system",
        "status": "ERROR", "running": False, "lastHeartbeat": None,
        "detail": {"error": str(exc) or exc.__class__.__name__},
    }


def _iso_from_epoch(epoch_sec) -> str | None:
    try:
        v = float(epoch_sec)
        if v <= 0:
            return None
        return datetime.fromtimestamp(v, tz=IST).isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


# --------------------------------------------------------------------------- #
# Snapshot builder — the consolidated real-measurement overview
# --------------------------------------------------------------------------- #
async def build_snapshot(*, days: int = TREND_DAYS) -> dict:
    """The one consolidated overview payload for the Data Center page."""
    db = get_db() if is_mongo_connected() else None

    # Real mongo stats (cached 10s in api.system) + per-collection health
    mongo = await _mongo_stats()
    mongo_connected = bool(mongo.get("connected"))
    stats_list = (mongo.get("stats") or {}).get("collections") or []
    for c in stats_list:
        c["health"] = collection_health(c)

    # Real system runtime + storage dirs
    system = await _system_snapshot()
    storage_dirs = await _storage_dir_sizes()
    node = system.get("node") or {}
    buffer = system.get("buffer") or {}

    # Live latency probes (real, bounded)
    mongo_ping = await _ping_mongo()
    feed_latency = buffer.get("feedLatencyMs")

    # Scheduler info + real event history
    sched_info = system.get("schedulerInfo") or {}
    sched_state = system.get("schedulerState") or {}
    sched_running = bool(sched_info.get("running"))
    sched_schedule = {}
    try:
        from scheduler import get_schedule
        sched_schedule = get_schedule() or {}
    except Exception as exc:
        logger.debug("scheduler schedule failed: %s", exc)

    # Real daily write history rows
    history = await daily_write_history(days=days)
    symbols = await daily_symbols(days=days)
    for row in history:
        row["uniqueSymbols"] = symbols.get(row["date"], 0)

    # Storage trend from persisted snapshots (may be empty -> honest unavailable)
    trend = await storage_trend(days=days)

    # Real worker statuses
    workers = await workers_snapshot()

    # Real recent event trail (bounded)
    events_rows: list[dict] = []
    if db is not None:
        try:
            from api.system import _system_events_rows
            events_rows = await _system_events_rows(limit=200)
        except Exception as exc:
            logger.debug("events rows failed: %s", exc)

    # Ticks totals
    ticks_total = None
    ticks_today_ts = None
    try:
        if db is not None:
            ticks_total = await db.ticks.estimated_document_count()
            now = NOW_UTC()
            ticks_today_ts = await _count(
                db.ticks, {"ts": {"$gte": now.replace(hour=0, minute=0, second=0, microsecond=0)}}
            )
    except Exception as exc:
        logger.debug("ticks totals failed: %s", exc)

    # Real API telemetry summary (bounded window)
    api = await _api_summary(hours=24) if db is not None else None

    # Active incidents + open data quality issues (real)
    incidents_active = None
    quality_issues_active = None
    if db is not None:
        try:
            incidents_active = await _count(
                db["data_saver_incidents"], {"status": {"$in": ["open", "acknowledged"]}}
            )
        except Exception as exc:
            logger.debug("incidents failed: %s", exc)
            incidents_active = None
        try:
            from services.data_quality import count_active_issues
            opened, resolved = await count_active_issues()
            quality_issues_active = opened
        except Exception as exc:
            logger.debug("quality issues failed: %s", exc)
            quality_issues_active = None

    disk_percent = node.get("diskPercent")
    mongo_totals = mongo.get("stats") or {}

    return {
        "generatedAt": NOW_UTC().isoformat(),
        "istNow": _iso(NOW_UTC()),
        "mongo": {
            "connected": mongo_connected,
            # 'atlas' | 'local' — Data Center Database card. Never a URI.
            "source": mongo.get("source"),
            "pingMs": mongo_ping,
            "dbName": mongo_totals.get("dbName"),
            "collectionsCount": mongo_totals.get("collectionsCount"),
            "indexesCount": mongo_totals.get("indexesCount"),
            "totalObjects": mongo_totals.get("totalObjects"),
            "totalDataSizeBytes": mongo_totals.get("totalSizeBytes"),
            "totalStorageBytes": mongo_totals.get("totalStorageBytes"),
            "totalIndexSizeBytes": mongo_totals.get("totalIndexSizeBytes"),
            "collections": stats_list,
            "lastUpdatedAt": mongo_totals.get("lastUpdatedAt"),
        },
        "system": {
            "runtimeState": _runtime_state(),
            "uptimeSeconds": node.get("uptimeSeconds"),
            "cpuPercent": node.get("cpuPercent"),
            "cpuLoad1m": node.get("cpuLoad1m"),
            "ramPercent": node.get("ramPercent"),
            "ramTotalBytes": node.get("ramTotalBytes"),
            "ramUsedBytes": node.get("ramUsedBytes"),
            "diskPercent": disk_percent,
            "diskTotalBytes": node.get("diskTotalBytes"),
            "diskUsedBytes": node.get("diskUsedBytes"),
            "internet": bool(system.get("internetConnected")),
            "processStartedAt": _iso_from_epoch(_process_started_at()),
        },
        "pipeline": {
            "running": bool(buffer.get("pipelineRunning")),
            "totalReceived": buffer.get("totalReceived"),
            "totalWritten": buffer.get("totalWritten"),
            "totalWriteErrors": buffer.get("totalWriteErrors"),
            "bufferLength": buffer.get("bufferLength"),
            "ticksPerSecond": buffer.get("ticksPerSecond"),
            "writesPerSecond": buffer.get("writesPerSecond"),
            "activeTickStocks": buffer.get("activeTickStocks"),
            "startedAt": _iso_from_epoch(buffer.get("pipelineStartedAt")),
            "lastWriteAt": _iso_from_epoch(buffer.get("lastWriteAt")),
            "lastError": buffer.get("lastError"),
            "feedLatencyMs": feed_latency,
            "trend": buffer.get("tickRateTrend"),
        },
        "websocket": {
            "connected": bool(system.get("websocketConnected")),
            "lifecycleState": (system.get("websocketDetail") or {}).get("lifecycle_state"),
            "subscribedSymbols": (system.get("websocketDetail") or {}).get("subscribed_symbols"),
            "reconnectCount": (system.get("websocketDetail") or {}).get("reconnect_count"),
            "disconnectReason": system.get("wsDisconnectReason"),
        },
        "scheduler": {
            "running": sched_running,
            "enabled": True if system.get("schedulerEnabled") is None else bool(system.get("schedulerEnabled")),
            "state": sched_state.get("state") or sched_info.get("state"),
            "nextAction": sched_info.get("next_action"),
            "loginAt": sched_info.get("login_time"),
            "tickCollectionAt": sched_info.get("tick_collection_time"),
            "logoutAt": sched_info.get("logout_time"),
            "wsConnectAt": sched_info.get("ws_start_time"),
            "wsDisconnectAt": sched_info.get("ws_stop_time"),
            "isTradingDay": bool(sched_info.get("is_trading_day")),
            "schedule": sched_schedule,
        },
        "storage": {
            "exportsBytes": _dir_bytes(storage_dirs, "exports"),
            "logsBytes": _dir_bytes(storage_dirs, "logs"),
            "exportDirPresent": storage_dirs.get("dirs", [])[0].get("present", False) if storage_dirs.get("dirs") else None,
            "dbStorageBytes": mongo_totals.get("totalStorageBytes"),
            "dbIndexBytes": mongo_totals.get("totalIndexSizeBytes"),
            "diskPercent": disk_percent,
            "trend": trend,
        },
        "api": api,
        "dailyWriteHistory": history,
        "ticks": {"total": ticks_total, "today": ticks_today_ts},
        "workers": workers,
        "events": {
            "count": len(events_rows),
            "rows": events_rows[:50],
        },
        "alerts": {
            "activeIncidents": incidents_active,
            "activeQualityIssues": quality_issues_active,
        },
        "meta": {
            "measurementBoundaries": {
                "dataWrittenBytes": "None — per-day byte deltas are only available for "
                                   "windows after the snapshot loop begins persisting them.",
            },
        },
    }


def _dir_bytes(payload: dict, name: str) -> int | None:
    for d in (payload.get("dirs") or []):
        if d.get("name") == name:
            return d.get("bytes")
    return None


def _runtime_state() -> str:
    try:
        from api.system import _runtime_snapshot
        return _runtime_snapshot().get("state") or "UNKNOWN"
    except Exception:
        return "UNKNOWN"


_PROCESS_STARTED_AT: float | None = None


def mark_process_started() -> None:
    global _PROCESS_STARTED_AT
    _PROCESS_STARTED_AT = time.time()


def _process_started_at() -> float | None:
    return _PROCESS_STARTED_AT


async def _api_summary(hours: int = 24):
    """Real API telemetry summary (bounded window)."""
    if not is_mongo_connected():
        return None
    try:
        db = get_db()
        start = NOW_UTC() - timedelta(hours=max(1, min(int(hours), 30 * 24)))
        rows = await _bounded_agg(db.api_telemetry, [
            {"$match": {"ts": {"$gte": start}}},
            {"$group": {
                "_id": None,
                "requests": {"$sum": "$requests"},
                "errors": {"$sum": "$errors"},
                "clientErrors": {"$sum": "$clientErrors"},
                "serverErrors": {"$sum": "$serverErrors"},
                "sum_latency_ms": {"$sum": "$sum_latency_ms"},
                "num_latency": {"$sum": "$num_latency"},
            }},
        ])
        if not rows:
            return {"requests": 0, "errors": 0, "clientErrors": 0, "serverErrors": 0,
                    "avgLatencyMs": None, "health": "UNKNOWN"}
        r = rows[0]
        nl = int(r.get("num_latency") or 0)
        avg = round(float(r.get("sum_latency_ms") or 0) / nl, 2) if nl else None
        return {
            "requests": int(r.get("requests") or 0),
            "errors": int(r.get("errors") or 0),
            "clientErrors": int(r.get("clientErrors") or 0),
            "serverErrors": int(r.get("serverErrors") or 0),
            "avgLatencyMs": avg,
        }
    except Exception as exc:
        logger.debug("api summary failed: %s", exc)
        return None


# --------------------------------------------------------------------------- #
# Snapshot persistence (data_center_snapshots) — storage/DB growth history
# --------------------------------------------------------------------------- #
async def _persist_points() -> dict:
    db = get_db()
    now = NOW_UTC()
    mongo = await _mongo_stats()
    mongo_stats_payload = mongo.get("stats") or {}
    system = await _system_snapshot()
    node = system.get("node") or {}
    ping = await _ping_mongo()
    return {
        "ts": now,
        "istDay": _ist_day(now),
        "db": {
            "totalStorageBytes": mongo_stats_payload.get("totalStorageBytes"),
            "totalIndexSizeBytes": mongo_stats_payload.get("totalIndexSizeBytes"),
            "totalObjects": mongo_stats_payload.get("totalObjects"),
            "pingMs": ping,
        },
        "storage": {
            "diskUsedBytes": node.get("diskUsedBytes"),
            "diskPercent": node.get("diskPercent"),
        },
    }


async def capture_snapshot(*, manual: bool = False) -> dict:
    """Persist one snapshot point to data_center_snapshots (idempotent per ts)."""
    global _last_snapshot_at, _last_snapshot_ok
    payload = await _persist_points()
    try:
        db = get_db()
        await db[SNAPSHOT_COLL].update_one(
            {"ts": payload["ts"]},
            {"$set": {**payload, "mode": "manual" if manual else "auto"}},
            upsert=True,
        )
        ok = True
    except Exception as exc:
        logger.debug("snapshot persist failed: %s", exc)
        ok = False
    _last_snapshot_at = payload["ts"].isoformat()
    _last_snapshot_ok = ok
    return {"ts": payload["ts"].isoformat(), "ok": ok, "db": payload["db"], "storage": payload["storage"]}


async def recent_snapshots(limit: int = 90) -> list[dict]:
    """Newest-first persisted snapshot points (for the growth table)."""
    if not is_mongo_connected():
        return []
    try:
        db = get_db()
        cursor = db[SNAPSHOT_COLL].find({}).sort("ts", -1).limit(max(1, min(int(limit), 500)))
        docs = await cursor.to_list(length=max(1, min(int(limit), 500)))
        return [{
            "ts": _iso(d.get("ts")),
            "istDay": d.get("istDay"),
            "mode": d.get("mode"),
            "db": d.get("db"),
            "storage": d.get("storage"),
        } for d in docs]
    except Exception as exc:
        logger.debug("recent snapshots failed: %s", exc)
        return []


# --------------------------------------------------------------------------- #
# Background snapshot loop (started from app startup)
# --------------------------------------------------------------------------- #
async def _snapshot_loop() -> None:
    global _snapshot_running
    _snapshot_running = True
    try:
        while _snapshot_running:
            try:
                await capture_snapshot()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("snapshot loop iteration failed: %s", exc)
            await asyncio.sleep(SNAPSHOT_INTERVAL_SEC)
    finally:
        _snapshot_running = False
        logger.info("Data center snapshot loop stopped")


def start_snapshot_loop() -> asyncio.Task:
    global _snapshot_task, _snapshot_running
    if _snapshot_task is not None and not _snapshot_task.done():
        return _snapshot_task
    _snapshot_running = True
    _snapshot_task = asyncio.get_event_loop().create_task(_snapshot_loop())
    logger.info("Data center snapshot loop started (every %ss)", SNAPSHOT_INTERVAL_SEC)
    return _snapshot_task


def stop_snapshot_loop() -> None:
    global _snapshot_running, _snapshot_task
    _snapshot_running = False
    if _snapshot_task is not None:
        _snapshot_task.cancel()
        _snapshot_task = None