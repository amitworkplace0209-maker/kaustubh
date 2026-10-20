"""SSE stream for scheduler / download lifecycle events.

Browsers connect here (Server-Sent Events) to receive live scheduler and
package events without polling. The stream is a thin projection of the async
event bus in ``services.event_bus``; the scheduler never talks to a WebSocket
instance directly, so there is no ``wsConnection``-style state dependency.

A periodic "heartbeat" frame also re-sends a compact scheduler snapshot so a
freshly-reconnected tab converges immediately.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from services import event_bus

router = APIRouter(prefix="/api/schedule-events", tags=["schedule-events"])
logger = logging.getLogger("app")

HEARTBEAT_S = 15.0


@router.get("/stream")
async def schedule_event_stream(request: Request):
    """Server-Sent Events stream of scheduler/download lifecycle events."""

    async def event_generator():
        q = event_bus.subscribe()
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(q.get(), timeout=HEARTBEAT_S)
                    yield f"data: {frame}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            await event_bus.unsubscribe(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


@router.get("/health")
async def schedule_event_health():
    return {
        "ok": True,
        "subscribers": event_bus.get_event_bus().subscriber_count(),
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }
