"""Storage Engine API — infrastructure / runtime / storage observability.

Exposes the real, normalized state collected by ``services.storage_engine``.
Every value comes from the live backend; unavailable metrics are reported as
``UNAVAILABLE`` with a reason — never fabricated.

Endpoints
---------
GET  /api/services/storage            current normalized infrastructure state
GET  /api/services/storage/history    bounded short-interval snapshots
GET  /api/services/storage/events     meaningful infrastructure events
GET  /api/services/storage/config     monitoring configuration
POST /api/services/storage/config     validate + persist + apply configuration
POST /api/services/storage/snapshot   force one collection (operations/tests)
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Query

from services.json_safe import sanitize_for_json
from services.storage_engine import storage_engine

logger = logging.getLogger("app.storage_api")

router = APIRouter(prefix="/api/services/storage", tags=["storage-engine"])


def _ok(data) -> dict:
    return {"ok": True, "data": sanitize_for_json(data)}


def _bad(message: str) -> dict:
    return {"ok": False, "error": message}


@router.get("")
async def storage_state():
    """Current normalized infrastructure state + engine status."""
    status = storage_engine.status_snapshot()
    return _ok({
        "engine": status,
        "state": storage_engine.current_state(),
    })


@router.get("/history")
async def storage_history(limit: int = Query(120, ge=1, le=10000)):
    return _ok({
        "snapshots": storage_engine.history(limit),
        "count": len(storage_engine.history(limit)),
    })


@router.get("/events")
async def storage_events(limit: int = Query(50, ge=1, le=200)):
    events = storage_engine.events(limit)
    return _ok({"events": events, "count": len(events)})


@router.get("/config")
async def storage_config():
    return _ok({"config": storage_engine.get_config()})


@router.post("/config")
async def storage_update_config(payload: dict = Body(...)):
    try:
        result = await storage_engine.update_config(payload)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("storage config update failed")
        return _bad(str(exc))
    return _ok(result) if result.get("ok") else {
        "ok": False,
        "error": "; ".join(result.get("errors") or ["invalid configuration"]),
        "errors": result.get("errors") or [],
    }


@router.post("/snapshot")
async def storage_snapshot():
    state = await storage_engine.sample_once()
    await storage_engine.health_check()
    return _ok({"state": state, "engine": storage_engine.status_snapshot()})
