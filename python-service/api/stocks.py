"""Stock management routes — CRUD + auto-subscribe to WebSocket."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database.connection import get_db
from services import tick_buffer
from websocket.ws_manager import ws_manager

router = APIRouter(prefix="/api/stocks", tags=["stocks"])
logger = logging.getLogger("app")


class AddStockRequest(BaseModel):
    symbol: str
    instrumentToken: str
    exchangeSegment: str = "nse_cm"
    isIndex: bool = False
    isDepth: bool = False


async def _generate_internal_index(db) -> int:
    highest = await db.stocks.find_one(sort=[("internalIndex", -1)])
    return (highest["internalIndex"] + 1) if highest else 1


async def _subscribe_on_ws(db, stock_doc: dict):
    tokens = [{
        "instrument_token": stock_doc["instrumentToken"],
        "exchange_segment": stock_doc["exchangeSegment"],
        "isIndex": stock_doc.get("isIndex", False),
        "isDepth": stock_doc.get("isDepth", False),
        "symbol": stock_doc["symbol"],
    }]
    try:
        await ws_manager.subscribe(tokens)
    except Exception as exc:
        logger.warning("Auto-subscribe failed for %s: %s", stock_doc["symbol"], exc)


async def _unsubscribe_on_ws(token: str, exchange_segment: str):
    try:
        await ws_manager.unsubscribe([{
            "instrument_token": token,
            "exchange_segment": exchange_segment,
        }])
    except Exception as exc:
        logger.warning("Unsubscribe failed: %s", exc)


@router.get("")
async def get_stocks(active: str = "false", q: str = ""):
    db = get_db()
    query = {}
    if active.lower() == "true":
        query["active"] = True
    if q:
        query["symbol"] = {"$regex": q, "$options": "i"}
    cursor = db.stocks.find(query).sort("symbol", 1)
    stocks = await cursor.to_list(length=None)
    for s in stocks:
        s["_id"] = str(s["_id"])
    return {"data": stocks}


@router.post("")
async def add_stock(req: AddStockRequest):
    db = get_db()
    symbol = req.symbol.upper().strip()
    internal_index = await _generate_internal_index(db)
    doc = {
        "symbol": symbol,
        "instrumentToken": req.instrumentToken,
        "exchangeSegment": req.exchangeSegment,
        "internalIndex": internal_index,
        "isIndex": req.isIndex,
        "isDepth": req.isDepth,
        "active": True,
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }
    await db.stocks.update_one(
        {"symbol": symbol},
        {"$set": doc},
        upsert=True,
    )
    saved = await db.stocks.find_one({"symbol": symbol})
    saved["_id"] = str(saved["_id"])
    await _subscribe_on_ws(db, saved)
    return {"data": saved}


@router.post("/search")
async def search_stock_info(req: dict):
    from auth.kotak_client import kotak_session
    search_text = req.get("search_text") or req.get("q") or ""
    if not search_text:
        raise HTTPException(400, "search_text is required")
    if not kotak_session.logged_in:
        raise HTTPException(403, "Not logged in to Kotak")
    results = await kotak_session.async_search_scrip("nse_cm", search_text)
    items = results.get("data", results) if isinstance(results, dict) else results
    if not isinstance(items, list):
        items = []
    enriched = []
    for item in items[:10]:
        d = item if isinstance(item, dict) else {}
        enriched.append(d)
    return {"data": enriched}


@router.delete("/bulk")
async def bulk_delete_stocks(req: dict):
    db = get_db()
    symbols = req.get("symbols", [])
    if not symbols:
        raise HTTPException(400, "symbols is required")
    symbols = [s.upper() for s in symbols]
    for s in symbols:
        stock = await db.stocks.find_one({"symbol": s})
        if stock:
            await _unsubscribe_on_ws(stock["instrumentToken"], stock["exchangeSegment"])
    result = await db.stocks.delete_many({"symbol": {"$in": symbols}})
    return {"deleted": result.deleted_count}


@router.patch("/{symbol}")
async def toggle_stock(symbol: str, req: dict):
    db = get_db()
    stock = await db.stocks.find_one({"symbol": symbol.upper()})
    if not stock:
        raise HTTPException(404, f"Stock {symbol} not found")
    new_active = req.get("active", not stock.get("active", True))
    await db.stocks.update_one(
        {"symbol": symbol.upper()},
        {"$set": {"active": new_active, "updatedAt": datetime.now(timezone.utc)}},
    )
    if new_active:
        await _subscribe_on_ws(db, stock)
    else:
        await _unsubscribe_on_ws(stock["instrumentToken"], stock["exchangeSegment"])
    return {"data": {"symbol": symbol.upper(), "active": new_active}}


@router.delete("/{symbol}")
async def delete_stock(symbol: str):
    db = get_db()
    stock = await db.stocks.find_one({"symbol": symbol.upper()})
    if not stock:
        raise HTTPException(404, f"Stock {symbol} not found")
    await _unsubscribe_on_ws(stock["instrumentToken"], stock["exchangeSegment"])
    await db.stocks.delete_one({"symbol": symbol.upper()})
    return {"deleted": 1}
