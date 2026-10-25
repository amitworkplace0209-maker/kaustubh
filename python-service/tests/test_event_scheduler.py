"""Unified user-defined event scheduler — unit tests (DB-free).

Covers, WITHOUT a Mongo dependency:

  * the honest KINDS registry (every kind maps to a real description and a
    boolean ``requiresConfirm``);
  * ``_validate_schedule`` / ``_validate_params`` / ``_validate_notify`` —
    grammar errors, normalization (weekdays ⇒ Mon–Fri), dangerous-kind
    confirm coercion, leadMinutes bounds;
  * ``compute_next_run`` — daily/weekdays/weekly/once maths in Asia/Kolkata,
    weekend skipping, past one-shots ⇒ ``None`` (never fake-fired);
  * ``run_action`` — every kind dispatched to its REAL backend hook
    (mocked callables recorded) and the pytest-safe shutdown simulate path;
  * ``_event_public`` — serialization honesty (naive datetimes get UTC, ids
    stringify, lastError is bounded);
  * the ``_emit`` SSE envelope (same grammar the downloads engine uses);
  * the ``sched_events`` WS#3 channel — registration, cadences, the state
    signature (volatile serverNow/nextRun sub-bucket churn must NOT change
    it; enabled/status/counters/next-target MUST) and the builder.

Run:  python -m pytest tests/test_event_scheduler.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from unittest import mock
from zoneinfo import ZoneInfo

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services import event_scheduler as es
from services.market_scan import market_scan
from connection_engine import snapshots as snapshot_mod
from connection_engine.channels import STATE_CHANNELS

_TZ = "Asia/Kolkata"
_IST = ZoneInfo(_TZ)


def _utc(y: int, mo: int, d: int, h: int, mi: int) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


class KindRegistryTests(unittest.TestCase):
    """The registry is exhaustive, honest and explicit about danger."""

    def test_every_kind_has_real_metadata(self):
        self.assertEqual(
            set(es.KINDS), {
                "quality_scan", "atlas_cleanup", "flush_pipeline", "session_login",
                "session_logout", "square_off", "market_scan", "shutdown", "notify",
            },
        )
        for kind, meta in es.KINDS.items():
            self.assertTrue(meta["label"], kind)
            self.assertTrue(meta["description"], kind)
            self.assertIsInstance(meta["requiresConfirm"], bool)
        # real-money / service-life actions must demand confirmation
        self.assertTrue(es.KINDS["square_off"]["requiresConfirm"])
        self.assertTrue(es.KINDS["shutdown"]["requiresConfirm"])
        self.assertFalse(es.KINDS["notify"]["requiresConfirm"])


class ValidationTests(unittest.TestCase):
    def test_schedule_normalizes_weekdays(self):
        norm, err = es._validate_schedule({"type": "weekdays", "time": "09:30"})
        self.assertIsNone(err)
        self.assertEqual(norm["days"], [0, 1, 2, 3, 4])
        self.assertEqual(norm["timezone"], _TZ)

    def test_weekly_days_sorted_and_deduped(self):
        norm, err = es._validate_schedule({"type": "weekly", "time": "10:00", "days": [4, 0, 0]})
        self.assertIsNone(err)
        self.assertEqual(norm["days"], [0, 4])

    def test_bad_grammar_rejected(self):
        cases = [
            {"type": "hourly", "time": "10:00"},                       # unknown type
            {"type": "daily", "time": "24:00"},                        # bad hour
            {"type": "daily", "time": "9:30xx"},                       # bad format
            {"type": "daily", "time": "10:00", "timezone": "Mars/Olympus"},
            {"type": "weekly", "time": "10:00"},                       # no days
            {"type": "weekly", "time": "10:00", "days": [7]},          # day range
            {"type": "once", "time": "10:00"},                         # no date
            {"type": "once", "time": "10:00", "date": "2026-13-01"},   # bad date shape
        ]
        for schedule in cases:
            _, err = es._validate_schedule(schedule)
            self.assertTrue(err, schedule)

    def test_params_confirm_coercion(self):
        norm, err = es._validate_params("shutdown", {"confirm": 1, "junk": "kept"})
        self.assertIsNone(err)
        self.assertTrue(norm["confirm"])
        self.assertEqual(norm["junk"], "kept")
        norm2, _ = es._validate_params("notify", {"confirm": "yes"})
        self.assertNotIn("confirm", norm2)  # benign kinds are untouched

    def test_notify_defaults_and_bounds(self):
        norm, err = es._validate_notify({})
        self.assertIsNone(err)
        self.assertTrue(norm["onDevice"])
        self.assertEqual(norm["leadMinutes"], 5)
        self.assertTrue(norm["onCompletion"])
        _, err = es._validate_notify({"leadMinutes": 721})
        self.assertTrue(err)
        _, err = es._validate_notify({"leadMinutes": "soon"})
        self.assertTrue(err)
        norm3, err = es._validate_notify({"leadMinutes": 0, "onDevice": False})
        self.assertIsNone(err)
        self.assertEqual(norm3["leadMinutes"], 0)
        self.assertFalse(norm3["onDevice"])


class ComputeNextRunTests(unittest.TestCase):
    def test_daily_before_time_is_same_day(self):
        # now = 08:30 IST Sunday → the 09:30 slot is TODAY 04:00 UTC
        nxt = es.compute_next_run(
            {"type": "daily", "time": "09:30", "timezone": _TZ}, _utc(2026, 10, 25, 3, 0))
        self.assertEqual(nxt.astimezone(timezone.utc), _utc(2026, 10, 25, 4, 0))

    def test_daily_after_time_rolls_to_next_day(self):
        # now = 11:30 IST Sunday → 09:00 slots land Monday (weekday 0)
        base = _utc(2026, 10, 25, 6, 0)
        nxt = es.compute_next_run({"type": "daily", "time": "09:00", "timezone": _TZ}, base)
        self.assertIsNotNone(nxt)
        local = nxt.astimezone(_IST)
        self.assertEqual((local.hour, local.minute), (9, 0))
        self.assertEqual(local.weekday(), 0)
        self.assertGreater(nxt, base)

    def test_weekdays_skip_the_weekend(self):
        # Saturday 10:30 IST — the next WEEKDAYS 09:30 slot is Monday.
        base = datetime(2026, 10, 24, 5, 0, tzinfo=timezone.utc)
        nxt = es.compute_next_run({"type": "weekdays", "time": "09:30", "timezone": _TZ}, base)
        self.assertIsNotNone(nxt)
        self.assertEqual(nxt.astimezone(_IST).weekday(), 0)  # Monday

    def test_weekly_picks_the_next_listed_day(self):
        base = _utc(2026, 10, 25, 6, 0)  # Sunday 11:30 IST
        nxt = es.compute_next_run(
            {"type": "weekly", "time": "09:15", "days": [2, 0], "timezone": _TZ}, base)
        self.assertIsNotNone(nxt)
        local = nxt.astimezone(_IST)
        self.assertIn(local.weekday(), (0, 2))
        self.assertGreater(nxt, base)

    def test_once_past_is_none_and_future_is_exact(self):
        past = es.compute_next_run(
            {"type": "once", "time": "09:00", "date": "2026-01-01", "timezone": _TZ},
            _utc(2026, 10, 25, 4, 0))
        self.assertIsNone(past)
        future = es.compute_next_run(
            {"type": "once", "time": "23:59", "date": "2026-12-31", "timezone": _TZ},
            _utc(2026, 10, 25, 4, 0))
        self.assertEqual(future.astimezone(timezone.utc), _utc(2026, 12, 31, 18, 29))

    def test_once_with_broken_date_returns_none(self):
        self.assertIsNone(es.compute_next_run(
            {"type": "once", "time": "09:00", "date": "", "timezone": _TZ}, _utc(2026, 10, 25, 4, 0)))


class RunActionDispatchTests(unittest.IsolatedAsyncioTestCase):
    """Every kind reaches its real hook — mocked callee records the call."""

    async def test_quality_scan_hits_real_runner(self):
        with mock.patch("services.data_quality.run_scan",
                        mock.AsyncMock(return_value={"status": "success"})) as csr:
            out = await es.run_action("quality_scan", {})
        self.assertEqual(out, {"status": "success"})
        csr.assert_awaited_once()
        self.assertEqual(csr.await_args.kwargs.get("trigger"), "scheduled_event")

    async def test_flush_pipeline_reports_count(self):
        with mock.patch("services.tick_buffer.flush", mock.AsyncMock(return_value=42)):
            out = await es.run_action("flush_pipeline", {})
        self.assertEqual(out, {"flushed": 42})

    async def test_session_login_uses_scheduler_source(self):
        with mock.patch("scheduler.do_login", mock.AsyncMock(return_value=True)) as login:
            out = await es.run_action("session_login", {})
        self.assertEqual(out, {"success": True})
        self.assertEqual(login.await_args.kwargs.get("source"), "scheduler")

    async def test_cleanup_and_logout_pass_through(self):
        with mock.patch("services.atlas_cleanup.run_cleanup",
                        mock.AsyncMock(return_value={"status": "success", "totalDeleted": 3})), \
             mock.patch("scheduler.do_logout", mock.AsyncMock(return_value=True)):
            cleanup = await es.run_action("atlas_cleanup", {})
            logout = await es.run_action("session_logout", {})
        self.assertEqual(cleanup["totalDeleted"], 3)
        self.assertEqual(logout, {"success": True})

    async def test_notify_is_browser_delivered_not_faked(self):
        out = await es.run_action("notify", {})
        self.assertEqual(out, {"deliveredBy": "browser_notification"})

    async def test_market_scan_computes_off_the_loop(self):
        fake = mock.MagicMock(return_value={"scan": {"universeSize": 2716, "liveTokens": 512, "cycleMs": 12.5}})
        with mock.patch.object(market_scan, "compute", fake):
            out = await es.run_action("market_scan", {})
        self.assertEqual(out["universeSize"], 2716)
        fake.assert_called_once()

    async def test_shutdown_is_simulated_under_pytest(self):
        # pytest sets PYTEST_CURRENT_TEST — the exit path MUST be a no-op there.
        with mock.patch("services.tick_buffer.flush", mock.AsyncMock(return_value=7)), \
             mock.patch("scheduler.do_logout", mock.AsyncMock(return_value=True)) as logout:
            out = await es.run_action("shutdown", {"confirm": True})
        self.assertFalse(out["exitScheduled"])
        self.assertEqual(logout.await_args.kwargs.get("source"), "system")
        self.assertIn("simulated", out["steps"])

    async def test_unknown_kind_is_an_error_not_a_crash(self):
        out = await es.run_action("definitely_not_a_kind", {})
        self.assertIn("error", out)


class SerializationTests(unittest.TestCase):
    def test_event_public_is_honest(self):
        raw = {
            "_id": 12345,
            "name": "Night flush",
            "kind": "flush_pipeline",
            "enabled": True,
            "schedule": {"type": "daily", "time": "23:00", "timezone": _TZ},
            "notify": {"onDevice": True, "leadMinutes": 10, "onCompletion": False},
            "nextRun": datetime(2026, 10, 25, 17, 30),  # naive → UTC
            "lastRun": None,
            "lastStatus": "idle",
            "lastError": "x" * 500,
            "runCount": 3,
            "failCount": 1,
        }
        pub = es._event_public(raw)
        self.assertEqual(pub["id"], "12345")
        self.assertEqual(pub["nextRun"], "2026-10-25T17:30:00+00:00")
        self.assertIsNone(pub["lastRun"])
        self.assertEqual(len(pub["lastError"]), 200)
        self.assertEqual(pub["runCount"], 3)


class EmitEnvelopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_emit_uses_the_downloads_grammar(self):
        from services import event_bus

        with mock.patch.object(event_bus, "publish_event", mock.AsyncMock()) as pub:
            await es._emit("SCHEDULE_COMPLETED", "evt1", "Night flush", {"status": "success"})
        body = pub.await_args.args[0]
        self.assertEqual(body["event"], "SCHEDULE_COMPLETED")
        self.assertEqual(body["scheduleId"], "evt1")
        self.assertEqual(body["scheduleName"], "Night flush")
        self.assertEqual(body["origin"], "event_scheduler")
        self.assertIn("ts", body)
        self.assertIn("eventId", body)


class SchedEventsChannelTests(unittest.IsolatedAsyncioTestCase):
    """The WS#3 channel: registration, cadences, signature, builder."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.doc = {
            "generatedAt": "2026-10-25T06:00:00+00:00",
            "serverNow": "2026-10-25T06:00:00+00:00",
            "timezone": _TZ,
            "count": 2,
            "kinds": [{"kind": k, "label": k, "description": "d", "requiresConfirm": False}
                      for k in es.KINDS],
            "events": [
                {"id": "evt1", "name": "Night flush", "kind": "flush_pipeline", "enabled": True,
                 "nextRun": "2026-10-25T17:30:00+00:00", "lastStatus": "success",
                 "runCount": 3, "failCount": 0, "lastResult": {"flushed": 2}},
                {"id": "evt2", "name": "Morning logout", "kind": "session_logout", "enabled": False,
                 "nextRun": None, "lastStatus": "failed",
                 "runCount": 9, "failCount": 2, "lastResult": None},
            ],
        }

    def test_channel_registered(self):
        self.assertIn("sched_events", STATE_CHANNELS)
        self.assertIn("sched_events", snapshot_mod.SNAPSHOT_CHANNELS)
        self.assertTrue(snapshot_mod.supports_snapshot("sched_events"))
        self.assertEqual(snapshot_mod.CHANNEL_REFRESH_INTERVALS.get("sched_events"), 10.0)
        self.assertEqual(snapshot_mod.CHANNEL_FORCE_REFRESH_INTERVALS.get("sched_events"), 20.0)

    def _sig(self, doc: dict) -> str:
        return snapshot_mod.channel_signature("sched_events", doc)

    def test_signature_ignores_volatile_and_counts_real_state(self):
        base = deepcopy(self.doc)

        # serverNow/generatedAt + intra-bucket nextRun churn → SAME signature
        volatile = deepcopy(base)
        volatile["serverNow"] = "2026-10-25T06:00:07+00:00"
        volatile["generatedAt"] = "2026-10-25T06:00:07+00:00"
        volatile["events"][0]["nextRun"] = "2026-10-25T17:35:00+00:00"  # < 10 min shift
        volatile["events"][0]["lastResult"] = {"flushed": 999}
        self.assertEqual(self._sig(base), self._sig(volatile))

        # enabled flip, status change, counter change → REAL changes
        d2 = deepcopy(base)
        d2["events"][0]["enabled"] = False
        self.assertNotEqual(self._sig(base), self._sig(d2))
        d3 = deepcopy(base)
        d3["events"][1]["lastStatus"] = "success"
        self.assertNotEqual(self._sig(base), self._sig(d3))
        d4 = deepcopy(base)
        d4["events"][1]["runCount"] = 10
        self.assertNotEqual(self._sig(base), self._sig(d4))

        # nextRun crossing a 10-minute bucket → a real target change
        d5 = deepcopy(base)
        d5["events"][0]["nextRun"] = "2026-10-25T18:30:00+00:00"
        self.assertNotEqual(self._sig(base), self._sig(d5))

    async def test_builder_serves_events_and_kinds(self):
        with mock.patch("services.event_scheduler.state_document",
                        mock.AsyncMock(return_value=self.doc)):
            out = await snapshot_mod.build_snapshot("sched_events")
        self.assertIsNotNone(out)
        self.assertEqual(out["count"], 2)
        self.assertIn("kinds", out)
        self.assertIn("serverNow", out)

    async def test_builder_returns_none_while_warming(self):
        with mock.patch("services.event_scheduler.state_document",
                        mock.AsyncMock(return_value=None)):
            self.assertIsNone(await snapshot_mod.build_snapshot("sched_events"))


if __name__ == "__main__":
    unittest.main()
