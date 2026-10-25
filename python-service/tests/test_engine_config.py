"""Engine settings contract — declarative schema, validated writes.

Guards the gap the Service Control Center had: every engine published a live
``configSummary`` but none of them could be changed, so the Control Center
offered start/stop for an engine whose knobs it could not touch.

What is pinned here:
  * every registered engine answers ``config_snapshot()`` (no engine is missing
    a settings schema),
  * computed outputs are ``editable=False`` so the UI never offers an input that
    would silently do nothing,
  * validation refuses unknown keys and out-of-range values per field,
  * a failed write is reported as failed — never as a silent success,
  * engines that own a dedicated config store (Risk) write through it, so the
    Control Center and the engine's own settings page share one source of truth.

Run:  python -m pytest tests/test_engine_config.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from core.engines.engine_base import EngineBase, EngineCategory
from core.engines.engine_config import ConfigField, read_only, validate_patch


class SampleEngine(EngineBase):
    engine_id = "sample_engine"
    engine_name = "Sample"
    engine_category = EngineCategory.DATA
    config_fields = (
        ConfigField(key="sample_window", label="Window", summary="window",
                    type="number", min=1, max=100, unit="s", group="Limits"),
        ConfigField(key="sample_mode", label="Mode", summary="mode",
                    type="select", options=("fast", "safe")),
        ConfigField(key="sample_enabled", label="Enabled", summary="enabled",
                    type="boolean"),
        read_only("computedThing", "Computed Thing"),
    )


class SchemaTests(unittest.TestCase):
    def test_snapshot_reports_live_values(self):
        e = SampleEngine()
        e.set_config_summary({"window": 30, "mode": "fast", "enabled": True,
                              "computedThing": "abc"})
        snap = e.config_snapshot()
        by_key = {f["key"] or f["summary"]: f for f in snap["fields"]}
        self.assertEqual(by_key["sample_window"]["value"], 30)
        self.assertEqual(by_key["sample_window"]["unit"], "s")
        self.assertTrue(by_key["sample_window"]["editable"])
        self.assertFalse(by_key["computedThing"]["editable"])
        self.assertEqual(snap["editable"], 3)

    def test_undeclared_summary_entries_are_surfaced_read_only(self):
        """An engine reporting a knob it did not declare must still be visible,
        but never editable — no silently-dead input."""
        e = SampleEngine()
        e.set_config_summary({"window": 30, "surpriseKnob": 7})
        snap = e.config_snapshot()
        extra = [f for f in snap["fields"] if f["summary"] == "surpriseKnob"]
        self.assertEqual(len(extra), 1)
        self.assertFalse(extra[0]["editable"])

    def test_field_with_no_declared_value_falls_back_to_live(self):
        e = SampleEngine()
        e.set_config_summary({"window": 42})
        field = next(f for f in e.config_snapshot()["fields"] if f["key"] == "sample_window")
        self.assertEqual(field["value"], 42)
        self.assertIs(field["pending"], False)


class ValidationTests(unittest.TestCase):
    def test_accepts_a_valid_patch(self):
        clean, errors = validate_patch(
            SampleEngine.config_fields,
            {"sample_window": 50, "sample_mode": "safe", "sample_enabled": False},
        )
        self.assertEqual(errors, {})
        self.assertEqual(clean["sample_window"], 50)
        self.assertIs(clean["sample_enabled"], False)

    def test_rejects_unknown_key_and_names_the_valid_ones(self):
        clean, errors = validate_patch(SampleEngine.config_fields, {"nope": 1})
        self.assertEqual(clean, {})
        self.assertIn("nope", errors)
        self.assertIn("sample_window", errors["nope"])

    def test_rejects_out_of_range_with_the_bound(self):
        _clean, errors = validate_patch(SampleEngine.config_fields, {"sample_window": 5000})
        self.assertIn("sample_window", errors)
        self.assertIn("100", errors["sample_window"])

        _clean, errors = validate_patch(SampleEngine.config_fields, {"sample_window": 0})
        self.assertIn(">= 1", errors["sample_window"])

    def test_rejects_non_numeric(self):
        _clean, errors = validate_patch(SampleEngine.config_fields, {"sample_window": "abc"})
        self.assertIn("number", errors["sample_window"])

    def test_rejects_select_not_in_options(self):
        _clean, errors = validate_patch(SampleEngine.config_fields, {"sample_mode": "turbo"})
        self.assertIn("fast", errors["sample_mode"])

    def test_rejects_read_only_field(self):
        _clean, errors = validate_patch(SampleEngine.config_fields, {"computedThing": "x"})
        self.assertIn("computedThing", errors)

    def test_coerces_boolean_strings(self):
        clean, _errors = validate_patch(SampleEngine.config_fields, {"sample_enabled": "true"})
        self.assertIs(clean["sample_enabled"], True)

    def test_whole_numbers_stay_whole(self):
        clean, _errors = validate_patch(SampleEngine.config_fields, {"sample_window": "60"})
        self.assertEqual(clean["sample_window"], 60)
        self.assertIsInstance(clean["sample_window"], int)


class ApplyPatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_write_failure_is_reported_not_swallowed(self):
        """A rejected write must come back ok=False with the reason, never as a
        silent success that the UI would report as 'saved'."""
        e = SampleEngine()
        e.set_config_summary({"window": 30})

        with mock.patch("services.settings_service.set_setting",
                        new=mock.AsyncMock(side_effect=ValueError("boom"))):
            res = await e.apply_config_patch({"sample_window": 40})
        self.assertFalse(res["ok"])
        self.assertIn("sample_window", res["errors"])
        self.assertIn("boom", res["errors"]["sample_window"])

    async def test_invalid_patch_never_reaches_the_store(self):
        e = SampleEngine()
        store = mock.AsyncMock()
        with mock.patch("services.settings_service.set_setting", new=store):
            res = await e.apply_config_patch({"sample_window": 9999})
        store.assert_not_awaited()
        self.assertFalse(res["ok"])

    async def test_successful_write_is_reported_with_the_config(self):
        e = SampleEngine()
        e.set_config_summary({"window": 30})

        async def _set(key, value):
            return {"key": key}

        with mock.patch("services.settings_service.set_setting", new=_set), \
             mock.patch("services.runtime_settings.refresh_runtime_settings",
                        new=mock.AsyncMock()):
            res = await e.apply_config_patch({"sample_window": 40})
        self.assertTrue(res["ok"], res.get("errors"))
        self.assertEqual(res["written"]["sample_window"], 40)
        self.assertIn("config", res)


class FleetCoverageTests(unittest.TestCase):
    """Every engine the Service Control Center shows must have a settings schema."""

    def _engines(self):
        from core.engines.feature_engine import feature_engine
        from core.engines.search_engine import search_engine
        from core.engines.squareoff_engine import squareoff_engine
        from core.engines.risk_engine import risk_engine
        from services.watchlist_engine import watchlist_engine
        from services.market_watch_engine import market_watch_engine
        from services.market_coach import market_coach
        from services.storage_engine import storage_engine
        from services.db_writer_engine import db_writer_engine
        from services.notification_engine import notification_engine
        from services.audit_engine import audit_engine
        from services.session_manager_engine import session_manager_engine
        from services.connection_manager_engine import connection_manager_engine
        from services.websocket_engine import websocket_engine
        from services.legacy_engine_facades import FACADES
        return [
            feature_engine, search_engine, squareoff_engine,
            risk_engine, watchlist_engine, market_watch_engine, market_coach,
            storage_engine, db_writer_engine, notification_engine, audit_engine,
            session_manager_engine, connection_manager_engine, websocket_engine,
            *FACADES,
        ]

    def test_every_engine_declares_config_fields(self):
        missing = [e.engine_id for e in self._engines() if not e.config_fields]
        self.assertEqual(missing, [], f"engines with no settings schema: {missing}")

    def test_every_engine_answers_a_snapshot(self):
        for e in self._engines():
            snap = e.config_snapshot()
            self.assertEqual(snap["engineId"], e.engine_id)
            self.assertIsInstance(snap["fields"], list)

    def test_editable_keys_are_unique_within_an_engine(self):
        for e in self._engines():
            keys = [f.key for f in e.config_fields if f.key and f.editable]
            self.assertEqual(len(keys), len(set(keys)), f"{e.engine_id} has duplicate editable keys")

    def test_every_editable_key_is_declared_as_a_setting(self):
        """An editable field that writes to the SHARED settings store must map
        to a real key in it, otherwise a write validates then gets rejected at
        persistence time.

        Engines that override ``_write_settings`` own a different, dedicated
        store (Risk's module globals, Session Manager's config collection) and
        are excluded — for them the key is theirs, not the settings store's.
        """
        from services.settings_service import DEFAULTS
        for e in self._engines():
            if type(e)._write_settings is not EngineBase._write_settings:
                continue
            unknown = [f.key for f in e.config_fields if f.key and f.editable and f.key not in DEFAULTS]
            self.assertEqual(unknown, [], f"{e.engine_id} edits unknown settings: {unknown}")

    def test_engines_with_their_own_store_override_the_writer(self):
        """The two engines that already had dedicated config endpoints must keep
        writing to them, or the Control Center and the engine's own settings
        page would drift apart."""
        for e in self._engines():
            if e.engine_id in ("risk_engine", "session_manager", "storage_engine"):
                self.assertIsNot(
                    type(e)._write_settings, EngineBase._write_settings,
                    f"{e.engine_id} must keep its own config store",
                )
            else:
                self.assertIs(
                    type(e)._write_settings, EngineBase._write_settings,
                    f"{e.engine_id} should use the shared settings store",
                )


class RiskEngineConfigTests(unittest.IsolatedAsyncioTestCase):
    """Risk Engine limits live in module globals the validator consults. The
    Control Center must write those same globals, not a second copy."""

    async def test_write_updates_the_limit_the_validator_reads(self):
        import core.engines.risk_engine as re_mod
        engine = re_mod.risk_engine
        before = re_mod._MAX_ORDER_VALUE
        try:
            res = await engine.apply_config_patch({"max_order_value": 12345.0})
            self.assertTrue(res["ok"], res.get("errors"))
            self.assertEqual(re_mod._MAX_ORDER_VALUE, 12345.0)
            self.assertEqual(engine.config_summary()["maxOrderValue"], 12345.0)
        finally:
            re_mod._MAX_ORDER_VALUE = before
            engine.set_config_summary(engine.config_summary())

    async def test_whitelist_field_is_not_writable(self):
        import core.engines.risk_engine as re_mod
        res = await re_mod.risk_engine.apply_config_patch({"orderTypeWhitelist": ["MKT"]})
        self.assertFalse(res["ok"])
        self.assertIn("orderTypeWhitelist", res["errors"])


if __name__ == "__main__":
    unittest.main()