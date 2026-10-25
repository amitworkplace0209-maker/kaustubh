# PROJECT_MAP.md

## KAUSTUBH Trading Platform - Project Navigation Map

**Last Updated**: 2026-09-28
**Version**: 1.0
**Status**: ACTIVE

---

## Quick Start for New AI Agents

### 1. READ FIRST (Mandatory)
- `C:\project\PROJECT_IMPLEMENTATION_RULE.md` - Governance rules (2603 lines)
- `C:\project\docs\FINAL_REPORT.md` - Living master project report
- `C:\project\docs\ARCHITECTURE_OVERVIEW.md` - High-level architecture

### 2. CORE ARCHITECTURE

**Numbered set (00–35) — appears to be the canonical/structured series:**

| # | File | Topic |
|---|------|-------|
| 00 | `00_ARCHITECTURE_INDEX.md` | **Index — read this first** |
| 01 | `01_SYSTEM_OVERVIEW.md` | System identity & principles |
| 02 | `02_ENGINE_ARCHITECTURE.md` | Engine classification & contracts |
| 03 | `03_ENGINE_DEPENDENCY_GRAPH.md` | Dependency DAG & startup order |
| 04 | `04_STARTUP_SHUTDOWN_LIFECYCLE.md` | Process lifecycle |
| 05 | `05_RUNTIME_LIFECYCLE.md` | Runtime lifecycle |
| 06 | `06_BROKER_ARCHITECTURE.md` | Broker adapters |
| 07 | `07_SESSION_ARCHITECTURE.md` | Session architecture |
| 08 | `08_WEBSOCKET_ARCHITECTURE.md` | 4-WebSocket architecture |
| 09 | `09_REALTIME_DATA_FLOW.md` | Realtime data flow |
| 10 | `10_MARKET_DATA_FLOW.md` | Market data flow |
| 11 | `11_TRADING_FLOW.md` | Trading flow |
| 12 | `12_ORDER_LIFECYCLE.md` | Order lifecycle |
| 13 | `13_RISK_MARGIN_ARCHITECTURE.md` | Risk & margin |
| 14 | `14_POSITION_PNL_ARCHITECTURE.md` | Position & P&L |
| 15 | `15_TARGET_SQUAREOFF_ARCHITECTURE.md` | Target & squareoff |
| 16 | `16_AUDIT_NOTIFICATION_ARCHITECTURE.md` | Audit & notifications |
| 17 | `17_DATABASE_ARCHITECTURE.md` | MongoDB |
| 18 | `18_CONFIGURATION_ARCHITECTURE.md` | Configuration |
| 19 | `19_UI_ARCHITECTURE.md` | UI architecture |
| 20 | `20_SERVICE_PHASE_ARCHITECTURE.md` | Service phases |
| 21–22 | `21_PHASE_1_ARCHITECTURE.md`, `22_PHASE_2_ARCHITECTURE.md` | Phase 1/2 |
| 23 | `23_TRADING_TERMINAL_ARCHITECTURE.md` | Trading terminal |
| 24 | `24_PWA_ACCESSIBILITY_ARCHITECTURE.md` | PWA & a11y |
| 25 | `25_SECURITY_ARCHITECTURE.md` | Security |
| 26 | `26_ERROR_RECOVERY_ARCHITECTURE.md` | Error recovery |
| 27 | `27_OBSERVABILITY_ARCHITECTURE.md` | Observability |
| 28 | `28_API_ARCHITECTURE.md` | API architecture |
| 29 | `29_EVENT_ARCHITECTURE.md` | Event architecture |
| 30 | `30_ENGINE_UI_MAPPING.md` | Engine → UI mapping |
| 31 | `31_CURRENT_VS_TARGET.md` | **Current vs target state** |
| 32 | `32_ARCHITECTURE_GAPS.md` | **Known architecture gaps** |
| 33 | `33_MIGRATION_PLAN.md` | Migration plan |
| 34 | `34_DEVELOPER_ONBOARDING.md` | **Developer onboarding** |
| 35 | `35_AI_AGENT_CONTEXT.md` | **AI agent context** |

**Unnumbered set — overlaps heavily with the numbered set (see D-11):**

`ARCHITECTURE_DOCUMENTATION_AUDIT.md`, `BROKER_ARCHITECTURE.md`, `BROKER_SELECTION_FLOW.md`, `DATA_FLOW_MAP.md`, `ENGINE.md`, `ENGINE_ARCHITECTURE.md`, `ENGINE_DEPENDENCY_GRAPH.md`, `FAILURE_AND_RECOVERY.md`, `FINAL_PRODUCTION_ARCHITECTURE_AUDIT_REPORT.md`, `ORDER_POSITION_FLOW.md`, `PHASE_1_2_3_4_RESPONSIBILITIES.md`, `REALTIME_DATA_FLOW.md`, `SCHEDULER_LIFECYCLE.md`, `SDK_CATALOG.md`, `SESSION_MANAGER_ENGINE.md`, `WEBSOCKET_ARCHITECTURE.md`, `WebSocket_ConnectionManager_Flow.md`, `WEBSOCKET_CONNECTION_MANAGER_ARCHITECTURE_MIGRATION_REPORT.md`, `WEBSOCKET_ENGINE.md`

> **UNREAD / HIGH PRIORITY**: `00_ARCHITECTURE_INDEX.md`, `31_CURRENT_VS_TARGET.md`, `32_ARCHITECTURE_GAPS.md`, `34_DEVELOPER_ONBOARDING.md`, `35_AI_AGENT_CONTEXT.md` — these are existing navigation and gap documents that should be reconciled with the new master files. See `PENDING-003`.

### 3. ENGINE SPECIFICATIONS (Authoritative — filenames verified)
| File | Engine |
|------|--------|
| `ENGINE_INVENTORY.md` | **Engine inventory — see the ⚠ CORRECTION NOTICE at the top; the "15 engines" count is wrong** |
| `MARKET_WATCH.md` | Market Watch engine (comprehensive) |
| `scheduler-engine.md` | Scheduler Engine |
| `session-manager.md` | Session Manager (comprehensive) |
| `websocket-engine.md` | WebSocket Engine |
| `watchlist-engine.md` | Watchlist Engine |
| `feature-engine.md` | Feature Engine |
| `order-engine.md` | Order Engine |
| `position-engine.md` | Position Engine |
| `margin-engine.md` | Margin Engine |
| `RISK_ENGINE.md` | Risk Engine (note: uppercase filename) |
| `target-engine.md` | Target Engine |
| `squareoff-engine.md` | Squareoff Engine |
| `storage-engine.md` | Storage Engine |
| `search-engine.md` | Search Engine |
| `notification-engine.md` | Notification Engine |
| `db_writer_engine_detailed.md` | DB Writer Engine |
| `connection-manager.md` | Connection Manager |

**31 files** in `docs\engines\` (the architecture set says "25+"; the architecture set also
says "35 architecture files" when there are **36**).

> ### ⚠ Registered engine count is 17, not 15
> Derived from `python-service\app.py:609-626` and
> `services\legacy_engine_facades.py:428-432`: **14 native + 3 facade**.
> The "15 engines (13 native, 2 facade)" claim in `00`, `31`, `34`, `35` is **wrong**.
> Full reconciliation: `docs/DOCUMENTATION_AUTHORITY.md` §4 · finding D-15.

**Supporting engine docs (not read in this pass)**: `ENGINE_LIFECYCLE.md`, `ENGINE_DEPENDENCY_GRAPH.md`, `ENGINE_CONTROL.md`, `ENGINE_FAILURE_RECOVERY.md`, `BROKER_ENGINE_RELATIONSHIP.md`, `BROKER_TERMINAL_ENGINE_ADVANCED_UI_ENGINE_DETAILED_DESIGN.md`, `AUDIT_ENGINE_ADVANCED_UI_ENGINE_DETAILED_DESIGN.md`, `DUMMY_MODE_ARCHITECTURE.md`, `CHECKLIST.md`, `MARKET_WATCH_ENGINE_IMPLEMENTATION_AUDIT_REPORT.md`, `MARKET_WATCH_ENGINE_RUNTIME_VERIFICATION_REPORT.md`, `MARKET_WATCH_REALTIME_AUDIT.md`, `WEBSOCKET_SUBSCRIPTION_AND_SESSION_MANAGER_FORENSIC_AUDIT.md`

> **Naming inconsistency**: `RISK_ENGINE.md` uses uppercase while all others use kebab-case. Minor, noted for hygiene.

### 4. BACKEND IMPLEMENTATION (python-service/)
- `C:\project\python-service\app.py` - FastAPI entry point (40 router registrations)
- `C:\project\python-service\config\settings.py` - 86 configuration settings
- `C:\project\python-service\requirements.txt` - Python dependencies
- `C:\project\python-service\core\engines\` - Core engine implementations (**not line-audited**)
- `C:\project\python-service\services\` - Service implementations (**not line-audited**)
- `C:\project\python-service\brokers\` - Broker adapters (3 adapters confirmed; `manager.py`/`registry.py` **not read**)
- `C:\project\python-service\ws_socket\` - WebSocket engine (WS#1, WS#2)
- `C:\project\python-service\connection_engine\` - Connection Engine (WS#3, WS#4)
- `C:\project\python-service\scheduler\` - Daily lifecycle (**not read**)
- `C:\project\python-service\database\` - MongoDB connection + migrations (**not read**)
- `C:\project\python-service\api\` - 37 route modules → 40 router registrations

### 5. FRONTEND IMPLEMENTATION (Next.js)
- `C:\project\app\` - **151 routable `page.tsx`** across 5 route groups (189 `page.tsx` total)
- `C:\project\app\_pages\` - **74 files, NOT ROUTED** (Next.js private folder); only 1 is live
- `C:\project\components\` - React components (layout, trading, orders, UI primitives)
- `C:\project\lib\` - Shared libraries (`realtime-ws.ts`, `backend.ts`, `kaustubh-types.ts` — **not read**)
- `C:\project\hooks\` - Custom React hooks
- `C:\project\tests\` - TypeScript tests (**not run**)
- `C:\project\package.json` - Node dependencies

### 6. DOMAIN CATALOGS (Created during bootstrap)
- `C:\project\docs\architecture\SDK_CATALOG.md` - All SDKs with versions & capabilities
- `C:\project\docs\broker\BROKER_INTEGRATION_MAP.md` - Broker capability matrix
- `C:\project\docs\database\DATABASE_ARCHITECTURE.md` - Database architecture
- `C:\project\docs\database\DATABASE_COLLECTION_CATALOG.md` - Collection schemas
- `C:\project\docs\database\DATABASE_LIFECYCLE.md` - DB lifecycle & migrations
- `C:\project\docs\architecture\DATA_FLOW_MAP.md` - Critical data flows
- `C:\project\docs\architecture\WEBSOCKET_ARCHITECTURE.md` - WebSocket details
- `C:\project\docs\api\API_CATALOG.md` - All REST endpoints
- `C:\project\docs\frontend\FRONTEND_ARCHITECTURE.md` - Frontend architecture
- `C:\project\docs\frontend\FRONTEND_ROUTE_MAP.md` - Frontend routes
- `C:\project\docs\frontend\FRONTEND_DATA_FLOW.md` - Frontend data flow
- `C:\project\docs\config\CONFIGURATION_CATALOG.md` - All config variables
- `C:\project\docs\runtime\SCHEDULER_AND_LIFECYCLE.md` - Scheduler & lifecycle
- `C:\project\docs\testing\TESTING_ARCHITECTURE.md` - Test structure
- `C:\project\docs\testing\VERIFICATION_MATRIX.md` - Verification status
- `C:\project\docs\security\SECURITY_ARCHITECTURE.md` - Security boundaries
- `C:\project\docs\observability\OBSERVABILITY_ARCHITECTURE.md` - Logging/metrics
- `C:\project\docs\architecture\FAILURE_AND_RECOVERY.md` - Error handling
- `C:\project\docs\audits\DUPLICATE_AND_LEGACY_FINDINGS.md` - Duplicates/legacy

### 7. MASTER KNOWLEDGE FILES
- `C:\project\docs\PROJECT_MAP.md` - This file
- `C:\project\docs\ARCHITECTURE_OVERVIEW.md` - High-level architecture
- `C:\project\docs\DEPENDENCY_MAP.md` - Dependency graph
- `C:\project\docs\DATA_FLOW_MAP.md` - Data flow summary
- `C:\project\docs\PROJECT_GLOSSARY.md` - Project terminology
- `C:\project\docs\PROJECT_GAPS.md` - Known gaps
- `C:\project\docs\PROJECT_RISKS.md` - Risk register
- `C:\project\docs\PROJECT_ASSUMPTIONS.md` - Assumptions
- `C:\project\docs\PROJECT_CHANGE_HISTORY.md` - Change history
- `C:\project\docs\FINAL_REPORT.md` - Living master report

### 8. IMPLEMENTATION & VERIFICATION HISTORY
- `C:\project\docs\implementation\015-project-discovery-and-documentation-bootstrap.md`
- `C:\project\docs\verification\015-project-discovery-verification.md`

### 9. PENDING TASKS (Actionable)
- `C:\project\docs\pending\PENDING-001-live-verification.md` — **P0 CRITICAL** — Start backend, verify the engine registry (**17 expected**), **verify no secrets in `/api/settings`**, export OpenAPI, verify MongoDB, test `/ws/realtime`
- `C:\project\docs\pending\PENDING-002-build-and-test-verification.md` — **P1** — `npm run build`, `tsc --noEmit`, lint, pytest, npm test, `pip-audit`, `npm audit`
- `C:\project\docs\pending\PENDING-003-static-code-audit.md` — **P1** — Read `lib/` contract layer, build `_pages/` import graph, confirm broker failover, read `migrations.py`, reconcile engine registry, create per-engine backend audits
- `C:\project\docs\pending\PENDING-004-db-writer-tick-persistence-live-verification.md` — **P0 CRITICAL** — **START HERE next session.** Restart the stale backend on port 8000, then prove claims C1-C5: live tick reaches the DB Writer, an OFF permission produces zero `market_ticks` writes, one permission does not move the other two, overlapping classification writes one document, and the Settings panel matches backend state across a reload. Closes GAP-036 / GAP-037.

### 10. ENGINEERING LOGS
- `C:\project\docs\logs\LOG-001-2026-09-28-project-discovery.md`
- `C:\project\docs\logs\LOG-002-2026-09-28-db-writer-tick-persistence-authority.md` — **read this alongside PENDING-004**

### 11. OPENCODE WORKING FILES
- `C:\project\docs\opencode\001-project-discovery-analysis.md`

- `C:\project\docs\DOCUMENTATION_AUTHORITY.md` — canonical doc per topic
- `C:\project\docs\PROJECT_GAPS.md` — GAP-001…GAP-035
- `C:\project\docs\PROJECT_RISKS.md` — 42 risks, R-01…R-42
- `C:\project\docs\pending\` — PENDING-001 (live), PENDING-002 (build/test), PENDING-003 (static)

### 12. REPORTS & AUDITS
**Read `DOCUMENTATION_AUTHORITY.md` first** — it resolves which document wins.

**Critical security (read before any runtime work):**
- `C:\project\docs\security\SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` — **unsigned session
  token, fail-open app lock, operator-JWT escalation** — R-36, R-37, R-38
- `C:\project\docs\security\AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` — 37 of 40
  routers unauthenticated, `HOST=0.0.0.0`, CORS `*` — R-17…R-19

**Audit pass of 2026-09-28 (new):**
- `C:\project\docs\audits\DUPLICATE_AND_LEGACY_FINDINGS.md` — findings D-01…D-23
- `C:\project\docs\audits\FRONTEND_PAGES_AUDIT.md` — 189 `page.tsx`, 151 routable → 151
  distinct routes; `_pages` import graph (1 live / 73 dead)
- `C:\project\docs\audits\VERSION_CONTROL_STATE.md` — 5 commits, 141 tracked, ~975 untracked
- `C:\project\docs\audits\GITIGNORE_AUDIT.md` — secrets correctly ignored; `downloads/` gap
- `C:\project\docs\frontend\FRONTEND_CONTRACT.md` — HTTP/WS/type/env/auth contract
- `C:\project\docs\broker\BROKER_SELECTION_AND_FAILOVER.md` — no failover; two divergent
  selection systems — R-39…R-42
- `C:\project\docs\database\DATABASE_COLLECTION_CATALOG.md` — 19 collections, index
  definitions, forward-only migration ledger
- `C:\project\docs\audits\backend\`, `frontend\`, `security\`, `runtime\` — reserved, **empty**

**Pre-existing reports:**
- `C:\project\docs\reports\FINAL_REPORT_SIX_ENGINE_RUNTIME_IMPLEMENTATION.md`
- `C:\project\docs\reports\FINAL_REPORT_ORDERS_TERMINAL_REBUILD.md`
- `C:\project\docs\reports\FINAL_REPORT_DATA_CENTER_REAL_DATA_OVERHAUL.md`
- `C:\project\docs\reports\KOTAK_WEBSOCKET_SDK_AUDIT.txt`
- `C:\project\docs\reports\KOTAK_L16_FULL_DEPTH_FORENSIC_REPORT.txt`
- `C:\project\docs\audits\MARKET_WATCH_IMPLEMENTATION_AUDIT.md`
- `C:\project\docs\audits\MARKET_WATCH_STATUS.md`

> **Large unread reports** (95 KB, 110 KB) exist and were not read in this pass:
> `docs\architecture\FINAL_PRODUCTION_ARCHITECTURE_AUDIT_REPORT.md` and
> `docs\architecture\WEBSOCKET_CONNECTION_MANAGER_ARCHITECTURE_MIGRATION_REPORT.md`.

---

## Directory Structure

```
C:\project\
├── PROJECT_IMPLEMENTATION_RULE.md
├── python-service/          # Backend (FastAPI)
│   ├── app.py
│   ├── config/settings.py
│   ├── requirements.txt
│   ├── api/                 # 30+ route modules
│   ├── auth/                # Kotak session
│   ├── brokers/             # 3 adapters + manager
│   ├── connection_engine/   # WS#3/WS#4 gateway
│   ├── core/engines/        # 15 engine implementations
│   ├── database/            # MongoDB connection
│   ├── scheduler/           # Daily lifecycle
│   ├── services/            # 30+ services
│   ├── ws_socket/           # WS#1/WS#2 broker feeds
│   └── tests/               # 50+ test files
├── app/                     # Frontend (Next.js)
│   ├── _pages/              # 30+ pages
│   ├── api/                 # API routes
│   ├── components/          # React components
│   ├── lib/                 # Shared libraries
│   └── hooks/               # Custom hooks
├── docs/                    # Documentation (controlled system)
│   ├── architecture/        # 35+ architecture docs
│   ├── engines/             # 25+ engine specs
│   ├── reports/             # 15+ final reports
│   ├── audits/              # Backend/frontend audits
│   ├── implementation/      # Implementation records
│   ├── verification/        # Verification records
│   ├── opencode/            # OpenCode working files
│   ├── pending/             # Pending tasks
│   ├── logs/                # Engineering logs
│   ├── api/                 # API catalog
│   ├── database/            # Database docs
│   ├── broker/              # Broker docs
│   ├── config/              # Configuration catalog
│   ├── runtime/             # Scheduler/lifecycle
│   ├── testing/             # Testing docs
│   ├── security/            # Security docs
│   ├── observability/       # Observability docs
│   ├── frontend/            # Frontend specs
│   └── backend/             # Backend specs
└── tests/                   # Frontend tests
```

---

## Key Entry Points

### Backend API
- Base: `http://localhost:8000`
- Health: `GET /health` → `GET /api/system/health`
- Engines: `GET /api/services/engines`
- WebSocket: `WS /ws/realtime` (WS#3 + WS#4)

### Frontend
- Dev: `npm run dev` (port 3000)
- Build: `npm run build`
- Pages: `/dashboard`, `/trading`, `/orders`, `/market-watch`, `/session-manager`, `/scheduler`, `/settings`, etc.

### Database
- MongoDB URI: `MONGODB_URI` env var (required)
- Database: `kaustubh` (from URI or MONGODB_DATABASE)
- Collections: **19 session_manager_*** collections, **no TTL** (application-managed expiry)

### Broker Credentials
- Kotak: `CLIENT_ID`, `CONSUMER_KEY`, `MOBILE_NUMBER`, `MPIN`, `TOTP_SECRET`
- Shoonya: `SHOONYA_API_KEY`, `SHOONYA_SECRET_KEY`, `SHOONYA_USER_ID`, `SHOONYA_ACCOUNT_ID`, `SHOONYA_REDIRECT_URL`
- All secrets backend-only, never exposed to frontend

---

## Critical Rules (from PROJECT_IMPLEMENTATION_RULE.md)

1. **READ PROJECT_IMPLEMENTATION_RULE.md FIRST** - Before any work
2. **Engine spec is authoritative for intent** - `docs/engines/*.md`
3. **Backend audit = what currently does** - `docs/audits/backend/`
3. **Frontend spec = intended UI** - `docs/frontend/`
4. **Frontend audit = current UI** - `docs/audits/frontend/`
5. **Never silently change engine responsibility** - Document, spec, then implement
6. **No fake data** - Show UNKNOWN/NO_DATA/STALE honestly
7. **No secrets in docs** - Use `<REDACTED>` placeholders
8. **Documentation in C:\project\docs\ only** - No random locations
9. **Serial numbers from filesystem** - Never guess
10. **Cross-reference related docs** - Enable traceability

---

## Current Status Summary (2026-09-28)

| Area | Status | Notes |
|------|--------|-------|
| Backend Architecture | DOCUMENTED | **17** engines (code-derived), **1** WS route (`/ws/realtime`, 4 logical channels), 3 brokers |
| Frontend Architecture | DOCUMENTED | **189** `page.tsx`, **151 routable → 151 distinct routes**; `_pages` 1 live / 73 dead |
| Engine Specs | MOSTLY COMPLETE | Some placeholders, UNKNOWN states |
| API Catalog | PARTIAL | Routers known, schemas `NOT_VERIFIED` (no OpenAPI spec) |
| Database | DOCUMENTED | **19** `session_manager_*` collections, index definitions read, **no TTL**, forward-only migrations |
| Broker Integration | **DEFECTIVE** | 3 adapters, **no failover**, two divergent selection systems (R-39…R-42) |
| WebSocket | DOCUMENTED | 4 logical channels over 1 route; contract verified correct (D-23) |
| Configuration | DOCUMENTED | 86 variables cataloged |
| Testing | PARTIAL | 50+ backend, 15+ frontend tests; **no auth tests for R-36/37/38** |
| **Security** | **CRITICAL DEFECTS** | **Unsigned session token, fail-open lock, operator-JWT escalation** (R-36/37/38); 37/40 routers unauthenticated (R-17) |
| **Version Control** | **CRITICAL** | **5 commits, 141 tracked, ~975 untracked** — a clone cannot build or run this app (R-34) |
| Observability | PARTIAL | Structured logging, metrics partial |
| Live Verification | NOT_VERIFIED | Requires running environment |

---

## Next AI Agent Entry Point

**START HERE**: Read `C:\project\docs\FINAL_REPORT.md` then `C:\project\docs\PROJECT_MAP.md`

**Current Architecture**: Engine-first, 4 logical WS channels over 1 route, Session Manager as truth source, Scheduler orchestrates daily lifecycle

### Read these three before touching anything
1. `security\SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` — the auth chain does not hold
2. `audits\VERSION_CONTROL_STATE.md` — the repo does not contain the app
3. `broker\BROKER_SELECTION_AND_FAILOVER.md` — failover does not exist

**Current Risks**: unauthenticated control plane on `0.0.0.0`; forgeable operator session;
uncommitted application; no broker failover; 5 engines UNKNOWN/DEGRADED (doc claim)

**Pending Work**: fix the auth chain (R-36/37/38); commit the application (R-34); live
verification (`pending\PENDING-001`); OpenAPI + TS codegen (GAP-033/035); decide broker
failover policy (R-39/40)

**Must NOT Change**: Engine responsibility boundaries, Session Manager as subscription authority, WS#1/WS#2 broker-owned, DB Writer as persistence owner

**Authoritative Documents**: `DOCUMENTATION_AUTHORITY.md` first, then `ENGINE_INVENTORY.md`, `architecture\WebSocket_ConnectionManager_Flow.md`, `database\DATABASE_COLLECTION_CATALOG.md`, `MARKET_WATCH.md`, `scheduler-engine.md`, `session-manager.md`

> ⚠ **Note**: `17_DATABASE_ARCHITECTURE.md` and `08_WEBSOCKET_ARCHITECTURE.md` are
> **superseded** on collection names and the WS model respectively — see
> `DOCUMENTATION_AUTHORITY.md`. Prefer the catalogs written from code.