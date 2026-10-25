"""Per-channel SNAPSHOT documents for the realtime WebSocket (WS#3).

Why this module exists
    The state channels of the Connection Manager only carried DELTA events
    (``order.update``, ``notification.new``, ``position.update`` …). A page
    that opened between two deltas had to poll REST until the next event
    arrived — which is exactly what the UI did every 2-10 seconds, per page.

    This module gives every state channel an authoritative SNAPSHOT document
    that travels over the SAME socket:

      * once, immediately, when a client subscribes to the channel;
      * afterwards, only when the document actually changed.

    One implementation, one source of truth
        Every builder reuses the exact service call the matching REST route
        uses:

          system        → ``api.system._system_snapshot`` + ``api.system.system_market``
                          + ``api.websocket._build_snapshot``
          notifications → ``services.notification_center.list_notifications``
                          + ``alert_summary``
          orders        → ``services.broker_cache`` ``order_book`` / ``trade_book``
          positions     → the ACTIVE terminal's positions (Kotak: ``api.trading.
                          build_positions_payload``; Dummy: ``api.demo``; any other
                          terminal: ``core.engines.position_engine``)
          portfolio     → ``api.trading_dashboard.trading_dashboard`` (one
                          terminal-aware envelope: funds / positions / holdings /
                          orders)

        The number rendered over the WebSocket is therefore the SAME number
        the REST route would return — the socket is never a second opinion.
        All broker reads go through the single-flight TTL cache
        (``services.broker_cache``), so one snapshot build serves every
        connected client instead of one broker round trip per browser tab.

    Terminal awareness
        The trading channels (``positions`` / ``orders`` / ``portfolio``) are
        TERMINAL-aware: they always describe the ACTIVE terminal (kotak |
        shoonya | dummy), never a hard-coded broker. Switching the terminal
        therefore changes the document, and the change is detected like any
        other state change.

    Change detection
        A stable fingerprint (SHA-1 over the JSON document with volatile keys
        removed) decides whether anything really changed. Volatile keys are
        timestamps, CPU/memory samples and latency probes — jitter there must
        NOT push a frame, while a new order / position / notification always
        does.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any, Awaitable, Callable

logger = logging.getLogger("realtime_snapshots")

# --------------------------------------------------------------------------- #
# Channel catalogue
# --------------------------------------------------------------------------- #
#: Channels that have an authoritative snapshot document.
SNAPSHOT_CHANNELS: tuple[str, ...] = (
    "system",
    "notifications",
    "orders",
    "positions",
    "portfolio",
    "dashboard",
    "watch_scan",
    "sched_events",
)

#: Backend-side re-evaluation cadence per channel (seconds). The browser no
#: longer polls — the socket pushes the document whenever it changes.
CHANNEL_REFRESH_INTERVALS: dict[str, float] = {
    "system": 6.0,
    "notifications": 4.0,
    "orders": 5.0,
    "positions": 5.0,
    "portfolio": 8.0,
    "dashboard": 3.0,
    # watch_scan re-reads the already-computed scan cache (cheap); the scan
    # service itself has the adaptive compute cadence.
    "watch_scan": 5.0,
    # sched_events re-reads the small scheduled_events list (cheap find) so
    # countdowns start from a fresh serverNow and CRUD lands quickly.
    "sched_events": 10.0,
}

#: Slow re-push cadence per channel (seconds).
#:
#: The state signature below decides WHEN a document is pushed. A document
#: whose signature is unchanged is NOT pushed — otherwise every refresh cycle
#: would look like a change and the socket would carry exactly as many bytes
#: as the REST poll it replaced. High-frequency telemetry (CPU %, RAM, tick
#: counters, latency samples) is deliberately outside the signature, so it is
#: re-sent on this slow cadence instead of on every evaluation.
#:
#: ``None`` disables the slow re-push (the document is only sent when its
#: state actually changes).
CHANNEL_FORCE_REFRESH_INTERVALS: dict[str, float | None] = {
    "system": 15.0,
    "notifications": None,
    "orders": None,
    "positions": None,
    "portfolio": None,
    # The dashboard carries the fast telemetry (ticks/sec, counters, latency,
    # uptime). Those stay OUT of the state signature, so they ride on this
    # slow re-push instead of triggering a frame on every evaluation.
    "dashboard": 6.0,
    # watch_scan is pushed only when mover membership / breadth changes; the
    # 10s re-push keeps the strip ltps fresh between real changes.
    "watch_scan": 10.0,
    # sched_events: nextRun bucket (10 min) + statuses are the signature; the
    # 20s re-push keeps the serverNow anchor (countdowns) fresh enough.
    "sched_events": 20.0,
}

#: Broker cache tuning reused from ``api.trading`` so a snapshot refresh and a
#: REST read share ONE cached broker answer.
_BROKER_TTL = 5.0
_BROKER_COOLDOWN = 15.0
_BROKER_TIMEOUT = 4.0


# --------------------------------------------------------------------------- #
# Volatile keys (excluded from the change fingerprint)
# --------------------------------------------------------------------------- #
# Keys whose value changes on EVERY evaluation even when nothing real
# happened. Comparing them would push a frame every cycle (pure traffic).
_VOLATILE_KEYS: frozenset[str] = frozenset({
    "generatedat",
    "generated_at",
    "checkedat",
    "checked_at",
    "server_time_utc",
    "server_time_ist",
    "now_ist",
    "now",
    "updatedat",
    "updated_at",
    "lastupdated",
    "last_updated",
    "uptime",
    "uptimeseconds",
    "cpupercent",
    "cpuload1m",
    "cpuload5m",
    "cpuload15m",
    "ramusedbytes",
    "ramfreebytes",
    "rampercent",
    "lastticktime",
    "lastticksymbol",
    "lasttickat",
    "lastwriteat",
    "lasttickage",
    "feedlatencyms",
    "pipelinelatency",
    "livedata",
    "tickspersecond",
    "writespersecond",
    "latencyms",
    "elapsed",
    "elapsedms",
    "durationms",
    "heartbeat",
    "heartbeatat",
    "sent_at",
    "sentat",
    "receivedat",
    # -- camelCase / snake_case variants seen in the system document -------
    "lastchecked",
    "timestamp",
    "ts",
    "checked",
    "remaining_seconds",
    "remainingseconds",
    "countdown",
    "countdownseconds",
    "secondsleft",
    "secondstogo",
    "next_run_seconds",
    "nextrunseconds",
    "next_run_in",
    "nextrunin",
    "heaptotalmb",
    "heapusedmb",
    "rssmb",
    "heaptotal",
    "heapused",
    "rss",
    "createdat",
    "created_at",
    "duration",
    "durationseconds",
    "lastseen",
    "last_seen",
    "sampleat",
    "polledat",
    "collectedat",
    "fetchedat",
    "syncedat",
    "lastsync",
    "lastupdate",
    "last_update",
    "age",
    "agems",
    "age_ms",
})


def _strip_volatile(value: Any) -> Any:
    """Recursively drop volatile keys so the fingerprint tracks real change."""
    if isinstance(value, dict):
        return {
            key: _strip_volatile(item)
            for key, item in value.items()
            if str(key).lower() not in _VOLATILE_KEYS
        }
    if isinstance(value, (list, tuple)):
        return [_strip_volatile(item) for item in value]
    return value


def snapshot_fingerprint(payload: Any) -> str:
    """Stable hash of a snapshot document, ignoring volatile fields."""
    try:
        raw = json.dumps(_strip_volatile(payload), sort_keys=True, default=str)
    except (TypeError, ValueError):
        raw = repr(payload)
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()


# --------------------------------------------------------------------------- #
# State signatures — what "actually changed" means per channel
# --------------------------------------------------------------------------- #
def _service_signature(services: Any) -> dict:
    """Per-service HEALTH (status/error), without latency samples."""
    if not isinstance(services, dict):
        return {}
    out: dict[str, Any] = {}
    for name, entry in services.items():
        if not isinstance(entry, dict):
            out[str(name)] = entry
            continue
        out[str(name)] = {
            "status": entry.get("status"),
            "error": entry.get("error"),
            "ok": entry.get("ok"),
            "connected": entry.get("connected"),
        }
    return out


def _system_signature(document: dict) -> dict:
    """The STATE of the system document — what a human actually reacts to.

    Deliberately excludes telemetry (CPU %, RAM %, disk bytes, tick counters,
    latency samples, connection timestamps): those change on every evaluation
    and would turn each refresh into a frame. They are re-sent on the slow
    re-push cadence (``CHANNEL_FORCE_REFRESH_INTERVALS``).
    """
    status = document.get("status") if isinstance(document.get("status"), dict) else {}
    state = document.get("state") if isinstance(document.get("state"), dict) else {}
    market = document.get("market") if isinstance(document.get("market"), dict) else {}

    python_status = status.get("pythonStatus") if isinstance(status.get("pythonStatus"), dict) else {}
    mongo = status.get("mongo") if isinstance(status.get("mongo"), dict) else {}
    python = status.get("python") if isinstance(status.get("python"), dict) else {}

    session = state.get("session") if isinstance(state.get("session"), dict) else {}
    websocket = state.get("websocket") if isinstance(state.get("websocket"), dict) else {}
    scheduler = state.get("scheduler") if isinstance(state.get("scheduler"), dict) else {}
    database = state.get("database") if isinstance(state.get("database"), dict) else {}
    internet = state.get("internet") if isinstance(state.get("internet"), dict) else {}

    return {
        # -- backend / broker / scheduler health ------------------------- #
        "mongo": mongo.get("connected"),
        "python": python.get("status"),
        "sdkLoaded": status.get("sdkLoaded"),
        "loggedIn": python_status.get("logged_in"),
        "sessionActive": python_status.get("session_active"),
        "wsState": python_status.get("ws_state"),
        "websocketConnected": status.get("websocketConnected"),
        "schedulerRunning": status.get("schedulerRunning"),
        "schedulerEnabled": status.get("schedulerEnabled"),
        "internetConnected": status.get("internetConnected"),
        # -- trading counters (change when something real happened) ------ #
        "totalOrders": status.get("totalOrders"),
        "totalPositions": status.get("totalPositions"),
        "holdingsCount": status.get("holdingsCount"),
        "activeStocks": status.get("activeStocks"),
        "totalStocks": status.get("totalStocks"),
        # -- per-service health ----------------------------------------- #
        "services": _service_signature(status.get("services")),
        "stateServices": _service_signature(state.get("services")),
        # -- connection engine state ------------------------------------ #
        "terminal": state.get("terminal"),
        "terminalBroker": state.get("terminalBroker"),
        "sessionStatus": session.get("status"),
        "sessionState": session.get("state"),
        "sessionBroker": session.get("broker"),
        "sessionMode": session.get("mode"),
        "ws": {
            "state": websocket.get("state"),
            "connected": websocket.get("connected"),
            "supervisorState": websocket.get("supervisorState"),
            "lifecycleState": websocket.get("lifecycleState"),
            "disconnectReason": websocket.get("disconnectReason"),
        },
        "schedulerState": scheduler.get("state"),
        "database": database.get("connected"),
        "internet": internet.get("connected"),
        # -- market calendar (the bits that change at a session boundary) - #
        "market": {
            "market_status": market.get("market_status"),
            "market_session": market.get("market_session"),
            "day_class": market.get("day_class"),
            "trading_day": market.get("trading_day"),
            "market_state": market.get("market_state"),
        },
    }


def _dashboard_signature(document: Any) -> dict:
    """The state of the Data Saver dashboard document.

    Same philosophy as ``_system_signature``: the signature covers only what a
    human reacts to (connection states, scheduler/session/market state,
    subscriber counts). Fast telemetry — ticks/sec, counters, latency, uptime,
    CPU/RAM, countdowns — stays outside and rides the slow re-push cadence.
    """
    d = document if isinstance(document, dict) else {}
    scheduler = d.get("scheduler") if isinstance(d.get("scheduler"), dict) else {}
    session = d.get("session") if isinstance(d.get("session"), dict) else {}
    ws = d.get("ws") if isinstance(d.get("ws"), dict) else {}
    subscribed = d.get("subscribedStocks") if isinstance(d.get("subscribedStocks"), dict) else {}
    mongo = d.get("mongo") if isinstance(d.get("mongo"), dict) else {}

    return {
        # -- connectivity states (a human always reacts to these) --------- #
        "wsConnected": ws.get("connected"),
        "wsDisconnectedAt": ws.get("disconnectedAt"),
        "wsDisconnectReason": ws.get("disconnectReason"),
        "mongoConnected": mongo.get("connected"),
        "internetOk": (d.get("net") or {}).get("internetOk"),
        # -- session / scheduler states ----------------------------------- #
        "sessionActive": session.get("active"),
        "sessionState": session.get("state"),
        "sessionExpiresAt": session.get("expiresAt"),
        "lastLoginAt": session.get("lastLoginAt"),
        "lastLogoutAt": session.get("lastLogoutAt"),
        "schedulerRunning": scheduler.get("running"),
        "schedulerState": scheduler.get("state"),
        "stateSince": scheduler.get("stateSince"),
        "nextEvent": scheduler.get("nextEvent"),
        "nextEventAt": scheduler.get("nextEventAt"),
        "nextLogin": scheduler.get("nextLogin"),
        "nextWsStart": scheduler.get("nextWsStart"),
        # -- market state (session boundaries) ---------------------------- #
        "market": {
            "marketState": scheduler.get("marketState"),
            "marketStatus": scheduler.get("marketStatus"),
            "marketSession": scheduler.get("marketSession"),
            "dayClass": scheduler.get("dayClass"),
            "tradingDay": scheduler.get("isTradingDay"),
        },
        # -- instrument-count parity (sub changes are real changes) ------- #
        "subscribedActive": subscribed.get("active"),
        "subscribedTotal": subscribed.get("total"),
        "subscribedByWs": subscribed.get("byWs"),
    }


def _generic_signature(document: Any) -> Any:
    """Default signature: the whole document minus volatile fields."""
    return _strip_volatile(document)


async def _build_watch_scan() -> dict:
    """The Data Saver full-market scan summary (the ``watch_scan`` channel).

    The heavy scan pass lives in ``services.market_scan`` and re-computes on
    its own adaptive cadence (fast while the market trades, slow overnight);
    this builder is CHEAP — it only awaits the already-computed document and
    strips the per-instrument ``rows`` (those ride the REST lane; the socket
    carries the light summary: indexes, breadth, window movers, feed meta).

    ``None`` is returned when the first scan pass has not landed yet — the
    snapshot loop simply skips this cycle and tries again on the next tick.
    """
    from services.market_scan import market_scan

    doc = await market_scan.wait_document(timeout=3.0)
    if doc is None:
        return None
    return market_scan.summary_copy()


def _watch_scan_signature(document: Any) -> dict:
    """State of the full-market scan: what a watcher reacts to.

    Mover MEMBERSHIP (and order) plus breadth counts and index availability
    are real changes — per-strip ltps and per-token prices are NOT (they ride
    the slow re-push + the browser's per-token tick overlay, so a signature
    that tracked them would push a frame every scan cycle).
    """
    d = document if isinstance(document, dict) else {}
    scan = d.get("scan") if isinstance(d.get("scan"), dict) else {}
    breadth = d.get("breadth") if isinstance(d.get("breadth"), dict) else {}
    windows = d.get("windows") if isinstance(d.get("windows"), dict) else {}
    movers_raw = d.get("movers") if isinstance(d.get("movers"), dict) else {}
    indexes = d.get("indexes") if isinstance(d.get("indexes"), list) else []

    depth = scan.get("historyDepthSeconds")
    depth_bucket = round(float(depth) / 300.0) * 300 if isinstance(depth, (int, float)) else None
    live = scan.get("liveTokens")
    live_bucket = (int(live) // 100) * 100 if isinstance(live, (int, float)) else None

    return {
        # -- breadth (day) ------------------------------------------------- #
        "measurable": breadth.get("measurable"),
        "advances": breadth.get("advances"),
        "declines": breadth.get("declines"),
        "pct1Up": breadth.get("pct1Up"),
        "pct1Down": breadth.get("pct1Down"),
        "pct2Up": breadth.get("pct2Up"),
        "pct2Down": breadth.get("pct2Down"),
        "pct5Up": breadth.get("pct5Up"),
        "pct5Down": breadth.get("pct5Down"),
        # -- window breadth (1m/5m/10m movers ≥1%) -------------------------- #
        "windows": {
            label: {
                "measurable": (w or {}).get("measurable"),
                "up1": (w or {}).get("up1"),
                "down1": (w or {}).get("down1"),
            }
            for label, w in windows.items()
        },
        # -- mover membership (strips reshuffle only on real rank changes) -- #
        "movers": {
            key: [m.get("token") for m in (rows or [])][:12]
            for key, rows in movers_raw.items()
        },
        # -- indexes: availability + tick health (ltp itself is telemetry) -- #
        "indexes": [
            {"name": (i or {}).get("name"), "quality": (i or {}).get("quality"), "hasLtp": bool((i or {}).get("ltp"))}
            for i in indexes
        ],
        # -- coarse feed health (buckets prevent churn-pushes) -------------- #
        "liveBucket": live_bucket,
        "depthBucket": depth_bucket,
        "feed": scan.get("feed"),
    }


async def _build_sched_events() -> dict:
    """The unified user-defined event scheduler (the ``sched_events`` channel).

    Thin projection of ``services.event_scheduler.state_document()``: every
    user event (schedule, params, notify policy, nextRun, last status) + the
    kind registry. ``None`` while the DB/engine is still warming up — the
    snapshot loop skips this cycle and tries again on the next tick.
    """
    from services.event_scheduler import state_document

    doc = await state_document(max_age=2.5)
    if doc is None:
        return None
    events = doc.get("events") if isinstance(doc.get("events"), list) else []
    return {
        "generatedAt": doc.get("generatedAt"),
        "serverNow": doc.get("serverNow"),
        "timezone": doc.get("timezone"),
        "count": doc.get("count"),
        "kinds": doc.get("kinds"),
        # lastResult can carry a big scan doc (quality scan) — bounds it.
        "events": [
            {**e, "lastResult": None} if isinstance(e.get("lastResult"), dict) and len(json.dumps(e.get("lastResult"), default=str)) > 2000 else e
            for e in events
        ],
    }


def _sched_events_signature(document: Any) -> dict:
    """State of the scheduled events: what a watcher reacts to.

    Per event: enabled, last status, run counters and the nextRun target
    (bucketed to 10 minutes — the browser counts down locally between
    pushes). ``serverNow``/``generatedAt`` are volatile and deliberately
    excluded (they ride the slow re-push instead).
    """
    d = document if isinstance(document, dict) else {}
    events = d.get("events") if isinstance(d.get("events"), list) else []

    def next_bucket(value: Any) -> int | None:
        try:
            from datetime import datetime as _dt

            epoch = _dt.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
            return int(epoch // 600) * 600
        except Exception:
            return None

    return {
        "count": d.get("count"),
        "kinds": [k.get("kind") for k in (d.get("kinds") or []) if isinstance(k, dict)],
        "events": [
            {
                "id": e.get("id"),
                "enabled": e.get("enabled"),
                "lastStatus": e.get("lastStatus"),
                "failCount": e.get("failCount"),
                "runCount": e.get("runCount"),
                "nextBucket": next_bucket(e.get("nextRun")),
            }
            for e in events
            if isinstance(e, dict)
        ],
    }


#: Per-channel signature builders. A signature is the STATE part of a
#: document — the fields a consumer actually reacts to.
_SIGNATURES: dict[str, Callable[[Any], Any]] = {
    "system": _system_signature,
    "dashboard": _dashboard_signature,
    "watch_scan": _watch_scan_signature,
    "sched_events": _sched_events_signature,
}


def channel_signature(channel: str, document: Any) -> str:
    """Hash of the channel's state signature (volatile fields removed)."""
    builder = _SIGNATURES.get(str(channel or ""))
    try:
        signature = builder(document) if builder else _generic_signature(document)
        raw = json.dumps(signature, sort_keys=True, default=str)
    except (TypeError, ValueError):
        raw = repr(document)
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()


def _safe_json(payload: Any) -> Any:
    """Make the document JSON-safe (ObjectId / datetime / Decimal → primitives)."""
    try:
        from services.json_safe import sanitize_for_json

        return sanitize_for_json(payload)
    except Exception:
        return payload


# --------------------------------------------------------------------------- #
# Builders
# --------------------------------------------------------------------------- #
async def _build_system() -> dict:
    """The system-state document (session, terminal, scheduler, resources).

    Reuses the very same builders the REST routes use:
      * ``api.system._system_snapshot``  → ``GET /api/system``
      * ``api.system.system_market``     → ``GET /api/system/market``
      * ``api.websocket._build_snapshot`` → the ``state_snapshot`` the legacy
        SSE stream used to send (session / terminal / websocket / database /
        internet / services).
    """
    from api.system import _system_snapshot, system_market
    from api.websocket import _build_snapshot

    status, market, state = await _gather(
        _system_snapshot(),
        system_market(),
        _build_snapshot(),
    )
    document = {
        "status": _trim_status(status if isinstance(status, dict) else {}),
        "market": market if isinstance(market, dict) else {},
        "state": state if isinstance(state, dict) else {},
    }
    return _enforce_budget(document)


#: Maximum serialized size of one snapshot document (bytes). A frame above
#: this budget is trimmed before it reaches a browser — an oversized frame
#: closes the socket with WebSocket 1009 (message too big).
SNAPSHOT_MAX_BYTES = 512 * 1024


def _trim_status(status: dict) -> dict:
    """Trim the heavy history arrays out of the system status document."""
    trimmed = dict(status)
    detail = trimmed.get("websocketDetail")
    if isinstance(detail, dict):
        detail = dict(detail)
        history = detail.get("connection_history")
        if isinstance(history, list):
            detail["connection_history"] = history[-10:]
        trimmed["websocketDetail"] = detail
    history = trimmed.get("wsConnectionHistory")
    if isinstance(history, list):
        trimmed["wsConnectionHistory"] = history[-10:]
    return trimmed


def _enforce_budget(document: dict) -> dict:
    """Drop the least important sections until the document fits the budget."""
    def _size(value: Any) -> int:
        try:
            return len(json.dumps(value, default=str))
        except (TypeError, ValueError):
            return 0

    if _size(document) <= SNAPSHOT_MAX_BYTES:
        return document

    trimmed = dict(document)
    state = trimmed.get("state")
    if isinstance(state, dict):
        state = dict(state)
        websocket = state.get("websocket")
        if isinstance(websocket, dict):
            websocket = dict(websocket)
            websocket.pop("live", None)
            state["websocket"] = websocket
        state.pop("metrics", None)
        trimmed["state"] = state
    if _size(trimmed) <= SNAPSHOT_MAX_BYTES:
        return trimmed

    status = trimmed.get("status")
    if isinstance(status, dict):
        status = dict(status)
        status.pop("websocketDetail", None)
        status.pop("wsConnectionHistory", None)
        status.pop("services", None)
        trimmed["status"] = status
    return trimmed


async def _build_notifications() -> dict:
    """The notification centre document (list + unread counts + alerts).

    ``list_notifications`` already embeds the unified summary, so the alert
    summary is the only additional read.
    """
    from services.notification_center import alert_summary, list_notifications

    listing, alerts = await _gather(
        list_notifications(limit=100),
        alert_summary(),
    )
    listing = listing if isinstance(listing, dict) else {}
    return {
        "notifications": listing.get("notifications") or [],
        "total": listing.get("total") or 0,
        "unreadCount": listing.get("unreadCount") or 0,
        "categories": listing.get("categories") or {},
        "sources": listing.get("sources") or [],
        "summary": listing.get("summary") or {},
        "alerts": alerts if isinstance(alerts, dict) else {},
        "live": listing.get("live"),
    }


async def _build_orders() -> dict:
    """The order book + executed-trade book document (ACTIVE terminal)."""
    from brokers.manager import active_terminal, get_adapter
    from auth.kotak_client import kotak_session
    from services.broker_cache import broker_cache

    terminal = active_terminal()

    if terminal == "kotak":
        orders, trades = await _gather(
            broker_cache.get(
                "order_book", kotak_session.async_order_book,
                ttl=_BROKER_TTL, fail_cooldown=_BROKER_COOLDOWN, timeout=_BROKER_TIMEOUT,
            ),
            broker_cache.get(
                "trade_book", kotak_session.async_trade_report,
                ttl=_BROKER_TTL, fail_cooldown=_BROKER_COOLDOWN, timeout=_BROKER_TIMEOUT,
            ),
        )
        return {
            "terminal": terminal,
            "isDemo": False,
            "orders": orders if orders is not None else {},
            "trades": trades if trades is not None else {},
        }

    # Dummy / Shoonya: the adapter owns the book.
    try:
        adapter = get_adapter(terminal)
        orders = await adapter.orders()
    except Exception as exc:  # noqa: BLE001 — a snapshot must never kill the loop
        logger.warning("snapshot orders read failed terminal=%s error=%r", terminal, exc)
        orders = None
    trades = None
    try:
        adapter = get_adapter(terminal)
        reader = getattr(adapter, "trade_book", None)
        if reader is not None:
            trades = await reader()
    except Exception as exc:  # noqa: BLE001
        logger.warning("snapshot trade book read failed terminal=%s error=%r", terminal, exc)
    return {
        "terminal": terminal,
        "isDemo": terminal == "dummy",
        "orders": orders if orders is not None else {},
        "trades": trades if trades is not None else {},
    }


async def _terminal_positions_rows(terminal: str) -> tuple[list, str]:
    """Positions rows for ``terminal`` in the shape the UI already consumes.

    * ``kotak``   → ``api.trading.build_positions_payload`` (the SAME builder
      the ``/api/trading/positions`` route uses, incl. the live LTP/OHLC
      enrichment and the instrument-master company name).
    * ``dummy``   → ``api.demo``'s open positions (CASH longs settle into
      holdings and are hidden here, exactly like ``/api/demo/positions``).
    * anything else → the canonical ``position_engine`` shape.
    """
    if terminal == "kotak":
        from api.trading import build_positions_payload
        from auth.kotak_client import kotak_session
        from services.broker_cache import broker_cache

        raw = await broker_cache.get(
            "positions", kotak_session.async_positions,
            ttl=_BROKER_TTL, fail_cooldown=_BROKER_COOLDOWN, timeout=_BROKER_TIMEOUT,
        )
        payload = await build_positions_payload(raw)
        payload = payload if isinstance(payload, dict) else {}
        return list(payload.get("data") or []), (payload.get("stat") or "ok")

    if terminal == "dummy":
        from api.demo import get_dummy_positions, position_visible_in_positions

        rows = await get_dummy_positions()
        visible = [p for p in rows if position_visible_in_positions(p)]
        return visible, "ok"

    from core.engines import position_engine

    payload = await position_engine.get_positions(terminal)
    return list(payload.get("data") or []), (payload.get("stat") or "ok")


async def _build_positions() -> dict:
    """The positions document for the ACTIVE terminal."""
    from brokers.manager import active_terminal

    terminal = active_terminal()
    try:
        rows, stat = await _terminal_positions_rows(terminal)
    except Exception as exc:  # noqa: BLE001 — a snapshot must never kill the loop
        logger.warning("snapshot positions read failed terminal=%s error=%r", terminal, exc)
        rows, stat = [], "unavailable"

    return {
        "terminal": terminal,
        "isDemo": terminal == "dummy",
        "positions": rows,
        "stat": stat,
    }


async def _build_portfolio() -> dict:
    """The portfolio document — ONE terminal-aware envelope.

    Reuses ``api.trading_dashboard.trading_dashboard`` so the socket carries
    the very same ``sections`` envelopes (funds / positions / holdings / orders)
    the ``GET /api/trading/dashboard`` route returns.
    """
    from api.trading_dashboard import trading_dashboard

    payload = await trading_dashboard()
    payload = payload if isinstance(payload, dict) else {}
    return {
        "ok": payload.get("ok", True),
        "terminal": payload.get("terminal"),
        "broker": payload.get("broker"),
        "isDemo": payload.get("isDemo"),
        "isLoggedIn": payload.get("isLoggedIn"),
        "enabled": payload.get("enabled"),
        "generatedAt": payload.get("generatedAt"),
        "sections": payload.get("sections") or {},
    }


async def _build_dashboard() -> dict:
    """The Data Saver dashboard live document (the ``dashboard`` channel).

    ONE authoritative, CHEAP document that the Connection Engine pushes over
    WS#3 (subscribe → immediate push → re-push on real change + 6s telemetry
    cadence). It reuses the very same service reads the REST system routes use
    — ``api.system._system_snapshot`` (the ``GET /api/system`` builder) and
    ``api.system.system_market`` (the market calendar/state snapshot) plus the
    authoritative Session Manager snapshot — so a socket frame can never be a
    second opinion of the REST value.

    Deliberately EXCLUDED (expensive, and not needed for a live overview):
    per-collection Mongo stats, the quality-window aggregation, the events
    trail and storage directories. Those come from the REST dashboard payload
    and are merged on the client; the live document only carries what can be
    read cheaply on the every-3s cadence.
    """
    from api.system import _system_snapshot, system_market

    system, market, snap = await _gather(
        _system_snapshot(),
        system_market(),
        _session_snapshot(),
    )
    system = system if isinstance(system, dict) else {}
    market = market if isinstance(market, dict) else {}
    snap = snap if isinstance(snap, dict) else {}

    sched_info: dict = system.get("schedulerInfo") or {}
    sched_state: dict = system.get("schedulerState") or {}
    buffer: dict = system.get("buffer") or {}
    ws_detail: dict = system.get("websocketDetail") or {}
    python_status: dict = system.get("pythonStatus") or {}
    snap_ws: dict = snap.get("websocket") or {}
    node: dict = system.get("node") or {}
    last_logout: dict = snap.get("lastLogout") or {}

    def _iso_epoch(v: Any) -> str | None:
        n = _num(v)
        if n is None or n <= 0:
            return None
        return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(float(n)))

    def _iso_any(v: Any) -> str | None:
        return str(v) if v else None

    used_bytes = node.get("diskUsedBytes")
    capacity_bytes = node.get("diskTotalBytes")
    attempted = int(buffer.get("totalWritten", 0) or 0) + int(buffer.get("totalWriteErrors", 0) or 0)
    summary_attempted = int(system.get("todayInserts") or 0) + int(system.get("errorCount") or 0)
    attempts = attempted if attempted > 0 else summary_attempted
    saved_total = int(buffer.get("totalWritten", 0) or 0) or int(system.get("todayInserts") or 0)
    save_success_rate = round((saved_total / attempts) * 100, 2) if attempts > 0 else None

    ws_connected = bool(system.get("websocketConnected"))
    connected_at = _iso_any(system.get("wsConnectedAt"))
    ws_uptime_sec: float | None = None
    if ws_connected and connected_at:
        try:
            import datetime as _dt

            start = _dt.datetime.fromisoformat(connected_at)
            if start.tzinfo is None:
                start = start.replace(tzinfo=_dt.timezone.utc)
            ws_uptime_sec = max(0.0, (_dt.datetime.now(_dt.timezone.utc) - start).total_seconds())
        except (ValueError, TypeError):
            ws_uptime_sec = None

    return {
        "generatedAt": _iso_utc_now(),
        # -- market calendar + market state service (the REST envelope's keys) --
        "market": {
            "marketState": market.get("market_state"),
            "marketStatus": market.get("market_status"),
            "marketSession": market.get("market_session"),
            "marketDate": market.get("market_date"),
            "dayClass": market.get("day_class"),
            "closureReason": market.get("closure_reason"),
            "isWeekend": bool(market.get("is_weekend")),
            "isExchangeHoliday": bool(market.get("is_exchange_holiday")),
            "isSpecialClosure": bool(market.get("is_special_closure")),
            "nextMarketOpen": _iso_any(market.get("next_market_open")),
            "nextMarketClose": _iso_any(market.get("next_market_close")),
            "marketStateSource": market.get("market_state_source"),
            "reasonCode": market.get("reason_code"),
            "reasonMessage": market.get("reason_message"),
            "tradingDay": bool(market.get("trading_day", True)),
            "confirmationWindowActive": bool(market.get("confirmation_window_active")),
            "ticksInWindow": market.get("ticks_in_window"),
            "uniqueInstrumentsInWindow": market.get("unique_instruments_in_window"),
        },
        # -- scheduler (same field names the REST envelope exposes) ------------
        "scheduler": {
            "running": bool(system.get("schedulerRunning")),
            "enabled": bool(system.get("schedulerEnabled")),
            "state": sched_state.get("state") or sched_info.get("state") or "UNKNOWN",
            "isTradingDay": bool(sched_info.get("is_trading_day", market.get("trading_day", True))),
            "inLoginWindow": bool(sched_state.get("in_login_window")),
            "inWsWindow": bool(sched_state.get("in_ws_window")),
            "loginTime": _iso_any(sched_state.get("login_time")),
            "logoutTime": _iso_any(sched_state.get("logout_time")),
            "wsStartTime": _iso_any(sched_state.get("ws_start_time")),
            "wsStopTime": _iso_any(sched_state.get("ws_stop_time")),
            "nextLogin": _iso_any(sched_state.get("next_login")),
            "nextLogout": _iso_any(sched_state.get("next_logout")),
            "nextWsStart": _iso_any(sched_state.get("next_ws_start")),
            "nextWsStop": _iso_any(sched_state.get("next_ws_stop")),
            "nextEvent": _iso_any(sched_state.get("next_event")),
            "nextEventAt": _iso_any(sched_state.get("next_event_at")),
            "remainingSeconds": _num(sched_state.get("remaining_seconds")),
            # -- market-state parallels (same keys the REST scheduler block
            #    exposes, so the WS merge keeps them fresh in real time) ----
            "marketState": _iso_any(market.get("market_state")),
            "marketStatus": _iso_any(market.get("market_status")),
            "marketSession": _iso_any(market.get("market_session")),
            "marketDate": _iso_any(market.get("market_date")),
            "dayClass": _iso_any(market.get("day_class")),
            "closureReason": _iso_any(market.get("closure_reason")),
            "isWeekend": bool(market.get("is_weekend")),
            "isExchangeHoliday": bool(market.get("is_exchange_holiday")),
            "isSpecialClosure": bool(market.get("is_special_closure")),
            "marketStateSource": _iso_any(market.get("market_state_source")),
            "marketReasonCode": _iso_any(market.get("reason_code")),
            "marketReasonMessage": _iso_any(market.get("reason_message")),
            "confirmationWindowActive": bool(market.get("confirmation_window_active")),
            "ticksInWindow": market.get("ticks_in_window"),
            "uniqueInstrumentsInWindow": market.get("unique_instruments_in_window"),
            "nextMarketOpen": _iso_any(market.get("next_market_open")),
            "nextMarketClose": _iso_any(market.get("next_market_close")),
            "loginError": _iso_any(sched_state.get("login_error")),
            "wsError": _iso_any(sched_state.get("ws_error")),
            "stateSince": _iso_any(sched_state.get("state_since")),
            "sessionOwner": _iso_any(sched_state.get("session_owner")),
            "nextMarketOpen": _iso_any(market.get("next_market_open")),
        },
        # -- session (Session Manager is THE authority) -------------------------
        "session": {
            "active": bool(snap.get("active")),
            "state": _iso_any(snap.get("state")),
            "stateMessage": _iso_any(snap.get("stateMessage")),
            "user": _iso_any(snap.get("userId")),
            "lastLoginAt": _iso_any(snap.get("loginTime")),
            "lastLogoutAt": _iso_any(last_logout.get("at")),
            "lastLogoutReason": _iso_any(last_logout.get("logoutReason")),
            "loginSource": _iso_any(snap.get("loginSource")),
            "expiresAt": _iso_any(snap.get("expiresAt")),
            "validatedAt": _iso_any(snap.get("validatedAt")),
            "remainingSeconds": _num(snap.get("remainingSeconds")),
            "sessionDurationSeconds": _num(snap.get("sessionDurationSeconds")),
            "lastLoginError": _iso_any(snap.get("lastAuthError")),
            "wsState": _iso_any(snap_ws.get("state") or python_status.get("ws_state")),
        },
        # -- tick pipeline (tick-buffer counters — cheap, in-memory) ------------
        "pipeline": {
            "state": "live" if ws_connected else "stopped",
            "live": ws_connected,
            "ticksPerSec": _num(buffer.get("ticksPerSecond")),
            "savedPerSec": _num(buffer.get("writesPerSecond")),
            "totalReceived": _num(buffer.get("totalReceived")),
            "totalWrites": _num(buffer.get("totalWritten")),
            "failed": _num(buffer.get("totalWriteErrors")),
            "bufferLength": _num(buffer.get("bufferLength")),
            "lastTickAt": _iso_epoch(buffer.get("lastTickAt")) or _iso_any(system.get("lastTickTime")),
            "lastSavedAt": _iso_epoch(buffer.get("lastWriteAt")),
            "feedLatencyMs": _num(buffer.get("feedLatencyMs")),
        },
        "pipelineLive": ws_connected,
        "ticksPerSec": _num(buffer.get("ticksPerSecond")),
        "savedPerSec": _num(buffer.get("writesPerSecond")),
        "activeInstruments": _num(buffer.get("activeTickStocks")),
        "ticksToday": _num(system.get("todayRecords")),
        "dataSaved": _num(system.get("todayInserts")) or saved_total,
        "saveSuccessRate": save_success_rate,
        "qualityScore": None,  # expensive window aggregation — REST owns it
        "wsUptimeSec": _num(ws_uptime_sec),
        "ws": {
            "connected": ws_connected,
            "latencyMs": _num(ws_detail.get("latencyMs") or buffer.get("feedLatencyMs")),
            "disconnectReason": _iso_any(system.get("wsDisconnectReason")),
            "connectedAt": connected_at,
            "disconnectedAt": _iso_any(system.get("wsDisconnectedAt")),
            "lifecycleState": _iso_any(ws_detail.get("lifecycle_state")),
            "reconnectCount": _num(system.get("pythonStatus", {}).get("reconnect_count")
                                   or ws_detail.get("reconnect_count")),
        },
        "mongo": {"connected": bool((system.get("mongo") or {}).get("connected"))},
        "net": {"internetOk": bool(system.get("internetConnected"))},
        "subscribedStocks": {
            "active": _num(system.get("activeStocks")),
            "total": _num(system.get("totalStocks")),
            "byWs": _num(system.get("pythonStatus", {}).get("subscribed_symbols")
                         or ws_detail.get("subscribed_symbols")),
        },
        "storage": {
            "used": _num(used_bytes),
            "capacity": _num(capacity_bytes),
            "free": (_num(capacity_bytes) - _num(used_bytes))
            if (_num(used_bytes) is not None and _num(capacity_bytes) is not None) else None,
        },
        "resources": {
            "cpuPercent": _num(node.get("cpuPercent")),
            "ramPercent": _num(node.get("ramPercent")),
            "uptimeSeconds": _num(node.get("uptimeSeconds")),
        },
    }


def _num(v: Any) -> float | None:
    """Finite number or None — the snapshot never invents a value."""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if n == n and n not in (float("inf"), float("-inf")) else None


def _iso_utc_now() -> str:
    """Current UTC time as one ISO string (a volatile field, fingerprint-ignored)."""
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())


async def _session_snapshot() -> dict:
    """Session Manager's authoritative snapshot, terminal-safe."""
    try:
        from services.session.session_manager import session_manager

        return session_manager.snapshot()
    except Exception as exc:  # noqa: BLE001 — session must never kill a build
        logger.warning("snapshot session read failed: %r", exc)
        return {}


_BUILDERS: dict[str, Callable[[], Awaitable[dict]]] = {
    "system": _build_system,
    "notifications": _build_notifications,
    "orders": _build_orders,
    "positions": _build_positions,
    "portfolio": _build_portfolio,
    "dashboard": _build_dashboard,
    "watch_scan": _build_watch_scan,
    "sched_events": _build_sched_events,
}


async def _gather(*awaitables: Awaitable[Any]) -> list[Any]:
    """Await several coroutines, returning ``None`` for the ones that failed.

    A snapshot is best-effort: one broken sub-read (e.g. the broker is down)
    must never prevent the rest of the document from being delivered.
    """
    results = await asyncio.gather(*awaitables, return_exceptions=True)
    out: list[Any] = []
    for result in results:
        if isinstance(result, BaseException):
            logger.warning("snapshot sub-read failed: %s", result)
            out.append(None)
        else:
            out.append(result)
    return out


def supports_snapshot(channel: str) -> bool:
    return channel in _BUILDERS


#: Broker cache keys each channel reads. A FORCED rebuild invalidates them
#: first, so an explicit "refresh now" really re-reads the broker instead of
#: answering from the 5-second single-flight cache.
_CHANNEL_BROKER_KEYS: dict[str, tuple[str, ...]] = {
    "positions": ("positions",),
    "orders": ("order_book", "trade_book"),
    "portfolio": ("limits", "holdings", "positions", "order_book"),
}


def _invalidate_broker_cache(channel: str) -> None:
    keys = _CHANNEL_BROKER_KEYS.get(str(channel or ""))
    if not keys:
        return
    try:
        from services.broker_cache import broker_cache

        for key in keys:
            broker_cache.invalidate(key)
    except Exception as exc:  # noqa: BLE001 — invalidation must never break a build
        logger.warning("snapshot broker cache invalidation failed channel=%s error=%r", channel, exc)


async def build_snapshot(channel: str, force: bool = False) -> dict | None:
    """Build the snapshot document for ``channel`` (or ``None`` if unsupported).

    Never raises: a failing builder yields ``None`` so the caller can keep the
    last good document instead of pushing an empty one.

    ``force`` bypasses the broker cache, so the document really reflects the
    broker right now (used by the explicit "refresh now" action).
    """
    builder = _BUILDERS.get(str(channel or ""))
    if builder is None:
        return None
    if force:
        _invalidate_broker_cache(channel)
    try:
        payload = await builder()
    except Exception as exc:  # noqa: BLE001 — a snapshot must never kill the loop
        logger.warning("snapshot build failed channel=%s error=%r", channel, exc)
        return None
    if payload is None:
        return None
    return _safe_json(payload)


# --------------------------------------------------------------------------- #
# Snapshot hub — build once, share with every subscriber
# --------------------------------------------------------------------------- #
class SnapshotHub:
    """Owns the per-channel snapshot documents and their change fingerprints.

    One build per channel per refresh tick — N connected browsers share ONE
    broker/DB read instead of each one polling REST on its own timer.
    """

    def __init__(self) -> None:
        self._fingerprints: dict[str, str] = {}
        self._last_built: dict[str, float] = {}
        self._last_pushed: dict[str, float] = {}
        self._documents: dict[str, dict] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    # -- accessors --------------------------------------------------------- #
    def document(self, channel: str) -> dict | None:
        return self._documents.get(channel)

    def fingerprint(self, channel: str) -> str:
        return self._fingerprints.get(channel, "")

    def last_built_at(self, channel: str) -> float | None:
        return self._last_built.get(channel)

    def last_pushed_at(self, channel: str) -> float | None:
        return self._last_pushed.get(channel)

    def is_fresh(self, channel: str, max_age_s: float) -> bool:
        """True when the cached document is younger than ``max_age_s``."""
        built_at = self._last_built.get(channel)
        if built_at is None:
            return False
        return (time.time() - built_at) < max_age_s

    def _lock(self, channel: str) -> asyncio.Lock:
        lock = self._locks.get(channel)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[channel] = lock
        return lock

    # -- building ---------------------------------------------------------- #
    async def build(self, channel: str, force: bool = False) -> dict | None:
        """Build + remember the document. Returns the fresh document.

        One build at a time per channel — N browsers subscribing at the same
        moment share a single broker/DB read. ``force`` re-reads the source
        instead of answering from the broker cache.
        """
        async with self._lock(channel):
            document = await build_snapshot(channel, force=force)
            if document is None:
                return self._documents.get(channel)
            self._documents[channel] = document
            self._fingerprints[channel] = channel_signature(channel, document)
            self._last_built[channel] = time.time()
            self._last_pushed[channel] = self._last_built[channel]
            return document

    async def build_if_changed(self, channel: str) -> tuple[bool, dict | None]:
        """Rebuild the document; report whether the CLIENT should see it.

        The decision uses the channel's *state signature* (see
        ``_SIGNATURES``), not a hash of the whole document: telemetry such as
        CPU % or tick counters changes on every evaluation and must not turn
        into a frame.

        A slow re-push (``CHANNEL_FORCE_REFRESH_INTERVALS``) still re-sends an
        unchanged document every N seconds so the telemetry keeps moving.

        Returns ``(changed, document)``. A failed build keeps the previous
        document and reports ``changed=False`` so a transient broker outage
        never blanks the UI.
        """
        async with self._lock(channel):
            document = await build_snapshot(channel)
            if document is None:
                return False, self._documents.get(channel)
            signature = channel_signature(channel, document)
            previous = self._fingerprints.get(channel)
            self._documents[channel] = document
            self._last_built[channel] = time.time()
            if previous is not None and previous == signature and not self._force_due(channel):
                return False, document
            self._fingerprints[channel] = signature
            self._last_pushed[channel] = time.time()
            return True, document

    def _force_due(self, channel: str) -> bool:
        """True when the slow re-push interval has elapsed for the channel."""
        interval = CHANNEL_FORCE_REFRESH_INTERVALS.get(channel)
        if not interval:
            return False
        last = self._last_pushed.get(channel)
        if last is None:
            return True
        return (time.time() - last) >= interval

    def forget(self, channel: str) -> None:
        self._fingerprints.pop(channel, None)
        self._documents.pop(channel, None)
        self._last_built.pop(channel, None)
        self._last_pushed.pop(channel, None)


#: Process-wide hub used by the Connection Engine.
snapshot_hub = SnapshotHub()
