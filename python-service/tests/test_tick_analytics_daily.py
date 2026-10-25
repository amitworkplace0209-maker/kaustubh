"""Deterministic unit tests for :mod:`services.tick_analytics_daily`.

These test ONLY the pure reducers, the session/period derivation and the
Tick Analytics Report honesty contract -- they never touch MongoDB, the
websocket manager, or any live service.

Run:  python -m pytest tests/test_tick_analytics_daily.py -q
"""
from __future__ import annotations

import os
import sys

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from datetime import datetime, timezone

import asyncio

from services import market_calendar
from services import tick_analytics_daily as tad
from core.timezones import IST

DATE = "2026-09-25"          # a Friday -> normal market day
SAT_DATE = "2026-09-26"      # a Saturday -> closed


def _ms(hh: int, mm: int, ss: int = 0, date: str = DATE) -> int:
    d = datetime.strptime(date, "%Y-%m-%d").replace(
        hour=hh, minute=mm, second=ss, tzinfo=IST)
    return int(d.timestamp() * 1000)


# ------------------------- numeric honesty helpers -------------------------

def test_fnum_rejects_non_finite():
    assert tad._fnum(None) is None
    assert tad._fnum(float("nan")) is None
    assert tad._fnum(float("inf")) is None
    assert tad._fnum("12.5") == 12.5
    assert tad._fnum("abc") is None


def test_int_coercion():
    assert tad._int(None) is None
    assert tad._int("42") == 42
    assert tad._int(3.7) == 3
    assert tad._int("x") is None


def test_safe_div_never_returns_zero_on_empty_denominator():
    # Honesty contract: a missing/zero denominator is None, never 0.0.
    assert tad._safe_div(1, 0) is None
    assert tad._safe_div(1, None) is None
    assert tad._safe_div(None, 5) is None
    assert tad._safe_div(1, 4) == 0.25


def test_pct_never_returns_zero_on_empty_denominator():
    assert tad._pct(0, 0) is None
    assert tad._pct(None, 100) is None
    assert tad._pct(50, 100) == 50.0


# ------------------------- time / session derivation -----------------------

def test_day_window_is_utc_half_open_ist_day():
    start, end = tad.day_window(DATE)
    assert start.tzinfo is not None
    # IST midnight == 18:30 UTC the previous day.
    assert (start.astimezone(timezone.utc)).strftime("%H:%M:%S") == "18:30:00"
    assert (end - start).total_seconds() == 86400
    assert end > start


def test_recent_days_is_newest_first_and_contiguous():
    days = tad.recent_days(5)
    assert len(days) == 5
    assert days[0] == tad.business_date_str()
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in days]
    assert all((parsed[i] - parsed[i + 1]).days == 1 for i in range(len(parsed) - 1))


def test_is_today_only_matches_business_date():
    assert tad.is_today(tad.business_date_str()) is True
    assert tad.is_today("1999-01-01") is False


def test_session_boundaries_from_market_calendar_not_hardcoded():
    b = tad.session_boundaries(DATE)
    assert b["tradingDay"] is True
    assert b["dayClass"] == market_calendar.NORMAL_MARKET_DAY
    assert b["sessionOpenMinute"] == 9 * 60 + 15   # 09:15
    assert b["sessionCloseMinute"] == 15 * 60 + 30  # 15:30
    assert b["marketOpenAt"] is not None
    assert b["marketCloseAt"] is not None
    assert b["closureReason"] is None


def test_session_boundaries_on_a_closed_day_report_no_session():
    b = tad.session_boundaries(SAT_DATE)
    assert b["tradingDay"] is False
    assert b["sessionOpenMinute"] is None
    assert b["sessionCloseMinute"] is None
    assert b["marketOpenAt"] is None


def test_build_periods_tile_the_session_without_gaps_or_overlap():
    periods = tad.build_periods(DATE)
    assert periods, "a normal market day must produce activity periods"
    assert periods[0]["startMinute"] == 9 * 60 + 15
    assert periods[0]["label"] == "09:15-10:00"
    assert periods[-1]["endMinute"] == 15 * 60 + 30
    for a, b in zip(periods, periods[1:]):
        assert a["endMinute"] == b["startMinute"], "periods must be contiguous"
    assert sum(p["endMinute"] - p["startMinute"] for p in periods) == (
        (15 * 60 + 30) - (9 * 60 + 15))


def test_build_periods_empty_on_closed_day():
    assert tad.build_periods(SAT_DATE) == []


def test_minute_index_parsing_is_lenient_but_never_raises():
    assert tad._minute_index(DATE, "09:15") == 9 * 60 + 15
    assert tad._minute_index(DATE, "bogus") is None
    assert tad._minute_index(DATE, "") is None
    assert tad._minute_index("not-a-date", "09:15") is None


# ------------------------- pure reducers -----------------------------------

def test_reduce_seconds_empty_never_fabricates_values():
    out = tad.reduce_seconds([])
    assert out["count"] == 0
    assert out["peakPerSec"] is None
    assert out["avgPerSec"] is None
    assert out["p50PerSec"] is None
    assert out["firstMs"] is None
    assert out["lastMs"] is None
    assert out["series"] == []


def test_reduce_seconds_sorts_and_computes_rate_statistics():
    rows = [
        {"_id": _ms(9, 16), "n": 4},
        {"_id": _ms(9, 15), "n": 10},
        {"_id": _ms(9, 17), "n": 2},
    ]
    out = tad.reduce_seconds(rows)
    assert [ms for ms, _ in out["series"]] == sorted(ms for ms, _ in out["series"])
    assert out["count"] == 16
    assert out["activeSeconds"] == 3
    assert out["peakPerSec"] == 10
    assert out["minPerSec"] == 2
    assert out["avgPerSec"] == round(16 / 3, 4)
    assert out["firstMs"] == _ms(9, 15)
    assert out["lastMs"] == _ms(9, 17)
    assert out["p50PerSec"] is not None


def test_reduce_seconds_skips_rows_without_a_timestamp():
    out = tad.reduce_seconds([{"_id": None, "n": 5}, {"n": 7}])
    assert out["count"] == 0
    assert out["series"] == []


def test_sorted_percentile_known_values():
    assert tad._sorted_percentile([], 0.5) is None
    assert tad._sorted_percentile([7], 0.95) == 7.0
    assert tad._sorted_percentile([1, 2, 3, 4], 0.5) == 2.5
    assert tad._sorted_percentile([1, 2, 3, 4], 0.0) == 1.0
    assert tad._sorted_percentile([1, 2, 3, 4], 1.0) == 4.0


def test_minute_rollup_buckets_by_ist_minute_and_drops_other_days():
    series = [
        (_ms(9, 15), 3),
        (_ms(9, 15), 4),          # same minute -> merged
        (_ms(9, 16), 1),
        (_ms(10, 0), 9),
        (_ms(11, 0, date="2026-09-24"), 50),  # other day -> dropped
    ]
    out = tad.minute_rollup(series, DATE)
    assert [b["m"] for b in out] == [9 * 60 + 15, 9 * 60 + 16, 10 * 60]
    first = out[0]
    assert first["n"] == 7
    assert first["peak"] == 4          # peak is the largest single-second burst
    assert out[2]["n"] == 9


def test_fold_periods_aggregates_ticks_from_minute_buckets():
    periods = tad.build_periods(DATE)
    buckets = [
        {"m": 9 * 60 + 15, "n": 10, "peak": 5},
        {"m": 9 * 60 + 16, "n": 6, "peak": 6},
        {"m": 10 * 60 + 1, "n": 4, "peak": 4},
    ]
    out = tad.fold_periods(periods, buckets, {})
    first = out[0]
    assert first["label"] == "09:15-10:00"
    assert first["ticks"] == 16
    assert first["peakRatePerSec"] == 6
    assert first["activeMinutes"] == 2
    assert first["symbols"] is None, "unknown symbol count must stay None"
    assert first["avgRatePerSec"] == round(16 / (45 * 60), 4)


def test_fold_periods_reports_zero_rate_only_for_actually_empty_periods():
    periods = tad.build_periods(DATE)
    out = tad.fold_periods(periods, [], {})
    assert all(p["ticks"] == 0 for p in out)
    assert all(p["avgRatePerSec"] == 0.0 for p in out)
    assert all(p["peakRatePerSec"] is None for p in out)
    assert all(p["activeMinutes"] == 0 for p in out)


def test_fold_minute_symbols_assigns_to_the_right_period():
    rows = [
        {"_id": {"m": "09:20", "s": "RELIANCE"}},
        {"_id": {"m": "10:30", "s": "TCS"}},
        {"_id": {"m": "09:20", "s": "RELIANCE"}},   # duplicate -> set dedupes
        {"_id": {"m": "bogus", "s": "SKIP"}},
        {"_id": {"m": "09:21", "s": "  "}},         # blank symbol -> skipped
    ]
    out = tad.fold_minute_symbols(rows, DATE)
    first_key = (9 * 60 + 15, 10 * 60)
    second_key = (10 * 60, 11 * 60)
    assert out[first_key] == {"RELIANCE"}
    assert out[second_key] == {"TCS"}
    assert all(isinstance(v, set) for v in out.values())


# ------------------------- report honesty contract -------------------------

def _full_doc() -> dict:
    return {
        "date": DATE,
        "schema": "tick_analytics_daily/v1",
        "tradingDay": True,
        "dayClass": market_calendar.NORMAL_MARKET_DAY,
        "closureReason": None,
        "status": "COMPLETE",
        "counts": {"received": 1000, "persisted": 995, "failed": 5,
                   "skipped": 3, "symbols": 42, "storedDocs": 995},
        "ticks": {"count": 995, "firstTickAt": "2026-09-25T09:15:00+05:30",
                  "lastTickAt": "2026-09-25T15:29:59+05:30",
                  "activeDurationSec": 22499.0, "avgTickRate": 44.2,
                  "peakTickRate": 910.0, "series": [1, 2]},
        "rate": {"avg": 44.2, "peak": 910.0},
        "persistence": {"received": 1000, "persisted": 995, "failed": 5,
                        "skipped": 3, "successPct": 99.5},
        "storage": {"bytes": 123456},
        "quality": {"score": 98.0},
        "latency": {"available": True},
        "sources": {"received": "daily_summaries.totalTicks"},
        "symbolStats": [{"symbol": "RELIANCE", "ticks": 500}],
        "periods": [],
        "anomalies": [],
    }


def test_report_without_document_is_no_data_with_explicit_missing():
    rep = tad.build_report(DATE, None)
    assert rep["status"] == "NO_DATA"
    assert rep["complete"] is False
    assert rep["sections"] is None
    assert rep["missing"] == ["daily_document"]
    assert rep["reason"] == "NO_TICK_DATA"
    assert rep["generatedAt"]


def test_report_with_empty_doc_is_no_data_not_zeroed_metrics():
    rep = tad.build_report(DATE, tad._empty_doc(DATE, "PENDING_BUILD"))
    assert rep["status"] == "NO_DATA"
    assert rep["complete"] is False
    assert "ticksReceived" in rep["missing"]
    assert "persistenceSuccessRate" in rep["missing"]
    assert rep["sections"]["ticks"]["avgTickRate"] is None


def test_report_complete_only_when_every_required_metric_present():
    rep = tad.build_report(DATE, _full_doc())
    assert rep["status"] == "COMPLETE"
    assert rep["complete"] is True
    assert rep["missing"] == []
    assert rep["sections"]["counts"]["received"] == 1000
    assert rep["sections"]["persistence"]["successPct"] == 99.5
    assert rep["sections"]["storage"]["bytes"] == 123456
    assert "series" not in rep["sections"]["ticks"], "raw series must not leak"


def test_report_partial_names_exactly_the_missing_metric():
    doc = _full_doc()
    doc["persistence"]["successPct"] = None
    rep = tad.build_report(DATE, doc)
    assert rep["status"] == "PARTIAL"
    assert rep["complete"] is False
    assert rep["missing"] == ["persistenceSuccessRate"]


def test_report_writer_activity_without_stored_ticks_is_partial_not_no_data():
    doc = _full_doc()
    doc["ticks"]["count"] = 0
    doc["counts"]["storedDocs"] = 0
    rep = tad.build_report(DATE, doc)
    assert rep["status"] == "PARTIAL"
    assert rep["complete"] is False
    assert "storedTickDocuments" in rep["missing"], (
        "a day where the writer recorded ticks but stored none must name the gap"
    )


def test_report_is_no_data_only_when_there_was_no_activity_at_all():
    doc = _full_doc()
    doc["ticks"]["count"] = 0
    doc["counts"] = {"received": 0, "persisted": 0, "failed": 0,
                     "skipped": 0, "symbols": 0, "storedDocs": 0}
    doc["persistence"]["successPct"] = None
    rep = tad.build_report(DATE, doc)
    assert rep["status"] == "NO_DATA"
    assert rep["reason"] == "NO_TICK_DATA"
    assert rep["complete"] is False


# ------------------------- session-scoped counters -------------------------

def test_db_writer_session_counters_is_a_dict_and_never_raises():
    out = tad.db_writer_session_counters()
    assert isinstance(out, dict)
    if out:
        # Session-scoped counters must be labelled as such -- they are NOT
        # day counters and must never be presented as one.
        assert out["scope"] == "session"
        assert isinstance(out["sources"], list)
        assert isinstance(out["dropReasons"], dict)


def test_latency_slice_labels_provenance_or_is_none():
    out = tad.latency_slice()
    assert out is None or (isinstance(out, dict) and "hops" in out)
    if out is not None:
        assert out["source"] == "PIPELINE_LATENCY"
        assert out["scope"] == "process"


def test_storage_slice_without_mongo_reports_a_reason_not_zero():
    import asyncio

    out = asyncio.run(tad.storage_slice(None, 0))
    assert out["bytes"] is None
    assert out["collection"] == "ticks"
    assert out["reason"] is not None, "unmeasurable storage must carry a reason"


# ------------------------- backfill bookkeeping ----------------------------

def test_backfill_queue_dedupes_and_skips_completed_days():
    tad.reset_state()
    try:
        tad.queue_backfill(["2026-09-24", "2026-09-24", "2026-09-23"])
        assert tad.backfill_state()["queued"] == 2
        tad.queue_backfill(["2026-09-24"])
        assert tad.backfill_state()["queued"] == 2, "re-queue must dedupe"
    finally:
        tad.reset_state()


def test_backfill_queue_never_requeues_a_completed_day():
    tad.reset_state()
    try:
        tad._backfill_done.add("2026-09-24")
        tad.queue_backfill(["2026-09-24"])
        assert tad.backfill_state()["queued"] == 0
    finally:
        tad.reset_state()


def test_backfill_state_reports_all_three_counters():
    tad.reset_state()
    try:
        state = tad.backfill_state()
        assert state == {"queued": 0, "completed": 0, "running": False}
    finally:
        tad.reset_state()


def test_reset_state_clears_caches_and_bookkeeping():
    tad.reset_state()
    tad._day_cache["2026-09-24"] = (0.0, {})
    tad._list_cache[(30,)] = (0.0, [])
    tad._backfill_done.add("2026-09-24")
    tad._backfill_queue.append("2026-09-23")
    tad.reset_state()
    assert tad._day_cache == {}
    assert tad._list_cache == {}
    assert tad._backfill_done == set()
    assert tad._backfill_queue == []


def test_get_day_refresh_rebuilds_instead_of_serving_the_stored_doc(monkeypatch):
    """A queued backfill day must actually be rebuilt, not re-served."""
    stored = {"date": DATE, "status": "STALE"}
    rebuilt = {"date": DATE, "status": "PARTIAL"}

    class _Coll:
        async def find_one(self, *_args, **_kwargs):
            return stored

    class _DB:
        def __getitem__(self, _name):
            return _Coll()

    async def _ensure_indexes():
        return None

    async def _build_day(date_str, *, persist=True):
        return rebuilt

    monkeypatch.setattr(tad, "is_mongo_connected", lambda: True)
    monkeypatch.setattr(tad, "ensure_indexes", _ensure_indexes)
    monkeypatch.setattr(tad, "get_db", lambda: _DB())
    monkeypatch.setattr(tad, "build_day", _build_day)
    tad.reset_state()

    try:
        assert asyncio.run(tad.get_day(DATE)) is stored, (
            "a normal read of a past day should reuse the stored document"
        )
        tad._day_cache.clear()
        assert asyncio.run(tad.get_day(DATE, refresh=True)) is rebuilt, (
            "refresh=True must rebuild, otherwise a queued backfill day would "
            "silently re-serve the stale document it was queued to rebuild"
        )
    finally:
        tad.reset_state()


# ------------------------- REST surface ------------------------------------

def test_daily_router_exposes_the_redesigned_surface():
    import api.tick_analytics as router_mod

    paths = {r.path for r in router_mod.router.routes}
    for expected in (
        "/api/data-saver/tick-analytics/summary",
        "/api/data-saver/tick-analytics/daily",
        "/api/data-saver/tick-analytics/daily/{date}",
        "/api/data-saver/tick-analytics/top-symbols",
        "/api/data-saver/tick-analytics/symbol-stats/{symbol}",
        "/api/data-saver/tick-analytics/rate",
        "/api/data-saver/tick-analytics/persistence",
        "/api/data-saver/tick-analytics/sources",
        "/api/data-saver/tick-analytics/storage",
        "/api/data-saver/tick-analytics/quality",
        "/api/data-saver/tick-analytics/latency",
        "/api/data-saver/tick-analytics/report",
        "/api/data-saver/tick-analytics/reports",
        "/api/data-saver/tick-analytics/export",
        # legacy live surface must survive the redesign
        "/api/data-saver/tick-analytics/state",
        "/api/data-saver/tick-analytics/metrics",
        "/api/data-saver/tick-analytics/timeseries",
        "/api/data-saver/tick-analytics/symbol/{symbol}",
        "/api/data-saver/tick-analytics/depth/{symbol}",
        "/api/data-saver/tick-analytics/market-wide",
        "/api/data-saver/tick-analytics/history",
        "/api/data-saver/tick-analytics/anomalies",
    ):
        assert expected in paths, f"missing route {expected}"


def test_csv_export_helpers_escape_and_label_columns():
    rows = [
        {
            "date": DATE, "tradingDay": True, "status": "COMPLETE",
            "counts": {"received": 10, "persisted": 10, "failed": 0,
                       "symbols": 2},
            "ticks": {"avgTickRate": 1.0, "peakTickRate": 9.0,
                      "firstTickAt": "x", "lastTickAt": "y",
                      "activeDurationSec": 10},
            "storage": {"bytes": 99},
            "persistence": {"successPct": 100.0, "skipped": 0},
        },
        {"date": "2026-09-24", "status": "NO_DATA"},   # honest blanks, not zeros
    ]
    csv_text = tad_build_csv(rows)
    lines = [ln for ln in csv_text.splitlines() if ln]
    assert lines[0].startswith("Date,Trading Day,Status")
    assert lines[1].startswith(DATE)
    # the sparse row must be blank-padded, never "0"-padded
    assert lines[2].split(",")[3] == ""


# Local wrapper so the CSV helper can be exercised without importing the
# FastAPI module at collection time.
def tad_build_csv(rows):
    import api.tick_analytics as router_mod
    return router_mod._daily_csv(rows)
