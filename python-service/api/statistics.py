"""Statistics — aggregate tick data + gainers/losers."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter

from database.connection import get_db

router = APIRouter(prefix="/api/statistics", tags=["statistics"])
logger = logging.getLogger("app")


@router.get("")
async def get_statistics(start: str = "", end: str = ""):
    db = get_db()
    match = {}
    if start:
        try:
            match["ts"] = {"$gte": datetime.fromisoformat(start.replace("Z", "+00:00"))}
        except ValueError:
            pass
    if end:
        match.setdefault("ts", {})
        try:
            match["ts"]["$lte"] = datetime.fromisoformat(end.replace("Z", "+00:00"))
        except ValueError:
            pass

    pipeline = [
        {"$match": match} if match else {"$match": {}},
        {
            "$group": {
                "_id": "$symbol",
                "count": {"$sum": 1},
                "firstTs": {"$min": "$ts"},
                "lastTs": {"$max": "$ts"},
                "minLtp": {"$min": "$ltp"},
                "maxLtp": {"$max": "$ltp"},
            }
        },
        {"$sort": {"count": -1}},
    ]
    stats = await db.ticks.aggregate(pipeline, maxTimeMS=30000).to_list(length=None)

    total_active = await db.stocks.count_documents({"active": True})
    total_ticks = await db.ticks.estimated_document_count()

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    summary = await db.daily_summaries.find_one({"date": today})

    return {
        "data": {
            "perSymbol": stats,
            "totalActiveStocks": total_active,
            "totalTicksAllTime": total_ticks,
            "todaySummary": summary,
        }
    }


@router.get("/gainers-losers")
async def gainers_losers(filter: int = 0, limit: int = 20):
    db = get_db()
    limit = min(max(limit, 1), 50)

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    pipeline = [
        {"$match": {"ts": {"$gte": today_start}, "exchangeSegment": "nse_cm"}},
        {
            "$group": {
                "_id": "$symbol",
                "open": {"$first": "$ltp"},
                "ltp": {"$last": "$ltp"},
                "high": {"$max": "$high"},
                "low": {"$min": "$low"},
                "change": {"$last": "$change"},
                "changePercent": {"$last": "$changePercent"},
            }
        },
        {"$addFields": {"priceChange": {"$subtract": ["$ltp", "$open"]}}},
        *( [{"$match": {"ltp": {"$gte": filter}}}] if filter > 0 else [] ),
        {"$sort": {"priceChange": -1}},
    ]
    results = await db.ticks.aggregate(pipeline, maxTimeMS=30000).to_list(length=None)

    gainers = results[:limit]
    losers = list(reversed(results))[:limit]

    return {"data": {"gainers": gainers, "losers": losers}}

