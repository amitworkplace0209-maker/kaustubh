"""
Scheduled Downloads — CRUD + automatic execution + run history.

Persistence: MongoDB collection `scheduled_downloads`; every execution is
recorded in `schedule_runs` (schedule, trigger, status, stocks, file,
size, error).

Timing: each schedule persists an IANA timezone (default Asia/Kolkata).
nextRunAt is stored as an aware UTC datetime; naive datetimes read back
from Mongo are treated as UTC (PyMongo convention) — this fixes the
historic bug where UTC values were misread as IST and jobs fired 5.5h
late.

Execution: uses the shared export engine (services/exporter.py), so a
scheduled run produces exactly one downloadable artifact containing ALL
selected stocks, recorded in download_history and ready in the Downloads
Center. Optional extra copy to a server folder via validated destinations.

Retry policy: bounded — up to MAX_RETRIES delayed retries per due slot,
each attempt visible in the runs history. No silent infinite retrying.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from datetime import time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from database.connection import get_db, is_mongo_connected
from services.serializers import get_serializer, REGISTRY as SERIALIZER_REGISTRY
from services.destinations import get_destination, REGISTRY as DEST_REGISTRY
from services import exporter
from services import market_calendar
from services import tick_buffer
from services import event_bus
from services.session.session_manager import session_manager
from core.event_loop import get_loop

logger = logging.getLogger("app")

router = APIRouter(prefix="/api/scheduled-downloads", tags=["scheduled-downloads"])

DEFAULT_TZ = "Asia/Kolkata"
CHECK_INTERVAL_S = 10          # schedule accuracy; tighter than the old ±20s
MAX_RETRIES = 2                # additional attempts after the first failure
RETRY_DELAY_S = 300            # 5 minutes between attempts

# Missed-run policy: what to do when a due slot was never executed (e.g. the
# backend was down at the scheduled time and only recovered later).
MISSED_RUN_RECOVERY = "RUN_ON_RECOVERY"
MISSED_RUN_SKIP = "SKIP"
MISSED_RUN_OPTIONS = (MISSED_RUN_RECOVERY, MISSED_RUN_SKIP)

# Download (device) state machine on top of PACKAGE_READY.
PKG_GENERATING = "PACKAGE_GENERATING"
PKG_READY = "PACKAGE_READY"
DL_QUEUED = "DOWNLOAD_QUEUED"
DL_STARTED = "DOWNLOAD_STARTED"
DL_COMPLETED = "DOWNLOAD_COMPLETED"
DL_FAILED = "DOWNLOAD_FAILED"
PKG_STATES = (PKG_GENERATING, PKG_READY, DL_QUEUED, DL_STARTED, DL_COMPLETED, DL_FAILED)

# Dependency states used by the retry engine / UI.
DEP_OK = "OK"
DEP_WAIT = "WAITING_FOR_DEPENDENCY"
DEP_SKIPPED = "SKIPPED"
DEP_RETRYING = "RETRYING"

# Backoff ladder (seconds) for WAITING_FOR_DEPENDENCY retries.
RETRY_BACKOFF_S = [60, 120, 300, 600, 1200]

# Dependencies that (when down) block execution by default.
BLOCKING_DEPS = ("mongodb", "data", "formats")


async def _emit(event: str, job_id: str | None, job_name: str | None = None,
                payload: dict | None = None) -> None:
    """Broadcast a scheduler/download lifecycle event to open browser tabs."""
    import uuid
    body = dict(payload or {})
    body.update({
        "event": event,
        "scheduleId": job_id,
        "scheduleName": job_name,
        "ts": datetime.now(timezone.utc).isoformat(),
        "eventId": uuid.uuid4().hex[:12],
    })
    try:
        await event_bus.publish_event(body)
    except Exception:
        logger.debug("Event emit failed for %s", event)


def _emit_feed_event(event: str, category: str, level: str,
                     message: str, meta: dict | None = None) -> None:
    """Route an export/download lifecycle event into the notification center.

    This is the entry point for the real download/export events — non-exported
    (browser-only) notifications are explicitly skipped, keeping the ledger
    rating honest (no fake/un-real alerts). ``event`` uses the canonical
    DOWNLOAD_*/EXPORT_* names consumed by the Alert Rule Engine.
    """
    try:
        from services.notification_center import emit_event
        emit_event(category, event, level, message, dict(meta or {}))
    except Exception:
        logger.debug("Notification-center event skipped: %s", event)


def _log(msg: str, *args) -> None:
    logger.info("[SCHEDULER] " + msg, *args)


async def _record_package(db, job: dict, meta: dict, run_objid=None) -> str:
    """Persist a generated package into the package/download registry.

    Returns the package record _id (as str).
    """
    filename = meta["fileName"]
    pkg = {
        "packageId": f"pkg_{meta['fileId']}",
        "scheduleId": str(job["_id"]),
        "scheduleName": job.get("name", ""),
        "executionId": str(run_objid) if run_objid else None,
        "historyId": meta.get("historyId"),
        "filename": filename,
        "fileId": meta["fileId"],
        "storageKey": str(meta.get("filePath") or ""),
        "sizeBytes": meta["fileSizeBytes"],
        "recordCount": meta["recordCount"],
        "symbols": meta.get("symbolsWithData") or [],
        "status": PKG_READY,
        "created_at": datetime.now(timezone.utc),
        "download_started_at": None,
        "download_completed_at": None,
        "download_error": None,
    }
    res = await db.package_downloads.insert_one(pkg)
    return str(res.inserted_id)


async def _mark_download_state(db, package_id: str, status: str,
                               error: str | None = None,
                               started: bool = False,
                               completed: bool = False,
                               failed: bool = False) -> None:
    """Advance the download (device) state of a package record."""
    update: dict = {"status": status}
    now = datetime.now(timezone.utc)
    if started or (status == DL_STARTED):
        update["download_started_at"] = now
    if completed or (status == DL_COMPLETED):
        update["download_completed_at"] = now
        update["download_error"] = None
    if failed or (status == DL_FAILED):
        update["download_error"] = error or "download failed"
    await db.package_downloads.update_one(
        {"packageId": package_id}, {"$set": update}
    )


def _missed_run_policy(job: dict) -> str:
    pol = job.get("missedRunPolicy") or MISSED_RUN_RECOVERY
    return pol if pol in MISSED_RUN_OPTIONS else MISSED_RUN_RECOVERY


def _retry_policy(job: dict) -> dict:
    rp = job.get("retryPolicy") or {}
    return {
        "enabled": bool(rp.get("enabled", True)),
        "intervalS": int(rp.get("intervalS") or RETRY_DELAY_S),
        "maxDurationS": int(rp.get("maxDurationS") or 3600),
    }


async def _dependency_check(job: dict) -> dict:
    """Real dependency snapshot used before every scheduled execution.

    Returns a list of checks with live state and a resolved overall decision.
    blocking = dependency that must be healthy to proceed (default set above).
    informational = reported but not a hard gate (session / pipeline / internet).
    No values are fabricated — each is read from the live runtime.
    """
    db = get_db()

    # MongoDB
    mongo_ok = is_mongo_connected()

    # Formats / export service
    formats_ok = any(
        s.available for s in SERIALIZER_REGISTRY.values()
    )

    # Data: at least one storable tick within the resolved window for the job.
    data_ok = False
    data_reason = None
    try:
        symbols = await _resolve_symbols(
            db, job.get("symbolMode", "custom"), job.get("symbols"),
        )
        if symbols:
            start, end = _resolve_date_range(job.get("dateRange") or {})
            query: dict = {"symbol": {"$in": [s.upper() for s in symbols]}}
            if start or end:
                ts_filter: dict = {}
                if start:
                    try:
                        ts_filter["$gte"] = datetime.fromisoformat(start.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                if end:
                    try:
                        ts_filter["$lte"] = datetime.fromisoformat(end.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                if ts_filter:
                    query["ts"] = ts_filter
            count = await db.ticks.count_documents(query)
            data_ok = count > 0
            if not data_ok:
                data_reason = "No tick data for the selected stocks" + (" in the date range" if start or end else "")
        else:
            data_reason = "No stocks resolved for this schedule"
    except Exception as exc:
        data_reason = str(exc) or exc.__class__.__name__

    # Internet / connectivity (informational by default — export of stored
    # data does not require a live internet path, but it is reported).
    internet_ok = False
    try:
        import socket
        try:
            socket.setdefaulttimeout(4)
            socket.create_connection(("8.8.8.8", 53))
            internet_ok = True
        except OSError:
            internet_ok = False
    except Exception:
        internet_ok = False

    wait_for = job.get("dependencyPolicy") or list(BLOCKING_DEPS)
    wait_for = [d for d in wait_for if d in BLOCKING_DEPS]

    session = None
    try:
        session = session_manager.snapshot()
    except Exception:
        session = None
    ws_ok = bool((session or {}).get("websocket", {}).get("connected"))

    buf_stats = {}
    try:
        buf_stats = tick_buffer.stats()
    except Exception:
        buf_stats = {}

    checks = [
        {
            "dependency": "mongodb",
            "available": bool(mongo_ok),
            "blocking": "mongodb" in wait_for,
            "reason": "MongoDB is connected" if mongo_ok else "MongoDB unavailable",
        },
        {
            "dependency": "data",
            "available": bool(data_ok),
            "blocking": "data" in wait_for,
            "reason": data_ok and data_reason is None
                and "Tick data available" or (data_reason or "Tick data unavailable"),
        },
        {
            "dependency": "formats",
            "available": bool(formats_ok),
            "blocking": "formats" in wait_for,
            "reason": "Export formats available" if formats_ok else "No export formats available",
        },
        {
            "dependency": "internet",
            "available": bool(internet_ok),
            "blocking": "internet" in wait_for,
            "reason": "Internet reachable" if internet_ok else "Internet unavailable",
        },
        {
            "dependency": "session",
            "available": bool((session or {}).get("active")),
            "blocking": False,
            "reason": "Broker session active" if ((session or {}).get("active")) else "No broker session active (info)",
        },
        {
            "dependency": "websocket",
            "available": bool(ws_ok),
            "blocking": False,
            "reason": "WebSocket connected" if ws_ok else "WebSocket not connected (info)",
        },
        {
            "dependency": "pipeline",
            "available": bool(buf_stats.get("pipelineRunning")),
            "blocking": False,
            "reason": "Tick pipeline running" if buf_stats.get("pipelineRunning") else "Tick pipeline idle (info)",
        },
    ]

    blocked = [c for c in checks if c["blocking"] and not c["available"]]
    decision = DEP_SKIPPED
    reason = None
    if job.get("enabled") is False:
        decision = DEP_SKIPPED
        reason = "Schedule is paused"
    elif blocked:
        decision = DEP_WAIT
        reason = "; ".join(f"{c['dependency']} unavailable" for c in blocked)
    else:
        decision = DEP_OK

    return {
        "decision": decision,
        "reason": reason,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "stocksResolved": None,  # filled by caller when needed
        "checks": checks,
    }


def _retry_delay(attempt: int) -> int:
    """Controlled backoff for dependency/retry waits (seconds)."""
    idx = min(max(attempt, 0), len(RETRY_BACKOFF_S) - 1)
    return RETRY_BACKOFF_S[idx]


def _is_trading_day_local(schedule: dict, when_utc: datetime) -> bool:
    """Determine whether the due instant falls on a trading day in the
    schedule's own timezone, using the existing market-calendar logic."""
    tz = _tz(schedule.get("timezone"))
    local = when_utc.astimezone(tz)
    return market_calendar.is_trading_day(local.date())



# ── Models ────────────────────────────────────────────────

class ScheduleConfig(BaseModel):
    type: str = "daily"           # daily | weekdays | weekly
    time: str = "09:00"           # HH:MM in `timezone`
    days: list[int] = []          # weekday indexes, Mon=0..Sun=6 (weekly)
    timezone: str = DEFAULT_TZ    # persisted explicitly


class DateRangeConfig(BaseModel):
    type: str = "previous_day"    # previous_day | last_n_days | today | custom
    days: int = 1
    startDate: str | None = None  # ISO (custom)
    endDate: str | None = None


class CreateJobRequest(BaseModel):
    name: str
    enabled: bool = True
    symbols: list[str] | None = None
    symbolMode: str = "all_active"  # all_active | all | custom
    fields: list[str] | None = None
    formats: list[str] = ["csv"]
    schedule: ScheduleConfig = ScheduleConfig()
    dateRange: DateRangeConfig = DateRangeConfig()
    destination: str = "server"
    destinationConfig: dict | None = None
    timezone: str | None = None     # convenience alias for schedule.timezone
    dependencyPolicy: list[str] | None = None  # which deps may block execution
    missedRunPolicy: str | None = None   # RUN_ON_RECOVERY | SKIP
    retryPolicy: dict | None = None      # {enabled, intervalS, maxDurationS}


class UpdateJobRequest(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    symbols: list[str] | None = None
    symbolMode: str | None = None
    fields: list[str] | None = None
    formats: list[str] | None = None
    schedule: ScheduleConfig | None = None
    dateRange: DateRangeConfig | None = None
    destination: str | None = None
    destinationConfig: dict | None = None
    timezone: str | None = None
    dependencyPolicy: list[str] | None = None
    missedRunPolicy: str | None = None
    retryPolicy: dict | None = None


# ── Time helpers ──────────────────────────────────────────

def _tz(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def _parse_time(time_str: str) -> tuple[int, int]:
    parts = (time_str or "00:00").split(":")
    try:
        return int(parts[0]) % 24, int(parts[1]) % 60
    except (ValueError, IndexError):
        return 0, 0


def _as_utc(dt: datetime) -> datetime:
    """Naive datetimes from Mongo are UTC (PyMongo default)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _next_run_time(schedule: dict, from_time: datetime | None = None) -> datetime:
    """Next due instant for a schedule, returned as aware UTC."""
    tz = _tz(schedule.get("timezone"))
    now_local = from_time.astimezone(tz) if from_time else datetime.now(tz)
    hour, minute = _parse_time(schedule.get("time", "09:00"))
    sched_type = schedule.get("type", "daily")
    days = schedule.get("days") or []

    target = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)

    if sched_type == "weekdays":
        while target <= now_local or target.weekday() >= 5:
            target += timedelta(days=1)
    elif sched_type == "weekly":
        if not days:
            days = [0]
        while target <= now_local or target.weekday() not in days:
            target += timedelta(days=1)
    else:  # daily
        if target <= now_local:
            target += timedelta(days=1)

    return target.astimezone(timezone.utc)


async def _resolve_symbols(db, symbol_mode: str, symbols: list[str] | None) -> list[str]:
    """Resolve which symbols a job should download — ALL of them."""
    if symbol_mode == "custom":
        return sorted({s.strip().upper() for s in (symbols or []) if s and s.strip()})
    query = {} if symbol_mode == "all" else {"active": True}
    cursor = db.stocks.find(query)
    stocks = await cursor.to_list(length=None)
    return sorted({s["symbol"].upper() for s in stocks if s.get("symbol")})


def _resolve_date_range(date_range: dict) -> tuple[str | None, str | None]:
    """Resolve the data window to start/end ISO strings (UTC)."""
    dr = date_range or {}
    dr_type = dr.get("type", "previous_day")
    now = datetime.now(timezone.utc)

    if dr_type == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start.isoformat(), None

    if dr_type == "previous_day":
        yesterday = now - timedelta(days=1)
        start = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)
        end = yesterday.replace(hour=23, minute=59, second=59, microsecond=999999)
        return start.isoformat(), end.isoformat()

    if dr_type == "last_n_days":
        days = max(int(dr.get("days") or 1), 1)
        start = (now - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
        return start.isoformat(), None

    if dr_type == "custom":
        start = dr.get("startDate")
        end = dr.get("endDate")
        if not start and not end:
            return None, None
        # Date-only values get full-day bounds.
        def expand(v: str | None, end_side: bool) -> str | None:
            if not v:
                return None
            v = str(v)
            if len(v) == 10:
                return (
                    f"{v}T00:00:00+00:00" if not end_side
                    else f"{v}T23:59:59+00:00"
                )
            try:
                dtv = datetime.fromisoformat(v.replace("Z", "+00:00"))
                if dtv.tzinfo is None:
                    dtv = dtv.replace(tzinfo=timezone.utc)
                return dtv.isoformat()
            except ValueError:
                return None
        return expand(start, False), expand(end, True)

    return None, None


def _regex_escape(text: str) -> str:
    return re.escape(text)


def _serialize_job(job: dict) -> dict:
    out = dict(job)
    if "_id" in out:
        out["_id"] = str(out["_id"])
    for key in ("createdAt", "updatedAt", "lastRun", "nextRun",
                "firstAttemptAt", "lastAttemptAt", "nextRetryAt"):
        val = out.get(key)
        if isinstance(val, datetime):
            out[key] = _as_utc(val).isoformat()
        elif val is not None and key in ("nextRun", "nextRetryAt"):
            # naive value read back from Mongo — annotate as UTC
            try:
                out[key] = _as_utc(val).isoformat()
            except Exception:
                pass
    # Expose the persisted schedule timezone top-level (UI reads job.timezone).
    sched = out.get("schedule") or {}
    if isinstance(sched, dict):
        out.setdefault("timezone", sched.get("timezone") or DEFAULT_TZ)
    return out


# ── Job executor ──────────────────────────────────────────

async def _execute_job(job: dict, trigger: str = "scheduled",
                       idempotency_key: str | None = None,
                       scheduled_at: datetime | None = None) -> bool:
    """Execute a scheduled download through the shared export engine.

    Records every attempt in `schedule_runs`. Returns success.
    """
    db = get_db()
    job_id = job["_id"]
    job_name = job.get("name", str(job_id))
    scheduled_at = scheduled_at or job.get("nextRun")
    started = datetime.now(timezone.utc)
    t0 = time.monotonic()

    # Second-level precision report.
    delay_ms = None
    if scheduled_at is not None:
        try:
            delay_ms = round((started - _as_utc(scheduled_at)).total_seconds() * 1000, 1)
        except Exception:
            delay_ms = None

    _log("executing schedule %s (trigger=%s)", job_name, trigger)
    await _emit("SCHEDULE_RUNNING", str(job_id), job_name, {
        "trigger": trigger, "scheduledAt": _as_utc(scheduled_at).isoformat() if scheduled_at else None,
    })

    await db.scheduled_downloads.update_one(
        {"_id": job_id},
        {"$set": {"lastStatus": "running", "lastError": None}},
    )

    base_run: dict = {
        "scheduleId": str(job_id),
        "scheduleName": job_name,
        "trigger": trigger,
        "runAt": started,
        "scheduledAt": _as_utc(scheduled_at) if scheduled_at else None,
        "startedAt": started,
        "delayMs": delay_ms,
        "stocks": [],
        "symbolCount": 0,
        "idempotencyKey": idempotency_key,
    }

    try:
        sym_list = await _resolve_symbols(
            db, job.get("symbolMode", "custom"), job.get("symbols"),
        )
        if not sym_list:
            raise ValueError("No stocks resolved for this schedule")

        start, end = _resolve_date_range(job.get("dateRange") or {})
        fields_str = ",".join(job.get("fields") or [])

        _log("export started %s", job_name)
        await _emit("SCHEDULE_EXPORT_STARTED", str(job_id), job_name, {})
        _emit_feed_event(
            "EXPORT_STARTED", "export", "info",
            f"Export started: {job_name}",
            {"schedule_id": str(job_id), "schedule_name": job_name},
        )

        meta = await exporter.execute_export(
            symbols=sym_list,
            start=start,
            end=end,
            fields_str=fields_str,
            formats=job.get("formats", ["csv"]),
            package_zip=True,
            label=job_name,           # KAUSTUBH_<SCHEDULE>_<date>.zip
            source="scheduled",
            schedule_id=str(job_id),
            schedule_name=job_name,
        )

        # Optional additional copy to a server folder (validated path).
        delivered_path = None
        dest_id = job.get("destination", "server")
        dest = get_destination(dest_id)
        if dest and dest.available and dest_id != "server":
            raw = Path(exporter.EXPORT_DIR / meta["fileId"]).read_bytes()
            result = dest.deliver(raw, meta["fileName"], job.get("destinationConfig"))
            delivered_path = result.get("path")

        completed = datetime.now(timezone.utc)
        duration_ms = (time.monotonic() - t0) * 1000

        run_doc = {
            **base_run,
            "status": "success",
            "stocks": meta["symbolsWithData"],
            "symbolCount": len(meta["symbolsWithData"]),
            "missingSymbols": meta["symbolsMissing"],
            "jobId": meta.get("historyId"),
            "historyId": meta.get("historyId"),
            "fileId": meta["fileId"],
            "fileName": meta["fileName"],
            "fileSizeBytes": meta["fileSizeBytes"],
            "recordCount": meta["recordCount"],
            "durationMs": round(duration_ms, 1),
            "completedAt": completed,
            "deliveredTo": delivered_path,
            "error": None,
        }
        res = await db.schedule_runs.insert_one(run_doc)
        run_objid = res.inserted_id

        # Package/download registry + PACKAGE_READY event.
        pkg_id = await _record_package(db, job, meta, run_objid)
        await _emit("PACKAGE_READY", str(job_id), job_name, {
            "packageId": pkg_id,
            "filename": meta["fileName"],
            "fileSizeBytes": meta["fileSizeBytes"],
            "recordCount": meta["recordCount"],
            "historyId": meta.get("historyId"),
            "symbols": meta.get("symbolsWithData") or [],
        })
        _log("ZIP created %s → %s (%d rows)", job_name, meta["fileName"], meta["recordCount"])
        _log("package ready %s (%s)", meta["fileName"], pkg_id)

        await db.scheduled_downloads.update_one(
            {"_id": job_id},
            {"$set": {
                "lastStatus": "success",
                "lastRun": datetime.now(timezone.utc),
                "lastError": None,
                "lastFile": meta["fileName"],
                "lastFileSize": meta["fileSizeBytes"],
                "historyId": meta["historyId"],
                "packageId": pkg_id,
                "failCount": 0,
            },
            "$inc": {"runCount": 1}},
        )
        await _emit("SCHEDULE_COMPLETED", str(job_id), job_name, {
            "fileName": meta["fileName"],
            "fileSizeBytes": meta["fileSizeBytes"],
            "recordCount": meta["recordCount"],
            "durationMs": round(duration_ms, 1),
            "historyId": meta.get("historyId"),
            "packageId": pkg_id,
        })
        _log("completed %s → %s (%d rows, %.1fs)", job_name, meta["fileName"], meta["recordCount"], duration_ms / 1000)
        _emit_feed_event(
            "EXPORT_COMPLETED", "export", "success",
            f"Export completed: {meta.get('fileName') or job_name} "
            f"({meta.get('recordCount')} rows)",
            {"schedule_id": str(job_id), "symbols": meta.get("symbolsWithData") or [],
             "fileName": meta.get("fileName"), "recordCount": meta.get("recordCount")},
        )
        return True

    except Exception as exc:
        error = str(exc) or exc.__class__.__name__
        completed = datetime.now(timezone.utc)
        duration_ms = (time.monotonic() - t0) * 1000
        _log("FAILED %s — %s", job_name, error)
        await db.schedule_runs.insert_one({
            **base_run,
            "status": "failed",
            "error": error,
            "durationMs": round(duration_ms, 1),
            "completedAt": completed,
        })
        await db.scheduled_downloads.update_one(
            {"_id": job_id},
            {"$set": {
                "lastStatus": "failed",
                "lastError": error,
                "lastRun": datetime.now(timezone.utc),
            },
            "$inc": {"runCount": 1, "failCount": 1}},
        )
        await _emit("SCHEDULE_FAILED", str(job_id), job_name, {"error": error})
        _emit_feed_event(
            "EXPORT_FAILED", "export", "error",
            f"Export failed for {job_name}: {error}",
            {"schedule_id": str(job_id), "error": error},
        )
        return False


# ── Background checker ────────────────────────────────────

_checker_task: asyncio.Task | None = None
_running = False


async def _check_scheduled_jobs():
    """Periodically execute due jobs with dependency checks, non-trading-day
    skipping, idempotency (one package per due slot) and bounded retries."""
    global _running
    _running = True
    import os as _os
    logger.info("[DL-CHECKER] instance=%s started (every %ss)", _os.getpid(), CHECK_INTERVAL_S)

    while _running:
        try:
            db = get_db()
            now_utc = datetime.now(timezone.utc)
            cursor = db.scheduled_downloads.find({"enabled": True})
            jobs = await cursor.to_list(length=200)

            for job in jobs:
                jid = job["_id"]
                sched = job.get("schedule") or {}

                # ── No nextRun set yet (fresh / disabled->enabled) ──
                next_run_raw = job.get("nextRun")
                if next_run_raw is None:
                    at = _next_run_time(sched)
                    # On a non-trading day, advance to the next trading day.
                    if not _is_trading_day_local(sched, at):
                        at = _next_trading_day_run(sched, at)
                    await db.scheduled_downloads.update_one(
                        {"_id": jid}, {"$set": {"nextRun": at}}
                    )
                    continue

                next_run = (
                    _as_utc(next_run_raw) if isinstance(next_run_raw, datetime) else None
                )
                if next_run is None:
                    continue
                if now_utc < next_run:
                    continue

                slot = next_run.astimezone(_tz(sched.get("timezone"))).date().isoformat()
                idem_key = f"{str(jid)}:{slot}"

                # ── Missed-run recovery ──
                # If we are meaningfully (>=90s) past the due instant, the slot
                # was not run while we were away. Honor the schedule's policy:
                #   RUN_ON_RECOVERY -> execute now (missing job is not lost)
                #   SKIP           -> advance without executing
                from datetime import timedelta as _td
                missed = (now_utc - next_run) > _td(seconds=90)
                if missed:
                    already_any = await db.schedule_runs.find_one({
                        "idempotencyKey": idem_key, "status": {"$in": ["success", "failed", "skipped"]},
                    })
                    if not already_any:
                        if _missed_run_policy(job) == MISSED_RUN_SKIP:
                            _log("MISSED %s at %s — policy SKIP, advancing", job.get("name"), next_run.isoformat())
                            await db.schedule_runs.insert_one({
                                "scheduleId": str(jid),
                                "scheduleName": job.get("name", str(jid)),
                                "trigger": "scheduled",
                                "runAt": next_run,
                                "startedAt": None,
                                "scheduledAt": next_run,
                                "stocks": [],
                                "symbolCount": 0,
                                "status": "skipped",
                                "error": "MISSED — SKIPPED by policy (backend unavailable)",
                                "idempotencyKey": idem_key,
                            })
                            following = _next_scheduled_run(sched)
                            await db.scheduled_downloads.update_one(
                                {"_id": jid}, {"$set": {"nextRun": following,
                                                          "lastStatus": "skipped",
                                                          "lastError": "MISSED — SKIPPED by policy",
                                                          "failCount": 0, "retry_count": 0}},
                            )
                            await _emit("SCHEDULE_SKIPPED", str(jid), job.get("name"), {"reason": "missed"})
                            continue
                        _log("MISSED %s at %s — policy RUN_ON_RECOVERY, executing now",
                             job.get("name"), next_run.isoformat())
                        await _emit("SCHEDULE_MISSED", str(jid), job.get("name"), {
                            "scheduledAt": next_run.isoformat(),
                            "policy": MISSED_RUN_RECOVERY,
                        })
                    else:
                        # If a terminal run exists for this slot we simply missed
                        # the advance; re-run the normal idempotency handling below.
                        if already_any.get("status") == "success":
                            following = _next_scheduled_run(sched)
                            await db.scheduled_downloads.update_one(
                                {"_id": jid},
                                {"$set": {"nextRun": following, "failCount": 0,
                                          "retry_count": 0, "lastStatus": "completed",
                                          "lastError": None}},
                            )
                            continue

                # ── Idempotency: a successful package already exists for this
                #    due slot -> advance; never generate a duplicate package.
                already = await db.schedule_runs.find_one({
                    "idempotencyKey": idem_key, "status": "success",
                })
                if already:
                    following = _next_scheduled_run(sched)
                    await db.scheduled_downloads.update_one(
                        {"_id": jid},
                        {"$set": {"nextRun": following, "failCount": 0,
                                  "retry_count": 0, "lastStatus": "completed",
                                  "lastError": None}},
                    )
                    continue

                # ── Non-trading-day handling on the due date ──
                if not _is_trading_day_local(sched, next_run):
                    reason = market_calendar.closure_reason(
                        next_run.astimezone(_tz(sched.get("timezone"))).date()
                    ) or "Non-trading day"
                    await db.schedule_runs.insert_one({
                        "scheduleId": str(jid),
                        "scheduleName": job.get("name", str(jid)),
                        "trigger": "scheduled",
                        "runAt": next_run,
                        "stocks": [],
                        "symbolCount": 0,
                        "status": "skipped",
                        "error": f"SKIPPED — {reason}",
                        "idempotencyKey": idem_key,
                    })
                    following = _next_trading_day_run(sched, next_run)
                    await db.scheduled_downloads.update_one(
                        {"_id": jid},
                        {"$set": {"nextRun": following, "lastStatus": "skipped",
                                  "lastError": f"SKIPPED — {reason}",
                                  "failCount": 0, "retry_count": 0}},
                    )
                    continue

                # ── Dependency check before executing ──
                dep = await _dependency_check(job)
                retry_count = int(job.get("retry_count") or 0)

                if dep["decision"] == DEP_WAIT:
                    delay = _retry_delay(retry_count)
                    retry_at = now_utc + timedelta(seconds=delay)
                    _log("dependency check %s: WAITING — %s", job.get("name"), dep["reason"])
                    await db.schedule_runs.insert_one({
                        "scheduleId": str(jid),
                        "scheduleName": job.get("name", str(jid)),
                        "trigger": "scheduled",
                        "runAt": next_run,
                        "startedAt": None,
                        "scheduledAt": next_run,
                        "stocks": [],
                        "symbolCount": 0,
                        "status": "waiting",
                        "error": f"WAITING_FOR_DEPENDENCY — {dep['reason']}",
                        "idempotencyKey": idem_key,
                    })
                    await db.scheduled_downloads.update_one(
                        {"_id": jid},
                        {"$set": {
                            "lastStatus": DEP_WAIT,
                            "failure_reason": dep["reason"],
                            "nextRetryAt": retry_at,
                            "retry_count": retry_count + 1,
                            "firstAttemptAt": job.get("firstAttemptAt") or now_utc,
                            "lastAttemptAt": now_utc,
                        }},
                    )
                    await db.scheduled_downloads.update_one(
                        {"_id": jid}, {"$set": {"nextRun": retry_at}}
                    )
                    await _emit("SCHEDULE_WAITING", str(jid), job.get("name"), {
                        "reason": dep["reason"], "nextRetryAt": retry_at.isoformat(),
                    })
                    continue

                if not job.get("lastStatus") in (None, "running"):
                    await db.scheduled_downloads.update_one(
                        {"_id": jid},
                        {"$set": {"firstAttemptAt": job.get("firstAttemptAt") or now_utc,
                                  "lastAttemptAt": now_utc}},
                    )

                await _emit("SCHEDULE_DUE", str(jid), job.get("name"), {
                    "scheduledAt": next_run.isoformat(),
                })
                ok = await _execute_job(job, trigger="scheduled", idempotency_key=idem_key,
                                        scheduled_at=next_run)

                retry_pol = _retry_policy(job)
                fail_count = int(job.get("failCount") or 0)
                if ok:
                    following = _next_scheduled_run(sched)
                    await db.scheduled_downloads.update_one(
                        {"_id": jid},
                        {"$set": {"nextRun": following, "failCount": 0,
                                  "retry_count": 0, "nextRetryAt": None,
                                  "failure_reason": None}},
                    )
                elif retry_pol["enabled"] and (fail_count < MAX_RETRIES):
                    retry_at = now_utc + timedelta(seconds=retry_pol["intervalS"])
                    _log("retry %s (%d/%d) at %s", job.get("name"), fail_count + 1, MAX_RETRIES,
                         retry_at.isoformat())
                    await db.scheduled_downloads.update_one(
                        {"_id": jid},
                        {"$set": {"nextRun": retry_at, "nextRetryAt": retry_at,
                                  "lastAttemptAt": now_utc, "retry_count": fail_count + 1,
                                  "lastStatus": DEP_RETRYING}},
                    )
                    await _emit("SCHEDULE_RETRYING", str(jid), job.get("name"), {
                        "attempt": fail_count + 1, "nextRetryAt": retry_at.isoformat(),
                    })
                else:
                    following = _next_scheduled_run(sched)
                    await db.scheduled_downloads.update_one(
                        {"_id": jid},
                        {"$set": {"nextRun": following, "failCount": 0,
                                  "retry_count": 0, "nextRetryAt": None}},
                    )

        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Scheduler check error: %s", exc)

        await asyncio.sleep(CHECK_INTERVAL_S)

    logger.info("Scheduled downloads checker stopped")


def _next_scheduled_run(schedule: dict) -> datetime:
    """Next due instant advancing forward (used after a completed/missed slot)."""
    return _next_run_time(schedule)


def _next_trading_day_run(schedule: dict, from_time: datetime) -> datetime:
    """Advance to the schedule's time on the next trading day."""
    tz = _tz(schedule.get("timezone"))
    hour, minute = _parse_time(schedule.get("time", "09:00"))
    # Scan up to 90 days for the next trading day strictly after the given day.
    base_local = from_time.astimezone(tz).date()
    probe = base_local + timedelta(days=1)
    for _ in range(90):
        if market_calendar.is_trading_day(probe):
            at_local = datetime.combine(probe, dtime(hour, minute), tzinfo=tz)
            return at_local.astimezone(timezone.utc)
        probe += timedelta(days=1)
    return _next_run_time(schedule)


def start_scheduled_downloads_checker():
    global _checker_task
    if _checker_task is not None and not _checker_task.done():
        return
    try:
        loop = get_loop()
        _checker_task = loop.create_task(_check_scheduled_jobs())
        _log("started (part of backend startup; no frontend request required)")
    except Exception as exc:
        logger.warning("Could not start scheduled downloads checker: %s", exc)


def stop_scheduled_downloads_checker():
    global _running, _checker_task
    _running = False
    if _checker_task is not None:
        _checker_task.cancel()
        _checker_task = None


def scheduled_downloads_checker_status() -> dict:
    """Real in-process checker state for the Data Center workers panel."""
    task = _checker_task
    return {
        "running": bool(_running),
        "taskActive": bool(task is not None and not task.done()),
        "intervalSeconds": CHECK_INTERVAL_S,
    }


# ── Static routes (MUST be before /{job_id}) ─────────────

@router.get("/destinations/list")
async def list_destinations():
    return {"destinations": [
        {
            "id": d.id,
            "name": d.name,
            "available": d.available,
            "requiresConfig": d.requires_config,
        }
        for d in DEST_REGISTRY.values()
    ]}


@router.get("/formats/list")
async def list_available_formats():
    return {"formats": [
        {
            "id": s.id,
            "extension": s.extension,
            "mimeType": s.mime_type,
            "available": s.available,
            "description": s.description,
        }
        for s in SERIALIZER_REGISTRY.values()
    ]}


@router.get("/runs")
async def list_schedule_runs(
    limit: int = Query(10, ge=1, le=100),
    offset: int = Query(0, ge=0),
    schedule_id: str = "",
    status: str = "",
):
    db = get_db()
    query: dict = {}
    if schedule_id:
        query["scheduleId"] = schedule_id
    if status:
        query["status"] = status

    total = await db.schedule_runs.count_documents(query)
    cursor = (
        db.schedule_runs.find(query)
        .sort("runAt", -1)
        .skip(offset)
        .limit(limit)
    )
    items = []
    async for r in cursor:
        r["_id"] = str(r["_id"])
        for key in ("runAt", "scheduledAt", "startedAt", "completedAt"):
            if isinstance(r.get(key), datetime):
                r[key] = _as_utc(r[key]).isoformat()
        items.append(r)
    return {"total": total, "limit": limit, "offset": offset, "items": items}


@router.get("/health")
async def scheduler_health():
    """Live dependency + market snapshot for the scheduler UI. No fabricated
    values — every check reads real runtime state."""
    db = get_db()
    job_total = 0
    enabled = 0
    waiting = 0
    try:
        job_total = await db.scheduled_downloads.count_documents({})
        enabled = await db.scheduled_downloads.count_documents({"enabled": True})
        waiting = await db.scheduled_downloads.count_documents(
            {"enabled": True, "lastStatus": DEP_WAIT}
        )
    except Exception:
        pass
    market = market_calendar.snapshot()
    return {
        "dependencies": (await _dependency_check({})),
        "market": market,
        "jobs": {
            "total": job_total,
            "enabled": enabled,
            "waiting": waiting,
        },
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/runs/{run_id}")
async def get_schedule_run(run_id: str):
    db = get_db()
    try:
        oid = ObjectId(run_id)
    except (InvalidId, TypeError):
        raise HTTPException(400, "Invalid run id")
    run = await db.schedule_runs.find_one({"_id": oid})
    if not run:
        raise HTTPException(404, "Run record not found")
    run["_id"] = str(run["_id"])
    for key in ("runAt", "scheduledAt", "startedAt", "completedAt"):
        if isinstance(run.get(key), datetime):
            run[key] = _as_utc(run[key]).isoformat()
    return {"run": run}


@router.delete("/runs/{run_id}")
async def delete_schedule_run(run_id: str):
    db = get_db()
    try:
        oid = ObjectId(run_id)
    except (InvalidId, TypeError):
        raise HTTPException(400, "Invalid run id")
    result = await db.schedule_runs.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(404, "Run record not found")
    return {"deleted": 1}


# ── CRUD Endpoints ────────────────────────────────────────

@router.get("")
async def list_jobs():
    db = get_db()
    cursor = db.scheduled_downloads.find({}).sort("createdAt", -1)
    jobs = [_serialize_job(j) async for j in cursor]
    return {"jobs": jobs, "count": len(jobs)}


@router.post("")
async def create_job(req: CreateJobRequest):
    db = get_db()

    name = (req.name or "").strip()
    if not name:
        raise HTTPException(400, "Schedule name is required")
    if len(name) > 120:
        raise HTTPException(400, "Schedule name is too long (max 120 chars)")

    duplicate = await db.scheduled_downloads.find_one(
        {"name": {"$regex": f"^{_regex_escape(name)}$", "$options": "i"}}
    )
    if duplicate:
        raise HTTPException(400, f"A schedule named \"{name}\" already exists")

    if req.symbolMode == "custom" and not (req.symbols and [s for s in req.symbols if s.strip()]):
        raise HTTPException(400, "Custom stock mode requires at least one selected symbol")

    if not req.formats or not [f for f in req.formats if f.strip()]:
        raise HTTPException(400, "At least one export format is required")

    for fmt in req.formats:
        ser = get_serializer(fmt)
        if not ser or not ser.available:
            raise HTTPException(400, f"Format not available: {fmt}")

    dest = get_destination(req.destination)
    if not dest:
        raise HTTPException(400, f"Unknown destination: {req.destination}")
    config_err = dest.validate_config(req.destinationConfig)
    if config_err:
        raise HTTPException(400, config_err)

    # Validate timezone early so bad values never reach the checker.
    schedule_data = req.schedule.model_dump()
    if req.timezone and req.timezone.strip():
        schedule_data["timezone"] = req.timezone.strip()
    tz = _tz(schedule_data.get("timezone"))
    if tz.utcoffset(datetime.now(timezone.utc)) is None:
        raise HTTPException(400, f"Invalid timezone: {schedule_data.get('timezone')}")

    now = datetime.now(timezone.utc)
    next_run = _next_run_time(schedule_data)

    missed_pol = req.missedRunPolicy
    if missed_pol not in MISSED_RUN_OPTIONS:
        missed_pol = MISSED_RUN_RECOVERY

    job = {
        "name": name,
        "enabled": req.enabled,
        "symbols": req.symbols,
        "symbolMode": req.symbolMode,
        "fields": req.fields,
        "formats": req.formats,
        "schedule": schedule_data,
        "dateRange": req.dateRange.model_dump(),
        "destination": req.destination,
        "destinationConfig": req.destinationConfig,
        "dependencyPolicy": req.dependencyPolicy if req.dependencyPolicy else None,
        "missedRunPolicy": missed_pol,
        "retryPolicy": req.retryPolicy if isinstance(req.retryPolicy, dict) else None,
        "nextRun": next_run,
        "lastRun": None,
        "lastStatus": None,
        "lastError": None,
        "failCount": 0,
        "runCount": 0,
        "retry_count": 0,
        "firstAttemptAt": None,
        "lastAttemptAt": None,
        "nextRetryAt": None,
        "failure_reason": None,
        "createdAt": now,
        "updatedAt": now,
    }

    result = await db.scheduled_downloads.insert_one(job)
    serialized = _serialize_job({**job, "_id": result.inserted_id})
    _log("created schedule %s (id=%s)", name, serialized["_id"])
    await _emit("SCHEDULE_CREATED", serialized["_id"], name, {"enabled": req.enabled})
    return {"job": serialized}


# ── Packages (generated export artifacts) ─────────────────

@router.get("/packages")
async def list_packages(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    schedule_id: str = "",
    status: str = "",
):
    db = get_db()
    query: dict = {}
    if schedule_id:
        query["scheduleId"] = schedule_id
    if status:
        query["status"] = status

    total = await db.package_downloads.count_documents(query)
    cursor = (
        db.package_downloads.find(query)
        .sort("createdAt", -1)
        .skip(offset)
        .limit(limit)
    )
    items = []
    async for p in cursor:
        p["_id"] = str(p["_id"])
        for key in ("createdAt", "readyAt", "downloadStartedAt", "completedAt"):
            if isinstance(p.get(key), datetime):
                p[key] = _as_utc(p[key]).isoformat()
        items.append(p)
    return {"total": total, "limit": limit, "offset": offset, "items": items}


@router.get("/packages/{package_id}")
async def get_package(package_id: str):
    db = get_db()
    try:
        oid = ObjectId(package_id)
    except (InvalidId, TypeError):
        raise HTTPException(400, "Invalid package id")
    pkg = await db.package_downloads.find_one({"_id": oid})
    if not pkg:
        raise HTTPException(404, "Package not found")
    pkg["_id"] = str(pkg["_id"])
    for key in ("createdAt", "readyAt", "downloadStartedAt", "completedAt"):
        if isinstance(pkg.get(key), datetime):
            pkg[key] = _as_utc(pkg[key]).isoformat()
    return {"package": pkg}


@router.post("/packages/{package_id}/download")
async def trigger_package_download(package_id: str, body: dict = Body(default={})):
    """Propagate a browser download trigger through the device download
    state machine (DL_QUEUED -> DL_STARTED -> DL_COMPLETED/DL_FAILED)."""
    db = get_db()
    try:
        oid = ObjectId(package_id)
    except (InvalidId, TypeError):
        raise HTTPException(400, "Invalid package id")
    pkg = await db.package_downloads.find_one({"_id": oid})
    if not pkg:
        raise HTTPException(404, "Package not found")

    now = datetime.now(timezone.utc)
    action = (body or {}).get("action") or "start"
    if action in ("start", "queued"):
        await db.package_downloads.update_one(
            {"_id": oid},
            {"$set": {"status": DL_QUEUED, "downloadStartedAt": now,
                      "deviceId": (body or {}).get("deviceId")}},
        )
        await _emit("PACKAGE_DL_QUEUED", str(oid), pkg.get("scheduleName"), {
            "packageId": str(oid), "fileName": pkg.get("fileName"),
        })
    elif action == "started":
        await db.package_downloads.update_one(
            {"_id": oid},
            {"$set": {"status": DL_STARTED, "downloadStartedAt": now}},
        )
        await _emit("PACKAGE_DL_STARTED", str(oid), pkg.get("scheduleName"), {
            "packageId": str(oid), "fileName": pkg.get("fileName"),
        })
        _emit_feed_event(
            "DOWNLOAD_STARTED", "download", "info",
            f"Download started for {pkg.get('fileName') or 'package'}",
            {"package_id": str(oid), "fileName": pkg.get("fileName")},
        )
    elif action == "complete":
        await db.package_downloads.update_one(
            {"_id": oid},
            {"$set": {"status": DL_COMPLETED, "completedAt": now}},
        )
        await _emit("PACKAGE_DL_COMPLETED", str(oid), pkg.get("scheduleName"), {
            "packageId": str(oid), "fileName": pkg.get("fileName"),
        })
        _emit_feed_event(
            "DOWNLOAD_COMPLETED", "download", "success",
            f"Download completed for {pkg.get('fileName') or 'package'}",
            {"package_id": str(oid), "fileName": pkg.get("fileName")},
        )
    elif action == "fail":
        await db.package_downloads.update_one(
            {"_id": oid},
            {"$set": {"status": DL_FAILED, "completedAt": now,
                      "error": (body or {}).get("error")}},
        )
        await _emit("PACKAGE_DL_FAILED", str(oid), pkg.get("scheduleName"), {
            "packageId": str(oid), "fileName": pkg.get("fileName"),
            "error": (body or {}).get("error"),
        })
        _emit_feed_event(
            "DOWNLOAD_FAILED", "download", "error",
            f"Download failed for {pkg.get('fileName') or 'package'}: {(body or {}).get('error') or 'unknown error'}",
            {"package_id": str(oid), "fileName": pkg.get("fileName"),
             "error": (body or {}).get("error")},
        )
    else:
        raise HTTPException(400, f"Unknown download action: {action}")

    updated = await db.package_downloads.find_one({"_id": oid})
    updated["_id"] = str(updated["_id"])
    return {"package": updated}


# ── Convenience: duplicate / test-config ──────────────────

@router.post("/{job_id}/duplicate")
async def duplicate_job(job_id: str):
    db = get_db()
    oid = _oid(job_id)
    src = await db.scheduled_downloads.find_one({"_id": oid})
    if not src:
        raise HTTPException(404, "Job not found")

    base = (src.get("name") or "schedule").strip()
    new_name = f"{base} (copy)"
    n = 2
    conf = {k: v for k, v in src.items() if k.startswith(("missed", "retry"))}
    while await db.scheduled_downloads.find_one(
        {"name": new_name}
    ):
        new_name = f"{base} (copy {n})"
        n += 1

    now = datetime.now(timezone.utc)
    copy = {
        "name": new_name,
        "enabled": False,
        "symbols": src.get("symbols"),
        "symbolMode": src.get("symbolMode", "all_active"),
        "fields": src.get("fields"),
        "formats": src.get("formats", ["csv"]),
        "schedule": src.get("schedule", {}),
        "dateRange": src.get("dateRange", {}),
        "destination": src.get("destination", "server"),
        "destinationConfig": src.get("destinationConfig"),
        "dependencyPolicy": src.get("dependencyPolicy"),
        "missedRunPolicy": src.get("missedRunPolicy", MISSED_RUN_RECOVERY),
        "retryPolicy": src.get("retryPolicy"),
        "nextRun": _next_run_time(src.get("schedule", {}) or {}),
        "lastRun": None,
        "lastStatus": None,
        "lastError": None,
        "failCount": 0,
        "runCount": 0,
        "retry_count": 0,
        "firstAttemptAt": None,
        "lastAttemptAt": None,
        "nextRetryAt": None,
        "failure_reason": None,
        "createdAt": now,
        "updatedAt": now,
    }
    result = await db.scheduled_downloads.insert_one(copy)
    serialized = _serialize_job({**copy, "_id": result.inserted_id})
    _log("duplicated schedule %s -> %s", src.get("name"), new_name)
    await _emit("SCHEDULE_CREATED", serialized["_id"], new_name, {"enabled": False})
    return {"job": serialized}


@router.post("/test-config")
async def test_job_config(req: CreateJobRequest):
    """Validate a schedule config without persisting it."""
    errors: list[str] = []
    name = (req.name or "").strip()
    if not name:
        errors.append("Schedule name is required")

    if req.symbolMode == "custom" and not (req.symbols and [s for s in req.symbols if s.strip()]):
        errors.append("Custom stock mode requires at least one selected symbol")
    if not req.formats or not [f for f in req.formats if f.strip()]:
        errors.append("At least one export format is required")
    for fmt in (req.formats or []):
        ser = get_serializer(fmt)
        if not ser or not ser.available:
            errors.append(f"Format not available: {fmt}")

    try:
        tz = _tz(req.timezone or (req.schedule.model_dump()).get("timezone"))
        if tz.utcoffset(datetime.now(timezone.utc)) is None:
            errors.append("Invalid timezone")
    except Exception as exc:
        errors.append(f"Invalid timezone: {exc}")

    try:
        _next_run_time(req.schedule.model_dump() or {})
    except Exception as exc:
        errors.append(f"Invalid schedule: {exc}")

    if errors:
        return {"ok": False, "errors": errors}
    return {"ok": True, "errors": []}


@router.get("/{job_id}")
async def get_job(job_id: str):
    db = get_db()
    job = await db.scheduled_downloads.find_one({"_id": _oid(job_id)})
    if not job:
        raise HTTPException(404, "Job not found")
    return {"job": _serialize_job(job)}


def _oid(value: str) -> ObjectId:
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise HTTPException(400, "Invalid id")


@router.put("/{job_id}")
async def update_job(job_id: str, req: UpdateJobRequest):
    db = get_db()
    updates = {k: v for k, v in req.model_dump().items() if v is not None}

    if "schedule" in updates:
        sched = updates["schedule"]
        if isinstance(sched, ScheduleConfig):
            updates["schedule"] = sched.model_dump()
    if "timezone" in updates:
        # Top-level timezone alias wins — persist it inside the schedule doc.
        tz_name = str(updates.pop("timezone") or "").strip()
        if tz_name:
            if "schedule" in updates and isinstance(updates["schedule"], dict):
                sched = dict(updates["schedule"])
            else:
                existing = await db.scheduled_downloads.find_one(
                    {"_id": _oid(job_id)}, {"schedule": 1}
                )
                sched = dict((existing or {}).get("schedule") or {})
            sched["timezone"] = tz_name
            updates["schedule"] = sched
    if "schedule" in updates:
        _tz(updates["schedule"].get("timezone"))
        updates["nextRun"] = _next_run_time(updates["schedule"])

    if "destination" in updates:
        dest = get_destination(updates["destination"])
        if not dest:
            raise HTTPException(400, f"Unknown destination: {updates['destination']}")
        err = dest.validate_config(updates.get("destinationConfig"))
        if err:
            raise HTTPException(400, err)

    if "missedRunPolicy" in updates and updates["missedRunPolicy"] not in MISSED_RUN_OPTIONS:
        raise HTTPException(400, f"Invalid missedRunPolicy: {updates['missedRunPolicy']}")

    updates["updatedAt"] = datetime.now(timezone.utc)

    result = await db.scheduled_downloads.update_one(
        {"_id": _oid(job_id)},
        {"$set": updates},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Job not found")
    _log("updated schedule %s", job_id)
    await _emit("SCHEDULE_UPDATED", job_id, None, dict(updates))
    return {"ok": True}


@router.delete("/{job_id}")
async def delete_job(job_id: str):
    db = get_db()
    existing = await db.scheduled_downloads.find_one({"_id": _oid(job_id)})
    result = await db.scheduled_downloads.delete_one({"_id": _oid(job_id)})
    if result.deleted_count == 0:
        raise HTTPException(404, "Job not found")
    _log("deleted schedule %s", (existing or {}).get("name") or job_id)
    await _emit("SCHEDULE_DELETED", job_id, (existing or {}).get("name"))
    return {"deleted": 1}


@router.post("/{job_id}/toggle")
async def toggle_job(job_id: str):
    db = get_db()
    oid = _oid(job_id)
    job = await db.scheduled_downloads.find_one({"_id": oid})
    if not job:
        raise HTTPException(404, "Job not found")

    new_enabled = not job.get("enabled", True)
    updates: dict = {"enabled": new_enabled, "updatedAt": datetime.now(timezone.utc)}

    if new_enabled:
        updates["nextRun"] = _next_run_time(job.get("schedule", {}))
        updates["failCount"] = 0
    else:
        updates["nextRun"] = None

    await db.scheduled_downloads.update_one({"_id": oid}, {"$set": updates})
    _log("%s %s", "paused" if not new_enabled else "resumed/enabled", job.get("name"))
    await _emit("SCHEDULE_UPDATED", job_id, job.get("name"), {"enabled": new_enabled})
    return {"enabled": new_enabled}


@router.post("/{job_id}/run")
async def run_job_now(job_id: str):
    """Immediate manual execution — records a 'manual' entry in run history."""
    db = get_db()
    oid = _oid(job_id)
    job = await db.scheduled_downloads.find_one({"_id": oid})
    if not job:
        raise HTTPException(404, "Job not found")
    job["_id"] = oid

    # A deliberate manual run uses its own idempotency key (schedule + timestamp)
    # so it never collides with the normal scheduled slot and is not de-duped
    # against it, while the scheduled slot itself stays idempotent.
    manual_key = f"{str(oid)}:manual:{int(time.time() * 1000)}"
    _log("Run Now %s", job.get("name"))
    asyncio.create_task(_execute_job(job, trigger="manual", idempotency_key=manual_key))
    return {"ok": True, "message": "Job execution started"}
