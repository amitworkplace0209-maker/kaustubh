"""Central WebSocket Engine tests.

Pure unit tests (no MongoDB / no live broker connection). They cover registry
dedup, canonical immutability, profile projection + validation, router priority
backpressure, pin management, resource severity/policy, and the 344-field
verification payload served by the control API.
"""
import asyncio
import unittest

from neo_api_client.websocket.feed.models import DepthLevel, SFeedScrip

from ws_socket.engine.canonical import FULL_WS_FIELDS, canonicalize
from ws_socket.engine import engine as engine_module
from ws_socket.engine.engine import WebSocketEngine, _rate_moving
from ws_socket.engine.fields import (
    DERIVED,
    DIRECT_WS,
    NOT_PROVIDED,
    NOT_VERIFIED,
    OTHER_API,
    QUOTE_REST_ONLY,
    TARGET_LABEL,
    WS_CONDITIONAL,
    field_count,
    status_counts,
    unique_field_names,
)
from ws_socket.engine.pins import PinManager, MANUAL_PIN_SOURCE
from ws_socket.engine.profiles import FieldProfileStore, field_availability
from ws_socket.engine.registry import InstrumentKey, SubscriptionRegistry, parse_instrument_body
from ws_socket.engine.resources import ResourceMonitor
from ws_socket.engine.router import BACKPRESSURE_THRESHOLD, TickRouter
from ws_socket.engine.verification import render_report

SAMPLE_BODY = {
    "exchange_segment": "nse_cm",
    "instrument_token": "11536",
    "Symbol": "SBIN",
    "trading_symbol": "SBIN-EQ",
    "Token": "3045",
    "Expiry": "26JUN2026",
    "Strike": "0",
    "OptionType": "XX",
    "FillType": "MARKET",
}


def make_scrip(**overrides):
    base = dict(
        exchange_segment="nse_cm",
        instrument_token="11536",
        trading_symbol="SBIN-EQ",
        level=16,
        last_traded_price=712.5,
        open_price=701.0,
        high_price=715.0,
        low_price=698.5,
        close_price=707.25,
        average_trade_price=709.0,
        last_trade_time=1700000000,
        last_update_time=1700000005,
        last_trade_qty=25,
        total_buy_quantity=12345,
        total_sell_quantity=9876,
        volume_traded_today=2345678,
        open_interest=34567,
        net_change=5.25,
        net_change_percent=0.74,
        upper_circuit_limit=777.97,
        lower_circuit_limit=636.52,
        yearly_high=910.0,
        yearly_low=610.0,
        total_traded_value=1.66e9,
        market_lot=1,
        precision=2,
        multiplier=1,
        auction=False,
        buy=[DepthLevel(quantity=10, price=712.0, orders=3)],
        sell=[DepthLevel(quantity=8, price=712.6, orders=2)],
    )
    base.update(overrides)
    return SFeedScrip(**base)


def feed(engine: WebSocketEngine, message) -> dict:
    engine.on_feed_message(message)
    return canonicalize(message)


class FieldTableTest(unittest.TestCase):
    def test_344_rows_exactly(self):
        self.assertEqual(field_count(), 344)
        self.assertEqual(len(unique_field_names()), 344)

    def test_classification_totals(self):
        counts = status_counts()
        allowed = {DIRECT_WS, WS_CONDITIONAL, QUOTE_REST_ONLY, OTHER_API,
                   DERIVED, TARGET_LABEL, NOT_PROVIDED, NOT_VERIFIED}
        self.assertEqual(set(counts.keys()), allowed)
        self.assertEqual(sum(counts.values()), 344)
        # Respect the negotiated minima set out by the contract.
        self.assertEqual(counts[DIRECT_WS], 30)
        self.assertEqual(counts[NOT_PROVIDED], 5)
        self.assertEqual(counts[TARGET_LABEL], 24)

    def test_generated_report_has_344_rows(self):
        report = render_report()
        self.assertIn("344 fields currently present", report)
        marker = "# | Schema Field | Category | Kotak WS Status | Kotak Field/Attribute | Feed Level | Direct/Derived | Evidence | Notes"
        main = report.split(marker, 1)[1].split("-" * 100, 1)[0]
        data_rows = [line for line in main.splitlines() if line.strip()[:1].isdigit()]
        self.assertEqual(len(data_rows), 344)


class RegistryTest(unittest.TestCase):
    def test_dedup_across_consumers(self):
        reg = SubscriptionRegistry()
        reg.add_instruments("subscribed", [dict(SAMPLE_BODY)])
        reg.add_instruments("watchlist", [dict(SAMPLE_BODY)])
        self.assertEqual(reg.unique_count(), 1)
        self.assertEqual(len(reg.desired()), 1)

    def test_remove_keeps_other_consumer(self):
        reg = SubscriptionRegistry()
        reg.add_instruments("subscribed", [dict(SAMPLE_BODY)])
        reg.add_instruments("watchlist", [dict(SAMPLE_BODY)])
        self.assertTrue(reg.remove_instrument("subscribed", "nse_cm", "11536"))
        self.assertEqual(reg.unique_count(), 1)
        self.assertEqual(len(reg.desired()), 1)

    def test_parse_instrument_body_normalizes(self):
        rows = parse_instrument_body(SAMPLE_BODY)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["exchange_segment"], "nse_cm")
        self.assertEqual(rows[0]["instrument_token"], "11536")


class DepthRegistryTest(unittest.TestCase):
    """L8 routing contract: depth tokens carry isDepth/flags through the
    registry so the WebSocket manager picks subscribe_depth()."""

    def test_depth_token_carries_flags_into_desired(self):
        reg = SubscriptionRegistry()
        reg.add_instruments("session_manager", [{
            "exchange_segment": "nse_cm",
            "instrument_token": "2885",
            "symbol": "WIPRO",
            "is_depth": True,
            "feed_level": 8,
            "market_data": "L8",
        }])
        row = reg.desired()[0]
        self.assertTrue(row["isDepth"])
        self.assertEqual(row["feedLevel"], 8)
        self.assertEqual(row["marketData"], "L8")

    def test_index_token_carries_flag(self):
        reg = SubscriptionRegistry()
        reg.add_instruments("session_manager", [{
            "exchange_segment": "nse_cm",
            "instrument_token": "26000",
            "symbol": "NIFTY",
            "is_index": True,
        }])
        self.assertTrue(reg.desired()[0]["isIndex"])

    def test_l4_pin_cannot_downgrade_l8_intent(self):
        reg = SubscriptionRegistry()
        reg.add_instruments("session_manager", [{
            "exchange_segment": "nse_cm", "instrument_token": "2885",
            "symbol": "WIPRO", "is_depth": True, "feed_level": 8, "market_data": "L8",
        }])
        reg.add_instruments("pin:nse_cm|2885", [{
            "exchange_segment": "nse_cm", "instrument_token": "2885", "symbol": "WIPRO",
        }])
        self.assertEqual(reg.unique_count(), 1)
        row = reg.desired()[0]
        self.assertTrue(row["isDepth"])
        self.assertEqual(row["feedLevel"], 8)

    def test_unsubscribe_recalls_depth_feed_family(self):
        reg = SubscriptionRegistry()
        reg.add_instruments("session_manager", [{
            "exchange_segment": "nse_cm", "instrument_token": "2885",
            "symbol": "WIPRO", "is_depth": True, "feed_level": 8,
        }])
        to_sub, _ = reg.broker_diff(set())
        self.assertEqual(len(to_sub), 1)
        self.assertTrue(to_sub[0]["isDepth"])
        reg.add_instrument("subscribed", "nse_cm", "2885", "WIPRO")
        # Instrument removed from desired state entirely.
        reg.remove_instrument("session_manager", "nse_cm", "2885")
        reg.remove_instrument("subscribed", "nse_cm", "2885")
        _, to_unsub = reg.broker_diff({InstrumentKey("nse_cm", "2885")})
        self.assertEqual(len(to_unsub), 1)
        self.assertTrue(to_unsub[0]["isDepth"], "unsubscribe must use the same feed family")

    def test_group_intents_routes_depth_index_scrip(self):
        from ws_socket.ws_manager import _group_intents
        scrips, indices, full_depths, depths = _group_intents([
            # Explicit legacy L4 intent keeps using subscribe_scrips.
            {"exchange_segment": "nse_cm", "instrument_token": "3045", "isIndex": False, "isDepth": False,
             "feedLevel": 4, "marketData": "L4"},
            # Depth token routes to subscribe_depth.
            {"exchange_segment": "nse_cm", "instrument_token": "2885", "isIndex": False, "isDepth": True, "feedLevel": 8},
            # Index token routes to subscribe_index.
            {"exchange_segment": "nse_cm", "instrument_token": "26000", "isIndex": True, "isDepth": False},
            # Unclassified token DEFAULTS to depth (L8) — no more L4 default.
            {"exchange_segment": "nse_cm", "instrument_token": "7777", "isIndex": False, "isDepth": False},
            # Full-depth token routes to subscribe_full_depth.
            {"exchange_segment": "nse_cm", "instrument_token": "8888", "isIndex": False, "isDepth": True, "feedLevel": 16},
        ])
        self.assertEqual([t["instrument_token"] for t in scrips], ["3045"])
        self.assertEqual([t["instrument_token"] for t in indices], ["26000"])
        self.assertEqual([t["instrument_token"] for t in depths], ["2885", "7777"])
        self.assertEqual([t["instrument_token"] for t in full_depths], ["8888"])

    def test_feed_level_recording_reflects_actual_subscription(self):
        from ws_socket.ws_manager import WebSocketManager
        mgr = WebSocketManager()
        with mgr._lock:
            mgr._record_feed_level("2885", {"instrument_token": "2885", "isDepth": True, "feedLevel": 8})
            mgr._record_feed_level("3045", {"instrument_token": "3045"})
            mgr._record_feed_level("26000", {"instrument_token": "26000", "isDepth": False, "isIndex": True})
        levels = mgr.feed_levels()
        self.assertEqual(levels["L8"], 2)
        self.assertEqual(levels["L4"], 0)
        self.assertEqual(levels["INDEX"], 1)
        self.assertEqual(sorted(mgr._subscribed_feed_levels.keys()), ["26000", "2885", "3045"])


class CanonicalTest(unittest.TestCase):
    def test_broker_values_copied_verbatim(self):
        msg = make_scrip()
        canonical = canonicalize(msg, event_counter=1)
        self.assertEqual(canonical["fields"]["ltp"], msg.last_traded_price)
        self.assertEqual(canonical["fields"]["open"], msg.open_price)
        self.assertEqual(canonical["exchange_segment"], "nse_cm")
        self.assertEqual(canonical["instrument_token"], "11536")

    def test_no_derived_fields_in_raw_fields(self):
        canonical = canonicalize(make_scrip(), event_counter=1)
        ws_names = set(FULL_WS_FIELDS) | {"buy", "sell"}
        # All fields are broker-provided canonical names; derived keys (e.g.
        # change-percent from REST, or calculated spreads) must NOT appear.
        self.assertTrue(set(canonical["fields"]).issubset(ws_names))
        self.assertNotIn("ltp_change_pct", canonical["fields"])
        self.assertNotIn("spread", canonical["fields"])

    def test_raw_depth_passthrough(self):
        canonical = canonicalize(make_scrip(), event_counter=1)
        self.assertEqual(canonical["fields"]["buy"][0]["price"], 712.0)
        self.assertEqual(canonical["feed_type"], "full_depth")
        self.assertEqual(canonical["feed_level"], 16)


class ProfileTest(unittest.TestCase):
    def test_builtin_profiles_exist(self):
        store = FieldProfileStore()
        ids = [p["profile_id"] for p in store.list()]
        for expected in ("FULL_RAW", "SUBSCRIBED_FULL", "WATCHLIST_LIGHT", "PINNED_HIGH",
                         "POSITION_CRITICAL", "AI_HIGH", "ALERT_MINIMAL"):
            self.assertIn(expected, ids)

    def test_unknown_field_rejected(self):
        store = FieldProfileStore()
        with self.assertRaises(ValueError):
            store.create({"profile_name": "bad", "enabled_fields": ["definitely_not_a_field"]})

    def test_projection_respects_profile(self):
        store = FieldProfileStore()
        profile = store.get("ALERT_MINIMAL")
        canonical = canonicalize(make_scrip(), event_counter=1)
        projected = profile.select(canonical["fields"])
        self.assertNotIn("buy", projected)
        self.assertNotIn("open_interest", projected)
        for key in projected:
            self.assertIn(key, FULL_WS_FIELDS)

    def test_availability_mapping_returns_status(self):
        self.assertEqual(field_availability("ltp"), "DIRECT_WS")
        self.assertIn(field_availability("sector"), ("NOT_VERIFIED", "NOT_PROVIDED_BY_KOTAK_WS"))
        # Additional discovered fields (e.g. market_status_code, num 1009) resolve too.
        self.assertEqual(field_availability("market_status_code"), "DIRECT_WS")


class RouterTest(unittest.TestCase):
    def _router(self):
        return TickRouter(FieldProfileStore())

    def test_priority_backpressure(self):
        router = self._router()
        router.register({
            "consumer_id": "p0", "consumer_type": "execution", "priority": "P0", "profile_id": "FULL_RAW",
        })
        router.register({
            "consumer_id": "p3", "consumer_type": "analytics", "priority": "P3", "profile_id": "FULL_RAW",
        })
        for cid in ("p0", "p3"):
            router._consumers[cid].maxlen = BACKPRESSURE_THRESHOLD + 5
        canonical = canonicalize(make_scrip(), event_counter=1)
        for _ in range(BACKPRESSURE_THRESHOLD + 5):
            router.route(canonical)
        p3 = router._consumers["p3"]
        p0 = router._consumers["p0"]
        self.assertEqual(len(p3.queue), BACKPRESSURE_THRESHOLD)  # gated at high-water mark
        self.assertEqual(len(p0.queue), BACKPRESSURE_THRESHOLD + 5)  # P0 never gated silently
        self.assertGreater(p3.bps_deferred, 0)
        self.assertEqual(p3.bps_dropped, 0)

    def test_route_to_specific_instrument(self):
        router = self._router()
        router.register({
            "consumer_id": "only_one", "priority": "P1", "instruments": [{"exchange_segment": "nse_cm", "instrument_token": "11536"}],
        })
        router.route(canonicalize(make_scrip(exchange_segment="nse_cm", instrument_token="11536"), event_counter=1))
        router.route(canonicalize(make_scrip(exchange_segment="nse_cm", instrument_token="99999"), event_counter=2))
        self.assertEqual(len(router._consumers["only_one"].queue), 1)


class PinTest(unittest.TestCase):
    def test_set_list_unset(self):
        pins = PinManager()
        pins.set("nse_cm|11536", "SBIN", priority=1)
        self.assertEqual(len(pins.list()), 1)
        self.assertTrue(pins.unset("nse_cm|11536"))
        self.assertEqual(len(pins.list()), 0)

    def test_set_top5_generates_intents(self):
        pins = PinManager()
        pins.set_top5([{"symbol": "RELIANCE", "trading_symbol": "RELIANCE", "exchange_segment": "nse_cm", "instrument_token": "2885"}])
        intents = pins.intents()
        self.assertEqual(len(intents), 1)
        self.assertIn("nse_cm|2885", {f"{r['exchange_segment']}|{r['instrument_token']}" for r in intents})


class ResourceTest(unittest.TestCase):
    def test_severity_bands(self):
        monitor = ResourceMonitor()
        self.assertEqual(monitor.severity(10), "NORMAL")
        self.assertEqual(monitor.severity(72), "WARNING")
        self.assertEqual(monitor.severity(82), "HIGH")
        self.assertEqual(monitor.severity(92), "CRITICAL")
        self.assertEqual(monitor.severity(97), "EMERGENCY")

    def test_policy_evaluation_and_config(self):
        monitor = ResourceMonitor()
        result = monitor.evaluate(82.0)
        actions = result["actions"]
        self.assertEqual(result["severity"], "HIGH")
        stopped = [a["service"] for a in actions if a["action"] == "STOP"]
        # Watchlist degrades at 80, Analytics/Reports stop at 85; 82 stops nothing yet.
        self.assertNotIn("Analytics", stopped)
        self.assertIn("Watchlist", [a["service"] for a in actions])
        # Thresholds/policy are fully configurable, not hardcoded.
        monitor.update_thresholds({"warning_pct": 60, "high_pct": 65, "critical_pct": 75, "emergency_pct": 85})
        self.assertEqual(monitor.severity(70), "HIGH")
        self.assertEqual(monitor.severity(80), "CRITICAL")
        monitor.update_policy([{"service": "Analytics", "action": "STOP", "ram_threshold": 65}])
        self.assertEqual(monitor.evaluate(70)["actions"][0]["service"], "Analytics")


class EngineFacadeTest(unittest.TestCase):
    def setUp(self):
        self.engine = WebSocketEngine()

    def test_builtin_data_saver_consumer_registered(self):
        consumers = {c["consumer_id"]: c for c in self.engine.consumers()}
        self.assertIn("data_saver", consumers)
        self.assertEqual(consumers["data_saver"]["consumer_type"], "DATA_SAVER")
        self.assertEqual(consumers["data_saver"]["profile_id"], "FULL_RAW")
        self.assertEqual(consumers["data_saver"]["priority"], "P0")

    def test_storage_doc_flattens_full_scrip_surface(self):
        from ws_socket.engine.storage import to_storage_doc
        self.engine.register_consumer({
            "consumer_id": "saver-echo", "consumer_type": "DATA_SAVER",
            "profile_id": "FULL_RAW", "priority": "P0",
        })
        feed(self.engine, make_scrip(
            buy=[DepthLevel(quantity=10, price=712.0, orders=3)],
            sell=[DepthLevel(quantity=8, price=712.6, orders=2)],
        ))
        batch = self.engine.drain_consumer("saver-echo", limit=10)
        self.assertEqual(len(batch), 1)
        payload = batch[0]
        self.assertIsNotNone(payload["raw"])
        self.assertIn("preserved|", payload["raw_reference"])
        doc = to_storage_doc(payload)
        # legacy surface preserved for existing consumers
        self.assertEqual(doc["ltp"], 712.5)
        self.assertEqual(doc["open"], 701.0)
        self.assertEqual(doc["high"], 715.0)
        self.assertEqual(doc["low"], 698.5)
        self.assertEqual(doc["close"], 707.25)
        self.assertEqual(doc["volume"], 2345678)
        self.assertEqual(doc["averagePrice"], 709.0)
        self.assertEqual(doc["change"], 5.25)
        self.assertEqual(doc["changePercent"], 0.74)
        self.assertEqual(doc["oi"], 34567)
        self.assertEqual(doc["bp"], 712.0)
        self.assertEqual(doc["bq"], 10)
        self.assertEqual(doc["sp"], 712.6)
        self.assertEqual(doc["sq"], 8)
        # Fixed legacy alias: bs = BEST BID SIZE (= bq), not the ask quantity.
        self.assertEqual(doc["bs"], doc["bq"])
        # previously-dropped fields are now lossless
        self.assertEqual(doc["market_lot"], 1)
        self.assertEqual(doc["precision"], 2)
        self.assertEqual(doc["multiplier"], 1)
        self.assertEqual(doc["auction"], False)
        self.assertEqual(doc["yearly_high"], 910.0)
        self.assertEqual(doc["yearly_low"], 610.0)
        self.assertEqual(doc["level"], 16)
        self.assertEqual(doc["message_type"], "full_depth")
        self.assertEqual(doc["sdk_version"], "3.0.7")
        self.assertEqual(len(doc["buy"]), 1)
        self.assertEqual(len(doc["sell"]), 1)
        self.assertIsNotNone(doc["ts"])
        self.assertIsNotNone(doc["receivedAt"])
        # raw blob is the exact Kotak message
        self.assertEqual(doc["raw"]["last_traded_price"], 712.5)
        self.assertEqual(doc["raw"]["buy"][0]["price"], 712.0)

    def test_canonical_only_storage_doc_nests_market_data(self):
        from ws_socket.engine.storage import to_storage_doc
        from ws_socket.engine.master_canonical import build_from_flat_tick

        flat = {
            "exchangeSegment": "nse_cm",
            "instrumentToken": "11536",
            "symbol": "SBIN-EQ",
            "ltp": 712.5,
            "open": 701.0,
            "high": 715.0,
            "low": 698.5,
            "prevClose": 707.25,
            "averagePrice": 709.0,
            "volume": 2345678,
            "netChange": 5.25,
            "netChangePercent": 0.74,
            "buy": [{"price": 712.0, "quantity": 10, "orders": 3}],
            "sell": [{"price": 712.6, "quantity": 8, "orders": 2}],
            "lastTradeTime": 1700000000,
        }
        master = build_from_flat_tick(flat, received_at=1700000000)
        payload = {
            "master_canonical": master.data,
            "trading_symbol": "SBIN-EQ",
            "instrument_token": "11536",
            "exchange_segment": "nse_cm",
            "broker_timestamp": 1700000000,
            "received_at": 1700000005,
            "raw_reference": "preserved|test",
            "raw": {"last_traded_price": 712.5,
                    "buy": [{"price": 712.0, "quantity": 10}],
                    "sell": [{"price": 712.6, "quantity": 8}]},
        }
        self.assertIn("master_canonical", payload)
        doc = to_storage_doc(payload, storage_schema="canonical_only")
        # canonical-only: no flat market-data keys, no duplicate depth surface
        self.assertIsNone(doc.get("ltp"))
        self.assertIsNone(doc.get("open"))
        self.assertIsNone(doc.get("buy"))
        self.assertIsNone(doc.get("sell"))
        self.assertIsNone(doc.get("bp"))
        canonical = doc["master_canonical"]
        self.assertEqual(canonical["price"]["last_traded_price"], 712.5)
        self.assertEqual(canonical["price"]["open_price"], 701.0)
        self.assertEqual(canonical["price"]["high_price"], 715.0)
        self.assertEqual(canonical["price"]["low_price"], 698.5)
        self.assertEqual(canonical["price"]["previous_close_price"], 707.25)
        self.assertEqual(canonical["volume"]["volume_traded_today"], 2345678)
        self.assertEqual(canonical["depth"]["buy"][0]["price"], 712.0)
        self.assertEqual(canonical["depth"]["buy"][0]["quantity"], 10)
        self.assertEqual(canonical["depth"]["sell"][0]["price"], 712.6)
        self.assertEqual(canonical["depth"]["sell"][0]["quantity"], 8)
        # identity / raw audit envelope at root — raw stays isolated
        self.assertEqual(doc["symbol"], "SBIN")
        self.assertEqual(doc["instrumentToken"], "11536")
        self.assertIsNotNone(doc["raw"])
        self.assertEqual(doc["raw"]["last_traded_price"], 712.5)
        self.assertIn("preserved|", doc["raw_reference"])
        self.assertIsNotNone(doc["ts"])
        self.assertIsNotNone(doc["receivedAt"])

    def test_non_fullraw_payload_omits_raw_blob(self):
        self.engine.register_consumer({
            "consumer_id": "lite", "consumer_type": "analytics",
            "profile_id": "ALERT_MINIMAL", "priority": "P3",
        })
        feed(self.engine, make_scrip())
        batch = self.engine.drain_consumer("lite", limit=10)
        self.assertEqual(len(batch), 1)
        self.assertIsNone(batch[0]["raw"])
        self.assertIsNotNone(batch[0]["raw_reference"])

    def test_cas_and_market_status_do_not_pollute_price_history(self):
        from services.tick_buffer import _price_history, _record_price_history
        _record_price_history("cas-test", {"ltp": 100.0, "message_type": "cas_change"})
        _record_price_history("ms-test", {"ltp": 100.0, "message_type": "market_status"})
        _record_price_history("scrip-test", {"ltp": 100.0})
        self.assertNotIn("cas-test", _price_history)
        self.assertNotIn("ms-test", _price_history)
        self.assertIn("scrip-test", _price_history)
        self.assertEqual(_price_history["scrip-test"][-1][2], 100.0)

    def test_field_verification_payload(self):
        payload = self.engine.field_verification()
        self.assertEqual(payload["total"], 344)
        self.assertEqual(len(payload["rows"]), 344)
        self.assertEqual(sum(payload["status_counts"].values()), 344)
        self.assertEqual(len(payload["additional_discovered"]), 18)

    def test_feed_routes_to_consumer(self):
        self.engine.register_consumer({
            "consumer_id": "test-full", "consumer_type": "testing", "priority": "P2", "profile_id": "FULL_RAW",
        })
        feed(self.engine, make_scrip())
        batch = self.engine.drain_consumer("test-full", limit=10)
        self.assertEqual(len(batch), 1)
        self.assertEqual(batch[0]["fields"]["ltp"], 712.5)
        self.assertEqual(batch[0]["source"], "kotak_neo_sfeed")

    def test_raw_bucket_kept_per_token(self):
        feed(self.engine, make_scrip(instrument_token="11536"))
        feed(self.engine, make_scrip(instrument_token="99999"))
        self.assertEqual(len(self.engine.raw_stream("nse_cm|11536")), 1)
        self.assertEqual(len(self.engine.raw_stream("nse_cm|99999")), 1)

    def test_profile_validation_via_api_path(self):
        with self.assertRaises(ValueError):
            self.engine.profiles.create({"profile_name": "x", "enabled_fields": ["nope"]})

    def test_pin_reconcile_without_owner(self):
        result = asyncio.run(self.engine.set_pin({"instrument_key": "nse_cm|11536", "symbol": "SBIN"}))
        self.assertEqual(result["pin"]["instrument_key"], "nse_cm|11536")
        self.assertEqual(result["sync"]["ok"], False)  # no owner configured yet


class ApiSurfaceTest(unittest.TestCase):
    def test_control_router_exposes_expected_paths(self):
        from api.ws_engine import router
        paths = {route.path for route in router.routes}
        expected = {
            "/api/services/websocket/status",
            "/api/services/websocket/health",
            "/api/services/websocket/metrics",
            "/api/services/websocket/subscriptions",
            "/api/services/websocket/watchlist",
            "/api/services/websocket/pins",
            "/api/services/websocket/field-profiles",
            "/api/services/websocket/field-verification",
            "/api/services/websocket/routes",
            "/api/services/websocket/consumers",
            "/api/services/websocket/raw-stream",
            "/api/services/websocket/resources",
            "/api/services/websocket/connect",
            "/api/services/websocket/disconnect",
            "/api/services/websocket/reconnect",
            "/api/services/websocket/subscribe",
            "/api/services/websocket/unsubscribe",
        }
        self.assertTrue(expected.issubset(paths), paths)

    def test_status_singleton_importable(self):
        engine_module.engine.status()


if __name__ == "__main__":
    unittest.main()
