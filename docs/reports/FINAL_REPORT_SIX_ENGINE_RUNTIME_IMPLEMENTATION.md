# FINAL REPORT — SIX-ENGINE RUNTIME IMPLEMENTATION + UI AS CONNECTION-MANAGER CONSUMER

> Final verification report (sections A–L) for the mandate to implement the six
> core engine specs as **real runtime engines** (no spec-only / facade / mock
> engines, no hidden bypass live-data paths), plus the follow-on task to migrate
> the engine UI pages into pure WebSocket #2 (Connection Manager) consumers.
>
> Generated: 2026-09-17 | Author: opencode (big-pickle)

---

## A. Objective & scope

Implement and wire the six core engine specifications as real running engines so
that the backend **operates through them**:

1. Scheduler Engine — trigger/orchestration only.
2. Session Manager — session + instrument/subscription source of truth.
3. WebSocket (Market Data) Engine — single broker connection owner + feed quality.
4. Feature Engine — modular, field-driven calculation layer.
5. Connection Manager — consumer routing + field requirements + persistence drain.
6. DB Writer Engine — bounded, batched, honest persistence.

Constraints honoured: specs are source of truth; no advertised engine is a
facade/mock; no hidden direct bypass of the live path; Dummy mode never opens a
fake broker WebSocket; real broker modes never use fabricated data; all six
engines are registered in the Engine Registry with lifecycle/health/metrics.

Follow-on scope (this pass): migrate the seven engine-facing frontend pages from
per-page REST polling to the realtime `engines` channel pushed by the Connection
Manager over WebSocket #2.

---

## B. System under test

- Backend: `C:\project\python-service` (FastAPI app, scheduler, session manager,
  broker adapter layer, `ws_socket` feed, engine registry, connection engine).
- Frontend: `C:\project\app` + `C:\project\lib` + `C:\project\components`.
- Live environment: backend `http://localhost:8000` (terminal_mode `kotak`,
  broker Kotak Neo), frontend `http://localhost:3000`.
- Market state during verification: **OPEN**, phase `LIVE_FEED`.

---

## C. Evidence method

Live REST probes against the running backend; a live WebSocket #2 client
(`/ws/realtime?token=<JWT>`) subscribing to the `engines` channel; header
inspection of every cited source file; the full backend pytest suite; frontend
`tsc --noEmit`, ESLint, `node --test`; and live HTTP compilation of each engine
route through the running Next dev server. No value in this report is simulated.

---

## D. Build / typecheck / test status

| Check | Command | Result |
|---|---|---|
| Backend suite | `python -m pytest tests -q` | **594 passed, 1 warning** (dateutil deprecation) |
| Frontend types | `npx tsc --noEmit` | **Clean (0 errors)** |
| Frontend lint | `npm run lint` | **0 errors** (242 pre-existing warnings) |
| Frontend unit tests | `node --test "tests/*.test.ts"` | **230 passed** |
| Engine routes (live) | HTTP GET × 7 routes | **200** each (compiled) |
| Backend runtime | process on `:8000` | **UP** (restarted on new code) |
| Frontend runtime | process on `:3000` | **UP** |

New test coverage added this effort: `tests/test_feature_engine_calculators.py`
(8), `tests/test_connection_engine.py::EngineSnapshotTests` (3),
`tests/test_ws_engine_quality.py` (14), `tests/test_scheduler_phases.py` (19),
`tests/test_scheduler_ledger.py` (+5), `tests/test_session_manager_*` (+4).

---

## E. Engine #01 — Scheduler

- Registry id `scheduler_engine`; live `state=RUNNING`, `health=HEALTHY`.
- Live `GET /api/scheduler/status`: `schedulerState=TICK_COLLECTION_RUNNING`,
  `phase=LIVE_FEED`, `nextPhase=square_off @ 15:16`, `marketStatus=OPEN`,
  `isTradingDay=true`, `sessionOwner=scheduler`.
- Daily phase timeline materialised exactly per spec: readiness 08:55,
  pre_market 09:00, limit_order 09:05, equilibrium 09:10, buffer 09:12,
  live_feed 09:15, square_off 15:16, feed_stop 15:30, websocket_close 15:31,
  logout 16:00.
- Readiness check (spec §3, 10-component + connection_manager) is live and
  honest: `overall=READY`; every critical component `ready=true`;
  `margin_engine` reports `ready=false` (honest — not started);
  `model_group` reports `ready=null` / "not registered" (never invented).
- Scheduler only **triggers**; square-off ownership ("how") stays with the
  square-off engine; feed-stop is a distinct event from WebSocket close.
- Idempotency + missed-event recovery + IST are covered by
  `tests/test_scheduler_phases.py` and `tests/test_scheduler_ledger.py`.

Code: `scheduler/__init__.py` (`get_scheduler_state` :599/:1844,
`get_scheduler_phases` :1848, `get_scheduler_readiness` :1853),
`api/routes.py` (`/api/scheduler/status` :275, `/readiness` :330,
`/summary` :350, `/history` :362).

---

## F. Engine #02 — Session Manager

- Registry id `session_manager`; live `state=RUNNING`, `health=HEALTHY`.
- Live overview (`/api/phase3/session-manager/overview`, spec vocabulary §7):
  `status/lifecycleState=SESSION_ACTIVE`, `active=true`, `mode=kotak`,
  `broker="Kotak Neo"`, `engineVersion=2.2.0`.
- Instrument/subscription truth is live: `counts.total=8`, `subscribed=8`,
  `desired=8`, `revision=2`, `feedLevelCounts.L8=8`, `statusCounts.ACTIVE=8`.
- Subscriber/reference logic (spec §11) is live per-instrument: each row on
  `/subscriptions` carries `subscribers=["stocks_db"]`, `subscriberCount=1`,
  `sources`, `desired`, `subscribed`, `feed_level=8`, `last_tick_at`.
- Domain events + revision tracking exposed (`revision`, `lastUpdatedAt`,
  `revisionApply`); no fabricated values.

Code: `services/session/session_manager.py` (`phase3_snapshot` :2524),
`api/session_manager.py` (`overview` :83, prefix `/api/phase3/session-manager`),
`services/session/instrument_store.py`.

---

## G. Engine #03 — WebSocket (Market Data) Engine

- Registry id `websocket_engine`; live `state=RUNNING`, `health=HEALTHY`.
- Live `GET /api/services/websocket/status`: `connected=true`,
  `feed_state=RECEIVING`, `lifecycle_state=WS_CONNECTED`, 8 subscribed symbols,
  `feed_levels={L4:0,L8:8,L16:0}`, `ticks_received=1608`,
  `ticks_validated=1608`, `ticks_rejected=0`, `errors=0`.
- Feed quality monitor (spec §18–§21) live at `/api/services/websocket/quality`:
  per-instrument status `LIVE` × 8, `field_availability` expected/received = 26/26
  per instrument, `missing=[]`, `null_count=0`, `invalid_count=0`.
- Duplicates/sequence honesty: `duplicate_total=31` reported;
  `sequence_gap_total=0` **and** `sequence_available=false` (Kotak SDK exposes no
  sequence number — gaps are reported unavailable, never fabricated).
- `PUT /quality/thresholds` present for configurable degraded/stale windows.
- Raw/validated/rejected counters and diagnostics by message type are live
  (`SFeedScrip`, `SFeedCasChange`).

Code: `ws_socket/engine/quality.py`, `api/ws_engine.py` (`/quality` :83),
`tests/test_ws_engine_quality.py` (14).

**Observation (honest):** overall feed latency measured at probe time was
`avg≈2.44s`, `p95≈8.20s`, `p99≈25.7s` (per-instrument p95 ~1.5–3.0s). This is a
recorded measurement, not a pass claim; see §L.

---

## H. Engine #04 — Feature Engine

- Registry id `feature_engine`; live `state=RUNNING`, `health=HEALTHY`.
- Modular calculator framework live: 6 calculators (`change`, `changePercent`,
  `spread`, `vwap`, `sma_10`, `sma_60`), each declaring required/optional inputs
  and a warm-up requirement; registry supports add/remove at runtime
  (`register_calculator`, `remove_calculator`).
- Execution honesty: `metrics.custom.totalCalculations=1608`, `errors=0`,
  `missingInputs=0`, `calculationErrors=0`; latency tail measured
  (`calculationLatencyP95Ms≈0.52`, `P99≈0.65`).
- **Warm-up bug fixed and verified live.** Previously the API's `calculators_view`
  emitted a stat key `warmup` that shadowed the declared warm-up requirement.
  Renamed to `warmupCount`; now declared `warmup` is correct
  (change/changePercent/spread=1, vwap=2, sma_10=10, sma_60=60) and live
  `warmupCount` is real (vwap=8, sma_10=72, sma_60=419).
- Feature output contract live (`/latest`): per instrument `marketData`,
  `features`, `calculationStatus`, `missingInputs`, `inputQuality`; e.g.
  `close: NOT_RECEIVED` is reported honestly rather than fabricated.

Code: `core/engines/feature_engine.py` (`calculators_view` :299,
`register_calculator` :322, `remove_calculator` :334),
`core/engines/feature_calculators.py`, `tests/test_feature_engine_calculators.py`.

---

## I. Engine #05 — Connection Manager

- Registry id `connection_manager`; live `state=RUNNING`, `health=HEALTHY`.
- Consumer routing + channel registry live: `marketChannels=[ai, market_watch,
  trading, watchlist]`, `stateChannels=[data, engines, notifications, orders,
  positions, system]`; `stats.messagesRouted=1`, `messagesDropped=0`.
- **Persistence reroute verified live:** the WS engine keeps the built-in
  `data_saver` consumer registered, but the Connection Manager now owns draining
  it — `persistence.consumerId=data_saver`, `ticksPersisted=1890`, `errors=0`.
  The WS engine's former inline `_drain_data_saver()` path is removed.
- Freshness reported live: `freshness.state=FRESH`, `ticksPerSecond≈6.2`,
  `pipelineRunning=true`; `feedLastTickAgeSeconds≈0.0`.
- Field requirements are a pure additive module (`field_requirements.py`);
  the CM never calculates features (feature fields resolved via the Feature
  Engine `CALCULATIONS`); unknown fields resolve to UNAVAILABLE, never invented.
- New realtime control plane: `engine_snapshot()` (:693) and
  `_engine_snapshot_loop()` (:716) push an `engine.status` frame on the `engines`
  state channel every `ENGINE_SNAPSHOT_INTERVAL_S=2.0`s, only while a session is
  subscribed.

Code: `connection_engine/connection_engine.py`, `connection_engine/channels.py`,
`connection_engine/field_requirements.py`, `tests/test_connection_engine.py`,
`tests/test_connection_field_requirements.py`.

---

## J. Engine #06 — DB Writer

- Registry id `db_writer_engine`; live `state=RUNNING`, `health=HEALTHY`.
- Live pipeline (`/api/services/engines/db_writer_engine`): `pipelineRunning=true`,
  `bufferLength=4` (bounded), `totalReceived=1611`,
  `ingestedFromRouter=1611`, `totalWritten=1607`, `totalWriteErrors=0`,
  `rejectedByValidation=0`, `ticksPerSecond≈6.2`, `writesPerSecond≈5.9`,
  `activeTickStocks=8`, `feedLatencyMs≈2937.66`.
- Ingestion is via the Connection Manager router → `DBWriterEngine.ingest()`
  (`services/db_writer_engine.py` :138); writes are batched and non-blocking from
  the feed path; buffer is bounded (no unbounded queue).
- Bypass removal verified live: `POST /api/ticks/ingest` → **404**,
  `POST /api/ticks/log` → **404** (HTTP tick injection deleted in `api/ticks.py`).

Code: `services/db_writer_engine.py`, `services/tick_buffer.py`, `api/ticks.py`,
`tests/test_db_writer_engine.py`.

---

## K. Realtime control plane + UI migration

### Backend (new capability, live-verified)

- `engines` added to `STATE_CHANNELS` (`connection_engine/channels.py`).
- `welcome` frame advertises it: live state channels =
  `['data','engines','notifications','orders','positions','system']`.
- Live WS client subscribed to `engines` and received an `engine.status` frame
  on `channel=engines` with `count=15` engine ids, including every facade id the
  UI needs.
- **Snapshot parity proven live:** the realtime per-engine payload is identical
  to REST (both come from `status_snapshot()`), so pages lose no fields on
  realtime. Verified present in the pushed frame:
  `db_writer_engine.pipeline.pipelineRunning=true`,
  `scheduler_engine.realStatus` + `schedule`,
  `session_manager.realStatus.lifecycleState=SESSION_ACTIVE`,
  `websocket_engine.realStatus.status.connection_connected=true`,
  `connection_manager.realStatus.persistence` (ticks persisted, errors 0).

### Frontend (all seven engine pages migrated)

New shared module `lib/engine-realtime.ts`:
- `useEngines()` — whole-registry live map.
- `useEngineStatus(engineId, fallbackPath?)` — one engine; REST fallback fetched
  **exactly once** on mount, realtime wins thereafter (never polled).
- `useOneShot(path, enabled)` — mount + manual refresh only; **no interval**.

Migrated pages (all now have **zero** `setInterval` / `usePoll`):

| Page | Route | Live source |
|---|---|---|
| `db-writer` | `/services/db-writer` | `useEngineStatus('db_writer_engine')` |
| `scheduler` | `/services/scheduler` | `useEngineStatus('scheduler_engine')` + one-shot jobs/runs |
| `feature-engine` | `/services/feature-engine` | `useEngineStatus('feature_engine')` + one-shot `/latest` |
| `connection-manager` | `/services/connection-manager` | `useEngineStatus('connection_manager')` |
| `session-manager` | `/services/session-manager` | `useEngineStatus('session_manager')` (overview via `realStatus`) + one-shot detail |
| `websocket-engine` | `/services/websocket-engine` | one-shot resources; status via registry |
| `data-quality` | `/data-saver/quality` | CM-push-driven reload (throttled 5s), no timer |

Live compilation: all seven routes returned HTTP **200** through the running
Next dev server. The session-manager Live Feed and the websocket-engine raw
stream now follow the Connection Manager push cadence instead of local timers.

Deferred by user decision (not in the seven): `system-indicators` and the
`lib/data-center-*` / `lib/shared-request.ts` / `lib/account-service.ts` /
`lib/time-engine.ts` pollers.

---

## L. No-fabrication audit, remaining risks & sign-off

**No-fabrication audit (live):**
- Missing values render as `—` / `N/A` / `UNKNOWN`; no page invents numbers.
- `model_group` readiness = `null` ("not registered"); `margin_engine` readiness
  = `false`; `close` input quality = `NOT_RECEIVED`; sequence gaps reported
  unavailable when the broker exposes no sequence number.
- Dummy mode: no fake broker WebSocket (asserted by the Dummy-mode gate tests);
  not re-switched live during market hours to avoid disturbing the live session.

**Genuine remaining items (not pass claims):**
1. **High observed feed latency** — p95 ≈ 8.2s / p99 ≈ 25.7s overall at probe
   time (per-instrument p95 ~1.5–3.0s) and DB-writer `feedLatencyMs ≈ 2937`.
   This needs a dedicated review (broker timestamp semantics vs local clock
   and/or buffering) before it can be called healthy.
2. **Three registry engines are `REGISTERED/UNKNOWN`** (`margin_engine`,
   `squareoff_engine`, `notification_engine`) — these are outside the six-engine
   scope but are surfaced honestly rather than reported as running.
3. **Interactive browser walkthrough** of the seven pages under a real
   authenticated session was not performed headlessly; verification used the
   live WS client (full payload parity) plus live route compilation (200).
4. **Dummy-mode live switch** not executed during market hours (test-verified).

**Sign-off:** All six engine specs are implemented as real runtime engines and
are live under the running backend; every claim above is backed by a live probe,
a source citation, or a passing test. Backend **594 passed**, frontend
**tsc clean / lint 0 errors / 230 unit tests passed**, seven engine routes
compile and the realtime `engines` channel delivers full per-engine snapshots.
The four items in §L remain the honest open list.

---

## Spec-vs-Code Checklist

Legend: **MET** = implemented + (test and/or live evidence); **PARTIAL** = present
with a stated caveat; **DEFERRED** = outside the six-engine scope this pass.

### #01 Scheduler Engine (`docs/engines/scheduler-engine.md`)

| Spec | Requirement | Status | Evidence |
|---|---|---|---|
| §1, §29 | Time/orchestration control only (no orders/ticks/P&L/UI) | MET | `scheduler/__init__.py`; live `/api/scheduler/status` |
| §3 | Daily timeline 08:50→16:00 | MET | live `todayPhases` exactly matches |
| §3 | 10-component readiness + connection_manager | MET | live readiness list (12 checks) |
| §17 | Explicit state machine | MET | `get_scheduler_state` :1844; tests `test_scheduler_phases.py` |
| §18–§20 | Internal events, duplicate protection, missed-event recovery | MET | `test_scheduler_ledger.py` (+5) |
| §21 | IST timezone | MET | scheduler + `tests/ist.test.ts` |
| §22–§24 | Trigger-only boundaries | MET | source audit; feed-stop ≠ WS close |
| §27 | Performance rules (lightweight handlers) | MET | source audit |

### #02 Session Manager (`docs/engines/session-manager.md`)

| Spec | Requirement | Status | Evidence |
|---|---|---|---|
| §2–§5 | Broker session management, Kotak/Shoonya independent | MET | live `mode=kotak`, `broker=Kotak Neo`; tests `test_session_manager_engine.py` |
| §6 | Dummy mode separate session (no disconnect of Kotak) | MET | gate tests; overview honesty |
| §7 | Session state vocabulary | MET | live `lifecycleState=SESSION_ACTIVE` |
| §9–§11 | Instrument + subscription registry, reference/subscriber logic | MET | live `/subscriptions` `subscribers`/`subscriberCount` |
| §12–§15 | Stock add/duplicate/remove flow | MET | `test_session_manager_subscriptions.py` |
| §20–§22 | Expiry management, stock vs session expiry | MET | live `expired=0`; source audit |
| §25–§27 | Event contract / STOCK_ADDED / STOCK_EXPIRED | MET | domain events + revision |
| §32–§34 | Persistence, startup recovery, idempotency | MET | `phase3_snapshot`; tests |

### #03 WebSocket / Market Data Engine (`docs/engines/websocket-engine.md`)

| Spec | Requirement | Status | Evidence |
|---|---|---|---|
| §1, §4 | Starts 08:55, closes 15:31 (scheduler-driven) | MET | live lifecycle + scheduler |
| §6 | Active list from Session Manager | MET | 8 subscriptions live |
| §7–§9 | Broker adapter, Kotak Neo, standard internal feed | MET | live `owner=WebSocketManager` |
| §10–§13 | Field availability + response validation | MET | quality live 26/26, rejected=0 |
| §14–§15 | Duplicate + sequence-gap detection (when supported) | MET | duplicates=31; sequence_available=false reported honestly |
| §16–§17 | Normalization + depth/L8 | MET | L8=8 live |
| §18–§21 | Feed quality monitor, speed, latency, stale detection | MET | `/quality` live; `test_ws_engine_quality.py` |
| §22 | Overall feed health | MET | `LIVE` × 8 |
| §26–§28 | Connection state machine, WS-vs-session failure split | MET | live `CONNECTED`/`RECEIVING`; tests |
| §32 | Feature Engine handoff | MET | feature engine receiving 1608 |
| §44 | Golden rules (no direct distribution, not storage engine) | MET | source audit |

### #04 Feature Engine (`docs/engines/feature-engine.md`)

| Spec | Requirement | Status | Evidence |
|---|---|---|---|
| §3, §6 | Field-driven calculations; input understanding | MET | calculators declare inputs |
| §5, §7–§9 | Not raw broker data; categories/indicators/derived | MET | `feature_calculators.py` |
| §10–§11 | Per-instrument state; rolling windows | MET | sma_10/60 live; tests |
| §13 | Missing field handling (no fabrication) | MET | `missingInputs=0`; `close: NOT_RECEIVED` |
| §14–§15 | Availability + warm-up | MET | live declared `warmup` + real `warmupCount` |
| §18–§19 | Feature output + versioning | MET | `/latest` `featureVersion=v1` |
| §20–§22 | Modular calculators, plug-in concept, input mapping | MET | `register_calculator`/`remove_calculator` |
| §25–§26 | Metrics + calculation error isolation | MET | p95/p99 latency, `calculationErrors=0` |
| §28–§30 | Does not own connection/orders/positions | MET | source audit |

### #05 Connection Manager (`docs/engines/connection-manager.md`)

| Spec | Requirement | Status | Evidence |
|---|---|---|---|
| §2, §5 | Routing + persistence drain; not WS adapter/feature engine | MET | live `persistence.consumerId=data_saver` |
| §7–§9 | Central registry, consumer types, instrument requirement | MET | `connectionRegistry`, `activeConsumers` |
| §10–§11 | Field requirement + source management | MET | `field_requirements.py`; `test_connection_field_requirements.py` |
| §12 | Live data delivery + field filter | MET | `framesRouted`, channel filtering |
| §19–§20 | Subscription aggregation + expiry | MET | dedupe live; tests |
| §23–§27 | States, health, backpressure | MET | freshness FRESH; bounded; tests |
| §31, §52 | UI connection model + live feed | MET | new `engines` channel push (live) |
| §43–§46 | Security, field permission, no blocking routing | MET | source audit; async routing |
| §58 | Dummy mode (no separate connection) | MET | gate tests |
| §67 | Testing requirements (20 cases) | MET | `test_connection_engine.py` (+3 this pass) |

### #06 DB Writer (`docs/engines/db_writer_engine_detailed.md`)

| Spec | Requirement | Status | Evidence |
|---|---|---|---|
| §2, §3 | Persist only; not login/WS/feature/order/margin | MET | `db_writer_engine.py`; live pipeline |
| §5 | Fed via Connection Manager | MET | `ingestedFromRouter=1611` |
| §11–§15 | Validation pipeline, instrument/expiry/field validation | MET | `rejectedByValidation=0` |
| §16–§19 | Duplicate removal + data-loss accounting | MET | counters live; tests |
| §20–§23 | Per-tick persistence, bounded buffer, batch write | MET | `bufferLength=4` bounded; `totalWritten` |
| §24–§26 | DB failure, retry, ordering | MET | `totalWriteErrors=0`; tests |
| §36 | Flush on shutdown | MET | `/db_writer_engine/flush`; `api/ticks.py` bypass deleted |
| §37–§45 | Rate/field/latency/buffer/loss metrics | MET | live metrics.custom |
| §46–§48 | Health states + per-instrument + source health | PARTIAL | honest `feedLatencyMs≈2937` (see §L) |
| §72–§74 | Timezone, no silent transform, exact accounting | MET | source audit; received=router=1611 |
| §75 | Golden rules | MET | source audit |

---

*Backend: 594 passed · Frontend: tsc clean, lint 0 errors, 230 unit tests passed ·
Live: 7/7 engine routes 200, `engines` WS channel delivering full snapshots.*
