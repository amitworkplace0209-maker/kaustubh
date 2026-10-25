# Connection Manager Engine — Implementation Report

**Engine ID:** `connection_manager`
**Date:** 2026-09-20
**Status:** Doc-driven audit + implementation complete. Backend verified
(77 target tests + facade suite), frontend rebuilt (Overview + Connections +
Events + Configuration, Service Phase).

---

## 1. Implementation overview

The Connection Manager is the **realtime control gateway that owns WS#2**
(`/ws/realtime`, backend <-> frontend). It is NOT the broker feed owner,
NOT the Session Manager, NOT a feature/strategy engine. The audit in
`docs/reports/CONNECTION_MANAGER_AUDIT_PLAN.md` found 10 gaps (F1-F10);
backend findings F1-F9 and the frontend/data-layer finding (F10) are
resolved. The facade `services/connection_manager_engine.py` is the single
registered engine; the legacy `GatewayFacade` was removed so no duplicate
engine owns the `connection_manager` id.

**Authority chain:** design spec (`docs/engines/connection-manager.md`,
69 sections) -> lifecycle architecture
(`docs/MASTER_ENGINE_LIFECYCLE_CONNECTION_FLOW.md`) -> current runtime
(certified truth for behavior) -> existing contract tests.

---

## 2. What the Connection Manager is (and is not)

It is the consumer-facing feed-routing / connection-management layer:

- knows WHO needs WHAT fields, FROM WHICH source, THROUGH WHICH channel,
  and tracks connection lifecycle, health, backpressure and delivery.
- owns the application realtime channel WS#2 for the frontend.

It must NOT (spec §3): log into brokers, own broker WebSocket auth,
compute features, place orders, persist every tick, or become any other
engine. All boundaries are preserved; `field_requirements` explicitly
resolves requested fields to AVAILABLE / UNAVAILABLE / PARTIAL /
NOT_READY / SOURCE_ERROR — never fabricating a value.

---

## 3. Audit findings and resolutions

| # | Finding | Resolution |
|---|---|---|
| F1 | `GatewayFacade` duplicate engine facade (`connection_manager`) | Removed from `services/legacy_engine_facades.py`; real `ConnectionManagerEngine` is the sole registered engine; facade-catalog test updated (8 tests pass) |
| F2 | Client lifecycle states | `client.py` rewritten: lifecycle state machine with derived DEGRADED / STALE, `record_error`, `_outbox_limit()` runtime clamp |
| F3 | No spec-health surface | `connection_engine.health()` (STOPPED/ERROR/OVERLOADED/DEGRADED/NO_DATA/HEALTHY) + facade `_on_health_check` (Mongo gate + mapping) + `GET /api/realtime/health` |
| F4 | Envelope missing version/source/correlation_id | Additive fields in engine frames AND gateway frames (welcome, pong, auth, subscribe/unsubscribe, error.event) |
| F5 | No event inspector | Bounded in-memory ring (maxlen 500) + `GET /api/realtime/events` with limit/since/type/level/channel filters |
| F6 | Backpressure not configurable | Runtime `cm_outbox_maxlen` (clamp 100..5000) exposed via `config()`/`status()`/`health()` |
| F7 | Registry/diagnostics sparse | `session_records()` enriched (state, lifecycleState, requestedFields, queue, drops, rate, up, lastError, lastTransitionAt, ...) |
| F8 | No realtime control plane | `api/ws_gateway.py`: 4 new REST endpoints (`/health`, `/events`, `/connections/{id}`, `/config`) + writer error recording (`writer_ping_failed`, `writer_send_failed`) |
| F9 | `_outbox_limit` called unqualified | Fixed to `client_mod._outbox_limit()` (3 call sites: status / health / config) |
| F10 | Frontend main page read `realStatus` (now a legacy boolean) | Rewritten to read `connectionEngine.status()` snapshot + control-plane one-shots; child pages added |

---

## 4. Backend surface (control plane)

| Endpoint | Source |
|---|---|
| `GET /api/realtime/status` | `connection_engine.status()` |
| `GET /api/realtime/sessions` | `connection_engine.sessions()` |
| `GET /api/realtime/fields` | `field_requirements.available_fields()` / `resolve_requirements(...)` |
| `GET /api/realtime/health` | `connection_engine.health()` |
| `GET /api/realtime/events?limit&since&event_type&level&channel` | `connection_engine.recent_events(...)` |
| `GET /api/realtime/connections/{connection_id}` | one `session_records()` record, `{ok, error}` on miss |
| `GET /api/realtime/config` | `connection_engine.config()` (read-only) |

All responses use the `{ok, data|error}` envelope. Live status additionally
streams to the frontend over WS#2 (`engines` channel, one-shot REST
fallback).

---

## 5. Envelope contract (additive)

Gateway frames now carry, alongside the existing keys:

- `version` = `ENVELOPE_VERSION` (`"1.0"`)
- `source` = `SOURCE_GATEWAY` (`"gateway"`)
- `correlation_id` (echoed: ping->pong, auth->auth.ok/error,
  subscribe->subscription.ack, unsubscribe->subscription.removed,
  welcome)

`schema_version`, `event_id`, `sequence`, `timestamp`, `channel`, `data`
are unchanged, so the wire format is strictly additive.

---

## 6. Health mapping

`connection_engine.health()` — computed from real signals only:

| Priority | State | Trigger |
|---|---|---|
| 1 | `STOPPED` | gateway not started |
| 2 | `ERROR` | `persist_errors > 0` (db_writer pipeline) |
| 3 | `OVERLOADED` | queue depth >= 80% of `_outbox_limit()` |
| 4 | `DEGRADED` | dropped > 1000, or feed `STALE` |
| 5 | `DEGRADED` | feed `DELAYED` (within `delayedMaxAgeS`) |
| 6 | `NO_DATA` | feed `NO_DATA` and no active sessions |
| 7 | `HEALTHY` | otherwise |

The facade maps this onto `EngineHealth` and downgrades to DEGRADED when
Mongo is disconnected (`is_mongo_connected()` gate).

---

## 7. Event inspector

In-memory `deque(maxlen=500)`; events: `engine.started`, `engine.stopped`,
`subscription.acked`, `subscription.removed`, `persistence.written`,
`persistence.failed`, `fanout.batch` (+ failed), `broadcast.delivered`,
`session.attached` / `session.detached`. Filtered by limit / since
(epoch) / type / level / channel.

---

## 8. Backpressure

Per-connection `DROP_OLDEST` outbox; queue limit sourced from the runtime
setting `cm_outbox_maxlen` (default `OUTBOX_MAXLEN = 1000`, clamped to
100..5000). Market vs critical drops are counted separately and surfaced in
`health()`, `status().backpressure`, per-record diagnostics, and the
Overview/Connections UI.

---

## 9. Registry diagnostics

`session_records()` per connection: `connectionId`, `state`,
`lifecycleState`, `channels`, `source`, `deliveryMethod`, `requestedFields`,
`queueDepth`, `queueLimit`, `droppedMarket`, `droppedCritical`,
`deliveryRatePerSec`, `upSeconds`, `sequence`, `connectingAt`,
`connectedAt`, `enqueuedAt`, `lastApprovedAt`, `lastActivityAt`,
`lastDeliveredAt`, `lastTransitionAt`, `lastReason`, `lastError`
(code/message/at). `status()` aggregates channelMetrics (market + state
channels: profileId, priority, minIntervalS, subscribers, delivered),
freshness (FRESH/DELAYED/STALE/NO_DATA + age + ticks/sec), backpressure,
lifecycle counts, persistence, health and the registry.

---

## 10. Realtime wiring (WS#2 monitor channel)

- `lib/engine-realtime.ts` — `useEngineStatus` / `useOneShot`.
- `components/frontend-realtime-provider.tsx` — `onFrame`.
- The facade `status_snapshot()` embeds `connectionEngine` (the live
  `connection_engine.status()`) plus `diagnostics`; the frontend reads
  `data.connectionEngine` for the registry/flow and the control-plane
  one-shots for health/events/config.

---

## 11. Frontend

- `app/_pages/connection-manager/connection-manager-data.ts` — shared data
  + formatters (`fmtNum`, `fmtClock`, `fmtEpoch`, `fmtDuration`) + tone maps
  for the spec vocabulary (HEALTH/FRESH/LIFE/LEVEL/CHANNEL kinds) +
  `FLOW_STAGES` for the §24 receive->health pipeline.
- `app/_pages/connection-manager/page.tsx` — Overview rebuilt with the 12
  spec sections: Header, Top Status (Gateway/Health/Routing/Persistence),
  Realtime Flow (RECEIVE->HEALTH, real counters), Channel Overview,
  Live Connections (registry), Routing & Delivery policy, Freshness,
  Backpressure, Errors/Diagnostics, Event Inspector, History (honest
  NOT AVAILABLE gap), Configuration.
- `app/_pages/connection-manager/connections.tsx` — registry table + per-id
  detail via `GET /api/realtime/connections/{id}`.
- `app/_pages/connection-manager/events.tsx` — inspector with real filters
  (limit/type/level/channel/since).
- `app/_pages/connection-manager/configuration.tsx` — read-only config +
  field catalogue.
- `app/(services)/services/connection-manager/{connections,events,configuration}/page.tsx`
  — wrapper pages (dynamic import, Service Phase pattern).
- `components/layout/nav.ts` — `connection-manager` item now has children:
  Overview / Connections / Events / Configuration (`NavSubmenu`,
  route-authoritative).
- `lib/api.ts` — `getRealtimeHealth/Config/Events/Connection` helpers.

---

## 12. Bugs fixed

| # | Bug | Fix |
|---|---|---|
| 1 | `_outbox_limit()` called as a bare name (NameError path in status/health/config) | `client_mod._outbox_limit()` |
| 2 | Duplicate `connection_manager` engine ownership (`GatewayFacade`) | removed facade; single real engine |
| 3 | Frontend read legacy `realStatus` (boolean) for the whole snapshot | reads `data.connectionEngine` + one-shots |

---

## 13. Data integrity verdict

No fabricated data in any surface. Health, freshness, registry, events,
config and every counter come from real engine state; absent values render
`—` / `NO_DATA` / `NOT AVAILABLE`. Spec-§29 history is honestly gapped,
not emulated.

---

## 14. Known limitations

- Spec §20 expiry / §29 historical session store: not implemented (no
  history endpoint; live registry + persistence signals only).
- Spec §39 full speculative event model: the inspector logs the real
  engine events; the broader event bus is not realised.
- Spec §55 source fallback: single-stream source resolution stays.
- Full backend suite has 16 pre-existing failures unrelated to this task
  (poisoned scheduler tests follow `test_common_trading_core.py`; one
  supervisor-SDK test breaks on its own fixture); the target connection
  suites and the facade suite are green.

---

## 15. Compliance mapping (design §s)

| Design section | Compliance |
|---|---|
| 1-2 Purpose / topology | Preserved — CM is the consumer-facing distribution point after Feat Engine |
| 3 What it is NOT / 47 Data ownership | All boundaries hold; single registered engine |
| 10 Field requirement management | `field_requirements` catalogue + resolver (never fabricates) |
| 13-14 Control vs data plane + API | `/api/realtime/*` control plane + WS#2 data plane separated |
| 23 Connection states | Lifecycle state machine incl. DEGRADED / STALE (derived) |
| 24 Data delivery filtering | Per-connection `requestedFields` filter on fan-out |
| 26 / 45 / 60 Backpressure & memory safety | `DROP_OLDEST`, bounded outbox, runtime clamp |
| 27 / 51 Connection health | `health()` + aggregated metrics + facade mapping |
| 28 Data quality vs connection health | Distinct surfaces (feed quality vs gateway health) |
| 39 Internal events | Real engine events in the inspector |
| 50 Diagnostics | Rich `session_records()` / `status()` + per-id control plane |
| 56 Stale data protection | FRESH/DELAYED/STALE/NO_DATA with thresholds |
| 63-64 Envelope contract | Additive `version`/`source`/`correlation_id` |
| 68 Golden rules | All 25 rules hold |
| 69 Final architecture | WS#2 documented as the CM-owned realtime channel |

---

## Feature Matrix

| FEATURE | BACKEND | API | DATA SOURCE | PERSISTENCE | EVENT | UI | TEST | STATUS |
|---|---|---|---|---|---|---|---|---|
| Single registered engine | `services/connection_manager_engine.py` | engine registry | `connection_engine` | — | engine frames | Overview | `test_legacy_engine_facades.py` | DONE |
| Client lifecycle state machine | `client.py` | `/sessions` | registry | — | session.attached/detached | Connections | `test_connection_engine.py` | DONE |
| Envelope v/source/correlation | `connection_engine.py` + `api/ws_gateway.py` | — | engine frames | — | frames | — | `test_connection_engine.py` + `test_realtime_gateway.py` | DONE |
| Health (spec vocab) | `connection_engine.health()` | `GET /api/realtime/health` | real signals | — | engine health | Overview/Status | `test_connection_engine.py` + `test_connection_manager_engine.py` | DONE |
| Event inspector | `_event_log` ring | `GET /api/realtime/events` | engine events | in-memory (500) | event types | Events / Overview | `test_connection_engine.py` + `test_realtime_gateway.py` | DONE |
| Backpressure config | `cm_outbox_maxlen` | `GET /api/realtime/config` | runtime settings | — | — | Overview/Configuration | `test_connection_engine.py` | DONE |
| Field requirements | `field_requirements.py` | `GET /api/realtime/fields` | catalogue | — | — | Configuration | existing suite | DONE |
| Registry diagnostics | `session_records()` | `/connections/{id}` | registry | — | — | Connections | `test_connection_engine.py` + `test_realtime_gateway.py` | DONE |
| Configuration (read-only) | `connection_engine.config()` | `GET /api/realtime/config` | constants + settings | — | — | Configuration | `test_realtime_gateway.py` | DONE |
| Facade health mapping | `_on_health_check` | engine registry health | `health()` + Mongo | — | engine health | Overview | `test_connection_manager_engine.py` | DONE |
| Frontend data layer + tone maps | `connection-manager-data.ts` | one-shots | — | — | — | all pages | tsc/eslint | DONE |
| Overview 12-section | `page.tsx` | WS#2 + one-shots | engine snapshot | — | engine.status | Overview | tsc/eslint | DONE |
| Connections child | `connections.tsx` | `/connections/{id}` | registry | — | — | Connections | tsc/eslint | DONE |
| Events child | `events.tsx` | `/events` | event ring | — | — | Events | tsc/eslint | DONE |
| Configuration child | `configuration.tsx` | `/config` + `/fields` | config | — | — | Configuration | tsc/eslint | DONE |
| Nav children | `nav.ts` | — | — | — | — | sidebar | `nav-utils.test.ts` | DONE |
| Persisted history (spec §29) | — | — | — | — | — | Overview gap note | — | NOT IMPLEMENTED (honest gap) |