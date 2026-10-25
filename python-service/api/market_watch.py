"""Market Watch REST surface — a READ of the canonical engine (REAL data only).

This module does not own the pipeline any more. The single source of truth is
``services.market_watch_engine``, which holds the instrument registry, folds
validated WebSocket ticks into typed state, and owns eligibility, circuit
safety, margin, liquidity and history availability:

    Complete NSE EQ Instrument Master (2560+ real equities, no hardcoded list)
            ↓  services.market_watch_engine registry
    Validated WS ticks → typed state → daily block ledger
            ↓  engine-owned eligibility + circuit safety (never re-decided here)
    Ranking / pins / Show More / search
            ↓
    This module: engine state → Gainers / Losers → Frontend

What this module still does:
  - resolve presentation-only request filters (direction, price, sort, paging);
  - report engine-owned filters under ``diagnostics.engineOwnedFilters`` so the
    UI can show what the engine actually applied instead of re-deciding;
  - serve derived reads (search, Show More, snapshots, status, EOD report);
  - accept pin / saved-filter mutations.

Anti-fabrication rules:
  - Unknown circuit data is NEVER reported as SAFE. It is UNKNOWN.
  - Every status carries a backend reason. Nothing is invented client-side.
  - Distance to a circuit limit uses the circuit BOUNDARY as the denominator.
  - LTP / quotes come only from the current live stream / broker API.
  - No request here triggers a scan or calls the broker.
"""

from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Query

from auth.kotak_client import kotak_session
from bson import ObjectId
from database.connection import get_db
from services import market_calendar, tick_buffer
from services.broker_cache import broker_cache
from services.instrument_cache import instrument_cache
from services.market_watch_filters import (
    apply_filters,
    catalog as filters_catalog,
    validate_criteria,
    validate_filter_document,
)
from services.market_watch_pins import (
    add_pin,
    clear_pins,
    is_pinned,
    list_pins,
    remove_pin,
)
from services.market_watch_ranking import market_watch_ranking
from services.market_watch_engine import market_watch_engine
from services.session.session_manager import session_manager
from services import market_watch_config as mw_config
from services import market_watch_report as mw_report
from services import market_watch_universe as mw_universe
from services import market_watch_weekly as mw_weekly

from api.market_watch_engine import (
    CIRCUIT_SAFE,
    CIRCUIT_UPPER_HIT,
    CIRCUIT_LOWER_HIT,
    CIRCUIT_NEAR_UPPER,
    CIRCUIT_NEAR_LOWER,
    CIRCUIT_UNKNOWN,
    evaluate_circuit_safety,
    evaluate_intraday_eligibility,
    evaluate_trading_eligibility,
    normalize_quote,
    passes_filters,
    circuit_excludes,
    max_change_eligible,
)

router = APIRouter(prefix="/api/market-watch", tags=["market-watch"])
logger = logging.getLogger("app")

_STALE_TICK_SEC = 60.0


#: doc §23 fields the frontend must render but must never compute (doc §24).
_SPEC_FIELDS: tuple[str, ...] = (
    "circuitDistanceUpperPct",
    "circuitDistanceLowerPct",
    "circuitDistancePct",
    "circuitStatus",
    "marginValue",
    "marginMultiplier",
    "marginStatus",
    "intradayStatus",
    "change_1m",
    "change_1m_pct",
    "change_5m",
    "change_5m_pct",
    "change_10m",
    "change_10m_pct",
    "change_30m",
    "change_30m_pct",
    "classification",
    "stockState",
    "movementFlags",
    "dataCompleteness",
    "observationsAboveThreshold",
    "observationsAtOrBelowThreshold",
    "eligibilityStatus",
    "blockReason",
)


def _spec_fields_for(symbol_or_token: str) -> dict[str, Any]:
    """doc §23 backend-owned fields for one symbol, or ``{}`` when unknown.

    Read straight from the engine's typed state. ``None`` values are preserved so
    "not available" stays distinguishable from zero (doc §35.11).
    """
    try:
        record = market_watch_engine.record_for(symbol_or_token)
    except Exception:
        return {}
    if not record:
        return {}
    return {key: record.get(key) for key in _SPEC_FIELDS}


_DEFAULT_BUFFER = 2.0


_OHLC_OPEN_KEYS = ("open", "Open", "op")
_OHLC_HIGH_KEYS = ("high", "High", "h")
_OHLC_LOW_KEYS = ("low", "Low", "l")
_OHLC_CLOSE_KEYS = ("close", "Close", "c")

_CIRCUIT_UC_KEYS = ("upper_circuit", "uc", "upperCircuit", "upperLimit")
_CIRCUIT_LC_KEYS = ("lower_circuit", "lc", "lowerCircuit", "lowerLimit")


def _fnum(v: Any) -> float | None:
    if v is None:
        return None
    try:
        n = float(v)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def _is_present(v: Any) -> bool:
    return v is not None and _fnum(v) is not None


def _first_key(raw: dict, keys: tuple[str, ...]) -> Any:
    for k in keys:
        v = raw.get(k)
        if v is not None:
            return v
    return None


def _ohlc_nested(raw: dict) -> dict:
    o = raw.get("ohlc")
    return o if isinstance(o, dict) else {}


def _as_utc_iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
        return dt.astimezone(timezone.utc).isoformat()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, (int, float)) and value > 0:
        try:
            if value > 10_000_000_000:
                return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    return None


# --------------------------------------------------------------------------- #
# Quote / tick snapshot (REAL WS + REST fields)
# --------------------------------------------------------------------------- #
def _quote_snapshot(token: str, raw: dict) -> dict:
    ohlc = _ohlc_nested(raw)
    norm = normalize_quote(raw, {"token": token})
    ltp = norm["ltp"]
    op = _fnum(_first_key(raw, _OHLC_OPEN_KEYS)) or _fnum(_first_key(ohlc, _OHLC_OPEN_KEYS))
    hi = _fnum(_first_key(raw, _OHLC_HIGH_KEYS)) or _fnum(_first_key(ohlc, _OHLC_HIGH_KEYS))
    lo = _fnum(_first_key(raw, _OHLC_LOW_KEYS)) or _fnum(_first_key(ohlc, _OHLC_LOW_KEYS))
    cl = _fnum(_first_key(raw, _OHLC_CLOSE_KEYS)) or _fnum(_first_key(ohlc, _OHLC_CLOSE_KEYS))
    if cl is None:
        cl = norm["previousClose"]

    vol_tmp = raw.get("last_volume")
    if vol_tmp is None:
        vol_tmp = raw.get("volume") or _first_key(raw, ("vol", "v", "Volume"))
    vol = _fnum(vol_tmp)
    if vol is None:
        vol = norm["volume"]

    ts_raw = _first_key(raw, ("lstup_time", "ts", "ltp_ts", "timestamp", "ltp_time", "last_update_time"))

    depth = raw.get("depth") if isinstance(raw.get("depth"), dict) else {}
    bids = depth.get("buy") if isinstance(depth.get("buy"), list) else []
    asks = depth.get("sell") if isinstance(depth.get("sell"), list) else []
    bid = ask = bid_qty = ask_qty = None
    if bids:
        bid = _fnum(bids[0].get("price"))
        bid_qty = _fnum(bids[0].get("quantity"))
    if asks:
        ask = _fnum(asks[0].get("price"))
        ask_qty = _fnum(asks[0].get("quantity"))
    if bid is None:
        bid = norm["bid"]
    if ask is None:
        ask = norm["ask"]
    if bid_qty is None:
        bid_qty = norm["bidQty"]
    if ask_qty is None:
        ask_qty = norm["askQty"]

    upper = norm["upperCircuit"] or _fnum(_first_key(raw, _CIRCUIT_UC_KEYS)) \
        or _fnum(_first_key(ohlc, _CIRCUIT_UC_KEYS))
    lower = norm["lowerCircuit"] or _fnum(_first_key(raw, _CIRCUIT_LC_KEYS)) \
        or _fnum(_first_key(ohlc, _CIRCUIT_LC_KEYS))

    mis_avail = raw.get("mis_available")
    if raw.get("misAvailable") is not None:
        mis_avail = raw.get("misAvailable")

    return {
        "ltp": ltp,
        "open": op,
        "high": hi,
        "low": lo,
        "prevClose": cl,
        "volume": vol,
        "change": norm["change"],
        "changePercent": norm["changePercent"],
        "bid": bid,
        "bidQty": bid_qty,
        "ask": ask,
        "askQty": ask_qty,
        "turnover": norm["turnover"],
        "oi": norm["oi"],
        "oiChange": norm["oiChange"],
        "upperCircuit": upper,
        "lowerCircuit": lower,
        "circuitPercent": norm["circuitPercent"],
        "quoteTs": _as_utc_iso(ts_raw),
        "available": ltp is not None,
        "misAvailable": bool(mis_avail) if mis_avail is not None else None,
        "source": raw.get("source") or "broker",
    }


def _tick_snapshot(token: str) -> dict:
    """Real market data from the latest WS tick (central store), or empty.

    The central store now carries the REAL exchange circuit limits
    (upper_circuit_limit / lower_circuit_limit) from the live feed.
    """
    latest = tick_buffer._latest_ticks.get(str(token))
    if not latest:
        return {}
    ts_val = latest.get("ts")
    return {
        "ltp": _fnum(latest.get("ltp")),
        "open": _fnum(latest.get("open")),
        "high": _fnum(latest.get("high")),
        "low": _fnum(latest.get("low")),
        "prevClose": _fnum(latest.get("close")),
        "volume": _fnum(latest.get("volume")),
        "change": _fnum(latest.get("change")),
        "changePercent": _fnum(latest.get("changePercent")),
        "bid": _fnum(latest.get("bp")),
        "bidQty": _fnum(latest.get("bq")),
        "ask": _fnum(latest.get("sp")),
        "askQty": _fnum(latest.get("sq")),
        "turnover": _fnum(latest.get("total_traded_value")),
        "oi": _fnum(latest.get("oi")),
        "oiChange": _fnum(latest.get("oi_change")),
        "circuitPercent": _fnum(latest.get("circuit_percent")),
        # REAL circuit limits from the live feed.
        "upperCircuit": _fnum(latest.get("upper_circuit_limit")),
        "lowerCircuit": _fnum(latest.get("lower_circuit_limit")),
        "lastTickAt": _as_utc_iso(ts_val),
        "receivedAt": _as_utc_iso(latest.get("receivedAt")),
        "tickAgeSec": tick_buffer.latest_tick_age_seconds(token),
        "available": True,
        "source": "broker_live",
    }


def _merged_snapshot(token, inst, raw_quote, circuit_data, session_products, account_intraday=None) -> dict:
    tick = _tick_snapshot(token)
    quote = _quote_snapshot(token, raw_quote) if raw_quote else {}

    def pick(*keys):
        for k in keys:
            v = tick.get(k)
            if v is not None:
                return v
        for k in keys:
            v = quote.get(k)
            if v is not None:
                return v
        return None

    ltp = pick("ltp")
    quote_ts = quote.get("quoteTs")
    last_tick_at = tick.get("lastTickAt")
    received_at = tick.get("receivedAt")
    tick_age = tick.get("tickAgeSec")
    from_tick = bool(tick)
    from_quote = bool(quote)
    live = from_tick and (tick_age is None or tick_age <= _STALE_TICK_SEC)
    stale = from_tick and tick_age is not None and tick_age > _STALE_TICK_SEC

    # Circuit limits: live tick first (REAL exchange fields), REST OHLC fallback.
    upper_circuit = pick("upperCircuit")
    lower_circuit = pick("lowerCircuit")
    if upper_circuit is None and circuit_data:
        upper_circuit = _fnum(circuit_data.get("upperCircuit"))
    if lower_circuit is None and circuit_data:
        lower_circuit = _fnum(circuit_data.get("lowerCircuit"))

    merged = {
        "symbol": str(inst.get("symbol") or inst.get("tradingSymbol") or ""),
        "tradingSymbol": str(inst.get("tradingSymbol") or inst.get("symbol") or ""),
        "companyName": inst.get("companyName"),
        "instrumentToken": token,
        "exchangeSegment": str(inst.get("exchangeSegment") or "nse_cm"),
        "exchange": "NSE",
        "isin": inst.get("isin"),
        "series": inst.get("series"),
        "ltp": ltp,
        "open": pick("open"),
        "high": pick("high"),
        "low": pick("low"),
        "prevClose": pick("prevClose"),
        "volume": pick("volume"),
        "change": pick("change"),
        "changePercent": pick("changePercent"),
        "bid": pick("bid"),
        "bidQty": pick("bidQty"),
        "ask": pick("ask"),
        "askQty": pick("askQty"),
        "turnover": pick("turnover"),
        "oi": pick("oi"),
        "oiChange": pick("oiChange"),
        "circuitPercent": pick("circuitPercent"),
        "quoteTs": quote_ts,
        "lastTickAt": last_tick_at,
        "receivedAt": received_at,
        "available": ltp is not None,
        "dataQuality": {
            "live": live,
            "stale": stale,
            "tickAgeSec": tick_age,
            "quoteSource": "ws" if from_tick else ("quote" if from_quote else "none"),
        },
    }

    # Intraday eligibility (broker-confirmed, mandatory).
    eligibility = evaluate_intraday_eligibility(
        inst, {"misAvailable": quote.get("misAvailable")}, list(session_products),
        account_intraday=account_intraday,
    )
    if eligibility["eligible"]:
        # A merged row is only eligible if it has a real usable price and a
        # live/non-stale quote. Keep the intraday reason but gate on price too.
        if ltp is None or ltp <= 0:
            eligibility = {**eligibility, "eligible": False,
                           "reason": "NO_LIVE_PRICE", "instrumentStatus": "ACTIVE"}
        elif stale:
            eligibility = {**eligibility, "eligible": False,
                           "reason": "STALE_QUOTE", "instrumentStatus": "ACTIVE"}
    merged["eligibility"] = {
        "intradayEligible": eligibility["eligible"],
        "eligible": eligibility["eligible"],
        "product": eligibility["product"],
        "intradayReason": eligibility["reason"],
        "instrumentStatus": eligibility["instrumentStatus"],
        "quoteAvailable": bool(quote),
        "livePriceAvailable": ltp is not None and ltp > 0,
        "exclusionReason": None if eligibility["eligible"] else eligibility["reason"],
    }

    # Trading/instrument state (honest, never claims AVAILABLE when closed/etc).
    merged["trading"] = evaluate_trading_eligibility(inst)

    # Circuit evaluation (never fakes SAFE).
    circuit_settings = {"enabled": True, "bufferPct": _DEFAULT_BUFFER}  # default; real value injected later
    merged["circuit"] = {
        "upperCircuit": upper_circuit,
        "lowerCircuit": lower_circuit,
        "status": CIRCUIT_UNKNOWN,
        "distanceToUpperPct": None,
        "distanceToLowerPct": None,
        "isUpperCircuitHit": False,
        "isLowerCircuitHit": False,
        "isNearUpperCircuit": False,
        "isNearLowerCircuit": False,
        "circuitDataAvailable": upper_circuit is not None and lower_circuit is not None,
        "circuitSafe": False,
        "circuitReason": None,
    }
    return merged


def _apply_circuit(md: dict, inst: dict, enabled: bool, buffer: float) -> dict:
    """Evaluate safety against REAL circuit limits and write into the row."""
    circuit = evaluate_circuit_safety(
        {"ltp": md["ltp"], "upperCircuit": md["circuit"]["upperCircuit"],
         "lowerCircuit": md["circuit"]["lowerCircuit"]},
        inst,
        {"enabled": enabled, "bufferPct": buffer},
    )
    md["circuit"].update({
        "status": circuit["status"],
        "distanceToUpperPct": circuit["distanceToUpperPct"],
        "distanceToLowerPct": circuit["distanceToLowerPct"],
        "isUpperCircuitHit": circuit["isUpperCircuitHit"],
        "isLowerCircuitHit": circuit["isLowerCircuitHit"],
        "isNearUpperCircuit": circuit["isNearUpperCircuit"],
        "isNearLowerCircuit": circuit["isNearLowerCircuit"],
        "circuitDataAvailable": circuit["circuitDataAvailable"],
        "circuitSafe": circuit["status"] == CIRCUIT_SAFE,
        "circuitReason": circuit["exclusionReason"],
        "bufferPct": buffer,
    })
    md["eligibility"]["circuitSafe"] = md["circuit"]["circuitSafe"]
    return md["circuit"]


# --------------------------------------------------------------------------- #
# Market context
# --------------------------------------------------------------------------- #
def _market_context() -> dict:
    snap = market_calendar.snapshot()
    return {
        "exchange": "NSE",
        "segment": "EQ",
        "status": snap.get("market_status"),
        "session": snap.get("market_session"),
        "date": snap.get("market_date"),
        "dayClass": snap.get("day_class"),
        "tradingDay": snap.get("tradeDay", snap.get("trading_day")),
        "closureReason": snap.get("closure_reason"),
    }


# --------------------------------------------------------------------------- #
# Sort
# --------------------------------------------------------------------------- #
def _sort_rows(rows: list[dict], sort_by: str, sort_dir: str) -> list[dict]:
    def momentum(r):
        return (r.get("momentum") or {}).get(r.get("window") or "5m")

    def key_fn(r):
        if sort_by == "rupee":
            return r.get("change")
        if sort_by == "ltp":
            return r.get("ltp")
        if sort_by == "volume":
            return r.get("volume")
        if sort_by == "symbol":
            return (r.get("symbol") or "").upper()
        if sort_by == "momentum":
            return momentum(r)
        return r.get("changePercent")

    reverse = (sort_dir or "desc") == "desc"
    if sort_by == "symbol":
        rows.sort(key=lambda r: (r.get("symbol") or "").upper(), reverse=reverse)
    else:
        rows.sort(key=lambda r: (key_fn(r) if key_fn(r) is not None else -math.inf), reverse=reverse)
    return rows


def _compute_counts(rows: list[dict]) -> dict:
    advancing = sum(1 for r in rows if _is_present(r.get("changePercent")) and r["changePercent"] > 0)
    declining = sum(1 for r in rows if _is_present(r.get("changePercent")) and r["changePercent"] < 0)
    unchanged = max(0, len(rows) - advancing - declining)
    live = sum(1 for r in rows if r.get("dataQuality", {}).get("live"))
    return {
        "advancing": advancing,
        "declining": declining,
        "unchanged": unchanged,
        "scanned": len(rows),
        "live": live,
    }


def _empty_diagnostics(total_nse_eq: int) -> dict:
    return {
        "nseEqUniverse": total_nse_eq,
        "active": 0,
        "tradable": 0,
        "intradayEligible": 0,
        "liveQuotes": 0,
        "freshQuotes": 0,
        "quoteRequested": 0,
        "quoteReceived": 0,
        "circuitDataAvailable": 0,
        "circuitSafe": 0,
        "circuitNearUpper": 0,
        "circuitNearLower": 0,
        "upperCircuitHit": 0,
        "lowerCircuitHit": 0,
        "priceEligible": 0,
        "dailyChangeEligible": 0,
        "momentumEligible": 0,
        "historyReady": 0,
        "scannerEligible": 0,
        "finalEligible": 0,
        "gainers": 0,
        "losers": 0,
        "excluded": {
            "intradayUnavailable": 0,
            "inactive": 0,
            "noLiveQuote": 0,
            "staleQuote": 0,
            "circuitDataUnavailable": 0,
            "nearUpperCircuit": 0,
            "nearLowerCircuit": 0,
            "upperCircuitHit": 0,
            "lowerCircuitHit": 0,
            "priceOutOfRange": 0,
            "dailyChangeLimit": 0,
            "tradingRestricted": 0,
            "historyUnavailable": 0,
            "liquidityFailed": 0,
            "hiddenFromScanner": 0,
        },
    }


# --------------------------------------------------------------------------- #
# Response builder — the stable Market Watch HTTP contract.
#
# ``scannerState`` vocabulary is retained because the UI already keys off it,
# but it now describes the ENGINE's data, not a scan this endpoint ran:
#   LIVE          the engine holds real, recently priced rows
#   STALE         the engine is known but has no priced row yet
#   MARKET_CLOSED the market is not open; only last-known data is available
#
# The ``scan`` block is retained for shape compatibility and is always
# ``id: null``: no scan happens on this request path.
# --------------------------------------------------------------------------- #
def _build_response(*, ok, market, universe, filters, gainers, losers, diagnostics,
                    quote_source, generated_at, reason=None, refresh_ms=None,
                    counts=None, refresh_error=None, scan_id=None,
                    scanner_state="LIVE", started_at=None, completed_at=None,
                    duration_ms=None, session=None, web_socket=None, database=None):
    identified_at = datetime.now(timezone.utc).isoformat()
    return {
        "ok": ok,
        "scannerState": scanner_state,
        "status": scanner_state,
        "scan": {
            "id": scan_id,
            "startedAt": started_at or generated_at,
            "completedAt": completed_at or generated_at,
            "durationMs": duration_ms if duration_ms is not None else refresh_ms,
        },
        "market": market,
        "universe": universe,
        "filters": filters,
        "gainers": [r for r in gainers],
        "losers": [r for r in losers],
        "diagnostics": diagnostics,
        "counts": counts or {"advancing": 0, "declining": 0, "unchanged": 0, "scanned": len(gainers) + len(losers), "live": 0},
        "reason": reason,
        "quoteSource": quote_source,
        "generatedAt": generated_at,
        "identifiedAt": identified_at,
        "refreshMs": refresh_ms,
        "refreshError": refresh_error,
        "scanId": scan_id,
        "session": session,
        "webSocket": web_socket,
        "database": database,
    }


def _session_status() -> dict:
    return {
        "active": bool(session_manager.is_active() and kotak_session.session_active),
        "state": session_manager.snapshot().get("state"),
    }


def _websocket_status() -> dict:
    try:
        from ws_socket.ws_manager import ws_manager
        st = ws_manager.status()
        return {
            "connected": bool(st.get("connected")),
            "state": st.get("lifecycle_state") or st.get("state"),
        }
    except Exception:
        return {"connected": False, "state": "UNKNOWN"}


def _database_status() -> dict:
    try:
        from database.connection import is_mongo_connected
        return {"connected": bool(is_mongo_connected())}
    except Exception:
        return {"connected": False}


@router.get("/history")
async def market_watch_history(
    limit: int = Query(30, ge=1, le=200),
    symbol: str | None = Query(None, description="Optional symbol / token filter"),
    date: str | None = Query(None, description="Optional trading date (YYYY-MM-DD)"),
):
    """Recent real Market Watch decisions, newest first.

    The engine has no per-request scan to journal: it persists one document per
    eligibility decision through the DB Writer (``market_watch_decisions``),
    which is the honest history of what the engine decided and why. A symbol or
    date filter narrows the same real collection.
    """
    query: dict = {}
    if symbol:
        query["$or"] = [{"symbol": symbol.upper()}, {"instrumentToken": str(symbol)}]
    if date:
        query["date"] = date
    rows: list[dict] = []
    try:
        db = get_db()
        cursor = (
            db.market_watch_decisions.find(query)
            .sort("blocked_at", -1)
            .limit(limit)
        )
        rows = await cursor.to_list(length=limit)
    except Exception as exc:
        logger.debug("market watch history unavailable: %s", exc)
        rows = []
    out = []
    for r in rows:
        r.pop("_id", None)
        # The ledger stores `blocked_at` as an ISO string; normalise defensively
        # in case an older writer stored it as a datetime.
        raw = r.get("blocked_at")
        r["blockedAt"] = _as_utc_iso(raw) if not isinstance(raw, str) else raw
        r.pop("blocked_at", None)
        out.append(r)
    return {
        "ok": True,
        "count": len(out),
        "source": "market_watch_decisions",
        "decisions": out,
        # Retained key so existing consumers keep a non-empty shape.
        "scans": out,
    }


@router.get("/progress")
async def market_watch_progress():
    """Canonical Market Watch engine progress — real engine counters.

    The engine has no batches: it holds a registry, folds validated WebSocket
    ticks into typed state, and publishes on a fixed cadence. So "progress" is
    the real lifecycle/subscription picture — how much of the universe is
    known, eligible, subscribed and priced right now — never a fabricated
    batch cursor.
    """
    engine = market_watch_engine
    registry = engine.registry()
    counts = engine.status_counts()
    eligible = engine.eligible_token_count()
    subscribed = engine.subscribed_token_count()
    live = counts.get("live", 0)
    rows = engine.full_universe_rows()
    gainers = sum(1 for r in rows if _is_present(r.get("changePercent")) and r["changePercent"] > 0)
    losers = sum(1 for r in rows if _is_present(r.get("changePercent")) and r["changePercent"] < 0)
    snapshot = engine.status_snapshot()
    # status_snapshot() nests the Market Watch custom fields (lifecycle,
    # indexVersion, feedState, ...) under metrics.custom — reading them from the
    # top level returned None and the phase indicator had no state to show.
    custom = snapshot.get("metrics", {}).get("custom", {}) or {}
    lifecycle = custom.get("lifecycle") or snapshot.get("lifecycle") or {}
    ranking = engine.ranking_status() or {}

    return {
        "ok": True,
        "source": "market_watch_engine",
        "feedState": engine.feed_state(),
        # LifecycleSnapshot.to_dict() key names (previousState / changedAt), plus
        # the engine's own eligibleCount / subscribedCount / universeState.
        # These used to be read as "previous" / "since", which do not exist in
        # the snapshot, so the phase indicator silently lost its history.
        "lifecycle": {
            "state": lifecycle.get("state"),
            "previousState": lifecycle.get("previousState"),
            "changedAt": lifecycle.get("changedAt"),
            "tradingDate": lifecycle.get("tradingDate"),
            "serverTime": lifecycle.get("serverTime"),
            "nextState": lifecycle.get("nextState"),
            "minutesToNext": lifecycle.get("minutesToNext"),
            "dataActive": lifecycle.get("dataActive"),
            "monitoring": lifecycle.get("monitoring"),
            "states": lifecycle.get("states"),
            "eligibleCount": lifecycle.get("eligibleCount", eligible),
            "subscribedCount": lifecycle.get("subscribedCount", subscribed),
            "universeState": lifecycle.get("universeState"),
            # doc §8 — the runtime window is operator configuration, so it is
            # published rather than restated by the frontend. The offline page
            # used to hardcode "08:50 – 15:30", which silently contradicts a
            # configured window (doc §24: the frontend renders, it does not
            # re-derive). `runtimeActive` is the engine's own verdict.
            "runtimeActive": lifecycle.get("runtimeActive"),
            "schedule": lifecycle.get("schedule") or {},
        },
        "universe": {
            "total": len(registry),
            "known": len(engine.states()),
            "eligible": eligible,
        },
        "subscribed": subscribed,
        "withLivePrice": live,
        "statusCounts": counts,
        "valid": len(rows),
        "gainers": gainers,
        "losers": losers,
        "unchanged": max(0, len(rows) - gainers - losers),
        "indexVersion": custom.get("indexVersion", snapshot.get("indexVersion")),
        "ranking": ranking,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _filters_dict(params: dict) -> dict:
    return {
        "direction": params.get("direction", "all"),
        "window": params.get("window", "5m"),
        "minPrice": params.get("minPrice"),
        "maxPrice": params.get("maxPrice"),
        "rupeeMin": params.get("rupeeMin"),
        "rupeeMax": params.get("rupeeMax"),
        "pctMin": params.get("pctMin"),
        "pctMax": params.get("pctMax"),
        "momMin": params.get("momMin"),
        "momMax": params.get("momMax"),
        "q": params.get("q", ""),
        "sortBy": params.get("sortBy", "pct"),
        "sortDir": params.get("sortDir", "desc"),
        "resultLimit": params.get("resultLimit", 80),
        "circuitSafety": params.get("circuitSafety", True),
        "circuitBuffer": params.get("circuitBuffer", _DEFAULT_BUFFER),
        "minVolume": params.get("minVolume"),
        "minTurnover": params.get("minTurnover"),
        "maxChangePercent": params.get("maxChangePercent"),
    }


# --------------------------------------------------------------------------- #
# Endpoint
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Endpoint — a READ of the canonical Market Watch engine (no second scanner)
# --------------------------------------------------------------------------- #
def _engine_owned(value, default) -> dict:
    """Report a request parameter the engine, not this endpoint, decides.

    Returning the value plus whether the caller actually overrode the default
    keeps the API honest: a per-request circuit/margin rule can never look
    applied when the engine ignored it.
    """
    return {"value": value, "overridden": value != default}


@router.get("")
async def market_watch(
    force: bool = Query(False),
    direction: str = Query("all"),
    rupee_min: float | None = Query(None, alias="rupeeMin"),
    rupee_max: float | None = Query(None, alias="rupeeMax"),
    pct_min: float | None = Query(None, alias="pctMin"),
    pct_max: float | None = Query(None, alias="pctMax"),
    window: str = Query("5m"),
    mom_min: float | None = Query(None, alias="momMin"),
    mom_max: float | None = Query(None, alias="momMax"),
    q: str = Query(""),
    sort_by: str = Query("pct"),
    sort_dir: str = Query("desc"),
    result_limit: int = Query(80, alias="resultLimit", ge=1, le=2000),
    min_price: float | None = Query(None, alias="minPrice"),
    max_price: float | None = Query(None, alias="maxPrice"),
    circuit_safety: bool = Query(True, alias="circuitSafety"),
    circuit_buffer: float = Query(_DEFAULT_BUFFER, alias="circuitBuffer", ge=0, le=50),
    min_volume: float | None = Query(None, alias="minVolume"),
    min_turnover: float | None = Query(None, alias="minTurnover"),
    max_change_pct: float | None = Query(None, alias="maxChangePercent", ge=0, le=100),
):
    """NSE EQ intraday gainers / losers, served by the canonical Market Watch engine.

    docs/engines/MARKET_WATCH.md §16. There is exactly ONE Market Watch
    implementation — ``services.market_watch_engine`` — and this endpoint is a
    read of its published state. It does not run a scan, does not call the
    broker, does not build its own universe, and does not re-decide
    eligibility; the engine owns all of that and the operator owns the config.

    Query parameters therefore behave as follows:

    * presentation-only narrowing (price/pct/momentum range, search text,
      sort, limit) is applied to the engine's real rows here;
    * ELIGIBILITY parameters (``circuitSafety``, ``circuitBuffer``,
      ``maxChangePercent``, ``minVolume``, ``minTurnover``) are engine config
      (``MWR_CIRCUIT_*`` / ``MWR_FILTER_*``). They are reported back under
      ``diagnostics.engineOwnedFilters`` instead of being silently applied, so
      a caller can never believe a per-request circuit rule took effect;
    * ``force`` is accepted for backward compatibility and is a no-op: the
      engine refreshes on its own cadence and blocking a request until a
      synchronous broker sweep finishes is exactly the coupling this engine
      removed.
    """
    engine = market_watch_engine
    generated_at = engine.generated_at()
    market = _market_context()
    filters = _filters_dict({
        "direction": direction, "window": window, "minPrice": min_price, "maxPrice": max_price,
        "rupeeMin": rupee_min, "rupeeMax": rupee_max, "pctMin": pct_min, "pctMax": pct_max,
        "momMin": mom_min, "momMax": mom_max, "q": q, "sortBy": sort_by, "sortDir": sort_dir,
        "resultLimit": result_limit, "circuitSafety": circuit_safety, "circuitBuffer": circuit_buffer,
        "minVolume": min_volume, "minTurnover": min_turnover,
        "maxChangePercent": max_change_pct,
    })

    # --- Universe totals: the engine's registry, not a second master scan --- #
    registry = engine.registry()
    total_universe = len(registry)
    eligible_tokens = engine.eligible_token_count()
    state_counts = engine.status_counts()

    # --- Real rows the engine has published for the live eligible universe --- #
    rows = engine.full_universe_rows()

    filter_kwargs = {
        "direction": direction, "window": window,
        "rupee_min": rupee_min, "rupee_max": rupee_max,
        "pct_min": pct_min, "pct_max": pct_max,
        "mom_min": mom_min, "mom_max": mom_max, "q": q,
    }
    if direction == "all":
        gpos = [r for r in rows if _is_present(r.get("changePercent")) and r["changePercent"] > 0]
        lneg = [r for r in rows if _is_present(r.get("changePercent")) and r["changePercent"] < 0]
        gainers = [r for r in gpos if passes_filters(r, **filter_kwargs)]
        losers = [r for r in lneg if passes_filters(r, **filter_kwargs)]
    else:
        gainers = [r for r in rows if passes_filters(r, **filter_kwargs)]
        losers = [r for r in rows if passes_filters(r, **filter_kwargs)]

    gainers = _sort_rows(gainers, sort_by, sort_dir)[:result_limit]
    losers = _sort_rows(losers, sort_by, sort_dir)[:result_limit]

    counts = _compute_counts(rows)
    universe = {
        "total": total_universe,
        "eligible": eligible_tokens,
        "active": state_counts.get("live", 0),
        "intradayEligible": eligible_tokens,
        "liveQuotes": state_counts.get("live", 0),
        "scannerEligible": eligible_tokens,
        "source": "market_watch_engine",
        "state": engine.feed_state(),
    }

    diag = _empty_diagnostics(total_universe)
    diag["nseEqUniverse"] = total_universe
    diag["active"] = state_counts.get("live", 0)
    diag["gainers"] = len(gainers)
    diag["losers"] = len(losers)
    diag["engineStateCount"] = engine.live_state_count()
    diag["subscribedTokenCount"] = engine.subscribed_token_count()
    diag["engineOwnedFilters"] = {
        "circuitSafety": _engine_owned(circuit_safety, True),
        "circuitBuffer": _engine_owned(circuit_buffer, _DEFAULT_BUFFER),
        "maxChangePercent": _engine_owned(max_change_pct, None),
        "minVolume": _engine_owned(min_volume, None),
        "minTurnover": _engine_owned(min_turnover, None),
        "note": (
            "Eligibility is decided by the Market Watch engine from its own "
            "configuration (MWR_CIRCUIT_*, MWR_FILTER_*). These request "
            "parameters are reported, not applied."
        ),
    }

    # --- Honest state: LIVE only when the engine holds real fresh data ----- #
    # The registry always yields PENDING placeholders, so "we have rows" proves
    # nothing. Only a real traded price makes the page LIVE.
    live_rows = [r for r in rows if _fnum(r.get("ltp")) is not None]
    feed_state = engine.feed_state()
    market_status = str((market or {}).get("status") or "").upper()
    if market_status == "CLOSED":
        scanner_state = "MARKET_CLOSED"
    elif live_rows:
        scanner_state = "LIVE"
    else:
        scanner_state = "STALE"

    reason = None
    if not live_rows:
        reason = (
            "The Market Watch engine has not published a live eligible universe yet. "
            "It populates state from validated WebSocket ticks between "
            f"{engine.mw_config().lifecycle.filter_start} and 15:15 IST; the engine "
            f"feed is {feed_state}."
        )
    if force:
        reason = (reason + " " if reason else "") + (
            "'force' is accepted but has no effect: the engine refreshes on its own "
            "cadence and this endpoint never triggers a synchronous broker scan."
        )

    payload = _build_response(
        ok=True, scanner_state=scanner_state, market=market, universe=universe,
        filters=filters, gainers=gainers, losers=losers, diagnostics=diag,
        counts=counts, quote_source="market_watch_engine", generated_at=generated_at,
        reason=reason, scan_id=None, started_at=generated_at, completed_at=generated_at,
        session=_session_status(), web_socket=_websocket_status(), database=_database_status(),
    )
    # No scan is recorded: this endpoint performed no scan. The engine persists
    # its own ticks/candles/decisions through the DB Writer.
    return payload


# --------------------------------------------------------------------------- #
# Live update support: lightweight per-token snapshot from the central store
# (WS ticks only — no broker REST call on every refresh), used by the page's
# 30s fallback poll and WebSocket merge.
# --------------------------------------------------------------------------- #
def _lookup_instrument(token: str) -> dict | None:
    """Resolve an instrument by token (index first, scan fallback).

    The scanner iterates the master list directly; some code paths / tests may
    not have built the ``_by_token`` index, so we also scan ``_instruments``.
    """
    inst = instrument_cache.lookup_by_token(str(token))
    if inst is not None:
        return inst
    for i in getattr(instrument_cache, "_instruments", []):
        if str(i.get("token") or "") == str(token):
            return i
    return None


@router.get("/tick-snapshot")
async def market_watch_tick_snapshot(
    tokens: str = Query("", description="comma-separated NSE EQ instrument tokens"),
    buffer: float = Query(_DEFAULT_BUFFER, ge=0, le=50),
    safety: bool = Query(True, alias="safety"),
):
    """Real merged market data for the given tokens, from the central tick store.

    Does NOT require a broker session: it serves whatever the live WebSocket
    feed has already delivered (REAL values only). Rows without a tick are
    returned with ``hasData: false`` so the client can retain its last snapshot
    instead of wiping it.
    """
    generated_at = datetime.now(timezone.utc).isoformat()
    token_list = [t.strip() for t in tokens.split(",") if t.strip()][:500]
    rows: dict[str, Any] = {}

    for tk in token_list:
        inst = _lookup_instrument(tk)
        if inst is None:
            rows[tk] = {
                "token": tk, "exists": False, "hasData": False,
                "reason": "unknown_instrument",
            }
            continue

        md = _merged_snapshot(tk, inst, None, None, (), account_intraday=kotak_session.intraday_available)
        md["token"] = md["instrumentToken"]
        md["instrumentToken"] = tk
        has_data = bool(md.get("ltp") is not None and md.get("ltp") > 0)

        circuit = _apply_circuit(md, inst, safety, buffer)
        md["eligibility"]["circuitSafe"] = md["circuit"]["circuitSafe"]

        rows[tk] = {
            "token": tk,
            "exists": True,
            "symbol": md.get("symbol"),
            "tradingSymbol": md.get("tradingSymbol"),
            "ltp": md.get("ltp"),
            "change": md.get("change"),
            "changePercent": md.get("changePercent"),
            "open": md.get("open"),
            "high": md.get("high"),
            "low": md.get("low"),
            "prevClose": md.get("prevClose"),
            "volume": md.get("volume"),
            "turnover": md.get("turnover"),
            "oi": md.get("oi"),
            "oiChange": md.get("oiChange"),
            "upperCircuit": md["circuit"].get("upperCircuit"),
            "lowerCircuit": md["circuit"].get("lowerCircuit"),
            "circuitPercent": md.get("circuitPercent"),
            "hasData": has_data,
            "dataQuality": md.get("dataQuality"),
            "circuit": md["circuit"],
            "circuitSafe": md["circuit"].get("circuitSafe"),
            # doc §23: the backend-owned fields. These were computed above and
            # then dropped from the response, which left the frontend with no way
            # to render them (and an incentive to recompute them — doc §24).
            "lastTickAt": md.get("lastTickAt"),
            "receivedAt": md.get("receivedAt"),
            "eligibility": md.get("eligibility"),
        }
        spec = _spec_fields_for(tk)
        if spec:
            rows[tk].update(spec)

    return {
        "ok": True,
        "generatedAt": generated_at,
        "session": session_manager.is_active() and kotak_session.session_active,
        "rows": rows,
    }


# --------------------------------------------------------------------------- #
# 30-second ranking snapshots + automatic Top-5 pins (docs §10-§14)
# --------------------------------------------------------------------------- #
@router.get("/sections")
async def market_watch_sections():
    """All dynamic sections: top gainers, top losers, highest volume, movers …"""
    engine = market_watch_engine
    sections = engine.get_sections()
    return {
        "ok": True,
        "tradingDate": engine.ranking_snapshot().get("tradingDate"),
        "generatedAt": engine.generated_at(),
        "indexVersion": engine._index_version,
        "feedState": engine.feed_state(),
        "liveStateCount": engine.live_state_count(),
        "universeSize": engine.universe_size(),
        "subscribedTokenCount": engine.subscribed_token_count(),
        "statusCounts": engine.status_counts(),
        "sections": sections,
    }


@router.get("/search")
async def market_watch_search(
    q: str = Query("", description="Substring over symbol / name (full universe)"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Full-universe search (docs §17): matching stocks, no new broker feed needed."""
    return market_watch_engine.search(q, limit=limit, offset=offset)


# --------------------------------------------------------------------------- #
# Configuration (docs §23) — live engine config + ranking status + filter catalog
# --------------------------------------------------------------------------- #
@router.get("/config")
async def market_watch_config():
    """Market Watch engine configuration, ranking/cap settings and the filter
    criteria catalog usable in the custom-filter builder. All real values."""
    engine = market_watch_engine
    return {
        "ok": True,
        "tradingDate": market_calendar.snapshot().get("market_date"),
        "feedState": engine.feed_state(),
        "engine": engine.config(),
        "ranking": {
            "intervalSeconds": engine.config().get("rankingIntervalSeconds"),
            "maxGainerPins": engine.config().get("maxGainerPins"),
            "maxLoserPins": engine.config().get("maxLoserPins"),
            "trackedTopN": market_watch_ranking.status().get("topTracked", 5),
        },
        "limits": {
            "maxManualPins": 20,
            "pageSize": engine.config().get("pageSize"),
            "initialSectionLimit": engine.config().get("initialSectionLimit"),
        },
        "filterCatalog": filters_catalog(),
        "statusCounts": engine.status_counts(),
        "storage": engine.tick_saving(),
    }


# --------------------------------------------------------------------------- #
# Persistence on/off (doc §23) — operator control over what Market Watch saves
# --------------------------------------------------------------------------- #
#: The doc §23 storage switches, in the order they are presented. Each entry is
#: ``(api_field, settings_key, StorageConfig field, description)``. The write
#: goes through the ONE app_settings contract in ``services.settings_service``
#: and the TTL runtime cache picks it up on the next reconcile — no second
#: config channel, no restart.
_TICK_SAVING_SWITCHES: tuple[tuple[str, str, str, str], ...] = (
    (
        "persistTicks", "mwr_persist_ticks", "persist_ticks",
        "Save every Market Watch tick to MongoDB (market_ticks).",
    ),
    (
        "persistCandles", "mwr_persist_candles", "persist_candles",
        "Save 1m/5m/10m/30m candles to MongoDB.",
    ),
    (
        "persistDecisions", "mwr_persist_decisions", "persist_decisions",
        "Save block / re-entry decisions and the EOD report.",
    ),
)
_TICK_SAVING_FIELDS: tuple[str, ...] = tuple(item[0] for item in _TICK_SAVING_SWITCHES)


def _parse_switch(payload: Any) -> dict[str, bool]:
    """Accept ``{"persistTicks": false}``, ``{"ticks": "off"}`` or a bare bool."""
    from services.market_watch_config import load as load_config

    current = {
        "persistTicks": bool(load_config().storage.persist_ticks),
        "persistCandles": bool(load_config().storage.persist_candles),
        "persistDecisions": bool(load_config().storage.persist_decisions),
    }
    if isinstance(payload, bool):
        # A bare boolean is the tick switch: the control the operator asked for.
        return {"persistTicks": payload}
    if not isinstance(payload, dict):
        return current
    out: dict[str, bool] = {}
    # Lower-cased alias -> canonical field name.
    aliases = {item[0].lower(): item[0] for item in _TICK_SAVING_SWITCHES}
    aliases.update({"ticks": "persistTicks", "candles": "persistCandles", "decisions": "persistDecisions"})
    for raw_key, raw_value in payload.items():
        field = aliases.get(str(raw_key).strip().lower())
        if field is None:
            continue
        if isinstance(raw_value, bool):
            out[field] = raw_value
        elif isinstance(raw_value, (int, float)):
            out[field] = bool(raw_value)
        elif isinstance(raw_value, str):
            text = raw_value.strip().lower()
            if text in {"1", "true", "yes", "on"}:
                out[field] = True
            elif text in {"0", "false", "no", "off"}:
                out[field] = False
    return out


@router.get("/tick-saving")
async def market_watch_tick_saving():
    """Current persistence on/off state and the real counters behind it (doc §23).

    A read of resolved engine config plus the DB Writer's document buffer — it
    does not scan, does not call the broker and never re-decides eligibility.
    """
    return {"ok": True, **market_watch_engine.tick_saving()}


@router.post("/tick-saving")
async def market_watch_set_tick_saving(payload: Any = Body(default=None)):
    """Turn Market Watch persistence on or off (doc §23).

    Accepts ``{"persistTicks": false}``, ``{"ticks": "off"}`` or a bare JSON
    boolean (which means the tick switch). ``Body`` is explicit because an
    ``Any`` parameter is otherwise bound as a query parameter by FastAPI, and
    the body would be silently ignored.

    The write goes through ``services.settings_service`` so the value is
    persisted, validated and broadcast exactly like every other setting, and the
    TTL runtime cache is refreshed by that same path. The document buffer's
    gates are then reconciled immediately, so the switch does not wait for the
    next status tick, and the flush loop is (re)started if every switch had been
    off when the process booted.

    Disabling drops whatever is still buffered for the switched-off collection:
    writing documents after the operator asked for "off" would make the control
    a lie. The drop count is returned.
    """
    from dataclasses import replace as _dc_replace

    from services import market_watch_doc_buffer, settings_service
    from services.market_watch_config import load as _load_config

    requested = _parse_switch(payload)
    if not requested:
        return {
            "ok": False,
            "error": "No known switch in payload",
            "accepted": list(_TICK_SAVING_FIELDS),
            **market_watch_engine.tick_saving(),
        }

    keys = {item[0]: item[1] for item in _TICK_SAVING_SWITCHES}
    attrs = {item[0]: item[2] for item in _TICK_SAVING_SWITCHES}
    written: dict[str, bool] = {}
    for field, value in requested.items():
        key = keys[field]
        try:
            await settings_service.set_setting(key, bool(value))
            written[field] = bool(value)
        except Exception as exc:  # unknown key / validation / no database
            logger.warning("[MARKET_WATCH] tick-saving write failed for %s: %s", key, exc)

    if not written:
        return {
            "ok": False,
            "error": "Persistence is not writable right now (settings backend unavailable)",
            **market_watch_engine.tick_saving(),
        }

    # Reconcile from the values just applied, NOT from a re-resolved config: the
    # runtime cache refresh happens inside set_setting and a slow or failed
    # refresh would otherwise make this reconcile re-apply the pre-flip value
    # and silently undo the operator's change. The TTL cache catches up on its
    # own, and the next status tick reconciles again.
    effective = _dc_replace(
        _load_config().storage,
        **{attrs[field]: value for field, value in written.items()},
    )
    reconciled = market_watch_engine.reconcile_storage_switches(effective)
    if market_watch_doc_buffer.is_enabled():
        try:
            # apply_config=False: the authoritative gates were just applied
            # above, so the loop must not re-resolve and undo them.
            await market_watch_doc_buffer.start(apply_config=False)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("[MARKET_WATCH] tick-saving could not start the writer: %s", exc)

    return {
        "ok": True,
        "applied": written,
        "changed": reconciled["changed"],
        "droppedOnDisable": reconciled["dropped"],
        **market_watch_engine.tick_saving(),
    }


# --------------------------------------------------------------------------- #
# Saved filters (persisted in Mongo ``market_watch_filters``)
# --------------------------------------------------------------------------- #
@router.get("/filters")
async def market_watch_filters_list(limit: int = Query(50, ge=1, le=200)):
    """Saved custom filters, newest first (validated on save)."""
    rows: list[dict] = []
    try:
        db = get_db()
        cursor = db.market_watch_filters.find({}).sort("createdAt", -1).limit(limit)
        rows = await cursor.to_list(length=limit)
    except Exception:
        rows = []
    out = []
    for r in rows:
        r["filterId"] = str(r.pop("_id", ""))
        r["createdAt"] = _as_utc_iso(r.get("createdAt"))
        r.pop("criteria", None)
        out.append({k: r[k] for k in ("filterId", "name", "description", "limit", "createdAt") if k in r})
    return {"ok": True, "count": len(out), "filters": out}


@router.post("/filters")
async def market_watch_filters_save(payload: dict | None = None):
    """Save a custom filter: {name, description?, criteria, limit?}."""
    raw = payload or {}
    ok, reason, doc = validate_filter_document(raw)
    if not ok:
        return {"ok": False, "reason": reason}
    try:
        db = get_db()
        record = {
            "name": doc["name"],
            "description": doc["description"],
            "criteria": doc["criteria"],
            "limit": doc["limit"],
            "createdAt": datetime.now(timezone.utc),
        }
        result = await db.market_watch_filters.insert_one(record)
        return {"ok": True, "filterId": str(result.inserted_id), "filter": {
            "filterId": str(result.inserted_id),
            "name": doc["name"],
            "description": doc["description"],
            "limit": doc["limit"],
            "criteria": doc["criteria"],
        }}
    except Exception as exc:
        logger.debug("filter save failed: %s", exc)
        return {"ok": False, "reason": "persist_failed"}


@router.get("/filters/{filter_id}")
async def market_watch_filters_detail(filter_id: str):
    """One saved filter with its full criteria list."""
    try:
        oid = ObjectId(filter_id)
    except Exception:
        return {"ok": False, "reason": "invalid_filter_id"}
    try:
        db = get_db()
        doc = await db.market_watch_filters.find_one({"_id": oid})
    except Exception:
        return {"ok": False, "reason": "persist_failed"}
    if not doc:
        return {"ok": False, "reason": "not_found"}
    doc["filterId"] = str(doc.pop("_id", ""))
    doc["createdAt"] = _as_utc_iso(doc.get("createdAt"))
    return {"ok": True, "filter": doc}


@router.post("/filters/apply")
async def market_watch_filters_apply(payload: dict | None = None):
    """Apply a saved filter (``filterId``) or inline criteria to the live merged
    universe and return a ranked page. Never fabricates a lying value: rows whose
    fields are absent fail the criterion naturally."""
    raw = payload or {}
    criteria = raw.get("criteria")
    filter_id = str(raw.get("filterId") or "").strip()
    if filter_id:
        try:
            oid = ObjectId(filter_id)
        except Exception:
            return {"ok": False, "reason": "invalid_filter_id"}
        try:
            db = get_db()
            doc = await db.market_watch_filters.find_one({"_id": oid})
        except Exception:
            doc = None
        if not doc:
            return {"ok": False, "reason": "filter_not_found"}
        criteria = doc.get("criteria") or []
        limit = min(int(doc.get("limit") or 100), 1000)
        sort_by = str(raw.get("sortBy") or doc.get("sortBy") or "changePercent")
        sort_dir = str(raw.get("sortDir") or doc.get("sortDir") or "desc")
    else:
        limit = min(int(raw.get("limit") or 100), 1000)
        sort_by = str(raw.get("sortBy") or "changePercent")
        sort_dir = str(raw.get("sortDir") or "desc")

    ok, reason, _norm = validate_criteria(criteria)
    if not ok:
        return {"ok": False, "reason": reason}

    rows = market_watch_engine.full_universe_rows()
    rows = apply_filters(rows, criteria)
    rows = _rank_rows(rows, sort_by, sort_dir)

    offset = max(0, int(raw.get("offset") or 0))
    page = rows[offset: offset + limit]
    return {
        "ok": True,
        "tradingDate": market_watch_engine.ranking_snapshot().get("tradingDate"),
        "generatedAt": market_watch_engine.generated_at(),
        "criteria": criteria,
        "sortBy": sort_by,
        "sortDir": sort_dir,
        "offset": offset,
        "limit": limit,
        "count": len(page),
        "total": len(rows),
        "hasMore": (offset + limit) < len(rows),
        "items": page,
    }


@router.delete("/filters/{filter_id}")
async def market_watch_filters_delete(filter_id: str):
    """Delete one saved filter."""
    try:
        oid = ObjectId(filter_id)
    except Exception:
        return {"ok": False, "reason": "invalid_filter_id"}
    try:
        db = get_db()
        result = await db.market_watch_filters.delete_one({"_id": oid})
        return {"ok": True, "removed": result.deleted_count}
    except Exception:
        return {"ok": False, "reason": "persist_failed"}


# --------------------------------------------------------------------------- #
# Full-universe ranked table (docs §17/§18) — virtualization-friendly
# --------------------------------------------------------------------------- #
def _rank_key(row: dict, sort_by: str) -> Any:
    if sort_by == "volume":
        return row.get("volume")
    if sort_by == "turnover":
        return row.get("tradedValue")
    if sort_by == "ltp":
        return row.get("ltp")
    if sort_by == "fiveMinPercent":
        return row.get("fiveMinPercent")
    if sort_by == "tenMinPercent":
        return row.get("tenMinPercent")
    if sort_by == "spread":
        return row.get("spread")
    if sort_by == "oi":
        return row.get("oi")
    if sort_by == "symbol":
        return (row.get("symbol") or "").upper()
    # doc §19/§21/§23 — the frontend may sort by any backend-owned field, so
    # the sort keys below are read, never recomputed.
    for key in (
        "change_1m_pct", "change_5m_pct", "change_10m_pct", "change_30m_pct",
        "circuitDistancePct", "circuitDistanceUpperPct", "circuitDistanceLowerPct",
        "marginMultiplier", "marginValue", "tickCount", "lastTickAt",
        "classification", "stockState", "circuitStatus", "marginStatus",
    ):
        if sort_by == key:
            value = row.get(key)
            # Never sort on a missing value as if it were zero.
            return None if value is None else value
    return row.get("changePercent")


def _rank_rows(rows: list[dict], sort_by: str, sort_dir: str) -> list[dict]:
    reverse = (sort_dir or "desc") == "desc"

    def value(r: dict):
        return _rank_key(r, sort_by)

    if sort_by == "symbol":
        rows.sort(key=lambda r: (str(r.get("symbol") or "").upper(), r.get("token") or ""), reverse=reverse)
        return rows

    # Two stable passes so a missing sort value sorts LAST in BOTH directions:
    # 1) present-value rows first, missing-value rows last (never reversed);
    # 2) value ordering with the requested direction — a direction-aware
    #    sentinel keeps the missing rows at the very end after reversing
    #    (-inf sorts last on desc, +inf sorts last on asc).
    sentinel = float("-inf") if reverse else float("inf")
    rows.sort(key=lambda r: value(r) is None)
    rows.sort(key=lambda r: (value(r) if value(r) is not None else sentinel), reverse=reverse)
    return rows


@router.get("/rank")
async def market_watch_rank(
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    sort_by: str = Query("changePercent", alias="sortBy"),
    sort_dir: str = Query("desc", alias="sortDir"),
):
    """Full-universe ranked, paginated rows (merged live + PENDING placeholders).

    Sort keys: changePercent, volume, turnover, ltp, fiveMinPercent,
    tenMinPercent, spread, oi, symbol. Rows with a missing sort value sort last.
    """
    rows = market_watch_engine.full_universe_rows()
    total = len(rows)
    rows = _rank_rows(rows, sort_by, sort_dir)
    page = rows[offset: offset + limit]
    return {
        "ok": True,
        "tradingDate": market_watch_engine.ranking_snapshot().get("tradingDate"),
        "generatedAt": market_watch_engine.generated_at(),
        "indexVersion": market_watch_engine._index_version,
        "feedState": market_watch_engine.feed_state(),
        "offset": offset,
        "limit": limit,
        "count": len(page),
        "total": total,
        "hasMore": (offset + limit) < total,
        "sortBy": sort_by,
        "sortDir": sort_dir,
        "items": page,
    }


# --------------------------------------------------------------------------- #
# Symbol detail (docs §17) — engine live record + merged tick + real depth
# --------------------------------------------------------------------------- #
#: NSE equity series suffixes stripped when resolving a symbol string to a
#: token. The engine registry / instrument cache may carry the bare symbol
#: (e.g. ``KOTAKBANK``) while callers use the series-qualified form
#: (``KOTAKBANK-EQ``); without normalisation those lookups miss and
#: ``/symbol/{id}`` + ``POST /pins`` report ``unknown_symbol`` for live stocks.
_SERIES_SUFFIXES: tuple[str, ...] = ("-EQ", "-BE")


def _candidate_symbols(q: str) -> list[str]:
    """The query plus series-normalised variants, deduped, in try order."""
    out = [q]
    upper = q.upper()
    for suffix in _SERIES_SUFFIXES:
        if upper.endswith(suffix):
            base = q[: -len(suffix)]
            if base and base not in out:
                out.append(base)
    return out


def _resolve_token(symbol_or_token: str) -> str | None:
    q = str(symbol_or_token or "").strip()
    if not q:
        return None
    if q.isdigit():
        if _lookup_instrument(q) is not None or market_watch_engine.stock_detail(q):
            return q
    candidates = _candidate_symbols(q)
    for cand in candidates:
        hit = instrument_cache.lookup_by_symbol(cand)
        if hit is not None:
            token = str(hit.get("token") or "")
            if token:
                return token
    # Compare with any known series suffix stripped on both sides so bare <->
    # suffixed match in either direction (registry may carry either form).
    def _norm(sym: object) -> str:
        s = str(sym or "").upper()
        for suffix in _SERIES_SUFFIXES:
            if s.endswith(suffix):
                return s[: -len(suffix)]
        return s

    registry = market_watch_engine.registry()
    for cand in candidates:
        wanted = _norm(cand)
        if not wanted:
            continue
        for row in registry:
            if _norm(row.get("symbol", "")) == wanted:
                return str(row.get("token") or "")
    return None


async def _depth_snapshot(token: str, inst: dict) -> dict:
    """Real order-book ladder: merged WS depth first, REST quote fallback."""
    latest = tick_buffer._latest_ticks.get(str(token))
    buy = sell = None
    if latest:
        raw_buy = latest.get("buy")
        raw_sell = latest.get("sell")
        if isinstance(raw_buy, list):
            buy = raw_buy
        if isinstance(raw_sell, list):
            sell = raw_sell
    source = "ws"
    if (not buy or not sell) and kotak_session.session_active:
        try:
            raw = await kotak_session.async_quote(
                [{"exchange_segment": str(inst.get("exchangeSegment") or "nse_cm"),
                  "instrument_token": token}],
                quote_type="all",
            )
            data = (raw or {}).get("data")
            if isinstance(data, list) and data:
                depth = data[0].get("depth") if isinstance(data[0].get("depth"), dict) else {}
                if isinstance(depth.get("buy"), list) and isinstance(depth.get("sell"), list):
                    buy = depth.get("buy")
                    sell = depth.get("sell")
                    source = "broker_quote"
        except Exception:
            pass
    rows = lambda levels: [
        {
            "price": _fnum(lv.get("price")),
            "quantity": _fnum(lv.get("quantity") or lv.get("qty")),
            "orders": int(lv["orders"]) if lv.get("orders") is not None else None,
        }
        for lv in (levels or [] if levels else [])
        if isinstance(lv, dict)
    ]
    return {
        "source": source,
        "buy": rows(buy),
        "sell": rows(sell),
        "available": bool(buy or sell),
    }


@router.get("/symbol/{symbol_or_token}")
async def market_watch_symbol(symbol_or_token: str):
    """Combined market-watch detail for one symbol: engine live record + merged
    tick + real depth ladder + registry meta + circuit/eligibility fields."""
    token = _resolve_token(symbol_or_token)
    if token is None:
        return {"ok": False, "reason": "unknown_symbol", "symbol": symbol_or_token}
    inst = _lookup_instrument(token)
    engine_row = market_watch_engine.stock_detail(token) or {}
    tick = _tick_snapshot(token)
    depth = await _depth_snapshot(token, inst) if inst else {"source": "none", "buy": [], "sell": [], "available": False}
    registry_row: dict = {}
    for row in market_watch_engine.registry():
        if str(row.get("token") or "") == token:
            registry_row = row
            break

    merged = {
        "token": token,
        **registry_row,
        **({k: v for k, v in engine_row.items() if k not in registry_row}),
    }
    price_source = "live" if merged.get("status") == "LIVE" else (
        "stale" if merged.get("status") == "STALE" else (
            "no_data" if merged.get("status") == "NO_DATA" else "pending"
        )
    )
    return {
        "ok": True,
        "symbol": symbol_or_token,
        "token": token,
        "tradingDate": market_watch_engine.ranking_snapshot().get("tradingDate"),
        "generatedAt": market_watch_engine.generated_at(),
        "feedState": market_watch_engine.feed_state(),
        "state": {
            "status": merged.get("status") or "PENDING",
            "dataAgeSec": merged.get("dataAgeSec"),
            "intradayEligible": bool(merged.get("intradayEligible")),
            "priceSource": price_source,
        },
        "quote": tick or {"available": False, "reason": "no_ws_tick"},
        "depth": depth,
        "record": merged,
        "circuit": {
            "upperCircuit": merged.get("upperCircuit"),
            "lowerCircuit": merged.get("lowerCircuit"),
            "circuitAvailable": merged.get("upperCircuit") is not None and merged.get("lowerCircuit") is not None,
        },
        "manualPinned": await is_pinned(token),
    }


@router.get("/page")
async def market_watch_page(
    section: str = Query("top_gainers"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
):
    """Cursored pagination over a dynamic section (docs §17-§18)."""
    return market_watch_engine.paginate(section, offset=offset, limit=limit)


@router.get("/ui")
async def market_watch_ui_payload():
    """Controlled UI publish payload (docs §16): per-section indexVersion /
    pinned / items — NOT the raw tick stream."""
    return market_watch_engine.ui_payload()


@router.get("/registry")
async def market_watch_registry():
    """Symbol / name / token mapping for the eligible universe (docs §4, §27)."""
    engine = market_watch_engine
    return {
        "ok": True,
        "tradingDate": engine.ranking_snapshot().get("tradingDate"),
        "universeSize": engine.universe_size(),
        "subscribedTokenCount": engine.subscribed_token_count(),
        "eligibleCount": sum(1 for r in engine.registry() if r.get("intradayEligible")),
        "feedState": engine.feed_state(),
        "items": engine.registry(),
    }


@router.get("/scan")
async def market_watch_full_scan(
    refresh: bool = Query(False, description="Force a fresh compute pass"),
    limit: int = Query(0, ge=0, le=10000),
):
    """Full NSE EQ market scan (Data Saver Watch) — the entire scrip master's
    EQ universe read from the ONE live tick store.

    Rows are real in-memory WS-tick state (ltp/prev-close/net change from the
    broker feed fields, plus true 1m/5m/10m window moves from the central
    price history). Nothing is broker-looped, nothing fetched off-box, and an
    instrument without feed data keeps every price field ``None`` — the UI
    renders an em dash, never an invented 0. ``?refresh=1`` recomputes
    immediately; otherwise the cached pass (recomputed when >8s old) returns.
    """
    from services.market_scan import market_scan

    doc = await market_scan.document_fresh(force=refresh, timeout=6.0)
    if doc is None:
        # Race on a truly cold boot: compute once inline rather than inventing.
        doc = await asyncio.to_thread(market_scan.compute)
    data = dict(doc)
    if limit:
        data["rows"] = (doc.get("rows") or [])[:limit]
    return {"ok": True, "data": data}


@router.get("/status")
async def market_watch_status():
    """Market Watch engine observability snapshot (docs §25)."""
    return {
        "ok": True,
        "engine": market_watch_engine.status_snapshot(),
        "feedState": market_watch_engine.feed_state(),
        "statusCounts": market_watch_engine.status_counts(),
        "config": market_watch_engine.config(),
    }


@router.get("/ranking")
async def market_watch_ranking_snapshot():
    """Latest 30-second ranking snapshot and its automatic pins."""
    snap = market_watch_ranking.snapshot()
    pins = market_watch_ranking.pins()
    return {
        "ok": True,
        "tradingDate": snap.get("tradingDate"),
        "lastSnapshotAt": snap.get("lastSnapshotAt"),
        "snapshotCount": snap.get("snapshotCount"),
        "latest": snap.get("latest"),
        "pins": pins,
    }


@router.get("/pins")
async def market_watch_pins():
    """Automatic Gainer/Loser pins (max 5 each) + manual user pins (day-scoped)."""
    pins = market_watch_ranking.pins()
    manual = await list_pins()
    return {
        "ok": True,
        "tradingDate": pins.get("tradingDate"),
        "gainers": pins.get("gainers", []),
        "losers": pins.get("losers", []),
        "manual": manual,
        "manualCount": len(manual),
        "maxManualPins": 20,
    }


@router.post("/pins")
async def market_watch_pins_add(payload: dict | None = None):
    """Pin a symbol manually (day-scoped). Resolves symbol/token to registry meta."""
    raw = payload or {}
    symbol_or_token = str(raw.get("symbol") or raw.get("token") or "").strip()
    if not symbol_or_token:
        return {"ok": False, "reason": "missing_symbol"}
    token = _resolve_token(symbol_or_token)
    if token is None:
        return {"ok": False, "reason": "unknown_symbol", "symbol": symbol_or_token}
    meta: dict = {}
    for row in market_watch_engine.registry():
        if str(row.get("token") or "") == token:
            meta = row
            break
    result = await add_pin(
        token,
        symbol=str(meta.get("symbol") or symbol_or_token.upper()),
        name=str(meta.get("name") or ""),
        exchange=str(meta.get("exchange") or "nse_cm"),
        segment=str(meta.get("segment") or "EQUITY"),
    )
    if result.get("ok"):
        return {"ok": True, "pin": result.get("pin"), "alreadyPinned": bool(result.get("alreadyPinned"))}
    return {"ok": False, "reason": result.get("reason")}


@router.delete("/pins/{symbol_or_token}")
async def market_watch_pins_remove(symbol_or_token: str):
    """Remove a manual pin for the current trading day."""
    result = await remove_pin(symbol_or_token)
    if result.get("ok"):
        return {"ok": True, "removed": result.get("removed", 0)}
    return {"ok": False, "reason": result.get("reason")}


@router.delete("/pins")
async def market_watch_pins_clear():
    """Clear all manual pins for the current trading day."""
    result = await clear_pins()
    return {"ok": True, "removed": result.get("removed", 0)}


@router.get("/ranking/status")
async def market_watch_ranking_status():
    return {"ok": True, **market_watch_ranking.status()}


# --------------------------------------------------------------------------- #
# Weekly locked universe (docs/engines/MARKET_WATCH.md §2, §4, §5, §6, §7,
# §16, §30, §32, §33)
#
# Saturday: REVIEW -> REPORT -> ADD / REMOVE / KEEP -> LOCK.
# Monday-Friday: the engine monitors exactly the locked list. These endpoints are
# the ONLY way membership changes; nothing here runs per tick.
# --------------------------------------------------------------------------- #
@router.get("/weekly")
async def market_watch_weekly(week_id: str | None = Query(None, alias="weekId")):
    """Full weekly state: current lock, draft, decisions, history, config.

    Two different weeks matter and they are NOT the same (doc §2):

    * ``weekId``        — the week whose Mon-Fri data the review READS and whose
      report is built. That is the week that just finished.
    * ``targetWeekId``  — the week whose MEMBERSHIP the operator decides with
      ADD/REMOVE/KEEP and then LOCKs. That is the week about to start.

    Previously both defaulted to the current ISO week, which during and after a
    trading week is already LOCKED — so every decision and every lock was
    rejected with ``WEEK_LOCKED`` and the review flow could never be completed.
    """
    mw_universe.invalidate_cache()
    universe = await mw_universe.load_locked_universe(refresh=True)
    target = week_id or mw_universe.review_target_week_id()
    # The draft, lock check, decisions, history and verification are five
    # independent reads. Running them sequentially made a cold Weekly page pay
    # five Atlas round trips AFTER the universe read. The verification reuses
    # the universe already loaded above instead of re-reading the same lock.
    draft, target_locked, decisions, history, verify = await asyncio.gather(
        mw_universe.get_draft(target),
        mw_universe.is_locked(target),
        mw_universe.decisions_for(target),
        mw_universe.history(limit=26),
        mw_universe.verify_week(target, universe),
    )
    report_week = mw_universe.week_id_for()
    return {
        "ok": True,
        "weekId": target,
        "targetWeekId": target,
        "targetWeekLocked": bool(target_locked),
        "reportWeekId": report_week,
        "nextReviewAt": mw_universe.next_review_at(),
        "locked": universe.summary() if universe else None,
        "draft": draft.summary() if draft else None,
        "draftSymbols": list(draft.symbols) if draft else [],
        "decisions": decisions,
        "history": history,
        "verify": verify,
        "config": mw_config.as_dict(mw_config.load()).get("weekly", {}),
        # Friday 15:25 automatic scan: resolved schedule + last real outcome.
        # The UI never computes "next Friday" itself.
        "fridayScan": market_watch_engine.friday_scan_status(),
        "engine": {
            "weekId": universe.week_id if universe else None,
            "version": universe.version if universe else None,
            "symbolCount": len(universe) if universe else 0,
            "universeVerify": market_watch_engine.universe_verify(),
        },
    }


@router.get("/weekly/universe")
async def market_watch_weekly_universe():
    """The active subscription universe proof (doc §7, §30).

    Returns the locked list, what the engine resolved from it, and what could
    not be resolved — never a silently widened set.
    """
    universe = await mw_universe.load_locked_universe(refresh=True)
    boards = market_watch_engine.official_rankings()
    return {
        "ok": True,
        "locked": universe.summary() if universe else None,
        "symbols": list(universe.symbols) if universe else [],
        "engineUniverseSize": len(market_watch_engine.full_universe_rows()) if universe else 0,
        "subscribedTokenCount": market_watch_engine.subscribed_token_count(),
        "universeVerify": market_watch_engine.universe_verify(),
        "boardCounts": {name: len(rows) for name, rows in boards.items()},
    }


@router.post("/weekly/scan")
async def market_watch_weekly_scan(body: Any = Body(default=None)):
    """Build (and persist) the advisory weekly report from Mon-Fri saved data.

    doc §5: "The report is advisory. The user remains the final authority." This
    never changes membership — that is the LOCK call below.
    """
    payload = body if isinstance(body, dict) else {}
    week_id = str(payload.get("weekId") or mw_universe.week_id_for())
    symbols = payload.get("symbols")
    report = await mw_weekly.build_weekly_report(week_id, symbols=symbols)
    persisted = await asyncio.to_thread(mw_weekly.persist, report)
    return {
        "ok": True,
        "weekId": week_id,
        "persisted": persisted,
        "counts": report.get("counts", {}),
        "threshold": report.get("threshold"),
        "rows": report.get("rows", []),
    }


@router.get("/weekly/report")
async def market_watch_weekly_report(week_id: str | None = Query(None, alias="weekId")):
    """Fetch a stored weekly report; ``build=false`` returns a live preview."""
    target = week_id or mw_universe.week_id_for()
    report = await mw_weekly.load_report(target)
    if report is None:
        return {"ok": True, "weekId": target, "report": None, "reason": "NO_REPORT"}
    return {"ok": True, "weekId": target, "report": report}


@router.get("/weekly/reports")
async def market_watch_weekly_reports(limit: int = Query(12, ge=1, le=52)):
    return {"ok": True, "reports": await mw_weekly.recent_reports(limit)}


@router.post("/weekly/decision")
async def market_watch_weekly_decision(body: Any = Body(...)):
    """Record one operator ADD / REMOVE / KEEP for the DRAFT week.

    A LOCKED week rejects the decision (doc §33 — no mid-week membership change).
    """
    payload = body if isinstance(body, dict) else {}
    # doc §2 step 9: the operator decides membership for the UPCOMING week, not
    # for the locked week that just finished. Defaulting to the current ISO week
    # made every decision answer WEEK_LOCKED.
    week_id = str(payload.get("weekId") or mw_universe.review_target_week_id())
    symbol = str(payload.get("symbol") or "").strip()
    action = str(payload.get("action") or "").strip().upper()
    if not symbol or action not in mw_config.REVIEW_ACTIONS:
        return {"ok": False, "reason": "INVALID_REQUEST", "actions": list(mw_config.REVIEW_ACTIONS)}
    try:
        doc = await mw_universe.record_decision(
            week_id, symbol, action,
            locked_by=payload.get("lockedBy") or payload.get("by"),
            note=payload.get("note"),
        )
    except PermissionError as exc:
        return {"ok": False, "reason": "WEEK_LOCKED", "detail": str(exc)}
    except ValueError as exc:
        return {"ok": False, "reason": "INVALID_REQUEST", "detail": str(exc)}
    draft = await mw_universe.get_draft(week_id)
    return {
        "ok": True,
        "weekId": week_id,
        "decision": doc,
        "draft": draft.summary() if draft else None,
    }


@router.post("/weekly/lock")
async def market_watch_weekly_lock(body: Any = Body(default=None)):
    """Freeze the week: assign a version, record added/removed/kept, lock.

    doc §32: after LOCK the engine's subscription set equals exactly this list
    and membership cannot change until the next Saturday review.
    """
    payload = body if isinstance(body, dict) else {}
    # doc §2 step 10 / §32: the lock freezes the UPCOMING week's membership.
    week_id = str(payload.get("weekId") or mw_universe.review_target_week_id())
    symbols = payload.get("symbols")
    try:
        result = await mw_universe.lock_universe(
            week_id,
            symbols=symbols,
            locked_by=payload.get("lockedBy") or payload.get("by"),
            notes=payload.get("notes"),
        )
    except PermissionError as exc:
        detail = str(exc)
        reason = "LOCK_DISABLED" if "disabled" in detail else "WEEK_LOCKED"
        return {"ok": False, "reason": reason, "detail": detail}
    # doc §28: reload + verify, then rebuild so the live engine immediately
    # monitors exactly the locked list.
    verdict = await market_watch_engine.load_locked_universe(refresh=True)
    result.pop("universe", None)
    return {"ok": True, **result, "verify": verdict}


@router.post("/weekly/draft")
async def market_watch_weekly_draft(body: Any = Body(default=None)):
    """Seed (or re-seed) the DRAFT for the UPCOMING week from the previous LOCK."""
    payload = body if isinstance(body, dict) else {}
    week_id = str(payload.get("weekId") or mw_universe.review_target_week_id())
    if await mw_universe.is_locked(week_id):
        return {"ok": False, "reason": "WEEK_LOCKED"}
    draft = await mw_universe.seed_draft_from_locked(week_id)
    if draft is None:
        return {"ok": False, "reason": "WEEK_LOCKED"}
    return {"ok": True, "weekId": week_id, "draft": draft.summary()}


@router.get("/weekly/history")
async def market_watch_weekly_history(limit: int = Query(52, ge=1, le=200)):
    return {"ok": True, "history": await mw_universe.history(limit)}


@router.get("/observability")
async def market_watch_observability():
    """doc §30 — the tracking metrics, at the top level, with the spec names."""
    custom = (market_watch_engine.status_snapshot().get("metrics") or {}).get("custom") or {}
    keys = (
        "locked_universe_count", "active_subscription_count", "received_tick_count",
        "validated_tick_count", "invalid_tick_count", "invalid_tick_reasons",
        "out_of_universe_tick_count",
        "danger_count", "intraday_unavailable_count", "top_gainers_count",
        "top_losers_count", "movers_1m_count", "movers_5m_count",
        "movers_10m_count", "movers_30m_count", "last_tick_at",
        "processing_latency_ms", "publish_latency_ms", "websocket_status",
        "stockStates", "classificationCounts", "weekly", "weeklyReview", "feedState",
    )
    return {
        "ok": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "metrics": {key: custom.get(key) for key in keys},
        "thresholds": {
            "dangerCircuitPct": mw_config.load().weekly.danger_circuit_pct,
            "moverThresholdPct": mw_config.load().weekly.mover_threshold_pct,
            "normalThresholdPct": mw_config.load().weekly.normal_threshold_pct,
            "rupeeThreshold": mw_config.load().weekly.rupee_threshold,
            "marginMultiplierThreshold": mw_config.load().weekly.margin_multiplier_threshold,
        },
    }


@router.get("/report/daily/{date}")
async def market_watch_daily_report(date: str):
    """Read the persisted EOD report — it was previously write-only.

    The read is delegated to ``services.market_watch_report.load_report`` so the
    REST layer never opens its own Mongo path for a Market Watch collection
    (doc §13: DB Writer owns persistence, and reads of DB-Writer-owned documents
    go through the service that owns the document shape). The previous inline
    ``find_one`` here was never awaited, so Motor returned a coroutine and the
    ``doc.pop`` below it raised outside the ``try`` — every request to this
    endpoint answered 500 even though real reports existed.
    """
    report = await mw_report.load_report(date)
    if report is None:
        return {"ok": True, "date": date, "report": None, "reason": "NO_REPORT"}
    report.pop("_id", None)
    return {"ok": True, "date": date, "report": report}


@router.get("/report/daily")
async def market_watch_daily_reports(limit: int = Query(20, ge=1, le=120)):
    """Recent stored EOD reports, newest first (summary projection only).

    Delegates to ``services.market_watch_report.recent``. The previous inline
    version iterated an ``AsyncIOMotorCursor`` synchronously, which Motor does
    not support, so this endpoint always answered ``READ_ERROR`` and the Report
    page could never list a single stored report.
    """
    reports = await mw_report.recent(limit)
    return {"ok": True, "reports": reports, "reason": None if reports else "NO_REPORT"}


@router.get("/boards")
async def market_watch_boards():
    """doc §22 — every backend-owned ranking board, including the 1% movers and
    Circuit Danger boards that were previously unreachable over REST."""
    boards = market_watch_engine.official_rankings()
    limit_default = mw_config.load().universe.ranking_max_entries
    take = min(limit_default, 50)
    return {
        "ok": True,
        "counts": {name: len(rows) for name, rows in boards.items()},
        "moverThresholdPct": mw_config.load().weekly.mover_threshold_pct,
        "dangerCircuitPct": mw_config.load().weekly.danger_circuit_pct,
        "boards": {name: rows[:take] for name, rows in boards.items()},
    }


@router.get("/stock/{symbol_or_token}")
async def market_watch_stock(symbol_or_token: str):
    """doc §23 frontend contract for one symbol — every field backend-owned.

    Accepts a symbol OR a token (``/stock/RELIANCE`` and ``/stock/2885`` are the
    same query). Resolution goes through ``_resolve_token``, which is the
    symbol/token-aware resolver used by ``/symbol/{symbol_or_token}``; the record
    comes from ``record_for``, which prefers the typed ``SymbolState`` and so
    carries the full §23 field set (classification, circuit status, margin, the
    flat ``change_{tf}`` block) instead of the thinner legacy flat row.
    """
    token = _resolve_token(symbol_or_token)
    if not token:
        return {"ok": False, "reason": "UNKNOWN_INSTRUMENT", "symbol": symbol_or_token}
    record = market_watch_engine.record_for(symbol_or_token)
    if record is None:
        # Resolvable in the instrument master but the engine holds no state for
        # it yet. That is an honest NO_DATA, not an error (doc §21: never
        # fabricate), so report the instrument and an explicit empty record.
        record = {}
    return {
        "ok": True,
        "record": record,
        "resolvedToken": token,
        "meta": _lookup_instrument(token) or {},
        "hasState": bool(record),
    }


# --------------------------------------------------------------------------- #
# Friday 3:25 PM Market Watch Universe Scan (Manual Trigger)
# --------------------------------------------------------------------------- #
@router.post("/friday-scan")
async def market_watch_friday_scan(payload: dict | None = None):
    """Manually run the Friday Market Watch universe scan on any day.

    The same command executes automatically every Friday at 15:25 IST:

    * screen every NSE EQ instrument for intraday eligibility;
    * keep only LTP below ``mwr_price_max`` (default ₹800);
    * keep only broker-confirmed margin at/above
      ``mwr_margin_multiplier_threshold`` (default 5x);
    * LOCK the survivors as the upcoming week's Market Watch universe;
    * apply the Session Manager daily-universe intent with **no expiry**;
    * reconcile the WebSocket subscription immediately when the engine is inside
      its runtime window (outside it the intent is still recorded for the next
      trading session).

    ``payload.targetWeekId`` may override the lock target; by default the
    upcoming ISO week is locked. Live ticks then flow through the normal
    WebSocket -> Market Watch -> DB Writer pipeline.
    """
    from services.market_watch_engine import market_watch_engine

    try:
        body = payload or {}
        target_week_id = body.get("targetWeekId") or body.get("weekId")
        result = await market_watch_engine.run_friday_scan(
            triggered_by="manual",
            target_week_id=str(target_week_id) if target_week_id else None,
        )
        return result
    except Exception as exc:
        logger.error("[MARKET_WATCH_MANUAL_FRIDAY_SCAN] Manual trigger failed: %s", exc)
        return {"ok": False, "triggered": False, "reason": f"scan_failed: {exc}"}
