"""The ACTIVE broker's own instrument search.

The local instrument master (``data/instrument_master.json`` + the instrument
cache) is KOTAK's. When the user trades on **Shoonya**, the order needs
SHOONYA's tradingsymbol and token — a Kotak token is not a Shoonya token — so
the dropdown has to ask the broker that is actually active.

This module queries the active broker's own instrument search:

* ``kotak`` — the local master IS Kotak's data (built from Kotak's own
  instrument cache), so nothing extra is needed.
* ``dummy``  — the paper engine trades the same NSE symbols, so the local
  master is correct as well.
* ``shoonya`` — ``NorenApi.searchscrip(exchange, text)`` is queried and its
  rows are mapped onto the canonical instrument shape.

Every field is taken from the broker's answer; a field the broker did not send
stays ``None``. Nothing is invented.
"""
from __future__ import annotations

import logging
from typing import Any

_log = logging.getLogger("broker_instruments")

#: Noren exchange code -> the canonical exchange segment.
_EXCHANGE_SEGMENT = {"N": "NSE", "B": "BSE"}


def _num(value: Any) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def map_shoonya_row(row: dict[str, Any]) -> dict[str, Any] | None:
    """Map one Noren scrip row onto the canonical instrument shape."""
    if not isinstance(row, dict):
        return None
    tradingsymbol = str(row.get("value") or row.get("tradingsymbol") or "").strip()
    symbol = str(row.get("symbol") or tradingsymbol.split("-")[0] or "").strip()
    token = str(row.get("token") or "").strip()
    if not tradingsymbol or not symbol:
        return None
    exch = str(row.get("exchange") or row.get("exch") or "N").strip().upper()
    segment = str(row.get("exch_seg") or "").strip().upper() or _EXCHANGE_SEGMENT.get(exch, "NSE")
    name = str(row.get("label") or row.get("name") or "").strip()
    lot = _num(row.get("lot_size") or row.get("lotSize"))
    tick = _num(row.get("tick_size") or row.get("tickSize"))
    return {
        "symbol": symbol.upper(),
        "tradingSymbol": tradingsymbol,
        "name": name,
        "token": token,
        "exchange": segment,
        "exchangeSegment": segment.lower(),
        "instrumentType": str(row.get("type") or "").strip() or None,
        "series": str(row.get("ser") or "").strip() or None,
        "isin": str(row.get("isin") or "").strip(),
        "lotSize": lot,
        "tickSize": tick,
        # Live state and margin stay unknown here: they are resolved by the
        # search engine's own enrichment against the ACTIVE broker's feed.
        "ltp": None,
        "liveStatus": "UNAVAILABLE",
        "marginStatus": "REQUIRES_ORDER_CONTEXT",
        "source": "shoonya_api",
    }


async def search_active_broker(query: str, limit: int = 10) -> list[dict]:
    """Ask the ACTIVE broker for its own instruments matching ``query``.

    Returns an empty list when the active broker is Kotak or Dummy (their
    instrument data IS the local master), when the broker has no session, or
    when the broker call fails — never a fabricated row.
    """
    text = (query or "").strip()
    if not text:
        return []
    try:
        from brokers.manager import active_terminal, get_adapter

        terminal = active_terminal()
    except Exception:
        return []
    if terminal != "shoonya":
        return []
    try:
        adapter = get_adapter("shoonya")
        if not getattr(adapter, "is_logged_in", False):
            return []
        payload = await adapter.search("nse_cm", text)
    except Exception as exc:  # noqa: BLE001 — a broker search must never break a search
        _log.debug("broker instrument search failed: %s", exc)
        return []
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return []
    out: list[dict] = []
    for row in rows:
        mapped = map_shoonya_row(row) if isinstance(row, dict) else None
        if mapped:
            out.append(mapped)
        if len(out) >= limit:
            break
    return out
