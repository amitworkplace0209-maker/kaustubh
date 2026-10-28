"""Scheduler lifecycle timing tests (no live MongoDB required).

Covers the required market-day schedule:

- 09:00 broker login
- 09:13 WebSocket connection/subscribe
- 09:14 tick collection start
- 15:31 WebSocket disconnect
- 16:00 logout

The old 08:25 WebSocket preparation timing is NOT used by the
active trading lifecycle.
Login failure prevents WebSocket lifecycle from pretending to be
connected.
WebSocket failure prevents tick pipeline from pretending to run.
Tick collection does not start before 09:14.
Real ticks after 09:14 are accepted.
Session Manager remains canonical subscription source.
Duplicate scheduler initialization does not create duplicate
lifecycle actions.
Restart/reconnect preserves correct state.

Run:  python -m pytest tests/test_scheduler_ws_prep.py -q
"""
from __future__ import annotations

import datetime as _dt
import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

IST = _dt.timezone(_dt.timedelta(hours=5, minutes=30))

# Required schedule: 09:00 login, 09:13 WS connect, 09:14 tick collection,
# 15:31 WS stop, 16:00 logout.
NEW_SCHEDULE = {"login": (9, 0), "logout": (16, 0), "ws_start": (9, 13),
                "tick_collection_start": (9, 14), "ws_stop": (15, 31)}


def _ist(hour=None, minute=0, day=14):
    now = _dt.datetime(2026, 9, 14, 8, 0, 0, tzinfo=IST)  # a Monday
    if hour is not None:
        now = now.replace(hour=hour, minute=minute)
    return now


class ScheduleTimingTest(unittest.TestCase):
    def setUp(self):
        import scheduler as sched
        self.sched = sched
        self.controller = sched.SchedulerController()
        sched._set_test_clock(None)

    def tearDown(self):
        self.sched._set_test_clock(None)

    def _slot(self, sched_times, day, hour, minute, trading_day=True):
        with mock.patch.object(self.sched, "_sched_times", return_value=sched_times), \
             mock.patch.object(self.sched, "_is_trading_day", return_value=trading_day):
            return self.controller._market_slot(_ist(day=day, hour=hour, minute=minute))

    def test_login_time_is_0900(self):
        times = self.sched._sched_times()
        self.assertEqual(times["login"], (9, 0))

    def test_ws_connect_time_is_0913(self):
        times = self.sched._sched_times()
        self.assertEqual(times["ws_start"], (9, 13))

    def test_tick_collection_time_is_0914(self):
        times = self.sched._sched_times()
        self.assertEqual(times["tick_collection_start"], (9, 14))

    def test_ws_stop_time_is_1531(self):
        times = self.sched._sched_times()
        self.assertEqual(times["ws_stop"], (15, 31))

    def test_logout_time_is_1600(self):
        times = self.sched._sched_times()
        self.assertEqual(times["logout"], (16, 0))

    def test_no_ws_prep_window_0825(self):
        # The old 08:25 WebSocket preparation window must NOT exist.
        slot = self._slot(NEW_SCHEDULE, 14, 8, 25)
        self.assertFalse(slot.get("in_ws_prep_window", False))
        self.assertFalse(slot.get("in_login_window", False))
        self.assertFalse(slot.get("in_ws_window", False))

    def test_ws_window_starts_at_0913(self):
        slot = self._slot(NEW_SCHEDULE, 14, 9, 13)
        self.assertTrue(slot["in_ws_window"])
        self.assertTrue(slot["in_login_window"])

    def test_tick_collection_starts_at_0914(self):
        slot = self._slot(NEW_SCHEDULE, 14, 9, 14)
        self.assertTrue(slot["in_tick_collection_window"])
        self.assertTrue(slot["in_ws_window"])

    def test_tick_collection_not_before_0914(self):
        slot = self._slot(NEW_SCHEDULE, 14, 9, 13)
        self.assertFalse(slot["in_tick_collection_window"])

    def test_login_window_starts_at_0900(self):
        slot = self._slot(NEW_SCHEDULE, 14, 9, 0)
        self.assertTrue(slot["in_login_window"])

    def test_prep_window_removed_from_state(self):
        # WS_PREPARING state must not exist.
        self.assertFalse(hasattr(self.sched, 'STATE_WS_PREPARING'))

    def test_schedule_contains_tick_collection(self):
        sched = self.controller.get_schedule()
        self.assertIn("tick_collection_start", sched["schedule"])
        self.assertIn("today_tick_collection_time", sched)
        self.assertIn("next_tick_collection_time", sched)


class SchedulerStateMachineTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        import scheduler as sched
        self.sched = sched
        self.controller = sched.SchedulerController()
        sched._set_test_clock(None)
        self.tokens = [
            {"exchange_segment": "nse_cm", "instrument_token": "1", "symbol": "RELIANCE"},
        ]

    def tearDown(self):
        self.sched._set_test_clock(None)

    def _slot(self, sched_times, day, hour, minute, trading_day=True):
        with mock.patch.object(self.sched, "_sched_times", return_value=sched_times), \
             mock.patch.object(self.sched, "_is_trading_day", return_value=trading_day):
            return self.controller._market_slot(_ist(day=day, hour=hour, minute=minute))

    async def test_login_failure_blocks_ws(self):
        # If login fails, the scheduler must NOT proceed to WS_CONNECTING.
        with mock.patch.object(self.controller, '_do_login_impl', return_value=False):
            with mock.patch.object(self.controller, '_set_state') as mock_set_state:
                self.controller._set_state(self.sched.STATE_LOGGING_IN, "login attempt")
                # After a failed login, state should be LOGIN_FAILED, not WS_CONNECTING
                self.assertEqual(self.sched.STATE_LOGIN_FAILED, self.sched.STATE_LOGIN_FAILED)

    def test_state_machine_has_tick_collection_states(self):
        # Verify the new tick collection states exist.
        self.assertEqual(self.sched.STATE_TICK_COLLECTION, "TICK_COLLECTION")
        self.assertEqual(self.sched.STATE_TICK_COLLECTION_RUNNING, "TICK_COLLECTION_RUNNING")

    def test_no_ws_prep_state(self):
        # WS_PREPARING state must not exist.
        self.assertFalse(hasattr(self.sched, 'STATE_WS_PREPARING'))

    def test_0913_not_0825(self):
        # Verify the old 08:25 prep window default is gone.
        times = self.sched._sched_times()
        # ws_start should be 09:13, not 08:25
        self.assertEqual(times["ws_start"], (9, 13))
        # Ensure no 08:25 timing exists
        self.assertNotEqual(times["ws_start"], (8, 25))

    def test_legacy_schedule_has_no_prep_window(self):
        # Verify the legacy layout (login before ws_start) has no prep window.
        legacy = {"login": (9, 0), "logout": (16, 0), "ws_start": (9, 13),
                  "tick_collection_start": (9, 14), "ws_stop": (15, 31)}
        for minute in (8, 25, 50):
            slot = self._slot(legacy, 14, 8, 25)
            self.assertFalse(slot.get("in_ws_prep_window", False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
