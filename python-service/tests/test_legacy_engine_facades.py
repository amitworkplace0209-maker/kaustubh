"""Tests for the legacy-subystem facade engines.

The facades adapt pre-existing systems (Scheduler, Session Manager, Connection
Engine, WebSocket Engine, Order/Position Engine, Notification Center) into the
Engine Registry. They must reflect *real* state — never fabricated — and must
never throw when the underlying subsystem is unavailable.

Run:  python -m pytest tests/test_legacy_engine_facades.py -q
"""
from __future__ import annotations

import os
import sys
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from core.engines.engine_base import EngineState, EngineHealth
from services.legacy_engine_facades import FACADES
from services.engine_registry import EngineRegistry


class FacadeCatalogTest(unittest.TestCase):
    def test_registry_contains_expected_ids(self):
        # connection_manager is a first-class engine (services/connection_manager_engine.py),
        # registered by app.py; it is NOT a legacy facade (F1: duplicate removed).
        # websocket_engine, session_manager and notification_engine are also
        # first-class now (services/*_engine.py); their facades remain
        # importable but are NOT auto-registered (F2: duplicate removed).
        ids = {f.engine_id for f in FACADES}
        self.assertEqual(
            ids,
            # target_engine is a stateless function module
            # (core/engines/target_engine.py) with no dedicated EngineBase
            # class, so this facade is its only registry presence.
            {"scheduler_engine", "order_engine", "position_engine", "target_engine"},
        )

    def test_unique_engine_ids(self):
        ids = [f.engine_id for f in FACADES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_snapshot_shape(self):
        for f in FACADES:
            snap = f.status_snapshot()
            self.assertEqual(snap["engineId"], f.engine_id)
            self.assertIn("state", snap)
            self.assertIn("health", snap)
            self.assertIn("metrics", snap)
            self.assertTrue(snap.get("managed", False))


class FacadeSyncTest(unittest.TestCase):
    """Facades must never fabricate a running state for subsystems that cannot
    be running in a bare test process. (session_manager is excluded: other
    tests in the suite legitimately create a dummy session, making the real
    session active — the facade is then honest when it reports RUNNING.)"""

    def _reset_globals(self):
        from services.notification_center import notification_center_initialized
        notification_center_initialized.clear()

    def test_state_never_fakes_running_health(self):
        self._reset_globals()
        expected_stopped = {"scheduler_engine"}
        for f in FACADES:
            if f.engine_id in expected_stopped:
                self.assertNotIn(
                    f.state,
                    (EngineState.RUNNING, EngineState.HEALTHY),
                    f"{f.engine_id} must not invent a running state",
                )
            elif f.engine_id in ("order_engine", "position_engine"):
                # Function modules report RUNNING; health must mirror the real
                # adapter login state — HEALTHY only iff the adapter is actually
                # logged in (some tests legitimately log in the dummy adapter).
                f._sync_status()
                self.assertEqual(f.state, EngineState.RUNNING)
                try:
                    from brokers.manager import get_adapter
                    from brokers.broker_registry import get_broker_registry
                    adapter = get_adapter(get_broker_registry().get_trading_broker())
                    logged_in = bool(getattr(adapter, "is_logged_in", False))
                except Exception:
                    logged_in = False
                if logged_in:
                    self.assertEqual(f.health, EngineHealth.HEALTHY)
                else:
                    self.assertNotEqual(f.health, EngineHealth.HEALTHY)

    def test_sync_status_does_not_raise(self):
        for f in FACADES:
            try:
                f._sync_status()
            except Exception as exc:  # pragma: no cover
                self.fail(f"{f.engine_id}._sync_status raised: {exc!r}")

    def test_registry_can_register_and_read_facades(self):
        reg = EngineRegistry()
        for f in FACADES:
            reg.register(f)
        statuses = reg.get_all_statuses()
        self.assertEqual(len(statuses), len(FACADES))
        # Dependency graph works across facades
        graph = reg.dependency_graph()
        self.assertIn("order_engine", graph)
        self.assertIn("scheduler_engine", graph)


class NotificationFlagTest(unittest.TestCase):
    def test_flag_starts_unset(self):
        from services.notification_center import is_initialized, notification_center_initialized
        notification_center_initialized.clear()
        self.assertFalse(is_initialized())

    def test_facade_reports_not_initialized(self):
        from services.notification_center import notification_center_initialized
        notification_center_initialized.clear()
        from services.legacy_engine_facades import notification_facade
        snap = notification_facade.status_snapshot()
        self.assertEqual(snap["connectionState"], "NOT_INITIALIZED")


if __name__ == "__main__":
    unittest.main(verbosity=2)