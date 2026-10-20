"""Central WebSocket Engine control API.

Full operational control of the Central Kotak WebSocket Engine (Services ->
WebSocket Engine). Every endpoint returns ``{ ok: bool, data? | error? }``.
The engine composes ``ws_socket.ws_manager`` (the single Kotak SFeedWebSocket
owner) — this module only wires the publish hook + owner reference on first use
and never opens its own socket or registry; there is no duplicate auth/service
registry here (the project's own middleware + auth conventions are reused).
"""

from __future__ import annotations

import logging
import threading

from fastapi import APIRouter, Body, Path, Query

from services import pipeline_latency
from services import websocket_history_service as ws_history
from services.json_safe import sanitize_for_json


def _mongo_unavailable(exc: Exception) -> bool:
    """True when a store error is simply "MongoDB is not connected".

    The previous check string-matched ``"MongoDB not connected"`` but
    ``database.connection.get_db()`` raises ``"MongoDB is not connected - call
    connect_mongo() first ..."``, so the guard never matched and every
    Mongo-backed read surface 500'd instead of degrading honestly. Ask the
    connection layer directly rather than matching a message.
    """
    from database.connection import is_mongo_connected

    if not isinstance(exc, RuntimeError):
        return False
    return not is_mongo_connected()

logger = logging.getLogger("app")

router = APIRouter(prefix="/api/services/websocket", tags=["websocket-engine"])

_wired = False
_wire_lock = threading.Lock()

_engine = None  # set on first use to avoid heavy import at module load


def get_wired_engine(record: bool = False):
    """Wire-and-return the engine singleton (used at app startup and lazily)."""
    return _get_engine()


def _get_engine():
    global _engine, _wired
    if _engine is None:
        from ws_socket.engine.engine import engine
        _engine = engine
    if not _wired:
        with _wire_lock:
            if not _wired:
                try:
                    from ws_socket.ws_manager import ws_manager
                    _engine.set_owner(ws_manager)
                    ws_manager.set_publish_hook(_engine.on_feed_message)
                    logger.info("[WS-ENGINE] wired to ws_manager (single WS owner)")
                    _wired = True
                except Exception:
                    logger.exception("[WS-ENGINE] wiring failed (will retry lazily)")
    return _engine


def _ok(data) -> dict:
    return {"ok": True, "data": sanitize_for_json(data)}


def _bad(message: str) -> dict:
    return {"ok": False, "error": message}


# ---------------------------------------------------------------------------
# Status / health / metrics
# ---------------------------------------------------------------------------
@router.get("/status")
async def status():
    return _ok(_get_engine().status())


@router.get("/health")
async def health():
    return _ok(_get_engine().health())


@router.get("/metrics")
async def metrics():
    return _ok(_get_engine().metrics())


# ---------------------------------------------------------------------------
# History / config (real persisted + live state — no fabricated values)
# ---------------------------------------------------------------------------
@router.get("/history")
async def history(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    status: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
    search: str = Query(""),
    sort: str = Query("newest"),
):

    """Paginated real WebSocket connection history (persisted records)."""
    try:
        records = await ws_history.get_history(
            limit=limit,
            offset=offset,
            status=status or None,
            date_from=date_from or None,
            date_to=date_to or None,
            search=search or None,
            sort=sort,
        )
    except RuntimeError as exc:
        if _mongo_unavailable(exc):
            return _ok({"records": [], "total": 0, "limit": limit, "offset": offset,
                        "note": "history unavailable — MongoDB not connected"})
        raise
    return _ok(records)

@router.get("/events")
async def events(
    connection_id: str = Query(""),
    event_type: str = Query(""),
    severity: str = Query(""),
    ts_from: str = Query(""),
    ts_to: str = Query(""),
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=500),
):
    """Paginated real WebSocket events (reconnect/feed/connection ledger)."""
    try:
        return _ok(await ws_history.get_events_filtered(
            event_type=event_type or None,
            severity=severity or None,
            connection_id=connection_id or None,
            ts_from=ts_from or None,
            ts_to=ts_to or None,
            offset=offset,
            limit=limit,
        ))
    except RuntimeError as exc:
        if _mongo_unavailable(exc):
            return _ok({"events": [], "total": 0, "limit": limit, "offset": offset,
                        "note": "events unavailable — MongoDB not connected"})
        raise


@router.get("/history/{connection_id}")
async def history_detail(connection_id: str = Path(...)):
    """One persisted connection record plus its real events."""
    try:
        record = await ws_history.get_record(connection_id)
    except RuntimeError as exc:
        if _mongo_unavailable(exc):
            return _bad("history unavailable — MongoDB not connected")
        raise
    if record is None:
        return _bad(f"connection record {connection_id} not found")
    event_rows = await ws_history.get_events(connection_id=connection_id, limit=500)
    return _ok({"record": record, "events": event_rows})


@router.get("/daily")
async def daily(date: str = Query("")):
    """Real per-day availability summary (uptime/connectivity from history)."""
    try:
        summary = await ws_history.get_daily_summary(date or None)
        dates = await ws_history.get_available_dates(limit=30)
    except RuntimeError as exc:
        if _mongo_unavailable(exc):
            return _ok({"summary": None, "availableDates": [],
                        "note": "daily summary unavailable — MongoDB not connected"})
        raise
    return _ok({"summary": summary, "availableDates": dates})


@router.get("/config")
async def config():
    """Read-only live configuration of WS-owned settings (no writes).

    Exposes the reconnect/backoff knobs honoured by the single connection
    owner plus the canonical schema/SDK versions and feed-level defaults.
    """
    from services.runtime_settings import get_runtime_setting as rt_get

    engine = _get_engine()
    owner_status = {}
    if engine.owner is not None and hasattr(engine.owner, "status"):
        try:
            owner_status = engine.owner.status()
        except Exception:
            owner_status = {}
    settings = {}
    for key in (
        "ws_reconnect_delay_ms", "ws_backoff", "ws_auto_reconnect",
        "ws_max_reconnect_attempts",
    ):
        settings[key] = rt_get(key)
    status = engine.status()
    quality = engine.quality.summary().get("thresholds")
    return _ok({
        "reconnect": settings,
        "schema_version": status.get("schema_version"),
        "sdk_version": status.get("sdk_version"),
        "feed_levels": owner_status.get("feed_levels"),
        "subscription_registry_count": owner_status.get("subscription_registry_count"),
        "quality_thresholds": quality,
        "resource_thresholds": engine.resources.thresholds.to_dict(),
    })


# ---------------------------------------------------------------------------
# Feed quality monitor (websocket-engine.md §18–§21)
# ---------------------------------------------------------------------------
@router.get("/quality")
async def quality():
    snapshot = _get_engine().quality_snapshot()
    # The legacy ``latency`` block measures ``received_at - broker_timestamp``
    # where broker_timestamp is the broker's last_trade_time: that is feed
    # freshness ("time since last trade"), NOT transport latency. The true
    # hop-to-hop propagation is reported additively under ``pipelineLatency``
    # (nothing is renamed or hidden).
    snapshot["pipelineLatency"] = pipeline_latency.stats()
    snapshot["feedAgeNote"] = (
        "overall.latency / instruments[].latency = received_at - broker "
        "last_trade_time (time since last trade / feed age), not transport "
        "latency. See pipelineLatency for real propagation stages."
    )
    return _ok(snapshot)


@router.get("/latency")
async def latency():
    """True end-to-end pipeline latency stages (A-G), real measurements only."""
    return _ok(pipeline_latency.stats())


@router.get("/quality/{instrument_token}")
async def quality_instrument(instrument_token: str = Path(...)):
    row = _get_engine().quality_instrument(instrument_token)
    if row is None:
        return _bad(f"no feed quality recorded for {instrument_token}")
    return _ok(row)


@router.put("/quality/thresholds")
async def update_quality_thresholds(payload: dict = Body(...)):
    return _ok(_get_engine().update_quality_thresholds(payload))


# ---------------------------------------------------------------------------
# Subscriptions
# ---------------------------------------------------------------------------
@router.get("/subscriptions")
async def subscriptions():
    return _ok(_get_engine().subscriptions())


@router.post("/subscriptions")
async def add_subscriptions(payload: dict = Body(...)):
    engine = _get_engine()
    consumer = payload.get("consumer", "subscribed")
    tokens = payload.get("tokens") or payload.get("instruments") or [payload]
    added = engine.registry.add_instruments(consumer, tokens)
    sync = await engine.reconcile_broker_subscriptions()
    return _ok({"added": added, "sync": sync})


@router.delete("/subscriptions/{id}")
async def remove_subscription(id: str = Path(...), payload: dict = Body(default={})):
    engine = _get_engine()
    segment = payload.get("exchange_segment") or "nse_cm"
    token = payload.get("instrument_token") or id
    consumer = payload.get("consumer", "subscribed")
    removed = engine.registry.remove_instrument(consumer, segment, token)
    sync = await engine.reconcile_broker_subscriptions()
    return _ok({"removed": removed, "sync": sync})


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------
@router.get("/watchlist")
async def watchlist():
    return _ok(_get_engine().watchlist())


# ---------------------------------------------------------------------------
# Pins
# ---------------------------------------------------------------------------
@router.get("/pins")
async def pins():
    return _ok(_get_engine().pins_list())


@router.post("/pins")
async def set_pin(payload: dict = Body(...)):
    return _ok(await _get_engine().set_pin(payload))


@router.delete("/pins/{id}")
async def unset_pin(id: str = Path(...)):
    return _ok(await _get_engine().unset_pin(id))


# ---------------------------------------------------------------------------
# Field profiles
# ---------------------------------------------------------------------------
@router.get("/field-profiles")
async def field_profiles():
    return _ok(_get_engine().profiles.list())


@router.post("/field-profiles")
async def create_profile(payload: dict = Body(...)):
    try:
        return _ok(_get_engine().profiles.create(payload))
    except ValueError as exc:
        return _bad(str(exc))


@router.put("/field-profiles/{id}")
async def update_profile(id: str = Path(...), payload: dict = Body(...)):
    updated = _get_engine().profiles.update(id, payload)
    if updated is None:
        return _bad(f"profile {id} not found")
    return _ok(updated)


@router.delete("/field-profiles/{id}")
async def delete_profile(id: str = Path(...)):
    deleted = _get_engine().profiles.delete(id)
    if not deleted:
        return _bad(f"profile {id} not found or is built-in")
    return _ok({"deleted": id})


@router.get("/field-verification")
async def field_verification():
    return _ok(_get_engine().field_verification())


@router.get("/field-verification/label/{field_name}")
async def field_label(field_name: str = Path(...)):
    return _ok({"field": field_name, "status": _get_engine().field_label(field_name)})


# ---------------------------------------------------------------------------
# Routing / consumers
# ---------------------------------------------------------------------------
@router.get("/routes")
async def routes():
    return _ok(_get_engine().routes())


@router.get("/consumers")
async def consumers():
    return _ok(_get_engine().consumers())


@router.post("/consumers")
async def register_consumer(payload: dict = Body(...)):
    result = _get_engine().register_consumer(payload)
    consumer = result.get("consumer", {})
    instruments = payload.get("instruments")
    if instruments:
        _get_engine().registry.add_instruments(consumer.get("consumer_id", ""), instruments)
        await _get_engine().reconcile_broker_subscriptions()
    return _ok(result)


@router.put("/consumers/{id}")
async def update_consumer(id: str = Path(...), payload: dict = Body(...)):
    return _ok(_get_engine().update_consumer(id, payload))


@router.delete("/consumers/{id}")
async def unregister_consumer(id: str = Path(...)):
    return _ok(_get_engine().unregister_consumer(id))


@router.get("/consumers/{id}/drain")
async def drain_consumer(id: str = Path(...), limit: int = 100):
    return _ok(_get_engine().drain_consumer(id, limit))


# ---------------------------------------------------------------------------
# Raw stream (Data Saver contract + Raw Tick Inspector)
# ---------------------------------------------------------------------------
@router.get("/raw-stream")
async def raw_stream(token: str = "", limit: int = 20):
    return _ok(_get_engine().raw_stream(token, max(1, min(limit, 200))))


@router.get("/live-feed")
async def live_feed(window_sec: float = 10.0):
    return _ok(_get_engine().live_feed(max(1.0, min(window_sec, 120.0))))


@router.get("/raw/{reference}")
async def raw_detail(reference: str = Path(...)):
    raw = _get_engine().raw_lookup(reference)
    if raw is None:
        return _bad(f"raw reference {reference} not found")
    return _ok(raw)


# ---------------------------------------------------------------------------
# Resource control
# ---------------------------------------------------------------------------
@router.get("/resources")
async def resources():
    return _ok(_get_engine().resources_view())


@router.put("/resources")
async def update_resources(payload: dict = Body(...)):
    return _ok(await _get_engine().update_resources(payload))


# ---------------------------------------------------------------------------
# Connection control (delegated to the single owner)
# ---------------------------------------------------------------------------
@router.post("/connect")
async def connect():
    return _ok(await _get_engine().control_connection("connect"))


@router.post("/disconnect")
async def disconnect():
    return _ok(await _get_engine().control_connection("disconnect"))


@router.post("/reconnect")
async def reconnect():
    return _ok(await _get_engine().control_connection("reconnect"))


# ---------------------------------------------------------------------------
# Direct subscribe / unsubscribe (registry-driven, broker-neutral)
# ---------------------------------------------------------------------------
@router.post("/subscribe")
async def subscribe(payload: dict = Body(...)):
    engine = _get_engine()
    consumer = payload.get("consumer", "subscribed")
    tokens = payload.get("tokens") or payload.get("instruments") or [payload]
    engine.registry.add_instruments(consumer, tokens)
    return _ok(await engine.reconcile_broker_subscriptions())


@router.post("/unsubscribe")
async def unsubscribe(payload: dict = Body(...)):
    engine = _get_engine()
    consumer = payload.get("consumer", "subscribed")
    tokens = payload.get("tokens") or payload.get("instruments") or [payload]
    removed = 0
    for token in tokens:
        segment = token.get("exchange_segment") or token.get("exchangeSegment") or ""
        number = token.get("instrument_token") or token.get("instrumentToken")
        if number is not None and engine.registry.remove_instrument(consumer, segment, str(number)):
            removed += 1
    return _ok({"removed": removed, "sync": await engine.reconcile_broker_subscriptions()})