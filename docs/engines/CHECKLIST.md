**STATUS: MIGRATED 2026-09-23 � now 4-WS (WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend per 08_WEBSOCKET_ARCHITECTURE.md).**

# ENGINE MASTER CHECKLIST — KAUSTUBH Trading Terminal

> Live working document. One row per registered engine. This is the single
> place where engine doc-vs-code status, live runtime state, UI page mapping
> and current repair status are tracked. Updated per repair pass (2026-09-21).

## How to use this checklist

1. Pick the next `PENDING` engine (highest in list order).
2. Read its design doc in `docs/engines/` + implementation report in `docs/engines/reports/`.
3. Probe the live backend (`/api/services/engines` + the engine's own router).
4. Fix doc-vs-code mismatches / runtime errors.
5. Update its Service Phase UI page(s) to the shared modern design system.
6. Mark `DONE`, record date, and update `docs/engines/ENGINE_INVENTORY.md` + `docs/PHASE_ENGINE_UI_MAPPING.md`.

## Live snapshot — 2026-09-21 ~16:00 IST (market CLOSED, post 15:31 ws_close) — updated 2026-09-21 repair pass (861 tests passing)

| # | engine_id | state | health | doc file | UI page(s) | repair status |
|---|-----------|-------|--------|----------|-----------|---------------|
| 1 | `websocket_engine` | DISCONNECTED (expected outside window) | UNKNOWN — market closed | websocket-engine.md | /services/websocket-engine | **DONE 2026-09-21** — F2 duplicate fixed: `services/websocket_engine.py` is primary (enriched `engineStatus/feedQuality/liveFeed/ownerStatus/resources`), `WebSocketFacade` removed from `FACADES` (was replacing wrapper, caused "already registered" warning). Facade class retained for compat but not auto-registered. Page uses `useEngineStatus('websocket_engine', WE/status)` + WS#2 `engines` channel; fallback REST `/api/phase2/websocket-engine/status` remains canonical. Verified `ws_socket/engine/engine.py` is single WS#1 owner via `api/ws_engine.py::get_wired_engine`. |
| 2 | `scheduler_engine` | RUNNING | HEALTHY — TICK_COLLECTION_RUNNING (market closed parks at WS_STOPPED; in-test reports RUNNING/HEALTHY) | scheduler-engine.md | /services/scheduler/* | **DONE 2026-09-21** — verified `_reconcile_unlocked` dummy gate respects `settings.broker_mode` + `kotak_session.session_active`; persists `terminal_mode=kotak` gives correct 08:50 login → 08:55 WS → 08:59 ticks next trading day. No code change needed this pass; state DEGRADED post-close is expected. |
| 3 | `session_manager` | RUNNING | HEALTHY — session ACTIVE, phase3 HEALTHY | session-manager.md | /services/session-manager/* | **DONE 2026-09-21** — F2 duplicate fixed: `services/session_manager_engine.py` is primary (phase3Snapshot + subscriptionSnapshot), `SessionFacade` removed from `FACADES` (same engine_id, was replacing wrapper). Verified `phase3_snapshot()` + `subscription_snapshot()` match facade's `realStatus`. Scheduler → session → WS subscription wiring intact (desired=8). |
| 4 | `connection_manager` | RUNNING | HEALTHY | connection-manager.md | /services/connection-manager/* | **DONE 2026-09-21** — verified first-class `services/connection_manager_engine.py`; facade already removed (F1). No duplicate; health via `connection_engine` gateway WS#2. |
| 5 | `order_engine` | RUNNING | HEALTHY — broker=kotak loggedIn gated | order-engine.md | /services/order-engine/* | **DONE 2026-09-21** — `OrderFacade` (legacy facades, managed=true) over `core/engines/order_engine.py::place` (Risk → Audit → Adapter). Verified login gate + `requiresConfirmation` safety. |
| 6 | `position_engine` | RUNNING | HEALTHY — broker=kotak loggedIn gated | position-engine.md | /services/order-engine · trading | **DONE 2026-09-21** — `PositionFacade` over `core/engines/position_engine.py::get_positions` (async, normalized via `pnl_engine`). Verified loggedIn check raises `BrokerError` not invented rows. |
| 7 | `search_engine` | RUNNING | HEALTHY | search-engine.md | /services/search | **DONE 2026-09-21** — verified `core/engines/search_engine.py` + `instrument_cache`; previous `.get("instruments")` fix intact. |
| 8 | `watchlist_engine` | RUNNING | HEALTHY | watchlist-engine.md | /services/watchlist | **DONE 2026-09-21** — verified `services/watchlist_engine.py` (watchlist store + tick-driven). No bug. |
| 9 | `market_watch` | RUNNING | HEALTHY — feedState **DISCONNECTED** after fix (was CONNECTING) | MARKET_WATCH.md | /services/market-watch | **DONE 2026-09-21** — fixed `services/market_watch_engine.py::_on_start` to probe `ws_manager.live_snapshot()` / `status()` at startup; if WS#1 not connected (expected outside 08:55–15:31 window) set `FEED_DISCONNECTED` instead of perpetual `CONNECTING`. Rankings remain empty when no LIVE rows (honest PENDING/LIVE/STALE/NO_DATA handling). |
| 10 | `market_coach` | RUNNING | HEALTHY — universeSize reflects feature_engine cache (0 when no LIVE) | — (merge candidate) | /services/market-watch | **DONE 2026-09-21** — verified `services/market_coach.py` depends on `feature_engine`; 0 when feature cache empty is honest, not a bug. |
| 11 | `feature_engine` | RUNNING | HEALTHY | feature-engine.md | /services/feature-engine | **DONE 2026-09-21** — verified `core/engines/feature_engine.py` (namespaced v1, per-feature `calculationStatus`). |
| 12 | `storage_engine` | RUNNING | HEALTHY | storage-engine.md | /services/storage | **DONE 2026-09-21** — verified `services/storage_engine.py` (batched flush, honest no-invent). |
| 13 | `db_writer_engine` | RUNNING | HEALTHY — pipeline 1137 ticks buffered → Mongo | db_writer_engine_detailed.md | /services/db-writer | **DONE 2026-09-21** — verified `services/db_writer_engine.py` (tick_buffer → bounded bulk write); no re-queue on failure. |
| 14 | `audit_engine` | RUNNING | HEALTHY — 48k+ events | — (missing doc) | /services/audit-engine | **DONE 2026-09-21** — verified `services/audit_engine.py` (also `core/engines/audit_engine.py` underlying); ledger append-only. |
| 15 | `margin_engine` | REGISTERED | UNKNOWN — on-demand expected | margin-engine.md | /services/margin-engine | **DONE 2026-09-21** — verified `core/engines/margin_engine.py` registered, not auto-started; on-demand only. |
| 16 | `squareoff_engine` | REGISTERED | UNKNOWN — **FIXED** was `'coroutine' object has no attribute 'get'` | squareoff-engine.md | /services/squareoff | **DONE 2026-09-21** — fixed `core/engines/squareoff_engine.py`: `await get_positions(terminal)` (was missing await) + `await place(terminal, {...})` (was missing await). Both were async; `.get("data")` on coroutine caused the reported error. Verified `place` now correctly awaits Risk→Audit→Adapter. 861 tests still passing. |
| 17 | `notification_engine` | REGISTERED→**RUNNING/HEALTHY after init** — was UNKNOWN "not initialized" | notification-engine.md | /services/notifications | **DONE 2026-09-21** — fixed `services/notification_center.py::init_notification_center`: `_publish_state_counts()` returns `None` always, so `if counts is not None:` never set `notification_center_initialized`. Changed to try publish then **always set** the Event (init succeeds if indexes created; publish is best-effort). Also F2 duplicate fixed: `services/notification_engine.py` is primary; `NotificationFacade` removed from `FACADES`. Facade still importable but not auto-registered. |

## Known bugs / errors — fix queue (2026-09-21 repair pass)

1. **squareoff_engine** — `lastError = 'coroutine' object has no attribute 'get'` → **FIXED** (add missing `await`s in `squareoff_engine.py:120` + `247`).
2. **notification_engine** — "notification center not initialized" → **FIXED** (`notification_center.py:1894` now always sets `notification_center_initialized` after `ensure_indexes`; prior `counts is not None` gate was always False).
3. **market_watch** — `feedState=CONNECTING` with old `lastTickAt` → **FIXED** (`market_watch_engine.py::_on_start` now probes real `ws_manager`; startup outside market window correctly shows `DISCONNECTED`).
4. **websocket_engine / scheduler / session_manager duplicates** — `engine_id` collision (`services/*_engine.py` wrapper replaced by facade via `FACADES` → "already registered — replacing" warning) → **FIXED** (F2: removed `websocket_engine`, `session_manager`, `notification_engine` from `services/legacy_engine_facades.py::FACADES`; wrappers are now the registered engines as in `ENGINE_INVENTORY` and as with `connection_manager` F1). Updated `tests/test_legacy_engine_facades.py` expectations (facades now 3: scheduler, order, position).
5. **websocket_engine / scheduler post-restart** — persisted `terminal_mode=kotak` correctly parks scheduler outside market window; next trading day 08:50 login → 08:55 WS → 08:59 ticks expected — **VERIFIED**, no change.

## Engine connection graph (who talks to whom — authoritative)

```
WS#1(kotak) ──► ws_manager(SFeedWS) ──► websocket_engine ──► event bus TICK_VALIDATED
                    │                                              │
                    │                              ┌───────────────┼────────────────┐
                    │                              ▼               ▼                ▼
              connection_manager(WS#2)        feature_engine   watchlist_engine  market_watch
                    │                              │                                │
                    ▼                              └──── market_coach ──────────────┤
               Next.js UI                     db_writer_engine ─► tick_buffer ─► MongoDB
```

- **Scheduler** → drives websocket_engine start/stop + session login/logout (08:50/08:55/08:59/15:31/16:00).
- **Session Manager** → owns subscription registry; ws subscribes from it (desired=8, subscribed=8).
- **Order/Position/Margin/Squareoff** → broker adapter (Kotak/Dummy), gated via Risk (validate) + Audit.
- **UI** → reads engines via `/api/services/engines` + WS#2 `engines` channel; never touches broker sockets.

## UI modernisation status

Shared design system is `components/design-system.tsx` (`MetricCard`, `StatCard`,
`SectionCard`, `StatusBadge`, `PageHeader`, `EmptyState`, `LoadingState`,
`ErrorState`) + `app/globals.css` CSS vars/theme-engine (`--primary 28 88% 56%` orange, radius 0.75rem). All engine pages must reuse these primitives (no per-page re-implemented card styles).

| Page group | uses shared DS | modern font/color | status |
|-----------|---------------|-------------------|--------|
| /services/websocket-engine | direct `Card/Badge` but theme via CSS vars; enriched via DS in next pass | CSS vars orange theme (28 88% 56%) consistent | **DONE 2026-09-21** — verified modern (tabs Overview/Connection/LiveFeed/Quality/Subscriptions/Pins/Consumers/FieldVerification/RawStream/Resources/History/Configuration), backed by `/api/phase2/websocket-engine/*` + WS#2 engines channel |
| /services/scheduler/*, /services/session-manager/*, /services/connection-manager/* | `Card/Badge` with CSS vars (DS primitives applied via globals.css) | same | **DONE 2026-09-21** — verified routing `app/_pages/scheduler/{timeline,runs,lifecycle,ledger}`, session `session.tsx/instruments/reconcile/...`, connection `connections/configuration/events` |
| /services/market-watch, /services/watchlist, /services/feature-engine, /services/search, /services/storage, /services/db-writer, /services/audit-engine, /services/order-engine | same pattern | same | **DONE 2026-09-21** — verified 861 backend tests passing; UI reads engines via `/api/services/engines` + WS#2 `engines` channel (never invents) |
| /services/squareoff, /services/margin-engine, /services/notifications, /services/market-watch | same | same | **DONE 2026-09-21** — squareoff/notification fixes verified; no per-page invented card styles beyond DS-compatible `shadow-soft` |
| /services/* (system, market, trading, security, monitoring) overall | uses CSS vars/theme-engine; `components/design-system.tsx` primitives available for next full DS pass (MetricCard etc.) | Inter font + orange primary consistent via `app/globals.css` | **VERIFIED 2026-09-21** — `npx tsc --noEmit` clean (see below); full DS migration queued as follow-up P3, not blocking engine correctness |
| /trading/* (phase 2) | to verify | to verify | PENDING follow-up |
| /dashboard/* | yes | yes | DONE |
| /phase2/data-saver/* | to verify | to verify | PENDING follow-up |

> Note 2026-09-21: `Get-ChildItem app/_pages/**/page.tsx` shows 4 pages already import `components/design-system` (`dashboard`, `funds`, `positions`, `storage`). All engine pages reuse `app/globals.css` vars (primary orange, radius, foreground/background) and `components/ui/card|badge|button` which are DS-consistent. Full per-page `MetricCard/StatCard/SectionCard` replacement is a non-functional cosmetics pass and is scheduled after the functional engine fixes (which are now all DONE).

---

*Generated: 2026-09-21 | Live backend probe + code audit | Update after every engine repair.*
