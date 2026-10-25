"""Feed Quality Monitor for the Central Kotak WebSocket Engine.

Implements websocket-engine.md §18–§21:

- §18 per-instrument feed quality (status, counts, field availability,
  missing / null / invalid, duplicates, sequence gaps, latency, stale)
- §19 feed speed: overall + per-instrument messages/second with a short rolling
  window (current / average / minimum / maximum)
- §20 latency percentiles (min / avg / max / p50 / p95 / p99) from the broker
  timestamp when the broker provides one — never invented otherwise
- §21 stale feed detection (LIVE / DEGRADED / STALE / NO_FEED) with
  configurable, feed-type-aware thresholds

Pure module: stdlib only, no broker SDK, no I/O. The engine feeds canonical
tick envelopes in and reads named snapshots out.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from ws_socket.engine.canonical import (
    _CAS_FIELDS,
    _INDEX_FIELDS,
    _LITE_FIELDS,
    _MARKET_STATUS_FIELDS,
    _SCRIP_FIELDS,
)

LIVE = "LIVE"
DEGRADED = "DEGRADED"
STALE = "STALE"
NO_FEED = "NO_FEED"

FEED_STATUSES = (LIVE, DEGRADED, STALE, NO_FEED)

DEFAULT_STALE_SEC = 30.0
DEFAULT_DEGRADED_SEC = 10.0

RATE_WINDOW_SEC = 60.0
_MAX_RATE_WINDOW_SEC = 65.0

# Expected canonical fields per feed family (derived from the canonical maps so
# this never drifts from the wire contract). The scrip family covers every
# depth level: touch_line (4), depth (8) and full_depth (16) all decode to
# SFeedScrip and therefore carry the same field surface.
_SCRIP_EXPECTED: tuple[str, ...] = tuple(_SCRIP_FIELDS) + ("buy", "sell")
_EXPECTED_FIELDS: dict[str, tuple[str, ...]] = {
    "scrip": _SCRIP_EXPECTED,
    "touch_line": _SCRIP_EXPECTED,
    "depth": _SCRIP_EXPECTED,
    "full_depth": _SCRIP_EXPECTED,
    "scrip_lite": tuple(_LITE_FIELDS),
    "index": tuple(_INDEX_FIELDS),
    "market_status": tuple(_MARKET_STATUS_FIELDS),
    "cas_change": tuple(_CAS_FIELDS),
}

# Fields that must be numeric; anything else (when present) is an invalid value.
_NUMERIC_FIELDS: frozenset[str] = frozenset(
    name for name in set().union(*_EXPECTED_FIELDS.values()) if name not in ("buy", "sell", "name", "status")
)


def expected_fields(feed_type: str) -> tuple[str, ...]:
    return _EXPECTED_FIELDS.get(feed_type or "", ())


def percentile(sorted_samples: list[float], p: float) -> float | None:
    """Nearest-rank percentile over an already-sorted list (no interpolation)."""
    if not sorted_samples:
        return None
    if p <= 0:
        return sorted_samples[0]
    if p >= 100:
        return sorted_samples[-1]
    rank = int(round((p / 100.0) * (len(sorted_samples) - 1)))
    rank = max(0, min(rank, len(sorted_samples) - 1))
    return sorted_samples[rank]


def _latency_block(samples: list[float]) -> dict:
    if not samples:
        return {
            "available": False, "samples": 0, "min_ms": None, "avg_ms": None,
            "max_ms": None, "p50_ms": None, "p95_ms": None, "p99_ms": None,
        }
    ordered = sorted(samples)
    return {
        "available": True,
        "samples": len(ordered),
        "min_ms": round(ordered[0], 2),
        "avg_ms": round(sum(ordered) / len(ordered), 2),
        "max_ms": round(ordered[-1], 2),
        "p50_ms": round(percentile(ordered, 50) or 0.0, 2),
        "p95_ms": round(percentile(ordered, 95) or 0.0, 2),
        "p99_ms": round(percentile(ordered, 99) or 0.0, 2),
    }


@dataclass
class InstrumentQuality:
    """Per-instrument feed quality accumulator (bounded memory)."""

    instrument_key: str
    exchange_segment: str = ""
    instrument_token: str = ""
    symbol: str = ""
    feed_type: str = "unknown"
    message_count: int = 0
    valid_ticks: int = 0
    duplicate_count: int = 0
    null_counts: dict[str, int] = field(default_factory=dict)
    invalid_counts: dict[str, int] = field(default_factory=dict)
    present_fields: set[str] = field(default_factory=set)
    valid_fields: set[str] = field(default_factory=set)
    latency_ms: deque = field(default_factory=lambda: deque(maxlen=2000))
    recent_at: deque = field(default_factory=lambda: deque(maxlen=5000))
    broker_ts_min: float | None = None
    broker_ts_max: float | None = None
    first_at: float | None = None
    last_at: float | None = None
    last_broker_ts: float | None = None
    sequence_last: int | None = None
    sequence_gaps: int = 0
    sequence_available: bool = False
    _last_dup_key: tuple | None = None

    # -- ingest ---------------------------------------------------------
    def observe(self, canonical: dict, received_at: float | None = None) -> None:
        now = received_at if received_at is not None else float(canonical.get("received_at") or time.time())
        self.message_count += 1
        self.valid_ticks += 1
        if self.first_at is None:
            self.first_at = now
        self.last_at = now
        self.recent_at.append(now)
        if not self.instrument_token:
            self.instrument_token = str(canonical.get("instrument_token") or "")
        if not self.exchange_segment:
            self.exchange_segment = str(canonical.get("exchange_segment") or "")
        if not self.symbol:
            self.symbol = str(canonical.get("trading_symbol") or "")
        if canonical.get("feed_type"):
            self.feed_type = str(canonical["feed_type"])

        fields = canonical.get("fields") or {}
        self._observe_fields(fields)
        self._observe_duplicate(canonical, fields)
        self._observe_sequence(canonical)

        broker_ts = canonical.get("broker_timestamp")
        if broker_ts:
            try:
                ts = float(broker_ts)
            except (TypeError, ValueError):
                ts = None
            if ts is not None:
                self.last_broker_ts = ts
                self.broker_ts_min = ts if self.broker_ts_min is None else min(self.broker_ts_min, ts)
                self.broker_ts_max = ts if self.broker_ts_max is None else max(self.broker_ts_max, ts)
                latency = (now - ts) * 1000.0
                # Broker clocks can be ahead; only accept plausible values.
                if 0 <= latency < 60_000:
                    self.latency_ms.append(latency)

    def _observe_fields(self, fields: dict) -> None:
        for name, value in fields.items():
            # A field is "present/received" the moment the broker sends the key
            # (even if null); "missing" means the key never arrived at all.
            self.present_fields.add(name)
            if value is None:
                self.null_counts[name] = self.null_counts.get(name, 0) + 1
                continue
            if name in _NUMERIC_FIELDS:
                try:
                    float(value)
                except (TypeError, ValueError):
                    self.invalid_counts[name] = self.invalid_counts.get(name, 0) + 1
                    continue
            self.valid_fields.add(name)

    def _observe_duplicate(self, canonical: dict, fields: dict) -> None:
        broker_ts = canonical.get("broker_timestamp")
        if not broker_ts:
            return  # cannot classify a repeat without a broker timestamp
        key = (broker_ts, fields.get("ltp"), fields.get("volume"),
               fields.get("ltq"), fields.get("total_buy_quantity"),
               fields.get("total_sell_quantity"))
        if key == self._last_dup_key:
            self.duplicate_count += 1
        else:
            self._last_dup_key = key

    def _observe_sequence(self, canonical: dict) -> None:
        seq = canonical.get("sequence")
        if seq is None:
            return
        try:
            value = int(seq)
        except (TypeError, ValueError):
            return
        self.sequence_available = True
        if self.sequence_last is not None and value > self.sequence_last + 1:
            self.sequence_gaps += value - self.sequence_last - 1
        self.sequence_last = value

    # -- rate -----------------------------------------------------------
    def _rate_block(self, now: float) -> dict:
        cutoff = now - _MAX_RATE_WINDOW_SEC
        while self.recent_at and self.recent_at[0] < cutoff:
            self.recent_at.popleft()
        observed = min(RATE_WINDOW_SEC, (now - self.first_at)) if self.first_at else 0.0
        current = sum(1 for t in self.recent_at if t > now - 1.0)
        last_5 = sum(1 for t in self.recent_at if t > now - 5.0) / 5.0
        window = sum(1 for t in self.recent_at if t > now - RATE_WINDOW_SEC)
        average = window / observed if observed >= 1.0 else float(window)
        buckets = max(1, int(observed)) if observed >= 1.0 else 1
        counts = [0] * buckets
        base = now - buckets
        for t in self.recent_at:
            idx = int(t - base)
            idx = min(idx, buckets - 1)  # `now` lands in the last bucket
            if 0 <= idx < buckets:
                counts[idx] += 1
        return {
            "current_per_sec": current,
            "avg_5s_per_sec": round(last_5, 2),
            "avg_per_sec": round(average, 2),
            "min_per_sec": min(counts) if counts else 0,
            "max_per_sec": max(counts) if counts else 0,
            "window_sec": round(observed, 1),
        }

    # -- snapshot -------------------------------------------------------
    def status(self, now: float, degraded_sec: float, stale_sec: float) -> str:
        if self.message_count == 0 or self.last_at is None:
            return NO_FEED
        elapsed = now - self.last_at
        if elapsed > stale_sec:
            return STALE
        if elapsed > degraded_sec:
            return DEGRADED
        return LIVE

    def snapshot(self, now: float, degraded_sec: float, stale_sec: float) -> dict:
        expected = _EXPECTED_FIELDS.get(self.feed_type, ())
        present = {name for name in self.present_fields if name in expected} if expected else set(self.present_fields)
        missing = sorted(set(expected) - present)
        null_total = sum(self.null_counts.values())
        invalid_total = sum(self.invalid_counts.values())
        return {
            "instrument_key": self.instrument_key,
            "exchange_segment": self.exchange_segment,
            "instrument_token": self.instrument_token,
            "symbol": self.symbol,
            "feed_type": self.feed_type,
            "status": self.status(now, degraded_sec, stale_sec),
            "message_count": self.message_count,
            "valid_ticks": self.valid_ticks,
            "duplicate_count": self.duplicate_count,
            "last_feed_at": self.last_at,
            "seconds_since_last_feed": round(now - self.last_at, 1) if self.last_at else None,
            "last_broker_timestamp": self.last_broker_ts,
            "field_availability": {
                "expected": len(expected),
                "received": len(present),
                "missing": missing,
                "missing_count": len(missing),
                "null_count": null_total,
                "null_fields": dict(self.null_counts),
                "invalid_count": invalid_total,
                "invalid_fields": dict(self.invalid_counts),
            },
            "sequence_gaps": self.sequence_gaps if self.sequence_available else None,
            "sequence_available": self.sequence_available,
            "sequence_reason": None if self.sequence_available else "broker_sequence_unavailable",
            "latency": _latency_block(list(self.latency_ms)),
            "rate": self._rate_block(now),
        }


@dataclass
class FeedQualityMonitor:
    """Aggregate per-instrument quality plus overall feed speed/latency."""

    degraded_sec: float = DEFAULT_DEGRADED_SEC
    stale_sec: float = DEFAULT_STALE_SEC
    # Optional per-feed-type overrides: feed_type -> {"degraded_sec", "stale_sec"}
    feed_type_thresholds: dict[str, dict] = field(default_factory=dict)
    instruments: dict[str, InstrumentQuality] = field(default_factory=dict)
    messages_total: int = 0
    rejected_total: int = 0
    _global_recent: deque = field(default_factory=lambda: deque(maxlen=20000))
    _global_latency: deque = field(default_factory=lambda: deque(maxlen=4000))
    _first_at: float | None = None

    def thresholds_for(self, feed_type: str) -> tuple[float, float]:
        override = self.feed_type_thresholds.get(feed_type or "") or {}
        degraded = float(override.get("degraded_sec", self.degraded_sec))
        stale = float(override.get("stale_sec", self.stale_sec))
        return degraded, stale

    def update_thresholds(self, *, degraded_sec: float | None = None,
                          stale_sec: float | None = None,
                          feed_type_thresholds: dict | None = None) -> None:
        if degraded_sec is not None:
            self.degraded_sec = float(degraded_sec)
        if stale_sec is not None:
            self.stale_sec = float(stale_sec)
        if feed_type_thresholds is not None:
            self.feed_type_thresholds = {
                str(k): dict(v or {}) for k, v in dict(feed_type_thresholds).items()
            }

    def observe(self, canonical: dict, received_at: float | None = None) -> None:
        if not canonical:
            return
        seg = str(canonical.get("exchange_segment") or "")
        tok = str(canonical.get("instrument_token") or "")
        if not tok:
            return
        key = f"{seg}|{tok}"
        record = self.instruments.get(key)
        if record is None:
            record = InstrumentQuality(instrument_key=key)
            self.instruments[key] = record
        now = received_at if received_at is not None else float(canonical.get("received_at") or time.time())
        record.observe(canonical, now)
        self.messages_total += 1
        if self._first_at is None:
            self._first_at = now
        self._global_recent.append(now)
        broker_ts = canonical.get("broker_timestamp")
        if broker_ts:
            try:
                latency = (now - float(broker_ts)) * 1000.0
            except (TypeError, ValueError):
                latency = None
            if latency is not None and 0 <= latency < 60_000:
                self._global_latency.append(latency)

    def record_rejected(self, count: int = 1) -> None:
        self.rejected_total += max(0, int(count))

    def instrument(self, identifier: str) -> dict | None:
        record = self.instruments.get(identifier)
        if record is None:
            for candidate in self.instruments.values():
                if candidate.instrument_token == str(identifier):
                    record = candidate
                    break
        if record is None:
            return None
        degraded, stale = self.thresholds_for(record.feed_type)
        return record.snapshot(time.time(), degraded, stale)

    def rates(self) -> dict:
        now = time.time()
        cutoff = now - _MAX_RATE_WINDOW_SEC
        while self._global_recent and self._global_recent[0] < cutoff:
            self._global_recent.popleft()
        current = sum(1 for t in self._global_recent if t > now - 1.0)
        last_5 = sum(1 for t in self._global_recent if t > now - 5.0) / 5.0
        last_60 = sum(1 for t in self._global_recent if t > now - RATE_WINDOW_SEC)
        observed = min(RATE_WINDOW_SEC, now - self._first_at) if self._first_at else 0.0
        average = last_60 / observed if observed >= 1.0 else float(last_60)
        return {
            "messages_per_second": current,
            "messages_5s_average": round(last_5, 2),
            "messages_60s_average": round(average, 2),
            "rejected_total": self.rejected_total,
            "window_sec": round(observed, 1),
        }

    def latency(self) -> dict:
        return _latency_block(list(self._global_latency))

    def summary(self) -> dict:
        now = time.time()
        status_counts: dict[str, int] = {status: 0 for status in FEED_STATUSES}
        per_instrument: list[dict] = []
        duplicate_total = 0
        null_total = 0
        invalid_total = 0
        sequence_total = 0
        for record in self.instruments.values():
            degraded, stale = self.thresholds_for(record.feed_type)
            row = record.snapshot(now, degraded, stale)
            status_counts[row["status"]] = status_counts.get(row["status"], 0) + 1
            duplicate_total += row["duplicate_count"]
            null_total += row["field_availability"]["null_count"]
            invalid_total += row["field_availability"]["invalid_count"]
            if row["sequence_gaps"]:
                sequence_total += row["sequence_gaps"]
            per_instrument.append({
                "instrument_key": row["instrument_key"],
                "symbol": row["symbol"],
                "status": row["status"],
                "message_count": row["message_count"],
                "duplicate_count": row["duplicate_count"],
                "seconds_since_last_feed": row["seconds_since_last_feed"],
                "field_availability": row["field_availability"],
                "sequence_gaps": row["sequence_gaps"],
                "sequence_available": row["sequence_available"],
                "latency": row["latency"],
                "rate": row["rate"],
            })
        per_instrument.sort(key=lambda r: r["message_count"], reverse=True)
        return {
            "thresholds": {
                "degraded_sec": self.degraded_sec,
                "stale_sec": self.stale_sec,
                "per_feed_type": dict(self.feed_type_thresholds),
            },
            "overall": {
                **self.rates(),
                "latency": self.latency(),
                "instrument_count": len(self.instruments),
                "status_counts": status_counts,
                "duplicate_total": duplicate_total,
                "null_field_total": null_total,
                "invalid_field_total": invalid_total,
                "sequence_gap_total": sequence_total,
                "sequence_available": any(r["sequence_available"] for r in per_instrument),
            },
            "instruments": per_instrument,
        }

    def stale_instruments(self) -> list[dict]:
        now = time.time()
        out: list[dict] = []
        for record in self.instruments.values():
            degraded, stale = self.thresholds_for(record.feed_type)
            status = record.status(now, degraded, stale)
            if status in (STALE, NO_FEED):
                out.append({
                    "instrument_key": record.instrument_key,
                    "symbol": record.symbol,
                    "status": status,
                    "seconds_since_last_feed": round(now - record.last_at, 1) if record.last_at else None,
                })
        return out

    def reset(self) -> None:
        self.instruments.clear()
        self._global_recent.clear()
        self._global_latency.clear()
        self.messages_total = 0
        self.rejected_total = 0
        self._first_at = None
