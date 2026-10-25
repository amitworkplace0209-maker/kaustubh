"""Watchlist CRUD."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database.connection import get_db

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])


async def _track_canonical(symbol: str, token: str, exchange: str, source: str = "watchlist") -> None:
    """Phase 3: merge into the Session Manager canonical store (best effort)."""
    try:
        from services.session.session_manager import session_manager
        await session_manager.upsert_instrument({
            "exchange_segment": exchange or "nse_cm",
            "instrument_token": str(token),
            "symbol": symbol,
        }, source=source)
    except Exception:
        pass


class AddWatchlistRequest(BaseModel):
    symbol: str
    token: str
    exchange: str = "nse_cm"
    favorite: bool = False


@router.get("")
async def get_watchlist():
    db = get_db()
    cursor = db.watchlist.find({}).sort([("favorite", -1), ("symbol", 1)])
    items = await cursor.to_list(length=None)
    for item in items:
        item["_id"] = str(item["_id"])
    return {"data": items}


@router.post("")
async def add_to_watchlist(req: AddWatchlistRequest):
    db = get_db()
    symbol = req.symbol.upper().strip()
    doc = {
        "symbol": symbol,
        "token": req.token,
        "exchange": req.exchange,
        "favorite": req.favorite,
        "createdAt": datetime.now(timezone.utc),
    }
    await db.watchlist.update_one({"symbol": symbol}, {"$set": doc}, upsert=True)
    saved = await db.watchlist.find_one({"symbol": symbol})
    saved["_id"] = str(saved["_id"])
    await _track_canonical(symbol, req.token, req.exchange)
    return {"data": saved}


@router.delete("/{symbol}")
async def remove_from_watchlist(symbol: str):
    db = get_db()
    result = await db.watchlist.delete_one({"symbol": symbol.upper()})
    if result.deleted_count == 0:
        raise HTTPException(404, f"{symbol} not found in watchlist")
    return {"deleted": 1}


@router.patch("/{symbol}/favorite")
async def toggle_favorite(symbol: str):
    db = get_db()
    item = await db.watchlist.find_one({"symbol": symbol.upper()})
    if not item:
        raise HTTPException(404, f"{symbol} not found in watchlist")
    new_fav = not item.get("favorite", False)
    await db.watchlist.update_one({"symbol": symbol.upper()}, {"$set": {"favorite": new_fav}})
    return {"data": {"symbol": symbol.upper(), "favorite": new_fav}}
