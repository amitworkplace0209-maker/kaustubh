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

#: Concurrency against the broker. Deliberately modest: this is one call per
#: symbol in the candidate universe, and a weekly scan must not look like an
#: attack on the broker's rate limiter.
MAX_CONCURRENCY = 6
PER_CALL_TIMEOUT_SECONDS = 4.0


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

    async def _ask_broker(
        self, session: Any, *, token: str, segment: str, ltp: float,
    ) -> tuple[Optional[float], str]:
        """One broker margin call. Returns ``(margin_amount, error_reason)``.

        ``(None, "")`` means the broker answered but the answer carried no
        recognisable margin figure — distinguishable from a failure so the
        operator-facing reason is accurate.
        """
        async with self._semaphore:
            try:
                payload = await asyncio.wait_for(
                    session.async_margin_required(
                        exchange=segment,
                        token=token,
                        product=PRODUCT,
                        order_type="MKT",
                        quantity="1",
                        # Price the notional with the SAME price the broker is
                        # asked to price, so multiplier = notional/margin is
                        # internally consistent.
                        price=str(round(float(ltp), 2)),
                        transaction_type="BUY",
                    ),
                    timeout=PER_CALL_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                self.stats.broker_errors += 1
                return None, f"broker margin call timed out after {PER_CALL_TIMEOUT_SECONDS}s"
            except Exception as exc:
                self.stats.broker_errors += 1
                return None, f"broker margin call failed: {exc}"
            self.stats.broker_calls += 1
            margin = extract_margin_amount(payload)
            if margin is None:
                return None, "broker returned no recognisable margin figure"
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
                for token, _ltp in pending:
                    answers[token] = self._store_answer(MarginAnswer(
                        token=token,
                        status=MARGIN_UNAVAILABLE_STATUS,
                        basis="none",
                        reason="no active broker session, so margin is unverified",
                        resolved_at=time.time(),
                    ))
            else:
                resolved = await asyncio.gather(*(
                    self._resolve_one(session, token, ltp, segment, threshold)
                    for token, ltp in pending
                ))
                for answer in resolved:
                    answers[answer.token] = self._store_answer(answer)

        self._tally(answers)
        return answers

    def _store_answer(self, answer: MarginAnswer) -> MarginAnswer:
        self._cache[answer.token] = (time.time(), answer)
        return answer

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
        }


#: Process-wide resolver. One broker, one cache, one set of published decisions.
margin_resolver = MarginResolver()


__all__ = [
    "MARGIN_FAILURE_TTL_SECONDS",
    "MARGIN_TTL_SECONDS",
    "PRODUCT",
    "MarginAnswer",
    "MarginResolver",
    "ResolverStats",
    "margin_resolver",
]