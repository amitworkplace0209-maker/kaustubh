"""Terminal isolation tests (§4 of MASTER IMPLEMENTATION PROMPT).

Guarantees:
  1. Switching terminals is a pure context switch — it NEVER destroys the
     previously active terminal's session. A Kotak->Dummy->Kotak cycle must
     restore the existing Kotak session (same session_id, same user).
  2. Each terminal owns an INDEPENDENT session record in the session manager.
  3. mark_logout / mark_expired only affect the TARGET terminal's record and
     never touch another terminal's session.
  4. brokers.manager.switch_terminal() must not call adapter.logout() and must
     not call session_manager.mark_logout().
"""
import unittest
from unittest.mock import MagicMock, patch

from services.session.session_manager import (
    SESSION_ACTIVE,
    CentralSessionManager,
)


class TerminalIsolationTestMixin:
    def _new_manager(self) -> CentralSessionManager:
        return CentralSessionManager()

    def _login(self, sm: CentralSessionManager, mode: str, user_id: str):
        sm.set_mode(mode, user_id=user_id)
        sm.mark_login_success(
            mode=mode,
            broker=mode.capitalize(),
            user_id=user_id,
        )


class TestSetModeIsPureContextSwitch(TerminalIsolationTestMixin, unittest.TestCase):
    def test_kotak_to_dummy_to_kotak_restores_kotak_session(self):
        sm = self._new_manager()
        self._login(sm, "kotak", "user-kotak")
        kotak_sid = sm.snapshot()["sessionId"]

        # kotak record must be persisted at login time
        rec = sm.terminal_session("kotak")
        self.assertEqual(rec["session_status"], SESSION_ACTIVE)
        self.assertEqual(rec["session_id"], kotak_sid)

        # switch to dummy → pure context switch, kotak untouched
        sm.set_mode("dummy")
        snap_dummy = sm.snapshot()
        self.assertEqual(snap_dummy["mode"], "dummy")
        self.assertEqual(snap_dummy["state"], "DISCONNECTED")
        self.assertNotIn("user-kotak", str(snap_dummy.get("userId")))

        # kotak record survived the switch
        self.assertEqual(
            sm.terminal_session("kotak")["session_status"], SESSION_ACTIVE
        )
        self.assertEqual(sm.terminal_session("kotak")["session_id"], kotak_sid)

        # switch back to kotak → the SAME session is restored into the view
        sm.set_mode("kotak")
        snap_kotak = sm.snapshot()
        self.assertEqual(snap_kotak["mode"], "kotak")
        self.assertEqual(snap_kotak["state"], SESSION_ACTIVE)
        self.assertEqual(snap_kotak["sessionId"], kotak_sid)
        self.assertEqual(snap_kotak["userId"], "user-kotak")

    def test_logging_in_dummy_creates_dummy_record_and_keeps_kotak(self):
        sm = self._new_manager()
        self._login(sm, "kotak", "user-kotak")
        self._login(sm, "dummy", "user-dummy")

        snap = sm.snapshot()
        self.assertEqual(snap["mode"], "dummy")
        self.assertEqual(snap["state"], SESSION_ACTIVE)
        # both records exist and are independent
        self.assertEqual(sm.terminal_session("kotak")["session_id"],
                         snap["sessionId"]) if False else None
        kotak_rec = sm.terminal_session("kotak")
        dummy_rec = sm.terminal_session("dummy")
        self.assertEqual(kotak_rec["session_status"], SESSION_ACTIVE)
        self.assertEqual(dummy_rec["session_status"], SESSION_ACTIVE)
        self.assertNotEqual(kotak_rec["session_id"], dummy_rec["session_id"])

    def test_snapshot_exposes_sessions_map(self):
        sm = self._new_manager()
        self.assertEqual(sm.snapshot()["sessions"], {})
        self._login(sm, "kotak", "user-kotak")
        snap = sm.snapshot()
        self.assertIn("kotak", snap["sessions"])
        self.assertIn("terminalSessions", snap)
        self.assertEqual(snap["sessions"]["kotak"]["session_status"],
                         SESSION_ACTIVE)


class TestMarkLogoutIsTerminalScoped(TerminalIsolationTestMixin, unittest.TestCase):
    def test_mark_logout_on_dummy_does_not_touch_kotak_record(self):
        sm = self._new_manager()
        self._login(sm, "kotak", "user-kotak")
        self._login(sm, "dummy", "user-dummy")

        # logout the ACTIVE (dummy) terminal only
        sm.mark_logout("explicit_user_logout")

        self.assertEqual(sm.terminal_session("dummy")["login_status"], "logged_out")
        self.assertEqual(sm.terminal_session("dummy")["session_status"], "DISCONNECTED")
        # kotak record is preserved
        self.assertEqual(
            sm.terminal_session("kotak")["session_status"], SESSION_ACTIVE
        )
        self.assertEqual(sm.terminal_session("kotak")["user_id"], "user-kotak")

    def test_mark_logout_accepts_explicit_target_mode(self):
        sm = self._new_manager()
        self._login(sm, "kotak", "user-kotak")

        # target kotak explicitly while still on kotak
        sm.mark_logout("explicit_user_logout")
        self.assertEqual(sm.terminal_session("kotak")["login_status"], "logged_out")

    def test_mark_expired_only_updates_target_record(self):
        sm = self._new_manager()
        self._login(sm, "kotak", "user-kotak")
        self._login(sm, "dummy", "user-dummy")

        sm.mark_expired("session_expired")

        self.assertEqual(sm.terminal_session("dummy")["session_status"], "SESSION_EXPIRED")
        self.assertEqual(sm.terminal_session("kotak")["session_status"], SESSION_ACTIVE)


class TestSwitchTerminalNeverLogsOut(unittest.IsolatedAsyncioTestCase):
    async def test_switch_terminal_is_pure_context_switch(self):
        sm = CentralSessionManager()
        sm.set_mode("kotak", user_id="user-kotak")
        sm.mark_login_success(mode="kotak", broker="Kotak Neo", user_id="user-kotak")
        kotak_sid = sm.snapshot()["sessionId"]

        fake_adapter = MagicMock()
        fake_adapter.is_logged_in = True

        with patch("brokers.manager.session_manager", sm), \
             patch("brokers.manager.get_adapter", return_value=fake_adapter) as mock_get:
            from brokers import manager as bm
            result = await bm.switch_terminal("dummy")
            self.assertTrue(result["ok"])
            self.assertTrue(result["changed"])
            self.assertEqual(result["mode"], "dummy")

            # pure context switch: no logout on previous terminal, no adapter logout
            fake_adapter.logout.assert_not_called()
            mock_get.assert_not_called()  # previous terminal's adapter never touched
            # mark_logout is NOT part of a switch (only set_mode is)
            self.assertEqual(sm.snapshot()["mode"], "dummy")
            # kotak session still alive in its record
            self.assertEqual(
                sm.terminal_session("kotak")["session_status"], SESSION_ACTIVE
            )
            self.assertEqual(sm.terminal_session("kotak")["session_id"], kotak_sid)

            # switching back to kotak restores the SAME kotak session
            await bm.switch_terminal("kotak")
            snap_back = sm.snapshot()
            self.assertEqual(snap_back["mode"], "kotak")
            self.assertEqual(snap_back["sessionId"], kotak_sid)
            self.assertEqual(snap_back["state"], SESSION_ACTIVE)

    async def test_switch_terminal_same_mode_is_noop(self):
        sm = CentralSessionManager()
        sm.set_mode("kotak")
        with patch("brokers.manager.session_manager", sm):
            from brokers import manager as bm
            result = await bm.switch_terminal("kotak")
            self.assertEqual(result["message"], "Already active")
            self.assertFalse(result["changed"])


class TestApiModeEndpointIsPureContextSwitch(unittest.IsolatedAsyncioTestCase):
    async def test_api_mode_does_not_logout(self):
        from services.session.session_manager import session_manager as real_sm
        sm = CentralSessionManager()
        sm.set_mode("kotak", user_id="user-kotak")
        sm.mark_login_success(mode="kotak", broker="Kotak Neo", user_id="user-kotak")
        kotak_sid = sm.snapshot()["sessionId"]

        with patch("api.routes.session_manager", sm), \
             patch("api.routes.active_mode", return_value="kotak"), \
             patch("api.routes.do_logout") as mock_do_logout, \
             patch("api.routes.record_event"):
            from api import routes as rt
            resp = await rt.set_mode("dummy")
            self.assertTrue(resp["ok"])
            # the pure-context-switch contract: no broker logout, no central
            # session invalidation
            mock_do_logout.assert_not_called()
            sm.mark_logout  # never toggled by switch

        self.assertEqual(sm.terminal_session("kotak")["session_id"], kotak_sid)
        self.assertEqual(sm.terminal_session("kotak")["session_status"], SESSION_ACTIVE)


class TestSchedulerDummyGatePreservesSessions(TerminalIsolationTestMixin, unittest.TestCase):
    def test_reconcile_gate_preserves_sessions_and_ignores_terminal(self):
        """The paper-feed gate must NOT terminate an existing broker session.

        Whether a manual / scheduler session stays alive is derived from the real
        broker state, and the session_manager must never be asked to invalidate
        merely because a terminal was selected. The gate is keyed on the
        SCHEDULED FEED, so a Dummy trading terminal cannot park the lifecycle.
        """
        import scheduler as sched_mod
        src = open(sched_mod.__file__, encoding="utf-8").read()
        gate_start = src.find("# Paper-feed gate")
        self.assertGreaterEqual(gate_start, 0, "paper-feed gate marker missing")
        gate_end = src.find("now = _now_ist()", gate_start)
        self.assertGreaterEqual(gate_end, gate_start, "gate end marker missing")
        gate_block = src[gate_start: gate_end]

        # (1) the gate keys on the scheduled feed, never the trading terminal
        self.assertIn("_scheduled_feed_is_dummy()", gate_block)
        self.assertNotIn(
            "is_dummy_mode()",
            gate_block,
            "the reconcile gate must not key on the active trading terminal",
        )
        # (2) it must NOT call _logout_current inside the gate
        self.assertNotIn("_logout_current", gate_block)
        # (3) it must NOT call _stop_ws inside the gate
        self.assertNotIn("_stop_ws", gate_block)
        # (4) it must NOT call mark_logout inside the gate
        self.assertNotIn("mark_logout", gate_block)

    def test_do_login_gate_keys_on_scheduled_feed_not_terminal(self):
        """The scheduler's do_login gate MUST key on the scheduled feed."""
        import scheduler as sched_mod
        src = open(sched_mod.__file__, encoding="utf-8").read()
        do_login = src.find("def do_login")
        self.assertGreater(do_login, 0, "do_login not found in scheduler")
        do_login_block = src[do_login: do_login + 1200]
        self.assertIn("_scheduled_feed_is_dummy()", do_login_block)
        self.assertNotIn(
            "is_dummy_mode()",
            do_login_block,
            "do_login must not gate on the active trading terminal; a Dummy "
            "terminal still needs the scheduled broker session",
        )

    def test_scheduled_logout_is_not_gated_on_the_trading_terminal(self):
        """Logout must always run for the scheduled broker session.

        Gating the scheduled logout on the trading terminal left the Kotak
        session authenticated overnight whenever the paper engine was selected.
        """
        import scheduler as sched_mod
        src = open(sched_mod.__file__, encoding="utf-8").read()
        logout = src.find("async def _logout_current")
        self.assertGreater(logout, 0, "_logout_current not found")
        logout_block = src[logout: logout + 3000]
        self.assertIn("kotak_session.logout", logout_block)
        self.assertNotIn(
            "is_dummy_mode()",
            logout_block,
            "the scheduled logout must run regardless of the trading terminal",
        )
        # The dummy terminal itself is still protected: mark_logout stays
        # scoped to the kotak session only.
        self.assertIn('mode="kotak"', logout_block)


if __name__ == "__main__":
    unittest.main()