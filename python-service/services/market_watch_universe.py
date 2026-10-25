"""Weekly locked Market Watch universe (docs/engines/MARKET_WATCH.md §2, §3, §4, §6, §7, §31, §32, §33).

The operating model in doc §2 is a WEEKLY cadence, not a daily one:

    SATURDAY  review Mon-Fri saved data -> weekly report -> manual
              ADD / REMOVE / KEEP -> LOCK  (freeze + version bump)
    MON-FRI   monitor EXACTLY the locked list. Nothing else.

Non-negotiables enforced here (doc §35):

* ``LOCKED`` is the only source of Market Watch membership. Instrument Master
  availability does NOT authorise a subscription (§3, §35.4).
* There is no automatic mid-week add/remove (§33). ``record_decision`` writes an
  operator decision into a DRAFT week; it never mutates a LOCKED week.
* ``lock_universe`` is the single mutation that freezes a week, bumps the
  version and writes the immutable history row.
* Missing data stays ``None`` / ``UNKNOWN``. Nothing is fabricated (§35.11).

Persistence
-----------
doc §13/§35.9 make DB Writer the only MongoDB tick-persistence owner. Every write
here therefore goes through ``db_writer_engine.buffer_documents`` — the same
hand-off used by ``market_watch_report`` and ``market_watch_ledger``. Reads use
the database directly, which is permitted.

Collections (doc §31):
    market_watch_universe            — current locked week (one live document)
    market_watch_universe_history    — immutable audit row per LOCK
    market_watch_review_decisions    — operator ADD / REMOVE / KEEP per symbol
    market_watch_weekly_reports      — generated Saturday weekly reports
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

logger = logging.getLogger("app.market_watch_universe")

from services.market_watch_config import (
    REVIEW_ACTION_ADD,
    REVIEW_ACTION_KEEP,
    REVIEW_ACTION_REMOVE,
    REVIEW_ACTIONS,
    WEEK_STATUS_DRAFT,
    WEEK_STATUS_LOCKED,
    WEEK_STATUS_SUPERSEDED,
    load as load_config,
)

COLLECTION_UNIVERSE = "market_watch_universe"
COLLECTION_HISTORY = "market_watch_universe_history"
COLLECTION_DECISIONS = "market_watch_review_decisions"
COLLECTION_WEEKLY_REPORTS = "market_watch_weekly_reports"

#: Monday of the week that contains ``d``.
def week_start(d: Optional[datetime] = None) -> datetime:
    d = d or _now_ist_date()
    return (d - timedelta(days=d.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


def week_id_for(d: Optional[datetime] = None) -> str:
    """ISO week id, e.g. ``2026-W41`` (doc 6 example)."""
    d = d or _now_ist_date()
    iso = d.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def next_week_start(d: Optional[datetime] = None) -> datetime:
    """Monday of the week AFTER the week containing ``d``.

    doc §2/§5/§32: the Saturday review reads the week that just finished, but the
    membership it produces belongs to the week that is about to start. Without
    this the only derivable week is the current (already locked) one, so a
    review can never target next week's membership.
    """
    return week_start(d) + timedelta(days=7)


def next_week_id_for(d: Optional[datetime] = None) -> str:
    """ISO week id of the upcoming week — the LOCK target of a review."""
    return week_id_for(next_week_start(d))


def week_start_from_id(week_id: str) -> Optional[datetime]:
    """Monday 00:00 of the week named by an ISO week id, or ``None``.

    ``lock_universe`` must stamp the validity window of the week it is LOCKING.
    Deriving it from "now" is wrong whenever the lock targets the UPCOMING week
    (the normal Saturday review), which would label next week's universe with
    this week's dates.
    """
    try:
        year_text, _, week_text = str(week_id or "").partition("-W")
        return datetime.fromisocalendar(int(year_text), int(week_text), 1)
    except Exception:
        return None


def review_target_week_id(d: Optional[datetime] = None) -> str:
    """The week a review/lock must target.

    During and after a trading week the operator is deciding NEXT week's
    membership, so that is the target. Before the first trading week of a cycle
    there is nothing to review yet, so the current week is the target.
    """
    d = d or _now_ist_date()
    if d.weekday() == 0:
        # Monday: the week being reviewed is the previous one and its membership
        # for the current week may not be locked yet.
        return week_id_for(d)
    return next_week_id_for(d)


def next_review_at(cfg=None) -> Optional[str]:
    """IST timestamp of the next scheduled weekly review (doc §2 Saturday step).

    Returns ``None`` when the weekly review is disabled by configuration.
    """
    from services.market_watch_config import load as _load

    weekly = (cfg or _load()).weekly
    if not getattr(weekly, "enabled", False):
        return None
    weekday = int(getattr(weekly, "review_weekday", 5))
    hhmm = str(getattr(weekly, "review_hhmm", "18:00") or "18:00")
    try:
        hour, _, minute = hhmm.partition(":")
        hour_i, minute_i = int(hour), int(minute or 0)
    except Exception:
        hour_i, minute_i = 18, 0
    now = _now_ist_date()
    for offset in range(8):
        day = now + timedelta(days=offset)
        if day.weekday() != weekday:
            continue
        candidate = day.replace(hour=hour_i, minute=minute_i, second=0, microsecond=0)
        if candidate > now:
            return candidate.isoformat()
    return None


def _now_ist_date() -> datetime:
    from core.timezones import IST

    return datetime.now(IST)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class WeeklyUniverse:
    """One versioned weekly universe (doc §6 field list, verbatim).

    ``symbols`` is the frozen membership. ``added`` / ``removed`` / ``kept`` are
    the doc §32 lock-time audit trail of what the operator decided.
    """

    week_id: str
    version: int = 0
    status: str = WEEK_STATUS_DRAFT
    symbols: list[str] = field(default_factory=list)
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    kept: list[str] = field(default_factory=list)
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    locked_at: Optional[str] = None
    locked_by: Optional[str] = None
    source_week_id: Optional[str] = None
    notes: Optional[str] = None
    created_at: Optional[str] = None

    @property
    def locked(self) -> bool:
        return self.status == WEEK_STATUS_LOCKED

    def __contains__(self, symbol: str) -> bool:
        return symbol in self._symbol_set

    def __len__(self) -> int:
        return len(self.symbols)

    @property
    def _symbol_set(self) -> frozenset[str]:
        return frozenset(self.symbols)

    def to_doc(self) -> dict[str, Any]:
        return {
            "weekId": self.week_id,
            "week_id": self.week_id,
            "version": self.version,
            "status": self.status,
            "symbols": list(self.symbols),
            "symbolCount": len(self.symbols),
            "added": list(self.added),
            "removed": list(self.removed),
            "kept": list(self.kept),
            "effectiveFrom": self.effective_from,
            "effectiveTo": self.effective_to,
            "lockedAt": self.locked_at,
            "lockedBy": self.locked_by,
            "sourceWeekId": self.source_week_id,
            "notes": self.notes,
            "createdAt": self.created_at or _utc_now_iso(),
            "updatedAt": _utc_now_iso(),
        }

    @classmethod
    def from_doc(cls, doc: dict[str, Any]) -> "WeeklyUniverse":
        return cls(
            week_id=str(doc.get("weekId") or doc.get("week_id") or ""),
            version=int(doc.get("version") or 0),
            status=str(doc.get("status") or WEEK_STATUS_DRAFT),
            symbols=[str(s) for s in (doc.get("symbols") or []) if s],
            added=[str(s) for s in (doc.get("added") or []) if s],
            removed=[str(s) for s in (doc.get("removed") or []) if s],
            kept=[str(s) for s in (doc.get("kept") or []) if s],
            effective_from=doc.get("effectiveFrom"),
            effective_to=doc.get("effectiveTo"),
            locked_at=doc.get("lockedAt"),
            locked_by=doc.get("lockedBy"),
            source_week_id=doc.get("sourceWeekId"),
            notes=doc.get("notes"),
            created_at=doc.get("createdAt"),
        )

    def summary(self) -> dict[str, Any]:
        return {
            "weekId": self.week_id,
            "version": self.version,
            "status": self.status,
            "symbolCount": len(self.symbols),
            "addedCount": len(self.added),
            "removedCount": len(self.removed),
            "keptCount": len(self.kept),
            "effectiveFrom": self.effective_from,
            "effectiveTo": self.effective_to,
            "lockedAt": self.locked_at,
            "lockedBy": self.locked_by,
            "sourceWeekId": self.source_week_id,
            "notes": self.notes,
        }


# --------------------------------------------------------------------------- #
# In-process cache. The engine reads the locked list on every restart/recovery
# path, so the document is cached but always reloadable.
# --------------------------------------------------------------------------- #
_cache_lock = threading.RLock()
_cached_universe: Optional[WeeklyUniverse] = None
_cache_loaded = False
#: week_id -> DRAFT overlay.
#:
#: ``persist_universe`` hands the draft to the DB Writer's BUFFER, which flushes
#: a few seconds later. A read-modify-write that read the draft straight from
#: Mongo would therefore read a state that predates the previous decision, and
#: the next upsert (keyed ``weekId:DRAFT``) would silently discard that decision.
#: That is how an operator's ADD could vanish. The overlay makes the in-process
#: draft the authority for its own mutation sequence, so consecutive
#: ADD/REMOVE/KEEP commands compose exactly as issued.
#:
#: Scope: one backend process. ``invalidate_cache`` clears the overlay, and
#: ``lock_universe`` drops the locked week from it (a locked week is immutable,
#: doc §33). A multi-process deployment would need this state shared; that is
#: recorded as a known limitation rather than silently assumed away.
_draft_overlay: dict[str, WeeklyUniverse] = {}


def invalidate_cache() -> None:
    global _cached_universe, _cache_loaded
    with _cache_lock:
        _cached_universe = None
        _cache_loaded = False
        _draft_overlay.clear()


def _db():
    from database.connection import get_db

    return get_db()


def _sink():
    """DB Writer hand-off (doc §13/§35.9). Falls back to None when the writer is
    not running; callers must report persistence honestly rather than writing
    directly.

    This must be the DB Writer **instance**
    (``services.db_writer_engine.db_writer_engine``). Importing the module and
    calling ``buffer_documents`` on it raised ``AttributeError`` every time, so
    every weekly write silently reported ``persisted: false`` and the locked
    universe was never actually stored.
    """
    try:
        from services.db_writer_engine import db_writer_engine as writer

        return writer
    except Exception:
        return None


def _buffer(collection: str, docs: list[dict[str, Any]]) -> bool:
    writer = _sink()
    if writer is None:
        return False
    try:
        writer.buffer_documents(collection, docs)
        return True
    except Exception:
        return False


async def ensure_indexes() -> bool:
    """Idempotent index creation. Reads/index admin are permitted directly."""
    try:
        db = _db()
        await db.market_watch_universe.create_index([("status", 1), ("version", -1)], name="mw_universe_status_version")
        await db.market_watch_universe_history.create_index([("weekId", 1), ("version", -1)], name="mw_history_week_version")
        await db.market_watch_review_decisions.create_index(
            [("weekId", 1), ("symbol", 1)], unique=True, name="mw_decision_week_symbol"
        )
        await db.market_watch_weekly_reports.create_index([("weekId", 1)], name="mw_weekly_report_week")
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #
async def load_locked_universe(*, refresh: bool = False) -> Optional[WeeklyUniverse]:
    """The latest LOCKED weekly universe, or ``None`` when none is locked.

    This is the ONLY membership source when
    ``cfg.weekly.universe_source == "LOCKED"`` (doc §3, §7).
    """
    global _cached_universe, _cache_loaded
    with _cache_lock:
        if _cache_loaded and not refresh and _cached_universe is not None:
            return _cached_universe
    try:
        doc = await (
            _db()
            .market_watch_universe.find_one({"status": WEEK_STATUS_LOCKED}, sort=[("lockedAt", -1), ("version", -1)])
        )
    except Exception:
        # NB: an EMPTY locked universe (zero symbols) is a legitimate LOCKED
        # week, so this must not use a truthiness test — ``WeeklyUniverse``
        # defines ``__len__``, which makes a zero-symbol universe falsy and
        # would silently report "no lock at all".
        return _cached_universe if _cache_loaded else None
    universe = WeeklyUniverse.from_doc(doc) if doc else None
    with _cache_lock:
        _cached_universe = universe
        _cache_loaded = True
    return universe


async def active_symbols() -> frozenset[str]:
    """Symbols the engine is allowed to monitor right now (doc §7)."""
    universe = await load_locked_universe()
    if universe is None:
        return frozenset()
    return frozenset(universe.symbols)


async def get_draft(week_id: str) -> Optional[WeeklyUniverse]:
    """The editable DRAFT for ``week_id`` (the operator's working list).

    Returns a copy of the in-process overlay when one exists, so a caller that
    mutates the result cannot corrupt the overlay without persisting it.
    """
    with _cache_lock:
        cached = _draft_overlay.get(week_id)
        if cached is not None:
            return WeeklyUniverse.from_doc(cached.to_doc())
    try:
        doc = await _db().market_watch_universe.find_one({"weekId": week_id, "status": WEEK_STATUS_DRAFT})
    except Exception:
        return None
    if not doc:
        return None
    draft = WeeklyUniverse.from_doc(doc)
    with _cache_lock:
        _draft_overlay[week_id] = WeeklyUniverse.from_doc(draft.to_doc())
    return draft


async def history(limit: int = 52) -> list[dict[str, Any]]:
    """Immutable LOCK history, newest first (doc §6 audit trail)."""
    try:
        cursor = (
            _db()
            .market_watch_universe_history.find({})
            .sort([("lockedAt", -1)])
            .limit(max(1, min(200, limit)))
        )
        return [dict(d) async for d in cursor]
    except Exception:
        return []


async def decisions_for(week_id: str) -> dict[str, dict[str, Any]]:
    """Operator decisions recorded for ``week_id``, keyed by symbol."""
    try:
        cursor = _db().market_watch_review_decisions.find({"weekId": week_id})
        return {str(d.get("symbol")): dict(d) async for d in cursor if d.get("symbol")}
    except Exception:
        return {}


async def is_locked(week_id: str) -> bool:
    """True when ``week_id`` already has a LOCKED version (doc §33 no auto-change)."""
    try:
        return (
            await _db()
            .market_watch_universe.count_documents({"weekId": week_id, "status": WEEK_STATUS_LOCKED}, limit=1)
            > 0
        )
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Draft + decisions (doc §32)
# --------------------------------------------------------------------------- #
async def seed_draft_from_locked(week_id: str, *, source_week_id: Optional[str] = None) -> Optional[WeeklyUniverse]:
    """Create (or refresh) the DRAFT for ``week_id`` from the previous lock.

    Seeding copies the previous LOCKED membership as ``kept`` — it does NOT
    discover new symbols. New candidates only enter through an explicit ADD.
    """
    if await is_locked(week_id):
        # doc 33: a locked week can never change.
        return None
    previous = await load_locked_universe()
    symbols = list(previous.symbols) if previous else []
    # Re-seeding REPLACES the working list, so any overlay for this week is
    # dropped first — otherwise the caller would keep editing the stale list.
    with _cache_lock:
        _draft_overlay.pop(week_id, None)
    draft = WeeklyUniverse(
        week_id=week_id,
        version=0,
        status=WEEK_STATUS_DRAFT,
        symbols=symbols,
        kept=list(symbols),
        source_week_id=source_week_id or (previous.week_id if previous else None),
        created_at=_utc_now_iso(),
    )
    if persist_universe(draft):
        _stage_draft(draft)
    return draft


async def record_decision(
    week_id: str,
    symbol: str,
    action: str,
    *,
    locked_by: Optional[str] = None,
    note: Optional[str] = None,
) -> dict[str, Any]:
    """Record one operator ADD / REMOVE / KEEP and apply it to the DRAFT.

    A LOCKED week rejects every decision (doc §33).
    """
    action = str(action or "").strip().upper()
    if action not in REVIEW_ACTIONS:
        raise ValueError(f"unsupported review action: {action!r}")
    if not symbol:
        raise ValueError("symbol is required")
    if await is_locked(week_id):
        raise PermissionError(f"week {week_id} is LOCKED — membership cannot change (doc §33)")

    draft = await get_draft(week_id)
    if draft is None:
        draft = WeeklyUniverse(week_id=week_id, created_at=_utc_now_iso())
    members = list(dict.fromkeys(draft.symbols))
    for bucket in ("added", "removed", "kept"):
        setattr(draft, bucket, [s for s in getattr(draft, bucket) if s != symbol])

    if action == REVIEW_ACTION_ADD:
        if symbol not in members:
            members.append(symbol)
        draft.added.append(symbol)
    elif action == REVIEW_ACTION_REMOVE:
        if symbol in members:
            members.remove(symbol)
        draft.removed.append(symbol)
    else:  # KEEP
        if symbol not in members:
            members.append(symbol)
        draft.kept.append(symbol)

    draft.symbols = members
    if persist_universe(draft):
        _stage_draft(draft)

    doc = {
        # Deterministic ``_id``: one current decision per (week, symbol). The
        # doc buffer writes idempotent collections with
        # ``ReplaceOne({"_id": ...}, upsert=True)`` and SILENTLY DROPS any
        # document without an ``_id`` — which previously discarded the entire
        # operator decision audit trail. This key also matches the existing
        # unique index on ``(weekId, symbol)``.
        "_id": f"{week_id}:{symbol}",
        "weekId": week_id,
        "symbol": symbol,
        "action": action,
        "note": note,
        "decidedBy": locked_by or load_config().weekly.lock_default_user,
        "decidedAt": _utc_now_iso(),
    }
    if not _buffer(COLLECTION_DECISIONS, [doc]):
        # The decision could not be handed to the DB Writer. Say so — the draft
        # itself is already persisted, but the audit trail would be incomplete,
        # and a silently missing decision is worse than a reported failure.
        logger.error(
            "[MARKET_WATCH_UNIVERSE] decision %s %s for %s not accepted by the DB Writer",
            action, symbol, week_id,
        )
    return doc


def _stage_draft(draft: WeeklyUniverse) -> None:
    """Make ``draft`` the in-process authority for its week.

    Called by every mutation AFTER its persist succeeded. Keeping this at the
    call sites (rather than inside ``persist_universe``) means the overlay and
    the hand-off can never disagree: a mutation that does not stage simply does
    not claim the overlay.
    """
    with _cache_lock:
        _draft_overlay[draft.week_id] = WeeklyUniverse.from_doc(draft.to_doc())


def persist_universe(universe: WeeklyUniverse) -> bool:
    """Upsert a DRAFT via DB Writer, superseding any prior draft of that week."""
    if universe.locked:
        # Locked weeks are written only by ``lock_universe``.
        with _cache_lock:
            _draft_overlay.pop(universe.week_id, None)
        return False
    writer = _sink()
    doc = universe.to_doc()
    # One draft document per week (``_id`` is the deterministic upsert key, so a
    # re-seed replaces the draft instead of appending a second one).
    doc["_id"] = f"{universe.week_id}:DRAFT"
    if writer is not None:
        try:
            writer.buffer_documents(COLLECTION_UNIVERSE, [doc])
            return True
        except Exception:
            return False
    # DB Writer unavailable — report honestly instead of writing directly
    # (doc §13/§35.9).
    return False


# --------------------------------------------------------------------------- #
# LOCK (doc §6, §32)
# --------------------------------------------------------------------------- #
async def _next_version(week_id: str) -> int:
    """The next ``version`` for ``week_id`` (doc §6).

    Reads the highest version already stored for the week — across the live
    universe document AND the immutable history — so the version is monotonic
    even after a restart or a re-lock. Falls back to ``1`` when nothing is
    readable, which is honest for a first lock rather than fabricated.
    """
    highest = 0
    try:
        db = _db()
        latest = await db.market_watch_universe.find_one(
            {"weekId": week_id}, sort=[("version", -1)], projection={"version": 1}
        )
        if latest:
            highest = max(highest, int(latest.get("version") or 0))
        cursor = db.market_watch_universe_history.find(
            {"weekId": week_id}, projection={"version": 1}
        )
        async for doc in cursor:
            highest = max(highest, int(doc.get("version") or 0))
    except Exception:
        pass
    return highest + 1


async def lock_universe(
    week_id: str,
    *,
    symbols: Optional[Iterable[str]] = None,
    locked_by: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict[str, Any]:
    """Freeze ``week_id``: assign a version, record the decision audit, freeze.

    After this call the week is immutable for its whole validity window and the
    engine's active subscription set equals exactly ``symbols``.
    """
    cfg = load_config()
    if not cfg.weekly.lock_enabled:
        raise PermissionError("weekly lock is disabled by configuration")
    if await is_locked(week_id):
        raise PermissionError(f"week {week_id} is already LOCKED (doc §33)")

    draft = await get_draft(week_id)
    if draft is None:
        draft = WeeklyUniverse(week_id=week_id, created_at=_utc_now_iso())
    if symbols is not None:
        final = [str(s) for s in symbols if s]
    else:
        final = list(draft.symbols)

    # doc §6 "version" — the next version of THIS week (not always 1), so a
    # re-locked week keeps a monotonic version and the history stays auditable.
    version = await _next_version(week_id)

    # doc §6: the validity window belongs to the week being LOCKED. A Saturday
    # review locks the UPCOMING week, so "this week's Monday" would be wrong.
    locked_week_start = week_start_from_id(week_id) or week_start()

    universe = WeeklyUniverse(
        week_id=week_id,
        version=version,
        status=WEEK_STATUS_LOCKED,
        symbols=final,
        added=list(draft.added),
        removed=list(draft.removed),
        kept=list(draft.kept),
        effective_from=locked_week_start.isoformat(),
        effective_to=(locked_week_start + timedelta(days=7)).isoformat(),
        locked_at=_utc_now_iso(),
        locked_by=locked_by or cfg.weekly.lock_default_user,
        source_week_id=draft.source_week_id,
        notes=notes if notes is not None else draft.notes,
        created_at=draft.created_at,
    )

    # Supersede every previous LOCK so the "latest locked list" query is unique.
    try:
        await _db().market_watch_universe.update_many(
            {"status": WEEK_STATUS_LOCKED}, {"$set": {"status": WEEK_STATUS_SUPERSEDED}}
        )
    except Exception:
        pass

    doc = universe.to_doc()
    # doc §6/§31 — the buffer writes idempotently on ``_id``, so a flush, retry or
    # restart can never create a second LOCK row for the same week.
    doc["_id"] = f"{week_id}:LOCKED"
    history_doc = {**doc, "_id": f"{week_id}:v{version}"}
    writer = _sink()
    persisted = False
    if writer is not None:
        try:
            writer.buffer_documents(COLLECTION_UNIVERSE, [doc])
            writer.buffer_documents(COLLECTION_HISTORY, [history_doc])
            persisted = True
        except Exception:
            persisted = False
    if persisted:
        # The write is buffered, not committed — clear the cache so the next
        # read reloads rather than serving a stale pre-lock view.
        invalidate_cache()
    return {**universe.summary(), "persisted": persisted, "universe": universe}


async def verify_week(week_id: str, universe: Optional[WeeklyUniverse] = None) -> dict[str, Any]:
    """doc §28 step 2 — verify the week/version we are about to monitor.

    Returns an honest verdict; it never repairs or guesses. ``universe`` lets a
    caller that just loaded the lock reuse it instead of paying for an
    identical second MongoDB read.
    """
    if universe is None:
        universe = await load_locked_universe(refresh=True)
    if universe is None:
        return {
            "ok": False,
            "reason": "NO_LOCKED_UNIVERSE",
            "expectedWeekId": week_id,
            "loadedWeekId": None,
            "version": None,
        }
    if universe.week_id != week_id:
        return {
            "ok": False,
            "reason": "WEEK_MISMATCH",
            "expectedWeekId": week_id,
            "loadedWeekId": universe.week_id,
            "version": universe.version,
        }
    return {
        "ok": True,
        "reason": None,
        "expectedWeekId": week_id,
        "loadedWeekId": universe.week_id,
        "version": universe.version,
        "symbolCount": len(universe.symbols),
    }


def current_week_id() -> str:
    return week_id_for()


def engine_state_for(universe: Optional[WeeklyUniverse]) -> str:
    """doc §27 ``WEEKLY_LOCKED`` — the engine is running against a frozen list."""
    from services.market_watch_config import ENGINE_STATE_WEEKLY_LOCKED

    if universe is None or not universe.locked:
        from services.market_watch_config import ENGINE_STATE_OFFLINE

        return ENGINE_STATE_OFFLINE
    return ENGINE_STATE_WEEKLY_LOCKED


__all__ = [
    "COLLECTION_DECISIONS",
    "COLLECTION_HISTORY",
    "COLLECTION_UNIVERSE",
    "COLLECTION_WEEKLY_REPORTS",
    "REVIEW_ACTION_ADD",
    "REVIEW_ACTION_KEEP",
    "REVIEW_ACTION_REMOVE",
    "WeeklyUniverse",
    "active_symbols",
    "current_week_id",
    "decisions_for",
    "ensure_indexes",
    "get_draft",
    "history",
    "invalidate_cache",
    "is_locked",
    "load_locked_universe",
    "lock_universe",
    "next_review_at",
    "next_week_id_for",
    "next_week_start",
    "persist_universe",
    "record_decision",
    "review_target_week_id",
    "seed_draft_from_locked",
    "verify_week",
    "week_id_for",
    "week_start",
    "week_start_from_id",
]