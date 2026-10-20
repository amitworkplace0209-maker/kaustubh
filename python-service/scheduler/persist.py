"""Persistent scheduler run ledger + missed-job/misfire recovery.

The session-lifecycle scheduler (login / ws_start / ws_stop / logout) must be
TIME-AUTHORITATIVE and must never lose a job because the backend was offline at
the exact scheduled instant. This module stores one immutable record per
scheduled execution and reconciles missed jobs when the process comes back.

Execution identity (idempotency):

    execution_id = f"{job_id}:{business_date}:{scheduled_at_iso}"

A unique index on ``execution_id`` guarantees no duplicate run records, so a
restart can never re-execute a scheduled job twice. A terminal record
(COMPLETED / FAILED / MISSED_EXPIRED / SKIPPED / ALREADY_SATISFIED) is never
re-run.

States used here (a superset of the UI vocabulary):

    PENDING  / RUNNING / COMPLETED / FAILED / MISSED / CATCHING_UP /
    MISSED_EXPIRED / SKIPPED / ALREADY_SATISFIED / MISSED_WAITING_NETWORK

Timestamps are stored in IST (Asia/Kolkata) following the project convention:
``scheduled_at`` is the true scheduled instant and is NEVER rewritten to the
actual execution time; ``started_at`` / ``completed_at`` / ``failed_at`` record
the real execution timeline separately.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from database.connection import get_db

logger = logging.getLogger("scheduler.ledger")

from core.timezones import IST
TZ_NAME = "Asia/Kolkata"

# ---------------------------------------------------------------------------
# Run status vocabulary — explicit occurrence/execution states.
#
# Every status has a clear semantic meaning (Phase 3). These are the canonical
# states; backward-compatible alias constants map the older vocabulary onto it.
# ---------------------------------------------------------------------------
ST_SCHEDULED = "SCHEDULED"                 # future occurrence, not yet due
ST_DUE = "DUE"                             # scheduled instant reached, about to run
ST_RUNNING = "RUNNING"                     # real action in progress
ST_COMPLETED = "COMPLETED"                 # real action finished successfully
ST_ALREADY_SATISFIED = "ALREADY_SATISFIED" # outcome already satisfied, no action needed
ST_CATCH_UP = "CATCH_UP"                   # missed occurrence being executed late
ST_WAITING_NETWORK = "WAITING_NETWORK"     # blocked until the network returns
ST_WAITING_BACKEND = "WAITING_BACKEND"     # blocked until a backend dependency is ready
ST_WAITING_DEPENDENCY = "WAITING_DEPENDENCY"  # generic dependency unavailable
ST_MISSED = "MISSED"                       # occurrence passed and unresolved
ST_MISSED_EXPIRED = "MISSED_EXPIRED"       # missed and no longer valid to run
ST_FAILED = "FAILED"                       # real execution failed
ST_CANCELLED = "CANCELLED"                 # explicitly cancelled

# Backward-compatible aliases (old vocabulary -> canonical). Existing persisted
# records use these; readers must normalise them before counting.
ST_PENDING = "PENDING"
ST_CATCHING_UP = "CATCHING_UP"             # alias of CATCH_UP
ST_MISSED_WAITING_NETWORK = "MISSED_WAITING_NETWORK"  # alias of WAITING_NETWORK
ST_SKIPPED = "SKIPPED"                     # alias of MISSED_EXPIRED (generic skip)

# Canonical set used for counting + terminal logic.
_CANONICAL = {
    ST_SCHEDULED, ST_DUE, ST_RUNNING, ST_COMPLETED, ST_ALREADY_SATISFIED,
    ST_CATCH_UP, ST_WAITING_NETWORK, ST_WAITING_BACKEND, ST_WAITING_DEPENDENCY,
    ST_MISSED, ST_MISSED_EXPIRED, ST_FAILED, ST_CANCELLED,
}

# Map any status (canonical or legacy alias) to its canonical form.
_STATUS_NORM = {
    ST_PENDING: ST_SCHEDULED,
    ST_CATCHING_UP: ST_CATCH_UP,
    ST_MISSED_WAITING_NETWORK: ST_WAITING_NETWORK,
    "MISSED_WAITING_NETWORK": ST_WAITING_NETWORK,
    ST_SKIPPED: ST_MISSED_EXPIRED,
    "SKIPPED": ST_MISSED_EXPIRED,
}

# Guard set: persisted statuses that are fully resolved and must never be
# touched again by the reconcile loop (idempotency). NOTE: a persisted MISSED
# record is NOT terminal here — it may still become CATCH_UP / COMPLETED on a
# later tick when dependencies / network return.
_TERMINAL = {
    ST_COMPLETED, ST_FAILED, ST_MISSED_EXPIRED, ST_SKIPPED,
    ST_ALREADY_SATISFIED, ST_CANCELLED,
}

# Canonical terminal-by-semantics set used for reporting (MISSED is a final
# unresolved terminal occurrence once expired, but it stays re-drivable until
# then — counted as its own bucket, so it is NOT folded into terminal here).
_NORMAL_TERMINAL = {
    ST_COMPLETED, ST_FAILED, ST_MISSED_EXPIRED, ST_SKIPPED,
    ST_ALREADY_SATISFIED, ST_CANCELLED,
}

# Triggers (how this execution came to run).
TRIGGER_SCHEDULED = "scheduled"
TRIGGER_MISSED = "MISSED_SCHEDULE_CATCHUP"
TRIGGER_NETWORK = "NETWORK_RECOVERY"

# Job definitions (job_id -> job_type mapping used by rules + UI).
JOB_TYPE_LOGIN = "LOGIN_CHECK"
JOB_TYPE_WS_START = "WEBSOCKET_START"
JOB_TYPE_TICK_COLLECTION = "TICK_COLLECTION_START"
JOB_TYPE_WS_STOP = "WEBSOCKET_STOP"
JOB_TYPE_LOGOUT = "LOGOUT"
JOB_TYPE_SQUARE_OFF = "SQUARE_OFF_TRIGGER"
JOB_TYPE_FEED_STOP = "FEED_STOP"
JOB_TYPE_MARKET_WATCH_START = "MARKET_WATCH_START"
JOB_TYPE_MARKET_WATCH_STOP = "MARKET_WATCH_STOP"
JOB_TYPE_MARKET_WATCH_FRIDAY_SCAN = "MARKET_WATCH_FRIDAY_SCAN"

# Login / WS-start catch-up semantics: a missed login or feed start is only
# meaningful while today's feed window is still open. The oracle for "still
# meaningful" is the WS stop instant (ws_stop, default 15:31 IST) — NOT a fixed
# 3h look-back. A backend that returns at 14:30 has missed the 08:50/08:55
# instants, but the trading lifecycle for the day is still active, so login +
# feed start remain valid CATCH_UP targets until ws_stop. After ws_stop they
# become obsolete (MISSED_EXPIRED) and the remaining day never blind-starts.
# ``WS_START_CATCHUP_WINDOW`` is retained only as a backward-compatible alias;
# the reconcile logic keys off ``ws_stop`` so an afternoon restart resumes the
# SAME active trading lifecycle instead of waiting for the next day.
WS_START_CATCHUP_WINDOW = timedelta(hours=3)


def _now() -> datetime:
    return datetime.now(IST)


def execution_id(job_id: str, business_date: str,
                 scheduled_at: datetime, broker: str | None = None) -> str:
    """Deterministic identity for a scheduled execution (idempotency key).

    Broker-scoped so the SAME scheduled instant can never collide across
    simultaneously-driven broker lifecycles. Kotak (and legacy rows that carry
    no broker) keep the historic key format unchanged; every other broker
    suffixes its terminal id.
    """
    base = f"{job_id}:{business_date}:{scheduled_at.isoformat()}"
    broker = (broker or "kotak").lower()
    if broker == "kotak":
        return base
    return f"{base}:{broker}"


def to_ist(value) -> datetime:
    """Normalise any stored timestamp into an IST-aware datetime.

    Motor (tz_aware=False) round-trips an aware IST datetime through MongoDB as
    a *naive UTC* datetime (09:00:00+05:30 -> 03:30:00). Reading that back and
    calling ``.timestamp()`` naively would interpret 03:30 in the *machine's*
    local timezone, corrupting every scheduled-time comparison. This helper
    resolves the ambiguity: a naive value is treated as UTC (the storage
    convention) and converted to IST; an aware value is converted to IST as-is.
    """
    if value is None:
        return value
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(IST)
    return value


def _ts(value) -> float:
    """Reliable epoch for a stored timestamp (aware or naive-UTC)."""
    v = to_ist(value)
    return v.timestamp() if isinstance(v, datetime) else 0.0


class SchedulerLedger:
    """Persistent record of scheduled session executions + recovery engine.

    A single instance is owned by :class:`SchedulerController`. The controller
    is the ONLY scheduler worker, so all reconciliation happens inside its one
    asyncio loop (no duplicate workers). Atomic Mongo claims add a second layer
    of protection for multi-process restarts.
    """

    def __init__(self) -> None:
        self._init_lock = asyncio.Lock()
        self._initialized = False
        # Terminal executions we already settled this process — avoids a DB
        # round-trip on every 5 s tick for a job that will not re-run today.
        self._settled: set[str] = set()
        # business_date -> {job_id: status} cache of today's job statuses,
        # cleared on any mutation so reads stay cheap on every tick.
        self._today_statuses_cache: dict[str, dict[str, str]] = {}

    # ------------------------------------------------------------------
    # Setup / indexes
    # ------------------------------------------------------------------

    async def _ensure_indexes(self) -> None:
        try:
            db = get_db()
            await db.scheduler_runs.create_index(
                "execution_id", unique=True, background=True,
            )
            await db.scheduler_runs.create_index(
                [("business_date", -1), ("job_id", 1)], background=True,
            )
            await db.scheduler_runs.create_index(
                [("status", 1), ("business_date", -1)], background=True,
            )
            await db.scheduler_runs.create_index(
                "occurrence_id", unique=True, background=True, sparse=True,
            )
        except Exception:
            logger.exception("Scheduler ledger index setup failed")

    async def _assure(self) -> None:
        if self._initialized:
            return
        async with self._init_lock:
            if self._initialized:
                return
            await self._ensure_indexes()
            self._initialized = True

    # ------------------------------------------------------------------
    # Read / claim helpers
    # ------------------------------------------------------------------

    async def get_run(self, job_id: str, business_date: str,
                      scheduled_at: datetime, broker: str | None = None):
        db = get_db()
        return await db.scheduler_runs.find_one(
            {"execution_id": execution_id(job_id, business_date, scheduled_at,
                                          broker)}
        )

    async def _claim(self, run_id, expected_statuses, update) -> bool:
        """Atomically advance a run unless another worker already owns it."""
        db = get_db()
        res = await db.scheduler_runs.update_one(
            {"_id": run_id, "status": {"$in": list(expected_statuses)}},
            {"$set": update, "$inc": {"attempt_count": 1}},
        )
        return (res.modified_count or 0) > 0

    async def upsert_pending(
        self,
        job_id: str,
        job_type: str,
        business_date: str,
        scheduled_at: datetime,
        trigger: str = TRIGGER_SCHEDULED,
        schedule_id: str | None = None,
        broker: str | None = None,
    ) -> dict:
        """Insert a PENDING run (or return the existing one) idempotently."""
        broker = (broker or "kotak").lower()
        key = execution_id(job_id, business_date, scheduled_at, broker)
        occurrence_key = f"occ:{job_id}:{business_date}:{scheduled_at.isoformat()}:{broker}"
        now = _now()
        db = get_db()
        try:
            await db.scheduler_runs.insert_one({
                "execution_id": key,
                "idempotency_key": key,
                "occurrence_id": occurrence_key,
                "schedule_id": schedule_id,
                "job_id": job_id,
                "job_type": job_type,
                "business_date": business_date,
                "broker": broker,
                "scheduled_at": scheduled_at,
                "timezone": TZ_NAME,
                "status": ST_PENDING,
                "trigger": trigger,
                "started_at": None,
                "completed_at": None,
                "failed_at": None,
                "attempt_count": 0,
                "last_error": None,
                "reason": None,
                "reason_code": None,
                "created_at": now,
                "updated_at": now,
                "owner_pid": os.getpid(),
            })
        except Exception:
            # Unique key collision -> an existing record is the single source.
            pass
        self._invalidate_status_cache(business_date)
        return await self.get_run(job_id, business_date, scheduled_at, broker)

    async def update(self, run_id, **fields) -> None:
        fields["updated_at"] = _now()
        try:
            db = get_db()
            await db.scheduler_runs.update_one({"_id": run_id}, {"$set": fields})
        except Exception:
            logger.exception("Scheduler ledger update failed (run=%s)", run_id)

    def _invalidate_status_cache(self, business_date) -> None:
        if business_date:
            prefix = f"{str(business_date)}:"
            keys = [k for k in self._today_statuses_cache if k.startswith(prefix)]
            for k in keys:
                self._today_statuses_cache.pop(k, None)

    async def list_recent(self, limit: int = 50, broker: str | None = None) -> list[dict]:
        try:
            db = get_db()
            q: dict = {}
            if broker:
                b = (broker or "kotak").lower()
                if b == "kotak":
                    q["broker"] = {"$in": [None, "kotak"]}
                else:
                    q["broker"] = b
            cursor = db.scheduler_runs.find(
                q, {"_id": 0}
            ).sort([("scheduled_at", -1)]).limit(limit)
            return [doc async for doc in cursor]
        except Exception:
            logger.exception("Scheduler ledger list failed")
            return []

    async def today_job_statuses(self, business_date: str,
                                 broker: str | None = None) -> dict[str, str]:
        """Map of job_id -> terminal/current status for a business date.

        Kotak rows are matched inclusively (legacy rows carry no broker field).
        Used by the scheduler state machine to abort a session day once the
        window has been judged obsolete (no blind login/flood after expiry).
        """
        broker = (broker or "kotak").lower()
        cache_key = f"{business_date}:{broker}"
        cached = self._today_statuses_cache.get(cache_key)
        if cached is not None:
            return cached
        result: dict[str, str] = {}
        try:
            db = get_db()
            mq: dict = {"business_date": business_date}
            if broker == "kotak":
                mq["broker"] = {"$in": [None, "kotak"]}
            else:
                mq["broker"] = broker
            cursor = db.scheduler_runs.find(
                mq, {"_id": 0, "job_id": 1, "status": 1}
            )
            async for doc in cursor:
                result[doc.get("job_id")] = doc.get("status")
            self._today_statuses_cache[cache_key] = result
        except Exception:
            logger.exception("Scheduler ledger today_job_statuses failed")
        return result

    async def today_broker_statuses(self, business_date: str) -> dict[str, dict[str, str]]:
        """Per-broker job statuses: {broker: {job_id: status}} for one date.

        Rows without a broker field are attributed to kotak (legacy rows).
        """
        result: dict[str, dict[str, str]] = {}
        try:
            db = get_db()
            cursor = db.scheduler_runs.find(
                {"business_date": business_date},
                {"_id": 0, "job_id": 1, "status": 1, "broker": 1},
            )
            async for doc in cursor:
                b = (doc.get("broker") or "kotak").lower()
                result.setdefault(b, {})[doc.get("job_id")] = doc.get("status")
        except Exception:
            logger.exception("Scheduler ledger today_broker_statuses failed")
        return result

    # ------------------------------------------------------------------
    # Summary (for scheduler UI — real values only)
    # ------------------------------------------------------------------

    async def summary(self, business_date: str | None = None) -> dict:
        """Real persisted counters for the scheduler UI block.

        Counts are computed from the persisted ledger by normalising every
        (possibly legacy) status onto the canonical vocabulary so the reported
        numbers are semantically correct (Phase 3 / Phase 22 / Phase 53).
        ``last_event`` / ``last_execution`` reflect the most recent *actual*
        scheduler execution (never a page-load / API-request / boot timestamp).
        """
        try:
            db = get_db()
            q: dict = {}
            if business_date:
                q["business_date"] = business_date
            raw: dict[str, int] = {}
            async for doc in db.scheduler_runs.aggregate([
                {"$match": q},
                {"$group": {"_id": "$status", "n": {"$sum": 1}}},
            ]):
                st = doc["_id"] or "UNKNOWN"
                raw[_STATUS_NORM.get(st, st)] = raw.get(_STATUS_NORM.get(st, st), 0) + doc["n"]

            def _n(status: str) -> int:
                return int(raw.get(status, 0))

            completed = _n(ST_COMPLETED)
            running = _n(ST_RUNNING) + _n(ST_CATCH_UP)
            due = _n(ST_DUE)
            catch_up = _n(ST_CATCH_UP)
            already_satisfied = _n(ST_ALREADY_SATISFIED)
            waiting = (_n(ST_WAITING_NETWORK) + _n(ST_WAITING_BACKEND)
                       + _n(ST_WAITING_DEPENDENCY))
            failed = _n(ST_FAILED)
            missed = _n(ST_MISSED)
            missed_expired = (_n(ST_MISSED_EXPIRED) + _n(ST_SKIPPED))
            total = sum(raw.values())

            # Most recent actual execution/decision (Phase 23). A pure
            # PENDING/SCHEDULED registration is NOT an event yet — it has no
            # started/completed/failed timestamp and is not a reviewed
            # terminal decision, so it must never masquerade as "last event".
            pending_statuses = (ST_PENDING, ST_SCHEDULED)
            last_event = None
            last_doc = await db.scheduler_runs.find_one(
                {"$and": [
                    q,
                    {"status": {"$nin": list(pending_statuses)}},
                ]},
                {"_id": 0},
                sort=[("updated_at", -1)],
            )
            if last_doc is None:
                # No reviewed decision at all today -> no event, not a fake one.
                last_event = None
            else:
                actual = last_doc.get("completed_at") or last_doc.get("started_at") \
                    or last_doc.get("failed_at") or last_doc.get("updated_at")
                if actual:
                    last_event = {
                        "job_id": last_doc.get("job_id"),
                        "job_type": last_doc.get("job_type"),
                        "status": _STATUS_NORM.get(
                            last_doc.get("status"), last_doc.get("status")),
                        "scheduled_at": to_ist(
                            last_doc.get("scheduled_at")).isoformat()
                        if last_doc.get("scheduled_at") else None,
                        "actual_at": to_ist(actual).isoformat(),
                        "trigger": last_doc.get("trigger"),
                        "reason_code": last_doc.get("reason_code"),
                        "reason": last_doc.get("reason"),
                        "execution_id": last_doc.get("execution_id"),
                        "business_date": last_doc.get("business_date"),
                    }

            last_completed = await db.scheduler_runs.find_one(
                {"status": ST_COMPLETED}, {"_id": 0},
                sort=[("completed_at", -1)],
            )
            last_failed = await db.scheduler_runs.find_one(
                {"status": {"$in": [ST_FAILED, ST_MISSED_EXPIRED]}},
                {"_id": 0},
                sort=[("updated_at", -1)],
            )
            last_waiting_net = await db.scheduler_runs.find_one(
                {"status": {"$in": [ST_WAITING_NETWORK, ST_MISSED_WAITING_NETWORK]}},
                {"_id": 0},
                sort=[("updated_at", -1)],
            )
            return {
                # Backward-compatible legacy keys.
                "totalRuns": total,
                "pending": _n(ST_SCHEDULED) + _n(ST_PENDING),
                "running": running,
                "due": due,
                "completed": completed,
                "failed": failed,
                "missed": missed,
                "recovered": completed,
                "skipped": missed_expired + already_satisfied,
                "catchUp": catch_up,
                "alreadySatisfied": already_satisfied,
                "waiting": waiting,
                "waitingNetwork": _n(ST_WAITING_NETWORK),
                "waitingBackend": sum(
                    int(raw.get(k, 0))
                    for k in (ST_WAITING_BACKEND, ST_WAITING_DEPENDENCY,
                              ST_DUE, ST_SCHEDULED, ST_MISSED)
                ),
                "lastSuccessfulRun": self._iso(last_completed),
                "lastFailedRun": self._iso(last_failed),
                "lastWaitingNetworkRun": self._iso(last_waiting_net),
                "timezone": TZ_NAME,
                # Phase 53 canonical summary block.
                "today": {
                    "total": total,
                    "completed": completed,
                    "running": running,
                    "due": due,
                    "catch_up": catch_up,
                    "already_satisfied": already_satisfied,
                    "waiting": waiting,
                    "failed": failed,
                    "missed": missed,
                    "missed_expired": missed_expired,
                },
                "last_event": last_event,
            }
        except Exception:
            logger.exception("Scheduler ledger summary failed")
            return {
                "totalRuns": 0, "pending": 0, "running": 0, "due": 0,
                "completed": 0, "failed": 0, "missed": 0, "recovered": 0,
                "skipped": 0, "catchUp": 0, "alreadySatisfied": 0, "waiting": 0,
                "waitingNetwork": 0, "waitingBackend": 0,
                "lastSuccessfulRun": None, "lastFailedRun": None,
                "lastWaitingNetworkRun": None, "timezone": TZ_NAME,
                "today": {
                    "total": 0, "completed": 0, "running": 0, "due": 0,
                    "catch_up": 0, "already_satisfied": 0, "waiting": 0,
                    "failed": 0, "missed": 0, "missed_expired": 0,
                },
                "last_event": None,
            }

    async def executions(self, business_date: str | None = None,
                         limit: int = 50) -> list[dict]:
        """Today's scheduler execution history rows (real persisted data)."""
        try:
            db = get_db()
            q: dict = {}
            if business_date:
                q["business_date"] = business_date
            cursor = db.scheduler_runs.find(
                q, {"_id": 0}
            ).sort([("scheduled_at", 1)]).limit(limit)
            rows = []
            async for doc in cursor:
                scheduled = doc.get("scheduled_at")
                actual = doc.get("completed_at") or doc.get("started_at") \
                    or doc.get("updated_at")
                rows.append({
                    "execution_id": doc.get("execution_id"),
                    "occurrence_id": doc.get("occurrence_id"),
                    "schedule_id": doc.get("schedule_id"),
                    "job_id": doc.get("job_id"),
                    "job_type": doc.get("job_type"),
                    "business_date": doc.get("business_date"),
                    "scheduled_at": to_ist(scheduled).isoformat()
                    if scheduled else None,
                    "actual_at": to_ist(actual).isoformat() if actual else None,
                    "status": _STATUS_NORM.get(
                        doc.get("status"), doc.get("status")),
                    "raw_status": doc.get("status"),
                    "trigger": doc.get("trigger"),
                    "attempt": doc.get("attempt_count"),
                    "duration_ms": None,
                    "reason": doc.get("reason"),
                    "reason_code": doc.get("reason_code"),
                    "error": doc.get("last_error"),
                })
            return rows
        except Exception:
            logger.exception("Scheduler ledger executions failed")
            return []

    @staticmethod
    def normalize_run(doc) -> dict:
        """Project one persisted run into the UI-facing runs-map payload.

        `status` is the real canonical backend status (legacy aliases
        normalised via _STATUS_NORM); the UI derives tone + vocabulary from it.
        Timestamps are IST ISO strings. `duration_ms` is computed from the real
        started/completed timestamps (never fabricated). `next_retry` is null by
        design: this executor does not schedule retries — the reconcile loop
        re-evaluates each window on its own, so a WAITING run has no fixed
        retry instant to report.
        """
        raw_status = doc.get("status")
        # SKIPPED is a distinct user-facing outcome (always carries a reason),
        # so it is preserved on the surface instead of folding into
        # MISSED_EXPIRED; counting still folds both (see summary()).
        status = (raw_status if raw_status == ST_SKIPPED
                  else _STATUS_NORM.get(raw_status, raw_status))
        scheduled = to_ist(doc.get("scheduled_at"))
        actual_start = to_ist(doc.get("started_at"))
        actual_completion = to_ist(
            doc.get("completed_at") or doc.get("failed_at") or None)
        duration_ms = None
        if isinstance(actual_start, datetime) and isinstance(actual_completion, datetime):
            delta_s = (actual_completion - actual_start).total_seconds()
            if delta_s >= 0:
                duration_ms = int(delta_s * 1000)
        trigger = doc.get("trigger")
        catch_up = bool(
            trigger == TRIGGER_MISSED
            or status in (ST_CATCH_UP, ST_CATCHING_UP, ST_MISSED))
        return {
            "run_id": doc.get("execution_id"),
            "execution_id": doc.get("execution_id"),
            "occurrence_id": doc.get("occurrence_id"),
            "schedule_id": doc.get("schedule_id"),
            "job_id": doc.get("job_id"),
            "job_type": doc.get("job_type"),
            "business_date": doc.get("business_date"),
            "status": status,
            "raw_status": doc.get("status"),
            "catch_up": catch_up,
            "trigger": trigger,
            "scheduled_at": scheduled.isoformat() if isinstance(scheduled, datetime) else None,
            "actual_start": actual_start.isoformat() if isinstance(actual_start, datetime) else None,
            "actual_completion": actual_completion.isoformat() if isinstance(actual_completion, datetime) else None,
            "duration_ms": duration_ms,
            "attempt": doc.get("attempt_count"),
            "reason": doc.get("reason"),
            "reason_code": doc.get("reason_code"),
            "error": doc.get("last_error"),
            "next_retry": None,
            "created_at": to_ist(doc.get("created_at")).isoformat()
            if isinstance(to_ist(doc.get("created_at")), datetime) else None,
            "updated_at": to_ist(doc.get("updated_at")).isoformat()
            if isinstance(to_ist(doc.get("updated_at")), datetime) else None,
        }

    async def list_runs(
        self,
        *,
        business_date: str = "",
        job_id: str = "",
        status: str = "",
        trigger: str = "",
        schedule_id: str = "",
        search: str = "",
        failed_only: bool = False,
        catch_up_only: bool = False,
        sort: str = "scheduled_at",
        order: str = "desc",
        page: int = 1,
        page_size: int = 20,
    ) -> dict:
        """Paginated, filtered scheduler-run ledger (real persisted data).

        Equality filters (business_date / job_id / schedule_id / trigger) are
        pushed into the Mongo query so indexes are used; the semantic status /
        search / catch-up buckets are resolved server-side over the shortlist
        (a day yields only a handful of runs, so this is honest and cheap).
        Returns ``{count, page, page_size, pages, total, runs}`` with pages
        computed from the real ``total``.
        """

        async def _all(match: dict) -> list[dict]:
            try:
                db = get_db()
                cursor = db.scheduler_runs.find(match, {"_id": 0})
                return [doc async for doc in cursor]
            except Exception:
                logger.exception("Scheduler ledger list_runs fetch failed")
                return []

        q: dict = {}
        if business_date:
            q["business_date"] = business_date
        if job_id:
            q["job_id"] = job_id
        if schedule_id:
            q["schedule_id"] = schedule_id
        if trigger:
            q["trigger"] = trigger
        docs = await _all(q)

        # Semantic status buckets (spec vocabulary) -> canonical backend states.
        status_groups = {
            "PENDING": (ST_SCHEDULED, ST_PENDING),
            "DUE": (ST_DUE,),
            "RUNNING": (ST_RUNNING, ST_CATCH_UP, ST_CATCHING_UP),
            "COMPLETED": (ST_COMPLETED,),
            "FAILED": (ST_FAILED,),
            "RETRYING": (),  # no known backend run holds this; accepts + matches nothing
            "WAITING": (ST_WAITING_NETWORK, ST_WAITING_BACKEND,
                        ST_WAITING_DEPENDENCY, ST_MISSED_WAITING_NETWORK),
            "ALREADY_SATISFIED": (ST_ALREADY_SATISFIED,),
            "MISSED": (ST_MISSED,),
            "MISSED_SCHEDULE_CATCHUP": (ST_CATCH_UP, ST_CATCHING_UP, ST_MISSED),
            "SKIPPED": (ST_MISSED_EXPIRED, ST_SKIPPED),
        }
        wanted_statuses: set[str] = set()
        catchup_token = False
        for token in (t.strip().upper() for t in status.split(",") if t.strip()):
            if token == "MISSED_SCHEDULE_CATCHUP":
                catchup_token = True
            if token not in status_groups:
                continue
            wanted_statuses.update(status_groups[token])
        status_filter: set[str] | None = wanted_statuses or None

        hay = search.strip().lower()
        rows: list[dict] = []
        for doc in docs:
            norm = _STATUS_NORM.get(doc.get("status"), doc.get("status"))
            canon = (norm or "").upper()
            if status_filter is not None and canon not in status_filter:
                # MISSED_SCHEDULE_CATCHUP also covers caught-up triggers whose
                # canonical status resolved elsewhere (e.g. COMPLETED catch-up).
                if not (catchup_token and doc.get("trigger") == TRIGGER_MISSED):
                    continue
            if failed_only and canon != ST_FAILED:
                continue
            catch_up = (
                doc.get("trigger") == TRIGGER_MISSED
                or canon in (ST_CATCH_UP, ST_CATCHING_UP, ST_MISSED))
            if catch_up_only and not catch_up:
                continue
            if hay:
                blob = " ".join([
                    str(doc.get("execution_id") or ""),
                    str(doc.get("occurrence_id") or ""),
                    str(doc.get("schedule_id") or ""),
                    str(doc.get("job_id") or ""),
                    str(doc.get("trigger") or ""),
                    str(doc.get("reason") or ""),
                    str(doc.get("reason_code") or ""),
                    str(doc.get("last_error") or ""),
                ]).lower()
                if hay not in blob:
                    continue
            rows.append(doc)

        # Sort server-side on the real field values (None always sorts last).
        sort_key = sort or "scheduled_at"
        allowed = ("scheduled_at", "updated_at", "started_at", "completed_at",
                   "failed_at", "job_id", "status", "trigger", "business_date")
        if sort_key not in allowed:
            sort_key = "scheduled_at"
        asc = str(order).lower() != "desc"

        def _sv(d):
            v = d.get(sort_key)
            if isinstance(v, datetime):
                return v
            v = to_ist(v)
            return (v if isinstance(v, datetime)
                    else (str(v or "").lower() if v is not None else ""))

        if asc:
            rows.sort(key=lambda d: (0 if _sv(d) is None else 1, _sv(d) or ""))
        else:
            rows.sort(key=lambda d: (0 if _sv(d) is None else 1, _sv(d) or ""), reverse=True)

        total = len(rows)
        page = max(int(page), 1)
        page_size = min(max(int(page_size), 1), 100)
        pages = max(int((total + page_size - 1) // page_size), 1)
        start = (page - 1) * page_size
        chunk = rows[start:start + page_size]
        return {
            "count": len(chunk),
            "page": page,
            "page_size": page_size,
            "pages": pages,
            "total": total,
            "runs": [self.normalize_run(d) for d in chunk],
        }

    async def get_run_by_execution_id(self, run_id: str) -> dict | None:
        """One run by its deterministic ``execution_id`` (or None)."""
        try:
            db = get_db()
            doc = await db.scheduler_runs.find_one(
                {"execution_id": run_id}, {"_id": 0})
            return self.normalize_run(doc) if doc else None
        except Exception:
            logger.exception("Scheduler ledger run lookup failed (run=%s)", run_id)
            return None

    @staticmethod
    def _iso(doc) -> str | None:
        if not doc:
            return None
        ts = doc.get("completed_at") or doc.get("updated_at") or doc.get("scheduled_at")
        if not ts:
            return None
        ts = to_ist(ts)
        return ts.isoformat() if isinstance(ts, datetime) else str(ts)

    # ------------------------------------------------------------------
    # Missed-job reconciliation
    # ------------------------------------------------------------------

    async def reconcile(
        self,
        *,
        now: datetime,
        schedule: dict,
        business_date: str,
        is_trading_day: bool,
        session_active: bool,
        ws_connected: bool,
        network_ok: bool,
        market_state: str,
        market_session: str,
        ws_enabled: bool,
        past_logout: bool,
        record_event,
        phase: str | None = None,
        square_off_completed: bool = False,
        feed_stop_completed: bool = False,
        broker: str | None = None,
    ) -> list[dict]:
        """Evaluate today's scheduled executions and reconcile the ledger.

        Called once per scheduler reconcile tick (inside the single scheduler
        worker). This ledger is DEDUCTIVE: it never performs the side effects
        itself. It records a scheduled execution, decides whether a missed job
        may still be caught up, and then VERIFIES the outcome from the real
        state (session / WebSocket) on later ticks. The scheduler state machine
        remains the single actor, so there is no double execution:
        ``scheduled_at`` is never rewritten, and a terminal record is never
        re-run (idempotent across restarts).

        Resolutions on each call:

        * ``session_active`` / ``ws_connected`` already true  -> COMPLETED (the
          scheduled outcome was reached) or ALREADY_SATISFIED (it was subsumed
          before the ledger could act).
        * job due + still valid window + network ok             -> CATCH_UP
          (state machine performs the real action; verified next ticks).
        * job due + window/feed no longer valid                 -> MISSED_EXPIRED
        * job due + network offline                             -> MISSED_WAITING_NETWORK
        * not a trading day / ws disabled                       -> SKIPPED
        """
        await self._assure()
        decisions: list[dict] = []
        broker = (broker or "kotak").lower()
        if not schedule:
            return decisions

        def _day_at(h: int, m: int) -> datetime:
            d = datetime.fromisoformat(business_date).date()
            return datetime.combine(d, datetime.min.time(),
                                    tzinfo=IST).replace(
                                        hour=h, minute=m, second=0, microsecond=0)

        login_at = _day_at(*schedule["login"])
        ws_start_at = _day_at(*schedule["ws_start"])
        tick_collection_at = _day_at(*schedule.get("tick_collection_start", (0, 0)))
        ws_stop_at = _day_at(*schedule["ws_stop"])
        logout_at = _day_at(*schedule["logout"])

        runtime_start_at = _day_at(*schedule.get("runtime_start", (8, 50)))
        runtime_stop_at = _day_at(*schedule.get("runtime_stop", (15, 30)))
        market_watch_friday_scan_at = _day_at(*schedule.get("market_watch_friday_scan", (15, 25)))
        
        jobs = [
            {"schedule_id": "session_login", "job_id": "login",
             "job_type": JOB_TYPE_LOGIN, "scheduled_at": login_at},
            {"schedule_id": "session_ws_start", "job_id": "ws_start",
             "job_type": JOB_TYPE_WS_START, "scheduled_at": ws_start_at},
            {"schedule_id": "session_tick_collection", "job_id": "tick_collection",
             "job_type": JOB_TYPE_TICK_COLLECTION, "scheduled_at": tick_collection_at},
            {"schedule_id": "session_ws_stop", "job_id": "ws_stop",
             "job_type": JOB_TYPE_WS_STOP, "scheduled_at": ws_stop_at},
            {"schedule_id": "session_logout", "job_id": "logout",
             "job_type": JOB_TYPE_LOGOUT, "scheduled_at": logout_at},
            {"schedule_id": "session_market_watch_start", "job_id": "market_watch_start",
             "job_type": JOB_TYPE_MARKET_WATCH_START, "scheduled_at": runtime_start_at},
            {"schedule_id": "session_market_watch_stop", "job_id": "market_watch_stop",
             "job_type": JOB_TYPE_MARKET_WATCH_STOP, "scheduled_at": runtime_stop_at},
            {"schedule_id": "session_market_watch_friday_scan", "job_id": "market_watch_friday_scan",
             "job_type": JOB_TYPE_MARKET_WATCH_FRIDAY_SCAN, "scheduled_at": market_watch_friday_scan_at},
        ]

        for job in jobs:
            decision = await self._reconcile_job(
                job=job,
                now=now,
                business_date=business_date,
                broker=broker,
                is_trading_day=is_trading_day,
                session_active=session_active,
                ws_connected=ws_connected,
                network_ok=network_ok,
                market_state=market_state,
                market_session=market_session,
                ws_enabled=ws_enabled,
                past_logout=past_logout,
                ws_start_at=ws_start_at,
                tick_collection_at=tick_collection_at,
                ws_stop_at=ws_stop_at,
                logout_at=logout_at,
                runtime_start_at=runtime_start_at,
                runtime_stop_at=runtime_stop_at,
                record_event=record_event,
            )
            if decision is not None:
                decisions.append(decision)

        # Phase jobs (Engine #01) — square-off trigger + broker feed stop. These
        # are separate timing points (15:16 / 15:30) that must never be merged
        # with the 15:31 WebSocket close (spec §3 NOTE). Both are optional:
        # older callers / tests pass a schedule without these keys.
        square_off_at = _day_at(*schedule["square_off"]) if schedule.get("square_off") else None
        feed_stop_at = _day_at(*schedule["feed_stop"]) if schedule.get("feed_stop") else None

        if square_off_at is not None:
            decision = await self._reconcile_square_off(
                now=now,
                business_date=business_date,
                broker=broker,
                is_trading_day=is_trading_day,
                square_off_at=square_off_at,
                feed_stop_at=feed_stop_at or ws_stop_at,
                network_ok=network_ok,
                square_off_completed=square_off_completed,
                record_event=record_event,
            )
            if decision is not None:
                decisions.append(decision)

        if feed_stop_at is not None:
            decision = await self._reconcile_feed_stop(
                now=now,
                business_date=business_date,
                broker=broker,
                is_trading_day=is_trading_day,
                feed_stop_at=feed_stop_at,
                ws_stop_at=ws_stop_at,
                ws_connected=ws_connected,
                network_ok=network_ok,
                feed_stop_completed=feed_stop_completed,
                record_event=record_event,
            )
            if decision is not None:
                decisions.append(decision)
        return decisions

    # ------------------------------------------------------------------
    # Phase jobs: square-off trigger + feed stop (Engine #01)
    # ------------------------------------------------------------------

    async def _reconcile_square_off(
        self, *, now, business_date, broker, is_trading_day, square_off_at,
        feed_stop_at, network_ok, square_off_completed, record_event,
    ):
        """Persist the 15:16 square-off trigger for missed-event recovery.

        DEDUCTIVE like the other jobs: this never places orders. It records the
        occurrence, marks CATCH_UP while the state machine runs the trigger, and
        settles COMPLETED once ``square_off_completed`` is observed. A restart at
        15:20 therefore resumes an un-triggered square-off exactly once.
        """
        job_id = "square_off"
        key = execution_id(job_id, business_date, square_off_at, broker)
        if key in self._settled:
            return None
        run = await self.upsert_pending(
            job_id, JOB_TYPE_SQUARE_OFF, business_date, square_off_at,
            schedule_id="session_square_off", broker=broker,
        )
        if run is None:
            return None
        status = run.get("status")
        if status in _TERMINAL:
            self._settled.add(key)
            return None

        now_ts = now.timestamp()
        sched_ts = square_off_at.timestamp()
        missed = now_ts > sched_ts + 5
        trigger = TRIGGER_MISSED if missed else TRIGGER_SCHEDULED
        was_catching_up = status == ST_CATCHING_UP

        if not is_trading_day:
            return await self._settle(run, ST_SKIPPED, trigger,
                                      reason="Not a trading day",
                                      reason_code="NOT_TRADING_DAY",
                                      record_event=record_event)
        if square_off_completed:
            return await self._settle(run, ST_COMPLETED, trigger,
                                      reason="Square-off completed",
                                      reason_code="SQUARE_OFF_COMPLETED",
                                      record_event=record_event)
        if now_ts < sched_ts - 1:
            return None
        # The trigger is only meaningful while the closing window is still open
        # (15:16 through the feed stop). After that it is obsolete — a late
        # restart must not place closing orders past the configured window.
        if now_ts > feed_stop_at.timestamp():
            return await self._settle(run, ST_MISSED_EXPIRED, trigger,
                                      reason="Square-off window closed before trigger",
                                      reason_code="SQUARE_OFF_WINDOW_EXPIRED",
                                      record_event=record_event)
        if not network_ok:
            return await self._settle(run, ST_WAITING_NETWORK, trigger,
                                      reason="Network unavailable for square-off",
                                      reason_code="NETWORK_OFFLINE",
                                      record_event=record_event)
        if was_catching_up:
            return None  # the state machine is running the trigger now
        if missed:
            self._log_job(job_id, square_off_at, now, ST_MISSED, "CATCH_UP")
        return await self._begin_catchup(run, job_id, trigger, square_off_at,
                                         record_event)

    async def _reconcile_feed_stop(
        self, *, now, business_date, broker, is_trading_day, feed_stop_at,
        ws_stop_at, ws_connected, network_ok, feed_stop_completed, record_event,
    ):
        """Persist the 15:30 broker feed-stop phase (separate from 15:31)."""
        job_id = "feed_stop"
        key = execution_id(job_id, business_date, feed_stop_at, broker)
        if key in self._settled:
            return None
        run = await self.upsert_pending(
            job_id, JOB_TYPE_FEED_STOP, business_date, feed_stop_at,
            schedule_id="session_feed_stop", broker=broker,
        )
        if run is None:
            return None
        status = run.get("status")
        if status in _TERMINAL:
            self._settled.add(key)
            return None

        now_ts = now.timestamp()
        sched_ts = feed_stop_at.timestamp()
        missed = now_ts > sched_ts + 5
        trigger = TRIGGER_MISSED if missed else TRIGGER_SCHEDULED
        was_catching_up = status == ST_CATCHING_UP

        if not is_trading_day:
            return await self._settle(run, ST_SKIPPED, trigger,
                                      reason="Not a trading day",
                                      reason_code="NOT_TRADING_DAY",
                                      record_event=record_event)
        if feed_stop_completed:
            return await self._settle(run, ST_COMPLETED, trigger,
                                      reason="Feed-stop policy executed",
                                      reason_code="FEED_STOPPED",
                                      record_event=record_event)
        if now_ts < sched_ts - 1:
            return None
        if not ws_connected:
            # The feed is already gone — the stop was subsumed.
            return await self._settle(run, ST_ALREADY_SATISFIED, trigger,
                                      reason="Feed already stopped",
                                      reason_code="FEED_ALREADY_STOPPED",
                                      record_event=record_event)
        if now_ts > ws_stop_at.timestamp():
            return await self._settle(run, ST_MISSED_EXPIRED, trigger,
                                      reason="Feed-stop window closed",
                                      reason_code="FEED_STOP_WINDOW_EXPIRED",
                                      record_event=record_event)
        if not network_ok:
            return await self._settle(run, ST_WAITING_NETWORK, trigger,
                                      reason="Network unavailable for feed stop",
                                      reason_code="NETWORK_OFFLINE",
                                      record_event=record_event)
        if was_catching_up:
            return None
        if missed:
            self._log_job(job_id, feed_stop_at, now, ST_MISSED, "CATCH_UP")
        return await self._begin_catchup(run, job_id, trigger, feed_stop_at,
                                         record_event)

    async def _reconcile_job(self, job, *, now, business_date, broker,
                             is_trading_day, session_active, ws_connected,
                             network_ok, market_state, market_session,
                             ws_enabled, past_logout,
                             ws_start_at, tick_collection_at, ws_stop_at,
                             logout_at, runtime_start_at, runtime_stop_at,
                             record_event):
        job_id = job["job_id"]
        scheduled_at = job["scheduled_at"]
        key = execution_id(job_id, business_date, scheduled_at, broker)
        if key in self._settled:
            return None  # resolved earlier in this process — never re-run
        run = await self.upsert_pending(
            job_id, job["job_type"], business_date, scheduled_at,
            schedule_id=job.get("schedule_id"), broker=broker,
        )
        if run is None:
            return None
        status = run.get("status")
        now_ts = now.timestamp()
        # Allow re-evaluation of MISSED_EXPIRED for login if still before logout
        # (catch-up login window extends to logout time, not ws_stop)
        if job_id == "login" and status == ST_MISSED_EXPIRED:
            if now_ts < logout_at.timestamp():
                # Still within catch-up window — treat as catch-up candidate
                pass
            else:
                self._settled.add(key)
                return None
        elif status in _TERMINAL:
            self._settled.add(key)
            return None  # idempotent: already resolved, never re-run

        now_ts = now.timestamp()
        sched_ts = scheduled_at.timestamp()

        # The feed-window deadline for the day. A scheduled ws_start can
        # only be "caught up" while that window is still open; after it, the
        # session day is judged obsolete (no blind login/flood). The deadline is
        # the ws_stop instant (15:31). For LOGIN, the catch-up window extends
        # to LOGOUT (16:00) to allow afternoon restarts to establish a session.
        feed_deadline = ws_stop_at.timestamp()

        # A job is MISSED when its scheduled instant has passed and it is not
        # yet resolved. The catch-up decision happens below.
        missed = now_ts > sched_ts + 5  # 5 s tolerance for the same-instant tick
        trigger = TRIGGER_MISSED if missed else TRIGGER_SCHEDULED
        was_catching_up = status == ST_CATCHING_UP

        # -------------------- LOGIN -------------------------------------
        if job_id == "login":
            if not is_trading_day:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not a trading day",
                                          reason_code="NOT_TRADING_DAY",
                                          record_event=record_event)
            if session_active:
                reached = was_catching_up or not missed
                return await self._settle(
                    run, ST_COMPLETED if reached else ST_ALREADY_SATISFIED,
                    trigger,
                    reason="Session established" if reached
                           else "Session already active",
                    reason_code="SESSION_ESTABLISHED" if reached
                               else "SESSION_ALREADY_ACTIVE",
                    record_event=record_event)
            # Login catch-up is valid until LOGOUT (16:00), not ws_stop (15:31).
            # This allows an afternoon restart to establish a session for the
            # remainder of the trading day.
            if now_ts >= logout_at.timestamp():
                return await self._settle(run, ST_MISSED_EXPIRED, trigger,
                                          reason="Login no longer meaningful after logout time",
                                          reason_code="LOGIN_WINDOW_EXPIRED",
                                          record_event=record_event)
            if not network_ok:
                return await self._settle(run, ST_WAITING_NETWORK, trigger,
                                          reason="Network unavailable at scheduled time",
                                          reason_code="NETWORK_OFFLINE",
                                          record_event=record_event)
            if was_catching_up:
                return None  # state machine is still establishing the session
            if missed:
                self._log_job(job_id, scheduled_at, now, ST_MISSED, "CATCH_UP")
            return await self._begin_catchup(run, job_id, trigger, scheduled_at,
                                             record_event)

        # -------------------- WEBSOCKET START -----------------------------
        if job_id == "ws_start":
            if not is_trading_day:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not a trading day",
                                          reason_code="NOT_TRADING_DAY",
                                          record_event=record_event)
            if ws_connected:
                reached = was_catching_up or not missed
                return await self._settle(
                    run, ST_COMPLETED if reached else ST_ALREADY_SATISFIED,
                    trigger,
                    reason="Feed connected" if reached
                           else "Feed already connected",
                    reason_code="FEED_CONNECTED" if reached
                               else "FEED_ALREADY_ACTIVE",
                    record_event=record_event)
            if not ws_enabled:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="WebSocket feed disabled in settings",
                                          reason_code="WS_DISABLED",
                                          record_event=record_event)
            # Market window + feed window validity for a missed start. The daily
            # feed start stays valid for catch-up until ws_stop (15:31); only
            # after that is it obsolete for the day.
            if now_ts >= ws_stop_at.timestamp():
                return await self._settle(run, ST_MISSED_EXPIRED, trigger,
                                          reason="Market/feed window no longer valid",
                                          reason_code="MARKET_WINDOW_NO_LONGER_VALID",
                                          record_event=record_event)
            if market_state in {"MARKET_CLOSED", "NO_TICKS_AFTER_CONFIRMATION",
                                "WEEKEND", "EXCHANGE_HOLIDAY", "SPECIAL_CLOSURE_STATE"}:
                return await self._settle(run, ST_MISSED_EXPIRED, trigger,
                                          reason="Market window no longer valid",
                                          reason_code="MARKET_WINDOW_NO_LONGER_VALID",
                                          record_event=record_event)
            if not network_ok:
                return await self._settle(run, ST_WAITING_NETWORK, trigger,
                                          reason="Network unavailable for feed start",
                                          reason_code="NETWORK_OFFLINE",
                                          record_event=record_event)
            if was_catching_up:
                return None  # supervisor is still connecting
            return await self._begin_catchup(run, job_id, trigger, scheduled_at,
                                             record_event)

        # -------------------- TICK COLLECTION START -----------------------
        if job_id == "tick_collection":
            if not is_trading_day:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not a trading day",
                                          reason_code="NOT_TRADING_DAY",
                                          record_event=record_event)
            if not ws_connected:
                # Tick collection cannot start without an active WebSocket.
                reached = was_catching_up or not missed
                return await self._settle(
                    run, ST_COMPLETED if reached else ST_ALREADY_SATISFIED,
                    trigger,
                    reason="Tick collection viable (WS connected)" if reached
                           else "Waiting for WebSocket",
                    reason_code="TICK_VIABLE" if reached
                               else "WAITING_FOR_WS",
                    record_event=record_event)
            if ws_connected and session_active:
                reached = was_catching_up or not missed
                return await self._settle(
                    run, ST_COMPLETED if reached else ST_ALREADY_SATISFIED,
                    trigger,
                    reason="Tick collection active" if reached
                           else "Tick collection already active",
                    reason_code="TICK_COLLECTION_ACTIVE" if reached
                               else "TICK_ALREADY_ACTIVE",
                    record_event=record_event)
            # Tick collection window validity.
            if now_ts >= ws_stop_at.timestamp():
                return await self._settle(run, ST_MISSED_EXPIRED, trigger,
                                          reason="Market window no longer valid for tick collection",
                                          reason_code="MARKET_WINDOW_NO_LONGER_VALID",
                                          record_event=record_event)
            if not network_ok:
                return await self._settle(run, ST_WAITING_NETWORK, trigger,
                                          reason="Network unavailable for tick collection",
                                          reason_code="NETWORK_OFFLINE",
                                          record_event=record_event)
            if was_catching_up:
                return None  # state machine is still establishing the pipeline
            if missed:
                self._log_job(job_id, scheduled_at, now, ST_MISSED, "CATCH_UP")
            return await self._begin_catchup(run, job_id, trigger, scheduled_at,
                                             record_event)

        # -------------------- WEBSOCKET STOP ------------------------------
        if job_id == "ws_stop":
            if not is_trading_day:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not a trading day",
                                          reason_code="NOT_TRADING_DAY",
                                          record_event=record_event)
            if now_ts < ws_stop_at.timestamp() - 1:
                return None  # not due yet
            if not ws_connected:
                reached = was_catching_up or not missed
                return await self._settle(
                    run, ST_COMPLETED if reached else ST_ALREADY_SATISFIED,
                    trigger,
                    reason="Feed stopped" if reached
                           else "Feed already stopped",
                    reason_code="FEED_STOPPED" if reached
                               else "FEED_ALREADY_STOPPED",
                    record_event=record_event)
            if was_catching_up:
                return None  # scheduler is shutting the feed down
            return await self._begin_catchup(run, job_id, trigger, scheduled_at,
                                             record_event)

        # -------------------- LOGOUT --------------------------------------
        if job_id == "logout":
            if not is_trading_day:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not a trading day",
                                          reason_code="NOT_TRADING_DAY",
                                          record_event=record_event)
            if now_ts < logout_at.timestamp() - 1:
                return None
            if not session_active:
                reached = was_catching_up or not missed
                return await self._settle(
                    run, ST_COMPLETED if reached else ST_ALREADY_SATISFIED,
                    trigger,
                    reason="Session logged out" if reached
                           else "Session already logged out",
                    reason_code="SESSION_LOGGED_OUT" if reached
                               else "SESSION_ALREADY_LOGGED_OUT",
                    record_event=record_event)
            if was_catching_up:
                return None  # scheduler logout is in progress
            return await self._begin_catchup(run, job_id, trigger, scheduled_at,
                                             record_event)

        # -------------------- MARKET WATCH START ---------------------------
        if job_id == "market_watch_start":
            if not is_trading_day:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not a trading day",
                                          reason_code="NOT_TRADING_DAY",
                                          record_event=record_event)
            # Market Watch start is valid for catch-up until runtime_stop
            if now_ts >= runtime_stop_at.timestamp():
                return await self._settle(run, ST_MISSED_EXPIRED, trigger,
                                          reason="Market Watch runtime window closed",
                                          reason_code="RUNTIME_WINDOW_EXPIRED",
                                          record_event=record_event)
            if not network_ok:
                return await self._settle(run, ST_WAITING_NETWORK, trigger,
                                          reason="Network unavailable for Market Watch start",
                                          reason_code="NETWORK_OFFLINE",
                                          record_event=record_event)
            if was_catching_up:
                return None  # Market Watch engine is starting
            if missed:
                self._log_job(job_id, scheduled_at, now, ST_MISSED, "CATCH_UP")
            return await self._begin_catchup(run, job_id, trigger, scheduled_at,
                                             record_event)

        # -------------------- MARKET WATCH STOP ----------------------------
        if job_id == "market_watch_stop":
            if not is_trading_day:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not a trading day",
                                          reason_code="NOT_TRADING_DAY",
                                          record_event=record_event)
            # Market Watch stop at runtime_stop
            if now_ts < runtime_stop_at.timestamp() - 1:
                return None
            # Check if Market Watch engine is already stopped
            try:
                from services.market_watch_engine import market_watch_engine
                if market_watch_engine._lifecycle_state in ("RUNTIME_INACTIVE", "MARKET_WATCH_STOPPED", "REPORTING", "COMPLETED"):
                    reached = was_catching_up or not missed
                    return await self._settle(
                        run, ST_COMPLETED if reached else ST_ALREADY_SATISFIED,
                        trigger,
                        reason="Market Watch already stopped" if reached
                               else "Market Watch already inactive",
                        reason_code="MARKET_WATCH_STOPPED" if reached
                                   else "MARKET_WATCH_ALREADY_STOPPED",
                        record_event=record_event)
            except Exception:
                pass  # Engine not available, proceed with catch-up
            if was_catching_up:
                return None  # Market Watch stop in progress
            if missed:
                self._log_job(job_id, scheduled_at, now, ST_MISSED, "CATCH_UP")
            return await self._begin_catchup(run, job_id, trigger, scheduled_at,
                                             record_event)

        # -------------------- MARKET WATCH FRIDAY SCAN ---------------------------
        if job_id == "market_watch_friday_scan":
            # Only run on Fridays (weekday 4)
            if now.weekday() != 4:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not Friday — scan runs weekly on Fridays",
                                          reason_code="NOT_FRIDAY",
                                          record_event=record_event)
            if not is_trading_day:
                return await self._settle(run, ST_SKIPPED, trigger,
                                          reason="Not a trading day",
                                          reason_code="NOT_TRADING_DAY",
                                          record_event=record_event)
            # Verify the real outcome before claiming the job is in progress.
            # The engine owns the scan; the ledger only records what it sees.
            try:
                from services.market_watch_engine import market_watch_engine
                from services.market_watch_universe import week_id_for
                if market_watch_engine._friday_scan_done_for == week_id_for(now):
                    last = dict(getattr(market_watch_engine, "_friday_scan_last", {}) or {})
                    reached = was_catching_up or not missed
                    return await self._settle(
                        run, ST_COMPLETED if reached else ST_ALREADY_SATISFIED,
                        trigger,
                        reason=(
                            f"Friday scan completed for {last.get('targetWeekId') or 'the upcoming week'}"
                            f" ({last.get('symbols')} symbols)"
                            if reached else "Friday scan already completed"
                        ),
                        reason_code="FRIDAY_SCAN_COMPLETED" if reached else "FRIDAY_SCAN_ALREADY_COMPLETED",
                        record_event=record_event)
            except Exception:
                pass  # Engine not available — fall through to catch-up
            # The screen can take minutes (prices + broker margin for the whole
            # market) and the engine may catch up after the 15:30 runtime stop.
            # Keep the ledger occurrence valid until logout, then expire it.
            if now_ts >= logout_at.timestamp():
                return await self._settle(run, ST_MISSED_EXPIRED, trigger,
                                          reason="Trading day closed before the Friday scan completed",
                                          reason_code="RUNTIME_WINDOW_EXPIRED",
                                          record_event=record_event)
            if not network_ok:
                return await self._settle(run, ST_WAITING_NETWORK, trigger,
                                          reason="Network unavailable for Market Watch Friday scan",
                                          reason_code="NETWORK_OFFLINE",
                                          record_event=record_event)
            if was_catching_up:
                return None  # Market Watch Friday scan is running
            if missed:
                self._log_job(job_id, scheduled_at, now, ST_MISSED, "CATCH_UP")
            return await self._begin_catchup(run, job_id, trigger, scheduled_at,
                                             record_event)

        return None

    # ------------------------------------------------------------------
    # Execution / settlement helpers
    # ------------------------------------------------------------------

    async def _begin_catchup(self, run, job_id, trigger, scheduled_at,
                             record_event):
        """Mark a due job as CATCHING_UP for the state machine to satisfy.

        Does not perform the action itself. A single atomic claim guarantees
        only one worker starts the recovery; the outcome is verified from real
        state on subsequent ticks (see :meth:`_reconcile_job`).
        """
        if run.get("status") in (ST_CATCHING_UP, ST_RUNNING):
            return None
        if run.get("status") == ST_WAITING_NETWORK:
            trigger = TRIGGER_NETWORK  # resumed once the network came back
        claimed = await self._claim(
            run["_id"],
            {ST_PENDING, ST_MISSED, ST_MISSED_EXPIRED, ST_WAITING_NETWORK, ST_CATCHING_UP, ST_RUNNING},
            {"status": ST_CATCHING_UP, "trigger": trigger, "started_at": _now()},
        )
        if not claimed:
            return None
        self._invalidate_status_cache(run.get("business_date"))
        if trigger == TRIGGER_MISSED:
            record_event("scheduler", "SCHEDULED_JOB_MISSED", "warning",
                         f"{job_id} missed its schedule; catching up ({trigger})",
                         {"job_id": job_id, "trigger": trigger,
                          "broker": run.get("broker") or "kotak"})
        else:
            record_event("scheduler", "SCHEDULED_JOB_STARTED", "info",
                         f"{job_id} scheduled start in progress ({trigger})",
                         {"job_id": job_id, "trigger": trigger,
                          "broker": run.get("broker") or "kotak"})
        self._log_job(job_id, scheduled_at, _now(), ST_CATCHING_UP,
                      f"trigger={trigger}")
        return {"job": job_id, "trigger": trigger, "status": ST_CATCHING_UP}

    async def _settle(self, run, status, trigger, *, reason, reason_code,
                      record_event):
        """Idempotently record a terminal outcome with a single event."""
        if run.get("status") == status and run.get("reason_code") == reason_code:
            return None
        # A completed execution keeps the trigger captured when it began
        # (scheduled / MISSED_SCHEDULE_CATCHUP / NETWORK_RECOVERY).
        if status == ST_COMPLETED and run.get("trigger") in {
            TRIGGER_SCHEDULED, TRIGGER_MISSED, TRIGGER_NETWORK,
        }:
            trigger = run.get("trigger")
        fields: dict = {
            "status": status, "trigger": trigger,
            "reason": reason, "reason_code": reason_code,
        }
        if status == ST_COMPLETED:
            fields["completed_at"] = _now()
        elif status == ST_FAILED:
            fields["failed_at"] = _now()
        await self.update(run["_id"], **fields)
        if status in _TERMINAL:
            self._settled.add(run.get("execution_id"))

        job_id = run.get("job_id") or "?"
        self._invalidate_status_cache(run.get("business_date"))
        event, level = {
            ST_COMPLETED: ("SCHEDULED_JOB_COMPLETED", "info"),
            ST_FAILED: ("SCHEDULED_JOB_FAILED", "error"),
            ST_MISSED_EXPIRED: ("SCHEDULED_JOB_EXPIRED", "warning"),
            ST_ALREADY_SATISFIED: ("SCHEDULED_JOB_SKIPPED", "info"),
            ST_SKIPPED: ("SCHEDULED_JOB_SKIPPED", "info"),
            ST_WAITING_NETWORK: ("SCHEDULED_JOB_WAITING_NETWORK", "warning"),
        }.get(status, ("SCHEDULED_JOB_UPDATED", "info"))
        message = {
            ST_COMPLETED: f"{job_id} completed ({trigger})",
            ST_FAILED: f"{job_id} failed: {reason}",
            ST_MISSED_EXPIRED: f"{job_id} expired: {reason} ({reason_code})",
            ST_ALREADY_SATISFIED: f"{job_id} already satisfied: {reason}",
            ST_SKIPPED: f"{job_id} skipped: {reason}",
            ST_WAITING_NETWORK: f"{job_id} waiting for network: {reason}",
        }.get(status, f"{job_id}: {reason} ({reason_code})")
        record_event("scheduler", event, level, message,
                     {"job_id": job_id, "status": status, "trigger": trigger,
                      "reason_code": reason_code,
                      "broker": run.get("broker") or "kotak"})
        self._log_job(job_id, run.get("scheduled_at"), _now(), status,
                      f"{reason} ({reason_code})")
        return {"job": job_id, "status": status, "trigger": trigger}

    @staticmethod
    def _log_job(job_id, scheduled_at, now, state, message) -> None:
        try:
            sched_iso = scheduled_at.isoformat() if isinstance(scheduled_at, datetime) else scheduled_at
            now_iso = now.isoformat() if isinstance(now, datetime) else now
        except Exception:
            sched_iso, now_iso = str(scheduled_at), str(now)
        logger.info(
            "[SCHEDULER] job=%s scheduled=%s current=%s state=%s %s",
            job_id, sched_iso, now_iso, state, message,
        )


# Single shared instance owned by the scheduler controller.
scheduler_ledger = SchedulerLedger()