"""Data Center — observability planes (read-only).

The Data Center page is an observability surface, not a second control plane.
This module adds six *named, read-only* planes to the existing
``services.data_center`` snapshot so the UI can answer, without guessing:

  1. ``database``  — which MongoDB the process is actually talking to right now
                     (identity, server facts, connection pool, storage totals)
  2. ``engines``   — the live Engine Registry restricted to the engines the Data
                     Center documents, each tagged with its authoritative owner
  3. ``topology``  — the real engine dependency graph from the registry
  4. ``dbwriter``  — the DB Writer authoritative pipeline / permission / data-loss
                     snapshot (DB Writer remains the ONLY owner of tick writes)
  5. ``ownership`` — the live collection inventory joined to a code-derived owner
                     map, with an explicit basis per collection
  6. ``retention`` — real TTL indexes, the 06:00 IST cleanup contract and the
                     Data Center's own snapshot retention

Rules enforced here:

* **Read-only.** Nothing in this module writes to MongoDB and nothing mutates
  engine state. It only calls existing read paths and in-memory snapshots.
* **No secrets.** The only connection metadata used is ``get_mongo_info()``,
  which returns the source label, database name, credential-free cluster host,
  server version and pool counters — never a URI, user, password or token.
  ``serverStatus`` is never forwarded raw; only an explicit whitelist of
  numeric/scalar fields is copied out.
* **No fabrication.** Every value is a real measurement or a real configured
  setting. Anything that cannot be read is ``None`` and the owning field carries
  an explicit ``*Available`` / ``*Source`` marker so the frontend can render
  ``N/A`` honestly instead of a made-up number.
* **Single source of truth.** Where another subsystem already owns a value
  (DB Writer, the engine registry, ``api.system.mongo_stats``) this module
  reads *that* value and re-publishes it with its provenance rather than
  recomputing it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from database.connection import get_mongo_info, is_mongo_connected

logger = logging.getLogger("data_center.planes")

NA = "N/A"

# --------------------------------------------------------------------------- #
# Documented provenance
# --------------------------------------------------------------------------- #
SOURCE_DATABASE = "database.connection.get_mongo_info + api.system.mongo_stats + serverStatus whitelist"
SOURCE_ENGINE_REGISTRY = "services.engine_registry.EngineRegistry"
SOURCE_DB_WRITER = "services.db_writer_engine.DBWriterEngine.status_snapshot"
SOURCE_TTL_INDEXES = "MongoDB index_information() expireAfterSeconds"
SOURCE_CLEANUP = "services.atlas_cleanup.get_cleanup_status"
SOURCE_OWNERSHIP = "static write-path audit (services/**.py, api/**.py) joined to live list_collection_names"

#: Engines the Data Center documents as its own observability surface.
#:
#: Every key MUST be the exact ``engine_id`` that the class declares and that
#: ``app.py`` registers in the Engine Registry bootstrap — a key that does not
#: match the registry can never resolve to a live engine, so it is permanently
#: reported as ``NOT_REGISTERED`` while the real engine is reported as
#: ``UNDOCUMENTED``. ``tests/test_data_center_planes.py`` asserts this map
#: covers every declared ``engine_id`` so the two can never drift apart again.
#:
#: This map is what "connects" an engine to the Data Center: it supplies the
#: authoritative owner, the plane the engine answers for and its real endpoint.
DOCUMENTED_ENGINES: dict[str, dict[str, str]] = {
    # -- storage / persistence ------------------------------------------------
    "storage_engine": {
        "owner": "Storage Engine",
        "plane": "host + runtime infrastructure telemetry",
        "endpoint": "/api/services/storage",
    },
    "db_writer_engine": {
        "owner": "DB Writer Engine",
        "plane": "tick persistence pipeline (authoritative writer)",
        "endpoint": "/api/services/engines/db_writer_engine",
    },
    # -- market data ----------------------------------------------------------
    "market_watch": {
        "owner": "Market Watch Engine",
        "plane": "market watch ownership + eligibility state",
        "endpoint": "/api/services/engines/market_watch",
    },
    "websocket_engine": {
        "owner": "WebSocket Engine",
        "plane": "market feed sockets + telemetry persistence",
        "endpoint": "/api/services/engines/websocket_engine",
    },
    "watchlist_engine": {
        "owner": "Watchlist Engine",
        "plane": "personal watchlist state",
        "endpoint": "/api/services/engines/watchlist_engine",
    },
    "feature_engine": {
        "owner": "Feature Engine",
        "plane": "derived feature computation over the tick stream",
        "endpoint": "/api/services/engines/feature_engine",
    },
    "market_coach": {
        "owner": "Market Coach",
        "plane": "session coaching + guidance state",
        "endpoint": "/api/services/engines/market_coach",
    },
    "search_engine": {
        "owner": "Search Engine",
        "plane": "instrument master + symbol search index",
        "endpoint": "/api/services/engines/search_engine",
    },
    # -- control plane --------------------------------------------------------
    "connection_manager": {
        "owner": "Connection Manager",
        "plane": "broker / session connection state",
        "endpoint": "/api/services/engines/connection_manager",
    },
    "session_manager": {
        "owner": "Session Manager",
        "plane": "trading session lifecycle",
        "endpoint": "/api/services/engines/session_manager",
    },
    "notification_engine": {
        "owner": "Notification Engine",
        "plane": "notification + alert delivery state",
        "endpoint": "/api/services/engines/notification_engine",
    },
    "audit_engine": {
        "owner": "Audit Engine",
        "plane": "audit trail persistence",
        "endpoint": "/api/services/engines/audit_engine",
    },
    # -- trading --------------------------------------------------------------
    "squareoff_engine": {
        "owner": "Square-Off Engine",
        "plane": "automatic square-off execution state",
        "endpoint": "/api/services/engines/squareoff_engine",
    },
    # -- facades over subsystems owned by app.py's own startup ---------------
    "scheduler_engine": {
        "owner": "Scheduler",
        "plane": "session schedule + action dispatch (facade)",
        "endpoint": "/api/services/engines/scheduler_engine",
    },
    "order_engine": {
        "owner": "Order Engine",
        "plane": "order placement + lifecycle (facade)",
        "endpoint": "/api/services/engines/order_engine",
    },
    "position_engine": {
        "owner": "Position Engine",
        "plane": "position book state (facade)",
        "endpoint": "/api/services/engines/position_engine",
    },
    "target_engine": {
        "owner": "Target Engine",
        "plane": "per-position monetary targets (facade)",
        "endpoint": "/api/services/engines/target_engine",
    },
    "risk_engine": {
        "owner": "Risk Engine",
        "plane": "pre-execution order validation limits",
        "endpoint": "/api/services/engines/risk_engine",
    },
}

# --------------------------------------------------------------------------- #
# Collection ownership — static, code-derived, explicitly labelled.
#
# Key   : MongoDB collection name
# Value : (owning subsystem, writing module, retention mechanism)
#
# This is a *documentation map*, not a live probe: it is the write-path audit of
# `services/**.py` + `api/**.py`. A collection that exists live but is absent
# here is surfaced with owner ``UNMAPPED`` / ``NOT VERIFIED`` so the UI can say
# so honestly instead of guessing an owner.
# --------------------------------------------------------------------------- #
COLLECTION_OWNERS: dict[str, dict[str, str]] = {
    "ticks": {
        "owner": "DB Writer Engine",
        "module": "services/db_writer_engine.py",
        "retention": "TTL index (per-permission collections) or capped",
        "basis": "db.ticks.bulk_write in DBWriterEngine",
    },
    "market_ticks": {
        "owner": "DB Writer Engine",
        "module": "services/market_watch_doc_buffer.py",
        "retention": "1-day expiry (marketWatchOneDay permission)",
        "basis": "market watch document buffer flush",
    },
    "market_watch_decisions": {
        "owner": "Market Watch Engine",
        "module": "services/market_watch_doc_buffer.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "decision ledger writes",
    },
    "market_watch_filters": {
        "owner": "Market Watch Engine",
        "module": "services/market_watch.py",
        "retention": "user state (no automatic expiry)",
        "basis": "filter insert/delete",
    },
    "scheduler_runs": {
        "owner": "Scheduler",
        "module": "services/scheduler/routes.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "scheduler_runs insert/update by status",
    },
    "schedule_runs": {
        "owner": "Scheduled Downloads",
        "module": "services/scheduled_downloads.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "download backfill run records",
    },
    "scheduled_downloads": {
        "owner": "Scheduled Downloads",
        "module": "services/scheduled_downloads.py",
        "retention": "user state (no automatic expiry)",
        "basis": "job insert/update/delete",
    },
    "package_downloads": {
        "owner": "Scheduled Downloads",
        "module": "services/scheduled_downloads.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "download job history",
    },
    "download_history": {
        "owner": "Scheduled Downloads",
        "module": "services/downloads.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "download_history insert/update/delete",
    },
    "api_telemetry": {
        "owner": "API Telemetry middleware",
        "module": "services/api_telemetry.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "per-minute request/error/latency buckets",
    },
    "websocket_events": {
        "owner": "WebSocket Engine",
        "module": "services/websocket_history_service.py",
        "retention": "delete on disconnect / manual purge",
        "basis": "websocket_events insert/delete",
    },
    "websocket_history": {
        "owner": "WebSocket Engine",
        "module": "services/websocket_history_service.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "per-connection message history",
    },
    "websocket_telemetry": {
        "owner": "WebSocket Engine",
        "module": "services/websocket_history_service.py",
        "retention": "explicit ts cutoff delete",
        "basis": "feed latency / throughput samples",
    },
    "system_events": {
        "owner": "Audit + Notification + Settings + Session Manager",
        "module": "services/audit_engine.py, services/notification_engine.py, services/settings_service.py, services/session_manager.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "shared system event stream (multi-writer)",
    },
    "audit_trail": {
        "owner": "Audit Engine",
        "module": "services/audit_engine.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "audit_trail.insert_one",
    },
    "app_logs": {
        "owner": "Logging Service",
        "module": "services/logs.py",
        "retention": "manual clear",
        "basis": "app_logs write + delete",
    },
    "app_settings": {
        "owner": "Settings Service",
        "module": "services/settings_service.py",
        "retention": "persistent (no automatic expiry)",
        "basis": "key/value upsert + delete",
    },
    "notifications": {
        "owner": "Notification Engine",
        "module": "services/notification_engine.py",
        "retention": "read-cutoff / manual prune",
        "basis": "notifications insert/update/delete",
    },
    "alerts": {
        "owner": "Notification Engine",
        "module": "services/alerts.py",
        "retention": "resolved-alert prune",
        "basis": "alerts insert/update/delete",
    },
    "events": {
        "owner": "Event Bus",
        "module": "services/event_bus.py, services/engine_event_bus.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "in-process + persisted engine events",
    },
    "export_jobs": {
        "owner": "Data Saver Export",
        "module": "services/export_jobs.py",
        "retention": "manual purge",
        "basis": "export_jobs lifecycle (create/update/delete)",
    },
    "basket_orders": {
        "owner": "Baskets",
        "module": "services/baskets.py",
        "retention": "user state (no automatic expiry)",
        "basis": "basket_orders CRUD",
    },
    "stocks": {
        "owner": "Instrument Master",
        "module": "services/stock_fetcher.py, services/instrument_store.py",
        "retention": "persistent (no automatic expiry)",
        "basis": "symbol master upsert",
    },
    "watchlist": {
        "owner": "Watchlist Engine",
        "module": "services/watchlist_engine.py, services/watch_list.py",
        "retention": "user state (no automatic expiry)",
        "basis": "watchlist upsert/delete",
    },
    "watch_hidden": {
        "owner": "Watchlist Engine",
        "module": "services/watch_list.py",
        "retention": "user state (no automatic expiry)",
        "basis": "hidden-symbol state",
    },
    "daily_summaries": {
        "owner": "Statistics / Data Quality",
        "module": "services/statistics.py, services/quality.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "per-day authoritative counters",
    },
    "quality_issues": {
        "owner": "Data Quality",
        "module": "services/quality.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "detected data quality issues",
    },
    "quality_scans": {
        "owner": "Data Quality",
        "module": "services/data_quality.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "scan run records",
    },
    "quality_snapshot": {
        "owner": "Data Quality",
        "module": "services/quality.py",
        "retention": "single current snapshot (upsert)",
        "basis": "latest quality verdict per scope",
    },
    "data_saver_telemetry": {
        "owner": "Data Saver Insights",
        "module": "services/ds_insights.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "data-saver telemetry samples",
    },
    "data_saver_daily_reports": {
        "owner": "Data Saver Insights",
        "module": "services/ds_insights.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "generated daily reports",
    },
    "data_saver_weekly_reports": {
        "owner": "Data Saver Insights",
        "module": "services/ds_insights.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "generated weekly reports",
    },
    "data_saver_incidents": {
        "owner": "Data Saver Insights",
        "module": "services/ds_insights.py",
        "retention": "06:00 IST Atlas cleanup",
        "basis": "data-saver incident records",
    },
    "data_center_snapshots": {
        "owner": "Data Center",
        "module": "services/data_center.py",
        "retention": f"background capture every {600 // 60} min, bounded list",
        "basis": "Data Center's own trend snapshots",
    },
    "engine_config": {
        "owner": "Storage Engine",
        "module": "services/storage_engine.py",
        "retention": "persistent (single document per engine)",
        "basis": "engine config replace_one",
    },
    "dummy_daily_sessions": {
        "owner": "Demo / Dummy Session (non-production)",
        "module": "services/dummy_session.py",
        "retention": "demo data",
        "basis": "dummy session writes",
    },
}

#: ``serverStatus`` sub-document paths copied into the database plane. Whitelist
#: only — the raw command result is never returned, so hostnames, paths and
#: connection strings inside it can never leak.
_SERVER_STATUS_FIELDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("connections", ("current", "available", "totalCreated")),
    ("network", ("bytesIn", "bytesOut", "numRequests")),
    ("opcounters", ("insert", "query", "update", "delete", "command", "getmore")),
    ("opcountersRepl", ("insert", "query", "update", "delete")),
    ("extra_info", ("page_faults",)),
    ("mem", ("resident", "virtual")),
    ("globalLock", ("currentQueue", "clientsWaiting")),
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dig(payload: dict | None, *path: str) -> Any:
    cur: Any = payload or {}
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _index_field(key: Any) -> str | None:
    """Return the leading field of an index key spec.

    pymongo's ``index_information()`` reports ``key`` as a list of
    ``(field, direction)`` pairs, while some drivers/servers report a plain
    ``{field: direction}`` dict. Both shapes are accepted.
    """
    if isinstance(key, dict):
        return next(iter(key), None)
    if isinstance(key, (list, tuple)) and key:
        first = key[0]
        if isinstance(first, (list, tuple)) and first:
            return first[0]
        return first
    return None


async def _server_status_whitelist(db) -> dict[str, Any]:
    """Copy an explicit allow-list of scalar metrics out of ``serverStatus``.

    Returns ``available: False`` (with the real reason) whenever the command
    could not be read — e.g. Atlas tiers that restrict admin commands. An
    unreadable command must never look like "available but empty".
    """
    try:
        raw = await _server_status_raw(db)
    except Exception as exc:
        logger.debug("database plane serverStatus failed: %s", exc)
        return {"available": False, "error": str(exc)}
    if not isinstance(raw, dict) or not raw:
        return {"available": False, "error": "serverStatus returned no document"}

    out: dict[str, Any] = {"available": True, "error": None}
    for group, keys in _SERVER_STATUS_FIELDS:
        values = {k: raw.get(group, {}).get(k) for k in keys}
        if any(v is not None for v in values.values()):
            out[group] = {k: v for k, v in values.items() if v is not None}
    out["uptimeSeconds"] = raw.get("uptime")
    out["process"] = "mongod"
    if out["uptimeSeconds"] is None and len(out) == 2:
        # Nothing from the allow-list was present -> treat as unreadable rather
        # than publishing an "available" payload with no numbers in it.
        return {"available": False, "error": "serverStatus carried no allow-listed metrics"}
    return out


async def _server_status_raw(db) -> dict:
    try:
        return await db.command("serverStatus")
    except Exception as exc:
        # Atlas free/shared tiers restrict serverStatus; that is a real,
        # expected limitation and must be reported as unavailable.
        logger.debug("serverStatus command unavailable: %s", exc)
        return {}


# --------------------------------------------------------------------------- #
# Plane 1 — database
# --------------------------------------------------------------------------- #
async def database_plane() -> dict[str, Any]:
    """Which MongoDB is the process actually using, measured right now."""
    info = get_mongo_info()
    connected = bool(info.get("connected"))
    source_label = info.get("source") or "unknown"

    plane: dict[str, Any] = {
        "plane": "database",
        "source": SOURCE_DATABASE,
        "generatedAt": _now_iso(),
        "available": connected,
        "error": info.get("error"),
        "identity": {
            "connected": connected,
            "source": source_label,
            "sourceLabel": f"mongodb-{source_label}",
            "sourceAvailable": True,
            "database": info.get("database"),
            "databaseAvailable": info.get("database") is not None,
            # Credential-free cluster host (settings.mongodb_host strips userinfo).
            "host": info.get("host") or None,
            "hostAvailable": bool(info.get("host")),
            "serverVersion": info.get("serverVersion"),
            "serverVersionAvailable": info.get("serverVersion") is not None,
            "connectedAt": info.get("connectedAt"),
            "configured": info.get("configured"),
            "error": info.get("error"),
        },
        "pool": info.get("pool") or {},
        "serverStatus": {"available": False, "error": NA},
        "storage": None,
        "collections": None,
    }

    if not connected:
        plane["serverStatus"] = {
            "available": False,
            "error": "MongoDB is not connected",
        }
        return plane

    try:
        plane["serverStatus"] = await _server_status_whitelist(get_db())
    except Exception as exc:
        plane["serverStatus"] = {"available": False, "error": str(exc)}

    # Reuse the already-cached, already-10s-TTL mongo_stats() so the database
    # plane never adds a second collStats sweep of its own.
    try:
        from api.system import mongo_stats

        stats_payload = await mongo_stats()
    except Exception as exc:
        logger.debug("database plane mongo_stats failed: %s", exc)
        stats_payload = {"connected": False, "stats": None, "error": str(exc)}

    stats = stats_payload.get("stats")
    if stats:
        plane["storage"] = {
            "dbName": stats.get("dbName"),
            "collectionsCount": stats.get("collectionsCount"),
            "indexesCount": stats.get("indexesCount"),
            "totalObjects": stats.get("totalObjects"),
            "totalSizeBytes": stats.get("totalSizeBytes"),
            "totalStorageBytes": stats.get("totalStorageBytes"),
            "totalIndexSizeBytes": stats.get("totalIndexSizeBytes"),
            "pingMs": stats.get("pingMs"),
            "lastUpdatedAt": stats.get("lastUpdatedAt"),
        }
        plane["collections"] = stats.get("collections") or []
    else:
        plane["storageError"] = stats_payload.get("error") or "collection statistics unavailable"
        # None (not measured) rather than [] (measured: zero) — a failed
        # collStats sweep must not masquerade as an empty database.
        plane["collections"] = None

    return plane


def get_db():
    from database.connection import get_db as _get_db

    return _get_db()


# --------------------------------------------------------------------------- #
# Plane 2 — engines
# --------------------------------------------------------------------------- #
async def engines_plane() -> dict[str, Any]:
    """Live registry status for the Data Center's documented engine set."""
    plane: dict[str, Any] = {
        "plane": "engines",
        "source": SOURCE_ENGINE_REGISTRY,
        "generatedAt": _now_iso(),
        "documented": [],
        "summary": None,
        "available": False,
        "error": None,
    }

    try:
        from services.engine_registry import get_engine_registry

        registry = get_engine_registry()
        summary = registry.summary()
        graph = registry.dependency_graph()
    except Exception as exc:
        logger.warning("engines plane registry unavailable: %s", exc)
        plane["error"] = str(exc)
        return plane

    plane["available"] = True
    plane["summary"] = summary

    registered: list[dict[str, Any]] = []
    for engine_id, meta in DOCUMENTED_ENGINES.items():
        node = graph.get(engine_id)
        status = registry.get_status(engine_id)
        registered.append(
            {
                "engineId": engine_id,
                "engineName": (status or {}).get("engineName") or (node or {}).get("name"),
                "category": (status or {}).get("engineCategory") or (node or {}).get("category"),
                "version": (status or {}).get("version"),
                "state": (status or {}).get("state") or (node or {}).get("state") or "NOT_REGISTERED",
                "health": (status or {}).get("health") or (node or {}).get("health") or "UNKNOWN",
                "healthReason": (status or {}).get("healthReason"),
                "lastHeartbeat": (status or {}).get("lastHeartbeat"),
                "lastHeartbeatAt": (status or {}).get("lastHeartbeatAt"),
                "uptimeSeconds": (status or {}).get("uptimeSeconds"),
                "dependencies": (node or {}).get("dependencies") or [],
                "dependents": (node or {}).get("dependents") or [],
                "registered": node is not None,
                "owner": meta["owner"],
                "plane": meta["plane"],
                "endpoint": meta["endpoint"],
            }
        )

    # Anything the registry holds that the Data Center has not documented yet
    # is still reported — as UNDOCUMENTED, never dropped.
    for engine_id, node in graph.items():
        if engine_id in DOCUMENTED_ENGINES:
            continue
        status = registry.get_status(engine_id)
        registered.append(
            {
                "engineId": engine_id,
                "engineName": (status or {}).get("engineName") or (node or {}).get("name"),
                "category": (status or {}).get("engineCategory") or (node or {}).get("category"),
                "version": (status or {}).get("version"),
                "state": (status or {}).get("state") or (node or {}).get("state"),
                "health": (status or {}).get("health") or (node or {}).get("health"),
                "healthReason": (status or {}).get("healthReason"),
                "lastHeartbeat": (status or {}).get("lastHeartbeat"),
                "lastHeartbeatAt": (status or {}).get("lastHeartbeatAt"),
                "uptimeSeconds": (status or {}).get("uptimeSeconds"),
                "dependencies": (node or {}).get("dependencies") or [],
                "dependents": (node or {}).get("dependents") or [],
                "registered": True,
                "owner": "UNMAPPED",
                "plane": "NOT DOCUMENTED",
                "endpoint": f"/api/services/engines/{engine_id}",
                "documented": False,
            }
        )

    for entry in registered:
        entry.setdefault("documented", True)

    plane["documented"] = sorted(registered, key=lambda e: str(e.get("category") or ""))
    plane["undocumentedCount"] = sum(1 for e in registered if not e.get("documented"))
    return plane


# --------------------------------------------------------------------------- #
# Plane 3 — topology
# --------------------------------------------------------------------------- #
async def topology_plane() -> dict[str, Any]:
    """The real engine dependency graph: nodes, edges and health roll-up."""
    plane: dict[str, Any] = {
        "plane": "topology",
        "source": SOURCE_ENGINE_REGISTRY,
        "generatedAt": _now_iso(),
        "available": False,
        "error": None,
        "nodes": [],
        "edges": [],
    }

    try:
        from services.engine_registry import get_engine_registry

        registry = get_engine_registry()
        graph = registry.dependency_graph()
        summary = registry.summary()
    except Exception as exc:
        plane["error"] = str(exc)
        return plane

    plane["available"] = True
    plane["summary"] = summary
    plane["nodeCount"] = len(graph)

    edges: list[dict[str, Any]] = []
    for engine_id, node in graph.items():
        plane["nodes"].append(
            {
                "id": engine_id,
                "name": node.get("name"),
                "category": node.get("category"),
                "state": node.get("state"),
                "health": node.get("health"),
                "documented": engine_id in DOCUMENTED_ENGINES,
                "owner": DOCUMENTED_ENGINES.get(engine_id, {}).get("owner", "UNMAPPED"),
                "dependencyCount": len(node.get("dependencies") or []),
                "dependentCount": len(node.get("dependents") or []),
            }
        )
        for dep in node.get("dependencies") or []:
            edges.append(
                {
                    "from": dep,
                    "to": engine_id,
                    "kind": "depends_on",
                    "fromHealth": (graph.get(dep) or {}).get("health") or "NOT_REGISTERED",
                    "toHealth": node.get("health"),
                }
            )

    plane["edges"] = edges
    plane["edgeCount"] = len(edges)
    plane["orphans"] = [
        n["id"] for n in plane["nodes"] if n["dependencyCount"] == 0 and n["dependentCount"] == 0
    ]
    return plane


# --------------------------------------------------------------------------- #
# Plane 4 — DB Writer (authoritative tick pipeline)
# --------------------------------------------------------------------------- #
async def db_writer_plane() -> dict[str, Any]:
    """Republish DB Writer's own snapshot. The Data Center never recomputes it.

    DB Writer Engine is the only writer of tick documents. This plane only
    projects that engine's own counters (pipeline throughput, buffer depth,
    per-permission settings, data-loss reconciliation) so the Data Center shows
    the same numbers the writer shows — not a second opinion.
    """
    plane: dict[str, Any] = {
        "plane": "dbwriter",
        "source": SOURCE_DB_WRITER,
        "authoritative": True,
        "generatedAt": _now_iso(),
        "available": False,
        "error": None,
        "engineId": "db_writer_engine",
    }

    try:
        from services.db_writer_engine import (
            TICK_PERSISTENCE_LABELS,
            TICK_PERSISTENCE_PERMISSIONS,
            db_writer_engine,
            is_tick_persistence_hard_capped,
            storage_cap_reason,
            storage_caps,
        )
    except Exception as exc:
        plane["error"] = str(exc)
        return plane

    try:
        snapshot = db_writer_engine.status_snapshot()
    except Exception as exc:
        plane["error"] = str(exc)
        return plane

    plane["available"] = True
    plane["state"] = snapshot.get("state")
    plane["health"] = snapshot.get("health")
    plane["healthReason"] = snapshot.get("healthReason")
    plane["version"] = snapshot.get("version")
    plane["lastHeartbeat"] = snapshot.get("lastHeartbeat")
    plane["pipeline"] = snapshot.get("pipeline")
    plane["dataLoss"] = snapshot.get("dataLossAccounting")
    plane["instruments"] = snapshot.get("instruments")
    plane["audit"] = snapshot.get("audit")
    plane["marketWatch"] = snapshot.get("marketWatch")
    plane["pipelineLatency"] = snapshot.get("pipelineLatency")
    plane["lastFlushResult"] = snapshot.get("lastFlushResult")
    plane["settings"] = snapshot.get("tickPersistence")

    caps = storage_caps()
    reason = storage_cap_reason()
    plane["permissions"] = [
        {
            "key": key,
            "label": TICK_PERSISTENCE_LABELS.get(key, key),
            "collection": collection,
            "enabled": bool((plane.get("settings") or {}).get(key)),
            "storageCap": bool(caps.get(key)),
            "hardCapped": bool(is_tick_persistence_hard_capped(key)),
            "capReason": reason if caps.get(key) else None,
        }
        for key, collection in TICK_PERSISTENCE_PERMISSIONS.items()
    ]
    plane["capReason"] = reason
    return plane


# --------------------------------------------------------------------------- #
# Plane 5 — collection ownership
# --------------------------------------------------------------------------- #
async def ownership_plane() -> dict[str, Any]:
    """Live collection inventory joined to the code-derived owner map."""
    plane: dict[str, Any] = {
        "plane": "ownership",
        "source": SOURCE_OWNERSHIP,
        "generatedAt": _now_iso(),
        "available": False,
        "error": None,
        "collections": [],
    }

    if not is_mongo_connected():
        plane["error"] = "MongoDB is not connected"
        return plane

    try:
        from api.system import mongo_stats

        payload = await mongo_stats()
    except Exception as exc:
        plane["error"] = str(exc)
        return plane

    stats = payload.get("stats")
    if not stats:
        plane["error"] = payload.get("error") or "collection statistics unavailable"
        return plane

    plane["available"] = True
    db_name = stats.get("dbName")
    by_name = {c.get("name"): c for c in (stats.get("collections") or [])}

    rows: list[dict[str, Any]] = []
    for name, stat in by_name.items():
        meta = COLLECTION_OWNERS.get(name)
        rows.append(
            {
                "name": name,
                "namespace": f"{db_name}.{name}",
                "documents": stat.get("count"),
                "storageBytes": stat.get("storageBytes"),
                "dataSizeBytes": stat.get("dataSizeBytes"),
                "indexSizeBytes": stat.get("indexSizeBytes"),
                "indexes": stat.get("indexes"),
                "capped": stat.get("capped"),
                "firstRecord": stat.get("firstRecord"),
                "lastRecord": stat.get("lastRecord"),
                "owner": (meta or {}).get("owner", "UNMAPPED"),
                "module": (meta or {}).get("module"),
                "retention": (meta or {}).get("retention", "NOT VERIFIED"),
                "basis": (meta or {}).get("basis"),
                "documented": meta is not None,
            }
        )

    # Collections the map documents that are not currently present in the
    # database. Reported (with owner) and explicitly marked absent.
    for name, meta in COLLECTION_OWNERS.items():
        if name in by_name:
            continue
        rows.append(
            {
                "name": name,
                "namespace": f"{db_name}.{name}",
                "documents": None,
                "storageBytes": None,
                "dataSizeBytes": None,
                "indexSizeBytes": None,
                "indexes": None,
                "capped": None,
                "firstRecord": None,
                "lastRecord": None,
                "owner": meta.get("owner"),
                "module": meta.get("module"),
                "retention": meta.get("retention"),
                "basis": meta.get("basis"),
                "documented": True,
                "present": False,
            }
        )
        rows[-1].setdefault("present", True)

    for row in rows:
        row.setdefault("present", True)

    rows.sort(key=lambda r: (-int(r.get("storageBytes") or 0), str(r.get("name"))))
    plane["collections"] = rows
    plane["count"] = len(rows)
    plane["liveCount"] = sum(1 for r in rows if r["present"])
    plane["undocumented"] = [r["name"] for r in rows if not r["documented"]]
    plane["totalStorageBytes"] = sum(int(r.get("storageBytes") or 0) for r in rows if r["present"])
    return plane


# --------------------------------------------------------------------------- #
# Plane 6 — retention
# --------------------------------------------------------------------------- #
async def retention_plane(limit: int = 400) -> dict[str, Any]:
    """Real TTL indexes + the 06:00 IST cleanup contract + snapshot retention."""
    limit = max(1, min(int(limit), 2000))
    plane: dict[str, Any] = {
        "plane": "retention",
        "source": f"{SOURCE_TTL_INDEXES} + {SOURCE_CLEANUP}",
        "generatedAt": _now_iso(),
        "available": False,
        "error": None,
        "ttlIndexes": [],
        "ttlIndexCount": 0,
        "cleanup": None,
        "snapshots": None,
    }

    if is_mongo_connected():
        try:
            db = get_db()
            names = await db.list_collection_names()
        except Exception as exc:
            logger.warning("retention plane list_collection_names failed: %s", exc)
            names = []

        for name in names[:limit]:
            try:
                info = await db[name].index_information()
            except Exception as exc:
                logger.debug("retention index_information failed for %s: %s", name, exc)
                continue
            for index_name, spec in (info or {}).items():
                expire = spec.get("expireAfterSeconds")
                if expire is None:
                    continue
                plane["ttlIndexes"].append(
                    {
                        "collection": name,
                        "index": index_name,
                        "field": _index_field(spec.get("key")),
                        "expireAfterSeconds": expire,
                        "owner": COLLECTION_OWNERS.get(name, {}).get("owner", "UNMAPPED"),
                    }
                )
        plane["ttlIndexCount"] = len(plane["ttlIndexes"])
        plane["scannedCollections"] = min(len(names), limit)
        plane["available"] = True
    else:
        plane["error"] = "MongoDB is not connected"

    try:
        from services import atlas_cleanup

        plane["cleanup"] = await atlas_cleanup.get_cleanup_status()
    except Exception as exc:
        logger.warning("retention plane cleanup status failed: %s", exc)
        plane["cleanup"] = {"ok": False, "error": str(exc)}

    try:
        from services import data_center as _dc

        plane["snapshots"] = {
            "collection": _dc.SNAPSHOT_COLL,
            "intervalSeconds": _dc.SNAPSHOT_INTERVAL_SEC,
            "trendDaysDefault": _dc.TREND_DAYS,
            "owner": "Data Center",
            "running": _dc._snapshot_task is not None and not _dc._snapshot_task.done(),
            "lastCapturedAt": _dc._last_snapshot_at,
            "lastRunOk": _dc._last_snapshot_ok,
        }
    except Exception as exc:
        plane["snapshots"] = {"error": str(exc)}

    return plane


#: Plane name -> builder. Consumed by ``api.data_center`` which owns the TTL
#: cache + single-flight, so planes never fan out duplicate MongoDB work.
PLANES = {
    "database": database_plane,
    "engines": engines_plane,
    "topology": topology_plane,
    "dbwriter": db_writer_plane,
    "ownership": ownership_plane,
    "retention": retention_plane,
}
