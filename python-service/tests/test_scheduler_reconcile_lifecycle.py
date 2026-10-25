"""Current-time-aware lifecycle reconciliation tests.

Drives the scheduler's ``_reconcile`` / ``_reconcile_unlocked`` state machine
with the simulated IST clock (``_set_test_clock``) against the master lifecycle
spec: 08:50 login -> 08:55 WebSocket connect -> 15:31 WebSocket disconnect ->
16:00 logout. The key regression being pinned is the AFTERNOON RESTART: a
backend coming up at 11:00 / 14:30 must resume the SAME active trading
lifecycle (login + feed), NOT wait for the next day — while a restart at/after
15:31 (past ws_stop) must never blind-start the feed, and a restart before
08:50 must wait for the login window.

Cases covered:
  * 08:30 restart  -> WAITING_FOR_LOGIN, no login, no feed
  * 08:50 restart  -> login fired, session becomes active
  * 09:00 restart  -> still within windows; falls into tick collection
  * 11:00 restart (no session) -> login catch-up -> same-day session
  * 14:30 restart (no session) -> login catch-up (regression: was blocked)
  * 14:30 restart (live session+feed) -> keeps lifecycle, no teardown
  * 15:30 restart (live session+feed) -> feed stays until ws_stop
  * 15:32 restart (live session+feed) -> feed disconnected, session retained
  * 15:32 restart (no session) -> parked, no login, no feed start
  * 16:01 restart (no session) -> WAITING_FOR_NEXT_TRADING_DAY
  * weekend / holiday -> MARKET_CLOSED, never login
  * WS drop 11:30 (mid-window)   -> reconnect/supervisor start (WS required)
  * WS drop 15:32 (after ws_stop)-> no reconnect, feed parked
  * two sequential reconciles   -> single login, no double execution

Run:  python -m pytest tests/test_scheduler_reconcile_lifecycle.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone, timedelta
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

IST = timezone(timedelta(hours=5, minutes=30))

# A Tuesday (2026-09-08) that is a real NSE trading day (not in KNOWN_HOLIDAYS).
TRADING_DATE = (2026, 9, 8)


def _ist(hour=9, minute=0, day=TRADING_DATE):
    return datetime(day[0], day[1], day[2], hour, minute, 0, tzinfo=IST)


def _noop_event(*args, **kwargs):
    return {}


class FakeKotak:
    def __init__(self):
        self.session_active = False
        self.last_login_at = None
        self.last_logout_at = None

    def mark_session_expired(self, reason=""):
        self.session_active = False


class FakeWs:
    def __init__(self):
        self._connected = False
        self._sup_state = "STOPPED"
        self._subs = 0
        self.start_calls = 0
        self.stop_calls = 0
        self.disconnect_calls = 0

    def is_connected(self):
        return self._connected

    def subscribed_count(self):
        return self._subs

    def get_supervisor_state(self):
        return self._sup_state

    def start_supervisor(self):
        self.start_calls += 1
        self._sup_state = "CONNECTING"

    def stop_supervisor(self):
        self.stop_calls += 1
        self._sup_state = "STOPPED"

    def disconnect(self, why=None):
        self.disconnect_calls += 1
        self._connected = False
        self._subs = 0


class FakeSessionManager:
    def __init__(self):
        self.active = False
        self.state = "DISCONNECTED"
        self.ws_state = "DISCONNECTED"

    def is_active(self):
        return self.active

    def snapshot(self):
        return {
            "state": self.state, "mode": "kotak",
            "ws_state": self.ws_state, "active": self.active,
        }


class FakeLedger:
    def __init__(self, statuses: dict[str, str]):
        self.statuses = statuses
        self.reconcile_calls = 0

    async def reconcile(self, **kwargs):
        self.reconcile_calls += 1
        return []

    async def today_job_statuses(self, business_date):
        return dict(self.statuses)

    async def summary(self, business_date=None):
        return {}


def _make_controller():
    import scheduler  # noqa: PLC0415
    sc = scheduler.SchedulerController()
    sc._running = True
    sc._busy_lock = asyncio.Lock()
    sc._wake_event = asyncio.Event()
    return scheduler, sc


class ReconcileLifecycleTest(unittest.IsolatedAsyncioTestCase):
    def _setup(self, *, session_active=False, ws_connected=False,
               statuses=None, trading_day=True, clock=None):
        scheduler, sc = _make_controller()
        kotak = FakeKotak()
        kotak.session_active = session_active
        ws = FakeWs()
        ws._connected = ws_connected
        if ws_connected:
            ws._subs = 3
            ws._sup_state = "CONNECTED"
        sm = FakeSessionManager()
        sm.active = session_active
        sm.state = ("SESSION_ACTIVE" if session_active else "DISCONNECTED")
        sm.ws_state = ("CONNECTED" if ws_connected else "DISCONNECTED")
        statuses = statuses or {
            "login": "PENDING", "ws_start": "PENDING",
            "tick_collection": "PENDING", "ws_stop": "PENDING", "logout": "PENDING",
        }
        ledger = FakeLedger(statuses)
        market_svc = mock.MagicMock()
        market_svc.get_snapshot.return_value = {"network_ok": True, "market_state": ""}

        if not trading_day:
            td = mock.patch.object(scheduler, "_is_trading_day", return_value=False)
            td.start()
            self.addCleanup(td.stop)

        self.patches = [
            mock.patch.object(scheduler, "kotak_session", kotak),
            mock.patch.object(scheduler, "ws_manager", ws),
            mock.patch.object(scheduler, "session_manager", sm),
            mock.patch.object(scheduler, "scheduler_ledger", ledger),
            mock.patch.object(scheduler, "market_state_service", market_svc),
            mock.patch.object(scheduler, "record_event", _noop_event),
            mock.patch.object(scheduler, "refresh_runtime_settings",
                              new=mock.AsyncMock()),
            mock.patch.object(scheduler, "rt_bool", return_value=True),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

        self.login_calls = {"n": 0}

        async def fake_do_login_impl(source="scheduler", acquire_busy=True):
            self.login_calls["n"] += 1
            kotak.session_active = True
            sm.active = True
            sm.state = "SESSION_ACTIVE"
            return True

        sc._do_login_impl = fake_do_login_impl
        scheduler._set_test_clock(clock if clock is not None
                                  else (lambda: _ist(hour=9, minute=0)))
        return scheduler, sc, kotak, ws, sm, ledger

    def tearDown(self):
        import scheduler
        scheduler._set_test_clock(None)

    # ---- CASE 08:30 — before the login window --------------------------
    async def test_0830_wait_for_login(self):
        import scheduler
        _sched, sc, _k, ws, _sm, _l = self._setup(
            clock=lambda: _ist(hour=8, minute=30))
        await sc._reconcile()
        self.assertEqual(sc._state, scheduler.STATE_WAITING_FOR_LOGIN)
        self.assertEqual(self.login_calls["n"], 0)
        self.assertEqual(ws.start_calls, 0)

    # ---- CASE 08:50 — login window opens -------------------------------
    async def test_0850_login_fires(self):
        import scheduler
        _sched, sc, kotak, ws, _sm, _l = self._setup(
            clock=lambda: _ist(hour=8, minute=50))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 1)
        self.assertTrue(kotak.session_active)
        self.assertEqual(sc._state, scheduler.STATE_SESSION_ACTIVE)
        self.assertEqual(ws.start_calls, 0)

    # ---- CASE 09:00 — session already live, feed live ------------------
    async def test_0900_active_same_day(self):
        import scheduler
        _sched, sc, kotak, ws, _sm, _l = self._setup(
            session_active=True, ws_connected=True,
            clock=lambda: _ist(hour=9, minute=0))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 0)
        self.assertTrue(ws.is_connected())
        self.assertEqual(ws.stop_calls, 0)
        self.assertIn(sc._state,
                      {scheduler.STATE_TICK_COLLECTION,
                       scheduler.STATE_TICK_COLLECTION_RUNNING})

    # ---- CASE 11:00 — restart mid-morning, missed schedules ------------
    async def test_1100_afternoon_still_catches_up_login(self):
        import scheduler
        statuses = {"login": "CATCH_UP", "ws_start": "CATCH_UP",
                    "tick_collection": "PENDING", "ws_stop": "PENDING",
                    "logout": "PENDING"}
        _sched, sc, kotak, ws, _sm, _l = self._setup(
            statuses=statuses, clock=lambda: _ist(hour=11, minute=0))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 1, "login must catch up at 11:00")
        self.assertTrue(kotak.session_active)

    # ---- CASE 14:30 — REGRESSION: afternoon restart must NOT park ------
    async def test_1430_afternoon_restart_logs_in(self):
        import scheduler
        statuses = {"login": "CATCH_UP", "ws_start": "CATCH_UP",
                    "tick_collection": "PENDING", "ws_stop": "PENDING",
                    "logout": "PENDING"}
        _sched, sc, kotak, _ws, _sm, _l = self._setup(
            statuses=statuses, clock=lambda: _ist(hour=14, minute=30))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 1,
                         "14:30 restart must resume the SAME active lifecycle")
        self.assertTrue(kotak.session_active)
        self.assertEqual(sc._state, scheduler.STATE_SESSION_ACTIVE)

    async def test_1430_active_session_and_feed_kept(self):
        import scheduler
        _sched, sc, _k, ws, _sm, _l = self._setup(
            session_active=True, ws_connected=True,
            clock=lambda: _ist(hour=14, minute=30))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 0)
        self.assertTrue(ws.is_connected())
        self.assertEqual(ws.stop_calls, 0)
        self.assertIn(sc._state,
                      {scheduler.STATE_TICK_COLLECTION,
                       scheduler.STATE_TICK_COLLECTION_RUNNING})

    # ---- CASE 15:30 — feed stays right up to ws_stop --------------------
    async def test_1530_session_stays_active(self):
        import scheduler
        _sched, sc, _k, ws, _sm, _l = self._setup(
            session_active=True, ws_connected=True,
            clock=lambda: _ist(hour=15, minute=30))
        await sc._reconcile()
        self.assertTrue(ws.is_connected())
        self.assertEqual(ws.stop_calls, 0)

    # ---- CASE 15:32 — after ws_stop: feed down, session retained -------
    async def test_1532_feed_disconnected_session_retained(self):
        import scheduler
        _sched, sc, _k, ws, _sm, _l = self._setup(
            session_active=True, ws_connected=True,
            clock=lambda: _ist(hour=15, minute=32))
        await sc._reconcile()
        self.assertFalse(ws.is_connected())
        self.assertGreaterEqual(ws.disconnect_calls, 1)
        self.assertEqual(sc._state, scheduler.STATE_SESSION_ACTIVE)

    # ---- CASE 15:32 — no session: parked, no blind login ---------------
    async def test_1532_no_session_parks(self):
        import scheduler
        statuses = {"login": "MISSED_EXPIRED", "ws_start": "MISSED_EXPIRED",
                    "tick_collection": "ALREADY_SATISFIED",
                    "ws_stop": "ALREADY_SATISFIED", "logout": "PENDING"}
        _sched, sc, _k, ws, _sm, _l = self._setup(
            statuses=statuses, clock=lambda: _ist(hour=15, minute=32))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 0, "no blind login after ws_stop")
        self.assertEqual(ws.start_calls, 0, "no blind feed start after ws_stop")
        self.assertEqual(sc._state, scheduler.STATE_MARKET_CLOSED)

    # ---- Manual login mid-day with a skipped ws_start job ----------------
    async def test_manual_session_starts_feed_despite_skipped_ws_start(self):
        import time as _time
        import scheduler
        # Backend down at 08:55 -> the ledger judges ws_start SKIPPED for the
        # whole day. A manual login at 13:05 is an explicit user decision, so
        # the feed MUST still come up inside the ws window.
        statuses = {"login": "SKIPPED", "ws_start": "SKIPPED",
                    "tick_collection": "SKIPPED", "ws_stop": "PENDING",
                    "logout": "PENDING"}
        _sched, sc, _k, ws, _sm, _l = self._setup(
            session_active=True, statuses=statuses,
            clock=lambda: _ist(hour=13, minute=5))
        sc._session_owner = "manual"
        sc._manual_expire_at = _time.time() + 3600.0
        await sc._reconcile()
        self.assertGreaterEqual(ws.start_calls, 1,
                                "manual session must start the feed in-window")
        self.assertNotEqual(sc._state, scheduler.STATE_MARKET_CLOSED)

    # ---- CASE 16:01 — after logout window -------------------------------
    async def test_1601_wait_next_trading_day(self):
        import scheduler
        _sched, sc, _k, ws, _sm, _l = self._setup(
            clock=lambda: _ist(hour=16, minute=1))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 0)
        self.assertEqual(sc._state, scheduler.STATE_WAITING_FOR_NEXT_TRADING_DAY)

    # ---- Weekend / holiday ----------------------------------------------
    async def test_weekend_market_closed(self):
        import scheduler
        # 2026-09-12 is a Saturday.
        _sched, sc, _k, ws, _sm, _l = self._setup(
            trading_day=False, clock=lambda: _ist(hour=10, minute=0, day=(2026, 9, 12)))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 0)
        self.assertEqual(ws.start_calls, 0)
        self.assertEqual(sc._state, scheduler.STATE_MARKET_CLOSED)

    async def test_holiday_market_closed(self):
        import scheduler
        # 2026-10-02 (Friday) is the confirmed Gandhi Jayanti NSE holiday.
        _sched, sc, _k, ws, _sm, _l = self._setup(
            trading_day=False, clock=lambda: _ist(hour=10, minute=0, day=(2026, 10, 2)))
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 0)
        self.assertEqual(sc._state, scheduler.STATE_MARKET_CLOSED)

    # ---- WS drop mid-window: reconnect/start required -------------------
    async def test_ws_drop_1130_reconnect(self):
        import scheduler
        _sched, sc, _k, ws, _sm, _l = self._setup(
            session_active=True, ws_connected=False,
            clock=lambda: _ist(hour=11, minute=30))
        await sc._reconcile()
        self.assertGreaterEqual(ws.start_calls, 1, "feed must be restarted mid-window")
        self.assertEqual(sc._state, scheduler.STATE_WS_CONNECTING)

    # ---- WS drop after ws_stop: never reconnect -------------------------
    async def test_ws_drop_1532_no_reconnect(self):
        import scheduler
        _sched, sc, _k, ws, _sm, _l = self._setup(
            session_active=True, ws_connected=False,
            clock=lambda: _ist(hour=15, minute=32))
        await sc._reconcile()
        self.assertEqual(ws.start_calls, 0, "no feed restart past ws_stop")
        self.assertEqual(sc._state, scheduler.STATE_SESSION_ACTIVE)

    # ---- Concurrency: sequential reconciles never double-login ----------
    async def test_sequential_reconciles_single_login(self):
        import scheduler
        _sched, sc, _k, ws, _sm, _l = self._setup(
            clock=lambda: _ist(hour=9, minute=0))
        await sc._reconcile()
        await sc._reconcile()
        self.assertEqual(self.login_calls["n"], 1, "two ticks must not double-login")


if __name__ == "__main__":
    unittest.main(verbosity=2)