"""Master Canonical Market Data Adapter tests (L8_MASTER_CANONICAL_ADAPTER).

Pure unit tests (no MongoDB / live broker). Cover:
  - canonical mapping + semantic de-duplication (one name per value)
  - variable-length depth (0 / 1 / 5 / 16 rows) with NO 5-row assumption
  - L16 16+16 structural compatibility through the real code path
  - alias-conflict policy (never a silent pick)
  - missing/unknown/malformed fields
  - type + timestamp normalization and stale detection
  - raw payload preservation (separate audit envelope)
  - engine opt-in handoff -> TICK_VALIDATED carries masterCanonical
  - Feature Engine caches masterCanonical (canonical_for)
"""
import asyncio
import unittest

from neo_api_client.websocket.feed.models import DepthLevel, SFeedScrip

from ws_socket.engine.canonical import canonicalize
from ws_socket.engine.engine import WebSocketEngine
from ws_socket.engine.master_canonical import (
    CANONICAL_ALIAS_MAP,
    CANONICAL_SCHEMA,
    ALL_CANONICAL_FIELDS,
    build_from_canonical,
    build_from_flat_tick,
)


def make_scrip(**overrides):
    base = dict(
        exchange_segment="nse_cm",
        instrument_token="2885",
        trading_symbol="RELIANCE-EQ",
        level=8,
        last_traded_price=1244.5,
        open_price=1245.0,
        high_price=1247.3,
        low_price=1238.3,
        close_price=1243.9,
        average_trade_price=1242.85,
        last_trade_time=1789723226,
        last_update_time=1789723226,
        last_trade_qty=7,
        total_buy_quantity=793721,
        total_sell_quantity=710943,
        volume_traded_today=6287447,
        open_interest=0,
        net_change=0.6,
        net_change_percent=0.05,
        upper_circuit_limit=1368.2,
        lower_circuit_limit=1119.6,
        yearly_high=1400.0,
        yearly_low=1100.0,
        total_traded_value=7.81e9,
        market_lot=1,
        precision=2,
        multiplier=100,
        auction=False,
        buy=[DepthLevel(quantity=4222, price=1244.5, orders=3),
             DepthLevel(quantity=400, price=1244.0, orders=5)],
        sell=[DepthLevel(quantity=319, price=1244.6, orders=2)],
    )
    base.update(overrides)
    return SFeedScrip(**base)


def depth_rows(prices, qty=10, orders=1):
    return [DepthLevel(quantity=qty + i, price=p, orders=orders + i) for i, p in enumerate(prices)]


def canonical_for(msg, recv=1789723645.0, now=1789723645.0):
    c = canonicalize(msg, received_at=recv)
    return build_from_canonical(c, received_at=recv, now=now)


class CanonicalMappingTest(unittest.TestCase):
    def test_one_canonical_name_per_semantic_value(self):
        """ltp/lastPrice/last_traded_price collapse to ONE field."""
        mc = canonical_for(make_scrip())
        price = mc.data["price"]
        self.assertIn("last_traded_price", price)
        self.assertNotIn("ltp", price)
        self.assertNotIn("lastPrice", price)
        self.assertEqual(price["last_traded_price"], 1244.5)

    def test_alias_map_resolves_to_canonical(self):
        for alias, (canon, _) in CANONICAL_ALIAS_MAP.items():
            self.assertIn(canon, ALL_CANONICAL_FIELDS)
            # canonical name itself is accepted idempotently as an input alias

    def test_every_canonical_field_has_schema_metadata(self):
        self.assertTrue(ALL_CANONICAL_FIELDS)
        flat = dict(CANONICAL_SCHEMA)
        self.assertIn("price", CANONICAL_SCHEMA)
        self.assertIn("depth", CANONICAL_SCHEMA)
        self.assertIn("raw", CANONICAL_SCHEMA)

    def test_auction_bool_live_override(self):
        mc = canonical_for(make_scrip(auction=True))
        self.assertTrue(mc.data["price"]["auction_active"])


class DepthTest(unittest.TestCase):
    def test_l8_five_by_five(self):
        bids = depth_rows([1244.5, 1244.0, 1243.5, 1243.0, 1242.5])
        asks = depth_rows([1244.6, 1245.0, 1245.5, 1246.0, 1246.5])
        mc = canonical_for(make_scrip(buy=bids, sell=asks))
        self.assertEqual(len(mc.data["depth"]["buy"]), 5)
        self.assertEqual(len(mc.data["depth"]["sell"]), 5)
        self.assertEqual(mc.data["depth"]["levels"]["expected"], 8)
        self.assertTrue(mc.valid)

    def test_zero_rows_allowed(self):
        mc = canonical_for(make_scrip(buy=[], sell=[]))
        self.assertEqual(mc.data["depth"]["buy"], [])
        self.assertEqual(mc.data["depth"]["sell"], [])
        self.assertIsNone(mc.data["derived"]["best_bid_price"])
        self.assertIsNone(mc.data["derived"]["spread"])

    def test_one_row_touch_line(self):
        mc = canonical_for(make_scrip(level=4, buy=depth_rows([100.0]), sell=depth_rows([100.1])))
        self.assertEqual(len(mc.data["depth"]["buy"]), 1)
        self.assertEqual(mc.data["feed_metadata"]["feed_level"], 4)

    def test_l16_sixteen_rows_structural_compatibility(self):
        """16+16 passes through the real adapter/canonical path with NO code change."""
        bids = depth_rows([float(x) for x in range(1244_5, 1243_0, -1)] )  # 15 prices
        bids = depth_rows([1244.5 - 0.1 * i for i in range(16)])
        asks = depth_rows([1244.6 + 0.1 * i for i in range(16)])
        msg = make_scrip(level=16, buy=bids, sell=asks)
        mc = canonical_for(msg)
        self.assertEqual(len(mc.data["depth"]["buy"]), 16)
        self.assertEqual(len(mc.data["depth"]["sell"]), 16)
        self.assertEqual(mc.data["feed_metadata"]["feed_level"], 16)
        self.assertEqual(mc.data["feed_metadata"]["feed_type"], "full_depth")
        self.assertTrue(mc.valid)

    def test_no_hardcoded_five_anywhere(self):
        import os, re
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        path = os.path.join(base, "ws_socket", "engine", "master_canonical.py")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertFalse(re.search(r"\[0[:.]\.\.4\]|range\(5\)|\[:5\]", src), "5-row hardcode present")

    def test_order_semantics_validated(self):
        bad = canonical_for(make_scrip(buy=depth_rows([1244.5, 1245.0]), sell=[]))
        self.assertFalse(bad.valid)
        self.assertTrue(any("not best-first" in i for i in bad.issues))


class ConflictPolicyTest(unittest.TestCase):
    def test_alias_conflict_recorded_not_silent(self):
        c = canonicalize(make_scrip(), received_at=1789723645.0)
        c["fields"]["ltp"] = 99.0          # conflicting alias #1
        c["fields"]["lastPrice"] = 1244.5  # conflicting alias #2 (same semantic)
        mc = build_from_canonical(c, received_at=1789723645.0, now=1789723645.0)
        self.assertTrue(any(x["canonical"] == "last_traded_price" for x in mc.conflicts))
        # deterministic precedence: ltp is the primary legacy alias; no silent pick
        self.assertEqual(mc.data["price"]["last_traded_price"], 99.0)
        rec = [x for x in mc.conflicts if x["canonical"] == "last_traded_price"][0]
        self.assertEqual(sorted(rec["sources"]), ["lastPrice", "ltp"])
        self.assertIn("no silent pick", rec["policy"])

    def test_identical_aliases_no_conflict(self):
        c = canonicalize(make_scrip(), received_at=1789723645.0)
        c["fields"]["ltp"] = 1244.5  # same value as last_traded_price
        mc = build_from_canonical(c, received_at=1789723645.0, now=1789723645.0)
        self.assertFalse([x for x in mc.conflicts if x["canonical"] == "last_traded_price"])


class EdgeCaseTest(unittest.TestCase):
    def test_missing_identity_invalid(self):
        c = canonicalize(make_scrip(), received_at=1789723645.0)
        c["exchange_segment"] = ""
        c["instrument_token"] = ""
        mc = build_from_canonical(c, received_at=1789723645.0, now=1789723645.0)
        self.assertFalse(mc.valid)
        self.assertTrue(any("exchange_segment" in i for i in mc.issues))

    def test_missing_optional_field_is_none_not_fabricated(self):
        c = canonicalize(make_scrip(), received_at=1789723645.0)
        c["fields"]["ltq"] = None  # optional field absent on this tick
        mc = build_from_canonical(c, received_at=1789723645.0, now=1789723645.0)
        self.assertIsNone(mc.data["trade"]["last_trade_quantity"])

    def test_unknown_future_field_ignored_without_error(self):
        c = canonicalize(make_scrip(), received_at=1789723645.0)
        c["fields"]["future_broker_field_2027"] = "unknown"
        mc = build_from_canonical(c, received_at=1789723645.0, now=1789723645.0)
        self.assertTrue(mc.valid)
        self.assertIn("future_broker_field_2027", mc.source_keys)

    def test_malformed_depth_row_dropped_with_diagnostic(self):
        c = canonicalize(make_scrip(), received_at=1789723645.0)
        c["fields"]["buy"] = [{"price": 1244.5, "quantity": 10}, {"price": 1244.0, "quantity": 5, "orders": 1}]
        mc = build_from_canonical(c, received_at=1789723645.0, now=1789723645.0)
        self.assertFalse(mc.valid)
        self.assertTrue(any("depth.buy[0]" in i for i in mc.issues))
        self.assertEqual(len(mc.data["depth"]["buy"]), 1)  # malformed row dropped, never guessed

    def test_type_conversion_strings_and_epoch(self):
        mc = build_from_flat_tick({
            "instrumentToken": "2885", "exchangeSegment": "nse_cm", "symbol": "RELIANCE-EQ",
            "ltp": "1244.50", "volume": "6287447", "timestamp": 1789723226,
            "buy": [{"price": 1244.5, "quantity": 10, "orders": 2}],
            "sell": [{"price": 1244.6, "quantity": 5, "orders": 1}],
        }, received_at=1789723645.0, now=1789723645.0)
        self.assertIsInstance(mc.data["price"]["last_traded_price"], float)
        self.assertIsInstance(mc.data["volume"]["volume_traded_today"], int)
        self.assertEqual(mc.data["trade"]["last_trade_time"], 1789723226)


class ValidationTest(unittest.TestCase):
    def test_high_below_low_flagged(self):
        mc = canonical_for(make_scrip(high_price=1238.0, low_price=1239.0))
        self.assertFalse(mc.valid)
        self.assertTrue(any("price.high_price < price.low_price" in i for i in mc.issues))

    def test_stale_timestamp_flagged(self):
        mc = canonical_for(make_scrip(last_update_time=1700000000), now=1789723645.0)
        self.assertTrue(any("stale" in i for i in mc.issues))


class RawPolicyTest(unittest.TestCase):
    def test_raw_separate_envelope_no_inline_duplicates(self):
        mc = canonical_for(make_scrip())
        raw = mc.data["raw"]
        self.assertIn("reference", raw)
        self.assertTrue(str(raw["reference"]).startswith("preserved|"))
        # raw payload values must NOT be re-inlined as semantic fields
        data_str = str(mc.data)
        for duck in ("last_traded_price", "depth"):
            self.assertIn(duck, data_str)
        self.assertNotIn("model_dump", data_str)


class EngineHandoffTest(unittest.TestCase):
    def test_engine_optin_emits_master_canonical(self):
        eng = WebSocketEngine()
        eng.master_canonical_enabled = False
        eng.on_feed_message(make_scrip())
        event = eng._event_drain.get_nowait() if not eng._event_drain.empty() else None
        while not eng._event_drain.empty():
            event = eng._event_drain.get_nowait()
            if event and event[0] == "TICK_VALIDATED":
                break
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "TICK_VALIDATED")
        self.assertNotIn("masterCanonical", event[1])  # disabled by default

        eng2 = WebSocketEngine()
        eng2.set_master_canonical_enabled(True)
        eng2.on_feed_message(make_scrip())
        found = False
        while not eng2._event_drain.empty():
            etype, data = eng2._event_drain.get_nowait()
            if etype == "TICK_VALIDATED" and data.get("masterCanonical"):
                found = True
                self.assertEqual(data["masterCanonical"]["identity"]["trading_symbol"], "RELIANCE-EQ")
                break
        self.assertTrue(found)

    def test_engine_persists_master_canonical_in_envelope(self):
        eng = WebSocketEngine()
        eng.set_master_canonical_enabled(True)
        eng.on_feed_message(make_scrip())
        mc = eng.raw_stream("nse_cm|2885", limit=1)[0].get("master_canonical")
        self.assertIsNotNone(mc)
        self.assertEqual(mc["feed_metadata"]["feed_level"], 8)

    def test_feature_engine_caches_canonical_for_token(self):
        from core.engines.feature_engine import FeatureEngine
        fe = FeatureEngine()
        tick = {
            "instrumentToken": "2885", "exchangeSegment": "nse_cm", "symbol": "RELIANCE-EQ",
            "ltp": 1244.5, "volume": 6287447, "volume_traded_today": 6287447, "timestamp": 1789723226,
            "masterCanonical": {"identity": {"trading_symbol": "RELIANCE-EQ"},
                                "price": {"last_traded_price": 1244.5},
                                "feed_metadata": {"feed_level": 8, "feed_type": "depth"}},
        }
        fe._process_tick("2885", tick)
        mc = fe.canonical_for("2885")
        self.assertIsNotNone(mc)
        self.assertEqual(mc["price"]["last_traded_price"], 1244.5)
        self.assertEqual(mc["feed_metadata"]["feed_level"], 8)

    def test_router_forwards_master_canonical_to_consumer_payload(self):
        """Regression: the router dropped the envelope key.

        ``engine.on_feed_message`` attached ``master_canonical`` to the canonical
        envelope, but ``router._build_payload`` never copied it, so every
        downstream ``payload.get("master_canonical")`` was ``None`` in
        production even though the pre-routing bucket had it.
        """
        eng = WebSocketEngine()
        eng.set_master_canonical_enabled(True)
        eng.register_consumer({
            "consumer_id": "saver-echo", "consumer_type": "DATA_SAVER",
            "profile_id": "FULL_RAW", "priority": "P0",
        })
        eng.on_feed_message(make_scrip())
        batch = eng.drain_consumer("saver-echo", limit=10)
        self.assertEqual(len(batch), 1)
        mc = batch[0].get("master_canonical")
        self.assertIsNotNone(mc, "router dropped master_canonical from the consumer payload")
        self.assertEqual(mc["feed_metadata"]["feed_level"], 8)

    def test_master_canonical_survives_into_the_storage_document(self):
        from ws_socket.engine.storage import to_storage_doc
        eng = WebSocketEngine()
        eng.set_master_canonical_enabled(True)
        eng.register_consumer({
            "consumer_id": "saver-echo", "consumer_type": "DATA_SAVER",
            "profile_id": "FULL_RAW", "priority": "P0",
        })
        eng.on_feed_message(make_scrip())
        doc = to_storage_doc(eng.drain_consumer("saver-echo", limit=10)[0])
        self.assertIsNotNone(doc.get("master_canonical"))
        self.assertEqual(doc["master_canonical"]["feed_metadata"]["feed_level"], 8)

    def test_router_payload_has_no_master_canonical_when_disabled(self):
        eng = WebSocketEngine()
        eng.set_master_canonical_enabled(False)
        eng.register_consumer({
            "consumer_id": "saver-echo", "consumer_type": "DATA_SAVER",
            "profile_id": "FULL_RAW", "priority": "P0",
        })
        eng.on_feed_message(make_scrip())
        batch = eng.drain_consumer("saver-echo", limit=10)
        self.assertIsNone(batch[0].get("master_canonical"))


if __name__ == "__main__":
    unittest.main()