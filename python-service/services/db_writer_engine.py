"""DB Writer Engine â€” persistence-layer engine (tick + audit pipelines).

Adapts the already-wired persistence pipelines into the Engine Registry so
the Phase 3 Service Control Center can observe and control the persistence
path as a first-class engine:

- Tick pipeline  (``services.tick_buffer``): bounded in-memory buffer ->
  batched MongoDB bulk writes, backpressure via hard cap, no re-queue of
  failed batches, graceful final flush on shutdown, real throughput/latency
  metrics.
- Audit pipeline (``services.storage_engine``): bounded write queue -> batched
  ``insert_many`` for sessions/instruments/audit/notifications.

This engine does NOT re-implement any write loop and never fabricates data.
It reflects the real state of those pipelines, maps them onto EngineBase
lifecycle/health/metrics, and provides ``flush()`` for operations/tests.

Design per ``docs/engines/db_writer_engine_detailed.md``: producer -> bounded
buffer -> engine -> DB; batching; backpressure; retry policy (failed batches
are counted as write errors, never re-queued, so a down database cannot grow
memory without bound); graceful shutdown with final flush; per-instrument
data isolation is handled upstream (WebSocket Engine dedup) and the writer
never mixes instruments (each tick document is stored as received).

Data-loss accounting (core correctness property):
    RECEIVED = DUPLICATES + INVALID + ACCEPTED
    ACCEPTED = WRITTEN + WRITE_FAILED + PENDING
"""

from __future__ import annotations

import logging
import os
import time
import asyncio
from collections import deque
from typing import Any, Optional

from core.engines.engine_config import ConfigField, read_only
from core.engines.engine_base import (
    EngineBase,
    EngineHealth,
    EngineCategory,
)
from services.runtime_settings import rt_bool, rt_int  # rt_int backs the engine settings summary

logger = logging.getLogger("app.db_writer_engine")

# Tick source classification (backend-owned, never frontend-decided)
class TickSource:
    PERSONAL_NO_EXPIRY = "PERSONAL_NO_EXPIRY"
    #: "1-day" is the session/subscription classification for an expiring
    #: personal subscription â€” it is NOT a MongoDB TTL (no TTL index exists;
    #: expiry is application-managed, see PENDING-001).
    PERSONAL_ONE_DAY = "PERSONAL_ONE_DAY"
    MARKET_WATCH_ONE_DAY = "MARKET_WATCH_ONE_DAY"
    UNKNOWN = "UNKNOWN"

    # Legacy aliases. These share the canonical VALUE (not a second name) so
    # existing callers, stored docs and tests that compare the old strings keep
    # working without a second classification system.
    PERSONAL_EXPIRY = PERSONAL_ONE_DAY
    MARKET_WATCH = MARKET_WATCH_ONE_DAY


#: The three INDEPENDENT persistence permissions, each mapped to the runtime
#: settings key that owns it. The DB Write Engine is the sole authority for
#: these; no other engine and not the frontend may decide them.
#:
#: Key names are pre-existing in ``settings_service.DEFAULTS``, which already
#: carried an authoritative default of ``False`` (OFF) for all three â€” no
#: default is invented here (task Â§5).
TICK_PERSISTENCE_PERMISSIONS: dict[str, str] = {
    "personalNoExpiry": "dbw_personal_no_expiry_ticks",
    "personalOneDay": "dbw_personal_expiry_ticks",
    "marketWatchOneDay": "dbw_market_watch_ticks",
}

#: Master kill-switch setting key. Master OFF blocks EVERY tick write even if
#: individual permissions are ON; master ON (default) lets the three
#: permissions decide per stream. Resolved live on every SAVE/DROP decision.
TICK_PERSISTENCE_MASTER_SETTING = "dbw_ticks_enabled"

#: API name for the master switch in the tick-persistence PUT body.
TICK_PERSISTENCE_MASTER_NAME = "master"


def tick_master_enabled() -> bool:
    """Effective master switch (default ON so existing behaviour is unchanged)."""
    return rt_bool(TICK_PERSISTENCE_MASTER_SETTING, True)

#: Human-facing labels for the settings UI / API.
#:
#: Encoding note: these three strings shipped as mojibake (``â€”``, a UTF-8
#: em dash read as CP1252) and were republished verbatim by the Data Center DB
#: Writer plane, so the damage was user-visible. The separator is now a plain
#: ASCII hyphen so the label can never be corrupted again by an encoding
#: round-trip. Only the three user-facing values changed.
TICK_PERSISTENCE_LABELS: dict[str, str] = {
    "personalNoExpiry": "Personal Stocks - No Expiry",
    "personalOneDay": "Personal Stocks - 1-Day Expiry",
    "marketWatchOneDay": "Market Watch Stocks - 1-Day",
}

#: Classification -> permission name. A classification absent from this map is
#: never persisted, so adding a new TickSource cannot silently persist data.
_CLASSIFICATION_TO_PERMISSION: dict[str, str] = {
    TickSource.PERSONAL_NO_EXPIRY: "personalNoExpiry",
    TickSource.PERSONAL_ONE_DAY: "personalOneDay",
    TickSource.MARKET_WATCH_ONE_DAY: "marketWatchOneDay",
}

#: ---------------------------------------------------------------------- #
# STORAGE CAP  (operator-configured, never hard-coded)                     #
# ---------------------------------------------------------------------- #
#: A storage cap forces a tick stream OFF regardless of its permission. It is
#: an operational brake, not a save rule: the permission keys above remain the
#: authority for whether a stream MAY be persisted, and the cap only says
#: whether storage is currently available for it.
#:
#: Resolution order for every cap (same contract as every other setting in this
#: project â€” runtime setting, then environment, then "not capped"):
#:     1. runtime setting ``app_settings`` (writable via the settings service)
#:     2. environment variable ``DBW_STORAGE_CAP_<PERMISSION>``
#:     3. NOT CAPPED
#:
#: Previously this was a module-level literal (``{"personalNoExpiry": True,
#: "personalOneDay": False, "marketWatchOneDay": False}``) that silently
#: overrode the operator's settings. That literal is what made the Market Watch
#: stream unpersistable no matter what the settings said, and it is gone: a
#: decision now always traces to configuration the operator can read and change.
#:
#: HONEST REPORTING
#: Because a cap changes the effective value, the read surface reports the
#: EFFECTIVE value plus a ``hardCapped`` flag, and the write path refuses to
#: enable a capped stream instead of accepting a toggle that would do nothing.
TICK_PERSISTENCE_CAP_SETTINGS: dict[str, str] = {
    "personalNoExpiry": "dbw_storage_cap_personal_no_expiry",
    "personalOneDay": "dbw_storage_cap_personal_one_day",
    "marketWatchOneDay": "dbw_storage_cap_market_watch_one_day",
}

TICK_PERSISTENCE_CAP_ENV: dict[str, str] = {
    "personalNoExpiry": "DBW_STORAGE_CAP_PERSONAL_NO_EXPIRY",
    "personalOneDay": "DBW_STORAGE_CAP_PERSONAL_ONE_DAY",
    "marketWatchOneDay": "DBW_STORAGE_CAP_MARKET_WATCH_ONE_DAY",
}

#: Operators can explain a cap in one line (surfaced verbatim in the API and the
#: DB Writer panel) instead of the reason being buried in a comment.
TICK_PERSISTENCE_CAP_REASON_SETTING = "dbw_storage_cap_reason"

_TRUE_TOKENS = frozenset({"1", "true", "yes", "on"})
_FALSE_TOKENS = frozenset({"0", "false", "no", "off"})


def _as_bool(value: Any) -> Optional[bool]:
    """Coerce a settings / environment value to a bool.

    ``None`` means "not set", which is what lets the tiers below be ordered
    honestly: a stored ``false`` must be able to switch OFF a cap that the
    environment turns on, so an explicit false cannot be treated as "absent".
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if not text:
        return None
    if text in _TRUE_TOKENS:
        return True
    if text in _FALSE_TOKENS:
        return False
    return None


def _rt_setting(key: str) -> Any:
    """Read a runtime setting through the settings module.

    Resolved by attribute rather than captured at import so the value is always
    the live cached setting, exactly as :func:`services.runtime_settings.rt_bool`
    sees it.
    """
    from services import runtime_settings

    return runtime_settings.get_runtime_setting(key)


def storage_caps() -> dict[str, bool]:
    """Effective storage cap per permission. Never hard-coded, never guessed."""
    caps: dict[str, bool] = {}
    for permission in TICK_PERSISTENCE_PERMISSIONS:
        raw = _as_bool(_rt_setting(TICK_PERSISTENCE_CAP_SETTINGS[permission]))
        if raw is None:
            raw = _as_bool(os.environ.get(TICK_PERSISTENCE_CAP_ENV[permission]))
        caps[permission] = bool(raw)
    return caps


def storage_cap_reason() -> Optional[str]:
    """Operator-supplied explanation for the active cap, if any."""
    value = _rt_setting(TICK_PERSISTENCE_CAP_REASON_SETTING)
    if isinstance(value, str) and value.strip():
        return value.strip()
    env = os.environ.get("DBW_STORAGE_CAP_REASON")
    if env and env.strip():
        return env.strip()
    return None


def is_tick_persistence_hard_capped(permission: str) -> bool:
    """True when ``permission`` is currently overridden by the storage cap."""
    return bool(storage_caps().get(permission))


#: ---------------------------------------------------------------------- #
# TICK SOURCE / CATEGORY VOCABULARY                                        #
# ---------------------------------------------------------------------- #
#: The stock-source / category names are the project's OWN registry vocabulary
#: (``services.session.session_manager`` is the single active-stock registry).
#: They are imported, never re-declared, so a rename in the registry cannot
#: leave this engine matching on a stale string.
#: - ``SOURCE_DAILY_UNIVERSE`` -> the Market Watch current-day fusion universe
#:   (day-scoped validity, one-day lifecycle)
#: - ``stocks_db``             -> the discovered / scraped stock universe
#:   (permanent, no expiry)
#: - ``manual`` / ``pin`` / ``broker_ack`` -> personal subscription intents,
#:   classified by their own recorded expiry metadata
#: Importing fails soft to the empty tuple so this module still imports if the
#: session package is unavailable; matching then falls back to the substring
#: rule in :meth:`_category_for_source`, which is strictly wider.
def _registry_source_names() -> tuple[str, str, str, str, str]:
    try:
        from services.session.session_manager import SOURCE_DAILY_UNIVERSE
    except Exception:  # pragma: no cover - defensive
        return ("", "stocks_db", "manual", "pin", "broker_ack")
    return (
        str(SOURCE_DAILY_UNIVERSE),
        "stocks_db",
        "manual",
        "pin",
        "broker_ack",
    )


class DropReason:
    """Canonical, machine-readable reasons a tick was not persisted.

    These are the vocabulary the status surface, the API and the UI report.
    They are UPPER_SNAKE_CASE constants (never ad-hoc strings) so a reader can
    group them, and each is a real observed cause â€” none is ever inferred.
    """

    PERMISSION_GRANTED = "PERMISSION_GRANTED"
    NOT_ALLOWED_SOURCE = "NOT_ALLOWED_SOURCE"
    EXPIRED_STOCK = "EXPIRED_STOCK"
    INACTIVE_STOCK = "INACTIVE_STOCK"
    INVALID_TICK = "INVALID_TICK"
    PERSISTENCE_DISABLED = "PERSISTENCE_DISABLED"
    STORAGE_CAPPED = "STORAGE_CAPPED"
    DUPLICATE = "DUPLICATE"
    QUEUE_REJECTED = "QUEUE_REJECTED"
    DATABASE_ERROR = "DATABASE_ERROR"


#: Every reason this engine can emit, so the status surface can report a stable,
#: complete set instead of only the reasons that happen to have fired.
DROP_REASONS: tuple[str, ...] = (
    DropReason.PERMISSION_GRANTED,
    DropReason.NOT_ALLOWED_SOURCE,
    DropReason.EXPIRED_STOCK,
    DropReason.INACTIVE_STOCK,
    DropReason.INVALID_TICK,
    DropReason.PERSISTENCE_DISABLED,
    DropReason.STORAGE_CAPPED,
    DropReason.DUPLICATE,
    DropReason.QUEUE_REJECTED,
    DropReason.DATABASE_ERROR,
)

#: Legacy lowercase reasons kept for API/UI compatibility. ``persist`` is the
#: legacy boolean; ``reason`` stays the same string callers already match on.
#: The canonical code is always available as ``reasonCode``.
_LEGACY_REASONS: dict[str, str] = {
    DropReason.PERMISSION_GRANTED: "permission_granted",
    DropReason.NOT_ALLOWED_SOURCE: "unknown_source",
    DropReason.EXPIRED_STOCK: "expired_stock",
    DropReason.INACTIVE_STOCK: "inactive_stock",
    DropReason.INVALID_TICK: "invalid_tick",
    DropReason.PERSISTENCE_DISABLED: "permission_disabled",
    DropReason.STORAGE_CAPPED: "blocked_by_storage_cap",
    DropReason.DUPLICATE: "duplicate",
    DropReason.QUEUE_REJECTED: "queue_rejected",
    DropReason.DATABASE_ERROR: "database_error",
}


class TickPersistenceUnavailable(RuntimeError):
    """The settings store could not be reached while writing a permission.

    Distinct from :class:`ValueError` (a bad request) so the API can answer
    "storage unavailable" rather than surfacing a 500 that reads as a bug.
    """

#: Market Watch timeframe -> candle collection (doc Â§10).
CANDLE_COLLECTIONS: dict[str, str] = {
    "1m": "market_candles_1m",
    "2m": "market_candles_2m",
    "5m": "market_candles_5m",
    "10m": "market_candles_10m",
    "30m": "market_candles_30m",
}


class DBWriterEngine(EngineBase):
    engine_id = "db_writer_engine"
    engine_name = "DB Writer Engine"
    engine_category = EngineCategory.STORAGE
    engine_version = "1.0.0"

    config_fields = (
        ConfigField(
            key="flush_interval_ms",
            label="Flush Interval",
            summary="flushIntervalMs",
            type="number",
            min=100,
            max=60000,
            unit="ms",
            group="Pipeline",
            help="How often the tick buffer is flushed to MongoDB.",
        ),
        ConfigField(
            key="buffer_size",
            label="Buffer Capacity",
            summary="bufferMaxSize",
            type="number",
            min=100,
            max=1000000,
            group="Pipeline",
            help="Ticks held in memory before a flush is forced.",
        ),
        ConfigField(
            key="bulk_insert_size",
            label="Bulk Insert Size",
            summary="bulkInsertSize",
            type="number",
            min=1,
            max=100000,
            group="Pipeline",
        ),
        # ---- Tick persistence on/off --------------------------------------
        # These two switches already gated Market Watch tick persistence
        # (they were in the settings store but exposed on no engine page, so
        # there was nowhere to turn them on). Declaring them here gives the DB
        # Writer a real settings surface:
        #   dbw_ticks_enabled         — master switch; OFF blocks every stream
        #   dbw_market_watch_ticks    — Market Watch's own permission
        ConfigField(
            key="dbw_ticks_enabled",
            label="Persist ticks (master)",
            summary="ticksEnabled",
            type="boolean",
            group="Tick persistence",
            help="Master switch. OFF blocks tick persistence for EVERY stream.",
        ),
        ConfigField(
            key="dbw_market_watch_ticks",
            label="Persist Market Watch ticks",
            summary="marketWatchTicksEnabled",
            type="boolean",
            group="Tick persistence",
            help="Save Market Watch's validated ticks to MongoDB. Only applies while the master switch above is ON.",
        ),
        ConfigField(
            key="dbw_storage_cap_market_watch_one_day",
            label="Market Watch tick cap",
            summary="storageCapMarketWatchOneDay",
            type="number",
            min=0,
            max=1000000,
            unit="docs",
            group="Tick persistence",
            help="Hard ceiling on buffered Market Watch tick documents. 0 disables the cap.",
        ),
        read_only("bufferHardCap", "Buffer Hard Cap"),
        read_only("collection", "Tick Collection"),
        read_only("marketWatchCollections", "Market Watch Collections"),
        read_only("mode", "Write Mode"),
        read_only("tickPersistencePermissions", "Tick Persistence Permissions"),
        read_only("storageCaps", "Storage Caps"),
    )

    # Dedup cache: bounded, TTL-based. Stores (instrumentToken, sequenceNumber)
    # pairs seen in the current window. Simple and memory-safe for Phase A.
    _DEDUP_MAXLEN = 50000
    _DEDUP_TTL_SEC = 300.0  # 5 minutes

    def __init__(self) -> None:
        super().__init__()
        self._last_write_errors = 0
        self._last_total_written = 0
        self._last_flush_result: dict[str, Any] | None = None
        # Ingest counters for the Connection Manager â†’ DB Writer consumer path.
        self._ingested = 0
        self._rejected = 0
        # Market Watch document ingest counters (candles/decisions/report).
        self._mw_accepted = 0
        self._mw_rejected = 0
        self._last_mw_write_errors = 0
        # Deduplication tracking
        self._duplicates = 0
        self._dedup_cache: deque[tuple[str, int, float]] = deque(maxlen=self._DEDUP_MAXLEN)  # (token, seq, expiry_mono)

        # Tick persistence policy counters (by source)
        self._personal_no_expiry_accepted = 0
        self._personal_expiry_accepted = 0
        self._market_watch_accepted = 0
        self._personal_no_expiry_skipped = 0
        self._personal_expiry_skipped = 0
        self._market_watch_skipped = 0
        self._unknown_source_skipped = 0
        self._overlapping_sources_deduped = 0

        # Aggregated SAVE/DROP diagnostics. Counters, not per-tick log lines:
        # a busy feed must not flood the log, but every drop must still be
        # explainable from the status surface.
        self._reason_counts: dict[str, int] = {code: 0 for code in DROP_REASONS}
        self._rejection_log_counts: dict[str, int] = {}
        self._queue_rejected = 0
        self._db_errors = 0
        # Tick records REMOVED by the DB Writer's own duplicate cleanup. Kept
        # apart from the SAVE/DROP reasons: a removal is not a drop decision.
        self._duplicates_removed = 0

        # Active-stock registry cache. The decision needs source + validity
        # metadata for every tick, but rebuilding a whole Session Manager
        # snapshot per tick is O(universe) work on the hot path. The registry
        # is a single authoritative structure, so it is snapshotted here on a
        # short TTL and reused; nothing is duplicated, only memoised.
        self._registry_cache: dict[str, dict[str, Any]] = {}
        self._registry_cached_at: float = 0.0
        self._registry_cache_revision: Optional[int] = None
        self._registry_refreshes: int = 0
        self._registry_cache_ttl: float = float(
            os.environ.get("DBW_REGISTRY_CACHE_TTL_MS", "1000") or 1000
        ) / 1000.0
        self._trading_date_cache: tuple[str, float] = ("", 0.0)
        # The most recent real SAVE/DROP decision (the last tick evaluated on
        # the hot path). Bounded to ONE row in memory; the aggregated reasons
        # carry the history, this only names the latest outcome with its
        # symbol/token so the UI can show what literally just happened.
        self._last_decision: dict[str, Any] | None = None

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def _on_start(self) -> None:
        # tick_buffer.start() is idempotent: it refuses to spawn a second
        # flush loop if one is already running (e.g. app.py bootstrap).
        from services import tick_buffer

        await tick_buffer.start()

        # Market Watch document buffer (candles, block-ledger decisions, EOD
        # report) is owned by the DB Writer too â€” Market Watch never writes to
        # MongoDB itself and there is still only ONE database pipeline.
        from services import market_watch_doc_buffer

        try:
            await market_watch_doc_buffer.start()
        except Exception as exc:
            logger.warning("[DB-WRITER] Market Watch document buffer not started: %s", exc)

        self.set_dependencies(["websocket_engine", "connection_manager"])
        self.refresh_config_summary()
        self._refresh_metrics()
        logger.info("[DB-WRITER] engine started (tick pipeline attached)")
        self._warn_about_uncapped_streams()
        self.record_event()

    def refresh_config_summary(self) -> None:
        """Re-derive the published settings summary from LIVE values.

        Every switch on this page is resolved from the settings store on each
        tick decision (``_persistence_enabled_for_source``), so there is nothing
        here that needs a restart. Without this override the engine would keep
        publishing its start-time snapshot and the UI would honestly but
        unhelpfully label a switch that already took effect as "pending
        restart".
        """
        try:
            # Imported here rather than at module scope to match how the rest of
            # this engine reaches them (lazily, so importing this module never
            # drags the tick buffer or the document buffer in).
            from services import tick_buffer, market_watch_doc_buffer

            self.set_config_summary({
                "flushIntervalMs": tick_buffer.r_flush_interval_ms(),
                "bufferMaxSize": tick_buffer.r_buffer_max(),
                "bulkInsertSize": tick_buffer.r_bulk_insert(),
                "bufferHardCap": int(tick_buffer._BUFFER_HARD_CAP),
                "collection": "ticks",
                "marketWatchCollections": sorted(market_watch_doc_buffer.COLLECTIONS.keys()),
                "mode": "batched_bulk_write",
                "tickPersistencePermissions": {
                    name: rt_bool(key, False)
                    for name, key in TICK_PERSISTENCE_PERMISSIONS.items()
                },
                "tickPersistenceMaster": rt_bool(TICK_PERSISTENCE_MASTER_SETTING, True),
                "storageCaps": storage_caps(),
                "ticksEnabled": rt_bool(TICK_PERSISTENCE_MASTER_SETTING, True),
                "marketWatchTicksEnabled": rt_bool(
                    TICK_PERSISTENCE_PERMISSIONS.get("marketWatchOneDay", ""), False,
                ),
                "storageCapMarketWatchOneDay": rt_int(
                    TICK_PERSISTENCE_CAP_SETTINGS.get("marketWatchOneDay", ""), 0,
                ),
            })
        except Exception as exc:
            self.record_error("CONFIG_SUMMARY_FAILED", str(exc))
            logger.warning("[DB-WRITER] config summary refresh skipped: %s", exc)

    def _warn_about_uncapped_streams(self) -> None:
        """Say out loud when a tick stream is ON with no storage cap.

        Caps default to OFF, which is correct: the DB Writer never silently
        truncates data, and an operator must choose to stop a stream. The
        consequence is that a deployment can enable a tick permission and write
        append-only ticks to MongoDB with no retention policy and no cap. That
        is exactly why the storage risk (R-45) stays open, so it is raised as a
        startup warning instead of being discovered when the cluster fills.
        """
        caps = storage_caps()
        for permission, setting_key in TICK_PERSISTENCE_CAP_SETTINGS.items():
            source = next(
                (c for c, p in _CLASSIFICATION_TO_PERMISSION.items() if p == permission), None
            )
            if source is None or not self._persistence_enabled_for_source(source):
                continue
            if caps.get(permission):
                continue
            logger.warning(
                "[DB-WRITER] %s is ENABLED and UNCAPPED ('%s' is off). Its tick writes are "
                "append-only with no retention policy, so they can exhaust the database. Provision "
                "storage, add a retention policy, or set '%s' to true to stop the stream.",
                permission,
                setting_key,
                setting_key,
            )

    async def _on_stop(self) -> None:
        # Graceful shutdown: cancel the flush loops then do a final flush so
        # no buffered ticks or Market Watch documents are lost on restart.
        from services import tick_buffer

        await tick_buffer.stop()
        try:
            from services import market_watch_doc_buffer

            await market_watch_doc_buffer.stop()
        except Exception as exc:
            logger.warning("[DB-WRITER] Market Watch document buffer stop error: %s", exc)
        self._refresh_metrics()
        logger.info("[DB-WRITER] engine stopped (tick pipeline final flush done)")

    # ------------------------------------------------------------------ #
    # Health
    # ------------------------------------------------------------------ #
    async def _on_health_check(self) -> EngineHealth:
        try:
            from services import tick_buffer
            from services.runtime_settings import rt_bool

            if not rt_bool("ds_collection_enabled", True):
                self._set_health(EngineHealth.UNKNOWN, "data collection disabled")
                return self.health

            stats = tick_buffer.stats()
            if stats.get("pipelineRunning"):
                written = int(stats.get("totalWritten", 0))
                errors = int(stats.get("totalWriteErrors", 0))
                if errors > self._last_write_errors:
                    self._db_errors += errors - self._last_write_errors
                    self._count_reason(DropReason.DATABASE_ERROR, errors - self._last_write_errors)
                    self._set_health(
                        EngineHealth.DEGRADED,
                        f"write errors ({errors - self._last_write_errors} since last check)",
                    )
                else:
                    self._set_health(
                        EngineHealth.HEALTHY,
                        f"pipeline running, {stats.get('bufferLength', 0)} buffered",
                    )
            else:
                # Pipeline intentionally not running is only unhealthy when it
                # should be; report as degraded so the control center notices.
                self._set_health(EngineHealth.DEGRADED, "tick pipeline not running")
            self.heartbeat()
            await self._market_watch_document_health()
            return self.health
        except Exception as exc:
            self.record_error("health_check_error", str(exc))
            self._set_health(EngineHealth.UNHEALTHY, str(exc))
            return self.health

    # ------------------------------------------------------------------ #
    # Market Watch document health
    # ------------------------------------------------------------------ #
    async def _market_watch_document_health(self) -> None:
        """Fold Market Watch document write errors into the engine health.

        Runs as part of the tick health check so a failing candle/decision
        write is visible in the control center instead of only in the log.
        """
        try:
            from services import market_watch_doc_buffer

            mw = market_watch_doc_buffer.stats()
            errors = int(mw.get("totalWriteErrors", 0) or 0)
            if errors > self._last_mw_write_errors:
                self._set_health(
                    EngineHealth.DEGRADED,
                    f"market watch document write errors ({errors - self._last_mw_write_errors} since last check)",
                )
            self._last_mw_write_errors = errors
        except Exception:
            pass

    # ------------------------------------------------------------------ #
    # ------------------------------------------------------------------ #
    # Active stock registry (single authoritative source, memoised)
    # ------------------------------------------------------------------ #
    @staticmethod
    def _tick_token(tick: dict[str, Any]) -> str:
        return str(
            tick.get("instrumentToken")
            or tick.get("instrument_token")
            or tick.get("token")
            or ""
        )

    def _active_registry(self, *, force: bool = False) -> dict[str, dict[str, Any]]:
        """Token -> registry record, from the Session Manager (the one registry).

        This is a *cache*, not a second registry. The Session Manager remains
        the only place stock identity, source, validity and subscription state
        live; this only avoids rebuilding its full snapshot once per tick on the
        hot path.

        Validity is checked against TWO things, so a cache can never serve a
        stale answer:

        1. the Session Manager's ``subs_revision``, which bumps on every
           subscription-registry mutation — a subscribe, unsubscribe or expiry
           is therefore honoured on the very next tick rather than after a
           delay, at O(1) cost and without rebuilding the snapshot; and
        2. a short wall-clock TTL (``DBW_REGISTRY_CACHE_TTL_MS``, default 1s),
           which is the safety net for a change that does not bump the counter
           (e.g. per-tick validation updates).

        A negative result is cached too: an unknown token must not trigger a
        fresh snapshot for every subsequent tick of the same instrument.
        """
        now = time.monotonic()
        revision = self._registry_revision()
        fresh = (now - self._registry_cached_at) < self._registry_cache_ttl
        if not force and fresh and revision == self._registry_cache_revision:
            return self._registry_cache
        try:
            from services.session.session_manager import session_manager

            # The registry is the Session Manager's raw subscription state
            # (token -> record). ``snapshot()`` does not carry it and
            # ``subscription_snapshot()`` loses the numeric ``expires_at`` and
            # the ``market_date`` day scope, so the DB Writer reads the raw
            # records via ``active_registry()``. A missing/empty registry must
            # NOT masquerade as "all ticks are unknown", which is exactly what
            # happened when the wrong (empty) key was read and every tick was
            # rejected as an unknown source.
            instruments = session_manager.active_registry()
        except Exception as exc:
            # A failed read must NOT be cached as "the registry is empty": that
            # would turn a transient snapshot error into a silent drop storm.
            self.record_error("registry_snapshot_error", str(exc))
            return self._registry_cache
        cache = {str(token): rec for token, rec in instruments.items() if isinstance(rec, dict)}
        self._registry_cache = cache
        self._registry_cached_at = now
        self._registry_cache_revision = revision
        self._registry_refreshes += 1
        return cache

    @staticmethod
    def _registry_revision() -> Optional[int]:
        """O(1) read of the registry mutation counter, or None if unavailable."""
        try:
            from services.session.session_manager import session_manager

            revision = session_manager.subs_revision
        except Exception:
            return None
        return revision if isinstance(revision, int) else None

    def invalidate_registry_cache(self) -> None:
        """Force the next decision to re-read the active stock registry."""
        self._registry_cached_at = 0.0
        self._registry_cache_revision = None

    def _registry_record(self, token: str) -> Optional[dict[str, Any]]:
        return self._active_registry().get(str(token))

    def _current_trading_date(self) -> str:
        """Authoritative IST trading date, memoised for a second.

        Validity comparison needs "today", and the calendar is a pure function
        of the clock, so caching it for a second costs nothing in correctness.
        """
        value, at = self._trading_date_cache
        now = time.monotonic()
        if value and (now - at) < 1.0:
            return value
        try:
            from services import market_calendar

            value = str(market_calendar.snapshot().get("market_date") or "")
        except Exception:
            value = ""
        self._trading_date_cache = (value, now)
        return value

    # ------------------------------------------------------------------ #
    # Source -> category (project registry vocabulary, never hard-coded)
    # ------------------------------------------------------------------ #
    def _category_for_source(self, source: str) -> Optional[str]:
        """Map ONE registry source name to a tick category.

        The names come from the project's own source registry vocabulary, so a
        new source is recognised here by name rather than by a hard-coded stock
        or symbol list. A source with no mapping returns ``None`` and is never
        persisted, so adding a source cannot silently start writing ticks.
        """
        name = str(source or "").strip()
        if not name:
            return None
        daily, stocks_db, manual, pin, broker_ack = _registry_source_names()

        if daily and name == daily:
            return TickSource.MARKET_WATCH_ONE_DAY
        if name == stocks_db:
            # The discovered/scraped stock universe: registered without an
            # expiry, so its category is decided by the record's own metadata
            # in _classifications_for_record (not assumed here).
            return TickSource.PERSONAL_NO_EXPIRY
        if name in {manual, pin, broker_ack}:
            return TickSource.PERSONAL_NO_EXPIRY
        # Backwards-compatible widening for any source that already carried the
        # Market Watch marker before the constant was centralised.
        if "market_watch" in name.lower():
            return TickSource.MARKET_WATCH_ONE_DAY
        return None

    @staticmethod
    def _is_permanent(record: dict[str, Any]) -> bool:
        """True when the registry record has no expiry (permanent subscription).

        Reads the project's own expiry metadata: ``expiry_type`` / ``expiry_label``
        / ``expires_at`` / ``valid_until``. No value is invented â€” a record with
        no expiry metadata at all is treated as permanent, which is exactly what
        the Session Manager records for the discovered stock universe.
        """
        expiry_type = str(record.get("expiry_type") or record.get("expiryType") or "").strip().upper()
        if expiry_type and expiry_type not in {"PERMANENT", "NONE", ""}:
            return False
        for key in ("expires_at", "expiresAt", "valid_until", "validUntil", "expiry_at"):
            raw = record.get(key)
            if raw is None or raw == "":
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            # 0 is the project's explicit "no expiry" sentinel.
            if value != 0:
                return False
        return True

    def _classifications_for_record(self, record: dict[str, Any]) -> tuple[str, ...]:
        """Every tick category that applies to one registry record."""
        sources = record.get("sources") or ([record.get("source")] if record.get("source") else [])
        found: list[str] = []
        personal = False
        for source in sources:
            category = self._category_for_source(source)
            if category is None:
                continue
            if category == TickSource.MARKET_WATCH_ONE_DAY:
                if TickSource.MARKET_WATCH_ONE_DAY not in found:
                    found.append(TickSource.MARKET_WATCH_ONE_DAY)
            else:
                personal = True
        if personal:
            # Split the personal claim by the record's real expiry metadata.
            category = (
                TickSource.PERSONAL_NO_EXPIRY
                if self._is_permanent(record)
                else TickSource.PERSONAL_ONE_DAY
            )
            if category not in found:
                found.append(category)
        return tuple(found)

    def _get_tick_classifications(self, tick: dict[str, Any]) -> tuple[str, ...]:
        """Every classification that applies to this tick.

        A tick can legitimately satisfy more than one: an instrument the user
        subscribed to personally that is also in the Market Watch universe
        matches BOTH a personal classification and ``MARKET_WATCH_ONE_DAY``.
        Returning the full set (rather than short-circuiting on the first
        match) is what makes "persist at most once" enforceable â€” the caller
        evaluates every applicable permission but writes a single document.

        Unknown source returns an empty tuple, which is never eligible.
        """
        token = self._tick_token(tick)
        if not token:
            return ()
        record = self._registry_record(token)
        if not record:
            return ()
        return self._classifications_for_record(record)

    #: Personal classifications are credited before Market Watch when more
    #: than one applies, so a deliberate user subscription is the reported
    #: primary even though the document is written only once.
    _CLASSIFICATION_ORDER = (
        TickSource.PERSONAL_NO_EXPIRY,
        TickSource.PERSONAL_ONE_DAY,
        TickSource.MARKET_WATCH_ONE_DAY,
    )

    def _get_tick_source(self, tick: dict[str, Any]) -> str:
        """
        Classify a tick's source using the active stock registry. Returns the
        PRIMARY TickSource constant, or ``TickSource.UNKNOWN``.

        Use :meth:`_get_tick_classifications` when every applicable
        classification matters (persistence does).
        """
        found = self._get_tick_classifications(tick)
        if not found:
            return TickSource.UNKNOWN
        for candidate in self._CLASSIFICATION_ORDER:
            if candidate in found:
                return candidate
        return found[0]

    # ------------------------------------------------------------------ #
    # Validity (expiry is metadata-driven, never a hard-coded date)
    # ------------------------------------------------------------------ #
    def _validity(self, record: Optional[dict[str, Any]]) -> tuple[bool, Optional[str], dict[str, Any]]:
        """Is this registry record currently valid for persistence?

        Returns ``(valid, reasonCode_or_None, detail)``. Checks, in order:

        1. the record exists and is not deactivated  -> ``INACTIVE_STOCK``
        2. a wall-clock expiry has passed            -> ``EXPIRED_STOCK``
        3. a day-scoped source's validity date is not
           the current trading date                  -> ``EXPIRED_STOCK``

        No fixed date is used anywhere. The wall clock comes from the record's
        own ``expires_at`` / ``valid_until`` / ``expiry_at`` metadata, and the
        day scope from the record's ``market_date`` compared against the
        authoritative IST trading date.
        """
        detail: dict[str, Any] = {}
        if not record:
            return False, DropReason.NOT_ALLOWED_SOURCE, detail

        if record.get("active") is False:
            detail["active"] = False
            return False, DropReason.INACTIVE_STOCK, detail

        now = time.time()

        # (2) Wall-clock expiry.
        for key in ("expires_at", "expiresAt", "valid_until", "validUntil", "expiry_at"):
            raw = record.get(key)
            if raw is None or raw == "":
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if value == 0:  # explicit "no expiry" sentinel
                continue
            if value > 1_000_000_000_000:  # milliseconds
                value = value / 1000.0
            if now >= value:
                detail["expiredAt"] = value
                detail["expiryField"] = key
                return False, DropReason.EXPIRED_STOCK, detail
            detail.setdefault("expiresAt", value)
            detail["expiryField"] = key
            break

        # (3) Day-scoped validity (one-day / fusion universe).
        sources = record.get("sources") or ([record.get("source")] if record.get("source") else [])
        daily, _stocks_db, _manual, _pin, _broker_ack = _registry_source_names()
        is_day_scoped = any(
            self._category_for_source(s) == TickSource.MARKET_WATCH_ONE_DAY for s in sources
        )
        if is_day_scoped:
            validity_date = str(
                record.get("market_date")
                or record.get("trading_date")
                or record.get("tradingDate")
                or ""
            ).strip()
            today = self._current_trading_date()
            detail["validityDate"] = validity_date or None
            detail["tradingDate"] = today or None
            detail["dailyUniverse"] = True
            if validity_date and today and validity_date != today:
                # A previous trading day's fusion universe has expired. Its
                # ticks must stop being persisted even if the record is still
                # marked active and the stream is still receiving data.
                return False, DropReason.EXPIRED_STOCK, detail

        return True, None, detail

    # ------------------------------------------------------------------ #
    # Persistence decision â€” the single chokepoint
    # ------------------------------------------------------------------ #
    def _persistence_enabled_for_source(self, source: str) -> bool:
        """Effective permission for a tick category.

        Resolution order: master switch, then storage cap (see
        :func:`storage_caps`), then the per-stream runtime setting. This is
        the only place the effective value is computed, so every caller —
        the tick path, the Market Watch handoff and the status surface —
        observes the same answer.
        """
        if not tick_master_enabled():
            return False
        permission = _CLASSIFICATION_TO_PERMISSION.get(source)
        if permission is None:
            return False
        if storage_caps().get(permission):
            return False
        return rt_bool(TICK_PERSISTENCE_PERMISSIONS[permission], False)

    def _hard_cap_blocks(self, source: str) -> bool:
        """True when the storage cap, not the setting, is what refuses a tick."""
        permission = _CLASSIFICATION_TO_PERMISSION.get(source)
        if permission is None:
            return False
        return bool(storage_caps().get(permission))

    def _count_reason(self, code: str, amount: int = 1) -> None:
        self._reason_counts[code] = self._reason_counts.get(code, 0) + amount

    def _log_rejection_throttled(self, code: str, message: str, *, every: int = 5000) -> None:
        """Log a per-tick rejection at most once per ``every`` occurrences.

        ``ingest`` runs on every market tick. Recording each rejection through
        ``record_error`` produced hundreds of thousands of identical WARNING
        lines per session (and a multi-gigabyte log file) while the counters
        already carry the truth. The count is still incremented every time and
        exposed in ``dropReasons``; only the log line is sampled.
        """
        key = f"{code}|{message}"
        seen = self._rejection_log_counts.get(key, 0) + 1
        self._rejection_log_counts[key] = seen
        if seen == 1 or seen % every == 0:
            logger.warning(
                "[DB_WRITER] %s — %s (occurrence %d)", code, message, seen
            )

    def _credit_skip(self, classifications: tuple[str, ...]) -> None:
        """Count a suppressed tick against every classification that applied."""
        for classification in classifications or ():
            if classification == TickSource.PERSONAL_NO_EXPIRY:
                self._personal_no_expiry_skipped += 1
            elif classification == TickSource.PERSONAL_ONE_DAY:
                self._personal_expiry_skipped += 1
            elif classification == TickSource.MARKET_WATCH_ONE_DAY:
                self._market_watch_skipped += 1

    def _credit_accept(self, classification: str) -> None:
        if classification == TickSource.PERSONAL_NO_EXPIRY:
            self._personal_no_expiry_accepted += 1
        elif classification == TickSource.PERSONAL_ONE_DAY:
            self._personal_expiry_accepted += 1
        elif classification == TickSource.MARKET_WATCH_ONE_DAY:
            self._market_watch_accepted += 1

    @staticmethod
    def _decision(
        *,
        persist: bool,
        code: str,
        classification: str = TickSource.UNKNOWN,
        classifications: tuple[str, ...] = (),
        granted: tuple[str, ...] = (),
        permission: Optional[str] = None,
        enabled: bool = False,
        hard_capped: bool = False,
        overlapping: bool = False,
        validity: Optional[dict[str, Any]] = None,
        symbol: Optional[str] = None,
        token: Optional[str] = None,
        extra: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        decision: dict[str, Any] = {
            "persist": bool(persist),
            "reasonCode": code,
            "reason": _LEGACY_REASONS.get(code, code.lower()),
            "classification": classification,
            "classifications": list(classifications),
            "grantedClassifications": list(granted),
            "overlapping": bool(overlapping),
            "permission": permission,
            "enabled": bool(enabled),
            "hardCapped": bool(hard_capped),
            "validity": validity or {},
        }
        if permission is not None:
            decision["settingKey"] = TICK_PERSISTENCE_PERMISSIONS[permission]
        if symbol is not None:
            decision["symbol"] = symbol
        if token is not None:
            decision["token"] = token
        if extra:
            decision.update(extra)
        return decision

    def evaluate(self, tick: dict[str, Any]) -> dict[str, Any]:
        """Authoritative SAVE/DROP decision for one normalized tick.

        Ordered pipeline (the DB Writer is the ONLY place this is decided):

        1. validate the tick has an instrument identity
        2. identify the stock in the active registry
        3. identify its source(s) / category
        4. check the registry record is active
        5. check expiry / one-day validity
        6. check the persistence permission for each applicable category
        7. decide SAVE or DROP with a canonical reason code

        Side-effect free: it never buffers and never writes. Callers hand the
        accepted tick to the buffer; the returned ``reasonCode`` is the single
        explanation used by metrics, the API and the UI.
        """
        if not isinstance(tick, dict):
            return self._decision(persist=False, code=DropReason.INVALID_TICK)

        token = self._tick_token(tick)
        if not token:
            return self._decision(persist=False, code=DropReason.INVALID_TICK)

        # Master kill-switch: OFF blocks EVERY write, even for valid ticks.
        # Checked before the registry lookup so the reason is honest
        # (PERSISTENCE_DISABLED = operator turned saving off, not a data issue).
        if not tick_master_enabled():
            return self._decision(
                persist=False,
                code=DropReason.PERSISTENCE_DISABLED,
                symbol=tick.get("symbol"),
                token=token,
                extra={"reasonDetail": "master switch dbw_ticks_enabled is OFF"},
            )

        record = self._registry_record(token)
        symbol = None
        if record:
            symbol = record.get("symbol") or record.get("trading_symbol")
        symbol = symbol or tick.get("symbol")

        # 2/3 â€” the stock must be in the active registry and have a known source.
        classifications = self._classifications_for_record(record) if record else ()
        if not classifications:
            return self._decision(
                persist=False,
                code=DropReason.NOT_ALLOWED_SOURCE,
                symbol=symbol,
                token=token,
                extra={"reasonDetail": "instrument is not in the active stock registry"},
            )

        # 4/5 â€” active status and validity (expiry metadata, never a fixed date).
        valid, invalid_code, validity = self._validity(record)
        if not valid:
            return self._decision(
                persist=False,
                code=invalid_code or DropReason.INACTIVE_STOCK,
                classifications=classifications,
                symbol=symbol,
                token=token,
                validity=validity,
            )

        ordered = [c for c in self._CLASSIFICATION_ORDER if c in classifications]
        # 6 â€” persist when ANY applicable permission is on, but write ONE document.
        granted = [c for c in ordered if self._persistence_enabled_for_source(c)]
        primary = (granted or ordered)[0]
        permission = _CLASSIFICATION_TO_PERMISSION.get(primary)
        if permission is None:
            return self._decision(
                persist=False,
                code=DropReason.NOT_ALLOWED_SOURCE,
                classifications=ordered,
                symbol=symbol,
                token=token,
                validity=validity,
            )

        if granted:
            return self._decision(
                persist=True,
                code=DropReason.PERMISSION_GRANTED,
                classification=primary,
                classifications=tuple(ordered),
                granted=tuple(granted),
                permission=permission,
                enabled=True,
                hard_capped=False,
                overlapping=len(granted) > 1,
                symbol=symbol,
                token=token,
                validity=validity,
            )

        capped = any(self._hard_cap_blocks(c) for c in ordered)
        return self._decision(
            persist=False,
            code=DropReason.STORAGE_CAPPED if capped else DropReason.PERSISTENCE_DISABLED,
            classification=primary,
            classifications=tuple(ordered),
            granted=(),
            permission=permission,
            enabled=False,
            hard_capped=capped,
            symbol=symbol,
            token=token,
            validity=validity,
        )

    def should_persist_tick(self, tick: dict[str, Any]) -> dict[str, Any]:
        """Public, side-effect-free persistence decision for one tick.

        This is the single authority queried by every persistence path,
        including the Market Watch handoff. It never buffers and never writes â€”
        it only reports the decision so the caller can hand the tick to the
        right buffer. Metrics are intentionally not touched here.
        """
        return self.evaluate(tick)

    def _should_persist_tick(self, tick: dict[str, Any]) -> tuple[bool, str]:
        """Counting wrapper around :meth:`evaluate` for the hot ingest path.

        Returns ``(persist, primary_classification)`` and updates the
        aggregated SAVE/DROP counters, including the canonical reason code.
        """
        decision = self.evaluate(tick)
        code = decision["reasonCode"]
        self._count_reason(code)
        classifications = tuple(decision.get("classifications") or ())
        # Track the latest REAL decision for the status surface (never a
        # placeholder: at/epoch is the wall clock of this very evaluation).
        self._last_decision = {
            "at": time.time(),
            "persist": bool(decision["persist"]),
            "reasonCode": code,
            "classification": decision["classification"],
            "symbol": decision.get("symbol"),
            "token": decision.get("token"),
            "overlapping": bool(decision.get("overlapping")),
        }

        if not decision["persist"]:
            if code == DropReason.NOT_ALLOWED_SOURCE:
                self._unknown_source_skipped += 1
            elif code == DropReason.INVALID_TICK:
                self._rejected += 1
            else:
                self._credit_skip(classifications)
            return False, decision["classification"]

        if decision.get("overlapping"):
            self._overlapping_sources_deduped += 1
        self._credit_accept(decision["classification"])
        return True, decision["classification"]
    # Helpers
    # ------------------------------------------------------------------ #
    def _purge_dedup_cache(self) -> None:
        """Remove expired entries from the dedup cache."""
        now = time.monotonic()
        while self._dedup_cache and self._dedup_cache[0][2] <= now:
            self._dedup_cache.popleft()

    def _is_duplicate(self, token: str, seq: int | None) -> bool:
        """Check if (token, seq) was seen recently. If seq is None, cannot dedup."""
        if seq is None:
            return False
        self._purge_dedup_cache()
        key = (token, seq)
        for tok, sq, _ in self._dedup_cache:
            if tok == token and sq == seq:
                return True
        return False

    def _record_dedup(self, token: str, seq: int | None) -> None:
        if seq is None:
            return
        expiry = time.monotonic() + self._DEDUP_TTL_SEC
        self._dedup_cache.append((token, seq, expiry))
    async def flush(self) -> dict[str, Any]:
        """Manually drain every buffer this engine owns into MongoDB.

        Both write paths belong to the DB Writer, so an operational flush has to
        cover both: the Data Saver tick buffer (``ticks``) and the Market Watch
        document buffer (``market_ticks``, candles, decisions, report). Flushing
        only one of them would leave accepted documents sitting in memory while
        the caller was told the pipeline was drained.
        """
        from services import market_watch_doc_buffer, tick_buffer

        result = await tick_buffer.flush()
        written_ticks = int(result.get("written", 0) or 0) if isinstance(result, dict) else int(result or 0)

        written_documents = 0
        doc_error: Optional[str] = None
        try:
            while True:
                drained = await market_watch_doc_buffer.flush()
                written_documents += int(drained or 0)
                if not drained:
                    break
        except Exception as exc:
            # Reported, never raised: a caller asking for a flush still needs the
            # tick result it already earned, plus an honest account of what did
            # not drain.
            doc_error = str(exc)
            self.record_error("mw_document_flush_error", doc_error)

        self._last_flush_result = {
            "written": written_ticks,
            "documentsWritten": written_documents,
            "marketWatchDocumentsError": doc_error,
        }
        self._refresh_metrics()
        self.record_event()
        return self._last_flush_result

    async def ingest(self, tick: dict[str, Any]) -> bool:
        """Validate + buffer one standardized tick document.

        This is the DB Writer's consumer entry point: the Connection Manager
        owns routing, so it drains the built-in Data Saver stream and hands
        each document here (connection-manager.md Â§22/Â§47). Validation is
        deliberately minimal and never fabricates values â€” a document must
        carry an instrument identity to be persisted. Rejected documents are
        counted and logged, never silently dropped.

        Source Classification & Persistence Decision:
        - Classifies tick using Session Manager's authoritative subscription state
        - Checks three independent persistence policies
        - Unknown source is never persisted
        - Overlapping sources produce ONE document (not duplicates)

        Deduplication: uses broker sequenceNumber when available (best
        identity). Fallback: no dedup if sequence missing â€” upstream should
        provide it.
        """
        if not isinstance(tick, dict):
            self._rejected += 1
            self._count_reason(DropReason.INVALID_TICK)
            return False
        token = self._tick_token(tick)
        if not token:
            self._rejected += 1
            self._count_reason(DropReason.INVALID_TICK)
            self.record_error("ingest_rejected", "tick without instrument identity")
            return False

        # Source classification & persistence decision
        should_persist, source = self._should_persist_tick(tick)

        # Live quotes are NOT a storage concern. Publish the tick to the central
        # in-memory latest-value store BEFORE (and independently of) the
        # persistence decision, so a disabled MongoDB category can never make
        # real, subscribed market data look unavailable to the UI. A tick that
        # is not written to MongoDB is still a genuine live tick.
        tick["_tick_source"] = source
        try:
            from services import tick_buffer

            tick = tick_buffer.record_latest(tick)
        except Exception as exc:  # pragma: no cover - defensive
            # A failure to publish live must not be counted as a storage
            # rejection; the tick simply is not visible until the next update.
            self.record_error("live_publish_error", str(exc))

        if not should_persist:
            # Track the rejection by source
            if source == TickSource.UNKNOWN:
                self._log_rejection_throttled("ingest_rejected", "unknown source - not persisted")
            # Still count as rejected for data accounting
            self._rejected += 1
            return False

        # Deduplication check
        seq = tick.get("sequenceNumber")
        if self._is_duplicate(token, seq):
            self._duplicates += 1
            self._count_reason(DropReason.DUPLICATE)
            return False

        try:
            from services import tick_buffer

            tick_buffer.enqueue_for_storage(tick)
        except Exception as exc:  # pragma: no cover - defensive
            self._rejected += 1
            self._count_reason(DropReason.QUEUE_REJECTED)
            self._queue_rejected += 1
            self.record_error("ingest_error", str(exc))
            return False

        self._ingested += 1
        self._record_dedup(token, seq)
        return True

    async def delete_duplicate_ticks(
        self, ids: Any, *, collection: str = "ticks"
    ) -> int:
        """Delete duplicate tick records. The DB Writer owns EVERY tick write.

        This includes removals. A duplicate-cleanup tool that deletes tick
        documents straight from MongoDB is still a writer of tick data, and two
        writers means two different views of what is stored. Routing the delete
        through here keeps one authority for ticks and leaves an audit trail of
        how many records were removed, rather than a silent collection shrink.

        Returns the number of documents actually removed.
        """
        if not ids:
            return 0
        id_list = list(ids)
        from database.connection import get_db

        try:
            db = get_db()
            result = await db[collection].delete_many({"_id": {"$in": id_list}})
        except Exception as exc:
            self.record_error("tick_delete_error", str(exc))
            self._count_reason(DropReason.DATABASE_ERROR)
            raise

        deleted = int(getattr(result, "deleted_count", 0) or 0)
        self._duplicates_removed += deleted
        self.set_metric("duplicateTicksRemoved", self._duplicates_removed)
        self.record_event()
        return deleted

    # ------------------------------------------------------------------ #
    # Market Watch document ingest (candles, decisions, EOD report)
    # ------------------------------------------------------------------ #
    async def ingest_documents(self, collection: str, docs: Any) -> int:
        """Buffer Market Watch documents for batched persistence.

        Market Watch calls this instead of touching MongoDB (doc Â§10). The
        documents are written by this engine's flush loop, so a candle or a
        block-ledger decision is never written twice and never blocks the tick
        path. Returns the number of documents accepted.
        """
        return self.buffer_documents(collection, docs)

    #: Collections whose documents are TICKS and therefore subject to the
    #: persistence authority. They may not be buffered through the public
    #: batching method, or the storage cap could be side-stepped.
    _TICK_COLLECTIONS = frozenset({"market_ticks"})

    def buffer_documents(self, collection: str, docs: Any) -> int:
        """Synchronous, non-blocking buffer append for NON-tick documents.

        Safe to call from the hot path (which is synchronous): it only appends
        to the in-memory buffer; the DB Writer's flush loop does the MongoDB
        write later.

        This is the *batching* path only. It deliberately does NOT decide
        persistence, so **tick collections are refused outright**: routing ticks
        through here would bypass both the classification decision and the
        temporary storage cap, which is exactly what the cap exists to prevent.
        Use :meth:`ingest_market_watch_ticks` for ticks.
        """
        from services import market_watch_doc_buffer

        if collection in self._TICK_COLLECTIONS:
            self._mw_rejected += 1
            self.record_error(
                "mw_document_rejected",
                f"{collection} is a tick collection and must go through "
                "ingest_market_watch_ticks(), which applies the DB Writer's "
                "permission and storage cap",
            )
            return 0

        return self._buffer_documents_unchecked(collection, docs)

    def _buffer_documents_unchecked(self, collection: str, docs: Any) -> int:
        """Append to a buffer without re-applying the authority.

        Internal: reached only from the already-gated paths
        (:meth:`ingest_market_watch_ticks` and :meth:`buffer_candles`).
        """
        from services import market_watch_doc_buffer

        if collection not in market_watch_doc_buffer.COLLECTIONS:
            self._mw_rejected += 1
            self.record_error("mw_document_rejected", f"unknown collection {collection}")
            return 0
        try:
            accepted = market_watch_doc_buffer.add(collection, docs)
        except Exception as exc:
            self._mw_rejected += 1
            self.record_error("mw_document_error", str(exc))
            return 0
        self._mw_accepted += accepted
        return accepted

    def ingest_market_watch_ticks(self, docs: Any) -> dict[str, Any]:
        """Authority entry point for Market Watch tick persistence.

        Market Watch validates and publishes ticks but MUST NOT decide whether
        they are persisted. It hands the validated documents here; this method
        asks :meth:`should_persist_tick` and buffers only what the DB Writer
        itself accepts.

        The documents still travel through the existing ``market_ticks``
        append-only buffer, so batching, backpressure, retry and the
        ``(symbol, sequenceNumber)`` deterministic ``_id`` are unchanged.

        Returns a decision summary for the caller/tests. Nothing is buffered
        when the Market Watch permission is OFF, which is the default.
        """
        if isinstance(docs, dict):
            docs = [docs]
        if not isinstance(docs, (list, tuple)):
            self._mw_rejected += 1
            self._count_reason(DropReason.INVALID_TICK)
            self.record_error("mw_tick_rejected", "docs must be a list of tick documents")
            return {
                "accepted": 0,
                "rejected": 0,
                "duplicates": 0,
                "permission": "marketWatchOneDay",
                "enabled": self._persistence_enabled_for_source(TickSource.MARKET_WATCH_ONE_DAY),
                "reasonCode": DropReason.INVALID_TICK,
                "reason": "invalid_payload",
            }

        accepted: list[dict[str, Any]] = []
        duplicates = 0
        reasons: dict[str, int] = {}
        for doc in docs:
            if not isinstance(doc, dict):
                self._mw_rejected += 1
                self._count_reason(DropReason.INVALID_TICK)
                reasons[DropReason.INVALID_TICK] = reasons.get(DropReason.INVALID_TICK, 0) + 1
                continue

            decision = self.evaluate(doc)
            self._count_reason(decision["reasonCode"])
            if not decision["persist"]:
                # Group by the CANONICAL code; the legacy string is kept only
                # for the aggregated legacy key so existing readers still work.
                code = decision["reasonCode"]
                reasons[code] = reasons.get(code, 0) + 1
                if code == DropReason.NOT_ALLOWED_SOURCE:
                    self._unknown_source_skipped += 1
                elif code == DropReason.INVALID_TICK:
                    self._rejected += 1
                else:
                    # Credit the skip to every classification that applied so
                    # the status surface shows why the tick was suppressed.
                    self._credit_skip(
                        tuple(decision.get("classifications") or ()) or (decision["classification"],)
                    )
                self._mw_rejected += 1
                continue

            token = self._tick_token(doc)
            seq = doc.get("sequenceNumber")
            if self._is_duplicate(token, seq):
                duplicates += 1
                self._duplicates += 1
                self._count_reason(DropReason.DUPLICATE)
                reasons[DropReason.DUPLICATE] = reasons.get(DropReason.DUPLICATE, 0) + 1
                continue

            doc["_tick_source"] = decision["classification"]
            if decision.get("overlapping"):
                self._overlapping_sources_deduped += 1
            accepted.append(doc)

        written = self._buffer_documents_unchecked("market_ticks", accepted) if accepted else 0
        if accepted:
            self._ingested += written
            for doc in accepted[:written]:
                self._record_dedup(self._tick_token(doc), doc.get("sequenceNumber"))
            self._market_watch_accepted += written
            self._overlapping_sources_deduped += max(0, len(accepted) - written)
            if len(accepted) > written:
                # Buffer refused the overflow (hard cap). That is a real,
                # counted drop rather than a silent loss.
                self._queue_rejected += len(accepted) - written
                self._count_reason(DropReason.QUEUE_REJECTED, len(accepted) - written)
                reasons[DropReason.QUEUE_REJECTED] = (
                    reasons.get(DropReason.QUEUE_REJECTED, 0) + (len(accepted) - written)
                )

        mw_blocked = self._hard_cap_blocks(TickSource.MARKET_WATCH_ONE_DAY)
        if written:
            summary_code = DropReason.PERMISSION_GRANTED
        elif mw_blocked:
            summary_code = DropReason.STORAGE_CAPPED
        else:
            summary_code = next(
                (c for c in reasons if c != DropReason.DUPLICATE),
                DropReason.PERSISTENCE_DISABLED,
            )
        return {
            "accepted": written,
            "rejected": sum(v for k, v in reasons.items() if k != DropReason.DUPLICATE),
            "duplicates": duplicates,
            "permission": "marketWatchOneDay",
            "settingKey": TICK_PERSISTENCE_PERMISSIONS["marketWatchOneDay"],
            "enabled": self._persistence_enabled_for_source(TickSource.MARKET_WATCH_ONE_DAY),
            "hardCapped": mw_blocked,
            "reasonCode": summary_code,
            "reason": (
                "buffered"
                if written
                else _LEGACY_REASONS.get(summary_code, summary_code.lower())
            ),
            "reasons": reasons,
            "legacyReasons": {
                _LEGACY_REASONS.get(code, code.lower()): count for code, count in reasons.items()
            },
        }

    def buffer_candles(self, docs: Any) -> int:
        """Route Market Watch candle documents to their per-timeframe collections.

        ``market_candles_1m/5m/10m/30m`` are separate collections by design
        (doc Â§10); the mapping lives here so no caller has to know it.
        """
        if isinstance(docs, dict):
            docs = [docs]
        grouped: dict[str, list[dict[str, Any]]] = {}
        for doc in docs or []:
            if not isinstance(doc, dict):
                continue
            collection = CANDLE_COLLECTIONS.get(str(doc.get("timeframe") or ""))
            if collection is None:
                self._mw_rejected += 1
                self.record_error("mw_candle_rejected", f"unknown timeframe {doc.get('timeframe')}")
                continue
            grouped.setdefault(collection, []).append(doc)
        accepted = 0
        for collection, group in grouped.items():
            accepted += self.buffer_documents(collection, group)
        return accepted

    async def flush_documents(self) -> int:
        """Drain the Market Watch document buffer (stop path / tests)."""
        from services import market_watch_doc_buffer

        return await market_watch_doc_buffer.flush()

    def market_watch_persistence(self) -> dict:
        """Status of the Market Watch document pipeline (health/audit)."""
        from services import market_watch_doc_buffer

        return market_watch_doc_buffer.stats()

    # ------------------------------------------------------------------ #
    # Tick persistence permission surface (backend-owned)
    # ------------------------------------------------------------------ #
    def tick_persistence_settings(self) -> dict[str, Any]:
        """Authoritative read of the three independent tick permissions.

        Values come from the live runtime-settings cache, i.e. the same source
        ``_persistence_enabled_for_source`` consults on the tick path. The
        frontend renders this; it never owns it.
        """
        accepted = {
            "personalNoExpiry": self._personal_no_expiry_accepted,
            "personalOneDay": self._personal_expiry_accepted,
            "marketWatchOneDay": self._market_watch_accepted,
        }
        skipped = {
            "personalNoExpiry": self._personal_no_expiry_skipped,
            "personalOneDay": self._personal_expiry_skipped,
            "marketWatchOneDay": self._market_watch_skipped,
        }
        permissions: dict[str, Any] = {}
        caps = storage_caps()
        master_configured = rt_bool(TICK_PERSISTENCE_MASTER_SETTING, True)
        master_effective = bool(master_configured)
        for name, key in TICK_PERSISTENCE_PERMISSIONS.items():
            hard_capped = bool(caps.get(name))
            # Report the EFFECTIVE value. For a capped permission that is the
            # cap, not the stored setting, so the panel reflects what actually
            # happens on the tick path.
            configured = rt_bool(key, False)
            permissions[name] = {
                "label": TICK_PERSISTENCE_LABELS.get(name, name),
                "settingKey": key,
                "enabled": self._persistence_enabled_for_source(
                    next(c for c, p in _CLASSIFICATION_TO_PERMISSION.items() if p == name)
                ),
                "configuredEnabled": configured,
                "hardCapped": hard_capped,
                "capSettingKey": TICK_PERSISTENCE_CAP_SETTINGS[name],
                "capEnvKey": TICK_PERSISTENCE_CAP_ENV[name],
                "accepted": accepted.get(name, 0),
                "skipped": skipped.get(name, 0),
            }
        cap_active = any(caps.values())
        cap_reason = storage_cap_reason()
        any_stream_on = any(
            bool(p.get("enabled")) for p in permissions.values()
        )
        return {
            "owner": "db_writer_engine",
            "authority": "sole_tick_persistence_authority",
            "master": {
                "label": "Tick saving master switch",
                "settingKey": TICK_PERSISTENCE_MASTER_SETTING,
                "apiName": TICK_PERSISTENCE_MASTER_NAME,
                "enabled": master_effective,
                "configuredEnabled": master_configured,
            },
            "effectiveSaving": bool(master_effective and any_stream_on),
            "permissions": permissions,
            "unknownSourceSkipped": self._unknown_source_skipped,
            "overlappingSourcesDeduped": self._overlapping_sources_deduped,
            "dropReasons": dict(self._reason_counts),
            "reasonCodes": list(DROP_REASONS),
            "storageCapActive": cap_active,
            "storageCapReason": cap_reason if cap_active else None,
            "storageCaps": caps,
            "registryCache": {
                "entries": len(self._registry_cache),
                "refreshes": self._registry_refreshes,
                "ttlMs": int(self._registry_cache_ttl * 1000),
            },
        }

    async def set_tick_persistence(self, updates: dict[str, Any]) -> dict[str, Any]:
        """Apply permission updates through the existing settings service.

        ``updates`` maps permission name -> bool, plus the optional master
        switch (``"master"`` -> ``dbw_ticks_enabled``). Unknown names raise
        ``ValueError`` so the API can answer 400 instead of silently ignoring
        a typo. The runtime cache is refreshed immediately so the very next
        tick observes the new value.

        A storage failure (e.g. MongoDB unreachable) raises
        ``TickPersistenceUnavailable`` so the caller can report it honestly
        instead of returning a 500 that looks like a server bug. Nothing is
        partially applied: the keys are validated first, and a failure is
        recorded and surfaced.
        """
        from services import runtime_settings
        from services.settings_service import set_setting

        known = set(TICK_PERSISTENCE_PERMISSIONS) | {TICK_PERSISTENCE_MASTER_NAME}
        unknown = [name for name in updates if name not in known]
        if unknown:
            raise ValueError(f"unknown tick persistence permission(s): {', '.join(sorted(unknown))}")

        # A capped stream cannot be enabled. Reject rather than accept a toggle
        # that would be silently ignored, so the operator is told the truth
        # instead of watching a switch that does nothing. The reason is
        # operator-configured, and the default names the cap settings so the
        # message is actionable on its own.
        caps = storage_caps()
        cap_reason = storage_cap_reason() or (
            "blocked by an active storage cap ("
            + ", ".join(
                TICK_PERSISTENCE_CAP_SETTINGS[name]
                for name, capped in caps.items()
                if capped
            )
            + ")"
        )
        blocked_writes = [
            name
            for name, value in updates.items()
            if caps.get(name) and bool(value) is True
        ]
        if blocked_writes:
            raise ValueError(
                "cannot enable "
                + ", ".join(sorted(blocked_writes))
                + ": blocked by the storage cap. "
                + cap_reason
            )

        # Fail before writing anything if the settings store is unreachable.
        try:
            from database.connection import get_db

            get_db()
        except Exception as exc:
            message = f"tick persistence settings are unavailable: {exc}"
            self.record_error("tick_persistence_set_unavailable", message)
            raise TickPersistenceUnavailable(message) from exc

        applied: dict[str, bool] = {}
        for name, value in updates.items():
            key = (
                TICK_PERSISTENCE_MASTER_SETTING
                if name == TICK_PERSISTENCE_MASTER_NAME
                else TICK_PERSISTENCE_PERMISSIONS[name]
            )
            try:
                await set_setting(key, bool(value))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                message = f"could not persist {key}: {exc}"
                self.record_error("tick_persistence_set_failed", message)
                raise TickPersistenceUnavailable(message) from exc
            applied[name] = bool(value)

        await runtime_settings.refresh_runtime_settings()
        self.record_event()
        self._refresh_metrics()
        return self.tick_persistence_settings()

    # ------------------------------------------------------------------ #
    # Storage report — day-wise + all-time, real MongoDB numbers          #
    # ------------------------------------------------------------------ #

    #: Explicit data-plane collections this engine writes. The all-time view
    #: reports exactly this list (one live collStats each); anything else in
    #: the database is not DB-Writer storage and is never silently added.
    _STORAGE_COLLECTIONS = (
        "ticks",
        "market_ticks",
        "market_candles_1m",
        "market_candles_2m",
        "market_candles_5m",
        "market_candles_10m",
        "market_candles_30m",
        "market_watch_decisions",
        "market_watch_daily_report",
        "market_watch_universe",
        "market_watch_universe_history",
        "market_watch_review_decisions",
        "market_watch_weekly_reports",
        "market_watch_weekly_crossings",
        "market_watch_weekly_screen",
        "daily_summaries",
    )

    async def storage_report(self, days: int = 30, date: str = "") -> dict[str, Any]:
        """Storage view for the DB Writer storage page: day-wise + all-time.

        - ``allTime``: one live ``collStats`` run per data-plane collection
          this engine writes, plus grand totals.
        - ``days``: the IST daily ledgers the tick pipeline upserts into
          ``daily_summaries`` (date / totalTicks / totalWrites /
          subscribedStocks), newest first, bounded by ``days``.
        - ``day`` (optional ``date=YYYY-MM-DD`` IST business date): that
          day's ``daily_summaries`` row + a REAL count of ``ticks`` documents
          whose ``receivedAt`` — a genuine UTC datetime this engine wrote on
          every tick — falls inside that IST calendar day.

        Day-scoped numbers are produced ONLY where the persisted documents
        carry a real timestamp field (``ticks.receivedAt``); everything else is
        reported from the persisted daily ledger or honestly left out. Nothing
        here is fabricated.

        Returns ``{"ok": False, "error": ...}`` when MongoDB is unreachable so
        the caller reports storage unavailability, not a server bug.
        """
        from datetime import datetime, timedelta

        from core.timezones import IST, UTC, iso_ist
        from database.connection import get_db, is_mongo_connected

        days = max(1, min(365, int(days)))
        date = str(date or "").strip()

        day_window: tuple[datetime, datetime] | None = None
        if date:
            try:
                year, month, day_num = (int(v) for v in date.split("-"))
                day_start = datetime(year, month, day_num, tzinfo=IST)
                day_window = (day_start, day_start + timedelta(days=1))
            except (ValueError, TypeError):
                return {"ok": False, "error": "date must be YYYY-MM-DD (IST business date)"}

        try:
            db = get_db()
        except Exception as exc:
            return {"ok": False, "error": f"mongodb unavailable: {exc}"}
        if not is_mongo_connected():
            return {"ok": False, "error": "MongoDB not connected"}

        # -- all-time: live collStats per owned collection --------------- #
        collections: list[dict[str, Any]] = []
        total_docs = 0
        total_bytes = 0
        for name in self._STORAGE_COLLECTIONS:
            try:
                stats = await db.command("collStats", name)
                documents = int(stats.get("count", 0) or 0)
                size_bytes = int(stats.get("size", 0) or 0)
                collections.append({
                    "name": name,
                    "ok": True,
                    "documents": documents,
                    "sizeBytes": size_bytes,
                    "sizeMB": round(size_bytes / (1024 * 1024), 3),
                    "storageBytes": int(stats.get("storageSize", 0) or 0),
                    "avgObjBytes": int(stats.get("avgObjSize", 0) or 0),
                    "indexes": int(stats.get("nindexes", 0) or 0),
                })
                total_docs += documents
                total_bytes += size_bytes
            except Exception as exc:
                logger.warning("storage_report: collStats %s failed: %s", name, exc)
                collections.append({"name": name, "ok": False, "error": str(exc)[:200]})
        collections.sort(key=lambda c: c.get("sizeBytes", 0), reverse=True)

        # -- day-wise ledger: real rows persisted by _write_batch -------- #
        ledger_days: list[dict[str, Any]] = []
        try:
            cursor = (
                db.daily_summaries.find({}, {"_id": 0})
                .sort("date", -1)
                .limit(days)
            )
            async for row in cursor:
                ledger_days.append({
                    "date": row.get("date"),
                    "totalTicks": int(row.get("totalTicks", 0) or 0),
                    "totalWrites": int(row.get("totalWrites", 0) or 0),
                    "subscribedStocks": row.get("subscribedStocks"),
                    "updatedAt": iso_ist(row.get("updatedAt")),
                })
        except Exception as exc:
            logger.warning("storage_report: daily_summaries read failed: %s", exc)

        # -- single-day drill-down (real counts by receivedAt) ----------- #
        day: dict[str, Any] | None = None
        if day_window is not None:
            day_start, day_end = day_window
            ledger_row: dict[str, Any] | None = None
            try:
                row = await db.daily_summaries.find_one({"date": date}, {"_id": 0})
                if row:
                    ledger_row = {
                        "date": row.get("date"),
                        "totalTicks": int(row.get("totalTicks", 0) or 0),
                        "totalWrites": int(row.get("totalWrites", 0) or 0),
                        "subscribedStocks": row.get("subscribedStocks"),
                        "updatedAt": iso_ist(row.get("updatedAt")),
                    }
            except Exception as exc:
                logger.warning("storage_report: day ledger %s failed: %s", date, exc)
            try:
                # ticks documents carry receivedAt (UTC datetime written by
                # this engine); the IST day maps to an exact UTC window.
                ticks_day = await db.ticks.count_documents({
                    "receivedAt": {"$gte": day_start, "$lt": day_end},
                })
            except Exception as exc:
                logger.warning("storage_report: day tick count %s failed: %s", date, exc)
                ticks_day = None
            day = {
                "date": date,
                "startedAtUtc": day_start.astimezone(UTC).isoformat(),
                "endedAtUtc": day_end.astimezone(UTC).isoformat(),
                "timeZone": "Asia/Kolkata",
                "timestampField": "ticks.receivedAt",
                "ledger": ledger_row,
                "ticksDocuments": ticks_day,
                "countsAvailable": ticks_day is not None,
            }

        return {
            "ok": True,
            "owner": "db_writer_engine",
            "authority": "sole_tick_persistence_authority",
            "generatedAt": iso_ist(datetime.now(IST)),
            "timeZone": "Asia/Kolkata",
            "allTime": {
                "collections": collections,
                "summary": {
                    "collections": len(collections),
                    "documents": total_docs,
                    "sizeBytes": total_bytes,
                    "sizeMB": round(total_bytes / (1024 * 1024), 2),
                },
            },
            "days": ledger_days,
            "daysRequested": days,
            "day": day,
        }

    # ------------------------------------------------------------------ #
    # Metrics / status
    # ------------------------------------------------------------------ #
    def _refresh_metrics(self) -> None:
        try:
            from services import tick_buffer

            stats = tick_buffer.stats()
            errors = int(stats.get("totalWriteErrors", 0))
            self.set_metric("bufferLength", stats.get("bufferLength", 0))
            self.set_metric("totalReceived", stats.get("totalReceived", 0))
            self.set_metric("totalWritten", stats.get("totalWritten", 0))
            self.set_metric("totalWriteErrors", errors)
            self.set_metric("ticksPerSecond", stats.get("ticksPerSecond", 0))
            self.set_metric("writesPerSecond", stats.get("writesPerSecond", 0))
            self.set_metric("pipelineRunning", bool(stats.get("pipelineRunning")))
            self.set_metric("activeTickStocks", stats.get("activeTickStocks", 0))
            self.set_metric("feedLatencyMs", (stats.get("feedLatencyMs") or {}).get("currentMs"))
            # DB Writer specific accounting
            self.set_metric("ingestedFromRouter", self._ingested)
            self.set_metric("rejectedByValidation", self._rejected)
            self.set_metric("duplicatesRejected", self._duplicates)
            self.set_metric("acceptedForPersistence", self._ingested - self._rejected - self._duplicates)
            # Source-based persistence metrics
            self.set_metric("personalNoExpiryAccepted", self._personal_no_expiry_accepted)
            self.set_metric("personalExpiryAccepted", self._personal_expiry_accepted)
            self.set_metric("marketWatchAccepted", self._market_watch_accepted)
            self.set_metric("personalNoExpirySkipped", self._personal_no_expiry_skipped)
            self.set_metric("personalExpirySkipped", self._personal_expiry_skipped)
            self.set_metric("marketWatchSkipped", self._market_watch_skipped)
            self.set_metric("unknownSourceSkipped", self._unknown_source_skipped)
            self.set_metric("overlappingSourcesDeduped", self._overlapping_sources_deduped)
            self.set_metric("mwDocumentsAccepted", self._mw_accepted)
            self.set_metric("mwDocumentsRejected", self._mw_rejected)
            # Canonical SAVE/DROP diagnostics. Aggregated counters (never one
            # log line per tick) so a busy feed still explains every drop.
            self.set_metric("dropReasons", dict(self._reason_counts))
            self.set_metric("queueRejected", self._queue_rejected)
            self.set_metric("registryCacheEntries", len(self._registry_cache))
            self.set_metric("registryCacheRefreshes", self._registry_refreshes)
            caps = storage_caps()
            self.set_metric("storageCappedStreams", sum(1 for v in caps.values() if v))
            self.set_metric("storageCapActive", any(caps.values()))
            self._last_write_errors = errors
            self._last_total_written = int(stats.get("totalWritten", 0))
        except Exception as exc:
            self.record_error("stats_refresh_error", str(exc))
        try:
            from services import market_watch_doc_buffer

            mw = market_watch_doc_buffer.stats()
            self.set_metric("mwDocumentsPending", mw.get("pendingTotal", 0))
            self.set_metric("mwDocumentsWritten", mw.get("totalWritten", 0))
            self.set_metric("mwDocumentWriteErrors", mw.get("totalWriteErrors", 0))
        except Exception:
            pass

    def _data_loss_accounting(self, stats: dict) -> dict:
        """Build the data-loss accounting reconciliation.

        Uses DB Writer's own ingest counters for RECEIVED (single source of truth).
        RECEIVED = DUPLICATES + INVALID + ACCEPTED
        ACCEPTED = WRITTEN + WRITE_FAILED + PENDING
        """
        total_written = int(stats.get("totalWritten", 0))
        total_errors = int(stats.get("totalWriteErrors", 0))
        buffer_len = int(stats.get("bufferLength", 0))

        received = self._ingested
        duplicates = self._duplicates
        invalid = self._rejected
        accepted = max(0, received - invalid - duplicates)
        written = total_written
        write_failed = total_errors
        pending = buffer_len

        return {
            "received": received,
            "duplicates": duplicates,
            "invalid": invalid,
            "accepted": accepted,
            "written": written,
            "writeFailed": write_failed,
            "pending": pending,
            "reconciliation": {
                "receivedEqualsSum": received == duplicates + invalid + accepted,
                "acceptedEqualsSum": accepted == written + write_failed + pending,
            },
        }

    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        self._refresh_metrics()
        base["metrics"]["custom"] = dict(self.get_metrics().get("custom", {}))
        base["realStatus"] = True
        try:
            from services import tick_buffer

            stats = tick_buffer.stats()
            base["pipeline"] = {
                key: stats.get(key)
                for key in (
                    "bufferLength",
                    "totalReceived",
                    "totalWritten",
                    "totalWriteErrors",
                    "ticksPerSecond",
                    "writesPerSecond",
                    "lastTickAt",
                    "lastWriteAt",
                    "lastFlushAt",
                    "lastFlushDurationMs",
                    "pipelineRunning",
                    "pipelineStartedAt",
                    "pipelineStoppedAt",
                    "activeTickStocks",
                    "feedLatencyMs",
                    "lastError",
                )
            }
            # Data-loss accounting (core correctness property)
            base["dataLossAccounting"] = self._data_loss_accounting(stats)

            # Bounded real flush ledger (per-flush written/failed/duration,
            # most recent first) — new, from the actual write path.
            try:
                base["flushHistory"] = tick_buffer.flush_history()
            except Exception:
                base["flushHistory"] = []

            # The latest real SAVE/DROP decision (may be absent when the
            # pipeline has never evaluated a tick this process).
            base["lastDecision"] = self._last_decision

            # Per-instrument snapshot (from tick_buffer's latest_ticks)
            try:
                latest = tick_buffer.get_latest_ticks()
                base["instruments"] = {
                    token: {
                        "symbol": tick.get("symbol"),
                        "ltp": tick.get("ltp"),
                        "lastTickAgeSec": tick_buffer.latest_tick_age_seconds(token),
                        "momentum": tick_buffer.momentum_windows(token, tick.get("ltp")),
                    }
                    for token, tick in latest.items()
                    if tick.get("ltp") is not None
                }
            except Exception:
                base["instruments"] = {}

            # Audit pipeline â€” use new Storage Engine's persistence_pipeline()
            try:
                from services.storage_engine import storage_engine

                pipe = storage_engine.persistence_pipeline()
                base["audit"] = {
                    "queueSize": pipe.get("queueDepth", 0),
                    "totalWrites": pipe.get("totalWrites", 0),
                    "writeErrors": pipe.get("writeErrors", 0),
                }
            except Exception:
                base["audit"] = None
        except Exception as exc:
            self.record_error("pipeline_status_error", str(exc))
            base["pipeline"] = None
            base["dataLossAccounting"] = None
            base["instruments"] = {}
            base["audit"] = None
            base["flushHistory"] = []
        base["lastFlushResult"] = self._last_flush_result
        # Market Watch document pipeline (candles / decisions / EOD report).
        try:
            from services import market_watch_doc_buffer

            base["marketWatch"] = market_watch_doc_buffer.stats()
        except Exception as exc:
            self.record_error("market_watch_status_error", str(exc))
            base["marketWatch"] = None
        try:
            from services import pipeline_latency

            base["pipelineLatency"] = pipeline_latency.stats()
        except Exception:
            base["pipelineLatency"] = None
        # Tick Persistence Policy status (for Service page)
        # Keys come from TICK_PERSISTENCE_PERMISSIONS so the API, the settings
        # surface and this snapshot can never drift apart.
        base["tickPersistence"] = self.tick_persistence_settings()
        return base


# Module singleton
db_writer_engine = DBWriterEngine()