"""Idempotent, logged, non-destructive database migrations for KAUSTUBH.

Responsible for the ``system_events`` ledger integrity:

1. ``detect_duplicate_event_ids`` — find event_id groups with more than one doc.
2. ``reconcile_system_event_ids`` — repair duplicates (keep one canonical doc,
   assign fresh collision-resistant ids to the rest, log every repair).
3. ``ensure_system_events_unique_index`` — create the ``event_id`` unique index
   ONLY after data is clean; reuses existing equivalent indexes, drops a
   non-unique one if present, and retries repair if a new DuplicateKeyError
   appears (e.g. legacy writers still active).
4. ``run_startup_migrations`` — run the above at startup, gated by a persisted
   migration record (``_migrations`` collection) so the full repair never runs
   on every boot.

Every routine is rerunnable and never deletes or drops data.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("app")

MIGRATIONS_COLLECTION = "_migrations"
SYSTEM_EVENTS_COLLECTION = "system_events"
LOCK_STALENESS_SECONDS = 60.0
MIGRATION_NAME = "system_events.event_id_unique_repair"


def _epoch_now() -> float:
    return datetime.now(timezone.utc).timestamp()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def detect_duplicate_event_ids(
    db, collection: str = SYSTEM_EVENTS_COLLECTION
) -> list[dict[str, Any]]:
    """Return every duplicate event_id group as ``[{event_id, count, doc_ids}]``.

    O(groups) — cheap on a clean collection (returns [] immediately).
    """
    coll = db[collection]
    pipeline = [
        {"$group": {"_id": "$event_id", "doc_ids": {"$push": "$_id"}, "count": {"$sum": 1}}},
        {"$match": {"count": {"$gt": 1}}},
        {"$sort": {"count": -1}},
    ]
    groups = []
    async for g in coll.aggregate(pipeline, allowDiskUse=True):
        groups.append({
            "event_id": g["_id"],
            "count": int(g["count"]),
            "doc_ids": list(g.get("doc_ids", [])),
        })
    return groups


async def reconcile_system_event_ids(
    db, collection: str = SYSTEM_EVENTS_COLLECTION, *, dry_run: bool = False
) -> dict[str, Any]:
    """Repair duplicate ``event_id`` values in the ledger.

    For every duplicate group:
    - keep the earliest document (by ``ts`` then ``_id``) as the canonical row;
    - assign a fresh collision-resistant UUID-based ``event_id`` to every other
      document and tag it with ``repaired_from_event_id`` + ``repaired_at`` so
      the audit trail stays traceable;
    - never touches unrelated documents.

    Idempotent: no duplicates -> zero repairs. Returns a report dict.
    """
    coll = db[collection]
    groups = await detect_duplicate_event_ids(db, collection)

    from services.event_history import _next_event_id

    repaired = 0
    repaired_ids: list[str] = []
    canonical = 0
    failed = 0
    failures: list[str] = []

    for g in groups:
        old_id = g["event_id"]
        doc_ids = list(g.get("doc_ids", []))
        if len(doc_ids) < 2:
            continue
        docs = [d async for d in coll.find({"_id": {"$in": doc_ids}})]
        docs.sort(key=lambda d: (d.get("ts"), d.get("_id")))
        kept = docs[0]
        others = docs[1:]
        canonical += 1
        if dry_run:
            repaired += len(others)
            continue
        try:
            for doc in others:
                new_id = _next_event_id()
                await coll.update_one(
                    {"_id": doc["_id"]},
                    {"$set": {
                        "event_id": new_id,
                        "repaired_from_event_id": old_id,
                        "repaired_at": _now_iso(),
                    }},
                )
                repaired += 1
                repaired_ids.append(str(doc["_id"]))
        except Exception as exc:  # pragma: no cover - defensive
            failed += 1
            failures.append(f"group={old_id!r}: {exc}")
            logger.exception("system_events repair failed for group %s", old_id)

    report = {
        "name": MIGRATION_NAME,
        "collection": collection,
        "duplicate_groups": len(groups),
        "documents_in_duplicate_groups": sum(int(g["count"]) for g in groups),
        "repaired": int(repaired),
        "canonical_kept": int(canonical),
        "failed": int(failed),
        "failures": failures,
        "repaired_doc_ids": repaired_ids,
        "dry_run": bool(dry_run),
        "ran_at": _now_iso(),
    }
    if repaired:
        logger.info(
            "EVENT_LEDGER_REPAIR repaired=%d duplicate_groups=%d canonical_kept=%d collection=%s",
            repaired, len(groups), canonical, collection,
        )
    else:
        logger.info("EVENT_LEDGER_REPAIR no duplicates found (collection=%s)", collection)
    return report


# ---------------------------------------------------------------------------
# Migration bookkeeping (persisted, rerunnable, safe across workers).
# ---------------------------------------------------------------------------
async def _claim_lock(db, name: str) -> bool:
    """Atomically claim the migration lock or hand off a stale one."""
    from pymongo.errors import DuplicateKeyError

    now = _epoch_now()
    try:
        claimed = await db[MIGRATIONS_COLLECTION].find_one_and_update(
            {"_id": name, "$or": [
                {"state": {"$ne": "running"}},
                {"acquired_at_epoch": {"$lte": now - LOCK_STALENESS_SECONDS}},
            ]},
            {"$set": {"_id": name, "state": "running", "acquired_at_epoch": now,
                      "acquired_at": _now_iso()}},
            upsert=True,
            return_document=True,
        )
        return bool(claimed)
    except DuplicateKeyError:
        # Another worker holds the lock (a recent "running" row already exists).
        return False


def _release_lock(db, name: str) -> None:
    """Fire-and-forget lock release after the migration is recorded.

    Only transitions a row that is still ``running``; never overwrites an
    already ``applied`` record (which would make the migration look unapplied
    and re-run the full repair on the next boot).
    """
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    try:
        asyncio.ensure_future(
            db[MIGRATIONS_COLLECTION].update_one(
                {"_id": name, "state": "running"},
                {"$set": {"state": "done", "released_at": _now_iso()}},
            )
        )
    except Exception:
        logger.debug("migration lock release skipped for %s", name)


async def record_migration(db, name: str, report: dict[str, Any]) -> None:
    """Record a completed migration (idempotent bookkeeping)."""
    try:
        await db[MIGRATIONS_COLLECTION].update_one(
            {"_id": name},
            {
                "$set": {
                    "state": "applied",
                    "applied_at": _now_iso(),
                    "report": dict(report),
                }
            },
            upsert=True,
        )
    except Exception:  # pragma: no cover - defensive
        logger.warning("migration record write failed for %s", name)


async def is_migration_applied(db, name: str) -> bool:
    try:
        doc = await db[MIGRATIONS_COLLECTION].find_one({"_id": name})
    except Exception:
        return False
    return bool(doc and doc.get("state") == "applied")


async def _release_lock_after(db, name: str) -> None:
    _release_lock(db, name)


# ---------------------------------------------------------------------------
# Unique index management (idempotent, never silently ignores DuplicateKeyError).
# ---------------------------------------------------------------------------
async def _existing_event_id_indexes(db, collection: str) -> list[tuple[str, bool]]:
    """[(index_name, is_unique)] for every index keyed on event_id."""
    out: list[tuple[str, bool]] = []
    try:
        info = await db[collection].index_information()
    except Exception as exc:
        logger.warning("index_information failed for %s: %s", collection, exc)
        return out
    for name, spec in info.items():
        fields = tuple(f for f, _ in ((spec or {}).get("key") or []))
        if fields == ("event_id",):
            out.append((name, bool(spec.get("unique"))))
    return out


async def ensure_system_events_unique_index(
    db, collection: str = SYSTEM_EVENTS_COLLECTION, *,
    retries: int = 2, migration_name: str = MIGRATION_NAME,
) -> dict[str, Any]:
    """Create a real unique index on ``event_id``, repairing data first if needed.

    - Reuses an existing unique ``event_id`` index.
    - Drops an existing NON-unique ``event_id`` index (it would silently let
      duplicates through) after the data is repaired.
    - On DuplicateKeyError (legacy writers reintroduced duplicates) runs the
      repair and retries; only raises after the retries are exhausted.
    """
    coll = db[collection]

    existing = await _existing_event_id_indexes(db, collection)
    for name, is_unique in existing:
        if is_unique:
            logger.info("Indexes: event_id unique index reuse=%s", name)
            return {"name": name, "created": False, "reused": True}

    for name, is_unique in existing:
        if not is_unique:
            # A non-unique event_id index must never silently pass — drop it and
            # recreate unique after the data is clean.
            reconcile = await reconcile_system_event_ids(db, collection)
            if reconcile["repaired"] or reconcile["duplicate_groups"]:
                logger.info("Indexes: data repaired before replacing non-unique event_id index (%s)", reconcile)
            await coll.drop_index(name)
            logger.warning("Indexes: dropped non-unique event_id index %s", name)

    attempt = 0
    last_error: Exception | None = None
    while attempt <= retries:
        try:
            index_name = await coll.create_index("event_id", unique=True, background=True)
            await record_migration(db, f"{migration_name}.index", {
                "name": migration_name, "index_created": True,
                "index_name": index_name, "attempt": attempt,
            })
            logger.info("Indexes: event_id unique index created=%s", index_name)
            return {"name": index_name, "created": True, "reused": False}
        except Exception as exc:
            msg = f"{exc.__class__.__name__}: {exc}"
            if "DuplicateKeyError" not in str(exc.__class__.__name__) and "E11000" not in msg:
                raise
            last_error = exc
            attempt += 1
            logger.warning(
                "Indexes: event_id unique index duplicate key error (attempt %d/%d)",
                attempt, retries,
            )
            if attempt <= retries:
                reconcile = await reconcile_system_event_ids(db, collection)
                if reconcile["repaired"]:
                    logger.warning(
                        "Indexes: repaired=%d duplicates before retrying unique index",
                        reconcile["repaired"],
                    )

    raise RuntimeError(
        "system_events.event_id unique index could not be created after repair: duplicate "
        f"event_ids remain. Last error: {last_error}"
    )


# ---------------------------------------------------------------------------
# Startup orchestration.
# ---------------------------------------------------------------------------
async def run_startup_migrations(db, collection: str = SYSTEM_EVENTS_COLLECTION,
                                 migration_name: str = MIGRATION_NAME) -> list[dict[str, Any]]:
    """Run ledger migrations once per database state (idempotent + logged).

    Returns a list of per-migration reports. Never runs the full collection
    repair on every boot — it is skipped when already applied AND the unique
    index already exists.
    """
    report: dict[str, Any] = {"name": migration_name, "ran": True}

    # 1) Repair duplicate event_ids (once per clean state).
    if not await is_migration_applied(db, migration_name):
        if not await _claim_lock(db, migration_name):
            logger.info("EVENT_LEDGER_REPAIR skipped (locked by another worker)")
            report["repair"] = {"skipped": "locked"}
        else:
            try:
                report["repair"] = await reconcile_system_event_ids(db, collection)
                await record_migration(db, migration_name, report["repair"])
            finally:
                await _release_lock_after(db, migration_name)
    else:
        report["repair"] = {"skipped": "already-applied"}

    # 2) Ensure the unique index exists (idempotent + repair-on-demand).
    report["index"] = await ensure_system_events_unique_index(
        db, collection, migration_name=migration_name)

    return [report]