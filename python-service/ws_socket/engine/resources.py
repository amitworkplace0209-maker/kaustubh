"""Resource monitor (RAM/CPU) and configurable priority-based degradation.

"Stop service" is a controlled lifecycle action: the degradation policy toggles
an in-process enabled flag on the consumer, it never kills OS processes and
never shuts down the FastAPI process for a low-priority consumer. P0 never gets
silently disabled.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

try:
    import psutil
except Exception:  # pragma: no cover
    psutil = None  # type: ignore[assignment]


DEFAULT_RAM_WARNING = 70.0
DEFAULT_RAM_HIGH = 80.0
DEFAULT_RAM_CRITICAL = 90.0
DEFAULT_RAM_EMERGENCY = 95.0
DEFERRED_TOO_OLD_SEC = 5.0


@dataclass
class RampMon:
    allocation_high: float = DEFAULT_RAM_HIGH
    warning_pct: float = DEFAULT_RAM_WARNING
    critical_pct: float = DEFAULT_RAM_CRITICAL
    emergency_pct: float = DEFAULT_RAM_EMERGENCY
    cpu_threshold_pct: float = 90.0

    def to_dict(self) -> dict:
        return {
            "warning_pct": self.warning_pct,
            "high_pct": self.allocation_high,
            "critical_pct": self.critical_pct,
            "emergency_pct": self.emergency_pct,
            "cpu_threshold_pct": self.cpu_threshold_pct,
        }


@dataclass
class DegradationAction:
    priority: int
    service: str
    action: str = "KEEP"  # KEEP | THROTTLE | DEGRADE | STOP
    ram_threshold: float = DEFAULT_RAM_HIGH
    enabled: bool = True

    def to_dict(self) -> dict:
        return {
            "priority": self.priority,
            "service": self.service,
            "action": self.action,
            "ram_threshold": self.ram_threshold,
            "enabled": self.enabled,
        }


DEFAULT_POLICY: list[DegradationAction] = [
    DegradationAction(1, "Data Saver", "KEEP", 90.0),
    DegradationAction(2, "AI Stream", "THROTTLE", 90.0),
    DegradationAction(3, "Watchlist", "DEGRADE", 80.0),
    DegradationAction(4, "Analytics", "STOP", 85.0),
    DegradationAction(5, "Reports", "STOP", 85.0),
]


def _current_metrics() -> tuple[float, float]:
    """Return (ram_used_pct, cpu_pct)."""
    if psutil is None:
        return 0.0, 0.0
    try:
        ram = psutil.virtual_memory()
        return float(ram.percent), float(psutil.cpu_percent(interval=None))
    except Exception:
        return 0.0, 0.0


@dataclass
class ResourceDelegate:
    """Mutable gateway the engine reads when evaluating policy."""

    provider: object = None
    prefix: str = ""


class ResourceMonitor:
    def __init__(self) -> None:
        self.thresholds = RampMon()
        self.policy: list[DegradationAction] = [
            DegradationAction(**d) for d in (p.to_dict() for p in DEFAULT_POLICY)
        ]
        self._sample: dict = {"ram_pct": 0.0, "cpu_pct": 0.0, "since": time.time()}

    def update_thresholds(self, data: dict) -> dict:
        self.thresholds.warning_pct = float(data.get("warning_pct", self.thresholds.warning_pct))
        self.thresholds.allocation_high = float(data.get("high_pct", self.thresholds.allocation_high))
        self.thresholds.critical_pct = float(data.get("critical_pct", self.thresholds.critical_pct))
        self.thresholds.emergency_pct = float(data.get("emergency_pct", self.thresholds.emergency_pct))
        self.thresholds.cpu_threshold_pct = float(data.get("cpu_threshold_pct", self.thresholds.cpu_threshold_pct))
        return self.thresholds.to_dict()

    def update_policy(self, rows: list[dict]) -> list[dict]:
        self.policy = [
            DegradationAction(
                priority=int(r.get("priority", i + 1)),
                service=r.get("service", f"service{i + 1}"),
                action=r.get("action", "KEEP"),
                ram_threshold=float(r.get("ram_threshold", 80.0)),
                enabled=bool(r.get("enabled", True)),
            )
            for i, r in enumerate(rows)
        ]
        return [p.to_dict() for p in self.policy]

    def ram_pct(self) -> float:
        self._sample = {"ram_pct": _current_metrics()[0], "cpu_pct": _current_metrics()[1], "since": time.time()}
        return float(self._sample["ram_pct"])

    def cpu_pct(self) -> float:
        return float(self._sample.get("cpu_pct", 0.0))

    def severity(self, ram_pct: float) -> str:
        t = self.thresholds
        if ram_pct >= t.emergency_pct:
            return "EMERGENCY"
        if ram_pct >= t.critical_pct:
            return "CRITICAL"
        if ram_pct >= t.allocation_high:
            return "HIGH"
        if ram_pct >= t.warning_pct:
            return "WARNING"
        return "NORMAL"

    def evaluate(self, ram_pct: float | None = None) -> dict:
        """Evaluate the degradation policy; returns actions for enabled rows
        whose threshold has been crossed.
        """
        ram_pct = float(ram_pct if ram_pct is not None else self.ram_pct())
        severity = self.severity(ram_pct)
        actions = []
        for action in self.policy:
            if not action.enabled:
                continue
            # P0 (risk/execution/system health) is never silently disabled, even
            # at EMERGENCY - only an action the operator explicitly configured.
            if action.priority == 0 and action.action == "STOP" and severity == "EMERGENCY":
                continue
            if ram_pct >= action.ram_threshold:
                actions.append(action.to_dict())
        return {"severity": severity, "ram_pct": ram_pct, "actions": actions}

    def to_dict(self) -> dict:
        return {
            "thresholds": self.thresholds.to_dict(),
            "policy": [p.to_dict() for p in self.policy],
            "current": self._sample,
        }