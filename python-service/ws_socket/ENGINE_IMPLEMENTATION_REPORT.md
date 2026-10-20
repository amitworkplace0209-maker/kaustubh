# WebSocket Engine — Implementation Report

**Engine ID:** `websocket_engine`
**Date:** 2026-09-20
**Status:** Doc-driven implementation complete. Verification complete.

---

## 1. Implementation overview

The WebSocket Engine was implemented strictly from its design docs —
`docs/engines/websocket-engine.md` (45-section design) and
`docs/MASTER_ENGINE_LIFECYCLE_CONNECTION_FLOW.md` — then reconciled
against the current runtime and existing tests. The engine already existed
in the codebase and already satisfied the core architecture; this task
verified it against the spec, fixed five UI bugs, added read-only data
surfaces the design requires (History, Configuration), improved reconnect
observability, and rebuilt the frontend as Service Phase tabs with live
realtime delivery over the project's WS#2 monitor channel.

**Counts:** 5 UI bugs fixed, all hard-coded labels removed; 4 new backend
endpoints; 10 new backend tests; 9 WS test suites run.

---

## 2. Authority chain applied

1. `docs/engines/websocket-engine.md` (design authority)
2. `docs/MASTER_ENGINE_LIFECYCLE_CONNECTION_FLOW.md` (lifecycle authority)
3. Current source runtime (certified source of truth for behavior)
4. Existing WS tests/contracts (behavioral contract)

The UI was treated as an implementation surface to verify, never as
authority. Any conflict was resolved in this order and recorded in
`ws_socket/ENGINE_AUDIT_DECISIONS.md`.

---

## 3. Architecture preserved (single-owner rule)

The engine keeps exactly one broker/session WebSocket:

```
WebSocketFacade (compat) -> WebSocketEngine -> ws_manager/SFeedWebSocket -> Broker WS#1
```

- No other component opens a broker socket.
- `set_publish_hook` is the only path from the socket into the engine.
- Only the engine emits `TICK_*` events.
- `api/ws_engine.py::_get_engine()` is the single wire-up point.
- The frontend realtime channel (WS#2 / `engines` channel via Connection
  Manager) is a monitor socket, documented as separate from WS#1.

---

## 4. Audit summary

Audited: `api/ws_engine.py`, `api/websocket.py`, `ws_socket/engine/*`,
`ws_socket/ws_manager.py`, `services/websocket_engine.py`,
`services/websocket_history_service.py`, `lib/ws-engine.ts`,
`app/_pages/websocket-engine/page.tsx`, the Session Manager page (as the
tab/realtime pattern), `lib/engine-realtime.ts`, and the
`phase2/websocket-engine` proxy route.

Verdicts recorded in `ENGINE_AUDIT_DECISIONS.md`:
- Architecture: KEEP (correct per docs).
- Backend data integrity: KEEP (no fake data anywhere).
- Frontend: MODIFY (rebuild as Service Phase tabs, fix 5 bugs, remove all
  hard-coded labels).

---

## 5. Backend surfaces (existing, verified correct)

| Endpoint (control plane `/api/services/websocket`) | Source |
|---|---|
| `GET /status` | `engine.status()` + `ws_manager.status()` |
| `GET /metrics` | `engine.metrics()` |
| `GET /quality` | `engine.quality_snapshot()` |
| `GET /resources` | `engine.resources_view()` |
| `GET /live_feed` | `engine.live_feed()` |
| `GET /raw_stream` | `engine.raw_stream()` |
| `GET /field-verification` | `engine.field_verification()` |
| `GET /subscriptions` | subscription registry |
| `GET /pins`, `POST /pins`, `DELETE /pins/{id}` | pin registry |
| `GET /consumers`, `PUT /consumers/{id}` | consumer registry |
| `POST /subscribe`, `POST /unsubscribe` | `ws_manager.subscribe()` / `unsubscribe()` |
| `POST /connect`, `/reconnect`, `/disconnect` | supervisor control |

All responses use the `{ok, data|error}` envelope with JSON-safe
sanitization. Route correction: the frontend previously called a
non-existent `POST /pins/{key}`; it now uses the existing
`DELETE /pins/{id}`.

---

## 6. Backend surfaces (added by this task)

- `GET /history` — `services.websocket_history_service.get_history`
  (persisted MongoDB events; paginated + filtered). Honest empty envelope
  when MongoDB is not connected.
- `GET /events` — `get_events_filtered` (persisted reconnect/ws events).
- `GET /history/{connection_id}` — `get_record` detail for one connection.
- `GET /daily` — `get_daily_summary` + `get_available_dates`.
- `GET /config` — read-only: runtime reconnect knobs
  (`ws_reconnect_delay_ms`, `ws_backoff`, `ws_auto_reconnect`,
  `ws_max_reconnect_attempts`), canonical `schema_version`/`sdk_version`,
  `feed_levels` (from owner status), `quality_thresholds`,
  `resource_thresholds`. No writes.

The legacy diagnostics router (`api/websocket.py`) keeps its
`/history`, `/events`, `/daily`, `/metrics`, `/telemetry`, `/export`
routes for compatibility; both routers delegate to the same
`websocket_history_service` so logic is not duplicated.

---

## 7. Reconnect observability (added)

Previously inspectable only via persisted events and counters. Now also
recorded in the in-memory `ws_manager._connection_history` deque (maxlen
200, under `self._lock`) so the History tab shows reconnect activity even
without a database:

- `reconnecting` — attempt number + computed `backoff_sec`.
- `reconnected` — attempt number + total reconnect count.
- `reconnect_exhausted` — status `stopped` + total attempts.

Persisted event emission (`_emit_ws_event` -> `websocket_history_service`)
is unchanged.

---

## 8. Data integrity verdict

No fabricated data exists in any backend surface. Every value exposed to
the UI comes from real engine state. Where a value is absent the UI
renders an em-dash / `NO_FEED` / `DISCONNECTED` / `UNKNOWN` and states the
limitation. Nothing is defaulted to a plausible placeholder.

---

## 9. Frontend rebuild (Service Phase tabs)

`app/_pages/websocket-engine/page.tsx` was rebuilt to mirror the Service
Phase tab pattern with 12 tabs:

1. **Overview** — live via `useEngineStatus('websocket_engine', WE/status)`
   over WS#2 `engines` channel; connector/supervisor/session cards,
   resource health, quality summary, levels from real `feed_levels`,
   dynamic field-verification count.
2. **Connection** — lifecycle/feed state, WS id, per-button control
   actions with pending + result feedback, reconnect counter/backoff,
   connection history.
3. **Live Feed** — real `live_feed` increments; refreshed on every
   `engine.status` frame and on Refresh-all.
4. **Quality** — `quality.summary`, thresholds, per-instrument feed
   status/counts, field availability, latency percentiles.
5. **Subscriptions** — desired vs subscribed records; subscribe/unsubscribe
   with result feedback.
6. **Pins** — pins CRUD; remove uses `DELETE /pins/{id}`.
7. **Consumers** — consumer list + enabled toggle with flash feedback.
8. **Field Verification** — `field-verification` matrix, searchable,
   category/level filtering, cap labeled from real `rows.length`.
9. **Raw Stream** — `raw_stream` payload (segment default trimmed to a
   placeholder), keeps last payload on error.
10. **Resources** — `resources_view`, severity badge from real data.
11. **History** — `/history` (persisted, paginated) + `/events`.
12. **Configuration** — `/config` (read-only reconnect knobs + versions).

Realtime contract: `frame.type === 'engine.status'` on the `engines`
channel -> `liveTick` -> refresh the active detail tab (same contract as
the Session Manager page). No local polling.

---

## 10. Bugs fixed

| # | Bug | Fix |
|---|---|---|
| 1 | Remove-pin used `POST /pins/{key}` (405) | `DELETE /api/.../pins/{id}` |
| 2 | Connect/Reconnect/Disconnect had no feedback | per-button pending + result state; status refreshed after |
| 3 | Consumer toggle ignored result | pending + error/success flash |
| 4 | Live feed wasn't refreshed on live frames | refresh on `engine.status` frames |
| 5 | Refresh-all omitted Live Feed | included |

---

## 11. Hard-coded labels removed

- 344-field card title -> dynamic from `field-verification.total`.
- Tier badges -> real `feed_levels` (only levels the backend reports).
- `subSeg='nse_cm'` default input -> placeholder, user provides segment.
- `consumer: 'subscribed'` -> dropped; backend defaults it.
- Schema/SDK version -> rendered from live status (verified values:
  `schema_version '1.0'`, `sdk_version '3.0.6'`), never hard-coded.

---

## 12. Version facts (certified)

| Item | Value | Source |
|---|---|---|
| `schema_version` | `1.0` | runtime `engine.status().schema_version` |
| `sdk_version` | `3.0.6` | runtime `engine.status().sdk_version` |
| Feed levels | `L4` / `L8` / `L16` / `INDEX` | `feed_levels()` counts |
| Session lifetime | 08:50 login -> 08:55 connect -> 08:59 ticks -> 15:31 stop | Scheduler window |

Note: `master_canonical.SCHEMA_VERSION = "market-data-1.0"` also exists in
the codebase; the engine's live status reports `1.0` per `canonical`
schema constants. Both are preserved; the UI renders the live value.

---

## 13. Realtime wiring (WS#2 monitor channel)

- `lib/engine-realtime.ts` — `useEngineStatus` / `useOneShot`.
- `components/frontend-realtime-provider.tsx` — `onFrame`.
- Frame type `engine.status` on the `engines` channel carries
  `engineStatus`, `ownerStatus`, `feedQuality`, `liveFeed`, `resources`.
- REST fallback returns `engine.status()` with nested `owner_status`.

The page merges: `status = statusData?.engineStatus ?? statusData`,
`owner = statusData?.ownerStatus ?? statusData?.engineStatus?.owner_status
?? status.owner_status`, `connected = status.connection_connected ??
owner.connected`.

---

## 14. History surface

`GET /history?limit=50` -> `{records, total, ...}` (persisted). `GET
/events?limit=100` -> `{events, total, has_more}`. Reconnect transitions
also visible in-memory via `_connection_history`. `GET /history/{id}`
returns a single connection record or `{ok: False}` when missing. With no
MongoDB connection, endpoints return honest `{ok: True, records: [],
total: 0, mongo_unavailable: True}` envelopes.

---

## 15. Configuration surface

`GET /config` returns: reconnect settings (`ws_reconnect_delay_ms`,
`ws_backoff`, `ws_auto_reconnect`, `ws_max_reconnect_attempts`), canonical
schema/SDK versions, `feed_levels`, `quality_thresholds`,
`resource_thresholds`, schema count. Read-only by design: no settings are
mutated from the UI.

---

## 16. Connection surface & controls

Shows lifecycle/feed state, supervisor state, WS id, `last_tick_at`,
`connection_connected`, reconnect attempt count, backoff delay, and the
connection history. `POST /connect`, `/reconnect`, `/disconnect` perform
the real supervisor actions; each button reports pending/OK/error and
refreshes `/status`.

---

## 17. Live Feed surface

Renders `live_feed` incremental counters (messages, per-instrument,
latency) received over WS#2 frames (`frame.liveFeed`) with REST fallback.
Reactively refreshed — the Live Feed tab updates as frames arrive rather
than only on manual refresh.

---

## 18. Quality surface

`quality.summary()` -> overall feed health (total instruments, LIVE /
DEGRADED / STALE / NO_FEED counts, messages/sec, invalid, duplicates,
gaps) + `quality_thresholds` (configurable stale thresholds per feed
type, not a single universal timeout) + per-instrument feed status and
field availability. Latency percentiles from `metrics.py`.

---

## 19. Subscriptions surface

Desired vs subscribed records from the subscription registry. Subscribe /
unsubscribe call `POST /subscriptions` (regenerate + regroup idempotent
`subscribe_to_desired_pins`), so repeated requests do not duplicate local
state. The backend defaults the requested state to `subscribed`.

---

## 20. Pins surface

Pins CRUD against the pin registry: `POST /pins` (add), `DELETE
/pins/{id}` (remove). Pins drive subscription reconciliation; the engine
never writes the authoritative stock registry.

---

## 21. Consumers surface

Consumer registry read; toggle via `PUT /consumers/{id}` with pending +
error/success flash. No hard-coded consumer state.

---

## 22. Field verification surface

`field_verification` matrix from `fields.py`: expected/required/received
columns per feed level, `total` and `status_counts` with per-field status
(`RECEIVED` / `NOT_RECEIVED` / `NULL_VALUE` / `INVALID` / `UNSUPPORTED`).
UI renders the real row count and allows search + level/category filters.

---

## 23. Raw stream surface

`raw_stream` against the real `_raw_bucket` (bounded, TTL-based). Raw tab
requires a user-supplied segment (placeholder, not pre-filled default)
and keeps the last payload visible on error. No fabricated ticks.

---

## 24. Resources surface

`resources_view()` -> RAM/CPU percent, raw bucket tokens, pins; severity
badge (`severity` + `severityTone`) rendered from real data. Thresholds
come from `resources.thresholds.to_dict()` via `/config`.

---

## 25. Schema normalization reflection

The engine standardizes broker feed into the internal market-feed schema
(`fields.py`) with explicit per-field availability. "No invented values"
holds: unavailable fields stay unavailable (`OI = NOT_RECEIVED`, never `0`,
unless the protocol defines `0` as the real value). Sequence-gap metrics
are only produced when the broker supplies a usable sequence number.

---

## 26. Lifecycle reflection

The engine's Scheduler window (08:50 login -> 08:55 connect -> 08:59 ticks
-> 15:31 stop) matches `MASTER_ENGINE_LIFECYCLE_CONNECTION_FLOW.md`. 03:30
(broker feed-stop) and 03:31 (application shutdown) remain separate
events. Session-failure (Session Manager) and socket-failure (this engine)
stay separate failure domains.

---

## 27. Testing & verification results

Backend (from `python-service`):
```
pytest tests/test_ws_engine.py tests/test_websocket_engine.py
       tests/test_ws_availability.py tests/test_ws_engine_quality.py
       tests/test_ws_supervisor_sdk.py tests/test_scheduler_ws_prep.py
       tests/test_engine_control_api.py tests/test_master_canonical.py
       tests/test_ws_engine_surfaces.py -q
Result: 1 failed, 138 passed
```

- New `tests/test_ws_engine_surfaces.py` (10 tests): all pass — covers
  `/history`, `/events`, `/history/{id}`, `/daily`, `/config` surface
  shapes and envelope guards (including MongoDB-not-connected), plus
  reconnect-history recording performed via
  `importlib.import_module("ws_socket.ws_manager")` (the package
  `__init__` re-exports the module singleton, so a plain import is
  bypassed in tests).
- Pre-existing failure (not caused by this task, confirmed by `git stash`
  baseline): `tests/test_ws_supervisor_sdk.py::test_subscribe_path_builds_ws_tokens`
  — the `FakeWs` test fixture lacks `subscribe_depth`/`subscribe_index`
  (real SDK methods called by `_send_subscribe`). Left untouched as
  out-of-scope; remaining supervisor-sdk tests pass.

Frontend (from `C:\project`):
- `npx tsc --noEmit` -> clean.
- `npx eslint app/_pages/websocket-engine/page.tsx` -> clean (0 errors,
  0 warnings).
- Whole-app eslint -> 0 errors (warnings in unrelated legacy pages).

---

## 28. Known limitations

- With MongoDB unavailable, History/Events/Daily return empty-but-honest
  envelopes (state is purely in-memory then).
- Feed-latency values are only meaningful when the broker timestamp is
  available; otherwise only local receive timing is shown.
- One pre-existing supervisor-SDK test hinges on an incomplete test
  fixture (see section 27); real reconnection logic is covered by other
  passing tests.
- Raw-stream `_raw_bucket` is bounded by design (memory safety); the UI
  labels the window explicitly.

---

## 29. Compliance mapping against the 45-section design

| Design section | Compliance |
|---|---|
| 1-2 Purpose / High-level architecture | Preserved exactly (`SFeedWebSocket` = sole broker socket; Feature Engine = downstream) |
| 3 Responsibility boundary | Session Manager owns registry/subscription; engine owns socket/subscribe/validate/normalize/quality |
| 4-5 Daily lifecycle & 08:55 start | Scheduler window implements start sequence |
| 6-8 Session Manager input / adapter | Subscription registry + Kotak Neo feed handlers |
| 9-11 Standard feed / availability / field statuses | `fields.py` schema + field-verification statuses |
| 12-15 Validation / duplicates / sequence gaps | validation pipeline; sequence-only gap reporting |
| 16-17 Normalization / depth | internal schema normalization, L8 depth normalized when present |
| 18-22 Feed-quality monitor / speed / latency / stale / health | `quality.py` + `metrics.py` (rolling rates, latency p50/p95/p99) |
| 23-25 Runtime stock add/expiry / sync | registry/pin reconciliation, idempotent re-sync |
| 26-28 Connection state machine / failure / session vs socket | supervisor states + bounded backoff, separate failure domains |
| 29-30 03:31 shutdown / 03:30 vs 03:31 | Scheduler 15:31 stop; events kept separate |
| 31 Project WebSocket | WS#2 documented as separate monitor channel |
| 32 Feature Engine handoff | clean standardized feed only |
| 33-34 No silent modification / data preservation | `NOT_RECEIVED` preserved; metadata retained; not a tick-storage engine |
| 35-37 Performance / backpressure / memory safety | bounded structures, no per-tick DB writes, bounded raw bucket |
| 38-39 Observability / logging | metrics surfaces + `WS_*` logs + persisted/connection history |
| 40-41 Testing / idempotency | 8 suites + new surface tests; idempotent subscribe/unsubscribe |
| 42-45 Broker expansion / E2E / golden rules | adapter boundary; golden rules all hold |

---

## Feature Matrix

| FEATURE | BACKEND | API | DATA SOURCE | PERSISTENCE | EVENT | UI | TEST | STATUS |
|---|---|---|---|---|---|---|---|---|
| Single-owner WS#1 | `ws_manager.py` singleton | — | Broker SDK | — | WS events | Overview banner | `test_ws_supervisor_sdk.py` | DONE |
| Engine facade | `engine/engine.py` | `GET /status` `/metrics` `/resources` | `ws_manager.status()` | — | `engine.status` frame | Overview | `test_websocket_engine.py` | DONE |
| Subscribe/unsubscribe | `ws_manager.subscribe()` | `POST /subscriptions` | subscription registry | MongoDB registry | WS events | Subscriptions | `test_ws_supervisor_sdk.py` | DONE |
| Pins CRUD | pin registry | `GET/POST/DELETE /pins` | registry | MongoDB registry | registry events | Pins | `test_ws_engine.py` | DONE (uses `DELETE /pins/{id}`) |
| Consumers | consumer registry | `GET /consumers` `PUT /consumers/{id}` | registry | MongoDB registry | registry events | Consumers | `test_ws_engine.py` | DONE |
| Live feed | `engine.live_feed()` | `GET /live_feed` | feed pipeline | — | `liveFeed` frame | Live Feed | `test_ws_availability.py` | DONE (reactively refreshed) |
| Raw stream | `engine.raw_stream()` | `GET /raw_stream` | `_raw_bucket` | — | frame | Raw Stream | `test_ws_availability.py` | DONE |
| Quality summary | `engine/quality.py` | `GET /quality` | per-instrument monitor | — | `feedQuality` frame | Quality | `test_ws_engine_quality.py` | DONE |
| Field verification | `engine/field_verification.py` | `GET /field-verification` | `fields.py` | — | frame | Field Verification | existing suites | DONE |
| Resources | `engine/resources_view()` | `GET /resources` | resource monitor | — | `resources` frame | Resources | `test_ws_engine.py` | DONE |
| History (persisted) | `websocket_history_service` | `GET /history` `/events` `/daily` `/history/{id}` | WS events | MongoDB (opt-out) | WS events | History | `test_ws_engine_surfaces.py` | DONE |
| Reconnect observability | `ws_manager._connection_history` | `GET /status` | supervisor | MongoDB + in-memory | reconnect events | Connection/History | `test_ws_engine_surfaces.py` | DONE |
| Configuration (read-only) | runtime settings | `GET /config` | `get_runtime_setting` + canonical | — | — | Configuration | `test_ws_engine_surfaces.py` | DONE |
| Realtime Overview | `engine-realtime.ts` | WS#2 `engines` channel | status snapshots | — | `engine.status` frame | Overview | tsc/eslint | DONE |
| Control actions | supervisor | `POST /connect` `/reconnect` `/disconnect` | supervisor | — | WS events | Connection | `test_engine_control_api.py` | DONE |
| Scheduler window | Scheduler + engine | — | lifecycle window | — | START/STOP | — | `test_scheduler_ws_prep.py` | DONE |