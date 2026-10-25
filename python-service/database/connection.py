"""Async MongoDB connection manager using Motor.

Architecture
------------
    KAUSTUBH BACKEND  ->  database.connection  ->  MongoDB (Local or Atlas)

There is exactly ONE ``AsyncIOMotorClient`` for the whole process. Every module
reads it through :func:`get_db`, so sockets are pooled and reused and no code
path can open a second connection (or a per-request one).

The database destination is controlled by the MONGODB_URI environment variable:
- mongodb://127.0.0.1:27017/kaustubh        -> Local MongoDB
- mongodb://localhost:27017/kaustubh        -> Local MongoDB
- mongodb+srv://user:pass@cluster.net/db    -> MongoDB Atlas

The URI decides the destination; the application code does not care.
"""

import asyncio
import logging
import time
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo import monitoring as pymongo_monitoring
from pymongo.errors import (
    ConfigurationError as PymongoConfigurationError,
    ConnectionFailure,
    OperationFailure,
    PyMongoError,
    ServerSelectionTimeoutError,
)

from config.settings import MongoDbConfigurationError, settings
from database.migrations import run_startup_migrations, ensure_system_events_unique_index

logger = logging.getLogger("app")

#: The single shared client. ``None`` until connect_mongo() succeeds.
_client: AsyncIOMotorClient | None = None
_db: AsyncIOMotorDatabase | None = None
#: "atlas" while connected, None otherwise. There is no other possible value.
_active_source: str | None = None
#: Real reason the last connect attempt failed (redacted; never a URI).
_last_error: str | None = None
#: Wall-clock time of the last successful handshake.
_connected_at: float | None = None
#: ``buildInfo`` from the live cluster (server version), filled on connect.
_server_info: dict | None = None
#: Live pool counters, maintained by _AtlasPoolListener.
_pool_stats: dict[str, int] = {"created": 0, "ready": 0, "closed": 0, "checkout_failed": 0, "cleared": 0}


class MongoConnectionError(RuntimeError):
    """MongoDB could not be reached / authenticated.

    Carries a redacted ``reason`` plus operator-facing remediation. Never
    contains the connection string or any credential.
    """

    def __init__(self, reason: str, remediation: str = "", cause: BaseException | None = None) -> None:
        self.reason = reason
        self.remediation = remediation
        message = f"MongoDB connection failed: {reason}"
        if remediation:
            message += f" — {remediation}"
        super().__init__(message)
        self.__cause__ = cause


def _redact_uri(uri: str) -> str:
    """Strip credentials from a MongoDB URI before it touches the logs."""
    try:
        from urllib.parse import urlsplit, urlunsplit
        parts = urlsplit(uri)
        if parts.username or parts.password:
            host = ""
            if parts.hostname:
                host = parts.hostname
                if parts.port:
                    host = f"{host}:{parts.port}"
            netloc = "REDACTED@" + host if host else "REDACTED"
            return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    except Exception:
        pass
    return uri


def _redact(text: str) -> str:
    """Remove any ``scheme://user:pass@host`` fragment found inside free text."""
    import re
    try:
        return re.sub(r"(mongodb(?:\+srv)?://)[^:@/\s]+:[^@/\s]+@", r"\1***:***@", str(text))
    except Exception:
        return str(text)


class _MongoPoolListener(pymongo_monitoring.ConnectionPoolListener):
    """Surface connection-pool churn and pool errors in the backend log.

    Motor/pymongo owns reconnection: it monitors the topology and transparently
    re-establishes sockets after a network drop or a server failover. This
    listener makes that behaviour observable instead of silent.

    Every ``ConnectionPoolListener`` hook MUST be implemented. The pymongo base
    class defines each of them as ``raise NotImplementedError`` and the driver
    dispatches pool events to every registered listener unconditionally, so a
    partial subclass raises two exceptions on EVERY connection checkout/checkin.
    At Data Saver write rates that is thousands of tracebacks per second, which
    floods stderr and burns CPU. The high-frequency no-op hooks below are
    implemented for exactly that reason.
    """

    # -- high-frequency per-operation hooks: intentionally silent ------------
    # (Called twice per database round-trip; logging here would flood the log.)

    def connection_check_out_started(self, event):  # noqa: D102
        return None

    def connection_checked_out(self, event):  # noqa: D102
        return None

    def connection_checked_in(self, event):  # noqa: D102
        return None

    # -- low-frequency lifecycle hooks: observable ---------------------------

    def pool_created(self, event):  # noqa: D102
        _pool_stats["created"] += 1
        logger.info("Mongo pool: CREATED address=%s", event.address)

    def pool_ready(self, event):  # noqa: D102
        logger.info("Mongo pool: READY address=%s", event.address)

    def pool_cleared(self, event):  # noqa: D102
        _pool_stats["cleared"] += 1
        logger.warning("Mongo pool: CLEARED address=%s service_id=%s", event.address, event.service_id)

    def pool_closed(self, event):  # noqa: D102
        logger.info("Mongo pool: CLOSED address=%s", event.address)

    def connection_created(self, event):  # noqa: D102
        logger.debug("Mongo connection: CREATED %s", event.address)

    def connection_ready(self, event):  # noqa: D102
        _pool_stats["ready"] = max(0, _pool_stats["ready"] + 1)
        logger.debug("Mongo connection: READY %s", event.address)

    def connection_closed(self, event):  # noqa: D102
        _pool_stats["ready"] = max(0, _pool_stats["ready"] - 1)
        _pool_stats["closed"] += 1
        if event.reason not in ("stale", "idle"):
            logger.info("Mongo connection: CLOSED %s reason=%s", event.address, event.reason)

    def connection_check_out_failed(self, event):  # noqa: D102
        _pool_stats["checkout_failed"] += 1
        logger.error("Mongo pool: CHECKOUT FAILED reason=%s (%.0fms)", event.reason, event.duration * 1000)


def get_mongo_info() -> dict:
    """Cheap, I/O-free connection metadata for health endpoints.

    Never includes the connection string or any credential — only the source
    label (``local`` or ``atlas``), the database name, the cluster host and the last error.
    """
    return {
        "source": _active_source,
        "database": settings.effective_mongodb_database(),
        "connected": is_mongo_connected(),
        "configured": settings.mongodb_is_configured(),
        "host": settings.mongodb_host(),
        "error": _last_error,
        "connectedAt": _connected_at,
        "serverVersion": (_server_info or {}).get("version"),
        "pool": dict(_pool_stats),
    }


def _audit_pool_listeners() -> None:
    """Warn about any ConnectionPoolListener that pymongo cannot dispatch safely.

    pymongo dispatches pool events to the client's listeners PLUS every
    globally registered one (``pymongo.monitoring.register``). The base
    ``ConnectionPoolListener`` defines every hook as
    ``raise NotImplementedError``, so ANY partial subclass - ours or a
    third party's - raises twice per checkout/checkin and floods stderr at
    Data Saver write rates. Audit once at client build so the offender is
    named in the log instead of appearing as anonymous tracebacks.
    """
    base = pymongo_monitoring.ConnectionPoolListener
    hooks = [h for h in dir(base) if not h.startswith("_") and callable(getattr(base, h, None))]
    listeners = list(pymongo_monitoring._LISTENERS.cmap_listeners) + [_MongoPoolListener()]
    for lst in listeners:
        missing = [h for h in hooks if getattr(lst, h, None) is getattr(base, h, None)]
        name = f"{type(lst).__module__}.{type(lst).__name__}"
        if missing:
            logger.warning(
                "Mongo pool listener %s does not implement %s - pymongo will raise "
                "NotImplementedError on every checkout/checkin",
                name,
                ", ".join(sorted(missing)),
            )
        else:
            logger.info("Mongo pool listener %s implements all %d hooks", name, len(hooks))


def _build_client(uri: str) -> AsyncIOMotorClient:
    """Create the one shared MongoDB client.

    TLS certificate verification stays ON. For mongodb+srv:// URIs, TLS is
    implied. For mongodb:// URIs, the driver handles TLS based on the URI.

    ``tz_aware=True`` means BSON dates come back as timezone-aware UTC instead
    of naive datetimes. That removes the aware/naive mixing that previously
    forced every call site to guess a timezone; ``core.timezones.to_ist``
    converts to IST at the point of use.
    """
    _audit_pool_listeners()
    return AsyncIOMotorClient(
        uri,
        tz_aware=True,
        serverSelectionTimeoutMS=settings.mongodb_server_selection_timeout_ms,
        connectTimeoutMS=settings.mongodb_connect_timeout_ms,
        socketTimeoutMS=settings.mongodb_socket_timeout_ms,
        maxPoolSize=settings.mongodb_max_pool_size,
        minPoolSize=settings.mongodb_min_pool_size,
        maxIdleTimeMS=settings.mongodb_max_idle_time_ms,
        waitQueueTimeoutMS=settings.mongodb_wait_queue_timeout_ms,
        retryWrites=True,
        appname="kaustubh-backend",
        event_listeners=[_MongoPoolListener()],
    )


def _diagnose(exc: BaseException) -> tuple[str, str]:
    """Map a driver error to (reason, remediation) with no credentials.

    The operator needs to know WHICH MongoDB problem this is, not a stack trace.
    """
    if isinstance(exc, ServerSelectionTimeoutError):
        text = _redact(exc)
        if "SSL" in text or "TLS" in text or "handshake" in text:
            return (
                "the MongoDB node completed the TCP connection but failed the TLS handshake "
                "(the server answered with a fatal TLS internal_error alert)",
                "check the MongoDB server state (node certificate / server paused or "
                "recovering) and that egress on TCP 27017 is not being TLS-intercepted; "
                "for Atlas: verify in Atlas UI -> Network Access / Cluster status",
            )
        return (
            "no MongoDB node could be selected before the server-selection timeout",
            "verify the host resolves, the server is active, and TCP 27017 egress "
            "is allowed from this network; for Atlas: verify the SRV host resolves",
        )
    if isinstance(exc, OperationFailure):
        code = getattr(exc, "code", None)
        if code in (18, 13, 11, 8000):
            return (
                f"MongoDB rejected the credentials (MongoDB error code {code})",
                "verify the database user and its password in MONGODB_URI, and that "
                "the user still has readWrite on this database; for Atlas: check Atlas -> Database Access",
            )
        return (f"MongoDB returned an error for the connection attempt (code {code})", "check the MongoDB server and network access list")
    if isinstance(exc, PymongoConfigurationError):
        return (
            "the MongoDB connection string is malformed",
            "MONGODB_URI must be a valid mongodb://... or mongodb+srv://... URI",
        )
    if isinstance(exc, ConnectionFailure):
        return ("the MongoDB connection was refused or dropped", "check network egress to TCP 27017 and the server network access list; for Atlas: check Atlas Network Access list")
    return (f"{type(exc).__name__}: {_redact(exc)}", "see the backend log for the full traceback")


async def _handshake(uri: str) -> AsyncIOMotorClient:
    """Connect + verify with a bounded retry, then return the live client.

    The retry exists only for the INITIAL handshake: a brand-new server or an
    in-progress node failover can need a couple of seconds. After the bounded
    attempts the failure is raised loudly.
    """
    attempts = max(1, settings.mongodb_connect_attempts)
    delay = max(0.0, settings.mongodb_connect_retry_delay_s)
    last_exc: BaseException | None = None

    for attempt in range(1, attempts + 1):
        client = _build_client(uri)
        try:
            await client.admin.command("ping")
            return client
        except BaseException as exc:  # noqa: BLE001 - re-raised below
            last_exc = exc
            try:
                client.close()
            except Exception:
                pass
            if attempt < attempts:
                logger.warning(
                    "MongoDB handshake attempt %d/%d failed: %s — retrying in %.1fs",
                    attempt, attempts, _redact(exc), delay,
                )
                await asyncio.sleep(delay)

    reason, remediation = _diagnose(last_exc) if last_exc else ("unknown error", "")
    raise MongoConnectionError(
        f"{reason} (after {attempts} attempt{'s' if attempts != 1 else ''})",
        remediation,
        cause=last_exc,
    )


async def connect_mongo() -> None:
    """Open the single MongoDB connection and prepare the database.

    Raises:
        MongoDbConfigurationError: MONGODB_URI is missing/invalid.
        MongoConnectionError: MongoDB is unreachable or rejected the credentials.
    """
    global _client, _db, _active_source, _last_error, _connected_at, _server_info
    if _client is not None:
        return

    # Fail fast on CONFIGURATION before touching the network.
    config_error = settings.mongodb_config_error()
    if config_error:
        _last_error = config_error
        logger.error("MongoDB is not configured: %s", config_error)
        raise MongoDbConfigurationError(config_error)

    uri = settings.resolved_mongodb_uri()
    source = settings.mongodb_source()
    database = settings.effective_mongodb_database()
    host = settings.mongodb_host() or _redact_uri(uri)
    logger.info(
        "MongoDB: CONNECTING source=%s db=%s host=%s (credentials redacted)",
        source, database, host,
    )

    try:
        client = await _handshake(uri)
    except MongoConnectionError as exc:
        _last_error = str(exc)
        # Loud, with remediation, and with the redacted URI for correlation.
        logger.error("MongoDB unavailable: %s | redacted_uri=%s", exc, _redact_uri(uri))
        raise

    _client = client
    _db = client[database]
    _active_source = source
    _last_error = None
    _connected_at = time.time()

    try:
        _server_info = await client.admin.command("buildInfo")
    except Exception as exc:  # non-fatal: version is informational only
        logger.debug("buildInfo unavailable: %s", exc)
        _server_info = None

    # Log the SOURCE only — the URI (credentials) must never reach logs.
    logger.info(
        "MongoDB: CONNECTED source=%s db=%s server=%s",
        source, database, (_server_info or {}).get("version", "unknown"),
    )

    # Ledger migrations/repair BEFORE indexes: a duplicate event_id would make
    # the unique-index creation throw and kill the whole startup.
    try:
        _migrations = await run_startup_migrations(_db)
        for _m in _migrations:
            logger.info("MIGRATION %s -> %s", _m.get("name"), _m)
    except Exception as exc:
        _last_error = f"startup migration failed: {_redact(exc)}"
        logger.error("MongoDB startup migrations failed: %s", exc)
        raise

    await _ensure_indexes()
    logger.info("Indexes: READY (db=%s)", database)
    try:
        from services.notification_center import emit_event as record_event
        record_event(
            "database", "DATABASE_CONNECTED", "info",
            f"MongoDB ({source}) connection established",
            {"reason": "connected", "reason_code": "db_connected",
             "component": "mongodb", "provider": f"mongodb-{source}",
             "details": database},
        )
    except Exception:
        logger.debug("DATABASE_CONNECTED event not recorded")


async def disconnect_mongo() -> None:
    global _client, _db, _active_source, _connected_at, _server_info
    if _client is not None:
        source = _active_source or "unknown"
        try:
            from services.notification_center import emit_event as record_event
            record_event(
                "database", "DATABASE_DISCONNECTED", "info",
                f"MongoDB ({source}) connection closed",
                {"reason": "disconnected", "reason_code": "db_disconnected",
                 "component": "mongodb", "provider": f"mongodb-{source}"},
            )
        except Exception:
            logger.debug("DATABASE_DISCONNECTED event not recorded")
        try:
            _client.close()
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("MongoDB client close raised: %s", exc)
        _client = None
        _db = None
        _active_source = None
        _connected_at = None
        _server_info = None
        logger.info("MongoDB disconnected")


def get_db() -> AsyncIOMotorDatabase:
    if _db is None:
        raise RuntimeError(
            "MongoDB is not connected — call connect_mongo() first "
            f"({_last_error or 'connection not established'})"
        )
    return _db


def is_mongo_connected() -> bool:
    """True when the shared MongoDB client exists and is bound to a live loop.

    This reflects the *driver* state only. Endpoints that need to be certain the
    server is actually reachable must ping — see ping_mongo().
    """
    if _client is None:
        return False
    try:
        return _client.get_io_loop() is not None
    except Exception:  # pragma: no cover - defensive
        return False


async def ping_mongo(timeout_s: float = 3.0) -> dict:
    """Live MongoDB reachability + query-capability probe for the health check.

    Proves three things with real round-trips (never a fabricated value):
    connection state, ``ping``, and an actual query (``list_collection_names``).
    """
    database = settings.effective_mongodb_database()
    result: dict[str, Any] = {
        "ok": False,
        "pingMs": None,
        "queryOk": False,
        "collections": None,
        "error": None,
        "source": _active_source,
        "database": database,
        "serverVersion": (_server_info or {}).get("version"),
    }
    if _db is None:
        result["error"] = _last_error or "not connected"
        return result

    started = time.monotonic()
    try:
        await asyncio.wait_for(_db.command("ping"), timeout=timeout_s)
        result["pingMs"] = round((time.monotonic() - started) * 1000, 2)
        result["ok"] = True
    except Exception as exc:
        result["error"] = _redact(exc)
        return result

    try:
        # A real read against the catalog: proves query capability, not just a ping.
        names = await asyncio.wait_for(_db.list_collection_names(), timeout=timeout_s)
        result["queryOk"] = True
        result["collections"] = len(names)
    except Exception as exc:
        result["error"] = _redact(exc)

    return result


async def _ensure_indexes() -> None:
    db = get_db()
    # Guard the whole index phase. Index creation is a PERFORMANCE concern, not
    # a correctness one, but a failure here used to propagate out of the
    # FastAPI lifespan and abort startup, taking the entire API down (so search,
    # instrument selection and the market-data WebSocket all died with it).
    # A storage-quota-exhausted / write-blocked cluster rejects EVERY write, so
    # probing the first index tells us the rest would fail too: log it honestly
    # and continue serving. Indexes are re-ensured on the next start.
    try:
        await db.ticks.create_index([("ts", -1)], background=True)
    except Exception as exc:
        logger.error(
            "Indexes: SKIPPED - cluster refused index creation (%s). Starting "
            "without indexes; they are re-ensured on the next start once "
            "storage is available.", _redact(exc),
        )
        return
    await db.ticks.create_index([("symbol", 1), ("ts", -1)], background=True)
    await db.ticks.create_index([("instrumentToken", 1), ("ts", 1)],  background=True)
    # audit_trail is append-only; ts-range scans (Data Center per-day audit
    # trail + recent_from_db sort) benefit from an indexed ts.
    await db.audit_trail.create_index([("ts", -1)], background=True)
    await db.audit_trail.create_index([("terminal", 1), ("ts", -1)], background=True)
    await db.stocks.create_index("symbol", unique=True, background=True)
    await db.stocks.create_index("internalIndex", unique=True, background=True)
    await db.stocks.create_index("active", background=True)
    await db.app_logs.create_index([("ts", -1)], background=True)
    await db.app_logs.create_index("category", background=True)
    await db.notifications.create_index("read", background=True)
    await db.app_settings.create_index("key", unique=True, background=True)
    # One session document per Dummy terminal per trading date (09:00 IST
    # fresh-day lifecycle). Unique => the idempotent open can never duplicate.
    await db.dummy_daily_sessions.create_index(
        [("terminal", 1), ("trading_date", 1)], unique=True, background=True)
    await db.dummy_daily_sessions.create_index(
        [("status", 1), ("trading_date", -1)], background=True)
    await db.watchlist.create_index("symbol", unique=True, background=True)
    await db.watchlist.create_index("favorite", background=True)
    await db.watchlist.create_index("watchlist_id", background=True)
    await db.watchlist.create_index([("watchlist_id", 1), ("token", 1)], background=True)
    await db.daily_summaries.create_index("date", unique=True, background=True)
    await db.download_history.create_index([("ts", -1)], background=True)
    await db.download_history.create_index("format", background=True)
    await db.download_history.create_index("source", background=True)
    await db.download_history.create_index("fileId", background=True)
    await db.export_jobs.create_index([("createdAt", -1)], background=True)
    await db.export_jobs.create_index("status", background=True)
    await db.scheduled_downloads.create_index("enabled", background=True)
    await db.scheduled_downloads.create_index("nextRun", background=True)
    await db.schedule_runs.create_index([("runAt", -1)], background=True)
    await db.schedule_runs.create_index("scheduleId", background=True)
    await db.schedule_runs.create_index("idempotencyKey", background=True)
    await db.package_downloads.create_index([("createdAt", -1)], background=True)
    await db.package_downloads.create_index("scheduleId", background=True)
    await db.package_downloads.create_index("status", background=True)
    await db.system_events.create_index([("ts", -1)], background=True)
    await db.system_events.create_index("source", background=True)
    await db.system_events.create_index("event", background=True)
    await db.events.create_index([("ts", -1)], background=True)
    # Market Watch: the engine persists one doc per eligibility decision through
    # the DB Writer; /history reads and sorts exactly these fields.
    await db.market_watch_decisions.create_index([("blocked_at", -1)], background=True)
    await db.market_watch_decisions.create_index([("date", 1), ("blocked_at", -1)], background=True)
    await db.market_watch_decisions.create_index("symbol", background=True)
    await db.market_watch_decisions.create_index("instrumentToken", background=True)
    # Market Watch ticks (market_ticks): written append-only by the DB Writer and
    # read back by date/symbol windows. ``_id`` is already unique as
    # "<symbol>:<epoch_ms>", so these are the only secondary indexes needed.
    await db.market_ticks.create_index([("date", 1), ("lastTickAt", -1)], background=True)
    await db.market_ticks.create_index([("symbol", 1), ("lastTickAt", -1)], background=True)
    await db.market_ticks.create_index([("instrumentToken", 1), ("lastTickAt", -1)], background=True)
    # Candle recovery (doc §21) reads every timeframe collection by
    # ``{date, instrumentToken: $in}``; upserts key on the deterministic _id.
    for _tf in ("1m", "5m", "10m", "30m"):
        await db[f"market_candles_{_tf}"].create_index(
            [("date", 1), ("instrumentToken", 1)], background=True,
        )

    # ---- Notifications (7-day retention via TTL on ts) ----
    await db.notifications.create_index([("created_at", -1)], background=True)
    await db.notifications.create_index("severity", background=True)
    await db.notifications.create_index("category", background=True)
    await db.notifications.create_index("source", background=True)
    await db.notifications.create_index("event_type", background=True)
    try:
        await db.notifications.create_index(
            [("ts", -1)],
            name="ts_ttl_notifications",
            expireAfterSeconds=7 * 24 * 3600,
            background=True,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Notifications TTL index: %s", exc)

    # ---- Data Quality collections ----
    await db.quality_snapshot.create_index([("ts", -1)], background=True)
    await db.quality_snapshot.create_index([("session", 1), ("ts", -1)], background=True)
    await db.quality_snapshot.create_index([("symbol", 1), ("ts", -1)], background=True)
    await db.quality_issues.create_index([("ts", -1)], background=True)
    await db.quality_issues.create_index("status", background=True)
    await db.quality_issues.create_index("severity", background=True)
    await db.quality_issues.create_index("dimension", background=True)
    await db.quality_issues.create_index("symbol", background=True)
    await db.quality_issues.create_index([("key", 1), ("status", 1)], background=True)
    await db.quality_issues.create_index("last_seen", background=True)
    await db.quality_scans.create_index([("started_at", -1)], background=True)
    await db.quality_scans.create_index("status", background=True)

    # ---- WebSocket history & events (7-day retention) ----
    await db.websocket_history.create_index([("connected_at", -1)], background=True)
    await db.websocket_history.create_index([("disconnected_at", -1)], background=True)
    await db.websocket_history.create_index([("created_at", -1)], background=True)
    await db.websocket_history.create_index("connection_id", unique=True, background=True)
    await db.websocket_history.create_index("status", background=True)
    await db.websocket_history.create_index("date", background=True)
    try:
        await db.websocket_history.create_index(
            [("connected_at", 1)],
            name="connected_at_ttl",
            expireAfterSeconds=7 * 24 * 3600,
            background=True,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("WebSocket history TTL index: %s", exc)

    await db.websocket_events.create_index([("timestamp", -1)], background=True)
    await db.websocket_events.create_index("connection_id", background=True)
    await db.websocket_events.create_index("event_type", background=True)
    try:
        await db.websocket_events.create_index(
            [("timestamp", 1)],
            name="timestamp_ttl",
            expireAfterSeconds=7 * 24 * 3600,
            background=True,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("WebSocket events TTL index: %s", exc)

    # ---- Data SAVer Insights collections ----
    # Canonical append-only event ledger (never TTL'd — audit trail).
    # The event_id index MUST be unique and is created AFTER duplicate repair
    # (see database.migrations) — never before.
    await ensure_system_events_unique_index(db)
    await db.system_events.create_index("category", background=True)
    await db.system_events.create_index("severity", background=True)
    await db.system_events.create_index([("market_date", 1), ("ts", -1)], background=True)
    await db.system_events.create_index("connection_id", background=True)
    await db.system_events.create_index("session_id", background=True)
    await db.system_events.create_index("symbol", background=True)
    await db.system_events.create_index("token", background=True)

    # Tick pipeline + WebSocket telemetry buckets (30-day retention).
    await db.data_saver_telemetry.create_index("bucket", unique=True, background=True)
    await db.data_saver_telemetry.create_index([("ts", 1), ("bucket", 1)], background=True)
    try:
        await db.data_saver_telemetry.create_index(
            [("ts", 1)],
            name="ts_ttl_data_saver_telemetry",
            expireAfterSeconds=30 * 24 * 3600,
            background=True,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Data saver telemetry TTL index: %s", exc)

    # API request telemetry (30-day retention).
    await db.api_telemetry.create_index(
        [("bucket", 1), ("route", 1)], unique=True, background=True)
    await db.api_telemetry.create_index("route", background=True)
    await db.api_telemetry.create_index([("ts", -1)], background=True)
    try:
        await db.api_telemetry.create_index(
            [("ts", 1)],
            name="ts_ttl_api_telemetry",
            expireAfterSeconds=30 * 24 * 3600,
            background=True,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("API telemetry TTL index: %s", exc)

    # Incidents (grouped failure lifecycles).
    await db.data_saver_incidents.create_index("incident_id", unique=True, background=True)
    await db.data_saver_incidents.create_index(
        [("kind", 1), ("status", 1)], background=True)
    await db.data_saver_incidents.create_index([("detected_at", -1)], background=True)
    await db.data_saver_incidents.create_index("status", background=True)

    # Reports (daily + weekly archives).
    await db.data_saver_daily_reports.create_index("report_id", unique=True, background=True)
    await db.data_saver_daily_reports.create_index("report_date", background=True)
    await db.data_saver_daily_reports.create_index(
        [("report_type", 1), ("report_date", -1)], background=True)
    await db.data_saver_weekly_reports.create_index("report_id", unique=True, background=True)
    await db.data_saver_weekly_reports.create_index("weeks", background=True)

    # Data Center persisted snapshots (DB growth / storage trend history).
    await db.data_center_snapshots.create_index([("ts", -1)], background=True)
    await db.data_center_snapshots.create_index("istDay", background=True)

    # Session Manager Engine (Phase 3) — canonical instrument / event / revision
    # collections. Best-effort: never block startup on index failures (the
    # store also lazily ensures them).
    try:
        from services.session import instrument_store
        await instrument_store.ensure_indexes(db)
        logger.info("Indexes: session_manager_* collections ensured")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Session Manager indexes failed: %s", exc)

    logger.info("MongoDB indexes ensured")


# --- Test database support -----------------------------------------------------
# These functions allow integration tests to use a completely separate MongoDB
# database (controlled by MONGODB_TEST_URI) so they never touch production data.
# The test database client is independent of the main application client.

_test_client: AsyncIOMotorClient | None = None
_test_db: AsyncIOMotorDatabase | None = None


async def connect_test_mongo() -> AsyncIOMotorDatabase:
    """Open a MongoDB connection for TESTS ONLY.

    Uses MONGODB_TEST_URI if configured, otherwise falls back to the main
    MONGODB_URI. Returns the test database handle.

    This is completely separate from the application's connect_mongo() / get_db()
    so tests can run against a throwaway database without affecting production.
    """
    global _test_client, _test_db

    if _test_client is not None:
        return _test_db  # type: ignore[return-value]

    test_uri = settings.resolved_mongodb_test_uri()
    if not test_uri:
        # Fall back to main URI for backwards compatibility with existing tests
        test_uri = settings.resolved_mongodb_uri()

    database = settings.effective_mongodb_test_database()

    logger.info(
        "MongoDB TEST: CONNECTING db=%s (credentials redacted)",
        database,
    )

    _test_client = AsyncIOMotorClient(
        test_uri,
        tz_aware=True,
        serverSelectionTimeoutMS=settings.mongodb_server_selection_timeout_ms,
        connectTimeoutMS=settings.mongodb_connect_timeout_ms,
        socketTimeoutMS=settings.mongodb_socket_timeout_ms,
        maxPoolSize=settings.mongodb_max_pool_size,
        minPoolSize=settings.mongodb_min_pool_size,
        maxIdleTimeMS=settings.mongodb_max_idle_time_ms,
        waitQueueTimeoutMS=settings.mongodb_wait_queue_timeout_ms,
        retryWrites=True,
        appname="kaustubh-test",
    )

    try:
        await _test_client.admin.command("ping")
    except Exception as exc:
        logger.error("MongoDB TEST connection failed: %s", exc)
        _test_client.close()
        _test_client = None
        raise

    _test_db = _test_client[database]
    logger.info("MongoDB TEST: CONNECTED db=%s", database)
    return _test_db


async def disconnect_test_mongo() -> None:
    """Close the test MongoDB connection."""
    global _test_client, _test_db
    if _test_client is not None:
        _test_client.close()
        _test_client = None
        _test_db = None
        logger.info("MongoDB TEST disconnected")


def get_test_db() -> AsyncIOMotorDatabase:
    """Get the test database handle. Call connect_test_mongo() first."""
    if _test_db is None:
        raise RuntimeError(
            "Test MongoDB is not connected — call connect_test_mongo() first"
        )
    return _test_db


def is_test_mongo_connected() -> bool:
    """True when the test MongoDB client exists and is bound to a live loop."""
    if _test_client is None:
        return False
    try:
        return _test_client.get_io_loop() is not None
    except Exception:
        return False

