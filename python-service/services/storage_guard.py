"""Storage budget guard — keep MongoDB inside its cluster quota.

The 06:00 IST wipe in :mod:`services.atlas_cleanup` bounds Atlas storage
*across* days, but it cannot help *within* a day: one trading session of 1m
candles for the full subscribed universe is roughly 140 MB, which is enough to
exhaust a 512 MB free-tier cluster while the market is still open. Once the
cluster is write-blocked every write path fails, the DB Writer drops live ticks
and the API stops answering - the failure mode this module exists to prevent.

So this guard is deliberately independent of the calendar. It reads the REAL
storage usage reported by the server, and while usage is over budget it
deletes the oldest days from the high-volume, regenerable market-data
collections only. Everything that is not regenerable is never touched.

Design constraints:

* Only collections in :data:`PRUNABLE_COLLECTIONS` are ever deleted from, and
  those are the same temporary collections the daily wipe already treats as
  disposable.
* Oldest-first, by the ``date`` field the candle/tick documents carry, so the
  freshest part of the trading day is always the part that survives.
* Bounded batches, so a guard pass never issues one giant server-side delete
  and never blocks the event loop for long.
* A failed guard pass is non-fatal and is retried on the next tick; it must
  never be the reason the backend goes down.
* Storage numbers come from ``dbStats``/``collStats`` — never estimated or
  invented — and a run is auditable through the returned report.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("storage_guard")

# Ordered oldest-data-first is applied per collection via the `date` field, so
# the order here is only about which collection gives ground first: the 1m
# candles dominate storage, hence they are trimmed first.
PRUNABLE_COLLECTIONS: tuple[str, ...] = (
    "market_candles_1m",
    "market_candles_5m",
    "market_candles_10m",
    "market_candles_30m",
    "market_ticks",
)

# Each delete_many touches at most this many documents.
_DELETE_BATCH = 20_000
# Never spend an unbounded amount of time in one pass.
_MAX_BATCHES_PER_COLLECTION = 40
# Do not bother querying storage when the server reports less than this.
_MIN_USEFUL_BYTES = 1 * 1024 * 1024
# Minimum gap between two automatic cleanups so a still-full cluster does not
# re-trigger a wipe on every 5-minute tick.
_AUTO_CLEAN_COOLDOWN_SEC = 1800

_lock = asyncio.Lock()
_guard_task: asyncio.Task | None = None
_last_auto_clean_mono: float | None = None
_last_auto_clean_at: str | None = None


def _capacity_bytes(settings) -> int:
    """Configured cluster capacity. The driver never reports the Atlas quota,
    so this is the only honest denominator for a "percent full" number."""
    capacity_mb = getattr(settings, "storage_capacity_mb", 512) or 512
    return max(1, int(capacity_mb)) * 1048576


def _autoclean_pct(settings) -> int:
    pct = getattr(settings, "storage_autoclean_pct", 90) or 90
    return max(1, min(100, int(pct)))


def _mb(value: float) -> float:
    return round(value / 1048576, 2)


async def _storage_bytes(db) -> int | None:
    """Real bytes used by data + indexes, or None if the server won't say."""
    try:
        stats = await db.command("dbStats")
    except Exception as exc:
        logger.debug("storage guard: dbStats unavailable: %s", exc)
        return None
    return int(stats.get("storageSize", 0) or 0) + int(stats.get("indexSize", 0) or 0)


async def _distinct_dates(coll) -> list[str]:
    """Existing ``date`` values, oldest first. Real values only."""
    try:
        values = await coll.distinct("date")
    except Exception as exc:
        logger.debug("storage guard: distinct('date') failed: %s", exc)
        return []
    clean = sorted({str(v) for v in values if v not in (None, "")})
    return clean


async def _prune_oldest_day(db, name: str) -> int:
    """Delete the oldest day of documents in ``name``. Returns docs deleted."""
    coll = db[name]
    dates = await _distinct_dates(coll)
    if not dates:
        return 0
    oldest = dates[0]
    deleted = 0
    for _ in range(_MAX_BATCHES_PER_COLLECTION):
        cursor = coll.find({"date": oldest}, {"_id": 1}).limit(_DELETE_BATCH)
        ids = [doc["_id"] async for doc in cursor]
        if not ids:
            break
        try:
            res = await coll.delete_many({"_id": {"$in": ids}})
        except Exception as exc:
            logger.warning("storage guard: delete failed on %s: %s", name, exc)
            break
        deleted += int(res.deleted_count or 0)
        if len(ids) < _DELETE_BATCH:
            break
    return deleted


async def storage_guard_status() -> dict[str, Any]:
    """Read-only view of real storage usage vs budget AND vs the % threshold.

    Never deletes. ``usagePct`` is measured against the configured cluster
    capacity (Atlas M0 = 512 MB); when it reaches ``thresholdPct`` the guard
    auto-runs the safe cleanup pass on its next tick.
    """
    from config.settings import settings

    capacity = _capacity_bytes(settings)
    threshold = _autoclean_pct(settings)
    report: dict[str, Any] = {
        "ok": False,
        "enabled": bool(settings.storage_guard_enabled),
        "budgetMb": settings.storage_budget_mb,
        "capacityMb": capacity // 1048576,
        "thresholdPct": threshold,
        "autoArmed": bool(settings.storage_guard_enabled),
        "lastAutoCleanAt": _last_auto_clean_at,
        "intervalSec": int(settings.storage_guard_interval_sec),
        "at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        from database.connection import get_db

        db = get_db()
    except Exception as exc:
        report["error"] = str(exc)[:300]
        return report
    if db is None:
        report["reason"] = "no_database"
        return report
    try:
        used = await _storage_bytes(db)
    except Exception as exc:
        report["error"] = str(exc)[:300]
        return report
    if used is None:
        report["reason"] = "storage_unknown"
        return report

    report["ok"] = True
    report["usedMb"] = _mb(used)
    report["usagePct"] = round(used / capacity * 100, 1)
    report["overBudget"] = used > int(settings.storage_budget_mb) * 1048576
    report["overThreshold"] = report["usagePct"] >= threshold
    if report["overThreshold"]:
        report["reason"] = "over_threshold"
    else:
        report["reason"] = "over_budget" if report["overBudget"] else "within_budget"
    return report


async def run_storage_guard(trigger: str = "schedule") -> dict[str, Any]:
    """Keep the cluster usable: auto-cleanup at the % threshold, else trim.

    * Usage at/beyond ``STORAGE_AUTOCLEAN_PCT`` of ``STORAGE_CAPACITY_MB``
      auto-runs the safe cleanup pass (temporary market data + telemetry —
      same code path as the 06:00 IST wipe and the manual button), at most
      once per cooldown window.
    * Otherwise, while usage is over the MB budget, only the oldest
      regenerable market data is trimmed.

    Returns a report describing what was measured and deleted. Never raises.
    """
    from config.settings import settings

    global _last_auto_clean_mono, _last_auto_clean_at

    capacity = _capacity_bytes(settings)
    threshold = _autoclean_pct(settings)
    report: dict[str, Any] = {
        "ok": False,
        "trigger": trigger,
        "enabled": bool(settings.storage_guard_enabled),
        "budgetMb": settings.storage_budget_mb,
        "capacityMb": capacity // 1048576,
        "thresholdPct": threshold,
        "at": datetime.now(timezone.utc).isoformat(),
        "deleted": {},
    }
    if not settings.storage_guard_enabled:
        report["reason"] = "disabled"
        return report

    async with _lock:
        try:
            from database.connection import get_db

            db = get_db()
        except Exception as exc:
            report["error"] = str(exc)[:300]
            return report
        if db is None:
            report["reason"] = "no_database"
            return report

        try:
            used = await _storage_bytes(db)
        except Exception as exc:
            report["error"] = str(exc)[:300]
            return report
        if used is None:
            report["reason"] = "storage_unknown"
            return report

        usage_pct = round(used / capacity * 100, 1)
        report["usedMb"] = _mb(used)
        report["usagePct"] = usage_pct
        report["overThreshold"] = usage_pct >= threshold

        # --- 90%-style auto-cleanup: run the safe wipe, then re-measure. ---
        if usage_pct >= threshold:
            now_mono = time.monotonic()
            if _last_auto_clean_mono is not None and now_mono - _last_auto_clean_mono < _AUTO_CLEAN_COOLDOWN_SEC:
                report["ok"] = True
                report["reason"] = "auto_cooldown"
                report["lastAutoCleanAt"] = _last_auto_clean_at
                return report
            try:
                from services import atlas_cleanup

                cleaned = await atlas_cleanup.run_cleanup(trigger="auto-storage-pct")
            except Exception as exc:
                report["error"] = f"auto cleanup failed: {exc}"[:300]
                return report
            _last_auto_clean_mono = time.monotonic()
            _last_auto_clean_at = datetime.now(timezone.utc).isoformat()
            report["lastAutoCleanAt"] = _last_auto_clean_at
            report["autoCleanup"] = {
                "deleted": cleaned.get("totalDeleted"),
                "status": cleaned.get("status"),
                "error": cleaned.get("error"),
            }
            try:
                used = await _storage_bytes(db)
            except Exception:
                used = None
            if used is not None:
                report["usedMbAfter"] = _mb(used)
                report["usagePctAfter"] = round(used / capacity * 100, 1)
            report["ok"] = True
            report["reason"] = "auto_cleanup"
            logger.warning(
                "Storage guard: usage %.1f%% >= %d%% — auto cleanup ran (%s, %s records)",
                usage_pct, threshold, cleaned.get("status"), cleaned.get("totalDeleted"),
            )
            return report

        budget = int(settings.storage_budget_mb) * 1048576
        report["budgetMb"] = settings.storage_budget_mb
        report["overBudget"] = used > budget
        if used <= budget:
            report["ok"] = True
            report["reason"] = "within_budget"
            return report

        logger.warning(
            "Storage guard: %.1f MB used exceeds the %d MB budget - trimming "
            "oldest regenerable market data", _mb(used), settings.storage_budget_mb,
        )

        # Keep trimming oldest days, round-robin across collections, until the
        # cluster is back inside budget or there is nothing left to trim.
        for _ in range(_MAX_BATCHES_PER_COLLECTION):
            used = await _storage_bytes(db)
            if used is None or used <= budget:
                break
            trimmed_this_pass = 0
            for name in PRUNABLE_COLLECTIONS:
                if used is not None and used <= budget:
                    break
                removed = await _prune_oldest_day(db, name)
                if removed:
                    trimmed_this_pass += removed
                    report["deleted"][name] = report["deleted"].get(name, 0) + removed
            if not trimmed_this_pass:
                report["reason"] = "nothing_left_to_trim"
                break

        used = await _storage_bytes(db)
        report["usedMbAfter"] = _mb(used) if used is not None else None
        report["ok"] = True
        if report["deleted"]:
            report["reason"] = "trimmed"
        else:
            # Nothing was removable (empty collections, or deletes are being
            # rejected by the server). Say so instead of claiming success.
            report["reason"] = report.get("reason") or "nothing_left_to_trim"

    if report.get("deleted"):
        logger.warning("Storage guard trimmed: %s", report["deleted"])
    return report


async def _guard_loop() -> None:
    from config.settings import settings

    while True:
        try:
            await asyncio.sleep(max(30, int(settings.storage_guard_interval_sec)))
            await run_storage_guard(trigger="schedule")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("Storage guard pass failed (non-fatal)", exc_info=True)
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                raise


def start_storage_guard() -> asyncio.Task | None:
    """Start the periodic guard loop. Idempotent; returns the task or None."""
    global _guard_task
    if _guard_task is not None and not _guard_task.done():
        return _guard_task
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    _guard_task = loop.create_task(_guard_loop())
    return _guard_task


async def stop_storage_guard() -> None:
    """Cancel the guard loop (lifespan shutdown)."""
    global _guard_task
    if _guard_task is not None:
        _guard_task.cancel()
        try:
            await _guard_task
        except (asyncio.CancelledError, Exception):
            pass
        _guard_task = None


__all__ = [
    "PRUNABLE_COLLECTIONS",
    "run_storage_guard",
    "storage_guard_status",
    "start_storage_guard",
    "stop_storage_guard",
]
