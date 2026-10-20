"""Connection Engine (backend -> frontend WS #2) unit tests.

Pure unit tests (no MongoDB / no live broker). They cover the envelope
builder, outbox backpressure semantics (latest-value eviction, critical-frame
protection), channel routing of bridged state frames, instrument
normalization, and the subscribe/unsubscribe flow against a fake engine.
"""
import asyncio
import time
import unittest
from unittest import mock

from connection_engine import Outbox
from connection_engine.connection_engine import (
    ENGINE_STATUS_MAX_BYTES,
    PERSISTENCE_CONSUMER_ID,
    ConnectionEngine,
    _map_wire_type,
    _record_size,
    _route_state_channel,
)
from connection_engine import client as client_mod
from connection_engine.client import ClientSession


class FakeBrokerOwner:
    def __init__(self):
        self.calls = 0

    async def subscribe(self, to_sub) -> dict:
        self.calls += 1
        return {"ok": True, "count": len(to_sub)}


class FakeEngine:
    def __init__(self):
        self.router = mock.MagicMock()
        self.registry = mock.MagicMock()
        self.owner = FakeBrokerOwner()
        self._consumers = {}
        self._registered_consumers = {}

    def register_consumer(self, data: dict) -> dict:
        self._consumers[data["consumer_id"]] = data
        return {"consumer": data}

    def update_consumer(self, consumer_id: str, data: dict) -> dict:
        if consumer_id in self._consumers:
            self._consumers[consumer_id].update(data)
            return {"ok": True}
        return {"ok": False}

    def unregister_consumer(self, consumer_id: str) -> dict:
        removed = self._consumers.pop(consumer_id, None)
        return {"removed": bool(removed)}

    def drain_consumer(self, consumer_id: str, limit: int = 100) -> list[dict]:
        return self.registry.pending.pop(consumer_id, [])

    def subscribe_raw(self):
        class _Q(asyncio.Queue):
            pass

        return _Q()

    async def reconcile_broker_subscriptions(self) -> dict:
        to_sub = []
        for cid, data in self._consumers.items():
            for inst in data.get("instruments") or []:
                to_sub.append(inst)
        result = await self.owner.subscribe(to_sub)
        return {
            "ok": bool(result.get("ok")),
            "wanted": len(to_sub),
            "to_subscribe": len(to_sub),
            "count": result.get("count", 0),
        }


class _RegistryStub:
    def __init__(self):
        self.pending = {}
        self.intents = {}

    def add_instruments(self, consumer: str, tokens: list[dict]) -> int:
        rows = self.intents.setdefault(consumer, [])
        before = len(rows)
        known = {f"{r['exchange_segment']}|{r['instrument_token']}" for r in rows}
        for r in tokens:
            key = f"{r['exchange_segment']}|{r['instrument_token']}"
            if key not in known:
                rows.append(r)
                known.add(key)
        return len(rows) - before

    def remove_instrument(self, consumer: str, segment: str, token: str) -> bool:
        rows = self.intents.get(consumer, [])
        key = f"{segment}|{token}"
        for i, r in enumerate(rows):
            if f"{r['exchange_segment']}|{r['instrument_token']}" == key:
                del rows[i]
                return True
        return False

    def clear_consumer(self, consumer: str) -> int:
        return len(self.intents.pop(consumer, []))

    def desired(self) -> list[dict]:
        out = []
        for rows in self.intents.values():
            out.extend(rows)
        return out


def _fake_engine():
    eng = FakeEngine()
    eng.registry = _RegistryStub()
    return eng


class OutboxTests(unittest.TestCase):
    def test_order_is_fifo(self):
        box = Outbox(maxlen=5)
        box.put({"type": "market.tick", "sequence": 1})
        box.put({"type": "system.status", "sequence": 2})

        async def run():
            a = await box.get(timeout=0.5)
            b = await box.get(timeout=0.5)
            return a["type"], b["type"]

        a, b = asyncio.run(run())
        self.assertEqual((a, b), ("market.tick", "system.status"))

    def test_market_overflow_evicts_oldest_market_frame(self):
        box = Outbox(maxlen=2)
        box.put({"type": "market.tick", "sequence": 1})
        box.put({"type": "market.tick", "sequence": 2})
        # Full. Incoming market tick must evict an OLDER market frame, never drop.
        box.put({"type": "market.tick", "sequence": 3})
        self.assertEqual(len(box), 2)
        self.assertEqual(box.dropped_market, 1)

        async def run():
            first = await box.get(timeout=0.5)
            second = await box.get(timeout=0.5)
            return first["sequence"], second["sequence"]

        first, second = asyncio.run(run())
        # The freshest (3) is always kept.
        self.assertEqual(second, 3)

    def test_critical_never_displaced_by_market(self):
        box = Outbox(maxlen=2)
        box.put({"type": "market.tick", "sequence": 1})
        box.put({"type": "market.tick", "sequence": 2})
        # Incoming critical frame evicts one market frame and lands safely.
        box.put({"type": "order.update", "sequence": 9}, critical=True)
        self.assertEqual(len(box), 2)

        async def run():
            out = []
            for _ in range(2):
                item = await box.get(timeout=0.5)
                out.append(item["sequence"])
            return sorted(out)

        out = asyncio.run(run())
        self.assertIn(9, out)
        self.assertLess(box.dropped_critical, 1)


class StateRoutingTests(unittest.TestCase):
    def test_state_changed_routing(self):
        self.assertEqual(
            _route_state_channel({"type": "state_changed", "entity": "notifications"}),
            "notifications",
        )
        self.assertEqual(
            _route_state_channel({"type": "state_changed", "entity": "websocket"}),
            "system",
        )
        self.assertEqual(_route_state_channel({"type": "service_changed"}), "system")

    def test_wire_types(self):
        self.assertEqual(
            _map_wire_type({"type": "state_changed", "entity": "websocket"}),
            "connection.status",
        )
        self.assertEqual(
            _map_wire_type({"type": "state_changed", "entity": "market"}),
            "market.session",
        )
        self.assertEqual(
            _map_wire_type({"type": "state_changed", "entity": "notifications"}),
            "notification.count_changed",
        )
        self.assertEqual(_map_wire_type({"type": "service_changed"}), "system.status")
        self.assertEqual(_map_wire_type({"type": "engine_snapshot"}), "engine.status")


class EngineSnapshotTests(unittest.IsolatedAsyncioTestCase):
    def test_engine_snapshot_routes_to_engines_channel(self):
        from connection_engine.channels import STATE_CHANNELS

        self.assertIn("engines", STATE_CHANNELS)
        self.assertEqual(_route_state_channel({"type": "engine_snapshot"}), "engines")

    def test_engine_snapshot_is_keyed_by_engine_id(self):
        fake = mock.MagicMock()
        fake.engine_id = "feature_engine"
        fake.status_snapshot.return_value = {
            "engineId": "feature_engine",
            "state": "RUNNING",
            "health": "HEALTHY",
        }
        fake2 = mock.MagicMock()
        fake2.engine_id = "db_writer_engine"
        fake2.status_snapshot.return_value = {
            "engineId": "db_writer_engine",
            "state": "RUNNING",
            "health": "HEALTHY",
        }
        with mock.patch(
            "services.engine_registry.get_engine_registry"
        ) as get_registry:
            get_registry.return_value.get_all_statuses.return_value = [
                fake.status_snapshot.return_value,
                fake2.status_snapshot.return_value,
            ]
            snap = ConnectionEngine.engine_snapshot()

        self.assertEqual(snap["type"], "engine_snapshot")
        self.assertEqual(snap["count"], 2)
        self.assertEqual(snap["engines"]["feature_engine"]["state"], "RUNNING")
        self.assertIn("generatedAt", snap)

    async def test_broadcast_only_reaches_engines_subscribers(self):
        engine = ConnectionEngine()
        subscribed = ClientSession(connection_id="c1", username="op")
        subscribed.state_channels.add("engines")
        other = ClientSession(connection_id="c2", username="op")
        other.state_channels.add("system")
        engine._sessions = {"c1": subscribed, "c2": other}
        self.assertTrue(engine._has_engine_subscribers())

        with mock.patch(
            "services.engine_registry.get_engine_registry"
        ) as get_registry:
            get_registry.return_value.get_all_statuses.return_value = [
                {"engineId": "scheduler_engine", "state": "RUNNING", "health": "HEALTHY"}
            ]
            engine._broadcast_frame(ConnectionEngine.engine_snapshot())

        frame = await subscribed.outbox.get(timeout=0.5)
        self.assertEqual(frame["type"], "engine.status")
        self.assertEqual(frame["channel"], "engines")
        self.assertEqual(frame["data"]["engines"]["scheduler_engine"]["state"], "RUNNING")
        self.assertEqual(len(other.outbox), 0)

    def _heavy_status(self) -> dict:
        """A status shaped like the ones that produced ~7MB `engines` frames."""
        universe = [
            {
                "symbol": f"SYM{i}",
                "instrumentToken": str(1000 + i),
                "ltp": 1000.0 + i,
                "depth": {"buy": [{"price": 1.0, "qty": 1}] * 5, "sell": [{"price": 2.0, "qty": 1}] * 5},
            }
            for i in range(3000)
        ]
        return {
            "engineId": "session_manager",
            "engineName": "Session Manager",
            "engineCategory": "SESSION",
            "version": "1.0.0",
            "state": "RUNNING",
            "health": "HEALTHY",
            "healthReason": None,
            "startedAt": "2026-01-01T00:00:00+00:00",
            "lastHeartbeat": "2026-01-01T00:00:00+00:00",
            "metrics": {"custom": {"eligibleUniverseCount": 3000}},
            "recentErrors": [{"code": f"E{i}", "message": "x" * 200} for i in range(5)],
            "dependencies": ["auth_engine"],
            "dependents": ["order_engine"],
            "configSummary": {"instrumentCount": 3000},
            "connectionState": "OPEN",
            # The heavy diagnostics that broke the socket:
            "phase3Snapshot": {"sessions": [{"id": f"s{i}", "detail": "y" * 500} for i in range(200)]},
            "subscriptionSnapshot": {"channels": {"market": [{"token": str(i)} for i in range(5000)]}},
            "engineStatus": {"owner": {"clients": [{"id": i, "blob": "z" * 400} for i in range(500)]}},
            "ownerStatus": {"clients": [{"id": i} for i in range(500)]},
            "liveFeed": {"ticks": [{"t": i} for i in range(5000)]},
            "resources": {"queues": [{"name": "q", "items": [1] * 200} for _ in range(50)]},
            "feedQuality": {"rows": [{"i": i} for i in range(2000)]},
            "universeRows": universe,
        }

    def test_engine_snapshot_drops_heavy_nested_diagnostics(self):
        with mock.patch(
            "services.engine_registry.get_engine_registry"
        ) as get_registry:
            get_registry.return_value.get_all_statuses.return_value = [self._heavy_status()]
            snap = ConnectionEngine.engine_snapshot()

        record = snap["engines"]["session_manager"]
        # Control-plane fields the UI renders survive the projection.
        self.assertEqual(record["engineId"], "session_manager")
        self.assertEqual(record["state"], "RUNNING")
        self.assertEqual(record["health"], "HEALTHY")
        self.assertEqual(record["configSummary"]["instrumentCount"], 3000)
        # The oversized nested diagnostics are gone.
        for heavy in (
            "phase3Snapshot", "subscriptionSnapshot", "engineStatus",
            "ownerStatus", "liveFeed", "resources", "feedQuality",
        ):
            self.assertNotIn(heavy, record)
        # An unknown large array is bounded rather than dropped, and the whole
        # record stays inside the per-record budget.
        self.assertLessEqual(len(record["universeRows"]), 25)
        self.assertLessEqual(_record_size(record), 16 * 1024)

    def test_engine_snapshot_stays_inside_frame_budget(self):
        import json

        statuses = []
        for i in range(6):
            heavy = self._heavy_status()
            heavy["engineId"] = f"engine_{i}"
            statuses.append(heavy)
        with mock.patch(
            "services.engine_registry.get_engine_registry"
        ) as get_registry:
            get_registry.return_value.get_all_statuses.return_value = statuses
            snap = ConnectionEngine.engine_snapshot()

        encoded = json.dumps(snap, default=str)
        self.assertLessEqual(len(encoded), ENGINE_STATUS_MAX_BYTES)
        self.assertEqual(snap["count"], 6)
        self.assertEqual(snap["engines"]["engine_0"]["state"], "RUNNING")

    def test_engine_snapshot_degrades_to_slim_when_budget_exceeded(self):
        import json

        # Many engines each just UNDER the per-record budget: no single record
        # is trimmed, but together they bust the frame budget.
        statuses = []
        for i in range(20):
            record = {
                "engineId": f"engine_{i}",
                "state": "RUNNING",
                "health": "HEALTHY",
                f"pad_{i}": "q" * 15_000,
            }
            statuses.append(record)
        with mock.patch(
            "services.engine_registry.get_engine_registry"
        ) as get_registry:
            get_registry.return_value.get_all_statuses.return_value = statuses
            with self.assertLogs("connection_engine", level="WARNING"):
                snap = ConnectionEngine.engine_snapshot()

        encoded = json.dumps(snap, default=str)
        self.assertLessEqual(len(encoded), ENGINE_STATUS_MAX_BYTES)
        self.assertEqual(snap["count"], 20)
        self.assertEqual(snap["engines"]["engine_0"]["state"], "RUNNING")
        self.assertNotIn("pad_0", snap["engines"]["engine_0"])


class DataCenterSnapshotTests(unittest.IsolatedAsyncioTestCase):
    def test_data_center_snapshot_routes_and_wire_type(self):
        from connection_engine.channels import STATE_CHANNELS

        self.assertIn("data_center", STATE_CHANNELS)
        self.assertEqual(_route_state_channel({"type": "data_center_snapshot"}), "data_center")
        self.assertEqual(
            _map_wire_type({"type": "data_center_snapshot"}), "data_center.snapshot"
        )

    async def test_frame_carries_the_one_authoritative_document(self):
        sentinel = {"overall": "HEALTHY", "generatedAt": "2026-01-01T00:00:00+00:00"}
        with mock.patch(
            "services.data_center_snapshot.get_cached_snapshot",
            new=mock.AsyncMock(return_value=sentinel),
        ):
            frame = await ConnectionEngine().data_center_snapshot_frame()

        self.assertEqual(frame["type"], "data_center_snapshot")
        # The pushed document IS the aggregation service's document, not a copy.
        self.assertIs(frame["data"], sentinel)
        self.assertIn("generatedAt", frame)

    async def test_broadcast_only_reaches_data_center_subscribers(self):
        engine = ConnectionEngine()
        subscribed = ClientSession(connection_id="c1", username="op")
        subscribed.state_channels.add("data_center")
        other = ClientSession(connection_id="c2", username="op")
        other.state_channels.add("engines")
        engine._sessions = {"c1": subscribed, "c2": other}
        self.assertTrue(engine._has_data_center_subscribers())

        with mock.patch(
            "services.data_center_snapshot.get_cached_snapshot",
            new=mock.AsyncMock(return_value={"overall": "HEALTHY"}),
        ):
            engine._broadcast_frame(await engine.data_center_snapshot_frame())

        frame = await subscribed.outbox.get(timeout=0.5)
        self.assertEqual(frame["type"], "data_center.snapshot")
        self.assertEqual(frame["channel"], "data_center")
        self.assertEqual(frame["source"], "data_center")
        self.assertEqual(frame["data"]["data"]["overall"], "HEALTHY")
        self.assertEqual(len(other.outbox), 0)


class InstrumentNormalizeTests(unittest.TestCase):
    def test_accepts_plain_symbols_and_string_rows(self):
        with mock.patch("services.instrument_cache.instrument_cache") as cache:
            cache.lookup_by_symbol.return_value = None
            cache.lookup_by_token.return_value = None
            eng = ConnectionEngine()
            rows = eng.normalize_instruments(["nse_cm|2885", {"exchange_segment": "nse_fo", "instrument_token": "779521"}])
            self.assertEqual(len(rows), 2)
            self.assertIn("nse_cm|2885", [f"{r['exchange_segment']}|{r['instrument_token']}" for r in rows])


class SubscribeFlowTests(unittest.TestCase):
    def test_subscribe_creates_consumer_and_syncs_broker(self):
        eng = _fake_engine()

        async def run():
            engine = ConnectionEngine()
            session = engine.create_session("alice")
            await engine.attach(session)
            try:
                with mock.patch("connection_engine.connection_engine._engine", return_value=eng):
                    result = await engine.subscribe(
                        session,
                        [{"channel": "watchlist", "instruments": [{"exchange_segment": "nse_cm", "instrument_token": "2885"}]}],
                    )
                    return result, engine, session, eng
            finally:
                await engine.detach(session.connection_id)

        result, engine, session, eng = asyncio.run(run())

        self.assertTrue(result["results"][0]["added"] == 1)
        self.assertEqual(eng.owner.calls, 1)
        # Broker-bound instrument intents were recorded before detach cleaned up.
        self.assertEqual(len(eng.registry.intents), 1)
        self.assertEqual(len(session.channels), 0)

    def test_unsubscribe_removes_consumer(self):
        eng = _fake_engine()

        async def run():
            engine = ConnectionEngine()
            session = engine.create_session("bob")
            await engine.attach(session)
            try:
                with mock.patch("connection_engine.connection_engine._engine", return_value=eng):
                    await engine.subscribe(
                        session,
                        [{"channel": "watchlist", "instruments": [{"exchange_segment": "nse_cm", "instrument_token": "2885"}]}],
                    )
                    result = await engine.unsubscribe(
                        session,
                        [{"channel": "watchlist", "instruments": [{"exchange_segment": "nse_cm", "instrument_token": "2885"}]}],
                    )
                    return result, engine, session
            finally:
                await engine.detach(session.connection_id)

        result, engine, session = asyncio.run(run())
        self.assertEqual(result["results"][0]["removed"], 1)
        self.assertEqual(len(session.channels), 0)


class FieldRequirementSubscribeTests(unittest.IsolatedAsyncioTestCase):
    async def test_subscribe_reports_field_requirements(self):
        eng = _fake_engine()
        engine = ConnectionEngine()
        session = engine.create_session("alice")
        await engine.attach(session)
        try:
            with mock.patch(
                "connection_engine.connection_engine._engine", return_value=eng
            ), mock.patch.object(ConnectionEngine, "_feature_source_ok", return_value=True):
                result = await engine.subscribe(session, [{
                    "channel": "watchlist",
                    "fields": ["ltp", "close", "ema20"],
                    "instruments": [{"exchange_segment": "nse_cm", "instrument_token": "2885"}],
                }])
        finally:
            await engine.detach(session.connection_id)

        req = result["results"][0]["fieldRequirements"]
        self.assertEqual(req["status"], "PARTIAL")
        self.assertEqual(req["resolvedFields"], ["ltp", "close"])
        self.assertEqual(req["unavailableFields"], ["ema20"])

    async def test_market_frame_filters_to_requested_fields(self):
        engine = ConnectionEngine()
        session = engine.create_session("bob")
        session.channels["watchlist"] = {
            "consumer_id": "x",
            "profile_id": "WATCHLIST_LIGHT",
            "tokens": {"nse_cm|2885": {"fields": ["ltp", "close"]}},
        }
        with mock.patch.object(ConnectionEngine, "_feature_output_for", return_value=None), \
                mock.patch.object(ConnectionEngine, "_feature_source_ok", return_value=True):
            frame = engine._market_frame(session, {
                "instrument_token": "2885",
                "exchange_segment": "nse_cm",
                "trading_symbol": "RELIANCE",
                "fields": {"ltp": 101.5, "prev_close": 100.0, "volume": 5000, "open": 99.0},
                "event_type": "tick",
            }, "watchlist")

        self.assertEqual(frame["data"]["fields"], {"ltp": 101.5, "close": 100.0})
        self.assertEqual(frame["data"]["fieldStatus"], "AVAILABLE")


class PersistenceRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_drain_persists_data_saver_via_db_writer(self):
        eng = _fake_engine()
        payload = {
            "instrument_token": "2885",
            "exchange_segment": "nse_cm",
            "trading_symbol": "RELIANCE-EQ",
            "fields": {"ltp": 101.5},
            "event_id": "e1",
            "broker_timestamp": 1_700_000_000,
            "received_at": 1_700_000_001,
        }
        eng.registry.pending[PERSISTENCE_CONSUMER_ID] = [payload]

        engine = ConnectionEngine()
        with mock.patch(
            "connection_engine.connection_engine._engine", return_value=eng
        ), mock.patch(
            "services.db_writer_engine.db_writer_engine.ingest",
            new=mock.AsyncMock(return_value=True),
        ) as ingest:
            written = await engine._drain_persistence()

        self.assertEqual(written, 1)
        self.assertEqual(engine._ticks_persisted, 1)
        ingest.assert_awaited_once()
        doc = ingest.await_args.args[0]
        self.assertEqual(doc["instrumentToken"], "2885")
        self.assertEqual(doc["ltp"], 101.5)

    async def test_drain_skips_when_queue_empty(self):
        eng = _fake_engine()
        engine = ConnectionEngine()
        with mock.patch(
            "connection_engine.connection_engine._engine", return_value=eng
        ), mock.patch(
            "services.db_writer_engine.db_writer_engine.ingest",
            new=mock.AsyncMock(return_value=True),
        ) as ingest:
            written = await engine._drain_persistence()

        self.assertEqual(written, 0)
        ingest.assert_not_awaited()

    async def test_status_exposes_persistence_block(self):
        engine = ConnectionEngine()
        with mock.patch("services.tick_buffer.stats", return_value={}):
            status = engine.status()
        self.assertEqual(status["persistence"]["consumerId"], PERSISTENCE_CONSUMER_ID)
        self.assertEqual(status["persistence"]["ticksPersisted"], 0)


class LifecycleStateTests(unittest.IsolatedAsyncioTestCase):
    async def test_attach_transitions_to_active(self):
        engine = ConnectionEngine()
        session = engine.create_session("alice")
        self.assertEqual(session.lifecycle_state, "CREATED")
        await engine.attach(session)
        self.assertEqual(session.lifecycle_state, "ACTIVE")
        self.assertEqual(session.current_state(), "ACTIVE")
        await engine.detach(session.connection_id)
        self.assertEqual(session.current_state(), "TERMINATED")

    async def test_error_derives_degraded(self):
        session = ClientSession(connection_id="c1")
        session._transition("ACTIVE", "attached")
        session.record_error("fanout_failed", "boom")
        self.assertEqual(session.current_state(), "DEGRADED")

    async def test_outbox_drop_derives_degraded(self):
        session = ClientSession(connection_id="c1")
        session._transition("ACTIVE", "attached")
        session.outbox.dropped_market = 1
        self.assertEqual(session.current_state(), "DEGRADED")

    async def test_idle_derives_stale(self):
        session = ClientSession(connection_id="c1")
        session._transition("ACTIVE", "attached")
        session.last_activity_at = time.time() - client_mod.STALE_AFTER_S - 1
        self.assertEqual(session.current_state(), "STALE")


class EnvelopeFieldTests(unittest.IsolatedAsyncioTestCase):
    async def test_frame_carries_envelope_fields(self):
        from connection_engine.connection_engine import (
            ENVELOPE_VERSION, SOURCE_GATEWAY,
        )
        engine = ConnectionEngine()
        session = ClientSession(connection_id="c1")
        frame = engine._frame(session, "market.tick", channel="watchlist", token="2885",
                              source=SOURCE_GATEWAY, correlation_id="req-1")
        self.assertEqual(frame["version"], ENVELOPE_VERSION)
        self.assertEqual(frame["source"], SOURCE_GATEWAY)
        self.assertEqual(frame["correlation_id"], "req-1")
        self.assertEqual(frame["type"], "market.tick")

    async def test_market_frame_source_and_correlation(self):
        from connection_engine.connection_engine import SOURCE_FEATURE, SOURCE_WS_ENGINE
        engine = ConnectionEngine()
        session = ClientSession(connection_id="c1")
        with mock.patch.object(ConnectionEngine, "_feature_output_for", return_value=None), \
                mock.patch.object(ConnectionEngine, "_feature_source_ok", return_value=True):
            frame = engine._market_frame(session, {
                "instrument_token": "2885",
                "exchange_segment": "nse_cm",
                "fields": {"ltp": 101.5},
                "correlation_id": "corr-9",
            }, "watchlist")
        self.assertEqual(frame["source"], SOURCE_WS_ENGINE)
        self.assertEqual(frame["correlation_id"], "corr-9")
        self.assertEqual(frame["version"], "1.0")

    async def test_market_frame_feature_output_source_feature_engine(self):
        from connection_engine.connection_engine import SOURCE_FEATURE
        engine = ConnectionEngine()
        session = ClientSession(connection_id="c1")
        with mock.patch.object(ConnectionEngine, "_feature_output_for",
                               return_value={"calculationStatus": {}}):
            frame = engine._market_frame(session, {
                "instrument_token": "2885",
                "exchange_segment": "nse_cm",
                "fields": {"ltp": 101.5},
            }, "watchlist")
        self.assertEqual(frame["source"], SOURCE_FEATURE)


class HealthMappingTests(unittest.TestCase):
    def _started_engine(self):
        engine = ConnectionEngine()
        engine._started = True
        return engine

    def test_stopped(self):
        engine = ConnectionEngine()
        health = engine.health()
        self.assertEqual(health["state"], "STOPPED")

    def test_no_data_when_no_sessions(self):
        engine = self._started_engine()
        with mock.patch.object(ConnectionEngine, "_feed_freshness",
                               return_value={"state": "NO_DATA"}):
            health = engine.health()
        self.assertEqual(health["state"], "NO_DATA")

    def test_healthy(self):
        engine = self._started_engine()
        session = ClientSession(connection_id="c1")
        session._transition("ACTIVE", "x")
        engine._sessions["c1"] = session
        with mock.patch.object(ConnectionEngine, "_feed_freshness",
                               return_value={"state": "FRESH"}):
            health = engine.health()
        self.assertEqual(health["state"], "HEALTHY")

    def test_degraded_on_drop_limit(self):
        engine = self._started_engine()
        session = ClientSession(connection_id="c1")
        session.outbox = Outbox(maxlen=50)
        for _ in range(1100):
            session.outbox.put({"type": "market.tick"})
        self.assertGreater(session.outbox.dropped_market, 1000)
        engine._sessions["c1"] = session
        with mock.patch.object(ConnectionEngine, "_feed_freshness",
                               return_value={"state": "FRESH"}):
            health = engine.health()
        self.assertEqual(health["state"], "DEGRADED")

    def test_degraded_on_stale_feed(self):
        engine = self._started_engine()
        with mock.patch.object(ConnectionEngine, "_feed_freshness",
                               return_value={"state": "STALE"}):
            health = engine.health()
        self.assertEqual(health["state"], "DEGRADED")

    def test_overloaded_on_queue_ratio(self):
        engine = self._started_engine()
        session = ClientSession(connection_id="c1")
        limit = client_mod._outbox_limit()
        for _ in range(int(limit * 0.9)):
            session.outbox.put({"type": "market.tick"})
        engine._sessions["c1"] = session
        with mock.patch.object(ConnectionEngine, "_feed_freshness",
                               return_value={"state": "FRESH"}):
            health = engine.health()
        self.assertEqual(health["state"], "OVERLOADED")

    def test_error_on_persist_failures(self):
        engine = self._started_engine()
        engine._persist_errors = 11
        with mock.patch.object(ConnectionEngine, "_feed_freshness",
                               return_value={"state": "FRESH"}):
            health = engine.health()
        self.assertEqual(health["state"], "ERROR")


class EventInspectorTests(unittest.TestCase):
    def test_records_and_filters(self):
        engine = ConnectionEngine()
        engine._log_event("info", "engine.started", detail="online")
        engine._log_event("warn", "outbox.dropped", channel="market", detail="+3")
        engine._log_event("error", "fanout.failed", connection_id="c1", detail="boom")
        self.assertEqual(len(engine.recent_events()), 3)
        self.assertEqual(len(engine.recent_events(event_type="fanout.failed")), 1)
        self.assertEqual(len(engine.recent_events(level="warn")), 1)
        self.assertEqual(len(engine.recent_events(channel="market")), 1)
        self.assertEqual(len(engine.recent_events(limit=1)), 1)
        since = engine.recent_events()[0]["epoch"] - 60
        self.assertEqual(len(engine.recent_events(since_epoch=since)), 3)

    def test_ring_bounded(self):
        engine = ConnectionEngine()
        for i in range(600):
            engine._log_event("info", "engine.started")
        self.assertLessEqual(len(engine._event_log), 500)
        self.assertEqual(len(engine.recent_events(limit=5000)), 500)

    def test_status_exposes_health_and_lifecycle(self):
        engine = ConnectionEngine()
        with mock.patch("services.tick_buffer.stats", return_value={}):
            status = engine.status()
        self.assertEqual(status["health"]["state"], "STOPPED")
        self.assertIn("channelMetrics", status)
        self.assertIn("backpressure", status)
        self.assertIn("lifecycle", status)
        self.assertIn("lastEvents", status)

    def test_config_shape(self):
        engine = ConnectionEngine()
        cfg = engine.config()
        self.assertEqual(cfg["envelopeVersion"], "1.0")
        self.assertIn("market", cfg["channels"])
        self.assertIn("state", cfg["channels"])
        self.assertIn("fieldSources", cfg)
        self.assertIn("freshnessThresholds", cfg)
        self.assertEqual(cfg["backpressure"]["policy"], "DROP_OLDEST")

    def test_session_records_enriched(self):
        engine = ConnectionEngine()
        session = ClientSession(connection_id="c1", username="alice")
        session.channels["watchlist"] = {"profile_id": "WATCHLIST_LIGHT", "tokens": {}, "fields": ["ltp"]}
        engine._sessions["c1"] = session
        records = engine.session_records()
        self.assertEqual(len(records), 1)
        rec = records[0]
        self.assertEqual(rec["connectionId"], "c1")
        self.assertEqual(rec["lifecycleState"], "CREATED")
        self.assertIn("lastTransitionAt", rec)
        self.assertEqual(rec["deliveryMethod"], "WEBSOCKET")
        self.assertEqual(rec["queueLimit"], session.outbox.maxlen)
        self.assertEqual(rec["requestedFields"], ["ltp"])


if __name__ == "__main__":
    unittest.main()