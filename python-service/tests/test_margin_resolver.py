"""Margin resolver recovery semantics.

The weekly screen depends on the broker answering margin for every priced
candidate. These tests pin the two failure modes that matter operationally:

* a transient rate limit must cool down and retry, not become a false
  "margin unavailable" that silently removes a stock from the universe;
* a persistent rate limit or an expired session must abort the batch so the
  engine can refuse to lock a partial universe.
"""

from __future__ import annotations

import unittest
from unittest import mock

from services.margin_resolver import (
    MarginBrokerUnavailable,
    MarginResolver,
)


class _FakeSession:
    session_active = True

    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = 0

    async def async_margin_required(self, **_kwargs):
        self.calls += 1
        if not self.payloads:
            raise AssertionError("unexpected extra broker call")
        return self.payloads.pop(0)


class MarginResolverRecoveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._patches = [
            mock.patch("services.margin_resolver.MARGIN_MIN_INTERVAL_SECONDS", 0.0),
            mock.patch(
                "services.margin_resolver.RATE_LIMIT_BACKOFF_SECONDS",
                (0.01, 0.01),
            ),
            mock.patch(
                "services.margin_resolver.TRANSIENT_BACKOFF_SECONDS",
                (0.01, 0.01),
            ),
        ]
        for patch in self._patches:
            patch.start()
        self.addCleanup(lambda: [p.stop() for p in self._patches])

    async def test_rate_limit_cools_down_then_retries_the_same_symbol(self):
        session = _FakeSession([
            {
                "stCode": 100025,
                "errMsg": "rate limit exceeded",
                "stat": "too many request received",
            },
            {"data": {"reqdMrgn": "20.00", "stCode": 200, "stat": "Ok"}},
        ])
        resolver = MarginResolver()

        with mock.patch.object(MarginResolver, "_session", return_value=session):
            answers = await resolver.resolve(
                [{"instrumentToken": "2885", "ltp": 100.0}],
                threshold=5.0,
            )

        answer = answers["2885"]
        self.assertTrue(answer.eligible)
        self.assertEqual(answer.multiplier, 5.0)
        self.assertEqual(session.calls, 2)
        self.assertEqual(resolver.stats.rate_limited, 1)
        self.assertEqual(resolver.stats.broker_calls, 1)

    async def test_persistent_rate_limit_aborts_instead_of_returning_unavailable(self):
        session = _FakeSession([
            {"stCode": 100025, "errMsg": "rate limit exceeded"},
            {"stCode": 100025, "errMsg": "rate limit exceeded"},
        ])
        resolver = MarginResolver()

        with mock.patch(
            "services.margin_resolver.RATE_LIMIT_BACKOFF_SECONDS", (0.01,)
        ):
            with mock.patch.object(MarginResolver, "_session", return_value=session):
                with self.assertRaises(MarginBrokerUnavailable):
                    await resolver.resolve(
                        [{"instrumentToken": "2885", "ltp": 100.0}],
                        threshold=5.0,
                    )

        self.assertEqual(session.calls, 2)
        self.assertEqual(resolver.stats.rate_limited, 2)
        self.assertEqual(resolver.stats.broker_calls, 0)

    async def test_no_active_session_aborts_instead_of_returning_unavailable(self):
        resolver = MarginResolver()

        with mock.patch.object(MarginResolver, "_session", return_value=None):
            with self.assertRaises(MarginBrokerUnavailable):
                await resolver.resolve(
                    [{"instrumentToken": "2885", "ltp": 100.0}],
                    threshold=5.0,
                )

    async def test_a_large_margin_figure_is_not_mistaken_for_rate_limit_code(self):
        session = _FakeSession([
            {"data": {"reqdMrgn": "100025.00", "stCode": 200, "stat": "Ok"}},
        ])
        resolver = MarginResolver()

        with mock.patch.object(MarginResolver, "_session", return_value=session):
            answers = await resolver.resolve(
                [{"instrumentToken": "2885", "ltp": 100.0}],
                threshold=5.0,
            )

        answer = answers["2885"]
        self.assertEqual(answer.margin_amount, 100025.0)
        self.assertEqual(session.calls, 1)
        self.assertEqual(resolver.stats.rate_limited, 0)

    async def test_a_valid_no_margin_answer_is_not_a_broker_outage(self):
        session = _FakeSession([
            {"data": {"stat": "NotOk", "stCode": 200, "errMsg": "no MIS margin"}},
        ])
        resolver = MarginResolver()

        with mock.patch.object(MarginResolver, "_session", return_value=session):
            answers = await resolver.resolve(
                [{"instrumentToken": "2885", "ltp": 100.0}],
                threshold=5.0,
            )

        answer = answers["2885"]
        self.assertFalse(answer.eligible)
        self.assertIsNone(answer.multiplier)
        self.assertIn("no recognisable margin", answer.reason)
        self.assertEqual(session.calls, 1)

    async def test_primed_answer_skips_the_broker(self):
        """Recovery runs reuse same-day authoritative answers without a call."""
        from services.margin_resolver import MarginAnswer

        resolver = MarginResolver()
        resolver.prime([MarginAnswer(
            token="2885", eligible=True, multiplier=6.0,
            status="AUTHORITATIVE", basis="broker",
        )])
        session = _FakeSession([])

        with mock.patch.object(MarginResolver, "_session", return_value=session):
            answers = await resolver.resolve(
                [{"instrumentToken": "2885", "ltp": 100.0}],
                threshold=5.0,
            )

        self.assertEqual(answers["2885"].multiplier, 6.0)
        self.assertEqual(session.calls, 0)
        self.assertEqual(resolver.stats.cache_hits, 1)

    async def test_expired_session_aborts_the_batch(self):
        session = _FakeSession([
            {"data": {"stCode": 401, "errMsg": "Session expired"}},
        ])
        resolver = MarginResolver()

        with mock.patch.object(MarginResolver, "_session", return_value=session):
            with self.assertRaises(MarginBrokerUnavailable):
                await resolver.resolve(
                    [{"instrumentToken": "2885", "ltp": 100.0}],
                    threshold=5.0,
                )

        self.assertEqual(session.calls, 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
