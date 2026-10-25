"""WebSocket Engine Feed Quality Monitor tests (websocket-engine.md §18–§21).

Pure unit tests: per-instrument quality counters, field availability, null /
invalid detection, duplicate detection, sequence-gap honesty, latency
percentiles, rolling feed speed, stale status and configurable thresholds.
"""
from __future__ import annotations

import time
import unittest

from neo_api_client.websocket.feed.models import DepthLevel, SFeedScrip

from ws_socket.engine.engine import WebSocketEngine
from ws_socket.engine.quality import (
    DEGRADED,
    LIVE,
    NO_FEED,
    STALE,
    FeedQualityMonitor,
    InstrumentQuality,
    expected_fields,
    percentile,
)


def make_scrip(**overrides) -> SFeedScrip:
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
        last_trade_time=int(time.time()),
        last_update_time=int(time.time()),
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


def envelope(token="1", feed_type="scrip", fields=None, ts=1000.0, **extra) -> dict:
    data = {
        "exchange_segment": "nse_cm",
        "instrument_token": token,
        "trading_symbol": "SBIN",
        "feed_type": feed_type,
        "received_at": ts,
        "broker_timestamp": ts,
        "fields": dict(fields or {}),
    }
    data.update(extra)
    return data


class PercentileTest(unittest.TestCase):
    def test_nearest_rank(self):
        samples = [float(v) for v in range(1, 101)]
        self.assertEqual(percentile(samples, 0), 1.0)
        self.assertEqual(percentile(samples, 50), 51.0)
        self.assertEqual(percentile(samples, 100), 100.0)
        self.assertIsNone(percentile([], 50))


class InstrumentQualityTest(unittest.TestCase):
    def test_duplicate_detection_requires_broker_timestamp(self):
        q = InstrumentQuality(instrument_key="nse_cm|1")
        base = {"ltp": 10.0, "volume": 5, "ltq": 1,
                "total_buy_quantity": 2, "total_sell_quantity": 3}
        q.observe(envelope(fields=base, ts=1000.0), 1000.0)
        q.observe(envelope(fields=dict(base), ts=1000.0), 1000.0)
        q.observe(envelope(fields={**base, "volume": 6}, ts=1000.0), 1000.0)
        row = q.snapshot(1000.0, 10, 30)
        self.assertEqual(row["duplicate_count"], 1)
        self.assertEqual(row["message_count"], 3)

    def test_duplicate_not_counted_without_timestamp(self):
        q = InstrumentQuality(instrument_key="nse_cm|1")
        q.observe(envelope(fields={"ltp": 1.0}, ts=None), 1000.0)
        q.observe(envelope(fields={"ltp": 1.0}, ts=None), 1000.0)
        self.assertEqual(q.snapshot(1000.0, 10, 30)["duplicate_count"], 0)

    def test_field_availability_null_and_invalid(self):
        q = InstrumentQuality(instrument_key="nse_cm|1")
        q.observe(envelope(fields={"ltp": None, "volume": "bad", "open": 1.0, "high": 2.0}), 1000.0)
        fa = q.snapshot(1000.0, 10, 30)["field_availability"]
        self.assertEqual(fa["expected"], len(expected_fields("scrip")))
        self.assertEqual(fa["received"], 4)
        self.assertEqual(fa["null_count"], 1)
        self.assertEqual(fa["null_fields"], {"ltp": 1})
        self.assertEqual(fa["invalid_count"], 1)
        self.assertEqual(fa["invalid_fields"], {"volume": 1})
        self.assertIn("low", fa["missing"])
        self.assertNotIn("ltp", fa["missing"])

    def test_latency_percentiles(self):
        q = InstrumentQuality(instrument_key="nse_cm|1")
        for latency in (10, 20, 30, 40, 50):
            q.observe(envelope(fields={"ltp": 1.0}, ts=1000.0), 1000.0 + latency / 1000.0)
        block = q.snapshot(1000.06, 10, 30)["latency"]
        self.assertTrue(block["available"])
        self.assertEqual(block["samples"], 5)
        self.assertEqual(block["min_ms"], 10.0)
        self.assertEqual(block["max_ms"], 50.0)
        self.assertEqual(block["avg_ms"], 30.0)
        self.assertEqual(block["p50_ms"], 30.0)

    def test_latency_unavailable_without_broker_timestamp(self):
        q = InstrumentQuality(instrument_key="nse_cm|1")
        q.observe(envelope(fields={"ltp": 1.0}, ts=None), 1000.0)
        block = q.snapshot(1000.0, 10, 30)["latency"]
        self.assertFalse(block["available"])
        self.assertIsNone(block["avg_ms"])

    def test_sequence_unavailable_never_fabricated(self):
        q = InstrumentQuality(instrument_key="nse_cm|1")
        q.observe(envelope(fields={"ltp": 1.0}), 1000.0)
        row = q.snapshot(1000.0, 10, 30)
        self.assertIsNone(row["sequence_gaps"])
        self.assertFalse(row["sequence_available"])
        self.assertEqual(row["sequence_reason"], "broker_sequence_unavailable")
        for seq in (1, 2, 4):
            q.observe(envelope(fields={"ltp": 1.0}, sequence=seq), 1000.0)
        row = q.snapshot(1000.0, 10, 30)
        self.assertEqual(row["sequence_gaps"], 1)
        self.assertTrue(row["sequence_available"])
        self.assertIsNone(row["sequence_reason"])

    def test_status_transitions(self):
        now = time.time()
        q = InstrumentQuality(instrument_key="nse_cm|1")
        q.observe(envelope(fields={"ltp": 1.0}, ts=now), now)
        self.assertEqual(q.status(now, 10, 30), LIVE)
        self.assertEqual(q.status(now + 15, 10, 30), DEGRADED)
        self.assertEqual(q.status(now + 40, 10, 30), STALE)
        self.assertEqual(InstrumentQuality(instrument_key="x").status(now, 10, 30), NO_FEED)

    def test_rolling_rate(self):
        now = time.time()
        q = InstrumentQuality(instrument_key="nse_cm|1")
        for _ in range(5):
            q.observe(envelope(fields={"ltp": 1.0}, ts=now), now)
        block = q.snapshot(now, 10, 30)["rate"]
        self.assertEqual(block["current_per_sec"], 5)
        self.assertGreaterEqual(block["max_per_sec"], 5)


class FeedQualityMonitorTest(unittest.TestCase):
    def test_overall_rollup_and_lookup(self):
        m = FeedQualityMonitor()
        now = time.time()
        m.observe(envelope(token="1", fields={"ltp": 1.0, "volume": 2}, ts=now), now)
        m.observe(envelope(token="2", fields={"ltp": 3.0, "volume": 4}, ts=now),
                  now + 20.0)
        summary = m.summary()
        self.assertEqual(summary["overall"]["instrument_count"], 2)
        self.assertEqual(summary["overall"]["duplicate_total"], 0)
        self.assertIn("latency", summary["overall"])
        self.assertGreaterEqual(summary["overall"]["status_counts"][LIVE], 1)
        self.assertEqual(m.instrument("nse_cm|1")["instrument_token"], "1")
        self.assertEqual(m.instrument("2")["instrument_token"], "2")
        self.assertIsNone(m.instrument("missing"))

    def test_stale_instruments_surface(self):
        m = FeedQualityMonitor(degraded_sec=1, stale_sec=2)
        now = time.time()
        m.observe(envelope(token="1", fields={"ltp": 1.0}, ts=now), now - 100.0)
        stale = m.stale_instruments()
        self.assertEqual(len(stale), 1)
        self.assertEqual(stale[0]["status"], STALE)

    def test_per_feed_type_thresholds(self):
        m = FeedQualityMonitor()
        m.update_thresholds(feed_type_thresholds={"index": {"degraded_sec": 1, "stale_sec": 2}})
        self.assertEqual(m.thresholds_for("index"), (1.0, 2.0))
        self.assertEqual(m.thresholds_for("scrip"), (m.degraded_sec, m.stale_sec))
        self.assertEqual(
            m.summary()["thresholds"]["per_feed_type"]["index"]["stale_sec"], 2)

    def test_rejected_counter(self):
        m = FeedQualityMonitor()
        m.record_rejected(3)
        self.assertEqual(m.rates()["rejected_total"], 3)


class EngineQualityIntegrationTest(unittest.TestCase):
    def test_engine_records_real_quality(self):
        engine = WebSocketEngine()
        engine.on_feed_message(make_scrip())
        engine.on_feed_message(make_scrip(last_traded_price=713.0))
        snap = engine.quality_snapshot()
        self.assertEqual(snap["overall"]["instrument_count"], 1)
        self.assertEqual(snap["instruments"][0]["instrument_key"], "nse_cm|11536")
        self.assertEqual(snap["instruments"][0]["message_count"], 2)
        self.assertEqual(snap["instruments"][0]["symbol"], "SBIN-EQ")
        self.assertIn("latency", snap["overall"])
        row = engine.quality_instrument("11536")
        self.assertIsNotNone(row)
        self.assertEqual(row["field_availability"]["expected"], len(expected_fields("scrip")))
        self.assertIn("latency_percentiles", engine.metrics())
        self.assertIn("feed_quality_overall", engine.metrics())


if __name__ == "__main__":
    unittest.main()
