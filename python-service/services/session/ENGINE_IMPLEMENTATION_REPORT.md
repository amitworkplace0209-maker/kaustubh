# Session Manager Engine — Implementation Report

**Engine ID:** `session_manager`
**Engine Name:** Session Manager Engine
**Version:** 1.1.0 (EngineBase wrapper over `CentralSessionManager` + runtime configuration layer)
**Category:** CONTROL
**Phase:** B (Foundation) — Engine 5 of 5 (+ Phase 3 upgrade)
**Date:** 2026-09-20
**Report Location:** `python-service/services/session/ENGINE_IMPLEMENTATION_REPORT.md`
**Design Reference:** `docs/engines/session-manager.md` (41 sections + new §42-44)

---

## 1. Objective

Full doc-driven completion of the Session Manager Engine per `docs/engines/session-manager.md`:

1. Broker session lifecycle (Kotak / Shoonya / Scheduler / Dummy, independent).
2. Stock/instrument registry (metadata only — no live ticks consumed).
3. Subscription registry (subscriber tracking, deduplication, canonical status).
4. Expiry management (real wall-clock, automatic EXPIRED / archive).
5. Runtime configuration (Session lifetime, expiry-warning horizon, tick-active window) applied LIVE with MongoDB persistence.
6. Session state + history + diagnostics surfaced truthfully.
7. Frontend upgrade: Session / Configuration / Diagnostics tabs, instrument detail drawer, real-time detail-tab refresh.

---

## 2. Audit Summary

Full audit was performed before implementation:

| Area | File(s) | Findings → action |
|------|---------|-------------------|
| Frontend realtime | `lib/engine-realtime.ts`, `components/frontend-realtime-provider.tsx` | `useEngineStatus` subscribes to WS#2 `engines` channel; `engine.status` frames carry each engine's `status_snapshot()` verbatim. Detail tabs can refresh on every frame. |
| Settings architecture | `docs/SETTINGS_ARCHITECTURE.md`, `services/settings_service.py`, `api/settings.py` | Settings framework is broker/connection-scoped; Session Manager introduced its own dedicated settings service (see §4) instead of abusing settings_service. |
| Engine inventory | `docs/ENGINE_INVENTORY.md`, `docs/ENGINE_AUDIT_REPORT.md` | `session_manager` already registered as EngineBase wrapper via `session_manager_engine.py`; legacy `SessionFacade` also claims `engine_id="session_manager"`. |
| Event history | `services/event_history.py` | `record_event("session", ...)`, `mongo_events()` (persisted) + `recent_events()` (in-memory ring) → basis for `/session`, `/session/history`. |
| Session manager | `services/session/session_manager.py` (2992+ lines) | Expiry check + fresh-tick + login lifecycle hardcoded → wired to config accessors. |
| Frame pipeline | `api/ws_gateway.py`, `services/legacy/connection_engine/connection_engine.py` | `engine_snapshot()` pushes every engine's `status_snapshot()` (`get_engine_registry().get_all_statuses()`) on the `engines` channel → `overview.configSummary`, `overview.session` live in UI without polling. |
| Legacy facade tests | `tests/test_legacy_engine_facades.py` | `FacadeCatalogTest.test_registry_contains_expected_ids` asserts `FACADES` must contain `session_manager` → **do NOT remove the facade**; duplicate engine_id is documented (see §13). |

---

## 3. Architecture Overview

```
UI / API / Engine
        |
        v
SESSION MANAGER (session_manager.py + session_manager_engine.py)
    |-- Session Store (per-terminal, session history)
    |-- Instrument Registry (instrument_store.py)
    |-- Subscription Registry (canonical status, revisions)
    |-- Expiry Manager (wall-clock sweep, archive-not-purge)
    |-- Runtime Config  (session_manager_config.py: defaults + Mongo + sync cache)
    |-- Session API / Service (api/session_manager.py)
    |-- Event Publisher (event_history + engine_event_bus)
        |
        +---- active stock list ----> WebSocket Engine
        +---- stock events ---------> WebSocket Engine
        +---- engine.status ---------> Connection Manager -> UI (WS#2)
```

Session Manager NEVER receives, processes, or distributes live market data. This boundary is preserved (see §9).

---

## 4. New: Runtime Configuration Service

`python-service/services/session/session_manager_config.py`

### 4.1 Fixed defaults

| Key | Default | Min | Max | Runtime consumer |
|-----|---------|-----|-----|------------------|
| `session_lifetime_seconds` | 3600 | 300 | 86400 | `mark_login_success` / `login` → new-session expiry |
| `expiry_warning_seconds` | 900 | 60 | 3600 | canonical_status → EXPIRING horizon |
| `tick_active_window_seconds` | 60.0 | 10 | 300 | fresh-tick / ACTIVE window |

Each key carries: `value`, `default`, `min`, `max`, `step`, `description`, `updated_at`, `updated_by`, `persisted`.

### 4.2 Storage & cache

- Persisted per-key in MongoDB collection **`session_manager_config`** (`pk_key` id docs).
- **Sync accessors** (`session_lifetime_seconds()`, `expiry_warning_seconds()`, `tick_active_window_seconds()`) read an in-memory cache — no `await` in the hot path.
- `state()` reports `cacheSource: 'mongo' | 'defaults'` (Mongo down ⇒ defaults, honestly reported — no faked persistence).

### 4.3 Live application (no restart)

- **New sessions only:** configured `session_lifetime_seconds` is applied at login. The active session's expiry is NOT retroactively changed.
- **Expiry warning horizon:** read live in `canonical_status` → instruments relabel EXPIRING earlier/later instantly.
- **Tick-active window:** read live in fresh-tick logic → ACTIVE derivation shifts instantly.

### 4.4 Operations

- `get_config`, `set_config` (unknown key ⇒ **rejected**), `reset_config`, `reset_key`, `refresh_config`.
- Every config event published via `event_history.record_event("session", ...)` + best-effort `engine_event_bus`.
- Hydrated at `app.py` lifespan (after `reload_instruments`).

---

## 5. Wiring into `CentralSessionManager`

`python-service/services/session/session_manager.py`

- Imported `_cfg_expiry_warning_seconds()`, `_cfg_tick_active_window_seconds()`, config helpers.
- Expiry-warning check and fresh-tick window now read live config.
- `mark_login_success(lifetime_seconds=None)` — a `None` default now means "use configured session lifetime" (previously None meant "no expiry"). **Verified by grep no caller relied on None→no-expiry** (dummy.py, shoonya_adapter.py, brokers `__init__.py:1527`, session_manager_engine.py; scheduler path still passes `scheduled_expires_at`).
- New `self._session_lifetime`: `sessionDurationSeconds` in the snapshot now reports the **ACTIVE session's actual lifetime** (scheduler sessions have no explicit lifetime ⇒ honest `None`), NOT the config default.
- Lifetime tracking cleared on `mark_expired` / `mark_logout`.
- Docstring updated.

---

## 6. Engine wrapper

`python-service/services/session_manager_engine.py`

- Live `config_summary()` method (merged into `status_snapshot.configSummary`).
- `_on_start()` computes `config_summary()` at start.
- `login(mode, broker, user_id, ...)` — `lifetime_seconds=None` default → config-driven.
- `status_snapshot()` adds `configSummary`.

---

## 7. New API endpoints

`python-service/api/session_manager.py`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/session` | GET | Current session snapshot (identity, lifecycle, websocket, routing, terminal sessions, session history, recent events, errors) |
| `/session/history?limit=` | GET | Merge of `event_history.mongo_events()` + `recent_events()` (in-memory ring) + manager snapshot ring — includes events not yet persisted. |
| `/diagnostics` | GET | Engine registry states, session health, revision status, MongoDB connectivity, effective config + cache source, event ring counts, connections, last REST error |
| `/config` | GET | Config schema + state (`cacheSource`) |
| `/config` | PUT | Raw patch `{key: value}` or `{config: {...}, updatedBy}`; unknown keys rejected |
| `/config/reset` | POST | Reset all keys to defaults |
| `/config/{key}/reset` | POST | Reset one key |

All data is real backend state — no fabricated values.

---

## 8. Tests

### 8.1 New test files

| File | Tests | Coverage |
|------|-------|----------|
| `tests/test_session_manager_config.py` | 7 | defaults + Mongo-down fallback, validation bounds, set + live apply, reset all, reset key, refresh from Mongo, config lifetime drives new session |
| `tests/test_session_manager_api_surface.py` | 7 | `/session` shape, history rows, diagnostics, config read, update, unknown-key rejection, config reset (FastAPI `TestClient` + `FakeDB`) |

### 8.2 Results

- Session scope (existing 54 + new 14): **68 passed**.
- `py_compile` clean for all changed modules.
- 1 deprecation warning (third-party `dateutil`) — non-blocking.

**Test lessons recorded:** `FakeMongoCollection.find()` must return an **async generator** (config uses `async for ... find({})`); `mark_login_success` is **sync** (returns snapshot); history endpoint had to merge `recent_events()` ring to include un-persisted events.

---

## 9. Responsibility boundary (preserved)

| Must | Must NOT |
|------|----------|
| Session / instrument / subscription lifecycle | Receive/distribute live market data |
| Expiry sweep + archive (historical ticks kept) | Purge ticks on expire/remove |
| Config authority for session-scoped knobs | Configure broker/connection depth settings |
| Emit stock/session/subscription events | Fabricate tick counts, active states, or errors |
| Real state in every API/UI surface | Pretend persistence when Mongo is down |

---

## 10. UI Upgrade

`app/_pages/session-manager/page.tsx`

- **Imports:** new lucide icons + `Sheet` family from `@/components/ui/sheet`; `useFrontendRealtime` already used.
- **Helpers:** `fmtDuration()`, `LivePill({ok, label})`.
- **New panels:**
  - **Session** — identity/lifecycle/remaining (via `/session`), WebSocket + routing, terminal sessions, session history, recent events.
  - **Configuration** — per-key input + Save + Reset + Reset-all (`/config`), `LIVE APPLY`/`PERSISTED` vs `DEFAULTS` badges from `cacheSource`, drafts never clobbered on refresh (fill-missing-only guard).
  - **Diagnostics** — engine registry states, session health, revision drift, MongoDB, effective config, event counts, connections, last REST error.
  - **InstrumentDetailSheet** — `Sheet` drawer: full canonical record + lifecycle event timeline (`/events?instrument_id=...`) + Subscribe/Unsubscribe/Pin/Expire/Archive actions.
- **InstrumentsPanel:** row-click opens drawer; client-side pagination (page size 50, prev/next, clamps on page/filter change); reset to page 0 on filter change.
- **TABS extended** (order): Overview, Session, Instruments, Subscriptions, Sources, Pins, Expiry, Connections, Live, History, Reconcile, Configuration, Diagnostics, Manual Add.
- **Realtime cadence:** page-level `liveTick` counter incremented on every `engine.status` frame; active detail tab refreshed via `refreshForTab(tab)`. **Configuration and History never auto-refresh** (editing / first-refresh user control). Overview remains live.
- **Header:** `SESSION ACTIVE` pill + `CONFIG PERSISTED` / `CONFIG DEFAULTS` chip.

Verification: `npx tsc --noEmit` clean, `npx eslint app/_pages/session-manager/page.tsx` clean.

---

## 11. Verification Checklist (original 11-phase items)

- [x] Engine registers at startup (`engine_id: "session_manager"`).
- [x] Lifecycle: `REGISTERED → STARTING → RUNNING → HEALTHY`.
- [x] Health check: honest MongoDB / session / instrument counts.
- [x] `reconcile()` runs expiry sweep + request normalization.
- [x] `set_mode()` switches terminal context (no login/logout).
- [x] `login()`/`logout()`/`expire()` delegate to `CentralSessionManager`.
- [x] Status snapshot includes `phase3Snapshot` + `subscriptionSnapshot` + `configSummary`.
- [x] Session expire → recorded in history.
- [x] Expired instrument auto-archived (ticks kept).
- [x] No secrets in logs/UI (`_auth_log` safe-only).
- [x] Session Manager does not consume/distribute market data.

## 12. Verification Checklist (new Phase-3 items)

- [x] Config service: defaults + Mongo persistence + sync cache + live accessors.
- [x] Config lifecycle: GET/PUT/reject-unknown/reset-key/reset-all; hydration at startup.
- [x] Config events published via event_history + engine_event_bus.
- [x] `sessionDurationSeconds` = actual session lifetime (not config default).
- [x] `/session`, `/session/history`, `/diagnostics`, `/config` (+resets) endpoints live.
- [x] Frontend tabs: Session / Configuration / Diagnostics + instrument drawer + pagination.
- [x] Detail tabs refresh on `engine.status` frame; Configuration/History excluded.
- [x] 14 new backend tests pass; 68 total session-scope green.
- [x] `tsc` + `eslint` clean.
- [x] No fabricated values anywhere in new surfaces.

---

## 13. Known Duplicate Engine ID (documented, intentional)

- `services/legacy/engine_facades.py` `SessionFacade` and `session_manager_engine.py` `SessionManagerEngine` **both** use `engine_id="session_manager"`.
- The registry order makes the **legacy facade win** (registered after natives).
- `tests/test_legacy_engine_facades.py::FacadeCatalogTest::test_registry_contains_expected_ids` asserts `FACADES` must contain `session_manager` → the facade is **retained**.
- Impact: existing Session Manager page reads `/overview` via facade snapshot, not the engine wrapper's full phase-3 snapshot. The new UI's Session/Diagnostics tabs use the new dedicated REST endpoints directly, so no stale facade data is shown.
- Decision: keep both; the wrapper provides the phase-3 + config surface going forward. Any migration to a single `engine_id` requires updating the legacy facade test first.

---

## 14. Deviations from Design Doc

| Item | Target | Implemented | Notes |
|------|--------|-------------|-------|
| Runtime configuration | (unspecified in 41 sections) | ✅ added §42 | Dedicated `session_manager_config` service; broker settings untouched |
| Session state tab | (unspecified) | ✅ added §43 | `/session` + history endpoint |
| Diagnostics tab | Engine diagnostics | ✅ added §43 | Engine registry + config + mongo + revisions + events |
| Realtime detail refresh | WS#2 engine.status | ✅ added §44 | Active detail tab follows push cadence; config/history excluded |
| Legacy facade duplicate id | — | ⚠️ retained | Documented in §13; test-stabilized |
| `mark_login_success(None)` semantics | None = no expiry | changed → config default | Grep-verified no caller relied on old behavior |

---

## 15. Existing Infrastructure Leveraged (Not Re-implemented)

| Component | File | Status |
|-----------|------|--------|
| CentralSessionManager | `services/session/session_manager.py` | Mature, thread-safe, event publishing |
| Instrument store | `services/session/instrument_store.py` | Canonical records + revisions |
| Event history | `services/event_history.py` | Persisted + ring events |
| Session Manager API | `api/session_manager.py` | Extended (7 new endpoints) |
| Engine registry | `services/engine_registry.py` | Single source of engine state |
| WS#2 gateway | `api/ws_gateway.py` | `engine.status` push cadence |
| Frontend page / Sheet UI | `app/_pages/session-manager/page.tsx`, `components/ui/sheet.tsx` | Extended |

---

## 16. Files Changed

### Backend
- `python-service/services/session/session_manager_config.py` (new)
- `python-service/services/session/session_manager.py` (config wiring, `_session_lifetime`)
- `python-service/services/session_manager_engine.py` (`config_summary`, `login` default)
- `python-service/api/session_manager.py` (7 new endpoints)
- `python-service/app.py` (config hydration)

### Tests
- `python-service/tests/test_session_manager_config.py` (new, 7)
- `python-service/tests/test_session_manager_api_surface.py` (new, 7)

### Frontend
- `app/_pages/session-manager/page.tsx` (3 new tabs, drawer, pagination, realtime tick)

### Docs
- `docs/engines/session-manager.md` (§42–44 appended)
- this report

---

**Status:** ✅ COMPLETE — 68 backend tests green, `tsc` + `eslint` clean, config LIVE-applied, UI upgraded with truthful state only.