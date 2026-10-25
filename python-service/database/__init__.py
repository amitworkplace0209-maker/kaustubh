"""Database package — the single MongoDB access layer for the backend."""

from database.connection import (
    MongoConnectionError,
    connect_mongo,
    disconnect_mongo,
    get_db,
    get_mongo_info,
    is_mongo_connected,
    ping_mongo,
    connect_test_mongo,
    disconnect_test_mongo,
    get_test_db,
    is_test_mongo_connected,
)

__all__ = [
    "MongoConnectionError",
    "connect_mongo",
    "disconnect_mongo",
    "get_db",
    "get_mongo_info",
    "is_mongo_connected",
    "ping_mongo",
    "connect_test_mongo",
    "disconnect_test_mongo",
    "get_test_db",
    "is_test_mongo_connected",
]
