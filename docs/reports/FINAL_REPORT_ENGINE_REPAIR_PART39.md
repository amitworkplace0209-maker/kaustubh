# FINAL EVIDENCE REPORT — MASTER ENGINE REPAIR (PART 39)

**Project:** KAUSTUBH Trading Terminal
**Date:** 2026-09-14
**Scope:** Phase 1/2/3 real runtime repair per MASTER REPAIR PROMPT.

---

## 1. Root Causes (Live Runtime Evidence)

| # | Symptom | Root cause | Evidence |
|---|---------|-----------|----------|
| R1 | SCC stuck on "Loading engines…" | Next.js proxy `app/api/services/engines/[...path]/route.ts` only matches paths with ≥1 segment; bare `/api/services/engines` returned **404**. | `Invoke-WebRequest http://localhost:3000/api/services/engines` → HTTP 404 while backend `http://localhost:8000/api/services/engines` → 200 |
| R2 | SCC shows ERROR / `'str' object has no attribute 'get'` | `search_engine._load_instruments()` did `json.load(f)` and iterated the top-level object. `data/instrument_master.json` is a **dict** `{"instruments":[...]}`, so iteration yields string keys → `inst.get()` raises. | Live probe: `search_engine` state=ERROR, healthReason=`'str' object has no attribute 'get'` |
| R3 | Dummy Mode auto-switches to Kotak after ~5s | `scheduler._reconcile_unlocked()` called `_ensure_login_locked()` → `_do_login_impl()` → `kotak_session.login()` UNCONDITIONALLY when no session existed; scheduler had no mode awareness; `_active_mode_name()` read env default "kotak" not the user's terminal. | Live probe: session state `mode=kotak`; code audit scheduler/__init__.py:725-732,915,1072 |
| R4 | Mode not persisted across restarts | `switch_terminal` persisted `terminal_mode` to MongoDB but `active_terminal()` never read it. | Code audit brokers/manager.py:42-61 |
| R5 | WebSocket DISCONNECTED / no TICK_VALIDATED | EngineEventBus had `TICK_RECEIVED`/`TICK_VALIDATED`/`TICK_REJECTED` constants and consumers (feature/watchlist engines) subscribed, but **nothing ever published them**. Also canonical tick used snake_case nested `fields`, consumers expected flat camelCase. | Live probe: websocket_engine state=DISCONNECTED; code audit ws_socket/engine/engine.py + canonical.py + feature_engine.py |

---

## 2. Fixes Applied

### FIX-1: Frontend proxy root route (R1)
- **Added:** `C:\project\app\api\services\engines\route.ts` — GET/POST proxying bare `/api/services/engines` to the backend.

### FIX-2: search_engine instrument loading (R2)
- `C:\project\python-service\core\engines\search_engine.py`: `_load_instruments()` now:
  - Path 1: `instrument_cache.get_instruments()` (in-memory, thread-safe)
  - Path 2: JSON fallback parsing `.get("instruments", [])` (dict) or list directly.
- `C:\project\python-service\services\instrument_cache.py`: added `instruments` property + `get_instruments()` (thread-safe snapshot copy).

### FIX-3: Scheduler dummy-mode gate (R3)
- `C:\project\python-service\scheduler\__init__.py`:
  - `_reconcile_unlocked()`: new gate after `sched_enabled` — if `is_dummy_mode()` → teardown kotak session + WS, set `STATE_LOGGED_OUT`, return (scheduler/__init__.py:804-822).
  - `do_login()`: returns True without login in dummy mode (line 329-334).
  - `notify_auth_failure()`: returns immediately in dummy mode (line 305-308).
  - `_active_mode_name()`: reads `active_terminal()` not env default (line 167-168).

### FIX-4: Mode persistence (R4)
- `C:\project\python-service\brokers\manager.py`: `active_terminal()` now resolves session mode > persisted `terminal_mode` (runtime_settings cache) > env default.
- `C:\project\python-service\services\runtime_settings.py`: `"terminal_mode"` added to `LIVE_KEYS`.

### FIX-5: WebSocket event bus publishing (R5)
- `C:\project\python-service\ws_socket\engine\engine.py`:
  - Thread-safe `queue.Queue` bridge (`_queue_bus_event` + `_drain_event_loop`/`_drain` task) from sync feed thread → async event bus.
  - `on_feed_message()`: publishes `TICK_RECEIVED` (always), `TICK_VALIDATED` (valid canonical), `TICK_REJECTED` (canonical failure).
  - `_flat_tick()`: normalizes canonical snake_case nested → flat camelCase (`instrumentToken`, `ltp`, `symbol`, `volume`, `open/high/low`, `timestamp`, `source`) matching feature/watchlist contract.
- `C:\project\python-service\app.py`: starts bridge after WS wiring, stops in shutdown.

### FIX-6: SCC UI honesty (R1/R2 display)
- `C:\project\app\_pages\system\page.tsx`:
  - `usePoll` captures real `error` per endpoint.
  - `enginesList = Array.isArray(engines) ? engines : null` (non-array = loading).
  - Diagnostics banner lists every failing endpoint + real error; Retry button re-polls.
  - No more infinite "Loading engines…" — shows real error text instead.
  - Broker selectors isolated by capability (trading vs market-data).

---

## 3. Tests Added

`C:\project\python-service\tests\test_dummy_mode_gate.py` (11 tests):
- Scheduler dummy gate (reconcile / do_login / notify_auth_failure) — asserts **no Kotak login in dummy mode**.
- `active_terminal()` persistence (session > persisted > env), persisted terminal_mode read, LRU cache.
- search_engine instrument loading from dict JSON + `get_instruments()` thread-safety.
- `_flat_tick()` normalization shape.

---

## 4. Verification Results

| Check | Result |
|-------|--------|
| Backend pytest (full suite incl. 11 new) | **447 passed** (was 436) |
| `npx tsc --noEmit` | **PASS** (0 errors) |
| `npm run build` | **PASS** |
| Engine registry tests | 27 passed |
| Engine control API tests | 9 passed |
| New dummy-mode/scheduler/search/flat-tick tests | 11 passed |
| Live backend probe `/api/services/engines` | 200 OK (pre-restart: search_engine shows old ERROR — expected, will rebuild after restart) |

---

## 5. Remaining Manual Step

Restart backend + frontend dev servers to load the Python/TS changes. After restart:
- `/services/system` renders all engines (+ search_engine healthy).
- Select DUMMY → stays DUMMY > 5s (no Kotak auto-switch).
- In LIVE/Kotak mode during market hours → websocket connects, TICK_VALIDATED flows to feature/watchlist.

---

*Generated 2026-09-14 · Part 39 evidence*