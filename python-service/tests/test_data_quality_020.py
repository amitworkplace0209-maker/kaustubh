"""020 Data Quality redesign — regression tests (no live DB required).

Covers the defects found in the 020 forensic audit:

1. Metric cache key ignored exchange/segment/intraday filters, so a filtered
   view replayed the unfiltered payload.
2. ``quality_symbols`` referenced an undefined ``start`` (NameError swallowed
   per-symbol → duplicates silently 0) and counted duplicate GROUPS while the
   global metric reports excess ROWS.
3. Per-symbol ordering/invalid/missing were hardcoded 0 (fabricated) instead
   of null / not-measured.
4. ``_compute_all_filtered`` measured the unfiltered (hours, symbol) scope
   while totals were filtered (mismatched rates).
5. Pipeline stages omitted Quality / DB Writer / MongoDB and reported no
   latency honesty note.
6. Storage reported no provider identity and no retention contract.

Run with:  python -m pytest tests/test_data_quality_020.py -q
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api import quality  # noqa: E402
from services import data_quality as dq  # noqa: E402


class CacheKeyIsolationTest(unittest.TestCase):
    def test_unfiltered_key_legacy_format(self):
        self.assertEqual(dq._cache_key(24, ""), "24:")

    def test_exchange_changes_key(self):
        a = dq._cache_key(24, "", {"exchange": "NSE"})
        b = dq._cache_key(24, "", {"exchange": "BSE"})
        self.assertNotEqual(a, b)

    def test_segment_and_symbol_scope_change_key(self):
        a = dq._cache_key(24, "RELIANCE", {"segment": "EQ"})
        b = dq._cache_key(24, "RELIANCE", {"segment": "FO"})
        c = dq._cache_key(24, "TCS", {"segment": "EQ"})
        self.assertNotEqual(a, b)
        self.assertNotEqual(a, c)

    def test_identical_filters_share_key(self):
        a = dq._cache_key(24, "", {"exchange": "NSE", "segment": "EQ"})
        b = dq._cache_key(24, "", {"segment": "EQ", "exchange": "NSE"})
        self.assertEqual(a, b)


class WindowParsingTest(unittest.TestCase):
    def test_parse_window_bounds(self):
        self.assertEqual(quality._parse_window(0), 1)
        self.assertEqual(quality._parse_window(5000), 720)
        self.assertEqual(quality._parse_window(None), 24)
        self.assertEqual(quality._parse_window("bad"), 24)

    def test_time_filter_explicit_date(self):
        f = quality._build_time_filter(24, "2026-09-01", None, None)
        start = f["ts"]["$gte"]
        end = f["ts"]["$lt"]
        self.assertEqual((end - start), timedelta(days=1))
        self.assertEqual(start.hour, 0)

    def test_time_filter_intraday_range(self):
        f = quality._build_time_filter(24, None, "09:15", "15:30")
        self.assertIn("$gte", f["ts"])
        self.assertIn("$lt", f["ts"])
        self.assertLess(f["ts"]["$gte"], f["ts"]["$lt"])


class FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def sort(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def max_time_ms(self, *a, **k):
        return self

    def __aiter__(self):
        async def _gen():
            for r in self._rows:
                yield r

        return _gen()


class FakeAggCursor:
    def __init__(self, rows):
        self._rows = rows

    async def to_list(self, *a, **k):
        n = a[0] if a else k.get("length", 100)
        return self._rows[:n]


class FakeTicks:
    """Minimal ticks collection double: group returns no duplicates."""

    def __init__(self, rows):
        self._rows = rows
        self.seen_matches: list[dict] = []

    def aggregate(self, pipeline, **kw):
        self.seen_matches.append(pipeline[0].get("$match", {}))
        # Top-level symbol aggregation shape vs per-symbol dup shape.
        if pipeline[0].get("$match", {}).get("symbol") and any(
            "$subtract" in str(stage) for stage in pipeline
        ):
            return FakeAggCursor([])
        if any("$subtract" in str(stage) for stage in pipeline):
            return FakeAggCursor([])
        return FakeAggCursor([])

    def find(self, *a, **k):
        return FakeCursor([])


def _amock(**kw):
    m = mock.AsyncMock()
    for k, v in kw.items():
        setattr(m, k, v)
    return m


class SymbolsScopeTest(unittest.IsolatedAsyncioTestCase):
    async def test_symbols_scope_uses_time_filter_and_reports_unmeasured(self):
        """No NameError; per-symbol dup scoped to the window; ooo/invalid null."""
        now = datetime.now(timezone.utc)
        group_rows = [
            {"_id": "RELIANCE", "ticks": 10, "firstTs": now, "lastTs": now},
        ]
        db_seen: list[dict] = []

        def _fake_aggregate(pipeline, **kw):
            m = pipeline[0].get("$match", {})
            if isinstance(m.get("symbol"), str):
                db_seen.append(m)
                return FakeAggCursor([])  # no duplicate groups
            return FakeAggCursor(group_rows)

        db = mock.MagicMock()
        ticks = mock.MagicMock()
        ticks.aggregate.side_effect = _fake_aggregate
        db.ticks = ticks
        fake_cache = mock.MagicMock()
        fake_cache.loaded = False

        with mock.patch.object(quality, "get_db", return_value=db), mock.patch.object(
            quality, "instrument_cache", fake_cache
        ):
            out = await quality.quality_symbols(hours=24, limit=10)

        self.assertEqual(out["count"], 1)
        row = out["items"][0]
        # Excess-row dup scan found nothing → 0 measured (not a crash).
        self.assertEqual(row["duplicates"], 0)
        # Per-symbol granularity that is NOT computed must be null, not 0.
        self.assertIsNone(row["outOfOrder"])
        self.assertIsNone(row["invalid"])
        self.assertIsNone(row["missing"])
        self.assertFalse(row.get("outOfOrderMeasured", True))
        # The per-symbol duplicate scope carried the window start (the old
        # code raised NameError on `start` here).
        self.assertTrue(db_seen, "expected at least one per-symbol dup scope")
        self.assertIn("ts", db_seen[0])
        self.assertIn("$gte", db_seen[0]["ts"])


class FilteredScopeTest(unittest.IsolatedAsyncioTestCase):
    async def test_compute_all_filtered_passes_slice_to_service(self):
        seen: dict = {}

        async def _fake_metrics(hours, symbol="", use_cache=True, **kw):
            seen["hours"] = hours
            seen["symbol"] = symbol
            seen["extra"] = kw.get("extra_match")
            seen["start"] = kw.get("start_override")
            return {
                "window": {},
                "totals": {"totalTicks": 5, "attemptedSaves": 5},
                "errors": {
                    "missing": None,
                    "duplicates": 0,
                    "outOfOrder": 0,
                    "timestampErrors": 0,
                    "invalidLtp": 0,
                    "invalidVolume": 0,
                    "schemaErrors": 0,
                    "saveFailures": 0,
                },
                "rates": {},
                "pipeline": {"written": 5},
                "websocket": {},
                "freshness": {},
            }

        db = mock.MagicMock()
        db.ticks.count_documents = _amock(return_value=5).return_value  # placeholder
        db.ticks.count_documents = mock.AsyncMock(return_value=5)
        db.ticks.distinct = mock.AsyncMock(return_value=["RELIANCE"])

        with mock.patch.object(quality, "get_db", return_value=db), mock.patch.object(
            quality, "_db_health_payload", new=mock.AsyncMock(return_value={"connected": True})
        ), mock.patch.object(
            quality.tick_buffer, "stats", return_value={}
        ), mock.patch.object(
            quality.ws_manager, "status", return_value={}
        ), mock.patch(
            "services.data_quality._compute_metrics", side_effect=_fake_metrics
        ):
            tf = quality._build_time_filter(24, None, "09:15", "15:30")
            out = await quality._compute_all_filtered(
                tf, 200000, "", "NSE", "EQ", hours=24
            )

        self.assertEqual(seen["hours"], 24)
        self.assertEqual((seen["extra"] or {}).get("exchange"), "NSE")
        self.assertEqual((seen["extra"] or {}).get("segment"), "EQ")
        self.assertIsNotNone(seen["start"])
        self.assertTrue(out["window"]["filtered"])
        self.assertEqual(out["window"]["exchange"], "NSE")


class PipelineStagesTest(unittest.IsolatedAsyncioTestCase):
    async def test_six_canonical_stages_with_honesty_notes(self):
        with mock.patch.object(
            quality.tick_buffer, "stats", return_value={
                "totalReceived": 10, "totalWritten": 9, "totalWriteErrors": 0,
                "bufferLength": 1, "bufferMaxSize": 100, "ticksPerSecond": 2.0,
                "pipelineRunning": True, "lastWriteAt": None, "lastFlushAt": None,
                "feedLatencyMs": None,
            }
        ), mock.patch.object(
            quality.ws_manager, "status",
            return_value={"connected": False, "subscription_count": 0},
        ), mock.patch.object(
            quality, "_db_health_payload",
            new=mock.AsyncMock(return_value={"connected": False, "provider": "Unknown", "pingMs": None}),
        ), mock.patch.object(
            quality, "get_db", return_value=mock.MagicMock()
        ), mock.patch(
            "services.pipeline_latency.stats", return_value={"stages": {}, "agenda": {}}
        ):
            out = await quality.pipeline_health()

        names = [s["name"] for s in out["stages"]]
        self.assertEqual(
            names,
            ["Broker Feed", "WebSocket", "Validation", "Quality", "DB Writer", "MongoDB"],
        )
        for s in out["stages"]:
            if s["latencyMs"] is None:
                self.assertTrue(
                    (s.get("latencyNote") or "").startswith("NOT MEASURED"),
                    f"stage {s['name']} must explain its null latency",
                )


class DuplicatesEndpointTest(unittest.IsolatedAsyncioTestCase):
    async def test_duplicates_window_uses_request_time_filter(self):
        """Live 020 fix: the response window referenced an undefined `start`
        (NameError → HTTP 500 on every call). It must use the request window."""

        def _empty_agg(pipeline, **kw):
            class _C:
                async def to_list(self, *a, **k):
                    return []

            return _C()

        db = mock.MagicMock()
        # Motor aggregate() is sync (returns a cursor); only to_list() is async.
        db.ticks.aggregate = mock.MagicMock(side_effect=_empty_agg)
        with mock.patch.object(quality, "get_db", return_value=db):
            out = await quality.quality_duplicates(hours=24, limit=5)
        self.assertIn("window", out)
        self.assertEqual(out["window"]["hours"], 24)
        self.assertIn("startedAt", out["window"])
        self.assertEqual(out["count"], 0)
        self.assertEqual(out["duplicateRecords"], 0)

    async def test_duplicates_groups_shape(self):
        now = datetime.now(timezone.utc)

        def _grouped_agg(pipeline, **kw):
            class _C:
                async def to_list(self, *a, **k):
                    return [{
                        "_id": {"token": 123, "ts": now, "ltp": 10.0,
                                "volume": 5, "bp": 9.9, "sp": 10.1},
                        "n": 3, "symbols": ["CUPID"],
                    }]

            return _C()

        db = mock.MagicMock()
        db.ticks.aggregate = mock.MagicMock(side_effect=_grouped_agg)
        fake_cache = mock.MagicMock()
        fake_cache.loaded = False
        with mock.patch.object(quality, "get_db", return_value=db), mock.patch.object(
            quality, "instrument_cache", fake_cache
        ):
            out = await quality.quality_duplicates(hours=24, limit=5)
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["duplicateRecords"], 2)  # excess rows, not groups
        self.assertEqual(out["groups"][0]["extra"], 2)
        self.assertEqual(out["groups"][0]["symbol"], "CUPID")


class MetricSeverityTest(unittest.TestCase):
    def test_zero_measured_failures_are_ok_not_critical(self):
        """Live 020 fix: 0 failures with 0% rate rendered CRITICAL because the
        failure band starts at warn=0/crit=0."""
        th = {"duplicateRateWarn": 2.0, "missingRateWarn": 1.0, "dbFailuresCritical": 0}
        m = quality._metric("DB Write Failures", 0, 0.0, 100, "db", "Database", True, th, None)
        self.assertEqual(m["severity"], "ok")

    def test_nonzero_failures_still_critical(self):
        th = {"duplicateRateWarn": 2.0, "missingRateWarn": 1.0, "dbFailuresCritical": 0}
        m = quality._metric("DB Write Failures", 3, 1.5, 200, "db", "Database", True, th, None)
        self.assertEqual(m["severity"], "critical")

    def test_unmeasured_stays_info(self):
        th = {"duplicateRateWarn": 2.0, "missingRateWarn": 1.0, "dbFailuresCritical": 0}
        m = quality._metric("Missing Ticks", 0, None, 0, "x", "Missing", False, th, None)
        self.assertEqual(m["severity"], "info")


class StorageRetentionTest(unittest.IsolatedAsyncioTestCase):
    async def test_storage_carries_provider_and_retention_contract(self):
        db = mock.MagicMock()
        db.ticks.estimated_document_count = mock.AsyncMock(return_value=0)
        db.daily_summaries.find_one = mock.AsyncMock(return_value=None)

        with mock.patch.object(quality, "get_db", return_value=db), mock.patch.object(
            quality, "_db_health_payload",
            new=mock.AsyncMock(return_value={"connected": True, "provider": "Atlas", "dbName": "kaustubh"}),
        ), mock.patch.object(quality.tick_buffer, "stats", return_value={}), mock.patch.object(
            quality, "_load_config",
            new=mock.AsyncMock(return_value={"snapshotRetentionDays": 30}),
        ):
            out = await quality.storage_health()

        self.assertEqual(out["database"]["provider"], "Atlas")
        self.assertIn("retention", out)
        self.assertEqual(out["retention"]["qualitySnapshotRetentionDays"], 30)
        self.assertTrue(out["retention"]["qualitySnapshotRetentionMeasured"])
        # No TTL on ticks, no issue retention, no archive — must say so.
        self.assertFalse(out["retention"]["tickRetentionMeasured"])
        self.assertIn("CONFIGURATION UNAVAILABLE", out["retention"]["tickRetention"])
        self.assertFalse(out["retention"]["issueRetentionMeasured"])
        self.assertFalse(out["retention"]["archiveMeasured"])


if __name__ == "__main__":
    unittest.main()
