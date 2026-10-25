"""Tick-storage field resolver — canonical-first reads with legacy fallback.

The Mongo ``ticks`` collection is migrating to the canonical-only document
contract (master-canonical market-data adapter, docs/reports/
L8_MASTER_CANONICAL_ADAPTER_FORENSIC_AUDIT.txt): market data is stored ONLY
under ``master_canonical.<section>.<field>``. Older documents (written before
the switch) carry the legacy flat shape (``ltp``, ``open``, ``bp``, ``buy``,
... plus the SFeed extras added by ``ws_socket.engine.storage``).

This module is the ONE place that understands both shapes. Consumers read via
:func:`get_field` / :func:`get_depth` / :func:`has_canonical` so a single
document — older or newer — always resolves to the same value, with NO
duplicate semantic representation in either shape. It never fabricates values:
missing paths resolve to ``None``.

The in-process WebSocket/API market frame (feature engine, connection engine)
is a SEPARATE contract and is intentionally NOT routed through here.
"""

from __future__ import annotations

from typing import Any

# The 52-field canonical contract keyed exactly like the adapter output.
_CANONICAL_ROOT = "master_canonical"

# Legacy flat document key -> canonical path (section, field). These are the
# market-data keys the legacy ``to_storage_doc`` used to write. Depth aliases
# (bp/bq/sp/sq/bs) are handled by get_depth / get_quote below — they resolve to
# depth.buy[0] / depth.sell[0] and are never stored as separate fields.
_LEGACY_LEAF: dict[str, tuple[str, str]] = {
    "ltp": ("price", "last_traded_price"),
    "open": ("price", "open_price"),
    "high": ("price", "high_price"),
    "low": ("price", "low_price"),
    "close": ("price", "previous_close_price"),
    "prevClose": ("price", "previous_close_price"),
    "averagePrice": ("price", "average_trade_price"),
    "upper_circuit_limit": ("price", "upper_circuit_limit"),
    "lower_circuit_limit": ("price", "lower_circuit_limit"),
    "yearly_high": ("price", "yearly_high"),
    "yearly_low": ("price", "yearly_low"),
    "volume": ("volume", "volume_traded_today"),
    "total_buy_quantity": ("volume", "buy_volume_today"),
    "total_sell_quantity": ("volume", "sell_volume_today"),
    "tbq": ("volume", "buy_volume_today"),
    "tsq": ("volume", "sell_volume_today"),
    "ltq": ("trade", "last_trade_quantity"),
    "last_trade_time": ("trade", "last_trade_time"),
    "last_update_time": ("time", "feed_event_time"),
    "change": ("change", "price_change"),
    "changePercent": ("change", "price_change_percent"),
    "net_change": ("change", "price_change"),
    "net_change_pct": ("change", "price_change_percent"),
    "oi": ("open_interest", "open_interest"),
    "open_interest": ("open_interest", "open_interest"),
    "total_traded_value": ("price", "total_traded_value"),
    "market_lot": ("identity", "lot_size"),
    "precision": ("feed_metadata", "price_precision"),
    "multiplier": ("feed_metadata", "price_multiplier"),
    "auction": ("price", "auction_active"),
}


def has_canonical(doc: dict | None) -> bool:
    """True when the document carries the canonical contract (new shape)."""
    if not isinstance(doc, dict):
        return False
    root = doc.get(_CANONICAL_ROOT)
    return isinstance(root, dict) and bool(root)


def canonical_section(doc: dict | None, section: str) -> dict:
    """The canonical section dict (identity/price/...) or {} when absent."""
    if not isinstance(doc, dict):
        return {}
    root = doc.get(_CANONICAL_ROOT)
    return root.get(section) if isinstance(root, dict) else {}


def get_field(doc: dict | None, legacy_key: str, default: Any = None) -> Any:
    """Resolve one legacy semantic key from either document shape.

    Canonical-first: ``master_canonical.price.last_traded_price`` when the doc
    is canonical; otherwise the legacy flat key ``ltp``. ``default`` is
    returned when the value is absent in both shapes.
    """
    if not isinstance(doc, dict):
        return default
    mapping = _LEGACY_LEAF.get(legacy_key)
    if mapping is not None:
        section, field = mapping
        root = doc.get(_CANONICAL_ROOT)
        if isinstance(root, dict):
            section_block = root.get(section)
            if isinstance(section_block, dict) and field in section_block:
                return section_block[field]
        if legacy_key in doc:
            return doc[legacy_key]
        return default
    # Not a known legacy key: passthrough with no fabrication.
    return doc.get(legacy_key, default)


def get_depth(doc: dict | None, side: str) -> list[dict]:
    """Authoritative depth side (``buy`` / ``sell``) from either shape.

    Canonical docs: ``master_canonical.depth.buy`` / ``...sell``. Legacy docs:
    the top-level ``buy`` / ``sell`` arrays. NEVER one-of bid1..bid5 aliases.
    """
    if side not in ("buy", "sell"):
        return []
    root = doc.get(_CANONICAL_ROOT) if isinstance(doc, dict) else None
    if isinstance(root, dict):
        depth = root.get("depth")
        if isinstance(depth, dict) and isinstance(depth.get(side), list):
            return depth[side]
    if isinstance(doc, dict) and isinstance(doc.get(side), list):
        return doc[side]
    return []


def get_quote_slice(doc: dict | None) -> dict:
    """Compact quote view (top-of-book + ohlc) for scatter/quotes endpoints.

    Builds the same fields the legacy flat doc used to provide, but resolves
    canonical-first and with depth sourced exclusively from the depth arrays
    (no bp/bq/sp/sq duplicates).
    """
    buy = get_depth(doc, "buy")
    sell = get_depth(doc, "sell")
    bp = buy[0].get("price") if buy else None
    bq = buy[0].get("quantity") if buy else None
    sp = sell[0].get("price") if sell else None
    sq = sell[0].get("quantity") if sell else None
    return {
        "ltp": get_field(doc, "ltp"),
        "open": get_field(doc, "open"),
        "high": get_field(doc, "high"),
        "low": get_field(doc, "low"),
        "close": get_field(doc, "close"),
        "averagePrice": get_field(doc, "averagePrice"),
        "change": get_field(doc, "change"),
        "changePercent": get_field(doc, "changePercent"),
        "volume": get_field(doc, "volume"),
        "ltq": get_field(doc, "ltq"),
        "tbq": get_field(doc, "tbq"),
        "tsq": get_field(doc, "tsq"),
        "oi": get_field(doc, "oi"),
        "latestTradeTime": get_field(doc, "last_trade_time"),
        "bp": bp,
        "bq": bq,
        "sp": sp,
        "sq": sq,
        "bs": bq,
        "totalTradedValue": get_field(doc, "total_traded_value"),
        "upperCircuit": get_field(doc, "upper_circuit_limit"),
        "lowerCircuit": get_field(doc, "lower_circuit_limit"),
        "buy": buy,
        "sell": sell,
        # identity / time passthrough (both shapes carry these at top level)
        "symbol": doc.get("symbol"),
        "tradingSymbol": doc.get("tradingSymbol"),
        "instrumentToken": doc.get("instrumentToken"),
        "exchangeSegment": doc.get("exchangeSegment"),
        "ts": doc.get("ts"),
        "receivedAt": doc.get("receivedAt"),
        "_id": doc.get("_id"),
    }


def legacy_slice(doc: dict | None) -> dict | None:
    """Reconstruct the legacy flat market-data view for one document.

    Used ONLY to keep historical exports/dumps byte-compatible during the
    dual-read window, and only when the document is canonical (legacy docs are
    returned as-is). Values come from the canonical sections — never from
    duplicated storage paths.
    """
    if not isinstance(doc, dict):
        return None
    if not has_canonical(doc):
        return doc
    return get_quote_slice(doc)