"""Friday 15:25 universe scan — docs/engines/MARKET_WATCH.md §2, §33, A.14.

The scan must:

* screen the FULL NSE EQ master (never a hard-coded list),
* force intraday + LTP below the cap + broker margin >= threshold,
* lock the UPCOMING week (the current week is normally already locked),
* reload the engine before rebuilding, apply the Session Manager intent with
  no expiry and reconcile the WebSocket immediately,
* record an honest reason when it cannot lock (already LOCKED, no survivors,
  DB Writer rejection),
* never suppress the scheduled Friday run just because an operator ran the
  same screen earlier in the week.

No MongoDB or broker is required: the scan, lock, session manager and socket
engine are async fakes, and the clock is pinned to a real Friday.
"""

from __future__ import annotations

import asyncio
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest import mock

from services.market_watch_engine import MarketWatchEngine
from services.market_watch_lifecycle import IST
from services.market_watch_weekly_scan import ScanResult


def _ist(y: int, m: int, d: int, hh: int, mm: int) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=IST)


FRIDAY_1530 = _ist(2026, 10, 23, 15, 30)   # W43, after the 15:25 trigger
FRIDAY_1200 = _ist(2026, 10, 23, 12, 0)
WEDNESDAY_1000 = _ist(2026, 10, 21, 10, 0)


class _FakeSessionManager:
    def __init__(self):
        self.snapshot = mock.Mock(return_value={"session_id": "sess-1", "active": True})
        self.apply_daily_subscription_intent = mock.AsyncMock(return_value={"active": 2})


class _FakeWsEngine:
    def __init__(self):
        self.reconcile_broker_subscriptions = mock.AsyncMock(return_value={"ok": True})


def _scan(
    selected: list[str],
    *,
    candidates: int = 2400,
    priced: int | None = None,
    margin_requested: int | None = None,
    margin_resolved: int | None = None,
    margin_unavailable: int = 0,
    errors: list[str] | None = None,
) -> ScanResult:
    priced = candidates if priced is None else priced
    return ScanResult(
        week_id="2026-W43",
        target_week_id="2026-W44",
        started_at=100.0,
        finished_at=110.0,
        candidates=candidates,
        priced=priced,
        margin_requested=priced if margin_requested is None else margin_requested,
        margin_resolved=priced if margin_resolved is None else margin_resolved,
        margin_unavailable=margin_unavailable,
        selected=[{"symbol": s, "token": str(i + 1)} for i, s in enumerate(selected)],
        errors=list(errors or []),
        seeded=True,
    )


def _engine() -> MarketWatchEngine:
    engine = MarketWatchEngine()
    engine.load_locked_universe = mock.AsyncMock(return_value={"weekId": "2026-W44"})
    engine._build_universe = mock.Mock()
    engine._seed_states = mock.Mock()
    engine._in_runtime_window = mock.Mock(return_value=True)
    engine.daily_subscription_intent = mock.Mock(return_value=[
        {"instrument_token": "1", "symbol": "AAA", "exchange_segment": "nse_cm"},
        {"instrument_token": "2", "symbol": "BBB", "exchange_segment": "nse_cm"},
    ])
    return engine


class FridayScanRunTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # The target week is normally unlocked; individual tests override this
        # to exercise the already-LOCKED refusal.
        self._is_locked = mock.AsyncMock(return_value=False)
        patcher = mock.patch("services.market_watch_universe.is_locked", new=self._is_locked)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_locks_upcoming_week_and_applies_no_expiry_intent(self):
        engine = _engine()
        sm = _FakeSessionManager()
        ws = _FakeWsEngine()
        scan = _scan(["AAA", "BBB"])
        lock_result = {"persisted": True, "version": 7, "universe": object()}

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)) as run_scan, \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock(return_value=lock_result)) as lock, \
             mock.patch("services.session.session_manager.get_session_manager",
                        return_value=sm), \
             mock.patch("api.ws_engine.get_wired_engine", return_value=ws):
            result = await engine.run_friday_scan(triggered_by="manual")

        self.assertTrue(result["ok"])
        self.assertEqual(result["scanWeekId"], "2026-W43")
        self.assertEqual(result["targetWeekId"], "2026-W44")
        self.assertEqual(result["symbolCount"], 2)
        self.assertEqual(result["version"], 7)
        self.assertNotIn("universe", result["lock"], "response must stay JSON serialisable")

        kwargs = run_scan.await_args.kwargs
        self.assertEqual(kwargs["week_id"], "2026-W43")
        self.assertEqual(kwargs["target_week_id"], "2026-W44")
        self.assertTrue(kwargs["require_margin"], "Friday scan must always enforce margin")

        lock.assert_awaited_once()
        self.assertEqual(lock.await_args.kwargs["week_id"], "2026-W44")
        self.assertEqual(lock.await_args.kwargs["symbols"], ["AAA", "BBB"])
        self.assertEqual(lock.await_args.kwargs["locked_by"], "friday_scan_manual")

        engine.load_locked_universe.assert_awaited_once_with(refresh=True)
        engine._build_universe.assert_called_once()
        engine._seed_states.assert_called_once()

        sm.apply_daily_subscription_intent.assert_awaited_once()
        args = sm.apply_daily_subscription_intent.await_args.args
        # The market calendar owns the trading date; the week id is only a
        # fallback when the calendar has no snapshot.
        self.assertEqual(len(args[0]), 10, "expected an ISO trading date")
        self.assertEqual(args[1], "sess-1")
        self.assertEqual(len(args[2]), 2)
        ws.reconcile_broker_subscriptions.assert_awaited_once()

        self.assertEqual(engine._friday_scan_done_for, "2026-W43")
        self.assertEqual(engine.get_metrics()["custom"]["fridayScanWeekId"], "2026-W44")
        self.assertEqual(engine.get_metrics()["custom"]["fridayScanSymbols"], 2)

    async def test_already_locked_week_is_refused_without_touching_engine(self):
        engine = _engine()
        scan = _scan(["AAA"])

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_universe.is_locked",
                        new=mock.AsyncMock(return_value=True)), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)) as run_scan, \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock()) as lock:
            result = await engine.run_friday_scan(triggered_by="auto")

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "WEEK_ALREADY_LOCKED")
        run_scan.assert_not_awaited()
        lock.assert_not_awaited()
        engine.load_locked_universe.assert_not_awaited()
        engine._build_universe.assert_not_called()
        self.assertEqual(engine._friday_scan_last["reason"], "WEEK_ALREADY_LOCKED")

    async def test_partial_screen_never_locks_and_auto_retries(self):
        engine = _engine()
        scan = _scan(["AAA"], errors=["margin batch failed: broker timeout"])

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)), \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock()) as lock:
            result = await engine.run_friday_scan(triggered_by="auto")

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "SCAN_ERROR")
        self.assertIn("margin batch failed", result["detail"])
        lock.assert_not_awaited()
        engine._build_universe.assert_not_called()
        self.assertEqual(
            engine._friday_scan_done_for, "",
            "a partial screen must stay retryable, not claim the week is done",
        )
        self.assertGreater(engine._friday_scan_retry_at, 0)

    async def test_zero_prices_is_a_retryable_scan_error(self):
        engine = _engine()
        scan = _scan([], priced=0, margin_resolved=0)

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)), \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock()) as lock:
            result = await engine.run_friday_scan(triggered_by="auto")

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "SCAN_ERROR")
        self.assertIn("price resolution failed", result["detail"])
        lock.assert_not_awaited()
        self.assertEqual(engine._friday_scan_done_for, "")
        self.assertGreater(engine._friday_scan_retry_at, 0)

    async def test_all_margin_unavailable_is_a_retryable_scan_error(self):
        engine = _engine()
        scan = _scan([], margin_resolved=0, margin_unavailable=2400)

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)), \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock()) as lock:
            result = await engine.run_friday_scan(triggered_by="auto")

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "SCAN_ERROR")
        self.assertIn("margin resolution returned no authoritative", result["detail"])
        lock.assert_not_awaited()
        self.assertEqual(engine._friday_scan_done_for, "")
        self.assertGreater(engine._friday_scan_retry_at, 0)

    async def test_all_priced_above_cap_is_not_a_margin_outage(self):
        engine = _engine()
        # Every stock that got a price is above the ₹800 cap, so the scan never
        # asks the broker for margin. Zero survivors is a legitimate answer,
        # not an outage.
        scan = _scan(
            [], priced=24, margin_requested=0, margin_resolved=0,
            margin_unavailable=0,
        )

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)), \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock()) as lock:
            result = await engine.run_friday_scan(triggered_by="auto")

        self.assertTrue(result["ok"])
        self.assertEqual(result["reason"], "NO_SYMBOLS_SELECTED")
        lock.assert_not_awaited()
        self.assertEqual(engine._friday_scan_done_for, "2026-W43")

    async def test_zero_survivors_keep_the_previous_universe(self):
        engine = _engine()
        scan = _scan([], candidates=2400)

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)), \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock()) as lock:
            result = await engine.run_friday_scan(triggered_by="auto")

        self.assertTrue(result["ok"])
        self.assertEqual(result["reason"], "NO_SYMBOLS_SELECTED")
        self.assertEqual(result["symbolCount"], 0)
        lock.assert_not_awaited()
        engine._build_universe.assert_not_called()
        self.assertEqual(engine._friday_scan_last["reason"], "NO_SYMBOLS_SELECTED")
        # Marked done so the lifecycle loop cannot scan once per second.
        self.assertEqual(engine._friday_scan_done_for, "2026-W43")

    async def test_manual_run_before_friday_does_not_suppress_the_scheduled_run(self):
        engine = _engine()
        scan = _scan(["AAA"])
        sm = _FakeSessionManager()
        ws = _FakeWsEngine()

        with mock.patch("services.market_watch_engine.now_ist", return_value=WEDNESDAY_1000), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)), \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock(return_value={"persisted": True, "version": 1})), \
             mock.patch("services.session.session_manager.get_session_manager",
                        return_value=sm), \
             mock.patch("api.ws_engine.get_wired_engine", return_value=ws):
            await engine.run_friday_scan(triggered_by="manual")

        self.assertEqual(
            engine._friday_scan_done_for, "",
            "a Wednesday operator run must not silence Friday 15:25",
        )

    async def test_manual_trigger_is_rejected_while_a_scan_is_in_flight(self):
        engine = _engine()
        engine._friday_scan_running_for = "2026-W43"
        with mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock()) as run_scan:
            result = await engine.run_friday_scan(triggered_by="manual")

        self.assertFalse(result["ok"])
        self.assertFalse(result["triggered"])
        self.assertEqual(result["reason"], "SCAN_IN_PROGRESS")
        run_scan.assert_not_awaited()
        # The guard belongs to the in-flight run; the rejected caller must not
        # clear it.
        self.assertEqual(engine._friday_scan_running_for, "2026-W43")

    async def test_lifecycle_tick_starts_one_background_scan_after_1525(self):
        engine = _engine()
        cfg = SimpleNamespace(
            weekly=SimpleNamespace(enabled=True, friday_scan_hhmm="15:25")
        )
        started: list[str] = []
        gate = asyncio.Event()

        async def _hold(week: str) -> None:
            started.append(week)
            await gate.wait()

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_calendar.is_trading_day", return_value=True), \
             mock.patch("services.session.session_manager.get_session_manager",
                        return_value=_FakeSessionManager()), \
             mock.patch.object(engine, "_run_friday_scan_auto", new=_hold):
            await engine._friday_scan_tick(cfg)
            await asyncio.sleep(0)
            self.assertEqual(engine._friday_scan_running_for, "2026-W43")
            # The 1 s lifecycle cadence must not start a second task while the
            # first one is still screening.
            await engine._friday_scan_tick(cfg)
            await asyncio.sleep(0)
            self.assertEqual(started, ["2026-W43"])
            gate.set()
            await asyncio.sleep(0)

    async def test_background_wrapper_clears_the_guard_and_backs_off_on_error(self):
        engine = _engine()
        engine._friday_scan_running_for = "2026-W43"
        with mock.patch.object(
            engine, "run_friday_scan",
            new=mock.AsyncMock(side_effect=RuntimeError("broker unavailable")),
        ):
            await engine._run_friday_scan_auto("2026-W43")

        self.assertEqual(engine._friday_scan_running_for, "")
        self.assertGreater(engine._friday_scan_retry_at, 0)

    async def test_lifecycle_tick_does_nothing_before_1525_or_off_friday(self):
        engine = _engine()
        cfg = SimpleNamespace(
            weekly=SimpleNamespace(enabled=True, friday_scan_hhmm="15:25")
        )
        auto = mock.AsyncMock()
        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1200), \
             mock.patch("services.market_calendar.is_trading_day", return_value=True), \
             mock.patch.object(engine, "_run_friday_scan_auto", new=auto):
            await engine._friday_scan_tick(cfg)
            await asyncio.sleep(0)
        auto.assert_not_awaited()

        with mock.patch("services.market_watch_engine.now_ist", return_value=WEDNESDAY_1000), \
             mock.patch("services.market_calendar.is_trading_day", return_value=True), \
             mock.patch.object(engine, "_run_friday_scan_auto", new=auto):
            await engine._friday_scan_tick(cfg)
            await asyncio.sleep(0)
        auto.assert_not_awaited()

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_calendar.is_trading_day", return_value=False), \
             mock.patch.object(engine, "_run_friday_scan_auto", new=auto):
            await engine._friday_scan_tick(cfg)
            await asyncio.sleep(0)
        auto.assert_not_awaited()

        logged_out = _FakeSessionManager()
        logged_out.snapshot = mock.Mock(return_value={"session_id": "sess-1", "active": False})
        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_calendar.is_trading_day", return_value=True), \
             mock.patch("services.session.session_manager.get_session_manager",
                        return_value=logged_out), \
             mock.patch.object(engine, "_run_friday_scan_auto", new=auto):
            await engine._friday_scan_tick(cfg)
            await asyncio.sleep(0)
        auto.assert_not_awaited()

    async def test_socket_reconcile_is_deferred_after_the_runtime_window(self):
        engine = _engine()
        engine._in_runtime_window = mock.Mock(return_value=False)
        scan = _scan(["AAA"])
        sm = _FakeSessionManager()
        ws = _FakeWsEngine()

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)), \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock(return_value={"persisted": True, "version": 1})), \
             mock.patch("services.session.session_manager.get_session_manager",
                        return_value=sm), \
             mock.patch("api.ws_engine.get_wired_engine", return_value=ws):
            result = await engine.run_friday_scan(triggered_by="manual")

        self.assertEqual(result["subscription"]["deferred"], "outside runtime window")
        self.assertTrue(result["subscription"]["applied"], "the persisted intent still applies")
        ws.reconcile_broker_subscriptions.assert_not_awaited()

    async def test_manual_run_after_the_trigger_suppresses_a_duplicate(self):
        engine = _engine()
        scan = _scan(["AAA"])
        sm = _FakeSessionManager()
        ws = _FakeWsEngine()

        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1530), \
             mock.patch("services.market_watch_weekly_scan.run_scan",
                        new=mock.AsyncMock(return_value=scan)), \
             mock.patch("services.market_watch_universe.lock_universe",
                        new=mock.AsyncMock(return_value={"persisted": True, "version": 1})), \
             mock.patch("services.session.session_manager.get_session_manager",
                        return_value=sm), \
             mock.patch("api.ws_engine.get_wired_engine", return_value=ws):
            await engine.run_friday_scan(triggered_by="manual")

        self.assertEqual(engine._friday_scan_done_for, "2026-W43")


class FridayScanStatusTest(unittest.IsolatedAsyncioTestCase):
    def test_resolves_schedule_and_last_outcome_from_the_backend(self):
        engine = _engine()
        engine._friday_scan_last = {
            "scanWeekId": "2026-W43",
            "targetWeekId": "2026-W44",
            "symbols": 412,
            "version": 1,
            "trigger": "auto",
            "reason": None,
        }
        with mock.patch("services.market_watch_engine.now_ist", return_value=FRIDAY_1200):
            status = engine.friday_scan_status()

        self.assertTrue(status["enabled"])
        self.assertEqual(status["scanWeekday"], 4)
        self.assertEqual(status["scanHhmm"], "15:25")
        self.assertEqual(status["nextTargetWeekId"], "2026-W44")
        self.assertTrue(status["nextScanAt"].startswith("2026-10-23T15:25"))
        self.assertEqual(status["priceCap"], 800.0)
        self.assertEqual(status["marginMultiplierThreshold"], 5.0)
        self.assertFalse(status["running"])
        self.assertEqual(status["lastScan"]["symbols"], 412)

    async def test_candidates_are_nse_cash_equity_only(self):
        """The scan must not select indices, derivatives or BSE rows that the
        locked-universe builder would later drop as unresolved."""
        from services.instrument_cache import instrument_cache
        from services.market_watch_weekly_scan import _candidates

        rows = [
            {"symbol": "GOOD", "token": "1", "exchange": "nse_cm",
             "exchangeSegment": "nse_cm", "series": "EQ", "instrumentType": "EQ"},
            {"symbol": "NIFTY", "token": "26000", "exchange": "nse_cm",
             "exchangeSegment": "nse_cm", "series": "", "instrumentType": "",
             "isIndex": True},
            {"symbol": "BSEONLY", "token": "2", "exchange": "bse_cm",
             "exchangeSegment": "bse_cm", "series": "EQ", "instrumentType": "EQ"},
            {"symbol": "FUT", "token": "3", "exchange": "nse_cm",
             "exchangeSegment": "nse_cm", "series": "FUT", "instrumentType": "FUT"},
        ]
        with mock.patch.object(instrument_cache, "_loaded", True), \
             mock.patch.object(instrument_cache, "_instruments", rows), \
             mock.patch.object(instrument_cache, "_load_error", None):
            selected = await _candidates()

        self.assertEqual([r["symbol"] for r in selected], ["GOOD"])

    def test_price_cap_is_strict_and_margin_is_five_x(self):
        from services.market_watch_intraday import (
            INTRADAY_ELIGIBLE,
            MARGIN_BELOW_THRESHOLD,
            PRICE_ABOVE_CAP,
            ScreenConfig,
            StockFacts,
            screen_stock,
        )

        cfg = ScreenConfig(
            price_cap=800.0, margin_multiplier_threshold=5.0,
            require_intraday=True, require_margin=True,
        )

        def facts(symbol: str, ltp: float, margin: float) -> StockFacts:
            return StockFacts(
                token=symbol, symbol=symbol, ltp=ltp,
                margin_multiplier=margin, margin_status="ELIGIBLE",
                intraday_status=INTRADAY_ELIGIBLE,
            )

        at_cap = screen_stock(facts("A", 800.0, 6.0), cfg)
        self.assertFalse(at_cap.passed)
        self.assertEqual(at_cap.reason_code, PRICE_ABOVE_CAP)

        below = screen_stock(facts("B", 799.99, 5.0), cfg)
        self.assertTrue(below.passed, below.reason)

        low_margin = screen_stock(facts("C", 500.0, 4.99), cfg)
        self.assertFalse(low_margin.passed)
        self.assertEqual(low_margin.reason_code, MARGIN_BELOW_THRESHOLD)

    def test_screen_config_forces_margin_only_for_the_friday_run(self):
        from services.market_watch_weekly_scan import _screen_config

        normal = _screen_config()
        friday = _screen_config(True)
        self.assertFalse(normal.require_margin)
        self.assertTrue(friday.require_margin)
        # Everything else is the same resolved policy, not a second config.
        self.assertEqual(friday.price_cap, normal.price_cap)
        self.assertEqual(
            friday.margin_multiplier_threshold,
            normal.margin_multiplier_threshold,
        )


class PriceSourceRecoveryTest(unittest.IsolatedAsyncioTestCase):
    """A recovery scan can price from stored closes without touching the SDK.

    The quote phase and the margin phase share one broker client. When the
    quote endpoint disconnects, concurrent quote calls can leave that client
    unusable and the margin phase then times out. The Friday 15:25 run keeps
    live quotes; an operator recovery run may skip them.
    """

    async def test_price_batch_can_skip_broker_quotes(self):
        from services import market_watch_weekly_scan as scan

        rows = [{
            "instrumentToken": "1", "symbol": "AAA", "segment": "nse_cm",
        }]
        resolved = [{
            "ltp": 100.0, "source": "last_close", "status": "STALE",
        }]
        fake = mock.AsyncMock(return_value=resolved)
        with mock.patch("services.last_price.resolve_prices", new=fake):
            out = await scan._price_batch(rows, allow_broker=False)

        self.assertEqual(out["1"]["source"], "last_close")
        self.assertEqual(out["1"]["ltp"], 100.0)
        self.assertFalse(fake.await_args.kwargs["allow_broker"])


class IncompleteScreenSeedGuardTest(unittest.IsolatedAsyncioTestCase):
    """A partial screen must not seed next week's DRAFT either.

    The engine already refuses to LOCK on an incomplete screen. The scan has
    its own guard because the review UI reads the DRAFT; seeding half the
    universe would show a list that looks complete but silently omitted every
    symbol whose margin batch never ran.
    """

    def setUp(self):
        from services.market_watch_intraday import (
            ScreenConfig, ScreenDecision, ScreenResult,
        )

        self.cfg = ScreenConfig(
            price_cap=800.0, margin_multiplier_threshold=5.0,
            require_intraday=True, require_margin=True,
        )
        self.screen = ScreenResult(selected=[
            ScreenDecision(
                passed=True, reason_code="PASS", reason="ok",
                token="1", symbol="AAA",
            ),
        ])
        self.seed = mock.AsyncMock(return_value=True)
        self.persist = mock.Mock()
        self.resolver = SimpleNamespace(
            resolve=mock.AsyncMock(return_value={}),
            publish=mock.Mock(),
        )
        self.candidates = mock.AsyncMock(return_value=[{
            "instrumentToken": "1", "symbol": "AAA", "segment": "nse_cm",
        }])
        self.prices = mock.AsyncMock(return_value={
            "1": {"ltp": 100.0, "source": "broker", "status": "LIVE"},
        })
        self.patches = [
            mock.patch(
                "services.market_watch_weekly_scan._candidates",
                new=self.candidates,
            ),
            mock.patch(
                "services.market_watch_weekly_scan._resolve_prices",
                new=self.prices,
            ),
            mock.patch(
                "services.market_watch_weekly_scan._screen_config",
                return_value=self.cfg,
            ),
            mock.patch(
                "services.market_watch_intraday.screen_records",
                return_value=self.screen,
            ),
            mock.patch(
                "services.market_watch_weekly_scan._seed_draft",
                new=self.seed,
            ),
            mock.patch(
                "services.market_watch_weekly_scan._persist",
                new=self.persist,
            ),
            mock.patch(
                "services.margin_resolver.margin_resolver", self.resolver,
            ),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    async def _run(self):
        from services.market_watch_weekly_scan import run_scan

        return await run_scan(
            week_id="2026-W43",
            target_week_id="2026-W44",
            require_margin=True,
            seed_draft=True,
        )

    async def test_margin_batch_failure_does_not_seed(self):
        self.resolver.resolve = mock.AsyncMock(
            side_effect=RuntimeError("broker outage")
        )
        result = await self._run()

        self.assertFalse(result.seeded)
        self.seed.assert_not_awaited()
        self.assertTrue(any(
            error.startswith("margin batch failed")
            for error in result.errors
        ))

    async def test_unpriced_screen_does_not_seed(self):
        self.prices.return_value = {"1": {"ltp": None}}
        result = await self._run()

        self.assertEqual(result.priced, 0)
        self.assertFalse(result.seeded)
        self.seed.assert_not_awaited()

    async def test_zero_margin_answers_does_not_seed(self):
        result = await self._run()

        self.assertEqual(result.margin_requested, 1)
        self.assertEqual(result.margin_resolved, 0)
        self.assertFalse(result.seeded)
        self.seed.assert_not_awaited()

    async def test_complete_screen_seeds(self):
        from services.margin_resolver import MarginAnswer

        self.resolver.resolve = mock.AsyncMock(return_value={
            "1": MarginAnswer(
                token="1", eligible=True, multiplier=6.0,
                status="AUTHORITATIVE",
            ),
        })
        result = await self._run()

        self.assertTrue(result.seeded)
        self.seed.assert_awaited_once()
        self.assertEqual(result.selected_symbols, ["AAA"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
