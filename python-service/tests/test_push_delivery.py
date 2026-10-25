"""PWA push delivery + notification fan-out tests — no live MongoDB, no network.

The fan-out path is best-effort by contract: disabled backend, zero
subscriptions, or a dead endpoint must never raise into notify().
"""
import unittest
from unittest import mock


class FakeCollection:
    def __init__(self):
        self.docs = {}

    async def update_one(self, filt, update, upsert=False):
        key = filt.get("endpoint")
        doc = self.docs.get(key, {})
        doc.update(update.get("$set", {}))
        for k, v in (update.get("$setOnInsert", {}) or {}).items():
            doc.setdefault(k, v)
        self.docs[key] = doc

    async def delete_one(self, filt):
        gone = self.docs.pop(filt.get("endpoint"), None)
        return mock.Mock(deleted_count=1 if gone else 0)

    def find(self, *a, **k):
        async def _gen():
            for d in self.docs.values():
                yield dict(d)
        return _gen()


class FakeDB(dict):
    def __getitem__(self, key):
        if key not in self:
            self[key] = FakeCollection()
        return dict.__getitem__(self, key)


SUB = {
    "endpoint": "https://push.example/abc",
    "keys": {"p256dh": "p256", "auth": "auth"},
}


class PushTest(unittest.IsolatedAsyncioTestCase):
    async def test_payload_matches_sw_contract(self):
        from services import push_delivery as push

        p = push.build_push_payload(
            "Buy Order Executed", "BUY 10 RELIANCE @ 1200",
            kind="order_executed", symbol="RELIANCE", side="BUY",
            price=1200.0, order_id="DEMO1",
        )
        for field in ("kind", "title", "body", "symbol", "side", "price",
                      "orderId", "url"):
            self.assertIn(field, p)

    async def test_register_list_unregister(self):
        from services import push_delivery as push

        fakedb = FakeDB()
        # get_db is imported inside functions from database.connection
        with mock.patch("database.connection.get_db", return_value=fakedb):
            res = await push.register_subscription(dict(SUB), label="test")
            self.assertTrue(res["ok"])
            subs = await push.list_subscriptions()
            self.assertEqual(len(subs), 1)
            out = await push.unregister_subscription(SUB["endpoint"])
            self.assertEqual(out["removed"], 1)

    async def test_register_rejects_bad_input(self):
        from services import push_delivery as push

        fakedb = FakeDB()
        with mock.patch("database.connection.get_db", return_value=fakedb):
            with self.assertRaises(ValueError):
                await push.register_subscription({"endpoint": ""})

    async def test_fanout_no_subscriptions_never_raises(self):
        from services import push_delivery as push

        fakedb = FakeDB()
        with mock.patch("database.connection.get_db", return_value=fakedb):
            res = await push.fanout_push({"title": "t", "body": "b"})
            self.assertTrue(res["ok"])
            self.assertEqual(res["sent"], 0)

    async def test_fanout_prunes_dead_endpoints(self):
        from services import push_delivery as push

        fakedb = FakeDB()
        fakedb["push_subscriptions"].docs[SUB["endpoint"]] = dict(
            endpoint=SUB["endpoint"], keys=SUB["keys"])

        class Gone(Exception):
            pass

        err = Gone("gone")
        err.response = mock.Mock(status_code=410)
        with mock.patch("database.connection.get_db", return_value=fakedb), \
             mock.patch("pywebpush.webpush", side_effect=err):
            res = await push.fanout_push({"title": "t", "body": "b"})
            self.assertTrue(res["ok"])
            self.assertEqual(res["pruned"], 1)
            self.assertEqual(
                await push.list_subscriptions(), [])


class NotifyHookTest(unittest.IsolatedAsyncioTestCase):
    async def test_push_kind_mapping(self):
        from services.notification_service import _push_kind

        self.assertEqual(_push_kind("ORDER_FILLED"), "order_executed")
        self.assertEqual(_push_kind("TARGET_HIT"), "target")
        self.assertEqual(_push_kind("STOP_LOSS_HIT"), "stop_loss")
        self.assertEqual(_push_kind("SOMETHING_ELSE"), "order_executed")

    async def test_notify_survives_push_failure(self):
        """notify() must persist + return even when fan-out blows up."""
        import services.notification_service as ns

        doc = {"ok": True}

        async def fake_insert(*a, **k):
            return mock.Mock(inserted_id="507f1f77bcf86cd799439011")

        fakedb = mock.Mock()
        fakedb.notifications.insert_one = fake_insert
        with mock.patch("services.notification_service.get_db", return_value=fakedb), \
             mock.patch("services.notification_service._notify_globals_passes",
                        return_value={"ok": True, "realtime": False}), \
             mock.patch("services.notification_service._category_enabled", return_value=True), \
             mock.patch("services.notification_center._notification_category_enabled",
                        return_value=True), \
             mock.patch("services.push_delivery.fanout_push",
                        side_effect=RuntimeError("boom")), \
             mock.patch("services.event_history.record_event",
                        return_value={"event_id": "e1"}):
            out = await ns.notify("trade", "success", "T", "M", metadata={})
            self.assertIsNotNone(out)


if __name__ == "__main__":
    unittest.main()
