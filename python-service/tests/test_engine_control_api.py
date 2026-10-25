"""API tests for the Phase 3 Service Control Center endpoints.

Uses FastAPI TestClient against the real engine-control router. Every assertion
relies on the honest engine registry / broker registry state — no fake data.

Run:  python -m pytest tests/test_engine_control_api.py -q
"""
from __future__ import annotations

import os
import sys
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from fastapi.testclient import TestClient
from api.engine_control import router
from services.engine_event_bus import get_event_bus


def _make_app():
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(router)
    return app


class EngineControlApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(_make_app())

    def test_summary(self):
        r = self.client.get("/api/services/engines/summary")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        data = body.get("data", body)
        self.assertIn("total", data)
        self.assertIn("overall", data)

    def test_broker_list_lists_implemented_honestly(self):
        r = self.client.get("/api/services/engines/broker/list")
        self.assertEqual(r.status_code, 200)
        brokers = r.json().get("data", [])
        by_id = {b["id"]: b for b in brokers}
        self.assertIn("kotak", by_id)
        self.assertIn("shoonya", by_id)
        # Shoonya capabilities are all False — honest truth.
        cap = by_id["shoonya"]["capabilities"]
        self.assertFalse(cap["trading"])
        self.assertFalse(cap["marketData"])

    def test_select_shoonya_trading_rejected(self):
        r = self.client.post(
            "/api/services/engines/broker/trading/select",
            json={"broker": "shoonya"},
        )
        body = r.json()
        self.assertFalse(body.get("ok", True))
        self.assertIn("NOT IMPLEMENTED", body.get("error", ""))

    def test_select_shoonya_market_data_rejected(self):
        r = self.client.post(
            "/api/services/engines/broker/market-data/select",
            json={"broker": "shoonya"},
        )
        body = r.json()
        self.assertFalse(body.get("ok", True))
        self.assertIn("NOT IMPLEMENTED", body.get("error", ""))

    def test_select_unknown_broker_rejected(self):
        r = self.client.post(
            "/api/services/engines/broker/trading/select",
            json={"broker": "nonexistent"},
        )
        self.assertFalse(r.json().get("ok", True))

    def test_select_dummy_ok(self):
        r = self.client.post(
            "/api/services/engines/broker/trading/select",
            json={"broker": "dummy"},
        )
        body = r.json()
        self.assertTrue(body.get("ok", False), body)

    def test_select_kotak_ok(self):
        r = self.client.post(
            "/api/services/engines/broker/market-data/select",
            json={"broker": "kotak"},
        )
        self.assertTrue(r.json().get("ok", False))

    def test_start_unknown_engine(self):
        r = self.client.post("/api/services/engines/does_not_exist/start")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json().get("ok", True))


class EngineControlEventBusWriteTest(unittest.IsolatedAsyncioTestCase):
    async def test_broker_change_event_can_be_published(self):
        """Broker change events are part of the canonical vocabulary and must
        publish without deadlock (regression: non-reentrant lock in stats())."""
        from services.engine_event_bus import (
            EngineEvents, EngineEvent, get_event_bus,
        )
        bus = get_event_bus()
        q = await bus.subscribe([EngineEvents.TRADING_BROKER_CHANGED])
        await bus.publish(EngineEvent(
            event_type=EngineEvents.TRADING_BROKER_CHANGED,
            source_engine="broker_registry",
            data={"previous": "kotak", "current": "dummy"},
        ))
        event = await asyncio_wait(q)
        self.assertEqual(event["eventType"], "TRADING_BROKER_CHANGED")
        self.assertEqual(event["data"]["current"], "dummy")
        # stats() must not hang after publish (RLock regression)
        self.assertGreaterEqual(bus.stats()["totalPublished"], 1)


def asyncio_wait(queue):
    import asyncio
    return asyncio.wait_for(queue.get(), timeout=2.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)