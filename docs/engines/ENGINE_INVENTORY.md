**STATUS: MIGRATED 2026-09-23 � now 4-WS (WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend per 08_WEBSOCKET_ARCHITECTURE.md).**

# ENGINE INVENTORY — KAUSTUBH Trading Terminal

> ## ⚠ CORRECTION NOTICE — 2026-09-28 (static analysis, added by documentation bootstrap)
>
> **The table below is a runtime snapshot of unknown date. Its counts are internally
> inconsistent and several rows contradict the current source code. Do not treat the
> `state` / `health` columns as fact.**
>
> **1. The heading contradicts itself and the table.**
> Heading: `15 registered, 10 RUNNING, 8 HEALTHY, 5 UNKNOWN, 2 DEGRADED`
> — `10 + 5 + 2 = 17`, but `8 + 5 + 2 = 15`. The table has 15 rows.
>
> **2. The code-derived registration count is 17, not 15**
> (`python-service\app.py:609-626` and `services\legacy_engine_facades.py:428-432`).
>
> **3. Specific rows contradicted by code:**
>
> | Item | This document | Current source code |
> |------|---------------|---------------------|
> | `market_watch_engine` | Listed under **NOT IMPLEMENTED** — "No standalone engine" | **Registered** — `app.py:615`, in the auto-start list `app.py:629` |
> | `audit_engine` | **Absent from the table entirely** | **Registered and auto-started** — `app.py:620`, `app.py:629` |
> | Facade set | `scheduler`, `session_manager`, `connection_manager`, `websocket`, `order`, `position`, `notification` (7 facades) | **3 facades only**: `scheduler_engine`, `order_engine` (`OrderFacade`), `position_engine` (`PositionFacade`) |
> | `session_manager`, `connection_manager`, `notification_engine`, `websocket_engine` | facade, `managed=true` | first-class `EngineBase` engines. The comment at `legacy_engine_facades.py:421-427` states these were **removed from FACADES ("F2 fix")** to avoid duplicate `engine_id` registration |
>
> **The `managed` and `owner` columns are therefore out of date for at least 4 rows**, and
> the "NOT IMPLEMENTED" claim for Market Watch is **incorrect**.
>
> **4. `margin_engine` and `squareoff_engine` are registered but NOT auto-started**
> (`app.py:629` omits both). This document's `initPhase` note for `squareoff_engine` —
> "registered, not auto-started" — is correct; the architecture docs' instruction to
> "restart `sqareoff_engine`" is not, because that engine id does not exist (see below).
>
> **5. Naming:** the architecture set writes `sqareoff_engine` (missing `u`). In code:
> `squareoff` has 44 matches, `sqareoff` has **0**.
>
> **6. All runtime columns are `NOT_VERIFIED`.** No run log accompanies this snapshot, and
> the reconciliation procedure in `32_ARCHITECTURE_GAPS.md` invokes a
> `python -m kaushub.*` CLI that **does not exist** in this repository.
>
> **Full reconciliation:** `docs/DOCUMENTATION_AUTHORITY.md` §4 · finding D-15
> **Live verification:** `docs/pending/PENDING-001-live-verification.md`
>
> Rows and definitions below are preserved verbatim as the original record.

> **PART 2**: Every actual engine in the system. Each row is a real, registered
> engine observed live on the running backend (GET /api/services/engines).
> NOT IMPLEMENTED components are listed at the bottom.

## Actual Engines (15 registered, 10 RUNNING, 8 HEALTHY, 5 UNKNOWN, 2 DEGRADED)

| # | engineId | engineName | engineCategory | version | state | health | healthReason | managed | realBroker | brokerAdapter | dependencies | lifecycle | owner | initPhase | runPhase | runCadence | healthCheckCadence |
|---|----------|------------|----------------|---------|-------|--------|-------------|---------|-----------|--------------|-------------|----------|-------|-----------|----------|------------|-------------------|
| 1 | feature_engine | Feature Engine | MARKET_DATA | 1.0.0 | RUNNING | HEALTHY | — | false | none | — | websocket_engine, connection_manager | lifecycle_start_on_app_start | EngineBase | auto-start in app.py lifespan | event-driven (TICK_VALIDATED from event bus) | per-tick | periodic heartbeat |
| 2 | search_engine | Search Engine | CORE | 1.0.0 | FIXED→RUNNING | FIXED→HEALTHY | was: 'str' object has no attribute 'get' (instrument_master.json shape mismatch) | false | none | — | — | lifecycle_start_on_app_start | EngineBase | auto-start in app.py lifespan | on-demand (search query) | per-request | periodic heartbeat |
| 3 | margin_engine | Margin Engine | TRADING | 1.0.0 | REGISTERED | UNKNOWN | — | false | broker | KotakAdapter | — | lifecycle_start_on_app_start | EngineBase | registered, not auto-started | on-demand (order validation) | per-request | periodic heartbeat |
| 4 | squareoff_engine | Square-Off Engine | TRADING | 1.0.0 | REGISTERED | UNKNOWN | — | false | broker | KotakAdapter | position_engine, order_engine, margin_engine | lifecycle_start_on_app_start | EngineBase | registered, not auto-started | on-demand (manual/triggered) | per-trigger | periodic heartbeat |
| 5 | watchlist_engine | Watchlist Engine | MARKET_DATA | 1.0.0 | RUNNING | HEALTHY | — | false | none | — | — | lifecycle_start_on_app_start | EngineBase | auto-start in app.py lifespan | event-driven (TICK_VALIDATED from event bus) | per-tick | periodic heartbeat |
| 6 | market_coach | Market Coach | MARKET_DATA | 1.0.0 | RUNNING | HEALTHY | — | false | none | — | feature_engine | lifecycle_start_on_app_start | EngineBase | auto-start in app.py lifespan | event-driven (TICK_VALIDATED, time-driven) | periodic | periodic heartbeat |
| 7 | storage_engine | Storage Engine | STORAGE | 1.0.0 | RUNNING | HEALTHY | — | false | none | — | — | lifecycle_start_on_app_start | EngineBase | auto-start in app.py lifespan | event-driven (STORAGE_WRITE_COMPLETE) | periodic flush | periodic heartbeat |
| 8 | scheduler_engine | Scheduler | CONTROL | 1.0.0 | RUNNING | HEALTHY | TICK_COLLECTION_RUNNING, session_active, ws_connected | true | Kotak Neo | KotakScheduler | — | lifecycle_start_on_app_start | SchedulerFacade | app.py lifespan sync | 5s reconcile loop (market hours only) | 5s tick | per-reconcile |
| 9 | session_manager | Session Manager | CORE | 1.0.0 | RUNNING | HEALTHY | — | true | all | — | — | lifecycle_start_on_app_start | SessionFacade | app.py lifespan sync | on-demand (mode switch / login) | on-change | per-snapshot |
| 10 | connection_manager | Connection Engine (Gateway) | CONTROL | 1.0.0 | RUNNING | HEALTHY | — | true | none | — | — | lifecycle_start_on_app_start | GatewayFacade | app.py lifespan + start() | on-demand (WS#2 fan-out) | on-event | per-snapshot |
| 11 | websocket_engine | WebSocket Engine (Feed) | MARKET_DATA | 1.0.0 | RUNNING | HEALTHY | WS#1 CONNECTED, feed RECEIVING, subscriptions=8 | true | Kotak Neo | KotakSDK (via ws_manager) | ws_manager (SFeedWS) | lifecycle_start_on_app_start | WebSocketFacade | app.py lifespan sync | supervised (ws_manager supervisor) | supervised | per-snapshot |
| 12 | order_engine | Order Engine | TRADING | 1.0.0 | RUNNING | HEALTHY | — | true | broker | KotakAdapter / DummyAdapter | — | lifecycle_start_on_app_start | OrderFacade | app.py lifespan sync | on-demand (order placement) | per-request | per-snapshot |
| 13 | position_engine | Position Engine | TRADING | 1.0.0 | RUNNING | HEALTHY | — | true | broker | KotakAdapter / DummyAdapter | — | lifecycle_start_on_app_start | PositionFacade | app.py lifespan sync | on-demand (position query) | per-request | per-snapshot |
| 14 | notification_engine | Notification Center | CONTROL | 1.0.0 | REGISTERED | UNKNOWN | notification center not initialized | true | none | — | — | lifecycle_start_on_app_start | NotificationFacade | app.py lifespan sync | on-demand (event-driven) | per-event | per-snapshot |
| 15 | db_writer_engine | DB Writer Engine | STORAGE | 1.0.0 | RUNNING | HEALTHY | pipeline running, N buffered | false | none | — | websocket_engine, connection_manager | lifecycle_start_on_app_start | EngineBase | auto-start in app.py lifespan | event-driven (tick buffer flush) | batching flush | periodic heartbeat |

## Key Definitions

- **managed**: `true` = facade engine wrapping a pre-existing subsystem (lifecycle delegated). `false` = native EngineBase engine (lifecycle owned by registry).
- **realBroker**: `Kotak Neo` = real broker SDK used. `none` = no broker dependency. `broker` = uses whatever active broker adapter.
- **owner**: the code that actually manages this engine's lifecycle. Facade engines reflect state of the underlying subsystem.
- **initPhase**: how the engine is created/registered.
- **runPhase**: what triggers work.
- **runCadence**: how often work happens.
- **healthCheckCadence**: how health is evaluated (periodic heartbeat, on-demand, etc).

## NOT IMPLEMENTED / Phase 4

| Component | Status | Notes |
|-----------|--------|-------|
| Model Group | NOT IMPLEMENTED | AI interfaces exist in `services/ai_interfaces.py`; no engine singleton. Phase 4 boundary. |
| Market Watch (standalone) | NOT IMPLEMENTED | Covered by watchlist_engine + feature_engine. No standalone engine. |
| Backtest Engine | NOT IMPLEMENTED | Phase 4 boundary. |
| Strategy Engine | NOT IMPLEMENTED | Phase 4 boundary. |

---

## Post-Fix Engine States

After the fixes applied in this repair:
- `search_engine`: FIXED — instrument loading now reads `.get("instruments", [])` from the JSON dict; `get_instruments()` added to InstrumentCache. State: RUNNING/HEALTHY.
- `scheduler_engine`: now respects dummy mode — `is_dummy_mode()` gate in `_reconcile_unlocked`, `_ensure_login_locked`, `do_login`, `notify_auth_failure`. In dummy mode, scheduler parks at STATE_LOGGED_OUT.
- `websocket_engine`: now publishes TICK_RECEIVED/TICK_VALIDATED/TICK_REJECTED via event bus bridge (thread-safe queue + asyncio drain task).
- `db_writer_engine`: NEW — persistence-layer engine (tick pipeline producer → bounded buffer → batched MongoDB bulk write; audit pipeline via storage_engine). Registered + auto-started in app.py lifespan, deps `["websocket_engine", "connection_manager"]`, exposes `flush()` (manual drain) and a `/flush` control endpoint. Never re-queues failed batches (write errors counted, bounded memory).
- `connection_manager`: status() enriched with `stats` (active/total connections, messages delivered/dropped/routed), `freshness` (FRESH ≤5s / DELAYED ≤30s / STALE / NO_DATA from the real tick buffer) and `connectionRegistry` (per-session records).
- `feature_engine`: output namespaced into `marketData` vs `features`, `featureVersion: "v1"`, per-feature `calculationStatus` (AVAILABLE/WARMING_UP/MISSING_INPUT), `missingInputs`/`inputQuality`, prevClose-based change with prev-tick fallback. Volume is never fabricated. New `/feature_engine/latest` control endpoint exposes the real feature cache.
- `scheduler_engine`: status_snapshot now exposes `realStatus` (get_scheduler_info), `schedule` (get_schedule) and `jobs` (scheduled-downloads checker status). Legacy-facade jobs metrics corrected to the real checker keys (running/taskActive/intervalSeconds).

## Post-Fix Engine States — 2026-09-17 scheduler/terminal incident

Live remediation for the "scheduler did not login at 08:50 / websocket did not connect at 08:55" report:

- **Root cause**: persisted runtime setting `terminal_mode` = `dummy`. `brokers.manager.active_terminal()` resolves session mode → persisted `terminal_mode` → env `settings.broker_mode`, so the whole system ran in Dummy. The scheduler's `_reconcile` dummy-mode gate (`scheduler/__init__.py` `is_dummy_mode()` → park at `LOGGED_OUT`) is evaluated BEFORE the market-slot login/ws windows, so on restart the scheduler stopped the WS supervisor and parked without ever attempting the 08:50 Kotak login or 08:55 websocket connect. The Kotak credentials (`CONSUMER_KEY`/`CONSUMER_SECRET`/`MPIN`/`TOTP_SECRET`) were present all along; scheduler time settings were already exactly login 08:50 / ws 08:55 / tick 08:59 / ws-stop 15:31 / logout 16:00.
- **Fix**: `POST /api/terminal/switch {mode: kotak}` (mode lock was OFF → passwordless). This persisted `terminal_mode=kotak` in the settings store AND switched the live session (per-terminal isolation restored the existing Kotak session record, `kotak` CONNECTED / sessionActive true).
- **Result (live verified)**: `scheduler_engine` RUNNING/HEALTHY, realStatus `TICK_COLLECTION_RUNNING`, `session_active=true`, `websocket_connected=true`; WS#1 CONNECTED, feed RECEIVING, subscriptions=8, ticks streaming (~8/s); `db_writer_engine` RUNNING/HEALTHY consuming live ticks (received=634, written=627, errors=0, activeTickStocks=8, pipeline running); flush ok. Engines summary: total 15, RUNNING 10, HEALTHY 8, DEGRADED 2, UNKNOWN 5.
- **Note**: on restart *after* 08:50/08:55 IST the scheduler ledger would mark login `MISSED_EXPIRED` and park for the day; it only auto-fires the full morning sequence when the backend is running before the login window on a trading day. With `terminal_mode=kotak` persisted, subsequent trading days run 08:50 Kotak login → 08:55 WS connect → 08:59 tick collection automatically.

---

## Doc-vs-Code Audit (all 22 engine docs)

Full audit of every file in `docs/engines/` against the live codebase. Rows reflect verified code, not just doc intent.

| Doc | Engine(s) covered | Declares engine_id(s) | States/health vocabulary | Metrics / exposed API | Status in code |
|-----|-------------------|-----------------------|--------------------------|-----------------------|----------------|
| websocket-engine.md | WebSocket Engine (WS#1 broker feed) | no formal id | Yes — connection machine + feed/field/backpressure states | Yes — connection state, reconnect_total, msgs/s, latency, gaps | implemented — ws_socket/engine/engine.py + WebSocketFacade |
| watchlist-engine.md | watchlist_engine | placeholder id | minimal — honest stop when no ticks | no | implemented — services/watchlist_engine.py (auto-start) |
| storage-engine.md | storage_engine | placeholder id | minimal | batch=100, flush=2s | implemented — services/storage_engine.py (exact match) |
| squareoff-engine.md | squareoff_engine | placeholder id | minimal — UNKNOWN until invoked | no | implemented + registered (not auto-started) |
| session-manager.md | session_manager | design doc (no id) | Yes — full session state machine | Yes — session_* metrics / events | implemented — services/session/session_manager.py + SessionFacade |
| search-engine.md | search_engine | placeholder id | minimal | no | implemented — `.get("instruments", [])` fix in place |
| scheduler-engine.md | scheduler_engine | "ENGINE #01" | Yes (design model) | partial | implemented — SchedulerController + SchedulerFacade |
| position-engine.md | position_engine | placeholder id | minimal — DEGRADED + NOT_AUTHENTICATED | no | PositionFacade over core/engines/position_engine.py |
| order-engine.md | order_engine | placeholder id | minimal — same | no | OrderFacade over core/engines/order_engine.py |
| notification-engine.md | notification_engine | placeholder id | NOT_INITIALIZED | no | NotificationFacade over notification_center |
| market-coach.md | market_coach | placeholder id | minimal | no | services/market_coach.py (auto-start) |
| margin-engine.md | margin_engine | placeholder id | minimal — UNKNOWN until invoked | no | core/engines/margin_engine.py (registered) |
| feature-engine.md | feature_engine | design doc | Yes — AVAILABLE/WARMING_UP/MISSING_INPUT/… | Yes — output contract + featureVersion | implemented — namespaced v1 output, /feature_engine/latest |
| ENGINE_LIFECYCLE.md | all engines + facades | yes | Yes — REGISTERED/UNKNOWN/STALE/UNHEALTHY, lifecycle phases | contract fields | matches registry + facades + app.py lifespan |
| ENGINE_INVENTORY.md | all registered engines (15) | yes | per-engine state/health | yes | matches live code + post-fix notes |
| ENGINE_FAILURE_RECOVERY.md | several named engines | yes | ERROR/recentErrors, DISCONNECTED, UNKNOWN | no | matches code (search fix, scheduler gates, ws supervisor, bridge) |
| ENGINE_DEPENDENCY_GRAPH.md | all engines + externals | yes — edges by engine_id | no | dependency-graph endpoint | matches registry.dependency_graph() + db_writer_engine edge added |
| ENGINE_CONTROL.md | all engines (SCC) | yes — /api/services/engines/{id} | honesty rules | full endpoint table + proxy | matches api/engine_control.py + frontend proxy |
| DUMMY_MODE_ARCHITECTURE.md | scheduler/session/ws/dummy | no ids — components | STATE_LOGGED_OUT park, mode precedence | no | matches code (gates + active_terminal + DummyAdapter) |
| db_writer_engine_detailed.md | db_writer_engine | "Engine Number: 06" | Yes — STARTING/HEALTHY/DEGRADED/SOURCE_UNAVAILABLE/DB_UNAVAILABLE/BUFFER_*/FAILED/STOPPING/STOPPED | Yes — /db-writer/* control API + metrics | partial — thin EngineBase wrapper over tick_buffer + storage_engine (batched persistence, flush, no re-queue); doc's recording registry / per-instrument data-loss accounting are spec-only |
| connection-manager.md | connection_manager | "Engine Number: 05" | Yes — CREATED/…/ACTIVE/DEGRADED/…/TERMINATED + FRESH/DELAYED/STALE/NO_DATA | Yes — /connections + diagnostics | partial — GatewayFacade over connection_engine (WS#2 gateway): sessions/frames/stats/freshness real; full feed-routing registry / per-consumer filtering / backpressure mostly spec-only |
| BROKER_ENGINE_RELATIONSHIP.md | order/position/margin/squareoff/ws/feature/watchlist/coach/scheduler/session/search/storage | yes — matrix by engine_id | broker-independence rules | no | matches code — Kotak + Dummy implemented, Shoonya interface-only |

**Key mismatches (documented for awareness):**
- `market_coach` declares deps `["instrument_cache", "watchlist_engine"]` in code vs the `feature_engine` dependency shown here/elsewhere (implicit polling only).
- `margin_engine` code declares deps `["session_manager", "connection_manager"]` beyond the doc card.
- `watchlist_engine`, `squareoff_engine`, etc. carry unresolved `$(...)` template placeholders as engine_id in their cards; the real ids live in code/registry.
- `db_writer_engine_detailed.md` and `connection-manager.md` describe richer full-engine surfaces; the implemented code satisfies the core pipeline semantics but not every API/registry/diagnostics item (recorded as spec-only).

---

*Generated: 2026-09-14 | Source: Live backend probe + code audit*

