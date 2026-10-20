"""Master Canonical Market Data Adapter.

Transforms the existing broker-normalized canonical envelope (``ws_socket.engine.canonical``
output, itself a lossless decode of the Kotak SFeed ``SFeedScrip`` / ``SFeedScripLite`` /
``SFeedIndex`` / ``SFeedMarketStatus`` / ``SFeedCasChange`` models) into ONE authoritative,
stable, human-readable + ML-friendly canonical market-data object with:

* full semantic de-duplication (one canonical name per underlying semantic value)
* type / unit / scale normalization (prices INR float, quantities shares int, times epoch s)
* variable-length depth arrays ``buy[]`` / ``sell[]`` (NO 5-row assumption; L16 full-depth compatible)
* deterministic alias-conflict policy (never a silent pick)
* validation issues reported, never silently dropped
* separate raw audit envelope (raw payload is NOT mixed into the canonical semantics;
  only an immutable digest reference is carried inline)
* feed / schema metadata + adapter version

Contract (L8_MASTER_CANONICAL_ADAPTER_FORENSIC_AUDIT):
  RAW KOTAK L8  ->  DECODE (SDK)  ->  VALIDATE  ->  NORMALIZE
  ->  SEMANTIC DEDUPLICATION  ->  CANONICALIZATION  ->  MASTER CANONICAL  ->  FEATURE ENGINE

The adapter is a pure function of its input; it performs no I/O and never talks to a
broker. Consumers (Feature Engine, storage, API) read ONLY canonical fields.
"""

from __future__ import annotations

import time
from typing import Any, Iterable

from ws_socket.engine.canonical import SDK_VERSION

ADAPTER_VERSION = "1.0"
SCHEMA_NAME = "master_canonical_market_data"
SCHEMA_VERSION = "market-data-1.0"

KNOWN_FEED_TYPES = ("scrip", "scrip_lite", "touch_line", "depth", "full_depth", "index", "market_status", "cas_change", "unknown")
KNOWN_FEED_LEVELS = (1, 4, 8, 16, None)
DEFAULT_DIVIDER = 100

# ---------------------------------------------------------------------------
# Semantic alias groups (Phase 5 evidence).
#
# Each group is one underlying semantic value. ``canonical`` is the single
# authoritative name; ``aliases`` are every other name observed across the
# Kotak WS / Kotak REST quote / SDK attribute / legacy canonical surface that
# was PROVEN equal on live data (or is a direct SDK attribute mapping).
# Every alias must map to the SAME semantic meaning -- groups are never merged
# on name similarity alone.
# ---------------------------------------------------------------------------
SEMANTIC_GROUPS: tuple[dict[str, Any], ...] = (
    # --- identity ---
    {"canonical": "instrument_token", "section": "identity", "aliases": ("instrument_token", "exchange_token"), "evidence": "quote exchange_token==WS instrument_token (matrix: equal token)"},
    {"canonical": "trading_symbol", "section": "identity", "aliases": ("trading_symbol", "symbol", "display_symbol"), "evidence": "ACK trading_symbols map / quote display_symbol (matrix)"},
    {"canonical": "exchange_segment", "section": "identity", "aliases": ("exchange_segment", "exchange", "market_segment"), "evidence": "WS exchange_segment == quoted exchange (LIVE_VERIFIED)"},
    # --- price ---
    {"canonical": "last_traded_price", "section": "price", "aliases": ("ltp", "last_traded_price", "lastPrice"), "evidence": "LIVE: single value; probe ltp==last_trade_price (209/209)"},
    {"canonical": "open_price", "section": "price", "aliases": ("open", "open_price"), "evidence": "SDK attr direct"},
    {"canonical": "high_price", "section": "price", "aliases": ("high", "high_price"), "evidence": "SDK attr direct"},
    {"canonical": "low_price", "section": "price", "aliases": ("low", "low_price"), "evidence": "SDK attr direct"},
    {"canonical": "previous_close_price", "section": "price", "aliases": ("prev_close", "prevClose", "close", "close_price"), "evidence": "LIVE: WS prev_close == REST close (matrix)"},
    {"canonical": "average_trade_price", "section": "price", "aliases": ("avg_price", "average_trade_price", "avg_cost"), "evidence": "LIVE: WS avg == REST avg_cost (matrix)"},
    {"canonical": "upper_circuit_limit", "section": "price", "aliases": ("upper_circuit_limit", "upper_circuit", "high_price_range"), "evidence": "SDK attr; REST high_price_range to verify"},
    {"canonical": "lower_circuit_limit", "section": "price", "aliases": ("lower_circuit_limit", "lower_circuit", "low_price_range"), "evidence": "SDK attr; REST low_price_range to verify"},
    {"canonical": "yearly_high", "section": "price", "aliases": ("yearly_high", "year_high"), "evidence": "LIVE: WS yearly_high == REST year_high (matrix)"},
    {"canonical": "yearly_low", "section": "price", "aliases": ("yearly_low", "year_low"), "evidence": "LIVE: WS yearly_low == REST year_low (matrix)"},
    # --- change ---
    {"canonical": "price_change", "section": "change", "aliases": ("net_change", "change", "price_change"), "evidence": "LIVE: WS net_change == REST change == price_change (matrix)"},
    {"canonical": "price_change_percent", "section": "change", "aliases": ("net_change_pct", "net_change_percent", "per_change", "price_change_pct"), "evidence": "LIVE: WS net_change_pct == REST per_change (matrix); SDK /100 scale"},
    # --- trade ---
    {"canonical": "last_trade_quantity", "section": "trade", "aliases": ("ltq", "last_trade_qty", "last_trade_quantity", "last_traded_quantity"), "evidence": "LIVE: probe ltq==last_trade_quantity (209/209)"},
    # --- volume ---
    {"canonical": "volume_traded_today", "section": "volume", "aliases": ("volume", "volume_traded_today", "last_volume"), "evidence": "LIVE: WS volume == REST last_volume (matrix)"},
    {"canonical": "buy_volume_today", "section": "volume", "aliases": ("total_buy_quantity", "buy_volume", "total_buy"), "evidence": "LIVE: WS total_buy_quantity == REST total_buy (matrix)"},
    {"canonical": "sell_volume_today", "section": "volume", "aliases": ("total_sell_quantity", "sell_volume", "total_sell"), "evidence": "LIVE: WS total_sell_quantity == REST total_sell (matrix)"},
    # --- time ---
    {"canonical": "feed_event_time", "section": "time", "aliases": ("last_update_time", "lstup_time", "feed_event_time", "exchange_timestamp"), "evidence": "LIVE: epoch-seconds; L8==wall clock (2026-09-18 14:50 IST); REST lstup_time==WS last_update_time (matrix)"},
    {"canonical": "last_trade_time", "section": "time", "aliases": ("last_trade_time",), "evidence": "SDK attr; semantically DIFFERENT from feed_event_time (kept separate)"},
    # --- market lot / precision ---
    {"canonical": "lot_size", "section": "identity", "aliases": ("market_lot", "lot_size"), "evidence": "SDK attr market_lot"},
    {"canonical": "price_precision", "section": "feed_metadata", "aliases": ("precision",), "evidence": "SDK attr"},
    {"canonical": "price_multiplier", "section": "feed_metadata", "aliases": ("multiplier",), "evidence": "SDK attr"},
    # --- OI ---
    {"canonical": "open_interest", "section": "open_interest", "aliases": ("open_interest", "open_int"), "evidence": "LIVE: WS open_interest == REST open_int (matrix)"},
)

CANONICAL_ALIAS_MAP: dict[str, tuple[str, str]] = {}
for _g in SEMANTIC_GROUPS:
    for _a in _g["aliases"]:
        CANONICAL_ALIAS_MAP[_a] = (_g["canonical"], _g["section"])

# Legacy canonical (ws_socket.engine.canonical) key -> semantic alias canonical name.
_LEGACY_TO_CANONICAL: dict[str, str] = {
    "ltp": "last_traded_price",
    "ltq": "last_trade_quantity",
    "open": "open_price",
    "high": "high_price",
    "low": "low_price",
    "prev_close": "previous_close_price",
    "avg_price": "average_trade_price",
    "volume": "volume_traded_today",
    "total_buy_quantity": "buy_volume_today",
    "total_sell_quantity": "sell_volume_today",
    "open_interest": "open_interest",
    "net_change": "price_change",
    "net_change_pct": "price_change_percent",
    "upper_circuit_limit": "upper_circuit_limit",
    "lower_circuit_limit": "lower_circuit_limit",
    "yearly_high": "yearly_high",
    "yearly_low": "yearly_low",
    "total_traded_value": "total_traded_value",
    "market_lot": "lot_size",
    "precision": "price_precision",
    "multiplier": "price_multiplier",
    "auction": "auction_active",
    "last_trade_time": "last_trade_time",
    "last_update_time": "feed_event_time",
}

_LEGACY_DEPTH_ROW_MAP = {"price": "price", "quantity": "quantity", "orders": "orders"}

_TRADING_SYMBOL_ALIASES: tuple[tuple[str, ...], ...] = (("trading_symbol", "symbol", "display_symbol"),)

# ADP-required but intentionally NOT merged (proven distinct semantics).
NOT_DUPLICATES: tuple[tuple[str, str, str, str], ...] = (
    ("last_trade_time", "feed_event_time", "trade_time vs broker feed-update time; a depth tick can arrive long after the last trade", "trade.last_trade_time / time.feed_event_time"),
    ("buy_volume_today", "sell_volume_today", "aggressive-buy vs aggressive-sell volume", "volume.buy_volume_today / volume.sell_volume_today"),
    ("high_price", "last_traded_price", "session high vs current ltp", "price.high_price / price.last_traded_price"),
    ("upper_circuit_limit", "lower_circuit_limit", "band top vs band bottom", "price.upper_circuit_limit / price.lower_circuit_limit"),
    ("open_interest", "volume_traded_today", "outstanding contracts vs shares traded", "open_interest.open_interest / volume.volume_traded_today"),
)

# Base canonical schema: section -> {field -> metadata spec}.
# type: int|float|str|bool|list|None (nullable); unit; live/static; derived.
# Used for validation, ML-friendly contract and report generation.
CANONICAL_SCHEMA: dict[str, dict[str, dict[str, Any]]] = {
    "identity": {
        "exchange_segment": {"type": "str", "unit": "exchange enum", "live": False, "derived": False, "required": True, "desc": "Kotak exchange segment (e.g. nse_cm)"},
        "instrument_token": {"type": "str", "unit": "token", "live": False, "derived": False, "required": True, "desc": "broker instrument token"},
        "trading_symbol": {"type": "str", "unit": "symbol", "live": False, "derived": False, "required": True, "desc": "tradable symbol (e.g. RELIANCE-EQ)"},
        "lot_size": {"type": "int", "unit": "shares", "live": False, "derived": False, "required": False, "desc": "exchange lot size (SDK market_lot)"},
        "exchange_name": {"type": "str", "unit": "name", "live": False, "derived": True, "required": False, "desc": "derived short exchange name from segment, e.g. NSE"},
        "instrument_type": {"type": "str", "unit": "type", "live": False, "derived": True, "required": False, "desc": "EQUITY/FUTURE/INDEX ... (master/derived; nullable)"},
        "series": {"type": "str", "unit": "series", "live": False, "derived": False, "required": False, "desc": "master series (EQ)"},
        "isin": {"type": "str", "unit": "ISIN", "live": False, "derived": False, "required": False, "desc": "master ISIN"},
    },
    "market_state": {
        "trading_status": {"type": "str", "unit": "status text", "live": True, "derived": False, "required": False, "desc": "latest market status text for the exchange (nullable on scrip ticks)"},
    },
    "price": {
        "last_traded_price": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "last traded price (divider-applied)"},
        "open_price": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "session open"},
        "high_price": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "session high"},
        "low_price": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "session low"},
        "previous_close_price": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "previous session close"},
        "average_trade_price": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "VWAP (avg trade price)"},
        "upper_circuit_limit": {"type": "float", "unit": "INR", "live": False, "derived": False, "required": False, "desc": "upper price band"},
        "lower_circuit_limit": {"type": "float", "unit": "INR", "live": False, "derived": False, "required": False, "desc": "lower price band"},
        "yearly_high": {"type": "float", "unit": "INR", "live": False, "derived": False, "required": False, "desc": "52-week high"},
        "yearly_low": {"type": "float", "unit": "INR", "live": False, "derived": False, "required": False, "desc": "52-week low"},
        "indicative_price": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "optional index/auction indicative price"},
        "auction_active": {"type": "bool", "unit": "bool", "live": True, "derived": False, "required": False, "desc": "auction/CAS flag"},
    },
    "trade": {
        "last_trade_quantity": {"type": "int", "unit": "shares", "live": True, "derived": False, "required": False, "desc": "quantity of the last trade"},
        "last_trade_time": {"type": "int", "unit": "epoch seconds UTC", "live": True, "derived": False, "required": False, "desc": "time of last trade"},
        "total_traded_value": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "day's traded value"},
    },
    "volume": {
        "volume_traded_today": {"type": "int", "unit": "shares", "live": True, "derived": False, "required": False, "desc": "day's traded volume"},
        "buy_volume_today": {"type": "int", "unit": "shares", "live": True, "derived": False, "required": False, "desc": "day's aggressive-buy volume"},
        "sell_volume_today": {"type": "int", "unit": "shares", "live": True, "derived": False, "required": False, "desc": "day's aggressive-sell volume"},
    },
    "change": {
        "price_change": {"type": "float", "unit": "INR", "live": True, "derived": False, "required": False, "desc": "ltp - previous close"},
        "price_change_percent": {"type": "float", "unit": "percent", "live": True, "derived": False, "required": False, "desc": "pct change (SDK /100 scale applied)"},
    },
    "open_interest": {
        "open_interest": {"type": "int", "unit": "contracts", "live": True, "derived": False, "required": False, "desc": "outstanding OI (equity: 0)"},
    },
    "time": {
        "feed_event_time": {"type": "int", "unit": "epoch seconds UTC", "live": True, "derived": False, "required": False, "desc": "broker feed-update time (last_update_time)"},
        "received_at": {"type": "float", "unit": "epoch seconds UTC", "live": True, "derived": True, "required": False, "desc": "app receive time (local, wall clock)"},
    },
    "reference": {
        "previous_day_high": {"type": "float", "unit": "INR", "live": False, "derived": False, "required": False, "desc": "prior-day high (REST/other; nullable)"},
        "previous_day_low": {"type": "float", "unit": "INR", "live": False, "derived": False, "required": False, "desc": "prior-day low (REST/other; nullable)"},
        "previous_day_volume": {"type": "int", "unit": "shares", "live": False, "derived": False, "required": False, "desc": "prior-day volume (REST/other; nullable)"},
    },
    "depth": {
        "buy": {"type": "list[DepthRow]", "unit": "rows", "live": True, "derived": False, "required": False, "desc": "bid rows, best-first, variable length"},
        "sell": {"type": "list[DepthRow]", "unit": "rows", "live": True, "derived": False, "required": False, "desc": "ask rows, best-first, variable length"},
    },
    "derived": {
        "best_bid_price": {"type": "float", "unit": "INR", "live": True, "derived": True, "required": False, "desc": "buy[0].price"},
        "best_bid_quantity": {"type": "int", "unit": "shares", "live": True, "derived": True, "required": False, "desc": "buy[0].quantity"},
        "best_ask_price": {"type": "float", "unit": "INR", "live": True, "derived": True, "required": False, "desc": "sell[0].price"},
        "best_ask_quantity": {"type": "int", "unit": "shares", "live": True, "derived": True, "required": False, "desc": "sell[0].quantity"},
        "spread": {"type": "float", "unit": "INR", "live": True, "derived": True, "required": False, "desc": "best ask - best bid"},
        "mid_price": {"type": "float", "unit": "INR", "live": True, "derived": True, "required": False, "desc": "(bid+ask)/2"},
        "buy_sell_volume_ratio": {"type": "float", "unit": "ratio", "live": True, "derived": True, "required": False, "desc": "buy_volume_today / max(sell_volume_today,1)"},
    },
    "feed_metadata": {
        "feed_type": {"type": "str", "unit": "type", "live": False, "derived": False, "required": True, "desc": "scrip_lite/touch_line/depth/full_depth/index/market_status/cas_change"},
        "feed_level": {"type": "int", "unit": "level", "live": False, "derived": False, "required": False, "desc": "1/4/8/16"},
        "event_id": {"type": "str", "unit": "id", "live": False, "derived": True, "required": False, "desc": "engine tick id"},
        "source": {"type": "str", "unit": "source", "live": False, "derived": False, "required": False, "desc": "broker feed source tag"},
        "sdk_version": {"type": "str", "unit": "version", "live": False, "derived": False, "required": False, "desc": "kotak SDK version"},
        "price_precision": {"type": "int", "unit": "digits", "live": False, "derived": False, "required": False, "desc": "price precision"},
        "price_multiplier": {"type": "int", "unit": "divider", "live": False, "derived": False, "required": False, "desc": "price divider"},
    },
    "raw": {
        "reference": {"type": "str", "unit": "digest", "live": False, "derived": True, "required": False, "desc": "immutable raw-blob digest (raw payload kept SEPARATE)"},
    },
}

ALL_CANONICAL_FIELDS: tuple[str, ...] = tuple(
    name for section in CANONICAL_SCHEMA.values() for name in section
)
ALL_SECTIONS: tuple[str, ...] = tuple(CANONICAL_SCHEMA.keys())
CANONICAL_INPUT_FIELDS: tuple[str, ...] = tuple(
    name for name, _ in CANONICAL_ALIAS_MAP.items()
)  # every alias key the adapter understands

_DEPTH_ROW_KEYS = ("price", "quantity", "orders")
_EXCHANGE_NAMES = {
    "nse_cm": "NSE", "nse_fo": "NSE", "bse_cm": "BSE", "bse_fo": "BSE",
    "bse_cd": "BSE", "bse_co": "BSE", "mcx_fo": "MCX", "ncd_co": "NCDEX",
    "cde_fo": "CDE", "nse_com": "NSE", "none": "NONE",
}

# Alias conflict precedence: when two aliases of one semantic group disagree,
# this deterministic order decides the value that wins. Never silent: the
# conflict is recorded in ``validation.conflicts``.
ALIAS_PRECEDENCE: tuple[str, ...] = ("legacy_canonical", "sdk_attribute", "flat_tick")


class DepthRow:
    """One canonical depth row (bid or ask)."""

    __slots__ = ("price", "quantity", "orders")

    def __init__(self, price: float, quantity: int, orders: int) -> None:
        self.price = float(price)
        self.quantity = int(quantity)
        self.orders = int(orders)

    def to_dict(self) -> dict[str, Any]:
        return {"price": self.price, "quantity": self.quantity, "orders": self.orders}


def _as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None


def _is_valid_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# ---------------------------------------------------------------------------
# Validation (Phase 13)
# ---------------------------------------------------------------------------

def _valid_price(v: float | None) -> bool:
    return v is None or (v >= 0.0)


def _validate_identity(identity: dict) -> list[str]:
    issues: list[str] = []
    if not identity.get("exchange_segment"):
        issues.append("identity.exchange_segment missing/empty")
    if not identity.get("instrument_token"):
        issues.append("identity.instrument_token missing/empty")
    return issues


def _validate_price_block(price: dict, today: float) -> list[str]:
    issues: list[str] = []
    ltp = price.get("last_traded_price")
    if ltp is not None and ltp <= 0:
        issues.append("price.last_traded_price <= 0")
    hi, lo = price.get("high_price"), price.get("low_price")
    if hi is not None and lo is not None and hi < lo:
        issues.append("price.high_price < price.low_price")
    up, low = price.get("upper_circuit_limit"), price.get("lower_circuit_limit")
    if ltp is not None and up is not None and ltp > up:
        issues.append(f"price.last_traded_price {ltp} > upper_circuit {up}")
    if ltp is not None and low is not None and ltp < low:
        issues.append(f"price.last_traded_price {ltp} < lower_circuit {low}")
    yr_hi, yr_lo = price.get("yearly_high"), price.get("yearly_low")
    if yr_hi is not None and yr_lo is not None and yr_hi < yr_lo:
        issues.append("price.yearly_high < price.yearly_low")
    return issues


def _validate_time_block(vtime: dict, trade: dict, today: float) -> list[str]:
    issues: list[str] = []
    feed_ts = vtime.get("feed_event_time")
    if feed_ts is not None:
        if not _is_valid_num(feed_ts) or feed_ts < 0:
            issues.append("time.feed_event_time invalid")
        elif abs(float(today) - float(feed_ts)) > 7 * 86400:
            issues.append(f"time.feed_event_time stale (value {feed_ts}, now {int(today)})")
    tt = trade.get("last_trade_time")
    if tt is not None and (not _is_valid_num(tt) or tt < 0):
        issues.append("trade.last_trade_time invalid")
    return issues


def _validate_depth(rows: list[dict], side: str, *, daywise: bool) -> list[str]:
    issues: list[str] = []
    if not rows:
        return issues
    prev_price: float | None = None
    for i, row in enumerate(rows):
        if set(row) != set(_DEPTH_ROW_KEYS):
            issues.append(f"depth.{side}[{i}] malformed row keys: {sorted(row)}")
            continue
        if not _valid_price(row.get("price")):
            issues.append(f"depth.{side}[{i}].price invalid")
        if not isinstance(row.get("quantity"), int) or row.get("quantity", 0) < 0:
            issues.append(f"depth.{side}[{i}].quantity invalid")
        if not isinstance(row.get("orders"), int) or row.get("orders", 0) < 0:
            issues.append(f"depth.{side}[{i}].orders invalid")
        cur = row.get("price")
        if cur is not None and prev_price is not None:
            if daywise and cur > prev_price:
                issues.append(f"depth.{side} rows not best-first at index {i}")
            if not daywise and cur < prev_price:
                issues.append(f"depth.{side} rows not best-first at index {i}")
        if cur is not None:
            prev_price = cur
    return issues


class MasterCanonical:
    """Result object: canonical object + validation + conflict diagnostics."""

    __slots__ = ("data", "issues", "conflicts", "source_keys")

    def __init__(self, data: dict, issues: list[str], conflicts: list[dict], source_keys: set[str]) -> None:
        self.data = data
        self.issues = issues
        self.conflicts = conflicts
        self.source_keys = source_keys

    @property
    def valid(self) -> bool:
        return len(self.issues) == 0

    def filtered(self, omit_none: bool = True) -> dict:
        """Canonical object with None leaves optionally removed (for compact FE input)."""
        out: dict[str, Any] = {}
        for section, fields in self.data.items():
            if not isinstance(fields, dict):
                out[section] = fields
                continue
            kept = {k: v for k, v in fields.items() if not (omit_none and v is None)}
            if kept:
                out[section] = kept
        return out


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------

def _normalize_depth_row(raw: Any, issue_sink: list[str], ctx: str) -> dict[str, Any] | None:
    if isinstance(raw, DepthRow):
        return raw.to_dict()
    if not isinstance(raw, dict):
        issue_sink.append(f"{ctx} depth row is not a dict")
        return None
    out: dict[str, Any] = {}
    price = raw.get("price")
    out["price"] = _as_float(price)
    out["quantity"] = _as_int(raw.get("quantity"))
    out["orders"] = _as_int(raw.get("orders"))
    if out["price"] is None or out["quantity"] is None or out["orders"] is None:
        issue_sink.append(f"{ctx} depth row missing/illegal price/quantity/orders")
        return None
    return out


def _section_of(section_name: str) -> str:
    return section_name or "unknown"


def build_from_canonical(
    canonical: dict,
    *,
    market_status: dict[str, Any] | None = None,
    received_at: float | None = None,
    now: float | None = None,
) -> MasterCanonical:
    """Build the master canonical object from the engine's canonical envelope.

    ``canonical`` is the dict produced by ``ws_socket.engine.canonical.canonicalize``
    (its ``fields`` block holds broker values verbatim). ``market_status`` may carry
    the last-known per-exchange SFeedMarketStatus ({exchange_segment: {...}}).
    """
    today = now if now is not None else time.time()
    fields = canonical.get("fields") or {}
    raw: dict[str, Any] = {}
    issues: list[str] = []
    conflicts: list[dict] = []

    # ---- identity ----
    identity: dict[str, Any] = {
        "exchange_segment": canonical.get("exchange_segment") or fields.get("exchange_segment"),
        "instrument_token": str(canonical.get("instrument_token") or fields.get("instrument_token") or ""),
        "trading_symbol": canonical.get("trading_symbol") or fields.get("trading_symbol"),
    }
    seg = identity.get("exchange_segment")
    identity["exchange_name"] = _EXCHANGE_NAMES.get(str(seg or ""), str(seg or ""))
    identity["instrument_type"] = None
    identity["series"] = None
    identity["isin"] = None
    lot = _as_int(fields.get("market_lot"))
    if lot is not None:
        identity["lot_size"] = lot
    elif _as_int(fields.get("lot_size")) is not None:
        identity["lot_size"] = _as_int(fields.get("lot_size"))

    # ---- market_state (latest known per exchange, optional input) ----
    market_state: dict[str, Any] = {}
    if market_status:
        status_row = market_status.get(identity["exchange_segment"]) or market_status.get(seg)
        if status_row:
            market_state["trading_status"] = status_row.get("status") or status_row.get("trading_status")

    # ---- price (type-normalized: INR float, SDK-scale already applied) ----
    price: dict[str, Any] = {
        "last_traded_price": _as_float(fields.get("ltp")),
        "open_price": _as_float(fields.get("open")),
        "high_price": _as_float(fields.get("high")),
        "low_price": _as_float(fields.get("low")),
        "previous_close_price": _as_float(fields.get("prev_close")),
        "average_trade_price": _as_float(fields.get("avg_price")),
        "upper_circuit_limit": _as_float(fields.get("upper_circuit_limit")),
        "lower_circuit_limit": _as_float(fields.get("lower_circuit_limit")),
        "yearly_high": _as_float(fields.get("yearly_high")),
        "yearly_low": _as_float(fields.get("yearly_low")),
        "indicative_price": _as_float(fields.get("indicative_price")),
        "auction_active": bool(fields.get("auction")) if fields.get("auction") is not None else None,
    }

    # ---- trade ----
    trade: dict[str, Any] = {
        "last_trade_quantity": _as_int(fields.get("ltq")),
        "last_trade_time": _as_int(fields.get("last_trade_time")),
        "total_traded_value": _as_float(fields.get("total_traded_value")),
    }

    # ---- volume ----
    volume: dict[str, Any] = {
        "volume_traded_today": _as_int(fields.get("volume")),
        "buy_volume_today": _as_int(fields.get("total_buy_quantity")),
        "sell_volume_today": _as_int(fields.get("total_sell_quantity")),
    }

    # ---- change ----
    change: dict[str, Any] = {
        "price_change": _as_float(fields.get("net_change")),
        "price_change_percent": _as_float(fields.get("net_change_pct")),
    }

    # ---- open interest ----
    oi: dict[str, Any] = {"open_interest": _as_int(fields.get("open_interest"))}

    # ---- time ----
    vtime: dict[str, Any] = {
        "feed_event_time": _as_int(fields.get("last_update_time") or fields.get("last_trade_time")),
        "received_at": received_at if received_at is not None else canonical.get("received_at"),
    }

    # ---- depth (variable-length; NO 5-row hardcode) ----
    buy_rows: list[dict[str, Any]] = []
    for i, row in enumerate(fields.get("buy") or []):
        norm = _normalize_depth_row(row, issues, f"depth.buy[{i}]")
        if norm is not None:
            buy_rows.append(norm)
    sell_rows: list[dict[str, Any]] = []
    for i, row in enumerate(fields.get("sell") or []):
        norm = _normalize_depth_row(row, issues, f"depth.sell[{i}]")
        if norm is not None:
            sell_rows.append(norm)
    depth: dict[str, Any] = {
        "buy": buy_rows,
        "sell": sell_rows,
        "levels": {"buy": len(buy_rows), "sell": len(sell_rows), "expected": 8},
    }

    # ---- derived (Phase 8: single representation per semantic value) ----
    best_bid_price = buy_rows[0]["price"] if buy_rows else None
    best_bid_qty = buy_rows[0]["quantity"] if buy_rows else None
    best_ask_price = sell_rows[0]["price"] if sell_rows else None
    best_ask_qty = sell_rows[0]["quantity"] if sell_rows else None
    spread = None
    mid_price = None
    if best_bid_price is not None and best_ask_price is not None:
        spread = best_ask_price - best_bid_price
        mid_price = (best_bid_price + best_ask_price) / 2.0
    buy_sell_ratio = None
    bv = volume.get("buy_volume_today") or 0
    sv = volume.get("sell_volume_today") or 0
    if sv or bv:
        buy_sell_ratio = bv / max(sv, 1)
    derived: dict[str, Any] = {
        "best_bid_price": best_bid_price,
        "best_bid_quantity": best_bid_qty,
        "best_ask_price": best_ask_price,
        "best_ask_quantity": best_ask_qty,
        "spread": spread,
        "mid_price": mid_price,
        "buy_sell_volume_ratio": buy_sell_ratio,
    }

    # ---- feed metadata ----
    feed_metadata: dict[str, Any] = {
        "feed_type": canonical.get("feed_type"),
        "feed_level": canonical.get("feed_level"),
        "event_id": canonical.get("event_id"),
        "source": canonical.get("source", "kotak_neo_sfeed"),
        "sdk_version": canonical.get("sdk_version", SDK_VERSION),
        "price_precision": _as_int(fields.get("precision")),
        "price_multiplier": _as_int(fields.get("multiplier")),
    }

    # ---- raw audit envelope (Phase 9: NEVER inlined as semantic duplicates) ----
    raw_ref = canonical.get("raw_reference") or canonical.get("raw_reference")
    raw_section: dict[str, Any] = {"reference": raw_ref}

    # ---- reference (previous-day values; optional input, never invented) ----
    reference: dict[str, Any] = {
        "previous_day_high": None,
        "previous_day_low": None,
        "previous_day_volume": None,
    }

    # ---- alias conflict detection over the whole input surface ----
    source_keys = {k for k in list(fields) + list(canonical)}
    for group in SEMANTIC_GROUPS:
        values: list[tuple[str, Any, int]] = []
        prio: dict[str, int] = {p: i for i, p in enumerate(ALIAS_PRECEDENCE)}
        for alias in group["aliases"]:
            if alias in fields:
                values.append((alias, fields[alias], prio.get("legacy_canonical", 99)))
            elif alias in canonical:
                values.append((alias, canonical[alias], prio.get("sdk_attribute", 99)))
        nonnull = [(a, v) for a, v, _ in values if v is not None]
        distinct = set(_float_key(v) for _, v in nonnull if v is not None)
        if nonnull and len(distinct) > 1:
            conflicts.append({
                "canonical": group["canonical"],
                "sources": [a for a, _ in nonnull],
                "values": [v for _, v in nonnull],
                "policy": f"first non-null by precedence {ALIAS_PRECEDENCE}; no silent pick",
                "resolution": nonnull[0][0],
            })

    # ---- run validation ----
    issues += _validate_identity(identity)
    issues += _validate_price_block(price, today)
    issues += _validate_time_block(vtime, trade, today)
    issues += _validate_depth(buy_rows, "buy", daywise=True)
    issues += _validate_depth(sell_rows, "sell", daywise=False)
    if feed_metadata.get("feed_level") not in KNOWN_FEED_LEVELS:
        issues.append(f"feed_metadata.feed_level unexpected: {feed_metadata.get('feed_level')}")
    if feed_metadata.get("feed_type") not in KNOWN_FEED_TYPES:
        issues.append(f"feed_metadata.feed_type unknown: {feed_metadata.get('feed_type')}")

    data: dict[str, Any] = {
        "schema": {
            "name": SCHEMA_NAME,
            "version": SCHEMA_VERSION,
            "adapter": ADAPTER_VERSION,
        },
        "identity": identity,
        "market_state": market_state,
        "price": price,
        "trade": trade,
        "volume": volume,
        "change": change,
        "open_interest": oi,
        "time": vtime,
        "depth": depth,
        "derived": derived,
        "reference": reference,
        "feed_metadata": feed_metadata,
        "raw": raw_section,
        "validation": {
            "passed": len(issues) == 0,
            "issues": issues,
            "conflicts": conflicts,
        },
    }
    return MasterCanonical(data, issues, conflicts, source_keys)


def _float_key(v: Any) -> Any:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return round(float(v), 8)
    return v


# ---------------------------------------------------------------------------
# Model-level entry (SFeed messages) — used by tests / offline replay.
# ---------------------------------------------------------------------------

def build_from_model(message, *, received_at: float | None = None, now: float | None = None) -> MasterCanonical:
    """Adapt a decoded SFeed model directly (offline replay path)."""
    from ws_socket.engine.canonical import canonicalize

    canonical = canonicalize(message, received_at=received_at)
    return build_from_canonical(canonical, received_at=received_at, now=now)


def build_from_flat_tick(
    tick: dict,
    *,
    feed_type: str = "depth",
    feed_level: int = 8,
    received_at: float | None = None,
    now: float | None = None,
) -> MasterCanonical:
    """Adapt the flat consumer tick (TICK_VALIDATED payload pre-image)."""
    today = now if now is not None else time.time()
    fields: dict[str, Any] = {
        "ltp": tick.get("ltp") or tick.get("lastPrice"),
        "open": tick.get("open"),
        "high": tick.get("high"),
        "low": tick.get("low"),
        "prev_close": tick.get("prevClose") or tick.get("prev_close"),
        "net_change": tick.get("netChange") or tick.get("net_change"),
        "net_change_pct": tick.get("netChangePercent") or tick.get("net_change_pct"),
        "volume": tick.get("volume"),
        "total_buy_quantity": tick.get("totalBuyQuantity") or tick.get("buyVolume"),
        "total_sell_quantity": tick.get("totalSellQuantity") or tick.get("sellVolume"),
        "buy": tick.get("buy") or tick.get("bids"),
        "sell": tick.get("sell") or tick.get("asks"),
        "last_trade_time": tick.get("lastTradeTime") or tick.get("timestamp"),
        "market_lot": tick.get("lotSize") or tick.get("marketLot"),
    }
    canonical: dict[str, Any] = {
        "exchange_segment": tick.get("exchangeSegment") or tick.get("exchange"),
        "instrument_token": str(tick.get("instrumentToken") or tick.get("token") or ""),
        "trading_symbol": tick.get("symbol") or tick.get("tradingSymbol"),
        "feed_type": feed_type,
        "feed_level": feed_level,
        "event_id": tick.get("eventId"),
        "source": tick.get("source", "kotak_neo_sfeed"),
        "received_at": received_at if received_at is not None else today,
        "fields": fields,
        "sdk_version": SDK_VERSION,
        "raw_reference": tick.get("rawReference"),
    }
    return build_from_canonical(canonical, received_at=received_at, now=now)