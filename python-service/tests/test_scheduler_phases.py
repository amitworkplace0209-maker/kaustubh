"""Engine #01 trading-day phase machine + readiness tests (pure, no DB/network).

Locks the spec timeline (scheduler-engine.md §4/§6):
  08:55 READINESS -> 09:00 PRE_MARKET -> 09:05 LIMIT_ORDER_WINDOW ->
  09:10 EQUILIBRIUM -> 09:12 BUFFER -> 09:15 LIVE_FEED -> 15:16 SQUARE_OFF ->
  15:30 FEED_STOPPING -> 15:31 WEBSOCKET_STOPPING -> 16:00 DAY_COMPLETE

Run:  python -m pytest tests/test_scheduler_phases.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

import scheduler as sched

IST = timezone(timedelta(hours=5, minutes=30))


def _ist(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 9, 14, hour, minute, second, tzinfo=IST)


class TradingPhaseTest(unittest.TestCase):
    def setUp(self):
        self.times = sched._sched_times()

    def _phase(self, hour: int, minute: int, trading_day: bool = True) -> str:
        return sched._trading_phase(_ist(hour, minute), self.times, trading_day)

    def test_before_login_closed(self):
        self.assertEqual(self._phase(8, 0), sched.PHASE_CLOSED)
        self.assertEqual(self._phase(8, 55), sched.PHASE_CLOSED)
        self.assertEqual(self._phase(8, 59), sched.PHASE_CLOSED)

    def test_readiness_at_login_instant(self):
        # With login 09:00 and pre_market 09:00, readiness is instantaneous:
        # at 09:00 the phase machine moves straight to PRE_MARKET.
        self.assertEqual(self._phase(9, 0), sched.PHASE_PRE_MARKET)
        self.assertEqual(self._phase(9, 4), sched.PHASE_PRE_MARKET)

    def test_limit_order_window(self):
        self.assertEqual(self._phase(9, 5), sched.PHASE_LIMIT_ORDER_WINDOW)
        self.assertEqual(self._phase(9, 9), sched.PHASE_LIMIT_ORDER_WINDOW)

    def test_equilibrium(self):
        self.assertEqual(self._phase(9, 10), sched.PHASE_EQUILIBRIUM)
        self.assertEqual(self._phase(9, 11), sched.PHASE_EQUILIBRIUM)

    def test_buffer(self):
        self.assertEqual(self._phase(9, 12), sched.PHASE_BUFFER)
        self.assertEqual(self._phase(9, 14), sched.PHASE_BUFFER)

    def test_live_feed(self):
        self.assertEqual(self._phase(9, 15), sched.PHASE_LIVE_FEED)
        self.assertEqual(self._phase(12, 0), sched.PHASE_LIVE_FEED)

    def test_square_off(self):
        self.assertEqual(self._phase(15, 16), sched.PHASE_SQUARE_OFF)
        self.assertEqual(self._phase(15, 29), sched.PHASE_SQUARE_OFF)

    def test_feed_stopping(self):
        self.assertEqual(self._phase(15, 30), sched.PHASE_FEED_STOPPING)

    def test_websocket_stopping(self):
        self.assertEqual(self._phase(15, 31), sched.PHASE_WEBSOCKET_STOPPING)

    def test_day_complete(self):
        self.assertEqual(self._phase(16, 0), sched.PHASE_DAY_COMPLETE)
        self.assertEqual(self._phase(16, 30), sched.PHASE_DAY_COMPLETE)

    def test_non_trading_day_closed(self):
        self.assertEqual(self._phase(11, 0, trading_day=False), sched.PHASE_CLOSED)

    def test_reduced_schedule_tolerates_missing_keys(self):
        small = {
            "login": (8, 50), "logout": (15, 35), "ws_start": (8, 55),
            "tick_collection_start": (8, 59), "ws_stop": (15, 31),
        }
        self.assertEqual(
            sched._trading_phase(_ist(9, 20), small, True), sched.PHASE_READINESS
        )


class PhaseEventTest(unittest.TestCase):
    def test_phase_change_fires_once_with_entry_event(self):
        ctrl = sched.SchedulerController()
        with mock.patch.object(sched, "record_event") as re:
            self.assertTrue(ctrl._set_phase(sched.PHASE_PRE_MARKET))
            self.assertFalse(ctrl._set_phase(sched.PHASE_PRE_MARKET))
            names = [call.args[1] for call in re.call_args_list]
            self.assertEqual(names.count("PHASE_CHANGED"), 1)
            self.assertEqual(names.count("PRE_MARKET_STARTED"), 1)

    def test_action_phase_has_no_entry_event(self):
        ctrl = sched.SchedulerController()
        with mock.patch.object(sched, "record_event") as re:
            ctrl._set_phase(sched.PHASE_SQUARE_OFF)
            names = [call.args[1] for call in re.call_args_list]
            self.assertEqual(names.count("PHASE_CHANGED"), 1)
            self.assertNotIn("SQUARE_OFF_STARTED", names)


class ReadinessTest(unittest.TestCase):
    def test_not_applicable_on_non_trading_day(self):
        ctrl = sched.SchedulerController()
        ctrl._refresh_readiness(_ist(10, 0), False)
        rep = ctrl.readiness_snapshot()
        self.assertFalse(rep["applicable"])
        self.assertIsNone(rep["overall"])

    def test_not_ready_when_session_missing(self):
        ctrl = sched.SchedulerController()
        with mock.patch.object(sched, "record_event") as re:
            ctrl._refresh_readiness(_ist(9, 1), True)
        rep = ctrl.readiness_snapshot()
        self.assertTrue(rep["applicable"])
        self.assertEqual(rep["overall"], "NOT_READY")
        missing = [c["component"] for c in rep["checks"]
                   if c["critical"] and not c["ready"]]
        self.assertTrue(missing, "NOT_READY must name at least one missing component")
        self.assertTrue(any(call.args[1] == "SCHEDULER_NOT_READY"
                            for call in re.call_args_list))

    def test_ready_when_all_critical_present(self):
        ctrl = sched.SchedulerController()
        with mock.patch.object(sched, "record_event") as re, \
             mock.patch.object(sched, "kotak_session") as ks, \
             mock.patch.object(sched, "session_manager") as sm, \
             mock.patch.object(sched, "ws_manager") as wm, \
             mock.patch.object(sched.SchedulerController, "_engine_running",
                               staticmethod(lambda eid: True)):
            ks.session_active = True
            sm.snapshot.return_value = {"active": True}
            wm.is_connected.return_value = True
            wm.subscribed_count.return_value = 8
            ctrl._refresh_readiness(_ist(9, 1), True)
        rep = ctrl.readiness_snapshot()
        self.assertEqual(rep["overall"], "READY")
        self.assertTrue(any(call.args[1] == "SCHEDULER_READY"
                            for call in re.call_args_list))

    def test_readiness_toggle_emits_once_per_change(self):
        ctrl = sched.SchedulerController()
        with mock.patch.object(sched, "record_event") as re, \
             mock.patch.object(sched, "kotak_session") as ks, \
             mock.patch.object(sched, "session_manager") as sm, \
             mock.patch.object(sched, "ws_manager") as wm, \
             mock.patch.object(sched.SchedulerController, "_engine_running",
                               staticmethod(lambda eid: True)):
            ks.session_active = True
            sm.snapshot.return_value = {"active": True}
            wm.is_connected.return_value = True
            wm.subscribed_count.return_value = 8
            ctrl._refresh_readiness(_ist(9, 1), True)
            ctrl._refresh_readiness(_ist(9, 2), True)
        ready_calls = [c for c in re.call_args_list
                       if c.args[1] == "SCHEDULER_READY"]
        self.assertEqual(len(ready_calls), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
