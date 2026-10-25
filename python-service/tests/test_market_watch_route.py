"""Route test for /api/market-watch — a READ of the canonical engine.

docs/engines/MARKET_WATCH.md §16. The endpoint must be a view over
``services.market_watch_engine``'s published state, so these tests drive the
engine with real validated ticks and then assert the HTTP surface.

The architectural guarantee under test:
  * the route NEVER calls the broker (a broker quote attempt fails the test);
  * the route never re-decides eligibility (circuit/margin/business stay with
    the engine and are only REPORTED under ``engineOwnedFilters``);
  * ``force`` is an explicit, documented no-op;
  * with no engine data the route says so instead of inventing rows.
"""

from __future__ import annotations

import asyncio
import unittest
from unittest import mock

from api.market_watch import (
    _rank_rows,
    market_watch,
    market_watch_friday_scan,
    market_watch_progress,
    market_watch_tick_snapshot,
    market_watch_weekly,
)
from services import market_calendar, tick_buffer
from services.instrument_cache import instrument_cache
from services.market_watch_engine import market_watch_engine as engine
from auth.kotak_client import kotak_session

# (token, symbol, previous close, ltp, upper circuit, lower circuit)
INSTRUMENTS = [
    ("1", "GAIN_STOCK", 100.0, 112.0, 130.0, 90.0),
    ("2", "LOSS_STOCK", 100.0, 96.0, 115.0, 85.0),
    ("3", "QUIET_STOCK", 100.0, 100.0, 120.0, 80.0),
]

_NO_BROKER = (
    "the Market Watch route must read the engine, never call the broker"
)


def _registry_rows() -> dict:
    return {
        tok: {
            "token": tok, "symbol": sym, "name": f"{sym} Ltd", "exchange": "nse_cm",
            "segment": "EQUITY", "intradayEligible": True, "exchangeSegment": "nse_cm",
        }
        for tok, sym, *_ in INSTRUMENTS
    }


def _tick(token: str, ltp: float, prev: float, upper: float, lower: float) -> dict:
    return {
        "instrumentToken": token,
        "symbol": next(s for t, s, *_ in INSTRUMENTS if t == token),
        "ltp": ltp,
        "prevClose": prev,
        "volume": 100000.0,
        "open": prev,
        "high": max(prev, ltp),
        "low": min(prev, ltp),
        "upperCircuit": upper,
        "lowerCircuit": lower,
        "exchange": "nse_cm",
    }


class MarketWatchRouteTest(unittest.TestCase):

    def setUp(self):
        self._patchers = [
            mock.patch.object(market_calendar, "snapshot",
                              return_value={"market_status": "OPEN", "market_session": "MOR",
                                            "market_date": "2026-09-26", "day_class": "regular",
                                            "tradeDay": True, "closure_reason": None}),
            # The core guarantee: any broker call from the route fails the test.
            mock.patch.object(kotak_session, "async_quote",
                              side_effect=AssertionError(_NO_BROKER), autospec=False),
        ]
        for p in self._patchers:
            p.start()
            self.addCleanup(p.stop)

        # Isolate the shared engine singleton; restore it exactly afterwards.
        saved = {attr: getattr(engine, attr) for attr in (
            "_registry", "_states", "_records", "_tick_cache", "_eligible_tokens",
            "_subscribed_tokens", "_trading_date", "_index_version", "_feed_state",
            "_universe",
        )}
        self.addCleanup(self._restore_engine, saved)

        engine._registry = _registry_rows()
        engine._states = {}
        engine._records = {}
        engine._tick_cache = {}
        # doc §3/§7/§35.2 — membership decides which ticks may enter calculation
        # state, so the engine's universe is declared alongside its registry.
        engine._universe = {t for t, *_ in INSTRUMENTS}
        engine._eligible_tokens = {t for t, *_ in INSTRUMENTS}
        engine._subscribed_tokens = set()
        engine._trading_date = "2026-09-26"
        engine._index_version = 0
        engine._seed_states()
        for token, sym, prev, ltp, upper, lower in INSTRUMENTS:
            engine._process_tick(token, _tick(token, ltp, prev, upper, lower))

        # The canonical instrument master: the one source instrument identity
        # comes from (used by tick-snapshot to mark unknown tokens).
        with instrument_cache._lock:
            saved_master = (
                instrument_cache._instruments, instrument_cache._loaded,
                instrument_cache._source,
            )
            instrument_cache._instruments = [
                {
                    "symbol": sym, "token": tok, "tradingSymbol": sym,
                    "companyName": f"{sym} Ltd", "exchange": "nse_cm",
                    "exchangeSegment": "nse_cm", "series": "EQ",
                    "instrumentType": "EQ", "tradingStatus": None,
                }
                for tok, sym, *_ in INSTRUMENTS
            ]
            instrument_cache._loaded = True
            instrument_cache._source = "memory-test"
        self.addCleanup(self._restore_master, saved_master)

    @staticmethod
    def _restore_master(saved: tuple) -> None:
        with instrument_cache._lock:
            (instrument_cache._instruments, instrument_cache._loaded,
             instrument_cache._source) = saved

    @staticmethod
    def _restore_engine(saved: dict) -> None:
        for attr, value in saved.items():
            setattr(engine, attr, value)

    def _call(self, **overrides):
        async def run():
            kwargs = {
                "force": False, "direction": "all",
                "rupee_min": None, "rupee_max": None, "pct_min": None, "pct_max": None,
                "window": "5m", "mom_min": None, "mom_max": None, "q": "",
                "sort_by": "pct", "sort_dir": "desc", "result_limit": 80,
                "min_price": None, "max_price": None,
                "circuit_safety": True, "circuit_buffer": 2.0,
                "min_volume": None, "min_turnover": None,
                "max_change_pct": None,
            }
            kwargs.update(overrides)
            return await market_watch(**kwargs)

        return asyncio.run(run())

    # ------------------------------------------------------------------ #

    def test_rows_come_from_the_engine(self):
        resp = self._call()
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["quoteSource"], "market_watch_engine")
        self.assertEqual(resp["universe"]["source"], "market_watch_engine")

        gained = {r["symbol"] for r in resp["gainers"]}
        lost = {r["symbol"] for r in resp["losers"]}
        self.assertEqual(gained, {"GAIN_STOCK"})
        self.assertEqual(lost, {"LOSS_STOCK"})
        self.assertEqual(resp["counts"]["advancing"], 1)
        self.assertEqual(resp["counts"]["declining"], 1)
        self.assertEqual(resp["universe"]["total"], 3)

    def test_the_route_makes_no_broker_call(self):
        # setUp patches async_quote to raise; a clean return IS the assertion.
        resp = self._call(force=True)
        self.assertTrue(resp["ok"])

    def test_force_is_reported_as_a_no_op(self):
        resp = self._call(force=True)
        self.assertIn("force", resp["reason"])
        self.assertIn("no effect", resp["reason"])

    def test_eligibility_parameters_are_reported_not_applied(self):
        """A per-request circuit rule must never look like it took effect."""
        resp = self._call(circuit_safety=True, circuit_buffer=9.0, max_change_pct=18)
        owned = resp["diagnostics"]["engineOwnedFilters"]
        self.assertTrue(owned["circuitBuffer"]["overridden"])
        self.assertEqual(owned["circuitBuffer"]["value"], 9.0)
        self.assertTrue(owned["maxChangePercent"]["overridden"])
        self.assertFalse(owned["circuitSafety"]["overridden"])
        self.assertIn("not applied", owned["note"])
        # GAIN_STOCK is +12% and still present: the 18% cap did not filter it.
        self.assertIn("GAIN_STOCK", {r["symbol"] for r in resp["gainers"]})

    def test_presentation_filters_still_narrow_the_result(self):
        resp = self._call(pct_min=50.0)
        self.assertEqual(resp["gainers"], [])
        resp = self._call(q="GAIN")
        self.assertEqual({r["symbol"] for r in resp["gainers"]}, {"GAIN_STOCK"})

    def test_an_empty_engine_says_so_instead_of_inventing_rows(self):
        engine._records = {}
        engine._tick_cache = {}
        engine._states = {}
        resp = self._call()
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["gainers"], [])
        self.assertEqual(resp["losers"], [])
        self.assertEqual(resp["scannerState"], "STALE")
        self.assertIn("has not published", resp["reason"])

    def test_progress_reports_engine_state_not_a_batch_cursor(self):
        async def run():
            return await market_watch_progress()

        resp = asyncio.run(run())
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["source"], "market_watch_engine")
        self.assertEqual(resp["universe"]["total"], 3)
        self.assertEqual(resp["universe"]["eligible"], 3)
        self.assertIn("statusCounts", resp)
        for removed in ("currentBatch", "totalBatches", "nextBatchInSec", "batchSize"):
            self.assertNotIn(removed, resp, f"{removed} described a removed batch scanner")

    def test_tick_snapshot_serves_central_store(self):
        """A snapshot must come from the central tick store, not a broker call."""
        from datetime import datetime, timezone

        tick_buffer._latest_ticks["1"] = {
            "ltp": 112.0, "open": 111.0, "high": 113.0, "low": 111.0,
            "close": 110.0, "change": 2.0, "changePercent": 1.82,
            "volume": 100000, "total_traded_value": 5_000_000.0, "oi": 1000,
            "upper_circuit_limit": 130.0, "lower_circuit_limit": 90.0,
            "ts": datetime.now(timezone.utc),
            "receivedAt": datetime.now(timezone.utc),
        }

        async def run():
            return await market_watch_tick_snapshot(tokens="1,2,3,999")

        try:
            resp = asyncio.run(run())
            self.assertTrue(resp["ok"])
            rows = resp["rows"]
            self.assertTrue(rows["1"]["hasData"])
            self.assertEqual(rows["1"]["ltp"], 112.0)
            self.assertEqual(rows["1"]["circuit"]["status"], "SAFE")
            self.assertFalse(rows["2"]["hasData"])
            self.assertTrue(rows["3"]["exists"])
            self.assertFalse(rows["999"]["exists"])
        finally:
            tick_buffer._latest_ticks.pop("1", None)


class RankRowsSortTest(unittest.TestCase):
    """Rows whose sort value is missing must sort LAST in BOTH directions."""

    def _rows(self):
        return [
            {"symbol": "PEND1", "token": "1", "changePercent": None, "volume": None},
            {"symbol": "GAIN", "token": "2", "changePercent": 4.5, "volume": 500},
            {"symbol": "LOSS", "token": "3", "changePercent": -2.0, "volume": 900},
            {"symbol": "PEND2", "token": "4", "changePercent": None, "volume": None},
            {"symbol": "MID", "token": "5", "changePercent": 0.0, "volume": 800},
        ]

    def test_missing_change_percent_sorts_last_desc(self):
        rows = _rank_rows(self._rows(), "changePercent", "desc")
        self.assertEqual([r["symbol"] for r in rows][:3], ["GAIN", "MID", "LOSS"])
        self.assertEqual([r["symbol"] for r in rows][-2:], ["PEND1", "PEND2"])

    def test_missing_change_percent_sorts_last_asc(self):
        rows = _rank_rows(self._rows(), "changePercent", "asc")
        self.assertEqual([r["symbol"] for r in rows][:3], ["LOSS", "MID", "GAIN"])
        self.assertEqual([r["symbol"] for r in rows][-2:], ["PEND1", "PEND2"])

    def test_default_dir_is_desc(self):
        rows = _rank_rows(self._rows(), "volume", "desc")
        self.assertEqual([r["symbol"] for r in rows][:3], ["LOSS", "MID", "GAIN"])
        self.assertEqual([r["symbol"] for r in rows][-2:], ["PEND1", "PEND2"])

    def test_missing_symbol_is_not_special(self):
        rows = _rank_rows(self._rows(), "symbol", "asc")
        self.assertEqual([r["symbol"] for r in rows][:3], ["GAIN", "LOSS", "MID"])
        self.assertEqual([r["symbol"] for r in rows][-2:], ["PEND1", "PEND2"])


class DecisionHistoryTest(unittest.TestCase):
    """`/history` is the real ``market_watch_decisions`` ledger (doc A16).

    The engine has no per-request scan, so there is no scan-run journal left to
    read: history is the persisted ledger of eligibility decisions. The field
    names must match what ``BlockEntry.to_doc`` actually writes, and the sort
    key must be the field the ledger writes.
    """

    class _Cursor:
        def __init__(self, rows, sink):
            self._rows = rows
            self._sink = sink

        def sort(self, field, direction):
            self._sink["sort"] = (field, direction)
            return self

        def limit(self, n):
            self._sink["limit"] = n
            return self

        async def to_list(self, length=None):
            return list(self._rows)

    class _Collection:
        def __init__(self, rows, sink):
            self._rows = rows
            self._sink = sink

        def find(self, query):
            self._sink["query"] = query
            return DecisionHistoryTest._Cursor(self._rows, self._sink)

    @classmethod
    def setUpClass(cls):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from api.market_watch import router

        app = FastAPI()
        app.include_router(router)
        cls.client = TestClient(app, raise_server_exceptions=False)

    def _rows(self):
        from datetime import datetime, timezone
        from services.market_watch_ledger import BlockEntry, STATUS_BLOCKED, STATUS_ACTIVE

        blocked = BlockEntry(
            symbol="HOT", instrument_token="1", date="2026-09-25",
            status=STATUS_BLOCKED, reason="CIRCUIT", threshold=5.0,
            observed_value=6.2, blocked_at=datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc).timestamp(),
            detail="upper circuit", circuit_block_pct=5.0,
        )
        cleared = BlockEntry(
            symbol="COOL", instrument_token="2", date="2026-09-25",
            status=STATUS_ACTIVE, reason=None, blocked_at=datetime(2026, 9, 25, 9, 30, tzinfo=timezone.utc).timestamp(),
            reentered_at=datetime(2026, 9, 25, 11, 0, tzinfo=timezone.utc).timestamp(),
        )
        return [blocked.to_dict(), cleared.to_dict()]

    def _get(self, db_error: bool = False, **params):
        """Call the real HTTP route with ``get_db`` faked, capturing the query."""
        sink: dict = {}
        rows = self._rows()

        fake_db = mock.MagicMock()
        fake_db.market_watch_decisions = self._Collection(rows, sink)
        target = (
            mock.patch("api.market_watch.get_db", side_effect=RuntimeError("no mongo"))
            if db_error
            else mock.patch("api.market_watch.get_db", return_value=fake_db)
        )
        with target:
            resp = self.client.get("/api/market-watch/history", params={"limit": 10, **params})
        return resp, sink

    def test_it_reads_the_decision_ledger_sorted_by_the_field_the_ledger_writes(self):
        resp, sink = self._get()
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["source"], "market_watch_decisions")
        self.assertEqual(sink["sort"], ("blocked_at", -1))
        self.assertEqual(sink["limit"], 10)
        self.assertEqual(len(body["decisions"]), 2)
        # The retained alias keeps existing consumers working.
        self.assertEqual(body["scans"], body["decisions"])

    def test_rows_expose_the_ledger_field_names(self):
        body = self._get()[0].json()
        row = next(r for r in body["decisions"] if r["symbol"] == "HOT")
        self.assertEqual(row["instrumentToken"], "1")
        self.assertEqual(row["date"], "2026-09-25")
        self.assertEqual(row["status"], "BLOCKED")
        self.assertEqual(row["reason"], "CIRCUIT")
        self.assertAlmostEqual(row["threshold"], 5.0)
        self.assertAlmostEqual(row["observed_value"], 6.2)
        self.assertAlmostEqual(row["circuitBlockPct"], 5.0)
        self.assertEqual(row["detail"], "upper circuit")
        self.assertIsNotNone(row["blockedAt"])
        self.assertNotIn("blocked_at", row)
        self.assertNotIn("_id", row)

    def test_a_reentry_is_reported_with_its_timestamp(self):
        body = self._get()[0].json()
        cleared = next(r for r in body["decisions"] if r["symbol"] == "COOL")
        self.assertIsNotNone(cleared["reentered_at"])

    def test_symbol_filter_narrows_the_same_real_collection(self):
        _, sink = self._get(symbol="hot")
        self.assertEqual(
            sink["query"],
            {"$or": [{"symbol": "HOT"}, {"instrumentToken": "hot"}]},
        )

    def test_date_filter_narrows_the_same_real_collection(self):
        _, sink = self._get(date="2026-09-25")
        self.assertEqual(sink["query"], {"date": "2026-09-25"})

    def test_symbol_and_date_filters_compose(self):
        _, sink = self._get(symbol="hot", date="2026-09-25")
        self.assertEqual(
            sink["query"],
            {
                "$or": [{"symbol": "HOT"}, {"instrumentToken": "hot"}],
                "date": "2026-09-25",
            },
        )

    def test_an_unavailable_database_degrades_to_an_empty_real_answer(self):
        body = self._get(db_error=True)[0].json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["decisions"], [])

    def test_the_route_never_asks_the_broker_for_history(self):
        """History is a ledger read; a broker quote attempt must fail the test."""
        with mock.patch.object(
            kotak_session, "async_quote", side_effect=AssertionError(_NO_BROKER), autospec=False
        ):
            body = self._get()[0].json()
        self.assertEqual(len(body["decisions"]), 2)


class TickSavingRouteTest(unittest.TestCase):
    """``/tick-saving`` is the operator on/off control for Market Watch
    persistence (doc §23).

    The write must go through ``services.settings_service`` — the one owner of
    ``app_settings`` — and the buffer gates must be reconciled immediately, so
    the switch does not wait for the next status tick. Like every other Market
    Watch route it must not scan, re-decide eligibility or call the broker.
    """

    @classmethod
    def setUpClass(cls):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from api.market_watch import router

        app = FastAPI()
        app.include_router(router)
        cls.client = TestClient(app, raise_server_exceptions=False)

    def setUp(self):
        from services import market_watch_doc_buffer as buf

        buf.reset()
        self.addCleanup(buf.reset)

    def _get(self):
        return self.client.get("/api/market-watch/tick-saving")

    def _post(self, payload):
        return self.client.post("/api/market-watch/tick-saving", json=payload)

    def test_get_reports_the_real_switch_state(self):
        body = self._get().json()
        self.assertTrue(body["ok"])
        for field in ("persistTicks", "persistCandles", "persistDecisions"):
            self.assertIsInstance(body[field], bool)
        self.assertIn("gates", body)
        self.assertIn("ticksSaved", body)
        self.assertIn("ticksSuppressed", body)

    def test_post_writes_through_the_settings_service_and_reconciles_the_gate(self):
        from services import market_watch_doc_buffer as buf

        written: dict = {}

        async def _fake_set_setting(key, value):
            written[key] = value
            return {"ok": True}

        with mock.patch("services.settings_service.set_setting", side_effect=_fake_set_setting):
            resp = self._post({"persistTicks": False})

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        # Exactly one settings key, the documented one.
        self.assertEqual(written, {"mwr_persist_ticks": False})
        self.assertIn("market_ticks", body["changed"])
        self.assertFalse(buf.enabled("market_ticks"), "the gate must flip immediately")
        self.assertTrue(buf.enabled("market_candles_1m"), "untouched switches stay as they were")

    def test_accepts_a_bare_boolean_and_string_forms(self):
        from services import market_watch_doc_buffer as buf

        written: dict = {}

        async def _fake_set_setting(key, value):
            written[key] = value
            return {"ok": True}

        with mock.patch("services.settings_service.set_setting", side_effect=_fake_set_setting):
            body = self._post(False).json()
        self.assertEqual(written, {"mwr_persist_ticks": False})
        self.assertFalse(buf.enabled("market_ticks"))

        written.clear()
        with mock.patch("services.settings_service.set_setting", side_effect=_fake_set_setting):
            body = self._post({"ticks": "on"}).json()
        self.assertEqual(written, {"mwr_persist_ticks": True})
        self.assertTrue(buf.enabled("market_ticks"))
        self.assertTrue(body["ok"])

    def test_disabling_reports_the_dropped_backlog(self):
        from services import market_watch_doc_buffer as buf

        buf.add("market_ticks", [{"_id": f"AAA:{i}"} for i in range(3)])

        async def _fake_set_setting(key, value):
            return {"ok": True}

        with mock.patch("services.settings_service.set_setting", side_effect=_fake_set_setting):
            body = self._post({"persistTicks": False}).json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["droppedOnDisable"], 3)
        self.assertEqual(buf.pending("market_ticks"), 0)

    def test_an_unknown_switch_is_rejected_without_writing(self):
        from services import market_watch_doc_buffer as buf

        calls: list = []

        async def _fake_set_setting(key, value):
            calls.append(key)
            return {"ok": True}

        with mock.patch("services.settings_service.set_setting", side_effect=_fake_set_setting):
            resp = self._post({"not_a_switch": True})

        body = resp.json()
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(body["ok"])
        self.assertEqual(calls, [])
        self.assertIn("persistTicks", body["accepted"])
        self.assertTrue(buf.enabled("market_ticks"), "a rejected payload changes nothing")

    def test_a_failed_settings_backend_is_reported_not_faked(self):
        from services import market_watch_doc_buffer as buf

        async def _boom(key, value):
            raise RuntimeError("no database")

        with mock.patch("services.settings_service.set_setting", side_effect=_boom):
            body = self._post({"persistTicks": False}).json()

        self.assertFalse(body["ok"])
        self.assertIn("unavailable", body["error"])
        self.assertTrue(buf.enabled("market_ticks"), "a failed write must not flip the gate")

    def test_the_route_never_calls_the_broker(self):
        with mock.patch.object(
            kotak_session, "async_quote", side_effect=AssertionError(_NO_BROKER), autospec=False
        ):
            self.assertTrue(self._get().json()["ok"])

            async def _fake_set_setting(key, value):
                return {"ok": True}

            with mock.patch("services.settings_service.set_setting", side_effect=_fake_set_setting):
                self.assertTrue(self._post({"persistTicks": True}).json()["ok"])


class FridayScanRouteTest(unittest.IsolatedAsyncioTestCase):
    """The Friday scan is an engine command, never route-level arithmetic."""

    async def test_manual_endpoint_delegates_with_the_requested_target(self):
        payload = {
            "ok": True, "triggered": True, "targetWeekId": "2026-W44",
            "symbolCount": 2,
        }
        with mock.patch.object(
            engine, "run_friday_scan", new=mock.AsyncMock(return_value=payload)
        ) as run:
            body = await market_watch_friday_scan({"targetWeekId": "2026-W44"})

        self.assertTrue(body["ok"])
        run.assert_awaited_once_with(
            triggered_by="manual", target_week_id="2026-W44",
        )

    async def test_manual_endpoint_defaults_to_the_engine_target(self):
        with mock.patch.object(
            engine, "run_friday_scan",
            new=mock.AsyncMock(return_value={"ok": True, "symbolCount": 0}),
        ) as run:
            await market_watch_friday_scan(None)

        run.assert_awaited_once_with(triggered_by="manual", target_week_id=None)

    async def test_manual_endpoint_reports_a_failure_instead_of_raising(self):
        with mock.patch.object(
            engine, "run_friday_scan",
            new=mock.AsyncMock(side_effect=RuntimeError("broker unavailable")),
        ):
            body = await market_watch_friday_scan(None)

        self.assertFalse(body["ok"])
        self.assertFalse(body["triggered"])
        self.assertIn("broker unavailable", body["reason"])

    async def test_weekly_payload_carries_the_backend_scan_status(self):
        status = {
            "enabled": True, "scanHhmm": "15:25", "scanWeekday": 4,
            "nextScanAt": "2026-10-23T15:25:00+05:30",
            "nextTargetWeekId": "2026-W44",
            "running": False, "lastScan": None,
        }
        with mock.patch.object(
            engine, "friday_scan_status", return_value=status
        ), \
             mock.patch(
                 "services.market_watch_universe.load_locked_universe",
                 new=mock.AsyncMock(return_value=None),
             ), \
             mock.patch(
                 "services.market_watch_universe.get_draft",
                 new=mock.AsyncMock(return_value=None),
             ), \
             mock.patch(
                 "services.market_watch_universe.is_locked",
                 new=mock.AsyncMock(return_value=False),
             ), \
             mock.patch(
                 "services.market_watch_universe.decisions_for",
                 new=mock.AsyncMock(return_value={}),
             ), \
             mock.patch(
                 "services.market_watch_universe.history",
                 new=mock.AsyncMock(return_value=[]),
             ), \
             mock.patch(
                 "services.market_watch_universe.verify_week",
                 new=mock.AsyncMock(return_value={"ok": True}),
             ):
            body = await market_watch_weekly("2026-W44")

        self.assertEqual(body["fridayScan"], status)


if __name__ == "__main__":
    unittest.main()
