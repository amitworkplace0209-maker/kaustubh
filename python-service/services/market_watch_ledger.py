"""Market Watch daily block ledger — persistent per-symbol decision state.

docs/engines/MARKET_WATCH.md §7 (block ledger fields) and Phase 6.

Document shape (one row per symbol per trading day, the authoritative record):

    symbol, instrumentToken, date, status, reason, threshold, observed_value,
    blocked_at, detail, reentered_at, circuit_block_pct

``status`` is one of ``ACTIVE`` / ``BLOCKED``. Once a symbol is ``BLOCKED`` it
does NOT silently re-enter the eligible universe: doc §6 requires an explicit
re-entry rule. That rule is configuration
(``services.market_watch_config.LedgerConfig``) and only applies to data-driven
reasons; instrument/business/margin blocks stay for the whole day.

Writes go through the DB Writer document buffer — never a synchronous Mongo
insert from the tick path.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

logger = logging.getLogger("app.market_watch_ledger")

COLLECTION = "market_watch_decisions"

STATUS_ACTIVE = "ACTIVE"
STATUS_BLOCKED = "BLOCKED"


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


@dataclass
class BlockEntry:
    symbol: str
    instrument_token: str
    date: str
    status: str = STATUS_ACTIVE
    reason: Optional[str] = None
    threshold: Optional[float] = None
    observed_value: Optional[float] = None
    blocked_at: Optional[float] = None
    detail: Optional[str] = None
    circuit_block_pct: Optional[float] = None
    reentered_at: Optional[float] = None

    def to_doc(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "instrumentToken": self.instrument_token,
            "date": self.date,
            "status": self.status,
            "reason": self.reason,
            "threshold": self.threshold,
            "observed_value": self.observed_value,
            "blocked_at": _iso(self.blocked_at),
            "detail": self.detail,
            "circuitBlockPct": self.circuit_block_pct,
            "reentered_at": _iso(self.reentered_at),
        }

    def to_dict(self) -> dict[str, Any]:
        return {**self.to_doc(), "blockedAtEpoch": self.blocked_at}


class DailyBlockLedger:
    """In-memory day-scoped ledger + buffered persistence through the DB Writer.

    The in-memory map is the authority the ranking/eligibility hot path reads
    (O(1), no Mongo round-trip per tick). Writes are handed to the DB Writer
    buffer and the day is reloaded from storage on recovery (doc §21).
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._date: str = ""
        self._entries: dict[str, BlockEntry] = {}
        self._sink = None
        self._persist_enabled = True
        self._blocks = 0
        self._reentries = 0
        self._load_errors = 0
        self._loaded = False

    # ------------------------------------------------------------------ #
    def set_sink(self, sink) -> None:
        """Register the DB Writer document sink.

        ``sink`` must be a *synchronous* callable ``sink(docs: list) -> int``
        so it is safe on the tick path — the DB Writer buffers the documents
        and its own flush loop writes them.
        """
        self._sink = sink

    def default_sink(self):
        """DB Writer sink for this collection (the only supported writer)."""
        from services.db_writer_engine import db_writer_engine

        return lambda docs: db_writer_engine.buffer_documents(COLLECTION, docs)

    def ensure_sink(self) -> None:
        if self._sink is None:
            try:
                self._sink = self.default_sink()
            except Exception as exc:
                logger.warning("[MARKET_WATCH_LEDGER] no DB Writer sink available: %s", exc)

    def set_persist_enabled(self, enabled: bool) -> None:
        self._persist_enabled = bool(enabled)

    def configure_day(self, date: str) -> None:
        """Bind the ledger to a trading date, clearing in-memory state on roll."""
        with self._lock:
            if date == self._date:
                return
            self._date = date
            self._entries.clear()
            self._loaded = False

    @property
    def date(self) -> str:
        return self._date

    # ------------------------------------------------------------------ #
    def entry(self, token: str) -> Optional[BlockEntry]:
        with self._lock:
            return self._entries.get(str(token))

    def is_blocked(self, token: str) -> bool:
        with self._lock:
            entry = self._entries.get(str(token))
            return bool(entry and entry.status == STATUS_BLOCKED)

    def blocked_tokens(self) -> set[str]:
        with self._lock:
            return {t for t, e in self._entries.items() if e.status == STATUS_BLOCKED}

    def reason_counts(self) -> dict[str, int]:
        with self._lock:
            counts: dict[str, int] = {}
            for entry in self._entries.values():
                if entry.status != STATUS_BLOCKED or not entry.reason:
                    continue
                counts[entry.reason] = counts.get(entry.reason, 0) + 1
            return counts

    def entries(self) -> list[BlockEntry]:
        with self._lock:
            return list(self._entries.values())

    def summary(self) -> dict[str, Any]:
        with self._lock:
            total = len(self._entries)
            blocked = sum(1 for e in self._entries.values() if e.status == STATUS_BLOCKED)
            reentered = sum(1 for e in self._entries.values() if e.reentered_at is not None)
        return {
            "date": self._date,
            "tracked": total,
            "blocked": blocked,
            "active": total - blocked,
            "reentered": reentered,
            "blocks": self._blocks,
            "loadErrors": self._load_errors,
            "persistenceEnabled": self._persist_enabled,
            "reasonCounts": self.reason_counts(),
        }

    # ------------------------------------------------------------------ #
    def record_active(self, token: str, symbol: str) -> BlockEntry:
        with self._lock:
            entry = self._entries.get(str(token))
            if entry is None:
                entry = BlockEntry(symbol=symbol, instrument_token=str(token), date=self._date, status=STATUS_ACTIVE)
                self._entries[str(token)] = entry
            return entry

    def record_block(self, token: str, symbol: str, *, reason: str, threshold: Optional[float],
                     observed: Optional[float], detail: Optional[str],
                     circuit_block_pct: Optional[float], now: float) -> Optional[BlockEntry]:
        """Persist a day-block. Returns the entry, or ``None`` if unchanged."""
        doc: Optional[BlockEntry] = None
        with self._lock:
            entry = self._entries.get(str(token))
            if entry is None:
                entry = BlockEntry(symbol=symbol, instrument_token=str(token), date=self._date)
                self._entries[str(token)] = entry
            if entry.status == STATUS_BLOCKED and entry.reason == reason:
                return entry  # already blocked for the same reason — no churn
            entry.status = STATUS_BLOCKED
            entry.reason = reason
            entry.threshold = threshold
            entry.observed_value = observed
            entry.detail = detail
            entry.circuit_block_pct = circuit_block_pct
            entry.blocked_at = now
            entry.symbol = symbol or entry.symbol
            doc = entry
            self._blocks += 1
        self._enqueue(doc)
        return doc

    def record_reentry(self, token: str, now: float) -> Optional[BlockEntry]:
        """Explicit re-entry of a previously blocked symbol (doc §6).

        Only reachable when the ledger configuration enables re-entry for the
        recorded reason. The original block is preserved via ``reentered_at``.
        """
        doc: Optional[BlockEntry] = None
        with self._lock:
            entry = self._entries.get(str(token))
            if entry is None or entry.status != STATUS_BLOCKED:
                return None
            entry.status = STATUS_ACTIVE
            entry.reentered_at = now
            doc = entry
            self._reentries += 1
        self._enqueue(doc)
        return doc

    def _enqueue(self, entry: Optional[BlockEntry]) -> None:
        if entry is None or not self._persist_enabled:
            return
        if self._sink is None:
            self.ensure_sink()
            if self._sink is None:
                return
        try:
            doc = entry.to_doc()
            doc["_id"] = f"{doc['date']}:{doc['instrumentToken']}"
            written = self._sink([doc])
            if written <= 0:
                logger.warning("[MARKET_WATCH_LEDGER] sink rejected decision doc for %s", entry.instrument_token)
        except Exception as exc:
            logger.warning("[MARKET_WATCH_LEDGER] enqueue failed: %s", exc)

    # ------------------------------------------------------------------ #
    async def load_day(self, date: str, tokens: Optional[Iterable[str]] = None) -> int:
        """Reload the persisted decisions for ``date`` after a restart.

        Recovery path (doc §21): restore what was really recorded, never replay
        or invent blocks. A missing day simply means "nothing was blocked".
        """
        self.configure_day(date)
        if not date:
            return 0
        try:
            from database.connection import get_db

            db = get_db()
            if db is None:
                return 0
            query: dict[str, Any] = {"date": date}
            if tokens is not None:
                token_list = [str(t) for t in tokens]
                if not token_list:
                    return 0
                query["instrumentToken"] = {"$in": token_list}
            cursor = db[COLLECTION].find(query, {"_id": 0})
            rows = await cursor.to_list(length=None)
        except Exception as exc:
            self._load_errors += 1
            logger.warning("[MARKET_WATCH_LEDGER] load_day failed for %s: %s", date, exc)
            return 0

        restored = 0
        with self._lock:
            for row in rows:
                token = str(row.get("instrumentToken") or "")
                if not token:
                    continue
                self._entries[token] = BlockEntry(
                    symbol=str(row.get("symbol") or ""),
                    instrument_token=token,
                    date=date,
                    status=str(row.get("status") or STATUS_ACTIVE),
                    reason=row.get("reason"),
                    threshold=row.get("threshold"),
                    observed_value=row.get("observed_value"),
                    blocked_at=_epoch(row.get("blocked_at")),
                    detail=row.get("detail"),
                    circuit_block_pct=row.get("circuitBlockPct"),
                    reentered_at=_epoch(row.get("reentered_at")),
                )
                restored += 1
            self._loaded = True
        logger.info("[MARKET_WATCH_LEDGER] restored %d decisions for %s", restored, date)
        return restored

    async def ensure_indexes(self) -> None:
        try:
            from database.connection import get_db

            db = get_db()
            if db is None:
                return
            await db[COLLECTION].create_index([("date", 1), ("instrumentToken", 1)], unique=True)
            await db[COLLECTION].create_index([("date", 1), ("status", 1)])
            await db[COLLECTION].create_index([("date", 1), ("reason", 1)])
        except Exception as exc:
            logger.debug("[MARKET_WATCH_LEDGER] index creation skipped: %s", exc)

    async def prune(self, retention_days: int) -> int:
        """Bound storage: drop decisions older than the retention window."""
        try:
            from database.connection import get_db

            db = get_db()
            if db is None or retention_days <= 0:
                return 0
            cutoff = datetime.now(timezone.utc).timestamp() - retention_days * 86400
            result = await db[COLLECTION].delete_many({"blocked_at": {"$lt": _iso(cutoff)}})
            return int(getattr(result, "deleted_count", 0) or 0)
        except Exception as exc:
            logger.debug("[MARKET_WATCH_LEDGER] prune failed: %s", exc)
            return 0


def _epoch(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


block_ledger = DailyBlockLedger()

__all__ = [
    "COLLECTION",
    "STATUS_ACTIVE",
    "STATUS_BLOCKED",
    "BlockEntry",
    "DailyBlockLedger",
    "block_ledger",
]
