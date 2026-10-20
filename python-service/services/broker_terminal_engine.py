"""Broker Terminal Engine — the ONE surface that reports every broker
(Kotak Neo / Shoonya / Dummy Mode) in a single pass.

Every value is real adapter output (or the shared paper engine for Dummy Mode),
canonicalised with the SAME normalisers as ``/api/trading/dashboard`` so the
numbers always match the active terminal pages. Nothing is fabricated:

  * a terminal that is not logged in reports honest nulls + ``connected: false``;
  * Dummy Mode behaves exactly like the real terminals: once it has been
    STARTED (adapter login + active central session) it reports the live paper
    account — balance, margins, realised/unrealised/total P&L, positions and
    orders; until it has been started it reports a truthful ``not started``
    state instead of a fake 1,00,000 balance.

The engine powers the Broker Terminal pages and the shared
``Broker Data — Live`` card grid (GET /api/trading/brokers/overview and the
compatibility alias GET /api/dummy/comparison).
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Any

from brokers.manager import TERMINALS, active_terminal, get_adapter
from core.timezones import now_ist as _now_ist

log = logging.getLogger("broker_terminal_engine")

_BROKER_NAMES = {"kotak": "Kotak Neo", "shoonya": "Shoonya", "dummy": "Dummy Mode"}

_NUMERIC_AGG = (
    "balance", "usedMargin", "availableMargin", "blockedMargin", "cash",
    "invested", "currentValue", "exposure", "realizedPnl", "unrealizedPnl",
    "totalPnl", "totalCharges", "longQty", "shortQty",
)

_ORDER_KEYS = ("total", "open", "pending", "completed", "cancelled", "rejected", "partial")


def now_ist() -> str:
    """Current instant in IST (project-wide convention)."""
    return _now_ist().isoformat()


def _session_state(term: str) -> str:
    # A terminal that is not actually logged in may still have a stale record
    # in the central session manager (e.g. SESSION_ACTIVE written by an earlier
    # login). Never report a live-looking session state for a terminal whose
    # adapter has no session — the card badge must match reality.
    logged_in = False
    try:
        from brokers.manager import get_adapter
        logged_in = bool(get_adapter(term).is_logged_in)
        if not logged_in:
            return "NOT_LOGGED_IN"
    except Exception:
        pass
    try:
        from services.session.session_manager import session_manager  # local import to avoid cycle
        rec = session_manager.terminal_session(term)
        status = str(rec.get("session_status") or "NONE")
        # Prefer the terminal's OWN per-terminal record (created at login /
        # managed login) over the central view, so a managed Dummy session shows
        # as active even while Kotak owns the central session.
        if status not in ("NONE", ""):
            return status
        snap = session_manager.snapshot()
        if snap.get("mode") != term:
            # The adapter is genuinely logged in (checked above) but the central
            # session manager is tracking another terminal — e.g. the scheduler's
            # live Kotak login while the paper/dummy mode owns the central view.
            # A derived "INACTIVE" here would badge a live trading session as dead;
            # the adapter's own truth wins.
            return "SESSION_ACTIVE" if logged_in else "INACTIVE"
        return str(snap.get("status") or snap.get("state") or "UNKNOWN")
    except Exception:
        return "UNKNOWN"


def _cache_meta(term: str, method: str) -> dict:
    try:
        from services.broker_cache import broker_cache
        from api.trading_dashboard import _cache_key
        return broker_cache.status(_cache_key(term, method)) or {}
    except Exception:
        return {}


def _agg_positions(rows: Any) -> dict:
    """Aggregate invested / current value / P&L / exposure / quantities from
    canonical position rows (the same shape the terminal core produces)."""
    invested = current = unrealized = realized = exposure = 0.0
    long_qty = short_qty = 0
    for p in rows or []:
        try:
            net = int(p.get("netQuantity") or 0)
            ltp = float(p.get("ltp") or 0)
            buy_avg = float(p.get("averageBuyPrice") or 0)
            sell_avg = float(p.get("averageSellPrice") or 0)
            factor = 0.2 if str(p.get("product") or "MIS").upper() == "MIS" else 1.0
            if abs(net) > 0:
                entry = buy_avg if net > 0 else sell_avg
                invested += entry * abs(net)
                current += ltp * abs(net)
                exposure += ltp * abs(net) * factor
                if net > 0:
                    long_qty += net
                else:
                    short_qty += abs(net)
            unrealized += float(p.get("unrealizedPnl") or 0)
            realized += float(p.get("realizedPnl") or 0)
        except (TypeError, ValueError):
            continue
    return {
        "invested": round(invested, 2) or None,
        "currentValue": round(current, 2) or None,
        "realizedPnl": round(realized, 2) or None,
        "unrealizedPnl": round(unrealized, 2) or None,
        "exposure": round(exposure, 2) or None,
        "positionCount": len(rows) if isinstance(rows, list) else 0,
        "longQty": long_qty or None,
        "shortQty": short_qty or None,
    }


def _orders_summary(rows: Any) -> dict:
    total = len(rows) if isinstance(rows, list) else 0
    counts = {"OPEN": 0, "PENDING": 0, "COMPLETE": 0, "CANCELLED": 0, "REJECTED": 0, "PARTIALLY_FILLED": 0}
    for o in rows or []:
        key = str(o.get("status") or "OPEN").upper()
        if key in ("COMPLETED", "FILLED", "TRADED", "FULLY_FILLED"):
            key = "COMPLETE"
        counts[key] = counts.get(key, 0) + 1
    return {
        "total": total,
        "open": counts["OPEN"],
        "pending": counts["PENDING"],
        "completed": counts["COMPLETE"],
        "cancelled": counts["CANCELLED"],
        "rejected": counts["REJECTED"],
        "partial": counts["PARTIALLY_FILLED"],
    }


def _empty_row(term: str, adapter: Any, *, logged_in: bool, message: str) -> dict:
    meta = _cache_meta(term, "funds")
    return {
        "id": term,
        "name": _BROKER_NAMES.get(term, term),
        "enabled": bool(getattr(adapter, "enabled", True)),
        "active": term == active_terminal(),
        "isLoggedIn": logged_in,
        "connected": logged_in,
        "sessionState": _session_state(term) if logged_in else "NOT_LOGGED_IN",
        "funds": None,
        "balance": None,
        "usedMargin": None,
        "availableMargin": None,
        "blockedMargin": None,
        "cash": None,
        "invested": None,
        "currentValue": None,
        "exposure": None,
        "realizedPnl": None,
        "unrealizedPnl": None,
        "totalPnl": None,
        "totalCharges": None,
        "positionCount": None,
        "longQty": None,
        "shortQty": None,
        "orders": None,
        "updatedAt": meta.get("last_success"),
        "lastError": meta.get("last_error"),
        "message": message,
    }


async def _read_funds_positions_orders(term: str, adapter: Any) -> dict:
    """Real adapter reads for a logged-in terminal (funds + positions + orders),
    canonicalised exactly like /api/trading/dashboard."""
    from api.trading_dashboard import _normalize_funds, _normalize_orders

    out: dict[str, Any] = {}
    try:
        funds = await adapter.funds()
        norm = _normalize_funds(term, funds)
        if norm:
            out["funds"] = {
                "balance": norm.get("balance"),
                "usedMargin": norm.get("usedMargin"),
                "availableMargin": norm.get("freeMargin", norm.get("availableMargin")),
                "blockedMargin": norm.get("blockedMargin"),
                "cash": norm.get("cash"),
            }
            out["realizedPnl"] = norm.get("realizedPnl")
            out["unrealizedPnl"] = norm.get("unrealizedPnl")
            out["totalPnl"] = norm.get("totalPnl")
            out["totalCharges"] = norm.get("totalCharges")
    except Exception as exc:
        log.warning("broker engine %s funds failed: %s", term, exc)

    try:
        from core.engines.position_engine import get_positions
        payload = await get_positions(term)
        rows = payload.get("data", []) if isinstance(payload, dict) else []
        out.update(_agg_positions(rows))
    except Exception as exc:
        log.warning("broker engine %s positions failed: %s", term, exc)

    try:
        orders = await adapter.orders()
        raw_rows = orders.get("data", []) if isinstance(orders, dict) else (orders or [])
        out["orders"] = _orders_summary(_normalize_orders(term, raw_rows))
    except Exception as exc:
        log.warning("broker engine %s orders failed: %s", term, exc)

    return out


async def _dummy_row(adapter: Any) -> dict:
    """Dummy Mode: real paper-engine data ONCE the mode has been started."""
    from api.demo import get_dummy_account, get_dummy_positions, get_dummy_orders

    meta = _cache_meta("dummy", "funds")
    row = {
        "id": "dummy",
        "name": _BROKER_NAMES["dummy"],
        "enabled": bool(getattr(adapter, "enabled", True)),
        "active": "dummy" == active_terminal(),
        "isLoggedIn": bool(adapter.is_logged_in),
        "sessionState": _session_state("dummy"),
        "updatedAt": meta.get("last_success"),
        "lastError": meta.get("last_error"),
    }
    if not adapter.is_logged_in:
        row["connected"] = False
        row["message"] = "Dummy Mode not started — start it to see the paper account"
        for key in (
            "funds", "balance", "usedMargin", "availableMargin", "blockedMargin", "cash",
            "invested", "currentValue", "exposure", "realizedPnl", "unrealizedPnl",
            "totalPnl", "totalCharges", "positionCount", "longQty", "shortQty", "orders",
        ):
            row[key] = None
        return row

    row["connected"] = True
    account, positions, orders = await get_dummy_account(), await get_dummy_positions(), await get_dummy_orders()
    snap = _agg_positions(positions)
    row.update({
        "funds": {
            "balance": account.get("balance"),
            "usedMargin": account.get("usedMargin"),
            "availableMargin": account.get("freeMargin"),
            "blockedMargin": None,
            "cash": account.get("freeMargin"),
        },
        "balance": account.get("balance"),
        "usedMargin": account.get("usedMargin"),
        "availableMargin": account.get("freeMargin"),
        "blockedMargin": None,
        "cash": account.get("freeMargin"),
        "realizedPnl": account.get("realizedPnl") if account.get("realizedPnl") is not None else snap.get("realizedPnl"),
        "unrealizedPnl": account.get("unrealizedPnl") if account.get("unrealizedPnl") is not None else snap.get("unrealizedPnl"),
        "totalPnl": account.get("totalPnl"),
        "totalCharges": account.get("totalCharges"),
        "orders": _orders_summary(orders),
    })
    row.update({k: snap[k] for k in ("invested", "currentValue", "exposure", "positionCount", "longQty", "shortQty")})
    if row["totalPnl"] is None and (row["realizedPnl"] is not None or row["unrealizedPnl"] is not None):
        row["totalPnl"] = round(float(row["realizedPnl"] or 0) + float(row["unrealizedPnl"] or 0), 2)
    row["message"] = None
    return row


# Combined = the REAL brokers only (Kotak + Shoonya). Dummy Mode is paper virtual
# capital and is deliberately excluded so the aggregate reflects real money.
_COMBINED_TERMINALS: tuple[str, ...] = ("kotak", "shoonya")


def _combined(terminal_rows: dict[str, dict]) -> dict:
    combined: dict[str, Any] = {"connected": False, "sources": list(_COMBINED_TERMINALS)}
    connected = {
        k: v for k, v in terminal_rows.items()
        if k in _COMBINED_TERMINALS and v.get("connected")
    }
    for key in _NUMERIC_AGG:
        values = []
        for term in connected.values():
            value = term.get("funds", {}).get(key) if key in ("balance", "usedMargin", "availableMargin", "blockedMargin", "cash") and isinstance(term.get("funds"), dict) else term.get(key)
            if value is not None:
                values.append(float(value))
        combined[key] = round(sum(values), 2) if values else None
    combined["positionCount"] = sum(
        int(connected[t].get("positionCount") or 0) for t in connected
    ) or None
    combined["orders"] = {
        k: sum(int(connected[t].get("orders", {}).get(k, 0) or 0) for t in connected)
        for k in _ORDER_KEYS
    }
    combined["connected"] = bool(connected)
    return combined


async def build_terminal_overview(strict_dummy: bool = True) -> dict:
    """One-pass snapshot for ALL registered terminals + the aggregate row.

    ``strict_dummy`` (default True) gates Dummy Mode on an actual dummy login so
    a not-started dummy reports an honest empty card instead of a phantom paper
    balance. Keeping the flag makes the legacy /api/dummy/comparison behave the
    same while the new /api/trading/brokers/overview surface owns the contract.

    The aggregate row (``combined``) sums the REAL brokers Kotak + Shoonya only —
    Dummy Mode's virtual capital is excluded by design.
    """
    rows: dict[str, dict] = {}
    for term in TERMINALS:
        try:
            adapter = get_adapter(term)
        except Exception as exc:
            log.warning("broker engine get_adapter(%s) failed: %s", term, exc)
            rows[term] = _empty_row(term, adapter=None, logged_in=False,
                                     message=f"adapter unavailable: {exc}")
            continue
        if term == "dummy" and strict_dummy:
            try:
                rows[term] = await _dummy_row(adapter)
                continue
            except Exception as exc:
                log.warning("broker engine dummy row failed: %s", exc)
                rows[term] = _empty_row(term, adapter, logged_in=bool(adapter.is_logged_in), message=str(exc))
                continue
        if not adapter.is_logged_in:
            rows[term] = _empty_row(term, adapter, logged_in=False, message="not connected")
            continue
        try:
            out = await _read_funds_positions_orders(term, adapter)
        except Exception as exc:
            log.warning("broker engine %s read failed: %s", term, exc)
            rows[term] = _empty_row(term, adapter, logged_in=True, message=str(exc))
            continue
        meta = _cache_meta(term, "funds")
        row = {
            "id": term,
            "name": _BROKER_NAMES.get(term, term),
            "enabled": bool(getattr(adapter, "enabled", True)),
            "active": term == active_terminal(),
            "isLoggedIn": True,
            "connected": True,
            "sessionState": _session_state(term),
            "message": None,
            "updatedAt": meta.get("last_success"),
            "lastError": meta.get("last_error"),
            **out,
        }
        # Convenience top-level copies of the funds sub-object (the UI reads
        # either shape); values already present (e.g. P&L from agg) win.
        if isinstance(row.get("funds"), dict):
            for key in ("balance", "usedMargin", "availableMargin", "blockedMargin", "cash"):
                row.setdefault(key, row["funds"].get(key))
        for key in ("invested", "currentValue", "exposure", "positionCount", "longQty", "shortQty"):
            row.setdefault(key, None)
        rows[term] = row

    return {
        "ok": True,
        "active": active_terminal(),
        "generatedAt": now_ist(),
        "serverTime": now_ist(),
        "terminals": {
            "kotak": rows["kotak"],
            "shoonya": rows["shoonya"],
            "dummy": rows["dummy"],
        },
        "combined": _combined(rows),
    }