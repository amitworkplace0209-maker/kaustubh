"""Deterministic unit tests for the Data SAVer Insights layer (no DB required).

Covers the pure derivable pieces of ``services.ds_insights`` and
``services.api_telemetry``: IST day-range math, previous-trading-day lookup,
event-ledger field hoisting/category mapping, telemetry histogram bucketing,
resampling, percentile approximation, the honest health score, CSV/JSON
exports and sanitized event serialization. MongoDB-backed aggregations are
exercised live in the app, not here.

Run with:  python -m unittest tests.test_ds_insights
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import ds_insights  # noqa: E402
from services import api_telemetry  # noqa: E402
from services.event_history import (  # noqa: E402
    _ledger_category,
    _market_date_ist,
    record_event,
)


class DayRangeTest(unittest.TestCase):
    def test_ist_day_to_utc_bounds(self):
        start, end = ds_insights._day_utc_range("2026-01-05")
        # 2026-01-05 00:00 IST == 2026-01-04 18:30 UTC.
        self.assertEqual(start.isoformat(), "2026-01-04T18:30:00+00:00")
        self.assertEqual(end.isoformat(), "2026-01-05T18:30:00+00:00")

    def test_ist_today_is_dated(self):
        value = ds_insights.ist_today()
        self.assertRegex(value, r"^\d{4}-\d{2}-\d{2}$")


class PreviousTradingDayTest(unittest.TestCase):
    def test_monday_previous_is_friday(self):
        # 2026-01-05 is a Monday and a NSE trading day.
        prev = ds_insights._previous_trading_day("2026-01-05")
        self.assertEqual(prev.isoformat(), "2026-01-02")  # Friday

    def test_sunday_previous_is_friday(self):
        prev = ds_insights._previous_trading_day("2026-01-11")  # Sunday
        self.assertEqual(prev.isoformat(), "2026-01-09")

    def test_invalid_input_returns_none(self):
        self.assertIsNone(ds_insights._previous_trading_day("not-a-date"))


class LedgerCategoryTest(unittest.TestCase):
    def test_source_mapping(self):
        mapping = {
            "websocket": "WEBSOCKET", "market_state": "MARKET", "session": "MARKET",
            "pipeline": "PIPELINE", "tick_buffer": "PIPELINE", "database": "DATABASE",
            "scheduler": "SCHEDULER", "settings": "SETTINGS", "auth": "AUTHENTICATION",
            "notification": "NOTIFICATION", "alert": "ALERT", "quality": "DATA_QUALITY",
            "scanner": "MARKET_DATA", "process": "SYSTEM",
        }
        for source, category in mapping.items():
            self.assertEqual(_ledger_category(source), category)

    def test_unknown_source_falls_back_to_system(self):
        self.assertEqual(_ledger_category("tiny_minions"), "SYSTEM")


class LedgerEntryTest(unittest.TestCase):
    def test_entry_hoists_meta_fields(self):
        entry = record_event(
            "quality", "QUALITY_ISSUE_CREATED", "warning",
            "Duplicate rate high",
            {"severity": "warning", "dimension": "Uniqueness", "symbol": "RELIANCE",
             "token": "2885", "exchange": "NSE", "segment": "EQ",
             "reason_code": "dup-rate", "component": "data_quality",
             "connection_id": None, "duration_ms": 42},
        )
        self.assertEqual(entry["category"], "DATA_QUALITY")
        self.assertEqual(entry["symbol"], "RELIANCE")
        self.assertEqual(entry["token"], "2885")
        self.assertEqual(entry["reason_code"], "dup-rate")
        self.assertEqual(entry["duration_ms"], 42)
        self.assertRegex(entry["market_date"], r"^\d{4}-\d{2}-\d{2}$")

    def test_market_date_is_ist(self):
        self.assertRegex(_market_date_ist(datetime(2026, 1, 5, 18, 30, tzinfo=timezone.utc)),
                         r"^\d{4}-\d{2}-\d{2}$")


class HealthScoreTest(unittest.TestCase):
    def test_no_evidence_is_not_enough_data(self):
        result = ds_insights._health_score(
            ws_uptime_pct=None, ws_connected=None, pipeline_success=None,
            received=0, errors_total=None, quality_score=None,
            api_success_pct=None, scheduler_ok=None, scheduler_runs=None)
        self.assertIsNone(result["score"])
        self.assertEqual(result["status"], "Not enough data")

    def test_partial_evidence_normalizes_weights(self):
        result = ds_insights._health_score(
            ws_uptime_pct=90.0, ws_connected=True, pipeline_success=100.0,
            received=1000, errors_total=1, quality_score=95.0,
            api_success_pct=99.0, scheduler_ok=10, scheduler_runs=10)
        self.assertIsNotNone(result["score"])
        self.assertGreaterEqual(result["score"], 0)
        self.assertLessEqual(result["score"], 100)

    def test_honest_null_when_no_ticks(self):
        result = ds_insights._health_score(
            ws_uptime_pct=100.0, ws_connected=True, pipeline_success=100.0,
            received=0, errors_total=0, quality_score=100.0,
            api_success_pct=100.0, scheduler_ok=1, scheduler_runs=1)
        self.assertIsNone(result["score"])


class ResampleTest(unittest.TestCase):
    def test_sums_received_and_averages_rates(self):
        items = [
            {"timestamp": "2026-01-05T09:00:00+00:00", "received": 10,
             "written": 8, "errors": 1, "ticksPerSecond": 100, "feedLatencyMs": 5},
            {"timestamp": "2026-01-05T09:01:00+00:00", "received": 20,
             "written": 18, "errors": 2, "ticksPerSecond": 200, "feedLatencyMs": 15},
        ]
        out = ds_insights._resample(items, resolution_min=2)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["received"], 30)
        self.assertEqual(out[0]["written"], 26)
        self.assertEqual(out[0]["errors"], 3)
        self.assertEqual(out[0]["ticksPerSecond"], 150.0)
        self.assertEqual(out[0]["feedLatencyMs"], 10.0)


class PercentilesTest(unittest.TestCase):
    def test_cumulative_percentiles(self):
        buckets = [
            {"bucket": 5, "count": 10},
            {"bucket": 10, "count": 40},
            {"bucket": 25, "count": 50},
        ]
        p50, p95, p99 = ds_insights._percentiles_from_buckets(buckets, 100)
        self.assertEqual(p50, 10)  # cumulative 50 reached at bucket 10
        self.assertEqual(p95, 25)  # cumulative 95 reached at bucket 25
        self.assertEqual(p99, 25)

    def test_empty_returns_none(self):
        self.assertEqual(ds_insights._percentiles_from_buckets([], 0),
                         (None, None, None))


class ApiTelemetryTest(unittest.TestCase):
    def setUp(self):
        api_telemetry._ACCUM = {}

    def test_histogram_bucket_edges(self):
        edges = api_telemetry.HISTOGRAM_EDGES_MS
        self.assertEqual(api_telemetry._histogram_bucket(0.1), 5)
        self.assertEqual(api_telemetry._histogram_bucket(5.0), 5)
        self.assertEqual(api_telemetry._histogram_bucket(99.9), 100)
        self.assertEqual(api_telemetry._histogram_bucket(100.0), 100)
        self.assertEqual(api_telemetry._histogram_bucket(100.1), 250)
        self.assertEqual(api_telemetry._histogram_bucket(99999), edges[-1])

    def test_record_request_accumulates(self):
        api_telemetry.record_request("GET", "/api/system", 200, 50.0)
        api_telemetry.record_request("GET", "/api/system", 404, 60.0)
        api_telemetry.record_request("POST", "/api/data-saver/insights/reports/generate", 500, 2000.0)
        acc = api_telemetry._ACCUM
        total_requests = sum(a["requests"] for a in acc.values())
        total_errors = sum(a["errors"] for a in acc.values())
        self.assertEqual(total_requests, 3)
        # 500 counts server error; 404 is NOT counted as an error.
        self.assertEqual(total_errors, 1)
        self.assertEqual(sum(a["serverErrors"] for a in acc.values()), 1)
        self.assertEqual(sum(a["clientErrors"] for a in acc.values()), 1)

    def test_no_sensitive_keys_recorded(self):
        api_telemetry.record_request("GET", "/api/system", 200, 10.0)
        for acc in api_telemetry._ACCUM.values():
            keys = " ".join(str(k).lower() for k in acc.keys())
            for secret in ("token", "password", "authorization", "cookie"):
                self.assertNotIn(secret, keys)

    def test_flush_without_mongo_is_safe(self):
        # No MongoDB in the test env — flush must return 0, not raise.
        api_telemetry.record_request("GET", "/api/system", 200, 5.0)
        import asyncio
        written = asyncio.run(api_telemetry.flush_and_reset())
        self.assertEqual(written, 0)


class ExportTest(unittest.TestCase):
    def test_csv_columns_in_order(self):
        events = [{"event_id": "evt_1", "timestamp": "2026-01-05T00:00:00+05:30",
                   "category": "WEBSOCKET", "severity": "info",
                   "event_type": "connected", "source": "websocket",
                   "status": "info", "message": "hi", "meta": {"secret": "x"}}]
        csv = ds_insights.export_events_csv(events)
        header = csv.splitlines()[0]
        self.assertIn("event_id,timestamp,category,severity,event_type", header)
        self.assertNotIn("secret", csv)

    def test_json_export_strips_meta(self):
        events = [{"event_id": "evt_1", "message": "hello", "meta": {"token": "top-secret"}}]
        body = ds_insights.export_events_json(events)
        self.assertIn("evt_1", body)
        self.assertNotIn("top-secret", body)


class SerializeEventTest(unittest.TestCase):
    def test_whitelisted_fields_only(self):
        doc = {"_id": "x", "event_id": "e1", "source": "websocket",
               "event": "connected", "status": "info", "severity": "info",
               "category": "WEBSOCKET", "market_date": "2026-01-05",
               "message": "ok", "meta": {"token": "secret", "reason": "r"},
               "ts": datetime(2026, 1, 5, 0, 0, tzinfo=timezone.utc)}
        row = ds_insights._serialize_event(doc)
        self.assertNotIn("_id", row)
        self.assertNotIn("secret", str(row))
        self.assertEqual(row["event_type"], "connected")
        self.assertIn("timestamp", row)

    def test_body_redacts_secrets(self):
        doc = {"event_id": "e1", "meta": {"token": "abc", "password": "def",
                                          "benign": "ok"}, "ts": None}
        row = ds_insights._serialize_event(doc, with_body=True)
        self.assertEqual(row["metadata"]["token"], "[REDACTED]")
        self.assertEqual(row["metadata"]["password"], "[REDACTED]")
        self.assertEqual(row["metadata"]["benign"], "ok")


if __name__ == "__main__":
    unittest.main()