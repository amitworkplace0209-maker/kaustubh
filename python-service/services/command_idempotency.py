"""Command Idempotency Store — WS#4 correlation-based idempotency (Phase 11).

Prevents duplicate broker orders when the same correlation_id is replayed
(e.g. frontend reconnect retry, duplicate tap). State machine:

  PENDING   → request accepted by backend, broker call in-flight
  ACCEPTED  → broker returned ok (stat: NotOk is REJECTED)
  REJECTED  → risk gate or broker rejected
  COMPLETED → WS#2 OrderUpdate confirms final broker state (COMPLETE/REJECTED/CANCELLED)
  UNKNOWN   → correlation_id not found

Key:  (terminal, correlation_id)  — terminal+session isolates per-user replay.
Value: {correlation_id, terminal, session_id, command_type, request_hash,
        state, created_at, updated_at, result, error, request}

If the same (terminal, correlation_id) arrives again while PENDING → return
existing PENDING without placing a duplicate broker order. If ACCEPTED/REJECTED
→ return existing result. Hash mismatch with same id → REJECTED as conflict.

Bounded: 2000 entries, LRU eviction, 1-hour TTL.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from typing import Any

_PENDING = "PENDING"
_ACCEPTED = "ACCEPTED"
_REJECTED = "REJECTED"
_COMPLETED = "COMPLETED"
_UNKNOWN = "UNKNOWN"

_MAX_ENTRIES = 2000
_TTL_SECONDS = 3600


def _hash_request(req: dict) -> str:
    try:
        canonical = json.dumps(req, sort_keys=True, default=str)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
    except Exception:
        return hashlib.sha256(str(req).encode("utf-8")).hexdigest()[:16]


class CommandIdempotencyStore:
    def __init__(self, max_entries: int = _MAX_ENTRIES, ttl_seconds: int = _TTL_SECONDS) -> None:
        self._store: dict[tuple[str, str], dict] = {}
        self._lock = threading.RLock()
        self._max = max_entries
        self._ttl = ttl_seconds

    def check(self, terminal: str, correlation_id: str, command_type: str, request: dict) -> dict | None:
        """Return existing record if correlation_id was seen before, else None.

        If existing record's request_hash differs → return conflict marker.
        """
        if not correlation_id:
            return None
        key = (terminal, correlation_id)
        with self._lock:
            rec = self._store.get(key)
            if rec is None:
                return None
            # TTL check
            if time.time() - rec.get("created_at", 0) > self._ttl:
                self._store.pop(key, None)
                return None
            # Hash must match command type + payload (replay must be identical)
            current_hash = _hash_request({"type": command_type, **request})
            if rec.get("request_hash") != current_hash:
                return {
                    "conflict": True,
                    "existing": rec,
                    "message": f"correlation_id {correlation_id} reused with different payload (expected hash {rec.get('request_hash')} got {current_hash})",
                }
            return rec

    def create_pending(self, terminal: str, correlation_id: str, command_type: str, request: dict, session_id: str | None = None) -> dict:
        key = (terminal, correlation_id)
        now = time.time()
        rec = {
            "correlation_id": correlation_id,
            "terminal": terminal,
            "session_id": session_id,
            "command_type": command_type,
            "request_hash": _hash_request({"type": command_type, **request}),
            "state": _PENDING,
            "created_at": now,
            "updated_at": now,
            "request": request,
            "result": None,
            "error": None,
        }
        with self._lock:
            # Evict oldest if over cap
            if len(self._store) >= self._max:
                oldest = min(self._store.items(), key=lambda kv: kv[1].get("created_at", 0))
                self._store.pop(oldest[0], None)
            self._store[key] = rec
        return rec

    def complete(self, terminal: str, correlation_id: str, state: str, result: Any = None, error: str | None = None) -> dict | None:
        if not correlation_id:
            return None
        key = (terminal, correlation_id)
        with self._lock:
            rec = self._store.get(key)
            if rec is None:
                return None
            rec["state"] = state
            rec["updated_at"] = time.time()
            rec["result"] = result
            rec["error"] = error
            return rec

    def mark_completed_from_order_update(self, order_id: str, status: str) -> None:
        """When WS#2 OrderUpdate confirms final state, mark related pending as COMPLETED.

        Finds any PENDING/ACCEPTED record whose request contained that order_id
        or whose result.orderId matches. Best-effort (not critical path).
        """
        if not order_id:
            return
        final_statuses = {"COMPLETE", "REJECTED", "CANCELLED", "COMPLETED", "FAILED", "REJECT"}
        if str(status).upper() not in final_statuses:
            return
        with self._lock:
            for rec in list(self._store.values()):
                if rec.get("state") not in (_PENDING, _ACCEPTED):
                    continue
                # Check if this record is tied to the order_id via request or result
                req = rec.get("request") or {}
                res = rec.get("result") or {}
                candidate_id = str(req.get("order_id") or req.get("orderId") or res.get("orderId") or res.get("order_id") or "")
                if candidate_id == str(order_id):
                    rec["state"] = _COMPLETED
                    rec["updated_at"] = time.time()

    def get(self, terminal: str, correlation_id: str) -> dict | None:
        key = (terminal, correlation_id)
        with self._lock:
            return self._store.get(key)

    def stats(self) -> dict:
        with self._lock:
            counts = {}
            for r in self._store.values():
                counts[r.get("state", _UNKNOWN)] = counts.get(r.get("state", _UNKNOWN), 0) + 1
            return {"total": len(self._store), "byState": counts}


_store = CommandIdempotencyStore()


def get_idempotency_store() -> CommandIdempotencyStore:
    return _store
