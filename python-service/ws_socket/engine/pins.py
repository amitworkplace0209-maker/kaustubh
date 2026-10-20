"""Data-monitoring pin management.

Pins are high-priority monitoring routes with a source (manual / AI / automatic
Top-5), an optional expiry, a field profile, consumer destinations and a
reason. Because the pin add/remove logic feeds the Subscription Registry, a pin
that is removed never unsubscribes an instrument still required by another
consumer — only the high-priority route is dropped.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

TOP5_PIN_SOURCE = "auto_top5"  # automatic Top-5 monitor
AI_PIN_SOURCE = "ai"
MANUAL_PIN_SOURCE = "manual"


@dataclass
class Pin:
    instrument_key: str  # "<exchange_segment>|<instrument_token>"
    symbol: str
    source: str = MANUAL_PIN_SOURCE
    priority: int = 1
    profile_id: str = "PINNED_HIGH"
    consumers: list[str] = None  # type: ignore[assignment]
    reason: str = ""
    expires_at: float | None = None  # epoch; None = never
    enabled: bool = True
    created_at: float = 0.0
    updated_at: float = 0.0

    def __post_init__(self) -> None:
        if self.consumers is None:
            self.consumers = ["ai_pinned"]

    @property
    def expired(self) -> bool:
        return bool(self.expires_at is not None and time.time() > self.expires_at)

    def to_dict(self) -> dict:
        return {
            "instrument_key": self.instrument_key,
            "symbol": self.symbol,
            "source": self.source,
            "priority": self.priority,
            "profile_id": self.profile_id,
            "consumers": list(self.consumers),
            "reason": self.reason,
            "expires_at": self.expires_at,
            "enabled": self.enabled,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Pin":
        return cls(
            instrument_key=data.get("instrument_key", ""),
            symbol=data.get("symbol", ""),
            source=data.get("source", MANUAL_PIN_SOURCE),
            priority=int(data.get("priority", 1)),
            profile_id=data.get("profile_id", "PINNED_HIGH"),
            consumers=list(data.get("consumers") or ["ai_pinned"]),
            reason=data.get("reason", ""),
            expires_at=data.get("expires_at"),
            enabled=bool(data.get("enabled", True)),
            created_at=float(data.get("created_at") or 0),
            updated_at=float(data.get("updated_at") or 0),
        )


class PinManager:
    """Owns the pin set and mirrors it into a consumer intent named ``pin:<id>``.

    A pin removal only drops that pin's intent; the Subscription Registry keeps
    the instrument subscribed if any other consumer still wants it.
    """

    def __init__(self) -> None:
        self._pins: dict[str, Pin] = {}

    def list(self) -> list[dict]:
        return [p.to_dict() for p in self._pins.values()]

    def get(self, instrument_key: str) -> dict | None:
        pin = self._pins.get(instrument_key)
        return pin.to_dict() if pin else None

    def set(self, instrument_key: str, symbol: str, *, source: str = MANUAL_PIN_SOURCE, priority: int = 1,
            profile_id: str = "PINNED_HIGH", consumers: list[str] | None = None, reason: str = "",
            expires_at: float | None = None) -> dict:
        existing = self._pins.get(instrument_key)
        now = time.time()
        pin = Pin(
            instrument_key=instrument_key,
            symbol=symbol,
            source=source,
            priority=priority,
            profile_id=profile_id,
            consumers=list(consumers or (existing.consumers if existing else ["ai_pinned"])),
            reason=reason,
            expires_at=expires_at,
            enabled=True,
            created_at=existing.created_at if existing else now,
            updated_at=now,
        )
        self._pins[instrument_key] = pin
        return pin.to_dict()

    def unset(self, instrument_key: str) -> bool:
        return self._pins.pop(instrument_key, None) is not None

    def set_top5(self, symbols: list[dict], reason: str = "automatic top-5 monitor") -> list[str]:
        """Replace the automatic Top-5 pin set; returns changed keys."""
        wanted_keys = {f"{t.get('exchange_segment')}|{t.get('instrument_token')}" for t in symbols}
        previous = {k for k, p in self._pins.items() if p.source == TOP5_PIN_SOURCE}
        changed: list[str] = []
        for key in previous - wanted_keys:
            if self.unset(key):
                changed.append(key)
        for token in symbols:
            key = f"{token.get('exchange_segment')}|{token.get('instrument_token')}"
            if key not in self._pins or self._pins[key].source != TOP5_PIN_SOURCE:
                self.set(key, token.get("symbol", ""), source=TOP5_PIN_SOURCE, priority=1,
                         profile_id="PINNED_HIGH", consumers=["ai_pinned"], reason=reason)
                changed.append(key)
        return changed

    def expire_sweep(self) -> list[str]:
        """Remove expired pins; returns removed keys."""
        removed = [k for k, p in self._pins.items() if p.expired]
        for key in removed:
            self._pins.pop(key, None)
        return removed

    def replace_all(self, pins: list[dict]) -> None:
        self._pins = {p["instrument_key"]: Pin.from_dict(p) for p in pins}

    def intents(self) -> list[dict]:
        """Consumer intent rows for the Subscription Registry."""
        out = []
        for key, pin in self._pins.items():
            if not pin.enabled or pin.expired:
                continue
            segment, _, token = key.partition("|")
            out.append({
                "consumer": f"pin:{key}",
                "exchange_segment": segment,
                "instrument_token": token,
                "symbol": pin.symbol,
            })
        return out