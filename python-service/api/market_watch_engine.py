"""Market Watch engine — pure, broker-free logic (REAL data only).

This module owns the trading-data correctness rules so that they are fully
unit-testable without any broker/SDK/DB dependency.

Field names are the ACTUAL NeoAPI / Kotak SFeed field names (confirmed from
the SDK models):
  - WS tick (SFeedScrip):  last_traded_price, open_price, high_price, low_price,
    close_price, net_change, net_change_percent, volume_traded_today,
    total_traded_value, open_interest, upper_circuit_limit, lower_circuit_limit,
    last_update_time, total_buy_quantity, total_sell_quantity
  - REST OHLC fallback:    ohlc.open/high/low/close, upper_circuit/lower_circuit

Unknown != Safe. If upper or lower circuit is null we return status UNKNOWN and
NEVER claim SAFE.
"""

from __future__ import annotations

import math
from typing import Any

# Canonical circuit status vocabulary.
CIRCUIT_SAFE = "SAFE"
CIRCUIT_NEAR_UPPER = "NEAR_UPPER"
CIRCUIT_NEAR_LOWER = "NEAR_LOWER"
CIRCUIT_UPPER_HIT = "UPPER_HIT"
CIRCUIT_LOWER_HIT = "LOWER_HIT"
CIRCUIT_UNKNOWN = "UNKNOWN"

# Canonical intraday reasons.
INTRADAY_SUPPORTED = "INTRADAY_SUPPORTED"
INTRADAY_NOT_SUPPORTED = "INTRADAY_NOT_SUPPORTED"
INSTRUMENT_INACTIVE = "INSTRUMENT_INACTIVE"
TRADING_RESTRICTED = "TRADING_RESTRICTED"
INTRADAY_UNKNOWN = "UNKNOWN"

# Canonical daily-change limit reason (abs(changePercent) > max).
CHANGE_LIMIT_EXCEEDED = "CHANGE_LIMIT_EXCEEDED"

# Canonical trading / instrument states (only AVAILABLE shows "✓ Intraday").
TRADING_AVAILABLE = "AVAILABLE"
TRADING_NOT_AVAILABLE = "NOT_AVAILABLE"
TRADING_SUSPENDED = "SUSPENDED"
TRADING_INACTIVE = "INACTIVE"
TRADING_CLOSED = "CLOSED"
TRADING_RESTRICTED_STATE = "RESTRICTED"
TRADING_UNKNOWN = "UNKNOWN"

# Recognised intraday-capable broker products.
_INTRADAY_PRODUCTS = {"MIS", "INT", "INTRADAY"}

# Explicit + supporting reasons used by eligibility / filters.
REASON_EXCLUDED_REASONS = {
    "INACTIVE", "NOT_NSE_EQ", "INTRADAY_UNAVAILABLE", "NO_QUOTE", "STALE_QUOTE",
    "CIRCUIT_UNKNOWN", "UPPER_CIRCUIT_HIT", "LOWER_CIRCUIT_HIT",
    "NEAR_UPPER_CIRCUIT", "NEAR_LOWER_CIRCUIT", "DAILY_CHANGE_LIMIT",
    "PRICE_LIMIT", "MOMENTUM_LIMIT", "HISTORY_UNAVAILABLE", "TRADING_RESTRICTED",
}
DAILY_CHANGE_LIMIT_REASON = "DAILY_CHANGE_LIMIT"


def _fnum(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _nullable_float(values: dict, *keys: str) -> float | None:
    for k in keys:
        v = values.get(k)
        n = _fnum(v)
        if n is not None:
            return n
    return None


# --------------------------------------------------------------------------- #
# Normalization layer (NeoAPI raw quote -> clean market data)
# --------------------------------------------------------------------------- #
def normalize_quote(raw: dict, instrument: dict | None = None) -> dict:
    """Project a raw broker quote/tick into one clean market-data shape.

    Accepts either a WS tick (snake_case SFeed fields) or a REST quote item
    (nested ``ohlc``), preferring real values and never inventing any.
    """
    raw = raw if isinstance(raw, dict) else {}
    ohlc = raw.get("ohlc") if isinstance(raw.get("ohlc"), dict) else {}

    # LTP: WS last_traded_price / raw ltp+LTP / ohlc.close
    ltp = _nullable_float(raw, "ltp", "LTP", "last_traded_price", "lastPrice", "last_price")
    if ltp is None:
        ltp = _nullable_float(ohlc, "ltp", "close", "Close", "c")

    open_p = _nullable_float(raw, "open", "op", "open_price")
    if open_p is None:
        open_p = _nullable_float(ohlc, "open", "Open", "op")
    high = _nullable_float(raw, "high", "h", "high_price")
    if high is None:
        high = _nullable_float(ohlc, "high", "High", "h")
    low = _nullable_float(raw, "low", "lo", "low_price")
    if low is None:
        low = _nullable_float(ohlc, "low", "Low", "l")
    prev_close = _nullable_float(
        raw, "close", "close_price", "prevClose", "prev_close", "previousClose", "c",
    )
    if prev_close is None:
        prev_close = _nullable_float(ohlc, "close", "Close", "c", "prev_close")

    volume = _nullable_float(raw, "volume", "v", "volume_traded_today")
    turnover = _nullable_float(raw, "total_traded_value", "turnover", "ttv")
    oi = _nullable_float(raw, "oi", "open_interest")
    oi_change = _nullable_float(raw, "oi_change", "oiChange", "chgOI", "change_in_oi")
    if oi_change is None:
        oi_change = _nullable_float(ohlc, "oi_change", "oiChange", "chgOI")

    change = _nullable_float(raw, "change", "net_change", "chg")
    change_pct = _nullable_float(raw, "changePercent", "per_change", "net_change_percent", "changePct")
    if change is None and ltp is not None and prev_close is not None:
        change = ltp - prev_close
    if change_pct is None and change is not None and prev_close not in (None, 0):
        change_pct = (change / prev_close) * 100.0

    depth = raw.get("depth") if isinstance(raw.get("depth"), dict) else {}
    bids = depth.get("buy") if isinstance(depth.get("buy"), list) else []
    asks = depth.get("sell") if isinstance(depth.get("sell"), list) else []
    bid = bid_qty = ask = ask_qty = None
    if bids:
        bid = _nullable_float(bids[0], "price")
        bid_qty = _nullable_float(bids[0], "quantity")
    if asks:
        ask = _nullable_float(asks[0], "price")
        ask_qty = _nullable_float(asks[0], "quantity")
    # WS touch line fallback (bp/sp/bq available on the raw tick).
    if bid is None:
        bid = _nullable_float(raw, "bp")
    if ask is None:
        ask = _nullable_float(raw, "sp")
    if bid_qty is None:
        bid_qty = _nullable_float(raw, "bq")
    if ask_qty is None:
        ask_qty = _nullable_float(raw, "sq", "tsq")

    # Circuit limits: REAL broker/exchange fields only.
    upper_circuit = _nullable_float(raw, "upper_circuit_limit", "upper_circuit", "upperCircuit", "uc")
    lower_circuit = _nullable_float(raw, "lower_circuit_limit", "lower_circuit", "lowerCircuit", "lc")
    if upper_circuit is None:
        upper_circuit = _nullable_float(ohlc, "upper_circuit", "upperCircuit", "upper_circuit_limit", "uc")
    if lower_circuit is None:
        lower_circuit = _nullable_float(ohlc, "lower_circuit", "lowerCircuit", "lower_circuit_limit", "lc")

    # Official circuit percentage (valid only when the broker actually provides
    # it). NEVER invented from LTP / high / low / a generic 20% assumption.
    circuit_percent = _nullable_float(raw, "circuit_percent", "circuitPercent", "upper_circuit_percent")
    if circuit_percent is None:
        circuit_percent = _nullable_float(ohlc, "circuit_percent", "circuitPercent")

    quote_ts = raw.get("quoteTs") or raw.get("ts") or raw.get("timestamp") or raw.get("ltp_time") \
        or raw.get("last_update_time")
    tick_ts = raw.get("lastTickAt") or raw.get("receivedAt")

    inst = instrument if isinstance(instrument, dict) else {}

    return {
        "symbol": str(
            inst.get("symbol")
            or raw.get("symbol") or raw.get("sym") or raw.get("tradingSymbol") or ""
        ),
        "tradingSymbol": str(
            inst.get("tradingSymbol") or raw.get("tradingSymbol") or raw.get("trdSym")
            or raw.get("symbol") or ""
        ),
        "companyName": inst.get("companyName"),
        "token": str(inst.get("token") or raw.get("token") or raw.get("instrumentToken") or ""),
        "exchange": str(inst.get("exchange") or raw.get("exchange") or "nse_cm"),
        "segment": str(inst.get("segment") or inst.get("exchangeSegment") or raw.get("exchangeSegment") or ""),
        "isin": inst.get("isin"),
        "series": inst.get("series"),
        "instrumentType": inst.get("instrumentType"),
        "ltp": ltp,
        "previousClose": prev_close,
        "open": open_p,
        "high": high,
        "low": low,
        "change": change,
        "changePercent": change_pct,
        "bid": bid,
        "bidQty": bid_qty,
        "ask": ask,
        "askQty": ask_qty,
        "volume": volume,
        "turnover": turnover,
        "oi": oi,
        "oiChange": oi_change,
        "upperCircuit": upper_circuit,
        "lowerCircuit": lower_circuit,
        "circuitPercent": circuit_percent,
        "quoteTs": quote_ts,
        "tickTs": tick_ts,
        "source": raw.get("source") or "quote",
        "misAvailable": raw.get("misAvailable") if raw.get("misAvailable") is not None
        else raw.get("mis_available"),
    }


# --------------------------------------------------------------------------- #
# Intraday eligibility (broker/product-based, never segment-only)
# --------------------------------------------------------------------------- #
def evaluate_intraday_eligibility(
    instrument: dict | None,
    quote: dict | None,
    session_products: list[str] | None = None,
    *,
    instrument_active: bool | None = None,
    account_intraday: bool | None = None,
) -> dict:
    """Broker-confirmed intraday eligibility.

    Uses REAL broker/account data only — never infers intraday capability from
    ``segment == NSE_EQ`` alone.

    Decision chain (all inputs are real observed data):
      1. Inactive instrument                 -> INACTIVE (excluded)
      2. Quote explicitly MIS-unavailable    -> INTRADAY_NOT_SUPPORTED (excluded)
      3. No account/product MIS signal       -> UNKNOWN (excluded; honest)
      4. Session products confirm MIS        -> INTRADAY_SUPPORTED (eligible)
      5. Account margin confirms MIS (limits
         ``MisPrsnt`` fields on a validated
         trade session)                      -> INTRADAY_SUPPORTED (eligible)
      6. Quote explicitly MIS-available      -> INTRADAY_SUPPORTED (eligible)

    The per-quote ``misAvailable`` flag is NOT present in the Kotak quote
    payloads this backend consumes, and the validate envelope carries no
    product list either. The real sources are the broker session's product
    list (when provided) and the account's confirm end margin fields
    (``*MisPrsnt*``) returned by the limits API. When NEITHER is observed we
    report UNKNOWN and exclude — we never claim intraday capability from an
    unverified signal.
    """
    inst = instrument if isinstance(instrument, dict) else {}
    quote = quote if isinstance(quote, dict) else {}
    products = [str(p).upper() for p in (session_products or [])]

    active = instrument_active
    if active is None:
        active = _instrument_is_active(inst)

    quote_mis = quote.get("misAvailable")

    if active is False:
        return {
            "eligible": False,
            "product": None,
            "reason": INSTRUMENT_INACTIVE,
            "instrumentStatus": "INACTIVE",
        }

    has_intraday_product = any(p in _INTRADAY_PRODUCTS for p in products)

    # The quote explicitly forbids MIS — never eligible, whatever else says.
    if quote_mis is False:
        return {
            "eligible": False,
            "product": "MIS",
            "reason": INTRADAY_NOT_SUPPORTED,
            "instrumentStatus": _active_label(active),
            "basis": "quote",
        }

    basis = "quote" if quote_mis is True else None
    confirmed = has_intraday_product or account_intraday is True

    if not confirmed:
        # Unknown/unconfirmed: no product list, no margin confirmation. A bare
        # per-scrip quote flag is insufficient on its own (the Kotak payloads
        # on this backend never carry it). Exclude honestly.
        return {
            "eligible": False,
            "product": None,
            "reason": INTRADAY_NOT_SUPPORTED if products else INTRADAY_UNKNOWN,
            "instrumentStatus": _active_label(active),
            "basis": basis or ("product" if products else "unknown"),
        }

    return {
        "eligible": True,
        "product": "MIS",
        "reason": INTRADAY_SUPPORTED,
        "instrumentStatus": _active_label(active),
        "basis": basis or ("product" if has_intraday_product else "account"),
    }


def _instrument_is_active(inst: dict) -> bool:
    status = str(inst.get("tradingStatus") or inst.get("instrumentStatus") or "").strip().upper()
    if not status:
        return True  # unknown status is not treated as inactive
    if "INACTIVE" in status or status in {"SUSPENDED", "EXPIRED", "NOT_TRADING", "HALTED"}:
        return False
    return "ACTIVE" in status or status in {"NORMAL", "TRADING"}


def _active_label(active: bool) -> str:
    return "ACTIVE" if active else "INACTIVE"


# --------------------------------------------------------------------------- #
# Trading eligibility (broker/instrument-master driven, honest states)
# --------------------------------------------------------------------------- #
def evaluate_trading_eligibility(
    instrument: dict | None,
    *,
    instrument_active: bool | None = None,
    market_state: str | None = None,
) -> dict:
    """Evaluate trading eligibility from REAL instrument-master fields.

    Returns:
        available:        bool  (True only when the stock may trade intraday)
        tradingStatus:    canonical state (AVAILABLE/NOT_AVAILABLE/SUSPENDED/
                          INACTIVE/CLOSED/RESTRICTED/UNKNOWN)
        instrumentStatus: broker-reported status (as-is, uppercased)
        reason:           machine reason (INACTIVE, TRADING_RESTRICTED, ...)
    """
    inst = instrument if isinstance(instrument, dict) else {}

    def _status_label(raw: str) -> str:
        raw = (raw or "").strip().upper()
        if not raw:
            return TRADING_UNKNOWN
        if "INACTIVE" in raw or raw in {"EXPIRED", "DELISTED"}:
            return TRADING_INACTIVE
        if "SUSPEND" in raw:
            return TRADING_SUSPENDED
        if "HALT" in raw or raw in {"NOT_TRADING"}:
            return TRADING_NOT_AVAILABLE
        if "RESTRICT" in raw or raw == "CLOSED":
            return TRADING_RESTRICTED_STATE
        if "ACTIVE" in raw or raw in {"NORMAL", "TRADING", "LISTED"}:
            return TRADING_AVAILABLE
        return TRADING_UNKNOWN

    raw_status = str(inst.get("tradingStatus") or inst.get("instrumentStatus") or "").upper().strip()
    label = _status_label(raw_status)

    # A clearly closed market overrides a stale "ACTIVE" instrument status so a
    # card never shows "✓ Intraday" while the exchange is closed.
    if (market_state or "").upper() in {"CLOSED", "HOLIDAY"}:
        label = TRADING_CLOSED

    active = instrument_active
    if active is None:
        active = _instrument_is_active(inst)

    if label in (TRADING_AVAILABLE, TRADING_UNKNOWN) and not active:
        label = TRADING_INACTIVE

    available = active and label in (TRADING_AVAILABLE, TRADING_UNKNOWN)

    reason = "ACTIVE"
    if label == TRADING_INACTIVE:
        reason = INSTRUMENT_INACTIVE
    elif label == TRADING_SUSPENDED:
        reason = TRADING_RESTRICTED
    elif label == TRADING_NOT_AVAILABLE:
        reason = "NOT_AVAILABLE"
    elif label == TRADING_RESTRICTED_STATE:
        reason = TRADING_RESTRICTED
    elif label == TRADING_CLOSED:
        reason = "MARKET_CLOSED"
    elif label == TRADING_UNKNOWN:
        reason = "UNKNOWN"

    return {
        "available": available,
        "tradingStatus": label,
        "instrumentStatus": raw_status or None,
        "reason": reason,
    }


def max_change_eligible(change_pct, max_change_pct) -> bool:
    """abs(changePercent) must stay within the configured daily-change limit.

    Up to and including the limit is eligible (abs <= limit). Returns False
    (excluded) only when the magnitude strictly exceeds the limit, or when the
    change is unknown while a limit is configured.
    """
    pct = _fnum(change_pct)
    limit = _fnum(max_change_pct)
    if limit is None:
        return True
    if pct is None:
        return False
    return abs(pct) <= limit


# --------------------------------------------------------------------------- #
# Circuit safety (the heart of the fix)
# --------------------------------------------------------------------------- #
def evaluate_circuit_safety(
    quote: dict,
    instrument: dict | None = None,
    settings: dict | None = None,
) -> dict:
    """Evaluate circuit safety with a strict, honest status.

    settings:
        bufferPct: float  (distance from a circuit limit that counts as "near")
        enabled:   bool   (circuit safety filter ON/OFF)

    Returns a structured object (never a bare boolean):
        status, upperCircuit, lowerCircuit, distanceToUpperPct,
        distanceToLowerPct, isUpperCircuitHit, isLowerCircuitHit,
        isNearUpperCircuit, isNearLowerCircuit, circuitDataAvailable,
        exclusionReason
    """
    quote = quote if isinstance(quote, dict) else {}
    settings = settings if isinstance(settings, dict) else {}

    if not settings.get("enabled", True):
        # Filter OFF: do not exclude, but NEVER report SAFE without data.
        if quote.get("upperCircuit") is None or quote.get("lowerCircuit") is None:
            return _circuit_result(
                status=CIRCUIT_UNKNOWN,
                upper=quote.get("upperCircuit"),
                lower=quote.get("lowerCircuit"),
                data_available=False,
                exclusion_reason=None,
                buffer=settings.get("bufferPct"),
            )
        return _evaluate_with_limits(quote, settings)

    ltp = _fnum(quote.get("ltp"))
    upper = _fnum(quote.get("upperCircuit"))
    lower = _fnum(quote.get("lowerCircuit"))

    if ltp is None:
        return _circuit_result(
            status=CIRCUIT_UNKNOWN, upper=upper, lower=lower,
            data_available=(upper is not None and lower is not None),
            exclusion_reason="NO_LIVE_PRICE", buffer=settings.get("bufferPct"),
        )

    if upper is None or lower is None:
        return _circuit_result(
            status=CIRCUIT_UNKNOWN, upper=upper, lower=lower,
            data_available=False, exclusion_reason="CIRCUIT_DATA_UNAVAILABLE",
            buffer=settings.get("bufferPct"),
        )
    if upper <= 0 or lower <= 0 or upper <= lower:
        return _circuit_result(
            status=CIRCUIT_UNKNOWN, upper=upper, lower=lower,
            data_available=True, exclusion_reason="INVALID_CIRCUIT_DATA",
            buffer=settings.get("bufferPct"),
        )

    buffer = _fnum(settings.get("bufferPct")) or 0.0

    # Circuit hit detection (real LTP against real limits).
    upper_hit = ltp >= upper
    lower_hit = ltp <= lower

    # Distance uses the CIRCUIT BOUNDARY as denominator (not LTP).
    dist_upper = ((upper - ltp) / upper) * 100.0 if upper > 0 else None
    dist_lower = ((ltp - lower) / lower) * 100.0 if lower > 0 else None

    # Safeguard against negative distances (ltp beyond the boundary).
    if dist_upper is not None and dist_upper < 0:
        dist_upper = 0.0
    if dist_lower is not None and dist_lower < 0:
        dist_lower = 0.0

    near_upper = (not upper_hit) and dist_upper is not None and dist_upper <= buffer
    near_lower = (not lower_hit) and dist_lower is not None and dist_lower <= buffer

    exclusion = None
    if upper_hit:
        exclusion = "UPPER_CIRCUIT_HIT"
        status = CIRCUIT_UPPER_HIT
    elif lower_hit:
        exclusion = "LOWER_CIRCUIT_HIT"
        status = CIRCUIT_LOWER_HIT
    elif near_upper:
        exclusion = "TOO_CLOSE_TO_UPPER_CIRCUIT"
        status = CIRCUIT_NEAR_UPPER
    elif near_lower:
        exclusion = "TOO_CLOSE_TO_LOWER_CIRCUIT"
        status = CIRCUIT_NEAR_LOWER
    else:
        exclusion = None
        status = CIRCUIT_SAFE

    return _circuit_result(
        status=status, upper=upper, lower=lower,
        dist_upper=dist_upper, dist_lower=dist_lower,
        upper_hit=upper_hit, lower_hit=lower_hit,
        near_upper=near_upper, near_lower=near_lower,
        data_available=True, exclusion_reason=exclusion, buffer=buffer,
    )


def _evaluate_with_limits(quote: dict, settings: dict) -> dict:
    """Evaluate when the filter is OFF but both limits are present."""
    upper = quote.get("upperCircuit")
    lower = quote.get("lowerCircuit")
    ltp = _fnum(quote.get("ltp"))
    if upper is None or lower is None or ltp is None:
        return _circuit_result(
            status=CIRCUIT_UNKNOWN, upper=upper, lower=lower,
            data_available=False, exclusion_reason=None, buffer=settings.get("bufferPct"),
        )
    buffer = _fnum(settings.get("bufferPct")) or 0.0
    upper_hit = ltp >= upper
    lower_hit = ltp <= lower
    dist_upper = ((upper - ltp) / upper) * 100.0
    dist_lower = ((ltp - lower) / lower) * 100.0
    status = CIRCUIT_SAFE
    if upper_hit:
        status = CIRCUIT_UPPER_HIT
    elif lower_hit:
        status = CIRCUIT_LOWER_HIT
    elif dist_upper <= buffer:
        status = CIRCUIT_NEAR_UPPER
    elif dist_lower <= buffer:
        status = CIRCUIT_NEAR_LOWER
    return _circuit_result(
        status=status, upper=upper, lower=lower,
        dist_upper=max(0.0, dist_upper), dist_lower=max(0.0, dist_lower),
        upper_hit=upper_hit, lower_hit=lower_hit,
        near_upper=status == CIRCUIT_NEAR_UPPER, near_lower=status == CIRCUIT_NEAR_LOWER,
        data_available=True, exclusion_reason=None, buffer=buffer,
    )


def _circuit_result(*, status, upper, lower, data_available, exclusion_reason,
                    dist_upper=None, dist_lower=None, upper_hit=False, lower_hit=False,
                    near_upper=False, near_lower=False, buffer=None) -> dict:
    return {
        "status": status,
        "upperCircuit": upper,
        "lowerCircuit": lower,
        "distanceToUpperPct": dist_upper,
        "distanceToLowerPct": dist_lower,
        "isUpperCircuitHit": upper_hit,
        "isLowerCircuitHit": lower_hit,
        "isNearUpperCircuit": near_upper,
        "isNearLowerCircuit": near_lower,
        "circuitDataAvailable": data_available,
        "bufferPct": buffer,
        "exclusionReason": exclusion_reason,
    }


def circuit_excludes(result: dict) -> bool:
    """True when a stock must be excluded under the (enabled) circuit filter."""
    return (
        result.get("status") != CIRCUIT_SAFE
        or not result.get("circuitDataAvailable")
        or result.get("exclusionReason") is not None
    )


# --------------------------------------------------------------------------- #
# Direction-aware filtering
# --------------------------------------------------------------------------- #
def passes_filters(row: dict, *, direction: str, window: str,
                   rupee_min=None, rupee_max=None, pct_min=None, pct_max=None,
                   mom_min=None, mom_max=None, q: str = "") -> bool:
    """Apply user filters with correct, direction-aware semantics.

    For GAINERS a "min" is a positive threshold; for LOSERS the same min is the
    absolute loss, i.e. changePercent <= -pct_min etc. Momentum is analogous.
    """
    chg = _fnum(row.get("change"))
    chg_pct = _fnum(row.get("changePercent"))
    momentum = (row.get("momentum") or {})
    mom = _fnum(momentum.get(window))

    if direction == "gainers":
        if not (chg_pct is not None and chg_pct > 0):
            return False
    elif direction == "losers":
        if not (chg_pct is not None and chg_pct < 0):
            return False

    if q:
        if not _matches_search(row, q):
            return False

    if direction == "gainers":
        if rupee_min is not None and not (chg is not None and chg >= rupee_min):
            return False
        if rupee_max is not None and not (chg is not None and chg <= rupee_max):
            return False
        if pct_min is not None and not (chg_pct is not None and chg_pct >= pct_min):
            return False
        if pct_max is not None and not (chg_pct is not None and chg_pct <= pct_max):
            return False
        if mom_min is not None and not (mom is not None and mom >= mom_min):
            return False
        if mom_max is not None and not (mom is not None and mom <= mom_max):
            return False
    elif direction == "losers":
        # "min loss" -> below the negative threshold.
        if rupee_min is not None and not (chg is not None and chg <= -rupee_min):
            return False
        if rupee_max is not None and not (chg is not None and chg >= -rupee_max):
            return False
        if pct_min is not None and not (chg_pct is not None and chg_pct <= -pct_min):
            return False
        if pct_max is not None and not (chg_pct is not None and chg_pct >= -pct_max):
            return False
        if mom_min is not None and not (mom is not None and mom <= -mom_min):
            return False
        if mom_max is not None and not (mom is not None and mom >= -mom_max):
            return False
    else:  # 'all' — thresholds are absolute magnitude (loss or gain)
        if rupee_min is not None and not (chg is not None and abs(chg) >= rupee_min):
            return False
        if rupee_max is not None and not (chg is not None and abs(chg) <= rupee_max):
            return False
        if pct_min is not None and not (chg_pct is not None and abs(chg_pct) >= pct_min):
            return False
        if pct_max is not None and not (chg_pct is not None and abs(chg_pct) <= pct_max):
            return False
        if mom_min is not None and not (mom is not None and abs(mom) >= mom_min):
            return False
        if mom_max is not None and not (mom is not None and abs(mom) <= mom_max):
            return False

    return True


def _matches_search(row: dict, q: str) -> bool:
    ql = (q or "").strip().lower()
    if not ql:
        return True
    haystack = " ".join(str(row.get(k) or "") for k in
                        ("symbol", "tradingSymbol", "companyName", "token", "isin")).lower()
    return ql in haystack
