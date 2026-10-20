# 027 — Connection Manager UI redesign

## Verification ID

027

## Date / Time

2026-10-07, 00:45–01:20 IST. Backend server clock reported
`2026-10-07T00:57:15+05:30` during the field probes.

## Agent

OpenCode (space-bunny-free), working to `PROJECT_IMPLEMENTATION_RULE.md` v1.0.

## Task / Feature

Re-read the Connection Manager engine documentation and redesign the engine's UI and
every page inside it from scratch.

## Expected Behaviour

1. Every value a page renders comes from a field the backend actually sends.
2. Every value the backend does not send is declared absent, never faked.
3. The pages implement what `docs/engines/connection-manager.md` specifies — in
   particular §50 diagnostics and §51 health-dashboard metrics.
4. Offline / stale / no-data states are explicit, per `FRONTEND_DATA_FLOW.md:119-130`.
5. All four mandated routes exist, compile and serve.
6. TypeScript and lint pass.
7. All data comes through one transport.

## Verification Method

- full read of the 2,634-line engine specification
- field-by-field comparison of the pre-existing pages against **live** backend responses
- a purpose-written field-contract verifier asserting every field path the UI reads
- negative assertions that the previously-read non-existent keys are genuinely absent
- `npx tsc --noEmit`
- `npx eslint`
- HTTP status checks on the four routes and the four API proxies
- headless-browser render attempt (failed — recorded below)

## Environment

- OS: Windows, PowerShell 5.1
- Backend: `python-service` uvicorn on `127.0.0.1:8000`, Python 3.12 (`.venv`)
- Frontend: Next.js dev server on `localhost:3000`
- MongoDB: reachable (`kaustubh`)
- Gateway state: 1 session attached, 347 frames delivered, `health.state=HEALTHY`,
  `health.feed=NO_DATA`, `backpressure.policy=DROP_OLDEST`, `queueLimit=1000`
- Broker feeds: **not connected** — `WS#1 connected=false`
  (`state=WAITING_FOR_MARKET_WINDOW`), `WS#2 connected=false` (`state=OF_AUTH_REQUIRED`)
- Market: closed (00:57 IST)
- Timezone: Asia/Kolkata
- Secrets: none recorded

The closed market is why `feed=NO_DATA` — the feed freshness is honest, not broken, and it
gave a real example of spec §28's "health and data quality are separate".

## Questions / Checks

| # | Check | Method |
|---|---|---|
| C1 | Do the 4 mandated routes exist and serve? | HTTP GET via Next dev server |
| C2 | Does the Overview read only real fields? | field verifier |
| C3 | Does Connections read only real fields? | field verifier |
| C4 | Does Events read only real fields? | field verifier |
| C5 | Does Configuration read only real fields? | field verifier |
| C6 | Are the previously-read `state` / `timestamp` keys genuinely absent? | negative assertions |
| C7 | Is `health.feed` a string, not an object? | type assertion |
| C8 | Is `/api/realtime/fields` an object, not an array? | type assertion + non-empty counts |
| C9 | Are state-channel config values strings while market channels are objects? | type assertions |
| C10 | Do all four API proxies return `ok=true`? | HTTP GET |
| C11 | Does TypeScript pass? | `npx tsc --noEmit` |
| C12 | Does lint pass with zero warnings? | `npx eslint` |
| C13 | Does the page render in a browser? | headless Chromium `--dump-dom` |

## Expected Results

- C1 four × HTTP 200
- C2–C5 all field paths present
- C6 both absent
- C7 string
- C8 object, `ws` non-empty
- C9 strings / objects respectively
- C10 four × `ok=true`
- C11 exit 0
- C12 exit 0, 0 warnings
- C13 rendered DOM containing the page's own copy

## Actual Results

### C1 — routes: PASS
```
GET /services/connection-manager              -> HTTP 200  len=13460
GET /services/connection-manager/connections  -> HTTP 200  len=13512
GET /services/connection-manager/events       -> HTTP 200  len=13492
GET /services/connection-manager/configuration-> HTTP 200  len=13520
```
All four routes compile and serve. The bodies are the shell plus the loading skeleton
because each implementation is a client component whose data arrives after mount.

### C2–C5 — field contract: PASS (137 assertions, 0 failures)

Every field path the redesigned UI reads was asserted against a live response:

```
PASSED 137   FAILED 0
```

Breakdown of what was asserted:

| Surface | Assertions | Examples |
|---|---|---|
| `connectionEngine` top level | 15 | `started`, `framesRouted`, `channelMetrics`, `backpressure`, `freshness`, `lifecycle`, `health`, `lastEvents`, `connectionRegistry` |
| `stats` | 5 | `activeConnections`, `messagesRouted` |
| `backpressure` | 6 | `policy`, `queueDepthTotal`, `droppedCritical` |
| `health` | 9 | `feed`, `persistErrors`, `checkedAt`, `reason` |
| `connectionRegistry[]` | 26 | `status`, `lifecycleState`, `deliveryRatePerSec`, `queueLimit`, `lastTransitionAt`, `lastReason`, `fieldStatus` |
| event rows | 9 | `seq`, `ts`, `epoch`, `level`, `eventType`, `channel`, `connectionId`, `eventId`, `detail` |
| `channelMetrics[]` | 6 | `kind`, `profileId`, `priority`, `minIntervalS`, `subscribers`, `delivered` |
| `architecture` | 11 | all 7 transports, `WS#3.sessions`, `WS#4.endpoint`, `Event Bus.implementation` |
| `order-feed` | 9 | `state`, `connected`, `totalOrderUpdates`, `reconnectAttempt` |
| `sessions[]` | 9 | `outboxSize`, `ticksSent`, `framesSent` |
| `config` | 10 + 5 | envelope, thresholds, `channels.market[]`, `channels.state` |
| `fields` | 5 | `sources`, `ws`, `features`, `aliases`, non-empty `ws` |

### C6 — negative assertions: PASS
```
registry[].status is a STRING (was 'state')   -> True   ("ACTIVE")
registry[].state absent (old bug key)         -> True
event.epoch is numeric                        -> True
event.eventType is str                        -> True
event.timestamp absent (old bug key)           -> True
```
This is the direct proof that D1 and D2 were real defects and are now fixed: the keys the
old pages read do not exist, and the keys the new pages read do.

Live values captured during the check:
```
registry[0].connectionId = 516e713ea0e941db92e2f01aebe7909a
registry[0].status       = ACTIVE
registry[0].lifecycleState = ACTIVE
registry[0].channels     = ["engines"]
registry[0].deliveryRatePerSec = 0.46
registry[0].messagesDelivered  = 347
registry[0].lastReason    = "fan-out loop started"

event[0].seq = 359
event[0].ts  = 2026-10-07T00:57:15.008435+05:30
event[0].epoch = 1791314835.008436
event[0].eventType = broadcast.delivered
event[0].channel = engines
```

### C7 — `health.feed` is a string: PASS
```
health.feed = "NO_DATA"        (type str)
health.state = "HEALTHY"
health.reason = "feed=NO_DATA, active=1, dropped=0"
```
Confirms D5. The redesigned page renders `feed` as a freshness string and keeps it visibly
separate from `state`, which is exactly what spec §28 requires.

### C8 — `fields` is an object: PASS
```
type: dict   keys: ['sources', 'ws', 'features', 'aliases']
sources : 2   first="MARKET_DATA_WEBSOCKET"
ws      : 32  first="auction"
features: 6   first="change"
aliases : {close: prev_close, prevClose: prev_close, lastPrice: ltp, bid: buy, ask: sell}
```
Confirms D3. 32 real WebSocket fields and 6 feature fields were being discarded by the old
`Array.isArray` check; the redesigned Configuration page now lists and searches them.

### C9 — heterogeneous channel config: PASS
```
config.channels.market["market_watch"] = {"profileId":"WATCHLIST_LIGHT","priority":"P2","minIntervalS":1.0}
config.channels.state["orders"]         = "order.* lifecycle events"   (a string)
```
Confirms D4: the old page treated state channels as objects and rendered
`orders — kind=?, profile=?, priority=?`. The new page lists state channels as name plus
description string.

### C10 — proxies: PASS
```
GET /api/realtime/health                          -> HTTP 200 ok=True len=230
GET /api/realtime/fields                          -> HTTP 200 ok=True len=682
GET /api/realtime/architecture                    -> HTTP 200 ok=True len=960
GET /api/services/engines/connection_manager      -> HTTP 200 ok=True len=12915
```
All four transports the pages depend on return real data, so the redesign reads from
exactly the endpoints it claims to.

### C11 — TypeScript: PASS
```
npx tsc --noEmit   -> exit 0, no output
```

### C12 — lint: PASS
```
npx eslint app/_pages/connection-manager
first pass:  0 errors, 4 warnings
  page.tsx:40    'MetricCard' is defined but never used
  page.tsx:66    'fmtIso' is defined but never used
  connections.tsx:72  'registry' logical expression could change useMemo deps (x2)
fixed -> rerun: exit 0, 0 errors, 0 warnings
```

### C13 — browser rendering: **NOT VERIFIED**
```
headless Chromium 1243, --headless=new --virtual-time-budget=15000 --dump-dom
  -> empty output (len=0); a bounded PowerShell job attempt also returned len=0
```
The render attempt produced nothing usable, so **nothing about the rendered page is
claimed**. What is proven for the UI is: the routes compile, TypeScript type-checks
against the real payload shapes, lint is clean, and all 137 field reads resolve against
live data. Whether the page *looks* correct in a browser is untested.

## Evidence

Commands actually run from `C:\project` unless noted:

| Purpose | Command |
|---|---|
| live field probes | `.venv\Scripts\python.exe` urllib script over `127.0.0.1:8000` |
| field-contract verifier | `.venv\Scripts\python.exe cm_verify.py` — 137 assertions |
| backend health | `Invoke-WebRequest http://127.0.0.1:8000/health` → 200 |
| route checks | `Invoke-WebRequest http://localhost:3000/services/connection-manager{,/connections,/events,/configuration}` |
| proxy checks | `Invoke-WebRequest http://localhost:3000/api/realtime/{health,fields,architecture}`, `/api/services/engines/connection_manager` |
| typecheck | `npx tsc --noEmit` |
| lint | `npx eslint app/_pages/connection-manager` |
| render attempt | headless Chromium `--dump-dom` |

## Problems Found

Sixteen frontend defects, D1–D16, each with reproduction and fix in
`docs/implementation/027-connection-manager-ui-redesign.md`. The four that made the pages
actively misleading rather than merely empty:

| # | Problem | Why it mattered |
|---|---|---|
| D1 | read `state`, backend sends `status` | every connection state badge was `—`; the alive count silently equalled the total |
| D2 | read `timestamp`/`type`, backend sends `epoch`/`ts`/`eventType` | event Time and Type columns were `—`; the by-type summary collapsed to `?` |
| D3 | `Array.isArray` on an object response | the entire 38-field catalogue was permanently empty |
| D9 | `source`/`connected` returned then discarded | a stale REST snapshot was indistinguishable from a live feed, violating the documented UI staleness contract |

## Fixes Applied

See the implementation record § Design Decision and § Files Changed. Every fix was
re-verified by the check that originally failed; the re-verification table is above.

## Re-verification

- C2–C5 rerun after the final edits: 137 / 137 pass
- C6 rerun: both negative assertions hold
- C11 rerun after the lint fixes: exit 0
- C12 rerun after the lint fixes: exit 0, 0 warnings

## Final Result

**PARTIAL**

Every defect that caused the Connection Manager UI to display wrong or missing data is
fixed and proven fixed against live backend payloads, the four routes serve, the API
dependencies work, and TypeScript and lint are clean. It is not a PASS because the
rendered page was never seen — C13 failed — and because no live gateway session with real
tick traffic was observed.

## Remaining Risks

1. **Rendered appearance unknown.** Compilation and data-contract correctness do not prove
   layout, contrast or responsive behaviour. This is the largest gap.
2. **Realtime path unobserved.** All evidence is from REST snapshots with
   `feed=NO_DATA` and both broker feeds disconnected. No tick flood was seen, so the
   §51 derived metrics (`messages/sec`, stale count) were never exercised against real
   movement.
3. **D11 mitigation unproven.** The 16 KB WS-record projection can trim
   `connectionEngine` into `omittedFields`; the redesign degrades to fewer values rather
   than blanking, but that path was never actually triggered.
4. **Two spec §51 metrics are unimplemented** (`bytes/sec`, average delivery latency)
   because the backend measures neither. Shown as `NOT_PROVIDED`, not estimated.
5. **Two spec views have no endpoint** (spec §29 connection history, §20 expiry history).
   Declared in the UI.
6. **Backend `/api/realtime/fields` returns 32 WS fields** — the catalogue is rendered
   from that list, so if the backend adds or removes a field the UI follows
   automatically; no UI-side list is hardcoded, which is the correct coupling.

## Related

- Specification: `docs/engines/connection-manager.md` (§7, §8, §10, §11, §13, §23, §26,
  §28, §31, §38, §39, §47, §50, §51, §56, §65, §68)
- Implementation: `docs/implementation/027-connection-manager-ui-redesign.md`
- Frontend audit: `docs/audits/frontend/CONNECTION_MANAGER_UI_AUDIT.md`
- Frontend contract: `docs/frontend/FRONTEND_ROUTE_MAP.md`, `FRONTEND_DATA_FLOW.md`
- Engine log: `docs/logs/LOG-009-2026-10-07-connection-manager-ui-redesign.md`
