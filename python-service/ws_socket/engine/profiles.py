"""Field Profile Manager.

A profile is a named, configurable selection of canonical fields. Built-in
profiles exist for every consumer type; custom profiles are validated against
the master 344-field schema so a user can never select a field the canonical
stream does not carry, and can never mistake a REST-only / derived field for a
Kotak-WebSocket-direct field.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ws_socket.engine.fields import (
    DIRECT_WS,
    DERIVED,
    NOT_PROVIDED,
    NOT_VERIFIED,
    OTHER_API,
    QUOTE_REST_ONLY,
    TARGET_LABEL,
    WS_CONDITIONAL,
    _FIELDS,
)
from ws_socket.engine.canonical import FULL_WS_FIELDS

# Default (approximate) consumer payloads, built from real canonical fields only.
WATCHLIST_LIGHT_FIELDS: list[str] = [
    "ltp", "ltq", "open", "high", "low", "prev_close", "volume", "net_change",
    "net_change_pct", "avg_price", "yearly_high", "yearly_low",
    "last_trade_time", "buy", "sell",
]

PINNED_HIGH_FIELDS: list[str] = [
    "ltp", "ltq", "open", "high", "low", "prev_close", "avg_price", "volume",
    "total_buy_quantity", "total_sell_quantity", "open_interest", "net_change",
    "net_change_pct", "upper_circuit_limit", "lower_circuit_limit",
    "yearly_high", "yearly_low", "last_trade_time", "last_update_time", "buy", "sell",
]

POSITION_CRITICAL_FIELDS: list[str] = [
    "ltp", "ltq", "open", "high", "low", "prev_close", "volume", "net_change",
    "net_change_pct", "last_trade_time", "buy", "sell",
]

ALERT_MINIMAL_FIELDS: list[str] = [
    "ltp", "open", "high", "low", "prev_close", "volume", "net_change_pct",
    "upper_circuit_limit", "lower_circuit_limit", "last_trade_time",
]


@dataclass
class FieldProfile:
    profile_id: str
    profile_name: str
    consumer_type: str
    enabled_fields: list[str] = field(default_factory=list)
    priority: int = 2
    max_frequency: float = 0.0  # Hz; 0 = no cap
    enabled: bool = True
    created_at: float = 0.0
    updated_at: float = 0.0
    builtin: bool = False

    def to_dict(self) -> dict:
        return {
            "profile_id": self.profile_id,
            "profile_name": self.profile_name,
            "consumer_type": self.consumer_type,
            "enabled_fields": list(self.enabled_fields),
            "priority": self.priority,
            "max_frequency": self.max_frequency,
            "enabled": self.enabled,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "builtin": self.builtin,
        }

    def select(self, fields: dict) -> dict:
        selected = {}
        for name in self.enabled_fields:
            if name == "buy":
                selected["buy"] = fields.get("buy")
                continue
            if name == "sell":
                selected["sell"] = fields.get("sell")
                continue
            if name in fields:
                selected[name] = fields[name]
        return selected


def build_builtin_profiles() -> list[FieldProfile]:
    now = time.time()
    full = list(FULL_WS_FIELDS)
    return [
        FieldProfile("FULL_RAW", "Full raw canonical", "DATA_SAVER", enabled_fields=full, priority=0, created_at=now, updated_at=now, builtin=True),
        FieldProfile("SUBSCRIBED_FULL", "Subscribed full", "SUBSCRIBED", enabled_fields=full, priority=1, created_at=now, updated_at=now, builtin=True),
        FieldProfile("WATCHLIST_LIGHT", "Watchlist light", "WATCHLIST", enabled_fields=WATCHLIST_LIGHT_FIELDS, priority=3, created_at=now, updated_at=now, builtin=True),
        FieldProfile("PINNED_HIGH", "Pinned high", "PINNED", enabled_fields=PINNED_HIGH_FIELDS, priority=1, created_at=now, updated_at=now, builtin=True),
        FieldProfile("POSITION_CRITICAL", "Position critical", "ACTIVE_POSITION", enabled_fields=POSITION_CRITICAL_FIELDS, priority=0, created_at=now, updated_at=now, builtin=True),
        FieldProfile("AI_HIGH", "AI high", "AI", enabled_fields=PINNED_HIGH_FIELDS, priority=1, created_at=now, updated_at=now, builtin=True),
        FieldProfile("ALERT_MINIMAL", "Alert minimal", "ALERT", enabled_fields=ALERT_MINIMAL_FIELDS, priority=2, created_at=now, updated_at=now, builtin=True),
    ]


def field_availability(field_name: str) -> str:
    """Master-schema status for a field (for honest UI labelling).

    Returns one of the verification statuses, or 'UNKNOWN_FIELD'.
    """
    if field_name in ("buy", "sell"):
        return DIRECT_WS
    from ws_socket.engine.fields import _ADDITIONAL
    for entry in _FIELDS:
        if entry.field == field_name:
            return entry.status
    for entry in _ADDITIONAL:
        if entry.field == field_name:
            return entry.status
    return "UNKNOWN_FIELD"


def field_source_label(field_name: str) -> str:
    """Short UI label per schema status."""
    return {
        DIRECT_WS: "Direct Kotak WS field",
        WS_CONDITIONAL: "Conditional / feed-level dependent",
        QUOTE_REST_ONLY: "Quote REST field (not WS)",
        OTHER_API: "Available via other Kotak API",
        DERIVED: "Derived (future Feature Engine)",
        TARGET_LABEL: "Training target label",
        NOT_PROVIDED: "Not provided by Kotak WS",
        NOT_VERIFIED: "Not yet verified",
    }.get(field_availability(field_name), "Unsupported field")


class FieldProfileStore:
    def __init__(self) -> None:
        self._profiles: dict[str, FieldProfile] = {}
        for profile in build_builtin_profiles():
            self._profiles[profile.profile_id] = profile

    def list(self) -> list[dict]:
        return [p.to_dict() for p in self._profiles.values()]

    def get(self, profile_id: str) -> FieldProfile | None:
        return self._profiles.get(profile_id)

    def create(self, data: dict) -> dict:
        profile_id = data.get("profile_id") or _slug(data.get("profile_name") or f"profile{len(self._profiles) + 1}")
        profile = FieldProfile(
            profile_id=profile_id,
            profile_name=data.get("profile_name", profile_id),
            consumer_type=data.get("consumer_type", "CUSTOM"),
            enabled_fields=self._validate_fields(data.get("enabled_fields") or []),
            priority=int(data.get("priority", 2)),
            max_frequency=float(data.get("max_frequency", 0)),
            enabled=bool(data.get("enabled", True)),
            created_at=time.time(),
            updated_at=time.time(),
            builtin=False,
        )
        self._profiles[profile_id] = profile
        return profile.to_dict()

    def update(self, profile_id: str, data: dict) -> dict | None:
        profile = self._profiles.get(profile_id)
        if profile is None:
            return None
        if data.get("enabled_fields") is not None:
            profile.enabled_fields = self._validate_fields(data["enabled_fields"])
        profile.profile_name = data.get("profile_name", profile.profile_name)
        profile.consumer_type = data.get("consumer_type", profile.consumer_type)
        profile.priority = int(data.get("priority", profile.priority))
        profile.max_frequency = float(data.get("max_frequency", profile.max_frequency))
        profile.enabled = bool(data.get("enabled", profile.enabled))
        profile.updated_at = time.time()
        return profile.to_dict()

    def delete(self, profile_id: str) -> bool:
        profile = self._profiles.get(profile_id)
        if profile is None or profile.builtin:
            return False
        del self._profiles[profile_id]
        return True

    def replace_all(self, profiles: list[dict]) -> None:
        self._profiles = {}
        for item in profiles:
            profile = FieldProfile(
                profile_id=item.get("profile_id", ""),
                profile_name=item.get("profile_name", ""),
                consumer_type=item.get("consumer_type", "CUSTOM"),
                enabled_fields=item.get("enabled_fields") or [],
                priority=int(item.get("priority", 2)),
                max_frequency=float(item.get("max_frequency", 0) or 0),
                enabled=bool(item.get("enabled", True)),
                created_at=float(item.get("created_at") or 0),
                updated_at=float(item.get("updated_at") or 0),
                builtin=bool(item.get("builtin", False)),
            )
            self._profiles[profile.profile_id] = profile

    def _validate_fields(self, fields: list[str]) -> list[str]:
        allowed = set(FULL_WS_FIELDS)
        unknown = [f for f in fields if f not in allowed]
        if unknown:
            raise ValueError(f"Unsupported fields for WS profiles: {', '.join(sorted(unknown))}")
        return list(dict.fromkeys(fields))


def _slug(name: str) -> str:
    return "".join(ch for ch in name.strip().lower().replace(" ", "_") if ch.isalnum() or ch == "_")