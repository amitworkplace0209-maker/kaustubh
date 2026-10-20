"""Atlas daily cleanup — 06:00 Asia/Kolkata wipe of temporary market data.

MongoDB Atlas is TEMPORARY storage in the KAUSTUBH architecture: every trading
day's tick/telemetry payload is deleted at 06:00 IST so the database stays a
bounded rolling store.

Two independent mechanisms (either one is sufficient):

1. Backend scheduler (this module) — runs in-process when the backend is up.
   Started from ``app.py`` lifespan via :func:`start_cleanup_scheduler`.
2. Atlas Scheduled Trigger — runs Atlas-side even when the backend/VM is
   offline. Deploy ``atlas_cleanup_trigger.js`` in the Atlas UI; the exact
   steps live in ``docs/ATLAS_CLEANUP_SETUP.md``.

Collection classification (reviewed against the live schema — see module
docstring of ``database.connection``):

TEMPORARY (deleted at 06:00):
    ticks, market_ticks, market_candles_1m/2m/5m/10m/30m, market_watch_decisions,
    data_saver_telemetry, api_telemetry, websocket_telemetry,
    websocket_history, websocket_events,
    quality_snapshot, quality_scans, app_logs

FULL CLEAN (manual "Full clean" button only — user-confirmed wipe of ALL
regenerable/user-visible data, including ticks, notifications, alerts and
history reports):
    everything in TEMPORARY, plus notifications, alerts, system_events,
    events, audit_trail, download_history, scheduled_downloads,
    scheduler_runs, schedule_runs, daily_summaries, data_saver_incidents,
    data_saver_daily_reports, data_saver_weekly_reports,
    data_center_snapshots, quality_issues, export_jobs

NEVER WIPED (not even by Full clean — required for the app to function):
    app_settings, engine_config, stocks, watchlist, baskets,
    session_manager_*, market_watch_report/filters/pins, quality config,
    atlas_cleanup_log (this module's own audit trail), _migrations, dummy_*.

Safety properties: idempotent (re-running deletes 0 docs), observable (every
run writes one audit doc to ``atlas_cleanup_log``), chunked (large collections
are cleared in bounded ``_id`` batches so availability is never blocked by a
single giant server-side op), concurrent-run guarded.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger("atlas_cleanup")

from core.timezones import IST
CLEANUP_LOG_COLL = "atlas_cleanup_log"

# High-volume / regenerable market data + telemetry + scan points. Everything
# NOT listed here is preserved.
TEMPORARY_COLLECTIONS: tuple[str, ...] = (
    "ticks",
    "market_ticks",
    "market_candles_1m",
    "market_candles_2m",
    "market_candles_5m",
    "market_candles_10m",
    "market_candles_30m",
    "market_watch_decisions",
    "data_saver_telemetry",
    "api_telemetry",
    "websocket_telemetry",
    "websocket_history",
    "websocket_events",
    "quality_snapshot",
    "quality_scans",
    "app_logs",
)

# Extra collections wiped ONLY by an explicit user-confirmed "Full clean".
# Config/operational collections (app_settings, engine_config, stocks,
# watchlist, baskets, session_manager_*, market_watch_*, _migrations,
# atlas_cleanup_log, dummy_*) are NEVER in either list.
FULL_CLEAN_EXTRA_COLLECTIONS: tuple[str, ...] = (
    "notifications",
    "alerts",
    "system_events",
    "events",
    "audit_trail",
    "download_history",
    "scheduled_downloads",
    "scheduler_runs",
    "schedule_runs",
    "daily_summaries",
    "data_saver_incidents",
    "data_saver_daily_reports",
    "data_saver_weekly_reports",
    "data_center_snapshots",
    "quality_issues",
    "export_jobs",
)

#: Full clean covers every temporary collection plus the user-visible data above.
FULL_CLEAN_COLLECTIONS: tuple[str, ...] = TEMPORARY_COLLECTIONS + FULL_CLEAN_EXTRA_COLLECTIONS

# Bounded batches: each delete_many touches at most this many docs.
_DELETE_BATCH_SIZE = 50_000
# Hard stop so a pathological collection can never loop forever.
_MAX_BATCHES_PER_COLLECTION = 2_000

_lock = asyncio.Lock()
_running = False
_scheduler_task: asyncio.Task | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def next_cleanup_ist(now: datetime | None = None) -> datetime:
    """Next 06:00 Asia/Kolkata occurrence after ``now`` (timezone-aware IST)."""
    from config.settings import settings
    now_ist = (now or datetime.now(timezone.utc)).astimezone(IST)
    target = now_ist.replace(
        hour=settings.atlas_cleanup_hour,
        minute=settings.atlas_cleanup_minute,
        second=0,
        microsecond=0,
    )
    if target <= now_ist:
        target = target + timedelta(days=1)
    return target


async def _clear_collection(db, name: str) -> dict[str, Any]:
    """Delete every doc in ``name`` in bounded _id batches. Returns stats."""
    coll = db[name]
    try:
        before = await coll.estimated_document_count()
    except Exception:
        try:
            before = await coll.count_documents({})
        except Exception as exc:
            return {"name": name, "deleted": 0, "error": str(exc)[:300]}
    deleted = 0
    try:
        for _ in range(_MAX_BATCHES_PER_COLLECTION):
            cursor = coll.find({}, {"_id": 1}).limit(_DELETE_BATCH_SIZE)
            ids = [doc["_id"] async for doc in cursor]
            if not ids:
                break
            res = await coll.delete_many({"_id": {"$in": ids}})
            deleted += int(res.deleted_count or 0)
            if res.deleted_count < len(ids):
                # Fewer deleted than fetched — drain finished (or docs raced).
                leftover = await coll.estimated_document_count()
                if leftover == 0:
                    break
                if res.deleted_count == 0:
                    break
    except Exception as exc:
        logger.warning("Atlas cleanup batch on %s failed: %s", name, exc)
        return {"name": name, "deleted": deleted, "error": str(exc)[:300]}
    return {"name": name, "deleted": deleted, "before": int(before or 0)}


async def _run_pass(*, trigger: str, collections: tuple[str, ...], mode: str) -> dict[str, Any]:
    """Shared pass runner for safe + full cleanup. Idempotent + guarded."""
    global _running
    async with _lock:
        if _running:
            return {"ok": False, "error": "cleanup already running"}
        _running = True
    started_at = _now_iso()
    started_mono = time.monotonic()
    result: dict[str, Any] = {
        "ok": False,
        "trigger": trigger,
        "mode": mode,
        "startedAt": started_at,
        "status": "FAILED",
        "collections": [],
        "totalDeleted": 0,
        "collectionsCleaned": 0,
    }
    try:
        from database.connection import get_db, is_mongo_connected
        if not is_mongo_connected():
            result["error"] = "MongoDB is not connected"
            return result
        db = get_db()
        existing = set(await db.list_collection_names())
        per_coll: list[dict[str, Any]] = []
        for name in collections:
            if name not in existing:
                per_coll.append({"name": name, "deleted": 0, "skipped": True})
                continue
            stat = await _clear_collection(db, name)
            per_coll.append(stat)
        result["collections"] = per_coll
        result["totalDeleted"] = sum(int(c.get("deleted") or 0) for c in per_coll)
        result["collectionsCleaned"] = sum(
            1 for c in per_coll if not c.get("skipped") and not c.get("error")
        )
        failed = [c for c in per_coll if c.get("error")]
        result["ok"] = not failed
        result["status"] = "SUCCESS" if not failed else "PARTIAL"
        if failed:
            result["error"] = "; ".join(
                f"{c['name']}: {c['error']}" for c in failed
            )[:500]
    except Exception as exc:
        logger.exception("Atlas cleanup pass failed")
        result["error"] = str(exc)[:500]
    finally:
        result["finishedAt"] = _now_iso()
        result["durationSec"] = round(time.monotonic() - started_mono, 2)
        try:
            from database.connection import get_db, is_mongo_connected
            if is_mongo_connected():
                db = get_db()
                await db[CLEANUP_LOG_COLL].insert_one({
                    "trigger": trigger,
                    "mode": mode,
                    "startedAt": started_at,
                    "finishedAt": result["finishedAt"],
                    "status": result["status"],
                    "totalDeleted": result["totalDeleted"],
                    "collectionsCleaned": result["collectionsCleaned"],
                    "collections": result["collections"],
                    "error": result.get("error"),
                    "ts": datetime.now(timezone.utc),
                })
                await db[CLEANUP_LOG_COLL].create_index([("ts", -1)])
        except Exception as exc:
            logger.warning("Cleanup audit log write failed (non-fatal): %s", exc)
        async with _lock:
            _running = False
    logger.info(
        "Atlas cleanup %s via %s: %d records in %d collections (%.1fs)",
        result["status"], trigger, result["totalDeleted"],
        result["collectionsCleaned"], result["durationSec"],
    )
    return result


async def run_cleanup(*, trigger: str = "manual") -> dict[str, Any]:
    """Safe cleanup pass: temporary market data + telemetry only.

    ``trigger`` is ``"schedule"`` (06:00 loop), ``"manual"`` (API) or
    ``"atlas-trigger"`` (Atlas-side function calling back / docs marker).
    Always writes an audit doc to ``atlas_cleanup_log`` (persistent).
    """
    return await _run_pass(trigger=trigger, collections=TEMPORARY_COLLECTIONS, mode="safe")


async def run_full_cleanup(*, trigger: str = "manual-full") -> dict[str, Any]:
    """Full user-confirmed wipe of ALL regenerable/user-visible data.

    Covers every safe-cleanup collection PLUS ticks history, notifications,
    alerts, system/audit events, download history, scheduler runs, daily and
    weekly reports, stored snapshots, quality issues and export jobs.
    Config/operational collections (settings, stocks, watchlist, baskets,
    sessions, pins, migrations, the cleanup log itself) are NEVER touched.
    """
    return await _run_pass(trigger=trigger, collections=FULL_CLEAN_COLLECTIONS, mode="full")


async def get_cleanup_status() -> dict[str, Any]:
    """Real cleanup state for the Data Center: last run + next 06:00 IST.

    Also carries the live ``storage`` block (real dbStats usage vs the
    configured capacity + the auto-cleanup threshold) so the Data Center can
    show "% full" and the armed auto-cleanup without a second request.
    """
    from config.settings import settings
    out: dict[str, Any] = {
        "ok": True,
        "enabled": settings.atlas_cleanup_enabled,
        "timezone": "Asia/Kolkata",
        "schedule": f"{settings.atlas_cleanup_hour:02d}:{settings.atlas_cleanup_minute:02d} IST daily",
        "nextCleanup": next_cleanup_ist().isoformat(),
        "last": None,
    }
    try:
        from services import storage_guard

        out["storage"] = await storage_guard.storage_guard_status()
    except Exception as exc:
        logger.debug("cleanup status: storage block unavailable: %s", exc)
        out["storage"] = {"ok": False, "error": str(exc)[:200]}
    try:
        from database.connection import get_db, is_mongo_connected
        if not is_mongo_connected():
            out["ok"] = False
            out["error"] = "MongoDB is not connected"
            return out
        db = get_db()
        if CLEANUP_LOG_COLL in await db.list_collection_names():
            doc = await db[CLEANUP_LOG_COLL].find(
                {}, {"_id": 0}
            ).sort("ts", -1).limit(1).to_list(1)
            if doc:
                last = doc[0]
                ts = last.get("ts")
                out["last"] = {
                    "trigger": last.get("trigger"),
                    "mode": last.get("mode") or ("full" if str(last.get("trigger") or "").endswith("full") else "safe"),
                    "startedAt": last.get("startedAt"),
                    "finishedAt": last.get("finishedAt"),
                    "status": last.get("status"),
                    "totalDeleted": last.get("totalDeleted"),
                    "collectionsCleaned": last.get("collectionsCleaned"),
                    "error": last.get("error"),
                    "collections": [
                        {"name": c.get("name"), "deleted": c.get("deleted"),
                         "error": c.get("error")}
                        for c in (last.get("collections") or [])
                        if not c.get("skipped")
                    ],
                }
                if isinstance(ts, datetime):
                    out["last"]["ts"] = ts.isoformat()
    except Exception as exc:
        out["ok"] = False
        out["error"] = str(exc)[:300]
    return out


async def _scheduler_loop() -> None:
    """Sleep until the next 06:00 IST, run cleanup, repeat (self-healing)."""
    from config.settings import settings
    while True:
        try:
            now_utc = datetime.now(timezone.utc)
            wait = (next_cleanup_ist(now_utc) - now_utc.astimezone(IST)).total_seconds()
            await asyncio.sleep(max(1.0, wait))
            if not settings.atlas_cleanup_enabled:
                logger.info("Atlas cleanup schedule skipped (ATLAS_CLEANUP_ENABLED=0)")
                continue
            try:
                await run_cleanup(trigger="schedule")
            except Exception:
                logger.exception("Scheduled Atlas cleanup failed (non-fatal)")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("Atlas cleanup scheduler pass skipped (non-fatal)", exc_info=True)
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                raise


def start_cleanup_scheduler() -> asyncio.Task | None:
    """Start the 06:00 IST loop. Returns the task (idempotent)."""
    global _scheduler_task
    if _scheduler_task is not None and not _scheduler_task.done():
        return _scheduler_task
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    _scheduler_task = loop.create_task(_scheduler_loop())
    return _scheduler_task


async def stop_cleanup_scheduler() -> None:
    """Cancel the 06:00 IST loop (lifespan shutdown)."""
    global _scheduler_task
    if _scheduler_task is not None:
        _scheduler_task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(_scheduler_task), timeout=3)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        _scheduler_task = None
