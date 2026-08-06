"""Database package — re-exports connection helpers."""

from database.connection import (
    connect_mongo,
    disconnect_mongo,
    get_db,
    is_mongo_connected,
)

__all__ = ["connect_mongo", "disconnect_mongo", "get_db", "is_mongo_connected"]
