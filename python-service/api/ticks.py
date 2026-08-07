"""Tick ingestion + SSE live stream + recent ticks."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from database.connection import get_db
from services import tick_buffer

router = APIRouter(prefix="/api/ticks", tags=["ticks"])
logger = logging.getLogger("app")


class IngestRequest(BaseModel):
    ticks: list[dict]


@router.post("/ingest")
async def ingest_ticks(req: IngestRequest):
    for tick in req.ticks:
        tick_buffer.add(tick)
    return {"accepted": len(req.ticks), "bufferLength": tick_buffer.stats()["bufferLength"]}


@router.post("/log")
async def ingest_log(req: dict):
    category = req.get("category", "system")
    level = req.get("level", "info")
    message = req.get("message", "")
    meta = req.get("meta")
    db = get_db()
    await db.app_logs.insert_one({
        "category": category,
        "level": level,
        "message": message,
        "meta": meta,
        "ts": datetime.now(timezone.utc),
    })
    return {"ok": True}


@router.get("/stream")
async def live_tick_stream(request: Request):
    async def event_generator():
        q = tick_buffer.add_listener()
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    tick = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {json.dumps(tick, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            tick_buffer.remove_listener(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        },
    )


@router.get("/recent")
async def get_recent_ticks(limit: int = 200, symbol: str = ""):
    db = get_db()
    query = {}
    if symbol:
        query["symbol"] = symbol.upper()
    cursor = db.ticks.find(query).sort("ts", -1).limit(min(max(limit, 1), 200))
    ticks = await cursor.to_list(length=200)
    for t in ticks:
        t["_id"] = str(t["_id"])
        if "ts" in t and isinstance(t["ts"], datetime):
            t["ts"] = t["ts"].isoformat()
    return {"data": ticks}

