"""Canonical instrument persistence for the Session Manager Engine (Phase 3).

The Session Manager is the single source of truth for *what should be
subscribed and how* (desired set, pins, real expiries, feed level, field
requirements, routing targets). To make that truth durable across restarts and
crash recovery this module persists:

  - ``session_manager_instruments`` — one canonical record per instrument,
    uniquely addressed by ``instrument_id = broker|exchange_segment|instrument_token``.
    Multiple consumers (search, dashboard, watchlist, watchdog, engine, manual)
    MERGE into this single record — never ``WIPRO-1`` / ``WIPRO-2`` duplicates.
  - ``session_manager_events``    — append-only lifecycle event ledger.
  - ``session_manager_revisions`` — monotonic per-owner revision counters.

Documents are JSON-safe (ISO-8601 strings, no ``datetime`` / ``ObjectId``
objects in payload fields) so they can be served to the UI verbatim through
``services.json_safe``.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from database.connection import get_db

logger = logging.getLogger("session.store")

INSTRUMENTS_COLLECTION = "session_manager_instruments"
EVENTS_COLLECTION = "session_manager_events"
REVISIONS_COLLECTION = "session_manager_revisions"

DEFAULT_BROKER = "kotak"

# Sources which MAY claim a canonical record (bounded vocabulary). Anything
# outside this set is still stored but flagged with source="unknown:<raw>".
KNOWN_SOURCES = (
    "engine",
    "search",
    "dashboard",
    "watchlist",
    "data-saver",
    "manual",
    "stocks_db",
    "session-api",
    "scanner",
    "subscriptions",
    "import",
    "migration",
)

# Valid market-data tiers (Kotak SDK) and their numeric feed_level.
MARKET_DATA_TIERS = ("L4", "L8", "L16")
FEED_LEVEL_TO_TIER = {4: "L4", 8: "L8", 16: "L16"}
TIER_TO_FEED_LEVEL = {"L4": 4, "L8": 8, "L16": 16}

# Keys that a persisted canonical record ALWAYS carries (null/missing allowed).
CANONICAL_FIELDS = (
    "instrument_id",
    "broker",
    "exchange_segment",
    "instrument_token",
    "instrument_key",
    "symbol",
    "trading_symbol",
    "is_index",
    "is_depth",
    "source",
    "sources",
    "desired",
    "active",
    "advertised",
    "pinned",
    "status",
    "subscription_state",
    "expires_at",
    "expiry_type",
    "expiry_label",
    "feed_level",
    "market_data",
    "required_fields",
    "routing",
    "routing_targets",
    "connection_targets",
    "last_update_at",
    "created_at",
    "updated_at",
    "last_tick_at",
    "revision",
)

# Valid canonical lifecycle states (Phase 3 vocabulary). Imported lazily to
# avoid a circular import between the store and the manager module.
VALID_STATUSES = (
    "NOT_SUBSCRIBED",
    "SUBSCRIBE_REQUESTED",
    "SUBSCRIBED",
    "SUBSCRIBED_AND_PINNED",
    "PINNED_ONLY",
    "ACTIVE",
    "INACTIVE",
    "EXPIRED",
    "EXPIRING",
    "UNSUBSCRIBE_REQUESTED",
    "UNSUBSCRIBED",
    "ERROR",
)

EXPIRY_TYPES = ("PERMANENT", "SESSION", "TRADE", "DURATION", "ONE_SHOT")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def instrument_id(broker: Optional[str], exchange_segment: str, instrument_token: Any) -> str:
    """Canonical unique identity — broker + segment + token (never duplicated)."""
    b = (str(broker or DEFAULT_BROKER)).strip().lower() or DEFAULT_BROKER
    seg = str(exchange_segment or "").strip()
    tok = str(instrument_token or "").strip()
    return f"{b}|{seg}|{tok}"


def new_event_id() -> str:
    return f"sm_{uuid.uuid4().hex}"


def normalize_source(source: Optional[str]) -> str:
    s = str(source or "manual").strip() or "manual"
    name = s.lower().replace(" ", "-")
    return name if name in KNOWN_SOURCES else f"unknown:{name}"


async def ensure_indexes(db=None) -> None:
    """Create the canonical-collection indexes (idempotent; app startup)."""
    if db is None:
        db = get_db()
    coll = db[INSTRUMENTS_COLLECTION]
    await coll.create_index("_id")
    await coll.create_index("instrument_id", unique=True, background=True)
    await coll.create_index("broker", background=True)
    await coll.create_index("exchange_segment", background=True)
    await coll.create_index("instrument_token", background=True)
    await coll.create_index([("broker", 1), ("symbol", 1)], background=True)
    await coll.create_index("source", background=True)
    await coll.create_index("status", background=True)
    await coll.create_index("subscription_state", background=True)
    await coll.create_index("active", background=True)
    await coll.create_index("desired", background=True)
    await coll.create_index("pinned", background=True)
    await coll.create_index("expires_at", background=True)
    await coll.create_index("expiry_type", background=True)
    await coll.create_index([("active", 1), ("status", 1)], background=True)
    await coll.create_index([("expires_at", 1), ("status", 1)], background=True)
    await coll.create_index([("ts", -1)], background=True)
    await coll.create_index("updated_at", background=True)

    events = db[EVENTS_COLLECTION]
    await events.create_index([("ts", -1)], background=True)
    await events.create_index("event", background=True)
    await events.create_index("instrument_id", background=True)
    await events.create_index("event_type", background=True)
    await events.create_index([("instrument_id", 1), ("ts", -1)], background=True)
    await events.create_index("revision", background=True)

    revs = db[REVISIONS_COLLECTION]
    await revs.create_index("owner", unique=True, background=True)


async def load_instruments(db=None, broker: Optional[str] = None, active: Optional[bool] = None,
                           status: Optional[str] = None, source: Optional[str] = None,
                           desired: Optional[bool] = None) -> list[dict[str, Any]]:
    """Return canonical records (JSON-safe, Mongo `_id` stripped)."""
    if db is None:
        db = get_db()
    query: dict[str, Any] = {}
    if broker:
        query["broker"] = str(broker).strip().lower()
    if active is not None:
        query["active"] = bool(active)
    if desired is not None:
        query["desired"] = bool(desired)
    if status:
        query["status"] = status
    if source:
        query["source"] = normalize_source(source)
    docs = []
    try:
        cursor = db[INSTRUMENTS_COLLECTION].find(query).sort("_id", 1)
        async for doc in cursor:
            rec = dict(doc)
            rec.pop("_id", None)
            docs.append(rec)
    except Exception as exc:  # noqa: BLE001 - defensive: never crash the caller
        logger.warning("session_manager_instruments load failed: %s", exc)
    return docs


async def load_instrument(db=None, iid: Optional[str] = None, **key) -> Optional[dict[str, Any]]:
    """Return ONE canonical record (by instrument_id, or by broker/segment/token)."""
    if db is None:
        db = get_db()
    if not iid:
        iid = instrument_id(
            key.get("broker"), key.get("exchange_segment", ""), key.get("instrument_token", "")
        )
    try:
        doc = await db[INSTRUMENTS_COLLECTION].find_one({"instrument_id": iid})
    except Exception as exc:  # noqa: BLE001
        logger.warning("session_manager_instruments get failed: %s", exc)
        return None
    if doc is not None:
        doc.pop("_id", None)
    return doc


async def save_instrument(record: dict[str, Any], db=None) -> dict[str, Any]:
    """Upsert a canonical record. Returns the sanitized stored doc."""
    if db is None:
        db = get_db()
    iid = record.get("instrument_id")
    if not iid:
        iid = instrument_id(
            record.get("broker"),
            record.get("exchange_segment", ""),
            record.get("instrument_token", ""),
        )
        record["instrument_id"] = iid
    doc = {k: record.get(k) for k in CANONICAL_FIELDS}
    doc["instrument_id"] = iid
    doc["updated_at"] = record.get("updated_at") or _now_iso()
    try:
        await db[INSTRUMENTS_COLLECTION].replace_one(
            {"instrument_id": iid}, doc, upsert=True
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("session_manager_instruments save failed (%s): %s", iid, exc)
        raise
    return dict(doc)


async def delete_instrument(iid: str, db=None) -> bool:
    """Hard-delete a canonical record (purge path only — default is archive)."""
    if db is None:
        db = get_db()
    try:
        res = await db[INSTRUMENTS_COLLECTION].delete_one({"instrument_id": iid})
        return bool(res.deleted_count)
    except Exception as exc:  # noqa: BLE001
        logger.warning("session_manager_instruments delete failed (%s): %s", iid, exc)
        return False


async def record_event(event: dict[str, Any], db=None) -> None:
    """Append a lifecycle event to the ledger (best-effort, never raises)."""
    if db is None:
        db = get_db()
    doc = {
        "event_id": event.get("event_id") or new_event_id(),
        "ts": event.get("ts") or _now_iso(),
        "event": event.get("event") or "SESSION_INSTRUMENT_UPDATED",
        "event_type": event.get("event_type") or (event.get("event") or "SESSION_INSTRUMENT_UPDATED"),
        "instrument_id": event.get("instrument_id"),
        "broker": event.get("broker"),
        "exchange_segment": event.get("exchange_segment"),
        "instrument_token": event.get("instrument_token"),
        "symbol": event.get("symbol"),
        "source": event.get("source"),
        "revision": event.get("revision"),
        "message": event.get("message", ""),
        "state": event.get("state"),
        "meta": dict(event.get("meta") or {}),
    }
    try:
        await db[EVENTS_COLLECTION].insert_one(doc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("session_manager_events write failed: %s", exc)


async def load_events(db=None, limit: int = 200, instrument_id: Optional[str] = None,
                      since_revision: Optional[int] = None, event: Optional[str] = None) -> list[dict]:
    if db is None:
        db = get_db()
    query: dict[str, Any] = {}
    if instrument_id:
        query["instrument_id"] = instrument_id
    if since_revision is not None:
        query["revision"] = {"$gte": int(since_revision)}
    if event:
        query["event"] = event
    docs = []
    try:
        cursor = db[EVENTS_COLLECTION].find(query).sort("ts", -1).limit(limit)
        async for doc in cursor:
            doc.pop("_id", None)
            docs.append(doc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("session_manager_events load failed: %s", exc)
    return docs


async def next_revision(db=None, owner: str = "session_manager", initial: int = 0) -> int:
    """Atomically increment and return the next mono revision for ``owner``.

    All mutating writers share the counter so every event ordering in the
    ledger is consistent across producers.
    """
    if db is None:
        db = get_db()
    owner = owner or "session_manager"
    try:
        doc = await db[REVISIONS_COLLECTION].find_one_and_update(
            {"owner": owner},
            {"$setOnInsert": {"owner": owner, "initial": int(initial)},
             "$inc": {"revision": 1}},
            upsert=True,
            return_document=True,
        )
        return int((doc or {}).get("revision", 1))
    except Exception as exc:  # noqa: BLE001
        logger.warning("session_manager_revisions inc failed: %s", exc)
        return 0


async def read_revisions(db=None) -> dict[str, int]:
    """All owner revision counters, e.g. ``{"session_manager": 12}``."""
    if db is None:
        db = get_db()
    out: dict[str, int] = {}
    try:
        cursor = db[REVISIONS_COLLECTION].find({})
        async for doc in cursor:
            out[str(doc.get("owner") or "unknown")] = int(doc.get("revision", 0))
    except Exception as exc:  # noqa: BLE001
        logger.warning("session_manager_revisions read failed: %s", exc)
    return out