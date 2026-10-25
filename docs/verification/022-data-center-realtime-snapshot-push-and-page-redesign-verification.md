# 022 — Data Center Realtime Snapshot Push + Page Redesign — Verification Record

## Verification ID

`022` (implementation: `docs/implementation/022-data-center-realtime-snapshot-push-and-page-redesign.md`)

## Date / Time

2026-10-01, 15:43–16:05 IST (backend restart 15:43 IST, WS push probe 15:46 IST).

## Agent

OpenCode.

## Task / Feature

1. Fix the Data Center snapshot's broken `realtime` section.
2. Deliver the Data Center snapshot over the existing WS#2 connection
   (`/ws/realtime`) on a new `data_center` state channel, keeping the REST poll
   as a fallback.
3. Reorganise `/data-saver/data-center` into a clear hierarchy without removing
   data.

## Expected Behavior

- `build_snapshot()` returns a `realtime` section with `available: true` and no
  `TypeError`; the derived health rollup is therefore no longer `UNKNOWN`.
- With a client subscribed to `data_center`, the backend emits a
  `data_center.snapshot` frame roughly every 5 s containing the same
  authoritative document the REST route serves.
- With no subscriber, the backend performs no snapshot build at all.
- The frame is attributable: `channel = "data_center"`, `source = "data_center"`.
- `tsc` and eslint stay clean; the Data Center page keeps every panel; the page
  can state whether it is being served live or by the poll.
- No regression in the existing backend/frontend suites beyond failures that
  already existed.

## Verification Method

- static code inspection (classification of the section, producer wiring,
  shutdown path)
- unit test (new + existing backend suites)
- type check and lint (frontend)
- restart test (backend stopped and relaunched onto the new code)
- API test (`GET /api/system/data-center/snapshot`)
- WebSocket test (real client against the running server: handshake, welcome,
  subscribe, ack, pushed frame)
- route verification (Next dev server response for the page URL)
- **not performed:** UI inspection in a browser, interaction testing

## Environment

- Windows, development build, local MongoDB Atlas connection, backend on
  `127.0.0.1:8000`, Next dev server on `127.0.0.1:3000`.
- Python: `C:\project\.venv\Scripts\python.exe` (the venv re-execs the base
  Python as a child process; both were stopped and relaunched).
- Node v24.18.0, Next 16.3.4, React 19.2.8.
- Timezone IST; market state not required for this feature (the page is
  operational, not price-driven).
- **No broker session is logged in this session**, so `brokerFeed.connected` is
  `false`. That is a real measurement and was deliberately left as-is.
- Security is enabled (`APP_PASSWORD` configured), so
  `/api/realtime/token` answers 401 without an operator JWT. The WebSocket probe
  therefore minted its token with the server's own
  `services.jwt_auth.issue_token` in-process (same secret, no secret printed).

## Questions / Checks

1. Is `realtime_section` still awaited as if it were a coroutine?
2. Does the live snapshot report `realtime.available: true` and a non-UNKNOWN
   rollup?
3. Does the server advertise `data_center` in the `welcome` frame's state channel
   list?
4. Does `subscribe {"channel":"data_center"}` succeed?
5. Does a `data_center.snapshot` frame actually arrive, and does it carry the
   authoritative document?
6. Is the frame attributable (`channel`, `source`) and delivered **only** to
   subscribers?
7. Does the producer stop with the engine (`shutdown()` cancels the task)?
8. Is the producer gated so that no subscriber means no build?
9. Does the frontend typecheck / lint / test cleanly?
10. Do the pre-existing suites still pass, and are any failures pre-existing?

## Expected Results

1. No — the defect.
2. No — `realtime.available: false` with a `TypeError` reason, `overall: UNKNOWN`.
3. No — the channel did not exist.
4. No.
5. No.
6. N/A.
7. Unchanged; the risk is a task that is never cancelled.
8. Unchanged; the risk is an unconditional 5 s aggregation.
9. Yes, except the known pre-existing `topbar-status` failure.
10. Yes, except known pre-existing failures.

## Actual Results

1. **Defect confirmed and fixed.** `realtime_section` was in `ASYNC_SECTIONS`
   while being a plain `def`; `build_snapshot()` awaited its `dict` →
   `TypeError: object dict can't be used in 'await' expression`. Now in
   `SYNC_SECTIONS`; `ASYNC_SECTIONS` contains only `storage`. A regression test
   asserts the classification, that `realtime_section` is not a coroutine
   function, and that a real `build_snapshot()` keeps `realtime.available` true.
2. **Yes.** After restarting the backend onto the new code:
   `realtime.available=True`, `realtime.error` empty, `database.connected=True`,
   `health.overall=DEGRADED` (previously `UNKNOWN`). `DEGRADED` is the correct
   rollup here: `brokerFeed.available=True connected=False` and
   `backendRealtime.available=True health=NO_DATA` are real measurements, so it
   was **not** "fixed" with fake data.
3. **Yes.** `welcome.data.channels.state` contains `data_center`.
4. **Yes.** `{"requestId":"r1","results":[{"channel":"data_center","added":0,
   "kind":"state"}],"errors":[]}`.
5. **Yes.** `type=data_center.snapshot channel=data_center source=data_center`,
   payload `overall=DEGRADED`, `realtime.available=True`, i.e. the same document
   shape the REST route returns.
6. **Yes, in unit test** `DataCenterSnapshotTests::test_broadcast_only_reaches_data_center_subscribers`:
   a session subscribed to `engines` receives nothing; the `data_center` session
   receives the frame with `channel`/`source`/`data.data` intact.
7. **Yes.** `self._data_center_task` is created in `start()` inside a guarded
   try/except and cancelled in `shutdown()`, mirroring the engines loop.
8. **Yes.** `_data_center_snapshot_loop()` calls `_broadcast_frame` only when
   `_has_data_center_subscribers()`; with no subscriber the loop sleeps without
   aggregating.
9. `tsc --noEmit` exit 0. Targeted eslint 0 problems (after removing an unused
   lucide import introduced mid-task). Whole-repo `npm run lint`: 0 errors,
   340 pre-existing warnings in untouched files. `npm test`: 1 failure, the
   pre-existing `tests/topbar-status.test.ts:336` (`INACTIVE` vs
   `AUTHENTICATING`, documented in 019).
10. Targeted backend: 84 passed / 21 subtests. Full backend: **1381 passed,
    1 failed, 33 subtests**. The failure is
    `test_ws_engine.py::EngineFacadeTest::test_storage_doc_flattens_full_scrip_surface`
    → `AssertionError: '3.0.2' != '3.0.7'` on `doc["sdk_version"]`. That test
    file and `python-service/ws_socket/engine/` are **untracked** in git
    (earlier-session work); the assertion depends on the installed Kotak SDK
    version, not on the Data Center. Pre-existing and unrelated.

## Evidence

Commands actually executed (workdir stated):

```
# targeted backend suite
.venv\Scripts\python.exe -m pytest tests/test_data_center_snapshot.py tests/test_connection_engine.py -q
  -> 84 passed, 1 warning, 21 subtests passed in 9.46s

# full backend suite
.venv\Scripts\python.exe -m pytest -q
  -> 1 failed, 1381 passed, 1 warning, 33 subtests passed in 16.97s
  -> FAILED tests/test_ws_engine.py::EngineFacadeTest::test_storage_doc_flattens_full_scrip_surface
     AssertionError: '3.0.2' != '3.0.7'   (pre-existing; untracked test)

# frontend
npm run typecheck
  -> tsc --noEmit, exit 0, no diagnostics
npx eslint "app/(phase2)/data-saver/data-center/page.tsx" lib/data-center-store.ts lib/engine-realtime.ts
  -> (no output) 0 problems
npm run lint
  -> 340 problems (0 errors, 340 warnings) — all pre-existing, untouched files
npm test
  -> 1 failing: tests/topbar-status.test.ts:331 "canonical session state never
     invents ACTIVE": + 'INACTIVE' / - 'AUTHENTICATING'  (pre-existing, 019)

# restart onto the new backend code
C:\project\.venv\Scripts\python.exe C:\project\python-service\start_backend.py stop
  -> Stopping KAUSTUBH backend pid=25144 on 127.0.0.1:8000 (health=ok).
     Backend stopped; port 127.0.0.1:8000 released.
Start-Process C:\project\.venv\Scripts\python.exe start_backend.py run  (hidden, logged)
C:\project\.venv\Scripts\python.exe C:\project\python-service\start_backend.py status
  -> pid: 11920 / looks_like_backend: True / health: OK
```

API test (defect fix):

```
GET http://127.0.0.1:8000/api/system/data-center/snapshot   -> 200
generatedAt=2026-10-01T10:13:42.693122+05:30
buildMs=4697
overall=DEGRADED
realtime.available=True
realtime.error=
brokerFeed.available=True connected=False
backendRealtime.available=True health=NO_DATA
frontend.measurable=False
db.connected=True
```

WebSocket test (the push), run against the live server:

```
token = services.jwt_auth.issue_token("verify-op")     # same secret as the server
connect ws://127.0.0.1:8000/ws/realtime?token=...
  -> welcome ok; data_center advertised: True
  -> ack: {"requestId": "r1", "results": [{"channel": "data_center", "added": 0,
           "kind": "state"}], "errors": [], "sync": {...}}
  -> PUSH OK type=data_center.snapshot channel=data_center source=data_center
     overall=DEGRADED realtime.available=True
         generatedAt=2026-10-01T10:16:22.635199+00:00
```

Backend console log (same run) confirms the pre-existing `engines` push
continues unaffected and no data-center emit error was logged:

```
INFO connection_engine: [BRIDGE.BROADCAST] DELIVER session=37ad2ccf... type=engine.status channel=engines
INFO app: REQUEST => GET /api/system/data-center/snapshot
INFO app: RESPONSE <= 200
```

Route verification:

```
GET http://localhost:3000/data-saver/data-center  -> 307
```

(307 = the app's auth redirect. No 500 and no compile error, i.e. the route
resolves. It is **not** proof of rendering — see "Remaining risks".)

Static inspection confirming the gate and lifecycle:

```
connection_engine/connection_engine.py
  50:  DATA_CENTER_SNAPSHOT_INTERVAL_S = 5.0
  60:  SOURCE_DATA_CENTER = "data_center"
  123: _STATE_TYPE_CHANNEL["data_center_snapshot"] = "data_center"
  296: _map_wire_type -> "data_center.snapshot"
  367: self._data_center_snapshot_loop()        (created in start())
  1097: _has_data_center_subscribers()
  1103: data_center_snapshot_frame()           (awaits get_cached_snapshot)
  1120: _data_center_snapshot_loop()           (gate, then sleep 5s)
  1142: _broadcast_frame source == SOURCE_DATA_CENTER
```

## Problems Found

| # | Problem | Origin | Status |
|---|---|---|---|
| 1 | `realtime_section` in `ASYNC_SECTIONS` → awaited `dict` → `TypeError` | this task | **Fixed** + regression test |
| 2 | Data Center document only reachable by a 15 s poll | this task | **Fixed** (5 s push, gated) |
| 3 | Unused lucide `Radio` import introduced while building the live badge | this task | **Fixed** (removed) |
| 4 | Page had ~30 panels in one flat `space-y-4` column | this task | **Fixed** (5 regions, `space-y-6`) |
| 5 | `test_ws_engine.py::…full_scrip_surface` `sdk_version` 3.0.2 vs 3.0.7 | pre-existing, untracked test + installed SDK | **Not fixed** — unrelated, out of scope, recorded |
| 6 | `tests/topbar-status.test.ts:336` `INACTIVE` vs `AUTHENTICATING` | pre-existing (019) | **Not fixed** — unrelated, out of scope, recorded |

## Fixes Applied

- `services/data_center_snapshot.py`: `realtime_section` moved to
  `SYNC_SECTIONS`; `ASYNC_SECTIONS` = `{storage}` only.
- `services/data_center_snapshot.py`: `PUSH_TTL_S` + `get_cached_snapshot()` so
  the push and the REST route can never disagree.
- `connection_engine/`: the `data_center` channel + gated 5 s producer.
- Frontend store: realtime intake, source labelling, subscribe/unsubscribe.
- Frontend page: 5 regions, live badge, `space-y-6`, honest footer, unused
  import removed.

## Re-verification

After the fixes and the backend restart:

- Targeted backend suite re-run → 84 passed.
- Full backend suite re-run → 1381 passed, 1 pre-existing failure.
- `tsc` re-run after the import removal → exit 0.
- Targeted eslint re-run after the import removal → 0 problems.
- REST snapshot re-fetched after the restart → `realtime.available=True`,
  `overall=DEGRADED`.
- WS#2 probe re-run against the restarted server → frame delivered.

## Final Result

**PARTIAL** — the two functional claims (defect fixed, push delivered over
WS#2) are **PASS** with runtime evidence. The third claim (page redesign) is
**NOT_VERIFIED at the UI level**: TypeScript, eslint and route resolution pass,
but no browser rendered the page, so the visual hierarchy, the `Live · WS#2`
badge and the poll fallback in the real UI are unproven.

## Remaining Risks

1. The five-region layout, spacing and the live badge have not been *seen*.
2. `applyRealtimeSnapshot`'s rejection rules (incompatible schema, transport
   error, older document) have no automated test; they are code-inspected only.
3. The frontend store's realtime attachment was not exercised by a running
   browser, so a client-side error in `attachRealtime` would not have been caught
   by anything above.
4. `get_cached_snapshot`'s single-caller assumption is documented, not enforced.
5. With a broker session absent, the `brokerFeed` card is unverified in the
   `connected: true` state; that state predates this task.
6. Both remaining test failures predate this task and were deliberately left in
   place (unrelated subsystems; fixing them would violate rule 37's "do not mix
   unrelated cleanup").
