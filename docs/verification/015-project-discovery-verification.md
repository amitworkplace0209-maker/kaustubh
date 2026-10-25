# 015-project-discovery-verification.md

## Verification ID
015

## Date / Time
2026-09-28

## Agent
OpenCode AI Agent

## Task / Feature
Full project discovery, architecture mapping, and documentation bootstrap verification

## Expected Behavior
Complete forensic discovery of the KAUSTUBH Trading Platform repository, resulting in:
- Complete project inventory
- Accurate architecture mapping
- Dependency analysis
- Engine catalog
- SDK catalog
- Broker integration map
- Database architecture documentation
- WebSocket architecture documentation
- API catalog
- Frontend architecture documentation
- Configuration catalog
- Scheduler/lifecycle documentation
- Test analysis
- Security analysis
- Observability analysis
- Error/failure/recovery analysis
- Duplicate/legacy detection
- Specification vs implementation gap analysis
- Master knowledge files
- FINAL_REPORT.md

## Verification Method

**STATIC ONLY — no runtime verification was performed.**

- Filesystem traversal and inventory (root, `python-service/`, `app/`, `docs/`, `tests/`)
- Source-level extraction of `@router.<method>` decorators from all `python-service/api/*.py`
- Source-level extraction of all `APIRouter(prefix=..., tags=...)` declarations
- Source-level extraction of all router imports and `include_router()` calls in `app.py`
- Source-level extraction of all settings attribute names from `config/settings.py`
- Filesystem enumeration of all `page.tsx` files and route groups
- Architecture document cross-referencing against observed directory structure
- Cross-reference of `ENGINE_INVENTORY.md` against engine/service/broker/ws directories

**Explicitly NOT performed:** no HTTP requests, no WebSocket connections, no MongoDB queries, no test execution, no build, no broker login, no lint, no type-check, no dependency audit.

## Environment
- Local filesystem: `C:\project`
- Python virtualenv present at `python-service/.venv` (excluded from scans)
- Node toolchain: **NOT_VERIFIED** (no build run)
- **No live broker connection**
- **No live MongoDB connection**
- **No running backend process**
- **No running frontend process**
- **No test execution**

## Questions / Checks
1. Does the repository structure match documented architecture?
2. Are all 15 engines documented in ENGINE_INVENTORY.md present in code?
3. Does the 4-WebSocket architecture match implementation?
4. Are all 3 broker adapters implemented?
5. Do API routers in app.py match documented endpoints?
6. Does MongoDB schema match 17_DATABASE_ARCHITECTURE.md?
7. Are frontend pages under app/ documented?
8. Are dependencies in requirements.txt and package.json accurate?
9. Does scheduler-engine.md match scheduler/__init__.py?
10. Does session-manager.md match services/session/ implementation?
11. Does MARKET_WATCH.md match services/market_watch_engine.py?
12. Are there undocumented engines/services?
13. Are there duplicate implementations?
14. Are there legacy/dead code paths?
15. Do configuration variables match actual usage?
16. Are secrets properly protected (not in code/docs)?

## Expected Results (targets, not claims)
- 15 engines verified → **NOT ACHIEVED** (doc claims 15; registry completeness unverified)
- 4 WebSocket channels verified → **PARTIAL** (design confirmed; runtime unverified; multiplex-endpoint conflict found)
- 3 broker adapters verified → **ACHIEVED** (static: modules exist; capability logic unverified)
- 30+ API routers verified → **ACHIEVED** (static: 40 registrations, ~450 route paths; schemas not captured)
- 11 core collections documented → **ACHIEVED as documentation; NOT VERIFIED against live DB**
- 30+ frontend pages identified → **ACHIEVED and exceeded** (151 routable `page.tsx`; 189 total; 38 non-routable in `_pages\`)
- All Python dependencies cataloged → **ACHIEVED** (static manifest)
- All Node dependencies cataloged → **ACHIEVED** (static manifest)
- Configuration variables cataloged → **ACHIEVED** (86 names; effective values unverified)
- No secrets exposed → **ACHIEVED in created docs**; API-level exposure unconfirmed
- Master knowledge files created → **ACHIEVED** (30 documents)

## Actual Results

### Verified (static, source-level)

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | Repository structure vs documented architecture | `VERIFIED` | Root is `python-service/` + root-level `app/components/lib/hooks`; no `src/`, `backend/`, `frontend/`, `services/`, `engines/` at root |
| 2 | Router registrations in `app.py` | `VERIFIED` — 40 | Direct scan of imports (lines 66–111) and `include_router()` calls |
| 3 | REST route inventory | `VERIFIED` (method+path) — ~450 | Decorator extraction from 37 `api/*.py` modules |
| 4 | Broker adapter modules | `VERIFIED` — 3 | `brokers/kotak_adapter.py`, `shoonya_adapter.py`, `dummy.py` exist |
| 5 | Broker SDK versions | `VERIFIED` | `requirements.txt`: `kotakneoapi==3.0.7`, `NorenRestApiOAuth==0.0.41` |
| 6 | WebSocket design (4 channels) | `VERIFIED` (design) | `08_WEBSOCKET_ARCHITECTURE.md` + ownership confirmed by `ws_socket/`, `connection_engine/` |
| 7 | WS#3/WS#4 endpoint | `VERIFIED` (code) | `api/ws_gateway.py` declares `WS /ws/realtime` |
| 8 | Configuration variables | `VERIFIED` (names) — 86 | `config/settings.py` attribute extraction across 10 categories |
| 9 | Frontend page inventory | `VERIFIED` — 189 `page.tsx`, 151 routable | Filesystem enumeration + `FRONTEND_PAGES_AUDIT.md` |
| 10 | Route group structure | `VERIFIED` | 5 groups: `(ai)`, `(dashboard)`, `(phase2)`, `(services)`, `(trading)` |
| 11 | `app/_pages/` non-routability | `VERIFIED` | Next.js treats `_`-prefixed folders as private; 74 files affected, only 1 imported by live app |
| 12 | Python dependencies | `VERIFIED` (manifest) | `requirements.txt` |
| 13 | Node dependencies | `VERIFIED` (manifest) | `package.json` |
| 14 | Documentation system structure | `VERIFIED` | 30 documents created under `docs/` |

### Conflicts Found

| # | Conflict | Detail |
|---|----------|--------|
| 1 | `GET /api/health` registered twice | `api/routes.py` and `api/system.py` |
| 2 | 4-WS claim vs single `/ws/realtime` endpoint | Design doc describes 4 channels; code multiplexes WS#3+WS#4 on one endpoint |
| 3 | `/api/trading` prefix shared | `api/trading.py` + `api/trading_dashboard.py` |
| 4 | Watchlist triplication | `/api/watchlist`, `/api/watch-list`, `/api/watchlist-engine` |
| 5 | Engine dependency graph mismatch | `03_ENGINE_DEPENDENCY_GRAPH.md` omits code-declared deps for `margin_engine`, `market_coach` |
| 6 | Broker failover claim | `06_BROKER_ARCHITECTURE.md` claims failover/load-balancing; `brokers/manager.py` not audited |
| 7 | Database collection counts | `17_DATABASE_ARCHITECTURE.md` admits estimates |
| 8 | Duplicate frontend URLs | `/market-watch` (3 impl), `/settings` (4 impl), etc. — potential build-blocking collision |
| 9 | Engine spec placeholders | Some `docs/engines/*.md` use `$(...)` template IDs |
| 10 | Stale "MIGRATED" headers | Undated migration markers in architecture docs |

### Not Verified (requires runtime)

| # | Item | Blocker |
|---|------|---------|
| 1 | Engine states/health | Requires running backend |
| 2 | Secret redaction in `/api/settings` | **Requires running backend — CRITICAL** |
| 3 | API request/response schemas | Requires `/openapi.json` export |
| 4 | API response correctness | Requires running backend |
| 5 | MongoDB collection names/counts | Requires live DB or reading `migrations.py` |
| 6 | MongoDB indexes | Requires reading `database/migrations.py` |
| 7 | WebSocket connect/subscribe/reconnect | Requires live broker |
| 8 | WS#2 order feed delivery | Requires live broker |
| 9 | Scheduler phase firing | Requires market hours or clock override |
| 10 | Broker failover behavior | Requires reading `manager.py` + live test |
| 11 | Frontend build success | Requires `npm run build` |
| 12 | TypeScript compilation | Requires `tsc --noEmit` |
| 13 | ESLint status | Requires `npm run lint` |
| 14 | Python test results | Requires `pytest` |
| 15 | TypeScript test results | Requires `npm test` |
| 16 | Dependency CVEs | Requires `pip-audit` / `npm audit` |
| 17 | `app/_pages/` file liveness | Requires import-graph analysis |
| 18 | CORS restriction | Requires running backend |
| 19 | TLS / rate limiting | Requires deployment config inspection |
| 20 | Backup/restore procedure | Requires documentation search (none found) |

## Problems Found
1. **Engine state discrepancies**: 5 engines report UNKNOWN health, 2 report DEGRADED
2. **Documentation duplication**: Multiple architecture files with "MIGRATED" headers
3. **Placeholder engine IDs**: Several engine specs use $(...) template placeholders
4. **Missing implementation docs**: implementation/ and verification/ directories didn't exist
5. **No master navigation**: PROJECT_MAP.md, FINAL_REPORT.md missing
6. **API endpoints not fully cataloged**: Individual routes not documented
7. **Frontend routes not fully mapped**: Exact routes not documented
8. **Database collection counts estimated**: Actual counts NOT_VERIFIED
9. **Some engine specs incomplete**: Missing engine_id, health vocabulary, metrics

## Fixes Applied
- Created 19 documentation directories under `C:\project\docs\` per `PROJECT_IMPLEMENTATION_RULE.md`
- Created 10 master knowledge files
- Created 16 domain catalogs
- Created this verification record and the paired implementation record
- Created 1 working analysis file under `docs/opencode/`

**No application code, configuration, test, or data file was modified.**

## Re-verification
- Confirmed all documented files exist on disk (filesystem enumeration)
- Confirmed no secret values appear in any created document (only variable names, types, and `<REDACTED>` placeholders)
- Confirmed all files reside under `C:\project\docs\`
- Confirmed naming convention `NNN-topic-name.md` for records
- **Not re-verified**: no cross-validation against a running system was possible

## Second Pass (2026-09-28) — Pre-Existing Documentation Audit

The first pass created new documentation but treated the pre-existing `docs\architecture\`
and `docs\engines\` sets as trustworthy inputs. **That was a methodological error.** The
second pass read the previously-unread navigation documents and tested their claims against
source. They do not hold up.

### Method
Static only. No code was executed, no runtime state was observed, no secrets were read.

| Check | Command / method | Result |
|-------|------------------|--------|
| Does `kaushub` exist? | `Get-ChildItem -Recurse -Filter "kaushub*"` | **0 matches** |
| WebSocket routes | `Select-String '@router.websocket' api\*.py app.py` | **1** — `/ws/realtime` |
| `squareoff` spelling | `Select-String 'squareoff' \| 'sqareoff'` in `python-service\**\*.py` | **44 / 0** |
| Engine registration | read `app.py:609-626` | **17** (14 native + 3 facade) |
| Facade set | read `legacy_engine_facades.py:428-432` | **3**: scheduler, order, position |
| `config.yaml` | `Test-Path C:\project\config.yaml` | **False**; no `config*.y*ml` outside `.venv` |
| Architecture file count | `Where-Object Name -match '^\d\d_'` | **36** (docs say 35) |
| Engine doc count | `Get-ChildItem docs\engines -Filter *.md` | **31** (docs say "25+") |
| `page.tsx` count | filesystem enumeration | **189** total, **151** routable (docs say "30+") |
| Encoding | UTF-8 scan for `U+FFFD` / `U+2192`, 54 files | 28 files × 1 `U+FFFD`; banner `→` → `?` in all 36 |

### Findings raised (D-11 … D-18 in `docs/audits/DUPLICATE_AND_LEGACY_FINDINGS.md`)
| # | Finding | Severity |
|---|---------|----------|
| D-11 | Two parallel architecture doc sets (36 numbered + 19 unnumbered) | High |
| D-12 | Two naming conventions in `docs/reports/` | Low |
| D-13 | **`python -m kaushub.*` CLI does not exist** — whole remediation path unexecutable | **Critical** |
| D-14 | **4-WS banner over 2-WS body text in all 36 numbered files** | **Critical** |
| D-15 | Engine count 17 in code vs 15 in 5 docs; naming errors; unregistered engines | High |
| D-16 | `32_ARCHITECTURE_GAPS.md` Gap 2 contradicted by `app.py:620,629` | High |
| D-17 | Misc verified errors: `config.yaml`, page counts, `requirements.txt` path, self-contradicting state tables | Medium |
| D-18 | All runtime-state claims in `31`/`35` are `NOT_VERIFIED` | High |

### Corrections applied
- `docs/DOCUMENTATION_AUTHORITY.md` created — canonical doc per topic
- `docs/engines/ENGINE_INVENTORY.md` — correction notice prepended; original rows preserved
- `docs/PROJECT_MAP.md`, `docs/FINAL_REPORT.md`, `docs/PROJECT_RISKS.md` — counts corrected
- `docs/pending/PENDING-001` — engine assertion 15→17; WS + DB steps; fictional-CLI warning
- `docs/pending/PENDING-003` — corrected guessed paths; added task 0

### Left unmodified (requires human decision)
- The 36 numbered architecture files — banner/body contradiction persists (R13)
- The 19 legacy files — not deprecated
- `32_ARCHITECTURE_GAPS.md` — not rewritten, because its correction depends on enumerating
  the real `api\engine_control.py` endpoints (`PENDING-003`)
- 6 implemented-but-unregistered `core/engines/` modules

### Refinement of an earlier finding
D-07 originally read as "4-WS design vs 1 endpoint = contradiction". The second pass
established that `/ws/realtime` is the **only** `@router.websocket` route in the backend
and that the 4 WebSockets are **logical channels multiplexed over it**. D-07 is therefore
reclassified from *conflict* to *clarification* — documentation describes logical channels,
code implements one transport. Recorded in `docs/DOCUMENTATION_AUTHORITY.md` §3.

## Final Result
`PARTIALLY_COMPLETE`

The **documentation bootstrap itself is `COMPLETE`** — 33 documents covering architecture, dependencies, API surface, configuration, brokers, database, WebSocket, frontend, runtime, testing, security, observability, failure handling, duplication, gaps, risks, assumptions, and change history, plus 3 pending tasks and 1 engineering log.

The **verification of runtime behavior is `NOT_VERIFIED` in its entirety.** Zero runtime checks were performed. See the 20-item "Not Verified" table above and `docs/testing/VERIFICATION_MATRIX.md` (45 items: 14 static-verified, 22 not-verified, 6 conflict/duplicate, 7 unknown).

The **pre-existing documentation set is now known to be materially unreliable** in three
specific ways: an invented CLI, an engine count that is wrong by two, and a WebSocket
description that contradicts itself. Any agent working from those files without reading
`docs/DOCUMENTATION_AUTHORITY.md` first is likely to repeat their errors.

## Remaining Risks
1. **Secret exposure via `/api/settings` is unconfirmed** — treat as possible critical vulnerability until tested (PROJECT_RISKS R-01)
2. **The documented remediation commands do not exist** (R-12) — `32_ARCHITECTURE_GAPS.md` cannot be acted on as written
3. **The AI-agent navigation doc teaches the wrong WebSocket model** (R-13) — `35_AI_AGENT_CONTEXT.md` body vs banner
4. **Engine registry mismatch** (R-14) — code registers 17, five documents say 15
5. Engine health values in documentation are historical snapshots, not live observations
6. API contracts are unvalidated — no OpenAPI spec exists in version control
7. Database schemas and indexes are unverified — documented values are inferred
8. WebSocket behavior, reconnect, and resubscribe are entirely untested
9. Scheduler phase transitions have never been observed firing
10. Broker failover is claimed in documentation but unconfirmed in code
11. Frontend build status is unknown — duplicate URLs may be build-blocking
12. 41 frontend page files have unknown liveness
13. No dependency vulnerability scan has been performed
14. No test suite has been executed
15. Backup/restore procedures are undocumented for 7 years of regulatory audit data
16. Six implemented-but-unregistered `core/engines/` modules — dead code or registration gap, undetermined