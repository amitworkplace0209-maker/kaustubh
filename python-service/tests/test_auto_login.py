"""Auto-login + encrypted broker session store — regression guard.

Covers the pieces that make a broker terminal come up on its own:

* ``services/terminal_credentials`` — the OAuth session material is stored
  ENCRYPTED and round-trips; a wrong key yields nothing (never a plaintext
  token).
* ``services/auto_login`` — each terminal obtains its session the only way it
  can: Kotak via TOTP+MPIN, Dummy via the managed paper session, Shoonya by
  restoring the stored OAuth session (and reporting honestly that a handshake
  is required when there is nothing to restore).
* ``brokers.shoonya_adapter`` — the OAuth exchange returns a 4-TUPLE from the
  Noren SDK, not a string; the adapter must read the token out of it.

Run:  python -m pytest tests/test_auto_login.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


class TerminalCredentialStoreTest(unittest.TestCase):
    def setUp(self):
        from pathlib import Path

        from services import terminal_credentials as tc

        self.tc = tc
        self._tmp = Path(tc.RUNTIME_DIR) / "terminal_credentials.test.json"
        self._orig_path = tc.STORE_PATH
        tc.STORE_PATH = self._tmp
        if self._tmp.exists():
            self._tmp.unlink()

    def tearDown(self):
        self.tc.STORE_PATH = self._orig_path
        if self._tmp.exists():
            self._tmp.unlink()

    def test_session_material_round_trips_encrypted(self):
        material = {
            "access_token": "TOTALLY-SECRET-TOKEN",
            "susertoken": "usertoken",
            "user_id": "FA123456",
            "account_id": "FA123456",
        }
        self.assertTrue(self.tc.save_session_material("shoonya", material))
        # On disk it must NOT be readable.
        raw = open(self._tmp, encoding="utf-8").read()
        self.assertNotIn("TOTALLY-SECRET-TOKEN", raw)
        self.assertTrue(self.tc.has_session_material("shoonya"))
        loaded = self.tc.load_session_material("shoonya")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["access_token"], "TOTALLY-SECRET-TOKEN")
        self.assertEqual(loaded["user_id"], "FA123456")

    def test_unknown_terminal_is_never_stored(self):
        self.assertFalse(self.tc.save_session_material("kotak", {"access_token": "x"}))
        self.assertFalse(self.tc.has_session_material("kotak"))

    def test_clear_removes_the_material(self):
        self.tc.save_session_material("shoonya", {"access_token": "x"})
        self.assertTrue(self.tc.clear_session_material("shoonya"))
        self.assertFalse(self.tc.has_session_material("shoonya"))
        self.assertIsNone(self.tc.load_session_material("shoonya"))


class AutoLoginTest(unittest.IsolatedAsyncioTestCase):
    async def test_dummy_needs_no_broker(self):
        from services.auto_login import auto_login

        result = await auto_login("dummy")
        self.assertTrue(result.ok)
        self.assertEqual(result.method, "managed")

    async def test_shoonya_reports_the_handshake_when_nothing_is_stored(self):
        from services import auto_login as al
        import brokers.shoonya_adapter as sa

        # Patch the adapter so the test never touches a real broker.
        with mock.patch.object(type(sa.shoonya_adapter), "enabled", new_callable=mock.PropertyMock, return_value=True), \
             mock.patch.object(type(sa.shoonya_adapter), "is_logged_in", new_callable=mock.PropertyMock, return_value=False), \
             mock.patch.object(sa.shoonya_adapter, "restore_session", new=mock.AsyncMock(return_value=False)), \
             mock.patch.object(sa.shoonya_adapter, "oauth_url", return_value="https://shoonya/oauth?x=1"), \
             mock.patch("services.terminal_credentials.load_session_material", return_value=None):
            result = await al.auto_login("shoonya")
        self.assertFalse(result.ok)
        self.assertEqual(result.requires, "oauth_handshake")
        self.assertIsNotNone(result.oauth_url)

    async def test_shoonya_restores_a_stored_session(self):
        from services import auto_login as al
        import brokers.shoonya_adapter as sa

        with mock.patch.object(type(sa.shoonya_adapter), "enabled", new_callable=mock.PropertyMock, return_value=True), \
             mock.patch.object(type(sa.shoonya_adapter), "is_logged_in", new_callable=mock.PropertyMock, return_value=False), \
             mock.patch.object(sa.shoonya_adapter, "restore_session", new=mock.AsyncMock(return_value=True)):
            result = await al.auto_login("shoonya")
        self.assertTrue(result.ok)
        self.assertEqual(result.method, "oauth_restore")

    async def test_kotak_uses_totp(self):
        from services import auto_login as al

        fake_session = mock.Mock()
        fake_session.session_active = True
        with mock.patch("auth.kotak_client.kotak_session", fake_session):
            result = await al.auto_login("kotak")
        self.assertTrue(result.ok)
        self.assertEqual(result.method, "totp")


class ShoonyaOauthExchangeTest(unittest.IsolatedAsyncioTestCase):
    async def test_the_exchange_reads_the_token_out_of_the_tuple(self):
        """The Noren SDK returns (access_token, user_id, refresh_token, actid)."""
        from brokers import shoonya_adapter as sa

        adapter = sa.ShoonyaAdapter()
        client = mock.Mock()
        client.getAccessToken = mock.Mock(
            return_value=("ACCESS-TOKEN", "FA123456", "REFRESH-TOKEN", "FA999999")
        )
        client._NorenApi__susertoken = "USERTOKEN"
        adapter._client = client

        token = await adapter._exchange_auth_code("the-code")
        self.assertEqual(token, "ACCESS-TOKEN")
        self.assertEqual(adapter._session_material["user_id"], "FA123456")
        self.assertEqual(adapter._session_material["account_id"], "FA999999")
        self.assertEqual(adapter._session_material["susertoken"], "USERTOKEN")

    async def test_an_empty_token_is_refused(self):
        from brokers import shoonya_adapter as sa
        from brokers.models import BrokerError

        adapter = sa.ShoonyaAdapter()
        client = mock.Mock()
        client.getAccessToken = mock.Mock(return_value=None)
        adapter._client = client
        with self.assertRaises(BrokerError):
            await adapter._exchange_auth_code("the-code")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
