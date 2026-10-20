"""Notification Center rule/alert engine unit tests (no live MongoDB).

Uses monkeypatched ``get_db`` / settings / notification gates so the rule
engine, dedupe keys, cooldown grouping, auto-resolve and severity mapping can
be verified quickly and deterministically.

Run:  python -m pytest tests/test_notification_center.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone, timedelta
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

import services.notification_center as nc  # noqa: E402
from services.notification_center import (  # noqa: E402
    RULES, _dedupe_key, _fmt, canonical_category, ALERT_RETENTION_HOURS,
)


def _ts(v):
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    return _EPOCH


_EPOCH = datetime(1970, 1, 1, 0, 0, tzinfo=timezone.utc)


def _entry(source="websocket", event="connected", status="info", message="",
           meta=None, symbol="", reason_code=""):
    return {
        "source": source, "event": event, "status": status, "message": message,
        "event_id": "evt_" + "0" * 32, "ts": "2026-09-05T10:00:00+00:00",
        "severity": "info", "component": source, "meta": meta or {},
        "symbol": symbol, "reason_code": reason_code,
    }


class DedupeKeyTest(unittest.TestCase):
    def test_symbols_get_separate_groups(self):
        ws = next(r for r in RULES if r.rule_id == "ws_disconnected")
        a = _dedupe_key(ws, _entry(symbol="RELIANCE"))
        b = _dedupe_key(ws, _entry(symbol="TCS"))
        self.assertNotEqual(a, b)

    def test_reason_code_separates_groups(self):
        ws = next(r for r in RULES if r.rule_id == "ws_disconnected")
        a = _dedupe_key(ws, _entry(reason_code="network_loss"))
        b = _dedupe_key(ws, _entry(reason_code="bfa_reconnect"))
        self.assertNotEqual(a, b)

    def test_different_rules_never_collide(self):
        a = _dedupe_key(next(r for r in RULES if r.rule_id == "ws_connected"),
                        _entry(event="connected"))
        b = _dedupe_key(next(r for r in RULES if r.rule_id == "market_open"),
                        _entry(source="market_state", event="MARKET_OPEN_CONFIRMED"))
        self.assertNotEqual(a, b)


class FormatTest(unittest.TestCase):
    def test_fmt_resolves_fields(self):
        e = _entry(message="Broker WS down", meta={"reason": "network loss",
                                                   "reason_code": "network_loss"})
        self.assertEqual(
            _fmt("{message} — {reason} ({reason_code})", e),
            "Broker WS down — network loss (network_loss)",
        )

    def test_fmt_never_raises_on_bad_template(self):
        e = _entry()
        self.assertEqual(_fmt("{missing_field}", e), "{missing_field}")


class RuleTableTest(unittest.TestCase):
    def test_rules_have_unique_ids_and_events_mapped(self):
        ids = [r.rule_id for r in RULES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_ws_disconnected_skips_deliberate_reasons(self):
        rule = next(r for r in RULES if r.rule_id == "ws_disconnected")
        entry = _entry(event="disconnected", meta={"reason_code": "scheduled_disconnect"})
        self.assertTrue(rule.skip_when(entry))

    def test_ws_disconnected_alerts_network_loss(self):
        rule = next(r for r in RULES if r.rule_id == "ws_disconnected")
        entry = _entry(event="disconnected", meta={"reason_code": "network_loss"})
        self.assertFalse(rule.skip_when(entry))

    def test_quality_rule_auto_resolves(self):
        rule = next(r for r in RULES if r.rule_id == "quality")
        self.assertEqual(rule.auto_resolve_on, "QUALITY_ISSUE_RESOLVED")


class _Coll:
    def __init__(self, rows):
        self.rows = rows

    async def insert_one(self, doc):
        doc["_id"] = "res_" + str(len(self.rows))
        self.rows.append(doc)
        return mock.Mock(inserted_id=doc["_id"])

    async def find_one(self, q, *a, **k):
        return next((r for r in self.rows if _match(q, r)), None)

    async def update_one(self, q, u, *a, **k):
        row = next((r for r in self.rows if _match(q, r)), None)
        if row is None:
            return mock.Mock(matched_count=0, modified_count=0)
        s = u.get("$set") or {}
        for k, v in s.items():
            row[k] = v
        inc = u.get("$inc") or {}
        for k, v in inc.items():
            row[k] = row.get(k, 0) + v
        return mock.Mock(matched_count=1, modified_count=1)

    async def update_many(self, q, u):
        matched = [r for r in self.rows if _match(q, r)]
        s = u.get("$set") or {}
        for r in matched:
            for k, v in s.items():
                r[k] = v
        return mock.Mock(matched_count=len(matched),
                         modified_count=len(matched))

    async def count_documents(self, q=None):
        q = dict(q or {})
        rows = self.rows
        if "read" in q:
            rows = [r for r in rows if r.get("read") is q["read"]]
        if "importance" in q:
            rows = [r for r in rows if r.get("importance") == q["importance"]]
        if "status" in q:
            rows = [r for r in rows if r.get("status") == q["status"]]
        if "ts" in q:
            rng = q["ts"]
            if isinstance(rng, dict) and "$gte" in rng:
                rows = [r for r in rows if _ts(r.get("ts")) >= _ts(rng["$gte"])]
        return len(rows)

    def aggregate(self, pipeline, *a, **k):
        by_cat: dict = {}
        for r in self.rows:
            by_cat.setdefault(r.get("category") or "SYSTEM", 0)
            by_cat[r.get("category") or "SYSTEM"] += 1
        return _Rows([{"_id": k, "n": v} for k, v in by_cat.items()])

    def find(self, *q, **k):
        query = q[0] if q else {}
        rows = [r for r in self.rows if _match(query, r)]
        if "limit" in k:
            rows = rows[:k["limit"]]
        return FakeCursor(list(rows))

    async def delete_one(self, q, *a, **k):
        idx = next((i for i, r in enumerate(self.rows) if _match(q, r)), None)
        if idx is None:
            return mock.Mock(deleted_count=0)
        self.rows.pop(idx)
        return mock.Mock(deleted_count=1)

    async def delete_many(self, q, *a, **k):
        before = len(self.rows)
        self.rows[:] = [r for r in self.rows if not _match(q, r)]
        return mock.Mock(deleted_count=before - len(self.rows))


class FakeCursor:
    def __init__(self, rows):
        self._rows = rows
        self._i = 0

    def sort(self, spec):
        return self

    def skip(self, n):
        self._rows = self._rows[n:]
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    async def to_list(self, length=None, *a, **k):
        return self._rows

    def __aiter__(self):
        self._i = 0
        return self

    async def __anext__(self):
        if self._i >= len(self._rows):
            raise StopAsyncIteration
        doc = self._rows[self._i]
        self._i += 1
        return doc


def _match(q, doc):
    for k, v in (q or {}).items():
        if k == "$or":
            if not any(_match(clause, doc) for clause in v):
                return False
            continue
        if isinstance(v, dict):
            if "$in" in v:
                if doc.get(k) not in v["$in"]:
                    return False
            elif "$lt" in v:
                val = doc.get(k)
                if val is None:
                    return False
                try:
                    if not (val < v["$lt"]):
                        return False
                except TypeError:
                    return False
            elif "$gte" in v:
                val = doc.get(k)
                if val is None:
                    return False
                try:
                    if not (val >= v["$gte"]):
                        return False
                except TypeError:
                    return False
            elif "$exists" in v:
                if bool(v["$exists"]) != (k in doc):
                    return False
        elif doc.get(k) != v:
            return False
    return True


class EngineTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.alerts = []
        self.notifs = []
        db = mock.Mock()
        db.alerts = _Coll(self.alerts)
        db.notifications = _Coll(self.notifs)
        db.__getitem__ = lambda self, k: db.alerts if k == "alerts" else db.notifications
        self.db = db
        self.patchers = [
            mock.patch.object(nc, "get_db", return_value=db),
            mock.patch("services.settings_service.get_setting",
                       new=mock.AsyncMock(return_value=True)),
            mock.patch("services.notification_service._category_enabled",
                       new=mock.AsyncMock(return_value=True)),
            mock.patch.object(nc, "_publish_frame", new=mock.AsyncMock()),
            mock.patch.object(nc, "_publish_state_counts", new=mock.AsyncMock()),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    async def test_alert_created_for_network_loss(self):
        rule = next(r for r in RULES if r.rule_id == "ws_disconnected")
        entry = _entry(event="disconnected",
                       meta={"reason_code": "network_loss", "reason": "Network lost"})
        await nc._upsert_alert(rule, entry, "error", self.db)
        self.assertEqual(len(self.alerts), 1)
        a = self.alerts[0]
        self.assertEqual(a["status"], "active")
        self.assertEqual(a["rule_id"], "ws_disconnected")
        self.assertEqual(a["severity"], "error")
        self.assertEqual(a["reason_code"], "network_loss")
        self.assertTrue(a.get("automation", {}).get("dedupe"))

    async def test_alert_occurrence_grouping_and_escalation(self):
        rule = next(r for r in RULES if r.rule_id == "ws_disconnected")
        entry = _entry(event="disconnected",
                       meta={"reason_code": "network_loss", "reason": "Network lost"})
        await nc._upsert_alert(rule, entry, "error", self.db)
        self.assertEqual(len(self.alerts), 1)
        self.assertEqual(self.alerts[0]["occurrence_count"], 1)
        await nc._upsert_alert(rule, entry, "error", self.db)
        self.assertEqual(len(self.alerts), 1)
        self.assertEqual(self.alerts[0]["occurrence_count"], 2)
        self.assertGreaterEqual(self.alerts[0]["severity"], "error")

    async def test_auto_resolve_creates_resolution_notification(self):
        rule = next(r for r in RULES if r.rule_id == "quality")
        create = _entry(source="quality", event="QUALITY_ISSUE_CREATED",
                        meta={"symbol": "RELIANCE"})
        await nc._upsert_alert(rule, create, "warning", self.db)
        self.assertEqual(len(self.alerts), 1)

        resolve = _entry(source="quality", event="QUALITY_ISSUE_RESOLVED",
                         meta={"symbol": "RELIANCE", "reason_code": "quality_fixed"})
        await nc._resolve_open_alerts(rule, resolve, self.db)
        self.assertEqual(self.alerts[0]["status"], "resolved")
        self.assertIsNotNone(self.alerts[0].get("resolved_at"))

    async def test_connected_event_auto_resolves_disconnect_alert(self):
        disc_rule = next(r for r in RULES if r.rule_id == "ws_disconnected")
        disc_entry = _entry(event="disconnected",
                            meta={"reason_code": "network_loss"})
        await nc._upsert_alert(disc_rule, disc_entry, "warning", self.db)
        self.assertEqual(len(self.alerts), 1)
        self.assertEqual(self.alerts[0]["status"], "active")

        conn_entry = _entry(event="connected")
        await nc._run_rules_for(conn_entry)
        self.assertEqual(self.alerts[0]["status"], "resolved")
        self.assertIn("Auto-resolved", self.alerts[0].get("resolved_reason", ""))

    async def test_notification_created_with_related_alert(self):
        rule = next(r for r in RULES if r.rule_id == "ws_connected")
        entry = _entry(event="connected")
        alert_id = await nc._upsert_alert(rule, entry, "success", self.db)
        await nc._create_notification(rule, entry, "success", self.db, alert_id)
        self.assertEqual(len(self.notifs), 1)
        n = self.notifs[0]
        self.assertEqual(n["status"], "unread")
        self.assertEqual(n["read"], False)
        self.assertEqual(n["category"], "WEBSOCKET")
        self.assertEqual(n["importance"], "normal")
        self.assertEqual(n["related_alert_id"], alert_id)
        self.assertIn("occurrence_count", n)

    async def test_notification_dedupe_cooldown_grouping(self):
        rule = next(r for r in RULES if r.rule_id == "ws_connected")
        entry = _entry(event="connected")
        await nc._create_notification(rule, entry, "success", self.db, None)
        await nc._create_notification(rule, entry, "success", self.db, None)
        self.assertEqual(len(self.notifs), 1)
        self.assertEqual(self.notifs[0]["occurrence_count"], 2)


class CategoryMappingTest(unittest.TestCase):
    def test_canonical_categories_are_uppercased_labels(self):
        cases = {
            "websocket": "WEBSOCKET",
            "database": "DATABASE",
            "database:write": "TICKS",
            "market": "MARKET",
            "quality": "DATA_QUALITY",
            "scanner": "DATA_QUALITY",
            "pipeline": "PIPELINE",
            "scheduler": "SCHEDULER",
            "download": "DOWNLOADS",
            "export": "EXPORTS",
            "login": "SESSION",
            "session": "SESSION",
            "settings": "SYSTEM",
        }
        for src, expected in cases.items():
            self.assertEqual(canonical_category(src), expected, src)

    def test_unknown_falls_back_to_uppercased(self):
        self.assertEqual(canonical_category("monitoring"), "MONITORING")
        self.assertEqual(canonical_category(None), "SYSTEM")
        self.assertEqual(canonical_category(""), "SYSTEM")

    def test_notification_categories_are_stable_display_labels(self):
        cases = {
            "websocket": "WEBSOCKET",
            "database": "DATA",
            "database:write": "DATA",
            "market": "MARKET",
            "quality": "DATA",
            "scanner": "DATA",
            "pipeline": "SYSTEM",
            "scheduler": "SCHEDULER",
            "download": "DOWNLOADS",
            "export": "EXPORTS",
            "login": "SESSION",
            "session": "SESSION",
            "settings": "SETTINGS",
            "system": "SYSTEM",
        }
        for src, expected in cases.items():
            self.assertEqual(nc.notification_category(src), expected, src)

    def test_rule_notification_category_disambiguation(self):
        sub = next(r for r in RULES if r.rule_id == "subscriptions")
        export = next(r for r in RULES if r.rule_id == "export")
        dl = next(r for r in RULES if r.rule_id == "download")
        persist = next(r for r in RULES if r.rule_id == "persistence")
        self.assertEqual(nc._notif_category_for(sub), "SUBSCRIPTIONS")
        self.assertEqual(nc._notif_category_for(export), "EXPORTS")
        self.assertEqual(nc._notif_category_for(dl), "DOWNLOADS")
        self.assertEqual(nc._notif_category_for(persist), "DATA")

    def test_importance_reflects_severity(self):
        self.assertEqual(nc.importance_for("info"), "normal")
        self.assertEqual(nc.importance_for("success"), "normal")
        self.assertEqual(nc.importance_for("warning"), "high")
        self.assertEqual(nc.importance_for("error"), "high")
        self.assertEqual(nc.importance_for("critical"), "high")


class RetentionExpiryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.alerts = []
        self.notifs = []
        db = mock.Mock()
        db.alerts = _Coll(self.alerts)
        db.notifications = _Coll(self.notifs)
        db.aggregate = lambda *a, **k: _Rows(self.alerts)
        self.db = db
        self.stack = [
            mock.patch.object(nc, "get_db", return_value=db),
            mock.patch.object(nc, "_publish_frame", new=mock.AsyncMock()),
            mock.patch.object(nc, "_publish_state_counts", new=mock.AsyncMock()),
            mock.patch("services.settings_service.get_setting",
                       new=mock.AsyncMock(return_value=True)),
        ]
        self._started = []
        for p in self.stack:
            p.start()
            self._started.append(p)
            self.addCleanup(p.stop)

    async def test_new_alert_gets_expires_at_plus_24h(self):
        rule = next(r for r in RULES if r.rule_id == "ws_disconnected")
        entry = _entry(event="disconnected", meta={"reason_code": "network_loss"})
        was = datetime.now(timezone.utc)
        await nc._upsert_alert(rule, entry, "warning", self.db)
        a = self.alerts[0]
        exp = a.get("expires_at")
        self.assertIsNotNone(exp)
        delta = exp - was
        self.assertAlmostEqual(delta.total_seconds() / 3600, ALERT_RETENTION_HOURS, delta=0.001)

    async def test_all_alerts_expired_by_retention_sweep(self):
        # Resolved AND active alerts older than 24h must both be removed.
        old = datetime.now(timezone.utc) - timedelta(hours=ALERT_RETENTION_HOURS + 1)
        self.alerts.append({
            "_id": "a1", "status": "active",
            "expires_at": old + timedelta(hours=ALERT_RETENTION_HOURS),
        })
        self.alerts.append({
            "_id": "a2", "status": "resolved",
            "expires_at": old + timedelta(hours=ALERT_RETENTION_HOURS),
        })
        result = await nc.run_retention()
        self.assertEqual(result["deletedAlerts"], 2)

    async def test_legacy_rows_without_expiry_are_expired(self):
        # A legacy row with no expires_at (created > 24h ago) is swept too.
        self.alerts.append({
            "_id": "legacy", "status": "active",
            "created_at": datetime.now(timezone.utc) - timedelta(hours=ALERT_RETENTION_HOURS + 2),
        })
        result = await nc.run_retention()
        self.assertEqual(result["deletedAlerts"], 1)

    async def test_fresh_row_not_expired(self):
        self.alerts.append({
            "_id": "fresh", "status": "active",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=ALERT_RETENTION_HOURS),
        })
        result = await nc.run_retention()
        self.assertEqual(result["deletedAlerts"], 0)

    async def test_backfill_sets_expiry_from_stored_created_at(self):
        base = datetime.now(timezone.utc) - timedelta(hours=3)
        self.alerts.append({"_id": "x1", "category": "websocket", "created_at": base})
        updated = await nc.backfill_alert_metadata()
        self.assertEqual(updated, 1)
        a = self.alerts[0]
        self.assertAlmostEqual(
            (a["expires_at"] - base).total_seconds() / 3600, ALERT_RETENTION_HOURS, delta=0.001,
        )
        # canonical category applied from the raw rule category
        self.assertEqual(a["category"], "WEBSOCKET")

    async def test_alert_summary_provides_category_breakdown(self):
        self.alerts.append({"_id": "s1", "category": "WEBSOCKET", "status": "active",
                            "severity": "critical"})
        self.alerts.append({"_id": "s2", "category": "DATABASE", "status": "resolved",
                            "severity": "error"})
        summary = await nc.alert_summary()
        self.assertEqual(summary["byCategory"].get("WEBSOCKET"), 1)
        self.assertEqual(summary["byCategory"].get("DATABASE"), 1)
        self.assertEqual(summary["total"], 2)

    async def test_notification_summary_unread_important_categories(self):
        now = datetime.now(timezone.utc)
        self.notifs.append({"_id": "n1", "category": "WEBSOCKET", "status": "unread",
                            "read": False, "importance": "high", "severity": "error", "ts": now})
        self.notifs.append({"_id": "n2", "category": "DOWNLOADS", "status": "read",
                            "read": True, "importance": "normal", "severity": "success", "ts": now})
        summary = await nc.notification_summary()
        self.assertEqual(summary["unread"], 1)
        self.assertEqual(summary["read"], 1)
        self.assertEqual(summary["important"], 1)
        self.assertEqual(summary["byCategory"].get("WEBSOCKET"), 1)
        self.assertEqual(summary["byCategory"].get("DOWNLOADS"), 1)
        self.assertIn("retentionDays", summary)

    async def test_notification_settings_include_category_gates(self):
        settings = await nc.get_notification_settings()
        self.assertTrue(settings["notif_enabled"])
        self.assertTrue(settings["retentionReadOnly"])
        cats = settings["categories"]
        for display in nc.NOTIFICATION_CATEGORIES:
            self.assertTrue(cats.get(display), display)


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    async def to_list(self, length=None, *a, **k):
        return self._rows


if __name__ == "__main__":
    unittest.main()