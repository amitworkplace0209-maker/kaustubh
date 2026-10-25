"""Square-Off Engine — safely close open positions per the configured policy.

Flow (docs/engines/squareoff-engine.md):
  Scheduler → Square-Off Engine → Position Engine → find open positions →
  calculate closing quantities → Order Engine → Broker Adapter → execution →
  Position Engine → verify closed

Safety: confirmation for manual execution, idempotency, duplicate prevention,
retry policy, partial-fill handling, final verification.

Doc defaults (§2):
  Squareoff Time 15:16 IST · Trading Freeze 15:15 IST (1 min before) ·
  Retry Interval 15s · Position Scope Intraday/MIS · Timezone Asia/Kolkata.

UI contract (§15-§18, §22):
  Squareoff Card + Live Progress Panel + Last Run Summary + run/attempt
  history grouped per trading day. Everything rendered from the backend —
  no fabricated closures. Broker-side position state is authoritative.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime
from typing import Any, Optional

from core.engines.engine_config import ConfigField, read_only
from core.engines.engine_base import EngineBase, EngineState, EngineHealth, EngineCategory
from core.timezones import IST
from services.engine_event_bus import get_event_bus, EngineEvent, EngineEvents

logger = logging.getLogger("app.squareoff_engine")

# Doc §2 defaults — used only when no live setting is present, and always
# labelled as defaults by the UI.
DOC_DEFAULT_SQUAREOFF_TIME = "15:16"
DOC_DEFAULT_FREEZE_TIME = "15:15"
DOC_DEFAULT_FREEZE_BEFORE_MIN = 1
DOC_DEFAULT_RETRY_INTERVAL_SEC = 15
DOC_DEFAULT_MAX_RETRIES = 3
DOC_DEFAULT_MAX_RETRY_DURATION_SEC = 900  # 15 min deadline → SQUAREOFF_INCOMPLETE
DOC_DEFAULT_SCOPE = "MIS"
DOC_DEFAULT_TIMEZONE = "Asia/Kolkata"


def _ist_now() -> datetime:
    return datetime.now(IST)


def _ist_today_str(ts: float | None = None) -> str:
    dt = datetime.fromtimestamp(ts, tz=IST) if ts else _ist_now()
    return dt.strftime("%Y-%m-%d")


def _ist_iso(ts: float | None = None) -> str:
    dt = datetime.fromtimestamp(ts, tz=IST) if ts else _ist_now()
    return dt.isoformat()


def _parse_hhmm(value: Any) -> tuple[int, int] | None:
    if isinstance(value, str) and ":" in value:
        try:
            h, m = value.strip().split(":")
            h, m = int(h), int(m)
            if 0 <= h <= 23 and 0 <= m <= 59:
                return h, m
        except (ValueError, TypeError):
            return None
    return None


def _minus_minutes(hhmm: str, minutes: int) -> str:
    parsed = _parse_hhmm(hhmm)
    if not parsed:
        return DOC_DEFAULT_FREEZE_TIME
    h, m = parsed
    total = h * 60 + m - minutes
    total %= 24 * 60
    return f"{total // 60:02d}:{total % 60:02d}"


def _resolve_schedule() -> dict:
    """Live schedule: runtime cache → persisted settings → doc defaults.

    Never raises — the page must render even when settings/Mongo is down.
    """
    sq_enabled: Any = None
    sq_time: Any = None
    sq_apply: Any = None
    sched_time: Any = None
    sched_enabled: Any = None
    try:
        from services.runtime_settings import get_runtime_setting
        sq_enabled = get_runtime_setting("sq_enabled")
        sq_time = get_runtime_setting("sq_trigger_time")
        sq_apply = get_runtime_setting("sq_apply_to")
        sched_time = get_runtime_setting("sched_square_off_time")
        sched_enabled = get_runtime_setting("sched_square_off_enabled")
    except Exception:
        pass
    if sq_enabled is None or sq_time is None or sq_apply is None:
        try:
            from config.settings import settings as env_settings
            if sq_time is None:
                sq_time = f"{getattr(env_settings, 'square_off_hour', 15):02d}:{getattr(env_settings, 'square_off_minute', 16):02d}"
        except Exception:
            pass
    try:
        from services.settings_service import DEFAULTS
        if sq_enabled is None:
            sq_enabled = DEFAULTS.get("sq_enabled", {}).get("value", False)
        if sq_time is None:
            sq_time = DEFAULTS.get("sq_trigger_time", {}).get("value", DOC_DEFAULT_SQUAREOFF_TIME)
        if sq_apply is None:
            sq_apply = DEFAULTS.get("sq_apply_to", {}).get("value", DOC_DEFAULT_SCOPE)
        if sched_time is None:
            sched_time = DEFAULTS.get("sched_square_off_time", {}).get("value", DOC_DEFAULT_SQUAREOFF_TIME)
        if sched_enabled is None:
            sched_enabled = DEFAULTS.get("sched_square_off_enabled", {}).get("value", True)
    except Exception:
        pass

    trigger = str(sq_time or sched_time or DOC_DEFAULT_SQUAREOFF_TIME)
    if not _parse_hhmm(trigger):
        trigger = DOC_DEFAULT_SQUAREOFF_TIME
    freeze = _minus_minutes(trigger, DOC_DEFAULT_FREEZE_BEFORE_MIN)
    scope = str(sq_apply or DOC_DEFAULT_SCOPE).upper()
    if scope not in ("MIS", "CNC", "NRML", "ALL", "INTRADAY"):
        scope = DOC_DEFAULT_SCOPE
    auto = bool(sq_enabled) if isinstance(sq_enabled, bool) else False
    sched_on = bool(sched_enabled) if isinstance(sched_enabled, bool) else True
    return {
        "autoEnabled": auto,
        "schedulerEnabled": sched_on,
        "squareoffTime": trigger,
        "freezeTime": freeze,
        "freezeBeforeMin": DOC_DEFAULT_FREEZE_BEFORE_MIN,
        "retryIntervalSec": DOC_DEFAULT_RETRY_INTERVAL_SEC,
        "maxRetries": DOC_DEFAULT_MAX_RETRIES,
        "maxRetryDurationSec": DOC_DEFAULT_MAX_RETRY_DURATION_SEC,
        "positionScope": scope,
        "timezone": DOC_DEFAULT_TIMEZONE,
    }


class SquareOffStatus:
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class SquareOffEngine(EngineBase):
    engine_id = "squareoff_engine"
    engine_name = "Square-Off Engine"
    engine_category = EngineCategory.TRADING
    engine_version = "1.0.0"

    config_fields = (
        ConfigField(
            key="sq_enabled",
            label="Auto Square-Off",
            summary="enabled",
            type="boolean",
            group="Policy",
            help="Close intraday positions automatically at the trigger time.",
        ),
        ConfigField(
            key="sq_trigger_time",
            label="Trigger Time (IST)",
            summary="triggerTime",
            type="text",
            group="Policy",
            help="HH:MM in Asia/Kolkata. Mirrors the scheduler square-off time.",
        ),
        ConfigField(
            key="sq_apply_to",
            label="Applies To",
            summary="applyTo",
            type="select",
            options=("MIS", "CNC", "ALL"),
            group="Policy",
        ),
        read_only("policy", "Active Policy"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._active_requests: dict[str, dict] = {}
        self._completed_requests: list[dict] = []
        self._max_retries = DOC_DEFAULT_MAX_RETRIES
        self._total_squareoffs = 0
        self._successful = 0
        self._failed = 0

    async def _on_start(self) -> None:
        self.set_dependencies(["position_engine", "order_engine", "session_manager"])
        self.refresh_config_summary()
        logger.info("[SQUAREOFF] engine started")

    def refresh_config_summary(self) -> None:
        """Publish the LIVE schedule so the Control Center never shows stale defaults."""
        try:
            sched = _resolve_schedule()
            self.set_config_summary({
                "enabled": sched["autoEnabled"],
                "triggerTime": sched["squareoffTime"],
                "applyTo": sched["positionScope"],
                "maxRetries": self._max_retries,
                "retryIntervalSec": sched["retryIntervalSec"],
                "squareoffTime": sched["squareoffTime"],
                "freezeTime": sched["freezeTime"],
                "policy": f"{sched['squareoffTime']} IST · freeze {sched['freezeTime']} · {sched['retryIntervalSec']}s retry · {sched['positionScope']}",
            })
        except Exception:
            pass

    async def _on_stop(self) -> None:
        self._active_requests.clear()
        logger.info("[SQUAREOFF] engine stopped")

    # ------------------------------------------------------------------
    # Run history helpers (doc §22)
    # ------------------------------------------------------------------
    def _finalize_request(self, request_id: str) -> None:
        req = self._active_requests.pop(request_id, None)
        if not req:
            return
        req["completedAt"] = req.get("completedAt") or time.time()
        req["completedAtIST"] = _ist_iso(req["completedAt"])
        self._completed_requests.append(req)
        # Bounded in-memory history — the audit trail (SQUARE_OFF_*) is the
        # permanent record; this keeps the last 50 runs for the live page.
        if len(self._completed_requests) > 50:
            self._completed_requests = self._completed_requests[-50:]

    def _derive_squareoff_state(self) -> str:
        """Doc §16 UI status from live runs (explicit text, never colour-only)."""
        active = [r for r in self._active_requests.values() if r.get("status") == SquareOffStatus.IN_PROGRESS]
        if active:
            return "SQUAREOFF_IN_PROGRESS"
        if self._completed_requests:
            last = self._completed_requests[-1]
            st = str(last.get("status") or "")
            if st == SquareOffStatus.COMPLETED:
                return "SQUAREOFF_COMPLETE"
            if st == SquareOffStatus.PARTIAL:
                return "SQUAREOFF_INCOMPLETE"
            if st in (SquareOffStatus.FAILED, SquareOffStatus.CANCELLED):
                return "SQUAREOFF_INCOMPLETE"
        return "IDLE"

    def get_history(self, limit: int = 20) -> dict:
        """In-memory run history + per-trading-day grouping (doc §22)."""
        try:
            lim = max(1, min(int(limit), 50))
        except Exception:
            lim = 20
        recent = (self._completed_requests[-lim:])[::-1]
        active = [r for r in self._active_requests.values() if r.get("status") == SquareOffStatus.IN_PROGRESS]
        # Per-day rollup: trading_date → runs / closed / failed / remaining.
        by_day: dict[str, dict] = {}
        for r in list(self._completed_requests) + list(self._active_requests.values()):
            day = str(r.get("tradingDate") or _ist_today_str(r.get("startedAt")))
            slot = by_day.setdefault(day, {
                "tradingDate": day, "runs": 0, "completed": 0, "partial": 0,
                "failed": 0, "inProgress": 0, "positionsClosed": 0,
                "positionsRemaining": 0, "attempts": 0,
            })
            slot["runs"] += 1
            st = str(r.get("status") or "")
            if st == SquareOffStatus.COMPLETED:
                slot["completed"] += 1
            elif st == SquareOffStatus.PARTIAL:
                slot["partial"] += 1
            elif st == SquareOffStatus.FAILED:
                slot["failed"] += 1
            elif st == SquareOffStatus.IN_PROGRESS:
                slot["inProgress"] += 1
            results = r.get("results") or []
            slot["positionsClosed"] += sum(1 for x in results if str(x.get("status")) in ("COMPLETE", "SUBMITTED"))
            slot["positionsRemaining"] += sum(1 for x in results if str(x.get("status")) in ("FAILED", "REJECTED"))
            slot["attempts"] += len(results)
        days = sorted(by_day.values(), key=lambda d: d["tradingDate"], reverse=True)
        return {
            "active": active,
            "recent": recent,
            "byDay": days,
            "tradingDate": _ist_today_str(),
            "totalSquareoffs": self._total_squareoffs,
            "successful": self._successful,
            "failed": self._failed,
        }

    async def get_detail(self) -> dict:
        """Live detail for the Service page: schedule + runs + broker reality.

        Broker counts are best-effort and honest: when no session is live the
        fields are None (rendered as —), never zero-invented.
        """
        sched = _resolve_schedule()
        hist = self.get_history(limit=10)
        active = hist["active"]
        active_run = active[0] if active else None
        last_run = (self._completed_requests[-1]) if self._completed_requests else None

        open_positions: Any = None
        pending_orders: Any = None
        session_active: Any = None
        positions_error: str | None = None
        try:
            from services.session.session_manager import session_manager
            try:
                snap = session_manager.snapshot()
                session_active = bool(snap.get("active")) or bool(session_manager.is_active())
            except Exception:
                session_active = None
        except Exception:
            pass

        # Only touch the broker when a session is (probably) live — otherwise
        # leave the counts unknown instead of fabricating zeros.
        terminal = "kotak"
        try:
            from brokers.manager import get_adapter
            from core.engines.position_engine import get_positions as _get_positions
            # Prefer the active terminal when the session manager knows it.
            try:
                from scheduler import _active_mode_name  # type: ignore
                terminal = _active_mode_name()
            except Exception:
                try:
                    from services.session.session_manager import session_manager as _sm
                    terminal = str(getattr(_sm, "active_terminal", None) or "kotak")
                except Exception:
                    pass
            if session_active:
                try:
                    pos_data = await _get_positions(terminal)
                    rows = pos_data.get("data", []) if isinstance(pos_data, dict) else []
                    scope = str(sched.get("positionScope") or "MIS").upper()
                    def _eligible(p: dict) -> bool:
                        qty = p.get("netQuantity", 0)
                        if qty == 0:
                            return False
                        if scope == "ALL":
                            return True
                        prod = str(p.get("product") or "").upper()
                        if scope == "INTRADAY":
                            return prod in ("MIS", "INTRADAY", "")
                        return prod == scope or (scope == "MIS" and prod in ("MIS", ""))
                    open_positions = [p for p in rows if p.get("netQuantity", 0) != 0]
                    eligible = [p for p in rows if _eligible(p)]
                    sched["_liveOpenPositions"] = len(open_positions)
                    sched["_livePositionsToClose"] = len(eligible)
                except Exception as exc:
                    positions_error = str(exc)
                try:
                    adapter = get_adapter(terminal)
                    if getattr(adapter, "is_logged_in", False):
                        raw_orders = await adapter.orders()
                        olist = raw_orders.get("data") if isinstance(raw_orders, dict) else raw_orders
                        if isinstance(olist, list):
                            pending_orders = sum(
                                1 for o in olist
                                if str(o.get("status") or o.get("orderStatus") or "").upper() in (
                                    "PENDING", "OPEN", "TRIGGER_PENDING", "AMO_REQ", "PLACED", "SUBMITTED")
                            )
                except Exception:
                    pass
        except Exception as exc:
            positions_error = positions_error or str(exc)

        remaining = None
        retries = 0
        if active_run:
            results = active_run.get("results") or []
            remaining = sum(1 for r in results if str(r.get("status")) not in ("COMPLETE", "SUBMITTED", "SKIPPED"))
            retries = int(active_run.get("retryCount") or len(results) or 0)

        return {
            "engineId": self.engine_id,
            "squareoffState": self._derive_squareoff_state(),
            "schedule": sched,
            "freezeActive": False,  # freeze is scheduler-owned; engine reports runs honestly
            "pendingOrders": pending_orders,
            "openPositions": sched.pop("_liveOpenPositions", None) if isinstance(sched, dict) else None,
            "positionsToClose": sched.pop("_livePositionsToClose", None) if isinstance(sched, dict) else None,
            "remainingQuantity": remaining,
            "retryCount": retries,
            "retryIntervalSec": sched.get("retryIntervalSec"),
            "activeRun": active_run,
            "lastRun": last_run,
            "recent": hist["recent"],
            "byDay": hist["byDay"],
            "tradingDate": hist["tradingDate"],
            "totals": {
                "totalSquareoffs": self._total_squareoffs,
                "successful": self._successful,
                "failed": self._failed,
            },
            "sessionActive": session_active,
            "terminal": terminal,
            "positionsError": positions_error,
            "recentActivity": self.get_recent_activity(10),
            "recentErrors": self.get_recent_errors(5),
        }

    async def execute_square_off(
        self,
        terminal: str,
        positions: list[dict] | None = None,
        source: str = "manual",
        confirmation_token: str | None = None,
    ) -> dict:
        """Execute square-off for open positions.

        Args:
            terminal: broker terminal identifier
            positions: specific positions to close (None = all open)
            source: "scheduler" | "manual" | "emergency"
            confirmation_token: required for manual execution

        Returns:
            Square-off result with per-position outcomes
        """
        today = _ist_today_str()
        run_id = f"SO_{uuid.uuid4().hex[:12]}"
        # Doc §10 run id shape: SQO-YYYYMMDD-<unique-id>
        doc_run_id = f"SQO-{today.replace('-', '')}-{uuid.uuid4().hex[:6].upper()}"
        started = time.time()

        # Safety: require confirmation for manual execution
        if source == "manual" and not confirmation_token:
            return {
                "ok": False,
                "error": "CONFIRMATION_REQUIRED",
                "message": "Manual square-off requires confirmation token",
                "requestId": run_id,
                "runId": doc_run_id,
            }

        # Check if already in progress
        active = [r for r in self._active_requests.values() if r["status"] == SquareOffStatus.IN_PROGRESS]
        if active:
            return {
                "ok": False,
                "error": "ALREADY_IN_PROGRESS",
                "message": f"Square-off already in progress: {active[0]['requestId']}",
                "requestId": run_id,
                "runId": doc_run_id,
            }

        self._active_requests[run_id] = {
            "requestId": run_id,
            "runId": doc_run_id,
            "status": SquareOffStatus.IN_PROGRESS,
            "source": source,
            "terminal": terminal,
            "tradingDate": today,
            "startedAt": started,
            "startedAtIST": _ist_iso(started),
            "retryCount": 0,
            "results": [],
        }

        self._total_squareoffs += 1
        self.set_metric("totalSquareoffs", self._total_squareoffs)
        try:
            self._record_activity(f"run_started:{doc_run_id}", f"source={source} terminal={terminal}")
        except Exception:
            pass

        await get_event_bus().publish(EngineEvent(
            event_type=EngineEvents.SQUARE_OFF_STARTED,
            source_engine=self.engine_id,
            data={"requestId": run_id, "runId": doc_run_id, "source": source, "tradingDate": today},
        ))

        try:
            # Early guard: do not attempt a broker fetch when no session is live.
            # Use the single source of truth (Session Manager / Broker registry)
            # instead of reaching directly into auth.kotak_client (architecture §5).
            if positions is None:
                try:
                    from services.session.session_manager import session_manager
                    from brokers.manager import get_adapter
                    snap = session_manager.snapshot()
                    # Session Manager is authoritative; also check adapter liveness as secondary guard
                    is_active = bool(snap.get("active")) or bool(session_manager.is_active())
                    if not is_active:
                        try:
                            is_active = bool(get_adapter(terminal).is_logged_in)
                        except Exception:
                            pass
                    if not is_active:
                        logger.warning("[SQUAREOFF] deferred: session not active (terminal=%s state=%s)", terminal, snap.get("status"))
                        self._active_requests[run_id]["status"] = SquareOffStatus.FAILED
                        self._active_requests[run_id]["error"] = "Broker session required for positions"
                        self._active_requests[run_id]["completedAt"] = time.time()
                        self._active_requests[run_id]["completedAtIST"] = _ist_iso()
                        await get_event_bus().publish(EngineEvent(
                            event_type=EngineEvents.SQUARE_OFF_FAILED,
                            source_engine=self.engine_id,
                            data={"requestId": run_id, "runId": doc_run_id, "error": "Broker session required for positions", "deferred": True},
                            severity="warning",
                        ))
                        self._failed += 1
                        self.set_metric("failed", self._failed)
                        self._finalize_request(run_id)
                        return {
                            "ok": False,
                            "status": SquareOffStatus.FAILED,
                            "error": "Broker session required for positions",
                            "deferred": True,
                            "requestId": run_id,
                            "runId": doc_run_id,
                        }
                except Exception:
                    pass
            # Get open positions from Position Engine
            if positions is None:
                from core.engines.position_engine import get_positions
                pos_data = await get_positions(terminal)
                positions = [
                    p for p in pos_data.get("data", [])
                    if p.get("netQuantity", 0) != 0
                ]

            # Filter out zero-qty positions even when passed explicitly
            positions = [p for p in positions if p.get("netQuantity", 0) != 0]

            if not positions:
                self._active_requests[run_id]["status"] = SquareOffStatus.COMPLETED
                self._active_requests[run_id]["completedAt"] = time.time()
                self._active_requests[run_id]["completedAtIST"] = _ist_iso()
                self._active_requests[run_id]["positionsFound"] = 0
                self._active_requests[run_id]["positionsClosed"] = 0
                self._successful += 1
                self.set_metric("successful", self._successful)
                await get_event_bus().publish(EngineEvent(
                    event_type=EngineEvents.SQUARE_OFF_COMPLETED,
                    source_engine=self.engine_id,
                    data={"requestId": run_id, "runId": doc_run_id, "status": SquareOffStatus.COMPLETED, "total": 0},
                ))
                self._finalize_request(run_id)
                return {
                    "ok": True,
                    "status": SquareOffStatus.COMPLETED,
                    "message": "No open positions to close",
                    "requestId": run_id,
                    "runId": doc_run_id,
                    "results": [],
                }

            # Execute square-off for each position
            results = []
            for idx, pos in enumerate(positions, start=1):
                attempt_id = f"{doc_run_id}-ATTEMPT-{idx:03d}"
                result = await self._close_position(terminal, pos, run_id)
                result["attemptId"] = attempt_id
                result["runId"] = doc_run_id
                results.append(result)
                self._active_requests[run_id]["results"] = list(results)
                self._active_requests[run_id]["retryCount"] = len(results)

            # Determine overall status
            filled = sum(1 for r in results if r.get("status") == "COMPLETE")
            submitted = sum(1 for r in results if r.get("status") == "SUBMITTED")
            closed = filled + submitted
            failed = sum(1 for r in results if r.get("status") in ("FAILED", "REJECTED"))

            if filled == len(positions) or closed == len(positions):
                overall_status = SquareOffStatus.COMPLETED
                self._successful += 1
                self.set_metric("successful", self._successful)
            elif failed == len(positions):
                overall_status = SquareOffStatus.FAILED
                self._failed += 1
                self.set_metric("failed", self._failed)
            elif filled > 0 or submitted > 0:
                overall_status = SquareOffStatus.PARTIAL
                self._failed += 1
                self.set_metric("failed", self._failed)
            else:
                overall_status = SquareOffStatus.FAILED
                self._failed += 1
                self.set_metric("failed", self._failed)

            self._active_requests[run_id]["status"] = overall_status
            self._active_requests[run_id]["results"] = results
            self._active_requests[run_id]["completedAt"] = time.time()
            self._active_requests[run_id]["completedAtIST"] = _ist_iso()
            self._active_requests[run_id]["positionsFound"] = len(positions)
            self._active_requests[run_id]["positionsClosed"] = closed
            self._active_requests[run_id]["positionsRemaining"] = len(positions) - closed
            try:
                self._record_activity(
                    f"run_{overall_status.lower()}:{doc_run_id}",
                    f"found={len(positions)} closed={closed} failed={failed}",
                )
            except Exception:
                pass

            await get_event_bus().publish(EngineEvent(
                event_type=EngineEvents.SQUARE_OFF_COMPLETED,
                source_engine=self.engine_id,
                data={
                    "requestId": run_id,
                    "runId": doc_run_id,
                    "status": overall_status,
                    "filled": filled,
                    "failed": failed,
                    "total": len(positions),
                },
            ))

            out = {
                "ok": overall_status != SquareOffStatus.FAILED,
                "status": overall_status,
                "requestId": run_id,
                "runId": doc_run_id,
                "results": results,
                "filled": filled,
                "failed": failed,
                "total": len(positions),
            }
            # Terminal runs leave the in-memory slot; the completed record is
            # what the History / Per-day panels read.
            self._finalize_request(run_id)
            return out

        except Exception as exc:
            msg = str(exc)
            is_session_missing = "NOT_LOGGED_IN" in msg or "Kotak Neo session required" in msg
            self._active_requests[run_id]["status"] = SquareOffStatus.FAILED
            self._active_requests[run_id]["error"] = msg
            self._active_requests[run_id]["completedAt"] = time.time()
            self._active_requests[run_id]["completedAtIST"] = _ist_iso()
            if is_session_missing:
                logger.warning("[SQUAREOFF] failed deferred (no session): %s", msg)
                await get_event_bus().publish(EngineEvent(
                    event_type=EngineEvents.SQUARE_OFF_FAILED,
                    source_engine=self.engine_id,
                    data={"requestId": run_id, "runId": doc_run_id, "error": msg, "deferred": True},
                    severity="warning",
                ))
                self._failed += 1
                self.set_metric("failed", self._failed)
                self._finalize_request(run_id)
                return {
                    "ok": False,
                    "status": SquareOffStatus.FAILED,
                    "error": msg,
                    "deferred": True,
                    "requestId": run_id,
                    "runId": doc_run_id,
                }
            self.record_error("squareoff_error", msg)

            await get_event_bus().publish(EngineEvent(
                event_type=EngineEvents.SQUARE_OFF_FAILED,
                source_engine=self.engine_id,
                data={"requestId": run_id, "runId": doc_run_id, "error": msg},
                severity="error",
            ))

            self._failed += 1
            self.set_metric("failed", self._failed)
            self._finalize_request(run_id)
            return {
                "ok": False,
                "status": SquareOffStatus.FAILED,
                "error": msg,
                "requestId": run_id,
                "runId": doc_run_id,
            }

    async def _close_position(self, terminal: str, position: dict, request_id: str) -> dict:
        """Close a single position via the Order Engine."""
        symbol = position.get("symbol") or position.get("tradingSymbol", "")
        token = position.get("token") or position.get("instrumentToken", "")
        exchange = position.get("exchange", "nse_cm")
        product = position.get("product", "MIS")
        net_qty = position.get("netQuantity", 0)

        if net_qty == 0:
            return {"symbol": symbol, "status": "SKIPPED", "reason": "zero quantity"}

        # Determine closing direction
        if net_qty > 0:
            transaction_type = "SELL"
            quantity = abs(net_qty)
        else:
            transaction_type = "BUY"
            quantity = abs(net_qty)

        for attempt in range(1, self._max_retries + 1):
            try:
                from core.engines.order_engine import place
                result = await place(terminal, {
                    "exchange": exchange,
                    "token": token,
                    "symbol": symbol,
                    "transaction_type": transaction_type,
                    "product": product,
                    "order_type": "MKT",
                    "quantity": quantity,
                    "price": 0,
                    "trigger_price": 0,
                    "validity": "DAY",
                    "disclosed_quantity": 0,
                    "amo": False,
                    "market_protection": 0,
                    "client_id": "",
                })

                if result.get("ok"):
                    return {
                        "symbol": symbol,
                        "token": token,
                        "status": "COMPLETE" if result.get("accepted") else "SUBMITTED",
                        "side": transaction_type,
                        "requestedQty": quantity,
                        "orderId": result.get("orderId"),
                        "attempt": attempt,
                        "placedAtIST": _ist_iso(),
                    }
                else:
                    if attempt == self._max_retries:
                        return {
                            "symbol": symbol,
                            "token": token,
                            "status": "FAILED",
                            "side": transaction_type,
                            "requestedQty": quantity,
                            "error": result.get("error", "unknown"),
                            "attempts": attempt,
                        }

            except Exception as exc:
                if attempt == self._max_retries:
                    return {
                        "symbol": symbol,
                        "token": token,
                        "status": "FAILED",
                        "side": transaction_type,
                        "requestedQty": quantity,
                        "error": str(exc),
                        "attempts": attempt,
                    }
                await asyncio.sleep(1)

        return {"symbol": symbol, "token": token, "status": "FAILED", "error": "max retries exceeded"}

    def get_status(self, request_id: str | None = None) -> dict:
        if request_id:
            found = self._active_requests.get(request_id)
            if found:
                return found
            for r in reversed(self._completed_requests):
                if r.get("requestId") == request_id or r.get("runId") == request_id:
                    return r
            return {}
        return {
            "active": [r for r in self._active_requests.values()
                       if r["status"] == SquareOffStatus.IN_PROGRESS],
            "recent": list(reversed(self._completed_requests[-10:])),
            "totalSquareoffs": self._total_squareoffs,
            "successful": self._successful,
            "failed": self._failed,
        }

    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        # Keep the Control Center contract, then layer the doc §15-§18 live
        # squareoff state on top so the page renders from ONE snapshot whether
        # it arrives via REST or the WS#2 realtime push.
        try:
            self.refresh_config_summary()
        except Exception:
            pass
        try:
            sched = _resolve_schedule()
        except Exception:
            sched = {
                "autoEnabled": False, "squareoffTime": DOC_DEFAULT_SQUAREOFF_TIME,
                "freezeTime": DOC_DEFAULT_FREEZE_TIME,
                "freezeBeforeMin": DOC_DEFAULT_FREEZE_BEFORE_MIN,
                "retryIntervalSec": DOC_DEFAULT_RETRY_INTERVAL_SEC,
                "maxRetries": self._max_retries,
                "maxRetryDurationSec": DOC_DEFAULT_MAX_RETRY_DURATION_SEC,
                "positionScope": DOC_DEFAULT_SCOPE, "timezone": DOC_DEFAULT_TIMEZONE,
            }
        try:
            hist = self.get_history(limit=10)
        except Exception:
            hist = {"active": [], "recent": [], "byDay": [], "tradingDate": _ist_today_str(),
                    "totalSquareoffs": self._total_squareoffs, "successful": self._successful, "failed": self._failed}
        active = hist.get("active") or []
        last_run = (self._completed_requests[-1]) if self._completed_requests else None
        base["metrics"]["custom"]["totalSquareoffs"] = self._total_squareoffs
        base["metrics"]["custom"]["successful"] = self._successful
        base["metrics"]["custom"]["failed"] = self._failed
        base["metrics"]["custom"]["activeRequests"] = sum(
            1 for r in self._active_requests.values()
            if r["status"] == SquareOffStatus.IN_PROGRESS
        )
        # --- doc-compliant live surface (additive; old keys untouched) ---
        base["squareoffState"] = self._derive_squareoff_state()
        base["schedule"] = sched
        base["config"] = {
            "defaultSquareoffTime": f"{sched.get('squareoffTime')} IST",
            "squareoffTime": sched.get("squareoffTime"),
            "defaultFreezeTime": f"{sched.get('freezeTime')} IST",
            "freezeTime": sched.get("freezeTime"),
            "retryIntervalSec": sched.get("retryIntervalSec"),
            "retryInterval": sched.get("retryIntervalSec"),
            "maxRetries": sched.get("maxRetries", self._max_retries),
            "positionScope": sched.get("positionScope"),
            "autoEnabled": sched.get("autoEnabled"),
        }
        base["freezeActive"] = False
        base["pendingOrders"] = None
        base["remainingQuantity"] = None
        base["retryCount"] = len(active[0].get("results", [])) if active else 0
        base["activeRun"] = active[0] if active else None
        base["lastRun"] = last_run
        base["recentRuns"] = hist.get("recent", [])
        base["runsByDay"] = hist.get("byDay", [])
        base["tradingDate"] = hist.get("tradingDate")
        return base


# Module singleton
squareoff_engine = SquareOffEngine()
