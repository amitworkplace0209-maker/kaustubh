# FINAL_REPORT.md

## KAUSTUBH Trading Platform - Master Project Report

**Report Date**: 2026-09-29
**Report Type**: Discovery & Documentation Bootstrap, plus delivered changes
**Prepared By**: OpenCode AI Agent
**Status**: `PARTIALLY_COMPLETE`
**Scope**: Static repository discovery, architecture mapping, dependency analysis, documentation system bootstrap, and the serial implementation changes recorded in §14–§16

> **Read §20 first for the most recent change** (Tick Analytics,
> `IMPLEMENTED_AND_VERIFIED_WITH_LIMITATIONS`). §16 describes the most recent
> change before that. §1–§13 describe the original discovery pass and are
> unchanged by them.

---

## 1. Executive Summary

The KAUSTUBH Trading Platform is a production-oriented algorithmic trading terminal consisting of:
- **Backend**: Python 3.12+ / FastAPI 0.115.0, single process, ~40 router registrations, ~450 REST routes, 1 unified WebSocket endpoint
- **Frontend**: Next.js 16.3.4 / React 19.2.8 / TypeScript 5.9.3, App Router with 5 route groups, **189 `page.tsx` (151 routable)**
- **Database**: MongoDB via Motor 3.5.1, **19 `session_manager_*` collections, no TTL** (expiry is application-managed)
- **Brokers**: Kotak Neo (primary, `kotakneoapi` 3.0.7), Shoonya (`NorenRestApiOAuth` 0.0.41, **capability table disputed**), Dummy (paper, 48 simulated endpoints)
- **Engines**: **17 registered engines** (14 native + 3 facade) behind an engine registry, orchestrated by a scheduler and a Session Manager acting as subscription authority

The documentation system has been bootstrapped: master knowledge files, domain catalogs, API catalog, configuration catalog, and implementation/verification records now exist under `C:\project\docs\`.

**All runtime behavior remains `NOT_VERIFIED`** — no backend, frontend, MongoDB, or broker connection was live during discovery.

> ### ✅ Architecture change delivered — DB Writer owns tick persistence (2026-09-28)
> A traced, implemented and tested change makes the **DB Write Engine the single
> authority** for tick persistence, with three independent OFF-by-default
> permissions, a backend API and a Service-page Settings ⚙️ panel.
>
> **Three real defects were found and fixed:**
> 1. **Market Watch was a co-owner of tick persistence.** Its own switch
>    `mwr_persist_ticks` (default **True**) was the only gate on the Market Watch
>    tick path; `dbw_market_watch_ticks` (default OFF) was never consulted there.
>    Market Watch ticks were therefore persisted by default, and turning the DB
>    Writer's permission off did nothing. Market Watch now hands off to
>    `db_writer_engine.ingest_market_watch_ticks()`, which classifies, checks the
>    permission, dedupes and buffers.
> 2. **The "persist at most once" rule was dead code.** `_get_tick_source()`
>    short-circuited on `market_watch`, so the overlapping-classification branch
>    could never run and `overlapping_sources_deduped` was structurally always 0.
>    Fixed with a classification **set**.
> 3. **The new settings endpoint returned a raw 500 when MongoDB was down** (found
>    by a live HTTP round-trip). Now reports an honest "settings store unavailable"
>    and checks reachability *before* writing, so a multi-key update cannot
>    half-apply.
>
> **Verification:** backend `1189 passed / 0 failed`; the real router is mounted at
> `app.py:1020` and the endpoints were driven over **real HTTP** via a scratch app;
> `tsc` and `eslint` clean; frontend `273/274` (the single failure is the
> pre-existing, unrelated `tests/topbar-status.test.ts:336`).
> **Live broker / live MongoDB / browser run remain `NOT_VERIFIED`** — an
> already-running backend on port 8000 predates the change and was deliberately not
> restarted (GAP-036, GAP-037).
> → `implementation/016-db-writer-single-tick-persistence-authority.md`,
> `verification/016-db-writer-single-tick-persistence-verification.md`,
> `audits/DB_WRITER_TICK_PERSISTENCE_AUDIT.md`,
> `audits/FRONTEND_DB_WRITER_SETTINGS_AUDIT.md`,
> `logs/LOG-002-2026-09-28-db-writer-tick-persistence-authority.md`,
> `opencode/002-tick-persistence-ownership-trace.md`


> ### ⚠ Read this before trusting any other section
> Three further passes of static reading (2026-09-28) moved the picture from
> *undocumented* to *defective*. The most important results:
>
> 1. **The operator session is forgeable and the app lock fails open.** `kaustubh_session`
>    is an **unsigned** base64 JSON blob with no `expires` field; the lock defaults to
>    **disabled**; and `/api/realtime/token` returns a **backend operator JWT** to the
>    browser once `APP_USERNAME`/`APP_PASSWORD` are configured. Combined with 37 of 40
>    routers being unauthenticated, this is the most serious finding in the project.
>    **R-36, R-37, R-38.** → `security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md`
> 2. **The repository does not contain its own application.** 5 commits, 141 tracked
>    files, **~975 untracked**, including ~98k lines of frontend and 209 `.py` files. A
>    fresh clone cannot build or run this system. **R-34.** → `audits/VERSION_CONTROL_STATE.md`
> 3. **There is no broker failover.** No health check, retry, or automatic switch exists
>    anywhere; status is computed and never acted on. Two independent selection systems
>    never reconcile. **R-39, R-40.** → `broker/BROKER_SELECTION_AND_FAILOVER.md`
>
> These are **facts about the code**, not open questions about documentation quality.

---

## 2. Status Legend

| Marker | Meaning |
|--------|---------|
| `VERIFIED` | Confirmed by static code inspection or documentation cross-reference |
| `NOT_VERIFIED` | Requires a running system; not tested |
| `UNKNOWN` | Not determinable from available information |
| `DOCUMENTATION_CODE_CONFLICT` | Documentation and code disagree |
| `DUPLICATE_OR_POSSIBLE_DUPLICATE` | Same or overlapping responsibility in multiple places |
| `DEPENDENCY_UNRESOLVED` | Dependency relationship unclear or undocumented |
| `DOCUMENTATION_GAP` | Documented or implied but missing |

---

## 3. What Was Done

| Activity | Result |
|----------|--------|
| Governance review | `PROJECT_IMPLEMENTATION_RULE.md` read and applied |
| Repository inventory | Root, `python-service/`, frontend, `docs/`, tests enumerated |
| Architecture analysis | 6 layers, engine-first model, 4-WS design documented |
| Dependency analysis | 25 Python packages, 41 Node/library entries cataloged |
| Engine catalog | **17** engines (14 native + 3 facade) with type/state/health/category |
| API catalog | 40 router registrations, ~450 routes extracted from source |
| Configuration catalog | 86 settings across 10 categories |
| WebSocket mapping | WS#1–WS#4 with owners and purposes |
| Broker map | 3 adapters with capability matrices; **capability table disputed** (R-41) |
| Database docs | **19 `session_manager_*` collections**, index definitions read, **no TTL** |
| Frontend route map | **189 `page.tsx`, 151 routable → 151 distinct routes**, `_pages` import graph (1 live / 73 dead) |
| **Auth chain audit (new)** | Unsigned session token, fail-open app lock, operator-JWT escalation — **R-36/R-37/R-38** |
| **Version-control audit (new)** | 5 commits, 141 tracked, **~975 untracked** — **R-34**; `tailwind.config.ts` restored, **R-35 closed** |
| **`.gitignore` audit (new)** | Secrets correctly ignored; `downloads/` (48.51 MiB) not — GAP-034 |
| **Broker failover audit (new)** | **No failover exists**; two divergent selection systems — **R-39…R-42** |
| **Migration/index audit (new)** | Custom forward-only ledger, no rollback, 60 s stale-lock window |
| Documentation bootstrap | 30+ new documents created |
| Records | 1 implementation record, 1 verification record |
| Source code changes | **1 approved restore only** — `tailwind.config.ts` from `HEAD` (no logic changed) |
| Staged / committed | **NONE** — owner chose audit-only |

---

## 4. Key Architecture Findings

### 4.1 Engine-First, Session-Manager-Authoritative
**17** engines are registered in a runtime registry (14 native + 3 facade). Session Manager is the single source of truth for subscriptions, instrument state, and daily intent. Subscription Registry merges/dedupes/diffs broker-level feed requirements. WebSocket Engine orchestrates reconciliation.

### 4.2 Four Separate WebSocket Channels
| Channel | Direction | Owner |
|---------|-----------|-------|
| WS#1 | Kotak SFeed → backend | `ws_socket/ws_manager.py` |
| WS#2 | Kotak OrderFeed → backend | `ws_socket/order_feed_manager.py` |
| WS#3 | backend → frontend | `connection_engine/` |
| WS#4 | frontend → backend | `connection_engine/` + `api/ws_gateway.py` |

WS#3 and WS#4 are multiplexed onto a single endpoint: `WS /ws/realtime` in `api/ws_gateway.py`. **NOT_VERIFIED** whether they are logically separated by message type at runtime.

### 4.3 Engine Health Concerns
`docs/engines/ENGINE_INVENTORY.md` reports 5 engines `REGISTERED`/`UNKNOWN` and 2 `DEGRADED` (per verification record). `margin_engine`, `squareoff_engine`, and `notification_engine` are `REGISTERED` but not `RUNNING`. **These are documentation claims, not live observations.**

### 4.4 Dependency Constraint That Must Not Be Broken
```
uvicorn 0.30.6  →  imports websockets.legacy.*  →  websockets MUST stay <= 13.1
kotakneoapi 3.0.7  →  requires websockets >= 12.0  →  satisfied by 13.1
```
Upgrading `websockets` to 14.x without upgrading uvicorn will break the backend.

### 4.5 Watchlist Surface Is Split Three Ways
`api/watchlist.py` (`/api/watchlist`), `api/watch_list.py` (`/api/watch-list`), and `api/watchlist_engine.py` (`/api/watchlist-engine`) all serve watchlist responsibilities. `DUPLICATE_OR_POSSIBLE_DUPLICATE`.

---

## 5. Documentation & Code Conflicts

| # | Conflict | Evidence | Severity |
|---|----------|----------|----------|
| 1 | `GET /api/health` registered twice | `api/routes.py` and `api/system.py` | Medium |
| 2 | `/api/trading` prefix shared | `api/trading.py` + `api/trading_dashboard.py` | Medium |
| 3 | Engine inventory dependency graph differs from code declarations | `docs/architecture/03_ENGINE_DEPENDENCY_GRAPH.md` vs `services/*.py` | Medium |
| 4 | `market_coach` documented as depending on `feature_engine`; code suggests `instrument_cache` + `watchlist_engine` | `MARKET_WATCH.md` vs `services/market_watch_engine.py` | Medium |
| 5 | `margin_engine` documented deps do not include `session_manager`/`connection_manager` which code declares | `03_ENGINE_DEPENDENCY_GRAPH.md` vs `core/engines/margin_engine.py` | Medium |
| 6 | Database doc claims pool metrics/collection counts | `docs/architecture/17_DATABASE_ARCHITECTURE.md` | Low (unverified estimates) |
| 7 | Broker doc claims failover/load balancing | `docs/architecture/06_BROKER_ARCHITECTURE.md` vs `brokers/manager.py` | Medium |
| 8 | **Engine count is 17 (14 native + 3 facade) in code, not 15 (13+2) in 5 documents**; `market_watch_engine` and `audit_engine` are registered but missing/contradicted in the inventory; `watchlist_target_engine` does not exist in code | `app.py:609-626`, `legacy_engine_facades.py:428-432` | **High** |
| 9 | **`python -m kaushub.*` CLI does not exist** — the entire remediation path in `32_ARCHITECTURE_GAPS.md` and `34_DEVELOPER_ONBOARDING.md` is unexecutable | repo-wide search for `kaushub*` → 0 results | **Critical** |
| 10 | **Banner/body contradiction across all 36 numbered architecture files** — a 4-WS banner sits atop 2-WS body text; `35_AI_AGENT_CONTEXT.md` (the AI-agent doc) teaches the wrong WS model | `00`:53, `31`:30-35, `34`:12, `35`:19-30 | **Critical** |
| 11 | `32_ARCHITECTURE_GAPS.md` Gap 2 says `audit_engine` is not started; code **registers and auto-starts** it | `app.py:620,629` | High |
| 12 | `C:\project\config.yaml` (claimed in `35`:69,90) does not exist; no `config*.y*ml` outside `.venv` | filesystem search | Medium |
| 13 | `35_AI_AGENT_CONTEXT.md` points agents at `app/_pages\` as the frontend — a **non-routable** private folder | `35`:89, `34`:28 | Medium |
| 14 | Only **one** WebSocket route exists (`/ws/realtime`); the 4-WS design is logical channels multiplexed over it | `api/ws_gateway.py:278` — sole `@router.websocket` | Informational (clarifies D-07) |
| 15 | Counts wrong in the architecture set: "30+ frontend pages" (actual **151** routable / 189 total), "25+ engine docs" (actual 31), "35 architecture files" (actual 36), `pip install -r requirements.txt` from root (no root file) | `00`:93-94, `34`:20-38, `35`:54-67 | Medium |
| 16 | **No authentication on 37 of 40 routers**, including engine start/stop/restart and broker selection; `HOST=0.0.0.0`; 0 of 40 `include_router()` calls use `dependencies=` | `api/engine_control.py`, `app.py` (0/40), `settings.py`:256, `.env` | **CRITICAL** |
| 17 | **JWT signing secret falls back to the hardcoded literal `dev-insecure-jwt-secret`** when `JWT_SECRET` is unset — and `JWT_SECRET` is absent from `.env` | `services/jwt_auth.py:30`, `settings.py:351,34` | **CRITICAL** |
| 18 | Wildcard CORS (`CORS_ORIGINS=*`) with `allow_credentials=True`; shipped in `.env.example` | `app.py:872-878`, `.env` | High |
| 19 | A real backend CLI **does** exist — `python start_backend.py run\|status\|stop\|restart` — but there is **no per-engine CLI**; engine control is HTTP-only, and `engine reconcile` has no equivalent at all | `start_backend.py:295-317`, `api/engine_control.py` | High |

---

## 6. Duplication & Legacy Summary

| Finding | Detail | Status |
|---------|--------|--------|
| 3 watchlist APIs | `/api/watchlist`, `/api/watch-list`, `/api/watchlist-engine` | `DUPLICATE_OR_POSSIBLE_DUPLICATE` |
| **Two parallel architecture doc sets** | **36 numbered + 19 unnumbered files in `docs/architecture/` with subject-identical pairs** | **`DUPLICATE_OR_POSSIBLE_DUPLICATE` (High)** |
| **73 unreachable pages** | `app\_pages\**` excluded from routing; import graph shows 1 live, 73 dead | `DUPLICATE_OR_POSSIBLE_DUPLICATE` (Low) |
| Duplicate health endpoint | `/api/health` in two modules | `DOCUMENTATION_CODE_CONFLICT` |
| ~~Duplicate page URLs~~ → **WITHDRAWN** | 151 routable pages → **151 distinct route strings**; no collision (D-05) | **Refuted** — see `audits/FRONTEND_PAGES_AUDIT.md` §2 |
| New catalogs overlap numbered docs | `API_CATALOG` vs `28_API_ARCHITECTURE`, `SECURITY_ARCHITECTURE` vs `25_`, `CONFIGURATION_CATALOG` vs `18_`, `FAILURE_AND_RECOVERY` vs `26_`, `OBSERVABILITY_ARCHITECTURE` vs `27_`, `FRONTEND_ARCHITECTURE` vs `19_UI_ARCHITECTURE` | `DUPLICATE_OR_POSSIBLE_DUPLICATE` |
| MIGRATED headers on architecture docs | Historical migration markers | `DOCUMENTATION_GAP` (stale) |
| Placeholder engine IDs | Some spec files use `$(...)` templates | `DOCUMENTATION_GAP` |
| `docs/DATA_FLOW_MAP.md` vs `docs/architecture/DATA_FLOW_MAP.md` | Created by this bootstrap (summary vs detail) — cross-referenced, not merged | Intentional overlap |
| Shoonya declared not-implemented | Registry says all `False`; adapter is 448 lines / 16-of-18 protocol | `DOCUMENTATION_CODE_CONFLICT` (R-41) |
| Fake `/api/kaushub/*` "external hangar" | Endpoint map documented; **no such code exists** | Fiction (D-11) |

---

## 7. Security Posture (Static)

| Control | Present | Verified How |
|---------|---------|--------------|
| Broker secrets backend-only | Yes (by design) | `config/settings.py` structure, adapter import sites |
| JWT auth | Yes | `services/jwt_auth*`, `api/auth.py` |
| PBKDF2 PIN hashing | Yes | `cryptography` + `services/mode_lock` |
| WebAuthn | Yes | `api/security.py` |
| CORS restriction | Configurable | `cors_origins` — actual value unknown |
| Secret redaction in docs | Required | `PROJECT_IMPLEMENTATION_RULE.md` |
| **Secret masking in `/api/settings`** | **UNKNOWN** | **Top-priority live check**; static reading suggests likely safe (D-20) |
| TLS enforcement | UNKNOWN | No evidence found |
| Rate limiting | **Absent on the auth paths** | No limiter on `login` or `realtime/token` — relevant to R-36/R-37 |
| Dependency vulnerability scan | NOT DONE | Recommended `pip-audit` / `npm audit` |

### The auth chain does not hold (Critical)

The controls above exist, but three defects in the chain that uses them mean they are not
effective. This is the most serious finding in the audit:

| Step | Control | What actually happens | Risk |
|---|---|---|---|
| 1 | App lock | `login` grants operator access when `!appLock` or `!user`; `app_lock_enabled` defaults **false** with no env override; `.env` has no `APP_LOCK_PIN` | **R-37** |
| 2 | Session token | `kaustubh_session` is base64 of **plaintext JSON** — no signature, **no `expires` field**. Forgeable offline, no credentials needed | **R-36** |
| 3 | Realtime token | Gated only by step 2, then returns `acquireOperatorJwt()` (backend operator JWT, 8 h cache) **to the browser** | **R-38** |

PIN hashing is also weak: `SHA-256(password + Math.random() salt)`.

**Consequence**: a fresh checkout starts **unlocked**, and `POST /api/auth/login
{"direct": true}` is a no-credential operator path today. Once `APP_USERNAME`/
`APP_PASSWORD` are set, forging a cookie escalates to operator access over the 37
unauthenticated routers (R-17) and `HOST=0.0.0.0` decides who can reach it.

**No code was changed.** Remediation requires owner approval.
→ `security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md`

---

## 8. Top Risks

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| R1 | Secrets exposed via `/api/settings` | Critical | Live-verify redaction; add masking test |
| R2 | `websockets` mis-upgrade breaks backend | Critical | Pin 13.1; add constraint comment (already present) |
| R3 | Single-process architecture; crash = full outage | High | Process guard exists; add watchdog |
| R4 | MongoDB is a hard dependency at startup | High | Startup fails without URI; health reports 503 |
| R5 | Engine health `UNKNOWN`/`DEGRADED` (doc claim) | High | Live health check across all **17** engines |
| R6 | Proprietary broker SDK lock-in | Medium | Adapter abstraction already in place |
| R7 | ~450 routes with no committed OpenAPI spec | Medium | Generate/serve OpenAPI at `/openapi.json` |
| R8 | Watchlist triple-API divergence | Medium | Consolidate; document contract |
| R9 | **73** dead frontend pages (1 live of 74 in `_pages`) | Low | Import graph done; lowest-risk step is a README, not deletion |
| R10 | No CI/CD verification pipeline observed | Medium | Add lint + type + test gates |
| R13 | ~~Route shadowing~~ → **CLOSED** — disproven by path-shape analysis | — | None |
| R17 | **Unauthenticated engine control plane** — 37 of 40 routers unauthenticated, incl. engine stop/restart + broker select; `HOST=0.0.0.0` | **Critical** | `security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` |
| R18 | **JWT secret falls back to hardcoded `dev-insecure-jwt-secret`**; `JWT_SECRET` absent from `.env` | **Critical** | Fail closed at signing time |
| R19 | Wildcard CORS + `allow_credentials=True`, shipped in `.env.example` | High | Pin origin; fix example |
| R20 | Documented remediation commands do not exist | High | `ENGINE_CONTROL_API.md`; Gap 1 unexecutable |
| R21 | AI-agent doc teaches the wrong WebSocket model | High | Fix or flag bodies |
| R22 | Engine registry mismatch (17 in code vs 15 in docs) | High | Correct 5 documents |
| R23 | Banner character damage (cosmetic) | Low | Repair with R21 |
| R24 | 6 implemented-but-unregistered `core/engines/` modules | Medium | Human decision |
| **R-34** | **Repository does not contain its own application** — 5 commits, 141 tracked, **~975 untracked**; a clone cannot build or run it | **Critical** | Commit in logical slices. **Highest-leverage single action** |
| **R-36** | **Session token is unsigned** — forgeable offline, no `expires` | **Critical** | Sign it; enforce expiry server-side |
| **R-37** | **App lock fails open** — `!appLock` grants operator access; disabled by default | **Critical** | Fail **closed**; ship locked-by-default |
| **R-38** | Forged session escalates to a **backend operator JWT** returned to the browser | High | Issue a scoped realtime token; never forward operator credentials |
| **R-39** | **No broker failover exists** — status computed, never acted on; manual switch only, via an open endpoint | **High** | Health probe + bounded retry + loud `dummy` fallback |
| **R-40** | **Two broker-selection systems that never reconcile** — registry resets on restart while the manager persists | **High** | Pick one source of truth; persist it |
| R41 | Shoonya capability table contradicts its adapter; **tests enforce the claim** | Medium | Read bodies; fix table or tests |
| R42 | `get_market_data_status()` reports the wrong broker for `dummy` | Medium | Gate the status read on the selected broker |

Full register: `PROJECT_RISKS.md` (42 risks, 38 unique IDs after D-20 renumbering).

---

## 9. Coverage of Required Documentation

| Requirement | Document | Status |
|-------------|----------|--------|
| Project Map | `PROJECT_MAP.md` | Complete |
| Architecture Overview | `ARCHITECTURE_OVERVIEW.md` | Complete |
| Dependency Map | `DEPENDENCY_MAP.md` | Complete |
| Data Flow Map | `DATA_FLOW_MAP.md` | Complete |
| Glossary | `PROJECT_GLOSSARY.md` | Complete |
| Gaps | `PROJECT_GAPS.md` | Complete |
| Risks | `PROJECT_RISKS.md` | Complete |
| Assumptions | `PROJECT_ASSUMPTIONS.md` | Complete |
| Change History | `PROJECT_CHANGE_HISTORY.md` | Complete |
| SDK Catalog | `architecture/SDK_CATALOG.md` | Complete |
| Broker Integration Map | `broker/BROKER_INTEGRATION_MAP.md` | Complete |
| Database Architecture | `database/DATABASE_ARCHITECTURE.md` | Complete |
| Database Collection Catalog | `database/DATABASE_COLLECTION_CATALOG.md` | Complete |
| Database Lifecycle | `database/DATABASE_LIFECYCLE.md` | Complete |
| WebSocket Architecture | `architecture/WEBSOCKET_ARCHITECTURE.md` | Complete |
| API Catalog | `api/API_CATALOG.md` | Complete |
| Frontend Architecture | `frontend/FRONTEND_ARCHITECTURE.md` | Complete |
| Frontend Route Map | `frontend/FRONTEND_ROUTE_MAP.md` | Complete |
| Frontend Data Flow | `frontend/FRONTEND_DATA_FLOW.md` | Complete |
| Configuration Catalog | `config/CONFIGURATION_CATALOG.md` | Complete |
| Scheduler & Lifecycle | `runtime/SCHEDULER_AND_LIFECYCLE.md` | Complete |
| Testing Architecture | `testing/TESTING_ARCHITECTURE.md` | Complete |
| Verification Matrix | `testing/VERIFICATION_MATRIX.md` | Complete |
| Security Architecture | `security/SECURITY_ARCHITECTURE.md` | Complete |
| Observability Architecture | `observability/OBSERVABILITY_ARCHITECTURE.md` | Complete |
| Failure & Recovery | `architecture/FAILURE_AND_RECOVERY.md` | Complete |
| Duplicate & Legacy Findings | `audits/DUPLICATE_AND_LEGACY_FINDINGS.md` | Complete (D-01…D-23) |
| Frontend Pages Audit | `audits/FRONTEND_PAGES_AUDIT.md` | Complete |
| Version Control State | `audits/VERSION_CONTROL_STATE.md` | Complete |
| Gitignore Audit | `audits/GITIGNORE_AUDIT.md` | Complete |
| Frontend Contract | `frontend/FRONTEND_CONTRACT.md` | Complete |
| Auth / Session Forgery | `security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` | Complete |
| Broker Selection & Failover | `broker/BROKER_SELECTION_AND_FAILOVER.md` | Complete |
| Documentation Authority | `DOCUMENTATION_AUTHORITY.md` | Complete |
| Final Report | `FINAL_REPORT.md` | This file |

---

## 10. What Was NOT Done

1. **No live verification** — no backend started, no frontend built, no MongoDB queried, no broker connected.
2. **No route request/response schemas** — only method + path extracted; OpenAPI not generated.
3. **No dependency vulnerability scan** — `pip-audit` / `npm audit` not run.
4. **No test execution** — neither Python nor TypeScript tests were run.
5. **No `.env` inspection** — secret values deliberately not read (names were checked).
6. **No backend engine implementation deep-read** — engine files identified but not line-audited.
7. **No `components/` audit** — 137 untracked component files unread; the *transport layer*
   (`lib/kaustubh-types.ts`, `lib/backend.ts`, `lib/realtime-ws.ts`, `lib/engine-realtime.ts`,
   `lib/env.ts`, `lib/auth-crypto.ts`) **was** read in full.
8. **No Shoonya adapter body review** — method names compared against `base.py`, but bodies
   not read, so R-41 cannot be closed either way.
9. **No code remediation** — R-36/R-37/R-38 and R-39/R-40 are documented, **not fixed**;
   all require owner approval.
10. **No commits or staging** — the owner chose audit-only. ~~975 untracked files remain.

**Superseded items** (previously listed as "not done", now complete):
~~No frontend import-graph analysis~~ → done, 1 live / 73 dead.
~~No git history analysis~~ → done, 5 commits / ~975 untracked.

---

## 11. Recommended Next Steps (Priority Order)

Ordered by *what changes the risk picture*, not by doc order.

| Priority | Action | Unblocks |
|----------|--------|----------|
| **P0** | **Fix the auth chain**: sign the session token, make the app lock fail **closed**, stop returning operator credentials to the browser | R-36, R-37, R-38 |
| **P0** | **Commit the application** in logical slices (ignore `python-service/downloads/` first) | R-34; makes every other item reproducible |
| **P0** | Treat the backend as internet-exposed until R-17 is fixed: bind loopback, restrict CORS, gate the engine-control router | R-17, R-19 |
| P0 | Start backend with dummy broker mode; verify all **17** engines reach `RUNNING` | R5 |
| P0 | Verify `/api/settings` never returns secrets | R1 |
| P1 | Generate OpenAPI spec; diff against `api/API_CATALOG.md`; generate TS types from it | R7, GAP-033, GAP-035 |
| P1 | Add the missing auth tests (tampered/expired token, fail-closed lock, token scoping) | R-36/37/38 |
| P1 | Add CI with a **repo-completeness gate** as step 0 | R-10, R-34 |
| P1 | Build frontend (`npm run build`) and `tsc --noEmit` | R9 |
| P2 | Decide broker failover policy and unify broker selection | R-39, R-40 |
| P2 | Read the Shoonya adapter bodies; fix the capability table or its test | R-41 |
| P2 | Run `pip-audit` and `npm audit` | Security posture |
| P2 | Run the Python test suite; record results | Verification matrix |
| P2 | Resolve watchlist triple-API divergence | R8 |
| P3 | Live WS#1/WS#2 test with Kotak (non-trading hours) | WS behavior |
| P3 | Verify scheduler phase transitions (market hours or clock override) | Lifecycle |
| P3 | Review architecture docs for stale "MIGRATED" content | Doc hygiene |

---

## 12. Documentation Index

Start here for any new work:
1. `PROJECT_MAP.md` — navigation
2. `FINAL_REPORT.md` — this file
3. Domain catalog for the area you are changing
4. `PROJECT_RISKS.md` before making risky changes
5. `PROJECT_GAPS.md` to see known unknowns

**Governance**: `C:\project\PROJECT_IMPLEMENTATION_RULE.md` always takes precedence.

---

## 13. Sign-Off

| Item | Result |
|------|--------|
| Discovery completeness | `PARTIALLY_COMPLETE` |
| Documentation bootstrap | `COMPLETE` |
| Static code-to-doc mapping | `SUBSTANTIALLY_COMPLETE` for the areas audited; `PARTIALLY_COMPLETE` overall |
| Live verification | `NOT_VERIFIED` — nothing was run |
| Application behavior changes | **NONE** (only `tailwind.config.ts` restored from `HEAD`, approved) |
| Secrets exposed in created docs | **NONE** (only variable *names* referenced) |
| Git commits / staging | **NONE** |
| Overall | `PARTIALLY_COMPLETE` |

---

## 14. Change Log — 016 DB Writer Tick Persistence Authority (2026-09-28)

| Item | Result |
|------|--------|
| DB Writer is the single tick persistence authority | `IMPLEMENTED` + automated tests |
| Market Watch no longer decides or writes tick persistence | `IMPLEMENTED` + regression test |
| Three independent permissions, OFF by default | `IMPLEMENTED` (pre-existing `False` default kept) |
| Backend GET/PUT API | `IMPLEMENTED` + 6 API tests |
| Service page Settings ⚙️ with 3 toggles, no optimistic state | `IMPLEMENTED` + `tsc`/`eslint` clean |
| Batching / backpressure / dedup identities | **UNCHANGED** (no new buffers, keys or inserts) |
| Defect: Market Watch bypassed the DB Writer permission | **FIXED** |
| Defect: overlapping-classification dedup was unreachable | **FIXED** |
| Defect: settings endpoint returned a raw 500 when MongoDB was down | **FIXED** |
| Backend test suite | `1189 passed, 0 failed` |
| Route registration + endpoint behaviour over real HTTP | **VERIFIED** (scratch app mounting the real router; `app.py:1020`) |
| Frontend typecheck / lint | clean |
| Frontend tests | `273/274` — 1 pre-existing unrelated failure |
| Live broker + live MongoDB | `NOT_VERIFIED` (GAP-036) — run `pending/PENDING-004-db-writer-tick-persistence-live-verification.md` |
| Browser exercise of the Settings panel | `NOT_VERIFIED` (GAP-037) — same pending file, step 7 |
| Database changes | **NONE** (no new collection, index or TTL) |
| Secrets involved | **NONE** |
| Session log | `logs/LOG-002-2026-09-28-db-writer-tick-persistence-authority.md` |
| **Next-session entry point** | **`pending/PENDING-004-db-writer-tick-persistence-live-verification.md`** — start with its "Do This First" section; the backend on port 8000 predates this change and must be restarted or every check returns 404 |
| Final status | `VERIFIED_WITH_LIMITATIONS` |

---

## 15. Change Log — TEMPORARY STORAGE CAP (2026-09-29)

> **Operational override, not a design change.** The Atlas cluster
> (`mongodb+srv://…cluster0.1ed9ojp.mongodb.net/kaustubh`) has only **~400 MB free**, and
> Market Watch emits one tick per subscribed instrument across the whole daily universe. The
> operator instructed that only the **personal no-expiry** stream may be written, for now.
>
> Implemented as `TICK_PERSISTENCE_HARD_CAP` in `db_writer_engine.py`, enforced inside
> `_persistence_enabled_for_source()` — the single chokepoint every persistence path consults.
> It overrides the runtime settings in **both** directions (force-ON for no-expiry, force-OFF for
> the rest), so it cannot be defeated by the API, the UI, a direct Mongo write, or a stale cache.
>
> **Three defects found while doing it:**
> 1. `buffer_documents("market_ticks", …)` bypassed the authority entirely and wrote ticks with no
>    classification, no permission check and no cap — the exact volume that filled the disk. No
>    production caller did this, but it was one careless caller away. Now **refused**; the gated
>    paths use a private `_buffer_documents_unchecked()`.
> 2. `PATCH /api/settings` can write the `dbw_*` keys directly, bypassing the dedicated endpoint's
>    validation. Probed and confirmed the cap still holds (it is applied at the decision point, not
>    the settings layer). Pinned as a regression test so it cannot later move to a weaker layer.
> 3. A rejected toggle erased its own error message — the follow-up re-read cleared the banner, so
>    the operator saw a switch snap back with no explanation. Fixed.
>
> The API now reports `storageCapActive`, `storageCapReason` and per-permission `hardCapped` /
> `configuredEnabled`, refuses to enable a capped permission, and the Settings panel shows a
> `CAPPED` badge with a disabled toggle and a plain-language explanation — the UI cannot show a
> value the backend ignores.
>
> **Still open for the operator:**
> - The surviving stream is the one that **never expires**, so it will eventually consume the
>   remaining space. A retention/pruning policy is the real fix; this only buys time.
> - Existing `market_ticks` documents are **not** deleted. This stops growth; it does not reclaim
>   space already used.
> - The database is named **`kaustubh`**, not `kaustubh_test` — it is the live Atlas database this
>   application uses. Confirm that is intended before the live pass.
>
> **To remove the cap:** delete the `TICK_PERSISTENCE_HARD_CAP` entries. Nothing else changes — the
> runtime settings are still read and take effect the moment a name is absent from the dict.
>
> Backend `1202 passed`; `tsc`/`eslint` clean; frontend `273/274` (1 pre-existing unrelated
> failure). **Not live-verified** — the backend on port 8000 must be restarted first.
> → `logs/LOG-003-2026-09-29-db-writer-tick-persistence-storage-cap.md`
> → `pending/PENDING-004-db-writer-tick-persistence-live-verification.md` (updated: adds claim C6)

---

## 16. Change Log — 017 Data Center Observability Center (2026-09-29)

> **An upgrade of the one canonical `/data-saver/data-center` page, in place.** No duplicate
> page, no desktop/mobile variant, no second engine, no second PWA. The existing PWA
> infrastructure (`public/sw.js` v7, `manifest.json`, `viewportFit: 'cover'`) already
> precached this route and was **not** re-architected.
>
> **The problem:** `services/data_center.py` only answered a *storage/history* question
> (bytes, ticks, per day). The page could not say which MongoDB it was on, which engines
> existed, who owned which collection, what the dependency graph was, whether the tick
> pipeline was healthy, or what the retention contract actually was. Panels inferred
> ownership by name-matching.
>
> **What was added:** six read-only backend planes with independent TTL / single-flight
> and failure isolation — `database` (10s), `engines`, `topology`, `dbwriter` (10s),
> `ownership`, `retention` (30s) — each returning
> `{ plane, source, available, error, … }`. `available: false` is a supported state. Plus
> six typed frontend normalizers, six panels, six independent proxy sections, and a
> 15s/60s split-cadence poll that merges in place.
>
> **Read-only, verified by call-site review:** no `insert` / `update` / `delete` /
> `create_index` / `drop` anywhere in the plane module. `mongo_stats()` is *reused* rather
> than re-implemented, so the page did not double MongoDB load. Tick-persistence authority
> is untouched — `ticks` is attributed to DB Writer, and its counters are republished from
> the writer's own `status_snapshot()`, never recomputed.
>
> **Secrets, verified by test:** `serverStatus` is allow-listed (7 groups, 18 paths) rather
> than copied; a test walks a real-shaped document to confirm the non-allow-listed `host`
> is dropped, and another asserts no plane response contains a URI, password, key or secret.
>
> **Six real defects were caught by the tests written for this change** — the significant one
> being that the store requested `'dbwriter'` while the proxy serves `'dbWriter'`. The proxy
> filters unknown names silently, so the 15s live poll simply stopped fetching DB Writer and
> the panel froze at its first value with **no error anywhere** — on a page whose purpose is
> to not lie. Also fixed: a failed `serverStatus` reported as *available with no metrics*;
> a TTL index field rendered as `("expiry", 1)` because pymongo returns pairs not a dict; a
> failed `mongo_stats` rendering as "this database is empty"; a plane cache key that ignored
> `limit`; and a `TypeError` on the corrected key.
>
> | Item | Result |
> |------|--------|
> | Six plane endpoints routed, isolated, read-only | `IMPLEMENTED` + verified via the real FastAPI router |
> | Every panel carries its backend `source` | `IMPLEMENTED` |
> | Missing data never coerced to `0` / `[]` / `false` | `IMPLEMENTED` + 11 normalizer tests |
> | Unmapped collections report `UNMAPPED` / `NOT VERIFIED` | `IMPLEMENTED` (static, code-derived map) |
> | One canonical page, no duplicate route | `VERIFIED` (`next build` route table) |
> | Backend test suite | `1248 passed`, 12 subtests passed |
> | Frontend tests | `286/287` — 1 pre-existing unrelated failure (`topbar-status.test.ts:331`) |
> | `tsc` / `eslint` (changed files) / `next build` | clean / clean / clean |
> | Defects F1–F5, B1–B5 | **FIXED** (see implementation record §4) |
> | Live MongoDB (real `serverStatus`, `index_information`, owners, TTL) | `NOT_VERIFIED` — highest-priority remaining check; B1/B2 were both shape bugs |
> | Browser layout at 375/390/430/768/1024/1280/1440/1920 | `NOT_VERIFIED` — no browser, no screenshot |
> | PWA standalone + safe area on device | `NOT_VERIFIED` |
> | Ownership map correctness vs runtime | `NOT_VERIFIED` — static, per-row-attributed, unratified |
> | Database changes | **NONE** (read-only) |
> | Secrets involved | **NONE** |
> | Audit: backend | `audits/backend/DATA_CENTER_OBSERVABILITY_PLANES_AUDIT.md` |
> | Audit: frontend | `audits/frontend/DATA_CENTER_PLANES_UI_AUDIT.md` |
> | Implementation record | `implementation/017-data-center-observability-center.md` |
> | Verification record | `verification/017-data-center-observability-center-verification.md` |
> | **Final status** | **`VERIFIED_WITH_LIMITATIONS`** |
>
> **Carried forward, not fixed here (they belong to other modules):**
> - `TICK_PERSISTENCE_LABELS` in `services/db_writer_engine.py` contains mojibake
>   (`â€”` for an em dash). The DB Writer plane republishes it verbatim, so it is now
>   user-visible on the Data Center.
> - `tests/topbar-status.test.ts:331` still fails; that file imports only
>   `lib/topbar-status.ts`, which this work does not touch.
> - The Atlas cluster is still at ~400 MB free, and change 015's hard cap is still
>   active — the retention panel now makes that contract visible, but nothing in this
>   change prunes anything.

---

## 17. Change Log — 020 Data Quality Redesign + Logic Rebuild + Engine Integration (2026-10-01)

> **Not a second pipeline, not fake numbers — a forensic repair of the one
> canonical `/data-saver/quality` page and the backend it already had.** The
> Data Quality service (`services/data_quality.py`) and its 20-route API were
> already the authoritative implementation; the page showed `Not measured /
> No data / Temporarily unavailable` because (a) the backend measured the
> wrong scope for filtered views, crashed per-symbol duplicate scopes, and
> stalled page loads with unbounded scans, and (b) the page never sent most
> filters to the backend and fired 7 heavy aggregations per mount, poll and
> keystroke.
>
> **Backend (all real defects, all fixed, all tested):**
> `quality_symbols` referenced an undefined `start` (NameError swallowed per
> symbol → duplicates silently 0) and counted duplicate groups while the
> global metric reports excess rows; per-symbol ordering/invalid/missing were
> hardcoded `0` (now `null` + `*Measured: false`); `_compute_all_filtered`
> measured the unfiltered scope while totals were filtered (now passes the
> full slice via `extra_match` + window overrides); the metric cache key
> ignored filters (now covers the full filter set); the ordering walk is
> capped (200k docs, 8s timeout, `orderingTruncated` flag) and aggregations
> carry timeouts; `/pipeline` is now the 6 canonical stages (Broker Feed →
> WebSocket → Validation → Quality → DB Writer → MongoDB) with A–G hop
> latency + `NOT MEASURED` notes; `/storage` carries provider identity from
> `get_mongo_info()` (never the URI) and an honest retention contract.
>
> **Frontend (same page, rebuilt data layer):** same-origin client
> (`lib/data-quality-client.ts`) through the Next proxy (no more direct
> loopback reads); every filter reaches the backend (date presets + picker,
> session presets, exchange/segment, debounced symbol search, opt-in intraday
> range); phased loading (snapshot first, details deferred, trend/duplicates
> lazy — duplicates manual-only, 24h cap); scan completion refreshes scored
> phases over the single existing SSE fan-out; responsive header wrap; honest
> empty/error states kept everywhere.
>
> | Item | Result |
> |------|--------|
> | Filtered metrics measure their own slice; cache isolates filter sets | `IMPLEMENTED` + 11 backend tests |
> | Per-symbol duplicates scoped + excess-row semantics; unmeasured cells null | `IMPLEMENTED` + tested |
> | Bounded scans (count/dup/ordering/distinct timeouts, walk cap + flag) | `IMPLEMENTED` |
> | 6-stage pipeline + hop latency + retention + provider, no secrets | `IMPLEMENTED` + tested |
> | Same-origin client, functional filters, debounced search, phased load | `IMPLEMENTED` + 6 client tests |
> | Lazy capped duplicate scan; realtime scan refresh | `IMPLEMENTED` |
> | Backend suite (`-k quality`) | `48 passed` (37 existing + 11 new) |
> | Frontend suite | `364/365` — 1 pre-existing unrelated failure (`topbar-status.test.ts:331`) |
> | `tsc` / `eslint` (changed files) / `next build` | clean / 0 errors / one `/data-saver/quality` route |
> | Live broker + live MongoDB + browser (responsive/PWA) | `NOT_VERIFIED` — no live system in session |
> | Database changes | **NONE** (no new collection, index or TTL) |
> | Secrets involved | **NONE** (provider label carries source/db/host/version/pool only) |
> | Spec | `docs/engines/DATA_QUALITY.md` (new) |
> | Audits | `audits/DATA_QUALITY_BACKEND_AUDIT.md`, `audits/DATA_QUALITY_FRONTEND_AUDIT.md` |
> | Implementation record | `implementation/020-data-quality-redesign.md` |
> | Verification record | `verification/020-data-quality-redesign-verification.md` |
> | **Final status** | **`IMPLEMENTED_NOT_VERIFIED`** |
>
> **Carried forward, not fixed here:**
> - `tests/topbar-status.test.ts:331` still fails (pre-existing, unrelated).
> - `app/_pages/data-quality/page.tsx` (dead legacy) left untouched; deletion
>   is a separate dead-code decision.
> - Endpoint-level `_CACHE` in `api/quality.py` intentionally unwired (single
>   global key would collide across filter sets).
> - Completeness stays presence-based and volume stays NOT MEASURED (no
>   expected-tick model / volume validator exists — spec §13).

---

## 18. Change Log — 021 Trade Page Realtime Performance (2026-10-01)

> **Not a `next dev` tuning trick — a forensic fix of event-loop starvation and
> a ~7 GB heap.** The Trade page "hung" because the asyncio loop spent its time
> on synchronous per-tick work for 2682 instruments (py-spy: 34.2 %
> `feature_engine._process_tick`, 30.8 % Market Watch, 22.5 % ws ingest; then,
> after round one, 28 % `session_manager.active_registry()` via the DB Writer
> 1 s registry TTL). The handlers served in <1 ms; requests waited ~2 s in the
> loop. Idle feed → 2–3 ms; live flood → seconds — so it was not `next dev`.
>
> **Backend (fixed at each owner):** `momentum_windows` O(1) on the oldest
> deque element (`MOMENTUM_WINDOWS_MIN`); `CalculatorState` incremental VWAP +
> version-memoised `prices()`; `market_watch_engine.mw_config()` memoised 1 s;
> `ws_socket/engine/engine.py` `RAW_BUCKET_DEPTH` 2000 → 64 and `live_feed()`
> memoised 2 s; `session_manager.active_registry()` memoised on `subs_revision`
> and `subscription_snapshot()` computes `_subscribers` once;
> `scheduler._refresh_readiness()` reads `is_active()` instead of building the
> full snapshot.
>
> **Frontend:** one positions source in `trade-page.tsx` (`existingPosition`
> derived from `myPositions`) with `dedupFetch('positions:<key>')` and a real WS
> unsubscribe; `<p>` → `<div>` hydration fix in `history-page.tsx:270` and
> `basket-page.tsx:524`.
>
> | Item | Result |
> |------|--------|
> | Event-loop de-starvation (measured hot paths) | `IMPLEMENTED` + live verified |
> | `GET /api/trade/demo/positions` latency | ~35–200 ms (was 1320–3602 ms) |
> | Backend RSS | ~1.9 GB stable (was ~7.0–7.3 GB) |
> | `engine_ram_percent` | ~66–71 % (was 95 % EMERGENCY) |
> | Backend suite | `1372 passed`, 33 subtests passed |
> | Frontend suite | `364/365` — 1 pre-existing unrelated failure (`topbar-status.test.ts:336`) |
> | `tsc` / `eslint` (changed files) | clean / 0 errors, 28 pre-existing warnings |
> | Live broker feed + restart verification | `VERIFIED` (Kotak dummy, ~500 tps) |
> | Database changes | **NONE** |
> | Secrets involved | **NONE** |
> | Specs updated | `engines/session-manager.md`, `scheduler-engine.md`, `feature-engine.md`, `websocket-engine.md`, `MARKET_WATCH.md` |
> | Implementation record | `implementation/021-trade-page-realtime-performance.md` |
> | Verification record | `verification/021-trade-page-realtime-performance-verification.md` |
> | **Final status** | **`VERIFIED_WITH_LIMITATIONS`** |
>
> **Carried forward, not fixed here:**
> - `avg_tick_latency_ms` remains ~2–5 s; CPU ~95 % of one core at 500 tps.
> - Occasional 0.5–1.5 s tails on `/api/market-watch/status`;
>   `ws_manager.status()` still ~15 % of CPU.
> - `api/search.py` `_margin_cache` is unbounded (`_MARGIN_TTL_SECONDS = 15.0`) —
>   observed, not changed.
> - `tests/topbar-status.test.ts:336` still fails (pre-existing, unrelated).


---

## 19. Serial 022 — Data Center realtime snapshot push over WS#2 + page hierarchy redesign (2026-10-01)

> **Request (user):** *"data-center page ko update kro, check kro, real time kam
> krna chye, redesign kro."* Agreed scope: realtime = **WS#2-push snapshot panels
> with the poll kept as fallback**; redesign = **visual + hierarchy refresh, keep
> all data** (not tabs).
>
> Implementation record: `docs/implementation/022-data-center-realtime-snapshot-push-and-page-redesign.md`
> Verification record: `docs/verification/022-data-center-realtime-snapshot-push-and-page-redesign-verification.md`
> Session log: `docs/logs/LOG-005-2026-10-01-data-center-realtime-and-redesign.md`
>
> **What was actually wrong:** `realtime_section` was listed in `ASYNC_SECTIONS`
> although it is a plain `def`, so `build_snapshot()` awaited a `dict` →
> `TypeError: object dict can't be used in 'await' expression`. The Data Center's
> realtime section therefore always reported `available: false`, and the derived
> health rollup was `UNKNOWN`.
>
> **What was built:**
> - `services/data_center_snapshot.py` — `realtime_section` moved to
>   `SYNC_SECTIONS` (`ASYNC_SECTIONS` = `{storage}` only); added `PUSH_TTL_S = 5.0`
>   + `async get_cached_snapshot(ttl)` so the push and the REST route serve the
>   **same** document (no second aggregation, no per-client fan-out).
> - `connection_engine/channels.py` — new state channel `data_center`.
> - `connection_engine/connection_engine.py` — new producer mirroring the
>   existing `engines` pattern: `DATA_CENTER_SNAPSHOT_INTERVAL_S = 5.0`,
>   `_has_data_center_subscribers()` gate (**no subscriber → no build**),
>   `data_center_snapshot_frame()`, `_data_center_snapshot_loop()`, task created
>   in `start()` / cancelled in `shutdown()`, wire type `data_center.snapshot`,
>   `source: "data_center"`. No new engine, worker or scheduler job.
> - `lib/data-center-store.ts` — `snapshotSource` / `realtimeUpdatedAt` /
>   `realtimeConnected`; `applyRealtimeSnapshot()` (rejects incompatible schema,
>   transport error, older document); `attachRealtime()` / `detachRealtime()`
>   (with a real `unsubscribe`) wired into the store's timer lifecycle. The push is
>   driven from the **store singleton**, not a React hook, to avoid ~4 Hz
>   tick-rate re-renders of a very long page.
> - `app/(phase2)/data-saver/data-center/page.tsx` — body regrouped into five
>   regions (**Overview / Realtime / Storage & pipeline / Engines / History &
>   telemetry**), every existing panel kept, `Live · WS#2` vs `Polling 15s` chip
>   in the header, `space-y-6` outer rhythm, footer states the delivery path.
>
> | Item | Result |
> |------|--------|
> | `realtime` section defect | **fixed** (classification) + 2 regression tests |
> | Realtime delivery for the snapshot | **new `data_center` WS#2 channel, 5 s, subscriber-gated** |
> | Second socket / new engine created | **none** (WS#2 reused) |
> | Snapshot schema / REST contract | **unchanged** (`schemaVersion 2`, 9 sections) |
> | Database changes | **NONE** |
> | Secrets involved | **NONE** |
> | Backend targeted suite | `84 passed`, 21 subtests passed (was 79) |
> | Backend full suite | `1381 passed`, 33 subtests, **1 pre-existing unrelated failure** (`test_ws_engine.py::…full_scrip_surface`, untracked test, `sdk_version` 3.0.2 vs 3.0.7) |
> | `tsc --noEmit` | **clean** |
> | `eslint` (changed files) | **0 problems**; whole repo 0 errors / 340 pre-existing warnings |
> | `npm test` | 1 pre-existing unrelated failure (`topbar-status.test.ts:336`) |
> | Live API check | `realtime.available=True`, `overall=DEGRADED` (was `UNKNOWN`), `db.connected=True` |
> | Live WS#2 check | `welcome` advertises `data_center`; subscribe ack ok; `data_center.snapshot` frame received on `channel=data_center`, `source=data_center` |
> | Backend restart onto new code | pid 11920, `health: OK` |
> | Audits updated | backend + frontend Data Center audits (§10 / §8) |
> | Implementation / verification record | `implementation/022-…`, `verification/022-…` |
> | **Final status** | **`VERIFIED_WITH_LIMITATIONS`** |
>
> **Not verified / carried forward:**
> - **No browser pass.** The five-region layout, the `Live · WS#2` badge
>   transition and the poll fallback in the rendered UI were not observed.
> - `lib/data-center-store.ts` still has no test coverage, including the new
>   `applyRealtimeSnapshot` rejection rules.
> - `DEGRADED` is correct, not a bug: `brokerFeed.connected=false` (no broker
>   session) and `backendRealtime.health=NO_DATA` are real measurements; no fake
>   data was substituted.
> - `get_cached_snapshot` is lock-free under a documented single-caller
>   assumption; a second caller would need a lock.
> - Pre-existing failures unchanged: `topbar-status.test.ts:336`,
>   `test_ws_engine.py::…full_scrip_surface`.

---

## 20. Serial 024 — Tick Analytics: operational + historical tick analytics (2026-10-02)

> **Request (user):** rebuild `/data-saver/analytics` 0-to-1 as a real
> operational **and** historical tick analytics system with real backend
> integration, under the project's honesty contract (never default a missing
> metric to `0`; tag provenance in `sources`; report
> `COMPLETE | PARTIAL | NO_DATA` with an explicit `missing[]`).
>
> Implementation record: `docs/implementation/024-tick-analytics-operational-and-historical-analytics.md`
> Verification record: `docs/verification/023-tick-analytics-operational-and-historical-analytics-verification.md`
> Session log: `docs/logs/LOG-006-2026-10-02-tick-analytics.md`
> Engine doc: `docs/engines/TICK_ANALYTICS.md`
> Trace: `docs/opencode/004-tick-analytics-trace.md`
>
> **Ownership:** Tick Analytics is a **read-only consumer** of the tick
> pipeline's telemetry. It never owns the broker feed, the WebSocket Engine,
> the DB Writer, tick writes, orders, sessions or subscriptions, and it opens
> **no new socket** — realtime rides the existing system SSE as one coalesced
> `tick_analytics` frame per second, gated on `state_store.client_count() > 0`.
>
> **What was built:**
> - `services/tick_analytics_daily.py` (new) — per-trading-day rollup stored in
>   `tick_analytics_daily` (unique index on `date`), session periods from
>   `market_calendar` (09:15 → 15:30), per-minute buckets, symbolStats,
>   persistence/storage/quality/latency slices, `anomalies[]`, `missing[]`,
>   `status`, plus `build_report()` and the backfill bookkeeping
>   (`queue_backfill` / `backfill_once` / `backfill_state`). `list_days()` reads
>   **stored documents only** (`SUMMARY_FIELDS`) — it never aggregates on the
>   request path.
> - `api/tick_analytics.py` — **14 new routes** (`summary`, `daily`,
>   `daily/{date}`, `top-symbols`, `symbol-stats/{symbol}`, `rate`,
>   `persistence`, `sources`, `storage`, `quality`, `latency`, `report`,
>   `reports`, `export?format=csv|json`); the **8 legacy routes preserved**
>   (22 total on `/api/data-saver/tick-analytics`).
> - `app.py` — `_tick_analytics_backfill_loop` (8 s, ≤2 days/pass, startup
>   queues `recent_days(30)`) and `_tick_analytics_publish_loop` (1 s, only
>   while a subscriber exists); both cancelled on shutdown.
> - `services/tick_analytics.py` — composition layer (`summary()` with a 5 s
>   cache, `live_event()`, `latency_block()`) over `tick_buffer`,
>   `daily_summaries`, `data_saver_telemetry`, `data_quality`,
>   `db_writer_engine`, `pipeline_latency`, `market_calendar`, `collstats`.
> - Frontend: `lib/tick-analytics.ts` (one shared section contract + pure
>   helpers), rewritten section-scoped single-flight BFF
>   `app/api/phase2/analytics/route.ts`, `backendText()` for CSV passthrough,
>   `tickAnalytics` / `tickAnalyticsEpoch` on `realtime-provider.tsx`, and the
>   rebuilt page with **per-section** fetch/error/reload
>   (`useSection()`) so one failure degrades one card instead of the page.
>
> **Round 2 (same day) — page redesign** (request: *"page ko update kro redesign
> kro search kam krna chye or details bhi aane chye"*): section order rebuilt to
> spec (Controls → Today → Tick Rate → Daily → Session/Periods → Top Symbols →
> Selected Symbol → Persistence → Quality/Storage → Report → History →
> Provenance); Top Symbols field mapping corrected to the real `symbolStats`
> keys (`firstTickAt` / `lastTickAt` / `avgRate` / `sharePct`) plus a working
> Top 10/25/50 selector; Daily table gained **Trading Day / Skipped / Active**
> columns; Selected Symbol dropped the never-populated **Depth** card for
> **Share of Day** + `exchange`/`instrumentToken`; session-analysis strip added
> for any selected date; new `TodaySection` / `TickRateSection` /
> `PersistenceSection` / `QualityStorageSection` / `ProvenanceFooter` all read
> the single `summary` snapshot (no extra fetches). Fields the backend does not
> measure are shown as `—` with a footnote, never as a number.
>
> **Three defects found by running it against real MongoDB (not by reading it):**
> 1. `data_quality._cache_key` does **not** include `start_override` /
>    `end_override`, so building two different days inside the 60 s TTL would
>    return the wrong day's metrics. Fixed by passing
>    `extra_match={"ts": {"$gte": start, "$lt": end}}`.
> 2. `get_day(refresh=True)` still returned the **stored** document for a past
>    day, so `backfill_once()` was re-serving the exact document it was queued
>    to rebuild — the first real backfill reported "built 6 days" while every
>    row kept its old status. Fixed: `refresh=True` skips the stored read.
> 3. A day with **writer activity but zero stored documents** was reported as
>    `NO_DATA`, hiding the gap (real case: `2026-10-01 received=15811,
>    stored=0`). Now `PARTIAL` + `storedTickDocuments` in `missing[]` +
>    `NO_STORED_DOCUMENTS_FOR_DAY`; `NO_DATA` only when there is no stored doc
>    **and** no writer activity. Also removed the BFF's legacy
>    `/api/ticks/recent` fallback (unlabelled provenance).
>
> | Item | Result |
> |------|--------|
> | New collection | `tick_analytics_daily` (analytics rollup only; no change to `ticks` / `daily_summaries`) |
> | New REST routes | **14** (8 legacy preserved → 22 total) |
> | New WebSocket / broker socket | **none** — 1 Hz coalesced frame on the existing system SSE, subscriber-gated |
> | Schema / secrets | **none** |
> | Backend targeted suite | `68 passed` (`test_tick_analytics_daily.py` 36 + `test_tick_analytics.py` 32) |
> | Backend full suite | `1417 passed`, **1 pre-existing unrelated failure** (`test_ws_engine.py::…full_scrip_surface`, `sdk_version` 3.0.2 vs 3.0.7) |
> | Frontend targeted suite | `28/28` (`tests/tick-analytics.test.ts`) |
> | `npm test` | 1 pre-existing unrelated failure (`topbar-status.test.ts:331`) |
> | `tsc --noEmit` / `eslint` | **clean** (repo-wide 0 errors) |
> | REST over real HTTP + real MongoDB | scratch app mounting only this router: **16/16 endpoints → 200**, JSON-safe, CSV header exact, invalid date degrades honestly, legacy routes intact |
> | Real 7-day backfill | 7 queued → 6 built in ~1.1 s (today skipped by design); statuses and `missing[]` checked against the live counters |
> | Backend restart onto new code | **NOT DONE** — `start_backend.py` refuses a duplicate; the running process still answers 404 on the new prefix |
> | **Final status** | **`IMPLEMENTED_AND_VERIFIED_WITH_LIMITATIONS`** |
>
> **Not verified / carried forward:**
> - **No live-port smoke and no browser pass.** Restarting the backend on port
>   8000 requires stopping the current process (singleton guard) and was
>   deliberately not done without the operator's confirmation.
> - **Observation (pre-existing, not caused or fixed by this change):** the
>   `ticks` collection holds 0 documents while `daily_summaries` records real
>   per-day activity (e.g. 15 811 on 2026-10-01). Correctly surfaced as
>   `PARTIAL` + `storedTickDocuments`; the root cause (retention, storage cap
>   or permission) was not investigated here.
> - Pre-existing failures unchanged: `topbar-status.test.ts:331`,
>   `test_ws_engine.py::…full_scrip_surface`.
