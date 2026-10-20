# 022 — Data Center Realtime Snapshot Push over WS#2 + Page Hierarchy Redesign

- **Task:** "data-center page ko update kro, check kro, real time kam krna chye,
  redesign kro." Three explicit deliverables agreed with the user: (1) make the
  Data Center realtime, (2) fix it (its realtime section was broken), (3) redesign
  it visually/hierarchically **without removing any data**.
- **Status:** `VERIFIED_WITH_LIMITATIONS` — the broken section is fixed, the
  snapshot is now pushed over WS#2, both backend suites and the frontend
  typecheck/lint pass, and the fix + the push were runtime-verified against the
  running backend. A browser-level visual/interaction pass was **not** performed
  in this session; see §17.
- **Serial predecessor:** `docs/implementation/021-trade-page-realtime-performance.md`
- **Direct predecessor (Data Center):** `docs/implementation/017-data-center-observability-center.md`
- **Date:** 2026-10-01
- **Agent:** OpenCode

---

## 1. Task

The `/data-saver/data-center` page was reported as needing an update, a check, a
realtime improvement and a redesign. Inspecting the page's own data before
changing anything revealed that its **realtime section was already broken in the
backend**, so "make it realtime" had to start with a defect fix.

## 2. Objective

- Restore the `realtime` section of the Data Center snapshot so the page reports
  the three realtime surfaces honestly instead of an exception.
- Deliver the Data Center snapshot over the **existing** WS#2 connection
  (`/ws/realtime`) on a new `data_center` channel, with the 15 s REST poll kept
  as a fallback — no second socket, no new engine, no duplicate aggregation.
- Reorganise the very long page into a clear hierarchy (Overview → Realtime →
  Storage & pipeline → Engines → History & telemetry) with consistent section
  rhythm, keeping **every** existing panel and honest state.
- Make the page state the delivery path it is actually using.

## 3. Scope

Backend:

- `python-service/services/data_center_snapshot.py` — section classification fix
  + a short-TTL push cache getter.
- `python-service/connection_engine/channels.py` — one new state channel.
- `python-service/connection_engine/connection_engine.py` — the new producer task
  (interval, subscriber gate, frame builder, broadcast source).

Frontend:

- `lib/data-center-store.ts` — realtime snapshot intake + delivery-source state.
- `app/(phase2)/data-saver/data-center/page.tsx` — hierarchy/spacing/badge/footer.

Tests:

- `python-service/tests/test_data_center_snapshot.py` — 2 new regression tests.
- `python-service/tests/test_connection_engine.py` — 3 new tests (1 class).

## 4. Out of Scope

- No new engine, service, worker, socket or scheduler job. The Connection
  Engine's existing loop pattern was reused.
- No change to Order / Risk / Margin / Broker-Terminal engines, to the DB Writer
  persistence authority, or to the Session Manager subscription authority.
- No change to the snapshot **schema** (`schemaVersion` stays 2) or to any panel
  component in `components/data-center/`.
- No data removed from the page (explicitly excluded by the user's redesign
  choice — "Visual + hierarchy refresh, keep all data", not tabs).
- No tabs, no new navigation entries, no new page.
- No secret, no new REST route, no database write (the Data Center stays
  read-only).
- `lib/engine-realtime.ts` is **unchanged** in the final diff — see §8.2.

## 5. Source Documentation Read

- `PROJECT_IMPLEMENTATION_RULE.md` — read in full (all 71 sections).
- `docs/pending/` — `PENDING-001…004` inspected (titles/status); none is closed
  by this task, a cross-reference note was added to PENDING-001.
- `docs/implementation/017-data-center-observability-center.md` and
  `docs/verification/017-data-center-observability-center-verification.md` — the
  authoritative Data Center contract (read).
- `docs/implementation/021-trade-page-realtime-performance.md` — record format
  and the reason the realtime push is driven from a **store singleton** rather
  than a React hook (read).
- `docs/audits/backend/DATA_CENTER_OBSERVABILITY_PLANES_AUDIT.md`,
  `docs/audits/frontend/DATA_CENTER_PLANES_UI_AUDIT.md` — read, then appended to.
- Traced end-to-end before editing (rule 25): `services/data_center_snapshot.py`
  → `api/data_center.py` → `app/api/phase2/data-center/snapshot/route.ts` →
  `lib/data-center-store.ts` → `page.tsx`; and
  `api/ws_gateway.py` → `connection_engine/connection_engine.py` →
  `connection_engine/client.py` → `lib/realtime-ws.ts`.
- `WebSocket_ConnectionManager_Flow.md` contract as encoded in
  `api/ws_gateway.py` (`/ws/realtime`, state channels, envelope).

## 6. Existing State (before this task)

- The page already had a working `RealtimePanel` rendering the snapshot's
  `realtime` section (broker feed, backend fan-out, browser-measured socket).
- The snapshot already had 9 sections and was served by
  `GET /api/system/data-center/snapshot` with a 10 s server cache and a 15 s
  client poll, plus a 60 s slow poll for history/telemetry.
- The Connection Engine already pushed `engine_snapshot` → `engines` on a timer
  gated on subscribers. That pattern existed but was not used by the Data Center.
- `lib/engine-realtime.ts` already subscribed to `engines` from a React hook.

## 7. Problems Found

### 7.1 The `realtime` section was mis-classified and always failed (root cause)

`python-service/services/data_center_snapshot.py` listed **`realtime_section` in
`ASYNC_SECTIONS`**, but `realtime_section()` is a plain `def`. `build_snapshot()`
awaits every async section, so it awaited a `dict`:

```
TypeError: object dict can't be used in 'await' expression
```

Consequences: `realtime.available = false` with a `TypeError` as its reason, and
`health.overall = UNKNOWN` because the realtime health category could not be
rolled up. The page's realtime panel was therefore permanently showing a
backend error, and the page's own health strip was rendering a derived UNKNOWN.

This is a code-level fact (verifiable in the repo) plus the earlier session's
live observation of `realtime.available:false`; the "before" value was not
re-measured on a running instance in this session.

### 7.2 No realtime delivery for the Data Center document

The only path for the snapshot was the 15 s REST poll. Every other live panel on
the page (`StorageEngineLivePanel`, `EnginesLiveGrid`) already had a WS#2 push,
so the Data Center's own document was the odd one out.

### 7.3 No honest way for the UI to say which path delivered the data

The store had no notion of delivery source, so a page served by a 15 s poll was
indistinguishable from a live one.

### 7.4 Hierarchy

The page rendered ~30 panels in one flat `space-y-4` column. A reader could not
tell which panels answer "is the system up" versus "where are ticks persisted"
versus "what is the live control plane". `RealtimePanel` — the panel the user
asked about — was buried mid-page.

### 7.5 Findings that were NOT defects (recorded to avoid a wrong fix)

- `brokerFeed.connected = false` and `backendRealtime.health = NO_DATA` are
  **honest measurements** (broker not logged in this session; no market data on
  the fan-out yet), not code faults. No fake data was added to "fix" them
  (rule 21).
- A naive WS push would have re-aggregated the snapshot **per subscribed
  client** on a 5 s timer — with 2 tabs open, 2× the Mongo/session/scheduler
  work on the event loop. That is the exact class of bug fixed in 021.

## 8. Design Decision

### 8.1 Fix the classification; add a push cache, never a second aggregation

`realtime_section` moved from `ASYNC_SECTIONS` into `SYNC_SECTIONS` (`ASYNC_SECTIONS`
is now just `{storage}`, whose builder really is a coroutine). For the push path,
`services/data_center_snapshot.py` gained:

- `PUSH_TTL_S = 5.0` and a module-level `_push_cache`;
- `async def get_cached_snapshot(ttl=PUSH_TTL_S)` — returns the ONE authoritative
  document, rebuilding it at most once per TTL.

The push therefore serves *the same* document the REST route serves (no second
opinion, no per-client aggregation). It is lock-free and has a single caller (the
Connection Engine loop), which is documented in its docstring.

### 8.2 Reuse the Connection Engine's existing timer pattern

`engines` already had a `DATA_CENTER`-shaped pattern: a 5 s loop gated on
`_has_engine_subscribers()`. The Data Center mirror was added rather than a new
engine/worker/scheduler job (rules 26, 37):

- `DATA_CENTER_SNAPSHOT_INTERVAL_S = 5.0` — matches the page's 15 s poll
  freshness expectation and the 5 s push cache, so a subscriber sees a genuinely
  fresh document roughly every 5 s.
- `_has_data_center_subscribers()` — **no subscriber, no build** (identical to the
  engines gate). This is what keeps an unopened page free.
- `data_center_snapshot_frame()` — `{type: "data_center_snapshot", generatedAt,
  data: snapshot}`; the frame *is* the document, so there is no second shape to
  keep in sync.
- `_STATE_TYPE_CHANNEL["data_center_snapshot"] = "data_center"`,
  `_map_wire_type(...) = "data_center.snapshot"`, and
  `SOURCE_DATA_CENTER = "data_center"` in `_broadcast_frame` so the frame is
  attributable in logs/telemetry (rule 45: observable).
- Task created in `start()` (guarded) and cancelled in `shutdown()`.

### 8.3 Drive realtime from the store singleton, not a React hook

A `useDataCenterSnapshot()` hook was written first and then **reverted**
(`lib/engine-realtime.ts` has no net change). Reason: `useFrontendRealtime()`
re-renders its consumers at market-tick rate (~4 Hz). The Data Center is a very
long page, so a tick-rate React context there would re-render the whole page far
more often than the 5 s snapshot it is displaying. The store already owns the
snapshot, the poll and the subscriber refcount, so the push is attached in
`startTimers()` / `stopTimers()`:

- `attachRealtime()` registers `realtimeClient.onFrame` (filters
  `data_center.snapshot`, body = `frame.data?.data ?? frame.data`) and
  `onStateChange` (tracks connectivity, re-subscribes on CONNECTED), then
  subscribes `[{channel: 'data_center'}]`.
- `detachRealtime()` removes both listeners, **unsubscribes** the channel so a
  left page stops the backend from building, and clears `realtimeConnected`.
- `applyRealtimeSnapshot()` normalises through the same `normalizeSnapshot`, and
  rejects an incompatible schema, a transport-error document, or a document
  older than the one already displayed (no regression under a late REST poll).
- `refreshSnapshot()` sets `snapshotSource: 'poll'`; the push sets
  `'realtime'`. `streaming` is true only when connected, realtime-sourced and
  younger than 20 s.

WS#2 is used because it is the one authenticated, already-open socket; rule 27
("no duplicate UI") and the 021 finding both forbid opening a second one.

## 9. Files Changed

Backend:

- `python-service/services/data_center_snapshot.py` — `realtime_section` moved
  from `ASYNC_SECTIONS` to `SYNC_SECTIONS`; added `PUSH_TTL_S`, `_push_cache`,
  `get_cached_snapshot()`.
- `python-service/connection_engine/channels.py` — `STATE_CHANNELS["data_center"]
  = "aggregated Data Center snapshot (single authoritative document)"`.
- `python-service/connection_engine/connection_engine.py` —
  `DATA_CENTER_SNAPSHOT_INTERVAL_S`, `SOURCE_DATA_CENTER`,
  `_STATE_TYPE_CHANNEL["data_center_snapshot"]`, `_map_wire_type` case,
  `self._data_center_task` in `__init__`, task creation in `start()`, cancellation
  in `shutdown()`, `_has_data_center_subscribers()`, `data_center_snapshot_frame()`,
  `_data_center_snapshot_loop()`, and the `_broadcast_frame` source branch.

Frontend:

- `lib/data-center-store.ts` — `DcStoreState` += `snapshotSource`,
  `realtimeUpdatedAt`, `realtimeConnected` (+ `EMPTY_STATE`); `refreshSnapshot`
  marks `poll`; new public `applyRealtimeSnapshot()`; private `realtimeFrameOff` /
  `realtimeStateOff`; `attachRealtime()` / `detachRealtime()` wired into
  `startTimers()` / `stopTimers()`; imports `realtimeClient`.
- `app/(phase2)/data-saver/data-center/page.tsx` — `Region` helper; the body
  regrouped into 5 regions; `streaming` computation; `Live · WS#2` /
  `Polling 15s` `StatusBadge` in `PageHeader`; outer spacing `space-y-4` →
  `space-y-6`; footer now states the delivery path; removed an unused lucide
  import.

Tests:

- `python-service/tests/test_data_center_snapshot.py` — 2 new tests.
- `python-service/tests/test_connection_engine.py` — new
  `DataCenterSnapshotTests` class, 3 tests.

## 10. Files Created / Removed

- Created: this record,
  `docs/verification/022-data-center-realtime-snapshot-push-and-page-redesign-verification.md`,
  `docs/logs/LOG-005-2026-10-01-data-center-realtime-and-redesign.md`.
- Removed: none.

## 11. Backend / Frontend / Database / API / Realtime / Scheduler Changes

- **Backend:** one section-classification fix and one timer-gated producer task
  in the existing Connection Engine. No new service, no new engine, no ownership
  transfer.
- **Frontend:** store-level realtime intake + a five-region page hierarchy. No
  new state library, no new component library, no new polling (the 15 s poll
  remains as the fallback).
- **Database:** none. No collection, index, schema or write path touched; the
  Data Center remains read-only and DB Writer remains the only tick writer.
- **API:** **no REST route or contract changed.** The snapshot shape is byte-for-byte
  the schema-v2 contract; `GET /api/system/data-center/snapshot` and the Next
  proxy behave exactly as before.
- **Realtime:** one new **state** channel `data_center` on the existing
  `/ws/realtime` connection, one new frame type `data_center.snapshot`,
  5 s cadence, gated on subscribers, `source: "data_center"`. Existing channels,
  the envelope version, the schema version and the order/notification criticality
  rules are untouched.
- **Scheduler/Lifecycle:** no scheduler change. The producer is an asyncio task
  inside the Connection Engine's own lifecycle (`start()` / `shutdown()`), so it
  dies with the engine and can never outlive it.
- **Landing page / hero / session record:** not applicable — this is an
  operational page, its spec/audit pair is `017-*` plus the two audits updated in
  §12 (rule 29 only applies to major new surfaces).

## 12. Documentation Changes

- Created implementation/022, verification/022, LOG-005.
- Appended dated, cross-referenced notes to
  `docs/audits/backend/DATA_CENTER_OBSERVABILITY_PLANES_AUDIT.md` and
  `docs/audits/frontend/DATA_CENTER_PLANES_UI_AUDIT.md` (rule 11: no doc may keep
  describing obsolete behaviour — both audits described the broken `realtime`
  section and REST-only delivery).
- Added a cross-reference note to `docs/pending/PENDING-001-live-verification.md`.
- Added FINAL_REPORT §19.

## 13. Tests

Backend (venv `C:\project\.venv\Scripts\python.exe`, workdir `python-service`):

- `.venv\Scripts\python.exe -m pytest tests/test_data_center_snapshot.py tests/test_connection_engine.py -q`
- `.venv\Scripts\python.exe -m pytest -q` (full suite)

Frontend (workdir `C:\project`):

- `npm run typecheck`
- `npx eslint "app/(phase2)/data-saver/data-center/page.tsx" lib/data-center-store.ts lib/engine-realtime.ts`
- `npm run lint`
- `npm test`

## 14. Test Results

- Targeted backend: **84 passed, 21 subtests passed, 0 failed** (was 79 before
  the 5 new tests).
- Full backend suite: **1381 passed, 1 failed, 33 subtests passed**. The single
  failure is **pre-existing and unrelated**:
  `tests/test_ws_engine.py::EngineFacadeTest::test_storage_doc_flattens_full_scrip_surface`
  asserts `doc["sdk_version"] == "3.0.7"` while the installed payload produces
  `'3.0.2'`. That test file and `python-service/ws_socket/engine/` are **untracked**
  in git (earlier-session work) and were not touched by this task; the assertion
  depends on the installed Kotak SDK, not on the Data Center.
- `npm run typecheck` (`tsc --noEmit`): **exit 0, no output**.
- Targeted eslint: **0 problems** (an unused `Radio` import was introduced and
  then removed when the badge was built with `StatusBadge` only).
- `npm run lint` (whole repo): **0 errors, 340 warnings**, all pre-existing and
  all in files this task did not touch.
- `npm test`: **1 failure, the pre-existing `tests/topbar-status.test.ts:336`**
  (`INACTIVE` vs `AUTHENTICATING`, already documented in 019). Every Data Center
  test passed.

## 15. Verification (summary — full evidence in verification/022)

Backend restarted onto the new code (`start_backend.py stop`, then a fresh
launcher start; new pid 11920, `health: OK`).

- **Defect fix, over HTTP:** `GET /api/system/data-center/snapshot` → 200 with
  `realtime.available = True`, `realtime.error` empty,
  `database.connected = True`, `health.overall = DEGRADED` (no longer UNKNOWN).
  `DEGRADED` is correct here: `brokerFeed.connected = false` (no broker session)
  and `backendRealtime.health = NO_DATA` are real measurements.
- **Push, end-to-end over WS#2:** a token minted with the server's own
  `services.jwt_auth.issue_token` connected to `ws://127.0.0.1:8000/ws/realtime`;
  the `welcome` frame advertised `data_center` in `data.channels.state`;
  `subscribe {"channel":"data_center"}` returned
  `{"ok":true,"results":[{"channel":"data_center","added":0,"kind":"state"}],"errors":[]}`;
  a `type=data_center.snapshot channel=data_center source=data_center` frame then
  arrived, carrying `overall=DEGRADED` and `realtime.available=True`.
- **Route:** `http://localhost:3000/data-saver/data-center` → 307 (auth redirect,
  no 500 and no compile error).

Not verified in a browser: the visual hierarchy, the `Live · WS#2` badge
switching, and the poll fallback in the real UI (§17).

## 16. Documentation / Architecture Impact Analysis

- Connection Engine: additive. Existing channels, the `engines` loop, the outbox
  and the broadcast path are unchanged apart from one new `source` value.
- Aggregation service: additive (`get_cached_snapshot`) plus one classification
  fix. REST consumers see no difference.
- Frontend Data Center: the store gained three state fields; every consumer
  ignores unknown fields, so no other page is affected.
- The only shared-infrastructure change is `channels.py`'s `STATE_CHANNELS`, which
  is read by the `welcome` frame — that frame's `channels.state` list simply gains
  one entry.

## 17. Remaining Issues

1. **No browser-level pass.** The `Live · WS#2` badge, the five-region layout and
   the poll fallback were not observed in a real browser session in this task. The
   underlying data path is proven; the rendered result is not.
2. **Frontend unit coverage of the new store path is unchanged.** No test exists
   for `applyRealtimeSnapshot` (rejection of incompatible schema / transport
   error / older document). `lib/data-center-store.ts` is not currently exercised
   by `npm test`.
3. `get_cached_snapshot` is lock-free on the documented assumption of a single
   caller. If a second caller is ever added it needs a lock (noted in the
   docstring).
4. Pre-existing failures untouched: `tests/topbar-status.test.ts:336` and
   `test_ws_engine.py::test_storage_doc_flattens_full_scrip_surface`.
5. The first snapshot build is expensive (`buildMs` 4697 cold) because
   `storage` is the only async section and the sync sections do real work. With
   the 5 s push cache + subscriber gate this is paid at most once per 5 s while a
   page is open; a cold `curl` of the REST route still pays it.

## 18. Existing / Completed / Missing / Pending / Next

- **Existing:** the 9-section schema-v2 snapshot, the 15 s/60 s client polls, the
  `engines` WS#2 push pattern, `RealtimePanel` and every page panel.
- **Completed:** the `realtime` section is classified correctly; the snapshot is
  pushed on a new `data_center` WS#2 channel at 5 s with a subscriber gate; the
  store can ingest and label the push; the page is regrouped into 5 named regions
  and states its delivery path; 5 new backend tests; full suites run.
- **Missing:** a browser pass over the redesigned page; store-level tests for the
  realtime intake.
- **Pending:** PENDING-001, PENDING-002, PENDING-003, PENDING-004 (none closed by
  this task; evidence contributed).
- **Next:** browser verification of the redesign + the badge, then a store test
  for `applyRealtimeSnapshot`, then work PENDING-001/002 to closure.

## 19. Final Status

`VERIFIED_WITH_LIMITATIONS`

Related verification:
`docs/verification/022-data-center-realtime-snapshot-push-and-page-redesign-verification.md`

Related log: `docs/logs/LOG-005-2026-10-01-data-center-realtime-and-redesign.md`

Related audits: `docs/audits/backend/DATA_CENTER_OBSERVABILITY_PLANES_AUDIT.md`,
`docs/audits/frontend/DATA_CENTER_PLANES_UI_AUDIT.md`

Related implementation:
`docs/implementation/017-data-center-observability-center.md`,
`docs/implementation/021-trade-page-realtime-performance.md`

Related pending: `docs/pending/PENDING-001-live-verification.md`
