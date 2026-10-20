"""True end-to-end pipeline latency instrumentation.

The service records real hop-to-hop propagation latency for ticks as they flow

    broker -> WS engine -> feature engine -> Connection Manager -> UI
    broker -> WS engine -> Connection Manager -> DB Writer -> MongoDB

using the process-local wall-clock ``received_at`` stamped on every tick the
moment the broker socket handler receives it (``ws_socket.engine.engine``).

This is deliberately **separate** from ``feedAge`` (a.k.a. the legacy
``latency`` / ``feedLatencyMs`` metric). ``feedAge`` is
``received_at - broker_timestamp`` where ``broker_timestamp`` is the broker's
``last_trade_time`` — i.e. "how long since the instrument last traded". That is
a *data freshness* signal that grows for illiquid instruments (and can even go
negative on broker clock skew); it is not transport latency. Both are reported
so neither is hidden.

Every sample is a REAL measurement; nothing is fabricated. Negative or absurd
deltas are rejected so a clock skew can never masquerade as a latency sample.
"""
from __future__ import annotations

import threading
import time
from collections import deque

# Bounded per-stage sample windows. At peak feed rates this is ~a few seconds of
# history but the percentiles stay stable because each stage is independent.
_MAXLEN = 5000
_MAX_PLAUSIBLE_S = 120.0

# stage key -> (human label, A-G bucket or "")
STAGE_LABELS: dict[str, tuple[str, str]] = {
    "broker_to_ws": ("Broker message -> WS engine receive", "A"),
    "ws_recv_to_feature_done": ("WS engine receive -> Feature calculation done", "B"),
    "feature_to_cm_frame": ("Feature output -> CM frame build", "C"),
    "cm_recv_to_ui_send": ("CM receive -> UI gateway send", "D"),
    "ws_recv_to_ui_send": ("WS engine receive -> UI gateway send (backend leg)", "E"),
    "ws_recv_to_db_writer": ("WS engine receive -> DB Writer ingest", "F"),
    "ws_recv_to_mongo": ("WS engine receive -> MongoDB write complete", "G"),
    "ws_recv_to_cm_recv": ("WS engine receive -> CM drain (queue age)", ""),
    "feature_calc": ("Feature engine calculation time", ""),
    "broker_to_ui_send": ("Broker message -> UI gateway send", "E"),
    "broker_to_db_writer": ("Broker message -> DB Writer ingest", "F"),
    "broker_to_mongo": ("Broker message -> MongoDB write complete", "G"),
}

_LOCK = threading.Lock()
_samples: dict[str, deque[float]] = {}
_counts: dict[str, int] = {}


def reset() -> None:
    """Clear all samples (tests / measurement windows)."""
    with _LOCK:
        _samples.clear()
        _counts.clear()


def record(stage: str, seconds: float | None) -> None:
    """Record one real duration (seconds). Rejects implausible/negative values."""
    if seconds is None:
        return
    try:
        value = float(seconds)
    except (TypeError, ValueError):
        return
    if value < 0.0 or value > _MAX_PLAUSIBLE_S:
        with _LOCK:
            _counts[stage] = _counts.get(stage, 0) + 1
        return
    with _LOCK:
        dq = _samples.get(stage)
        if dq is None:
            dq = _samples[stage] = deque(maxlen=_MAXLEN)
        dq.append(value * 1000.0)


def record_ms(stage: str, milliseconds: float | None) -> None:
    if milliseconds is None:
        return
    record(stage, float(milliseconds) / 1000.0)


def _percentile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    idx = int(round((q / 100.0) * (len(sorted_vals) - 1)))
    idx = min(max(idx, 0), len(sorted_vals) - 1)
    return sorted_vals[idx]


def _block(values: list[float]) -> dict:
    values = sorted(values)
    return {
        "samples": len(values),
        "min_ms": round(values[0], 2),
        "avg_ms": round(sum(values) / len(values), 2),
        "p50_ms": round(_percentile(values, 50), 2),
        "p95_ms": round(_percentile(values, 95), 2),
        "p99_ms": round(_percentile(values, 99), 2),
        "max_ms": round(values[-1], 2),
    }


def stats() -> dict:
    """Per-stage percentile snapshot (milliseconds)."""
    with _LOCK:
        raw = {stage: list(dq) for stage, dq in _samples.items()}
        rejected = dict(_counts)

    stages: dict[str, dict] = {}
    for stage, values in raw.items():
        if not values:
            continue
        label, bucket = STAGE_LABELS.get(stage, (stage, ""))
        block = _block(values)
        block["label"] = label
        block["bucket"] = bucket
        stages[stage] = block

    # A-G summary keyed by bucket for the reporting contract.
    agenda: dict[str, dict] = {}
    for stage in sorted(stages):
        block = stages[stage]
        bucket = block.get("bucket") or ""
        if not bucket:
            continue
        existing = agenda.get(bucket)
        # Prefer the backend-leg metric for E/F/G (ws_recv_to_*) so the number is
        # not polluted by broker clock skew; fall back to the broker-based one.
        if existing is None or stage.startswith("ws_recv_to"):
            agenda[bucket] = {"stage": stage, **block}

    return {
        "generatedAt": time.time(),
        "semantics": (
            "True hop-to-hop latency (ms). 'ws_recv_to_*' stages are measured "
            "entirely on the backend clock. 'broker_to_*' stages additionally "
            "include the broker-provided message timestamp and are sensitive to "
            "broker clock skew."
        ),
        "stages": stages,
        "agenda": agenda,
        "rejectedSamples": rejected,
    }
