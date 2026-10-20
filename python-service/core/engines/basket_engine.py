"""Basket Engine — place several orders with per-order risk checks.

Each order in a basket goes through the SAME Risk → Audit → Adapter path as a
single order (no back-door to the adapter). Results are per-order; the basket
is "ok" only when every submitted order was accepted.
"""
from __future__ import annotations
from typing import Any

from brokers.manager import active_terminal
from core.engines import order_engine


async def place_basket(terminal: str | None = None, orders: list[dict] | None = None) -> dict:
    terminal = terminal or active_terminal()
    results = []
    for i, order in enumerate(orders or []):
        order = dict(order or {})
        order.setdefault("exchange", "nse_cm")
        order.setdefault("product", "MIS")
        order.setdefault("order_type", "MKT")
        result = await order_engine.place(terminal, order)
        result["index"] = i
        results.append(result)

    accepted = [r for r in results if r.get("accepted")]
    return {
        "ok": len(accepted) == len(results) and bool(results),
        "terminal": terminal,
        "total": len(results),
        "accepted": len(accepted),
        "results": results,
    }