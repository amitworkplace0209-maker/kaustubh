# DUMMY MODE ARCHITECTURE — KAUSTUBH Trading Terminal

> **PART 37**: Dummy Mode is the default and safest mode of the terminal.
> It must NEVER auto-switch to Kotak Neo. This document describes the isolation
> boundaries, mode persistence, and the scheduler gate introduced to fix the
> Dummy→Kotak 5-second auto-switch root cause.

## Design Principle

> **Dummy Mode is NOT a fallback for a broken Kotak connection.** It is a
> first-class, persistent, isolated mode where no real broker code executes.

## Mode Resolution (Single Authoritative Source)

The runtime mode is resolved by `brokers.manager.active_terminal()` which reads:

```
1. session_manager.snapshot().get("mode")   ← set by switch_terminal()
2. get_runtime_setting("terminal_mode")     ← persisted in MongoDB
3. settings.broker_mode                     ← env default "kotak"
```

**Resolution order (priority):** session memory > persisted DB setting > env.

After a user selects DUMMY via the UI:
- `POST /api/terminal/switch {mode: "dummy"}` → `switch_terminal("dummy")`
- `session_manager.set_mode("dummy")` → session memory = "dummy"
- `set_setting("terminal_mode", "dummy")` → persisted to MongoDB
- Frontend `mode-reconciler.tsx` adopts the backend authoritative mode
- localStorage persists `kaustubh_terminal_mode = "dummy"`

On backend restart:
- `get_runtime_setting("terminal_mode")` returns "dummy" from MongoDB (via runtime_settings TTL cache)
- `active_terminal()` returns "dummy" — scheduler stays parked

## Scheduler Gate (The Fix for the 5-Second Bug)

**Root cause (fixed):** The `SchedulerController._reconcile_unlocked()` had NO
mode awareness. On every 5-second tick during market hours, when no Kotak
session was active, it unconditionally called `_ensure_login_locked()` →
`_do_login_impl("scheduler")` → `kotak_session.login()` (real broker login).

**The chain (before fix):**
```
_tick_seconds = 5.0
_supervisor_loop: reconcile + sleep(5s)
_reconcile_unlocked → _ensure_login_locked (no mode check!)
_do_login_impl → kotak_session.login() (REAL Kotak Neo SDK login)
mark_login_success(mode=_active_mode_name()) → mode overwritten to "kotak"
```

**Fix applied (3 gates):**

1. **`_reconcile_unlocked()`** (`scheduler/__init__.py`):
   After the `sched_enabled` check and before market slot evaluation, a new
   `is_dummy_mode()` gate runs:
   ```python
   if is_dummy_mode():
       # Logout any stale Kotak session
       # Stop WS supervisor
       # Stop any active WS feed
       # Set STATE_LOGGED_OUT
       return
   ```

2. **`do_login()`** (`scheduler/__init__.py`):
   Before attempting any Kotak login:
   ```python
   if is_dummy_mode():
       logger.info("Login skipped: dummy mode active")
       return True
   ```

3. **`notify_auth_failure()`** (`scheduler/__init__.py`):
   Before scheduling a re-login:
   ```python
   if is_dummy_mode():
       return  # never re-login to real broker in dummy
   ```

4. **`_active_mode_name()`** (`scheduler/__init__.py`):
   Changed from reading `settings.broker_mode` to reading
   `active_terminal()` (the actual resolved mode).

## Dummy Adapter Isolation

`DummyAdapter` (`brokers/dummy.py`) implements the `BrokerAdapter` interface:
- `login()`: Creates a synthetic dummy session. Does NOT touch `kotak_session`.
- `logout()`: Clears synthetic state.
- `is_logged_in`: Returns the dummy session state.
- All broker API methods (positions, orders, margins): Return honest empty/dummy data.

**Critical:** DummyAdapter.login() calls `session_manager.set_mode("dummy")`
but does NOT set `kotak_session.session_active`. This means the scheduler's
"no active session" check (`if not kotak_session.session_active`) correctly
triggers the dummy-mode gate (now fixed) instead of proceeding with Kotak login.

## Frontend Mode Flow

```
User selects DUMMY in UI
  → lib/terminal-mode.ts::switchTo('dummy')
  → POST /api/terminal/switch {mode: 'dummy'}
  → session_manager.set_mode('dummy')
  → Settings stored to localStorage + backend

Backend SSE (realtime-provider.tsx) publishes state_snapshot
  → state.session.mode = 'dummy' / state.terminal = 'dummy'

TerminalModeReconciler (app-providers.tsx, globally mounted)
  → Reads backendTerminal = state.session?.mode ?? state.terminal
  → Converts to TradingMode via fromTerminalId()
  → If local mode ≠ backend mode: store.setMode(backendMode)
```

**After the fix:** In dummy mode, the backend never sends `mode: "kotak"` via
the SSE snapshot, so the reconciler never flips the UI from dummy to kotak.

## Safety Rules (Enforced)

| Rule | Implementation |
|------|---------------|
| Dummy never calls real broker SDK | `DummyAdapter` is a complete interface impl; scheduler gate prevents Kotak login |
| Dummy never auto-becomes Kotak | Scheduler `_reconcile_unlocked`, `do_login`, `notify_auth_failure` all gate on `is_dummy_mode()` |
| Dummy mode persists across restarts | `active_terminal()` reads `terminal_mode` from MongoDB via runtime_settings cache |
| No real market data in dummy | WS feed requires `kotak_session.session_active` (never true in dummy mode) |
| Frontend respects backend mode | `TerminalModeReconciler` is backend-authoritative (SSE snapshot is the source of truth) |
| No `window.location.reload()` workaround | Mode is resolved by backend + reconciler; no page refresh needed |

## Files Modified

| File | Change |
|------|--------|
| `python-service/scheduler/__init__.py` | `_reconcile_unlocked` dummy gate, `do_login` dummy gate, `notify_auth_failure` dummy gate, `_active_mode_name` reads `active_terminal()` |
| `python-service/brokers/manager.py` | `active_terminal()` now reads persisted `terminal_mode` from runtime_settings cache |
| `python-service/services/runtime_settings.py` | `terminal_mode` added to `LIVE_KEYS` so it's cached and sync-readable |

---

*Generated: 2026-09-14 | Root cause evidence: scheduler/__init__.py:208,725-732,915,952,975,1046,1072,1118*
