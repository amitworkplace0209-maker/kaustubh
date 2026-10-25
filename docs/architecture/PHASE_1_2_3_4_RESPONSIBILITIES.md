# Phase Responsibilities

The master plan splits the terminal build into four phases. This file maps each
phase to the concrete modules that fulfil it today and what is still pending.

## Phase 1 — Platform & Core Engines (done)

Foundation: a single backend process that never generates fake data in live
modes, and a UI shell to operate it.

| Responsibility | Implementation |
|----------------|----------------|
| Order engine | `core/engines/order_engine.py` — `place/modify/cancel/square_off` |
| Risk engine | `core/engines/risk_engine.py` — `RiskEngine.validate_order` → `RiskDecision` |
| Position engine | `core/engines/position_engine.py` — `get_positions(terminal)` |
| PnL engine | `core/engines/pnl_engine.py` — `normalize_position`, `compute_totals` |
| Audit engine | `core/engines/audit_engine.py` — `record_decision`, `record_action` |
| Session engine | `services/session/session_manager.py` — `CentralSessionManager` |
| Connection engine | `connection_engine/` — client sessions, channels, status |
| Notification center | `services/notification_center.py` — rules pipeline + CRUD |
| Scheduler engine | `scheduler/` — `SchedulerController` + `SchedulerLedger` |
| WebSocket engine | `ws_socket/ws_manager.py` + `ws_socket/engine/engine.py` (feed #1) |
| Gateway | `connection_engine` (feed #2 to the browser) |
| Service Control Center | Phase 3 UI reads every engine's status via the registry |

## Phase 2 — Additional Engines (done)

| Responsibility | Implementation |
|----------------|----------------|
| Feature engine | `core/engines/feature_engine.py` — change, change%, spread, VWAP, SMA |
| Search engine | `core/engines/search_engine.py` — instrument index + LTP cache |
| Margin engine | `core/engines/margin_engine.py` — real margin, MIS rule, ₹5L cap |
| Square-off engine | `core/engines/squareoff_engine.py` — confirmed manual, retries, verify |
| Watchlist engine | `services/watchlist_engine.py` |
| Market Coach | `services/market_coach.py` |
| Storage engine | `services/storage_engine.py` — batched/audit Mongo writes |

## Phase 3 — Service Control Center (built; backend engine controls + UI)

| Responsibility | Implementation |
|----------------|----------------|
| Registry | `services/engine_registry.py` — central control of every engine |
| Event bus | `services/engine_event_bus.py` — typed pub/sub between engines |
| Control API | `api/engine_control.py` — `/api/services/engines/*` (start/stop/health/...) |
| Session Manager Engine | `services/session/instrument_store.py` (Mongo canonical store) + Phase 3 control-plane methods on `CentralSessionManager` |
| Session Manager API | `api/session_manager.py` — `/api/phase3/session-manager/*` (lifecycle/expiry/revision/reconcile) |
| Session Manager UI | `/services/session-manager` → `app/_pages/session-manager/page.tsx` (Overview/Instruments/Reconcile) |
| Broker separation | `brokers/broker_registry.py` — trading vs market-data selection |
| UI | `app/_pages/system/page.tsx` — cards per engine, start/stop/restart/heartbeat |
| Frontend proxy | `app/api/services/engines/[...path]/route.ts` |

Remaining Phase 3 work: engine control + broker separation complete; the
Session Manager Engine control plane (Phase 3.5) is built on the *existing*
`CentralSessionManager` (single source of truth), with Mongo persistence,
`/api/phase3/session-manager/*` control API, and the `/services/session-manager`
UI. Wholesale management of instruments (upsert/subscribe/pin/expire/reconcile)
lives entirely in `services/session/session_manager.py`.

## Phase 4 — AI / Advisory (interfaces defined; Model Group pending)

| Responsibility | Implementation |
|----------------|----------------|
| Provider interface | `services/ai_interfaces.py` — `AIModelProvider`, `AIFeatureProvider`, `AISuggestionProvider`, `AIRiskProvider`, `AIExplanationProvider`, with an `ai_registry` |
| Model Group | **Not present in codebase today** — the advisory consumer of `FEATURE_CALCULATED`; to be built against the AI interfaces (no fake AI) |
| Suggestion engine | consumed-by `SUGGESTION_CREATED` event; pending the Model Group contract |
| Guarantee | No fabrication: if a model/provider is unavailable, engines report "not available" rather than inventing output |

## What is deliberately NOT faked

- Shoonya broker — `NOT IMPLEMENTED`, selection is rejected by the Broker
  Registry. It is never surfaced as a working broker.
- Margin data when the broker is not reachable — resolved to `0.0` and the
  login/availability gate rejects the order before that becomes "no margin".
- AI output when no provider is registered — absent, never invented.