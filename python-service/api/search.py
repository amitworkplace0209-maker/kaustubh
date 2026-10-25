"""Search API — exposes the Search Engine (docs/engines/search-engine.md).

    GET  /api/search?q=relia&scope=stocks&limit=10&cursor=0&withMargin=true
    POST /api/search  {"query": "...", "scope": ["stocks"], "limit": 10}

Live market state always comes from the canonical tick store. The 1-Qty
margin is resolved only through the authoritative broker margin API
(``kotak_session.margin_required``); when the session is inactive, the broker
is unavailable, or the value cannot be parsed, the result reports
``marginStatus="UNAVAILABLE"`` and ``oneQtyMargin=null``. It is never derived
from LTP or leverage.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from auth.kotak_client import kotak_session
from core.engines.search_engine import (
    MAX_LIMIT,
    MAX_QUERY_LENGTH,
    normalize_query,
    search_engine,
)

logger = logging.getLogger("app.api.search")

router = APIRouter(prefix="/api/search", tags=["search"])

# 1-Qty margin cache. Margin depends on price, so keep the window short.
_MARGIN_TTL_SECONDS = 15.0
_MARGIN_PRODUCT = "MIS"
_margin_cache: dict[tuple, tuple[float, Optional[float]]] = {}


class SearchRequest(BaseModel):
    query: str = Field(default="", max_length=MAX_QUERY_LENGTH)
    scope: list[str] | str = Field(default_factory=lambda: ["stocks"])
    limit: int = 10
    cursor: int = 0
    withMargin: bool = False


def _scopes(value) -> list[str]:
    if value is None:
        return ["stocks"]
    if isinstance(value, str):
        return [s.strip() for s in value.split(",") if s.strip()]
    return [str(s).strip() for s in value if str(s).strip()]


def _exchange_segment(result: dict) -> str:
    segment = str(result.get("exchangeSegment") or "").strip().lower()
    if segment:
        return segment
    exchange = str(result.get("exchange") or "").strip().upper()
    if exchange == "BSE":
        return "bse_cm"
    return "nse_cm"


def _extract_one_qty_margin(payload) -> Optional[float]:
    """Parse the Kotak margin response; return None when absent/unparseable."""
    if not isinstance(payload, dict):
        return None
    rows = payload.get("data")
    row = None
    if isinstance(rows, list) and rows:
        row = rows[0]
    elif isinstance(rows, dict):
        row = rows
    if not isinstance(row, dict):
        return None
    for key in ("TotalMargin", "totalMargin", "marginRequired", "requiredMargin", "total_margin"):
        if key in row:
            try:
                value = float(row[key])
                return value if value == value else None
            except (TypeError, ValueError):
                return None
    return None


async def _resolve_margins(results: list[dict]) -> None:
    """Annotate stock results with authoritative 1-Qty MIS margin (in place).

    Margins resolve IN PARALLEL (asyncio.gather) with a short per-token
    timeout. The old serial loop made one suggestion dropdown cost
    N x broker-RTT (~2-3s for 8 rows) — the "search me time le raha hai"
    complaint. Parallel + cache keeps even withMargin=true under ~400ms.
    """
    import asyncio

    for result in results:
        result.setdefault("oneQtyMargin", None)
        result.setdefault("marginStatus", "UNAVAILABLE")
        # The row builder defaults to "not requested"; we ARE the request, so
        # never leave that reason attached to a response that asked for margin.
        result["marginSource"] = "kotak_neo_rm"
        result["marginReason"] = None

    if not getattr(kotak_session, "session_active", False):
        for result in results:
            result["marginReason"] = "broker margin session inactive"
        return

    now = time.time()
    pending: list[tuple[dict, tuple]] = []
    for result in results:
        token = str(result.get("token") or "")
        segment = _exchange_segment(result)
        if not token.isdigit():
            result["marginStatus"] = "UNAVAILABLE"
            result["marginSource"] = "kotak_neo_rm"
            result["marginReason"] = "instrument has no numeric token"
            continue
        cache_key = (segment, token, _MARGIN_PRODUCT)
        cached = _margin_cache.get(cache_key)
        if cached and (now - cached[0]) < _MARGIN_TTL_SECONDS:
            result["oneQtyMargin"] = cached[1]
            result["marginStatus"] = "AVAILABLE" if cached[1] is not None else "UNAVAILABLE"
            if cached[1] is None:
                result["marginReason"] = "broker returned no 1-qty margin"
            continue
        pending.append((result, cache_key))

    if not pending:
        return

    async def _one(result: dict, cache_key: tuple) -> None:
        segment, token, _product = cache_key
        try:
            payload = await asyncio.wait_for(
                kotak_session.async_margin_required(
                    exchange=segment,
                    token=token,
                    product=_MARGIN_PRODUCT,
                    order_type="MKT",
                    quantity="1",
                    price="0",
                    transaction_type="BUY",
                ),
                timeout=3.0,
            )
            margin = _extract_one_qty_margin(payload)
        except Exception as exc:  # broker/network/session failure => unavailable
            logger.debug("[SEARCH] margin lookup failed for %s: %s", token, exc)
            margin = None
        _margin_cache[cache_key] = (time.time(), margin)
        result["oneQtyMargin"] = margin
        result["marginStatus"] = "AVAILABLE" if margin is not None else "UNAVAILABLE"
        if margin is None:
            result["marginReason"] = "broker returned no 1-qty margin"

    await asyncio.gather(*(_one(r, k) for r, k in pending))


async def _resolve_live_prices(results: list[dict]) -> None:
    """Fill a last-known REAL price on stock rows the tick store had no quote for.

    The central tick store only carries the small subscribed universe, so
    searching anything else returned ``ltp: null`` — the dropdown showed a
    symbol, a company name and nothing else ("search me sirf naam aata hai").
    Missing rows are resolved through the canonical LastPrice chain
    (broker snapshot → stored candle close, services/last_price.py) and every
    filled value is labelled honestly: LIVE vs STALE, plus source and asOf.
    """
    import asyncio
    from services.last_price import resolve_prices

    pending = [r for r in results if r.get("type") == "stock" and r.get("ltp") is None]
    if not pending:
        return

    refs = [
        {
            "token": r.get("token"),
            "symbol": r.get("symbol") or r.get("tradingSymbol"),
            "segment": _exchange_segment(r),
        }
        for r in pending
    ]
    try:
        prices = await asyncio.wait_for(resolve_prices(refs), timeout=5.0)
    except Exception as exc:  # noqa: BLE001 — enrichment must never fail a search
        logger.debug("[SEARCH] live price enrichment failed: %s", exc)
        return

    for row, price in zip(pending, prices):
        ltp = price.get("ltp")
        if ltp is None:
            continue
        row["ltp"] = ltp
        row["prevClose"] = price.get("prevClose")
        row["change"] = price.get("change")
        row["changePct"] = price.get("changePct")
        for field in ("open", "high", "low", "volume"):
            if price.get(field) is not None:
                row[field] = price[field]
        status = "LIVE" if price.get("status") == "LIVE" else "STALE"
        row["liveStatus"] = status
        row["dataStatus"] = status
        row["source"] = price.get("source") or "unavailable"
        if price.get("asOf"):
            row["timestamp"] = price["asOf"]


async def _broker_instrument_hits(query: str, limit: int) -> list[dict]:
    """The ACTIVE broker's own instrument rows for this query (Shoonya)."""
    try:
        from services.broker_instruments import search_active_broker

        return await search_active_broker(query, limit)
    except Exception as exc:  # noqa: BLE001 — a broker search must never break a search
        logger.debug("[SEARCH] broker instrument search failed: %s", exc)
        return []


def _merge_broker_rows(
    broker_rows: list[dict], local_rows: list[dict], limit: int
) -> list[dict]:
    """Broker rows first, then the local hits that are not already listed."""
    merged: list[dict] = []
    seen: set[str] = set()
    for row in [*broker_rows, *local_rows]:
        key = str(row.get("symbol") or row.get("tradingSymbol") or "").upper()
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(row)
        if len(merged) >= limit:
            break
    return merged


def _run_search(query: str, scopes: list[str], limit: int, cursor: int) -> dict:
    if not query or not query.strip():
        return {
            "query": "", "normalized": "", "results": [], "total": 0,
            "hasMore": False, "nextCursor": None, "scopes": scopes,
            "tookMs": 0.0, "errorCode": "EMPTY_QUERY",
        }
    if len(query.strip()) > MAX_QUERY_LENGTH:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "QUERY_TOO_LONG", "maxLength": MAX_QUERY_LENGTH,
                    "message": f"Query exceeds {MAX_QUERY_LENGTH} characters."},
        )
    return search_engine.search_scoped(
        query, scopes=scopes, limit=limit, cursor=cursor, with_live=True,
    )


@router.get("")
async def search_get(
    q: str = Query(default="", description="Search query"),
    scope: str = Query(default="stocks", description="Comma-separated scopes"),
    limit: int = Query(default=10, ge=1, le=MAX_LIMIT),
    cursor: int = Query(default=0, ge=0),
    withMargin: bool = Query(default=False, description="Resolve 1-Qty MIS margin"),
):
    scopes = _scopes(scope)
    payload = _run_search(q, scopes, limit, cursor)
    results = payload.get("results") or []
    # The ACTIVE broker's own instruments come FIRST: on Shoonya the local
    # master is Kotak's, and a Kotak token is not a Shoonya token.
    broker_rows = await _broker_instrument_hits(q, limit)
    if broker_rows:
        results = _merge_broker_rows(broker_rows, results, limit)
        payload["results"] = results
        payload["total"] = max(int(payload.get("total") or 0), len(results))
    if results:
        # Live-price enrichment and margin resolution are independent broker
        # round-trips — run them together so the dropdown pays one RTT total.
        tasks = [_resolve_live_prices(results)]
        if withMargin:
            tasks.append(_resolve_margins(results))
        await asyncio.gather(*tasks)
    return payload


@router.get("/suggest")
async def search_suggest(
    q: str = Query(default=""),
    limit: int = Query(default=8, ge=1, le=MAX_LIMIT),
):
    """Lightweight symbol suggestions (no margin, live state included)."""
    if not q or normalize_query(q)["empty"]:
        return {"query": "", "results": []}
    payload = _run_search(q, ["stocks"], limit, 0)
    if payload.get("results"):
        await _resolve_live_prices(payload["results"])
    return {"query": payload["query"], "results": payload["results"]}


@router.post("")
async def search_post(body: SearchRequest):
    payload = _run_search(
        body.query, _scopes(body.scope),
        max(1, min(int(body.limit), MAX_LIMIT)), max(0, int(body.cursor)),
    )
    results = payload.get("results") or []
    if results:
        tasks = [_resolve_live_prices(results)]
        if body.withMargin:
            tasks.append(_resolve_margins(results))
        await asyncio.gather(*tasks)
    return payload


@router.get("/status")
async def search_status():
    return search_engine.status_snapshot()


# --------------------------------------------------------------------------- #
# Shared adapter for the legacy instrument-search endpoints
# --------------------------------------------------------------------------- #
# ``/api/stocks/search``, ``/api/trading/search-local`` and
# ``/api/market-watch/search`` each used to run their own lookup over the
# instrument master. They now resolve through the one canonical index so there
# is a single ranking, a single normalization and a single place where search
# behaviour is changed. The legacy response envelopes are preserved so existing
# callers keep working; the frontend has migrated to ``/api/search``.

#: Emitted on legacy responses so callers can find the canonical replacement.
DEPRECATION_TARGET = "/api/search"


def canonical_instrument_rows(
    query: str, limit: int, *, eq_only: bool = False,
) -> tuple[list[dict], dict]:
    """Resolve ``query`` through the canonical Search Engine.

    Returns ``(rows, meta)`` where ``meta`` carries the envelope fields the
    legacy endpoints reported (``total``, ``errorCode``, index availability).
    """
    payload = _run_search(query, ["stocks"], max(1, min(int(limit or 10), MAX_LIMIT)), 0)
    rows = payload.get("results") or []
    if eq_only:
        rows = [
            r for r in rows
            if str(r.get("series") or "").upper() == "EQ"
            or str(r.get("instrumentType") or "").upper() in ("EQ", "STK")
            or str(r.get("tradingSymbol") or "").upper().endswith("-EQ")
        ]
    meta = {
        "total": payload.get("total", len(rows)),
        "errorCode": payload.get("errorCode"),
        "tookMs": payload.get("tookMs"),
        "indexAvailable": payload.get("errorCode") != "SEARCH_INDEX_UNAVAILABLE",
    }
    return rows, meta


def legacy_row(row: dict) -> dict:
    """Project a canonical row onto the legacy instrument-master shape."""
    return {
        "symbol": row.get("symbol"),
        "tradingSymbol": row.get("tradingSymbol"),
        "companyName": row.get("name") or row.get("companyName"),
        "exchange": row.get("exchange"),
        "exchangeSegment": row.get("exchangeSegment"),
        "segment": row.get("series") or "EQ",
        "instrumentToken": str(row.get("token") or ""),
        "token": str(row.get("token") or ""),
        "isin": row.get("isin") or "Not available",
        "instrumentType": row.get("instrumentType") or "Equity",
        "lotSize": row.get("lotSize"),
        "tickSize": row.get("tickSize"),
        "ltp": row.get("ltp"),
        "change": row.get("change"),
        "changePct": row.get("changePct"),
        "prevClose": row.get("prevClose"),
        "upperCircuit": row.get("upperCircuit"),
        "lowerCircuit": row.get("lowerCircuit"),
        "liveStatus": row.get("liveStatus"),
    }
