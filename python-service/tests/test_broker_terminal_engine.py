"""Broker Terminal Engine tests (no live MongoDB required).

Covers ``services.broker_terminal_engine``:
- Dummy Mode is reported HONESTLY: before it is started the card is a truthful
  "not started" state (no phantom 1,00,000 balance); after ``login()`` it
  reports the real paper account (balance / margin / P&L / positions / orders).
- Aggregators (positions → invested/value/P&L/exposure; orders → summary).
- ``build_terminal_overview`` returns all three terminals + combined in one pass.

Run:  python -m pytest tests/test_broker_terminal_engine.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


class FakeCollection:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    async def find_one(self, q=None):
        q = q or {}
        for d in self._docs:
            if all(d.get(k) == v for k, v in q.items()):
                return dict(d)
        return None

    async def update_one(self, q, update, upsert=False):
        key = q.get("key")
        for d in self._docs:
            if d.get("key") == key:
                d.update(update.get("$set", {}))
                return key
        if upsert:
            doc = {"key": key}
            doc.update({k: v for k, v in update.get("$set", {}).items() if k != "key"})
            self._docs.append(doc)
        return key

    def seed(self, docs):
        self._docs[:] = list(docs or self._docs)


class FakeDB:
    def __init__(self, **colls):
        for name, docs in colls.items():
            setattr(self, name, FakeCollection(docs))


def _seed_demo(app_settings):
    app_settings.seed([
        {"key": "demo_account", "value": {
            "balance": 200000, "usedMargin": 50000, "freeMargin": 150000,
            "realizedPnl": 1200.50, "unrealizedPnl": -400.25,
            "totalPnl": 800.25, "totalCharges": 45.10, "dailyOrders": 3,
        }},
        {"key": "demo_orders", "value": [
            {"orderId": "D1", "status": "COMPLETE"},
            {"orderId": "D2", "status": "OPEN"},
            {"orderId": "D3", "status": "CANCELLED"},
        ]},
        {"key": "demo_positions", "value": [
            {"symbol": "RELIANCE", "netQuantity": 10, "product": "MIS",
             "ltp": 2500, "averageBuyPrice": 2450.5, "averageSellPrice": 0,
             "unrealizedPnl": 495, "realizedPnl": 0},
            {"symbol": "TCS", "netQuantity": -5, "product": "CNC",
             "ltp": 3600, "averageBuyPrice": 0, "averageSellPrice": 3550,
             "unrealizedPnl": -250, "realizedPnl": 100},
            {"symbol": "FLAT", "netQuantity": 0, "product": "MIS", "ltp": 10,
             "averageBuyPrice": 10, "averageSellPrice": 10,
             "unrealizedPnl": 0, "realizedPnl": 0},
        ]},
    ])


class BrokerTerminalEngineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB(app_settings=[])
        _seed_demo(self.db.app_settings)

    # ---- aggregators ------------------------------------------------------ #
    def test_agg_positions(self):
        from services.broker_terminal_engine import _agg_positions
        snap = _agg_positions([
            {"symbol": "RELIANCE", "netQuantity": 10, "product": "MIS", "ltp": 2500,
             "averageBuyPrice": 2450.5, "averageSellPrice": 0, "unrealizedPnl": 495, "realizedPnl": 0},
            {"symbol": "TCS", "netQuantity": -5, "product": "CNC", "ltp": 3600,
             "averageBuyPrice": 0, "averageSellPrice": 3550, "unrealizedPnl": -250, "realizedPnl": 100},
        ])
        self.assertEqual(snap["positionCount"], 2)
        self.assertEqual(snap["longQty"], 10)
        self.assertEqual(snap["shortQty"], 5)
        self.assertAlmostEqual(snap["invested"], 2450.5 * 10 + 3550 * 5, places=2)
        # MIS exposure factor 0.2 for the long, CNC 1.0 for the short
        self.assertAlmostEqual(snap["exposure"], 2500 * 10 * 0.2 + 3600 * 5, places=2)
        self.assertEqual(snap["unrealizedPnl"], 245.0)
        self.assertEqual(snap["realizedPnl"], 100.0)

    def test_orders_summary(self):
        from services.broker_terminal_engine import _orders_summary
        summary = _orders_summary([
            {"status": "COMPLETE"}, {"status": "FILLED"}, {"status": "OPEN"},
            {"status": "CANCELLED"}, {"status": "PARTIALLY_FILLED"}, {"status": "REJECTED"},
        ])
        self.assertEqual(summary["total"], 6)
        self.assertEqual(summary["completed"], 2)
        self.assertEqual(summary["open"], 1)
        self.assertEqual(summary["cancelled"], 1)
        self.assertEqual(summary["partial"], 1)
        self.assertEqual(summary["rejected"], 1)

    # ---- Dummy managed always-on (no manual start needed) ------------------ #
    async def test_dummy_managed_ready_without_central_session(self):
        """ensure_auto_ready() keeps Dummy logged in WITHOUT hijacking the
        central/active terminal view (e.g. Kotak stays active at boot)."""
        from brokers.dummy import DummyAdapter
        from services.session.session_manager import session_manager

        central_before = session_manager.snapshot().get("mode")
        adapter = DummyAdapter()
        try:
            ready = await adapter.ensure_auto_ready()
            self.assertTrue(ready)
            self.assertTrue(adapter.is_logged_in)
            self.assertTrue(adapter._managed)
            rec = session_manager.terminal_session("dummy")
            self.assertEqual(rec.get("session_status"), "SESSION_ACTIVE")
            self.assertEqual(rec.get("login_status"), "logged_in")
            self.assertEqual(rec.get("login_source"), "MANAGED")
            # Central view untouched — the active terminal is NOT dummy.
            self.assertEqual(session_manager.snapshot().get("mode"), central_before)
        finally:
            adapter._logged_in = False
            adapter._managed = False
            session_manager.mark_logout("test done", mode="dummy")

    async def test_dummy_managed_is_logged_in_without_central_session(self):
        """Once managed, is_logged_in is True independent of the central
        session — the engine card stays live for the whole backend run."""
        from brokers.dummy import DummyAdapter
        from services.session.session_manager import session_manager

        adapter = DummyAdapter()
        await adapter.ensure_auto_ready()
        try:
            self.assertTrue(adapter.is_logged_in)
        finally:
            adapter._logged_in = False
            adapter._managed = False
            session_manager.mark_logout("test done", mode="dummy")

    # ---- dummy honesty: not started --------------------------------------- #
    def test_dummy_not_started_is_honest(self):
        views = {}
        import asyncio
        from services.broker_terminal_engine import build_terminal_overview

        adapter = mock.Mock()
        adapter.is_logged_in = False
        adapter.enabled = True
        with mock.patch("brokers.manager.get_adapter", side_effect=lambda term: adapter):
            result = asyncio.get_event_loop().run_until_complete(build_terminal_overview())
        dummy = result["terminals"]["dummy"]
        self.assertFalse(dummy["connected"])
        self.assertIsNone(dummy["balance"])
        self.assertIn("not started", (dummy["message"] or ""))
        self.assertFalse(result["ok"] is False)

    # ---- dummy started reports real paper account ------------------------- #
    async def test_dummy_started_reports_paper_account(self):
        from brokers.dummy import dummy_adapter
        from services.broker_terminal_engine import build_terminal_overview

        await dummy_adapter.login()

        adapter = mock.Mock()
        adapter.is_logged_in = True
        adapter.enabled = True
        counters = {"calls": 0}
        def _get_adapter(term):
            if term == "dummy":
                counters["calls"] += 1
                return adapter
            return None
        with mock.patch("api.demo.get_db", return_value=self.db), \
             mock.patch("brokers.manager.get_adapter", side_effect=_get_adapter):
            result = await build_terminal_overview()

        dummy = result["terminals"]["dummy"]
        self.assertTrue(dummy["connected"])
        self.assertEqual(dummy["balance"], 200000)
        self.assertEqual(dummy["availableMargin"], 150000)
        self.assertEqual(dummy["usedMargin"], 50000)
        self.assertAlmostEqual(dummy["realizedPnl"], 1200.50)
        self.assertAlmostEqual(dummy["unrealizedPnl"], -400.25)
        self.assertAlmostEqual(dummy["totalPnl"], 800.25)
        # FLAT position (netQuantity=0) is filtered out by get_dummy_positions as a ghost
        self.assertEqual(dummy["positionCount"], 2)
        self.assertEqual(dummy["orders"]["total"], 3)
        self.assertEqual(dummy["orders"]["completed"], 1)

        # combined aggregates ONLY the real brokers (kotak/shoonya); the paper
        # dummy terminal's virtual capital is deliberately excluded.
        combined = result["combined"]
        self.assertEqual(combined["sources"], ["kotak", "shoonya"])
        self.assertFalse(combined["connected"])
        self.assertIsNone(combined["balance"])
        self.assertEqual(combined["orders"]["total"], 0)

        await dummy_adapter.logout(reason="test done")

    # ---- all terminals present, one pass ----------------------------------- #
    async def test_overview_contains_all_terminals(self):
        from brokers.dummy import dummy_adapter
        from brokers.manager import active_terminal
        from services.broker_terminal_engine import build_terminal_overview

        await dummy_adapter.login()
        adapter = mock.Mock()
        adapter.is_logged_in = lambda: False  # kotak/shoonya paths: not logged in
        adapter.enabled = False
        with mock.patch("api.demo.get_db", return_value=self.db), \
             mock.patch("brokers.manager.get_adapter", side_effect=lambda term: adapter):
            result = await build_terminal_overview()

        self.assertTrue(result["ok"])
        self.assertEqual(sorted(result["terminals"].keys()), ["dummy", "kotak", "shoonya"])
        self.assertIn(result["active"], ("kotak", "shoonya", "dummy"))
        for key in ("kotak", "shoonya"):
            self.assertFalse(result["terminals"][key]["connected"])
        await dummy_adapter.logout(reason="test done")


# ---- session-state honesty (trading dashboard broker badges) ----------- #
    def test_live_adapter_without_central_record_reports_active(self):
        """doc — a terminal whose adapter is REALLY logged in must never badge
        INACTIVE just because the central session manager is tracking a different
        mode (e.g. scheduler Kotak login while Dummy owns the central view)."""
        from services.broker_terminal_engine import _session_state
        from services.session.session_manager import session_manager

        adapter = mock.Mock()
        adapter.is_logged_in = True
        with mock.patch("brokers.manager.get_adapter", return_value=adapter), \
             mock.patch.object(session_manager, "terminal_session", return_value={
                 "session_status": "NONE",
             }), \
             mock.patch.object(session_manager, "snapshot", return_value={"mode": "dummy"}):
            self.assertEqual(_session_state("kotak"), "SESSION_ACTIVE")

    def test_explicit_inactive_record_is_not_live(self):
        """An explicit DISCONNECTED/EXPIRED per-terminal record is honest even
        when the adapter says logged in (stale-after-logout guard stays real)."""
        from services.broker_terminal_engine import _session_state
        from services.session.session_manager import session_manager

        adapter = mock.Mock()
        adapter.is_logged_in = True
        with mock.patch("brokers.manager.get_adapter", return_value=adapter), \
             mock.patch.object(session_manager, "terminal_session", return_value={
                 "session_status": "DISCONNECTED",
             }):
            self.assertEqual(_session_state("dummy"), "DISCONNECTED")

    def test_not_logged_in_is_never_active(self):
        from services.broker_terminal_engine import _session_state

        adapter = mock.Mock()
        adapter.is_logged_in = False
        with mock.patch("brokers.manager.get_adapter", return_value=adapter):
            self.assertEqual(_session_state("kotak"), "NOT_LOGGED_IN")


if __name__ == "__main__":
    unittest.main()