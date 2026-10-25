# FRONTEND_CONTRACT.md

## Frontend ⇄ backend contract, derived from `lib/`

**Created**: 2026-09-28
**Method**: static reading of the transport and type layers. **No request was sent, no
WebSocket was opened, no build was run.**
**Status**: `STATIC_VERIFIED` for shapes; `NOT_VERIFIED` for all runtime behaviour.

> ### ⚠ Read `security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` first.
> While tracing the auth contract for this document, a **critical** flaw was found: the
> Next-layer session is an **unsigned** `base64` cookie, and the PIN path **fails open**.
> See **R-36**, **R-37**, **R-38**.

---

## 1. The `lib/` layer is 57 files, not 4

The originally assigned audit scope was four files. The transport contract is actually
distributed across more, and the two most contract-relevant ones
(`lib/api.ts` at 46 KB and `lib/realtime-ws.ts` at 32 KB) dominate. Files read in full for
this document:

| File | Lines | Role |
|------|-------|------|
| `lib/kaustubh-types.ts` | 280 | shared response shapes |
| `lib/backend.ts` | 68 | **server-side** proxy to FastAPI |
| `lib/realtime-ws.ts` | 841 | WebSocket client |
| `lib/engine-realtime.ts` | 156 | engine control-plane hooks |
| `lib/env.ts` | 27 | env accessors |
| `lib/auth-crypto.ts` | 59 | PIN hashing + session tokens |
| `app/api/auth/login/route.ts` | 93 | session issuance |
| `app/api/realtime/token/route.ts` | — | session validation + operator-JWT minting |

---

## 2. Two different HTTP paths — this is the key structural fact

The frontend reaches the Python backend by **two structurally different routes**, and
conflating them is a common source of confusion in the existing documentation.

```
A. BROWSER → Next.js API route → FastAPI          (server-to-server, same process)
   components/pages  →  app/api/**/route.ts  →  lib/backend.ts:backendFetch  →  :8000

B. BROWSER → FastAPI directly                     (client-to-server, bypasses Next)
   lib/realtime-ws.ts  →  ws://<host>/ws/realtime
```

| | A (proxy) | B (WebSocket) |
|---|---|---|
| Base URL | `BACKEND_URL` → `NEXT_PUBLIC_API_BASE` → `http://127.0.0.1:8000` (`backend.ts:9`) | derived from `NEXT_PUBLIC_API_BASE`, `ws`/`wss` by scheme (`realtime-ws.ts:106-115`) |
| Runs on | server | browser |
| Timeout | 12 s default, `AbortController` (`backend.ts:15-21`) | n/a; 8 s ACK timeout, 10 s open wait |
| Auth | forwarded headers, or nothing | `?token=` query param |
| Caching | `cache: 'no-store'` | n/a |

**Contract observation**: `NEXT_PUBLIC_API_BASE` is a **public** variable (inlined into
browser bundles) yet `backend.ts:9` uses it as the **server-side** proxy target, with
`BACKEND_URL` taking precedence. If the two disagree, server and client talk to different
backends. Nothing validates they match.

---

## 3. Response envelope

Every Next.js API route in this codebase returns the same envelope, and the client hooks
depend on it:

```ts
{ ok: boolean, data: T | null, error?: string }
```

Enforced by `backendFetch` (`backend.ts:41`) and consumed by
`useEngineStatus`/`useOneShot` (`engine-realtime.ts:75-82`, `:137-142`):

```ts
if (!res.ok || !body?.ok) { setError(body?.error ?? `HTTP ${res.status}`); return; }
setData(body.data as T);
```

`backendFetch` returns `status: 0` for both timeout and connection failure
(`backend.ts:45-48`), so **the two failure modes are indistinguishable to callers** — a
timeout is reported as "Backend unreachable".

`backendFetch` swallows non-JSON bodies by returning `data: null` (`backend.ts:34-40`), so a
proxy returning an HTML error page yields `ok:false, data:null` with no diagnostic.

---

## 4. WebSocket contract

`/ws/realtime` is the only backend socket (`python-service/api/ws_gateway.py:278`).

### 4.1 Envelope

`realtime-ws.ts:35-48` — one shape in both directions:

```
down: { type, event_id, timestamp, sequence, channel, symbol, instrument_token,
        exchange_segment, schema_version, data }
up:   { action, request_id, correlation_id, channels | order | order_id | position }
```

`sequence` is present on the wire but **no gap detection is implemented client-side** — the
client keeps a "latest value wins" view per instrument (`RealtimeTickView`, lines 51-75) and
`raw` is retained, so out-of-order or dropped frames are **not detected, only overwritten**.
This contradicts the `quality.out_of_order_rate` metric the backend reports, which implies
the backend *does* track ordering.

### 4.2 Connection lifecycle

`RealtimeLiveState` (lines 15-22): `DISCONNECTED | CONNECTING | CONNECTED | RECONNECTING |
AUTHENTICATING | AUTH_FAILED | ERROR`.

| Constant | Value | Line |
|---|---|---|
| `BASE_RECONNECT_MS` | 1 000 | 84 |
| `MAX_RECONNECT_MS` | 15 000 | 85 |
| `BACKOFF_JITTER_MS` | 250 | 86 |
| `MAX_CONSECUTIVE_SOCKET_FAILURES` | 8 | 87 |
| `ACK_TIMEOUT_MS` | 8 000 | 88 |
| `WAIT_OPEN_TIMEOUT_MS` | 10 000 | 90 |
| `ERROR_COOLDOWN_MS` | 60 000 | 94 |
| `WARN_THROTTLE_MS` | 10 000 | 96 |
| heartbeat | 12 000, floored at 3 000, overridden by server `heartbeatIntervalS` | 131, 657-660 |

Backoff is exponential, capped, jittered, and gives up after 8 consecutive failures into a
60 s `ERROR` cooldown. This is a **well-built** reconnect policy; the weakest point is
`AUTH_FAILED`, which is treated as permanent (line 214: *"permanent - no reconnect spam"*),
so a token that expires mid-session leaves the client dead until a manual reconnect.

### 4.3 Auth

Tokens are handed out REST-first because *"Frontend WebSocket clients cannot set HTTP
headers"*, then passed as `?token=` (lines 7-12). **Tokens in a query string land in
proxy logs, browser history, and `Referer` headers** — a known trade-off, but worth
recording. `?token=` on a WebSocket URL is also visible to any intermediary that logs
upgrade requests.

### 4.4 Engine control channel — **VERIFIED CORRECT** ✅

`ENGINES_CHANNEL = 'engines'` (`engine-realtime.ts:22`), frame type `engine.status`,
payload `frame.data.engines`.

The internal name and the wire name **differ**, which initially looks like a contract break.
It is not — the translation is explicit and tested:

| Layer | Code | Value |
|---|---|---|
| Internal frame | `connection_engine.py:927` | `{"type": "engine_snapshot", "generatedAt", "count", "engines": {...}}` |
| Wire-type mapping | `connection_engine.py:184-185` | `if ftype == "engine_snapshot": return "engine.status"` |
| Channel routing | `connection_engine.py:88` | `"engine_snapshot": "engines"` |
| Nesting | `connection_engine.py:958-964` | `self._frame(session, wire_type, channel=channel, data=frame)` — the whole frame is nested under `data` |
| Push loop | `connection_engine.py:933-941` | every 2.0 s, only to sessions that subscribed |

So the client receives `{type: "engine.status", channel: "engines", data: {type:
"engine_snapshot", count: 17, engines: {...}}}` and `frame.data?.engines` is correct.

**This is covered by backend tests** — `test_connection_engine.py:198` asserts
`_map_wire_type({"type": "engine_snapshot"}) == "engine.status"`; `:205` asserts the
`engines` channel; `:229-231` asserts the payload is keyed by engine id; `:251` asserts the
delivered frame's type is `engine.status`. **The engine realtime path is the best-covered
part of the socket contract.**

### 4.5 `welcome` handshake — **VERIFIED** ✅

`realtime-ws.ts:654-663` reads `connectionId`, `username` and `heartbeatIntervalS`.
The backend sends all three: `ws_gateway.py:322` builds the `welcome` frame and `:336`
includes `"heartbeatIntervalS"`, sourced from `client.py:29` (`HEARTBEAT_INTERVAL_S = 12.0`).
The client default of 12 000 ms (`realtime-ws.ts:131`) therefore already matches the server,
and the server override path works. The client floors the value at 3 000 ms and ignores
non-positive values.

`useEngineStatus` deliberately does **one** REST fallback fetch on mount and never polls
(`engine-realtime.ts:14-17`, `:108-110`), and once a realtime frame arrives
`realtimeRef.current = true` permanently suppresses REST updates (`:79-83`, `:99`). So
after the first WS frame the REST path is dead — **a stale or wedged WebSocket permanently
overrides a working REST endpoint**, and `refresh()` is still exposed in the return value but
will silently no-op. That is a real availability hazard, not a style issue.

---

## 5. `kaustubh-types.ts` — shared shapes

24 interfaces/types. Deliberately permissive: nearly every field is optional, matching the
file's stated policy — *"Optional markers (?:) mean 'may be absent from a real response' —
the UI must render an honest Stale/Unavailable/— state, never fabricate a value."*

This is a **good** convention and is the clearest statement of the project's data-honesty
principle found so far.

### 5.1 Naming inconsistency

| Convention | Examples |
|---|---|
| `snake_case` (backend-mirroring) | `SessionInfo`, `SchedulerState`, `MongoStats`, `Position`, `Order`, `Notification`, `AuditEvent`, `QualityMetrics`, `AIModel`, `AIJob`, `AIHardware`, `ReportRecord` |
| `camelCase` | `WebSocketState` (`subscribed_symbols` is snake but `disconnectReason`-style fields are camel: `disconnected_at`, `reconnect_count` are snake… mixed), `MongoStats.dataSize`/`storageSize`/`indexSize`, `TickStats.*`, `StorageInfo.measuredAt` |
| `camelCase` market-data | `Quote.tradingSymbol`, `instrumentToken`, `exchangeSegment`, `changePercent`, `trdVolumeNotional`, `lastUpdateTs` |

`Quote` is the worst offender: `tradingSymbol`/`instrumentToken` (camel) alongside
`upper_circuit`/`lower_circuit` (snake) in the same interface. Any consumer must know which
is which; nothing enforces it.

**Consequence**: a mechanical `snake→camel` transform is **unsafe** here. The earlier
note in `PENDING-002` suggesting `npx tsc --noEmit` will "check `lib/kaustubh-types.ts`
against backend Pydantic models for contract drift" is **not achievable** — TypeScript
cannot detect a frontend type that disagrees with a Python response, because the two are
never checked against each other. Drift is invisible to every tool in the repo.

### 5.2 Placeholder type

```ts
node?: { disk?: Record<string, never> };
```

`SystemSnapshot.node.disk` (line 274-276) is typed `Record<string, never>` — an object that
can only ever be empty. This is an unfinished stub presented as a real type.

### 5.3 Self-contradicting field

`Position` (line 149) declares `net_pnl`, `unrealised`, `realized` **and** `net_average_price`
while `Quote` uses `change`/`changePercent`. `lib/formatters.ts` exports both `fmtPnl` and
`pnlClr` (used by `_pages/dashboard/page.tsx:27`), so at least two PnL spellings are live
in the UI simultaneously. **Which field is authoritative is `UNKNOWN`.**

---

## 6. Env contract

`lib/env.ts` exposes four accessors, all server-side only.

| Var | Used? | Note |
|---|---|---|
| `NEXT_PUBLIC_API_BASE` | yes | fallback `http://127.0.0.1:8000`; also drives the WS URL |
| `APP_LOCK_PIN` | yes — 5 routes | plaintext `===` compare in one of them (§7) |
| `GUEST_EMAIL` | **no** | declared in `.env.example`, referenced nowhere |
| `GUEST_PASSWORD` | **no** | declared in `.env.example`, referenced nowhere |

`validateEnv()` (lines 12-16) **validates nothing**: it calls `optionalEnv(...)` and
discards the result, then sets `_validated = true`. Its docstring claims *"Environment
variable validation"* but there is no assertion, no required list, and no throw. Any caller
believing it validated the environment has gained nothing.

`env.ts` is listed as *"runs on server side only"*, but it is a plain module with no
`server-only` import, so **nothing enforces that**. A client component importing `env.ts`
would compile; `NEXT_PUBLIC_API_BASE` would work, and the other three would silently be
`undefined` in the browser rather than erroring.

---

## 7. Auth contract (summary — detail in the security doc)

| Route | Behaviour |
|---|---|
| `POST /api/auth/login` | `{pin}` → validates 6 digits, compares against `pinHash` (constant-time) or `APP_LOCK_PIN` (**not** constant-time) → sets unsigned cookie. **`{direct:true}` with app lock unconfigured returns a cookie with no credentials at all** |
| `DELETE /api/auth/login` | deletes the cookie |
| `POST /api/auth/pin/{setup,change,disable}` | manage `.auth/app-lock.json` |
| `GET /api/realtime/token` | validates the **unsigned** cookie, then mints an operator JWT from `APP_USERNAME`/`APP_PASSWORD` |

`APP_LOCK_PIN` appears in **5** routes: `auth/login`, `auth/pin/change`, `auth/pin/disable`,
`auth/pin/setup`, `auth/health`.

PIN storage is **single-round SHA-256** with a `Math.random()`-derived salt
(`auth-crypto.ts:15-21`). A 6-digit PIN is ~10^6 candidates; this is not a password KDF.

---

## 8. Findings

| # | Finding | Severity |
|---|---------|----------|
| C-1 | `kaustubh_session` is **unsigned**; a client can authenticate itself | **Critical** (R-36) |
| C-2 | App-lock check **fails open**; `{direct:true}` needs no credential; fresh clone is vulnerable by default | **Critical** (R-37) |
| C-3 | Forged session escalates to a backend **operator JWT** | **High** (R-38) |
| C-4 | Once a WS frame arrives, REST fallback is **permanently** suppressed — a wedged socket overrides a healthy REST path | Medium |
| C-5 | `validateEnv()` validates nothing and can throw the `server-only` guarantee away | Medium |
| C-6 | `snake_case`/`camelCase` are mixed **within single interfaces** (`Quote`); no tool can detect drift from the Python models | Medium |
| C-7 | `SystemSnapshot.node.disk` is `Record<string, never>` — a stub typed as a real contract | Low |
| C-8 | `Position` exposes four overlapping PnL/average fields; authoritative one is `UNKNOWN` | Low |
| C-9 | The backend sends a per-session monotonic `sequence` (`ws_gateway.py:265`, `connection_engine.py:585`) and the client declares it (`realtime-ws.ts:39`) but **never reads it** — the only two occurrences in all of `lib`/`components`/`hooks` are the type declaration and a docstring. No gap or out-of-order detection, while the backend separately reports `quality.out_of_order_rate` | **Medium** |
| C-10 | `?token=` puts the realtime token in URLs (proxy logs, history, `Referer`) | Low (documented trade-off) |
| C-11 | `GUEST_EMAIL`/`GUEST_PASSWORD` are dead accessors documented in `.env.example` | Low |
| C-12 | `backendFetch` maps timeout and connection-refused both to `status: 0`; failures are indistinguishable | Low |
| C-13 | `lib/` is 57 files / ~440 KB, with `api.ts` (46 KB) and `realtime-ws.ts` (32 KB) dominating; contract knowledge is spread, not centralised | Low (maintainability) |

---

## 9. What is still unverified

**Verified during this audit** (was previously unknown, and the engine channel had looked
like a break):

- ✅ `engines` channel exists and routes `engine_snapshot` frames
- ✅ `engine.status` is the correct **wire** type (mapped from `engine_snapshot`)
- ✅ the payload is nested under `data`, so `frame.data.engines` is right
- ✅ all of the above is asserted by `test_connection_engine.py`
- ✅ `welcome` carries `heartbeatIntervalS`, and the 12 s client default matches the server

**Still unverified:**

- Whether any `kaustubh-types.ts` field matches a real FastAPI response — the types are
  hand-written mirrors, and **no tool can detect drift** (C-6)
- Whether `/ws/realtime` accepts the `?token=` this client sends, and what it returns
- Whether the other channels (`market.tick`, `order.update`, `position.update`,
  `system.status`, `state_changed`) reach the client unmangled — only the `engines` path
  was traced
- Whether any of the 151 routes render at all
- The correct PnL field, and whether `fmtPct`/`fmtPnl` double-count
- Whether the `direct:true` auth bypass has ever been exercised

Every remaining item needs `PENDING-001` (runtime) or `PENDING-002` (build). **None was run.**

---

## 10. Cross-checks worth keeping

Two places where a careless grep produces a **false** finding — recorded so it is not
re-reported:

1. **`engine.status` looks absent.** Searching `"type": "…"` literals across the backend
   returns ~80 hits and none of them is `engine.status`, because the value is produced by
   `_map_wire_type()` rather than written as a literal. Only the *internal* name
   `engine_snapshot` appears literally.
2. **`heartbeatIntervalS` looks absent.** It is built at `ws_gateway.py:336`, not stored in
   a config dict that a keyword search would surface.

Both were caught by reading the mapping function and the tests rather than trusting the
grep.

---
*Static reading only. No request, socket, or build.*
