from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any


_SERVICES = (
    "fastapi",
    "mongo",
    "kotak",
    "websocket",
    "scheduler",
    "tick_buffer",
    "internet",
)

_status: dict[str, dict[str, Any]] = {
    service: {
        "status": "unknown",
        "lastChecked": None,
        "lastChanged": None,
        "latencyMs": None,
        "error": None,
    }
    for service in _SERVICES
}

_lock = asyncio.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def set_status(
    service: str,
    status: str,
    *,
    latency_ms: float | None = None,
    error: str | None = None,
) -> bool:
    """
    Update one service status.

    Returns True only when the state actually changed.
    """
    if service not in _status:
        raise ValueError(f"Unknown service: {service}")

    if status not in {"online", "offline", "degraded", "unknown"}:
        raise ValueError(f"Invalid status: {status}")

    async with _lock:
        current = _status[service]
        changed = current["status"] != status

        current["status"] = status
        current["lastChecked"] = _now()
        current["latencyMs"] = latency_ms
        current["error"] = error

        if changed:
            current["lastChanged"] = current["lastChecked"]

        return changed


async def get_status() -> dict[str, dict[str, Any]]:
    """Return a snapshot of all service statuses."""
    async with _lock:
        return {
            service: data.copy()
            for service, data in _status.items()
        }