# 027 — Connection Manager UI: full redesign against the engine spec

## Task

Chat request (Hindi/Urdu, romanised): *"http://localhost:3000/services/connection-manager
es engine k doc re-read kro aur ese aur eske andar saare page ko 0 se redesign kro"* — read
the engine's documentation, and redesign this engine and every page inside it from
scratch.

## Objective

Bring the entire Connection Manager Service Control Center UI into conformance with
`docs/engines/connection-manager.md`, and make it truthful: every value must come from a
field the backend actually sends, and every value the backend does not send must be
declared absent rather than faked.

## Scope

The four Service-phase Connection Manager routes and their shared implementation:

- `/services/connection-manager` (Overview)
- `/services/connection-manager/connections`
- `/services/connection-manager/events`
- `/services/connection-manager/configuration`

## Out of Scope

- **No backend change.** The engine, the gateway, the field resolver and the event ring
  were read and verified but not modified. Every defect found was a frontend defect.
- **No new route.** `docs/frontend/FRONTEND_ROUTE_MAP.md:166-172` mandates exactly four
  routes; all four already existed and all four had real pages. Adding a fifth would
  violate the no-duplicate-UI rule.
- **No control-plane writes.** Spec §13/§38 make the gateway control surface read-only
  (status, metadata, diagnostics). Pause / resume / delete were deliberately **not**
  added, because the backend exposes no write endpoints and faking buttons would be a
  lie.
- **No change to other engines' pages.** Market Watch, Watchlist, Trading and Data-Saver
  were untouched.
- **No new shared primitives.** Everything reuses `components/design-system.tsx` and
  `components/ui/*` rather than introducing another table/card/badge implementation.

## Source Documentation Read

- `C:\project\PROJECT_IMPLEMENTATION_RULE.md` (§1–§62, whole file)
- `C:\project\docs\engines\connection-manager.md` — **read in full, 2,634 lines / 69
  sections** plus the trailing IMPLEMENTATION STATUS block
- `C:\project\docs\frontend\FRONTEND_ROUTE_MAP.md` — the canonical 4-route mandate (lines
  166–172)
- `C:\project\docs\frontend\FRONTEND_DATA_FLOW.md` — dual-transport pattern, realtime
  client lifecycle, and the UI error/staleness contract (lines 20–42, 101–130)
- `C:\project\docs\frontend\FRONTEND_ARCHITECTURE.md`, `FRONTEND_CONTRACT.md`
- `C:\project\docs\engines\reports\CONNECTION_MANAGER_ENGINE_IMPLEMENTATION_REPORT.md`
- `C:\project\docs\audits/backend/DATA_CENTER_OBSERVABILITY_PLANES_AUDIT.md` (the only file
  in `audits/backend`)
- `C:\project\docs\audits/MARKET_WATCH_STATUS.md` (connection-manager interactions)
- `C:\project\docs\pending/PENDING-001…004`
- Existing implementation, before any change (PROJECT_IMPLEMENTATION_RULE §36):
  `app/_pages/connection-manager/{page,connections,events,configuration}.tsx` (1,006 lines
  total) and `connection-manager-data.ts`
- `components/layout/nav.ts:503-512` (nav entries), `lib/system-engines.ts:171-188`,
  `components/design-system.tsx`, `lib/engine-realtime.ts`, `lib/api.ts`,
  `tests/nav-utils.test.ts`

## Existing State

The engine was healthy and serving rich data. The UI was reading it almost entirely
wrong.

Live backend at the time of redesign:

```
GET /api/services/engines/connection_manager -> ok, 1 session, 347 frames delivered
connectionEngine.channelMetrics -> 11 channels (market_watch, trading, engines, ...)
connectionEngine.backpressure    -> DROP_OLDEST, queueLimit 1000
connectionEngine.health.state    -> HEALTHY, health.feed -> "NO_DATA" (a STRING)
connectionEngine.lastEvents      -> 8 events, keys: seq/ts/epoch/level/eventType/channel/...
connectionRegistry               -> 1 row, 26 keys, status="ACTIVE"
```

All four pages existed, all four compiled, all four were reachable, and all four were
materially broken because they read field names the backend never sends.

## Problems Found

Sixteen defects across the four pages, all reproduced by reading the pages against live
backend responses before changing anything. Severity as found.

### D1 — HIGH — every connection state badge was a permanent em-dash
Pages read `s.state`. The backend sends **`status`** (plus a separate `lifecycleState`).
Every state badge rendered `—`, and the "by lifecycle state" histogram collapsed into a
single `UNKNOWN` bucket, which also made the "alive (non-terminated)" count silently
equal the total.

### D2 — HIGH — event Time and Type columns were permanent em-dashes
Pages read `e.timestamp ?? e.time` and `e.type ?? e.event_type`. The backend sends
**`epoch`** (epoch seconds), **`ts`** (ISO string) and **`eventType`**. The "By type"
summary card collapsed to one `?` bucket as a direct consequence.

### D3 — HIGH — the field catalogue was permanently empty
`configuration.tsx` ran `GET /api/realtime/fields` through `Array.isArray(...)`, but the
endpoint returns an **object** `{sources, ws, features, aliases}`. The card always
showed `0` fields and "No fields in catalogue", discarding 32 real WebSocket fields and 6
feature fields.

### D4 — MEDIUM — nine configuration keys that do not exist
`eventSequenceEnabled`, `idleTimeoutS`, `closedDelayAfterStopS`, `maxQueuedPerConnection`,
`maxQueuedEnvelopeBytes`, `maxActiveConnections`, `maxRequestsPerMinute`, `sourceEnum`, and
per-channel `kind` / `priority` / `burstWindowS` are not emitted by
`connection_engine.config()`. `sourceEnum` also caused array-to-string concatenation in
React (`"MARKET_DATA_WEBSOCKETFEATURE_ENGINE"`, no separator).

### D5 — MEDIUM — `health.feed` treated as an object
`page.tsx` read `h.feed.source`. `health()["feed"]` is a plain freshness string.

### D6 — MEDIUM — six per-connection detail fields that do not exist
`connectingAt`, `connectedAt`, `enqueuedAt`, `lastApprovedAt`, `sequence`,
`ticksPersisted`. `session_records()` has none of them, and its profile field is
`profiles` (an array), not `profileId`.

### D7 — MEDIUM — request fired on every keystroke
`events.tsx` had `useEffect(() => load(), [load])` where `load` depended on five filter
strings, so typing produced a request per character.

### D8 — MEDIUM — unvalidated `limit` could only ever 422
`limit` was free text; the backend enforces `ge=1, le=500`.

### D9 — MEDIUM — no offline or stale handling anywhere
All four pages returned `source` and `connected` from their hook and discarded them.
`components/design-system.tsx` exports a `LiveIndicator` primitive that no Connection
Manager page used. This directly violates the UI staleness contract in
`FRONTEND_DATA_FLOW.md:119-130` (`NO_DATA` not zeros; `STALE` with an age indicator;
`UNKNOWN` never guessed; a connection indicator when WS is down).

### D10 — MEDIUM — two pages bypassed the Next proxy
`connections.tsx` and `events.tsx` called `lib/api.ts`, whose `API_BASE` defaults to
`http://127.0.0.1:8000` — cross-origin, cookie-less, and broken by any deployment where
the backend is not on localhost — while the other two pages used the relative
`/api/realtime/*` proxy.

### D11 — LOW — the live page could blank out under WS projection
`_compact_engine_status` bounds each engine record to 16 KB and reports trimmed keys in
`omittedFields`. Once a realtime frame won over the REST fallback, a trimmed
`connectionEngine` would leave the whole page rendering em-dashes with no explanation.

### D12 — LOW — four served-but-unconsumed endpoints wasted
`/api/realtime/status`, `/api/realtime/sessions`, `/api/realtime/order-feed` and
`/api/realtime/architecture` are all live and all returned `ok`. `architecture` in
particular renders spec §47 (data ownership) as real data and was entirely unused.

### D13 — LOW — dead code
Unused imports `Cable`, `Card*`, `MetricCard`, `HEALTH_TONE`; unused exports `fmtTs`,
`useConnectionManagerStatus`; an unused `numericBlocks` variable; and
`lib/api.ts:380-381` `getRealtimeHealth` / `getRealtimeConfig` defined but never called.

### D14 — LOW — duplicated formatters
`fmtNum` / `fmtClock` / `fmtEpoch` / `fmtDuration` existed in four places, and the
Connection Manager copy did not pin `Asia/Kolkata`, so it rendered in the browser's
timezone.

### D15 — LOW — hand-rolled primitives
Four raw `<table>` blocks and roughly twelve bespoke label/value row implementations,
where `components/ui/table.tsx` already exports the full Table family.

### D16 — LOW — misleading headers
The registry badge counted "non-empty rows" and read as a record count; the events badge
labelled `total` when the backend already caps it at `limit`; `connections.tsx` mixed `'…'`
with the app's `'—'` convention.

## Design Decision

**1. The types are the contract.** `cm-shared.tsx` declares every backend shape verbatim,
verified field-by-field against live responses. This is the root fix: the previous defect
class (reading a key that does not exist) is now a compile-time-visible, reviewable list
rather than a silent em-dash at runtime.

**2. Provenance over polish.** Every spec §51 aggregate carries a `derived` / `absent`
badge. `paused`, `failed`, `expired`, `reconnecting`, `consumers connected` and
`messages/sec` are genuinely computable from reported values, so they are shown — but
labelled, with their derivation spelled out. `bytes/sec` and `average delivery latency`
have **no** backend source, so they render `NOT_PROVIDED` with the reason. The spec
mandates the metric; the backend does not measure it. Inventing it would be worse than
declaring the gap.

**3. Health and data quality stay separate (spec §28).** The gateway is `HEALTHY` while
the feed is `NO_DATA`. The Overview shows two independent badges rather than blending
them, because a socket can be perfectly connected while the source data is stale.

**4. Read-only is a feature, not a limitation.** Spec §38 keeps the gateway API for
status/metadata/diagnostics; the control endpoints are read-only. Rather than add
pause/resume buttons with no backend, the Connections page states plainly that those are
control-plane operations and offers nothing fake.

**5. Everything through one transport.** All calls use the relative Next proxy, so auth
cookies and the configured backend base live in one place.

**6. Reuse over reinvention.** `PageHeader`, `SectionCard`, `StatusBadge`, `EmptyState`,
`LoadingState`, `ErrorState`, `StatCard`, `LiveIndicator` from the design system; the
`Table` family, `Input` and `Button` from `components/ui`. Four new small local
primitives (`KV`, `KVGrid`, `AggregateTile`, `TokenList`) removed twelve duplicated
implementations.

**7. Own the timezone.** Every timestamp formatter pins `Asia/Kolkata` explicitly. Market
Watch timestamps are IST by definition; the browser's zone is not authoritative.

## Files Changed

| File | Change |
|---|---|
| `app/_pages/connection-manager/cm-shared.tsx` | **new** (replaces `connection-manager-data.ts`) — backend-exact types, all API clients, hooks, `useDebounced`, IST-pinned formatters, tone vocabularies, `buildAggregates`, `KV`/`KVGrid`/`AggregateTile`/`TokenList` |
| `app/_pages/connection-manager/page.tsx` | rewritten — spec §51 dashboard, §47 transport ownership, §26/§27/§28/§56 health, channel table, persistence + observed order feed, event preview, explicit not-available panel |
| `app/_pages/connection-manager/connections.tsx` | rewritten — spec §50's ten diagnostic fields in the spec's own order, real `status` filtering, live state histogram, stale filter, search, field-availability panel, honest "no write controls" note |
| `app/_pages/connection-manager/events.tsx` | rewritten — real `epoch`/`ts`/`eventType`, debounced filters, bounded limit select, click-to-filter type/level summaries, no invented event vocabulary |
| `app/_pages/connection-manager/configuration.tsx` | rewritten — real field-catalogue object with search, per-channel tables, correct state-channel string handling, zero invented config keys |
| `app/_pages/connection-manager/connection-manager-data.ts` | **deleted** — superseded by `cm-shared.tsx`; had no remaining importer |

## Files Created

- `app/_pages/connection-manager/cm-shared.tsx`

## Files Removed

- `app/_pages/connection-manager/connection-manager-data.ts` (148 lines) — its types were
  partly wrong, which is the origin of D1/D2/D5; its formatters were a duplicate copy.

Route shells under `app/(services)/services/connection-manager/` were **not** changed: all
four already pointed at the right implementations and all four are mandated by
`FRONTEND_ROUTE_MAP.md:166-172`.

## Backend Changes

None. No Python file was modified.

## Frontend Changes

**Overview** — Gateway (state, uptime, sessions, frames routed, channel counts); Health &
freshness (health badge, feed badge, reason, last-tick age, the three thresholds,
heartbeat); Backpressure (policy, limit, depth total/max, dropped market/critical);
Transport ownership rendered from `/api/realtime/architecture` — seven cards naming
WS#1/WS#2/WS#3/WS#4/REST/Broker REST/Event Bus with their real owner, direction, purpose
and state, with the gateway's own two transports highlighted; a delivery-channel table
over all 11 channels; live-connection summary; persistence plus the WS#2 order feed shown
as *observed, not owned*; a recent-events preview; and a closing panel naming the two
spec metrics and the connection-history view that have no backend source.

**Connections** — the ten spec §50 fields (Connection, Consumer, Instrument, Source,
Fields, Status, Last Data, Delivery Rate, Queue, Errors) in the spec's exact order, then
the supporting detail; a status histogram built from the real `status`; an Alive /
Terminated / Stale filter that uses the configured `staleAfterS` threshold; search across
connection, consumer, type, username and channels; and a per-connection field-availability
panel (spec §10).

**Events** — correct Time/Level/Type/Channel/Connection/Detail columns; five debounced
filters plus a bounded limit select; type and level summaries whose chips apply as
filters; suggestions drawn only from event types actually present in the ring, so the
page never offers a filter the backend cannot satisfy.

**Configuration** — envelope/runtime, backpressure/delivery, sources and aliases, a market
channel table, a state channel list, and the full field-availability catalogue with search
across WebSocket fields, feature fields and aliases.

## Database Changes

None.

## API Changes

None. No endpoint was added, removed or changed. Four existing endpoints that the UI
previously ignored are now consumed:

| Endpoint | Newly consumed by | Purpose |
|---|---|---|
| `GET /api/realtime/architecture` | Overview | spec §47 ownership, WS#1–#4 |
| `GET /api/realtime/order-feed` | Overview | WS#2 order/position feed state, observed |
| `GET /api/realtime/sessions` | `cm-shared` (available) | live gateway sessions |
| `GET /api/realtime/status` | superseded by the engine endpoint | — |

## Realtime Changes

No new channel and no new event. The Overview and Connections pages inherit the existing
`engine.status` push on the `engines` channel through `useEngineStatus`, and each page
header states its provenance — `live` versus `REST snapshot` versus `offline` — via
`LiveIndicator`, so a snapshot is never displayed as if it were a live feed. The Events
page is deliberately snapshot-only: it reads a bounded ring on demand.

## Scheduler/Lifecycle Changes

None.

## Documentation Changes

- `docs/audits/frontend/CONNECTION_MANAGER_UI_AUDIT.md` — created; no Connection Manager
  frontend audit existed.
- `docs/frontend/FRONTEND_ROUTE_MAP.md` — annotated the 4-route block to name the shared
  implementations and the read-only control-plane constraint.
- `docs/verification/027-connection-manager-ui-redesign.md` — created.
- `docs/logs/LOG-009-2026-10-07-connection-manager-ui-redesign.md` — created.

## Tests

No unit or component test framework exists for these pages and none was added (adding one
would be a separate, larger decision). What was executed instead:

- `npx tsc --noEmit`
- `npx eslint app/_pages/connection-manager`
- a purpose-written field-contract verifier (`docs/verification/027-…`, Evidence) that
  asserts **137 field paths** read by the UI against **live** backend responses
- HTTP checks on all four routes through the running Next dev server
- HTTP checks on the four API proxies the pages call

## Test Results

Actual:

- `npx tsc --noEmit` → **exit 0**, no output
- `npx eslint app/_pages/connection-manager` → **exit 0**, 0 errors, 0 warnings
  (first pass reported 4 warnings — two unused imports and a `useMemo` dependency on a
  non-memoised `registry` — all fixed)
- field-contract verifier → **PASSED 137, FAILED 0**
- `GET /services/connection-manager{,/connections,/events,/configuration}` → **HTTP 200**
  for all four
- `GET /api/realtime/{health,fields,architecture}` and
  `GET /api/services/engines/connection_manager` → **HTTP 200, `ok=true`**

## Verification

Full evidence in `docs/verification/027-connection-manager-ui-redesign.md`. Summary:

- 137 field paths asserted against live payloads, including negative assertions that the
  old broken keys (`registry[].state`, `event.timestamp`) are genuinely absent
- all four routes compile and serve 200
- every proxy the pages depend on returns real data
- TypeScript and lint clean

Not proven: in-browser rendering and live-socket behaviour. See Remaining Issues.

## Remaining Issues

1. **No browser rendering verification.** A headless Chromium attempt returned an empty
   DOM, so what is proved is that the routes compile and their data contracts are correct
   — not that the rendered page looks right. Recorded as `NOT_VERIFIED`.
2. **Live socket path unverified.** All probes were REST snapshots; `feed=NO_DATA` and
   `WS#1/WS#2` were not connected, so no real tick flood was observed. D11 (the 16 KB WS
   projection trim) is therefore mitigated but not observed.
3. **`bytes/sec` and `average delivery latency` have no backend source.** Surfaced as
   `NOT_PROVIDED`; closing them needs a backend change, which was out of scope.
4. **Spec §29 connection history and §20 expiry history have no endpoint.** Declared in
   the UI rather than filled in.
5. **Spec §39's full 23-event model is not implemented** by the backend; the Events page
   deliberately offers no filter for an event type the ring cannot contain.
6. **Formatters are still duplicated** across `lib/system-engines.ts`,
   `components/design-system.tsx`, `app/_pages/session-manager/sm-shared.tsx` and now
   `cm-shared.tsx`. Consolidating them is a cross-cutting task, not a Connection Manager
   task.
7. **`lib/api.ts:380-381`** `getRealtimeHealth` / `getRealtimeConfig` remain unused by
   these pages (they go through `cm-shared`). Left alone to avoid touching shared code.

## Pending Work

- In-browser verification of the four routes.
- A live-session run to observe the realtime path and confirm D11's mitigation.
- A backend task for items 3–5 if the spec's remaining metrics are wanted.

## Final Status

`VERIFIED_WITH_LIMITATIONS`

The four pages were redesigned against the full 2,634-line specification, every defect
class that made them display wrong data is fixed and proven fixed against live payloads,
and TypeScript, lint, route compilation and all four API dependencies pass. The
limitation is that verification is by field contract and route compilation rather than by
rendered browser output.
