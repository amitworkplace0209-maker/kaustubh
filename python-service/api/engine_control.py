"""Engine Control API — Phase 3 Service Control Center endpoints.

Every engine's lifecycle, health, metrics, logs, dependencies, and controls
are exposed through these endpoints. This is the control PLANE — it does NOT
duplicate engine logic.
"""

from __future__ import annotations

import asyncio
import logging
import time
from fastapi import APIRouter, Body, Path, Response

from services.json_safe import sanitize_for_json
from services.engine_registry import get_engine_registry

logger = logging.getLogger("app.engine_control")

router = APIRouter(prefix="/api/services/engines", tags=["engine-control"])


def _ok(data) -> dict:
    return {"ok": True, "data": sanitize_for_json(data)}


def _bad(message: str) -> dict:
    return {"ok": False, "error": message}


# ------------------------------------------------------------------
# Overview
# ------------------------------------------------------------------
@router.get("/summary")
async def engine_summary():
    """Overall system status + engine summary."""
    return _ok(get_engine_registry().summary())


@router.get("")
async def all_engines():
    """Status of all registered engines.

    Same pre-encoded cache shape as /overview: the full status list is ~4.6MB
    and FastAPI's per-request dict re-encoding dominated the poll latency
    (~3s under live-feed load).
    """
    now = time.monotonic()
    if _ALL_ENGINES_JSON is None:
        try:
            body = await _build_all_engines_json()
        except Exception as exc:
            return _bad(str(exc))
        _store_all_engines_json(body)
        return Response(content=body, media_type="application/json")
    if now - _ALL_ENGINES_JSON_AT < _ENGINE_OVERVIEW_TTL_S:
        return Response(content=_ALL_ENGINES_JSON, media_type="application/json")
    _schedule_all_engines_rebuild()
    return Response(content=_ALL_ENGINES_JSON, media_type="application/json")


_ALL_ENGINES_JSON: str | None = None
_ALL_ENGINES_JSON_AT = 0.0
_ALL_ENGINES_REBUILD_TASK: asyncio.Task | None = None


def _encode_all_engines_json() -> str:
    import json as _json

    return _json.dumps(_ok(get_engine_registry().get_all_statuses()), default=str)


async def _build_all_engines_json() -> str:
    return await asyncio.to_thread(_encode_all_engines_json)


def _store_all_engines_json(body: str) -> None:
    global _ALL_ENGINES_JSON, _ALL_ENGINES_JSON_AT
    _ALL_ENGINES_JSON = body
    _ALL_ENGINES_JSON_AT = time.monotonic()


def _schedule_all_engines_rebuild() -> None:
    """Refresh the all-engines list in the background (single-flight)."""
    global _ALL_ENGINES_REBUILD_TASK
    task = _ALL_ENGINES_REBUILD_TASK
    if task is not None and not task.done():
        return
    try:
        _ALL_ENGINES_REBUILD_TASK = asyncio.ensure_future(_rebuild_all_engines_bg())
    except RuntimeError:
        pass


async def _rebuild_all_engines_bg() -> None:
    try:
        body = await _build_all_engines_json()
    except Exception as exc:
        logger.warning("background all-engines rebuild failed: %s", exc)
        return
    _store_all_engines_json(body)


@router.get("/overview")
async def engine_overview():
    """The WHOLE control plane in ONE response.

    Engines + summary + broker registry — the same three sections the
    ``engines`` WebSocket channel carries. The Service Control Center uses this
    as its REST fallback (and as the one-shot load), so the page never needs
    four separate polls.

    The build walks every engine's full status snapshot (~4.6MB serialized) and
    cost ~2.5-3s wall under live-feed load. Both the build AND FastAPI's
    per-request re-encoding of a dict that large are expensive, so the encoded
    JSON body itself is cached and returned as a pre-encoded Response.
    """
    body = _engine_overview_body()
    if body is not None:
        return Response(content=body, media_type="application/json")
    try:
        body = await _build_engine_overview_json()
        _engine_overview_store(body)
        return Response(content=body, media_type="application/json")
    except Exception as exc:
        return _bad(str(exc))


_ENGINE_OVERVIEW_TTL_S = 2.0
_ENGINE_OVERVIEW_JSON: str | None = None
_ENGINE_OVERVIEW_AT = 0.0
_ENGINE_OVERVIEW_REBUILD_TASK: asyncio.Task | None = None


def _encode_engine_overview_json() -> str:
    # sanitize_for_json walked every value already (_ok); json.dumps with
    # default=str is then safe and produces the exact body every request ships.
    import json as _json

    from brokers.broker_registry import get_broker_registry

    registry = get_engine_registry()
    broker_registry = get_broker_registry()
    return _json.dumps(_ok({
        "engines": registry.get_all_statuses(),
        "summary": registry.summary(),
        "brokers": {
            "trading": broker_registry.get_trading_status(),
            "marketData": broker_registry.get_market_data_status(),
            "list": broker_registry.get_all_brokers(),
        },
    }), default=str)


async def _build_engine_overview_json() -> str:
    import asyncio as _aio

    # The engine walk is CPU-heavy; slide it off the event loop so it cannot
    # starve concurrent request handlers while it runs.
    return await _aio.to_thread(_encode_engine_overview_json)


def _engine_overview_body() -> str | None:
    now = time.monotonic()
    if _ENGINE_OVERVIEW_JSON is None:
        return None
    if now - _ENGINE_OVERVIEW_AT < _ENGINE_OVERVIEW_TTL_S:
        return _ENGINE_OVERVIEW_JSON
    # Stale: serve the last-known body immediately and refresh in the
    # background — the polls are a status view, at most a couple of seconds old.
    _schedule_engine_overview_rebuild()
    return _ENGINE_OVERVIEW_JSON


def _engine_overview_store(body: str) -> None:
    global _ENGINE_OVERVIEW_JSON, _ENGINE_OVERVIEW_AT
    _ENGINE_OVERVIEW_JSON = body
    _ENGINE_OVERVIEW_AT = time.monotonic()


def _schedule_engine_overview_rebuild() -> None:
    """Refresh the engines overview in the background (single-flight)."""
    global _ENGINE_OVERVIEW_REBUILD_TASK
    task = _ENGINE_OVERVIEW_REBUILD_TASK
    if task is not None and not task.done():
        return
    try:
        _ENGINE_OVERVIEW_REBUILD_TASK = asyncio.ensure_future(_rebuild_engine_overview_bg())
    except RuntimeError:
        pass


async def _rebuild_engine_overview_bg() -> None:
    try:
        body = await _build_engine_overview_json()
    except Exception as exc:
        logger.warning("background engines overview rebuild failed: %s", exc)
        return
    _engine_overview_store(body)


@router.get("/dependency-graph")
async def dependency_graph():
    """Engine dependency graph."""
    return _ok(get_engine_registry().dependency_graph())


# ------------------------------------------------------------------
# Square-Off Engine — live detail / history / run (docs/engines/squareoff-engine.md)
# ------------------------------------------------------------------
@router.get("/squareoff_engine/detail")
async def squareoff_detail():
    """Doc §15-§18 live surface: schedule + active/last run + broker reality.

    Enriched asynchronously (positions / pending orders only when a session is
    live — otherwise honest nulls). The generic engine snapshot stays the
    realtime-push contract; this is the one-shot detail the page loads once.
    """
    try:
        from core.engines.squareoff_engine import squareoff_engine
        return _ok(await squareoff_engine.get_detail())
    except Exception as exc:
        return _bad(str(exc))


@router.get("/squareoff_engine/history")
async def squareoff_history(limit: int = 20):
    """Doc §22 run history + per-trading-day rollup (in-memory, last 50 runs).

    The permanent record is the audit trail (SQUARE_OFF_* events via
    GET /api/terminal/audit); this is the live engine's own recent runs.
    """
    try:
        from core.engines.squareoff_engine import squareoff_engine
        return _ok(squareoff_engine.get_history(limit=limit))
    except Exception as exc:
        return _bad(str(exc))


@router.post("/squareoff_engine/run")
async def squareoff_run(body: dict = Body(default={})):
    """Doc §20 RUN SQUAREOFF NOW — same engine workflow as the scheduler.

    Requires explicit confirmation: {terminal, confirmation_token} with
    confirmation_token truthy (the UI sends "CONFIRM" after its modal).
    Audited via the engine event bus (SQUARE_OFF_STARTED/COMPLETED/FAILED).
    """
    try:
        from core.engines.squareoff_engine import squareoff_engine
        if not isinstance(body, dict):
            return _bad("a JSON object is required")
        terminal = str(body.get("terminal") or "kotak")
        token = body.get("confirmation_token") or body.get("confirmationToken")
        source = str(body.get("source") or "manual")
        if source == "manual" and not token:
            return {"ok": False, "error": "CONFIRMATION_REQUIRED", "requiresConfirmation": True}
        result = await squareoff_engine.execute_square_off(
            terminal=terminal, source=source, confirmation_token=str(token or "CONFIRM"),
        )
        if result.get("ok"):
            return _ok(result)
        return {"ok": False, "error": result.get("error") or result.get("message") or "square-off failed",
                "data": result}
    except Exception as exc:
        return _bad(str(exc))


# ------------------------------------------------------------------
# Per-engine endpoints
# ------------------------------------------------------------------
@router.get("/{engine_id}")
async def engine_status(engine_id: str = Path(...)):
    status = get_engine_registry().get_status(engine_id)
    if not status:
        return _bad(f"engine '{engine_id}' not found")
    return _ok(status)


@router.get("/{engine_id}/health")
async def engine_health(engine_id: str = Path(...)):
    health = get_engine_registry().get_health(engine_id)
    if not health:
        return _bad(f"engine '{engine_id}' not found")
    return _ok(health)


@router.get("/{engine_id}/metrics")
async def engine_metrics(engine_id: str = Path(...)):
    metrics = get_engine_registry().get_metrics(engine_id)
    if not metrics:
        return _bad(f"engine '{engine_id}' not found")
    return _ok(metrics)


@router.get("/{engine_id}/dependencies")
async def engine_dependencies(engine_id: str = Path(...)):
    deps = get_engine_registry().get_dependencies(engine_id)
    if not deps:
        return _bad(f"engine '{engine_id}' not found")
    return _ok(deps)


@router.get("/{engine_id}/errors")
async def engine_errors(engine_id: str = Path(...), limit: int = 20):
    engine = get_engine_registry().get(engine_id)
    if not engine:
        return _bad(f"engine '{engine_id}' not found")
    return _ok(engine.get_recent_errors(limit))


@router.get("/{engine_id}/activity")
async def engine_activity(engine_id: str = Path(...), limit: int = 30):
    engine = get_engine_registry().get(engine_id)
    if not engine:
        return _bad(f"engine '{engine_id}' not found")
    return _ok(engine.get_recent_activity(limit))


# ------------------------------------------------------------------
# Settings — one declarative, validated schema per engine
# ------------------------------------------------------------------
@router.get("/{engine_id}/config")
async def engine_config(engine_id: str = Path(...)):
    """The engine's settings schema resolved against its LIVE values.

    Every engine answers this: fields the engine declares as editable are bound
    to a real persisted setting, and computed outputs come back read-only so
    the UI never offers an input that would do nothing.
    """
    engine = get_engine_registry().get(engine_id)
    if not engine:
        return _bad(f"engine '{engine_id}' not found")
    # Re-derive from live settings first, so the returned values are current
    # rather than whatever was captured when the engine started.
    try:
        engine.refresh_config_summary()
    except Exception:
        pass
    return _ok(engine.config_snapshot())


@router.patch("/{engine_id}/config")
async def engine_config_patch(engine_id: str = Path(...), body: dict = Body(default={})):
    """Validate + persist a settings patch. Per-field errors come back together."""
    engine = get_engine_registry().get(engine_id)
    if not engine:
        return _bad(f"engine '{engine_id}' not found")
    if not isinstance(body, dict) or not body:
        return _bad("a settings patch object is required")
    patch = body.get("settings") if isinstance(body.get("settings"), dict) else body
    result = await engine.apply_config_patch(patch)
    return _ok(result) if result.get("ok") else _bad(result)


# ------------------------------------------------------------------
# Lifecycle controls
# ------------------------------------------------------------------
@router.post("/{engine_id}/start")
async def engine_start(engine_id: str = Path(...)):
    result = await get_engine_registry().start(engine_id)
    return _ok(result) if result.get("ok") else _bad(result.get("error", "start failed"))


@router.post("/{engine_id}/stop")
async def engine_stop(engine_id: str = Path(...), body: dict = Body(default={})):
    confirm = body.get("confirm", False)
    result = await get_engine_registry().stop(engine_id)
    if not result.get("ok") and result.get("requiresConfirmation") and not confirm:
        return {"ok": False, "error": result["error"], "requiresConfirmation": True}
    return _ok(result) if result.get("ok") else _bad(result.get("error", "stop failed"))


@router.post("/{engine_id}/restart")
async def engine_restart(engine_id: str = Path(...)):
    result = await get_engine_registry().restart(engine_id)
    return _ok(result) if result.get("ok") else _bad(result.get("error", "restart failed"))


@router.post("/{engine_id}/heartbeat")
async def engine_heartbeat(engine_id: str = Path(...)):
    ok = get_engine_registry().heartbeat(engine_id)
    if not ok:
        return _bad(f"engine '{engine_id}' not found")
    return _ok({"engineId": engine_id, "heartbeat": True})


# ------------------------------------------------------------------
# Broker registry endpoints
# ------------------------------------------------------------------
@router.get("/broker/status")
async def broker_status():
    """Full broker status (trading + market data)."""
    from brokers.broker_registry import get_broker_registry
    return _ok(get_broker_registry().full_status())


@router.get("/broker/list")
async def broker_list():
    from brokers.broker_registry import get_broker_registry
    return _ok(get_broker_registry().get_all_brokers())


@router.get("/broker/trading")
async def trading_broker_status():
    from brokers.broker_registry import get_broker_registry
    return _ok(get_broker_registry().get_trading_status())


@router.get("/broker/market-data")
async def market_data_broker_status():
    from brokers.broker_registry import get_broker_registry
    return _ok(get_broker_registry().get_market_data_status())


@router.post("/broker/trading/select")
async def select_trading_broker(body: dict = Body(...)):
    from brokers.broker_registry import get_broker_registry
    broker = body.get("broker", "")
    result = get_broker_registry().set_trading_broker(broker)
    return _ok(result) if result.get("ok") else _bad(result.get("error", "selection failed"))


@router.post("/broker/market-data/select")
async def select_market_data_broker(body: dict = Body(...)):
    from brokers.broker_registry import get_broker_registry
    broker = body.get("broker", "")
    result = get_broker_registry().set_market_data_broker(broker)
    return _ok(result) if result.get("ok") else _bad(result.get("error", "selection failed"))


# ------------------------------------------------------------------
# Health check all
# ------------------------------------------------------------------
@router.post("/health-check")
async def health_check_all():
    results = await get_engine_registry().health_check_all()
    return _ok(results)


# ------------------------------------------------------------------
# Heartbeat all
# ------------------------------------------------------------------
@router.post("/db_writer_engine/flush")
async def db_writer_flush():
    """DB Writer Engine — manually drain the buffered tick pipeline to MongoDB."""
    from services.db_writer_engine import db_writer_engine
    result = await db_writer_engine.flush()
    return _ok(result)


# ------------------------------------------------------------------
# DB Writer — tick persistence permissions (single authority)
# ------------------------------------------------------------------
@router.get("/db_writer_engine/tick-persistence")
async def db_writer_tick_persistence():
    """The three INDEPENDENT tick persistence permissions, as the DB Writer
    currently applies them.

    This is the authoritative read used by the Service page Settings gear. The
    frontend renders this and never derives its own state.
    """
    from services.db_writer_engine import db_writer_engine
    return _ok(db_writer_engine.tick_persistence_settings())


@router.put("/db_writer_engine/tick-persistence")
async def update_db_writer_tick_persistence(body: dict = Body(...)):
    """Turn tick saving on/off: master switch and/or per-stream permissions.

    Body: ``{"master": true, "personalNoExpiry": true, "personalOneDay": false,
    "marketWatchOneDay": true}``. Only the supplied names change; the DB Writer
    validates the names and re-reads the runtime cache before answering, so the
    response is the authoritative post-update state. ``master: false`` blocks
    every stream even if individual permissions are on.
    """
    from services.db_writer_engine import (
        TickPersistenceUnavailable,
        db_writer_engine,
    )

    updates = body.get("permissions") if isinstance(body.get("permissions"), dict) else body
    if not isinstance(updates, dict) or not updates:
        return _bad("provide at least one of master, personalNoExpiry, personalOneDay, marketWatchOneDay")

    coerced: dict[str, bool] = {}
    for name, value in updates.items():
        if not isinstance(value, bool):
            return _bad(f"{name} must be a boolean")
        coerced[name] = value

    try:
        result = await db_writer_engine.set_tick_persistence(coerced)
    except ValueError as exc:
        return _bad(str(exc))
    except TickPersistenceUnavailable as exc:
        return _bad(str(exc))
    return _ok(result)


# ------------------------------------------------------------------
# DB Writer — storage report (day-wise + all-time, separate read plane)
# ------------------------------------------------------------------
@router.get("/db_writer_engine/storage")
async def db_writer_storage(days: int = 30, date: str = ""):
    """DB Writer storage view: all-time collection collStats, the IST daily
    ledger (``daily_summaries`` rows) and an optional single-day drill-down
    (``date=YYYY-MM-DD``) that counts real ``ticks`` documents by their
    ``receivedAt`` UTC timestamps.

    This is the storage page's OWN connection — deliberately separate from the
    tick-persistence authority read above, so the two pages poll different
    endpoints and neither doubles the other's DB load.
    """
    from services.db_writer_engine import db_writer_engine
    return _ok(await db_writer_engine.storage_report(days=days, date=date))


# ------------------------------------------------------------------
# Audit Engine — append-only trail queries + manual record (single authority)
# ------------------------------------------------------------------
@router.get("/audit_engine/summary")
async def audit_summary():
    """Aggregated audit posture: totals, by-category/severity/source, latest event.

    Real MongoDB aggregations over ``system_events`` (+ legacy ``events``).
    Returns {"error": ...} inside data when MongoDB is unreachable.
    """
    from services.audit_engine import audit_engine
    return _ok(await audit_engine.get_summary())


@router.get("/audit_engine/query")
async def audit_query(
    limit: int = 100,
    source: str = "",
    event: str = "",
    correlation_id: str = "",
    category: str = "",
    severity: str = "",
    actor_type: str = "",
    search: str = "",
):
    """Filtered newest-first audit trail from the persisted ledger.

    ``search`` matches message/reason/event_id/symbol substring (case-insensitive).
    All filters are optional; ``limit`` is clamped to 1..500.
    """
    from services.audit_engine import audit_engine
    rows = await audit_engine.query(
        limit=max(1, min(int(limit or 100), 500)),
        source=source or None,
        event=event or None,
        correlation_id=correlation_id or None,
        category=category or None,
        severity=severity or None,
        actor_type=actor_type or None,
    )
    if search:
        needle = search.strip().lower()
        rows = [
            r for r in rows
            if needle in str(r.get("message") or "").lower()
            or needle in str(r.get("reason") or "").lower()
            or needle in str(r.get("event") or "").lower()
            or needle in str(r.get("event_id") or "").lower()
            or needle in str(r.get("symbol") or "").lower()
            or needle in str(r.get("source") or "").lower()
        ]
    return _ok({"events": rows, "count": len(rows)})


@router.get("/audit_engine/trace/{correlation_id}")
async def audit_trace(correlation_id: str = Path(...)):
    """Full end-to-end event chain for one correlation ID (newest first)."""
    from services.audit_engine import audit_engine
    if not correlation_id.strip():
        return _bad("correlation_id is required")
    return _ok({"events": await audit_engine.trace_correlation(correlation_id.strip()), "correlation_id": correlation_id.strip()})


@router.post("/audit_engine/record")
async def audit_record(body: dict = Body(...)):
    """Append one manual audit entry to the immutable trail.

    Body: {"source": "operator", "event": "NOTE", "status": "info",
    "message": "...", "meta": {...}}. ``source`` and ``event`` are required.
    """
    from services.audit_engine import audit_engine
    source = str(body.get("source") or "").strip()
    event = str(body.get("event") or "").strip()
    if not source or not event:
        return _bad("source and event are required")
    status = str(body.get("status") or "info").strip() or "info"
    message = str(body.get("message") or "")
    meta = body.get("meta")
    entry = await audit_engine.record(
        source, event, status, message, meta if isinstance(meta, dict) else None
    )
    return _ok(entry)


@router.post("/audit_engine/flush")
async def audit_flush():
    """Force a ring-buffer persist pass (operational/test)."""
    from services.audit_engine import audit_engine
    return _ok(await audit_engine.flush())


@router.get("/feature_engine/latest")
async def feature_engine_latest(tokens: str = ""):
    """Feature Engine — latest calculated features (real cache)."""
    from core.engines.feature_engine import feature_engine
    wanted = [t.strip() for t in tokens.split(",") if t.strip()] or None
    return _ok({
        "features": feature_engine.get_latest_features(wanted),
        "tokens": wanted or sorted(feature_engine.get_all_features()),
    })


@router.post("/heartbeat-all")
async def heartbeat_all():
    count = get_engine_registry().heartbeat_all()
    return _ok({"heartbeatCount": count})
