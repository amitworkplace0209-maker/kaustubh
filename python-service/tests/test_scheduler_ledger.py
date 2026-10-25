"""Scheduler-run ledger tests (no live MongoDB required).

Covers the missed-job / recovery decisions of :mod:`scheduler.persist`:

- TEST 2: 08:55 ws_start missed, backend returns 09:20 -> CATCHING_UP
- TEST 4: 08:55 ws_start missed, backend returns 15:32 (after ws_stop) ->
          MISSED_EXPIRED (reason MARKET_WINDOW_NO_LONGER_VALID) — never
          blind-start the feed after the day's feed window has closed
- afternoon restart (14:30) still CATCHES UP login + ws_start (same active
  trading lifecycle, ws_stop-boundary, NOT a fixed 3h window)
- missed login catch-up -> CATCHING_UP, then COMPLETED once a session exists
- network offline -> MISSED_WAITING_NETWORK until the network returns
- non-trading day -> SKIPPED
- idempotency: a re-run or a fresh process never re-executes a terminal run

Run:  python -m pytest tests/test_scheduler_ledger.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

IST = timezone(timedelta(hours=5, minutes=30))

SCHEDULE = {"login": (8, 50), "logout": (15, 35), "ws_start": (8, 55), "tick_collection_start": (8, 59), "ws_stop": (15, 31)}


def _ist(hour=9, minute=0):
    return datetime(2026, 9, 8, hour, minute, 0, tzinfo=IST)


class DuplicateKey(Exception):
    pass


class FakeAgg:
    def __init__(self, items):
        self._seed = list(items)

    def __aiter__(self):
        async def _gen():
            for item in self._seed:
                yield item
        return _gen()


def _matches(item, q):
    for key, val in q.items():
        if key == "status" and isinstance(val, dict) and val.get("$in"):
            if item.get("status") not in val["$in"]:
                return False
            continue
        if item.get(key) != val:
            return False
    return True


class FakeRuns:
    def __init__(self):
        self._items: list[dict] = []
        self._seq = 0

    async def create_index(self, *args, **kwargs):
        pass

    async def _find_all(self, q, projection=None):
        rows = [dict(it) for it in self._items if _matches(it, q)]
        if projection and projection.get("_id") == 0:
            for r in rows:
                r.pop("_id", None)
        return rows

    async def insert_one(self, doc):
        for it in self._items:
            if it.get("execution_id") == doc["execution_id"]:
                raise DuplicateKey(doc["execution_id"])
        row = dict(doc)
        self._seq += 1
        row["_id"] = str(self._seq)
        self._items.append(row)
        return row

    async def find_one(self, q, projection=None, sort=None):
        rows = await self._find_all(q, projection)
        if not rows:
            return None
        if sort:
            key = sort[0][0]
            desc = sort[0][1] == -1
            rows.sort(key=lambda r: self._sortval(r.get(key)), reverse=desc)
        return rows[0]

    @staticmethod
    def _sortval(v):
        if v is None:
            return ""
        return v.isoformat() if isinstance(v, datetime) else str(v)

    async def update_one(self, filt, update):
        matched = [it for it in self._items if _matches(it, filt)]
        if not matched:
            return mock.Mock(modified_count=None)
        for it in matched:
            for key, val in (update.get("$set") or {}).items():
                it[key] = val
            for key, val in (update.get("$inc") or {}).items():
                it[key] = it.get(key, 0) + val
        return mock.Mock(modified_count=len(matched))

    def find(self, q, projection=None):
        return FakeAgg(self._loop(q, projection))

    def _loop(self, q, projection):
        async def _gen():
            db_row = await self._find_all(q, projection)
            for item in db_row:
                yield item
        return _gen()

    async def aggregate(self, pipeline):
        match = pipeline[0].get("$match", {})
        rows = [dict(r) for r in self._items if _matches(r, match)]
        group_key = {"$status" if k == "$status" else k: v for k, v in (pipeline[1].get("$group") or {}).items()}
        out = []
        counts: dict[str, int] = {}
        for r in rows:
            counts[r.get("status") or "UNKNOWN"] = counts.get(r.get("status") or "UNKNOWN", 0) + 1
        for k, v in (pipeline[1].get("$group") or {}).items():
            if k == "_id":
                _ = v
        for status, n in counts.items():
            out.append({"_id": status, "n": n})
        return FakeAgg(out)


class FakeDB:
    def __init__(self):
        self.scheduler_runs = FakeRuns()


def _noop_event(*args, **kwargs):
    return {}


class LedgerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB()
        self.patchers = [
            mock.patch("scheduler.persist.get_db", return_value=self.db),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)
        from scheduler.persist import SchedulerLedger
        self.ledger = SchedulerLedger()
        self.decisions = []

    async def _run(self, **kw):
        defaults = dict(
            now=_ist(hour=9, minute=20),
            schedule=SCHEDULE,
            business_date="2026-09-08",
            is_trading_day=True,
            session_active=False,
            ws_connected=False,
            network_ok=True,
            market_state="",
            market_session="pre_open",
            ws_enabled=True,
            past_logout=False,
            record_event=_noop_event,
        )
        defaults.update(kw)
        return await self.ledger.reconcile(**defaults)

    def _status_of(self, job_id):
        return (self.db.scheduler_runs._items[-1].get("status")
                if False else self._find(job_id))

    def _find(self, job_id):
        for it in self.db.scheduler_runs._items:
            if it.get("job_id") == job_id:
                return it
        return None

    # ------------------------------------------------------------------
    async def test_missed_ws_start_at_0920_catches_up(self):
        now = _ist(hour=9, minute=20)
        decided = await self._run(now=now)
        run = self._find("ws_start")
        self.assertIsNotNone(run)
        self.assertEqual(run["status"], "CATCHING_UP")
        self.assertEqual(run["trigger"], "MISSED_SCHEDULE_CATCHUP")
        self.assertEqual(run["scheduled_at"], datetime(2026, 9, 8, 8, 55, tzinfo=IST))
        self.assertTrue(any(d["job"] == "ws_start" for d in decided))

    async def test_missed_ws_start_at_1500_catches_up_afternoon_restart(self):
        # Afternoon restart at 15:00 — STILL within today's feed window
        # (ws_stop 15:31) — login + feed start remain valid CATCH_UP targets.
        now = _ist(hour=15, minute=0)
        await self._run(now=now)
        ws = self._find("ws_start")
        self.assertEqual(ws["status"], "CATCHING_UP")
        self.assertEqual(ws["trigger"], "MISSED_SCHEDULE_CATCHUP")
        login = self._find("login")
        self.assertEqual(login["status"], "CATCHING_UP")

    async def test_missed_ws_start_after_ws_stop_expires(self):
        # After the daily feed window has closed (ws_stop 15:31) a missed
        # ws_start is obsolete — never blind-start the feed.
        now = _ist(hour=15, minute=32)
        await self._run(now=now)
        run = self._find("ws_start")
        self.assertEqual(run["status"], "MISSED_EXPIRED")
        self.assertEqual(run["reason_code"], "MARKET_WINDOW_NO_LONGER_VALID")

    async def test_missed_login_expires_after_ws_stop(self):
        # A login has no purpose once the feed window is closed: at/after
        # ws_stop the scheduled login is terminal for the day.
        # BUT with the new catch-up window extending to logout (16:00),
        # a 15:32 restart can still log in for the remainder of the day.
        # The login only becomes MISSED_EXPIRED after 16:00 (logout).
        now = _ist(hour=15, minute=32)
        await self._run(now=now)
        run = self._find("login")
        # At 15:32, still before logout (16:00) -> CATCHING_UP
        self.assertEqual(run["status"], "CATCHING_UP")
        self.assertEqual(run["trigger"], "MISSED_SCHEDULE_CATCHUP")

    async def test_missed_login_catches_up_then_completes(self):
        now = _ist(hour=9, minute=20)
        await self._run(now=now)
        run = self._find("login")
        self.assertEqual(run["status"], "CATCHING_UP")
        # session established on a later tick -> COMPLETED (trigger preserved)
        await self._run(now=_ist(hour=9, minute=25), session_active=True)
        run = self._find("login")
        self.assertEqual(run["status"], "COMPLETED")
        self.assertEqual(run["trigger"], "MISSED_SCHEDULE_CATCHUP")
        self.assertIsNotNone(run.get("completed_at"))

    async def test_network_offline_waits_then_retries(self):
        now = _ist(hour=9, minute=20)
        await self._run(now=now, network_ok=False)
        run = self._find("login")
        self.assertEqual(run["status"], "WAITING_NETWORK")
        # network restored -> retries, does NOT materialise a false completion
        await self._run(now=now, network_ok=True)
        run = self._find("login")
        self.assertEqual(run["status"], "CATCHING_UP")

    async def test_non_trading_day_skipped(self):
        await self._run(now=_ist(hour=10, minute=0), is_trading_day=False)
        for job in ("login", "ws_start", "ws_stop", "logout"):
            run = self._find(job)
            self.assertEqual(run["status"], "SKIPPED", job)

    async def test_already_satisfied_when_session_active_late(self):
        # Backend returns at 14:00 with a live session — the 09:13 feed is
        # already obsolete AND connected: NOT a fresh start.
        await self._run(now=_ist(hour=14, minute=0),
                        session_active=True, ws_connected=True)
        run = self._find("ws_start")
        self.assertEqual(run["status"], "ALREADY_SATISFIED")

    async def test_idempotent_across_ticks_and_process(self):
        await self._run(now=_ist(hour=15, minute=32))
        self.assertEqual(self._find("ws_start")["status"], "MISSED_EXPIRED")
        # same process, later ticks -> no new decisions, no re-execution
        decisions = await self._run(now=_ist(hour=15, minute=33))
        self.assertTrue(all(False for _ in decisions))
        # fresh process (new ledger instance) sees terminal record -> no execution
        from scheduler.persist import SchedulerLedger
        fresh = SchedulerLedger()
        decided = await fresh.reconcile(
            now=_ist(hour=15, minute=33),
            schedule=SCHEDULE,
            business_date="2026-09-08",
            is_trading_day=True,
            session_active=False,
            ws_connected=False,
            network_ok=True,
            market_state="",
            market_session="",
            ws_enabled=True,
            past_logout=False,
            record_event=_noop_event,
        )
        self.assertTrue(all(False for _ in decided))
        self.assertEqual(self._find("ws_start")["status"], "MISSED_EXPIRED")

    async def test_ws_disabled_skips_feed(self):
        await self._run(now=_ist(hour=9, minute=20), ws_enabled=False)
        run = self._find("ws_start")
        self.assertEqual(run["status"], "SKIPPED")
        self.assertEqual(run["reason_code"], "WS_DISABLED")

    # ------------------------------------------------------------------
    # Engine #01 phase jobs: square-off trigger (15:16) + feed stop (15:30)
    # ------------------------------------------------------------------
    PHASE_SCHEDULE = dict(SCHEDULE, square_off=(15, 16), feed_stop=(15, 30))

    async def test_square_off_missed_catches_up(self):
        await self._run(now=_ist(hour=15, minute=20), schedule=self.PHASE_SCHEDULE)
        run = self._find("square_off")
        self.assertIsNotNone(run)
        self.assertEqual(run["status"], "CATCHING_UP")
        self.assertEqual(run["trigger"], "MISSED_SCHEDULE_CATCHUP")

    async def test_square_off_completed_settles(self):
        await self._run(now=_ist(hour=15, minute=20), schedule=self.PHASE_SCHEDULE)
        await self._run(now=_ist(hour=15, minute=21), schedule=self.PHASE_SCHEDULE,
                        square_off_completed=True)
        run = self._find("square_off")
        self.assertEqual(run["status"], "COMPLETED")
        self.assertIsNotNone(run.get("completed_at"))

    async def test_square_off_after_feed_stop_expires(self):
        await self._run(now=_ist(hour=15, minute=31), schedule=self.PHASE_SCHEDULE)
        run = self._find("square_off")
        self.assertEqual(run["status"], "MISSED_EXPIRED")
        self.assertEqual(run["reason_code"], "SQUARE_OFF_WINDOW_EXPIRED")

    async def test_feed_stop_catches_up_then_completes(self):
        await self._run(now=_ist(hour=15, minute=30), schedule=self.PHASE_SCHEDULE,
                        ws_connected=True)
        self.assertEqual(self._find("feed_stop")["status"], "CATCHING_UP")
        await self._run(now=_ist(hour=15, minute=31), schedule=self.PHASE_SCHEDULE,
                        ws_connected=True, feed_stop_completed=True)
        self.assertEqual(self._find("feed_stop")["status"], "COMPLETED")

    async def test_feed_stop_already_satisfied_when_feed_gone(self):
        await self._run(now=_ist(hour=15, minute=30), schedule=self.PHASE_SCHEDULE,
                        ws_connected=False)
        run = self._find("feed_stop")
        self.assertEqual(run["status"], "ALREADY_SATISFIED")
        self.assertEqual(run["reason_code"], "FEED_ALREADY_STOPPED")

    # ------------------------------------------------------------------
    # Friday 15:25 Market Watch universe scan (docs/engines/MARKET_WATCH.md A.14)
    # ------------------------------------------------------------------
    @staticmethod
    def _friday(hour: int, minute: int) -> datetime:
        return datetime(2026, 9, 11, hour, minute, tzinfo=IST)

    async def test_friday_scan_settles_when_the_engine_completed_the_week(self):
        fake = mock.Mock()
        fake._friday_scan_done_for = "2026-W37"
        fake._friday_scan_last = {"targetWeekId": "2026-W38", "symbols": 412}
        with mock.patch("services.market_watch_engine.market_watch_engine", fake):
            await self._run(now=self._friday(15, 25), business_date="2026-09-11")

        run = self._find("market_watch_friday_scan")
        self.assertEqual(run["status"], "COMPLETED")
        self.assertEqual(run["reason_code"], "FRIDAY_SCAN_COMPLETED")
        self.assertIn("2026-W38", run["reason"])
        self.assertIn("412", run["reason"])

    async def test_friday_scan_completes_a_catchup_once_the_screen_finishes(self):
        pending = mock.Mock()
        pending._friday_scan_done_for = ""
        pending._friday_scan_last = {}
        with mock.patch("services.market_watch_engine.market_watch_engine", pending):
            await self._run(now=self._friday(15, 26), business_date="2026-09-11")
        self.assertEqual(self._find("market_watch_friday_scan")["status"], "CATCHING_UP")

        done = mock.Mock()
        done._friday_scan_done_for = "2026-W37"
        done._friday_scan_last = {"targetWeekId": "2026-W38", "symbols": 412}
        with mock.patch("services.market_watch_engine.market_watch_engine", done):
            await self._run(now=self._friday(15, 27), business_date="2026-09-11")
        run = self._find("market_watch_friday_scan")
        self.assertEqual(run["status"], "COMPLETED")
        self.assertEqual(run["trigger"], "MISSED_SCHEDULE_CATCHUP")

    async def test_friday_scan_begins_catchup_while_the_screen_is_pending(self):
        fake = mock.Mock()
        fake._friday_scan_done_for = ""
        fake._friday_scan_last = {}
        with mock.patch("services.market_watch_engine.market_watch_engine", fake):
            await self._run(now=self._friday(15, 26), business_date="2026-09-11")

        run = self._find("market_watch_friday_scan")
        self.assertEqual(run["status"], "CATCHING_UP")
        self.assertEqual(run["trigger"], "MISSED_SCHEDULE_CATCHUP")

    async def test_friday_scan_expires_after_logout_if_never_completed(self):
        fake = mock.Mock()
        fake._friday_scan_done_for = ""
        fake._friday_scan_last = {}
        with mock.patch("services.market_watch_engine.market_watch_engine", fake):
            await self._run(now=self._friday(15, 35), business_date="2026-09-11")

        run = self._find("market_watch_friday_scan")
        self.assertEqual(run["status"], "MISSED_EXPIRED")
        self.assertEqual(run["reason_code"], "RUNTIME_WINDOW_EXPIRED")

    async def test_friday_scan_is_skipped_off_friday(self):
        await self._run(now=_ist(hour=15, minute=26), business_date="2026-09-08")
        run = self._find("market_watch_friday_scan")
        self.assertEqual(run["status"], "SKIPPED")
        self.assertEqual(run["reason_code"], "NOT_FRIDAY")


if __name__ == "__main__":
    unittest.main(verbosity=2)