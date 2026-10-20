"""Engine configuration schema — declarative, validated, writable.

Why this exists
---------------
Every engine already publishes a live ``configSummary`` (its real running
values), but before this module those values were **read-only**: the Service
Control Center could start/stop an engine and read its knobs, yet an operator
had no way to change any of them. Only four engines (risk, storage,
session-manager, db-writer) had a bespoke write endpoint, each with its own
shape.

This module gives every engine ONE uniform way to declare its settings, and
the registry a single validated write path:

  * ``ConfigField`` declares one setting — its UI label, type, bounds, unit and
    help text, plus the ``summary`` key it maps to in the engine's live
    ``configSummary``.
  * A field is **editable** only when it maps to a real key in
    ``settings_service.DEFAULTS``. Computed outputs (instrument counts,
    collection names, feed handlers) declare ``editable=False`` so the UI shows
    them as facts rather than offering an input that would do nothing.
  * Writes go through ``settings_service.set_setting`` (validated + persisted to
    Mongo ``app_settings``) and then the runtime TTL cache is refreshed, so a
    value the engine consumes through ``rt_*`` accessors takes effect live.
    Fields whose engine only reads at startup are reported as
    ``restartRequired`` instead of pretending to be live.

The honesty rule is the same one the rest of the project follows: never show a
control that silently does nothing, and never report a value as applied when
the engine did not take it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Field types the generic settings form knows how to render.
CONFIG_TYPES = ("number", "boolean", "select", "text", "json")


@dataclass(frozen=True)
class ConfigField:
    """One engine setting.

    ``key``
        Settings-store key. Required for editable fields; ``""`` for a
        read-only computed output.
    ``summary``
        Key inside the engine's live ``configSummary`` that this setting drives.
        This is what makes the UI show the value the engine is *actually*
        running with, not the value that was typed.
    """

    key: str
    label: str
    summary: str = ""
    type: str = "number"
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: str = ""
    options: tuple[Any, ...] = ()
    help: str = ""
    group: str = "General"
    editable: bool = True
    restart_required: bool = False

    def to_dict(self, value: Any, applied: Any = None, live: bool = True) -> dict:
        """Render one field for the UI.

        ``value`` is the CURRENT effective value — the live one until something
        is written through this channel, then the last write. ``applied`` is
        always what the engine reports, and ``pending`` is true when the two
        differ, i.e. a write landed but the engine has not taken it up yet. That
        distinction is what lets the form say "saved, pending restart" instead of
        claiming a change took effect when it did not.
        """
        current = value if value is not None else applied
        return {
            "key": self.key,
            "label": self.label,
            "summary": self.summary or self.key,
            "type": self.type,
            "min": self.min,
            "max": self.max,
            "step": self.step,
            "unit": self.unit,
            "options": list(self.options),
            "help": self.help,
            "group": self.group,
            "editable": self.editable,
            "restartRequired": self.restart_required and not live,
            "value": current,
            "applied": applied,
            "pending": value is not None and applied is not None and value != applied,
        }


def read_only(summary: str, label: str, **kwargs: Any) -> ConfigField:
    """A computed engine output — displayed, never editable."""
    kwargs.setdefault("type", "text")
    return ConfigField(key="", label=label, summary=summary, editable=False, **kwargs)


def validate_patch(fields: tuple[ConfigField, ...], patch: dict) -> tuple[dict, dict]:
    """Validate an incoming patch against the declared schema.

    Returns ``(clean, errors)`` where ``clean`` holds only accepted fields.
    Validation is deliberately strict: an unknown key or an out-of-range value is
    reported per field rather than silently dropped, so the UI can tell the
    operator exactly which control was refused.
    """
    by_key = {f.key: f for f in fields if f.key and f.editable}
    clean: dict[str, Any] = {}
    errors: dict[str, str] = {}

    for raw_key, raw_value in (patch or {}).items():
        spec = by_key.get(raw_key)
        if spec is None:
            known = [f.key for f in fields if f.editable and f.key]
            errors[raw_key] = (
                f"'{raw_key}' is not an editable setting for this engine"
                + (f" (editable: {', '.join(known)})" if known else "")
            )
            continue

        try:
            clean[raw_key] = _coerce(spec, raw_value)
        except ValueError as exc:
            errors[raw_key] = str(exc)

    return clean, errors


def _coerce(spec: ConfigField, value: Any) -> Any:
    """Coerce + bound-check one value against its field spec."""
    if spec.type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().lower() in ("true", "1", "yes", "on"):
            return True
        if isinstance(value, str) and value.strip().lower() in ("false", "0", "no", "off"):
            return False
        raise ValueError(f"{spec.label} must be true or false")

    if spec.type == "select":
        if spec.options and value not in spec.options:
            raise ValueError(
                f"{spec.label} must be one of {', '.join(str(o) for o in spec.options)}"
            )
        return value

    if spec.type == "number":
        if isinstance(value, bool):
            raise ValueError(f"{spec.label} must be a number")
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{spec.label} must be a number")
        if spec.min is not None and num < spec.min:
            raise ValueError(f"{spec.label} must be >= {spec.min:g}")
        if spec.max is not None and num > spec.max:
            raise ValueError(f"{spec.label} must be <= {spec.max:g}")
        # Keep whole numbers whole so a persisted int does not come back 5.0.
        if num.is_integer() and (spec.step is None or float(spec.step).is_integer()):
            return int(num)
        return num

    # text / json are stored verbatim (the settings store validates the rest).
    return value