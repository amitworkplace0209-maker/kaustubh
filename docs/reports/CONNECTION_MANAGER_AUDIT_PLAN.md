# CONNECTION MANAGER ENGINE — AUDIT & IMPLEMENTATION PLAN

> **Engine:** Connection Manager (`connection_manager`, CONTROL, v1.0.0) = the backend → frontend
> realtime gateway (WebSocket #2) + its Service Control facade.
> **Audit basis:** source = runtime truth (`python-service/connection_engine/`,
> `api/ws_gateway.py`, `api/ws_engine.py`, `services/connection_manager_engine.py`,
> `services/legacy_engine_facades.py`, `services/engine_registry.py`, `app.py`);
> docs = intent (`docs/engines/connection-manager.md`). UI = presentation layer only.
> **Status:** READ-EVERYTHING-FIRST phase complete; baseline tests present and verified
> to be running (must keep passing: `test_connection_engine.py`,
> `test_connection_manager_engine.py`, `test_realtime_gateway.py`,
> `test_connection_field_requirements.py`, `test_db_writer_engine.py`).

---

## 1. Runtime truth (verified in source)

### The one backend → frontend realtime layer — `connection_engine/` (WS #2)
- `connection_engine.py` — `ConnectionEngine` singleton (945 lines): session
  lifecycle (`create_session/attach/detach/get/sessions`), broker-neutral subscribe
  (market channels via WS-engine consumer registration + `reconcile_broker_subscriptions`;
  state channels via set), unsubscribe, snapshot from `tick_buffer`, envelope builder
  (`_frame`: `type/event_id/timestamp/sequence/channel/symbol/instrument_token/
  exchange_segment/schema_version/data`), field-requirement projection
  (`field_requirements.project_fields`), per-session fan-out loop (drain consumer queues →
  `_coalesce` latest-wins + per-channel rate-limit → outbox), event-driven `data_ready`
  wake-up, state bridge (`state_store` + `event_bus` queues → `_broadcast_frame` →
  per-channel route + wire-type map), persistence path (drains `data_saver` consumer →
  `db_writer_engine.ingest(to_storage_doc)`), engine-snapshot loop (`engines` channel,
  2 s, only when subscribers), diagnostics (`session_records`, `status()`, `_feed_freshness`).
- `client.py` — `Outbox` (bounded `deque`, `OUTBOX_MAXLEN=1000`; market-eviction +
  critical-frame protection; `dropped_market/dropped_critical`) and `ClientSession`
  (connection_id, username, channels, state_channels, per-session task registry, outbox,
  per-(channel,token) rate bookkeeping, `ticks_sent/frames_sent`, `close()`,
  `stats_dict()`). Heartbeat cadence 12 s.
- `channels.py` — `MARKET_CHANNELS` (watchlist, market_watch, trading, ai → profile +
  priority + min_interval_s 1.0/1.0/0.5/0.4) and `STATE_CHANNELS` (positions, orders,
  notifications, system, data, engines).
- `field_requirements.py` — AVAILABLE / UNAVAILABLE / PARTIAL / NOT_READY / SOURCE_ERROR;
  `resolve_requirements` + `project_fields`; alias map; feature/ws field catalogues.
- `__init__.py` — exports `connection_engine` singleton.

### Gateway (WS #2 transport) — `api/ws_gateway.py` (321 lines)
- `GET /api/realtime/token` — issue gateway JWT (secure iff `APP_PASSWORD` set).
- `GET /api/realtime/status` → `connection_engine.status()`; `GET /api/realtime/sessions`.
- `GET /api/realtime/fields` — control-plane field catalogue / resolver (§10/§14).
- `WS /ws/realtime` — one authenticated WS per operator; welcome envelope; writer/reader
  tasks; heartbeat ping; inbound `ping|auth|subscribe|unsubscribe|snapshot` control frames.

### WS #1 (broker feed) — `api/ws_engine.py` + `ws_socket/` engine
- The feed engine exposing `/api/services/websocket/*` (status/health/consumers/routes/
  subscriptions/quality/resources/…). Connection Manager registers per-channel router
  consumers on the WS engine and never owns the broker socket (ownership respected: §5/§47).

### Engine-Registry / Control-plane facade
- `services/connection_manager_engine.py` — `ConnectionManagerEngine` (`engine_id=
  "connection_manager"`, CONTROL): deps `session_manager/feature_engine/websocket_engine/
  scheduler`; health check (MongoDB + status freshness/dropped); `reconcile`,
  `get_field_requirements`, `get_available_fields`; `status_snapshot()` adds `realStatus`
  and `connectionEngine` blocks.
- **F1 (critical):** `services/legacy_engine_facades.py` still defines `GatewayFacade`
  with the **same** `engine_id="connection_manager"` and exports it in `FACADES`
  (line 479). `app.py` registers `connection_manager_engine` (line 519) then splats
  `*FACADES` (line 521); `engine_registry.register()` **replaces** on duplicate with a
  warning ("already registered — replacing"). So the registered engine under
  `connection_manager` is the legacy **GatewayFacade**, shadowing the real facade.
  `GatewayFacade` adds nothing the real facade does not provide.
- `app.py` also directly `connection_engine.start()` at boot (line 549) and
  `shutdown()` at teardown (line 675).
- `api/engine_control.py` — `/api/services/engines/{id}` status/health/metrics/errors/
  activity/start/stop/restart (+ broker endpoints). Frontend `useEngineStatus` reads
  `{engine_id}` snapshot + `realStatus`.

### Tests (current baseline, all in `python-service/tests/`)
- `test_connection_engine.py` — 16 tests: outbox FIFO / market-eviction / critical
  protection; state-channel routing + wire-type map; engine snapshot keyed + broadcast-to-
  subscribers; instrument normalization; subscribe/unsubscribe flow; field-requirement
  subscription + market-frame filtering; persistence drain (data_saver → db_writer).
- `test_realtime_gateway.py` — 10 tests: token auth (secure/insecure), WS auth reject +
  welcome flows, session attach/detach.
- `test_connection_manager_engine.py` — 11 tests: identity, start deps, health mapping,
  reconcile, field requirements, snapshot.
- `test_connection_field_requirements.py`, `test_db_writer_engine.py`
  (ConnectionEngineStatusTest: status shape + freshness mapping).

### Frontend (current state)
- `app/_pages/connection-manager/page.tsx` — ONE modern real-data status page (Header,
  Gateway/Routing/Freshness/Channels cards, live connection-registry table) fed by
  `useEngineStatus('connection_manager', '/api/services/engines/connection_manager')`.
- `app/(services)/services/connection-manager/page.tsx` — dynamic wrapper (Scheduler-like).
- `components/layout/nav.ts` SERVICES_SHELL — flat `connection-manager` item (no children).
- Realtime infra (reusable): `lib/realtime-ws.ts` (WS#2 client), `components/
  frontend-realtime-provider.tsx`, `lib/engine-realtime.ts` (`useEngineStatus`,
  `useEngines`, `useOneShot`), `lib/api.ts` (`API_BASE`, helper pattern from Scheduler work).
- Reusable sidebar submenu: `NavSubmenu` in `components/layout/phase-sidebar.tsx` +
  `lib/nav-utils.ts` (route-authoritative, hover-aware, no localStorage).

---

## 2. Audit findings (doc vs code)

| # | Finding | Severity | Decision |
|---|---|---|---|
| F1 | Duplicate `engine_id="connection_manager"`: legacy `GatewayFacade` (in `FACADES`) **replaces** `ConnectionManagerEngine` in the engine registry at boot — the registry/web UI sees the shadow, not the real facade. | Critical | Remove `connection_gateway` from `FACADES` and delete the dead `GatewayFacade`; `ConnectionManagerEngine` stays the single facade (it already surfaces `realStatus` + health). Keep the underlying `connection_engine` start/shutdown wiring unchanged. |
| F2 | Spec §23 lifecycle states (CREATED…TERMINATED, 17 states) vs implemented one boolean-ish `status: ACTIVE\|DISCONNECTED` in `session_records` — no state machine, no transition reason, no CREATED/CONNECTING/DEGRADED/STALE/DISCONNECTING/TERMINATED/ERROR. | Medium | Implement real derived lifecycle states on `ClientSession` (CONNECTING on attach → ACTIVE; DEGRADED when drops/errors occur; STALE when idle beyond threshold; DISCONNECTING → TERMINATED on close; ERROR on writer/fan-out failure). Expose `lifecycleState`, `lastTransitionAt`, `lastReason` per session + a `lifecycle` block in `status()`. |
| F3 | Spec §27/§51 unified health + dashboard metrics vs implemented: no Connection Manager `health()` (HEALTHY/DEGRADED/NO_DATA/OVERLOADED/ERROR/STOPPED); health lives only in the EngineBase facade + separate feed freshness. | Medium | Add `ConnectionEngine.health()` computing the vocabulary from real signals (started, feed freshness, active sessions, drops, queue depth, error counters, tick stats); surface in `status()` + facade health + a REST endpoint. |
| F4 | Spec §63/§64 delivery envelope lacks `source`, `version`, `correlation_id` (implemented: `type/event_id/timestamp/sequence/channel/symbol/instrument_token/exchange_segment/schema_version/data`). | Medium | Add `version` (+schema `schema_version` already present), `source` (producer: ws_engine/feature_engine/state_bridge/engine_snapshot/gateway), `correlation_id` (inbound `request_id` where present, else generated). Additive — no break to existing frames/tests. |
| F5 | No event inspector/history for delivered gateway envelopes (only WS#1 `ws_history` + engine `recentErrors`). Spec §50/§51 diagnostics + health dashboards want last events, errors, queue, delivery. | Medium | Add a bounded in-memory event inspector on `ConnectionEngine` (ring ~500): envelope deliveries, lifecycle transitions, drops, persistence, errors, subscriptions. Expose via REST + UI (real events only). |
| F6 | Spec §26 backpressure policies vs implemented single implicit DROP_OLDEST market-eviction in `Outbox`. | Low | Keep DROP_OLDEST runtime behaviour; expose a `backpressure` block (policy, queue limit, current depth, drops) and read the queue limit from `runtime_settings` (`cm_outbox_maxlen`, default 1000). No new drop policy that could silently harm trading streams. |
| F7 | `session_records()` lacks spec fields: `lastError`, `lastDeliveredAt`, `deliveryMethod`, `source`, `lifecycleState`; no per-channel routed/delivered counters. | Low | Enrich registry records (all real counters) + add per-channel delivery metrics to `status()`. |
| F8 | Dedicated CM control plane is minimal (token/status/sessions/fields). Spec §14 lists connections/{id}, health, events, config, sources, instruments. | Medium | Add real read-only endpoints backed by the live registry + inspector: `/api/realtime/health`, `/api/realtime/events`, `/api/realtime/connections/{connection_id}`, `/api/realtime/config`. Connections CRUD / pause / resume would require a durable connection-config layer that does not exist — mark spec-only (NOT_IMPLEMENTED) in docs; live gateway sessions remain in-memory runtime truth (§41). |
| F9 | Frontend = one flat status page; nav has no Connection Manager children. Task requires modern Service Phase UI with section pages backed by real backend. | High | Rebuild: shared data layer; 12-section main page; child pages (Overview, Connections, Channels, Routing, Delivery, Freshness, Backpressure, Events, Diagnostics, History, Configuration) each fed by real endpoints; nav children via the existing `NavSubmenu`. |
| F10 | Docs gap: `connection-manager.md` (spec) describes a broader generic feed-routing concept than the implemented WS#2 gateway; no implementation report, no evidence, no feature matrix; status doc/changelog not reconciled. | Medium | Add an implementation-mapping note to `connection-manager.md`; write `python-service/connection_engine/ENGINE_IMPLEMENTATION_REPORT.md` (28 sections, evidence-backed §41); update `ENGINE_IMPLEMENTATION_STATUS.md` changelog; never claim complete features without evidence. |

---

## 3. Implementation plan (one deliverable at a time)

1. **Audit & plan** (this file) — evidence-backed matrix.
2. **Backend F1** — drop `connection_gateway`/`GatewayFacade` from the registry path;
   confirm `/api/services/engines/connection_manager` then resolves to
   `ConnectionManagerEngine` (+ extend its `status_snapshot`/health to read
   `connection_engine.status()` + `.health()`).
3. **Backend F2/F3** — lifecycle states on `ClientSession` + `ConnectionEngine.health()` +
   diagnostics; keep all counters real.
4. **Backend F4** — envelope additions (`version`, `source`, `correlation_id`); propagate
   `request_id` → `correlation_id` in gateway control frames.
5. **Backend F5/F8** — in-memory event inspector + REST: `/api/realtime/health`,
   `/api/realtime/events`, `/api/realtime/connections/{connection_id}`, `/api/realtime/config`.
6. **Backend F6/F7** — backpressure config block + registry/channel-metrics enrichment.
7. **Backend tests** — extend `test_connection_engine.py` (states, health, envelope,
   inspector), `test_realtime_gateway.py` (new endpoints), facade test; keep every
   existing test green.
8. **Frontend** — `lib/api.ts` helpers + `app/_pages/connection-manager/` shared data layer.
9. **Frontend** — rebuild main page (12 sections per spec §23–24/§26–33):
   Header → Top Status → Realtime Flow Visualization → Channel Overview → Live Connections →
   Routing/Delivery → Freshness → Backpressure → Event Inspector → Errors/Diagnostics →
   History → Configuration.
10. **Frontend** — child pages under `app/(services)/services/connection-manager/` +
    nav children through `NavSubmenu` (only where real backend data exists).
11. **Verification** — full backend `pytest`, `npm run lint`, `npm run typecheck`,
    `npm test` (node).
12. **Docs** — implement notes on `connection-manager.md`, write
    `ENGINE_IMPLEMENTATION_REPORT.md` (28 sections + evidence), feature matrix,
    `ENGINE_IMPLEMENTATION_STATUS.md` changelog.