"""System dashboard â€” health, resources, MongoDB stats, trading stats."""
from __future__ import annotations

from scheduler import get_scheduler_info
import asyncio
import logging
from services import tick_buffer
from services.status.status_manager import set_status, get_status
import os
import platform
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from pydantic import BaseModel

from database.connection import get_db, is_mongo_connected
from services import tick_buffer
from services.settings_service import get_setting
from auth.kotak_client import ( kotak_session, SDK_AVAILABLE, SDK_VERSION,)
from ws_socket.ws_manager import ws_manager

router = APIRouter(prefix="/api/system", tags=["system"])
logger = logging.getLogger("app")


class ClearLogsRequest(BaseModel):
    category: str | None = None


async def _safe_call(coro, timeout=5.0, default=None):
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
       logger.error("SAFE_CALL TIMEOUT: %s", coro)
       return default

    except Exception as exc:
       logger.exception("SAFE_CALL ERROR: %s", exc)
       return default


@router.get("")
async def system_status(request: Request):
    import psutil

    process = psutil.Process()
    mem = process.memory_info()
    cpu_percent = process.cpu_percent(interval=0.1)
    uptime_sec = time.time() - process.create_time()

    cpu_load = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage(".")

    # Python status
    # Python status
    python_status = kotak_session.session_info()

    # WebSocket status
    ws_status = ws_manager.status()

    await set_status(
        "websocket",
        "online" if ws_status.get("connected", False) else "offline",
    )

    # Internet
    internet = await _safe_call(_check_internet(), timeout=2.0, default=False)

    db = get_db()
    active_stocks = await db.stocks.count_documents({"active": True})
    total_stocks = await db.stocks.count_documents({})

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_records = await db.ticks.count_documents({"ts": {"$gte": today_start}})
    summary = await db.daily_summaries.find_one({"date": today})

    last_tick = await db.ticks.find_one(sort=[("ts", -1)])
    logger.info(
    "LATEST TICK DEBUG: symbol=%r ts=%r receivedAt=%r",
    last_tick.get("symbol") if last_tick else None,
    last_tick.get("ts") if last_tick else None,
    last_tick.get("receivedAt") if last_tick else None,
)

    # Live tick / MongoDB saving metrics
    tick_stats = tick_buffer.stats() \
    
    # Trading stats
    total_orders = 0
    total_positions = 0
    holdings_count = 0
    funds = None

   
    scheduler_enabled = await get_setting("scheduler_enabled") or True

    return {
        "node": {
            "status": "ok",
            "uptimeSeconds": round(uptime_sec),
            "memory": {
                "rssMb": round(mem.rss / 1024 / 1024, 2),
                "heapUsedMb": round(mem.rss / 1024 / 1024, 2),
                "heapTotalMb": round(mem.rss / 1024 / 1024, 2),
            },
            "cpuLoad1m": cpu_load[0],
            "cpuLoad5m": cpu_load[1],
            "cpuLoad15m": cpu_load[2],
            "cpuPercent": cpu_percent,
            "ramPercent": ram.percent,
            "ramTotalBytes": ram.total,
            "ramUsedBytes": ram.used,
            "ramFreeBytes": ram.free,
            "diskTotalBytes": disk.total,
            "diskUsedBytes": disk.used,
            "diskPercent": disk.percent,
        },
        "python": {
            "status": "ok" if SDK_AVAILABLE else "degraded",
            "sdk_loaded": SDK_AVAILABLE,
        },
        "pythonStatus": python_status,
        "mongo": {"connected": is_mongo_connected()},
        "buffer": tick_stats,
        "activeStocks": active_stocks,
        "totalStocks": total_stocks,
        "todayRecords": today_records,
        "todayInserts": summary.get("totalWrites", 0) if summary else 0,
        "todayDownloads": 0,
        "errorCount": (
                        (summary.get("errorCount", 0) if summary else 0)
                          + tick_stats["totalWriteErrors"]
                        ), "lastTickTime": (
    last_tick["ts"].isoformat()
    if last_tick and hasattr(last_tick["ts"], "isoformat")
    else last_tick["ts"]
    if last_tick
    else None
),
         
        "lastLogin": python_status.get("last_login_at"),
        "lastLogout": python_status.get("last_logout_at"),
        "lastWebSocketConnection": python_status.get("websocket_connected_at"),
        "websocketConnected": ws_status.get("connected", False),
        "schedulerRunning": scheduler_enabled and get_scheduler_info()["running"],
        "schedulerEnabled": scheduler_enabled,
        "sdkLoaded": SDK_AVAILABLE,
        "sdkVersion": SDK_VERSION,
        "internetConnected": internet,
        "totalOrders": total_orders,
        "totalPositions": total_positions,
        "holdingsCount": holdings_count,
        "funds": funds,
        "liveData": {
        "ticksPerSecond": tick_stats["ticksPerSecond"],
        "writesPerSecond": tick_stats["writesPerSecond"],
        "activeTickStocks": tick_stats["activeTickStocks"],
        "lastTickAt": tick_stats["lastTickAt"],
        "lastWriteAt": tick_stats["lastWriteAt"],
         },
    }


@router.get("/mongo-stats")
async def mongo_stats():
    db = get_db()

    if not is_mongo_connected():
        return {
            "connected": False,
            "stats": None,
        }

    client = db.client
    db_name = db.name
    collections = []
    collections_info = await client[db_name].list_collection_names()

    for name in collections_info:

        try:
            count = await client[db_name][name].estimated_document_count()

            stats = await client[db_name].command(
                "collstats",
                name,
            )

            collections.append({
                "name": name,
                "count": count,
                "sizeBytes": stats.get("size", 0),
                "storageBytes": stats.get("storageSize", 0),
                "indexSizeBytes": stats.get("totalIndexSize", 0),
                "indexes": stats.get("nindexes", 0),
            })

        except Exception as exc:
            logger.warning(
                "Mongo collection stats failed for %s: %s",
                name,
                exc,
            )

    db_stats = await client[db_name].command("dbStats")

    ping_start = time.monotonic()

    await client[db_name].command("ping")

    ping_ms = round(
        (time.monotonic() - ping_start) * 1000,
        2,
    )

    return {
        "connected": True,
        "stats": {
            "dbName": db_name,
            "collections": collections,
            "totalSizeBytes": db_stats.get("dataSize", 0),
            "totalStorageBytes": db_stats.get("storageSize", 0),
            "totalIndexSizeBytes": db_stats.get("indexSize", 0),
            "totalObjects": db_stats.get("objects", 0),
            "pingMs": ping_ms,
        },
    }


@router.post("/logs/clear")
async def clear_logs(req: ClearLogsRequest):
    db = get_db()
    filter = {"category": req.category} if req.category else {}
    result = await db.app_logs.delete_many(filter)
    return {"deleted": result.deleted_count}


@router.get("/download-history")
async def download_history():
    db = get_db()
    cursor = db.download_history.find({}).sort("ts", -1).limit(50)
    items = await cursor.to_list(length=50)
    for item in items:
        item["_id"] = str(item["_id"])
        if "ts" in item and isinstance(item["ts"], datetime):
            item["ts"] = item["ts"].isoformat()
    return {"count": len(items), "downloads": items}


@router.get("/trading-day-stats")
async def trading_day_stats(date: str = ""):
    target_date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    db = get_db()
    summary = await db.daily_summaries.find_one({"date": target_date})

    orders = 0
    pnl = 0
    wins = 0
    losses = 0
    charges = 0

    if kotak_session.session_active:
        order_book = await _safe_call(kotak_session.async_order_book(), timeout=2.0)
        if isinstance(order_book, dict):
            data = order_book.get("data", order_book)
            if isinstance(data, list):
                orders = len(data)
                completed = [o for o in data if isinstance(o, dict) and o.get("status") in ("complete", "filled")]
                wins = sum(1 for o in completed if float(o.get("pnl", o.get("realised", 0)) or 0) >= 0)
                losses = sum(1 for o in completed if float(o.get("pnl", o.get("realised", 0)) or 0) < 0)

        positions = await _safe_call(kotak_session.async_positions(), timeout=2.0)
        if isinstance(positions, dict):
            data = positions.get("data", positions)
            if isinstance(data, list):
                pnl = sum(float(p.get("realised", 0) or 0) + float(p.get("unrealised", 0) or 0) for p in data if isinstance(p, dict))
                charges = sum(float(p.get("estimated_charges", p.get("charges", 0)) or 0) for p in data if isinstance(p, dict))

    win_rate = round((wins / orders) * 100) if orders > 0 else 0
    loss_rate = round((losses / orders) * 100) if orders > 0 else 0
    net_profit = pnl - charges

    return {
        "date": target_date,
        "todayPnl": pnl,
        "todayTrades": orders,
        "todayWins": wins,
        "todayLosses": losses,
        "todayWinRate": win_rate,
        "todayLossRate": loss_rate,
        "todayCharges": charges,
        "todayNetProfit": net_profit,
        "summary": summary,
    }


@router.get("/trading-history")
async def trading_history(range: str = "daily", limit: int = 30):
    max_limit = min(max(limit, 1), 365)
    db = get_db()

    if range == "weekly":
        pipeline = [
            {"$group": {"_id": {"year": {"$year": "$date"}, "week": {"$week": "$date"}},
                        "count": {"$sum": 1}, "totalTicks": {"$sum": "$totalTicks"},
                        "totalWrites": {"$sum": "$totalWrites"}, "errorCount": {"$sum": "$errorCount"}}},
            {"$sort": {"_id": 1}},
            {"$limit": max_limit},
        ]
    elif range == "monthly":
        pipeline = [
            {"$group": {"_id": {"year": {"$year": "$date"}, "month": {"$month": "$date"}},
                        "count": {"$sum": 1}, "totalTicks": {"$sum": "$totalTicks"},
                        "totalWrites": {"$sum": "$totalWrites"}, "errorCount": {"$sum": "$errorCount"}}},
            {"$sort": {"_id": 1}},
            {"$limit": max_limit},
        ]
    elif range == "yearly":
        pipeline = [
            {"$group": {"_id": {"year": {"$year": "$date"}},
                        "count": {"$sum": 1}, "totalTicks": {"$sum": "$totalTicks"},
                        "totalWrites": {"$sum": "$totalWrites"}, "errorCount": {"$sum": "$errorCount"}}},
            {"$sort": {"_id": 1}},
            {"$limit": max_limit},
        ]
    else:
        cursor = db.daily_summaries.find({}).sort("date", -1).limit(max_limit)
        results = await cursor.to_list(length=max_limit)
        results.reverse()
        return {"range": range, "count": len(results), "data": results}

    results = await db.daily_summaries.aggregate(pipeline).to_list(length=max_limit)
    return {"range": range, "count": len(results), "data": results}


async def _check_internet() -> bool:
    try:
        import urllib.request
        req = urllib.request.Request("https://www.google.com", method="HEAD")
        urllib.request.urlopen(req, timeout=2)
        return True
    except Exception:
        return False



