"""CRUD API for the unified user-defined event scheduler (Schedules page).

Path base: ``/api/sched-events`` — a sibling of the downloads engine's
``/api/scheduled-downloads``. Every event kind maps to a REAL backend hook
(``services/event_scheduler.py`` — the registry is exhaustive and honest:
there is no "custom shell command" kind). On-device notification policy rides
each event; the countdown itself is computed client-side from ``nextRun``.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from services.event_scheduler import (
    KINDS,
    RUNS_COLL,
    EVENTS_COLL,
    _validate_notify,
    _validate_params,
    _validate_schedule,
    compute_next_run,
    get_event_scheduler,
)

logger = logging.getLogger("app.sched_events")

router = APIRouter(prefix="/api/sched-events", tags=["sched-events"])


class CreateEventRequest(BaseModel):
    name: str
    kind: str
    enabled: bool = True
    schedule: dict
    params: dict = {}
    notify: dict = {}


class UpdateEventRequest(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    kind: Optional[str] = None
    schedule: Optional[dict] = None
    params: Optional[dict] = None
    notify: Optional[dict] = None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc).isoformat()
    return str(value)


def _serialize(doc: dict) -> dict:
    out = dict(doc)
    out["_id"] = str(doc["_id"])
    for key in ("nextRun", "lastRun", "completedAt", "createdAt", "updatedAt"):
        out[key] = _iso(doc.get(key))
    return out


def _oid(raw: str) -> Any:
    """Stored ids are uuid-hex strings; anything 24-hex may be an ObjectId."""
    raw = str(raw or "")
    if len(raw) == 24:
        try:
            return ObjectId(raw)
        except InvalidId:
            pass
    return raw


@router.get("/kinds")
async def list_kinds():
    """The honest action registry — what the Create form is allowed to build."""
    return {
        "ok": True,
        "kinds": [
            {
                "kind": kind,
                "label": meta["label"],
                "description": meta["description"],
                "requiresConfirm": meta["requiresConfirm"],
            }
            for kind, meta in KINDS.items()
        ],
    }


@router.get("/runs")
async def run_history(
    eventId: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    from database.connection import get_db

    db = get_db()
    query: dict[str, Any] = {}
    if eventId:
        query["eventId"] = eventId
    items = []
    cursor = db[RUNS_COLL].find(query).sort("startedAt", -1).limit(limit)
    async for run in cursor:
        items.append({
            **{k: v for k, v in run.items() if k != "_id"},
            "_id": str(run["_id"]),
            "scheduledAt": _iso(run.get("scheduledAt")),
            "startedAt": _iso(run.get("startedAt")),
            "finishedAt": _iso(run.get("finishedAt")),
        })
    return {"ok": True, "count": len(items), "items": items}


@router.get("")
async def list_events():
    from database.connection import get_db

    get_event_scheduler().ensure_started()
    db = get_db()
    events = []
    async for doc in db[EVENTS_COLL].find({}).sort("nextRun", 1):
        events.append(_serialize(doc))
    return {"ok": True, "count": len(events), "events": events, "serverNow": _iso(_utcnow())}


@router.post("")
async def create_event(payload: CreateEventRequest):
    from database.connection import get_db

    name = payload.name.strip()
    if not name or len(name) > 120:
        raise HTTPException(status_code=422, detail="name must be 1..120 chars")
    if payload.kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"unknown kind '{payload.kind}'")
    schedule, err = _validate_schedule(payload.schedule)
    if err:
        raise HTTPException(status_code=422, detail=err)
    params, err = _validate_params(payload.kind, payload.params)
    if err:
        raise HTTPException(status_code=422, detail=err)
    notify, err = _validate_notify(payload.notify)
    if err:
        raise HTTPException(status_code=422, detail=err)

    db = get_db()
    now = _utcnow()
    doc: dict[str, Any] = {
        "_id": uuid.uuid4().hex,
        "name": name,
        "kind": payload.kind,
        "enabled": bool(payload.enabled),
        "schedule": schedule,
        "params": params,
        "notify": notify,
        "nextRun": compute_next_run(schedule, now) if payload.enabled else None,
        "lastRun": None, "lastStatus": "idle", "lastError": None, "lastResult": None,
        "runCount": 0, "failCount": 0,
        "completedAt": None, "trigger": None,
        "createdAt": now, "updatedAt": now,
    }
    await db[EVENTS_COLL].insert_one(doc)
    from api.scheduled_downloads import _emit

    await _emit("SCHEDULE_CREATED", str(doc["_id"]), name, {"status": "created"})
    return {"ok": True, "event": _serialize(doc)}


@router.get("/{event_id}")
async def get_event(event_id: str):
    from database.connection import get_db

    db = get_db()
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    if doc is None:
        raise HTTPException(status_code=404, detail="event not found")
    return {"ok": True, "event": _serialize(doc)}


@router.put("/{event_id}")
async def update_event(event_id: str, payload: UpdateEventRequest):
    from database.connection import get_db

    db = get_db()
    existing = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    if existing is None:
        raise HTTPException(status_code=404, detail="event not found")

    updates: dict[str, Any] = {"updatedAt": _utcnow()}
    if payload.name is not None:
        name = payload.name.strip()
        if not name or len(name) > 120:
            raise HTTPException(status_code=422, detail="name must be 1..120 chars")
        updates["name"] = name
    kind = existing.get("kind")
    if payload.kind is not None:
        if payload.kind not in KINDS:
            raise HTTPException(status_code=422, detail=f"unknown kind '{payload.kind}'")
        kind = payload.kind
        updates["kind"] = kind
    schedule = existing.get("schedule") or {}
    if payload.schedule is not None:
        schedule, err = _validate_schedule(payload.schedule)
        if err:
            raise HTTPException(status_code=422, detail=err)
        updates["schedule"] = schedule
    params = existing.get("params") or {}
    if payload.params is not None:
        params, err = _validate_params(kind, payload.params)
        if err:
            raise HTTPException(status_code=422, detail=err)
        updates["params"] = params
    notify = existing.get("notify") or {}
    if payload.notify is not None:
        notify, err = _validate_notify(payload.notify)
        if err:
            raise HTTPException(status_code=422, detail=err)
        updates["notify"] = notify
    if payload.enabled is not None:
        updates["enabled"] = bool(payload.enabled)

    enabled = updates["enabled"] if "enabled" in updates else bool(existing.get("enabled"))
    if enabled:
        updates["nextRun"] = compute_next_run(schedule, _utcnow())
    else:
        updates["nextRun"] = None

    await db[EVENTS_COLL].update_one({"_id": _oid(event_id)}, {"$set": updates})
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    return {"ok": True, "event": _serialize(doc)}


@router.delete("/{event_id}")
async def delete_event(event_id: str):
    from database.connection import get_db

    db = get_db()
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    if doc is None:
        raise HTTPException(status_code=404, detail="event not found")
    await db[EVENTS_COLL].delete_one({"_id": _oid(event_id)})
    await db[RUNS_COLL].delete_many({"eventId": str(event_id)})
    from api.scheduled_downloads import _emit

    await _emit("SCHEDULE_DELETED", str(event_id), doc.get("name"), {"status": "deleted"})
    return {"ok": True, "deleted": 1}


@router.post("/{event_id}/toggle")
async def toggle_event(event_id: str):
    from database.connection import get_db

    db = get_db()
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    if doc is None:
        raise HTTPException(status_code=404, detail="event not found")
    enabled = not bool(doc.get("enabled"))
    updates: dict[str, Any] = {"enabled": enabled, "updatedAt": _utcnow()}
    if enabled:
        schedule, err = _validate_schedule(doc.get("schedule") or {})
        if err:
            raise HTTPException(status_code=422, detail=f"event schedule invalid: {err}")
        # re-arm: a re-enabled event always gets a fresh future slot
        updates["nextRun"] = compute_next_run(schedule, _utcnow())
        updates["lastStatus"] = doc.get("lastStatus") or "idle"
    else:
        updates["nextRun"] = None
    await db[EVENTS_COLL].update_one({"_id": _oid(event_id)}, {"$set": updates})
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    return {"ok": True, "event": _serialize(doc), "enabled": enabled}


@router.post("/{event_id}/run")
async def run_now(event_id: str):
    from database.connection import get_db

    db = get_db()
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    if doc is None:
        raise HTTPException(status_code=404, detail="event not found")
    scheduler = get_event_scheduler()
    scheduler.ensure_started()
    result = await scheduler.run_manual(doc)
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    return {"ok": True, "event": _serialize(doc), "run": result}


@router.post("/{event_id}/rearm")
async def rearm_event(event_id: str):
    """Give a completed/disabled one-shot a brand-new future slot."""
    from database.connection import get_db

    db = get_db()
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    if doc is None:
        raise HTTPException(status_code=404, detail="event not found")
    schedule, err = _validate_schedule(doc.get("schedule") or {})
    if err:
        raise HTTPException(status_code=422, detail=f"schedule invalid: {err}")
    nxt = compute_next_run(schedule, _utcnow())
    if schedule["type"] == "once" and nxt is None:
        raise HTTPException(status_code=422, detail="one-shot date already past — edit the date first")
    await db[EVENTS_COLL].update_one(
        {"_id": _oid(event_id)},
        {"$set": {"nextRun": nxt, "enabled": True, "lastStatus": "idle",
                  "lastError": None, "completedAt": None, "updatedAt": _utcnow()}},
    )
    doc = await db[EVENTS_COLL].find_one({"_id": _oid(event_id)})
    return {"ok": True, "event": _serialize(doc)}
