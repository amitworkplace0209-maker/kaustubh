"""Manual Market Watch pins (persisted in MongoDB).

Manual pins are user-driven symbols pinned on the Market Watch page. They are
distinct from the automatic Gainer/Loser pins produced by the ranking engine:
a symbol can be pinned manually and still appear in an automatic pin list.

Pins are trading-day-scoped: every document records the IST ``tradingDate`` it
was created on, and reads only return pins for the current trading date, so a
pin naturally stops applying on the next trading day without a delete job (the
stale documents simply stay dormant in the collection).

The service never fabricates instrument metadata — ``add_pin`` accepts a caller
resolved registry row (token/symbol/name/exchange/segment).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from database.connection import get_db
from services.market_calendar import snapshot as market_calendar_snapshot

logger = logging.getLogger("app")

COLLECTION = "market_watch_manual_pins"

MAX_MANUAL_PINS = 20


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _to_pin(doc: dict) -> dict:
    return {
        "token": str(doc.get("token") or ""),
        "symbol": doc.get("symbol") or "",
        "name": doc.get("name") or "",
        "exchange": doc.get("exchange") or "nse_cm",
        "segment": doc.get("segment") or "EQUITY",
        "tradingDate": doc.get("tradingDate") or "",
        "pinnedAt": _iso(doc.get("pinnedAt")),
        "createdAt": _iso(doc.get("createdAt")),
    }


def _trading_date() -> str:
    try:
        return str(market_calendar_snapshot().get("market_date") or "")
    except Exception:
        return ""


async def list_pins() -> list[dict]:
    """Manual pins for the current trading day (newest first)."""
    trading_date = _trading_date()
    try:
        db = get_db()
        cursor = db[COLLECTION].find({"tradingDate": trading_date}).sort("pinnedAt", -1)
        docs = await cursor.to_list(length=MAX_MANUAL_PINS + 50)
    except Exception as exc:
        logger.debug("manual pins list failed: %s", exc)
        return []
    return [_to_pin(d) for d in docs]


async def add_pin(
    token: str,
    *,
    symbol: str = "",
    name: str = "",
    exchange: str = "nse_cm",
    segment: str = "EQUITY",
) -> dict:
    """Insert one manual pin for the current trading day (idempotent per token)."""
    token = str(token or "").strip()
    if not token:
        return {"ok": False, "reason": "missing_token"}
    trading_date = _trading_date()
    if not trading_date:
        return {"ok": False, "reason": "no_trading_date"}
    try:
        db = get_db()
        existing = await db[COLLECTION].find_one({"tradingDate": trading_date, "token": token})
        if existing:
            return {"ok": True, "alreadyPinned": True, "pin": _to_pin(existing)}
        count = await db[COLLECTION].count_documents({"tradingDate": trading_date})
        if count >= MAX_MANUAL_PINS:
            return {"ok": False, "reason": "pin_limit_reached", "max": MAX_MANUAL_PINS}
        now = datetime.now(timezone.utc)
        doc = {
            "token": token,
            "symbol": symbol or "",
            "name": name or "",
            "exchange": exchange or "nse_cm",
            "segment": segment or "EQUITY",
            "tradingDate": trading_date,
            "pinnedAt": now,
            "createdAt": now,
        }
        await db[COLLECTION].insert_one(doc)
        return {"ok": True, "pin": _to_pin(doc)}
    except Exception as exc:
        logger.debug("manual pin add failed: %s", exc)
        return {"ok": False, "reason": "persist_failed"}


async def remove_pin(token: str) -> dict:
    """Remove one manual pin for the current trading day."""
    token = str(token or "").strip()
    trading_date = _trading_date()
    if not token:
        return {"ok": False, "reason": "missing_token"}
    try:
        db = get_db()
        result = await db[COLLECTION].delete_many({"tradingDate": trading_date, "token": token})
        return {"ok": True, "removed": result.deleted_count}
    except Exception as exc:
        logger.debug("manual pin remove failed: %s", exc)
        return {"ok": False, "reason": "persist_failed"}


async def clear_pins() -> dict:
    """Remove all manual pins for the current trading day."""
    trading_date = _trading_date()
    try:
        db = get_db()
        result = await db[COLLECTION].delete_many({"tradingDate": trading_date})
        return {"ok": True, "removed": result.deleted_count}
    except Exception as exc:
        logger.debug("manual pins clear failed: %s", exc)
        return {"ok": False, "reason": "persist_failed"}


async def is_pinned(token: str) -> bool:
    """Whether the token has a manual pin for the current trading day."""
    token = str(token or "").strip()
    trading_date = _trading_date()
    if not token or not trading_date:
        return False
    try:
        db = get_db()
        doc = await db[COLLECTION].find_one(
            {"tradingDate": trading_date, "token": token}, {"_id": 0, "token": 1}
        )
        return doc is not None
    except Exception:
        return False