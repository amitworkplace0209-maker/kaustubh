"""
Margin / intraday fact resolver — the PRODUCER side of the margin contract.

WHY THIS EXISTS
---------------
``services/market_watch_eligibility.margin_decision`` consumes an authoritative
margin decision for every symbol, and three other consumers read the same field
— but nothing in the codebase ever WROTE it. With the weekly screen's margin rule
switched on, that made the screen unusable: every stock would have been rejected
as ``MARGIN_UNAVAILABLE``.

This module closes that gap. It resolves per-symbol leverage from the broker's
own margin API and publishes it into the session snapshot that the consumers
already read.

WHY IT IS NOT NAMED ``market_watch_*``
--------------------------------------
Because Market Watch must never reach into a broker client — that boundary is
architecture, not a naming preference: Market Watch CONSUMES broker facts through
the session snapshot, and something that actually calls the broker is not Market
Watch's code. This module is that something. It deliberately sits outside the
``market_watch_*`` namespace so the boundary stays visible, and so a Market Watch
module can depend on it without a reviewer assuming Market Watch grew a broker
dependency.

HOW A MULTIPLIER IS DERIVED (and why it is real)
-------------------------------------------------
The broker's margin API answers a different question than "what is the leverage":
it answers "how much margin for N units at price P". Leverage is therefore
recovered from the answer as

    multiplier = notional / margin   where   notional = quantity x price

For a 5x margin, a 1-unit MIS buy at the LTP comes back with roughly
``ltp / 5`` of margin, giving a multiplier of ~5.0. This is a genuine derivation
from the broker's own arithmetic — not a segment guess, not a table, not a
constant.

The observed LTP is passed AS THE PRICE so the derivation is self-consistent:
the notional the multiplier is divided by is exactly the notional the broker
priced.

HONESTY
-------
* No session, no broker support, no numeric token, a timeout, an error envelope,
  or an unparseable answer all resolve to ``UNAVAILABLE`` — never to a guess.
* ``multiplier=None`` is a real answer meaning "the broker did not tell us", and
  the screen rejects on it. That is the intended behaviour: a stock whose margin
  was never established must not be silently waved into the live list.
* NOTHING is published when the broker did not answer, so a consumer's
  "absent means unknown" reading stays true.
* Results are cached, with a much shorter TTL for failures so a transient broker
  outage is re-probed quickly while a real answer is not re-fetched every scan.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional

from services.market_watch_intraday import (
    MARGIN_AUTHORITATIVE,
    MARGIN_UNAVAILABLE_STATUS,
    extract_margin_amount,
    margin_multiplier_from_preview,
)

logger = logging.getLogger("app.margin_resolver")

#: A real broker answer is stable for a trading day; re-asking every scan would
#: be pure load on the broker for a number that does not move meaningfully.
MARGIN_TTL_SECONDS = 900.0
#: A failure is re-probed far sooner — a logged-out session or a broker blip
#: should not pin "unavailable" for a quarter of an hour.
MARGIN_FAILURE_TTL_SECONDS = 30.0

#: MIS is the intraday product, so MIS margin is the only figure that answers
#: "can this be traded intraday, and at what leverage".
PRODUCT = "MIS"

def _env_number(name: str, default: float, minimum: float) -> float:
    """Read an operator tuning knob without letting a typo stop the service."""
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return max(minimum, value)


#: Concurrency against the broker. Kotak disconnects large bursts of
#: check-margin calls ("Server disconnected") and rate-limits sustained abuse
#: (HTTP 429). The SDK client is also not reliably thread-safe, so a recovery
#: run can drop to one worker with ``MWR_MARGIN_CONCURRENCY=1``.
MAX_CONCURRENCY = int(_env_number("MWR_MARGIN_CONCURRENCY", 3, 1))
MARGIN_MIN_INTERVAL_SECONDS = _env_number("MWR_MARGIN_MIN_INTERVAL", 0.2, 0.0)
#: Kotak's margin endpoint is slow under load (especially around the close):
#: a 4 s ceiling produced a first-attempt timeout on most symbols while the
#: retry succeeded. Give the broker room to answer instead of manufacturing a
#: transport failure.
PER_CALL_TIMEOUT_SECONDS = _env_number("MWR_MARGIN_TIMEOUT", 20.0, 1.0)

#: A full NSE EQ scan needs ~2,000 check-margin calls. Kotak's quota resets
#: after a few minutes, but a sustained 3-worker run reaches the ceiling before
#: the scan is done. When that happens, every worker shares one cooldown and the
#: call is retried instead of being recorded as a false "margin unavailable".
#: The backoff is deliberately gradual: a single 429 is a quota signal, not a
#: reason to abandon the whole screen.
RATE_LIMIT_BACKOFF_SECONDS = (30.0, 60.0, 120.0, 240.0, 300.0)
#: Transport blips ("Server disconnected", timeouts) get a few spaced retries
#: before the batch is declared unusable.
TRANSIENT_BACKOFF_SECONDS = (2.0, 5.0, 10.0)


class MarginBrokerUnavailable(RuntimeError):
    """The broker could not answer margin, so the screen must not lock.

    A partial margin answer is more dangerous than no answer: it would lock a
    universe that silently omitted every symbol whose batch happened to land
    after a rate limit. The scan treats this as fatal and keeps the previous
    locked universe.
    """


def _text_is_rate_limit(text: str) -> bool:
    value = str(text or "").lower()
    return (
        "rate limit" in value
        or "too many request" in value
        or "too many requests" in value
        or "100025" in value
    )


def _payload_is_rate_limit(payload: Any) -> bool:
    """Detect a quota envelope without inspecting numeric margin values.

    A blanket ``json.dumps(payload)`` check would treat a legitimate required
    margin of ``100025`` as the Kotak rate-limit code. Only status/error fields
    are examined here.
    """
    if isinstance(payload, str):
        return _text_is_rate_limit(payload)
    if not isinstance(payload, Mapping):
        return False
    rows: list[Mapping[str, Any]] = [payload]
    data = payload.get("data")
    if isinstance(data, Mapping):
        rows.append(data)
    elif isinstance(data, list):
        rows.extend(row for row in data if isinstance(row, Mapping))
    for row in rows:
        for key in ("stCode", "statusCode", "status_code", "code"):
            value = row.get(key)
            if value is not None and str(value).strip() == "100025":
                return True
        for key in ("error", "Error", "errMsg", "message", "stat", "status"):
            value = row.get(key)
            if value is not None and _text_is_rate_limit(str(value)):
                return True
    return False


def _payload_error_text(payload: Any) -> str:
    """Best-effort human-readable error text from a broker envelope."""
    if not isinstance(payload, Mapping):
        return str(payload or "")
    parts: list[str] = []
    for key in ("error", "Error", "errMsg", "message", "stat", "stCode"):
        if key in payload and payload.get(key) is not None:
            parts.append(f"{key}={payload.get(key)}")
    rows = payload.get("data")
    if isinstance(rows, Mapping):
        for key in ("error", "Error", "errMsg", "message", "stat", "stCode"):
            if key in rows and rows.get(key) is not None:
                parts.append(f"data.{key}={rows.get(key)}")
    elif isinstance(rows, list):
        for row in rows[:1]:
            if isinstance(row, Mapping):
                for key in ("error", "Error", "errMsg", "message", "stat", "stCode"):
                    if key in row and row.get(key) is not None:
                        parts.append(f"data.{key}={row.get(key)}")
    return " | ".join(parts)


def _is_fatal_auth_error(text: str) -> bool:
    value = str(text or "").lower()
    return any(
        marker in value
        for marker in (
            "session expired",
            "invalid token",
            "token expired",
            "unauthorized",
            "not logged in",
            "session not",
            "authentication failed",
            "stcode=401",
            "stcode=403",
        )
    )


@dataclass(frozen=True)
class MarginAnswer:
    """One symbol's resolved margin fact, with the provenance attached."""

    token: str
    eligible: bool = False
    multiplier: Optional[float] = None
    margin_amount: Optional[float] = None
    status: str = MARGIN_UNAVAILABLE_STATUS
    basis: str = ""
    reason: str = ""
    resolved_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "eligible": self.eligible,
            "reason": self.reason,
            "multiplier": self.multiplier,
            "marginAmount": self.margin_amount,
            "status": self.status,
            "basis": self.basis,
            "intradayStatus": self.intraday_status,
            "resolvedAt": self.resolved_at,
        }

    @property
    def intraday_status(self) -> str:
        """Intraday availability implied by this answer.

        The broker computing a MIS margin figure for an instrument IS the
        evidence that the instrument is intraday-priceable — it is the same MIS
        product an intraday order needs. So intraday is ``ELIGIBLE`` whenever the
        broker ANSWERED, and it stays ``UNKNOWN`` only when it did not.

        It is deliberately NOT tied to ``eligible``: a stock with real 1.25x
        leverage is genuinely intraday-available, it simply fails the operator's
        5x threshold. Reporting that as "intraday unknown" would blame the wrong
        rule and send the review screen after the wrong reason.
        """
        return "ELIGIBLE" if self.status == MARGIN_AUTHORITATIVE else "UNKNOWN"

    def to_screen_facts(self, *, ltp: Optional[float], symbol: str = "") -> dict[str, Any]:
        """Shape for ``market_watch_intraday.screen_records``."""
        return {
            "instrumentToken": self.token,
            "symbol": symbol,
            "ltp": ltp,
            "marginMultiplier": self.multiplier,
            "marginStatus": self.status,
            "marginBasis": self.basis,
            "intradayStatus": self.intraday_status,
        }


@dataclass
class ResolverStats:
    scans: int = 0
    resolved: int = 0
    unavailable: int = 0
    cache_hits: int = 0
    broker_calls: int = 0
    broker_errors: int = 0
    rate_limited: int = 0
    published: int = 0
    last_scan_at: Optional[float] = None
    last_reason: str = ""
    per_token: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "scans": self.scans,
            "resolved": self.resolved,
            "unavailable": self.unavailable,
            "cacheHits": self.cache_hits,
            "brokerCalls": self.broker_calls,
            "brokerErrors": self.broker_errors,
            "rateLimited": self.rate_limited,
            "published": self.published,
            "lastScanAt": self.last_scan_at,
            "lastReason": self.last_reason,
        }


class MarginResolver:
    """Resolves and publishes per-symbol margin facts for the weekly screen."""

    def __init__(self) -> None:
        # token -> (resolved_at, MarginAnswer)
        self._cache: dict[str, tuple[float, MarginAnswer]] = {}
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
        self._last_broker_call_at = 0.0
        self._cooldown_until = 0.0
        self._rate_limit_streak = 0
        self.stats = ResolverStats()

    # ------------------------------------------------------------------ #
    # Broker plumbing
    # ------------------------------------------------------------------ #

    @staticmethod
    def _session():
        """The live broker session, or None when no session is established."""
        try:
            from auth.kotak_client import kotak_session
        except Exception:
            return None
        return kotak_session if getattr(kotak_session, "session_active", False) else None

    async def _wait_for_cooldown(self) -> None:
        """Wait for the shared rate-limit cooldown without holding a worker."""
        while True:
            delay = self._cooldown_until - time.monotonic()
            if delay <= 0:
                return
            # Re-check periodically: another worker may extend the cooldown
            # after this worker started sleeping.
            await asyncio.sleep(min(delay, 5.0))

    def _note_rate_limit(self) -> None:
        self.stats.rate_limited += 1
        now = time.monotonic()
        if now < self._cooldown_until:
            # Several workers can see the same quota wall within milliseconds.
            # Keep one cooldown for the burst; only a retry AFTER the cooldown
            # proves the quota is still exhausted and should escalate.
            index = max(0, self._rate_limit_streak - 1)
            delay = RATE_LIMIT_BACKOFF_SECONDS[
                min(index, len(RATE_LIMIT_BACKOFF_SECONDS) - 1)
            ]
            self._cooldown_until = max(self._cooldown_until, now + delay)
        else:
            index = min(
                self._rate_limit_streak, len(RATE_LIMIT_BACKOFF_SECONDS) - 1
            )
            delay = RATE_LIMIT_BACKOFF_SECONDS[index]
            self._rate_limit_streak += 1
            self._cooldown_until = now + delay
        self.stats.last_reason = f"broker rate limit; cooling down {delay:.0f}s"
        logger.warning("[MARGIN] broker rate limit; cooling down %.0fs", delay)

    async def _ask_broker(
        self, session: Any, *, token: str, segment: str, ltp: float,
    ) -> tuple[Optional[float], str]:
        """One broker margin call with rate-limit and transport recovery.

        Returns ``(margin_amount, error_reason)``. ``(None, "")`` means the
        broker answered but the answer carried no recognisable margin figure —
        distinguishable from a failure so the operator-facing reason is
        accurate.

        Raises ``MarginBrokerUnavailable`` when the broker never answered after
        retries. The caller must treat that as fatal: continuing would produce a
        partial universe that looks complete.
        """
        rate_attempts = 0
        transient_attempts = 0
        while True:
            await self._wait_for_cooldown()
            async with self._semaphore:
                # Serialize AND pace: the broker disconnects bursts and returns
                # HTTP 429 when check-margin is called too quickly.
                await self._wait_for_cooldown()
                gap = MARGIN_MIN_INTERVAL_SECONDS - (
                    time.monotonic() - self._last_broker_call_at
                )
                if gap > 0:
                    await asyncio.sleep(gap)
                self._last_broker_call_at = time.monotonic()
                try:
                    payload = await asyncio.wait_for(
                        session.async_margin_required(
                            exchange=segment,
                            token=token,
                            product=PRODUCT,
                            order_type="MKT",
                            quantity="1",
                            # Price the notional with the SAME price the broker
                            # is asked to price, so multiplier =
                            # notional/margin is internally consistent.
                            price=str(round(float(ltp), 2)),
                            transaction_type="BUY",
                        ),
                        timeout=PER_CALL_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    payload = None
                    error_text = (
                        f"broker margin call timed out after "
                        f"{PER_CALL_TIMEOUT_SECONDS}s"
                    )
                except Exception as exc:
                    payload = None
                    error_text = f"broker margin call failed: {exc}"

            if payload is None:
                if _text_is_rate_limit(error_text):
                    self._note_rate_limit()
                    rate_attempts += 1
                    if rate_attempts > len(RATE_LIMIT_BACKOFF_SECONDS):
                        raise MarginBrokerUnavailable(
                            f"broker rate limit persisted after "
                            f"{rate_attempts} attempts"
                        )
                    continue
                if transient_attempts < len(TRANSIENT_BACKOFF_SECONDS):
                    delay = TRANSIENT_BACKOFF_SECONDS[transient_attempts]
                    transient_attempts += 1
                    self.stats.broker_errors += 1
                    logger.warning(
                        "[MARGIN] transient broker error (%s); retrying in %.0fs",
                        error_text, delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                self.stats.broker_errors += 1
                raise MarginBrokerUnavailable(error_text)

            if _payload_is_rate_limit(payload):
                self._note_rate_limit()
                rate_attempts += 1
                if rate_attempts > len(RATE_LIMIT_BACKOFF_SECONDS):
                    raise MarginBrokerUnavailable(
                        f"broker rate limit persisted after {rate_attempts} attempts"
                    )
                continue

            error_text = _payload_error_text(payload)
            if _is_fatal_auth_error(error_text):
                self.stats.broker_errors += 1
                raise MarginBrokerUnavailable(
                    f"broker margin session error: {error_text}"
                )

            # A real answer resets the quota backoff. The next burst starts at
            # the shortest cooldown again.
            self._rate_limit_streak = 0
            self.stats.broker_calls += 1
            margin = extract_margin_amount(payload)
            if margin is None:
                return None, (
                    "broker returned no recognisable margin figure"
                    + (f" ({error_text})" if error_text else "")
                )
            return margin, ""

    # ------------------------------------------------------------------ #
    # Cache
    # ------------------------------------------------------------------ #

    def _cached(self, token: str) -> Optional[MarginAnswer]:
        entry = self._cache.get(token)
        if not entry:
            return None
        stored_at, answer = entry
        ttl = (
            MARGIN_TTL_SECONDS
            if answer.status == MARGIN_AUTHORITATIVE
            else MARGIN_FAILURE_TTL_SECONDS
        )
        if (time.time() - stored_at) >= ttl:
            return None
        self.stats.cache_hits += 1
        return answer

    def _store(self, answer: MarginAnswer) -> None:
        self._cache[answer.token] = (time.time(), answer)

    def prime(self, answers: Iterable[MarginAnswer]) -> None:
        """Adopt answers resolved earlier (e.g. restored from storage)."""
        for answer in answers or []:
            if isinstance(answer, MarginAnswer) and answer.token:
                self._store(answer)

    def cached_answer(self, token: str) -> Optional[MarginAnswer]:
        return self._cache.get(str(token or ""), (0.0, None))[1]

    # ------------------------------------------------------------------ #
    # Resolution
    # ------------------------------------------------------------------ #

    async def resolve(
        self,
        rows: Iterable[Mapping[str, Any]],
        *,
        threshold: float = 5.0,
        segment: str = "nse_cm",
    ) -> dict[str, MarginAnswer]:
        """Resolve margin facts for ``rows``.

        Each row needs ``instrumentToken`` and ``ltp``. Rows missing either are
        resolved to UNAVAILABLE without a broker call — a price is the divisor of
        the multiplier, so without it there is nothing to derive and nothing
        honest to report.
        """
        rows = list(rows or [])
        self.stats.scans += 1
        self.stats.last_scan_at = time.time()

        answers: dict[str, MarginAnswer] = {}
        pending: list[tuple[str, float]] = []

        for row in rows:
            token = str(row.get("instrumentToken") or row.get("token") or "").strip()
            if not token:
                continue
            cached = self._cached(token)
            if cached is not None:
                answers[token] = cached
                continue
            try:
                ltp = float(row.get("ltp"))
            except (TypeError, ValueError):
                ltp = None
            if ltp is None or ltp <= 0:
                answers[token] = self._store_answer(MarginAnswer(
                    token=token,
                    status=MARGIN_UNAVAILABLE_STATUS,
                    basis="none",
                    reason="no positive LTP to price the notional against",
                    resolved_at=time.time(),
                ))
                continue
            if not token.isdigit():
                answers[token] = self._store_answer(MarginAnswer(
                    token=token,
                    status=MARGIN_UNAVAILABLE_STATUS,
                    basis="none",
                    reason="instrument has no numeric token, so the broker cannot price it",
                    resolved_at=time.time(),
                ))
                continue
            pending.append((token, ltp))

        if pending:
            session = self._session()
            if session is None:
                self.stats.last_reason = "no active broker session"
                # Do not return a batch of per-symbol UNAVAILABLE answers here:
                # if the session dropped after an earlier batch, the caller
                # would see some resolved answers and could mistake the rest
                # for a legitimate "no margin" screen. A missing session is a
                # broker outage, and the scan must abort rather than lock a
                # partial universe.
                raise MarginBrokerUnavailable(
                    "no active broker session; margin cannot be verified"
                )
            else:
                tasks = [
                    asyncio.create_task(
                        self._resolve_one_and_store(
                            session, token, ltp, segment, threshold
                        )
                    )
                    for token, ltp in pending
                ]
                try:
                    resolved = await asyncio.gather(*tasks)
                except Exception:
                    # A fatal broker condition invalidates the whole batch.
                    # Cancel siblings so a 429 storm does not keep spending
                    # quota after the decision to abort has been made.
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    raise
                for answer in resolved:
                    answers[answer.token] = answer

        self._tally(answers)
        return answers

    def _store_answer(self, answer: MarginAnswer) -> MarginAnswer:
        self._cache[answer.token] = (time.time(), answer)
        return answer

    async def _resolve_one_and_store(
        self, session: Any, token: str, ltp: float, segment: str, threshold: float,
    ) -> MarginAnswer:
        """Resolve one symbol and cache the answer immediately.

        Caching per answer (rather than after the whole batch) means a later
        rate-limit abort does not throw away every completed call. A retry can
        resume from the cached prefix instead of re-spending broker quota.
        """
        return self._store_answer(
            await self._resolve_one(session, token, ltp, segment, threshold)
        )

    async def _resolve_one(
        self, session: Any, token: str, ltp: float, segment: str, threshold: float,
    ) -> MarginAnswer:
        margin, error = await self._ask_broker(
            session, token=token, segment=segment, ltp=ltp,
        )
        now = time.time()
        if margin is None:
            return MarginAnswer(
                token=token, status=MARGIN_UNAVAILABLE_STATUS,
                basis="broker", reason=error, resolved_at=now,
            )
        multiplier = margin_multiplier_from_preview(ltp, margin)
        if multiplier is None:
            # A positive price against a non-positive margin is a broker figure
            # this module cannot interpret. Reporting it as a multiplier would
            # be a fabricated answer.
            return MarginAnswer(
                token=token, margin_amount=margin,
                status=MARGIN_UNAVAILABLE_STATUS, basis="broker",
                reason=f"broker margin {margin} yields no usable multiplier for notional {ltp}",
                resolved_at=now,
            )
        eligible = multiplier >= threshold
        return MarginAnswer(
            token=token, eligible=eligible, multiplier=multiplier,
            margin_amount=margin, status=MARGIN_AUTHORITATIVE, basis="broker",
            reason=(
                f"{multiplier:.2f}x on 1 unit MIS at {ltp:.2f} "
                f"(margin {margin:.2f}) — meets {threshold:.2f}x"
                if eligible else
                f"{multiplier:.2f}x on 1 unit MIS at {ltp:.2f} "
                f"(margin {margin:.2f}) — below {threshold:.2f}x"
            ),
            resolved_at=now,
        )

    def _tally(self, answers: Mapping[str, MarginAnswer]) -> None:
        for answer in answers.values():
            if answer.status == MARGIN_AUTHORITATIVE:
                self.stats.resolved += 1
            else:
                self.stats.unavailable += 1

    # ------------------------------------------------------------------ #
    # Publication
    # ------------------------------------------------------------------ #

    def publish(self, answers: Mapping[str, MarginAnswer]) -> dict[str, int]:
        """Publish ANSWERED decisions into the session snapshot.

        Only ``AUTHORITATIVE`` answers are published. Publishing an unanswered
        symbol as ``eligible: False`` would be indistinguishable from the broker
        saying no, which is a different and much stronger claim than "we asked
        and did not find out".
        """
        decided = {
            token: answer.to_dict()
            for token, answer in (answers or {}).items()
            if answer.status == MARGIN_AUTHORITATIVE
        }
        if not decided:
            self.stats.published = 0
            return {"published": 0, "total": 0}
        try:
            from services.session.session_manager import session_manager

            result = session_manager.publish_margin_decisions(decided)
        except Exception as exc:
            logger.warning("[MARGIN] publish failed: %s", exc)
            self.stats.last_reason = f"publish failed: {exc}"
            return {"published": 0, "total": 0}
        self.stats.published = int(result.get("published") or 0)
        self.stats.per_token = decided
        return result

    def status(self) -> dict[str, Any]:
        session = self._session()
        return {
            **self.stats.to_dict(),
            "sessionActive": session is not None,
            "cachedTokens": len(self._cache),
            "ttlSeconds": MARGIN_TTL_SECONDS,
            "failureTtlSeconds": MARGIN_FAILURE_TTL_SECONDS,
            "product": PRODUCT,
            "maxConcurrency": MAX_CONCURRENCY,
            "minIntervalSeconds": MARGIN_MIN_INTERVAL_SECONDS,
            "rateLimitBackoffSeconds": list(RATE_LIMIT_BACKOFF_SECONDS),
            "rateLimitStreak": self._rate_limit_streak,
            "cooldownRemainingSeconds": max(
                0.0, round(self._cooldown_until - time.monotonic(), 1)
            ),
        }


#: Process-wide resolver. One broker, one cache, one set of published decisions.
margin_resolver = MarginResolver()


__all__ = [
    "MARGIN_FAILURE_TTL_SECONDS",
    "MARGIN_TTL_SECONDS",
    "PRODUCT",
    "MarginAnswer",
    "MarginBrokerUnavailable",
    "MarginResolver",
    "ResolverStats",
    "margin_resolver",
]