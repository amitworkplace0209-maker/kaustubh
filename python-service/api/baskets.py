"""Basket orders — CRUD + sequential OCO execution."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database.connection import get_db
from auth.kotak_client import kotak_session

router = APIRouter(prefix="/api/baskets", tags=["baskets"])


class BasketOrderItem(BaseModel):
    symbol: str = ""
    token: str = ""
    exchange: str = "nse_cm"
    transactionType: str = "BUY"
    product: str = "MIS"
    orderType: str = "MKT"
    quantity: str = "1"
    price: str = "0"
    triggerPrice: str = "0"


class CreateBasketRequest(BaseModel):
    name: str
    orders: list[BasketOrderItem]
    cancelOnFill: bool = True


class UpdateBasketRequest(BaseModel):
    name: str | None = None
    orders: list[BasketOrderItem] | None = None
    cancelOnFill: bool | None = None


@router.get("")
async def get_baskets():
    db = get_db()
    cursor = db.basket_orders.find({}).sort("createdAt", -1)
    items = await cursor.to_list(length=None)
    for item in items:
        item["_id"] = str(item["_id"])
    return {"data": items}


@router.post("")
async def create_basket(req: CreateBasketRequest):
    db = get_db()
    doc = {
        "name": req.name,
        "orders": [o.model_dump() for o in req.orders],
        "cancelOnFill": req.cancelOnFill,
        "status": "active",
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }
    result = await db.basket_orders.insert_one(doc)
    doc["_id"] = str(result.inserted_id)
    return {"data": doc}


@router.put("/{basket_id}")
async def update_basket(basket_id: str, req: UpdateBasketRequest):
    from bson import ObjectId
    db = get_db()
    update = {"updatedAt": datetime.now(timezone.utc)}
    if req.name is not None:
        update["name"] = req.name
    if req.orders is not None:
        update["orders"] = [o.model_dump() for o in req.orders]
    if req.cancelOnFill is not None:
        update["cancelOnFill"] = req.cancelOnFill
    result = await db.basket_orders.update_one({"_id": ObjectId(basket_id)}, {"$set": update})
    if result.modified_count == 0:
        raise HTTPException(404, "Basket not found")
    updated = await db.basket_orders.find_one({"_id": ObjectId(basket_id)})
    updated["_id"] = str(updated["_id"])
    return {"data": updated}


@router.delete("/{basket_id}")
async def delete_basket(basket_id: str):
    from bson import ObjectId
    db = get_db()
    result = await db.basket_orders.delete_one({"_id": ObjectId(basket_id)})
    if result.deleted_count == 0:
        raise HTTPException(404, "Basket not found")
    return {"deleted": 1}


@router.post("/{basket_id}/push")
async def push_basket(basket_id: str):
    from bson import ObjectId
    db = get_db()
    basket = await db.basket_orders.find_one({"_id": ObjectId(basket_id)})
    if not basket:
        raise HTTPException(404, "Basket not found")
    if basket.get("status") in ("executing", "completed"):
        raise HTTPException(400, f"Basket already {basket['status']}")

    await db.basket_orders.update_one(
        {"_id": ObjectId(basket_id)},
        {"$set": {"status": "executing", "updatedAt": datetime.now(timezone.utc)}},
    )

    cancel_on_fill = basket.get("cancelOnFill", True)
    orders = basket.get("orders", [])
    results = []
    first_filled = False

    for i, order in enumerate(orders):
        if cancel_on_fill and first_filled:
            orders[i]["status"] = "cancelled"
            results.append({"index": i, "status": "cancelled", "reason": "cancelOnFill"})
            continue

        try:
            sdk_result = await kotak_session.async_place_order(
                exchange=order.get("exchange", "nse_cm"),
                token=order.get("token", ""),
                transaction_type=order.get("transactionType", "BUY"),
                product=order.get("product", "MIS"),
                order_type=order.get("orderType", "MKT"),
                quantity=order.get("quantity", "1"),
                price=order.get("price", "0"),
                trigger_price=order.get("triggerPrice", "0"),
                disclosed_quantity="0",
                validity="DAY",
                amo="NO",
                market_protection="NO",
            )
            order_id = ""
            if isinstance(sdk_result, dict):
                order_id = sdk_result.get("n_ord_no") or sdk_result.get("order_id") or ""
            orders[i]["status"] = "executed"
            orders[i]["orderId"] = order_id
            orders[i]["error"] = None
            first_filled = True
            results.append({"index": i, "status": "executed", "orderId": order_id})
        except Exception as exc:
            orders[i]["status"] = "failed"
            orders[i]["orderId"] = ""
            orders[i]["error"] = str(exc)
            results.append({"index": i, "status": "failed", "error": str(exc)})

    final_status = "completed" if first_filled else "failed"
    await db.basket_orders.update_one(
        {"_id": ObjectId(basket_id)},
        {"$set": {
            "status": final_status,
            "orders": orders,
            "updatedAt": datetime.now(timezone.utc),
        }},
    )

    filled = sum(1 for r in results if r["status"] == "executed")
    cancelled = sum(1 for r in results if r["status"] == "cancelled")
    failed = sum(1 for r in results if r["status"] == "failed")
    await db.notifications.insert_one({
        "category": "trading",
        "level": "info" if first_filled else "error",
        "title": f"Basket '{basket['name']}' executed",
        "message": f"{filled} filled, {cancelled} cancelled, {failed} failed",
        "read": False,
        "ts": datetime.now(timezone.utc),
    })

    updated = await db.basket_orders.find_one({"_id": ObjectId(basket_id)})
    updated["_id"] = str(updated["_id"])
    return {"basket": updated, "results": results}
