"""Dummy daily-session lifecycle — the authoritative 12:00 AM IST reset.

Canonical rules (Asia/Kolkata always):

  * A Dummy *session* is identified ONLY by its IST calendar date, never by
    browser state. The backend owns the lifecycle.
  * A new Dummy trading session opens at 12:00 AM IST (midnight). At that
    moment the previous day's session is CLOSED (final counters refreshed and
    the full operational store — account / orders / positions / transactions,
    i.e. every stock bought, its buy price and status — archived permanently
    inside the closed session document) and the operational store is
    re-initialised for the new date: fresh starting capital, zero P&L /
    charges / order & basket counters. Everything resets clean every day at
    12:00 AM, automatically (the 30s rollover loop + every terminal read runs
    the idempotent ensure, so no traffic is required for the reset to happen).
  * The reset is IDEMPOTENT. Restarts later the same day detect the existing
    session and never duplicate it, and never wipe within-day state.
  * Separation of concerns:
      DAILY OPERATIONAL  -> demo_account / demo_orders / demo_positions /
                            demo_transactions (archived inside the closed
                            session document at rollover).
      PERMANENT          -> dummy_audit_events, dummy_calendar_events,
                            dummy_watchlists, dummy_prefs,
                            dummy_daily_history (long-term accounting),
                            closed-position records. These are NEVER deleted
                            by the daily reset.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

from database.connection import get_db

logger = logging.getLogger("app")

from core.timezones import IST

#: The Dummy day boundary — 12:00 AM IST (midnight). A new IST calendar date
#: always means a new session: the previous day is closed + archived and the
#: operational store (balance, orders, positions) resets clean for the new day.
SESSION_OPEN_HOUR_IST = 0
SESSION_OPEN_MINUTE_IST = 0

COLLECTION = "dummy_daily_sessions"
TERMINAL = "dummy"

DEFAULT_STARTING_CAPITAL = 100000.0
MAX_ARCHIVED_ORDERS = 500
MAX_ARCHIVED_POSITIONS = 200
MAX_ARCHIVED_TRANSACTIONS = 200
MAX_CLOSED_SESSIONS = 60  # ~8 weeks of daily sessions kept as permanent history

# Operational app_settings keys owned by the paper engine (api/demo.py).
_KEY_ACCOUNT = "demo_account"
_KEY_ORDERS = "demo_orders"
_KEY_POSITIONS = "demo_positions"
_KEY_TRANSACTIONS = "demo_transactions"
_KEY_PREFS = "dummy_prefs"
_KEY_NOTIFICATIONS = "dummy_notifications"
_KEY_DAILY_HISTORY = "dummy_daily_history"
_KEY_CLOSED_POSITIONS = "dummy_closed_positions"
_KEY_BASKETS = "dummy_baskets"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _now_ist() -> datetime:
    return datetime.now(IST)


def session_date_for(value: datetime) -> str:
    """IST calendar-date partition for the *session* lifecycle.

    The Dummy session date flips at 12:00 AM IST (midnight):
      * 23:59:59 IST -> that calendar date (session still active)
      * 00:00:00 IST -> the new calendar date (new session opens here)
    """
    ist = value.astimezone(IST) if value.tzinfo else value.replace(tzinfo=IST)
    return ist.date().isoformat()


async def _get_prefs() -> dict:
    db = get_db()
    doc = await db.app_settings.find_one({"key": _KEY_PREFS})
    stored = (doc or {}).get("value") or {}
    return {
        "startingCapital": DEFAULT_STARTING_CAPITAL,
        **stored,
    }


def _default_account(starting_capital: float) -> dict:
    return {
        "balance": round(float(starting_capital), 2),
        "usedMargin": 0,
        "freeMargin": round(float(starting_capital), 2),
        "totalPnl": 0,
        "totalCharges": 0,
        "realizedPnl": 0,
        "unrealizedPnl": 0,
        "dailyOrders": 0,
        "startDate": _now_utc().isoformat(),
        "sessionId": None,
    }


# --------------------------------------------------------------------------- #
# Session document helpers
# --------------------------------------------------------------------------- #
async def _find_session(trading_date: str) -> Optional[dict]:
    db = get_db()
    return await db[COLLECTION].find_one({"terminal": TERMINAL, "trading_date": trading_date})


async def _upsert_session(doc: dict) -> dict:
    db = get_db()
    # ``createdAt`` is immutable (set only on insert); putting it in BOTH
    # ``$set`` and ``$setOnInsert`` is a MongoDB path-conflict (code 40).
    payload = {k: v for k, v in doc.items() if k not in ("_id", "createdAt")}
    await db[COLLECTION].update_one(
        {"terminal": TERMINAL, "trading_date": doc["trading_date"]},
        {"$set": payload, "$setOnInsert": {"createdAt": _now_utc()}},
        upsert=True,
    )
    return await _find_session(doc["trading_date"]) or doc


def _build_session(trading_date: str, starting_capital: float, status: str = "OPEN") -> dict:
    now = _now_utc()
    return {
        "sessionId": f"DUMMY:{trading_date}",
        "trading_date": trading_date,
        "terminal": TERMINAL,
        "status": status,
        "started_at": now.isoformat(),
        "closed_at": None,
        "starting_capital": round(float(starting_capital), 2),
        "available_capital": round(float(starting_capital), 2),
        "used_capital": 0,
        "reserved_margin": 0,
        "realized_pnl": 0,
        "unrealized_pnl": 0,
        "today_pnl": 0,
        "charges": 0,
        "turnover": 0,
        "order_count": 0,
        "trade_count": 0,
        "position_count": 0,
        "basket_count": 0,
        "summary": {},
    }


async def _read_operational_state() -> dict:
    """Best-effort read of the current operational store (no session reset).

    Returns every partition the rollover archives. Missing/absent stores are
    treated as empty so the archival is always well formed.
    """
    db = get_db()
    out: dict = {}
    for key in (_KEY_ACCOUNT, _KEY_ORDERS, _KEY_POSITIONS, _KEY_TRANSACTIONS):
        doc = await db.app_settings.find_one({"key": key})
        out[key.replace("demo_", "")] = (doc or {}).get("value")
    return out


async def _archive_session(session: dict) -> None:
    """Close ``session`` and fold the day's operational store into it as a
    permanent archive. ``dummy_audit_events`` and the long-term accounting
    stores are intentionally untouched (permanent records)."""
    op = await _read_operational_state()
    session["archive"] = {
        "account": op.get("account") or session.get("summary", {}).get("account") or {},
        "orders": (op.get("orders") or [])[:MAX_ARCHIVED_ORDERS],
        "positions": (op.get("positions") or [])[:MAX_ARCHIVED_POSITIONS],
        "transactions": (op.get("transactions") or [])[:MAX_ARCHIVED_TRANSACTIONS],
    }
    await _upsert_session(session)


async def _reset_operational_state(starting_capital: float, session_id: str) -> None:
    """Re-initialise the paper-engine operational store only.

    The long-term accounting / permanent stores (audit, history, watchlists,
    calendar, closed-position records) are NOT part of this reset.
    """
    db = get_db()
    account = _default_account(starting_capital)
    account["sessionId"] = session_id
    now = _now_utc()
    await db.app_settings.update_one(
        {"key": _KEY_ACCOUNT},
        {"$set": {"key": _KEY_ACCOUNT, "value": account, "category": "demo",
                  "description": "Demo Account", "updatedAt": now}},
        upsert=True,
    )
    for key in (_KEY_ORDERS, _KEY_POSITIONS, _KEY_TRANSACTIONS):
        await db.app_settings.update_one(
            {"key": key},
            {"$set": {"key": key, "value": [], "category": "demo", "updatedAt": now}},
            upsert=True,
        )


async def _close_previous_sessions(open_trading_date: str) -> None:
    """Mark any still-OPEN older sessions as CLOSED with their final archive.

    The day's final counters are recomputed from the operational store being
    archived (so the permanent record carries the real closing P&L / charges /
    order counts even if no refresh ran near midnight), then the full book —
    account, orders, positions (every stock, buy price, status), transactions —
    is folded into the closed session document. Runs at most once per session
    creation (idempotent: a closed session is never touched again). Audit /
    permanent records survive untouched.
    """
    db = get_db()
    cursor = db[COLLECTION].find(
        {"terminal": TERMINAL, "trading_date": {"$ne": open_trading_date}, "status": {"$in": ["OPEN", "PRE_OPEN"]}},
    )
    sessions = await cursor.to_list(length=None)
    for session in sessions:
        try:
            op = await _read_operational_state()
            final = _session_summary(
                session,
                op.get("account") or {},
                op.get("positions") or [],
                op.get("orders") or [],
                [],
            )
            for key, value in final.items():
                session[key] = value
        except Exception as exc:
            logger.warning("dummy session final-counter refresh skipped: %s", exc)
        session["status"] = "CLOSED"
        session["closed_at"] = _now_utc().isoformat()
        await _archive_session(session)
        logger.info("DUMMY_SESSION_CLOSED session=%s", session.get("sessionId"))
        # One-time daily alerts / stale targets from the just-closed date must
        # never re-arm on the new day (best-effort, never raises).
        try:
            from services.dummy_extras import expire_stale_daily_items
            await expire_stale_daily_items(session.get("trading_date", ""))
        except Exception as exc:
            logger.warning("daily scope transition skipped: %s", exc)


async def _apply_retention() -> int:
    """Hard cap on the session archive collection (oldest CLOSED sessions
    removed first). Permanent audit records live in their own collection and
    are never touched by this."""
    db = get_db()
    closed = await db[COLLECTION].find(
        {"terminal": TERMINAL, "status": "CLOSED"}, sort=[("trading_date", -1)],
    ).to_list(length=None)
    overflow = len(closed) - MAX_CLOSED_SESSIONS
    if overflow <= 0:
        return 0
    ids = [c["_id"] for c in closed[MAX_CLOSED_SESSIONS:]]
    res = await db[COLLECTION].delete_many({"_id": {"$in": ids}})
    return res.deleted_count


def _session_summary(session: dict, account: dict | None, positions: list,
                     orders: list, notifications: list) -> dict:
    """Compute the present-day counters for the session doc (idempotent)."""
    account = account or {}
    pos_rows = positions or []
    order_rows = orders or []
    open_positions = [p for p in pos_rows if abs(int(p.get("netQuantity") or 0)) != 0]
    filled = [o for o in order_rows if str(o.get("status") or "").upper() in ("COMPLETE", "FILLED", "EXECUTED")]
    pending = [o for o in order_rows if str(o.get("status") or "").upper() in ("OPEN", "PENDING", "TRIGGER_PENDING")]
    turnover = sum(float(o.get("averageTradedPrice") or 0) * int(o.get("filledQuantity") or 0) for o in filled)
    exposure = sum(
        abs(int(p.get("netQuantity") or 0)) * float(p.get("ltp") or 0) * (0.2 if p.get("product") == "MIS" else 1.0)
        for p in pos_rows
    )
    unread = sum(1 for n in notifications if not n.get("read"))
    return {
        "available_capital": round(float(account.get("freeMargin") or account.get("available_capital") or 0), 2),
        "used_capital": round(float(account.get("usedMargin") or 0), 2),
        "reserved_margin": round(exposure, 2),
        "realized_pnl": round(float(account.get("realizedPnl") or 0), 2),
        "unrealized_pnl": round(float(account.get("unrealizedPnl") or 0), 2),
        "today_pnl": round(float(account.get("totalPnl") or 0), 2),
        "charges": round(float(account.get("totalCharges") or 0), 2),
        "turnover": round(turnover, 2),
        "order_count": len(order_rows),
        "trade_count": len(filled),
        "position_count": len(open_positions),
        "pending_order_count": len(pending),
        "unread_notifications": unread,
    }


# --------------------------------------------------------------------------- #
# Public lifecycle API
# --------------------------------------------------------------------------- #
async def ensure_dummy_session(now: Optional[datetime] = None) -> dict:
    """Idempotent open of the current Dummy session.

    * At/after 12:00 AM IST a new calendar date means a NEW session: close +
      archive the previous session (final counters refreshed first, so the
      archive carries the day's real P&L / charges / orders), reset the
      operational store to starting capital, open the new one.
    * Within the same date the existing session is returned untouched —
      restarts never wipe within-day state.
    * A legacy ``PRE_OPEN`` document (pre-midnight-lifecycle) is promoted to
      ``OPEN`` on sight.
    """
    now = now or _now_utc()
    ist_now = now.astimezone(IST) if now.tzinfo else now.replace(tzinfo=IST)
    trading_date = session_date_for(now)
    session = await _find_session(trading_date)

    if session is not None:
        if session.get("status") == "PRE_OPEN":
            session["status"] = "OPEN"
            session["started_at"] = ist_now.isoformat()
            await _upsert_session(session)
        # Refresh present-day counters (idempotent, cheap).
        await _refresh_session_counters(session)
        return await _find_session(trading_date) or session

    await _close_previous_sessions(trading_date)
    prefs = await _get_prefs()
    starting_capital = float(prefs.get("startingCapital") or DEFAULT_STARTING_CAPITAL)

    session_id = f"DUMMY:{trading_date}"
    session = _build_session(trading_date, starting_capital, status="OPEN")
    session["sessionId"] = session_id
    session["started_at"] = ist_now.isoformat()
    session["summary"] = {"reset": {"startingCapital": starting_capital, "triggered_at": ist_now.isoformat()}}
    await _reset_operational_state(starting_capital, session_id)
    saved = await _upsert_session(session)
    await _apply_retention()
    logger.info("DUMMY_SESSION_OPENED session=%s capital=%s", session_id, starting_capital)
    return await _find_session(trading_date) or saved


async def _refresh_session_counters(session: dict) -> None:
    """Recompute present-day counters from the live operational store without
    mutating anything. Best effort, never raises into the lifecycle."""
    try:
        from services.dummy_extras import get_dummy_notifications
        db = get_db()
        account_doc = await db.app_settings.find_one({"key": _KEY_ACCOUNT})
        orders_doc = await db.app_settings.find_one({"key": _KEY_ORDERS})
        pos_doc = await db.app_settings.find_one({"key": _KEY_POSITIONS})
        notifications = await get_dummy_notifications()
        summary = _session_summary(
            session,
            (account_doc or {}).get("value"),
            (pos_doc or {}).get("value") or [],
            (orders_doc or {}).get("value") or [],
            notifications,
        )
        patch = {**summary, "updatedAt": _now_utc()}
        if session.get("started_at"):
            patch["started_at"] = session["started_at"]
        await _upsert_session({**session, **patch})
    except Exception as exc:  # non-fatal
        logger.warning("dummy session counter refresh skipped: %s", exc)


async def current_session(refresh: bool = True) -> dict:
    """Return the active Dummy session snapshot for the current IST moment."""
    session = await ensure_dummy_session()
    return await session_snapshot(session)


async def session_snapshot(session: Optional[dict] = None) -> dict:
    """Full public snapshot (used by /api/dummy/session and /state)."""
    if session is None:
        session = await current_session(refresh=False)
    allowed = {
        "sessionId", "trading_date", "terminal", "status", "started_at", "closed_at",
        "starting_capital", "available_capital", "used_capital", "reserved_margin",
        "realized_pnl", "unrealized_pnl", "today_pnl", "charges", "turnover",
        "order_count", "trade_count", "position_count", "basket_count",
        "pending_order_count", "unread_notifications", "updatedAt",
    }
    return {k: session.get(k) for k in allowed if k in session}


async def reset_dummy_session(starting_capital: float | None = None, force: bool = False) -> dict:
    """Explicitly close the current session and start a fresh one (same date).

    Used by maintenance / tests. Idempotent by construction — a second call
    simply opens the (already-open) session with the same starting capital.
    """
    now = _now_utc()
    trading_date = session_date_for(now)
    current = await _find_session(trading_date)
    if current is not None and not force:
        raise ValueError(f"session DUMMY:{trading_date} already open (use force=True to reopen)")
    await _close_previous_sessions(trading_date)
    prefs = await _get_prefs()
    capital = float(starting_capital if starting_capital is not None else (prefs.get("startingCapital") or DEFAULT_STARTING_CAPITAL))
    session = _build_session(trading_date, capital, status="OPEN")
    session["summary"] = {"reset": {"reason": "manual", "triggered_at": now.isoformat()}}
    await _reset_operational_state(capital, session["sessionId"])
    saved = await _upsert_session(session)
    await _apply_retention()
    return await _find_session(trading_date) or saved