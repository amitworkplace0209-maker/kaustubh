"""Consolidated trading dashboard — one terminal-aware snapshot endpoint.

``GET /api/trading/dashboard`` returns the REAL broker state for the ACTIVE
terminal in one call: canonicalised funds / positions / holdings / orders with
an honest per-section envelope (status · source · timestamp · data · error).

Why this exists
    The frontend dashboard previously polled four Kotak-only endpoints
    (``/api/trading/funds|positions|holdings|orders``) every few seconds and
    labelled every section "Kotak" regardless of the active terminal. This
    module serves the SAME adapter data through the terminal manager so the
    dashboard reflects the ACTIVE terminal (kotak | shoonya | dummy), with no
    polling-friendly shortcuts: every section carries the real broker snapshot
    time and an honest status — ``not_configured`` / ``not_logged_in`` /
    ``ok`` / ``unavailable`` / ``error``. Nothing is fabricated; a broker that
    cannot serve a section yields a null/absent value, never a fake zero.

Caching
    Kotak reads already flow through the shared single-flight broker cache
    (TTL 5s / cooldown 15s / timeout 4s) under the same keys the rest of the
    app uses, so concurrent consumers are deduplicated by the cache itself.
    Shoonya/Dummy reads are wrapped in the same cache under terminal-scoped
    keys for identical safety. Positions reuse the canonical
    ``position_engine`` (normalise + target overlay).
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import APIRouter, HTTPException

from brokers.manager import TERMINALS, active_terminal, get_adapter
from brokers.models import BrokerError
from core.engines import position_engine
from services.broker_cache import broker_cache
from core.timezones import now_ist as _now_ist

router = APIRouter(prefix="/api/trading", tags=["trading"])
log = logging.getLogger("trading_dashboard")

_BROKER_NAMES = {"kotak": "Kotak Neo", "shoonya": "Shoonya", "dummy": "Dummy Mode"}

_CACHE_TTL = 5.0
_CACHE_COOLDOWN = 15.0
_CACHE_TIMEOUT = 4.0

# Kotak reads reuse the legacy cache keys so the dashboard and the existing
# /api/trading/* endpoints share (and de-duplicate) one broker snapshot.
_LEGACY_KEYS = {
    ("kotak", "funds"): "limits",
    ("kotak", "orders"): "order_book",
    ("kotak", "holdings"): "holdings",
    ("kotak", "positions"): "positions",
}

_SOURCE_LABELS = {
    "funds": "broker:limits",
    "positions": "broker:positions",
    "holdings": "broker:holdings",
    "orders": "broker:order_book",
}

_SECTIONS = ("funds", "positions", "holdings", "orders")


def now_ist() -> str:
    """Current instant in IST (project-wide convention)."""
    return _now_ist().isoformat()


def _cache_key(terminal: str, method: str) -> str:
    return _LEGACY_KEYS.get((terminal, method), f"{terminal}_{method}")


def _as_num(v: Any) -> float | None:
    """Parse a numeric field honestly — null/''/'NA'/'N/A'/'-' remain None."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s in ("", "NA", "N/A", "-", "--", "null", "None"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _as_int(v: Any) -> int | None:
    n = _as_num(v)
    return int(n) if n is not None else None


def _str(v: Any) -> str:
    return "" if v is None else str(v)


def _pick(ctx: dict, names: list[str]) -> float | None:
    """First finite value among the candidate keys in ``ctx`` (in order)."""
    if not isinstance(ctx, dict):
        return None
    for k in names:
        v = ctx.get(k)
        n = _as_num(v)
        if n is not None:
            return n
    return None


def _as_list(raw: Any) -> list:
    if isinstance(raw, list):
        return raw
    return [raw] if isinstance(raw, dict) else []


# ---------------------------------------------------------------------------
# Canonical normalisers (cross-broker single shape; raw fields preserved)
# ---------------------------------------------------------------------------

def _normalize_funds(terminal: str, raw: Any) -> dict | None:
    # Dummy: a list with one account dict (canonical English field names).
    if terminal == "dummy":
        acct = raw[0] if isinstance(raw, list) and raw else (raw if isinstance(raw, dict) else {})
        return {
            "balance": _as_num(acct.get("balance")),
            "usedMargin": _as_num(acct.get("usedMargin") or acct.get("used_margin")),
            "freeMargin": _as_num(acct.get("freeMargin") or acct.get("free_margin")),
            "totalPnl": _as_num(acct.get("totalPnl") or acct.get("total_pnl")),
            "realizedPnl": _as_num(acct.get("realizedPnl") or acct.get("realized_pnl") or acct.get("realisedPnl")),
            "unrealizedPnl": _as_num(acct.get("unrealizedPnl") or acct.get("unrealized_pnl") or acct.get("unrealisedPnl")),
            "totalCharges": _as_num(acct.get("totalCharges") or acct.get("total_charges")),
            "dailyOrders": _as_int(acct.get("dailyOrders")),
            "cash": None,
            "blockedMargin": None,
            "raw": acct,
        }

    # Kotak / Shoonya: a response dict, possibly nested (data / payload /
    # limitObject / RMS).
    ctx = raw if isinstance(raw, dict) else {}
    for key in ("payload", "data", "limitObject"):
        nested = ctx.get(key)
        if isinstance(nested, dict):
            ctx = nested
            break
    rms = ctx.get("RMS") if isinstance(ctx, dict) else None
    if isinstance(rms, dict):
        ctx = rms

    free = _pick(ctx, [
        "Net", "net", "available_margin", "availableMargin", "freeMargin",
        "marginAvailable", "MarginAvailable", "cash_available", "CashAvail",
    ])
    used = _pick(ctx, [
        "MarginUsed", "used_margin", "usedMargin", "UtilisedDebit",
        "utilised_debit", "AmountUtilizedPrsnt",
    ])
    cash = _pick(ctx, [
        "NotionalCash", "cash_margin_available", "cashMarginAvailable", "notional_cash",
    ])
    blocked = _pick(ctx, [
        "CollateralValue", "collateral_margin", "collateralMargin",
        "Collateral", "RmsCollateral", "blockedMargin",
    ])
    balance = _pick(ctx, [
        "balance", "Balance", "totalFunds", "total_funds", "net_worth",
        "NetWorth", "equity",
    ])
    pnl = _pick(ctx, ["totalPnl", "total_pnl", "gross_pnl", "GrossPnl"])
    realized = _pick(ctx, [
        "realizedPnl", "realized_pnl", "realisedPnl", "realised_pnl",
        "RealisedPnl", "realized_pnl",
    ])
    unrealized = _pick(ctx, [
        "unrealizedPnl", "unrealized_pnl", "unrealisedPnl", "unrealised_pnl",
        "UnrealisedPnl", "unrealized_pnl",
    ])
    charges = _pick(ctx, ["totalCharges", "total_charges", "TotalCharges", "charges"])

    return {
        "balance": balance,
        "usedMargin": used,
        "freeMargin": free if free is not None else (balance if balance is not None else None),
        "totalPnl": pnl,
        "realizedPnl": realized,
        "unrealizedPnl": unrealized,
        "totalCharges": charges,
        "dailyOrders": _as_int(_pick(ctx, ["dailyOrders", "daily_orders", "DailyOrders"])),
        "cash": cash,
        "blockedMargin": blocked,
        "raw": raw,
    }


def _normalize_orders(terminal: str, raw: Any) -> list:
    out: list[dict] = []
    for idx, item in enumerate(_as_list(raw)):
        if not isinstance(item, dict):
            out.append({"index": idx})
            continue
        tx = _str(item.get("trnsTp") or item.get("transactionType") or item.get("buyOrSell") or item.get("txType") or item.get("BuySell"))
        tx_u = tx.upper()
        if tx_u in ("B", "BUY"):
            tx = "BUY"
        elif tx_u in ("S", "SELL"):
            tx = "SELL"
        canonical = {
            "orderId": _str(item.get("nOrdNo") or item.get("n_ord_no") or item.get("orderId") or item.get("order_id") or item.get("ordno")),
            "symbol": _str(item.get("sym") or item.get("symbol") or item.get("trdSym") or item.get("tradingSymbol") or "").split("-")[0],
            "tradingSymbol": _str(item.get("trdSym") or item.get("tradingSymbol") or item.get("tradingsymbol") or item.get("symbol")),
            "exchange": _str(item.get("exSeg") or item.get("exchange") or item.get("exchangeSegment") or item.get("exchange_segment") or item.get("pExchSeg")),
            "transactionType": tx,
            "product": _str(item.get("prod") or item.get("product") or item.get("productType") or item.get("product_type")),
            "orderType": _str(item.get("prcTp") or item.get("orderType") or item.get("order_type") or item.get("priceType")),
            "quantity": _as_int(item.get("qty") or item.get("quantity") or item.get("Qty")),
            "filledQuantity": _as_int(item.get("fldQty") or item.get("filledQuantity") or item.get("filled_quantity") or item.get("FillQty")),
            "price": _as_num(item.get("prc") or item.get("price") or item.get("order_price") or item.get("OrderPrice")),
            "averagePrice": _as_num(item.get("avgPrc") or item.get("averagePrice") or item.get("average_price") or item.get("avg_price")),
            "triggerPrice": _as_num(item.get("trgPrc") or item.get("triggerPrice") or item.get("trigger_price") or item.get("TriggerPrice")),
            "status": _str(item.get("ordSt") or item.get("status") or item.get("stat")),
            "orderTime": _str(item.get("orderTime") or item.get("order_time") or item.get("orderDate") or item.get("filled_order_time")),
        }
        out.append({**item, **canonical})
    return out


def _normalize_holdings(terminal: str, raw: Any) -> list:
    out: list[dict] = []
    for idx, item in enumerate(_as_list(raw)):
        if not isinstance(item, dict):
            out.append({"index": idx})
            continue
        qty = _as_int(item.get("holdqty") or item.get("holdingQty") or item.get("quantity") or item.get("qty") or item.get("totalQty"))
        ltp = _as_num(item.get("ltp") or item.get("last_price") or item.get("ClosePrice") or item.get("price"))
        avg = _as_num(item.get("avgPrice") or item.get("avg_price") or item.get("holdingCost") or item.get("avg_prc"))
        mv = _as_num(item.get("mktValue") or item.get("marketValue") or item.get("market_value") or item.get("MktValue"))
        pnl = _as_num(item.get("unrealisedGainLoss") or item.get("unrealizedGainLoss") or item.get("unrealised_gl") or item.get("unrealized_gl") or item.get("pnl"))
        canonical = {
            "symbol": _str(item.get("symbol") or item.get("sym") or item.get("trdSym") or item.get("tradingSymbol") or "").split("-")[0],
            "tradingSymbol": _str(item.get("trdSym") or item.get("tradingSymbol") or item.get("tradingsymbol") or item.get("symbol")),
            "exchange": _str(item.get("exSeg") or item.get("exchange") or item.get("exchangeSegment") or item.get("exchange_segment") or item.get("pExchSeg")),
            "product": _str(item.get("prod") or item.get("product") or item.get("productType") or item.get("product_type")),
            "quantity": qty,
            "avgPrice": avg,
            "ltp": ltp,
            "value": mv,
            "marketValue": mv,
            "pnl": pnl,
            "unrealizedPnl": pnl,
            "holdingCost": avg,
        }
        out.append({**item, **canonical})
    return out


# ---------------------------------------------------------------------------
# Section envelopes
# ---------------------------------------------------------------------------

def _envelope(status: str, is_demo: bool, **kw: Any) -> dict:
    base: dict[str, Any] = {
        "status": status,
        "isDemo": is_demo,
        "timestamp": None,
        "data": None,
        "error": None,
        "count": None,
    }
    base.update(kw)
    return base


async def _read_section(
    terminal: str,
    adapter: Any,
    method: str,
    normalizer: Callable[[str, Any], Any],
) -> dict:
    """Fetch ONE broker read and normalise it into a canonical envelope."""
    is_demo = terminal == "dummy"
    key = _cache_key(terminal, method)
    try:
        if terminal == "kotak":
            # Kotak adapters already route through the shared broker cache.
            result = await getattr(adapter, method)()
        else:
            result = await broker_cache.get(
                key, getattr(adapter, method),
                ttl=_CACHE_TTL, fail_cooldown=_CACHE_COOLDOWN,
                timeout=_CACHE_TIMEOUT,
            )
    except BrokerError as exc:
        log.warning("dashboard %s/%s BrokerError: %s", terminal, method, exc)
        return _envelope("error", is_demo, source=_SOURCE_LABELS[method], error=exc.message)
    except Exception as exc:
        log.exception("dashboard %s/%s failed: %s", terminal, method, exc)
        return _envelope("error", is_demo, source=_SOURCE_LABELS[method], error=f"{type(exc).__name__}: {exc}")

    if result is None:
        info = broker_cache.status(key)
        err = info.get("last_error") or "broker request failed or timed out"
        return _envelope("unavailable", is_demo, source=_SOURCE_LABELS[method], error=err)

    data = result
    if isinstance(result, dict):
        if "data" in result:
            data = result["data"]
        elif isinstance(result.get("values"), list):  # Noren-style payloads
            data = result["values"]
        elif isinstance(result.get("valuelist"), list):
            data = result["valuelist"]
    try:
        normalized = normalizer(terminal, data)
    except Exception as exc:
        log.exception("dashboard normaliser %s/%s failed", terminal, method)
        normalized = data

    count = None
    if isinstance(normalized, list):
        count = len(normalized)

    timestamp = broker_cache.status(key).get("last_success") or now_ist()
    return _envelope(
        "ok", is_demo,
        source=_SOURCE_LABELS[method],
        timestamp=timestamp,
        data=normalized,
        count=count,
    )


async def _positions_section(terminal: str, adapter: Any) -> dict:
    """Positions come from the canonical position_engine (normalise + target overlay)."""
    is_demo = terminal == "dummy"
    key = _cache_key(terminal, "positions")
    try:
        payload = await position_engine.get_positions(terminal)
    except BrokerError as exc:
        log.warning("dashboard %s/positions BrokerError: %s", terminal, exc)
        return _envelope("error", is_demo, source=_SOURCE_LABELS["positions"], error=exc.message)
    except Exception as exc:
        log.exception("dashboard %s/positions failed: %s", terminal, exc)
        return _envelope("error", is_demo, source=_SOURCE_LABELS["positions"], error=f"{type(exc).__name__}: {exc}")

    rows = payload.get("data") or []
    try:
        last_success = broker_cache.status(key).get("last_success")
    except Exception:
        last_success = None
    return _envelope(
        "ok", is_demo,
        source="position_engine:" + terminal,
        timestamp=last_success or now_ist(),
        data=rows,
        totals=payload.get("totals"),
        count=len(rows) if isinstance(rows, list) else None,
    )


def _unavailable_sections(status: str, adapter: Any) -> dict:
    is_demo = getattr(adapter, "mode", "") == "dummy"
    return {
        method: _envelope(status, is_demo, source=_SOURCE_LABELS[method])
        for method in _SECTIONS
    }


@router.get("/brokers/status")
async def brokers_status():
    """Real per-terminal operational status (all three terminals).

    Every value comes from the adapter / broker cache — never fabricated:
      enabled      config-level capability (credentials/settings present)
      isLoggedIn   the adapter's own login-state flag
      sessionState the terminal's own session state (managed/logged-in record
      updatedAt    latest real last-success timestamp from the broker cache
      lastError    the honest last failure message from the cache
    """
    def _terminal_session_state(term: str) -> str:
        try:
            # Single source of truth: the Broker Terminal engine's per-terminal
            # session state (own session record preferred over the central view,
            # so a managed Dummy connection reads as active).
            from services.broker_terminal_engine import _session_state
            return _session_state(term)
        except Exception:
            return "UNKNOWN"

    terminals = []
    for term in TERMINALS:
        try:
            adapter = get_adapter(term)
        except Exception as exc:
            log.warning("brokers/status get_adapter(%s) failed: %s", term, exc)
            terminals.append({
                "id": term,
                "name": _BROKER_NAMES.get(term, term),
                "enabled": False,
                "isLoggedIn": False,
                "isActive": term == active_terminal(),
                "sessionState": "UNAVAILABLE",
                "updatedAt": None,
                "lastError": str(exc),
            })
            continue
        try:
            cache_info = broker_cache.status(_cache_key(term, "funds"))
        except Exception:
            cache_info = {}
        terminals.append({
            "id": term,
            "name": _BROKER_NAMES.get(term, term),
            "enabled": bool(getattr(adapter, "enabled", True)),
            "isLoggedIn": bool(adapter.is_logged_in),
            "isActive": term == active_terminal(),
            "sessionState": _terminal_session_state(term),
            "updatedAt": cache_info.get("last_success"),
            "lastError": cache_info.get("last_error"),
        })
    return {
        "ok": True,
        "active": active_terminal(),
        "generatedAt": now_ist(),
        "server_time_utc": now_ist(),
        "terminals": terminals,
    }


@router.get("/brokers/overview")
async def brokers_overview():
    """Broker Terminal Engine — every broker (Kotak / Shoonya / Dummy) in ONE
    pass: funds, positions & P&L, orders, session state.

    This is the canonical surface for the Broker Terminal pages and the shared
    "Broker Data — Live" card grid. Every value is real adapter output (or the
    paper engine for Dummy Mode, reported only AFTER that mode has actually
    been started) — see services.broker_terminal_engine.
    """
    from services.broker_terminal_engine import build_terminal_overview
    return await build_terminal_overview()


@router.post("/brokers/refresh")
async def brokers_refresh():
    """Force a REAL broker re-read for every terminal (Kotak / Shoonya /
    Dummy), then re-run the Broker Terminal Engine's one-pass overview.

    The Broker Terminal page's Refresh button must never be satisfied from a
    5s cache hit, so this endpoint invalidates every terminal-scoped broker
    cache key (the shared single-flight cache, incl. the legacy Kotak
    ``limits`` / ``order_book`` / ``positions`` / ``holdings`` snapshots)
    before the engine reads again.
    """
    from services.broker_cache import broker_cache
    from services.broker_terminal_engine import build_terminal_overview

    for term in TERMINALS:
        for method in _SECTIONS:
            broker_cache.invalidate(_cache_key(term, method))

    overview = await build_terminal_overview()
    overview["refreshed"] = True
    overview["refreshedAt"] = overview.get("generatedAt")
    return overview


@router.get("/dashboard")
async def trading_dashboard(terminal: str = ""):
    """Consolidated snapshot for the ACTIVE terminal (kotak|shoonya|dummy).

    ``?terminal=`` is optional — when supplied it MUST be the active terminal
    (terminal isolation: a Shoonya session can never be shown as Kotak).
    Every section is an honest envelope; no field is fabricated.
    """
    term = (terminal or "").lower()
    if term and term not in TERMINALS:
        raise HTTPException(400, "terminal must be one of kotak|shoonya|dummy")
    if term and term != active_terminal():
        raise HTTPException(409, f"terminal {term} is not the active terminal (switch first)")

    active = active_terminal()
    adapter = get_adapter(active)
    enabled = bool(getattr(adapter, "enabled", True))
    logged_in = bool(adapter.is_logged_in)
    is_demo = active == "dummy"

    if not enabled:
        sections = _unavailable_sections("not_configured", adapter)
    elif not logged_in:
        sections = _unavailable_sections("not_logged_in", adapter)
    else:
        sections = {
            "funds": await _read_section(active, adapter, "funds", _normalize_funds),
            "positions": await _positions_section(active, adapter),
            "holdings": await _read_section(active, adapter, "holdings", _normalize_holdings),
            "orders": await _read_section(active, adapter, "orders", _normalize_orders),
        }

    return {
        "ok": True,
        "terminal": active,
        "broker": _BROKER_NAMES.get(active, active),
        "isDemo": is_demo,
        "isLoggedIn": logged_in,
        "enabled": enabled,
        "generatedAt": now_ist(),
        "server_time_utc": now_ist(),
        "sections": sections,
        "cache": broker_cache.summary(),
    }