"""Basket orders — CRUD + sequential OCO execution.

Every leg flows through the SINGLE order choke point
(Risk → Audit → Adapter); this router never calls a broker SDK directly.

Wire contract
-------------
The frontend stores legs in **camelCase** (`transactionType`, `orderType`,
`triggerPrice`) — the shape `lib/api.ts` documents as `BasketOrder`. Older
callers (and hand-written payloads) send snake_case (`transaction_type`,
`order_type`, `trigger_price`). Both are accepted through ``AliasChoices`` so a
SELL / limit / SL leg can never be silently coerced into a BUY market order by
an ignored field.
"""
from __future__ import annotations

import logging

from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from database.connection import get_db
from core.engines import order_engine
from brokers.manager import TERMINALS, active_terminal

router = APIRouter(prefix="/api/baskets", tags=["baskets"])
logger = logging.getLogger("api_baskets")

_BASKET_STATUSES = ("draft", "active", "executing", "completed", "partial", "failed", "expired")


class BasketOrderItem(BaseModel):
    """One basket leg. Accepts camelCase (canonical) and snake_case aliases."""

    model_config = ConfigDict(populate_by_name=True)

    symbol: str = ""
    token: str = ""
    exchange: str = "nse_cm"
    transactionType: str = Field("BUY", validation_alias=AliasChoices("transactionType", "transaction_type"))
    product: str = "MIS"
    orderType: str = Field("MKT", validation_alias=AliasChoices("orderType", "order_type"))
    quantity: str = "1"
    price: str = "0"
    triggerPrice: str = Field("0", validation_alias=AliasChoices("triggerPrice", "trigger_price"))
    # The REAL observed LTP for this leg at compose time. Carried with the leg
    # so a price-less engine (the Dummy paper engine) can execute it instead of
    # rejecting with "Market LTP unavailable". Never synthesised — when the page
    # has no live quote it sends 0 and the leg fails honestly.
    expectedLtp: str = Field("0", validation_alias=AliasChoices("expectedLtp", "expected_ltp"))

    @field_validator("symbol", "token", "exchange", "transactionType", "product", "orderType", mode="before")
    @classmethod
    def _coerce_str(cls, v):
        return "" if v is None else str(v)

    @field_validator("quantity", "price", "triggerPrice", "expectedLtp", mode="before")
    @classmethod
    def _coerce_num_str(cls, v):
        if v is None or v == "":
            return "0"
        return str(v)


class CreateBasketRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    orders: list[BasketOrderItem]
    cancelOnFill: bool = True
    # Basket policy the composer edits — persisted so the limits the UI shows
    # are the limits the backend enforces.
    maxOrders: int | None = Field(None, validation_alias=AliasChoices("maxOrders", "max_orders"))
    allocatedAmount: float | None = Field(None, validation_alias=AliasChoices("allocatedAmount", "allocated_amount"))
    expiry: str | None = None
    status: Literal["draft", "active"] = "active"

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("basket name is required")
        return v


class UpdateBasketRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str | None = None
    orders: list[BasketOrderItem] | None = None
    cancelOnFill: bool | None = None
    maxOrders: int | None = Field(None, validation_alias=AliasChoices("maxOrders", "max_orders"))
    allocatedAmount: float | None = Field(None, validation_alias=AliasChoices("allocatedAmount", "allocated_amount"))
    expiry: str | None = None
    status: str | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("basket name is required")
        return v

    @field_validator("status")
    @classmethod
    def _status_known(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if v not in _BASKET_STATUSES:
            raise ValueError(f"status must be one of {', '.join(_BASKET_STATUSES)}")
        return v


def _oid(basket_id: str) -> ObjectId:
    """Path param → ObjectId. A malformed id is a client error (404), never a
    500 from an unhandled bson.InvalidId."""
    try:
        return ObjectId(basket_id)
    except (InvalidId, TypeError):
        raise HTTPException(404, "Basket not found")


def _pick(leg: dict, *keys: str, default: str = "") -> str:
    """First present key wins — reads camelCase and snake_case leg shapes."""
    for key in keys:
        if key in leg and leg[key] not in (None, ""):
            return str(leg[key])
    return default


def _basket_leg_to_order(order: dict) -> dict:
    """Map a stored basket leg to the order-engine snake_case order intent.
    Accepts the camelCase wire shape AND a legacy snake_case document so the
    stored side / order type / trigger are what actually reach the adapter."""
    return {
        "exchange": _pick(order, "exchange", default="nse_cm"),
        "token": _pick(order, "token"),
        "symbol": _pick(order, "symbol"),
        "transaction_type": _pick(order, "transactionType", "transaction_type", default="BUY").upper(),
        "product": _pick(order, "product", default="MIS"),
        "order_type": _pick(order, "orderType", "order_type", default="MKT").upper(),
        "quantity": _pick(order, "quantity", default="1"),
        "price": _pick(order, "price", default="0") or "0",
        "trigger_price": _pick(order, "triggerPrice", "trigger_price", default="0") or "0",
        "expected_ltp": _pick(order, "expectedLtp", "expected_ltp", default="0") or "0",
    }


def _resolve_terminal(basket: dict, requested: str | None = None) -> str:
    """Which broker adapter a basket executes against.

    A basket must land on the terminal the trader is currently working in —
    Dummy-composed legs run on the Dummy adapter, Kotak-composed legs on the
    Kotak adapter, never one on the other's book. Resolution order:

    1. ``requested`` — the terminal the caller's page is in (its TradingMode),
    2. ``basket['terminal']`` — the terminal the basket was composed under,
    3. ``active_terminal()`` — the live backend session terminal.

    An unknown value is never coerced into a real broker; it falls through to
    the next source so a typo can never route a live order to the wrong adapter.
    """
    for candidate in (requested, basket.get("terminal")):
        term = str(candidate or "").strip().lower()
        if term in TERMINALS:
            return term
    return active_terminal()


def _doc_out(doc: dict) -> dict:
    doc["_id"] = str(doc["_id"])
    return doc


@router.get("")
async def get_baskets():
    db = get_db()
    cursor = db.basket_orders.find({}).sort("createdAt", -1)
    items = await cursor.to_list(length=None)
    return {"data": [_doc_out(item) for item in items]}


@router.post("")
async def create_basket(req: CreateBasketRequest):
    db = get_db()
    now = datetime.now(timezone.utc)
    doc = {
        "name": req.name,
        "orders": [o.model_dump() for o in req.orders],
        "cancelOnFill": req.cancelOnFill,
        "maxOrders": req.maxOrders,
        "allocatedAmount": req.allocatedAmount,
        "expiry": req.expiry,
        "status": req.status,
        "terminal": active_terminal(),
        "createdAt": now,
        "updatedAt": now,
    }
    result = await db.basket_orders.insert_one(doc)
    doc["_id"] = str(result.inserted_id)
    return {"data": doc}


@router.put("/{basket_id}")
async def update_basket(basket_id: str, req: UpdateBasketRequest):
    oid = _oid(basket_id)
    db = get_db()
    update: dict = {"updatedAt": datetime.now(timezone.utc)}
    if req.name is not None:
        update["name"] = req.name
    if req.orders is not None:
        update["orders"] = [o.model_dump() for o in req.orders]
    if req.cancelOnFill is not None:
        update["cancelOnFill"] = req.cancelOnFill
    if req.maxOrders is not None:
        update["maxOrders"] = req.maxOrders
    if req.allocatedAmount is not None:
        update["allocatedAmount"] = req.allocatedAmount
    if req.expiry is not None:
        update["expiry"] = req.expiry
    if req.status is not None:
        update["status"] = req.status
    # `matched_count`, not `modified_count`: re-saving a basket with unchanged
    # values is a legitimate no-op, not a missing basket (modified_count == 0
    # used to surface as a 404 and made "Save" look broken).
    result = await db.basket_orders.update_one({"_id": oid}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(404, "Basket not found")
    updated = await db.basket_orders.find_one({"_id": oid})
    if not updated:
        raise HTTPException(404, "Basket not found")
    return {"data": _doc_out(updated)}


@router.get("/{basket_id}")
async def get_basket(basket_id: str):
    """Single-basket read. Needed because id-level GET previously 405'd, so no
    caller could re-check one basket without refetching the whole list."""
    oid = _oid(basket_id)
    db = get_db()
    doc = await db.basket_orders.find_one({"_id": oid})
    if not doc:
        raise HTTPException(404, "Basket not found")
    return {"data": _doc_out(doc)}


@router.delete("/{basket_id}")
async def delete_basket(basket_id: str):
    oid = _oid(basket_id)
    db = get_db()
    result = await db.basket_orders.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(404, "Basket not found")
    return {"deleted": 1}


@router.post("/{basket_id}/push")
async def push_basket(basket_id: str, body: dict | None = None):
    oid = _oid(basket_id)
    db = get_db()
    basket = await db.basket_orders.find_one({"_id": oid})
    if not basket:
        raise HTTPException(404, "Basket not found")

    orders = basket.get("orders", [])
    if not orders:
        raise HTTPException(400, "Basket has no legs to execute")
    if any(str(o.get("status", "")).upper() in ("EXECUTED", "FILLED") for o in orders):
        raise HTTPException(400, "Basket already executed — duplicate legs are never re-placed")
    if basket.get("status") in ("executing", "completed"):
        raise HTTPException(400, f"Basket already {basket['status']}")

    terminal = _resolve_terminal(basket, (body or {}).get("terminal"))

    await db.basket_orders.update_one(
        {"_id": oid},
        {"$set": {"status": "executing", "terminal": terminal,
                  "updatedAt": datetime.now(timezone.utc)}},
    )

    cancel_on_fill = basket.get("cancelOnFill", True)
    first_filled = False
    results: list[dict] = []

    for i, order in enumerate(orders):
        symbol = str(_pick(order, "symbol") or "").upper()
        if cancel_on_fill and first_filled:
            orders[i]["status"] = "cancelled"
            orders[i]["orderId"] = ""
            orders[i]["error"] = "cancelOnFill"
            results.append({"index": i, "symbol": symbol, "accepted": False,
                            "orderId": None, "status": "cancelled",
                            "error": "cancelOnFill", "reason": "cancelOnFill", "raw": {}})
            continue

        # Every leg flows through the SINGLE order choke point (Risk → Audit →
        # Adapter) on the resolved terminal — the basket never calls a broker
        # SDK directly, and never crosses terminals mid-basket.
        mapped = _basket_leg_to_order(order)
        try:
            placed = await order_engine.place(terminal, mapped)
            if placed.get("accepted"):
                order_id = placed.get("orderId") or ""
                orders[i]["status"] = "executed"
                orders[i]["orderId"] = order_id
                orders[i]["error"] = None
                first_filled = True
                results.append({"index": i, "symbol": symbol, "accepted": True,
                                "orderId": order_id, "status": "executed",
                                "error": None, "raw": placed})
            else:
                err = placed.get("error") or {}
                msg = err.get("message") if isinstance(err, dict) else str(err)
                orders[i]["status"] = "failed"
                orders[i]["orderId"] = ""
                orders[i]["error"] = msg or "order rejected"
                results.append({"index": i, "symbol": symbol, "accepted": False,
                                "orderId": placed.get("orderId") or None,
                                "status": "failed", "error": msg or "order rejected",
                                "raw": placed})
        except Exception as exc:
            logger.debug("Basket leg %s failed: %s", i, exc, exc_info=True)
            orders[i]["status"] = "failed"
            orders[i]["orderId"] = ""
            orders[i]["error"] = str(exc)
            results.append({"index": i, "symbol": symbol, "accepted": False,
                            "orderId": None, "status": "failed", "error": str(exc),
                            "raw": {}})

    accepted = sum(1 for r in results if r["status"] == "executed")
    failed = sum(1 for r in results if r["status"] == "failed")
    cancelled = sum(1 for r in results if r["status"] == "cancelled")
    # Honest end state: every leg placed (or intentionally cancelled by
    # cancelOnFill) -> completed; a mix -> partial; nothing -> failed.
    if failed == 0 and accepted > 0:
        final_status = "completed"
    elif accepted > 0:
        final_status = "partial"
    else:
        final_status = "failed"

    await db.basket_orders.update_one(
        {"_id": oid},
        {"$set": {
            "status": final_status,
            "orders": orders,
            "terminal": terminal,
            "executedAt": datetime.now(timezone.utc),
            "updatedAt": datetime.now(timezone.utc),
        }},
    )

    try:
        from services.notification_service import notify
        await notify(
            "trading",
            "info" if accepted else "error",
            f"Basket '{basket['name']}' executed",
            f"{accepted} executed, {cancelled} cancelled, {failed} failed",
            source="trading", event_type="basket_executed",
            metadata={"basket_id": str(basket.get("_id") or ""),
                      "filled": accepted, "cancelled": cancelled, "failed": failed,
                      "status": final_status},
        )
    except Exception:
        logger.debug("Basket execution notification skipped", exc_info=True)

    updated = await db.basket_orders.find_one({"_id": oid})
    if not updated:
        raise HTTPException(404, "Basket not found")
    return {
        "basket": _doc_out(updated),
        "terminal": terminal,
        "ok": final_status in ("completed", "partial"),
        "status": final_status,
        "accepted": accepted,
        "failed": failed,
        "cancelled": cancelled,
        "results": results,
    }
