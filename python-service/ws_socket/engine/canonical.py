"""Canonical tick normalization for the Central Kotak WebSocket Engine.

Converts decoded SFeed typed messages into a stable canonical envelope. Raw
broker values are copied verbatim (the SDK already applied price scaling in
``protocol.decode_packet``); they are never overwritten by calculated values.
Calculated (DERIVED) fields never enter this layer.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import deque
from dataclasses import dataclass, field

from neo_api_client.websocket.feed.models import (
    SFeedCasChange,
    SFeedIndex,
    SFeedMarketStatus,
    SFeedScrip,
    SFeedScripLite,
    DepthLevel,
)

SCHEMA_VERSION = "1.0"


def _resolve_sdk_version() -> str:
    """Installed kotakneoapi version, so stored ticks are not stamped stale.

    This was hardcoded to "3.0.6", which meant every canonicalized tick
    carried the old SDK version after the upgrade to 3.0.7. Resolve it from
    the installed distribution and fall back to the installed
    ``auth.kotak_client.SDK_VERSION``.
    """
    try:
        from importlib.metadata import version

        return version("kotakneoapi")
    except Exception:
        try:
            from auth.kotak_client import SDK_VERSION as _sdk

            return _sdk or "unknown"
        except Exception:
            return "unknown"


SDK_VERSION = _resolve_sdk_version()  # kotakneoapi; resolved from .venv dist-info

# canonical field name <-> SFeed attribute.
_SCRIP_FIELDS: dict[str, str] = {
    "ltp": "last_traded_price",
    "ltq": "last_trade_qty",
    "open": "open_price",
    "high": "high_price",
    "low": "low_price",
    "prev_close": "close_price",
    "avg_price": "average_trade_price",
    "volume": "volume_traded_today",
    "total_buy_quantity": "total_buy_quantity",
    "total_sell_quantity": "total_sell_quantity",
    "open_interest": "open_interest",
    "net_change": "net_change",
    "net_change_pct": "net_change_percent",
    "upper_circuit_limit": "upper_circuit_limit",
    "lower_circuit_limit": "lower_circuit_limit",
    "yearly_high": "yearly_high",
    "yearly_low": "yearly_low",
    "total_traded_value": "total_traded_value",
    "market_lot": "market_lot",
    "precision": "precision",
    "multiplier": "multiplier",
    "auction": "auction",
    "last_trade_time": "last_trade_time",
    "last_update_time": "last_update_time",
}

_LITE_FIELDS: dict[str, str] = {
    "ltp": "last_traded_price",
    "ltq": "last_trade_qty",
    "prev_close": "close_price",
    "net_change": "net_change",
    "net_change_pct": "net_change_percent",
    "market_lot": "market_lot",
    "precision": "precision",
    "multiplier": "multiplier",
    "last_trade_time": "last_trade_time",
}

_INDEX_FIELDS: dict[str, str] = {
    "name": "name",
    "ltp": "last_traded_price",
    "open": "open_price",
    "high": "high_price",
    "low": "low_price",
    "prev_close": "close_price",
    "net_change": "change",
    "net_change_pct": "net_change_percent",
    "yearly_high": "yearly_high",
    "yearly_low": "yearly_low",
    "last_trade_time": "last_trade_time",
    "precision": "precision",
    "multiplier": "multiplier",
}

_MARKET_STATUS_FIELDS: dict[str, str] = {
    "status_code": "status_code",
    "status": "status",
}

_CAS_FIELDS: dict[str, str] = {
    "ref_price": "ref_price",
    "imbalance_qty": "imbalance_qty",
    "imbalance_qty_at_market": "imbalance_qty_at_market",
}

# All canonical field names that the market WebSocket can provide directly
# (DIRECT_WS + WS_CONDITIONAL). Used by the FULL_RAW profile and by field
# validation in the profile store.
FULL_WS_FIELDS: tuple[str, ...] = tuple(
    dict.fromkeys(
        list(_SCRIP_FIELDS)
        + list(_LITE_FIELDS)
        + list(_INDEX_FIELDS)
        + list(_MARKET_STATUS_FIELDS)
        + list(_CAS_FIELDS)
        + ["buy", "sell"]
    )
)

# Canonical depth row name -> SFeed DepthLevel attribute (level 4/8/16).
_DEPTH_MAP: dict[str, str] = {"quantity": "quantity", "price": "price", "orders": "orders"}


def _depth_list(levels: list[DepthLevel]) -> list[dict]:
    return [
        {out: getattr(level, attr) for out, attr in _DEPTH_MAP.items()}
        for level in (levels or [])
    ]


def _feed_type(level: int) -> str:
    if level == 1:
        return "scrip_lite"
    if level == 4:
        return "touch_line"
    if level == 8:
        return "depth"
    if level == 16:
        return "full_depth"
    return "scrip"


def _project_fields(message) -> dict:
    if isinstance(message, SFeedScrip):
        return {out: getattr(message, attr) for out, attr in _SCRIP_FIELDS.items()}
    if isinstance(message, SFeedScripLite):
        return {out: getattr(message, attr) for out, attr in _LITE_FIELDS.items()}
    if isinstance(message, SFeedIndex):
        return {out: getattr(message, attr) for out, attr in _INDEX_FIELDS.items()}
    if isinstance(message, SFeedMarketStatus):
        return {out: getattr(message, attr) for out, attr in _MARKET_STATUS_FIELDS.items()}
    if isinstance(message, SFeedCasChange):
        return {out: getattr(message, attr) for out, attr in _CAS_FIELDS.items()}
    return {}


def digest_raw(message) -> str:
    """Stable digest for a typed message, used as an immutable raw reference."""
    return hashlib.md5(
        f"{type(message).__name__}|{message.exchange_segment}|{getattr(message, 'instrument_token', '')}".encode()
    ).hexdigest()[:12]


def canonicalize(message, received_at: float | None = None, event_counter: int = 0, sdk_version: str = SDK_VERSION, schema_version: str = SCHEMA_VERSION) -> dict:
    """Build the canonical envelope for one decoded SFeed message.

    The returned dict has a ``fields`` block holding verbatim broker values
    (nullable attributes are null) plus envelope metadata. Raw broker object
    is NOT mutated.
    """
    if message is None:
        return {}
    received_at = received_at if received_at is not None else time.time()

    fields = _project_fields(message)
    if isinstance(message, SFeedScrip):
        fields["buy"] = _depth_list(getattr(message, "buy") or [])
        fields["sell"] = _depth_list(getattr(message, "sell") or [])
        feed_type = _feed_type(getattr(message, "level", 0))
        feed_level = getattr(message, "level", None)
    elif isinstance(message, SFeedScripLite):
        feed_type = "scrip_lite"
        feed_level = 1
    elif isinstance(message, SFeedIndex):
        feed_type = "index"
        feed_level = None
    elif isinstance(message, SFeedMarketStatus):
        feed_type = "market_status"
        feed_level = None
    elif isinstance(message, SFeedCasChange):
        feed_type = "cas_change"
        feed_level = None
    else:
        feed_type = "unknown"
        feed_level = None

    return {
        "event_id": f"tck_{event_counter:012d}",
        "event_type": "tick",
        "schema_version": schema_version,
        "sdk_version": sdk_version,
        "received_at": received_at,
        "broker_timestamp": fields.get("last_trade_time") or fields.get("last_update_time"),
        # Broker message-generation time, used ONLY for true latency (A/E/G).
        # ``last_update_time`` is when the broker produced/updated this feed
        # message; ``last_trade_time`` is when the instrument last traded, which
        # for depth feeds can be many seconds old on illiquid scrips. Unlike
        # ``broker_timestamp`` this is never used for the feedAge freshness
        # metric (websocket-engine.md §18) — keeping the two meanings separate.
        "broker_update_time": fields.get("last_update_time") or fields.get("last_trade_time"),
        # Broker sequence is carried only when the SDK actually provides one;
        # the quality monitor reports sequence gaps as unavailable otherwise
        # (never fabricated — websocket-engine.md §18).
        "sequence": getattr(message, "sequence", None),
        "exchange_segment": getattr(message, "exchange_segment", ""),
        "instrument_token": str(getattr(message, "instrument_token", "")),
        "trading_symbol": getattr(message, "trading_symbol", None),
        "feed_type": feed_type,
        "feed_level": feed_level,
        "fields": fields,
        "raw_reference": f"preserved|{digest_raw(message)}",
        "source": "kotak_neo_sfeed",
    }


@dataclass
class PreservedRawStore:
    """Immutable raw-blob store.

    Raw broker messages are kept verbatim (never edited by later layers) in a
    bounded window keyed by digest. ``get()`` returns an opaque reference that
    the Raw Tick Inspector can resolve over REST.
    """

    _store: dict[str, dict] = field(default_factory=dict)
    _order: deque = field(default_factory=deque)
    max_entries: int = 20000

    def put(self, message) -> str:
        reference = f"preserved|{digest_raw(message)}"
        if reference in self._store:
            return reference
        try:
            blob = message.model_dump(mode="json")
        except Exception:  # pragma: no cover
            blob = {"type": type(message).__name__,
                    "exchange_segment": getattr(message, "exchange_segment", None),
                    "instrument_token": getattr(message, "instrument_token", None)}
        self._store[reference] = {"saved_at": time.time(), "raw": blob, "type": type(message).__name__}
        self._order.append(reference)
        while len(self._order) > self.max_entries:
            old = self._order.popleft()
            self._store.pop(old, None)
        return reference

    def get(self, reference: str) -> dict | None:
        return self._store.get(reference)

    def size(self) -> int:
        return len(self._order)


def depth_to_json(reference: str) -> str:
    return json.dumps({"reference": reference}, separators=(",", ":"))