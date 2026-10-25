"""Settings service + API contracts for the advanced Settings workbench.

Covers the pieces the workbench depends on and that used to fail silently:

- bulk validation is atomic (every bad key is reported before any write)
- sensitive keys are detected on whole tokens, so ``security_pin`` is hidden
  while ``mwr_max_pins`` / ``stg_database_ping_enabled`` stay editable
- the export snapshot never leaks a sensitive value
- PATCH dry-run validates without writing
- import rejects the whole payload when one key is invalid

Run:  python -m pytest tests/test_settings_workbench.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from api import settings as settings_api  # noqa: E402
from services import settings_service  # noqa: E402


class SensitiveSettingTest(unittest.TestCase):
    def test_real_secrets_are_sensitive(self):
        self.assertTrue(settings_service.is_sensitive_setting("security_pin"))
        self.assertTrue(settings_service.is_sensitive_setting("mongodb_uri"))
        self.assertTrue(settings_service.is_sensitive_setting("api_token"))
        self.assertTrue(settings_service.is_sensitive_setting("broker_password"))

    def test_words_containing_pin_are_not_secrets(self):
        # Regression: substring matching marked these sensitive, so the
        # catalogue showed null and every write was rejected.
        for key in (
            "mwr_max_pins",
            "mwr_max_gainer_pins",
            "mwr_max_loser_pins",
            "stg_database_ping_enabled",
        ):
            self.assertFalse(settings_service.is_sensitive_setting(key), key)

    def test_ordinary_setting_is_not_sensitive(self):
        self.assertFalse(settings_service.is_sensitive_setting("general_auto_refresh"))


class ScheduleAliasTest(unittest.TestCase):
    def test_alias_resolves_to_canonical_key(self):
        self.assertEqual(
            settings_service.resolve_schedule_alias("square_off_time"),
            "sched_square_off_time",
        )
        self.assertEqual(
            settings_service.resolve_schedule_alias("scheduler_login_time"),
            "sched_login_time",
        )

    def test_unknown_key_is_unchanged(self):
        self.assertEqual(
            settings_service.resolve_schedule_alias("general_auto_refresh"),
            "general_auto_refresh",
        )


class BulkValidationTest(unittest.TestCase):
    def test_valid_patch_has_no_errors(self):
        errors = settings_service.validate_settings_bulk({
            "general_auto_refresh": False,
            "md_quote_refresh_ms": 1500,
        })
        self.assertEqual(errors, {})

    def test_unknown_key_is_reported(self):
        errors = settings_service.validate_settings_bulk({"not_a_real_key": 1})
        self.assertIn("not_a_real_key", errors)

    def test_sensitive_key_cannot_be_written(self):
        errors = settings_service.validate_settings_bulk({"security_pin": "1234"})
        self.assertIn("security_pin", errors)

    def test_bounds_and_types_are_enforced(self):
        errors = settings_service.validate_settings_bulk({
            "mwr_page_size": 5000,
            "md_quote_refresh_ms": "fast",
            "general_auto_refresh": "yes",
        })
        self.assertIn("mwr_page_size", errors)
        self.assertIn("md_quote_refresh_ms", errors)
        self.assertIn("general_auto_refresh", errors)

    def test_ping_key_is_writable(self):
        # Regression guard for the substring sensitive-key bug.
        self.assertEqual(
            settings_service.validate_settings_bulk({"stg_database_ping_enabled": False}),
            {},
        )


class ExportSnapshotTest(unittest.IsolatedAsyncioTestCase):
    async def test_export_omits_sensitive_values(self):
        stored = {
            "general_auto_refresh": {"key": "general_auto_refresh", "value": False},
            "security_pin": {"key": "security_pin", "value": "1234"},
            "mongodb_uri": {"key": "mongodb_uri", "value": "mongodb://secret"},
        }
        with mock.patch.object(settings_service, "get_all_settings", mock.AsyncMock(return_value=stored)):
            snapshot = await settings_service.export_settings()

        self.assertEqual(snapshot["count"], 1)
        self.assertEqual(snapshot["settings"], {"general_auto_refresh": False})
        self.assertNotIn("security_pin", snapshot["settings"])
        self.assertNotIn("mongodb_uri", snapshot["settings"])


class SettingsApiRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_schema_payload_lists_sensitive_keys(self):
        rows = [{"key": "general_auto_refresh", "value": False, "sensitive": False}]
        with mock.patch.object(
            settings_api, "get_settings_schema", mock.AsyncMock(return_value=rows)
        ), mock.patch.object(
            settings_api, "get_setting_categories", return_value=["general", "security"]
        ):
            payload = await settings_api.get_schema()

        self.assertEqual(payload["settings"], rows)
        self.assertIn("security_pin", payload["sensitiveKeys"])
        self.assertNotIn("mwr_max_pins", payload["sensitiveKeys"])

    async def test_bulk_patch_dry_run_does_not_write(self):
        setter = mock.AsyncMock()
        with mock.patch.object(
            settings_api, "get_all_settings", mock.AsyncMock(return_value={})
        ), mock.patch.object(settings_api, "set_setting", setter):
            result = await settings_api.patch_settings(
                settings_api.UpdateSettingsPatch(
                    settings={"general_auto_refresh": False}, dryRun=True
                )
            )

        self.assertTrue(result["dryRun"])
        self.assertEqual(result["validated"], ["general_auto_refresh"])
        setter.assert_not_awaited()

    async def test_bulk_patch_rejects_before_writing(self):
        setter = mock.AsyncMock()
        with mock.patch.object(settings_api, "set_setting", setter):
            with self.assertRaises(settings_api.HTTPException) as ctx:
                await settings_api.patch_settings(
                    settings_api.UpdateSettingsPatch(settings={"security_pin": "1234"})
                )

        self.assertEqual(ctx.exception.status_code, 400)
        setter.assert_not_awaited()

    async def test_import_rejects_invalid_payload(self):
        with self.assertRaises(settings_api.HTTPException) as ctx:
            await settings_api.import_settings_snapshot(
                settings_api.ImportSettingsRequest(settings={"unknown_key": 1})
            )

        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
