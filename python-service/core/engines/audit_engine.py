"""Audit Engine — append-only execution trail for every order decision.

Records WHAT was requested, WHICH risk checks ran, whether it was accepted or
rejected, and the ordered action — for every terminal (including Dummy and any
future AI executor). NEVER stores credentials, tokens or passwords.
"""
from __future__ import annotations
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any

_log = logging.getLogger("audit_engine")

_RECENT: list[dict] = []
_RECENT_MAX = 500


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _persist(doc: dict) -> None:
    try:
        from database.connection import get_db
        db = get_db()
        await db.audit_trail.insert_one(doc)
    except Exception as exc:  # pragma: no cover - DB may be down in tests
        _log.debug("audit persist skipped: %s", exc)


def _safe_payload(order: dict | None) -> dict:
    """Reduce an order intent to SAFE audit fields (no secrets)."""
    if not isinstance(order, dict):
        return {}
    allowed = (
        "terminal", "symbol", "token", "exchange", "transaction_type",
        "product", "order_type", "quantity", "price", "trigger_price", "order_id",
    )
    return {k: order.get(k) for k in allowed if order.get(k) is not None}


async def record_decision(
    *,
    terminal: str,
    decision: Any,
    order: dict | None = None,
    reason: str = "risk_validation",
) -> dict:
    """Record one execution decision (pre-adapter)."""
    payload = _safe_payload(order)
    doc = {
        "event_id": f"aud_{uuid.uuid4().hex[:16]}",
        "ts": _iso(),
        "terminal": terminal,
        "kind": "decision",
        "reason": reason,
        "accepted": bool(getattr(decision, "accepted", False)),
        "risk_reasons": list(getattr(decision, "reasons", [])),
        "order": payload,
    }
    ring(doc)
    await _persist(doc)
    return doc


async def record_action(
    *,
    terminal: str,
    action: str,
    order: dict | None = None,
    status: str = "submitted",
    broker_response: dict | None = None,
    error: str | None = None,
) -> dict:
    """Record an adapter action (place / modify / cancel / square_off)."""
    doc = {
        "event_id": f"aud_{uuid.uuid4().hex[:16]}",
        "ts": _iso(),
        "terminal": terminal,
        "kind": "action",
        "action": action,
        "status": status,
        "order": _safe_payload(order),
        "broker_stat": _broker_stat(broker_response),
        "error": error,
    }
    ring(doc)
    await _persist(doc)
    return doc


def _broker_stat(broker_response: dict | None) -> str | None:
    if not isinstance(broker_response, dict):
        return None
    stat = broker_response.get("stat")
    if isinstance(stat, str):
        return stat
    data = broker_response.get("data")
    if isinstance(data, dict) and data.get("stat"):
        return str(data["stat"])
    return None


def ring(doc: dict) -> None:
    _RECENT.append(doc)
    del _RECENT[: max(0, len(_RECENT) - _RECENT_MAX)]


def recent_audit(limit: int = 50, terminal: str | None = None) -> list[dict]:
    entries = _RECENT
    if terminal:
        entries = [e for e in entries if e.get("terminal") == terminal]
    return entries[-limit:][::-1]


async def recent_from_db(terminal: str | None = None, limit: int = 50) -> list[dict]:
    try:
        from database.connection import get_db
        db = get_db()
        query = {"terminal": terminal} if terminal else {}
        cursor = db.audit_trail.find(query).sort("ts", -1).limit(limit)
        docs = [doc async for doc in cursor]
        for doc in docs:
            if "_id" in doc:
                doc["_id"] = str(doc["_id"])
        return docs
    except Exception:
        return recent_audit(limit, terminal)