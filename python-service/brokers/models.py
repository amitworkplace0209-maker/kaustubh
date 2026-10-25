"""Common broker domain models + error contract.

Every adapter may return broker-native payloads, but the common trading core
and the terminal API speak ONLY these canonical shapes. Broker-specific fields
go under ``metadata``; nothing broker-specific is required by consumers.
"""
from __future__ import annotations
from typing import Any


class BrokerError(Exception):
    """A normalized broker failure.

    ``code`` uses an honest, closed vocabulary:
        NOT_LOGGED_IN, SESSION_EXPIRED, AUTH_FAILED, ORDER_REJECTED,
        ORDER_TIMEOUT, INVALID_REQUEST, INSUFFICIENT_MARGIN,
        BROKER_UNAVAILABLE, UNSUPPORTED, UNKNOWN
    """

    CODES = {
        "NOT_LOGGED_IN",
        "SESSION_EXPIRED",
        "AUTH_FAILED",
        "ORDER_REJECTED",
        "ORDER_TIMEOUT",
        "INVALID_REQUEST",
        "INSUFFICIENT_MARGIN",
        "BROKER_UNAVAILABLE",
        "UNSUPPORTED",
        "UNKNOWN",
    }

    def __init__(self, code: str, message: str, *, meta: dict[str, Any] | None = None) -> None:
        code = code if code in self.CODES else "UNKNOWN"
        super().__init__(message)
        self.code = code
        self.message = message
        self.meta = dict(meta or {})

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "meta": self.meta}


# ---- canonical order statuses (broker-agnostic) ----------------------------
ORDER_STATUSES = {
    "OPEN": "OPEN",
    "PENDING": "PENDING",
    "COMPLETE": "COMPLETE",
    "REJECTED": "REJECTED",
    "CANCELLED": "CANCELLED",
    "PARTIALLY_FILLED": "PARTIALLY_FILLED",
    "TRIGGER_PENDING": "TRIGGER_PENDING",
}


def normalize_status(raw: Any) -> str:
    """Map a broker-native order status into the canonical set."""
    text = str(raw or "").upper()
    if text in ORDER_STATUSES:
        return text
    mapping = {
        "NOT_TRADED": "PENDING",
        "NOT_TRAADED": "PENDING",
        "NEW": "PENDING",
        "PENDING": "PENDING",
        "OPEN": "OPEN",
        "TRIGGER_PENDING": "TRIGGER_PENDING",
        "OPEN_PENDING": "TRIGGER_PENDING",
        "TRIGGERED": "PENDING",
        "ACK": "PENDING",
        "COMPLETE": "COMPLETE",
        "COMPLETED": "COMPLETE",
        "FILLED": "COMPLETE",
        "FULLY_FILLED": "COMPLETE",
        "TRADED": "COMPLETE",
        "PARTIALLY_FILLED": "PARTIALLY_FILLED",
        "PARTFULL": "PARTIALLY_FILLED",
        "REJECTED": "REJECTED",
        "REJECT": "REJECTED",
        "CANCELED": "CANCELLED",
        "CANCELLED": "CANCELLED",
        "CANCELLED_PENDING": "PENDING",
    }
    return mapping.get(text, "PENDING" if text and "PEND" in text else "OPEN")


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(str(value).strip().replace(",", ""))
    except (ValueError, TypeError):
        return default