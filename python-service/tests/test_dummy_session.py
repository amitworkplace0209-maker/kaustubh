"""Dummy DAILY-SESSION lifecycle tests (12:00 AM IST reset) — no live MongoDB.

Covers ``services.dummy_session`` and its hooks in ``api.demo`` /
``services.dummy_extras``:
- 12:00 AM IST calendar-date flip (session partition)
- fresh-session creation + operational-store reset (starting capital)
- idempotency (two opens, restart same day → one session, no wipe)
- midnight rollover closes + archives the previous session; audit survives
- order/position/transaction session stamps
- notification trading-date partition (no cross-day badge)
- one-time daily alert expiry on rollover

Run:  python -m pytest tests/test_dummy_session.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, time, timedelta, timezone
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


def utc(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)


class FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    async def to_list(self, length=None):
        return list(self._docs)


class FakeCollection:
    """Minimal async Mongo lookalike for the daily-session lifecycle tests."""

    def __init__(self, docs=None):
        self._docs = list(docs or [])
        self._seq = 0

    def _op(self, doc, key, value):
        if key == "_id":
            return True
        if isinstance(value, dict):
            for operator, operand in value.items():
                if operator == "$ne":
                    if doc.get(key) == operand:
                        return False
                elif operator == "$in":
                    if doc.get(key) not in operand:
                        return False
                elif operator == "$gt":
                    if not (doc.get(key) or 0) > operand:
                        return False
                elif operator == "$gte":
                    if not (doc.get(key) or 0) >= operand:
                        return False
            return True
        return doc.get(key) == value

    def _match(self, doc, query):
        for k, v in (query or {}).items():
            if not self._op(doc, k, v):
                return False
        return True

    async def find_one(self, query=None):
        query = query or {}
        for d in self._docs:
            if self._match(d, query):
                return dict(d)
        return None

    def find(self, query=None, sort=None):
        docs = [d for d in self._docs if self._match(d, query or {})]
        if sort:
            for key, order in reversed(sort):
                docs.sort(key=lambda d: d.get(key, ""), reverse=(order == -1))
        return FakeCursor(docs)

    async def update_one(self, query, update, upsert=False, **kw):
        # Mongo code 40: a path may not appear in BOTH $set and $setOnInsert.
        set_keys = set((update.get("$set") or {}).keys())
        setoninsert_keys = set((update.get("$setOnInsert") or {}).keys())
        overlap = set_keys & setoninsert_keys
        if overlap:
            raise RuntimeError(
                f"Updating the path '{next(iter(overlap))}' would create a conflict")
        for d in self._docs:
            if self._match(d, query):
                if "$set" in update:
                    d.update(update["$set"])
                if "$setOnInsert" in update:
                    for k, v in update["$setOnInsert"].items():
                        d.setdefault(k, v)
                return {"modified_count": 1}
        if upsert:
            doc = dict(query)
            doc.update({k: v for k, v in update.get("$set", {}).items() if k != query.keys()})
            for k in query:
                doc.pop(k if False else k, None)
            doc.update(update.get("$set", {}))
            for k, v in update.get("$setOnInsert", {}).items():
                doc.setdefault(k, v)
            self._docs.append(doc)
            return {"modified_count": 1}
        return {"modified_count": 0}

    async def delete_many(self, query):
        before = len(self._docs)
        self._docs[:] = [d for d in self._docs if not self._match(d, query)]
        return type("Res", (), {"deleted_count": before - len(self._docs)})()

    def seed(self, docs):
        self._docs[:] = list(docs or [])


class FakeDB:
    def __init__(self, **colls):
        for name, docs in colls.items():
            setattr(self, name, FakeCollection(docs))
        if not hasattr(self, "app_settings"):
            self.app_settings = FakeCollection([])
        if not hasattr(self, "dummy_daily_sessions"):
            self.dummy_daily_sessions = FakeCollection([])

    def __getitem__(self, name):
        coll = getattr(self, name, None)
        if coll is None:
            coll = FakeCollection([])
            setattr(self, name, coll)
        return coll


# --------------------------------------------------------------------------- #
# session partition (12:00 AM IST flip — IST calendar date)
# --------------------------------------------------------------------------- #
class SessionDateTest(unittest.TestCase):
    def test_before_midnight_ist_is_same_date(self):
        from services.dummy_session import session_date_for
        ist = timezone(timedelta(hours=5, minutes=30))
        moment = datetime(2026, 9, 8, 23, 59, tzinfo=ist)  # 23:59 IST
        self.assertEqual(session_date_for(moment.astimezone(timezone.utc)), "2026-09-08")

    def test_at_midnight_ist_is_new_date(self):
        from services.dummy_session import session_date_for
        ist = timezone(timedelta(hours=5, minutes=30))
        moment = datetime(2026, 9, 9, 0, 0, tzinfo=ist)  # 00:00 IST sharp
        self.assertEqual(session_date_for(moment.astimezone(timezone.utc)), "2026-09-09")

    def test_evening_ist_is_today(self):
        from services.dummy_session import session_date_for
        ist = timezone(timedelta(hours=5, minutes=30))
        moment = datetime(2026, 9, 9, 15, 30, tzinfo=ist)
        self.assertEqual(session_date_for(moment.astimezone(timezone.utc)), "2026-09-09")


# --------------------------------------------------------------------------- #
# lifecycle (fake Mongo)
# --------------------------------------------------------------------------- #
class DummySessionLifecycleTest(unittest.IsolatedAsyncioTestCase):
    """Dates are expressed as UTC instants; IST = UTC + 05:30.

    * 2026-09-08 03:30 UTC  == 09:00 IST Sep 8 (same calendar date Sep 8)
    * 2026-09-08 18:30 UTC  == 00:00 IST Sep 9 (midnight flip → Sep 9 session)
    * 2026-09-08 18:29 UTC  == 23:59 IST Sep 8 (still Sep 8 session)
    """

    SEP8_0900 = utc(2026, 9, 8, 3, 30)
    SEP8_2359 = utc(2026, 9, 8, 18, 29)
    SEP9_0000 = utc(2026, 9, 8, 18, 30)

    def setUp(self):
        self.db = FakeDB(app_settings=[], dummy_daily_sessions=[])
        self.patchers = [
            mock.patch("services.dummy_session.get_db", return_value=self.db),
            mock.patch("services.dummy_extras.get_db", return_value=self.db),
            mock.patch("api.demo.get_db", return_value=self.db),
            mock.patch("services.dummy_session._now_utc", return_value=self.SEP8_0900),
            mock.patch("services.dummy_extras._now_utc", return_value=self.SEP8_0900),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def _account_doc(self):
        return next((d for d in self.db.app_settings._docs if d.get("key") == "demo_account"), None)

    # ---- fresh open ----------------------------------------------------- #
    async def test_fresh_open_creates_session_and_resets_account(self):
        from services.dummy_session import ensure_dummy_session

        session = await ensure_dummy_session()
        self.assertEqual(session["sessionId"], "DUMMY:2026-09-08")
        self.assertEqual(session["status"], "OPEN")
        self.assertEqual(session["starting_capital"], 100000.0)
        account = self._account_doc()["value"]
        self.assertEqual(account["balance"], 100000)
        self.assertEqual(account["freeMargin"], 100000)
        self.assertEqual(account["usedMargin"], 0)
        self.assertEqual(account["dailyOrders"], 0)
        self.assertEqual(account["totalPnl"], 0)
        self.assertEqual(account["sessionId"], "DUMMY:2026-09-08")

    async def test_no_duplicate_session_on_second_call(self):
        from services.dummy_session import ensure_dummy_session, _now_utc

        first = await ensure_dummy_session()
        # Second call (still 09:00 IST same day) must return the SAME session.
        second = await ensure_dummy_session()
        self.assertEqual(first["sessionId"], second["sessionId"])
        sessions = self.db.dummy_daily_sessions._docs
        self.assertEqual(len(sessions), 1)
        self.assertEqual(len([s for s in sessions if s.get("status") == "OPEN"]), 1)
        del _now_utc

    async def test_restart_same_day_keeps_open_session(self):
        from services.dummy_session import ensure_dummy_session

        # Day 1 open.
        await ensure_dummy_session()
        # Simulate restart within the same day: clock unchanged, store seeded
        # with an intra-day order. ensure must NOT wipe it.
        self.db.app_settings.seed([
            {"key": "demo_orders", "value": [{"orderId": "DEMO1", "status": "COMPLETE"}]},
        ])
        session = await ensure_dummy_session()
        self.assertEqual(session["sessionId"], "DUMMY:2026-09-08")
        orders_doc = next(d for d in self.db.app_settings._docs if d.get("key") == "demo_orders")
        self.assertEqual(len(orders_doc["value"]), 1)

    # ---- midnight rollover -------------------------------------------- #
    async def test_before_midnight_keeps_same_session(self):
        from services.dummy_session import ensure_dummy_session
        await ensure_dummy_session()
        with mock.patch("services.dummy_session._now_utc", return_value=self.SEP8_2359):
            session = await ensure_dummy_session()
        self.assertEqual(session["sessionId"], "DUMMY:2026-09-08")
        self.assertEqual(session["status"], "OPEN")

    async def test_midnight_opens_new_session_and_resets(self):
        from services.dummy_session import ensure_dummy_session
        await ensure_dummy_session()
        # Balance moved during the day; at 12:00 AM it must reset clean.
        self.db.app_settings.seed([{
            "key": "demo_account",
            "value": {"balance": 77777, "freeMargin": 70000, "usedMargin": 7777,
                      "dailyOrders": 2, "totalPnl": 5, "totalCharges": 1},
        }])
        with mock.patch("services.dummy_session._now_utc", return_value=self.SEP9_0000):
            session = await ensure_dummy_session()
        self.assertEqual(session["sessionId"], "DUMMY:2026-09-09")
        account = self._account_doc()["value"]
        self.assertEqual(account["balance"], 100000)
        self.assertEqual(account["dailyOrders"], 0)
        self.assertEqual(account["totalPnl"], 0)

    # ---- rollover / old-data cleanup ---------------------------------- #
    async def test_rollover_archives_previous_and_resets(self):
        from services.dummy_session import ensure_dummy_session

        # Day 1 fully active with operational data.
        await ensure_dummy_session()
        self.db.app_settings.seed([
            {"key": "demo_orders", "value": [{"orderId": "OLD1", "tradingDate": "2026-09-08"}]},
            {"key": "demo_positions", "value": [{"symbol": "INFY", "netQuantity": 10}]},
            {"key": "demo_account", "value": {
                "balance": 80000, "usedMargin": 20000, "freeMargin": 60000,
                "dailyOrders": 3, "totalPnl": 1200, "totalCharges": 55,
                "realizedPnl": 500, "unrealizedPnl": 700}},
            {"key": "dummy_audit_events", "value": [{"category": "order", "action": "place"}]},
        ])

        # Next day at 12:00 AM IST -> rollover.
        with mock.patch("services.dummy_session._now_utc", return_value=self.SEP9_0000):
            session = await ensure_dummy_session()

        self.assertEqual(session["sessionId"], "DUMMY:2026-09-09")
        # Previous session closed and archived.
        closed = next(s for s in self.db.dummy_daily_sessions._docs if s.get("trading_date") == "2026-09-08")
        self.assertEqual(closed["status"], "CLOSED")
        self.assertIsNotNone(closed["closed_at"])
        self.assertEqual(closed["archive"]["orders"][0]["orderId"], "OLD1")
        self.assertEqual(closed["archive"]["positions"][0]["symbol"], "INFY")
        self.assertEqual(closed["archive"]["account"]["totalPnl"], 1200)
        # New operational store is fresh.
        account = self._account_doc()["value"]
        self.assertEqual(account["balance"], 100000)
        self.assertEqual(account["totalPnl"], 0)
        self.assertEqual(account["dailyOrders"], 0)
        # Audit survived (permanent record).
        audit = next(d for d in self.db.app_settings._docs if d.get("key") == "dummy_audit_events")
        self.assertEqual(len(audit["value"]), 1)

    async def test_rollover_expires_previous_daily_alerts(self):
        from services.dummy_session import ensure_dummy_session
        await ensure_dummy_session()
        self.db.app_settings.seed([
            {"key": "dummy_alerts", "value": [
                {"id": "A1", "scope": "DAILY", "sessionDate": "2026-09-08", "status": "ACTIVE"},
                {"id": "A2", "scope": "CONTINUOUS", "status": "ACTIVE"},
            ]},
        ])
        with mock.patch("services.dummy_session._now_utc", return_value=self.SEP9_0000):
            await ensure_dummy_session()
        alerts = next(d for d in self.db.app_settings._docs if d.get("key") == "dummy_alerts")["value"]
        by_id = {a["id"]: a for a in alerts}
        self.assertEqual(by_id["A1"]["status"], "EXPIRED")   # old daily one-time
        self.assertEqual(by_id["A2"]["status"], "ACTIVE")    # persistent config kept

    # ---- retention cap ------------------------------------------------ #
    async def test_retention_caps_closed_sessions(self):
        from services.dummy_session import ensure_dummy_session, MAX_CLOSED_SESSIONS, _apply_retention
        for i in range(MAX_CLOSED_SESSIONS + 10):
            self.db.dummy_daily_sessions._docs.append({
                "_id": f"s{i}", "sessionId": f"DUMMY:2026-01-{i:02d}", "trading_date": f"2026-01-{i:02d}",
                "terminal": "dummy", "status": "CLOSED", "started_at": "",
            })
        await _apply_retention()
        closed = [s for s in self.db.dummy_daily_sessions._docs if s.get("status") == "CLOSED"]
        self.assertLessEqual(len(closed), MAX_CLOSED_SESSIONS)
        # Collectable call (no-op) does not raise.
        await ensure_dummy_session()


# --------------------------------------------------------------------------- #
# engine + terminal hooks
# --------------------------------------------------------------------------- #
class DummySessionHooksTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB(app_settings=[], dummy_daily_sessions=[])
        self.patchers = [
            mock.patch("services.dummy_session.get_db", return_value=self.db),
            mock.patch("api.demo.get_db", return_value=self.db),
            mock.patch("services.dummy_extras.get_db", return_value=self.db),
            mock.patch("services.dummy_session._now_utc", return_value=utc(2026, 9, 9, 3, 30)),
            mock.patch("services.dummy_extras._now_utc", return_value=utc(2026, 9, 9, 3, 30)),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    async def test_order_is_session_stamped(self):
        from api.demo import _execute_order, DemoPlaceOrderRequest
        result = await _execute_order(DemoPlaceOrderRequest(
            symbol="INFY", tradingSymbol="INFY-EQ", exchange="nse_cm", exchangeSegment="NSE_CM",
            token="1594", transactionType="BUY", product="MIS", orderType="MKT", quantity=10, ltp=2000.0,
        ))
        self.assertEqual(result["stat"], "Ok")
        order = result["demoOrder"]
        self.assertEqual(order["tradingDate"], "2026-09-09")
        self.assertEqual(order["sessionId"], "DUMMY:2026-09-09")

    async def test_notifications_partition_by_trading_date(self):
        from services.dummy_extras import notify, list_notifications
        with mock.patch("services.dummy_extras._now_utc", return_value=utc(2026, 9, 9, 3, 30)):
            today = await notify("order", "Placed", "INFY BUY 10")
        with mock.patch("services.dummy_extras._now_utc", return_value=utc(2026, 9, 8, 3, 30)):
            yesterday = await notify("order", "Filled", "OLD DAY")
        today_list = await list_notifications()
        self.assertEqual(today_list["tradingDate"], "2026-09-09")
        # Yesterday's unread must not leak into today's badge.
        self.assertEqual(today_list["unread"], 1)
        self.assertTrue(all(n["id"] != yesterday["id"] for n in today_list["data"]))
        self.assertTrue(any(n["id"] == today["id"] for n in today_list["data"]))


if __name__ == "__main__":
    unittest.main()