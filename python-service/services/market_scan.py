"""Full-market scan for the Data Saver Watch page.

ONE authoritative scan document covering the whole NSE EQ universe (the
broker scrip master — thousands of instruments), built purely from REAL
in-memory feed state:

  * live quotes  → ``services.tick_buffer`` (the ONE central WS-tick store)
  * 1m/5m/10m % → ``tick_buffer.window_moves`` (true window-boundary maths)
  * index rows   → ``services.market_watch_indexes.index_tracker``
  * universe     → ``services.instrument_cache`` (EQ rows of nse_cm)

Nothing is fetched from third-party endpoints; a value no feed has produced
is ``None`` and stays ``None`` downstream (the frontend renders an em dash —
never an invented zero).

The scanner runs as one asyncio task with an ADAPTIVE cadence (fast while
the market can trade, slow overnight) and never blocks the event loop: the
compute pass works on in-memory dicts/deques under bounded locks. REST
serves the cached document (recompute on force/stale), and the WS#3
``watch_scan`` snapshot channel pushes the light summary (`rows` stripped)
with membership/count signatures.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any

logger = logging.getLogger("app.market_scan")

#: Fast cadence while the market session can trade; slow overnight cadence.
FAST_CADENCE_S = 10.0
SLOW_CADENCE_S = 60.0

#: REST may ask for a recompute if the cache is older than this.
STALE_RECOMPUTE_S = 8.0

#: Count of top movers persisted into the WS summary per strip.
MOVER_LIMIT = 30
WS_MOVER_LIMIT = 12

#: Momentum windows (seconds) surfaced on every card.
WINDOW_SECONDS: tuple[float, float, float] = (60.0, 300.0, 600.0)
WINDOW_LABELS: tuple[str, str, str] = ("1m", "5m", "10m")

#: Last tick age beyond which a token is "stale" (not live).
LIVE_MAX_AGE_S = 30.0


def latest_tick_age(tick: dict) -> float | None:
    """Age in seconds of a merged latest-tick doc's receivedAt, or None."""
    received = tick.get("receivedAt")
    if received is None:
        return None
    if isinstance(received, (int, float)):
        return max(0.0, time.time() - float(received))
    try:
        from datetime import datetime, timezone

        if isinstance(received, datetime):
            stamp = received if received.tzinfo else received.replace(tzinfo=timezone.utc)
            delta = (datetime.now(timezone.utc) - stamp).total_seconds()
            return max(0.0, float(delta))
    except Exception:
        pass
    return None


def _num(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and abs(out) != float("inf") else None


def _iso_wall(epoch_or_none: float | None) -> str | None:
    """Approximately-local ISO stamp for a wall-clock epoch (display only)."""
    if epoch_or_none is None:
        return None
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(epoch_or_none))
    except Exception:
        return None


class MarketScan:
    """Background full-universe scan + cached document single source."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._doc: dict | None = None
        self._computed_at: float = 0.0
        self._cycle_ms: float = 0.0
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ #
    def ensure_started(self) -> None:
        """Idempotent background scan-loop bootstrap."""
        if self._task is not None and not self._task.done():
            return

        async def _runner() -> None:
            logger.info("[MARKET_SCAN] background scan loop started")
            while True:
                try:
                    await asyncio.to_thread(self.compute)
                    # persist from the MAIN loop thread (worker threads have
                    # no event loop, so a create_task there would be dropped)
                    self._maybe_persist()
                except Exception as exc:  # noqa: BLE001 — the loop must never die
                    logger.warning("[MARKET_SCAN] cycle failed: %r", exc)
                doc = self._doc or {}
                cadence = ((doc or {}).get("scan") or {}).get("cadenceSeconds") or FAST_CADENCE_S
                try:
                    await asyncio.sleep(float(cadence))
                except Exception:  # noqa: BLE001
                    await asyncio.sleep(FAST_CADENCE_S)

        self._task = asyncio.get_running_loop().create_task(_runner())

    # ------------------------------------------------------------------ #
    def _cadence_for_now(self) -> float:
        """Fast while the market can trade, slow in every other state."""
        try:
            from services.market_calendar import market_calendar

            snap = market_calendar.snapshot()
            status = str(snap.get("market_status") or "").lower()
            if status in {"open", "pre_open", "pre_market", "post_market"}:
                return FAST_CADENCE_S
            if snap.get("market_state_source") and bool(snap.get("trading_day")) and status == "":
                return FAST_CADENCE_S
            return SLOW_CADENCE_S
        except Exception:
            return SLOW_CADENCE_S

    def _universe(self) -> dict[str, dict]:
        """NSE EQ universe from the validated instrument master (cheap dict)."""
        out: dict[str, dict] = {}
        try:
            from services.instrument_cache import instrument_cache

            for inst in instrument_cache.get_instruments():
                if not instrument_cache.is_nse_eq(inst):
                    continue
                token = str(
                    inst.get("token")
                    or inst.get("instrumentToken")
                    or ""
                )
                if not token:
                    continue
                out[token] = {
                    "symbol": str(inst.get("symbol") or inst.get("tradingSymbol") or "NSE symbol"),
                    "name": str(inst.get("companyName") or inst.get("tradingSymbol") or ""),
                    "tradingSymbol": str(inst.get("tradingSymbol") or ""),
                    "segment": "nse_cm",
                }
        except Exception as exc:  # noqa: BLE001 — universe is best-effort
            logger.warning("[MARKET_SCAN] universe unavailable: %r", exc)
        return out

    # ------------------------------------------------------------------ #
    def compute(self) -> dict:
        """One full scan pass over in-memory feed state (thread-safe swap)."""
        t0 = time.monotonic()

        from services import tick_buffer

        universe = self._universe()
        latest_rows = tick_buffer.get_latest_ticks()
        moves = tick_buffer.window_moves(WINDOW_SECONDS)
        depth = tick_buffer.history_depth_seconds()

        rows: list[dict] = []
        for token, meta in universe.items():
            tick = latest_rows.get(token) or {}
            ltp = _num(tick.get("ltp"))
            prev_close = _num(
                tick.get("prevClose") or tick.get("previousClose") or tick.get("close")
            )
            chg = _num(tick.get("netChange"))
            chg_pct = _num(tick.get("netChangePercent"))
            if chg is None and ltp is not None and prev_close not in (None, 0):
                chg = round(ltp - prev_close, 4)
            if chg_pct is None and chg is not None and prev_close not in (None, 0):
                chg_pct = round((chg / prev_close) * 100.0, 4)
            age = latest_tick_age(tick)
            has_feed = age is not None or ltp is not None
            row = {
                "token": token,
                "symbol": str(tick.get("symbol") or meta["symbol"]),
                "name": str(tick.get("tradingSymbol") or meta["name"]),
                "segment": meta["segment"],
                "ltp": ltp,
                "prevClose": prev_close,
                "dayChange": chg,
                "dayChangePct": chg_pct,
                "open": _num(tick.get("open")),
                "high": _num(tick.get("high")),
                "low": _num(tick.get("low")),
                "volume": _num(tick.get("volume")),
                "bid": _num(tick.get("bp")),
                "ask": _num(tick.get("sp")),
                "tickAgeSec": round(age, 2) if age is not None else None,
                "status": "live" if (age is not None and age <= LIVE_MAX_AGE_S)
                    else ("stale" if has_feed else "no_data"),
            }
            moved = moves.get(token) or {}
            for idx, label in enumerate(WINDOW_LABELS):
                m = moved.get(label)
                key_pct, key_chg = f"pct{label}", f"chg{label}"
                if m:
                    row[key_pct] = m.get("pct")
                    row[key_chg] = m.get("chgRaw")
                else:
                    row[key_pct] = None
                    row[key_chg] = None
            rows.append(row)

        # ---------------- index rows (real tracker states) ---------------- #
        indexes: list[dict] = []
        try:
            from services.market_watch_indexes import index_tracker

            body = index_tracker.to_dict()
            for state in body.get("indexes", []):
                indexes.append({
                    "name": str(state.get("name") or ""),
                    "token": str(state.get("token") or ""),
                    "ltp": _num(state.get("ltp")),
                    "dayChange": _num(state.get("change")),
                    "dayChangePct": _num(state.get("change_pct")),
                    "volume": _num(state.get("volume")),
                    "ticks": _num(state.get("tick_count")),
                    "quality": str(state.get("data_quality") or "UNAVAILABLE"),
                    "lastTickAt": _iso_wall(
                        float(state["last_tick_time"]) if isinstance(state.get("last_tick_time"), (int, float)) else None
                    ),
                })
        except Exception as exc:  # noqa: BLE001
            logger.debug("[MARKET_SCAN] index rows unavailable: %r", exc)

        # ---------------- breadth (measured, never guessed) --------------- #
        with_prev = [r for r in rows if r.get("dayChangePct") is not None]
        def _count(pred) -> int:
            return sum(1 for r in with_prev if pred(r))
        pct_of = lambda r: r.get("dayChangePct") or 0.0
        breadth = {
            "measurable": len(with_prev),
            "noPrevClose": len(rows) - len(with_prev),
            "advances": _count(lambda r: pct_of(r) > 0),
            "declines": _count(lambda r: pct_of(r) < 0),
            "unchanged": _count(lambda r: pct_of(r) == 0),
            "pct1Up": _count(lambda r: pct_of(r) >= 1.0),
            "pct1Down": _count(lambda r: pct_of(r) <= -1.0),
            "pct2Up": _count(lambda r: pct_of(r) >= 2.0),
            "pct2Down": _count(lambda r: pct_of(r) <= -2.0),
            "pct3Up": _count(lambda r: pct_of(r) >= 3.0),
            "pct3Down": _count(lambda r: pct_of(r) <= -3.0),
            "pct5Up": _count(lambda r: pct_of(r) >= 5.0),
            "pct5Down": _count(lambda r: pct_of(r) <= -5.0),
        }

        # ------------- window breadth (1m/5m/10m ≥1% counts) -------------- #
        windows_breadth: dict[str, dict] = {}
        for label in WINDOW_LABELS:
            key = f"pct{label}"
            moved = [r for r in rows if r.get(key) is not None]
            windows_breadth[label] = {
                "measurable": len(moved),
                "up1": sum(1 for r in moved if (r.get(key) or 0.0) >= 1.0),
                "down1": sum(1 for r in moved if (r.get(key) or 0.0) <= -1.0),
            }

        # ------------------------ movers (top lists) ----------------------- #
        def _mover_row(r: dict, strip: str) -> dict:
            """Compact mover card for the gainer/loser strips (+ pinned detail rows)."""
            if strip in WINDOW_LABELS:
                win_pct = r.get(f"pct{strip}")
                win_chg = r.get(f"chg{strip}")
            else:
                win_pct = r.get("dayChangePct")
                win_chg = r.get("dayChange")
            return {
                "token": r["token"],
                "symbol": r["symbol"],
                "name": r["name"],
                "ltp": r.get("ltp"),
                "dayChangePct": r.get("dayChangePct"),
                "dayChange": r.get("dayChange"),
                "strip": strip,
                "stripPct": win_pct,
                "stripChg": win_chg,
            }

        def _top(key: str, reverse: bool, strip: str | None, limit: int,
                 require_positive: bool | None = None) -> list[dict]:
            pool = [r for r in rows if r.get(key) is not None]
            # Up strips carry ONLY advancers, Down strips ONLY decliners — a
            # laggard can never sit inside the gainer strip just because the
            # sort put it second.
            if require_positive is True:
                pool = [r for r in pool if (r.get(key) or 0.0) > 0]
            elif require_positive is False:
                pool = [r for r in pool if (r.get(key) or 0.0) < 0]
            pool.sort(key=lambda r: r.get(key) or 0.0, reverse=reverse)
            return [_mover_row(r, strip or "day") for r in pool[:limit]]

        day_w = None  # (kept minimal: day strips carry their own day keys)
        movers = {
            "dayUpPct": _top("dayChangePct", True, None, MOVER_LIMIT, True),
            "dayDownPct": _top("dayChangePct", False, None, MOVER_LIMIT, False),
            "dayUpPrice": _top("dayChange", True, None, MOVER_LIMIT, True),
            "dayDownPrice": _top("dayChange", False, None, MOVER_LIMIT, False),
        }
        for label in WINDOW_LABELS:
            movers[f"m{label}Up"] = _top(f"pct{label}", True, label, MOVER_LIMIT, True)
            movers[f"m{label}Down"] = _top(f"pct{label}", False, label, MOVER_LIMIT, False)

        # -------------------------- scan meta ------------------------------ #
        last_tick_age: float | None = None
        for tick in latest_rows.values():
            age = latest_tick_age(tick)
            if age is not None and (last_tick_age is None or age < last_tick_age):
                last_tick_age = age
        cadence = self._cadence_for_now()
        cycle_ms = (time.monotonic() - t0) * 1000.0
        live_tokens = 0
        try:
            live_tokens = int(tick_buffer.price_history_count())
        except Exception:
            live_tokens = 0
        meta = {
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
            "cadenceSeconds": cadence,
            "cycleMs": round(cycle_ms, 1),
            "universeSize": len(rows),
            "liveTokens": live_tokens,
            "historyDepthSeconds": round(depth, 1) if depth is not None else None,
            "newestTickAgeSec": round(last_tick_age, 2) if last_tick_age is not None else None,
            "feed": "live" if (last_tick_age is not None and last_tick_age <= LIVE_MAX_AGE_S)
                else ("stale" if live_tokens > 0 else "idle"),
            "source": "backend WS tick store (tick_buffer) — no third-party fetch",
        }

        doc = {
            "scan": meta,
            "indexes": indexes,
            "breadth": breadth,
            "windows": windows_breadth,
            "movers": movers,
            "rows": rows,
            "generatedAt": meta["generatedAt"],
        }
        with self._lock:
            self._doc = doc
            self._computed_at = time.monotonic()
            self._cycle_ms = cycle_ms
        return doc

    # ------------------------------------------------------------------ #
    def document(self) -> dict | None:
        return self._doc

    def stale(self) -> bool:
        if self._doc is None:
            return True
        return (time.monotonic() - self._computed_at) > STALE_RECOMPUTE_S

    def _maybe_persist(self) -> None:
        """Persist the latest scan from the MAIN event loop thread only."""
        doc = self._doc
        if doc is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # no running loop here (a worker thread) — the runner persists
        slim = {k: v for k, v in doc.items() if k != "rows"}

        async def _write() -> None:
            try:
                from database.connection import get_db

                await get_db().market_scan.update_one(
                    {"_id": "latest"},
                    {"$set": {**slim, "savedAt": time.strftime(
                        "%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"}},
                    upsert=True,
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[MARKET_SCAN] persist skipped: %r", exc)

        loop.create_task(_write())

    async def document_fresh(self, force: bool = False, timeout: float = 6.0) -> dict | None:
        """REST access point: cached doc recomputed when stale/forced."""
        self.ensure_started()
        if force or self.stale():
            try:
                await asyncio.wait_for(self._recompute_task(), timeout=timeout)
                self._maybe_persist()
            except Exception as exc:  # noqa: BLE001 — serve stale honestly
                logger.warning("[MARKET_SCAN] on-demand recompute failed: %r", exc)
        # Serve the live cache, or the last persisted scan on a truly cold boot.
        return self._doc or await parked_document()

    async def _recompute_task(self) -> None:
        await asyncio.to_thread(self.compute)

    async def wait_document(self, timeout: float = 8.0) -> dict | None:
        """WS snapshot builder entry: ensure the loop, then serve the doc."""
        self.ensure_started()
        deadline = asyncio.get_event_loop().time() + timeout
        while self._doc is None and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.25)
        return self._doc

    def summary_copy(self) -> dict:
        """WS #3 payload: the doc WITHOUT the heavy ``rows`` block, movers trimmed."""
        doc = self._doc
        if doc is None:
            return {}
        summary = {k: v for k, v in doc.items() if k != "rows"}
        movers = {}
        for key, rows in (doc.get("movers") or {}).items():
            movers[key] = rows[:WS_MOVER_LIMIT]
        summary["movers"] = movers
        return summary


# --------------------------------------------------------------------------- #
# Cold-start candidate: last persisted scan from Mongo (bounded, best effort)   #
# --------------------------------------------------------------------------- #
async def parked_document() -> dict | None:
    try:
        from database.connection import get_db

        db = get_db()
        raw = await db.market_scan.find_one({"_id": "latest"})
        if isinstance(raw, dict) and raw.get("scan"):
            raw.pop("_id", None)
            return raw
    except Exception:  # noqa: BLE001
        return None
    return None


market_scan = MarketScan()
