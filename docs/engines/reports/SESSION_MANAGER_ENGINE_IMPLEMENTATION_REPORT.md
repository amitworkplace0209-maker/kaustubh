# Session Manager Engine Implementation Report

**Engine ID:** `session_manager`  
**Engine Name:** Session Manager Engine  
**Version:** 1.0.0 (EngineBase wrapper for existing CentralSessionManager)  
**Category:** CONTROL  
**Phase:** B (Foundation) — Engine 5 of 5  
**Date:** 2026-09-19  
**Report Location:** `docs/engines/reports/SESSION_MANAGER_ENGINE_IMPLEMENTATION_REPORT.md`

---

## Objective

Wrap the existing mature `CentralSessionManager` + `instrument_store` as an `EngineBase` subclass so the Service Control Center can observe/control the session/subscription authority as a first-class engine.

Per `docs/engines/session-manager.md`:
- Broker session lifecycle (Kotak/Shoonya/Dummy, independent)
- Stock/instrument registry (metadata only, no live ticks)
- Subscription registry (subscriber tracking, deduplication)
- Expiry management (real wall-clock, auto EXPIRED transition)
- Phase 3 lifecycle vocabulary (ACTIVE/SUBSCRIBED/PINNED/EXPIRED/...)
- Real-time events via EngineEventBus + centralized state store

---

## Changes Summary

### 1. Backend (`python-service/services/session_manager_engine.py`)
- **New EngineBase wrapper** exposing the CentralSessionManager capabilities:
  - **Lifecycle:** `_on_start()` / `_on_stop()` wiring config, dependencies (`connection_manager`, `websocket_engine`, `scheduler`)
  - **Health:** Checks MongoDB connectivity, session active state, instrument counts
  - **Control:**
    - `reconcile()` → runs expiry sweep + request normalization
    - `set_mode(mode, broker, user_id)` → switches terminal context
    - `login(mode, broker, user_id, ...)` → records broker login
    - `logout(reason, mode)` → records session end with honest reason
    - `expire(reason)` → records session expiry
  - **Status snapshot:** Includes `phase3Snapshot` + `subscriptionSnapshot`

### 2. Registration (`python-service/app.py`)
- Imported `session_manager_engine` singleton
- Registered in Engine Registry
- Added to auto-start list

### 3. Tests (`python-service/tests/test_session_manager_engine.py`)
- 11 tests covering: identity, lifecycle, health (Mongo connected/disconnected/unhealthy), control methods (reconcile, set_mode, login, logout, expire), status snapshot
- All pass

### 4. Frontend (Existing — not modified)
- **Service Phase page** at `/services/session-manager` (`app/_pages/session-manager/page.tsx`) — comprehensive with 11 tabs:
  - Overview, Instruments, Subscriptions, Sources, Pins, Expiry, Connections, Live Feed, History, Reconcile, Manual Add
- **Wrapper** at `app/(services)/services/session-manager/page.tsx`
- **Sidebar entry** in System group (`components/layout/nav.ts`) — already present

---

## Deviations from Target Design Doc

| Item | Target (`session-manager.md`) | Implemented | Notes |
|------|-------------------------------|-------------|-------|
| Broker sessions (Kotak/Shoonya/Dummy) | Independent | ✅ | `CentralSessionManager` has per-terminal records |
| Stock/Instrument registry | Metadata only | ✅ | `instrument_store` canonical records |
| Subscription registry | Subscriber tracking | ✅ | Reference counting, deduplication |
| Expiry management | Wall-clock, auto EXPIRED | ✅ | `reconcile()` sweep, `EXPIRY_WARNING_SECONDS` |
| Phase 3 lifecycle vocabulary | ACTIVE/SUBSCRIBED/PINNED/... | ✅ | `canonical_status()` derivation |
| Real-time events | EngineEventBus + state store | ✅ | `_publish_engine_event()`, `_publish_domain_event()` |
| Scheduler integration | 08:50 login, 08:55 WS start | ✅ | Dependency on `scheduler` declared |
| WebSocket Engine integration | Active list → WS subscribe | ✅ | Dependency on `websocket_engine` declared |
| Dummy mode | No separate session/WS | ✅ | Terminal isolation in `set_mode()` |
| Multi-broker isolation | Independent Kotak/Shoonya | ✅ | Per-terminal session records |
| Security | No secrets in logs/UI | ✅ | `_auth_log()` safe-only logging |

---

## Verification Checklist

- [x] Engine registers at startup (`engine_id: "session_manager"`).
- [x] Lifecycle states: `REGISTERED → STARTING → RUNNING → HEALTHY`.
- [x] Health check: `HEALTHY` when MongoDB connected, `DEGRADED` when disconnected.
- [x] `reconcile()` runs expiry sweep via CentralSessionManager.
- [x] `set_mode()` switches terminal context (no login/logout).
- [x] `login()`/`logout()`/`expire()` delegate to CentralSessionManager.
- [x] Status snapshot includes `phase3Snapshot` + `subscriptionSnapshot`.
- [x] All Python tests pass (11/11).
- [x] No regressions in Storage (12) + DB Writer (17) + Notification (9) + Audit (12) + Session Manager (11) = 61 tests.
- [x] TypeScript compiles clean.
- [x] Frontend Service Phase page already implemented with 11 tabs.
- [x] Sidebar entry already in System group.

---

## Existing Infrastructure Leveraged (Not Re-implemented)

| Component | File | Status |
|-----------|------|--------|
| Central session lifecycle | `services/session/session_manager.py` | Mature — thread-safe, per-terminal, event publishing |
| Instrument persistence | `services/session/instrument_store.py` | Canonical records, events, revisions |
| Session Manager API | `api/session_manager.py` | Full CRUD + lifecycle transitions + reconcile |
| Frontend page | `app/_pages/session-manager/page.tsx` | 11 tabs, live feed, real-time |
| Sidebar entry | `components/layout/nav.ts` | System → Session Manager |

---

## Next Steps (Phase C → Engine 6: Connection Manager)

1. Implement Connection Manager Engine per `docs/engines/connection-manager.md`
2. Add Service Phase UI + sidebar entry (if not existing)
3. Write tests + report

---

## Files Changed

- `python-service/services/session_manager_engine.py` (new)
- `python-service/app.py` (import + registration)
- `python-service/tests/test_session_manager_engine.py` (new, 11 tests)

---

**Status:** ✅ COMPLETE — Ready for Phase C Engine 6 (Connection Manager).