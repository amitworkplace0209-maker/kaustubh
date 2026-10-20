"""
Engine self-reporting â€” every engine raises its own alert and notification.

WHAT THIS IS FOR
----------------
Before this module the only things that ever created alerts were the event
rules in ``services/notification_center``. An engine could sit in ERROR,
DISCONNECTED, STALE or DEGRADED and the alert center would never say so,
because nothing was watching for it. This closes that gap: the reporter
observes the engine registry and speaks up on its own.

WHY IT IS EDGE-TRIGGERED (the whole point)
------------------------------------------
The user's requirement is "sirf ek baar" â€” say it once, not on every poll.
So this is a *change detector*, not a reporter of current status:

  * The first observation of an engine only primes a provisional baseline, so
    ordinary start-up churn never produces a storm.
  * An alert fires when an engine moves INTO a problem, or escalates to a
    DIFFERENT problem (DEGRADED -> ERROR is new information; DEGRADED ->
    DEGRADED is not).
  * Staying in the same bad state emits NOTHING. This is the case that used to
    turn into a wall of identical notifications.
  * Returning to healthy emits one recovery notification and auto-resolves the
    alert that was opened.
  * An engine that is STILL unhealthy one full interval after boot is reported
    once (from UNKNOWN) â€” a genuine boot-time failure must not be hidden just
    because it predates our baseline â€” while a start-up wobble that clears
    itself inside that interval stays silent.
  * After a restart, alerts left open by the previous process are closed for
    engines that are healthy again, so nothing is left red forever.

    DEGRADED (first seen)  -> alert + notification
    DEGRADED (still)       -> silence
    DEGRADED -> ERROR      -> new alert (escalation)
    ERROR    -> HEALTHY    -> recovery notification + alert resolved
    HEALTHY  -> HEALTHY    -> silence

Even a flap is protected twice over: the transition detector above, plus a
dedupe key (``engine:<id>:<state>:<health>``) so the row folds into an existing
alert/notification instead of accumulating.

Everything carries the engine's real detail â€” id, name, category, version, the
exact from -> to transition, its own health reason, error/warning counts,
heartbeat age, queue depth, dependencies and recent errors â€” so the alert reads
as a diagnosis rather than a bare "something broke".
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("app.engine_alert_reporter")

# How often the registry is sampled. Transitions between samples are still
# caught; only a change *lasting less than one interval* could be missed, which
# for engine health transitions is not a real concern.
DEFAULT_INTERVAL_SECONDS = 15.0

# Engine states that mean "this is fine, stay quiet".
_OK_STATES = frozenset({"RUNNING", "HEALTHY"})

# Engine states that mean "this needs a human", mapped to alert severity.
# Anything not listed falls back to the health-based severity below.
_STATE_SEVERITY: dict[str, str] = {
    "ERROR": "critical",
    "DISCONNECTED": "critical",
    "DEPENDENCY_ERROR": "critical",
    "STALE": "warning",
    "DEGRADED": "warning",
    "STOPPED": "warning",
    "DISABLED": "info",
    "STOPPING": "info",
    "STARTING": "info",
    "RESTARTING": "info",
}

# States that are transient/expected during a normal lifecycle and must never
# open an alert on their own.
_TRANSIENT_STATES = frozenset({"REGISTERED", "STARTING", "STOPPING", "RESTARTING"})

_HEALTH_SEVERITY: dict[str, str] = {
    "UNHEALTHY": "critical",
    "DEGRADED": "warning",
    "UNKNOWN": "info",
    "HEALTHY": "info",
}

_SEVERITY_ORDER = ("info", "success", "warning", "error", "critical")


def _is_problem(state: str, health: str) -> bool:
    return state not in _OK_STATES and state not in _TRANSIENT_STATES


def _severity_for(state: str, health: str) -> str:
    sev = _STATE_SEVERITY.get(state) or _HEALTH_SEVERITY.get(health) or "warning"
    return sev if sev in _SEVERITY_ORDER else "warning"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class EngineAlertReporter:
    """Watches the engine registry and speaks up on real transitions only."""

    def __init__(self, interval_seconds: float = DEFAULT_INTERVAL_SECONDS) -> None:
        self.interval_seconds = max(2.0, float(interval_seconds))
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()
        # engine_id -> {"state", "health", "at", "pending_initial"}
        self._last: dict[str, dict[str, Any]] = {}
        # False only for the very first scan; the boot baseline is provisional
        # until one full interval has passed.
        self._primed = False
        self._emitted = 0
        self._suppressed = 0
        self._scans = 0
        self._last_scan_at: str | None = None
        self._last_error: str | None = None

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop(), name="engine-alert-reporter")
        logger.info(
            "[ENGINE-ALERTS] reporter started (every %.0fs)", self.interval_seconds
        )

    async def stop(self) -> None:
        self._stopping.set()
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        logger.info("[ENGINE-ALERTS] reporter stopped")

    def status(self) -> dict[str, Any]:
        return {
            "running": bool(self._task and not self._task.done()),
            "intervalSeconds": self.interval_seconds,
            "baselineSettled": self._primed,
            "trackedEngines": len(self._last),
            "scans": self._scans,
            "emitted": self._emitted,
            "suppressedRepeats": self._suppressed,
            "lastScanAt": self._last_scan_at,
            "lastError": self._last_error,
        }

    # ------------------------------------------------------------------ #
    # Loop
    # ------------------------------------------------------------------ #

    async def _loop(self) -> None:
        # Prime once immediately so the registry is baselined without emitting,
        # then settle into the interval.
        try:
            self._scan(prime_only=True)
        except Exception as exc:
            logger.debug("[ENGINE-ALERTS] initial scan skipped: %s", exc)
        while not self._stopping.is_set():
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self.interval_seconds)
                return  # stop requested
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                raise
            try:
                self._scan()
            except Exception as exc:  # never let the watcher die
                self._last_error = str(exc)
                logger.warning("[ENGINE-ALERTS] scan failed: %s", exc, exc_info=True)

    # ------------------------------------------------------------------ #
    # Transition detection
    # ------------------------------------------------------------------ #

    def _scan(self, prime_only: bool = False) -> None:
        from services.engine_registry import get_engine_registry

        registry = get_engine_registry()
        statuses = registry.get_all_statuses() or []
        self._scans += 1
        self._last_scan_at = _now_iso()
        # The boot baseline is provisional for exactly one scan. Once a second
        # scan has happened we know which engines were merely churning during
        # start-up and which are genuinely still broken.
        settle = self._scans >= 2

        seen: set[str] = set()
        for status in statuses:
            engine_id = str(status.get("engineId") or "")
            if not engine_id:
                continue
            seen.add(engine_id)
            state = str(status.get("state") or "UNKNOWN")
            health = str(status.get("health") or "UNKNOWN")
            prev = self._last.get(engine_id)

            if prev is None:
                # First sight of this engine. Record the baseline and, if it is
                # already unhealthy, remember that it still needs reporting â€”
                # but only once we have seen it again (see `settle`). That way a
                # start-up wobble that clears itself is never announced, while an
                # engine genuinely broken at boot IS.
                self._last[engine_id] = {
                    "state": state, "health": health, "at": _now_iso(),
                    "pending_initial": _is_problem(state, health),
                }
                continue

            if state == prev["state"] and health == prev["health"]:
                # Same state, same health â€” the engine is simply still however it
                # was. This is the case that must stay silent.
                self._suppressed += 1
                if settle and prev.get("pending_initial"):
                    # Still in the same bad state a full interval after boot:
                    # that is a real incident, not start-up noise.
                    prev["pending_initial"] = False
                    self._primed = True
                    asyncio.create_task(self._report_problem(status, "UNKNOWN", "UNKNOWN"))
                continue

            prev_state = str(prev["state"])
            prev_health = str(prev["health"])
            self._last[engine_id] = {
                "state": state, "health": health, "at": _now_iso(),
                "pending_initial": False,
            }
            if prime_only:
                continue

            was_problem = _is_problem(prev_state, prev_health)
            is_problem = _is_problem(state, health)

            if is_problem:
                if was_problem:
                    # Escalation only: DEGRADED -> ERROR is worth saying,
                    # DEGRADED -> DEGRADED is not (handled above).
                    self._suppressed += 1
                    asyncio.create_task(self._report_problem(status, prev_state, prev_health))
                else:
                    asyncio.create_task(self._report_problem(status, prev_state, prev_health))
            elif was_problem:
                if prev.get("pending_initial"):
                    # Broken at boot but never announced (still inside the
                    # grace window), and it has now come good on its own. There
                    # was no incident to recover from, so this is silence, not
                    # a "recovered" notification for something nobody was told
                    # about.
                    self._suppressed += 1
                else:
                    asyncio.create_task(self._report_recovery(status, prev_state, prev_health))
            else:
                # ok -> ok (e.g. RUNNING -> HEALTHY after a start). Not a problem.
                self._suppressed += 1

        # Engines that vanished from the registry are simply dropped from the
        # baseline. Re-registration primes again rather than reporting.
        for gone in [eid for eid in self._last if eid not in seen]:
            self._last.pop(gone, None)

        # A restart re-baselines every engine, which would otherwise leave an
        # alert opened before the restart sitting red forever even though the
        # engine is healthy again. Close those out now that we know real state.
        if settle and not self._primed:
            self._primed = True
            asyncio.create_task(self._close_stale_incidents())

    async def _close_stale_incidents(self) -> None:
        """Resolve engine alerts that outlived the process that raised them.

        Only touches engines currently in a healthy state, so a genuinely broken
        engine keeps its alert and gets a fresh report from the pending-initial
        path instead.
        """
        healthy = [
            eid for eid, prev in self._last.items()
            if not _is_problem(str(prev.get("state")), str(prev.get("health")))
        ]
        if not healthy:
            return
        try:
            from services.notification_center import resolve_incidents_by_prefix
            for engine_id in healthy:
                closed = await resolve_incidents_by_prefix(
                    f"engine:{engine_id}:", "engine is healthy again",
                )
                if closed:
                    logger.info(
                        "[ENGINE-ALERTS] cleared %d stale alert(s) for %s",
                        closed, engine_id,
                    )
                    self._emitted += 1
        except Exception:
            logger.warning(
                "[ENGINE-ALERTS] stale-incident sweep failed", exc_info=True,
            )

    # ------------------------------------------------------------------ #
    # Detail extraction
    # ------------------------------------------------------------------ #

    @staticmethod
    def _details(status: dict, prev_state: str, prev_health: str) -> dict[str, Any]:
        engine_id = str(status.get("engineId") or "")
        metrics = status.get("metrics") or {}
        heartbeat_age = status.get("heartbeatAge")
        recent_errors = status.get("recentErrors") or []

        details: dict[str, Any] = {
            "engineId": engine_id,
            "engineName": str(status.get("engineName") or engine_id),
            "engineCategory": str(status.get("engineCategory") or ""),
            "version": str(status.get("version") or ""),
            "fromState": prev_state,
            "toState": str(status.get("state") or ""),
            "fromHealth": prev_health,
            "toHealth": str(status.get("health") or ""),
            "healthReason": str(status.get("healthReason") or ""),
            "errorCount": int(metrics.get("errorCount") or 0),
            "warningCount": int(metrics.get("warningCount") or 0),
            "queueSize": int(metrics.get("queueSize") or 0),
            "workload": int(metrics.get("workload") or 0),
            "heartbeatAgeSeconds": (
                round(float(heartbeat_age), 1)
                if isinstance(heartbeat_age, (int, float)) else None
            ),
            "connectionState": str(status.get("connectionState") or ""),
            "dependencies": list(status.get("dependencies") or []),
            "recentErrors": [
                {
                    "code": str(e.get("code") or ""),
                    "message": str(e.get("message") or "")[:240],
                }
                for e in recent_errors[:3]
                if isinstance(e, dict)
            ],
        }

        # A short, honest snapshot of the engine's own counters â€” the numbers
        # that usually explain WHY it went bad.
        custom = metrics.get("custom") or {}
        numeric = {
            k: v for k, v in custom.items()
            if isinstance(v, (int, float)) and not isinstance(v, bool)
        }
        if numeric:
            details["customMetrics"] = dict(list(numeric.items())[:12])
        return details

    # ------------------------------------------------------------------ #
    # Reporting
    # ------------------------------------------------------------------ #

    async def _report_problem(
        self, status: dict, prev_state: str, prev_health: str,
    ) -> None:
        engine_id = str(status.get("engineId") or "")
        name = str(status.get("engineName") or engine_id)
        state = str(status.get("state") or "UNKNOWN")
        health = str(status.get("health") or "UNKNOWN")
        severity = _severity_for(state, health)
        details = self._details(status, prev_state, prev_health)

        reason = str(status.get("healthReason") or "")
        summary = (
            f"{name} went {prev_state} -> {state}"
            + (f" (health {health})" if health not in ("HEALTHY", "UNKNOWN") else "")
        )
        message = reason or summary

        # Identity of THIS incident. A flap back into the same state folds into
        # the same alert/notification instead of starting a new one.
        dedupe_key = f"engine:{engine_id}:{state}:{health}"
        meta = {
            **details,
            "component": f"engine:{engine_id}",
            "reason": reason[:500],
            "reason_code": "engine_state_change",
            "engine": engine_id,
        }

        alert_id = ""
        try:
            from services.notification_center import upsert_incident
            alert_id = await upsert_incident(
                category="system",
                severity=severity,
                title=summary,
                message=message,
                dedupe_key=dedupe_key,
                source=f"engine:{engine_id}",
                component=f"engine:{engine_id}",
                reason=reason[:500],
                reason_code="engine_state_change",
                related_event_id=self._record_engine_event(
                    "ENGINE_STATE_CHANGED", severity, summary, details,
                ),
                metadata=meta,
                automation={
                    "engineId": engine_id,
                    "fromState": prev_state,
                    "toState": state,
                },
            ) or ""
        except Exception:
            logger.warning("[ENGINE-ALERTS] alert upsert failed for %s", engine_id, exc_info=True)

        try:
            from services.notification_service import notify
            await notify(
                "system",
                severity,
                summary,
                message,
                source=f"engine:{engine_id}",
                event_type="ENGINE_STATE_CHANGED",
                # Link the notification to the alert it belongs to, so the
                # notification detail view can jump straight to the incident.
                metadata={**meta, "related_alert_id": alert_id} if alert_id else meta,
                # Identity carries the target state, so an escalation
                # (DEGRADED -> ERROR) is immediately a new notification while
                # a flap back into the state we already reported folds into that
                # earlier row and only bumps its counter. Default cooldown
                # (notif_dedup_window_seconds) applies.
                dedupe_key=f"engine:{engine_id}:notif:{state}:{health}",
            )
        except Exception:
            logger.warning("[ENGINE-ALERTS] notification failed for %s", engine_id, exc_info=True)

        self._emitted += 1
        logger.warning(
            "[ENGINE-ALERTS] %s (%s -> %s, health %s)", summary, engine_id, state, health,
        )

    async def _report_recovery(
        self, status: dict, prev_state: str, prev_health: str,
    ) -> None:
        engine_id = str(status.get("engineId") or "")
        name = str(status.get("engineName") or engine_id)
        state = str(status.get("state") or "UNKNOWN")
        health = str(status.get("health") or "UNKNOWN")
        details = self._details(status, prev_state, prev_health)
        summary = f"{name} recovered {prev_state} -> {state}"
        message = str(status.get("healthReason") or f"{name} is {state.lower()} again.")

        # Clear whichever incident this engine opened, whatever state/health
        # combination created it.
        try:
            from services.notification_center import resolve_incidents_by_prefix
            closed = await resolve_incidents_by_prefix(
                f"engine:{engine_id}:", f"recovered to {state}",
            )
            if closed:
                self._emitted += 1
        except Exception:
            logger.warning("[ENGINE-ALERTS] recovery resolve failed for %s", engine_id, exc_info=True)

        try:
            from services.settings_service import get_setting
            recovery_on = await get_setting("alerts_recovery_enabled")
            if recovery_on is False:
                return
        except Exception:
            pass

        try:
            from services.notification_service import notify
            await notify(
                "system",
                "success",
                summary,
                message,
                source=f"engine:{engine_id}",
                event_type="ENGINE_RECOVERED",
                metadata={
                    **details,
                    "component": f"engine:{engine_id}",
                    "reason_code": "engine_recovered",
                    "reason": message[:500],
                    "engine": engine_id,
                },
                dedupe_key=f"engine:{engine_id}:recovered:{state}:{health}",
            )
        except Exception:
            logger.warning("[ENGINE-ALERTS] recovery notification failed for %s", engine_id, exc_info=True)

        self._emitted += 1
        logger.info("[ENGINE-ALERTS] %s", summary)

    def _record_engine_event(
        self, event: str, severity: str, summary: str, details: dict,
    ) -> str:
        """Chain the alert to a real ledger row, so nothing is untraceable."""
        try:
            from services.event_history import record_event
            entry = record_event(
                "engine", event, severity, summary,
                {
                    "severity": severity,
                    "engine": details.get("engineId"),
                    "component": f"engine:{details.get('engineId')}",
                    "reason_code": "engine_state_change",
                    "from_state": details.get("fromState"),
                    "to_state": details.get("toState"),
                    "details": summary,
                },
            )
            return str(entry.get("event_id") or "")
        except Exception:
            logger.debug("[ENGINE-ALERTS] ledger event not recorded")
            return ""


# Module singleton wired into the app lifespan.
engine_alert_reporter = EngineAlertReporter()
