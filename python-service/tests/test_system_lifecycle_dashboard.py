"""Dashboard lifecycle-derivation regression tests.

Verifies ``api.system._scheduler_event_lifecycle`` — the function that builds
the four lifecycle cards (LOGIN / WS CONNECT / WS DISCONNECT / LOGOUT).

The core regression being pinned: on a trading day inside the active window,
LOGIN / WS CONNECT must NEVER be reported as ``SKIPPED`` merely because the
5-second loop missed the exact scheduled instant or the backend restarted after
the scheduled time. ``SKIPPED`` is allowed only with a genuine reason
(scheduler disabled / dummy mode / WebSocket disabled / non-trading day /
expired window) or when the outcome was already satisfied.

Run:  python -m pytest tests/test_system_lifecycle_dashboard.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timezone, timedelta

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

IST = timezone(timedelta(hours=5, minutes=30))
TRADING_DATE = (2026, 9, 8)  # Tuesday — real NSE trading day


def _ist(hour=9, minute=0, second=0, day=TRADING_DATE):
    return datetime(day[0], day[1], day[2], hour, minute, second, 0, tzinfo=IST)


SCHEDULE = {
    "today_login_time": _ist(8, 50).isoformat(),
    "today_ws_connect_time": _ist(8, 55).isoformat(),
    "today_ws_disconnect_time": _ist(15, 31).isoformat(),
    "today_logout_time": _ist(16, 0).isoformat(),
}
WINDOWS = {"schedule": {
    "login_time": "08:50", "ws_start_time": "08:55",
    "ws_stop_time": "15:31", "logout_time": "16:00",
}}


def _event(event, ts, source="scheduler", meta=None, reason=""):
    return {
        "source": source, "event": event,
        "ts": ts.replace(microsecond=0).isoformat(),
        "message": "", "reason": reason,
        "meta": meta or {},
    }


def _ledger(**statuses):
    return {k: {"status": v, "reason": "", "reason_code": None}
            for k, v in statuses.items()}


def _lifecycle(events=None, scheduler_state=None, ledger=None, **kw):
    from api.system import _scheduler_event_lifecycle
    return _scheduler_event_lifecycle(
        events=events or [],
        schedule=SCHEDULE,
        windows=WINDOWS,
        is_trading_day=kw.pop("is_trading_day", True),
        scheduler_state=scheduler_state,
        now=kw.pop("now", _ist(hour=10, minute=0)),
        ledger_jobs=ledger or {},
        session_active=kw.pop("session_active", False),
        ws_connected=kw.pop("ws_connected", False),
        ws_enabled=kw.pop("ws_enabled", True),
        sched_enabled=kw.pop("sched_enabled", True),
        terminal_mode=kw.pop("terminal_mode", None),
    )


def _cards(result):
    return {r["code"]: r for r in result}


class LifecycleStatusTest(unittest.TestCase):
    # ---- Regression: catch-up mid-window is NEVER a silent SKIPPED -------
    def test_mid_window_catching_up_not_skipped(self):
        result = _lifecycle(
            scheduler_state="LOGIN_FAILED",
            ledger=_ledger(login="CATCHING_UP", ws_start="CATCHING_UP"),
            now=_ist(hour=10, minute=0),
        )
        cards = _cards(result)
        self.assertEqual(cards["login"]["status"], "CATCHING_UP")
        self.assertEqual(cards["ws_connect"]["status"], "CATCHING_UP")
        self.assertNotIn("SKIPPED", {c["status"] for c in result})

    def test_mid_window_retry_not_skipped(self):
        result = _lifecycle(
            scheduler_state="WS_RECONNECTING",
            ledger=_ledger(login="CATCHING_UP", ws_start="CATCHING_UP"),
            now=_ist(hour=11, minute=0),
        )
        cards = _cards(result)
        self.assertEqual(cards["ws_connect"]["status"], "CATCHING_UP")
        self.assertNotEqual(cards["ws_connect"]["status"], "SKIPPED")

    # ---- No reason → honest DUE, never bare SKIPPED ----------------------
    def test_missing_execution_is_due_not_skipped(self):
        result = _lifecycle(scheduler_state="WAITING_FOR_LOGIN", now=_ist(hour=9, minute=0))
        cards = _cards(result)
        # No ledger, no event, nothing disabled → the card must stay DUE/WAITING.
        self.assertNotIn("SKIPPED", {c["status"] for c in result})

    # ---- Genuine skips still carry an explicit reason --------------------
    def test_scheduler_disabled_skip_with_reason(self):
        result = _lifecycle(scheduler_state="LOGGED_OUT", sched_enabled=False,
                            now=_ist(hour=11, minute=0))
        cards = _cards(result)
        self.assertEqual(cards["login"]["status"], "SKIPPED")
        self.assertIn("disabled", cards["login"]["explanation"])
        self.assertEqual(cards["ws_connect"]["status"], "SKIPPED")
        self.assertIn("disabled", cards["ws_connect"]["explanation"])

    def test_ws_disabled_skip_with_reason(self):
        result = _lifecycle(session_active=True, ws_enabled=False, now=_ist(hour=11, minute=0))
        cards = _cards(result)
        self.assertEqual(cards["ws_connect"]["status"], "SKIPPED")
        self.assertIn("WebSocket feed disabled", cards["ws_connect"]["explanation"])

    def test_dummy_mode_skip_with_reason(self):
        result = _lifecycle(scheduler_state="LOGGED_OUT", terminal_mode="dummy",
                            now=_ist(hour=11, minute=0))
        cards = _cards(result)
        self.assertEqual(cards["login"]["status"], "SKIPPED")
        self.assertIn("dummy mode", cards["login"]["explanation"])
        self.assertEqual(cards["ws_connect"]["status"], "SKIPPED")
        self.assertIn("dummy mode", cards["ws_connect"]["explanation"])

    def test_ledger_terminal_skip_uses_ledger_reason(self):
        ledger = _ledger(login="MISSED_EXPIRED", ws_start="MISSED_EXPIRED")
        ledger["login"]["reason"] = "Login no longer meaningful after feed window"
        ledger["ws_start"]["reason"] = "Market window no longer valid"
        result = _lifecycle(scheduler_state="MARKET_CLOSED", ledger=ledger,
                            now=_ist(hour=15, minute=32))
        cards = _cards(result)
        self.assertEqual(cards["login"]["status"], "SKIPPED")
        self.assertIn("Login no longer meaningful", cards["login"]["explanation"])
        self.assertEqual(cards["ws_connect"]["status"], "SKIPPED")
        self.assertIn("Market window no longer valid", cards["ws_connect"]["explanation"])

    # ---- Already satisfied → COMPLETED (spec §4 ALREADY_SATISFIED) -------
    def test_active_session_is_completed_without_event(self):
        result = _lifecycle(scheduler_state="SESSION_ACTIVE", session_active=True,
                            now=_ist(hour=9, minute=30))
        cards = _cards(result)
        self.assertEqual(cards["login"]["status"], "COMPLETED")
        self.assertIn("already satisfied", cards["login"]["explanation"].lower())

    def test_connected_ws_is_completed_without_event(self):
        result = _lifecycle(scheduler_state="SESSION_ACTIVE", ws_connected=True,
                            now=_ist(hour=9, minute=30))
        cards = _cards(result)
        self.assertEqual(cards["ws_connect"]["status"], "COMPLETED")
        self.assertIn("already satisfied", cards["ws_connect"]["explanation"].lower())

    # ---- Real execution events drive COMPLETED ----------------------------
    def test_completed_day_from_events(self):
        events = [
            _event("login_ok", _ist(8, 50, 3), meta={"source": "scheduler"}),
            _event("state:WS_ACTIVE", _ist(8, 55, 5)),
            _event("ws_stop", _ist(15, 31, 2)),
            _event("logout_ok", _ist(16, 0, 1)),
        ]
        result = _lifecycle(events=events, scheduler_state="LOGGED_OUT",
                            now=_ist(hour=16, minute=5))
        for code in ("login", "ws_connect", "ws_disconnect", "logout"):
            self.assertEqual(_cards(result)[code]["status"], "COMPLETED", code)
            last = _cards(result)[code]["actual"]
            self.assertIsNotNone(last, code)

    # ---- Failure superseded by later success → COMPLETED ------------------
    def test_failure_then_success_is_completed(self):
        events = [
            _event("login_failed", _ist(8, 51), reason="bad otp"),
            _event("login_ok", _ist(8, 52, 10), meta={"source": "scheduler"}),
        ]
        result = _lifecycle(events=events, scheduler_state="SESSION_ACTIVE",
                            now=_ist(hour=9, minute=0))
        self.assertEqual(_cards(result)["login"]["status"], "COMPLETED")

    # ---- Non-trading day → NOT_APPLICABLE ---------------------------------
    def test_non_trading_day_not_applicable(self):
        result = _lifecycle(is_trading_day=False, scheduler_state="MARKET_CLOSED",
                            now=_ist(hour=10, minute=0))
        self.assertEqual({c["status"] for c in result}, {"NOT_APPLICABLE"})

    # ---- Future schedule times stay UPCOMING/ACTIVE ------------------------
    def test_future_logout_still_upcoming(self):
        result = _lifecycle(now=_ist(hour=11, minute=0))
        cards = _cards(result)
        self.assertEqual(cards["logout"]["status"], "UPCOMING")
        self.assertEqual(cards["ws_disconnect"]["status"], "UPCOMING")

    def test_parked_state_keeps_ws_logout_active(self):
        result = _lifecycle(scheduler_state="LOGGED_OUT", now=_ist(hour=11, minute=0))
        cards = _cards(result)
        self.assertEqual(cards["ws_disconnect"]["status"], "ACTIVE")
        self.assertEqual(cards["logout"]["status"], "ACTIVE")

    # ---- Output contract: new ledger fields present ------------------------
    def test_payload_contract(self):
        ledger = _ledger(login="CATCHING_UP")
        result = _lifecycle(ledger=ledger, scheduler_state="LOGIN_FAILED",
                            now=_ist(hour=10, minute=0))
        card = _cards(result)["login"]
        for key in ("code", "label", "status", "explanation", "scheduled",
                    "scheduledWallTime", "actual", "actualSource", "actualReason",
                    "ledgerStatus", "ledgerReason", "ledgerReasonCode", "attempt",
                    "durationSeconds"):
            self.assertIn(key, card, key)


if __name__ == "__main__":
    unittest.main(verbosity=2)