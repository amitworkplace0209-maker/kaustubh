"""Target Engine — monetary-value targets for the Dummy terminal.

A target is a monetary value (virtual coins in Dummy mode) the user aims to
reach on a position. The engine tracks the current projected value of a
position from its live LTP and reports how far the target is. Targets are
attached to a position, not an order, and are enforced only by the terminal UI
(they never move money).
"""
from __future__ import annotations
import logging
import time
from typing import Any

from brokers.models import safe_float

_log = logging.getLogger("target_engine")

_TARGETS: dict[str, dict] = {}   # key: position_key -> target


def _key(terminal: str, symbol: str, product: str = "MIS") -> str:
    return f"{terminal}:{symbol.upper()}:{product.upper()}"


async def set_target(terminal: str, symbol: str, target_value: float, product: str = "MIS") -> dict:
    value = safe_float(target_value)
    if value <= 0:
        raise ValueError("target value must be positive")
    key = _key(terminal, symbol, product)
    entry = {
        "terminal": terminal,
        "symbol": symbol.upper(),
        "product": product.upper(),
        "targetValue": round(value, 2),
        "createdAt": time.time(),
    }
    _TARGETS[key] = entry
    return entry


async def get_target(terminal: str, symbol: str, product: str = "MIS") -> dict | None:
    return _TARGETS.get(_key(terminal, symbol, product))


async def get_all(terminal: str) -> list[dict]:
    """All engine targets belonging to one terminal (empty list when none)."""
    prefix = f"{(terminal or '').lower()}:"
    return [entry for key, entry in _TARGETS.items() if key.startswith(prefix)]


async def remove_target(terminal: str, symbol: str, product: str = "MIS") -> bool:
    return _TARGETS.pop(_key(terminal, symbol, product), None) is not None


async def evaluate(terminal: str, position: dict, product: str = "MIS") -> dict | None:
    """Report target progress for one canonical position row."""
    symbol = str(position.get("symbol") or "").upper()
    if not symbol:
        return None
    target = await get_target(terminal, symbol, product)
    if target is None:
        return None
    ltp = safe_float(position.get("ltp"))
    qty = abs(int(position.get("netQuantity", 0) or 0))
    current_value = ltp * qty
    target_value = target["targetValue"]
    target["currentValue"] = round(current_value, 2)
    target["achieved"] = current_value >= target_value
    target["remaining"] = round(max(0.0, target_value - current_value), 2)
    return target