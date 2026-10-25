"""Unified user-defined event scheduler (Data Saver — Schedules).

Downloads already have their dedicated engine (``api/scheduled_downloads.py``:
export/ZIP jobs on ``schedule_runs``). Everything ELSE a user may want to
schedule — the real hooks this backend owns — lives HERE as one registry:

    quality_scan     services.data_quality.run_scan          (bounded, persisted)
    atlas_cleanup    services.atlas_cleanup.run_cleanup      (temporary data only)
    flush_pipeline   services.tick_buffer.flush              (in-memory → Mongo)
    session_login    scheduler.do_login(source="scheduler")  (dedup-guarded)
    session_logout   scheduler.do_logout()                   (scheduled_logout)
    square_off       core.engines.squareoff_engine           (needs confirmation)
    market_scan      services.market_scan.compute            (full-universe scan)
    shutdown         orderly preflush + process exit         (needs confirmation)
    notify           a pure on-device reminder               (browser delivers)

Every event is a Mongo doc in ``scheduled_events`` with a schedule
(once/daily/weekdays/weekly + HH:MM + IANA tz, default Asia/Kolkata), params
validated per kind, and an on-device notification policy (lead minutes +
completion flag) the BROWSER honours by counting down to ``nextRun``.

Every run appends to ``scheduled_event_runs`` (bounded) and emits the SAME
``SCHEDULE_*`` grammar on the schedule-events bus that downloads already use
(``services.event_bus``), so the existing SSE stream feeds the unified page.
Nothing is invented: an action that never ran keeps runCount 0 and its
fields None; a missed one-shot is recorded ``MISSED``, never faked as run.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

logger = logging.getLogger("app.event_scheduler")

#: Fast internal cadence — due-event precision is this tick.
TICK_SECONDS = 5.0

#: A due event missed by more than this is a catch-up / missed decision point.
MISSED_WINDOW_SEC = 15 * 60.0

#: Bounded run-history cap per event.
RUN_HISTORY_CAP = 100

EVENTS_COLL = "scheduled_events"
RUNS_COLL = "scheduled_event_runs"

_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# --------------------------------------------------------------------------- #
# Action registry — the ONLY kinds a user may schedule, and what each does
# --------------------------------------------------------------------------- #

KINDS: dict[str, dict[str, Any]] = {
    "quality_scan": {
        "label": "Data quality scan",
        "description": "Runs the real data-quality scan (metrics, issues, notifications).",
        "requiresConfirm": False,
    },
    "atlas_cleanup": {
        "label": "Atlas cleanup",
        "description": "Safe cleanup pass over temporary market data + telemetry (audit-logged).",
        "requiresConfirm": False,
    },
    "flush_pipeline": {
        "label": "Flush tick pipeline",
        "description": "Flushes the in-memory tick buffer to MongoDB immediately.",
        "requiresConfirm": False,
    },
    "session_login": {
        "label": "Broker session login",
        "description": "Logs the broker session in (skipped when a live session already exists).",
        "requiresConfirm": False,
    },
    "session_logout": {
        "label": "Broker session logout",
        "description": "Cleanly logs the broker session out (scheduled_logout path).",
        "requiresConfirm": False,
    },
    "square_off": {
        "label": "Square off (close all)",
        "description": "Hands the close-all flow to the Square-Off Engine — real orders. Needs confirmation.",
        "requiresConfirm": True,
    },
    "market_scan": {
        "label": "Full market scan",
        "description": "Recomputes the full NSE scan document (watch_scan service) immediately.",
        "requiresConfirm": False,
    },
    "shutdown": {
        "label": "Service shutdown",
        "description": "Flushes the pipeline, logs the broker out, then EXITS the backend process. Needs confirmation.",
        "requiresConfirm": True,
    },
    "notify": {
        "label": "On-device reminder",
        "description": "Pure reminder: this device shows the notification at the scheduled time.",
        "requiresConfirm": False,
    },
}


def _validate_schedule(schedule: dict) -> tuple[dict, str | None]:
    """Validate the schedule block; returns (normalized, error)."""
    if not isinstance(schedule, dict):
        return {}, "schedule must be an object"
    kind = str(schedule.get("type") or "daily")
    if kind not in {"once", "daily", "weekdays", "weekly"}:
        return {}, f"invalid schedule.type '{kind}'"
    tz_name = str(schedule.get("timezone") or "Asia/Kolkata")
    try:
        ZoneInfo(tz_name)
    except Exception:
        return {}, f"invalid timezone '{tz_name}'"
    time_s = str(schedule.get("time") or "")
    m = _TIME_RE.match(time_s)
    if not m:
        return {}, "time must be HH:MM (24h)"
    days = schedule.get("days")
    norm: dict[str, Any] = {"type": kind, "time": time_s, "timezone": tz_name, "days": None, "date": None}
    if kind == "weekly":
        if not isinstance(days, list) or not days:
            return {}, "weekly requires a days list"
        try:
            day_set = sorted({int(d) for d in days})
        except (TypeError, ValueError):
            return {}, "days must be integers"
        if any(d < 0 or d > 6 for d in day_set):
            return {}, "days must be 0..6 (Monday=0)"
        norm["days"] = day_set
    elif kind == "weekdays":
        norm["days"] = [0, 1, 2, 3, 4]
    elif kind == "once":
        date_s = str(schedule.get("date") or "")
        if not _DATE_RE.match(date_s):
            return {}, "once requires date YYYY-MM-DD"
        try:
            y, mo, d = (int(x) for x in date_s.split("-"))
            datetime(y, mo, d)  # rejects 2026-13-01 and the like
        except ValueError:
            return {}, f"once date '{date_s}' is not a real calendar date"
        norm["date"] = date_s
    return norm, None


def _validate_params(kind: str, params: dict) -> tuple[dict, str | None]:
    """Validate per-kind params; only safety-relevant fields are read."""
    if not isinstance(params, dict):
        return {}, "params must be an object"
    out = dict(params)
    if kind in {"square_off", "shutdown"}:
        out["confirm"] = bool(out.get("confirm"))
    else:
        # benign kinds carry no confirmation semantics — keep payloads tidy
        out.pop("confirm", None)
    return out, None


def _validate_notify(notify: dict) -> tuple[dict, str | None]:
    if notify in (None, {}):
        return {"onDevice": True, "leadMinutes": 5, "onCompletion": True}, None
    if not isinstance(notify, dict):
        return {}, "notify must be an object"
    try:
        lead = int(notify.get("leadMinutes", 5))
    except (TypeError, ValueError):
        return {}, "notify.leadMinutes must be an integer"
    if lead < 0 or lead > 720:
        return {}, "notify.leadMinutes must be 0..720"
    return {
        "onDevice": bool(notify.get("onDevice", True)),
        "leadMinutes": lead,
        "onCompletion": bool(notify.get("onCompletion", True)),
    }, None


# --------------------------------------------------------------------------- #
# Next-run maths (IANA tz; Monday-first week to match the downloads engine)
# --------------------------------------------------------------------------- #

def compute_next_run(schedule: dict, from_utc: datetime) -> datetime | None:
    """First strictly-future occurrence of the schedule, or ``None`` when the
    schedule can simply no longer fire (a past one-shot)."""
    kind = str(schedule.get("type") or "daily")
    tz = ZoneInfo(str(schedule.get("timezone") or "Asia/Kolkata"))
    hm = str(schedule.get("time") or "00:00")
    hour, minute = int(hm[:2]), int(hm[3:5])
    now_local = from_utc.astimezone(tz)
    days = schedule.get("days")

    if kind == "once":
        date_s = schedule.get("date")
        if not isinstance(date_s, str) or not _DATE_RE.match(date_s):
            return None
        try:
            y, mo, d = (int(x) for x in date_s.split("-"))
        except ValueError:
            return None
        occurrence = datetime(y, mo, d, hour, minute, tzinfo=tz)
        return occurrence if occurrence > now_local else None

    candidate = now_local.replace(second=0, microsecond=0)
    for _ in range(0, 8):  # at most one week of days — schedules are simple
        occurrence = candidate.replace(hour=hour, minute=minute)
        if occurrence > now_local:
            if kind in {"weekdays", "weekly"}:
                weekday = occurrence.weekday()  # Monday == 0
                allowed = days if kind == "weekly" else [0, 1, 2, 3, 4]
                if isinstance(allowed, list) and weekday in set(allowed):
                    return occurrence
            elif kind == "daily":
                return occurrence
        candidate = (candidate + timedelta(days=1)).replace(hour=0, minute=0)
    return None


# --------------------------------------------------------------------------- #
# Action dispatch — the real backend hooks, nothing invented
# --------------------------------------------------------------------------- #

async def run_action(kind: str, params: dict) -> dict:
    """Execute one event kind against its REAL backend hook."""
    if kind == "quality_scan":
        from services.data_quality import run_scan

        return await run_scan(hours=24, trigger="scheduled_event")

    if kind == "atlas_cleanup":
        from services.atlas_cleanup import run_cleanup

        return await run_cleanup(trigger="scheduled_event")

    if kind == "flush_pipeline":
        from services import tick_buffer

        flushed = await tick_buffer.flush()
        return {"flushed": int(flushed)}

    if kind == "session_login":
        from scheduler import do_login

        ok = await do_login(source="scheduler")
        return {"success": bool(ok)}

    if kind == "session_logout":
        from scheduler import do_logout

        ok = await do_logout()
        return {"success": bool(ok)}

    if kind == "square_off":
        from scheduler import _active_mode_name
        from core.engines.squareoff_engine import squareoff_engine

        result = await squareoff_engine.execute_square_off(
            terminal=_active_mode_name(), source="scheduler",
        )
        return {
            "status": result.get("status") or ("COMPLETED" if result.get("ok") else "FAILED"),
            "filled": result.get("filled"),
            "failed": result.get("failed"),
        }

    if kind == "market_scan":
        from services.market_scan import market_scan

        doc = await asyncio.to_thread(market_scan.compute)
        scan = doc.get("scan") or {}
        return {
            "universeSize": scan.get("universeSize"),
            "liveTokens": scan.get("liveTokens"),
            "cycleMs": scan.get("cycleMs"),
        }

    if kind == "notify":
        # The device delivers this one — the browser counts down to nextRun
        # and honours the lead policy. Server-side there is nothing to do
        # but confirm scheduling (honesty: no fake server delivery).
        return {"deliveredBy": "browser_notification"}

    if kind == "shutdown":
        return await _execute_shutdown(params)

    return {"error": f"unknown kind '{kind}'"}


async def _execute_shutdown(params: dict) -> dict:
    """Orderly service shutdown: preflush + broker logout, then process exit.

    Runs the cleanup steps inline, then schedules the actual process exit a
    few seconds later so the run record + SSE frames still reach the browser.
    A test process (``pytest``) never exits — it simulates honestly instead.
    """
    steps: dict[str, Any] = {}
    try:
        from services import tick_buffer

        steps["flushed"] = await tick_buffer.flush()
    except Exception as exc:  # noqa: BLE001
        steps["flushed"] = f"failed: {exc}"
    try:
        from scheduler import do_logout

        logged_out = await do_logout(source="system")
        steps["loggedOut"] = bool(logged_out)
    except Exception as exc:  # noqa: BLE001
        steps["loggedOut"] = f"failed: {exc}"

    if os.environ.get("PYTEST_CURRENT_TEST"):
        steps["simulated"] = "test process — exit skipped"
        return {"steps": steps, "exitScheduled": False}

    delay = 6.0
    try:
        delay = max(1.0, min(float(params.get("exitAfterSeconds", delay)), 120.0))
    except (TypeError, ValueError):
        delay = 6.0

    async def _exit_task() -> None:
        await asyncio.sleep(delay)
        logger.warning("[EVENT_SCHEDULER] shutdown event: exiting process now")
        import signal

        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.get_running_loop().create_task(_exit_task())
    return {"steps": steps, "exitScheduled": True, "exitAfterSeconds": delay}


async def _emit(event: str, event_id: str | None, name: str | None,
                payload: dict | None = None) -> None:
    """Broadcast on the SAME bus the downloads engine uses (frame grammar)."""
    from services import event_bus

    body = dict(payload or {})
    body.update({
        "event": event,
        "scheduleId": event_id,
        "scheduleName": name,
        "ts": datetime.now(timezone.utc).isoformat(),
        "eventId": uuid.uuid4().hex[:12],
        "origin": "event_scheduler",
    })
    try:
        await event_bus.publish_event(body)
    except Exception:
        logger.debug("schedule event emit failed for %s", event)


# --------------------------------------------------------------------------- #
# The engine
# --------------------------------------------------------------------------- #

class EventScheduler:
    """CRUD-backed scheduler for every non-download event kind."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._running: set[str] = set()      # event ids currently executing
        self._starting = threading.Lock()

    # -- lifecycle ---------------------------------------------------------- #
    def ensure_started(self) -> None:
        if self._task is not None and not self._task.done():
            return
        with self._starting:
            if self._task is not None and not self._task.done():
                return
            self._task = asyncio.get_running_loop().create_task(self._loop())
            logger.info("[EVENT_SCHEDULER] unified event scheduler started")

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()

    async def _loop(self) -> None:
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — the loop must never die
                logger.warning("[EVENT_SCHEDULER] tick failed: %r", exc)
            await asyncio.sleep(TICK_SECONDS)

    async def _tick(self) -> None:
        db = None
        try:
            from database.connection import get_db

            db = get_db()
        except Exception:
            return
        now = datetime.now(timezone.utc)
        try:
            cursor = db[EVENTS_COLL].find({"enabled": True, "nextRun": {"$ne": None}})
            due = []
            async for doc in cursor:
                nxt = _as_utc(doc.get("nextRun"))
                if nxt is None:
                    continue
                if nxt <= now:
                    due.append(doc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[EVENT_SCHEDULER] due query failed: %r", exc)
            return
        for doc in due:
            await self._fire(doc, trigger="scheduled", now=now)

    # -- one fire ----------------------------------------------------------- #
    async def _fire(self, doc: dict, *, trigger: str, now: datetime | None = None) -> dict:
        event_id = str(doc.get("_id"))
        name = str(doc.get("name") or "")
        kind = str(doc.get("kind") or "")
        if event_id in self._running:
            return {"status": "SKIPPED", "reason": "already running"}
        self._running.add(event_id)
        now = now or datetime.now(timezone.utc)
        try:
            return await self._execute(doc, trigger=trigger, now=now)
        finally:
            self._running.discard(event_id)

    async def _execute(self, doc: dict, *, trigger: str, now: datetime) -> dict:
        from database.connection import get_db

        db = get_db()
        event_id = str(doc.get("_id"))
        name = str(doc.get("name") or "")
        kind = str(doc.get("kind") or "")
        params = doc.get("params") or {}
        scheduled_at = _as_utc(doc.get("nextRun")) or now

        # catch-up honesty: a slot way in the past is MISSED, never silently run
        lag = (now - scheduled_at).total_seconds()
        if trigger == "scheduled" and lag > MISSED_WINDOW_SEC:
            if str(doc.get("schedule", {}).get("type")) == "once":
                await db[EVENTS_COLL].update_one(
                    {"_id": event_id},
                    {"$set": {"nextRun": None, "lastRun": now, "lastStatus": "missed",
                              "lastError": "one-shot missed (backend was offline)",
                              "completedAt": now, "updatedAt": now}},
                )
                await _emit("SCHEDULE_MISSED", event_id, name, {"status": "missed"})
                return {"status": "MISSED"}
            # recurring: fall through and run once (catch-up), then recompute
            trigger = "missed_catchup"

        await db[EVENTS_COLL].update_one(
            {"_id": event_id},
            {"$set": {"lastRun": now, "lastStatus": "running", "updatedAt": now}},
        )
        await _emit("SCHEDULE_DUE", event_id, name, {"status": "due"})
        await _emit("SCHEDULE_RUNNING", event_id, name, {"status": "running"})

        status = "success"
        result: dict | None = None
        error: str | None = None
        try:
            requires_confirm = bool(KINDS.get(kind, {}).get("requiresConfirm"))
            if requires_confirm and not params.get("confirm"):
                status = "skipped"
                error = "requires confirmation — enable Confirm in the event"
            else:
                result = await run_action(kind, params)
        except Exception as exc:  # noqa: BLE001 — the run must record, not die
            status = "failed"
            error = repr(exc)

        if kind == "shutdown" and isinstance(result, dict) and result.get("exitScheduled"):
            status = "success"

        finished = datetime.now(timezone.utc)
        run_doc = {
            "eventId": event_id,
            "eventName": name,
            "kind": kind,
            "trigger": trigger,
            "scheduledAt": scheduled_at,
            "startedAt": now,
            "finishedAt": finished,
            "status": status,
            "result": result,
            "error": error,
            "durationMs": int((finished - now).total_seconds() * 1000),
        }
        try:
            await db[RUNS_COLL].insert_one(run_doc)
            await self._prune_runs(db, event_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[EVENT_SCHEDULER] run history write failed: %r", exc)

        # nextRun advances ONLY on a real scheduled slot: a manual/API run
        # must never consume the next slot or push a recurring schedule
        # forward (a 09:15 manual run of a daily 10:00 event would otherwise
        # silently DROP today's 10:00 firing). One-shots are DONE only when
        # the schedule itself fired them — honest, and the Re-arm flow on the
        # page takes over from there.
        schedule = doc.get("schedule") or {}
        update: dict[str, Any] = {
            "lastRun": finished,
            "lastStatus": status,
            "lastError": error,
            "lastResult": result,
            "updatedAt": finished,
            "trigger": trigger,
        }
        if trigger == "scheduled":
            if str(schedule.get("type")) == "once":
                update["nextRun"] = None
                update["completedAt"] = finished
            else:
                update["nextRun"] = compute_next_run(schedule, finished)
        try:
            await db[EVENTS_COLL].update_one({"_id": event_id}, {
                "$set": update,
                "$inc": {"runCount": 1, **({"failCount": 1} if status in {"failed"} else {})},
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("[EVENT_SCHEDULER] event update failed: %r", exc)

        frame_map = {"success": "SCHEDULE_COMPLETED", "failed": "SCHEDULE_FAILED",
                     "skipped": "SCHEDULE_SKIPPED", "running": "SCHEDULE_RUNNING"}
        await _emit(frame_map.get(status, "SCHEDULE_COMPLETED"), event_id, name, {
            "status": status,
            "result": result,
            "error": error,
            "durationMs": run_doc["durationMs"],
        })
        return {"status": status, "result": result, "error": error}

    async def _prune_runs(self, db: Any, event_id: str) -> None:
        try:
            cursor = db[RUNS_COLL].find({"eventId": event_id}).sort("startedAt", -1)
            docs = [d async for d in cursor.skip(RUN_HISTORY_CAP - 1)]
            if len(docs) >= 1:
                await db[RUNS_COLL].delete_many({
                    "eventId": event_id,
                    "_id": {"$in": [d["_id"] for d in docs]},
                })
        except Exception as exc:  # noqa: BLE001
            logger.debug("[EVENT_SCHEDULER] prune skipped: %r", exc)

    async def run_manual(self, event: dict) -> dict:
        """Trigger one event right now (does NOT move the schedule)."""
        self.ensure_started()
        return await self._fire(event, trigger="manual")


# --------------------------------------------------------------------------- #
# Document access for REST + the WS#3 ``sched_events`` snapshot channel
# --------------------------------------------------------------------------- #

_doc_cache: tuple[float, dict | None] = (0.0, None)


def _event_public(raw: dict) -> dict:
    """Bounded public event shape for REST + WS (README -- honest fields)."""
    return {
        "id": str(raw.get("_id")),
        "name": str(raw.get("name") or ""),
        "kind": str(raw.get("kind") or ""),
        "enabled": bool(raw.get("enabled")),
        "schedule": raw.get("schedule") or {},
        "params": raw.get("params") or {},
        "notify": raw.get("notify") or {},
        "nextRun": _iso_utc(raw.get("nextRun")),
        "lastRun": _iso_utc(raw.get("lastRun")),
        "lastStatus": str(raw.get("lastStatus") or "idle"),
        "lastError": (str(raw.get("lastError"))[:200] if raw.get("lastError") else None),
        "lastResult": raw.get("lastResult"),
        "runCount": int(raw.get("runCount") or 0),
        "failCount": int(raw.get("failCount") or 0),
        "completedAt": _iso_utc(raw.get("completedAt")),
        "createdAt": _iso_utc(raw.get("createdAt")),
        "updatedAt": _iso_utc(raw.get("updatedAt")),
    }


def _iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc).isoformat()


async def state_document(max_age: float = 2.5) -> dict | None:
    """The light events document for websocket pushes (REST serves full rows)."""
    get_event_scheduler().ensure_started()
    now = time.monotonic()
    if now - _doc_cache[0] < max_age:
        return _doc_cache[1]
    try:
        from database.connection import get_db

        db = get_db()
        events: list[dict] = []
        cursor = db[EVENTS_COLL].find({}).sort("nextRun", 1)
        async for raw in cursor:
            events.append(_event_public(raw))
        kinds = [
            {"kind": kind, "label": meta["label"], "description": meta["description"],
             "requiresConfirm": meta["requiresConfirm"]}
            for kind, meta in KINDS.items()
        ]
        doc = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "serverNow": datetime.now(timezone.utc).isoformat(),
            "timezone": "Asia/Kolkata",
            "count": len(events),
            "events": events,
            "kinds": kinds,
        }
        set_doc_cache(doc)
        return doc
    except Exception as exc:  # noqa: BLE001
        logger.debug("[EVENT_SCHEDULER] state document unavailable: %r", exc)
        return None


def set_doc_cache(doc: dict | None) -> None:
    global _doc_cache
    _doc_cache = (time.monotonic(), doc)


def _as_utc(value: Any) -> datetime | None:
    """Parse a stored datetime (aware datetime, naive → UTC, or ISO string)."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


_event_scheduler: EventScheduler | None = None
_singleton_lock = threading.Lock()


def get_event_scheduler() -> EventScheduler:
    global _event_scheduler
    with _singleton_lock:
        if _event_scheduler is None:
            _event_scheduler = EventScheduler()
        return _event_scheduler


def start_event_scheduler() -> None:
    """Bootstrap the background scheduler (app startup)."""
    get_event_scheduler().ensure_started()


def stop_event_scheduler() -> None:
    """Stop the background scheduler (app shutdown)."""
    try:
        get_event_scheduler().stop()
    except Exception:  # noqa: BLE001
        pass
