"""Multi-broker scheduler tests (spec: independent simultaneous lifecycles).

Master prompt: the Scheduler orchestrates the scheduled lifecycle for EVERY
enabled broker (Kotak + Shoonya together). Kotak keeps its regression-tested
controller; Shoonya runs through the independent ``ShoonyaLifecycleDriver`` on
the same time-table. These tests pin:

  * enablement rules (Kotak legacy default; Shoonya via adapter authority;
    Dummy NEVER an automatic target)
  * OAuth-pending honesty (no code today -> SHOONYA_OAUTH_CODE_REQUIRED +
    LOGIN_TRIGGERED once per date, not a fake login)
  * login fires the instant an OAuth code is provided
  * WS window drive / reconnect, scheduled WS stop, scheduled logout teardown
  * controller integration: kotak path keeps working while shoonya runs, both
    land in ``_brokers_report``

Run:  python -m pytest tests/test_multi_broker_scheduler.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

IST = timezone(timedelta(hours=5, minutes=30))
TRADING_DATE = (2026, 9, 8)


def _ist(hour=9, minute=0, day=TRADING_DATE):
    return datetime(day[0], day[1], day[2], hour, minute, 0, tzinfo=IST)


def _slot(hour=9, minute=0, *, trading_day=True, past_logout=False,
          past_ws_stop=False):
    h, m = hour, minute
    in_ws = (8, 55) <= (h, m) < (15, 32)
    return {
        "trading_day": trading_day,
        "in_login_window": (8, 50) <= (h, m) < (9, 0),
        "in_ws_window": in_ws and not past_ws_stop,
        "past_logout": past_logout,
        "past_ws_stop": past_ws_stop or (h, m) >= (15, 32),
        "now": _ist(hour, minute).isoformat(),
    }


def _times():
    return {"login": (8, 50), "ws_start": (8, 55), "ws_stop": (15, 31),
            "logout": (16, 0)}


class RecordingEvents:
    def __init__(self):
        self.events = []

    def __call__(self, category, event, level, message, meta=None):
        self.events.append({"event": event, "message": message, "meta": meta or {}})

    def names(self):
        return [e["event"] for e in self.events]


class FakeAdapter:
    """In-memory Shoonya adapter stand-in (SDK behaviour only)."""

    enabled = True

    def __init__(self):
        self.is_logged_in = False
        self._pending_auth_code: str | None = None
        self.logins = 0
        self.logouts = 0
        self.ensure_calls = 0
        self.stop_calls = 0

    def oauth_url(self):
        return "http://shoonya.test/oauth"

    def accept_auth_code(self, code):
        self._pending_auth_code = code or None

    async def login(self, register_central=True, ws_scope=None):
        self.logins += 1
        self.is_logged_in = True
        self._pending_auth_code = None
        return True

    async def logout(self, reason=None, register_central=True):
        self.logouts += 1
        self.is_logged_in = False
        return True

    async def ensure_feed(self, ws_scope=None):
        self.ensure_calls += 1
        return True

    def stop_feed(self, reason=None):
        self.stop_calls += 1


class _FakeSessionManager:
    def __init__(self, ws_state="DISCONNECTED"):
        self.ws_state = ws_state

    def terminal_session(self, terminal):
        return {
            "terminal": terminal, "connection_status": self.ws_state,
        }

    def snapshot(self):
        return {"state": "DISCONNECTED", "mode": "kotak", "ws_state": self.ws_state}


class FakeLedger:
    def __init__(self, statuses):
        self.statuses = statuses

    async def reconcile(self, **kwargs):
        return []

    async def today_job_statuses(self, business_date):
        return dict(self.statuses)

    async def today_broker_statuses(self, business_date):
        return {"kotak": dict(self.statuses), "shoonya": dict(self.statuses)}

    async def summary(self, business_date=None):
        return {}


# ---------------------------------------------------------------------------
# Enablement rules
# ---------------------------------------------------------------------------
class EnablementTests(unittest.TestCase):
    def test_kotak_default_enabled_when_engine_present(self):
        with mock.patch("brokers.selection.settings",
                        SimpleNamespace(kotak_enabled=True)) as s, \
             mock.patch("auth.kotak_client.kotak_session",
                        SimpleNamespace(session_active=False)):
            from brokers.selection import kotak_enabled, is_broker_enabled
            self.assertTrue(kotak_enabled())
            self.assertTrue(is_broker_enabled("kotak"))

    def test_kotak_explicit_false_disables_scheduler_drive(self):
        with mock.patch("brokers.selection.settings",
                        SimpleNamespace(kotak_enabled=False)):
            from brokers.selection import kotak_enabled
            self.assertFalse(kotak_enabled())

    def test_shoonya_enabled_from_adapter_authority(self):
        fake = SimpleNamespace(enabled=True)
        with mock.patch("brokers.shoonya_adapter.shoonya_adapter", fake):
            from brokers.selection import shoonya_enabled
            self.assertTrue(shoonya_enabled())

    def test_shoonya_disabled_when_adapter_off(self):
        fake = SimpleNamespace(enabled=False)
        with mock.patch("brokers.shoonya_adapter.shoonya_adapter", fake):
            from brokers.selection import shoonya_enabled
            self.assertFalse(shoonya_enabled())

    def test_dummy_never_an_automatic_target(self):
        from brokers.selection import TERMINAL_ORDER
        with mock.patch("brokers.selection.settings",
                        SimpleNamespace(kotak_enabled=True)), \
             mock.patch("auth.kotak_client.kotak_session",
                        SimpleNamespace(session_active=False)), \
             mock.patch("brokers.shoonya_adapter.shoonya_adapter",
                        SimpleNamespace(enabled=True)):
            from brokers.selection import is_broker_enabled, enabled_brokers
            self.assertFalse(is_broker_enabled("dummy"))
            self.assertNotIn("dummy", enabled_brokers())

    def test_single_broker_enablement_gives_tuple(self):
        with mock.patch("brokers.selection.settings",
                        SimpleNamespace(kotak_enabled=True)), \
             mock.patch("auth.kotak_client.kotak_session",
                        SimpleNamespace(session_active=False)), \
             mock.patch("brokers.shoonya_adapter.shoonya_adapter",
                        SimpleNamespace(enabled=False)):
            from brokers.selection import enabled_brokers
            self.assertEqual(enabled_brokers(), ("kotak",))


# ---------------------------------------------------------------------------
# ShoonyaLifecycleDriver — independent drive decisions (unit level)
# ---------------------------------------------------------------------------
class ShoonyaDriverTests(unittest.IsolatedAsyncioTestCase):
    def _make(self, ws_state="DISCONNECTED", controller=None):
        import scheduler.broker_lifecycle as bl
        adapter = FakeAdapter()
        events = RecordingEvents()
        ctrl = controller or SimpleNamespace(
            _set_state=lambda state, message="": None)
        driver = bl.ShoonyaLifecycleDriver(ctrl)
        patchers = [
            mock.patch("brokers.shoonya_adapter.shoonya_adapter", adapter),
            mock.patch("scheduler.broker_lifecycle.session_manager",
                       SimpleNamespace(terminal_session=lambda t: {
                           "terminal": t, "connection_status": ws_state})),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)
        return driver, adapter, events

    async def test_no_code_no_login_honest_pending(self):
        driver, adapter, events = self._make()
        statuses = {"login": "PENDING", "ws_start": "PENDING",
                    "tick_collection": "PENDING", "ws_stop": "PENDING",
                    "logout": "PENDING"}
        driver._login_triggered_date = None
        driver._oauth_warned_date = None
        report = await driver.reconcile(
            now=_ist(8, 50), slot=_slot(8, 50), times=_times(),
            today_iso="2026-09-08", today_status=statuses,
            record_event=events, is_primary=False)
        self.assertEqual(adapter.logins, 0)
        self.assertFalse(adapter.is_logged_in)
        self.assertEqual(report["state"], "LOGIN_PENDING")
        self.assertTrue(report["oauth"]["required"])
        self.assertTrue(report["oauth"]["code_provided"] is False)
        self.assertEqual(report["oauth"]["accept_endpoint"],
                         "/api/shoonya/oauth-code")
        names = events.names()
        self.assertIn("SHOONYA_OAUTH_CODE_REQUIRED", names)
        self.assertIn("LOGIN_TRIGGERED", names)
        # Exactly once per date — a second tick must not re-fire.
        await driver.reconcile(now=_ist(8, 51), slot=_slot(8, 51),
                               times=_times(), today_iso="2026-09-08",
                               today_status=statuses, record_event=events,
                               is_primary=False)
        self.assertEqual(events.names().count("SHOONYA_OAUTH_CODE_REQUIRED"), 1)
        self.assertEqual(events.names().count("LOGIN_TRIGGERED"), 1)
        self.assertEqual(report["broker"], "shoonya")

    async def test_login_on_oauth_code(self):
        driver, adapter, events = self._make()
        statuses = {"login": "PENDING", "ws_start": "PENDING", "tick_collection": "PENDING",
                    "ws_stop": "PENDING", "logout": "PENDING"}
        adapter.accept_auth_code("one-time-code")
        self.assertTrue(driver.has_auth_code())
        report = await driver.reconcile(
            now=_ist(8, 52), slot=_slot(8, 52), times=_times(),
            today_iso="2026-09-08", today_status=statuses,
            record_event=events, is_primary=False)
        self.assertEqual(adapter.logins, 1, "login fires the instant the code arrives")
        self.assertTrue(adapter.is_logged_in)
        self.assertIn("LOGIN_STARTED", events.names())
        self.assertIn("LOGIN_SUCCESS", events.names())
        self.assertTrue(report["session"]["active"])
        self.assertIn(report["login"]["state"], ("LOGGED_IN", "SESSION_VALID",
                                                 "WS_CONNECTING", "WS_CONNECTED"))

    async def test_ws_drop_mid_window_reconnects(self):
        driver, adapter, events = self._make()
        statuses = {"login": "COMPLETED", "ws_start": "COMPLETED",
                    "tick_collection": "PENDING", "ws_stop": "PENDING", "logout": "PENDING"}
        adapter.is_logged_in = True
        report = await driver.reconcile(
            now=_ist(11, 30), slot=_slot(11, 30), times=_times(),
            today_iso="2026-09-08", today_status=statuses,
            record_event=events, is_primary=False)
        self.assertGreaterEqual(adapter.ensure_calls, 1, "feed must be (re)started mid-window")
        self.assertIn(report["state"], ("WS_CONNECTING", "WS_CONNECTED"))

    async def test_past_ws_stop_stops_feed(self):
        driver, adapter, events = self._make(ws_state="CONNECTED")
        statuses = {"login": "COMPLETED", "ws_start": "COMPLETED",
                    "tick_collection": "PENDING", "ws_stop": "PENDING", "logout": "PENDING"}
        adapter.is_logged_in = True
        report = await driver.reconcile(
            now=_ist(15, 32), slot=_slot(15, 32, past_ws_stop=True), times=_times(),
            today_iso="2026-09-08", today_status=statuses,
            record_event=events, is_primary=False)
        self.assertGreaterEqual(adapter.stop_calls, 1, "feed must stop after ws_stop")
        self.assertEqual(report["state"], "WS_STOPPING")
        self.assertIn("WS_STOP_TRIGGERED", events.names())

    async def test_not_trading_day_logs_out(self):
        driver, adapter, events = self._make()
        adapter.is_logged_in = True
        slot = _slot(10, 0)
        slot["trading_day"] = False
        report = await driver.reconcile(
            now=_ist(10, 0), slot=slot, times=_times(),
            today_iso="2026-09-12", today_status={},
            record_event=events, is_primary=False)
        self.assertEqual(adapter.logouts, 1)
        self.assertEqual(report["state"], "MARKET_CLOSED")
        self.assertIn("LOGOUT_SUCCESS", events.names())

    async def test_primary_mirrors_controller_state(self):
        recorded = []
        ctrl = SimpleNamespace(_set_state=lambda state, message="": recorded.append(state))
        driver, adapter, events = self._make(controller=ctrl)
        statuses = {"login": "PENDING", "ws_start": "PENDING", "tick_collection": "PENDING",
                    "ws_stop": "PENDING", "logout": "PENDING"}
        await driver.reconcile(now=_ist(8, 50), slot=_slot(8, 50), times=_times(),
                               today_iso="2026-09-08", today_status=statuses,
                               record_event=events, is_primary=True)
        import scheduler  # noqa: PLC0415
        self.assertIn(scheduler.STATE_WAITING_FOR_LOGIN, recorded,
                      "primary broker must mirror its state on the global view")

    async def test_login_blocked_never_fabricates(self):
        driver, adapter, events = self._make()
        statuses = {"login": "MISSED_EXPIRED", "ws_start": "MISSED_EXPIRED",
                    "tick_collection": "ALREADY_SATISFIED", "ws_stop": "ALREADY_SATISFIED",
                    "logout": "PENDING"}
        report = await driver.reconcile(
            now=_ist(15, 32), slot=_slot(15, 32, past_ws_stop=True), times=_times(),
            today_iso="2026-09-08", today_status=statuses,
            record_event=events, is_primary=False)
        self.assertEqual(adapter.logins, 0, "never auto-login when the window expired")
        self.assertEqual(report["state"], "FAILED")


# ---------------------------------------------------------------------------
# Controller integration — Kotak + Shoonya simultaneously
# ---------------------------------------------------------------------------
class FakeKotak:
    def __init__(self):
        self.session_active = False
        self.last_login_at = None


class FakeWs:
    def __init__(self):
        self._connected = False

    def is_connected(self):
        return self._connected

    def subscribed_count(self):
        return 0

    def get_supervisor_state(self):
        return "STOPPED"


class MultiBrokerReconcileTest(unittest.IsolatedAsyncioTestCase):
    def _setup(self, *, clock, adapter=None, statuses=None):
        import scheduler  # noqa: PLC0415
        sc = scheduler.SchedulerController()
        sc._running = True
        sc._busy_lock = asyncio.Lock()
        sc._wake_event = asyncio.Event()
        kotak = FakeKotak()
        ws = FakeWs()
        sm = _FakeSessionManager()
        ledger = FakeLedger(statuses or {
            "login": "PENDING", "ws_start": "PENDING", "tick_collection": "PENDING",
            "ws_stop": "PENDING", "logout": "PENDING"})
        market_svc = mock.MagicMock()
        market_svc.get_snapshot.return_value = {"network_ok": True, "market_state": ""}
        market_svc.evaluate.return_value = None
        events = RecordingEvents()
        sh_adapter = adapter or FakeAdapter()

        self.patches = [
            mock.patch.object(scheduler, "kotak_session", kotak),
            mock.patch.object(scheduler, "ws_manager", ws),
            mock.patch.object(scheduler, "session_manager", sm),
            mock.patch.object(scheduler, "scheduler_ledger", ledger),
            mock.patch.object(scheduler, "market_state_service", market_svc),
            mock.patch.object(scheduler, "record_event", events),
            mock.patch.object(scheduler, "refresh_runtime_settings",
                              new=mock.AsyncMock()),
            mock.patch.object(scheduler, "rt_bool", return_value=True),
            mock.patch.object(scheduler, "_enabled_brokers_now",
                              return_value=("kotak", "shoonya")),
            mock.patch.object(scheduler, "_shoonya_active",
                              return_value=False),
            mock.patch.object(scheduler, "_shoonya_ws_connected",
                              return_value=False),
            mock.patch("brokers.shoonya_adapter.shoonya_adapter", sh_adapter),
            mock.patch("scheduler.broker_lifecycle.session_manager", sm),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

        self.login_calls = {"n": 0}

        async def fake_do_login_impl(source="scheduler", acquire_busy=True):
            self.login_calls["n"] += 1
            kotak.session_active = True
            return True

        sc._do_login_impl = fake_do_login_impl
        scheduler._set_test_clock(clock if clock is not None
                                  else (lambda: _ist(hour=9, minute=0)))
        return scheduler, sc, kotak, sh_adapter, ledger, events

    def tearDown(self):
        import scheduler  # noqa: PLC0415
        scheduler._set_test_clock(None)

    async def test_both_brokers_driven_kotak_keeps_working(self):
        import scheduler  # noqa: PLC0415
        _sched, sc, kotak, sh_adapter, _l, events = self._setup(
            clock=lambda: _ist(hour=8, minute=50))
        await sc._reconcile()
        # Kotak: the legacy login still fires exactly as before.
        self.assertEqual(self.login_calls["n"], 1)
        self.assertTrue(kotak.session_active)
        # Shoonya: an independent lifecycle report exists and honours OAuth.
        self.assertIn("kotak", sc._brokers_report)
        self.assertIn("shoonya", sc._brokers_report)
        shoonya = sc._brokers_report["shoonya"]
        self.assertEqual(shoonya["broker"], "shoonya")
        self.assertEqual(shoonya["state"], "LOGIN_PENDING")
        self.assertTrue(shoonya["oauth"]["required"])
        self.assertEqual(sh_adapter.logins, 0)
        self.assertIn("SHOONYA_OAUTH_CODE_REQUIRED", events.names())
        self.assertEqual(sc._enabled_brokers, ("kotak", "shoonya"))

    async def test_shoonya_login_after_code(self):
        import scheduler  # noqa: PLC0415
        sh_adapter = FakeAdapter()
        sh_adapter._pending_auth_code = "abc123"
        _sched, sc, kotak, sh_adapter, _l, events = self._setup(
            clock=lambda: _ist(hour=8, minute=52), adapter=sh_adapter)
        await sc._reconcile()
        self.assertGreaterEqual(sh_adapter.logins, 1,
                                "shoonya logs in once its OAuth code is provided")
        self.assertTrue(kotak.session_active)
        self.assertTrue(sc._brokers_report["shoonya"]["session"]["active"])


if __name__ == "__main__":
    unittest.main(verbosity=2)