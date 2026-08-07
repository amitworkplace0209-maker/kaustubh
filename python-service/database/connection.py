"""Async MongoDB connection manager using Motor."""

import logging
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from config.settings import settings

logger = logging.getLogger("app")

_client: AsyncIOMotorClient | None = None
_db: AsyncIOMotorDatabase | None = None


async def connect_mongo() -> None:
    global _client, _db
    if _client is not None:
        return
    _client = AsyncIOMotorClient(
        settings.mongodb_uri,
        serverSelectionTimeoutMS=10000,
        maxPoolSize=50,
        minPoolSize=5,
    )
    _db = _client[settings.mongodb_database]
    try:
        await _client.admin.command("ping")
        logger.info("MongoDB connected: %s/%s", settings.mongodb_uri, settings.mongodb_database)
    except Exception as exc:
        logger.error("MongoDB connection failed: %s", exc)
        raise
    await _ensure_indexes()


async def disconnect_mongo() -> None:
    global _client, _db
    if _client is not None:
        _client.close()
        _client = None
        _db = None
        logger.info("MongoDB disconnected")


def get_db() -> AsyncIOMotorDatabase:
    if _db is None:
        raise RuntimeError("MongoDB not connected — call connect_mongo() first")
    return _db


def is_mongo_connected() -> bool:
    return _client is not None and _client.get_io_loop() is not None


async def _ensure_indexes() -> None:
    db = get_db()
    await db.ticks.create_index([("symbol", 1), ("ts", -1)], background=True)
    await db.ticks.create_index([("instrumentToken", 1), ("ts", 1)],  background=True)
    await db.stocks.create_index("symbol", unique=True, background=True)
    await db.stocks.create_index("internalIndex", unique=True, background=True)
    await db.stocks.create_index("active", background=True)
    await db.app_logs.create_index([("ts", -1)], background=True)
    await db.app_logs.create_index("category", background=True)
    await db.notifications.create_index("ts", background=True)
    await db.notifications.create_index("read", background=True)
    await db.app_settings.create_index("key", unique=True, background=True)
    await db.watchlist.create_index("symbol", unique=True, background=True)
    await db.watchlist.create_index("favorite", background=True)
    await db.daily_summaries.create_index("date", unique=True, background=True)
    await db.download_history.create_index([("ts", -1)], background=True)
    logger.info("MongoDB indexes ensured")

