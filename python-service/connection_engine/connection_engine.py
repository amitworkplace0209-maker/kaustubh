"""ConnectionEngine — owns gateway sessions, tick fan-out and event bridging.

It is the backend half of WebSocket #2 (Backend ⇄ Frontend). It attaches each
frontend session to the Kotak Central WebSocket Engine by registering a router
consumer per subscribed market *channel*, drains those consumer queues, applies
per-channel coalescing + rate control, and envelopes every frame. A state bridge
streams ``state_store`` / ``event_bus`` events (positions/orders/notifications/
system/data) onto the same socket so ONE connection carries every realtime event
type per the master architecture.

Persistence is a consumer like any other: the WebSocket Engine's built-in Data
Saver stream is drained here and routed to the DB Writer Engine, so there is no
direct WebSocket-Engine → MongoDB path (connection-manager.md §22/§47).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from datetime import datetime, timezone

from services import pipeline_latency
from ws_socket.engine.canonical import SCHEMA_VERSION

from connection_engine import field_requirements as field_req
from connection_engine.channels import (
    MARKET_CHANNELS,
    STATE_CHANNELS,
    channel_min_interval,
    channel_priority,
    channel_profile,
)
from connection_engine import client as client_mod
from connection_engine.client import ClientSession

logger = logging.getLogger("connection_engine")

FANOUT_POLL_S = 0.15
DRAIN_LIMIT = 200
BRIDGE_POLL_S = 1.0
# Engine status snapshots are only built when a client actually subscribed to
# the ``engines`` channel; never fabricated and never polled when unused.
ENGINE_SNAPSHOT_INTERVAL_S = 2.0
# The aggregated Data Center snapshot is only built when a client actually
# subscribed to the ``data_center`` channel; the underlying service caches the
# document for PUSH_TTL_S so this interval never fans out to a per-client build.
DATA_CENTER_SNAPSHOT_INTERVAL_S = 5.0

# Master-architecture delivery envelope (connection-manager.md §63/§64).
ENVELOPE_VERSION = "1.0"
# Producers understood by the envelope ``source`` field.
SOURCE_GATEWAY = "gateway"
SOURCE_WS_ENGINE = "ws_engine"
SOURCE_FEATURE = "feature_engine"
SOURCE_STATE_BRIDGE = "state_bridge"
SOURCE_ENGINE_SNAPSHOT = "engine_snapshot"
SOURCE_DATA_CENTER = "data_center"

# Feed freshness thresholds (connection-manager.md §56), configurable.
FRESH_MAX_AGE_S = 5.0
DELAYED_MAX_AGE_S = 30.0

# Health vocabulary inputs (connection-manager.md §27/§51).
HEALTH_DEGRADED_DROP_LIMIT = 1000
HEALTH_ERROR_PERSIST_LIMIT = 10
HEALTH_OVERLOAD_QUEUE_RATIO = 0.8

# Event inspector: bounded in-memory ring of real gateway events.
EVENT_LOG_LIMIT = 500

# --------------------------------------------------------------------------- #
# `engines` channel payload budget.
#
# The REST status endpoints return each engine's FULL status, which is right for
# debugging but far too large for a socket: session_manager's phase3/session
# snapshots, the WebSocket engine's owner/resource views and the Market Watch
# universe together pushed ~7MB frames and closed browsers with WebSocket 1009
# (message too big). The socket therefore carries a bounded control-plane
# projection, and the full status stays one REST call away.
# --------------------------------------------------------------------------- #
ENGINE_STATUS_MAX_BYTES = 256 * 1024
_ENGINE_STATUS_MAX_RECORD_BYTES = 16 * 1024
_ENGINE_STATUS_MAX_DEPTH = 4
_ENGINE_STATUS_MAX_LIST = 25
_ENGINE_STATUS_MAX_KEYS = 40
_ENGINE_STATUS_KEEP = (
    "engineId", "engineName", "engineCategory", "version", "state", "health",
    "healthReason", "startedAt", "startedAtAgo", "lastHeartbeat", "heartbeatAge",
    "dependencies", "dependents", "connectionState",
)
_ENGINE_STATUS_DROP = (
    "phase3Snapshot", "subscriptionSnapshot", "engineStatus", "ownerStatus",
    "liveFeed", "resources", "feedQuality", "recovery",
)
_ENGINE_STATUS_SLIM = (
    "engineId", "engineName", "engineCategory", "version", "state", "health",
    "healthReason", "startedAt", "lastHeartbeat",
)

# Persistence path: the built-in Data Saver consumer (registered by the
# WebSocket Engine) is drained here and handed to the DB Writer Engine.
PERSISTENCE_CONSUMER_ID = "data_saver"
PERSISTENCE_POLL_S = 0.2
PERSISTENCE_DRAIN_LIMIT = 500

# state/bus frame -> target channel on the frontend socket
_STATE_TYPE_CHANNEL = {
    "state_changed": "system",
    "service_changed": "system",
    "connection_live": "system",
    "connection_status": "system",
    "market_session": "system",
    "quality_scan_started": "data",
    "quality_scan_finished": "data",
    "quality_scan_error": "data",
    "pipeline_saved": "data",
    "pipeline_error": "data",
    "download_completed": "data",
    "engine_snapshot": "engines",
    "data_center_snapshot": "data_center",
    "market_watch.ranking": "market_watch",
    "market_watch.pins": "market_watch",
    "market_watch.status": "market_watch",
}

_NOTIFICATION_TYPES = (
    "notification.",
    "alert_",
    "notifications.",
)

_ORDER_TYPES = ("order.", "trade.")
_POSITION_TYPES = ("position.", "positions.", "portfolio.", "holdings.")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_placeholder(value) -> dict:
    """Size marker for a fragment cut off by the projection budget."""
    if isinstance(value, dict):
        return {"truncated": "object", "keys": len(value)}
    if isinstance(value, (list, tuple, set)):
        return {"truncated": "array", "items": len(value)}
    return {"truncated": type(value).__name__}


def _bounded_status_value(value, depth: int = 0):
    """Recursively bound a status fragment so no single engine can bloat a frame."""
    if depth >= _ENGINE_STATUS_MAX_DEPTH:
        return value if isinstance(value, (str, int, float, bool)) or value is None else _status_placeholder(value)
    if isinstance(value, dict):
        return {
            str(key): _bounded_status_value(item, depth + 1)
            for key, item in list(value.items())[:_ENGINE_STATUS_MAX_KEYS]
        }
    if isinstance(value, (list, tuple)):
        return [_bounded_status_value(item, depth + 1) for item in list(value)[:_ENGINE_STATUS_MAX_LIST]]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _record_size(value) -> int:
    """Serialized byte size of a value (used for the per-record budget)."""
    try:
        return len(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return 0


def _compact_engine_status(status: dict) -> dict:
    """Control-plane projection of one engine status for the ``engines`` channel.

    Keeps identity/lifecycle/health plus bounded metric and config summaries —
    exactly what the UI engine strip and grid render — and drops the heavy
    nested diagnostics that used to make a single frame ~7MB. Nothing here is
    invented: dropped keys are still available per engine over REST
    (``GET /api/services/engines/{engineId}``).

    A per-record byte budget is applied on top of the key deny-list so an
    unexpected oversized field (a new nested dump, a long row array) can never
    dominate the frame; trimmed key names are reported in ``omittedFields``
    rather than silently disappearing.
    """
    if not isinstance(status, dict):
        return {}
    compact: dict = {}
    for key in _ENGINE_STATUS_KEEP:
        if key in status:
            compact[key] = status[key]
    for key, value in status.items():
        if key in compact or key in _ENGINE_STATUS_DROP:
            continue
        compact[key] = _bounded_status_value(value)
    errors = compact.get("recentErrors")
    if isinstance(errors, (list, tuple)):
        compact["recentErrors"] = list(errors)[:_ENGINE_STATUS_MAX_LIST]

    if _record_size(compact) > _ENGINE_STATUS_MAX_RECORD_BYTES:
        optional = [k for k in compact if k not in _ENGINE_STATUS_KEEP]
        optional.sort(key=lambda k: _record_size(compact[k]), reverse=True)
        omitted: list[str] = []
        for key in optional:
            if _record_size(compact) <= _ENGINE_STATUS_MAX_RECORD_BYTES:
                break
            omitted.append(key)
            del compact[key]
        if omitted:
            compact["omittedFields"] = sorted(omitted)
    return compact


def _engine():
    from api.ws_engine import get_wired_engine

    return get_wired_engine()


def _normalize_frame(frame) -> Optional[dict]:
    """Defensively normalize a bridged frame to a dict.

    ``services.event_bus`` publishes JSON *strings* while ``state_store``
    publishes dicts; the bridge feeds both into ``_broadcast_frame``. Normalize
    here so a string/bytes frame is deserialized instead of crashing the whole
    bridge loop with AttributeError (the previous single-point-of-failure).
    """
    if isinstance(frame, dict):
        return frame
    if isinstance(frame, str) or (isinstance(frame, (bytes, bytearray))):
        try:
            decoded = frame.decode("utf-8") if isinstance(frame, (bytes, bytearray)) else frame
            parsed = json.loads(decoded)
        except (ValueError, TypeError):
            logger.warning("[CONNECTION-ENGINE] dropping non-JSON bridge frame type=%s", type(frame).__name__)
            return None
        if isinstance(parsed, dict):
            return parsed
        logger.warning("[CONNECTION-ENGINE] dropping non-object bridge frame type=%s", type(frame).__name__)
        return None
    logger.warning("[CONNECTION-ENGINE] dropping unsupported bridge frame type=%s", type(frame).__name__)
    return None


def _route_state_channel(frame: dict) -> str:
    ftype = str(frame.get("type") or "")
    if ftype == "state_changed":
        entity = str(frame.get("entity") or "")
        return "notifications" if entity == "notifications" else "system"
    if ftype in _STATE_TYPE_CHANNEL:
        return _STATE_TYPE_CHANNEL[ftype]
    if ftype.startswith("market_watch."):
        return "market_watch"
    if ftype.startswith(_NOTIFICATION_TYPES):
        return "notifications"
    if ftype.startswith(_ORDER_TYPES):
        return "orders" if ftype.startswith("order.") else "positions"
    if ftype.startswith(_POSITION_TYPES):
        return "positions"
    # explicit ws#2 typed events
    if ftype in ("order.update", "order.updated", "order.ack"):
        return "orders"
    if ftype in ("position.update", "position.updated", "position.delta", "square_off.ack"):
        return "positions"
    return "system"


def _map_wire_type(frame: dict) -> str:
    """Map a bridged backend frame type onto the master-architecture envelope."""
    ftype = str(frame.get("type") or "")
    if ftype == "state_changed":
        entity = str(frame.get("entity") or "")
        if entity == "notifications":
            return "notification.count_changed"
        if entity in ("websocket", "app_ws", "session", "broker_ws"):
            return "connection.status"
        if entity == "market":
            return "market.session"
        return "system.status"
    if ftype == "service_changed":
        return "system.status"
    if ftype in ("connection_live", "connection_status"):
        return "connection.status"
    if ftype.startswith(_ORDER_TYPES):
        return f"order.update" if ftype.startswith("order.") else "trade.fill"
    if ftype.startswith(_POSITION_TYPES):
        return "position.update"
    if ftype in ("order.update", "order.updated", "position.update", "position.updated"):
        return ftype
    if ftype == "engine_snapshot":
        return "engine.status"
    if ftype == "data_center_snapshot":
        return "data_center.snapshot"
    if ftype.startswith(("quality_scan_", "pipeline_", "download_")):
        return "data.stream_event"
    if ftype.startswith(_NOTIFICATION_TYPES):
        return "notification.new"
    return ftype


class ConnectionEngine:
    """The ONE backend → frontend distribution engine (WS #2)."""

    def __init__(self) -> None:
        self._sessions: dict[str, ClientSession] = {}
        self._started = False
        self._started_at: float | None = None
        self._bridge_task: asyncio.Task | None = None
        self._persistence_task: asyncio.Task | None = None
        self._engine_snapshot_task: asyncio.Task | None = None
        self._data_center_task: asyncio.Task | None = None
        self._total_frames_routed = 0
        self._ticks_persisted = 0
        self._persist_errors = 0
        # Event-driven wake-up: the WS engine router fires this the instant a
        # tick is queued for a consumer, so fan-out/persistence never wait on a
        # fixed poll interval. FANOUT_POLL_S remains only as a safety fallback.
        self._data_ready: asyncio.Event | None = None
        self._wakeup_registered = False
        # Event inspector (bounded ring, real events only).
        self._event_log: deque[dict] = deque(maxlen=EVENT_LOG_LIMIT)
        # Per-channel delivery-attempt counters + subscriber counts (real).
        self._channel_delivered: dict[str, int] = {}
        self._event_seq = 0

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._started_at = time.time()
        try:
            self._data_ready = asyncio.Event()
            loop = asyncio.get_running_loop()
            engine = _engine()
            if engine is not None and hasattr(engine, "set_data_ready_callback"):
                engine.set_data_ready_callback(
                    lambda: loop.call_soon_threadsafe(self._data_ready.set)
                )
                self._wakeup_registered = True
        except Exception:
            logger.exception("Could not register Connection Engine data-ready wakeup")
        try:
            self._bridge_task = asyncio.get_running_loop().create_task(self._bridge_loop())
        except Exception:
            logger.exception("Could not start Connection Engine bridge")
        try:
            self._persistence_task = asyncio.get_running_loop().create_task(
                self._persistence_loop()
            )
        except Exception:
            logger.exception("Could not start Connection Engine persistence loop")
        try:
            self._engine_snapshot_task = asyncio.get_running_loop().create_task(
                self._engine_snapshot_loop()
            )
        except Exception:
            logger.exception("Could not start Connection Engine engine-status loop")
        try:
            self._data_center_task = asyncio.get_running_loop().create_task(
                self._data_center_snapshot_loop()
            )
        except Exception:
            logger.exception("Could not start Connection Engine data-center loop")
        logger.info("Connection Engine started (backend -> frontend WS #2)")
        self._log_event("info", "engine.started", detail="WS #2 gateway online")

    async def shutdown(self) -> None:
        self._started = False
        if self._bridge_task:
            self._bridge_task.cancel()
            try:
                await self._bridge_task
            except (asyncio.CancelledError, Exception):
                pass
            self._bridge_task = None
        if self._persistence_task:
            self._persistence_task.cancel()
            try:
                await self._persistence_task
            except (asyncio.CancelledError, Exception):
                pass
            self._persistence_task = None
        if self._engine_snapshot_task:
            self._engine_snapshot_task.cancel()
            try:
                await self._engine_snapshot_task
            except (asyncio.CancelledError, Exception):
                pass
            self._engine_snapshot_task = None
        if self._data_center_task:
            self._data_center_task.cancel()
            try:
                await self._data_center_task
            except (asyncio.CancelledError, Exception):
                pass
            self._data_center_task = None
        for connection_id in list(self._sessions):
            await self.detach(connection_id)
        self._log_event("info", "engine.stopped", detail="WS #2 gateway offline")

    # ------------------------------------------------------------------ #
    # Sessions
    # ------------------------------------------------------------------ #
    def create_session(self, username: str = "anonymous") -> ClientSession:
        return ClientSession(connection_id=uuid.uuid4().hex, username=username)

    async def attach(self, session: ClientSession) -> ClientSession:
        session.closed = False
        session._transition(client_mod.CONNECTING, "gateway accepted websocket")
        self._sessions[session.connection_id] = session
        loop = asyncio.get_event_loop()
        task = loop.create_task(self._fanout_loop(session))
        session.attach_task(task)
        session._transition(client_mod.ACTIVE, "fan-out loop started")
        logger.info("[CE] session attached id=%s username=%s active=%d", session.connection_id, session.username, len(self._sessions))
        self._log_event("info", "session.attached", connection_id=session.connection_id,
                        detail=f"username={session.username} active={len(self._sessions)}")
        return session

    async def detach(self, connection_id: str) -> None:
        session = self._sessions.pop(connection_id, None)
        if session is None:
            return
        engine = _engine()
        for channel, state in list(session.channels.items()):
            consumer_id = state.get("consumer_id", "")
            if consumer_id:
                try:
                    engine.unregister_consumer(consumer_id)
                except Exception:
                    pass
            try:
                engine.registry.clear_consumer(consumer_id or f"{session.connection_id}:{channel}")
            except Exception:
                pass
        session.channels.clear()
        session.state_channels.clear()
        await session.close()
        logger.info("[CE] session detached id=%s active=%d", connection_id, len(self._sessions))
        self._log_event("info", "session.detached", connection_id=connection_id,
                        detail=f"active={len(self._sessions)}")

    def get(self, connection_id: str) -> ClientSession | None:
        return self._sessions.get(connection_id)

    def sessions(self) -> list[dict]:
        return [s.stats_dict() for s in self._sessions.values()]

    # ------------------------------------------------------------------ #
    # Subscribe / unsubscribe
    # ------------------------------------------------------------------ #
    @staticmethod
    def normalize_instruments(rows) -> list[dict]:
        """Accept {'exchange_segment','instrument_token','symbol'} dicts or
        'SEG|TOKEN' strings; resolve bare symbols via the instrument cache."""
        from services.instrument_cache import instrument_cache

        out: list[dict] = []
        for row in rows or []:
            if isinstance(row, str):
                segment, _, token = row.partition("|")
                row = {"exchange_segment": segment, "instrument_token": token, "symbol": ""}
            if not isinstance(row, dict):
                continue
            segment = str(
                row.get("exchange_segment") or row.get("exchangeSegment") or row.get("exSeg") or ""
            ).lower().strip()
            token = str(
                row.get("instrument_token") or row.get("instrumentToken") or row.get("token") or row.get("tk") or ""
            ).strip()
            symbol = str(row.get("symbol") or row.get("tradingSymbol") or "").strip()
            if (not token or not segment) and symbol:
                hit = instrument_cache.lookup_by_symbol(symbol) or instrument_cache.lookup_by_token(symbol)
                if hit:
                    token = token or str(hit.get("token") or "")
                    segment = segment or str(hit.get("exchange") or hit.get("exchangeSegment") or "").lower()
            if token and segment:
                out.append({
                    "exchange_segment": segment,
                    "instrument_token": token,
                    "symbol": symbol or token,
                })
        return out

    async def subscribe(self, session: ClientSession, channels: list[dict]) -> dict:
        engine = _engine()
        results: list[dict] = []
        errors: list[dict] = []
        changed_broker = False

        for entry in channels or []:
            channel = str(entry.get("channel") or "")
            if channel in MARKET_CHANNELS:
                rows = self.normalize_instruments(entry.get("instruments"))
                if not rows:
                    if channel in STATE_CHANNELS:
                        session.state_channels.add(channel)
                        results.append({"channel": channel, "added": 0, "kind": "state"})
                        continue
                    errors.append({"channel": channel, "error": "no valid instruments supplied"})
                    continue
                instr_fields: dict[str, list[str]] = {}
                for raw_row in entry.get("instruments") or []:
                    if not isinstance(raw_row, dict) or not raw_row.get("fields"):
                        continue
                    seg = str(
                        raw_row.get("exchange_segment") or raw_row.get("exchangeSegment") or ""
                    ).lower().strip()
                    tok = str(
                        raw_row.get("instrument_token") or raw_row.get("instrumentToken") or ""
                    ).strip()
                    if seg and tok:
                        instr_fields[f"{seg}|{tok}"] = [
                            str(f).strip() for f in raw_row["fields"] if str(f).strip()
                        ]
                channel_fields = [
                    str(f).strip() for f in (entry.get("fields") or []) if str(f).strip()
                ]
                consumer_id = f"{session.connection_id}:{channel}"
                state = session.channels.setdefault(channel, {
                    "consumer_id": consumer_id,
                    "profile_id": channel_profile(channel),
                    "tokens": {},
                })
                if channel_fields:
                    state["fields"] = channel_fields
                added = []
                for row in rows:
                    key = f"{row['exchange_segment']}|{row['instrument_token']}"
                    if key in state["tokens"]:
                        continue
                    if key in instr_fields:
                        row["fields"] = instr_fields[key]
                    state["tokens"][key] = row
                    added.append(row)

                if "registered" not in state:
                    engine.register_consumer({
                        "consumer_id": consumer_id,
                        "consumer_type": "WS_CLIENT",
                        "profile_id": channel_profile(channel),
                        "priority": channel_priority(channel),
                        "enabled": True,
                        "online": True,
                        "instruments": list(state["tokens"].values()),
                    })
                    state["registered"] = True
                elif added:
                    engine.update_consumer(consumer_id, {"instruments": list(state["tokens"].values())})
                engine.registry.add_instruments(consumer_id, added)
                changed_broker = True
                entry_result = {
                    "channel": channel,
                    "added": len(added),
                    "profile": state["profile_id"],
                    "consumerId": consumer_id,
                }
                requested = list(state.get("fields") or [])
                for row in state["tokens"].values():
                    for name in row.get("fields") or []:
                        if name not in requested:
                            requested.append(name)
                if requested:
                    requirements = field_req.resolve_requirements(
                        requested, feature_source_ok=self._feature_source_ok()
                    )
                    state["field_requirements"] = requirements
                    entry_result["fieldRequirements"] = requirements
                results.append(entry_result)
            elif channel in STATE_CHANNELS:
                session.state_channels.add(channel)
                results.append({"channel": channel, "added": 0, "kind": "state"})
            else:
                errors.append({"channel": channel, "error": "unknown channel"})

        sync = {"ok": False, "count": 0, "reason": ""}
        if changed_broker:
            sync = await engine.reconcile_broker_subscriptions()
        self._log_event(
            "info", "subscription.acked", connection_id=session.connection_id,
            detail=f"results={len(results)} errors={len(errors)} sync_ok={bool(sync.get('ok'))}",
            extra={"added": [r.get("channel") for r in results], "errors": errors[:5]},
        )
        return {"results": results, "errors": errors, "sync": sync}

    async def unsubscribe(self, session: ClientSession, channels: list[dict]) -> dict:
        engine = _engine()
        results: list[dict] = []
        changed_broker = False

        for entry in channels or []:
            channel = str(entry.get("channel") or "")
            if channel in MARKET_CHANNELS:
                state = session.channels.get(channel)
                if not state:
                    if channel in STATE_CHANNELS and channel in session.state_channels:
                        session.state_channels.discard(channel)
                        results.append({"channel": channel, "removed": 0})
                        continue
                    results.append({"channel": channel, "removed": 0, "error": "not subscribed"})
                    continue
                rows = self.normalize_instruments(entry.get("instruments"))
                removed = 0
                for row in rows:
                    key = f"{row['exchange_segment']}|{row['instrument_token']}"
                    if key in state["tokens"]:
                        del state["tokens"][key]
                        try:
                            engine.registry.remove_instrument(
                                state["consumer_id"], row["exchange_segment"], row["instrument_token"]
                            )
                            removed += 1
                        except Exception:
                            pass
                if state["tokens"]:
                    engine.update_consumer(state["consumer_id"], {"instruments": list(state["tokens"].values())})
                else:
                    engine.unregister_consumer(state["consumer_id"])
                    engine.registry.clear_consumer(state["consumer_id"])
                    session.channels.pop(channel, None)
                    session._last_sent = {k: v for k, v in session._last_sent.items() if k[0] != channel}
                    session.state_channels.discard(channel)
                changed_broker = True
                results.append({"channel": channel, "removed": removed})
            elif channel in STATE_CHANNELS:
                session.state_channels.discard(channel)
                results.append({"channel": channel, "removed": 0})
            else:
                results.append({"channel": channel, "removed": 0, "error": "unknown channel"})

        if changed_broker:
            await engine.reconcile_broker_subscriptions()
        self._log_event(
            "info", "subscription.removed", connection_id=session.connection_id,
            detail=f"results={len(results)}",
        )
        return {"results": results}

    async def request_snapshot(self, session: ClientSession, request_id: str = "") -> None:
        """Build a latest-market-value snapshot frame from the central buffer."""
        from services import tick_buffer

        latest = tick_buffer.get_latest_ticks()
        tokens: list[str] = []
        for channel, state in session.channels.items():
            for key in state.get("tokens") or {}:
                _seg, _, token = key.partition("|")
                tokens.append(token)
        ticks = []
        for token in tokens:
            tick = latest.get(str(token))
            if not tick:
                continue
            ticks.append(self._as_tick_view(str(token), tick))
        frame = self._frame(
            session,
            "snapshot",
            channel="market",
            data={"requestId": request_id, "count": len(ticks), "ticks": ticks},
            source=SOURCE_GATEWAY,
            correlation_id=request_id,
        )
        session.outbox.put(frame, critical=True)

    @staticmethod
    def _as_tick_view(token: str, tick: dict) -> dict:
        return {
            "instrument_token": str(tick.get("instrumentToken") or token),
            "exchange_segment": tick.get("exchangeSegment") or "",
            "symbol": tick.get("symbol") or tick.get("tradingSymbol") or token,
            "ltp": tick.get("ltp"),
            "open": tick.get("open"),
            "high": tick.get("high"),
            "low": tick.get("low"),
            "close": tick.get("close") or tick.get("prev_close"),
            "volume": tick.get("volume"),
            "bid": tick.get("bp"),
            "ask": tick.get("sp"),
            "change": tick.get("change"),
            "changePercent": tick.get("changePercent"),
            "receivedAt": tick.get("receivedAt") or tick.get("ts"),
        }

    # ------------------------------------------------------------------ #
    # Frame envelope
    # ------------------------------------------------------------------ #
    @staticmethod
    def _frame(
        session: ClientSession,
        event_type: str,
        *,
        channel: str = "",
        symbol: str = "",
        token: str = "",
        segment: str = "",
        data: dict | None = None,
        source: str = SOURCE_GATEWAY,
        correlation_id: str = "",
    ) -> dict:
        return {
            "type": event_type,
            "event_id": f"{session.connection_id}:{session.next_sequence()}",
            "timestamp": _now_iso(),
            "sequence": session.sequence,
            "channel": channel,
            "symbol": symbol or "",
            "instrument_token": token or "",
            "exchange_segment": segment or "",
            "schema_version": SCHEMA_VERSION,
            "version": ENVELOPE_VERSION,
            "source": source or SOURCE_GATEWAY,
            "correlation_id": correlation_id or "",
            "data": data or {},
        }

    # ------------------------------------------------------------------ #
    # Field requirements (connection-manager.md §10 / §24)
    # ------------------------------------------------------------------ #
    @staticmethod
    def _feature_source_ok() -> bool:
        try:
            from services.engine_registry import get_engine_registry

            status = get_engine_registry().get_status("feature_engine") or {}
            return str(status.get("state") or "") == "RUNNING"
        except Exception:
            return False

    @staticmethod
    def _feature_output_for(token: str) -> dict | None:
        if not token:
            return None
        try:
            from core.engines.feature_engine import feature_engine

            return feature_engine.get_features(str(token))
        except Exception:
            return None

    @staticmethod
    def _requested_fields(session: ClientSession, channel: str, segment: str, token: str) -> list[str]:
        state = session.channels.get(channel) or {}
        row = (state.get("tokens") or {}).get(f"{segment}|{token}") or {}
        return list(row.get("fields") or state.get("fields") or [])

    def _market_frame(self, session: ClientSession, payload: dict, channel: str, drained_at: float | None = None) -> dict:
        token = str(payload.get("instrument_token") or "")
        segment = str(payload.get("exchange_segment") or "")
        fields = payload.get("fields")
        feature_output = self._feature_output_for(token) if token else None
        data = {
            "fields": fields,
            "brokerTimestamp": payload.get("broker_timestamp"),
            "receivedAt": payload.get("received_at"),
            "feedLevel": payload.get("feed_level"),
        }
        requested = self._requested_fields(session, channel, segment, token)
        if requested:
            projected, requirements = field_req.project_fields(
                fields,
                requested,
                feature_output=feature_output,
                feature_source_ok=self._feature_source_ok(),
            )
            data["fields"] = projected
            data["fieldStatus"] = requirements["status"]
            data["fieldSources"] = {
                item["field"]: item["source"]
                for item in requirements["fieldRequirements"]
                if item["status"] == field_req.AVAILABLE
            }
        frame = self._frame(
            session,
            f"market.{payload.get('event_type') or 'tick'}",
            channel=channel,
            symbol=str(payload.get("trading_symbol") or ""),
            token=token,
            segment=segment,
            data=data,
            source=(SOURCE_FEATURE if feature_output else SOURCE_WS_ENGINE),
            correlation_id=str(payload.get("correlation_id") or ""),
        )

        # True backend-leg latency stages D (CM receive → UI send) and C
        # (feature → CM frame). Measured on the backend clock.
        sent_at = time.time()
        received_at = payload.get("received_at")
        if received_at:
            try:
                pipeline_latency.record("ws_recv_to_ui_send", sent_at - float(received_at))
            except (TypeError, ValueError):
                pass
        broker_update_ts = payload.get("broker_update_time")
        if broker_update_ts:
            try:
                pipeline_latency.record("broker_to_ui_send", sent_at - float(broker_update_ts))
            except (TypeError, ValueError):
                pass
        if feature_output:
            feature_ts = feature_output.get("featureTimestamp")
            if feature_ts:
                try:
                    pipeline_latency.record("feature_to_cm_frame", sent_at - float(feature_ts))
                except (TypeError, ValueError):
                    pass
        # Stage D: CM receive to UI send. If a drain timestamp is available,
        # record it; otherwise the measurement falls back to ws_recv_to_ui_send.
        if drained_at is not None:
            try:
                pipeline_latency.record("cm_recv_to_ui_send", sent_at - float(drained_at))
            except (TypeError, ValueError):
                pass
        return frame

    # ------------------------------------------------------------------ #
    # Fan-out loop (per session)
    # ------------------------------------------------------------------ #
    def _coalesce(self, session: ClientSession, payloads: list[dict], drained_at: float | None = None) -> list[dict]:
        reverse = {state["consumer_id"]: ch for ch, state in session.channels.items()}
        by_key: dict[tuple, dict] = {}
        for payload in payloads:
            channel = reverse.get(str(payload.get("consumer_id") or ""))
            if not channel:
                continue
            token = str(payload.get("instrument_token") or "")
            segment = str(payload.get("exchange_segment") or "")
            by_key[(channel, token, segment)] = payload  # latest wins per drain

        frames: list[dict] = []
        now = time.monotonic()
        for (channel, token, _segment), payload in by_key.items():
            interval = channel_min_interval(channel)
            last = session._last_sent.get((channel, token))
            if last is not None and (now - last) < interval:
                continue  # rate-limited: the next fresher tick supersedes
            session._last_sent[(channel, token)] = now
            frames.append(self._market_frame(session, payload, channel, drained_at))
        return frames

    async def _wait_for_data(self, timeout: float) -> None:
        """Block until the WS engine signals a routed tick, or ``timeout``.

        Falls back to a bounded sleep when the wake-up callback could not be
        registered, so behaviour is always correct — just slower.
        """
        event = self._data_ready
        if event is None or not self._wakeup_registered:
            await asyncio.sleep(timeout)
            return
        event.clear()
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass

    async def _fanout_loop(self, session: ClientSession) -> None:
        engine = _engine()
        connection_id = session.connection_id
        while not session.closed:
            try:
                payloads: list[dict] = []
                for channel, state in list(session.channels.items()):
                    consumer_id = state.get("consumer_id", "")
                    if consumer_id:
                        payloads.extend(engine.drain_consumer(consumer_id, DRAIN_LIMIT))
                if payloads:
                    drained_at = time.time()
                    for payload in payloads:
                        recv = payload.get("received_at")
                        if recv:
                            try:
                                pipeline_latency.record(
                                    "ws_recv_to_cm_recv", drained_at - float(recv)
                                )
                            except (TypeError, ValueError):
                                pass
                    batches = self._coalesce(session, payloads)
                    for frame in batches:
                        channel = str(frame.get("channel") or "")
                        session.outbox.put(frame, critical=False)
                        session.ticks_sent += 1
                        self._total_frames_routed += 1
                        self._channel_delivered[channel] = self._channel_delivered.get(channel, 0) + 1
                    for delta in self._drop_delta(session):
                        self._log_event("warn", "outbox.dropped", connection_id=connection_id,
                                        channel=delta[0], detail=delta[1])
                    if len(batches) >= 200:
                        self._log_event("info", "fanout.batch", connection_id=connection_id,
                                        detail=f"delivered={len(batches)}")
                    await asyncio.sleep(0)
                else:
                    await self._wait_for_data(FANOUT_POLL_S)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                session.record_error("fanout_failed", str(exc))
                logger.exception("Fan-out loop error for %s", connection_id)
                self._log_event("error", "fanout.failed", connection_id=connection_id, detail=str(exc))
                await asyncio.sleep(FANOUT_POLL_S)

    # ------------------------------------------------------------------ #
    # State bridge (state_store + event_bus -> sessions)
    # ------------------------------------------------------------------ #
    async def _bridge_loop(self) -> None:
        from services.event_bus import get_event_bus
        from services.state_store import get_state_store

        store = get_state_store()
        bus = get_event_bus()
        q_store = store.subscribe()
        q_bus = bus.subscribe()

        def _drain(queue: asyncio.Queue) -> list[dict]:
            frames = []
            while not queue.empty():
                try:
                    frames.append(queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            return frames

        try:
            while self._started:
                try:
                    await asyncio.wait_for(q_store.get(), timeout=BRIDGE_POLL_S)
                except asyncio.TimeoutError:
                    pass
                frames = _drain(q_store) + _drain(q_bus)
                for frame in frames:
                    logger.info("[BRIDGE.DRAIN] frame type=%s", str(frame.get("type") or "?"))
                    self._broadcast_frame(frame)
        except asyncio.CancelledError:
            pass
        finally:
            try:
                await store.unsubscribe(q_store)
            except Exception:
                pass
            try:
                await bus.unsubscribe(q_bus)
            except Exception:
                pass

    # ------------------------------------------------------------------ #
    # Persistence path: Data Saver -> DB Writer Engine
    # ------------------------------------------------------------------ #
    async def _drain_persistence(self) -> int:
        """Route the built-in Data Saver stream into the DB Writer Engine.

        The WebSocket Engine no longer writes MongoDB itself: persistence is a
        consumer, so the Connection Manager drains the Data Saver consumer and
        hands each standardized document to the DB Writer (connection-
        manager.md §22/§47). Documents are flattened with ``to_storage_doc``
        and validated by the DB Writer; nothing is fabricated here.
        """
        engine = _engine()
        try:
            payloads = engine.drain_consumer(
                PERSISTENCE_CONSUMER_ID, PERSISTENCE_DRAIN_LIMIT
            )
        except Exception:
            logger.exception("Connection Engine: data saver drain failed")
            self._persist_errors += 1
            return 0
        if not payloads:
            return 0
        from services.db_writer_engine import db_writer_engine
        from ws_socket.engine.storage import to_storage_doc

        written = 0
        for payload in payloads:
            try:
                doc = to_storage_doc(payload)
            except Exception:
                self._persist_errors += 1
                continue
            if await db_writer_engine.ingest(doc):
                written += 1
                self._ticks_persisted += 1
                now = time.time()
                received_at = payload.get("received_at")
                if received_at:
                    try:
                        pipeline_latency.record(
                            "ws_recv_to_db_writer", now - float(received_at)
                        )
                    except (TypeError, ValueError):
                        pass
                broker_update_ts = payload.get("broker_update_time")
                if broker_update_ts:
                    try:
                        pipeline_latency.record(
                            "broker_to_db_writer", now - float(broker_update_ts)
                        )
                    except (TypeError, ValueError):
                        pass
        return written

    async def _persistence_loop(self) -> None:
        try:
            while self._started:
                try:
                    written = await self._drain_persistence()
                    if written:
                        self._log_event(
                            "info", "persistence.written",
                            detail=f"written={written} total={self._ticks_persisted}",
                        )
                except Exception:
                    logger.exception("Connection Engine: persistence loop error")
                    self._persist_errors += 1
                    self._log_event("error", "persistence.failed", detail="persistence loop error")
                    written = 0
                if not written:
                    await self._wait_for_data(PERSISTENCE_POLL_S)
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------ #
    # Engine status snapshots (Engine Registry -> "engines" channel)
    # ------------------------------------------------------------------ #
    def _has_engine_subscribers(self) -> bool:
        return any(
            not s.closed and s.has_channel("engines")
            for s in list(self._sessions.values())
        )

    @staticmethod
    def engine_snapshot() -> dict:
        """Live status of every registered engine, keyed by engine id.

        Built from the Engine Registry on demand and only pushed to sessions that
        subscribed to the ``engines`` state channel — this is how the UI consumes
        engine control-plane telemetry through the Connection Manager instead of
        polling each engine's REST status endpoint (connection-manager.md §...).

        Each engine is projected through :func:`_compact_engine_status` and the
        result is held to ``ENGINE_STATUS_MAX_BYTES``; a frame that still busts
        the budget degrades to identity + health only (logged, never silently
        truncated) so one verbose engine can never close the browser socket with
        WebSocket 1009.
        """
        from services.engine_registry import get_engine_registry
        from services.json_safe import sanitize_for_json

        engines: dict[str, dict] = {}
        for status in get_engine_registry().get_all_statuses():
            engine_id = str(status.get("engineId") or "")
            if engine_id:
                engines[engine_id] = _compact_engine_status(status)

        payload = sanitize_for_json(engines)
        try:
            size = len(json.dumps(payload, default=str))
        except (TypeError, ValueError):
            size = 0
        if size > ENGINE_STATUS_MAX_BYTES:
            payload = {
                engine_id: {k: v for k, v in (record or {}).items() if k in _ENGINE_STATUS_SLIM}
                for engine_id, record in payload.items()
            }
            logger.warning(
                "Connection Engine: engine snapshot %d bytes exceeds %d budget; "
                "emitting slim control-plane projection",
                size, ENGINE_STATUS_MAX_BYTES,
            )

        return {
            "type": "engine_snapshot",
            "generatedAt": _now_iso(),
            "count": len(engines),
            "engines": payload,
        }

    async def _engine_snapshot_loop(self) -> None:
        try:
            while self._started:
                try:
                    if self._has_engine_subscribers():
                        self._broadcast_frame(self.engine_snapshot())
                except Exception:
                    logger.exception("Connection Engine: engine snapshot emit failed")
                await asyncio.sleep(ENGINE_SNAPSHOT_INTERVAL_S)
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------ #
    # Data Center snapshots (aggregation service -> "data_center" channel)
    # ------------------------------------------------------------------ #
    def _has_data_center_subscribers(self) -> bool:
        return any(
            not s.closed and s.has_channel("data_center")
            for s in list(self._sessions.values())
        )

    async def data_center_snapshot_frame(self) -> dict:
        """The Data Center page's authoritative snapshot, pushed over WS #2.

        Reuses the same ``services.data_center_snapshot`` aggregation the REST
        endpoint serves (never a second opinion) through its short-TTL push
        cache, so every subscribed client receives the ONE document and an open
        page never triggers a per-client aggregation.
        """
        from services.data_center_snapshot import get_cached_snapshot

        snapshot = await get_cached_snapshot()
        return {
            "type": "data_center_snapshot",
            "generatedAt": _now_iso(),
            "data": snapshot,
        }

    async def _data_center_snapshot_loop(self) -> None:
        try:
            while self._started:
                try:
                    if self._has_data_center_subscribers():
                        self._broadcast_frame(await self.data_center_snapshot_frame())
                except Exception:
                    logger.exception("Connection Engine: data-center snapshot emit failed")
                await asyncio.sleep(DATA_CENTER_SNAPSHOT_INTERVAL_S)
        except asyncio.CancelledError:
            pass

    def _broadcast_frame(self, frame: dict) -> None:
        frame = _normalize_frame(frame)
        if frame is None:
            return
        channel = _route_state_channel(frame)
        wire_type = _map_wire_type(frame)
        critical = channel in ("orders", "notifications", "positions")
        frame_type = str(frame.get("type") or "")
        if frame_type == "engine_snapshot":
            source = SOURCE_ENGINE_SNAPSHOT
        elif frame_type == "data_center_snapshot":
            source = SOURCE_DATA_CENTER
        else:
            source = SOURCE_STATE_BRIDGE
        delivered = 0
        for session in list(self._sessions.values()):
            if session.closed or not session.has_channel(channel):
                logger.info("[BRIDGE.BROADCAST] SKIP session=%s closed=%s has_channel(%s)=%s", session.connection_id, session.closed, channel, session.has_channel(channel))
                continue
            out = self._frame(
                session,
                wire_type,
                channel=channel,
                data=frame,
                source=source,
            )
            session.outbox.put(out, critical=critical)
            session.frames_sent += 1
            logger.info("[BRIDGE.BROADCAST] DELIVER session=%s type=%s channel=%s", session.connection_id, wire_type, channel)
            self._total_frames_routed += 1
            self._channel_delivered[channel] = self._channel_delivered.get(channel, 0) + 1
            delivered += 1
        if delivered:
            self._log_event("info", "broadcast.delivered", channel=channel,
                            detail=f"wire_type={wire_type} delivered={delivered} source={source}")

    # ------------------------------------------------------------------ #
    # Diagnostics
    # ------------------------------------------------------------------ #
    def _feed_freshness(self) -> dict:
        """Backend's own view of feed freshness (FRESH/DELAYED/STALE/NO_DATA).

        Computed from real pipeline activity (last received/last flushed tick),
        never fabricated. Per ``docs/engines/connection-manager.md`` the
        freshness vocabulary describes the delivered feed; connection health
        (session alive) is reported separately on each registry record.
        """
        try:
            from services.tick_buffer import stats as tick_stats
        except Exception:
            return {"state": "NO_DATA", "lastTickAgeSeconds": None}
        try:
            st = tick_stats()
        except Exception:
            return {"state": "NO_DATA", "lastTickAgeSeconds": None}
        last_tick = st.get("lastTickAt")
        if not last_tick:
            return {"state": "NO_DATA", "lastTickAgeSeconds": None}
        age = max(0.0, time.time() - last_tick)
        if age <= FRESH_MAX_AGE_S:
            state = "FRESH"
        elif age <= DELAYED_MAX_AGE_S:
            state = "DELAYED"
        else:
            state = "STALE"
        return {
            "state": state,
            "lastTickAgeSeconds": round(age, 1),
            "lastTickAt": last_tick,
            "ticksPerSecond": st.get("ticksPerSecond", 0),
            "pipelineRunning": bool(st.get("pipelineRunning")),
        }

    def session_records(self) -> list[dict]:
        """Per-consumer connection registry (control-plane diagnostics).

        Each record carries the derived lifecycle ``state`` (spec §23), the
        explicit ``lifecycleState`` with its last transition/reason, real
        delivery/source/delivery-method facts, and last error when one occurred.
        """
        records = []
        for sid, s in list(self._sessions.items()):
            up = max(time.time() - s.attached_at, 0.0)
            delivered = s.ticks_sent + s.frames_sent
            requested_fields: list[str] = []
            for channel_state in s.channels.values():
                for name in channel_state.get("fields") or []:
                    if name not in requested_fields:
                        requested_fields.append(name)
                for row in (channel_state.get("tokens") or {}).values():
                    for name in row.get("fields") or []:
                        if name not in requested_fields:
                            requested_fields.append(name)
            state = s.current_state()
            source = SOURCE_FEATURE if any(
                (channel_state.get("field_requirements") or {}).get("status")
                for channel_state in s.channels.values()
            ) else SOURCE_WS_ENGINE
            records.append({
                "connectionId": str(sid),
                "consumerId": s.connection_id,
                "consumerType": "UI",
                "channels": sorted(s.channels) + sorted(s.state_channels),
                "profiles": sorted({c.get("profile_id", "") for c in s.channels.values()}),
                "instruments": sum(len(c.get("tokens", {})) for c in s.channels.values()),
                "requestedFields": requested_fields,
                "fieldStatus": {
                    channel: (channel_state.get("field_requirements") or {}).get("status")
                    for channel, channel_state in s.channels.items()
                    if channel_state.get("field_requirements")
                },
                "source": source,
                "deliveryMethod": "WEBSOCKET",
                "status": state,
                "lifecycleState": s.lifecycle_state,
                "lastTransitionAt": s.last_transition_at(),
                "lastReason": s.last_reason(),
                "lastActivityAt": s.last_activity_at,
                "lastDeliveredAt": s.last_activity_at,
                "lastError": s.last_error,
                "upSeconds": round(up, 1),
                "messagesDelivered": delivered,
                "deliveryRatePerSec": round(delivered / up, 2) if up > 0 else 0.0,
                "queueDepth": len(s.outbox),
                "queueLimit": s.outbox.maxlen,
                "messagesDropped": s.outbox.dropped_market + s.outbox.dropped_critical,
                "droppedMarket": s.outbox.dropped_market,
                "droppedCritical": s.outbox.dropped_critical,
                "username": s.username,
            })
        return records

    def status(self) -> dict:
        dropped = 0
        delivered = 0
        active = 0
        queue_depth = 0
        queue_max = 0
        for s in list(self._sessions.values()):
            dropped += s.outbox.dropped_market + s.outbox.dropped_critical
            delivered += s.ticks_sent + s.frames_sent
            if not s.closed:
                active += 1
            queue_depth += len(s.outbox)
            queue_max = max(queue_max, len(s.outbox))
        return {
            "started": self._started,
            "startedAt": self._started_at,
            "sessions": len(self._sessions),
            "framesRouted": self._total_frames_routed,
            "marketChannels": sorted(c for c in MARKET_CHANNELS),
            "stateChannels": sorted(c for c in STATE_CHANNELS),
            "stats": {
                "activeConnections": active,
                "totalConnections": len(self._sessions),
                "messagesDelivered": delivered,
                "messagesDropped": dropped,
                "messagesRouted": self._total_frames_routed,
            },
            "channelMetrics": self._channel_metrics(),
            "backpressure": {
                "policy": "DROP_OLDEST",
                "queueLimit": client_mod._outbox_limit(),
                "queueDepthTotal": queue_depth,
                "queueDepthMax": queue_max,
                "droppedMarket": sum(s.outbox.dropped_market for s in list(self._sessions.values())),
                "droppedCritical": sum(s.outbox.dropped_critical for s in list(self._sessions.values())),
            },
            "persistence": {
                "consumerId": PERSISTENCE_CONSUMER_ID,
                "ticksPersisted": self._ticks_persisted,
                "errors": self._persist_errors,
            },
            "freshness": self._feed_freshness(),
            "lifecycle": {
                "engineState": self._started and "RUNNING" or "STOPPED",
                "connections": self._connection_state_counts(),
            },
            "health": self.health(),
            "lastEvents": self.recent_events(limit=8),
            "connectionRegistry": self.session_records(),
        }

    # ------------------------------------------------------------------ #
    # Event inspector (bounded ring — real events only)
    # ------------------------------------------------------------------ #
    def _log_event(
        self,
        level: str,
        event_type: str,
        *,
        channel: str = "",
        connection_id: str = "",
        event_id: str = "",
        detail: str = "",
        extra: dict | None = None,
    ) -> None:
        self._event_seq += 1
        self._event_log.append({
            "seq": self._event_seq,
            "ts": _now_iso(),
            "epoch": time.time(),
            "level": level,
            "eventType": event_type,
            "channel": channel,
            "connectionId": connection_id,
            "eventId": event_id,
            "detail": detail,
            **(extra or {}),
        })

    def recent_events(
        self,
        limit: int = 200,
        *,
        since_epoch: float | None = None,
        event_type: str = "",
        level: str = "",
        channel: str = "",
    ) -> list[dict]:
        """Return real inspector events (newest last), never fabricated."""
        rows = list(self._event_log)
        if since_epoch is not None:
            rows = [r for r in rows if (r.get("epoch") or 0) >= since_epoch]
        if event_type:
            rows = [r for r in rows if r.get("eventType") == event_type]
        if level:
            rows = [r for r in rows if r.get("level") == level]
        if channel:
            rows = [r for r in rows if r.get("channel") == channel]
        return rows[-min(max(1, limit), EVENT_LOG_LIMIT):]

    # ------------------------------------------------------------------ #
    # Connection/engine health (spec §27/§51 vocabulary)
    # ------------------------------------------------------------------ #
    def health(self) -> dict:
        """Connection Manager health: HEALTHY / DEGRADED / NO_DATA /
        OVERLOADED / ERROR / STOPPED — computed from real signals only."""
        checked_at = time.time()
        if not self._started:
            return {"state": "STOPPED", "reason": "gateway not started", "checkedAt": checked_at}
        freshness = self._feed_freshness()["state"]
        sessions = list(self._sessions.values())
        active = sum(1 for s in sessions if not s.closed)
        dropped = sum(s.outbox.dropped_market + s.outbox.dropped_critical for s in sessions)
        queue_max = max((len(s.outbox) for s in sessions), default=0)
        queue_limit = client_mod._outbox_limit()
        persist_errors = self._persist_errors

        base = {
            "feed": freshness,
            "activeConnections": active,
            "totalConnections": len(sessions),
            "messagesDropped": dropped,
            "queueDepthMax": queue_max,
            "persistErrors": persist_errors,
            "checkedAt": checked_at,
        }
        if persist_errors > 0:
            return {
                **base,
                "state": "ERROR",
                "reason": f"{persist_errors} persistence errors (db_writer pipeline)",
            }
        if queue_limit and queue_max >= max(1, int(queue_limit * HEALTH_OVERLOAD_QUEUE_RATIO)):
            return {
                **base,
                "state": "OVERLOADED",
                "reason": f"outbox near capacity ({queue_max}/{queue_limit})",
            }
        if dropped > HEALTH_DEGRADED_DROP_LIMIT or freshness == "STALE":
            return {
                **base,
                "state": "DEGRADED",
                "reason": f"feed={freshness}, dropped={dropped}, active={active}",
            }
        if freshness in ("DELAYED",):
            return {
                **base,
                "state": "DEGRADED",
                "reason": f"feed delayed (age within {DELAYED_MAX_AGE_S:.0f}s window)",
            }
        if freshness == "NO_DATA" and active == 0:
            return {**base, "state": "NO_DATA", "reason": "no active sessions and no feed data"}
        return {**base, "state": "HEALTHY", "reason": f"feed={freshness}, active={active}, dropped={dropped}"}

    def config(self) -> dict:
        """Read-only live configuration of the Connection Manager (control plane)."""
        return {
            "envelopeVersion": ENVELOPE_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "heartbeatIntervalS": client_mod.HEARTBEAT_INTERVAL_S,
            "staleAfterS": client_mod.STALE_AFTER_S,
            "channels": {
                "market": {
                    channel: {
                        "profileId": meta["profile_id"],
                        "priority": meta["priority"],
                        "minIntervalS": meta["min_interval_s"],
                    }
                    for channel, meta in MARKET_CHANNELS.items()
                },
                "state": {channel: description for channel, description in STATE_CHANNELS.items()},
            },
            "fieldSources": field_req.available_fields(),
            "freshnessThresholds": {
                "freshMaxAgeS": FRESH_MAX_AGE_S,
                "delayedMaxAgeS": DELAYED_MAX_AGE_S,
            },
            "backpressure": {
                "policy": "DROP_OLDEST",
                "queueLimit": client_mod._outbox_limit(),
            },
            "deliveryMethods": ["WEBSOCKET"],
            "consumerTypes": ["UI"],
        }

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #
    def _drop_delta(self, session: ClientSession) -> list[tuple[str, str]]:
        prev_m, prev_c = getattr(session, "_last_drops", (0, 0))
        now_m, now_c = session.outbox.dropped_market, session.outbox.dropped_critical
        session._last_drops = (now_m, now_c)
        out: list[tuple[str, str]] = []
        if now_m > prev_m:
            out.append(("market", f"dropped_market={now_m - prev_m}"))
        if now_c > prev_c:
            out.append(("critical", f"dropped_critical={now_c - prev_c}"))
        return out

    def _channel_metrics(self) -> dict:
        metrics: dict[str, dict] = {}
        for channel in MARKET_CHANNELS:
            meta = MARKET_CHANNELS[channel]
            metrics[channel] = {
                "kind": "market",
                "profileId": meta["profile_id"],
                "priority": meta["priority"],
                "minIntervalS": meta["min_interval_s"],
                "subscribers": sum(1 for s in list(self._sessions.values()) if not s.closed and s.has_channel(channel)),
                "delivered": self._channel_delivered.get(channel, 0),
            }
        for channel in STATE_CHANNELS:
            if channel in metrics:
                metrics[channel]["kind"] = "state+market"
                continue
            metrics[channel] = {
                "kind": "state",
                "profileId": "",
                "priority": "",
                "minIntervalS": None,
                "subscribers": sum(1 for s in list(self._sessions.values()) if not s.closed and s.has_channel(channel)),
                "delivered": self._channel_delivered.get(channel, 0),
            }
        return metrics

    def _connection_state_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for s in list(self._sessions.values()):
            state = s.current_state()
            counts[state] = counts.get(state, 0) + 1
        return counts
