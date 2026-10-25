"""Atlas cleanup API — real 06:00 IST wipe status + manual trigger.

GET  /api/system/cleanup/status   last run / next run / records deleted
POST /api/system/cleanup/run      manual cleanup pass (idempotent)
                                     body {"mode": "safe"}  (default)
                                     body {"mode": "full"}
                                     body {"mode": "collection",
                                           "names": [...], "drop": false}
GET  /api/system/cleanup/plan     every collection classified protected/
                                  cleanable with real counts
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

    Body ``{"mode": "collection", "names": [...], "drop": false}`` cleans
    exactly the named collections on WHATEVER database the backend is connected
    to (Atlas cloud or a local/VM mongod — the authority uses the live
    connection). ``drop: true`` drops the whole collection (documents + indexes
    + allocated storage reclaimed) instead of keeping the empty shell.
    """
    body = payload or {}
    mode = str(body.get("mode") or "safe").lower()
    if mode == "collection":
        raw_names = body.get("names")
        if not isinstance(raw_names, (list, tuple)) or not raw_names:
            raise HTTPException(status_code=422, detail="mode 'collection' needs a names list")
        result = await atlas_cleanup.run_collection_cleanup(
            names=[str(n) for n in raw_names],
            mode="drop" if body.get("drop") else "clear",
        )
        if result.get("error") == "MongoDB is not connected":
            raise HTTPException(status_code=503, detail="MongoDB is not connected")
        if result.get("error") == "cleanup already running":
            raise HTTPException(status_code=409, detail="cleanup already running")
        return {"ok": bool(result.get("ok")), "data": sanitize_for_json(result)}
    if mode == "full":
        result = await atlas_cleanup.run_full_cleanup(trigger="manual-full")
    else:
        result = await atlas_cleanup.run_cleanup(trigger="manual")
    if result.get("error") == "MongoDB is not connected":
        raise HTTPException(status_code=503, detail="MongoDB is not connected")
    if result.get("error") == "cleanup already running":
        raise HTTPException(status_code=409, detail="cleanup already running")
    return {"ok": bool(result.get("ok")), "data": sanitize_for_json(result)}


@router.get("/plan")
async def cleanup_plan():
    """Every real collection classified for cleanup: protected vs cleanable.

    Counts are live ``count_documents`` results (delete previews are honest),
    and the classification comes from the same protection authority the runs
    enforce — protected names are refused by ``run_collection_cleanup`` in
    both clear and drop modes.
    """
    plan = await atlas_cleanup.list_cleanup_plan()
    if not plan.get("ok") and plan.get("error") == "MongoDB is not connected":
        raise HTTPException(status_code=503, detail="MongoDB is not connected")
    return {"ok": bool(plan.get("ok")), "data": sanitize_for_json(plan)}


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
