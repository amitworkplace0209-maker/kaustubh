"""Controlled broker (Kotak) request layer.

Why this exists
    Every HTTP poll of /api/system used to translate into 4 direct broker SDK
    calls (order book, positions, holdings, limits) through ``_safe_call``.
    Several frontends polled /api/system every few seconds, so the small
    asyncio threadpool filled with concurrent SDK calls that the SDK itself
    serialises with a threading lock. Calls starved, ``wait_for`` timed them
    out, and a cancelled ``asyncio.to_thread`` leaves its thread running —
    so the backlog grew on every poll. Result: SAFE_CALL TIMEOUT storms,
    delayed feeds, and growing threads.

    This module replaces that with a single-flight, TTL'd, cooldown'd cache:

    - at most ONE broker call in flight per endpoint (concurrent callers of
      the same endpoint share the same future and get the same result);
    - a fresh successful snapshot is reused within ``ttl`` instead of hitting
      the broker again;
    - after a timeout/failure the endpoint rests for ``fail_cooldown`` and
      answers from the last-good snapshot (or ``None``), never re-hammering;
    - one global async gate serialises actual SDK calls (mirroring the SDK's
      own threading lock), so the threadpool can never be saturated again.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

logger = logging.getLogger("broker_cache")

# monotonic clock is used for TTL/cooldown math; convert to wall-clock for display.
_EPOCH_OFFSET = time.time() - time.monotonic()


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts + _EPOCH_OFFSET, tz=timezone.utc).isoformat()


class BrokerCache:
    def __init__(self) -> None:
        self._gate = asyncio.Semaphore(1)
        self._inflight: dict[str, asyncio.Future] = {}
        self._snapshot: dict[str, Any] = {}
        self._last_success: dict[str, float] = {}
        self._last_attempt: dict[str, float] = {}
        self._last_error: dict[str, str] = {}
        self._cooldown_until: dict[str, float] = {}

    @staticmethod
    def _now() -> float:
        # monotonic clock — safe for TTL/cooldown arithmetic.
        return time.monotonic()

    def status(self, endpoint: str) -> dict:
        now = self._now()
        ls = self._last_success.get(endpoint)
        return {
            "endpoint": endpoint,
            "in_flight": endpoint in self._inflight,
            "has_snapshot": endpoint in self._snapshot,
            "last_success": _iso(ls),
            "last_success_age_s": round(now - ls, 1) if ls is not None else None,
            "last_attempt": _iso(self._last_attempt.get(endpoint)),
            "last_error": self._last_error.get(endpoint),
            "cooldown_remaining_s": round(max(0.0, self._cooldown_until.get(endpoint, 0.0) - now), 1),
        }

    def invalidate(self, endpoint: str) -> None:
        """Drop every cached artifact for ``endpoint`` so the next read is a
        live broker round trip (used by the Broker Terminal refresh path).

        An in-flight future is intentionally left alone — its completing fetch
        writes a freshly computed snapshot, which is exactly what a forced
        refresh wants.
        """
        self._snapshot.pop(endpoint, None)
        self._last_success.pop(endpoint, None)
        self._last_attempt.pop(endpoint, None)
        self._last_error.pop(endpoint, None)
        self._cooldown_until.pop(endpoint, None)

    def summary(self) -> dict:
        return {
            "endpoints": sorted(
                {
                    *self._snapshot.keys(),
                    *self._last_success.keys(),
                    *self._last_error.keys(),
                    *self._inflight.keys(),
                }
            ),
            "in_flight_count": len(self._inflight),
        }

    async def get(
        self,
        endpoint: str,
        fetch: Callable[[], Awaitable[Any]],
        *,
        ttl: float = 15.0,
        fail_cooldown: float = 20.0,
        timeout: float = 4.0,
        force: bool = False,
    ) -> Any:
        """Return the freshest broker result without ever flooding the SDK.

        - fresh snapshot -> return it (no broker round trip);
        - in cooldown after a failure -> return last-good snapshot, no call;
        - already in flight -> await the shared future (single-flight);
        - otherwise issue exactly one call, serialised through the gate.
        """
        now = self._now()

        if not force and endpoint in self._snapshot and (now - self._last_success.get(endpoint, 0.0)) < ttl:
            return self._snapshot[endpoint]

        if not force and now < self._cooldown_until.get(endpoint, 0.0):
            return self._snapshot.get(endpoint)

        fut = self._inflight.get(endpoint)
        if isinstance(fut, asyncio.Future):
            await self._await_future(fut)
            return self._snapshot.get(endpoint)

        fut = asyncio.ensure_future(
            self._call(endpoint, fetch, timeout=timeout, fail_cooldown=fail_cooldown)
        )
        self._inflight[endpoint] = fut

        def _on_done(f: asyncio.Future) -> None:
            if self._inflight.get(endpoint) is f:
                self._inflight.pop(endpoint, None)
            # Retrieve the exception so asyncio does not warn about an
            # unretrieved exception on the shared future.
            if not f.cancelled():
                with contextlib.suppress(BaseException):
                    _ = f.exception()

        fut.add_done_callback(_on_done)
        await self._await_future(fut)
        return self._snapshot.get(endpoint)

    async def _await_future(self, fut: asyncio.Future) -> None:
        try:
            await fut
        except asyncio.CancelledError:
            raise
        except Exception:
            # The shared future failed — the fetch already recorded the error
            # and entered cooldown; callers simply get the last-good snapshot.
            pass

    async def _call(
        self,
        endpoint: str,
        fetch: Callable[[], Awaitable[Any]],
        *,
        timeout: float,
        fail_cooldown: float,
    ) -> Any:
        self._last_attempt[endpoint] = self._now()
        try:
            async with self._gate:
                result = await asyncio.wait_for(fetch(), timeout=timeout)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            self._last_error[endpoint] = f"timeout after {timeout:g}s"
            self._cooldown_until[endpoint] = self._now() + fail_cooldown
            logger.warning(
                "BROKER_REQUEST_TIMEOUT endpoint=%s timeout=%.1fs cooldown=%.0fs in_flight=%d",
                endpoint, timeout, fail_cooldown, len(self._inflight),
            )
            return None
        except Exception as exc:
            self._last_error[endpoint] = f"{type(exc).__name__}: {exc}"
            self._cooldown_until[endpoint] = self._now() + fail_cooldown
            logger.warning("BROKER_REQUEST_FAILED endpoint=%s error=%r cooldown=%.0fs", endpoint, exc, fail_cooldown)
            return None

        self._snapshot[endpoint] = result
        self._last_success[endpoint] = self._now()
        self._last_error.pop(endpoint, None)
        self._cooldown_until.pop(endpoint, None)
        logger.debug("BROKER_REQUEST_SUCCESS endpoint=%s", endpoint)
        return result


broker_cache = BrokerCache()