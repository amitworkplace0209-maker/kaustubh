"""Pure availability math + live snapshot shape tests for the WS monitor.

These exercise ``availability_from_records`` (no MongoDB required) and the
canonical ``live_snapshot()`` frame. The market calendar's trading-day rule is
patched so the tests are deterministic regardless of real NSE holidays.
"""
import importlib
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from services.websocket_history_service import availability_from_records, new_connection_id

_TEST_IST = timezone(timedelta(hours=5, minutes=30))


def _ist(y, mo, d, h, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=_TEST_IST)


def _utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc)


_DAY_START = _ist(2026, 6, 1, 0, 0)   # Monday
_DAY_END = _ist(2026, 6, 2, 0, 0)
WINDOW_SEC = 6 * 3600 + 15 * 60  # 09:15-15:30 IST = 22500s


def _rec(connected: datetime, *, disconnected: datetime | None = None,
         status: str = "disconnected", messages: int = 0, ticks: int = 0,
         errors: int = 0, heartbeats: int = 0, gaps: int = 0, reconnects: int = 0):
    return {
        "connection_id": "ws_test_00000000_000000_00000",
        "connected_at": _utc(connected).isoformat(),
        "disconnected_at": _utc(disconnected).isoformat() if disconnected else None,
        "status": status,
        "messages_received": messages,
        "ticks_received": ticks,
        "error_count": errors,
        "heartbeat_failures": heartbeats,
        "data_gaps": gaps,
        "reconnect_count": reconnects,
    }


class AvailabilityFromRecordsTest(unittest.TestCase):

    def setUp(self):
        self.start = _utc(_DAY_START)
        self.end = _utc(_DAY_END)
        self._trading = mock.patch("services.market_calendar.is_trading_day", return_value=True)
        self._trading.start()
        self.addCleanup(self._trading.stop)

    def test_no_records_trading_day_is_insufficient_never_zero(self):
        result = availability_from_records([], self.start, self.end)
        self.assertTrue(result["insufficient"])
        self.assertIsNone(result["availabilityPercent"])
        self.assertEqual(result["downtimeSec"], 0)
        self.assertEqual(result["uptimeSec"], 0)
        self.assertEqual(result["windowSec"], WINDOW_SEC)

    def test_full_session_is_100_percent(self):
        rec = _rec(_ist(2026, 6, 1, 9, 0),
                   disconnected=_ist(2026, 6, 1, 15, 45),
                   messages=9000, ticks=4500, errors=1)
        result = availability_from_records([rec], self.start, self.end)
        self.assertEqual(result["availabilityPercent"], 100.0)
        self.assertEqual(result["uptimeSec"], WINDOW_SEC)
        self.assertEqual(result["downtimeSec"], 0)
        self.assertEqual(result["measuredWindowSec"], WINDOW_SEC)
        self.assertFalse(result["insufficient"])
        self.assertEqual(result["messagesReceived"], 9000)
        self.assertEqual(result["ticksReceived"], 4500)
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["connections"], 1)

    def test_half_day_session_reports_50_percent_with_honest_downtime(self):
        # Connected for exactly half the 09:15-15:30 window -> 50% availability.
        rec = _rec(_ist(2026, 6, 1, 9, 15), disconnected=_ist(2026, 6, 1, 12, 22, 30))
        result = availability_from_records([rec], self.start, self.end)
        self.assertEqual(result["availabilityPercent"], 50.0)
        self.assertEqual(result["uptimeSec"], WINDOW_SEC / 2)
        self.assertEqual(result["downtimeSec"], WINDOW_SEC / 2)
        self.assertEqual(result["measuredWindowSec"], WINDOW_SEC)

    def test_open_session_counted_to_now(self):
        now = _ist(2026, 6, 1, 11, 15)
        rec = _rec(_ist(2026, 6, 1, 9, 15), status="connected")  # still open
        result = availability_from_records([rec], self.start, self.end, now=_utc(now))
        self.assertFalse(result["insufficient"])
        self.assertEqual(result["uptimeSec"], 2 * 3600)
        self.assertEqual(result["availabilityPercent"], 32.0)  # 7200/22500
        self.assertEqual(result["downtimeSec"], round(WINDOW_SEC - 7200, 1))

    def test_weekend_with_no_records_is_insufficient_and_no_downtime(self):
        with mock.patch("services.market_calendar.is_trading_day", return_value=False):
            result = availability_from_records([], self.start, self.end)
        self.assertTrue(result["insufficient"])
        self.assertIsNone(result["availabilityPercent"])
        self.assertEqual(result["windowSec"], 0)
        self.assertEqual(result["downtimeSec"], 0)

    def test_record_on_weekend_never_fabricates_downtime(self):
        rec = _rec(_ist(2026, 6, 1, 10, 0), disconnected=_ist(2026, 6, 1, 11, 0))
        with mock.patch("services.market_calendar.is_trading_day", return_value=False):
            result = availability_from_records([rec], self.start, self.end)
        self.assertIsNone(result["availabilityPercent"])
        self.assertEqual(result["downtimeSec"], 0)
        self.assertEqual(result["windowSec"], 0)

    def test_session_only_before_open_claims_no_downtime(self):
        rec = _rec(_ist(2026, 6, 1, 8, 0), disconnected=_ist(2026, 6, 1, 9, 0))
        result = availability_from_records([rec], self.start, self.end)
        self.assertIsNone(result["availabilityPercent"])
        self.assertEqual(result["downtimeSec"], 0)
        self.assertEqual(result["measuredWindowSec"], 0)
        self.assertFalse(result["insufficient"])

    def test_multiple_sessions_account_for_market_hour_gap(self):
        rec1 = _rec(_ist(2026, 6, 1, 9, 15), disconnected=_ist(2026, 6, 1, 10, 15),
                    messages=1000, ticks=500)
        rec2 = _rec(_ist(2026, 6, 1, 12, 15), disconnected=_ist(2026, 6, 1, 15, 30),
                    messages=2000, ticks=1000, errors=2)
        result = availability_from_records([rec1, rec2], self.start, self.end)
        # uptime = 3600 + 11700 = 15300 of WINDOW_SEC; downtime = 7200
        self.assertEqual(result["uptimeSec"], 15300)
        self.assertEqual(result["downtimeSec"], 7200)
        self.assertEqual(result["availabilityPercent"], 68.0)
        self.assertEqual(result["connections"], 2)
        self.assertEqual(result["messagesReceived"], 3000)
        self.assertEqual(result["errors"], 2)
        self.assertEqual(result["measuredDays"], ["2026-06-01"])

    def test_orphaned_open_rows_do_not_double_count(self):
        # Three orphaned "open" rows (no disconnected_at — instances were hard
        # killed). Before the one-connection-at-a-time clamp, each claimed the
        # whole window through `now` and multiplied uptime beyond the window.
        recs = [
            _rec(_ist(2026, 6, 1, 9, 15), status="connected", messages=100),
            _rec(_ist(2026, 6, 1, 9, 20), status="connected", messages=200),
            _rec(_ist(2026, 6, 1, 9, 30), status="connected", messages=300),
        ]
        result = availability_from_records(recs, self.start, self.end, now=_utc(_ist(2026, 6, 1, 15, 30)))
        # Clamped sessions are contiguous 09:15 -> now: full window coverage,
        # never MORE than the eligible window (the regression this guards).
        self.assertEqual(result["uptimeSec"], WINDOW_SEC)
        self.assertEqual(result["availabilityPercent"], 100.0)
        self.assertLessEqual(result["uptimeSec"], result["measuredWindowSec"])
        self.assertEqual(result["connections"], 3)
        self.assertEqual(result["messagesReceived"], 600)

    def test_long_session_spans_several_trading_days(self):
        # 09:15 Monday -> 12:00 Wednesday, market-open counting only.
        rec = _rec(_ist(2026, 6, 1, 9, 15), disconnected=_ist(2026, 6, 3, 12, 0))
        start = _utc(_ist(2026, 6, 1, 0, 0))
        end = _utc(_ist(2026, 6, 4, 0, 0))
        result = availability_from_records([rec], start, end)
        # Full Mon + Tue windows + Wed 09:15-12:00 (9900s)
        self.assertEqual(result["uptimeSec"], 2 * WINDOW_SEC + 9900)
        self.assertEqual(result["measuredWindowSec"], 3 * WINDOW_SEC)
        self.assertLess(result["downtimeSec"], 2 * WINDOW_SEC)
        self.assertGreater(result["availabilityPercent"], 60.0)


class NewConnectionIdTest(unittest.TestCase):

    def test_readable_format(self):
        cid = new_connection_id()
        self.assertRegex(cid, r"^ws_\d{8}_\d{6}_[0-9a-f]{5}$")


class LiveSnapshotShapeTest(unittest.TestCase):

    def test_canonical_keys_present_without_connecting(self):
        ws_manager_mod = importlib.import_module("ws_socket.ws_manager")
        manager = ws_manager_mod.WebSocketManager()
        snap = manager.live_snapshot()
        expected = {
            "supervisorState", "state", "connected", "feedState", "connectionId",
            "sessionId", "connectedAt", "disconnectedAt", "disconnectReason",
            "disconnectReasonCode", "currentSessionUptimeSec", "lastMessageAt",
            "lastTickAt", "messagesReceived", "ticksReceived", "errorCount",
            "subscriptionCount", "subscriptionRegistryCount", "reconnectCount",
            "reconnectAttempt", "rates", "internetOk", "processStartedAt",
            "connectionHistoryCount", "market",
        }
        self.assertTrue(expected.issubset(set(snap.keys())), f"missing: {expected - set(snap.keys())}")
        self.assertIsInstance(snap["connected"], bool)
        rates = snap.get("rates") or {}
        self.assertIn("messages_per_second", rates)
        self.assertIn("ticks_per_second", rates)


if __name__ == "__main__":
    unittest.main()