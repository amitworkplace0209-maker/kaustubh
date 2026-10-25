"""Short-TTL single-flight cache for hot, read-mostly terminal reads.

The terminal pages poll the same small documents every few seconds. Against a
remote MongoDB (Atlas) every ``find_one`` costs a full network round trip, so a
page that needs six documents burns six round trips per poll. This module adds
two properties to those reads:

* **single-flight** — N concurrent callers of the same key share ONE loader
  coroutine, so navigating between two pages cannot double the query load;
* **bounded staleness** — a successful result is reused for at most ``ttl``
  seconds. The default is deliberately short (sub-second); order submission
  paths call :func:`invalidate` after every write, so a trade is visible on the
  very next read.

Correctness rules:

* errors are never cached (a transient DB failure must be retried);
* a fetch that started before an :func:`invalidate` is never allowed to
  repopulate the cache (generation guard), so a write can not be shadowed by an
  older in-flight read;
* one caller cancelling does not cancel the shared loader (``shield``); the
  remaining callers still receive the result.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any, Awaitable, Callable

logger = logging.getLogger("app.read_cache")

#: key -> (monotonic expiry, value)
_cache: dict[str, tuple[float, Any]] = {}
#: key -> shared loader future
_inflight: dict[str, asyncio.Future] = {}
#: key -> invalidation generation
_generation: dict[str, int] = {}


def _generation_for(key: str) -> int:
    return _generation.get(key, 0)


def invalidate(key: str) -> None:
    """Drop ``key`` and prevent an older in-flight fetch from re-caching it."""
    _cache.pop(key, None)
    _generation[key] = _generation_for(key) + 1


def invalidate_prefix(prefix: str) -> None:
    """Invalidate every cached key starting with ``prefix``."""
    for key in list(_cache):
        if key.startswith(prefix):
            invalidate(key)


def clear() -> None:
    """Drop every cached value (tests / maintenance)."""
    _cache.clear()
    for key in list(_generation):
        _generation[key] = _generation.get(key, 0) + 1


def stats() -> dict[str, int]:
    return {"keys": len(_cache), "in_flight": len(_inflight), "generations": len(_generation)}


async def get(key: str, loader: Callable[[], Awaitable[Any]], ttl: float = 0.75) -> Any:
    """Return a cached value or run ``loader`` once for all concurrent callers."""
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and hit[0] > now:
        return hit[1]

    pending = _inflight.get(key)
    if pending is not None:
        # The shared future is shielded so a cancelled page (unmount) cannot
        # cancel the fetch another page is waiting on.
        return await asyncio.shield(pending)

    generation = _generation_for(key)
    future = asyncio.ensure_future(loader())
    _inflight[key] = future

    def _consume(fut: asyncio.Future) -> None:
        if _inflight.get(key) is fut:
            _inflight.pop(key, None)
        # Retrieve failures even if every waiter was cancelled, otherwise
        # asyncio logs an unretrieved-exception warning at GC time.
        if not fut.cancelled():
            with contextlib.suppress(BaseException):
                _ = fut.exception()

    future.add_done_callback(_consume)

    value = await asyncio.shield(future)
    if ttl > 0 and _generation_for(key) == generation:
        _cache[key] = (time.monotonic() + ttl, value)
    return value
