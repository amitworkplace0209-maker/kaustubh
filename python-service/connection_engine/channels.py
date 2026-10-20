"""Realtime (WebSocket #2) channel catalogue.

A client subscribes to named *channels*. Market channels map to one built-in
engine field profile + a router priority, so field projection, backpressure and
per-channel rate control are decided end-to-end by the engine and the Connection
Engine fan-out loop. State channels consume bridged backend events (positions /
orders / notifications / system / data) with no tick projection.
"""
from __future__ import annotations

# Market channels: each maps to an engine FieldProfile + router priority.
MARKET_CHANNELS: dict[str, dict] = {
    "watchlist": {
        "profile_id": "WATCHLIST_LIGHT",
        "priority": "P2",
        "min_interval_s": 1.0,
    },
    "market_watch": {
        "profile_id": "WATCHLIST_LIGHT",
        "priority": "P2",
        "min_interval_s": 1.0,
    },
    "trading": {
        "profile_id": "POSITION_CRITICAL",
        "priority": "P1",
        "min_interval_s": 0.5,
    },
    "ai": {
        "profile_id": "AI_HIGH",
        "priority": "P1",
        "min_interval_s": 0.4,
    },
}

# Non-tick channels: fed by the bridged backend state / notification events.
STATE_CHANNELS: dict[str, str] = {
    "positions": "position / pnl / trade.fill events",
    "orders": "order.* lifecycle events",
    "notifications": "notification.* and alert_* events",
    "system": "state_changed / service_changed / connection.* / market.session",
    "data": "pipeline / quality-scan / download events",
    "engines": "live engine status / metrics snapshots (Engine Registry)",
    "market_watch": "market watch engine frames (ranking / pins / status / feed-state)",
    "data_center": "aggregated Data Center snapshot (single authoritative document)",
}


def is_market_channel(channel: str) -> bool:
    return channel in MARKET_CHANNELS


def is_state_channel(channel: str) -> bool:
    return channel in STATE_CHANNELS


def channel_profile(channel: str) -> str | None:
    meta = MARKET_CHANNELS.get(channel)
    return meta["profile_id"] if meta else None


def channel_priority(channel: str) -> str | None:
    meta = MARKET_CHANNELS.get(channel)
    return meta["priority"] if meta else None


def channel_min_interval(channel: str) -> float:
    meta = MARKET_CHANNELS.get(channel)
    return meta["min_interval_s"] if meta else 0.5