"""WebSocket diagnostics, history, events & metrics routes."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse

from ws_socket.ws_manager import ws_manager
from services import websocket_history_service as history
from services.state_store import get_state_store, get_snapshot

router = APIRouter(prefix="/api/websocket", tags=["websocket"])
logger = logging.getLogger("websocket")

HEARTBEAT_S = 12.0


def _safe_live_snapshot() -> dict:
    """Live WS monitor frame (never fails the snapshot build)."""
    try:
        return ws_manager.live_snapshot() or {}
    except Exception:
        return {}


async def _build_snapshot() -> dict:
    """Assemble the ONE initial complete state snapshot."""
    from scheduler import get_scheduler_info, get_scheduler_state
    from services.session.session_manager import session_manager
    from services.settings_service import get_setting
    from database.connection import is_mongo_connected
    from brokers.manager import active_terminal, _BROKER_NAMES

    snap = session_manager.snapshot()
    # The per-instrument `subscriptionState` matrix is ~2 MB of rows. No UI
    # component reads `state.session.subscriptionState` from the realtime
    # context, yet it was serialized into EVERY SSE initial snapshot and every
    # `/system/status` reconcile — making first hydration take seconds and each
    # poll multi-megabyte. That is what left the GlobalTopBar indicators stuck
    # on gray/UNKNOWN. The Session Manager still serves the full matrix on
    # /api/system/session for the pages that genuinely need it.
    snap.pop("subscriptionState", None)
    ws = ws_manager.status()
    sched_info = get_scheduler_info()
    sched_state = get_scheduler_state().get("state", "UNKNOWN")

    try:
        from api.system import _check_internet_async
        from services.broker_cache import broker_cache
        internet = await broker_cache.get(
            "internet", _check_internet_async, ttl=60.0, fail_cooldown=60.0, timeout=6.0
        )
    except Exception:
        internet = None

    db_connected = is_mongo_connected()

    return {
        "type": "state_snapshot",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "appConnection": {
            "state": "CONNECTED",
            "heartbeat": HEARTBEAT_S,
        },
        "session": snap,
        "terminal": active_terminal(),
        "terminalBroker": _BROKER_NAMES.get(active_terminal(), active_terminal()),
        "scheduler": {
            "running": bool(sched_info.get("running")),
            "state": sched_state,
            "info": sched_info,
        },
        "websocket": {
            "state": ws.get("state"),
            "supervisorState": ws.get("supervisor_state"),
            "connState": ws.get("state"),
            "lifecycleState": ws.get("lifecycle_state"),
            "connected": ws.get("connected"),
            "connectedAt": ws.get("connected_at"),
            "disconnectedAt": ws.get("disconnected_at"),
            "disconnectReason": ws.get("disconnect_reason"),
            "disconnectReasonCode": ws.get("disconnect_reason_code"),
            "reconnectCount": ws.get("reconnect_count"),
            "subscriptionCount": ws.get("subscription_count"),
            "lastTickAt": ws.get("last_tick_at"),
            "metrics": ws.get("metrics"),
            "live": _safe_live_snapshot(),
        },
        "database": {
            "connected": db_connected,
            "checkedAt": datetime.now(timezone.utc).isoformat(),
        },
        "internet": {
            "connected": internet,
            "checkedAt": datetime.now(timezone.utc).isoformat(),
        },
        "services": get_snapshot("services") or {},
        "notifications": get_snapshot("notifications") or {},
        "metrics": get_snapshot("metrics") or {},
    }


@router.get("/system/stream")
async def system_stream(request: Request):
    """ONE centralized SSE stream of backend-to-frontend system state.

    On connect: sends a full ``state_snapshot``. After that: only sends
    ``state_changed`` / ``service_changed`` delta events when the actual
    backend state transitions. A lightweight heartbeat keeps dead connections
    detectable.
    """
    from services.json_safe import sanitize_for_json

    store = get_state_store()
    q = store.subscribe()

    async def event_generator():
        try:
            # Send the initial complete snapshot first.
            snapshot = await _build_snapshot()
            yield f"data: {json.dumps(sanitize_for_json(snapshot), default=str)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(q.get(), timeout=HEARTBEAT_S)
                    yield f"data: {json.dumps(sanitize_for_json(frame), default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": hb\n\n"
        finally:
            await store.unsubscribe(q)

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


@router.get("/system/status")
async def system_status():
    """Current centralized system state (read-only).

    Returns the SAME canonical snapshot shape as the SSE stream's initial
    ``state_snapshot`` so the frontend HTTP status poll can never overwrite the
    live ``session.mode`` / ``terminal`` with a stale or empty state-store
    entity (which previously caused the Dummy→Kotak switch-back).
    """
    from services.json_safe import sanitize_for_json
    snap = await _build_snapshot()
    snap["type"] = "state_snapshot"
    return sanitize_for_json(snap)


@router.get("/status")
async def websocket_status():
    """Real-time WebSocket diagnostics from the live manager."""
    st = ws_manager.status()
    connected_at = st.get("connected_at")
    disconnected_at = st.get("disconnected_at")
    duration = None
    if st.get("connected") and connected_at:
        try:
            start = datetime.fromisoformat(connected_at)
            duration = round((datetime.now(timezone.utc) - start).total_seconds(), 1)
        except Exception:
            duration = None
    return {
        "connectionState": st.get("lifecycle_state"),
        "state": st.get("state"),
        "supervisorState": st.get("supervisor_state"),
        "feedState": st.get("feed_state"),
        "feedStateSince": st.get("feed_state_since"),
        "connected": st.get("connected"),
        "connectedAt": connected_at,
        "disconnectedAt": disconnected_at,
        "connectionDurationSec": duration,
        "currentConnection": st.get("websocket_id"),
        "sessionId": st.get("session_id"),
        "lastMessage": st.get("last_message_at"),
        "lastTick": st.get("last_tick_at"),
        "reconnectCount": st.get("reconnect_count"),
        "reconnectAttempt": st.get("reconnect_attempt"),
        "subscriptionCount": st.get("subscription_count"),
        "subscriptionRegistryCount": st.get("subscription_registry_count"),
        "messagesReceived": st.get("messages_received", st.get("total_messages")),
        "totalMessages": st.get("total_messages"),
        "rates": st.get("rates"),
        "ticksReceived": (st.get("metrics") or {}).get("ticks_received"),
        "errorCount": (st.get("metrics") or {}).get("errors"),
        "disconnectReason": st.get("disconnect_reason"),
        "disconnectReasonCode": st.get("disconnect_reason_code"),
        "internetOk": st.get("internet_ok"),
        "processStartedAt": st.get("process_started_at"),
        "metrics": st.get("metrics"),
        "diagnostics": st.get("diagnostics"),
        "connectionHistory": st.get("connection_history"),
        "connectionHistoryCount": st.get("connection_history_count"),
        "live": _safe_live_snapshot(),
    }


@router.get("/live")
async def websocket_live():
    """Canonical live frame for the WebSocket monitor (real values only)."""
    from services import market_calendar
    from services import tick_buffer

    now = datetime.now(timezone.utc)
    scheduler_running = False
    try:
        from scheduler import get_scheduler_info
        scheduler_running = bool(get_scheduler_info().get("running"))
    except Exception:
        pass
    return {
        "type": "live",
        "timestamp": now.isoformat(),
        "live": _safe_live_snapshot(),
        "tickPipeline": tick_buffer.stats(),
        "market": market_calendar.snapshot(),
        "schedulerRunning": scheduler_running,
        "retentionDays": history._retention_days(),
    }


@router.get("/history")
async def websocket_history(
    limit: str | None = Query(None),
    offset: str | None = Query(None),
    status: str = "",
    date_from: str = "",
    date_to: str = "",
    search: str = "",
    sort: str = "newest",
):
    data = await history.get_history(
        limit=int(limit) if limit else 100,
        offset=int(offset) if offset else 0,
        status=status or None,
        date_from=date_from or None,
        date_to=date_to or None,
        search=search or None,
        sort=sort,
    )
    return data


@router.get("/history/{connection_id}")
async def websocket_history_detail(connection_id: str):
    record = await history.get_record(connection_id)
    if not record:
        raise HTTPException(404, "Connection record not found")
    events = await history.get_events(connection_id=connection_id, limit=500)
    return {"record": record, "events": events}


@router.delete("/history/{connection_id}")
async def websocket_history_delete(connection_id: str):
    deleted = await history.delete_record(connection_id)
    if deleted == 0:
        raise HTTPException(404, "Connection record not found")
    return {"deleted": deleted}


@router.post("/history/delete-day")
async def websocket_history_delete_day(req: dict):
    date = (req or {}).get("date", "")
    if not date:
        raise HTTPException(400, "date is required (YYYY-MM-DD)")
    deleted = await history.delete_day(date)
    return {"deleted": deleted, "date": date}


@router.post("/history/delete-older-than")
async def websocket_history_delete_older(req: dict):
    days = int((req or {}).get("days", 0) or 0)
    if days < 1:
        raise HTTPException(400, "days must be >= 1")
    deleted = await history.delete_older_than(days)
    return {"deleted": deleted, "days": days}


@router.post("/history/clear-all")
async def websocket_history_clear():
    deleted = await history.clear_all_history()
    return {"deleted": deleted}


@router.get("/events")
async def websocket_events(
    connection_id: str = "",
    event_type: str = "",
    severity: str = "",
    ts_from: str = "",
    ts_to: str = "",
    offset: str | None = Query(None),
    limit: str | None = Query(None),
):
    """Paginated WebSocket events with filters (real persisted events only)."""
    return await history.get_events_filtered(
        event_type=event_type or None,
        severity=severity or None,
        connection_id=connection_id or None,
        ts_from=ts_from or None,
        ts_to=ts_to or None,
        limit=int(limit) if limit else 200,
        offset=int(offset) if offset else 0,
    )


@router.get("/daily")
async def websocket_daily(date: str = ""):
    summary = await history.get_daily_summary(date or None)
    dates = await history.get_available_dates(limit=30)
    return {"summary": summary, "availableDates": dates}


@router.get("/metrics")
async def websocket_metrics(
    hours: str | None = Query(None),
    from_ts: str = Query("", alias="from"),
    to_ts: str = Query("", alias="to"),
):
    """Aggregate metrics + real availability from persisted history.

    Uptime counts real connected seconds inside eligible market-open windows
    (09:15-15:30 IST on trading days via the market calendar), including the
    live/open session counted up to ``now``. Days with no connection record are
    never treated as downtime, and an empty range reports ``insufficient``
    instead of a fabricated 0% / 24h downtime.
    """
    now = datetime.now(timezone.utc)
    if from_ts or to_ts:
        try:
            start = datetime.fromisoformat(str(from_ts).replace("Z", "+00:00"))
        except Exception:
            raise HTTPException(400, "invalid from (ISO timestamp expected)")
        try:
            end = datetime.fromisoformat(str(to_ts).replace("Z", "+00:00")) if to_ts else now
        except Exception:
            raise HTTPException(400, "invalid to (ISO timestamp expected)")
        if end <= start:
            raise HTTPException(400, "to must be after from")
        hours = round((end - start).total_seconds() / 3600, 2)
    else:
        hours = int(hours) if hours else 24
        hours = min(max(hours, 1), 24 * 30)
        start = now - timedelta(hours=hours)
        end = now

    avail = await history.compute_availability(start, end)
    seconds = max(1, (end - start).total_seconds())
    messages = avail.get("messagesReceived", 0)
    ticks = avail.get("ticksReceived", 0)
    errors = avail.get("errors", 0)
    connections = avail.get("connections", 0)
    measured = avail.get("measuredWindowSec") or 0
    rate_base = measured if measured > 0 else seconds
    return {
        "rangeHours": round(hours, 2),
        "connections": connections,
        "totalUptimeSec": avail.get("uptimeSec", 0),
        "totalDowntimeSec": avail.get("downtimeSec", 0),
        "eligibleWindowSec": avail.get("windowSec", 0),
        "measuredWindowSec": measured,
        "uptimePercent": avail.get("availabilityPercent"),
        "availabilityPercent": avail.get("availabilityPercent"),
        "insufficient": avail.get("insufficient", True),
        "measuredDays": avail.get("measuredDays", []),
        "rangeStartAt": start.astimezone(history.IST).isoformat(),
        "rangeEndAt": end.astimezone(history.IST).isoformat(),
        "totalMessages": messages,
        "totalTicks": ticks,
        "totalErrors": errors,
        "messagesPerSec": round(messages / rate_base, 2) if rate_base else 0,
        "ticksPerSec": round(ticks / rate_base, 2) if rate_base else 0,
        "errorsPerConnection": round(errors / connections, 2) if connections else 0,
        "heartbeatFailures": avail.get("heartbeatFailures", 0),
        "dataGaps": avail.get("dataGaps", 0),
        "reconnectCount": avail.get("reconnectCount", 0),
        "reconnectAt": avail.get("reconnectAt", []),
    }


@router.get("/telemetry")
async def websocket_telemetry(
    connection_id: str = "",
    hours: str | None = Query(None),
    resolution: str | None = Query(None),
    limit: str | None = Query(None),
):
    """Aggregated telemetry series for charts (real minute buckets).

    Charts must render only real samples: the series is built from the
    canonical ``data_saver_telemetry`` buckets, so gaps stay gaps (no
    interpolation anywhere).
    """
    from services.ds_insights import get_telemetry_series

    hrs = int(hours) if hours else 24
    res = int(resolution) if resolution else 1
    series = await get_telemetry_series(
        hours=hrs,
        resolution_min=max(1, min(res, 60)),
        limit=int(limit) if limit else 3000,
    )
    items = await history.get_telemetry(
        connection_id=connection_id or None,
        hours=hrs,
        limit=int(limit) if limit else 200,
    )
    return {"series": series, "items": items, "hours": hrs, "resolutionMin": max(1, min(res, 60))}


@router.get("/subscriptions")
async def websocket_subscriptions():
    """Real subscription table from the live supervisor + latest-tick store.

    ``requested`` = in the reconnect registry, ``subscribed`` = currently sent
    to the broker. LTP / last-tick age come from the central latest-tick store
    (only present when a real tick has been received for that token).
    """
    from services import tick_buffer

    with ws_manager._lock:
        registry = list(ws_manager._subscription_registry)
        subscribed = set(
            (str(t.get("instrument_token", "")), str(t.get("exchange_segment", "")))
            for t in ws_manager._subscribed_tokens
        )

    latest = tick_buffer.get_latest_ticks()
    now_ms = datetime.now(timezone.utc)

    rows: list[dict] = []
    for item in registry:
        token = str(item.get("instrument_token", ""))
        segment = str(item.get("exchange_segment", ""))
        symbol = item.get("symbol") or item.get("trading_symbol") or ""
        key = (token, segment)
        lat = latest.get(token) if token else None
        ltp = None
        last_tick_at: str | None = None
        tick_age_ms: float | None = None
        if lat:
            try:
                ltp = float(lat.get("ltp"))
            except (TypeError, ValueError):
                ltp = None
            received = lat.get("receivedAt") or lat.get("received_time") or lat.get("updatedAt")
            if isinstance(received, (int, float)):
                last_tick_at = datetime.fromtimestamp(received, tz=timezone.utc).isoformat()
                tick_age_ms = max(0.0, (now_ms.timestamp() - received) * 1000)
            elif isinstance(received, datetime):
                last_tick_at = received.astimezone(timezone.utc).isoformat()
                tick_age_ms = max(0.0, (now_ms - received).total_seconds() * 1000)
        rows.append({
            "instrumentToken": token,
            "exchangeSegment": segment,
            "symbol": symbol,
            "requested": True,
            "subscribed": key in subscribed,
            "lsActive": bool(item.get("active", True)),
            "ltp": ltp,
            "lastTickAt": last_tick_at,
            "tickAgeMs": round(tick_age_ms, 1) if tick_age_ms is not None else None,
        })

    rows.sort(key=lambda r: (not (r["subscribed"] and r["lsActive"]), (r["symbol"] or "").lower()))
    return {
        "subscriptions": rows,
        "total": len(rows),
        "subscribedCount": sum(1 for r in rows if r["subscribed"]),
        "requestedCount": len(rows),
        "withTickCount": sum(1 for r in rows if r["lastTickAt"] and r["ltp"] is not None),
    }


@router.get("/export")
async def websocket_export(
    format: str = Query("csv"),
    hours: str | None = Query(None),
):
    """Export real persisted WebSocket history + events (CSV or JSON).

    Never fabricates rows — the export mirrors exactly what is stored.
    """
    import csv as _csv
    import io as _io

    hrs = int(hours) if hours else 24
    ts_from = (datetime.now(timezone.utc) - timedelta(hours=hrs)).isoformat()
    history_data = await history.get_history(limit=500)
    events = await history.get_events_filtered(ts_from=ts_from, limit=500)

    fmt = (format or "csv").lower()
    if fmt == "json":
        import json as _json
        payload = {
            "exportedAt": datetime.now(timezone.utc).isoformat(),
            "rangeHours": hrs,
            "history": history_data["records"],
            "events": events["events"],
        }
        body = _json.dumps(payload, default=str, indent=2)
        media = "application/json"
    else:
        buf = _io.StringIO()
        writer = _csv.writer(buf)
        writer.writerow(["kind", "connection_id", "timestamp", "status", "event_type",
                         "severity", "reason", "messages", "ticks", "errors",
                         "duration_sec", "details"])
        for rec in history_data["records"]:
            writer.writerow([
                "history", rec.get("connection_id"), rec.get("connected_at"),
                rec.get("status"), "", "", rec.get("reason"),
                rec.get("messages_received"), rec.get("ticks_received"),
                rec.get("error_count"), rec.get("duration_sec"), "",
            ])
        for ev in events["events"]:
            writer.writerow([
                "event", ev.get("connection_id"), ev.get("timestamp"), "",
                ev.get("event_type"), ev.get("severity"), ev.get("message"), "", "", "",
                "", ev.get("details") or "",
            ])
        body = buf.getvalue()
        media = "text/csv"

    return Response(
        content=body,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="websocket_export_{hrs}h.{fmt}"'},
    )


@router.get("/stream")
async def websocket_stream(request: Request):
    """SSE stream that pushes WebSocket status changes to the frontend.

    DEPRECATED for the monitor page: the page consumes the centralized
    ``/api/websocket/system/stream`` realtime channel instead (via the shared
    RealtimeProvider). Kept for backward compatibility with older clients.
    """
    import asyncio as _aio

    last_state: dict | None = None

    async def event_generator():
        nonlocal last_state
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    st = ws_manager.status()
                    rates = st.get("rates") or {}
                    current = {
                        "connected": st.get("connected"),
                        "state": st.get("lifecycle_state"),
                        "supervisorState": st.get("supervisor_state"),
                        "feedState": st.get("feed_state"),
                        "feedStateSince": st.get("feed_state_since"),
                        "connectionId": st.get("websocket_id"),
                        "sessionId": st.get("session_id"),
                        "connectedAt": st.get("connected_at"),
                        "disconnectedAt": st.get("disconnected_at"),
                        "lastConnectionAt": st.get("last_connection_at"),
                        "processStartedAt": st.get("process_started_at"),
                        "disconnectReason": st.get("disconnect_reason"),
                        "disconnectReasonCode": st.get("disconnect_reason_code"),
                        "subscriptionCount": st.get("subscription_count"),
                        "subscriptionRegistryCount": st.get("subscription_registry_count"),
                        "subscribedSymbols": st.get("subscribed_symbols"),
                        "connectionHistory": st.get("connection_history") or [],
                        "connectionHistoryCount": st.get("connection_history_count") or 0,
                        "ticksReceived": (st.get("metrics") or {}).get("ticks_received", 0),
                        "messagesReceived": st.get("total_messages", 0),
                        "errorCount": (st.get("metrics") or {}).get("errors", 0),
                        "reconnectCount": st.get("reconnect_count"),
                        "reconnectAttempt": st.get("reconnect_attempt"),
                        "lastTickAt": st.get("last_tick_at"),
                        "lastMessageAt": st.get("last_message_at"),
                        "internetOk": st.get("internet_ok"),
                        "rates": rates,
                        "diagnostics": st.get("diagnostics"),
                    }
                    if current != last_state:
                        last_state = current
                        yield f"data: {json.dumps(current, default=str)}\n\n"
                except Exception:
                    pass
                await _aio.sleep(2)
        except _aio.CancelledError:
            pass

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


@router.post("/cleanup")
async def websocket_cleanup(req: dict | None = None):
    """Trigger retention cleanup (admin/testing).

    Optional body ``{"days": N}`` forces deletion of records older than N days;
    without it the live retention policy (``ws_retention_days``) applies.
    """
    req = req or {}
    try:
        days = int(req.get("days", 0) or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "days must be an integer")
    retention = history._retention_days()
    if days:
        if days < 1:
            raise HTTPException(400, "days must be >= 1")
        deleted = await history.delete_older_than(days)
    else:
        deleted = await history.run_cleanup_retention()
        days = retention
    return {"deleted": deleted, "retentionDays": retention, "requestedDays": days}
