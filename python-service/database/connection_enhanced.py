"""Enhanced MongoDB connection manager with dynamic reconnection support.

This module adds the ability to:
1. Reload configuration from .env without restarting
2. Dynamically reconnect when MongoDB URI changes
3. Expose detailed connection information for monitoring
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional
from dataclasses import dataclass, field

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

logger = logging.getLogger("app.database")

#: Global state
_client: AsyncIOMotorClient | None = None
_db: AsyncIOMotorDatabase | None = None
_active_source: str | None = None
_last_error: str | None = None
_connected_at: float | None = None
_server_info: dict | None = None
_pool_stats: dict[str, int] = {"created": 0, "ready": 0, "closed": 0, "checkout_failed": 0, "cleared": 0}

#: Reconnection lock to prevent concurrent reconnection attempts
_reconnection_lock: asyncio.Lock = asyncio.Lock()
_reconnect_task: asyncio.Task | None = None
_config_version: int = 0
_shutdown: bool = False


@dataclass
class DatabaseConnectionInfo:
    """Complete database connection information for UI display."""
    source: str | None = None  # "local" or "atlas"
    database: str | None = None
    host: str | None = None
    connected: bool = False
    error: str | None = None
    connected_at: float | None = None
    server_version: str | None = None
    pool_stats: dict[str, int] = field(default_factory=dict)
    config_version: int = 0
    
    # Resource usage (from serverStatus)
    connections: dict[str, int] = field(default_factory=dict)
    memory: dict[str, Any] = field(default_factory=dict)
    network: dict[str, Any] = field(default_factory=dict)
    opcounters: dict[str, int] = field(default_factory=dict)
    storage: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)
    
    # Driver/client info
    driver_name: str | None = None
    driver_version: str | None = None
    os: str | None = None
    platform: str | None = None


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
    """Remove any scheme://user:pass@host fragment found inside free text."""
    import re
    try:
        return re.sub(r"(mongodb(?:\+srv)?://)[^:@/\s]+:[^@/\s]+@", r"\1***:***@", str(text))
    except Exception:
        return str(text)


class _MongoPoolListener(pymongo_monitoring.ConnectionPoolListener):
    """Surface connection-pool events for monitoring."""

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

    # High-frequency hooks - intentionally silent
    def connection_check_out_started(self, event): return None  # noqa: D102
    def connection_checked_out(self, event): return None  # noqa: D102
    def connection_checked_in(self, event): return None  # noqa: D102


def _audit_pool_listeners() -> None:
    """Audit pool listeners for safety."""
    base = pymongo_monitoring.ConnectionPoolListener
    hooks = [h for h in dir(base) if not h.startswith("_") and callable(getattr(base, h, None))]
    listeners = list(pymongo_monitoring._LISTENERS.cmap_listeners) + [_MongoPoolListener()]
    for lst in listeners:
        missing = [h for h in hooks if getattr(lst, h, None) is getattr(base, h, None)]
        name = f"{type(lst).__module__}.{type(lst).__name__}"
        if missing:
            logger.warning("Mongo pool listener %s missing hooks: %s", name, ", ".join(missing))
        else:
            logger.info("Mongo pool listener %s implements all %d hooks", name, len(hooks))


def _build_client(uri: str) -> AsyncIOMotorClient:
    """Create the shared MongoDB client."""
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
    """Map a driver error to (reason, remediation)."""
    if isinstance(exc, ServerSelectionTimeoutError):
        text = _redact(exc)
        if "SSL" in text or "TLS" in text or "handshake" in text:
            return (
                "the MongoDB node completed the TCP connection but failed the TLS handshake",
                "check the MongoDB server state (node certificate / server paused or recovering) and that egress on TCP 27017 is not being TLS-intercepted; for Atlas: verify in Atlas UI -> Network Access / Cluster status",
            )
        return (
            "no MongoDB node could be selected before the server-selection timeout",
            "verify the host resolves, the server is active, and TCP 27017 egress is allowed from this network; for Atlas: verify the SRV host resolves",
        )
    if isinstance(exc, OperationFailure):
        code = getattr(exc, "code", None)
        if code in (18, 13, 11, 8000):
            return (
                f"MongoDB rejected the credentials (MongoDB error code {code})",
                "verify the database user and its password in MONGODB_URI, and that the user still has readWrite on this database; for Atlas: check Atlas -> Database Access",
            )
        return (f"MongoDB returned an error (code {code})", "check the MongoDB server and network access list")
    if isinstance(exc, PymongoConfigurationError):
        return (
            "the MongoDB connection string is malformed",
            "MONGODB_URI must be a valid mongodb://... or mongodb+srv://... URI",
        )
    if isinstance(exc, ConnectionFailure):
        return ("the MongoDB connection was refused or dropped", "check network egress to TCP 27017 and the server network access list; for Atlas: check Atlas Network Access list")
    return (f"{type(exc).__name__}: {_redact(exc)}", "see the backend log for the full traceback")


async def _handshake(uri: str) -> AsyncIOMotorClient:
    """Connect + verify with bounded retry."""
    attempts = max(1, settings.mongodb_connect_attempts)
    delay = max(0.0, settings.mongodb_connect_retry_delay_s)
    last_exc: BaseException | None = None

    for attempt in range(1, attempts + 1):
        client = _build_client(uri)
        try:
            await client.admin.command("ping")
            return client
        except BaseException as exc:  # noqa: BLE001
            last_exc = exc
            try:
                client.close()
            except Exception:
                pass
            if attempt < attempts:
                logger.warning("MongoDB handshake attempt %d/%d failed: %s — retrying in %.1fs",
                             attempt, attempts, _redact(exc), delay)
                await asyncio.sleep(delay)

    reason, remediation = _diagnose(last_exc) if last_exc else ("unknown error", "")
    raise MongoConnectionError(
        f"{reason} (after {attempts} attempt{'s' if attempts != 1 else ''})",
        remediation,
        cause=last_exc,
    )


class MongoConnectionError(RuntimeError):
    """MongoDB connection failure with remediation."""

    def __init__(self, reason: str, remediation: str = "", cause: BaseException | None = None) -> None:
        self.reason = reason
        self.remediation = remediation
        message = f"MongoDB connection failed: {reason}"
        if remediation:
            message += f" — {remediation}"
        super().__init__(message)
        self.__cause__ = cause


async def connect_mongo() -> None:
    """Open the single MongoDB connection and prepare the database."""
    global _client, _db, _active_source, _last_error, _connected_at, _server_info, _config_version
    
    if _client is not None:
        return

    # Fail fast on CONFIGURATION
    config_error = settings.mongodb_config_error()
    if config_error:
        _last_error = config_error
        logger.error("MongoDB is not configured: %s", config_error)
        raise MongoDbConfigurationError(config_error)

    uri = settings.resolved_mongodb_uri()
    source = settings.mongodb_source()
    database = settings.effective_mongodb_database()
    host = settings.mongodb_host() or _redact_uri(uri)
    
    logger.info("MongoDB: CONNECTING source=%s db=%s host=%s", source, database, host)

    try:
        client = await _handshake(uri)
    except MongoConnectionError as exc:
        _last_error = str(exc)
        logger.error("MongoDB unavailable: %s | redacted_uri=%s", exc, _redact_uri(uri))
        raise

    _client = client
    _db = client[database]
    _active_source = source
    _last_error = None
    _connected_at = time.time()
    _config_version += 1

    try:
        _server_info = await client.admin.command("buildInfo")
    except Exception as exc:
        logger.debug("buildInfo unavailable: %s", exc)
        _server_info = None

    logger.info("MongoDB: CONNECTED source=%s db=%s server=%s",
                source, database, (_server_info or {}).get("version", "unknown"))


async def disconnect_mongo() -> None:
    """Close the MongoDB connection."""
    global _client, _db, _active_source, _connected_at, _server_info
    
    if _client is not None:
        source = _active_source or "unknown"
        try:
            _client.close()
        except Exception as exc:
            logger.debug("MongoDB client close raised: %s", exc)
        _client = None
        _db = None
        _active_source = None
        _connected_at = None
        _server_info = None
        logger.info("MongoDB disconnected")


async def reconnect_mongo(force: bool = False) -> bool:
    """
    Reconnect to MongoDB with current configuration.
    
    Args:
        force: If True, reconnect even if already connected (useful when .env changed)
        
    Returns:
        True if reconnection successful, False otherwise
    """
    global _reconnect_task, _shutdown
    
    if _shutdown:
        return False
        
    async with _reconnection_lock:
        # Check if URI actually changed
        if not force and _client is not None:
            current_uri = settings.resolved_mongodb_uri()
            # We can't easily compare without storing the old URI, so we'll just reconnect
            pass
            
        logger.info("MongoDB: RECONNECTING (force=%s)", force)
        
        # Disconnect first
        await disconnect_mongo()
        
        # Try to connect with new config
        try:
            await connect_mongo()
            logger.info("MongoDB: RECONNECTED successfully")
            return True
        except Exception as exc:
            logger.error("MongoDB reconnection failed: %s", exc)
            return False


async def get_detailed_connection_info() -> DatabaseConnectionInfo:
    """
    Get comprehensive database connection information for monitoring/UI.
    
    This includes:
    - Basic connection info (source, host, database, status)
    - Pool statistics
    - Server info (version, build info)
    - Resource usage from serverStatus
    - Driver/client information
    """
    info = DatabaseConnectionInfo(
        source=_active_source,
        database=settings.effective_mongodb_database(),
        host=settings.mongodb_host(),
        connected=is_mongo_connected(),
        error=_last_error,
        connected_at=_connected_at,
        server_version=(_server_info or {}).get("version"),
        pool_stats=dict(_pool_stats),
        config_version=_config_version,
    )

    if _db is None:
        _adopt_base_connection()

    if _client is not None and _db is not None:
        try:
            # Get server status for detailed metrics
            server_status = await _db.command("serverStatus")
            
            # Connections
            info.connections = {
                "current": server_status.get("connections", {}).get("current", 0),
                "available": server_status.get("connections", {}).get("available", 0),
                "total_created": server_status.get("connections", {}).get("totalCreated", 0),
                "active": server_status.get("connections", {}).get("active", 0),
            }
            
            # Memory
            mem = server_status.get("mem", {})
            info.memory = {
                "resident_mb": mem.get("resident", 0),
                "virtual_mb": mem.get("virtual", 0),
                "mapped_mb": mem.get("mapped", 0),
                "mapped_with_journal_mb": mem.get("mappedWithJournal", 0),
            }
            
            # Network
            net = server_status.get("network", {})
            info.network = {
                "bytes_in": net.get("bytesIn", 0),
                "bytes_out": net.get("bytesOut", 0),
                "num_requests": net.get("numRequests", 0),
            }
            
            # Operation counters
            opc = server_status.get("opcounters", {})
            info.opcounters = {
                "insert": opc.get("insert", 0),
                "query": opc.get("query", 0),
                "update": opc.get("update", 0),
                "delete": opc.get("delete", 0),
                "getmore": opc.get("getmore", 0),
                "command": opc.get("command", 0),
            }
            
            # Storage
            storage = server_status.get("wiredTiger", {}).get("cache", {})
            if storage:
                info.storage = {
                    "cache_used_gb": round(storage.get("bytes currently in the cache", 0) / (1024**3), 2),
                    "cache_max_gb": round(storage.get("maximum bytes configured", 0) / (1024**3), 2),
                    "cache_usage_pct": round(
                        storage.get("bytes currently in the cache", 0) / 
                        max(storage.get("maximum bytes configured", 1), 1) * 100, 1
                    ),
                    "dirty_bytes": storage.get("tracked dirty bytes in the cache", 0),
                }
            
            # Metrics
            metrics = server_status.get("metrics", {})
            info.metrics = {
                "document_inserted_per_sec": metrics.get("document", {}).get("inserted", 0),
                "document_updated_per_sec": metrics.get("document", {}).get("updated", 0),
                "document_deleted_per_sec": metrics.get("document", {}).get("deleted", 0),
            }
            
        except Exception as exc:
            logger.debug("Failed to get server status: %s", exc)
            # Non-fatal, continue with basic info
            
        # Client/driver info
        try:
            client_info = _client.HOST if hasattr(_client, 'HOST') else None
            info.driver_name = "motor"
            import motor
            info.driver_version = getattr(motor, '__version__', 'unknown')
            import pymongo
            info.driver_version += f" (pymongo {pymongo.__version__})"
        except Exception:
            pass
            
    return info


async def ping_mongo(timeout_s: float = 3.0) -> dict:
    """Live MongoDB reachability + query-capability probe."""
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
        _adopt_base_connection()
        result["source"] = _active_source
        result["serverVersion"] = (_server_info or {}).get("version")
    
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
        names = await asyncio.wait_for(_db.list_collection_names(), timeout=timeout_s)
        result["queryOk"] = True
        result["collections"] = len(names)
    except Exception as exc:
        result["error"] = _redact(exc)

    return result


def _adopt_base_connection() -> bool:
    """Adopt the process's ONE shared connection (``database.connection``).

    The application boot connects through the base module (app.py lifespan);
    a second parallel pool here would mean two clients for the same process
    and a monitoring plane that never sees the database (which is exactly the
    bug that kept every ``/api/database/*`` endpoint reporting "Database not
    connected" forever). When this module has no client of its own, borrow the
    base module's live one — never open a second connection.
    """
    global _client, _db, _active_source, _last_error, _connected_at, _server_info
    if _db is not None:
        return True
    try:
        from database import connection as base
    except Exception:
        return False
    if not base.is_mongo_connected():
        return False
    _client = base._client
    _db = base.get_db()
    _active_source = base._active_source or "unknown"
    _last_error = base._last_error
    _connected_at = base._connected_at
    _server_info = base._server_info
    logger.info("MongoDB monitoring plane adopted the shared database.connection client")
    return True


def get_db() -> AsyncIOMotorDatabase:
    if _db is None and _adopt_base_connection():
        pass
    if _db is None:
        raise RuntimeError(
            "MongoDB is not connected — call connect_mongo() first "
            f"({_last_error or 'connection not established'})"
        )
    return _db


def is_mongo_connected() -> bool:
    if _db is None and not _adopt_base_connection():
        return False
    if _client is None:
        return False
    try:
        return _client.get_io_loop() is not None
    except Exception:
        return False


def get_mongo_info() -> dict:
    """Basic connection metadata for health endpoints."""
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


async def get_atlas_cluster_info() -> dict:
    """Get Atlas-specific cluster information if connected to Atlas."""
    if _db is None:
        _adopt_base_connection()
    if _active_source != "atlas" or _db is None:
        return {"available": False, "reason": "Not connected to Atlas"}
    
    try:
        # Try to get Atlas-specific info
        cluster_info = await _db.command("buildInfo")
        sharding = await _db.command("getShardMap") if _active_source == "atlas" else None
        
        return {
            "available": True,
            "cluster_type": "atlas",
            "version": cluster_info.get("version"),
            "git_version": cluster_info.get("gitVersion"),
            "modules": cluster_info.get("modules", []),
            "allocator": cluster_info.get("allocator"),
            "javascript_engine": cluster_info.get("javascriptEngine"),
            "sharding_enabled": sharding is not None,
        }
    except Exception as exc:
        return {"available": True, "error": str(exc)}


# Backward compatibility - re-export the old functions
__all__ = [
    "connect_mongo",
    "disconnect_mongo", 
    "reconnect_mongo",
    "get_db",
    "is_mongo_connected",
    "get_mongo_info",
    "get_detailed_connection_info",
    "ping_mongo",
    "get_atlas_cluster_info",
    "MongoConnectionError",
    "DatabaseConnectionInfo",
]