"""Read-only live tick SSE stream, recent ticks and in-memory stats.

Tick data is produced exclusively by the real pipeline (Broker WS → WS Engine
→ Connection Manager → DB Writer Engine). The legacy unauthenticated
``POST /api/ticks/ingest`` and ``POST /api/ticks/log`` injection bypasses were
removed: nothing outside the engines may write into the tick buffer or treat
HTTP as a tick source.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from database.connection import get_db
from services import tick_buffer
from services.json_safe import sanitize_for_json

router = APIRouter(prefix="/api/ticks", tags=["ticks"])
logger = logging.getLogger("app")


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
                    # Datetimes (receivedAt / ts) MUST be emitted as ISO-8601 so
                    # browser JSON parsing is exact — never the space-form str().
                    yield f"data: {json.dumps(sanitize_for_json(tick), separators=(',', ':'))}\n\n"
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
    return {"data": sanitize_for_json(ticks)}


@router.get("/stats")
async def get_tick_stats():
    """Lightweight, in-memory-only live tick context for the tick monitor.

    Aggregates the buffer's live rate/latency metrics, the broker WebSocket
    lifecycle, and the scheduler/market state — all from memory, with NO
    MongoDB scans and NO broker API calls. This is what keeps the Live Tick
    Monitor feed fast while still being fully backed by real backend state.
    """
    from ws_socket.ws_manager import ws_manager
    from scheduler import get_scheduler_info, get_scheduler_state

    st = tick_buffer.stats()
    ws = ws_manager.status()
    sched_info = get_scheduler_info()
    sched_state = get_scheduler_state().get("state", "UNKNOWN")

    market_state = {
        "trading_day": sched_info.get("is_trading_day"),
        "market_status": sched_info.get("market_status"),
        "market_session": sched_info.get("market_session"),
    }

    # Compute pipeline state from real backend data
    ws_connected = bool(ws.get("connected"))
    feed_state = ws.get("feed_state", "NO_FEED")
    total_ticks = st.get("totalReceived", 0)
    pipeline_running = st.get("pipelineRunning", False)
    tick_rate = st.get("ticksPerSecond", 0)

    if not pipeline_running:
        pipeline_state = "STOPPED"
    elif not ws_connected:
        pipeline_state = "WAITING_FOR_FEED"
    elif feed_state == "NO_FEED":
        pipeline_state = "WAITING_FOR_FEED"
    elif feed_state == "STALE":
        pipeline_state = "DEGRADED"
    else:
        pipeline_state = "RUNNING"

    return {
        "connected": ws_connected,
        "state": ws.get("state"),
        "connectionState": ws.get("lifecycle_state"),
        "feedState": feed_state,
        "pipelineState": pipeline_state,
        "schedulerState": sched_state,
        "schedulerInfo": sched_info,
        "marketState": market_state,
        "bufferStatus": st,
        "liveData": {
            "ticksPerSecond": tick_rate,
            "writesPerSecond": st.get("writesPerSecond"),
            "activeTickStocks": st.get("activeTickStocks"),
            "lastTickAt": st.get("lastTickAt"),
            "lastWriteAt": st.get("lastWriteAt"),
            "totalReceived": total_ticks,
            "totalWritten": st.get("totalWritten"),
            "totalWriteErrors": st.get("totalWriteErrors"),
        },
        # Comprehensive feed diagnostics — real data from actual SFeed messages
        "diagnostics": ws.get("diagnostics", {}),
        "ws": {
            "connected": ws_connected,
            "state": ws.get("state"),
            "supervisorState": ws.get("supervisor_state"),
            "lifecycleState": ws.get("lifecycle_state"),
            "feedState": ws.get("feed_state"),
            "subscribedCount": ws.get("subscription_count"),
            "registryCount": ws.get("subscription_registry_count"),
            "tickCount": ws.get("tick_count"),
            "reconnectCount": ws.get("reconnect_count"),
            "reconnectAttempt": ws.get("reconnect_attempt"),
            "connectedAt": ws.get("connected_at"),
            "lastTickAt": ws.get("last_tick_at"),
            "lastMessageAt": ws.get("last_message_at"),
            "disconnectReason": ws.get("disconnect_reason"),
            "disconnectReasonCode": ws.get("disconnect_reason_code"),
            "internetOk": ws.get("internet_ok"),
        },
    }

