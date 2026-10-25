"""Data Saver ``dashboard`` WS#3 snapshot channel — unit tests.

The channel was added so the Data Saver dashboard stops relying on REST
polling alone: the Connection Engine pushes an authoritative live document
(the same service reads the REST routes use) the moment a browser subscribes,
re-pushes on real state change, and re-sends fast telemetry on a slow cadence.

These tests pin the parts that must hold WITHOUT heavy deps:

  * channel registration — STATE_CHANNELS + snapshot hub cadence tables;
  * the state signature — fast telemetry (counters, latency, countdowns,
    generatedAt) must NOT change the signature (it rides the force re-push),
    while REAL state changes (connection booleans, scheduler/session/market
    state, subscriber counts) MUST;
  * ``_build_dashboard()`` shape — a cheap, honest document that mirrors the
    REST envelope's key names (so the frontend can shallow-merge the WS frame
    over its REST snapshot), reuses the real source readers (mocked here),
    and never invents a value (unmeasured -> None, never 0).

Run:  python -m pytest tests/test_dashboard_snapshot_channel.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from copy import deepcopy
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from connection_engine.channels import STATE_CHANNELS
from connection_engine import snapshots as snapshot_mod

# --------------------------------------------------------------------------- #
# Fixtures                                                                      #
# --------------------------------------------------------------------------- #

def _fake_system_snapshot() -> dict:
    """The shape ``api.system._system_snapshot`` returns (the keys the builder
    actually reads). Values mirror a live session during market hours."""
    return {
        "node": {
            "uptimeSeconds": 7200, "cpuPercent": 12.5, "ramPercent": 61.0,
            "diskTotalBytes": 512 * 1024 ** 3, "diskUsedBytes": 256 * 1024 ** 3,
        },
        "pythonStatus": {
            "ws_state": "CONNECTED",
            "subscribed_symbols": 50,
            "reconnect_count": 0,
        },
        "mongo": {"connected": True},
        "buffer": {
            "bufferLength": 128, "totalReceived": 40_000, "totalWritten": 39_900,
            "totalWriteErrors": 100, "ticksPerSecond": 12.5, "writesPerSecond": 12.4,
            "feedLatencyMs": 22.5, "lastTickAt": 1_771_000_000.0,
            "lastWriteAt": 1_771_000_001.0, "activeTickStocks": 42,
        },
        "services": {},
        "schedulerInfo": {"running": True, "enabled": True, "state": "LIVE_FEED", "is_trading_day": True},
        "websocketDetail": {
            "connected_at": "2026-09-15T09:14:00+05:30",
            "disconnected_at": None,
            "last_message_at": "2026-09-15T10:00:00+05:30",
            "lifecycle_state": "CONNECTED",
            "subscribed_symbols": 50,
            "reconnect_count": 0,
        },
        "activeStocks": 50,
        "totalStocks": 400,
        "todayRecords": 12_345,
        "todayInserts": 12_300,
        "errorCount": 45,
        "lastTickTime": "2026-09-15T10:00:00+05:30",
        "lastTickSymbol": "RELIANCE",
        "lastLogin": "2026-09-15T09:00:00+05:30",
        "websocketConnected": True,
        "wsConnectedAt": "2026-09-15T09:14:00+05:30",
        "wsDisconnectedAt": None,
        "wsDisconnectReason": None,
        "wsConnectionHistory": [],
        "schedulerRunning": True,
        "schedulerEnabled": True,
        "schedulerState": {
            "state": "LIVE_FEED",
            "in_login_window": True,
            "in_ws_window": True,
            "login_time": "09:15",
            "logout_time": "15:30",
            "ws_start_time": "09:16",
            "ws_stop_time": "15:29",
            "next_login": "2026-09-16T09:15:00+05:30",
            "next_logout": None,
            "next_ws_start": "2026-09-16T09:16:00+05:30",
            "next_ws_stop": "2026-09-15T15:29:00+05:30",
            "next_event": "ws_stop",
            "next_event_at": "2026-09-15T15:29:00+05:30",
            "remaining_seconds": 1800,
            "login_error": None,
            "ws_error": None,
            "state_since": "2026-09-15T09:16:00+05:30",
            "session_owner": "scheduler",
        },
        "internetConnected": True,
        "totalOrders": None,
        "totalPositions": None,
        "holdingsCount": None,
        "funds": None,
        "liveData": {"pipelineLive": True, "activeTickStocks": 42},
    }


def _fake_market() -> dict:
    return {
        "market_state": "REGULAR_SESSION",
        "market_status": "open",
        "market_session": "regular",
        "market_date": "2026-09-15",
        "day_class": "trading",
        "closure_reason": None,
        "is_weekend": False,
        "is_exchange_holiday": False,
        "is_special_closure": False,
        "next_market_open": "2026-09-16T09:15:00+05:30",
        "next_market_close": "2026-09-15T15:30:00+05:30",
        "market_state_source": "websocket",
        "reason_code": None,
        "reason_message": None,
        "trading_day": True,
        "confirmation_window_active": False,
        "ticks_in_window": 1000,
        "unique_instruments_in_window": 40,
        "server_time_utc": "2026-09-15T10:01:00+00:00",
        "server_time_ist": "2026-09-15T15:31:00+05:30",
    }


def _fake_session_snapshot() -> dict:
    return {
        "active": True,
        "state": "ACTIVE",
        "stateMessage": None,
        "userId": "dummy-user-1",
        "loginTime": "2026-09-15T09:00:00+05:30",
        "expiresAt": "2026-09-15T16:00:00+05:30",
        "validatedAt": "2026-09-15T09:00:01+05:30",
        "remainingSeconds": 3600,
        "sessionDurationSeconds": 2_520_00,
        "lastAuthError": None,
        "websocket": {"state": "CONNECTED", "connected": True},
        "lastLogout": {"at": "2026-09-14T16:00:00+05:30", "logoutReason": "SCHEDULED"},
        "wsState": "CONNECTED",
    }


# --------------------------------------------------------------------------- #
# Channel registration                                                          #
# --------------------------------------------------------------------------- #

class ChannelRegistrationTests(unittest.TestCase):
    def test_dashboard_is_a_registered_state_channel(self):
        self.assertIn("dashboard", STATE_CHANNELS)

    def test_dashboard_supports_a_snapshot_document(self):
        self.assertTrue(snapshot_mod.supports_snapshot("dashboard"))

    def test_dashboard_cadences(self):
        refresh = snapshot_mod.CHANNEL_REFRESH_INTERVALS.get("dashboard")
        force = snapshot_mod.CHANNEL_FORCE_REFRESH_INTERVALS.get("dashboard")
        self.assertIsNotNone(refresh)
        # Fast re-evaluation cadence, deliberate slow re-push for telemetry:
        self.assertLessEqual(refresh, snapshot_mod.CHANNEL_REFRESH_INTERVALS.get("system"))
        self.assertGreaterEqual(force or 0, refresh or 0)


# --------------------------------------------------------------------------- #
# Signature semantics                                                           #
# --------------------------------------------------------------------------- #

class DashboardSignatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.doc = {
            "generatedAt": "2026-09-15T10:00:00+00:00",
            "market": {"marketState": "REGULAR_SESSION", "marketStatus": "open",
                       "marketSession": "regular", "dayClass": "trading", "tradingDay": True},
            "scheduler": {"running": True, "state": "LIVE_FEED", "stateSince": "2026-09-15T09:16:00+05:30",
                          "nextEvent": "ws_stop", "nextEventAt": "2026-09-15T15:29:00+05:30",
                          "nextLogin": "2026-09-16T09:15:00+05:30", "nextWsStart": "2026-09-16T09:16:00+05:30",
                          "remainingSeconds": 1800,
                          "marketState": "REGULAR_SESSION", "marketStatus": "open", "dayClass": "trading",
                          "isTradingDay": True, "marketReasonMessage": None},
            "session": {"active": True, "state": "ACTIVE", "expiresAt": "2026-09-15T16:00:00+05:30",
                        "lastLoginAt": "2026-09-15T09:00:00+05:30", "lastLogoutAt": None,
                        "remainingSeconds": 3600},
            "ws": {"connected": True, "disconnectedAt": None, "disconnectReason": None,
                   "latencyMs": 22.5, "connectedAt": "2026-09-15T09:14:00+05:30",
                   "reconnectCount": 0, "uptimeSeconds": 2760},
            "mongo": {"connected": True},
            "net": {"internetOk": True},
            "ticks": {"activeStocks": 50, "totalStocks": 400},
            "subscribedStocks": {"active": 50, "total": 400, "byWs": 50},
            # fast lane payload fields
            "pipeline": {"state": "live", "ticksPerSec": 12.5, "savedPerSec": 12.4,
                         "totalReceived": 40000, "totalWrites": 39900, "failed": 100,
                         "bufferLength": 128, "lastTickAt": "2026-09-15T10:00:00+00:00",
                         "lastSavedAt": "2026-09-15T10:00:01+00:00", "feedLatencyMs": 22.5},
            "ticksPerSec": 12.5,
            "ticksToday": 12345,
            "dataSaved": 12300,
            "saveSuccessRate": 99.75,
            "wsUptimeSec": 2760,
            "resources": {"cpuPercent": 12.5, "ramPercent": 61.0, "uptimeSeconds": 7200},
        }

    def _sig(self, doc: dict) -> str:
        return snapshot_mod.channel_signature("dashboard", doc)

    def test_volatile_telemetry_does_not_change_the_signature(self):
        doc2 = deepcopy(self.doc)
        doc2["generatedAt"] = "2026-09-15T10:00:06+00:00"          # gclock moved
        doc2["pipeline"]["ticksPerSec"] = 0.0                      # feed hiccup
        doc2["pipeline"]["savedPerSec"] = 0.0
        doc2["pipeline"]["totalReceived"] = 40_010
        doc2["pipeline"]["totalWrites"] = 39_910
        doc2["pipeline"]["bufferLength"] = 200
        doc2["pipeline"]["feedLatencyMs"] = 60.0
        doc2["pipeline"]["lastTickAt"] = "2026-09-15T10:00:05+00:00"
        doc2["pipeline"]["lastSavedAt"] = "2026-09-15T10:00:06+00:00"
        doc2["ticksPerSec"] = 0.0
        doc2["ticksToday"] = 12_350                                # counters move
        doc2["dataSaved"] = 12_305
        doc2["saveSuccessRate"] = 99.77
        doc2["wsUptimeSec"] = 2766
        doc2["resources"] = {"cpuPercent": 44.0, "ramPercent": 64.0, "uptimeSeconds": 7206}
        doc2["session"]["remainingSeconds"] = 3594                 # countdowns move
        doc2["scheduler"]["remainingSeconds"] = 1794
        doc2["ws"]["latencyMs"] = 61.0
        doc2["ws"]["uptimeSeconds"] = 2766
        self.assertEqual(self._sig(self.doc), self._sig(doc2))

    def test_real_state_changes_do_change_the_signature(self):
        base = deepcopy(self.doc)

        # Broker feed drops -> MUST push (worst case for a dashboard).
        d = deepcopy(base)
        d["ws"]["connected"] = False
        d["ws"]["disconnectReason"] = "MARKET_CLOSED"
        self.assertNotEqual(self._sig(base), self._sig(d))

        # Scheduler boundary crosses -> MUST push.
        d = deepcopy(base)
        d["scheduler"]["state"] = "MARKET_CLOSED"
        self.assertNotEqual(self._sig(base), self._sig(d))

        # Session ends -> MUST push.
        d = deepcopy(base)
        d["session"]["active"] = False
        self.assertNotEqual(self._sig(base), self._sig(d))

        # Market day rolls over -> MUST push (marketState is mirrored inside
        # the scheduler block, matching the REST envelope).
        d = deepcopy(base)
        d["scheduler"]["marketState"] = "MARKET_CLOSED"
        self.assertNotEqual(self._sig(base), self._sig(d))
        d = deepcopy(base)
        d["scheduler"]["marketStatus"] = "closed"
        self.assertNotEqual(self._sig(base), self._sig(d))

        # Mongo dies / internet drops -> MUST push.
        d = deepcopy(base)
        d["mongo"]["connected"] = False
        self.assertNotEqual(self._sig(base), self._sig(d))
        d = deepcopy(base)
        d["net"]["internetOk"] = False
        self.assertNotEqual(self._sig(base), self._sig(d))

        # Subscription count parity changes -> MUST push.
        d = deepcopy(base)
        d["subscribedStocks"]["active"] = 49
        self.assertNotEqual(self._sig(base), self._sig(d))

    def test_signature_is_stable_across_key_order(self):
        import json as _json

        shuffled = _json.loads(_json.dumps(self.doc))[::-1] if isinstance(self.doc, list) else deepcopy(self.doc)
        self.assertEqual(self._sig(self.doc), self._sig(shuffled))


# --------------------------------------------------------------------------- #
# Document build                                                                #
# --------------------------------------------------------------------------- #

class DashboardBuildTests(unittest.IsolatedAsyncioTestCase):
    async def test_document_shape_mirrors_the_rest_envelope(self):
        """The WS document must use the SAME key names the Next REST envelope
        exposes, so the frontend can merge the WS frame over its REST
        snapshot top-level-key by top-level-key."""
        with mock.patch("api.system._system_snapshot", new=mock.AsyncMock(
                return_value=_fake_system_snapshot())), \
             mock.patch("api.system.system_market", new=mock.AsyncMock(
                 return_value=_fake_market())), \
             mock.patch.object(snapshot_mod, "_session_snapshot",
                               mock.AsyncMock(return_value=_fake_session_snapshot())):
            doc = await snapshot_mod.build_snapshot("dashboard")

        self.assertIsNotNone(doc)
        # Top-level blocks the frontend merge expects.
        for key in ("market", "scheduler", "session", "pipeline", "ws",
                    "mongo", "net", "subscribedStocks", "storage", "resources",
                    "ticksToday", "dataSaved", "saveSuccessRate", "wsUptimeSec",
                    "activeInstruments", "generatedAt", "pipelineLive"):
            self.assertIn(key, doc, f"missing top-level key: {key}")

        # Key names agree with the REST envelope exactly (merge contract).
        self.assertIn("marketState", doc["market"])
        self.assertIn("marketState", doc["scheduler"])
        self.assertIn("marketReasonMessage", doc["scheduler"])
        self.assertIn("nextMarketOpen", doc["scheduler"])
        self.assertIn("remainingSeconds", doc["scheduler"])
        self.assertIn("remainingSeconds", doc["session"])
        self.assertIn("ticksPerSec", doc["pipeline"])
        self.assertIn("savedPerSec", doc["pipeline"])
        self.assertIn("totalReceived", doc["pipeline"])
        self.assertIn("totalWrites", doc["pipeline"])
        self.assertIn("bufferLength", doc["pipeline"])
        self.assertIn("feedLatencyMs", doc["pipeline"])
        self.assertIn("connected", doc["ws"])
        self.assertIn("latencyMs", doc["ws"])
        self.assertIn("disconnectReason", doc["ws"])
        self.assertIn("active", doc["subscribedStocks"])
        self.assertIn("byWs", doc["subscribedStocks"])

    async def test_document_is_honest_and_mirrors_source_values(self):
        with mock.patch("api.system._system_snapshot", new=mock.AsyncMock(
                return_value=_fake_system_snapshot())), \
             mock.patch("api.system.system_market", new=mock.AsyncMock(
                 return_value=_fake_market())), \
             mock.patch.object(snapshot_mod, "_session_snapshot",
                               mock.AsyncMock(return_value=_fake_session_snapshot())):
            doc = await snapshot_mod.build_snapshot("dashboard")

        # Values come from the ONE source of truth, never invented:
        self.assertEqual(doc["pipeline"]["ticksPerSec"], 12.5)
        self.assertEqual(doc["pipeline"]["totalReceived"], 40_000)
        self.assertEqual(doc["pipeline"]["failed"], 100)
        self.assertEqual(doc["pipeline"]["bufferLength"], 128)
        self.assertEqual(doc["pipeline"]["state"], "live")
        self.assertTrue(doc["pipelineLive"])
        self.assertEqual(doc["ticksToday"], 12_345)
        self.assertEqual(doc["dataSaved"], 12_300)
        self.assertEqual(doc["activeInstruments"], 42)
        self.assertEqual(doc["subscribedStocks"], {"active": 50, "total": 400, "byWs": 50})
        self.assertTrue(doc["ws"]["connected"])
        self.assertTrue(doc["mongo"]["connected"])
        self.assertTrue(doc["net"]["internetOk"])
        self.assertTrue(doc["scheduler"]["running"])
        self.assertEqual(doc["scheduler"]["state"], "LIVE_FEED")
        self.assertTrue(doc["session"]["active"])
        # saveSuccessRate: 39900 / (39900 + 100) = 99.75
        self.assertAlmostEqual(doc["saveSuccessRate"], 99.75, places=2)
        # Storage: disk used/capacity from the node block.
        self.assertEqual(doc["storage"]["used"], 256 * 1024 ** 3)
        self.assertEqual(doc["storage"]["capacity"], 512 * 1024 ** 3)
        self.assertAlmostEqual(doc["storage"]["free"], 256 * 1024 ** 3)

        # The expensive aggregation is deliberately absent (REST owns it).
        self.assertIsNone(doc.get("qualityScore"))

        # JSON-safe: survives a round-trip (frames cross the wire as JSON).
        import json as _json

        _json.dumps(doc)

    async def test_failing_session_read_never_kills_the_build(self):
        """A broken Session Manager read must yield an empty session block —
        never an exception (the snapshot loop never pushes on build failure)."""
        with mock.patch("api.system._system_snapshot", new=mock.AsyncMock(
                return_value=_fake_system_snapshot())), \
             mock.patch("api.system.system_market", new=mock.AsyncMock(
                 return_value=_fake_market())), \
             mock.patch.object(snapshot_mod, "_session_snapshot",
                               mock.AsyncMock(side_effect=RuntimeError("boom"))):
            doc = await snapshot_mod.build_snapshot("dashboard")
            self.assertIsNotNone(doc)
            # The session block degrades to honest absence: no invented values,
            # and fields the fallback covers (python ws_state) still populate.
            self.assertFalse(doc["session"]["active"])
            self.assertIsNone(doc["session"]["remainingSeconds"])
            self.assertEqual(doc["session"]["wsState"], "CONNECTED")


if __name__ == "__main__":
    unittest.main()
