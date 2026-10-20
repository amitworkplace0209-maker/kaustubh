"""Tests for the migrated Storage Engine (infrastructure observability).

Covers: identity, configuration validation + persistence behaviour, normalized
state collection, bounded history, duration-aware thresholds, compatibility
shims and health reporting. All external collectors are stubbed — no real host
or MongoDB dependency is required.
"""

import unittest
from unittest import mock

from services.storage_engine import StorageEngine, DEFAULT_CONFIG, InfraEvents


def _stub_state(cpu: float = 10.0) -> dict:
    return {
        "environment": {"type": "LOCALHOST", "pid": 1234, "runtime": "python"},
        "host": {
            "cpu": {"status": "AVAILABLE", "usagePct": cpu},
            "memory": {"status": "AVAILABLE", "usagePct": 40.0},
            "disk": {"status": "AVAILABLE", "usagePct": 30.0},
            "network": {"status": "AVAILABLE", "rxBytes": 1, "txBytes": 2},
            "load": {"status": "UNAVAILABLE", "reason": "unsupported"},
            "uptimeSeconds": 100.0,
        },
        "runtime": {"status": "RUNNING", "pid": 1234, "threads": 8, "memoryMb": 120.0, "cpuPct": 5.0},
        "database": {},
        "engines": [],
        "application": {},
        "updatedAt": None,
    }


class StorageEngineTest(unittest.IsolatedAsyncioTestCase):
    def test_identity(self):
        e = StorageEngine()
        self.assertEqual(e.engine_id, "storage_engine")
        self.assertEqual(e.engine_name, "Storage Engine")
        self.assertEqual(e.engine_category.value, "STORAGE")

    def test_validate_config_rejects_unknown_and_out_of_range(self):
        e = StorageEngine()
        _, errors = e.validate_config({"notAKey": 1})
        self.assertTrue(any("unknown" in x for x in errors))
        _, errors = e.validate_config({"sampleIntervalSeconds": 0})
        self.assertTrue(any("between" in x for x in errors))
        _, errors = e.validate_config({"cpuWarnPct": 50, "cpuCritPct": 40})
        self.assertTrue(any("cpuCritPct must be >= cpuWarnPct" in x for x in errors))

    def test_validate_config_accepts_valid(self):
        e = StorageEngine()
        clean, errors = e.validate_config({
            "sampleIntervalSeconds": 10,
            "cpuWarnPct": 70,
            "monitoringEnabled": False,
        })
        self.assertEqual(errors, [])
        self.assertEqual(clean["sampleIntervalSeconds"], 10)
        self.assertEqual(clean["cpuWarnPct"], 70.0)
        self.assertFalse(clean["monitoringEnabled"])

    async def test_update_config_applies_and_reports(self):
        e = StorageEngine()
        with mock.patch.object(e, "_save_config", new=mock.AsyncMock()) as save:
            result = await e.update_config({"sampleIntervalSeconds": 9})
        self.assertTrue(result["ok"])
        self.assertEqual(e.get_config()["sampleIntervalSeconds"], 9)
        save.assert_awaited_once()

    async def test_update_config_invalid_does_not_apply(self):
        e = StorageEngine()
        result = await e.update_config({"sampleIntervalSeconds": 9999})
        self.assertFalse(result["ok"])
        self.assertEqual(e.get_config()["sampleIntervalSeconds"], DEFAULT_CONFIG["sampleIntervalSeconds"])

    async def test_sample_once_normalizes_state(self):
        e = StorageEngine()
        with mock.patch.object(e, "_collect_blocking", return_value=_stub_state()), \
             mock.patch.object(e, "_collect_database", new=mock.AsyncMock(return_value={
                 "status": "CONNECTED", "connected": True, "readLatencyMs": 4.0,
                 "queueDepth": 0, "pendingWrites": 0, "failedWrites": 0,
             })), \
             mock.patch.object(e, "_aggregate_engines", return_value=[]):
            state = await e.sample_once()
        self.assertEqual(state["host"]["cpu"]["usagePct"], 10.0)
        self.assertEqual(state["database"]["status"], "CONNECTED")
        self.assertIn("application", state)
        self.assertIn("updatedAt", state)
        self.assertEqual(len(e.history()), 1)

    async def test_history_is_bounded(self):
        e = StorageEngine()
        await e.update_config({"historyMax": 10, "sampleIntervalSeconds": 1})
        with mock.patch.object(e, "_collect_blocking", return_value=_stub_state()), \
             mock.patch.object(e, "_collect_database", new=mock.AsyncMock(return_value={"status": "CONNECTED"})), \
             mock.patch.object(e, "_aggregate_engines", return_value=[]):
            for _ in range(15):
                await e.sample_once()
        self.assertEqual(len(e.history(1000)), 10)

    async def test_threshold_requires_duration(self):
        e = StorageEngine()
        await e.update_config({"thresholdDurationSamples": 3, "cpuWarnPct": 50, "cpuCritPct": 80})
        with mock.patch.object(e, "_collect_blocking", return_value=_stub_state(cpu=99.0)), \
             mock.patch.object(e, "_collect_database", new=mock.AsyncMock(return_value={"status": "CONNECTED"})), \
             mock.patch.object(e, "_aggregate_engines", return_value=[]), \
             mock.patch.object(e, "_emit_infra_event") as emit:
            await e.sample_once()
            await e.sample_once()
            self.assertEqual(emit.call_count, 0)  # breach not long enough yet
            await e.sample_once()
        self.assertEqual(emit.call_count, 1)
        self.assertEqual(emit.call_args[0][0], InfraEvents.HOST_CPU_HIGH)

    async def test_health_unknown_before_first_sample(self):
        e = StorageEngine()
        health = await e.health_check()
        self.assertEqual(health.value, "UNKNOWN")

    async def test_health_degraded_on_database_down(self):
        e = StorageEngine()
        with mock.patch.object(e, "_collect_blocking", return_value=_stub_state()), \
             mock.patch.object(e, "_collect_database", new=mock.AsyncMock(return_value={"status": "DISCONNECTED", "connected": False})), \
             mock.patch.object(e, "_aggregate_engines", return_value=[]):
            await e.sample_once()
        health = await e.health_check()
        self.assertEqual(health.value, "DEGRADED")

    async def test_legacy_queue_size_reads_pipeline(self):
        e = StorageEngine()
        with mock.patch.object(e, "_persistence_pipeline", return_value={"queueDepth": 42}):
            self.assertEqual(e.queue_size(), 42)

    async def test_legacy_write_guarded_when_db_down(self):
        e = StorageEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=False):
            self.assertFalse(await e.write("audit_logs", {"a": 1}))


if __name__ == "__main__":
    unittest.main()
