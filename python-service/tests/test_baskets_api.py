"""Basket API contract tests — no live MongoDB, no broker.

Guards the three defects the live Basket workspace exposed:

1. a snake_case leg payload silently became ``BUY / MKT`` (the SELL, limit and
   trigger fields were dropped by pydantic) — ``AliasChoices`` now accepts both
   wire shapes,
2. the composer's basket policy (``maxOrders`` / ``allocatedAmount`` /
   ``expiry`` / ``status``) was accepted by the UI and thrown away,
3. a malformed basket id raised ``bson.errors.InvalidId`` out of the router as
   an HTTP 500 instead of a 404.

Also pins the execution contract: every leg goes through
``order_engine.place`` with the leg's real side / order type, ``cancelOnFill``
only cancels the legs AFTER the first fill, a basket with ``cancelOnFill=false``
ends ``completed`` (not ``failed``), and an already-executed basket is never
re-placed.

Run:  python -m pytest tests/test_baskets_api.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.baskets as baskets_api
from api.baskets import router


# ---- fake mongo -------------------------------------------------------------
class _Result:
    def __init__(self, modified: int = 0, deleted: int = 0, inserted_id: ObjectId | None = None):
        self.modified_count = modified
        self.matched_count = modified
        self.deleted_count = deleted
        self.inserted_id = inserted_id


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, length=None):
        return [dict(d) for d in self._docs]


class _Collection:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    def find(self, query=None):
        return _Cursor(self.docs.values())

    async def find_one(self, query):
        doc = self.docs.get(str(query.get("_id")))
        return dict(doc) if doc else None

    async def insert_one(self, doc):
        oid = ObjectId()
        stored = dict(doc)
        stored["_id"] = oid
        self.docs[str(oid)] = stored
        return _Result(inserted_id=oid)

    async def update_one(self, query, update, upsert=False):
        key = str(query.get("_id"))
        doc = self.docs.get(key)
        if doc is None:
            return _Result(modified=0)
        doc.update(update.get("$set", {}))
        return _Result(modified=1)

    async def delete_one(self, query):
        key = str(query.get("_id"))
        if key in self.docs:
            del self.docs[key]
            return _Result(deleted=1)
        return _Result(deleted=0)


class _DB:
    def __init__(self):
        self.basket_orders = _Collection()


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


SNAKE_LEG = {
    "symbol": "RELIANCE",
    "token": "2885",
    "exchange": "nse_cm",
    "transaction_type": "SELL",
    "product": "MIS",
    "order_type": "L",
    "quantity": 1,
    "price": 1400,
    "trigger_price": 1405,
}

CAMEL_LEG = {
    "symbol": "RELIANCE",
    "token": "2885",
    "exchange": "nse_cm",
    "transactionType": "SELL",
    "product": "MIS",
    "orderType": "SL",
    "quantity": "2",
    "price": "1400",
    "triggerPrice": "1395",
}


class BasketsApiTest(unittest.TestCase):
    def setUp(self):
        self.db = _DB()
        self.placed: list[tuple[str, dict]] = []

        async def _place(terminal, order):
            self.placed.append((terminal, order))
            return {"accepted": True, "orderId": f"ORD-{len(self.placed)}"}

        async def _notify(*args, **kwargs):
            return None

        self._patches = [
            mock.patch.object(baskets_api, "get_db", return_value=self.db),
            mock.patch.object(baskets_api, "active_terminal", return_value="dummy"),
            mock.patch.object(baskets_api.order_engine, "place", side_effect=_place),
            mock.patch("services.notification_service.notify", new=_notify),
        ]
        for p in self._patches:
            p.start()
        self.client = TestClient(_make_app(), raise_server_exceptions=False)

    def tearDown(self):
        for p in self._patches:
            p.stop()

    # ---- create ------------------------------------------------------------
    def test_create_accepts_snake_case_leg(self):
        """A SELL limit leg sent snake_case must stay SELL / L (regression:
        it used to be stored as BUY / MKT because the fields were ignored)."""
        r = self.client.post(
            "/api/baskets",
            json={"name": "Snake", "orders": [SNAKE_LEG], "cancelOnFill": False},
        )
        self.assertEqual(r.status_code, 200, r.text)
        leg = r.json()["data"]["orders"][0]
        self.assertEqual(leg["transactionType"], "SELL")
        self.assertEqual(leg["orderType"], "L")
        self.assertEqual(leg["triggerPrice"], "1405")
        self.assertEqual(leg["price"], "1400")
        self.assertEqual(leg["quantity"], "1")

    def test_create_accepts_camel_case_leg(self):
        r = self.client.post(
            "/api/baskets",
            json={"name": "Camel", "orders": [CAMEL_LEG], "cancelOnFill": True},
        )
        self.assertEqual(r.status_code, 200, r.text)
        leg = r.json()["data"]["orders"][0]
        self.assertEqual(leg["transactionType"], "SELL")
        self.assertEqual(leg["orderType"], "SL")
        self.assertEqual(leg["triggerPrice"], "1395")
        self.assertEqual(leg["quantity"], "2")

    def test_create_persists_composer_policy(self):
        """maxOrders / allocatedAmount / expiry / status used to be dropped."""
        r = self.client.post(
            "/api/baskets",
            json={
                "name": "Policy",
                "orders": [CAMEL_LEG],
                "cancelOnFill": True,
                "maxOrders": 5,
                "allocatedAmount": 250000,
                "expiry": "Today",
                "status": "draft",
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()["data"]
        self.assertEqual(data["maxOrders"], 5)
        self.assertEqual(data["allocatedAmount"], 250000)
        self.assertEqual(data["expiry"], "Today")
        self.assertEqual(data["status"], "draft")
        self.assertEqual(data["terminal"], "dummy")

    def test_create_rejects_blank_name(self):
        r = self.client.post("/api/baskets", json={"name": "   ", "orders": [CAMEL_LEG]})
        self.assertEqual(r.status_code, 422, r.text)

    # ---- read --------------------------------------------------------------
    def test_get_returns_data_list(self):
        self.client.post("/api/baskets", json={"name": "A", "orders": [CAMEL_LEG]})
        r = self.client.get("/api/baskets")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIn("data", body)
        self.assertEqual(len(body["data"]), 1)

    # ---- malformed ids -----------------------------------------------------
    def test_delete_invalid_id_is_404_not_500(self):
        r = self.client.delete("/api/baskets/__not_an_object_id__")
        self.assertEqual(r.status_code, 404, r.text)

    def test_update_invalid_id_is_404(self):
        r = self.client.put("/api/baskets/__not_an_object_id__", json={"name": "x"})
        self.assertEqual(r.status_code, 404, r.text)

    def test_push_invalid_id_is_404(self):
        r = self.client.post("/api/baskets/__not_an_object_id__/push")
        self.assertEqual(r.status_code, 404, r.text)

    def test_delete_unknown_id_is_404(self):
        r = self.client.delete(f"/api/baskets/{ObjectId()}")
        self.assertEqual(r.status_code, 404, r.text)

    # ---- update ------------------------------------------------------------
    def test_update_changes_policy_and_orders(self):
        created = self.client.post(
            "/api/baskets",
            json={"name": "Edit", "orders": [CAMEL_LEG], "maxOrders": 2},
        ).json()["data"]
        r = self.client.put(
            f"/api/baskets/{created['_id']}",
            json={"name": "Edited", "allocatedAmount": 50000, "expiry": "This Week"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()["data"]
        self.assertEqual(data["name"], "Edited")
        self.assertEqual(data["allocatedAmount"], 50000)
        self.assertEqual(data["expiry"], "This Week")
        self.assertEqual(data["maxOrders"], 2)

    # ---- push / execution --------------------------------------------------
    def _create(self, **payload):
        body = {"name": "Exec", "orders": [CAMEL_LEG], "cancelOnFill": False}
        body.update(payload)
        r = self.client.post("/api/baskets", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def test_push_routes_leg_through_order_choke_point(self):
        basket = self._create()
        r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(len(self.placed), 1)
        terminal, order = self.placed[0]
        self.assertEqual(terminal, "dummy")
        self.assertEqual(order["transaction_type"], "SELL")
        self.assertEqual(order["order_type"], "SL")
        self.assertEqual(order["trigger_price"], "1395")
        self.assertEqual(order["quantity"], "2")
        self.assertEqual(order["symbol"], "RELIANCE")
        self.assertEqual(body["results"][0]["status"], "executed")
        self.assertEqual(body["basket"]["status"], "completed")
        self.assertEqual(body["basket"]["orders"][0]["orderId"], "ORD-1")

    def test_push_places_every_leg_when_cancel_on_fill_is_off(self):
        basket = self._create(
            orders=[CAMEL_LEG, {**CAMEL_LEG, "symbol": "TCS", "token": "11536"}],
            cancelOnFill=False,
        )
        r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.placed), 2)
        statuses = [x["status"] for x in r.json()["results"]]
        self.assertEqual(statuses, ["executed", "executed"])
        # regression: this used to end 'failed' because first_filled was reset
        self.assertEqual(r.json()["basket"]["status"], "completed")

    def test_push_cancel_on_fill_cancels_later_legs(self):
        basket = self._create(
            orders=[CAMEL_LEG, {**CAMEL_LEG, "symbol": "TCS", "token": "11536"}],
            cancelOnFill=True,
        )
        r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.placed), 1)
        results = r.json()["results"]
        self.assertEqual(results[0]["status"], "executed")
        self.assertEqual(results[1]["status"], "cancelled")
        self.assertEqual(r.json()["basket"]["status"], "completed")

    def test_push_empty_basket_is_400(self):
        basket = self._create(orders=[])
        r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(len(self.placed), 0)

    def test_push_never_re_places_an_executed_basket(self):
        basket = self._create()
        self.client.post(f"/api/baskets/{basket['_id']}/push")
        r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(len(self.placed), 1)

    def test_push_reports_partial_when_a_leg_is_rejected(self):
        async def _place(terminal, order):
            if order["symbol"] == "TCS":
                return {"accepted": False, "error": {"message": "risk rejected"}}
            self.placed.append((terminal, order))
            return {"accepted": True, "orderId": "ORD-1"}

        with mock.patch.object(baskets_api.order_engine, "place", side_effect=_place):
            basket = self._create(
                orders=[CAMEL_LEG, {**CAMEL_LEG, "symbol": "TCS", "token": "11536"}],
                cancelOnFill=False,
            )
            r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["basket"]["status"], "partial")
        self.assertEqual(body["results"][1]["status"], "failed")
        self.assertEqual(body["results"][1]["error"], "risk rejected")

    # ---- terminal routing (Dummy must stay Dummy, Kotak must stay Kotak) ---
    def test_push_routes_to_the_requested_terminal(self):
        """A basket pushed while the page is in Kotak must reach the Kotak
        adapter — never the Dummy one the session happens to hold."""
        basket = self._create()
        r = self.client.post(f"/api/baskets/{basket['_id']}/push", json={"terminal": "kotak"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.placed[0][0], "kotak")
        self.assertEqual(r.json()["terminal"], "kotak")
        self.assertEqual(r.json()["basket"]["terminal"], "kotak")

    def test_push_routes_to_dummy_when_dummy_is_requested(self):
        basket = self._create()
        with mock.patch.object(baskets_api, "active_terminal", return_value="kotak"):
            r = self.client.post(f"/api/baskets/{basket['_id']}/push", json={"terminal": "dummy"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.placed[0][0], "dummy")

    def test_push_falls_back_to_the_baskets_own_terminal(self):
        """No terminal in the body -> the basket's own terminal wins over the
        live session, so a Dummy basket cannot drift onto a real broker."""
        basket = self._create()
        with mock.patch.object(baskets_api, "active_terminal", return_value="kotak"):
            r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.placed[0][0], "dummy")

    def test_push_ignores_an_unknown_terminal(self):
        """A typo must never be coerced into a real broker."""
        basket = self._create()
        r = self.client.post(f"/api/baskets/{basket['_id']}/push", json={"terminal": "kotakk"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.placed[0][0], "dummy")
        self.assertEqual(r.json()["terminal"], "dummy")

    # ---- per-leg result contract -------------------------------------------
    def test_push_results_carry_the_full_leg_contract(self):
        """Every result must expose symbol + accepted, or the UI renders a
        successful leg as a red NOT ACCEPTED (accepted was undefined)."""
        basket = self._create(
            orders=[CAMEL_LEG, {**CAMEL_LEG, "symbol": "TCS", "token": "11536"}],
            cancelOnFill=False,
        )
        r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 200, r.text)
        first = r.json()["results"][0]
        self.assertEqual(first["symbol"], "RELIANCE")
        self.assertIs(first["accepted"], True)
        self.assertEqual(first["orderId"], "ORD-1")
        self.assertIsNone(first["error"])
        self.assertIn("raw", first)

    def test_push_marks_a_rejected_leg_not_accepted(self):
        async def _place(terminal, order):
            return {"accepted": False, "error": {"message": "broker refused"}}

        with mock.patch.object(baskets_api.order_engine, "place", side_effect=_place):
            basket = self._create()
            r = self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(r.status_code, 200, r.text)
        leg = r.json()["results"][0]
        self.assertIs(leg["accepted"], False)
        self.assertEqual(leg["symbol"], "RELIANCE")
        self.assertEqual(leg["error"], "broker refused")

    def test_push_carries_the_observed_ltp_to_the_engine(self):
        """The leg's real LTP must reach the order engine so a price-less
        engine (Dummy) can price the leg instead of rejecting it."""
        basket = self._create(orders=[{**CAMEL_LEG, "expectedLtp": "1402.35"}])
        self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(self.placed[0][1]["expected_ltp"], "1402.35")

    def test_create_persists_expected_ltp(self):
        r = self.client.post(
            "/api/baskets",
            json={"name": "Ltp", "orders": [{**CAMEL_LEG, "expectedLtp": "1402.35"}]},
        )
        self.assertEqual(r.json()["data"]["orders"][0]["expectedLtp"], "1402.35")

    def test_leg_without_a_quote_sends_zero_not_a_guess(self):
        basket = self._create(orders=[CAMEL_LEG])
        self.client.post(f"/api/baskets/{basket['_id']}/push")
        self.assertEqual(self.placed[0][1]["expected_ltp"], "0")

    # ---- read / update regressions ------------------------------------------
    def test_get_single_basket(self):
        created = self._create(name="Single")
        r = self.client.get(f"/api/baskets/{created['_id']}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["name"], "Single")

    def test_get_single_unknown_basket_is_404(self):
        r = self.client.get(f"/api/baskets/{ObjectId()}")
        self.assertEqual(r.status_code, 404, r.text)

    def test_update_with_unchanged_values_is_not_404(self):
        """Re-saving identical values is a no-op, not a missing basket —
        modified_count == 0 used to surface as 404 and broke Save."""
        created = self._create(name="Same", maxOrders=3)
        r = self.client.put(f"/api/baskets/{created['_id']}", json={"name": "Same"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["name"], "Same")


if __name__ == "__main__":
    unittest.main()
