"""Tests for the paper-terminal vs scheduled-feed separation.

The scheduler drives the DAILY LIFECYCLE (login -> session -> WebSocket ->
ticks -> Data Saver) for whichever broker is ENABLED on the schedule. The
"terminal" is a separate concept: it decides which broker receives ORDERS.

These two were previously conflated by a gate keyed on ``is_dummy_mode()``.
That parked the entire lifecycle whenever the Dummy paper engine was the
active trading terminal, so the scheduled Kotak login never ran, the market
feed never came up, and ``do_login()`` returned True without ever contacting
the broker (a fabricated success).

The invariant enforced here:
  * a Dummy TRADING TERMINAL must never disable the scheduled lifecycle, and
  * a genuinely dummy SCHEDULED FEED still never triggers a real login.
"""
from __future__ import annotations

import asyncio
import sys
import time
import unittest
from unittest.mock import patch, MagicMock, AsyncMock

sys.path.insert(0, r"C:\project\python-service")


class TestScheduledFeedDecision(unittest.TestCase):
    """_scheduled_feed_is_dummy() is the single gate for the paper-feed case."""

    def test_false_when_a_real_broker_is_enabled(self):
        from scheduler import _scheduled_feed_is_dummy
        with patch("scheduler._enabled_brokers_now", return_value=("kotak",)):
            self.assertFalse(_scheduled_feed_is_dummy())

    def test_true_only_when_every_scheduled_broker_is_dummy(self):
        from scheduler import _scheduled_feed_is_dummy
        with patch("scheduler._enabled_brokers_now", return_value=("dummy",)):
            self.assertTrue(_scheduled_feed_is_dummy())

    def test_dummy_terminal_does_not_make_the_feed_dummy(self):
        """The active trading terminal is irrelevant to the feed decision."""
        from scheduler import _scheduled_feed_is_dummy
        with patch("scheduler._enabled_brokers_now", return_value=("kotak",)), \
             patch("brokers.manager.is_dummy_mode", return_value=True):
            self.assertFalse(
                _scheduled_feed_is_dummy(),
                "A Dummy trading terminal must not park the scheduled broker feed",
            )


class TestSchedulerDummyGate(unittest.IsolatedAsyncioTestCase):
    """The gate keys on the scheduled feed, never on the trading terminal."""

    def _make_scheduler(self):
        """Create a minimal SchedulerController for testing the gate.

        Lock types mirror production (scheduler/__init__.py:364-367):
        ``_lock``/``_exec_lock`` are threading locks, ``_busy_lock`` is async.
        """
        import threading

        from scheduler import SchedulerController
        sc = SchedulerController.__new__(SchedulerController)
        sc._lock = threading.RLock()
        sc._busy_lock = asyncio.Lock()
        sc._exec_lock = threading.Lock()
        sc._state = "STARTING"
        sc._login_attempts = 0
        sc._next_login_attempt_at = 0.0
        sc._login_error = None
        sc._session_owner = None
        sc._manual_expire_at = None
        sc._tick_seconds = 5.0
        sc._is_running = lambda: True
        sc._set_state = lambda state, reason="", **kw: setattr(sc, "_state", state)
        return sc

    async def test_do_login_proceeds_when_only_the_terminal_is_dummy(self):
        """Dummy paper terminal + enabled Kotak => the real login must run."""
        sc = self._make_scheduler()
        called = {"impl": False}

        async def fake_impl(*a, **kw):
            called["impl"] = True
            return True

        sc._do_login_impl = fake_impl
        sc._session_owner = None

        with patch("scheduler._scheduled_feed_is_dummy", return_value=False), \
             patch("brokers.manager.is_dummy_mode", return_value=True), \
             patch("scheduler.kotak_session") as mock_kotak:
            mock_kotak.session_active = False
            result = await sc.do_login(source="scheduler")

        self.assertTrue(result)
        self.assertTrue(
            called["impl"],
            "A Dummy trading terminal must NOT suppress the scheduled broker login",
        )

    async def test_do_login_skipped_when_scheduled_feed_is_dummy(self):
        """A genuinely dummy scheduled feed still never logs in for real."""
        sc = self._make_scheduler()
        called = {"impl": False}

        async def fake_impl(*a, **kw):
            called["impl"] = True
            return True

        sc._do_login_impl = fake_impl

        with patch("scheduler._scheduled_feed_is_dummy", return_value=True):
            result = await sc.do_login(source="scheduler")

        self.assertTrue(result)
        self.assertFalse(called["impl"], "dummy scheduled feed must not hit the broker")

    def test_notify_auth_failure_recovers_when_only_terminal_is_dummy(self):
        """An expired broker session must recover even on the paper terminal."""
        sc = self._make_scheduler()
        sc.request_reconcile = MagicMock()

        with patch("scheduler._scheduled_feed_is_dummy", return_value=False), \
             patch("brokers.manager.is_dummy_mode", return_value=True), \
             patch("scheduler.kotak_session") as mock_kotak:
            sc.notify_auth_failure()
            mock_kotak.mark_session_expired.assert_called_once()
            sc.request_reconcile.assert_called_once()

    def test_notify_auth_failure_skipped_for_dummy_scheduled_feed(self):
        sc = self._make_scheduler()
        sc.request_reconcile = MagicMock()

        with patch("scheduler._scheduled_feed_is_dummy", return_value=True), \
             patch("scheduler.kotak_session") as mock_kotak:
            sc.notify_auth_failure()
            mock_kotak.mark_session_expired.assert_not_called()
            sc.request_reconcile.assert_not_called()


class TestActiveTerminalPersistence(unittest.TestCase):
    """active_terminal() must restore mode from the persisted terminal_mode setting."""

    def test_reads_persisted_mode_from_runtime_cache(self):
        """After restart, active_terminal() returns the persisted mode."""
        from brokers.manager import TERMINALS
        with patch("brokers.manager.session_manager") as mock_sm, \
             patch("services.runtime_settings.get_runtime_setting", return_value="dummy"):
            mock_sm.snapshot.return_value = {}
            from brokers.manager import active_terminal
            mode = active_terminal()
            self.assertEqual(mode, "dummy")

    def test_session_mode_takes_priority(self):
        """Session mode (set by switch_terminal) takes priority over persisted."""
        from brokers.manager import TERMINALS
        with patch("brokers.manager.session_manager") as mock_sm, \
             patch("services.runtime_settings.get_runtime_setting", return_value="kotak"):
            mock_sm.snapshot.return_value = {"mode": "dummy"}
            from brokers.manager import active_terminal
            mode = active_terminal()
            self.assertEqual(mode, "dummy")

    def test_falls_back_to_env_when_no_persisted_mode(self):
        """If no persisted mode and no session, falls back to env default."""
        with patch("brokers.manager.session_manager") as mock_sm, \
             patch("services.runtime_settings.get_runtime_setting", return_value=None), \
             patch("brokers.manager.settings") as mock_settings:
            mock_sm.snapshot.return_value = {}
            mock_settings.broker_mode = "kotak"
            from brokers.manager import active_terminal
            mode = active_terminal()
            self.assertEqual(mode, "kotak")


class TestSearchEngineInstrumentLoading(unittest.TestCase):
    """search_engine must properly load instruments from both sources."""

    def test_loads_from_json_dict(self):
        """The JSON file is {instruments:[...]} not a plain list."""
        from core.engines.search_engine import SearchEngine

        engine = SearchEngine()
        instruments = [
            {"symbol": "RELIANCE", "token": "1234", "exchangeSegment": "nse_cm",
             "companyName": "Reliance Industries", "series": "EQ", "instrumentType": "EQ"},
            {"symbol": "TCS", "token": "5678", "exchangeSegment": "nse_cm",
             "companyName": "Tata Consultancy", "series": "EQ", "instrumentType": "EQ"},
            {"symbol": "INFY", "token": "9012", "exchangeSegment": "nse_cm",
             "companyName": "Infosys Ltd", "series": "EQ", "instrumentType": "EQ"},
        ]

        with patch("services.instrument_cache.instrument_cache") as mock_cache:
            mock_cache.get_instruments.return_value = instruments
            engine._instruments = []
            engine._load_instruments()

        self.assertEqual(len(engine._instruments), 3)
        self.assertTrue(engine._built)
        results = engine.search("RELIANCE")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["symbol"], "RELIANCE")

    def test_get_instruments_thread_safe(self):
        """InstrumentCache.get_instruments returns empty list when not loaded."""
        from services.instrument_cache import InstrumentCache
        cache = InstrumentCache()
        self.assertEqual(cache.get_instruments(), [])

        # After loading mock data
        cache._instruments = [{"symbol": "TEST", "token": "1"}]
        cache._loaded = True
        result = cache.get_instruments()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["symbol"], "TEST")
        # Verify it's a copy, not the original list
        cache._instruments.append({"symbol": "TEST2", "token": "2"})
        self.assertEqual(len(result), 1, "get_instruments should return a snapshot copy")


class TestWSFlatTick(unittest.TestCase):
    """WebSocketEngine._flat_tick produces the consumer contract shape."""

    def test_normalizes_canonical_to_flat(self):
        from ws_socket.engine.engine import WebSocketEngine
        canonical = {
            "instrument_token": "2885",
            "exchange_segment": "nse_cm",
            "trading_symbol": "RELIANCE-EQ",
            "broker_timestamp": 1234.0,
            "source": "kotak_neo_sfeed",
            "fields": {
                "ltp": 2501.5,
                "volume": 100,
                "open": 2490.0,
                "high": 2510.0,
                "low": 2480.0,
                "prev_close": 2499.0,
                "net_change": 2.5,
                "net_change_percent": 0.1,
            },
        }
        flat = WebSocketEngine._flat_tick(canonical, received_at=9999.0)
        self.assertEqual(flat["instrumentToken"], "2885")
        self.assertEqual(flat["exchangeSegment"], "nse_cm")
        self.assertEqual(flat["symbol"], "RELIANCE-EQ")
        self.assertEqual(flat["ltp"], 2501.5)
        self.assertEqual(flat["volume"], 100)
        self.assertEqual(flat["open"], 2490.0)
        self.assertEqual(flat["high"], 2510.0)
        self.assertEqual(flat["low"], 2480.0)
        self.assertEqual(flat["timestamp"], 1234.0)
        self.assertEqual(flat["source"], "kotak_neo_sfeed")
        # None fields are stripped
        self.assertNotIn("close", flat)


class TestRuntimeSettingsTerminalMode(unittest.TestCase):
    """terminal_mode is in LIVE_KEYS so it's cached and sync-readable."""

    def test_terminal_mode_in_live_keys(self):
        from services.runtime_settings import LIVE_KEYS
        self.assertIn("terminal_mode", LIVE_KEYS)

    def test_get_runtime_setting_reads_terminal_mode(self):
        import services.runtime_settings as rs_mod
        with rs_mod._lock:
            rs_mod._cache["terminal_mode"] = "dummy"
        try:
            result = rs_mod.get_runtime_setting("terminal_mode")
            self.assertEqual(result, "dummy")
        finally:
            with rs_mod._lock:
                rs_mod._cache.pop("terminal_mode", None)


if __name__ == "__main__":
    unittest.main()
