# ENGINE FAILURE RECOVERY — KAUSTUBH Trading Terminal

> **PART 36**: How each engine recovers from failure, and how the system
> reacts when its dependencies fail.

## Engine Startup Failure

`search_engine` (fixed): `_load_instruments()` now handles the
`{"instruments": [...]}` JSON shape. Path 1: `instrument_cache.get_instruments()`
(in-memory). Path 2: parse JSON dict with `.get("instruments", [])` or list.
If both fail the engine starts with an empty index (status: ERROR with
`recentErrors` populated) — it never crashes the process.

## Scheduler Failure Recovery (Dummy Mode)

- `notify_auth_failure()`: In dummy mode returns immediately (no Kotak
  re-login). In kotak mode it marks the session expired and requests reconcile.
- `_reconcile_unlocked()`: In dummy mode deterministically tears down any stale
  Kotak session/WS and parks at `STATE_LOGGED_OUT`.
- Next scheduled login/session restore is a no-op in dummy mode.

## WebSocket / Feed Failure

- `ws_manager` supervisor owns reconnect; `WebSocketEngine` reports
  `state: DISCONNECTED` honestly when not connected (never fakes CONNECTED).
- When the feed is down, feature/watchlist engines simply see no new ticks
  (no fabricated ticks).

## Unknown-Health Engines

Registered-but-not-started engines (margin, squareoff, notification) report
`health: UNKNOWN` until they actually start — the control plane never
autofills a health verdict.

## Event Bridge (TICK_VALIDATED) Failure

- `start_event_bridge()` is idempotent; `stop_event_bridge()` drains.
- If the drain task dies, `_drain()` is re-scheduled by the next put
  (`_queue_bus_event` guards the task handle).
- Feed messages still canonicalize; enqueue failures are logged, never thrown.

---

*Generated: 2026-09-14 | Part 36*