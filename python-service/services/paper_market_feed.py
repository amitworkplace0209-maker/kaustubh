"""Paper Market Feed — the Dummy terminal's OWN real-time LTP source.

The paper engine (``api.demo``) prices and fills every order from the REAL last
traded price, never from a fabricated number. Until now that price only reached
the paper engine because a browser happened to be open: ``lib/dummy-ltp.ts``
batched ticks from ``/api/ticks/stream`` and POSTed them to ``/api/demo/ltp``.

That made execution a function of who had the UI open — a resting dummy order
would sit forever unless a Dummy page happened to be mounted, which is the exact
opposite of how a broker behaves. A broker carries its own market feed and works
whether or not anyone is watching.

This module is that missing feed. It taps the backend's own WS#1 tick buffer
(``services.tick_buffer``), which every real broker tick already flows through,
coalesces the high-frequency tick stream into symbol→LTP batches, and pushes
them into the paper engine's LTP funnel. Execution therefore becomes
browser-independent and genuinely real-time.

Design rules, in order of importance:

1. Only REAL prices are forwarded. A tick without a positive ``ltp`` is dropped,
   so the paper engine can never invent a market price.
2. Never block the tick pipeline. The consumer is a separate asyncio task with a
   bounded queue; a slow or failing paper engine can never stall WS#1.
3. Keep the broker subscribed to what the paper book is exposed to. A resting
   paper order is meaningless without a live price, so the feed asks the broker
   to subscribe to the tokens the paper book actually holds.
4. A dead feed is reported honestly — never papered over with a stale or
   synthetic price.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any

logger = logging.getLogger("paper_market_feed")

#: Ticks arrive per-token and per-trade; the paper engine only needs the latest
#: price per symbol, so a short coalescing window keeps the funnel (and Mongo)
#: at order-of-magnitude lower write volume than the raw feed.
FLUSH_INTERVAL_SEC = 0.25

#: Hard cap on one batch so a burst of thousands of ticks cannot build an
#: unbounded payload; the remainder is carried into the next window.
MAX_BATCH = 500

#: How often to re-assert broker feed subscriptions for paper-book instruments.
SUBSCRIBE_REFRESH_SEC = 45.0

#: A tick older than this is treated as stale and not forwarded, so a feed that
#: died silently cannot keep "executing" orders against a frozen price.
MAX_TICK_AGE_SEC = 180.0


def _to_float(value: Any) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return 0.0
    return out if out == out and out not in (float("inf"), float("-inf")) and out > 0 else 0.0


def _tick_symbol(tick: dict) -> str:
    """Best available symbol for a tick (``record_latest`` normalizes all three)."""
    for key in ("symbol", "tradingSymbol", "trading_symbol"):
        sym = str(tick.get(key) or "").strip().upper()
        if sym:
            return sym
    return ""


def _tick_token(tick: dict) -> str:
    """Broker instrument token for a tick, when the feed carried one."""
    for key in ("instrumentToken", "instrument_token", "token", "tk"):
        token = str(tick.get(key) or "").strip()
        if token:
            return token
    return ""


def _tick_ltp(tick: dict) -> float:
    """Positive real LTP from a tick, or 0.0 when the tick carries no price."""
    for key in ("ltp", "lastPrice", "last_price", "lastTradedPrice"):
        price = _to_float(tick.get(key))
        if price > 0:
            return price
    return 0.0


def _tick_age_sec(tick: dict) -> float | None:
    """Age of a tick in seconds from its own timestamp, or None if unknown."""
    for key in ("receivedAt", "received_at", "ts", "timestamp"):
        raw = tick.get(key)
        if raw is None or raw == "":
            continue
        if isinstance(raw, (int, float)):
            value = float(raw)
            if value > 1e11:  # milliseconds
                value /= 1000.0
        else:
            try:
                from datetime import datetime, timezone

                text = str(raw).strip().replace("Z", "+00:00")
                parsed = datetime.fromisoformat(text)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                value = parsed.timestamp()
            except Exception:  # noqa: BLE001 — an unreadable stamp is just "unknown"
                continue
        age = time.time() - value
        if age >= 0:
            return age
    return None


class PaperMarketFeed:
    """Server-side bridge: real WS ticks -> paper engine LTP funnel."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._listener: asyncio.Queue | None = None
        self._pending: dict[tuple[str, str], float] = {}
        self._running = False
        self._last_subscribe_at = 0.0
        self._subscribed_tokens: set[str] = set()
        self._counters = {
            "ticksSeen": 0,
            "ticksForwarded": 0,
            "ticksDroppedNoPrice": 0,
            "ticksDroppedStale": 0,
            "batchesPushed": 0,
            "engineErrors": 0,
            "queueDrops": 0,
        }

    # ---- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        """Attach to the tick buffer and run the pump. Idempotent."""
        if self._running:
            return
        from services import tick_buffer

        self._listener = tick_buffer.add_listener()
        self._pending = {}
        self._running = True
        self._task = asyncio.create_task(self._run())
        logger.info("Paper Market Feed: READY (real WS ticks -> paper engine)")

    async def stop(self) -> None:
        self._running = False
        if self._listener is not None:
            try:
                from services import tick_buffer

                tick_buffer.remove_listener(self._listener)
            except Exception as exc:  # noqa: BLE001
                logger.debug("paper feed listener detach skipped: %s", exc)
            self._listener = None
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(task), timeout=3)
        logger.info("Paper Market Feed: STOPPED")

    @property
    def running(self) -> bool:
        return self._running

    def status(self) -> dict[str, Any]:
        """Diagnostics for the Order Engine page — feed health, never invented."""
        try:
            from services import tick_buffer

            stats = tick_buffer.stats()
        except Exception as exc:  # noqa: BLE001
            logger.debug("paper feed status probe skipped: %s", exc)
            stats = {}
        # "Upstream is receiving" means the real broker feed is actually
        # delivering ticks right now. Reported as its own flag so the UI can say
        # "no live market data" instead of implying prices are flowing.
        ticks_per_second = float(stats.get("ticksPerSecond", 0.0) or 0.0)
        return {
            "running": self._running,
            "source": "services.tick_buffer (WS#1 real broker feed)",
            "browserDependent": False,
            "flushIntervalSec": FLUSH_INTERVAL_SEC,
            "pendingInstruments": len(self._pending),
            "subscribedTokens": len(self._subscribed_tokens),
            "upstreamTicksPerSecond": ticks_per_second,
            "upstreamFeedReceiving": ticks_per_second > 0,
            "lastUpstreamTickAt": stats.get("lastTickAt"),
            "upstreamTotalReceived": int(stats.get("totalReceived", 0) or 0),
            "counters": dict(self._counters),
        }

    # ---- internals ---------------------------------------------------------

    async def _run(self) -> None:
        listener = self._listener
        assert listener is not None
        while self._running:
            try:
                # Wait for the next real tick, then drain whatever else is
                # already queued so a burst becomes one coalesced batch.
                try:
                    tick = await asyncio.wait_for(listener.get(), timeout=FLUSH_INTERVAL_SEC)
                except asyncio.TimeoutError:
                    tick = None
                if tick is not None and isinstance(tick, dict):
                    self._ingest(tick)
                while True:
                    try:
                        extra = listener.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if isinstance(extra, dict):
                        self._ingest(extra)

                if self._pending:
                    await self._flush()
                await self._maybe_refresh_subscriptions()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — the pump must never die
                self._counters["engineErrors"] += 1
                logger.warning("Paper Market Feed pump error (continuing): %s", exc)
                await asyncio.sleep(FLUSH_INTERVAL_SEC)

    def _ingest(self, tick: dict) -> None:
        """Keep only the newest positive, fresh LTP per instrument."""
        self._counters["ticksSeen"] += 1
        symbol = _tick_symbol(tick)
        price = _tick_ltp(tick)
        if not symbol or price <= 0:
            # Market-status / CAS / subscription-ack frames share this path;
            # they are not prices and must never become one.
            self._counters["ticksDroppedNoPrice"] += 1
            return
        age = _tick_age_sec(tick)
        if age is not None and age > MAX_TICK_AGE_SEC:
            self._counters["ticksDroppedStale"] += 1
            return
        key = (symbol, _tick_token(tick))
        if len(self._pending) >= MAX_BATCH and key not in self._pending:
            return
        self._pending[key] = price

    async def _flush(self) -> None:
        window = list(self._pending.items())[:MAX_BATCH]
        if not window:
            return
        batch = [
            {"symbol": sym, "token": token, "ltp": price}
            for (sym, token), price in window
        ]
        try:
            from api.demo import apply_demo_ltp

            await apply_demo_ltp(batch)
            self._counters["ticksForwarded"] += len(batch)
            self._counters["batchesPushed"] += 1
        except Exception as exc:  # noqa: BLE001 — a paper-engine fault is not a feed fault
            self._counters["engineErrors"] += 1
            logger.warning("Paper Market Feed -> paper engine push failed: %s", exc)
        finally:
            # Only the forwarded window is dropped. Anything that piled up past
            # MAX_BATCH stays pending for the next window.
            for key, price in window:
                if self._pending.get(key) == price:
                    self._pending.pop(key, None)

    async def _maybe_refresh_subscriptions(self) -> None:
        """Keep the broker feed subscribed to what the paper book is exposed to.

        A resting paper order cannot fill without a live price, so the tokens
        behind resting paper orders are pushed to the real feed. Best-effort:
        with no broker session there is nothing to subscribe to, and the pump
        keeps running regardless.
        """
        now = time.time()
        if now - self._last_subscribe_at < SUBSCRIBE_REFRESH_SEC:
            return
        self._last_subscribe_at = now
        try:
            from api.demo import get_dummy_orders

            orders = await get_dummy_orders()
        except Exception as exc:  # noqa: BLE001
            logger.debug("paper feed order scan skipped: %s", exc)
            return

        needed: dict[str, str] = {}
        for order in orders or []:
            if str(order.get("status") or "").upper() not in (
                "PENDING", "OPEN", "TRIGGER_PENDING", "PARTIALLY_FILLED",
            ):
                continue
            token = str(order.get("token") or "").strip()
            if token:
                needed[token] = str(order.get("symbol") or "")

        stale = self._subscribed_tokens - set(needed)
        self._subscribed_tokens = set(needed)
        if not needed and not stale:
            return
        try:
            from auth.kotak_client import kotak_session
            from ws_socket.ws_manager import ws_manager

            if not kotak_session.logged_in:
                return
            for token, symbol in needed.items():
                await ws_manager.subscribe([
                    {"exchange_segment": "nse_cm", "instrument_token": token, "symbol": symbol},
                ])
            if stale:
                await ws_manager.unsubscribe([
                    {"exchange_segment": "nse_cm", "instrument_token": t, "symbol": ""} for t in stale
                ])
            if needed or stale:
                logger.info(
                    "Paper Market Feed: broker feed subscribed for %d paper-book instrument(s)",
                    len(needed),
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("paper feed subscription refresh skipped: %s", exc)


paper_market_feed = PaperMarketFeed()