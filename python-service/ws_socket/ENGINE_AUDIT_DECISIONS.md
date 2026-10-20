# WebSocket Engine — Audit & Implementation Decisions (Phase 3)

**Engine ID:** `websocket_engine`
**Date:** 2026-09-20
**Status:** Authoritative decision record for the 38-section doc-driven implementation task.
**Authority order applied:** `docs/engines/websocket-engine.md` → `docs/MASTER_ENGINE_LIFECYCLE_CONNECTION_FLOW.md` → current source runtime → existing WS tests/contracts. The UI is treated as an implementation surface to verify, never as authority.

---

## 1. Architecture verdict (KEEP)

The central-broker single-owner architecture already matches the doc's core requirement and must be preserved exactly:

`WebSocketFacade → WebSocketEngine → ws_manager/SFeedWebSocket → Broker WS#1`

| Item | Owner | Location |
|---|---|---|
| Broker WS#1 socket | `ws_manager.py` module singleton | `python-service/ws_socket/ws_manager.py` (2077 lines) |
| Supervisor state machine + reconnect backoff | `BrokerWebSocketSupervisor` inside `ws_manager` | `_supervisor_*`, `_get_reconnect_delay`, `_schedule_supervisor` |
| Real subscribe/unsubscribe over WS#1 | `ws_manager.subscribe()` (message 1109 acks) | `ws_manager.py` |
| Engine facade (never opens a socket) | `WebSocketEngine` | `python-service/ws_socket/engine/engine.py` (879 lines) |
| Registry / routes / pins / profiles / quality / resources | `WebSocketEngine` | `ws_socket/engine/{registry,router,pins,profiles,quality,resources}.py` |
| Wire-up (publish hook + owner ref) | `api/ws_engine.py::_get_engine()` | on first use, no duplicate socket/registry |
| EngineBase wrapper (registry citizen) | `WebSocketEngineWrapper` | `python-service/services/websocket_engine.py` (195 lines) |
| Legacy facade (compat) | `WebSocketFacade` | `services/legacy_engine_facades.py:262` |
| Frontend → backend | `app/api/phase2/websocket-engine/[...path]/route.ts` → `/api/services/websocket` | Next.js proxy |

**Confirmed everywhere in code:** no UI/library/feature/watchlist/market-watch component opens a broker socket; `set_publish_hook` is the only path from WS#1 into the engine; only the engine emits `TICK_*` events.

## 2. Backend data integrity verdict (KEEP — no fake data found)

All backend surfaces return real state: `ws_manager.status()` (1906+), `_connection_history` (deque maxlen 200, records real connect/disconnect), reconnect counters, persisted `websocket_history_service` events, `quality.summary()`, `metrics()`, `resources_view()`, `raw_stream` against the real `_raw_bucket`, `live_feed` incremental counters, `field_verification` against `fields.py`.

**Decision:** No data fabrication anywhere. The UI must render `\u2014`/`NO_FEED`/`DISCONNECTED`/`UNKNOWN` for absent values.

## 3. UI decision: rebuild as Service Phase tabs (MODIFY — KEEP harmlessness, REPLACE presentation + fix bugs)

Current page `app/_pages/websocket-engine/page.tsx` (642 lines) is stacked cards. Rebuild to match the Service Phase pattern (mirrors `session-manager/page.tsx`) with tabs, and **must**:
- Read live Overview via `useEngineStatus('websocket_engine', `${WE}/status`)` over WS#2 (`engines` channel) — no local polling.
- Use `onFrame` (`frame.type === 'engine.status'`) → `liveTick` → refresh active detail tab (same contract as session-manager page: `lib/engine-realtime.ts`, `components/frontend-realtime-provider.tsx`).
- Render every value straight from backend payloads; never hard-code state.

## 4. Bugs to fix (MODIFY)

| # | Bug | Fix |
|---|---|---|
| 1 | Remove-pin used `POST /pins/{key}` → 405 (backend only has `DELETE /pins/{id}`) | Use `DELETE /api/…/pins/{id}` |
| 2 | Connect/Reconnect/Disconnect had no loading/success/failure/current-state feedback | Add per-button pending + result state, refresh status after, show last result |
| 3 | Consumer enabled toggle had no feedback and ignored result | Show pending + error/success via flash |
| 4 | Live-feed wasn't live (refresh discarded; not refreshed on frames) | Refresh live-feed on `engine.status` frames + include in Refresh-all |
| 5 | Refresh button omitted live-feed | Include live-feed refresh |

## 5. Hard-coded labels/values to remove (MODIFY)

| Current | Decision |
|---|---|
| `tierBadge` L4/L8/L16 labels | Keep the *badge*, but render levels from real `feed_levels` present in `owner_status` (show only levels the backend reports) |
| Card title "344-field verification" | Derive from `field-verification.total` (real count) |
| `fvRows.slice(0, 120)` cap | Keep cap but label it from real data (`rows.length`) |
| `window_sec=10`, `limit=10` | UI defaults (query params the backend bounds) — acceptable as requested values, keep |
| `subSeg='nse_cm'` default input | Trim to placeholder; let user type real segment |
| `consumer: 'subscribed'` on subscribe | Drop hard-code; backend `POST /subscriptions` already defaults to `'subscribed'` |
| schema v… / SDK … | Already dynamic from `status.schema_version` / `sdk_version` (engine reads `canonical.SDK_VERSION` + `SCHEMA_VERSION`) — keep, do NOT hard-code |

## 6. Backend ADD (low-risk additive data surfaces)

To support the rebuilt UI to spec (History, Configuration, Connection, Quality sections):

- **ADD** `GET /api/services/websocket/history` — delegates to `services.websocket_history_service.get_history` (persisted, real; paginated + filters). The legacy router `api/websocket.py` already exposes `/history`, `/events`, `/daily`, `/metrics`, `/telemetry`, `/export` — the new control-plane endpoints reuse `websocket_history_service` (no duplication of logic).
- **ADD** `GET /api/services/websocket/events` — delegates to `get_events_filtered` (persisted reconnect/ws events).
- **ADD** `GET /api/services/websocket/config` — read-only surface of WS-owned settings: live knobs `ws_reconnect_delay_ms`, `ws_backoff`, `ws_auto_reconnect`, `ws_max_reconnect_attempts` (read via `rt_int`/`rt_bool`), canonical schema/SDK versions, feed-level config. No writes.
- **ADD** reconnect entries into `_connection_history` so the History tab shows reconnect activity: record `reconnecting`/`reconnected`/`reconnect_exhausted` events into the in-memory `_connection_history` deque (currently only `connect`/`disconnect` are recorded). Pure additive; persisted events already exist via `_emit_ws_event`.

## 7. Backend KEEP (verified correct, do not touch)

- `ws_manager.status()` contract (frontend stat cards read `owner_status`).
- `engine.status()/metrics()/quality_snapshot()/resources_view()/live_feed()/raw_stream()`.
- `api/ws_engine.py` routing + `{ok, data|error}` envelope + `sanitize_for_json`.
- Scheduler window (08:50 login, 08:55 connect, 08:59 ticks, 15:31 stop) and session-manager subscription/pin reconciliation.

## 8. Backend REMOVE/DEPRECATE

- **REMOVE:** the old `POST /pins/{key}` path — the frontend is the only caller and will switch to the existing `DELETE /pins/{id}`. No backend change needed (route already correct).
- **DEPRECATE (do not delete):** legacy `api/websocket.py` diagnostics router stays for compatibility/monitor page; control plane uses `api/ws_engine.py`.

## 9. Manual verify checklist (Phase 7)

- All WS test suites: `test_ws_engine.py`, `test_websocket_engine.py`, `test_ws_availability.py`, `test_ws_engine_quality.py`, `test_ws_supervisor_sdk.py`, `test_scheduler_ws_prep.py`, `test_engine_control_api.py`, `test_master_canonical.py`.
- `npx tsc --noEmit` + `npx eslint app/_pages/websocket-engine/page.tsx`.
- New backend tests for `/history`, `/events`, `/config`, reconnect-history recording.

## 10. Docs/report to produce (Phase 7)

- Append implementation sections to `docs/engines/websocket-engine.md`.
- Write `python-service/ws_socket/ENGINE_IMPLEMENTATION_REPORT.md` with the required 29 sections, reflection of the master lifecycle flow, and the FEATURE/BACKEND/API/DATA SOURCE/PERSISTENCE/EVENT/UI/TEST/STATUS matrix.