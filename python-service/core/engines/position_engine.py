"""Position Engine — canonical positions for the ACTIVE terminal.

Fetches the real adapter output and normalizes every row through the shared
P&L engine so the terminal UI gets one shape for Kotak, Shoonya and Dummy.
Never fabricates rows: when the adapter cannot serve (not logged in), a clear
error is raised instead of empty-but-invented books.
"""
from __future__ import annotations
from typing import Any

from brokers.manager import get_adapter
from brokers.models import BrokerError
from core.engines.pnl_engine import normalize_position, compute_totals
from core.engines.target_engine import evaluate


async def get_positions(terminal: str) -> dict:
    adapter = get_adapter(terminal)
    if not adapter.is_logged_in:
        raise BrokerError("NOT_LOGGED_IN", f"{adapter.broker_name} session required for positions")

    raw = await adapter.positions()
    rows = raw.get("data") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        rows = []

    canonical = []
    for idx, row in enumerate(rows or []):
        pos = normalize_position(row, index=idx)
        # Live-target overlay (dummy + real terminals share the same shape).
        try:
            target = await evaluate(terminal, pos)
            if target is not None:
                pos["target"] = target
        except Exception:
            pass
        canonical.append(pos)

    return {
        "data": canonical,
        "totals": compute_totals(canonical),
        "isDemo": bool((raw or {}).get("isDemo")) or adapter.mode == "dummy",
        "stat": "ok",
    }