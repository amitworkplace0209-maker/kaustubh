"""Session Manager configuration — the small set of knobs the Session
Manager engine actually consumes.

Scope discipline: only keys the runtime truly reads are exposed
(``session_lifetime_seconds``, ``expiry_warning_seconds``,
``tick_active_window_seconds``). The browser can never persist arbitrary
keys: unknown keys raise, values are validated against a declared schema,
and MongoDB unavailability degrades to the honest built-in defaults —
never fabricated values.

Persistence follows the ``app_settings`` precedent but stays scoped to the
Session Manager:
  - one document per key in Mongo ``session_manager_config``
  - a thread-safe in-process cache backs the SYNC runtime accessors
    (``session_lifetime_seconds`` / ``expiry_warning_seconds`` /
    ``tick_active_window_seconds``) so the tick path never awaits Mongo
  - the cache is refreshed once at app startup (``refresh_config()``) and
    synchronously on every set/reset, so changes apply live
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Optional

_log = logging.getLogger("session_manager_config")

CONFIG_COLLECTION = "session_manager_config"
CACHE_SOURCE_DEFAULTS = "defaults"
CACHE_SOURCE_MONGO = "mongo"

DEFAULTS: dict[str, dict] = {
    "session_lifetime_seconds": {
        "value": 3600,
        "type": "number",
        "min": 60,
        "max": 86400,
        "step": 60,
        "category": "session",
        "description": "Manual session lifetime in seconds (applies to NEW sessions at login time).",
    },
    "expiry_warning_seconds": {
        "value": 900,
        "type": "number",
        "min": 60,
        "max": 3600,
        "step": 60,
        "category": "session",
        "description": "Horizon before an instrument's real expiry at which it is flagged EXPIRING.",
    },
    "tick_active_window_seconds": {
        "value": 60.0,
        "type": "number",
        "min": 5.0,
        "max": 600.0,
        "step": 5,
        "category": "feed",
        "description": "Window after the last validated feed tick during which a subscription counts as ACTIVE.",
    },
}

_cache: dict[str, Any] = {k: v["value"] for k, v in DEFAULTS.items()}
_cache_updated_at: Optional[float] = None
_cache_source: str = CACHE_SOURCE_DEFAULTS
_cache_lock = Lock()


def _get(key: str) -> Any:
    with _cache_lock:
        return _cache.get(key, DEFAULTS[key]["value"])


def _validate_key(key: str) -> None:
    if key not in DEFAULTS:
        raise ValueError(f"Unknown session config key: {key}")


def validate(key: str, value: Any) -> Any:
    """Validate one value against its declared schema; return the value."""
    _validate_key(key)
    defn = DEFAULTS[key]
    dtype = defn.get("type")
    if dtype == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"Config {key} must be a number")
        lo = defn.get("min")
        hi = defn.get("max")
        if lo is not None and value < lo:
            raise ValueError(f"Config {key} must be >= {lo}")
        if hi is not None and value > hi:
            raise ValueError(f"Config {key} must be <= {hi}")
        return value
    raise ValueError(f"Config {key} has an unsupported type: {dtype}")


def _apply_cache_set(key: str, value: Any) -> None:
    global _cache_updated_at, _cache_source
    with _cache_lock:
        _cache[key] = value
        _cache_updated_at = time.time()
        _cache_source = CACHE_SOURCE_MONGO


def _apply_cache_reset(key: Optional[str]) -> None:
    global _cache_updated_at, _cache_source
    with _cache_lock:
        if key is None:
            _cache.update({k: v["value"] for k, v in DEFAULTS.items()})
        else:
            _cache[key] = DEFAULTS[key]["value"]
        _cache_updated_at = time.time()
        _cache_source = CACHE_SOURCE_MONGO


# ----------------------------------------------------------------------
# Sync runtime accessors (never hit Mongo; read the cache)
# ----------------------------------------------------------------------
def session_lifetime_seconds() -> float:
    return float(_get("session_lifetime_seconds"))


def expiry_warning_seconds() -> float:
    return float(_get("expiry_warning_seconds"))


def tick_active_window_seconds() -> float:
    return float(_get("tick_active_window_seconds"))


# ----------------------------------------------------------------------
# Read / write / reset (async, Mongo-backed)
# ----------------------------------------------------------------------
def _now() -> datetime:
    return datetime.now(timezone.utc)


async def get_config() -> dict[str, dict]:
    """Effective config for every declared key.

    Each entry carries ``value`` (effective), ``default``, ``type``,
    ``min``/``max`` (declared), ``updatedAt`` and ``persisted`` — so the UI
    can render honest apply/persistence labels without client-side schema
    logic.
    """
    persisted: dict[str, dict] = {}
    try:
        from database.connection import get_db, is_mongo_connected
        if is_mongo_connected():
            db = get_db()
            async for doc in db[CONFIG_COLLECTION].find({}):
                key = doc.get("key")
                if key in DEFAULTS:
                    persisted[key] = doc
    except Exception as exc:  # noqa: BLE001 - mongodb down is not fatal
        _log.debug("session config read failed: %s", exc)

    out: dict[str, dict] = {}
    for key, defn in DEFAULTS.items():
        doc = persisted.get(key)
        out[key] = {
            "key": key,
            "value": doc["value"] if doc else defn["value"],
            "default": defn["value"],
            "type": defn["type"],
            "min": defn.get("min"),
            "max": defn.get("max"),
            "step": defn.get("step"),
            "category": defn["category"],
            "description": defn["description"],
            "updatedAt": doc.get("updatedAt") if doc else None,
            "persisted": bool(doc),
        }
    return out


async def set_config(patch: dict, updated_by: str = "manual") -> dict:
    """Validate + persist + live-apply a partial config patch."""
    if not isinstance(patch, dict) or not patch:
        raise ValueError("config patch must be a non-empty object")

    validated: dict[str, Any] = {}
    for key, value in patch.items():
        _validate_key(key)
        validated[key] = validate(key, value)

    try:
        from database.connection import get_db, is_mongo_connected
        if not is_mongo_connected():
            raise RuntimeError("mongodb unavailable")
        db = get_db()
        now = _now()
        for key, value in validated.items():
            doc = {
                "key": key,
                "value": value,
                "updatedAt": now,
                "updatedBy": str(updated_by),
            }
            await db[CONFIG_COLLECTION].update_one({"key": key}, {"$set": doc}, upsert=True)
            _apply_cache_set(key, value)
    except Exception as exc:  # noqa: BLE001
        _log.warning("session config persist failed: %s", exc)
        raise RuntimeError(f"could not persist session config: {exc}") from exc

    _record_event("CONFIG_UPDATED", f"{','.join(sorted(validated))}")
    _publish_engine_event("CONFIG_UPDATED", {"keys": sorted(validated), "values": validated})
    return await get_config()


async def reset_config(key: Optional[str] = None, _updated_by: str = "manual") -> dict:
    """Reset one key (or all) to built-in defaults."""
    if key is not None:
        _validate_key(key)
    try:
        from database.connection import get_db, is_mongo_connected
        if is_mongo_connected():
            db = get_db()
            if key is None:
                await db[CONFIG_COLLECTION].delete_many({})
            else:
                await db[CONFIG_COLLECTION].delete_one({"key": key})
    except Exception as exc:  # noqa: BLE001
        _log.debug("session config reset failed: %s", exc)
    _apply_cache_reset(key)
    _record_event("CONFIG_RESET", f"all" if key is None else key)
    return await get_config()


async def refresh_config() -> dict:
    """Load persisted values into the in-process cache (app startup).

    Honest behavior: when MongoDB is down the cache stays on defaults and
    ``state()`` reports ``cacheSource: 'defaults'`` so the UI never mislabels
    a fallback as a persisted value.
    """
    global _cache_updated_at, _cache_source
    try:
        from database.connection import get_db, is_mongo_connected
        if is_mongo_connected():
            db = get_db()
            async for doc in db[CONFIG_COLLECTION].find({}):
                key = doc.get("key")
                if key in DEFAULTS:
                    _apply_cache_set(key, doc.get("value", DEFAULTS[key]["value"]))
    except Exception as exc:  # noqa: BLE001
        _log.debug("session config refresh failed: %s", exc)
    return await state()


async def state() -> dict:
    """Diagnostics snapshot: effective cache, source, declared schema."""
    with _cache_lock:
        effective = dict(_cache)
        cache_updated_at = _cache_updated_at
        cache_source = _cache_source
    config = await get_config()
    return {
        "effective": {k: config[k]["value"] for k in config},
        "defaults": {k: v["value"] for k, v in DEFAULTS.items()},
        "declared": {k: DEFAULTS[k] for k in DEFAULTS},
        "persisted": {k: config[k]["persisted"] for k in config},
        "cacheSource": cache_source,
        "cacheUpdatedAt": cache_updated_at,
        "collection": CONFIG_COLLECTION,
    }


def _record_event(event: str, detail: str) -> None:
    try:
        from services.event_history import record_event
        record_event(
            "session", event, "info", detail,
            {"component": "session_manager_config", "severity": "info", "details": detail},
        )
    except Exception:  # noqa: BLE001
        _log.debug("config event history unavailable")


def _publish_engine_event(event_type: str, data: dict) -> None:
    try:
        import asyncio
        from services.engine_event_bus import get_event_bus, EngineEvent

        async def _p():
            try:
                await get_event_bus().publish(EngineEvent(
                    event_type=event_type, source_engine="session_manager", data=data,
                ))
            except Exception:  # noqa: BLE001
                _log.debug("config engine event publish failed")
        try:
            asyncio.ensure_future(_p())
        except RuntimeError:
            _log.debug("config engine event skipped (no running loop)")
    except Exception:  # noqa: BLE001
        _log.debug("config engine event unavailable")