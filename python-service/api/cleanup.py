"""Atlas cleanup API — real 06:00 IST wipe status + manual trigger.

GET  /api/system/cleanup/status   last run / next run / records deleted
POST /api/system/cleanup/run      manual cleanup pass (idempotent)
GET  /api/system/cleanup/storage  storage budget guard state
POST /api/system/cleanup/storage  manual storage guard pass

All values come from the persistent ``atlas_cleanup_log`` collection and the
live scheduler — nothing is fabricated. Frontend receives status only, never
database credentials.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from services import atlas_cleanup, storage_guard
from services.json_safe import sanitize_for_json

logger = logging.getLogger("app")

router = APIRouter(prefix="/api/system/cleanup", tags=["cleanup"])


@router.get("/status")
async def cleanup_status():
    """Real cleanup state: last run, next 06:00 IST run, records deleted."""
    status = await atlas_cleanup.get_cleanup_status()
    return {"ok": bool(status.get("ok", True)), "data": sanitize_for_json(status)}


@router.post("/run")
async def cleanup_run(payload: dict | None = None):
    """Manually trigger one cleanup pass.

    Body ``{"mode": "safe"}`` (default, same code path as the 06:00 run) wipes
    temporary market data + telemetry only. ``{"mode": "full"}`` additionally
    wipes ticks history, notifications, alerts, events and reports — config and
    operational collections are never touched in either mode.
    """
    mode = str(((payload or {}).get("mode")) or "safe").lower()
    if mode == "full":
        result = await atlas_cleanup.run_full_cleanup(trigger="manual-full")
    else:
        result = await atlas_cleanup.run_cleanup(trigger="manual")
    if result.get("error") == "MongoDB is not connected":
        raise HTTPException(status_code=503, detail="MongoDB is not connected")
    if result.get("error") == "cleanup already running":
        raise HTTPException(status_code=409, detail="cleanup already running")
    return {"ok": bool(result.get("ok")), "data": sanitize_for_json(result)}


@router.get("/storage")
async def storage_guard_status():
    """Real storage usage vs the configured budget, straight from the server."""
    status = await storage_guard.storage_guard_status()
    return {"ok": bool(status.get("ok", True)), "data": sanitize_for_json(status)}


@router.post("/storage")
async def storage_guard_run():
    """Manually trim oldest regenerable market data if over budget."""
    result = await storage_guard.run_storage_guard(trigger="manual")
    if result.get("reason") == "no_database":
        raise HTTPException(status_code=503, detail="MongoDB is not connected")
    return {"ok": bool(result.get("ok")), "data": sanitize_for_json(result)}
