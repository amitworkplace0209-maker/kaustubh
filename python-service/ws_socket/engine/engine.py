"""Central Kotak WebSocket Engine facade.

Owns the canonical stream fan-out, subscription registry, field profiles, pin
manager, router and resource monitor. The Kotak connection itself stays owned
by ``ws_socket.ws_manager.WebSocketManager`` (the single SFeedWebSocket owner);
this facade composes it and never opens a socket of its own.
"""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
import time
from collections import deque

from ws_socket.engine.canonical import SDK_VERSION, SCHEMA_VERSION, PreservedRawStore, canonicalize
from ws_socket.engine.pins import PinManager
from ws_socket.engine.profiles import FieldProfileStore, field_source_label
from ws_socket.engine.quality import (
    DEFAULT_DEGRADED_SEC,
    DEFAULT_STALE_SEC,
    FeedQualityMonitor,
)
from ws_socket.engine.registry import InstrumentKey, SubscriptionRegistry
from ws_socket.engine.resources import ResourceMonitor, _current_metrics
from ws_socket.engine.router import TickRouter
from services import pipeline_latency

# Per-token canonical raw bucket depth. Each entry is a full canonical tick
# (measured ~3.4 KB JSON / more in memory: master_canonical + 5-level depth
# book), and the bucket is keyed per instrument (~2.7k live instruments). The
# only consumers are the Raw Tick Inspector, which requests ``limit=20``
# (api/ws_engine.py clamps to 200), and ``live_feed``, which only counts ticks
# inside a window of at most 120s. Holding every tick since process start per
# token therefore grew the heap into the multi-GB range for no consumer. 64
# serves the inspector with headroom and still spans far more than any live
# window (≈0.2 ticks/s/instrument average).
RAW_BUCKET_DEPTH: int = 64
# ``live_feed`` walks every token bucket; its result is memoised for this long
# so the engine-status sampler (and repeated live-feed reads) reuse one pass.
LIVE_FEED_TTL_SEC: float = 2.0
EVENT_ID_COUNTER_PREFIX = "evt"

logger = logging.getLogger("app")


class WebSocketEngine:
    """The reusable central market-data distribution service."""

    def __init__(self, owner=None) -> None:
        self.owner = owner  # the single Kotak WS connection manager
        self.registry = SubscriptionRegistry()
        self.profiles = FieldProfileStore()
        self.pins = PinManager()
        self.resources = ResourceMonitor()
        self.router = TickRouter(self.profiles)
        self.raw_store = PreservedRawStore()

        # Feed Quality Monitor (websocket-engine.md §18–§21): per-instrument
        # quality, rolling feed speed, latency percentiles and stale detection.
        _stale_sec = self._configured_stale_sec()
        self.quality = FeedQualityMonitor(
            degraded_sec=min(DEFAULT_DEGRADED_SEC, _stale_sec / 3.0),
            stale_sec=_stale_sec,
        )

        # MASTER CANONICAL ADAPTER (default ON: every validated tick carries
        # the authoritative master canonical object -- storage + Feature Engine
        # handoff, fully additive; legacy flat keys unchanged). Disable via
        # set_master_canonical_enabled(False) + restart if a rollback is needed.
        # See L8_MASTER_CANONICAL_ADAPTER_FORENSIC_AUDIT.
        self.master_canonical_enabled = True

        # Built-in Data Saver: consumes the canonical engine stream (P0, every
        # instrument, full raw). The Connection Manager drains this consumer
        # and routes each payload to the DB Writer Engine, so the engine never
        # silently loses data even if no API consumer registers.
        self.router.register({
            "consumer_id": "data_saver",
            "consumer_type": "DATA_SAVER",
            "profile_id": "FULL_RAW",
            "priority": "P0",
        })

        # canonical raw stream bucket: token -> deque[(received_at, canonical)]
        self._raw_bucket: dict[str, deque[dict]] = {}
        self._raw_lock = asyncio.Lock()
        self._event_counter = 0

        # live_feed memoisation: window_sec -> (computed_at, result)
        self._live_feed_cache: dict[float, tuple[float, dict]] = {}

        # metrics
        self._started_at = time.time()
        self._ticks_ingested = 0
        self._messages_total = 0
        self._messages_by_type: dict[str, int] = {}
        self._recent_rates: deque[float] = deque(maxlen=5000)
        self._latency_samples: deque[float] = deque(maxlen=2000)
        self._publish_errors = 0
        self._last_tick_at: float | None = None
        self._raw_subscribers: dict[str, asyncio.Queue] = {}

        # sync bookkeeping on the broker side
        self._broker_subscribed: set[InstrumentKey] = set()
        self._desired_snapshot: list[dict] = []
        self._profile_dirty = True
        self._registry_dirty = True

        # Thread-safe bridge from the broker feed thread into the async
        # Engine Event Bus. On every decoded tick the manager's hook runs on a
        # socket thread (sync context); the bus publish API is async, so we
        # enqueue here and let a background task drain asynchronously. This is
        # the ONLY source of TICK_RECEIVED / TICK_VALIDATED / TICK_REJECTED.
        self._event_drain: "queue.Queue[tuple[str, dict]]" = queue.Queue()
        self._drain_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Feed ingress (called by ws_manager's raw message hook only)
    # ------------------------------------------------------------------
    def on_feed_message(self, message) -> None:
        """Single entry point for every decoded SFeed message."""
        self._messages_total += 1
        type_name = type(message).__name__
        self._messages_by_type[type_name] = self._messages_by_type.get(type_name, 0) + 1

        received_at = time.time()
        self._event_counter += 1

        # Publish the raw ingress event to the Engine Event Bus (TICK_RECEIVED).
        # Emitted unconditionally for recorded message types so subscribers can
        # observe raw flow even when canonicalization later rejects the tick.
        self._queue_bus_event("TICK_RECEIVED", {
            "type": type_name,
            "receivedAt": received_at,
            "source": "websocket_engine",
        })

        canonical = canonicalize(message, received_at=received_at, event_counter=self._event_counter)
        if not canonical:
            # Validation failed — publish the rejection event, then bail.
            self._queue_bus_event("TICK_REJECTED", {
                "type": type_name,
                "receivedAt": received_at,
                "message": "canonicalization rejected tick",
            })
            self.quality.record_rejected()
            return

        # Master canonical adapter (opt-in, additive). Builds the single
        # authoritative canonical object; attached to the envelope (persists)
        # and to the flat handoff tick (Feature Engine input).
        if self.master_canonical_enabled:
            from ws_socket.engine.master_canonical import build_from_canonical
            master = build_from_canonical(canonical, received_at=received_at)
            canonical["master_canonical"] = master.data

        # Validated tick — the Feature Engine / Watchlist consume this. They
        # expect a FLAT camelCase payload (instrumentToken, ltp, symbol, ...),
        # not the nested canonical envelope, so normalize before publishing.
        flat = self._flat_tick(canonical, received_at)
        if self.master_canonical_enabled and canonical.get("master_canonical"):
            flat["masterCanonical"] = canonical["master_canonical"]
        self._queue_bus_event("TICK_VALIDATED", flat)

        self._last_tick_at = received_at
        self._ticks_ingested += 1
        self._recent_rates.append(received_at)
        self.quality.observe(canonical, received_at=received_at)

        # True broker -> WS engine propagation latency (A). Uses the broker's
        # message-update time, not its last-trade time, so a quiet instrument
        # cannot inflate a transport measurement (see services.pipeline_latency).
        broker_update_ts = canonical.get("broker_update_time")
        if broker_update_ts:
            try:
                pipeline_latency.record("broker_to_ws", received_at - float(broker_update_ts))
            except (TypeError, ValueError):
                pass

        latency_ms = None
        ts = canonical.get("broker_timestamp") or canonical.get("received_at")
        if ts:
            latency_ms = (received_at - float(ts)) * 1000.0
            if 0 <= latency_ms < 10_000:
                self._latency_samples.append(latency_ms)

        # immutable raw blob reference
        reference = self.raw_store.put(message)
        canonical["raw_reference"] = reference

        # Fresh immutable raw blob for lossless persistence. raw_store itself
        # dedups by token digest (reused for the Raw Tick Inspector), but the
        # Mongo copy must reflect THIS exact message, so dump it here.
        blob = message.model_dump(mode="json") if hasattr(message, "model_dump") else None

        # raw stream bucket (Data Saver / raw consumers)
        token = f"{canonical.get('exchange_segment', '')}|{canonical.get('instrument_token', '')}"
        bucket = self._raw_bucket.setdefault(token, deque(maxlen=RAW_BUCKET_DEPTH))
        bucket.append(canonical)

        # fan out to in-process raw-stream subscribers (async safe: queue put is sync)
        for queue in list(self._raw_subscribers.values()):
            try:
                queue.put_nowait(canonical)
            except asyncio.QueueFull:
                continue

        # routing to consumers
        self.router.route(canonical, raw=blob)
        # NOTE: persistence is NOT performed here. The built-in Data Saver
        # consumer (registered above) is drained by the Connection Manager —
        # the consumer-facing routing layer — which forwards each document to
        # the DB Writer Engine. The WebSocket Engine stays a pure feed
        # producer (connection-manager.md §5, §47): no direct WS→Mongo path.

    def set_owner(self, owner) -> None:
        self.owner = owner

    def set_master_canonical_enabled(self, enabled: bool) -> None:
        """Opt-in switch for the MASTER CANONICAL handoff/storage emission."""
        self.master_canonical_enabled = bool(enabled)

    @staticmethod
    def _configured_stale_sec() -> float:
        """Stale threshold from runtime settings (honest fallback when unset)."""
        try:
            from services.runtime_settings import rt_int
            value = rt_int("ws_stale_feed_sec", int(DEFAULT_STALE_SEC))
            if value and value > 0:
                return float(value)
        except Exception:  # noqa: BLE001
            pass
        return DEFAULT_STALE_SEC

    # ------------------------------------------------------------------
    # Engine Event Bus bridge (TICK_RECEIVED / TICK_VALIDATED / TICK_REJECTED)
    # ------------------------------------------------------------------
    def _queue_bus_event(self, event_type: str, data: dict) -> None:
        """Enqueue an event for the async drainer (thread-safe, never blocks)."""
        try:
            self._event_drain.put_nowait((event_type, data))
        except Exception:
            pass

    def start_event_bridge(self) -> None:
        """Start the background task that drains ticks into the event bus."""
        if self._drain_task is not None and not self._drain_task.done():
            return
        try:
            self._drain_task = asyncio.create_task(self._drain_event_loop())
        except RuntimeError:
            self._drain_task = None

    async def stop_event_bridge(self) -> None:
        if self._drain_task is not None:
            self._drain_task.cancel()
            try:
                await self._drain_task
            except asyncio.CancelledError:
                pass
            self._drain_task = None

    async def _drain_event_loop(self) -> None:
        """Drain queued tick events and publish them to the async event bus.

        Never blocks the event loop: the thread-safe drain queue is polled
        with ``get_nowait()`` and back-off sleeps instead of a blocking
        ``queue.Queue.get()`` (which would freeze the whole loop when the
        feed is idle).
        """
        from services.engine_event_bus import get_event_bus, EngineEvent
        while True:
            try:
                event_type, data = self._event_drain.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.02)
                continue
            except Exception:
                await asyncio.sleep(0.05)
                continue
            try:
                delivered = await get_event_bus().publish(EngineEvent(
                    event_type=event_type,
                    source_engine="websocket_engine",
                    data=data,
                ))
                if event_type == "TICK_VALIDATED":
                    # Feed the Session Manager so canonical ACTIVE reflects a
                    # real validated tick (within the active window), never a guess.
                    try:
                        from services.session.session_manager import session_manager
                        session_manager.mark_instrument_tick({
                            "instrumentToken": data.get("instrumentToken", ""),
                            "exchangeSegment": data.get("exchangeSegment", ""),
                        })
                    except Exception as exc:
                        logger.debug("[WS-ENGINE] session tick mark failed: %s", exc)
                    if delivered == 0:
                        logger.debug("[WS-ENGINE] TICK_VALIDATED published with no subscribers")
            except Exception as exc:
                logger.warning("[WS-ENGINE] event bus publish failed (%s): %s", event_type, exc)

    @staticmethod
    def _flat_tick(canonical: dict, received_at: float | None = None) -> dict:
        """Normalize a canonical tick envelope to the flat consumer contract.

        Feature Engine / Watchlist Engine expect camelCase top-level fields
        (``instrumentToken``, ``ltp``, ``symbol``, ``volume``, ``timestamp``),
        while canonical stores them snake_case inside a ``fields`` block.
        """
        fields = canonical.get("fields") or {}
        ts = canonical.get("broker_timestamp") or received_at or canonical.get("received_at")
        ltp = fields.get("ltp")
        tick: dict = {
            "instrumentToken": canonical.get("instrument_token", ""),
            "exchangeSegment": canonical.get("exchange_segment", ""),
            "symbol": canonical.get("trading_symbol") or "",
            "ltp": ltp,
            "lastPrice": ltp,
            "volume": fields.get("volume"),
            "timestamp": ts,
            "open": fields.get("open"),
            "high": fields.get("high"),
            "low": fields.get("low"),
            "prevClose": fields.get("prev_close"),
            "netChange": fields.get("net_change"),
            "netChangePercent": fields.get("net_change_pct"),
            "receivedAt": received_at if received_at is not None else canonical.get("received_at"),
            "brokerUpdateTimestamp": canonical.get("broker_update_time"),
            "source": canonical.get("source", "kotak_neo_sfeed"),
        }
        return {k: v for k, v in tick.items() if v is not None}

    # ------------------------------------------------------------------
    # Broker sync — the only code that talks to the connection owner
    # ------------------------------------------------------------------
    def _sync_desired(self) -> list[dict]:
        """Merge registry intents + pins + Session Manager desired into ONE set.

        The Session Manager's desired set is the authoritative DB-backed
        subscription intent (single source of truth for what must be fed); this
        engine's pins and any API consumer registrations are merged on top and
        deduplicated by the registry. Expired/inactive instruments never appear.
        """
        intents = self.registry.raw_intents()
        # Market Watch Engine: its intraday-eligible universe must be fed by the
        # broker stream (engines/MARKET_WATCH.md §4/§16). Registered as a
        # first-class consumer so dedup / unsubscribe stays authoritative.
        #
        # The bucket is ALWAYS rebuilt from the engine: after the 15:15 Market
        # Watch stop the engine reports no rows, and a leftover bucket from an
        # earlier cycle would otherwise keep the tokens subscribed forever.
        intents.pop("market_watch", None)
        try:
            from services.market_watch_engine import market_watch_engine
            mw_rows = market_watch_engine.eligible_subscription_payload()
            mw_index_rows = market_watch_engine.index_subscription_payload()
        except Exception as exc:
            logger.warning("[WS-ENGINE] market_watch universe sync failed: %s", exc)
            mw_rows = []
            mw_index_rows = []
        if mw_rows or mw_index_rows:
            bucket = intents.setdefault("market_watch", [])
            for row in mw_rows:
                bucket.append({
                    "consumer": "market_watch",
                    "exchange_segment": row.get("exchangeSegment") or "nse_cm",
                    "instrument_token": str(row.get("instrumentToken") or ""),
                    "symbol": row.get("symbol") or "",
                    "is_index": False,
                    "is_depth": False,
                    "feed_level": "L8",
                })
            for row in mw_index_rows:
                bucket.append({
                    "consumer": "market_watch",
                    "exchange_segment": row.get("exchangeSegment") or "idx_nse",
                    "instrument_token": str(row.get("instrumentToken") or ""),
                    "symbol": row.get("symbol") or "",
                    "is_index": True,
                    "is_depth": False,
                    "feed_level": "L1",
                })
        for intent_row in self.pins.intents():
            consumer = intent_row["consumer"]
            bucket = intents.setdefault(consumer, [])
            bucket.append(intent_row)
        # Session Manager desired set feeds the registry as a first-class
        # consumer intent so engine diff/unsubscribe logic stays authoritative.
        try:
            from services.session.session_manager import session_manager
            session_manager.set_pin_intents(self.pins.list())
            desired_rows = session_manager.subscription_desired_keys_by_row()
        except Exception as exc:
            logger.warning("[WS-ENGINE] session manager desired sync failed: %s", exc)
            desired_rows = []
        if desired_rows:
            bucket = intents.setdefault("session_manager", [])
            for row in desired_rows:
                bucket.append({
                    "consumer": "session_manager",
                    "exchange_segment": row.get("exchange_segment", ""),
                    "instrument_token": row.get("instrument_token", ""),
                    "symbol": row.get("symbol") or row.get("trading_symbol") or "",
                    "is_index": row.get("is_index", False),
                    "is_depth": row.get("is_depth", False),
                    "feed_level": row.get("feed_level"),
                    "market_data": row.get("market_data"),
                })
        # Rebuild into the registry so dedup/desired is authoritative.
        for consumer in list(intents):
            self.registry._intents.pop(consumer, None)
        for consumer, rows in intents.items():
            self.registry._intents[consumer] = {}
            for row in rows:
                self.registry.add_instrument(
                    consumer,
                    row["exchange_segment"],
                    row["instrument_token"],
                    row.get("symbol"),
                    is_index=bool(row.get("is_index", False)),
                    is_depth=bool(row.get("is_depth", False)),
                    feed_level=row.get("feed_level"),
                    market_data=str(row.get("market_data") or "L8"),
                )
        desired = self.registry.desired()
        self._desired_snapshot = desired
        return desired

    def _session_subscription_state(self) -> dict[str, int]:
        """Subscription-state counts straight from the Session Manager."""
        try:
            from services.session.session_manager import session_manager
            return session_manager.subscription_counts()
        except Exception:
            return {}

    def _sync_session_manager_routing(self, desired: list[dict]) -> None:
        """Mirror engine-side truth (routing) into the Session Manager."""
        try:
            from services.session.session_manager import session_manager
            from services.session.session_manager import DEFAULT_CONNECTION
            state = "CONNECTED" if self._owner_connected() else "PREPARING"
            session_manager.mark_subscription_routing(state, owner="ws_manager")
            session_manager.set_required_fields(self._required_field_rows(desired))
            if self._owner_connected():
                session_manager.mark_connection_connected(
                    DEFAULT_CONNECTION,
                    broker=getattr(self.owner, "broker_name", None) or "kotak",
                    feed_level=8,
                )
            else:
                session_manager.mark_connection_disconnected(
                    DEFAULT_CONNECTION, reason="owner_connection_down"
                )
        except Exception as exc:
            logger.warning("[WS-ENGINE] session manager mirror failed: %s", exc)

    def _sync_session_manager_intents(self, desired: list[dict]) -> None:
        """Mirror feed-level / routing-target / connection-target intent back
        onto the canonical Session Manager rows (Phase 3 contract).

        The Session Manager decides WHAT/WHICH feed level; the engine confirms
        the routing metadata it is actually serving so intent and reality stay
        aligned and never diverge silently.
        """
        try:
            from services.session.session_manager import session_manager
            from services.session.session_manager import DEFAULT_CONNECTION
            field_rows = {
                (r.get("exchange_segment"), r.get("instrument_token")): r
                for r in self._required_field_rows(desired)
            }
            consumers = self.router.list()
            by_consumer: dict[str, list[str]] = {}
            for consumer in consumers:
                cid = consumer.get("consumer_id")
                if not cid:
                    continue
                by_consumer[cid] = list(
                    (self.registry._intents.get(cid) or {}).keys()
                )
            rows = []
            for token in desired:
                key = InstrumentKey(token.get("exchange_segment", ""), token.get("instrument_token", ""))
                targets = [cid for cid, keys in by_consumer.items() if key in keys]
                fields = (field_rows.get((key.exchange_segment, key.instrument_token)) or {}).get("required_fields", [])
                rows.append({
                    "exchange_segment": key.exchange_segment,
                    "instrument_token": key.instrument_token,
                    "symbol": token.get("symbol") or "",
                    "required_fields": list(fields),
                    "routing_targets": targets,
                    "connection_targets": [DEFAULT_CONNECTION],
                    # Pass the Session Manager's own feed level through untouched;
                    # the manager preserves its stored value when None is given.
                    "feed_level": token.get("feed_level"),
                })
            session_manager.update_routing_metadata(rows)
        except Exception as exc:
            logger.warning("[WS-ENGINE] session manager intent mirror failed: %s", exc)

    def _required_field_rows(self, desired: list[dict]) -> list[dict]:
        """Field requirements per desired instrument from routed profiles."""
        consumers = self.router.list()
        profile_fields: dict[str, list[str]] = {}
        for consumer in consumers:
            pid = consumer.get("profile_id")
            if not pid or pid in profile_fields:
                continue
            profile = self.profiles.get(pid)
            if profile is not None:
                profile_fields[pid] = list(profile.enabled_fields)
        rows: list[dict] = []
        for token in desired:
            key = InstrumentKey(token.get("exchange_segment", ""), token.get("instrument_token", ""))
            fields: list[str] = []
            for consumer in consumers:
                pid = consumer.get("profile_id")
                if not pid or not profile_fields.get(pid):
                    continue
                if key in (self.registry._intents.get(consumer.get("consumer_id"), {}) or {}):
                    for name in profile_fields[pid]:
                        if name not in fields:
                            fields.append(name)
            rows.append({
                "exchange_segment": token.get("exchange_segment", ""),
                "instrument_token": token.get("instrument_token", ""),
                "symbol": token.get("symbol") or "",
                "required_fields": fields,
            })
        return rows

    def _owner_connected(self) -> bool:
        owner = self.owner
        if owner is None:
            return False
        return bool(getattr(owner, "_connected", False))

    async def reconcile_broker_subscriptions(self) -> dict:
        """Push the unique desired set through the single broker owner."""
        if self.owner is None:
            return {"ok": False, "error": "no connection owner", "count": 0}
        desired = self._sync_desired()
        self._sync_session_manager_routing(desired)
        self._sync_session_manager_intents(desired)
        to_sub, to_unsub = self.registry.broker_diff(self._broker_subscribed)
        summary = {
            "ok": True,
            "wanted": len(desired),
            "to_subscribe": len(to_sub),
            "to_unsubscribe": len(to_unsub),
            "count": 0,
        }
        # Unsubscribe instruments the Session Manager no longer desires
        # (expired / inactive / removed) so the feed stays honest.
        if to_unsub:
            unsub_result = await self.owner.unsubscribe(to_unsub)
            if unsub_result.get("ok"):
                for token in to_unsub:
                    self._broker_subscribed.discard(
                        InstrumentKey(token.get("exchange_segment", ""), token.get("instrument_token", ""))
                    )
                try:
                    from services.session.session_manager import session_manager
                    session_manager.mark_broker_unsubscribed(to_unsub, reason="engine reconcile")
                except Exception as exc:
                    logger.debug("[WS-ENGINE] session unsub mirror failed: %s", exc)
        if not to_sub:
            return summary

        # Ask the owning manager to subscribe (it dedups against its own set).
        result = await self.owner.subscribe(to_sub)
        summary["count"] = result.get("count", 0)
        summary["ok"] = bool(result.get("ok", True))
        if result.get("ok"):
            for token in to_sub:
                self._broker_subscribed.add(
                    InstrumentKey(token.get("exchange_segment", ""), token.get("instrument_token", ""))
                )
            try:
                from services.session.session_manager import session_manager
                session_manager.mark_broker_subscribed(to_sub)
                # The engine has applied the desired set it just reconciled.
                session_manager.mark_revision_applied(session_manager.revision())
            except Exception as exc:
                logger.debug("[WS-ENGINE] session sub mirror failed: %s", exc)
        return summary

    async def reconcile(self) -> dict:
        """Alias used by external triggers (e.g. Session Manager POST /reconcile)."""
        return await self.reconcile_broker_subscriptions()

    # ------------------------------------------------------------------
    # Pin helpers (feed intent back into registry + broker sync)
    # ------------------------------------------------------------------
    async def set_pin(self, data: dict) -> dict:
        instrument_key = data.get("instrument_key") or f"{data.get('exchange_segment')}|{data.get('instrument_token')}"
        segment, _, token = instrument_key.partition("|")
        pin = self.pins.set(
            instrument_key,
            data.get("symbol", ""),
            source=data.get("source", "manual"),
            priority=int(data.get("priority", 1)),
            profile_id=data.get("profile_id", "PINNED_HIGH"),
            consumers=data.get("consumers"),
            reason=data.get("reason", ""),
            expires_at=data.get("expires_at"),
        )
        sync = await self.reconcile_broker_subscriptions()
        return {"pin": pin, "sync": sync}

    async def unset_pin(self, instrument_key: str) -> dict:
        removed = self.pins.unset(instrument_key)
        sync = await self.reconcile_broker_subscriptions()
        return {"removed": removed, "sync": sync}

    # ------------------------------------------------------------------
    # Consumer registry
    # ------------------------------------------------------------------
    def register_consumer(self, data: dict) -> dict:
        return {"consumer": self.router.register(data).to_dict()}

    def update_consumer(self, consumer_id: str, data: dict) -> dict:
        consumer = self.router.update(consumer_id, data)
        if consumer is None:
            return {"ok": False, "error": "consumer not found"}
        return {"ok": True, "consumer": consumer.to_dict()}

    def unregister_consumer(self, consumer_id: str) -> dict:
        return {"removed": bool(self.router.unregister(consumer_id))}

    def consumers(self) -> list[dict]:
        return self.router.list()

    def routes(self) -> list[dict]:
        routes = []
        for consumer in self.router.list():
            routes.append({
                "route_id": consumer.get("route_id"),
                "consumer_id": consumer.get("consumer_id"),
                "profile_id": consumer.get("profile_id"),
                "priority": consumer.get("priority"),
                "queue_size": consumer.get("queue_size"),
                "online": consumer.get("online"),
                "enabled": consumer.get("enabled"),
            })
        return routes

    def drain_consumer(self, consumer_id: str, limit: int = 100) -> list[dict]:
        return self.router.drain(consumer_id, limit)

    def set_data_ready_callback(self, callback) -> None:
        """Register a sync callback fired on every routed tick (SDK thread).

        Used by the Connection Manager to wake its fan-out loop the instant a
        tick lands in a consumer queue, instead of polling.
        """
        self.router.set_wakeup(callback)

    def raw_stream(self, token: str, limit: int = 20) -> list[dict]:
        bucket = self._raw_bucket.get(token)
        if not bucket:
            return []
        return list(bucket)[-limit:]

    def live_feed(self, window_sec: float = 10.0) -> dict:
        """Real per-instrument live feed metrics derived from the canonical
        raw buckets (ticks that actually reached the engine). No fabricated
        values: an instrument with no bucket contributes nothing.

        Returns a list of rows (symbol, token, feed, last ltp, last tick ts,
        ticks/sec computed over the rolling window) plus the aggregated rate.

        The result is memoised for ``LIVE_FEED_TTL_SEC`` (keyed by window)
        because the walk covers every instrument bucket and this method is also
        invoked from the engine-status sampler.
        """
        now = time.time()
        cached = self._live_feed_cache.get(window_sec)
        if cached is not None and (now - cached[0]) < LIVE_FEED_TTL_SEC:
            return cached[1]
        total_ticks = 0
        rows: list[dict] = []
        for token, bucket in self._raw_bucket.items():
            recent = [t for t in bucket if (now - float(t.get("received_at") or 0)) <= window_sec]
            total_ticks += len(recent)
            last = bucket[-1] if bucket else None
            segment, _, inst = token.partition("|")
            rows.append({
                "exchange_segment": segment,
                "instrument_token": inst,
                "symbol": (last or {}).get("trading_symbol") or (last or {}).get("symbol") or "",
                "feed_type": (last or {}).get("feed_type"),
                "feed_level": (last or {}).get("feed_level"),
                "ltp": (last or {}).get("ltp"),
                "last_tick_at": (last or {}).get("received_at"),
                "ticks_per_second": round(len(recent) / max(window_sec, 0.001), 2),
                "ticks_in_window": len(recent),
            })
        rows.sort(key=lambda r: r["ticks_per_second"], reverse=True)
        msgs = self._messages_total
        msgs_sec = _rate_moving(self._recent_rates, window_sec=window_sec)
        result = {
            "window_sec": window_sec,
            "instruments": rows,
            "instrument_count": len(rows),
            "ticks_per_second": round(total_ticks / max(window_sec, 0.001), 2),
            "ticks_in_window": total_ticks,
            "ingested_total": self._ticks_ingested,
            "messages_total": msgs,
            "messages_per_second": round(msgs_sec, 2),
            "last_tick_at": self._last_tick_at,
        }
        self._live_feed_cache[window_sec] = (now, result)
        return result

    def raw_lookup(self, reference: str) -> dict | None:
        return self.raw_store.get(reference)

    def subscribe_raw(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=10_000)
        self._raw_subscribers[queue] = queue
        return queue

    def unsubscribe_raw(self, queue) -> None:
        self._raw_subscribers.pop(queue, None)

    # ------------------------------------------------------------------
    # Field verification helpers
    # ------------------------------------------------------------------
    def field_verification(self) -> dict:
        from ws_socket.engine.fields import (
            _FIELDS, additional_fields, field_count, not_provided_reasons, status_counts,
        )

        def _row(f) -> dict:
            return {
                "num": f.num, "field": f.field, "category": f.category,
                "status": f.status, "kotak_attr": f.kotak_attr, "feed_level": f.feed_level,
                "direct_derived": f.direct_derived, "evidence": f.evidence, "notes": f.notes,
            }

        rows = [_row(f) for f in _FIELDS]
        return {
            "total": field_count(),
            "status_counts": status_counts(),
            "not_provided_reasons": not_provided_reasons(),
            "additional_discovered": [_row(f) for f in additional_fields()],
            "rows": rows,
        }

    def field_label(self, field_name: str) -> str:
        return field_source_label(field_name)

    # ------------------------------------------------------------------
    # Metrics / status / health
    # ------------------------------------------------------------------
    def metrics(self) -> dict:
        ram_pct, cpu_pct = _current_metrics()
        ticks_per_second = _rate_moving(self._recent_rates, window_sec=10.0)
        route_stats = self.router.queue_summary()
        latency_samples = list(self._latency_samples)
        avg_lat = sum(latency_samples) / len(latency_samples) if latency_samples else 0.0
        max_lat = max(latency_samples) if latency_samples else 0.0
        return {
            "started_at": self._started_at,
            "messages_total": self._messages_total,
            "messages_by_type": dict(self._messages_by_type),
            "ticks_ingested": self._ticks_ingested,
            "ticks_per_second": round(ticks_per_second, 2),
            "publish_errors": self._publish_errors,
            "routed": self.router.stats(),
            "dropped": self.router.dropped,
            "deferred": self.router.deferred,
            "avg_tick_latency_ms": round(avg_lat, 2),
            "max_tick_latency_ms": round(max_lat, 2),
            "latency_percentiles": self.quality.latency(),
            "feed_quality_overall": self.quality.rates(),
            "raw_store_entries": self.raw_store.size(),
            "queue_sizes": route_stats,
            "engine_cpu_percent": round(cpu_pct, 2),
            "engine_ram_percent": round(ram_pct, 2),
            "last_tick_at": self._last_tick_at,
        }

    # ------------------------------------------------------------------
    # Feed Quality Monitor (websocket-engine.md §18–§21)
    # ------------------------------------------------------------------
    def quality_snapshot(self) -> dict:
        """Overall + per-instrument feed quality (real counters only)."""
        summary = self.quality.summary()
        summary["stale_instruments"] = self.quality.stale_instruments()
        owner_status = self.status()
        summary["connection"] = {
            "connected": bool(owner_status.get("connection_connected")),
            "subscription_count": owner_status.get("subscription_count"),
        }
        return summary

    def quality_instrument(self, identifier: str) -> dict | None:
        return self.quality.instrument(identifier)

    def update_quality_thresholds(self, data: dict) -> dict:
        self.quality.update_thresholds(
            degraded_sec=data.get("degraded_sec"),
            stale_sec=data.get("stale_sec"),
            feed_type_thresholds=data.get("per_feed_type") or data.get("feed_type_thresholds"),
        )
        return self.quality.summary()["thresholds"]

    def status(self) -> dict:
        owner_status = {}
        if self.owner is not None and hasattr(self.owner, "status"):
            try:
                owner_status = self.owner.status()
            except Exception:
                owner_status = {"error": "owner status unavailable"}
        owner_connected = bool(owner_status.get("connected", False) or getattr(self.owner, "_connected", False))
        return {
            "schema_version": SCHEMA_VERSION,
            "sdk_version": SDK_VERSION,
            "owner": type(self.owner).__name__ if self.owner is not None else None,
            "owner_status": owner_status,
            "connection_connected": owner_connected,
            "subscription_count": self.registry.unique_count(),
            "desired_subscriptions": len(self._desired_snapshot),
            "subscription_state": self._session_subscription_state(),
            "active_consumers": len(self.router.list()),
            "active_routes": len(self.routes()),
            "pins": len(self.pins.list()),
            "raw_bucket_tokens": len(self._raw_bucket),
            "ram": {"percent": float(self.resources.ram_pct()), "severity": self.resources.severity(self.resources.ram_pct())},
        }

    def health(self) -> dict:
        ram_pct = float(self.resources.ram_pct())
        severity = self.resources.severity(ram_pct)
        connection_ok = bool(self.owner is not None and (getattr(self.owner, "_connected", False)))
        stale = self._last_tick_at is None or (time.time() - self._last_tick_at) > 60.0
        return {
            "ok": connection_ok and severity not in ("CRITICAL", "EMERGENCY"),
            "connection_ok": connection_ok,
            "feed_stale": stale,
            "ram": {"percent": round(ram_pct, 2), "severity": severity},
            "thresholds": self.resources.thresholds.to_dict(),
            "policy_actions": self.resources.evaluate(ram_pct),
        }

    def subscriptions(self) -> list[dict]:
        """Rich, state-labelled subscription rows from the Session Manager
        (authoritative); falls back to the in-engine desired snapshot."""
        try:
            from services.session.session_manager import session_manager
            snapshot = session_manager.subscription_snapshot()
            if snapshot.get("instruments"):
                return snapshot["instruments"]
        except Exception:
            pass
        return self._desired_snapshot or self.registry.desired()

    def watchlist(self) -> list[dict]:
        out = []
        for row in self.registry.instruments_for("watchlist"):
            out.append({"instrument": row, "profile": "WATCHLIST_LIGHT", "route_status": "active"})
        return out

    def pins_list(self) -> list[dict]:
        return self.pins.list()

    def resources_view(self) -> dict:
        ram_pct, cpu_pct = _current_metrics()
        return {
            "ram_percent": round(ram_pct, 2),
            "cpu_percent": round(cpu_pct, 2),
            "thresholds": self.resources.thresholds.to_dict(),
            "policy": [p.to_dict() for p in self.resources.policy],
            "severity": self.resources.severity(ram_pct),
            "actions": self.resources.evaluate(ram_pct),
        }

    async def update_resources(self, data: dict) -> dict:
        if data.get("thresholds") is not None:
            self.resources.update_thresholds(data["thresholds"])
        if data.get("policy") is not None:
            self.resources.update_policy(data["policy"])
        # Apply degradation booleans to the routed consumers.
        actions = self.resources.evaluate(data.get("ram_percent"))
        for item in actions.get("actions", []):
            service = item.get("service", "").lower()
            stop = item.get("action") == "STOP"
            degrade = item.get("action") in ("DEGRADE", "THROTTLE", "STOP")
            for consumer in self.router.list():
                ctype = consumer.get("consumer_type", "").lower()
                if service in ctype or service in consumer.get("consumer_id", "").lower():
                    priority = consumer.get("priority", "P2")
                    if priority in ("P0", "P1") and stop:
                        continue  # never silently disable risk-critical routes
                    enabled = (not (degrade or stop)) or priority in ("P0", "P1")
                    self.router.update(consumer["consumer_id"], {"enabled": enabled})
        return self.resources_view()

    async def control_connection(self, action: str) -> dict:
        if self.owner is None:
            return {"ok": False, "error": "no connection owner"}
        # Delegate to the owner's supervisor where it exists; otherwise fall
        # back to a reconnect via subscribe re-apply.
        methods = {
            "connect": ("start_supervisor", "connect", "start"),
            "disconnect": ("stop_supervisor", "disconnect", "stop"),
            "reconnect": ("reconnect",),
        }
        fn_names = methods.get(action, ())
        for name in fn_names:
            fn = getattr(self.owner, name, None)
            if not callable(fn):
                continue
            try:
                result = fn()
                if asyncio.iscoroutine(result):
                    result = await result
                return {"ok": True, "action": action, "method": name, "result": result}
            except Exception as exc:  # pragma: no cover
                return {"ok": False, "action": action, "error": str(exc)}
        return {"ok": False, "action": action, "error": f"owner has no {action} control method"}


def _rate_moving(samples: deque, window_sec: float) -> float:
    if not samples:
        return 0.0
    now = time.time()
    cutoff = now - window_sec
    recent = [t for t in samples if t >= cutoff]
    return len(recent) / window_sec


# module-level singleton used by the API and the ws_manager hook.
engine = WebSocketEngine()