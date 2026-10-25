# VERIFICATION_MATRIX.md

## KAUSTUBH Trading Platform - Verification Matrix

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Purpose**: Track what has been statically verified vs what requires a running system.

---

## Legend

| Marker | Meaning |
|--------|---------|
| `VERIFIED` | Confirmed by code inspection, filesystem scan, or documentation cross-reference |
| `NOT_VERIFIED` | Requires a running backend/frontend/database/broker |
| `UNKNOWN` | Cannot be determined from available information |
| `CONFLICT` | Documentation and code disagree |
| `DUPLICATE` | Overlapping implementations detected |

---

## Matrix

| # | Claim / Component | Static Evidence | Runtime Status | Notes |
|---|-------------------|-----------------|----------------|-------|
| 1 | Backend is FastAPI | `app.py` | `VERIFIED` | 40 router registrations |
| 2 | Frontend is Next.js 16.3.4 | `package.json` | `VERIFIED` | React 19.2.8 |
| 3 | MongoDB via Motor | `requirements.txt`, `database/` | `VERIFIED` | Async driver |
| 4 | Kotak Neo primary | `brokers/kotak_adapter.py` | `VERIFIED` | 222 lines, 21 defs, 17/18 protocol coverage, 0 unimplemented markers; `kotakneoapi` 3.0.7 |
| 5 | ~~Shoonya secondary~~ | `brokers/broker_registry.py:68-79` vs `shoonya_adapter.py` | **`CONFLICT`** | Registry declares **every** capability `False`; adapter is **448 lines / 34 defs / 16-of-18** protocol coverage with **0** unimplemented markers — on par with `dummy`, which *is* declared implemented. `tests/test_engine_registry.py:301-314` enforces the "not implemented" claim. Bodies not read; the table is an **unverified claim**. R-41 |
| 6 | Dummy adapter | `brokers/dummy.py` | `VERIFIED` | 219 lines, 19 defs, 16/18 coverage; 48 REST routes. Capability record is self-inconsistent: `market_data=True`, `websocket=False`. R-42 |
| 7 | 4 WebSocket channels by design | `08_WEBSOCKET_ARCHITECTURE.md` | `VERIFIED` (design) | Ownership confirmed by dirs |
| 8 | WS#3 + WS#4 on `/ws/realtime` | `api/ws_gateway.py` | `VERIFIED` (code) | Runtime multiplexing `NOT_VERIFIED` |
| 9 | ~~15 registered engines~~ → **17 registered (14 native + 3 facade)** | `python-service\app.py:609-626`; `services\legacy_engine_facades.py:428-432` | `CONFLICT` (documentation) / `STATIC_VERIFIED` (code) | Documentation claims 15 in 5 files — **refuted**. Live state still `NOT_VERIFIED` |
| 10 | Engine states (RUNNING etc.) | `ENGINE_INVENTORY.md` | `NOT_VERIFIED` | Doc snapshot, not live |
| 11 | 5 engines UNKNOWN/DEGRADED | `ENGINE_INVENTORY.md` | `NOT_VERIFIED` | Requires `/api/services/engines` |
| 12 | ~~450 REST routes~~ → **~450** | Source scan of `api/*.py` | `VERIFIED` (paths) | Schemas `NOT_VERIFIED`; no OpenAPI spec exists (GAP-003) |
| 13 | `/api/health` duplicated | `api/routes.py` + `api/system.py` | `DUPLICATE` / `CONFLICT` | Resolution order `NOT_VERIFIED` |
| 14 | Watchlist triplication | 3 modules, 3 prefixes | `DUPLICATE` | Canonical API `UNKNOWN` |
| 15 | `websockets==13.1` pin is required | `requirements.txt` comment + uvicorn import | `VERIFIED` (reasoning) | Runtime break if changed |
| 16 | 86 configuration settings | `config/settings.py` | `VERIFIED` (names) | Values `NOT_VERIFIED` |
| 17 | Secret masking in `/api/settings` | — | **`NOT_VERIFIED` (Critical)** | **Top-priority live check** |
| 18 | Scheduler 12 phase times | `config/settings.py` defaults | `VERIFIED` (defaults) | Firing `NOT_VERIFIED` |
| 19 | `square_off_enabled` switch | `config/settings.py` | `VERIFIED` (exists) | Live behavior `NOT_VERIFIED` |
| 20 | ~~11 core DB collections~~ → **19 `session_manager_*` collections** | `17_DATABASE_ARCHITECTURE.md` vs `services/session/instrument_store.py` | **`CONFLICT`** | Doc's 11 names do not match code. Actual collection names read from source; **effective DB name still `NOT_VERIFIED`** |
| 21 | DB collection counts | `17_DATABASE_ARCHITECTURE.md` | `NOT_VERIFIED` | Doc admits estimates. Never queried |
| 22 | ~~DB indexes~~ → **`session_manager_*` index definitions** | `services/session/instrument_store.py` | **`VERIFIED` (static)** | All `session_manager_*` index definitions read and catalogued in `database/DATABASE_COLLECTION_CATALOG.md`: 18 unique indexes on `instruments`, 6 on `events`, 1 owner on `revisions`. **Live DB indexes `NOT_VERIFIED`** |
| 23 | DB Writer is sole persistence owner | Architecture claim | `NOT_VERIFIED` | Grep needed |
| 24 | Session Manager = subscription authority | Architecture claim | `NOT_VERIFIED` | Code read needed |
| 25 | ~~174 frontend pages~~ -> **189 `page.tsx`** | Filesystem scan | `VERIFIED` | **151 routable**, 38 under `app\_pages\`. **151 distinct route strings** - no duplicate collision (D-05 withdrawn) |
| 26 | `_pages/` excluded from routing | Next.js convention | `VERIFIED` | **78 files** (74 `.tsx` + 2 `.ts` + 2 stray backups), **36** top-level dirs |
| 27 | Route groups don't affect URL | Next.js convention | `VERIFIED` (convention) | — |
| 28 | Frontend build succeeds | — | **`NOT_VERIFIED`** | `npm run build` not run |
| 29 | TypeScript compiles | — | **`NOT_VERIFIED`** | `tsc --noEmit` not run |
| 30 | Python tests pass | — | **`NOT_VERIFIED`** | `pytest` not run |
| 31 | TS tests pass | — | **`NOT_VERIFIED`** | `npm test` not run |
| 32 | ESLint clean | — | **`NOT_VERIFIED`** | `npm run lint` not run |
| 33 | No dependency CVEs | — | **`NOT_VERIFIED`** | `pip-audit`/`npm audit` not run |
| 34 | No CI pipeline | No workflow files found | `VERIFIED` (absence) | — |
| 35 | ~~Broker failover works~~ → **NO FAILOVER EXISTS** | `brokers/manager.py`, `brokers/broker_registry.py` | **`CONFLICT` / `STATIC_VERIFIED` (defect)** | Refuted. No health check, failure detection, retry, circuit breaker, or automatic switch. Status is computed and never acted on. Only switch caller is the **unauthenticated** engine-control endpoint. **R-39** |
| 36 | WS reconnect + resubscribe | Config vars exist | `NOT_VERIFIED` | Requires forced disconnect |
| 37 | 14 AI routes functional | No backend found | `UNKNOWN` | Possibly placeholders |
| 38 | Supabase used | `package.json` dep | `UNKNOWN` | No usage confirmed |
| 39 | TLS / rate limiting | — | `UNKNOWN` | No evidence. **No rate limiting found on `login` or `realtime/token`** (relevant to R-36/R-37) |
| 40 | Scheduler catch-up on missed phase | — | `UNKNOWN` | No mechanism documented |
| 41 | Order retry idempotency | `client_order_id` index | `NOT_VERIFIED` | Behavior unconfirmed |
| 42 | ~~`app/_pages` files are live~~ → **1 live / 73 unreachable** | `audits/FRONTEND_PAGES_AUDIT.md` | **`VERIFIED` (static)** | Resolved. `app\_pages\dashboard\page` is the only live file (via `app\(dashboard)\dashboard.tsx:13`); the other 73 are unreachable. Intra-`_pages` cluster is self-referential and dead. D-04, D-06 |
| 43 | Backup/restore procedure | — | `UNKNOWN` | No docs found |
| 44 | ~~Migration strategy~~ → **custom forward-only ledger** | `database/migrations.py` | **`VERIFIED` (static)** | Read in full. `schema_migrations` ledger + lock; no rollback, no framework (not Alembic). Weaknesses: startup does not use `dry_run`; lock released fire-and-forget; 60 s stale window. See `database/DATABASE_COLLECTION_CATALOG.md` |
| 45 | CORS restricted | `cors_origins` config, `app.py:872-878` | `CONFLICT` | **`.env` sets `CORS_ORIGINS=*`** with `allow_credentials=True`; `.env.example` ships the same. Code default is the restrictive `http://localhost:3000` |
| 46 | Backend bound to loopback only | `settings.py:256`, `.env` | `CONFLICT` | **Both default and `.env` set `HOST=0.0.0.0`** — all interfaces |
| 47 | API authentication enforced | `api\*.py`, `app.py` | `CONFLICT` | **Auth applied to only 3 of 40 routers** (`security`, `terminal`, `ws_gateway`); 0 of 40 `include_router()` calls use `dependencies=` |
| 48 | Engine control requires auth | `api/engine_control.py` | `CONFLICT` | **No auth at all.** `POST /{engine_id}/stop|restart|start` and `POST /broker/trading/select` are open |
| 49 | JWT signing secret is not a default | `services/jwt_auth.py:30`, `settings.py:351` | `CONFLICT` | Falls back to literal `"dev-insecure-jwt-secret"` when `JWT_SECRET` empty; **`JWT_SECRET` absent from `.env`** (may exist in OS env or `.env.local` — `NOT_VERIFIED`) |
| 50 | Per-engine CLI exists | `start_backend.py`, `api/engine_control.py` | `CONFLICT` | No `kaushub` package. A **backend** CLI exists (`start_backend.py run\|status\|stop\|restart`); engine control is HTTP-only; `engine reconcile` has **no** equivalent |
| 51 | Session token is cryptographically protected | `lib/auth-crypto.ts` | **`CONFLICT` — Critical** | **No signature.** `kaustubh_session` is base64 of plaintext JSON with **no `expires` field**; forgeable offline without credentials. PIN = `SHA-256(password + Math.random() salt)`. **R-36**, D-22 |
| 52 | App lock protects the app | `app/api/auth/login/route.ts`, `config.py` | **`CONFLICT` — Critical** | **Fails open**: operator access granted when `!appLock` or `!user`. `app_lock_enabled` defaults **false** with no env override; `.env` has no `APP_LOCK_PIN`; `.auth/` gitignored. A fresh clone is **unlocked**, and `POST direct:true` is then a no-credential operator path. **R-37** |
| 53 | Realtime token is scoped to realtime | `app/api/realtime/token/route.ts` | **`CONFLICT` — High** | Gated only by the forgeable cookie, then returns `acquireOperatorJwt()` output (`APP_USERNAME`/`APP_PASSWORD`, 8 h cache) **to the browser**. Latent: vars currently unset → degrades to anonymous. **R-38** |
| 54 | Frontend ↔ backend WS message contract | `lib/kaustubh-types.ts` vs `python-service\ws_socket\messages.py` | `VERIFIED` (matches) | Internal `engine_snapshot` **does** map to wire type `engine.status`, channel `engines`, payload nested under `data`. `welcome.heartbeatIntervalS` correct (seconds). **Prior "missing type" claim was a false positive (D-23)** |
| 55 | WebSocket `sequence` field is consumed | `lib/realtime-ws.ts` | **`CONFLICT` — Low** | Backend emits monotonic per-session `sequence`; the client **ignores** it. No stale-frame or out-of-order detection |
| 56 | REST fallback stays available on WS failure | `lib/engine-realtime.ts` | `CONFLICT` — Low | Once the first realtime frame arrives, `realtimeRef` is set permanently and REST updates are **suppressed** for the session |
| 57 | Env var names match config | `lib/env.ts`, `NEXT_PUBLIC_*` usage | `CONFLICT` — Low | `validateEnv()` is a **no-op**. Mixed naming: `NEXT_PUBLIC_` prefixes on some, not all; `GUEST_*` vars exist in `.env.example` but are **unused**. Backend reads bare names |
| 58 | Repository contains the application | `git ls-tree`, `git status` | **`CONFLICT` — Critical** | 5 commits, 141 tracked, **~975 untracked**; 16 routable pages in `HEAD` vs 151 in tree; ~98k frontend lines + 209 `.py` uncommitted. **A fresh clone cannot reproduce this system.** **R-34**, GAP-025 |
| 59 | Secrets excluded from version control | `.gitignore` | `VERIFIED` (correct) | `.env`, `.env*.local`, `.auth\`, `.next\`, caches, logs all ignored; no unignored secret pattern found. **Gap**: `python-service\downloads\` (48.51 MiB derived CSV) not ignored — GAP-034 |
| 60 | Broker selection has one source of truth | `manager.py` + `broker_registry.py` | **`CONFLICT` — High** | Two independent systems never call each other; registry is process-local and resets to `kotak` on restart while the manager persists the session choice. **R-40** |
| 61 | Market-data status reflects the selected broker | `broker_registry.py:226-235` | **`CONFLICT` — Medium** | Always reads the global `ws_manager`, so `dummy` as market-data broker reports the **real** broker's live WS state. **R-42** |
| 62 | Duplicate `/trading` route blocks the build | `audits/FRONTEND_PAGES_AUDIT.md` | `VERIFIED` — **no collision** | **Disconfirmed.** 151 routable pages produce **151 distinct** route strings. `HEAD` contains only 16 routable pages and does **not** hold both `/trading` pages either. D-05 withdrawn |

---

## Coverage Summary

| Status | Count | Percentage |
|--------|-------|------------|
| `VERIFIED` (static) | 20 | 32% |
| `NOT_VERIFIED` (needs runtime) | 17 | 27% |
| `CONFLICT` / `DUPLICATE` | 23 | 37% |
| `UNKNOWN` | 2 | 4% |
| **Total items** | **62** | — |

**Interpretation**: the **static** picture is now well understood — twelve claims moved
*out* of `NOT_VERIFIED` into `VERIFIED` or `CONFLICT` in this pass. **Still no behavioral
claim is verified**, and the `CONFLICT` share grew because reading the code produced
defects, not because documentation is merely unclear.

> **The headline is not the percentage.** The Critical/High `CONFLICT` set is a set of
> **facts about the deployed configuration**, read directly from source:
> a live-money trading backend on `0.0.0.0`, 37 of 40 routers unauthenticated, a
> **forgeable operator session cookie**, an app lock that **fails open**, and a
> **repository that does not contain its own application**. Runtime testing confirms
> reachability; it cannot make these go away.

**Third pass (2026-09-28)** added items 51–62: the auth chain (#51–#53), the WS/type/env
contract (#54–#57), version control (#58–#59), broker selection (#60–#61), and the
disconfirmed route collision (#62).

**Corrections carried forward** so they are not re-raised: engine `engine.status` type
mapping is **correct** (D-23); the `/trading` duplicate does **not** exist (D-05); DB index
definitions and the migration strategy are now **read** (#22, #44); `_pages` liveness is
**resolved** (#42).

---

## Priority Verification Plan

Ordered by *what changes the risk picture*, not by doc order. Note that several P0 items
are now **read-only checks** — the finding is already established; the check only confirms
reachability.

| Priority | Item | How | Note |
|----------|------|-----|------|
| **P0** | #52/#51/#53 App lock, session forgery, operator-JWT escalation | From a host that can reach the frontend: craft a `kaustubh_session` cookie offline, then `POST /api/realtime/token` and `POST /api/auth/login {direct:true}` | **Already `STATIC_VERIFIED`.** Confirms blast radius only. Do **not** run against a funded account |
| **P0** | #58 Repository completeness | `git clone` to a temp dir, then `npm ci && npm run build` | Expect failure; the point is to size the recovery |
| **P0** | #17 Secret masking | `curl /api/settings` and inspect body | Static reading suggests it is likely safe (D-20); confirm |
| **P1** | #11 Engine health | Start backend in dummy mode; `GET /api/services/engines` | — |
| **P1** | #28/#29/#30 Build + type + test | `npm run build`, `tsc --noEmit`, `pytest` | Blocked on #58 |
| **P1** | #12 Route schemas | Export `/openapi.json`; diff vs `api/API_CATALOG.md` | Root fix for GAP-003/GAP-035 |
| **P2** | #13 Route collision resolution | Live-test `/api/health` | `/api/services/engines/broker/status` **disconfirmed** statically — no longer needs testing |
| **P2** | #33 Dependency CVEs | `pip-audit -r requirements.txt`; `npm audit` | — |
| **P2** | #20/#21 DB collections + counts | Query the live DB; compare vs `DATABASE_COLLECTION_CATALOG.md` | Index *definitions* already verified |
| **P2** | #18/#19 Scheduler phases | Observe a live session or clock-override test | — |
| **P2** | #60/#61 Broker selection divergence | Select a terminal in the UI, then read the registry state | Demonstrates the two-systems split without a real broker |
| **P3** | #5 Shoonya adapter reality | Read the method bodies vs `base.py` protocol | Decides whether R-41 is a stale table or a 448-line stub |
| **P3** | #36 WS reconnect | Force disconnect during market hours | — |
| **P3** | ~~#35 Broker failover~~ | **n/a — no failover to test** | Refuted statically; becomes a *design* task (R-39) |
| **P3** | #45 CORS | Inspect middleware + response headers | — |
| **P3** | #44 Migration dry-run | Invoke `dry_run=True` manually | Startup path does **not** use it |

---

## Related Documents
- `TESTING_ARCHITECTURE.md` — Test structure
- `../PROJECT_GAPS.md` — Gap register (GAP-025…035)
- `../PROJECT_RISKS.md` — Risk register (R-34…R-42)
- `../FINAL_REPORT.md` — Coverage summary
- `../audits/FRONTEND_PAGES_AUDIT.md` — Route and `_pages` import graph
- `../audits/VERSION_CONTROL_STATE.md` — Repository divergence
- `../audits/GITIGNORE_AUDIT.md` — Ignore coverage
- `../frontend/FRONTEND_CONTRACT.md` — HTTP/WS/type/env/auth contract
- `../security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` — Unsigned session token
- `../broker/BROKER_SELECTION_AND_FAILOVER.md` — Broker selection and failover
- `../database/DATABASE_COLLECTION_CATALOG.md` — Collection and index audit
