"""Database Monitoring API — complete database observability endpoints.

Endpoints:
---------
GET  /api/database/info              Complete connection info for UI
GET  /api/database/status            Basic status (legacy compatible)
GET  /api/database/ping              Live connectivity test
GET  /api/database/cluster           Atlas cluster details (if Atlas)
GET  /api/database/resources         Real-time resource usage
GET  /api/database/collections       Collection stats and sizes
POST /api/database/reconnect         Force reconnection with current .env config
GET  /api/database/config            Current MongoDB configuration
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from config.settings import settings
from database.connection_enhanced import (
    connect_mongo,
    disconnect_mongo,
    reconnect_mongo,
    get_mongo_info,
    get_detailed_connection_info,
    ping_mongo,
    get_atlas_cluster_info,
    is_mongo_connected,
    get_db,
    DatabaseConnectionInfo,
)
from services.json_safe import sanitize_for_json

logger = logging.getLogger("app.database_api")

router = APIRouter(prefix="/api/database", tags=["database"])


def _ok(data: Any) -> dict:
    return {"ok": True, "data": data}


def _bad(message: str) -> dict:
    return {"ok": False, "error": message}


@router.get("/info")
async def database_info():
    """
    Complete database connection information for UI display.
    
    Returns all connection details including:
    - Source (local/atlas), host, database name
    - Connection status and timing
    - Pool statistics
    - Server version and build info
    - Resource usage (connections, memory, network, storage)
    - Operation counters
    """
    try:
        info = await get_detailed_connection_info()
        return _ok(info.__dict__)
    except Exception as exc:
        logger.exception("Failed to get database info")
        return _bad(f"Failed to get database info: {exc}")


@router.get("/status")
async def database_status():
    """Basic database status (legacy compatible)."""
    return _ok(get_mongo_info())


@router.get("/ping")
async def database_ping(timeout: float = Query(3.0, ge=0.5, le=30.0)):
    """Live MongoDB connectivity test with ping and query."""
    result = await ping_mongo(timeout)
    return _ok(result) if result.get("ok") else _bad(result.get("error", "ping failed"))


@router.get("/cluster")
async def database_cluster():
    """Atlas cluster details (only available when connected to Atlas)."""
    info = await get_atlas_cluster_info()
    return _ok(info)


@router.get("/resources")
async def database_resources():
    """
    Real-time database resource usage.
    
    Includes:
    - Connection pool stats
    - Memory usage
    - Network I/O
    - Operation counters
    - Storage engine metrics (WiredTiger cache)
    - Document operation rates
    """
    if not is_mongo_connected():
        return _bad("Database not connected")
    
    try:
        db = get_db()
        server_status = await db.command("serverStatus")
        
        # WiredTiger cache
        wt_cache = server_status.get("wiredTiger", {}).get("cache", {})
        cache_used = wt_cache.get("bytes currently in the cache", 0)
        cache_max = wt_cache.get("maximum bytes configured", 0)
        
        # Connections
        conns = server_status.get("connections", {})
        
        # Memory
        mem = server_status.get("mem", {})
        
        # Operations
        opc = server_status.get("opcounters", {})
        
        # Metrics
        metrics = server_status.get("metrics", {})
        
        # Network
        net = server_status.get("network", {})
        
        # OpcountersRepl (replication)
        opc_repl = server_status.get("opcountersRepl", {})
        
        return _ok({
            "connections": {
                "current": conns.get("current", 0),
                "available": conns.get("available", 0),
                "total_created": conns.get("totalCreated", 0),
                "active": conns.get("active", 0),
                "usage_pct": round(conns.get("current", 0) / max(conns.get("available", 1) + conns.get("current", 0), 1) * 100, 1),
            },
            "memory": {
                "resident_mb": mem.get("resident", 0),
                "virtual_mb": mem.get("virtual", 0),
                "mapped_mb": mem.get("mapped", 0),
            },
            "storage": {
                "wired_tiger_cache": {
                    "used_gb": round(cache_used / (1024**3), 2),
                    "max_gb": round(cache_max / (1024**3), 2),
                    "usage_pct": round(cache_used / max(cache_max, 1) * 100, 1),
                    "dirty_bytes": wt_cache.get("tracked dirty bytes in the cache", 0),
                    "bytes_read_into_cache": wt_cache.get("bytes read into cache", 0),
                    "bytes_written_from_cache": wt_cache.get("bytes written from cache", 0),
                }
            },
            "operations": {
                "insert": opc.get("insert", 0),
                "query": opc.get("query", 0),
                "update": opc.get("update", 0),
                "delete": opc.get("delete", 0),
                "getmore": opc.get("getmore", 0),
                "command": opc.get("command", 0),
                "repl_insert": opc_repl.get("insert", 0),
                "repl_update": opc_repl.get("update", 0),
                "repl_delete": opc_repl.get("delete", 0),
            },
            "metrics": {
                "document_inserted": metrics.get("document", {}).get("inserted", 0),
                "document_updated": metrics.get("document", {}).get("updated", 0),
                "document_deleted": metrics.get("document", {}).get("deleted", 0),
                "cursor_open": metrics.get("cursor", {}).get("open", {}).get("total", 0),
                "cursor_timed_out": metrics.get("cursor", {}).get("timedOut", 0),
            },
            "network": {
                "bytes_in": net.get("bytesIn", 0),
                "bytes_out": net.get("bytesOut", 0),
                "num_requests": net.get("numRequests", 0),
            },
            "server_uptime_seconds": server_status.get("uptime", 0),
            "local_time": server_status.get("localTime"),
        })
    except Exception as exc:
        logger.exception("Failed to get database resources")
        return _bad(f"Failed to get resources: {exc}")


@router.get("/collections")
async def database_collections(
    limit: int = Query(100, ge=1, le=1000),
    include_indexes: bool = Query(False),
):
    """
    Collection statistics and sizes.
    
    Returns per-collection:
    - Document count
    - Size on disk
    - Storage size
    - Index count and size
    - Average document size
    """
    if not is_mongo_connected():
        return _bad("Database not connected")
    
    try:
        db = get_db()
        collections = await db.list_collection_names()
        
        results = []
        for coll_name in collections[:limit]:
            try:
                stats = await db.command("collStats", coll_name)
                results.append({
                    "name": coll_name,
                    "count": stats.get("count", 0),
                    "size_bytes": stats.get("size", 0),
                    "size_mb": round(stats.get("size", 0) / (1024**2), 2),
                    "storage_size_bytes": stats.get("storageSize", 0),
                    "storage_size_mb": round(stats.get("storageSize", 0) / (1024**2), 2),
                    "index_count": stats.get("nindexes", 0),
                    "index_size_bytes": stats.get("totalIndexSize", 0),
                    "index_size_mb": round(stats.get("totalIndexSize", 0) / (1024**2), 2),
                    "avg_obj_size": stats.get("avgObjSize", 0),
                    "capped": stats.get("capped", False),
                    "max_size": stats.get("maxSize", 0),
                })
            except Exception as exc:
                results.append({
                    "name": coll_name,
                    "error": str(exc),
                })
        
        # Sort by storage size descending
        results.sort(key=lambda x: x.get("storage_size_bytes", 0), reverse=True)
        
        total_storage = sum(r.get("storage_size_bytes", 0) for r in results)
        total_docs = sum(r.get("count", 0) for r in results)
        
        return _ok({
            "collections": results,
            "summary": {
                "total_collections": len(results),
                "total_documents": total_docs,
                "total_storage_bytes": total_storage,
                "total_storage_mb": round(total_storage / (1024**2), 2),
            },
        })
    except Exception as exc:
        logger.exception("Failed to get collection stats")
        return _bad(f"Failed to get collections: {exc}")


@router.get("/sample")
async def database_sample(
    collection: str = Query(..., description="Collection name"),
    limit: int = Query(5, ge=1, le=10),
):
    """
    Real document preview: the latest ``limit`` documents of one collection.

    Read-only (never mutates), authenticated against the CURRENT connection —
    works on Atlas, local mongod, or a VM-local mongod alike. Documents are
    sanitized through ``services.json_safe`` so ObjectId/datetime values turn
    into plain JSON strings without fabrication.
    """
    if not is_mongo_connected():
        return _bad("Database not connected")
    try:
        db = get_db()
        existing = await db.list_collection_names()
        if collection not in existing:
            return _bad(f"Unknown collection: {collection}")
        cursor = (
            db[collection]
            .find({})
            .sort("_id", -1)
            .limit(limit)
        )
        docs = await cursor.to_list(limit)
        return _ok({
            "collection": collection,
            "count": int(await db[collection].count_documents({})),
            "limit": limit,
            "samples": sanitize_for_json(docs),
        })
    except Exception as exc:
        logger.exception("Failed to sample collection %s", collection)
        return _bad(f"Failed to sample {collection}: {exc}")


@router.post("/reconnect")
async def database_reconnect(force: bool = Query(True, description="Force reconnection even if connected")):
    """
    Force database reconnection with current .env configuration.
    
    Use this when you've changed MONGODB_URI in .env and want to connect
    to the new database without restarting the backend.
    """
    try:
        success = await reconnect_mongo(force=force)
        if success:
            info = await get_detailed_connection_info()
            return _ok({
                "message": "Reconnected successfully",
                "info": info.__dict__,
            })
        else:
            return _bad("Reconnection failed - check logs for details")
    except Exception as exc:
        logger.exception("Reconnection failed")
        return _bad(f"Reconnection failed: {exc}")


@router.get("/config")
async def database_config():
    """Current MongoDB configuration (redacted)."""
    return _ok({
        "configured": settings.mongodb_is_configured(),
        "source": settings.mongodb_source(),
        "host": settings.mongodb_host(),
        "database": settings.effective_mongodb_database(),
        "database_from_uri": settings.mongodb_database_from_uri(),
        "pool": {
            "max_pool_size": settings.mongodb_max_pool_size,
            "min_pool_size": settings.mongodb_min_pool_size,
            "max_idle_time_ms": settings.mongodb_max_idle_time_ms,
            "wait_queue_timeout_ms": settings.mongodb_wait_queue_timeout_ms,
        },
        "timeouts": {
            "server_selection_ms": settings.mongodb_server_selection_timeout_ms,
            "connect_ms": settings.mongodb_connect_timeout_ms,
            "socket_ms": settings.mongodb_socket_timeout_ms,
        },
        "retry": {
            "attempts": settings.mongodb_connect_attempts,
            "retry_delay_s": settings.mongodb_connect_retry_delay_s,
        },
        "test_database": {
            "configured": settings.mongodb_test_is_configured(),
            "database": settings.effective_mongodb_test_database(),
        },
    })