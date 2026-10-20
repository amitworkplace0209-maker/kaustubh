# Scheduler Lifecycle

The Scheduler (`scheduler/` — `SchedulerController` + `SchedulerLedger`) is the
system's clock: it drives periodic jobs against the market session and records
every fired run in a ledger.

## Start order (app.py `lifespan()`)

1. Event loop + event ledger ready
2. MongoDB available
3. Runtime settings / overrides synced
4. `init_notification_center()`
5. Tick buffer worker / export worker / downloads checker
6. Scheduler started on its named loop — reads the session calendar and schedules:
   - market-open / market-close jobs
   - square-off job (end of day / configured time)
   - health / maintenance sweeps
7. WebSocket Engine wiring, Engine Registry auto-start, Connection Engine start
8. Dummy session, instrument-cache preload, background worker tasks

## Job execution model

- Jobs are scheduled relative to the **current trading session**
  (`services/market_state.py` confirms MARKET_OPEN from live ticks; the session
  manager supplies expiry timings).
- Each fired job records an entry in the `SchedulerLedger` (persisted) so runs
  are auditable and replayable: job id, fire time, status, payload, error.
- Square-off triggered by the scheduler uses `source="scheduler"` and therefore
  does **not** require the manual confirmation token (that gate is only for
  `source="manual"`).

## Shutdown order (app.py shutdown)

Mirrors startup in reverse:

1. Cancel background workers (downloads, export, tick-buffer flusher)
2. Stop scheduler loops (no new jobs fire)
3. Stop connection gateway (WS #2)
4. Tear down WebSocket Engine / WS #1 feed subscription
5. Graceful broker logout via `do_logout(source="system")`
6. Flush remaining audit/storage writes

## States observed

`Pending → Fired → Running → Succeeded/Failed/Cancelled`, tracked per job with
ledger timestamps; the ledger also exposes summaries
(`SCHEDULER_SUMMARY`, tested in `tests/test_scheduler_summary.py`).

## Trading-day lifecycle (Asia/Kolkata, current-time authority)

The daily lifecycle is fixed and the backend is **current-time aware**: every
reconcile tick (5s) recomputes the desired state from the IST clock, the real
Kotak session, the real broker feed and the persisted run ledger. A restart at
ANY instant converges to the correct lifecycle — nothing depends on a scheduled
event having been observed while the process was running.

| Time (IST)  | Event                                    |
|-------------|------------------------------------------|
| 08:50       | automatic Kotak login                    |
| 08:55       | broker WebSocket connect (`ws_start`)    |
| 08:59       | tick collection start                    |
| 15:31       | broker WebSocket disconnect (`ws_stop`)  |
| 16:00       | Kotak logout                             |

All five instants are runtime settings (`sched_login_time`,
`sched_ws_start_time`, `sched_tick_collection_start_time`, `sched_ws_stop_time`,
`sched_logout_time`) falling back to the env defaults in
`config/settings.py`, so a Settings edit applies within one tick.

## Late-restart reconciliation (catch-up window = ws_stop)

The **oracle for “a missed schedule is still valid” is the WS stop instant
(15:31 IST)**, not a fixed 3-hour look-back:

- Backend returns **08:00–08:50** → `WAITING_FOR_LOGIN`, no automatic action.
- Backend returns **08:50–15:31** with no session → the missed **login is
  CATCHING_UP** and the scheduler logs in immediately (11:00 and 14:30 restarts
  resume the SAME active trading lifecycle — they do NOT wait for the next day).
- Backend returns **08:55–15:31** with an active session → the missed **feed
  start is CATCHING_UP**; the supervisor connects and restores subscriptions.
- Backend returns **15:31–16:00** with a live session + feed → the feed is
  disconnected (`scheduled_disconnect`), the session is retained until logout.
- Backend returns **at/after 15:31** with no session → the day is parked
  (`MISSED_EXPIRED`/`SKIPPED` ledger) — **no blind login, no blind feed start**.
- Backend returns **after 16:00** → `WAITING_FOR_NEXT_TRADING_DAY`.
- **Weekend / exchange holiday** → `MARKET_CLOSED`, never auto-logs-in.

Implementations: `scheduler/persist.py` (`feed_deadline = ws_stop` for the
login + ws_start jobs), `scheduler/__init__.py` `_market_slot()`
(`in_login_window = login_at <= now < ws_stop`), and the supervisor wake so a
`request_reconcile()` at boot reconciles immediately (no 5s wait). The
observability contract is the deduped `LIFECYCLE` structured log (one line per
state transition).

State ownership: the **Session Manager** (`services/session/session_manager.py`)
is the authority for login + WS session state; `ws_manager` reports every real
open/close/reconnect into it (`mark_ws_connecting/connected/reconnecting/
disconnected`). The scheduler orchestrates; it never fabricates state.

Covered by `tests/test_scheduler_reconcile_lifecycle.py` and
`tests/test_scheduler_ledger.py`.