"""Fetch active stocks directly from MongoDB (no Node.js HTTP hop)."""
from __future__ import annotations

import logging

from database.connection import get_db

logger = logging.getLogger("app")


async def fetch_active_stocks() -> list[dict]:
    """Return active subscription tokens for the WebSocket."""
    try:
        db = get_db()
        cursor = db.stocks.find({"active": True})
        stocks = await cursor.to_list(length=None)
        return [
            {
                "instrument_token": s["instrumentToken"],
                "exchange_segment": s.get("exchangeSegment", "nse_cm"),
                "isIndex": s.get("isIndex", False),
                "isDepth": s.get("isDepth", False),
                "symbol": s["symbol"],
            }
            for s in stocks
        ]
    except Exception as exc:
        logger.error("Failed to fetch active stocks: %s", exc)
        return []

