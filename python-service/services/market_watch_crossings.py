"""
Market Watch — per-stock weekly crossing history.

WHY THIS EXISTS
---------------
The weekly review is a human decision: "which stocks come off next week's
list?". To make that decision the operator needs to know how a stock actually
behaved during the week it was on the list — most usefully, how many times it
crossed ABOVE the price cap, because a stock that repeatedly breaches the cap is
the obvious removal candidate.

That counter used to live in memory only and was wiped at every day rollover, so
by review time it was gone. This module persists it, per symbol per week, so
the review screen can show real evidence instead of asking someone to remember.

DOCUMENT ID
-----------
Every document carries a deterministic ``_id`` of
``"<weekId>:<instrumentToken>"``. That is not cosmetic: the shared doc buffer
silently drops idempotent documents that have no ``_id`` (it only counts them as
``totalUnidentifiableDrops``), so an upsert keyed on a natural pair must carry
the id itself.

WEEK ID
-------
ISO week, e.g. ``2026-W42``, so Saturday and Sunday of the same weekend roll up
into one bucket — the operator scans across the two days, then reviews once.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Any, Mapping, Optional

logger = logging.getLogger("app.market_watch_crossings")

#: Added to market_watch_doc_buffer.COLLECTIONS so the weekly flush owns it.
COLLECTION = "market_watch_weekly_crossings"


def week_id_for(when: Optional[date] = None) -> str:
    """ISO week id (``2026-W42``) for a date — Saturday and Sunday share one."""
    d = when or datetime.now(timezone.utc).date()
    iso = d.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def week_bounds(week_id: str) -> tuple[str, str]:
    """Inclusive Monday..Sunday ISO dates for a ``YYYY-Www`` id."""
    year_s, week_s = week_id.split("-W")
    monday = date.fromisocalendar(int(year_s), int(week_s), 1)
    return monday.isoformat(), date.fromisocalendar(int(year_s), int(week_s), 7).isoformat()


def doc_id(week_id: str, token: str) -> str:
    return f"{week_id}:{token}"


def _num(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


class WeeklyCrossingTracker:
    """Counts cap crossings per symbol per week and persists them.

    Crossings are counted on the TRANSITION, not on level: a symbol sitting at
    ₹900 counts once, not once per tick. Without that, "how many times did it go
    above the cap" would really mean "how many ticks did it have".
    """

    def __init__(self, week_id: Optional[str] = None) -> None:
        self.week_id = week_id or week_id_for()
        # token -> row (also the in-memory mirror of what we have persisted)
        self._rows: dict[str, dict[str, Any]] = {}
        self._above: dict[str, bool] = {}

    # ------------------------------------------------------------------ #
    # Observation
    # ------------------------------------------------------------------ #

    def observe(
        self,
        token: str,
        *,
        symbol: str = "",
        ltp: Optional[float] = None,
        price_cap: Optional[float] = None,
        date_str: str = "",
        ltp_low: Optional[float] = None,
        ltp_high: Optional[float] = None,
    ) -> Optional[dict[str, Any]]:
        """Fold one observation in. Returns the row when it changed.

        ``ltp_low`` / ``ltp_high`` let a caller fold a whole candle in one call
        instead of replaying every tick — a candle that straddles the cap counts
        one crossing even if its low is below and its high above.
        """
        token = str(token or "").strip()
        if not token:
            return None

        cap = _num(price_cap)
        row = self._rows.get(token) or {
            "_id": doc_id(self.week_id, token),
            "weekId": self.week_id,
            "instrumentToken": token,
            "symbol": symbol,
            "aboveCapCount": 0,
            "belowCapCount": 0,
            "daysAboveCap": [],
            "lastLtp": None,
            "minLtp": None,
            "maxLtp": None,
            "cap": cap,
            "firstSeenAt": datetime.now(timezone.utc),
            "updatedAt": datetime.now(timezone.utc),
        }
        if symbol and not row.get("symbol"):
            row["symbol"] = symbol
        if cap is not None:
            row["cap"] = cap

        changed = False

        lows = [v for v in (_num(ltp_low), _num(ltp)) if v is not None]
        highs = [v for v in (_num(ltp_high), _num(ltp)) if v is not None]
        if lows:
            prev_min = _num(row.get("minLtp"))
            row["minLtp"] = min(lows) if prev_min is None else min(prev_min, min(lows))
            changed = True
        if highs:
            prev_max = _num(row.get("maxLtp"))
            row["maxLtp"] = max(highs) if prev_max is None else max(prev_max, max(highs))
            changed = True

        last = _num(ltp)
        if last is not None:
            row["lastLtp"] = last

        if cap is not None and cap > 0 and highs:
            # Two different questions, answered by two different counters:
            #   aboveCapCount — TRANSITIONS. A stock parked at ₹900 for a
            #     hundred ticks went over the cap ONCE; counting per tick would
            #     report a hundred "crossings" and make the review signal
            #     worthless.
            #   daysAboveCap  — DAYS on which it was observed above at all,
            #     continuous or not, because "above the cap on 4 of 5 days" is
            #     exactly what tells the operator whether to keep the stock.
            was_above = bool(self._above.get(token, False))
            is_above = max(highs) > cap
            if is_above:
                if date_str and date_str not in row["daysAboveCap"]:
                    row["daysAboveCap"] = sorted(set(row["daysAboveCap"]) | {date_str})
                    changed = True
                if not was_above:
                    row["aboveCapCount"] = int(row.get("aboveCapCount") or 0) + 1
                    changed = True
            elif was_above:
                row["belowCapCount"] = int(row.get("belowCapCount") or 0) + 1
                changed = True
            self._above[token] = is_above

        if changed:
            row["updatedAt"] = datetime.now(timezone.utc)
            self._rows[token] = row
            return row
        return None

    # ------------------------------------------------------------------ #
    # Read
    # ------------------------------------------------------------------ #

    @property
    def rows(self) -> dict[str, dict[str, Any]]:
        return dict(self._rows)

    def snapshot(self) -> dict[str, Any]:
        """Summary for the review screen: totals plus the removal candidates."""
        rows = list(self._rows.values())
        ranked = sorted(
            rows,
            key=lambda r: (-int(r.get("aboveCapCount") or 0), r.get("maxLtp") or 0.0),
        )
        return {
            "weekId": self.week_id,
            "weekBounds": week_bounds(self.week_id),
            "symbolsTracked": len(rows),
            "symbolsAboveCap": sum(1 for r in rows if int(r.get("aboveCapCount") or 0) > 0),
            "totalAboveCapCrossings": sum(int(r.get("aboveCapCount") or 0) for r in rows),
            "removalCandidates": [self.review_entry(r) for r in ranked[:50]],
        }

    @staticmethod
    def review_entry(row: Mapping[str, Any]) -> dict[str, Any]:
        """One row shaped for the manual add/remove review.

        ``removalSuggested`` is deliberately only a SUGGESTION derived from the
        crossing count — the operator still decides, which is the whole point of
        the manual step.
        """
        above = int(row.get("aboveCapCount") or 0)
        days = len(row.get("daysAboveCap") or [])
        max_ltp = _num(row.get("maxLtp"))
        cap = _num(row.get("cap"))
        return {
            "symbol": row.get("symbol") or "",
            "instrumentToken": row.get("instrumentToken") or "",
            "aboveCapCount": above,
            "belowCapCount": int(row.get("belowCapCount") or 0),
            "daysAboveCap": list(row.get("daysAboveCap") or []),
            "daysAboveCapCount": days,
            "lastLtp": row.get("lastLtp"),
            "maxLtp": max_ltp,
            "minLtp": row.get("minLtp"),
            "cap": cap,
            "maxLtpOverCap": (
                round(max_ltp - cap, 2) if max_ltp is not None and cap is not None else None
            ),
            "removalSuggested": days >= 2 or above >= 10,
        }

    def load_existing(self, docs: Any) -> None:
        """Adopt rows already in storage so a restart does not restart counts.

        The above/below transition memory is rebuilt from each row's stored
        ``lastLtp`` versus its cap. Without this, a restart would leave the new
        process believing every symbol was below the cap, and the first
        observation of an ongoing breach would silently fail to count as a
        crossing — losing exactly the crossing the review cares about.
        """
        for doc in docs or []:
            token = str(doc.get("instrumentToken") or "")
            if not token:
                continue
            doc.pop("_id", None)
            doc["_id"] = doc_id(self.week_id, token)
            self._rows[token] = doc
            cap = _num(doc.get("cap"))
            last = _num(doc.get("lastLtp"))
            if cap is not None and cap > 0 and last is not None:
                self._above[token] = last > cap

    def dirty(self) -> list[dict[str, Any]]:
        return [self._rows[t] for t in sorted(self._rows)]


async def flush(tracker: WeeklyCrossingTracker) -> int:
    """Hand dirty rows to the DB Writer's document buffer.

    Returns the number of documents offered. Failures are non-fatal: the
    counters are re-derived from candles at review time if a flush is missed.
    """
    docs = tracker.dirty()
    if not docs:
        return 0
    try:
        from services.db_writer_engine import db_writer_engine

        return await db_writer_engine.buffer_documents(COLLECTION, docs)
    except Exception:
        logger.debug("weekly crossing flush skipped", exc_info=True)
        return 0


__all__ = [
    "COLLECTION",
    "WeeklyCrossingTracker",
    "doc_id",
    "flush",
    "week_bounds",
    "week_id_for",
]
