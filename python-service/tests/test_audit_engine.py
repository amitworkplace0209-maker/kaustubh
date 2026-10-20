"""Tests for the Audit Engine (services/audit_engine.py)."""

import unittest
from unittest import mock
from unittest.mock import AsyncMock

from core.engines.engine_base import EngineCategory, EngineHealth
from services.audit_engine import AuditEngine


class AuditEngineTest(unittest.IsolatedAsyncioTestCase):
    def test_identity(self):
        e = AuditEngine()
        self.assertEqual(e.engine_id, "audit_engine")
        self.assertEqual(e.engine_name, "Audit Engine")
        self.assertEqual(e.engine_category, EngineCategory.CONTROL)

    async def test_start_registers_dependencies(self):
        e = AuditEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=True):
            ok = await e.start()
        self.assertTrue(ok)
        self.assertTrue(e.is_running)
        self.assertEqual(e.get_dependencies(), ["storage_engine"])

    async def test_health_check_healthy_when_mongo_connected(self):
        e = AuditEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch.object(e, "_get_event_count", new=AsyncMock(return_value=1234)):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.HEALTHY)

    async def test_health_check_db_unavailable(self):
        e = AuditEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=False):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_record_creates_event(self):
        e = AuditEngine()
        mock_entry = {"event_id": "evt_123", "source": "test"}
        with mock.patch("services.event_history.record_event", return_value=mock_entry) as rec:
            result = await e.record("test_source", "TEST_EVENT", "info", "test message", {"symbol": "RELIANCE"})
        self.assertEqual(result["event_id"], "evt_123")
        rec.assert_called_once()

    async def test_query_returns_filtered_events(self):
        e = AuditEngine()
        mock_events = [
            {"event_id": "evt_1", "source": "risk", "category": "RISK", "severity": "warning"},
            {"event_id": "evt_2", "source": "order", "category": "TRADING", "severity": "info"},
        ]
        with mock.patch("services.event_history.mongo_events", new=AsyncMock(return_value=mock_events)):
            result = await e.query(limit=10, source="risk")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["event_id"], "evt_1")

    async def test_get_summary_returns_aggregates(self):
        e = AuditEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch("database.connection.get_db") as mock_get_db:
            mock_db = mock.MagicMock()
            mock_db.__getitem__.return_value.count_documents = AsyncMock(return_value=100)
            # Mock aggregate to return empty async iterable
            class MockCursor:
                def __aiter__(self):
                    return self
                async def __anext__(self):
                    raise StopAsyncIteration
            mock_db.__getitem__("system_events").aggregate.return_value = MockCursor()
            mock_db.__getitem__("system_events").find_one = AsyncMock(return_value=None)
            mock_get_db.return_value = mock_db
            result = await e.get_summary()
        # count_documents called for system_events + events = 200
        self.assertEqual(result["totalEvents"], 200)

    async def test_query_filters_by_correlation_id(self):
        e = AuditEngine()
        mock_events = [
            {"event_id": "evt_1", "meta": {"correlation_id": "CORR-123"}},
            {"event_id": "evt_2", "meta": {"correlation_id": "CORR-456"}},
        ]
        with mock.patch("services.event_history.mongo_events", new=AsyncMock(return_value=mock_events)):
            result = await e.query(correlation_id="CORR-123")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["event_id"], "evt_1")

    async def test_query_filters_by_category_and_severity(self):
        e = AuditEngine()
        mock_events = [
            {"event_id": "evt_1", "category": "RISK", "severity": "error"},
            {"event_id": "evt_2", "category": "TRADING", "severity": "info"},
        ]
        with mock.patch("services.event_history.mongo_events", new=AsyncMock(return_value=mock_events)):
            result = await e.query(category="RISK", severity="error")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["event_id"], "evt_1")

    async def test_trace_correlation_returns_chain(self):
        e = AuditEngine()
        mock_chain = [
            {"event_id": "evt_1", "meta": {"correlation_id": "CORR-123"}, "event": "AI_SUGGESTION"},
            {"event_id": "evt_2", "meta": {"correlation_id": "CORR-123"}, "event": "RISK_EVALUATION"},
            {"event_id": "evt_3", "meta": {"correlation_id": "CORR-123"}, "event": "RISK_DECISION_BLOCK"},
        ]
        with mock.patch.object(e, "query", new=AsyncMock(return_value=mock_chain)):
            result = await e.trace_correlation("CORR-123")
        self.assertEqual(len(result), 3)

    async def test_status_snapshot_includes_cached_summary(self):
        e = AuditEngine()
        e._cached_summary = {"totalEvents": 500, "byCategory": {"RISK": 100}}
        snap = e.status_snapshot()
        self.assertEqual(snap["summary"]["totalEvents"], 500)

    async def test_async_status_snapshot_refreshes(self):
        e = AuditEngine()
        with mock.patch.object(e, "get_summary", new=AsyncMock(return_value={"totalEvents": 200})), \
             mock.patch.object(e, "_get_event_count", new=AsyncMock(return_value=200)):
            snap = await e.async_status_snapshot()
        self.assertEqual(snap["summary"]["totalEvents"], 200)


class AuditEngineRoutesTest(unittest.IsolatedAsyncioTestCase):
    """The /audit_engine/* control-plane routes expose the engine truthfully."""

    async def test_summary_route_returns_engine_data(self):
        from api.engine_control import audit_summary
        with mock.patch(
            "services.audit_engine.audit_engine.get_summary",
            new=AsyncMock(return_value={"totalEvents": 7}),
        ):
            res = await audit_summary()
        self.assertTrue(res["ok"])
        self.assertEqual(res["data"]["totalEvents"], 7)

    async def test_query_route_search_filters_rows(self):
        from api.engine_control import audit_query
        rows = [
            {"event_id": "a1", "message": "Risk blocked RELIANCE", "reason": "", "event": "RISK_DECISION_BLOCK", "symbol": "RELIANCE", "source": "risk"},
            {"event_id": "a2", "message": "Scheduler started", "reason": "", "event": "SCHEDULER_STARTED", "symbol": "", "source": "scheduler"},
        ]
        with mock.patch(
            "services.audit_engine.audit_engine.query",
            new=AsyncMock(return_value=rows),
        ):
            res = await audit_query(limit=100, search="reliance")
        self.assertTrue(res["ok"])
        self.assertEqual(res["data"]["count"], 1)
        self.assertEqual(res["data"]["events"][0]["event_id"], "a1")

    async def test_trace_route_returns_chain(self):
        from api.engine_control import audit_trace
        chain = [{"event_id": "a1"}, {"event_id": "a2"}]
        with mock.patch(
            "services.audit_engine.audit_engine.trace_correlation",
            new=AsyncMock(return_value=chain),
        ):
            res = await audit_trace("CORR-1")
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["data"]["events"]), 2)

    async def test_record_route_requires_source_and_event(self):
        from api.engine_control import audit_record
        res = await audit_record({})
        self.assertFalse(res["ok"])
        with mock.patch(
            "services.audit_engine.audit_engine.record",
            new=AsyncMock(return_value={"event_id": "evt_9"}),
        ) as rec:
            res = await audit_record({"source": "operator", "event": "NOTE", "message": "hi"})
        self.assertTrue(res["ok"])
        self.assertEqual(res["data"]["event_id"], "evt_9")
        rec.assert_awaited_once()

    async def test_flush_route_returns_engine_result(self):
        from api.engine_control import audit_flush
        with mock.patch(
            "services.audit_engine.audit_engine.flush",
            new=AsyncMock(return_value={"ok": True, "ringSize": 3}),
        ):
            res = await audit_flush()
        self.assertTrue(res["ok"])
        self.assertEqual(res["data"]["ringSize"], 3)


if __name__ == "__main__":
    unittest.main()