# PROJECT_CHANGE_HISTORY.md

## KAUSTUBH Trading Platform - Change History

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Note**: This file is a **living engineering log**. It is NOT a git history dump. For commit-level history use `git log`.

---

## 2026-09-28 — Discovery & Documentation Bootstrap

**Agent**: OpenCode AI Agent
**Record**: `implementation/015-project-discovery-and-documentation-bootstrap.md`
**Verification**: `verification/015-project-discovery-verification.md`
**Result**: `PARTIALLY_COMPLETE`

### Application Code Changes
**NONE.** No source file, test, configuration, or data file was modified.

### Files Created (documentation only)

**Master Knowledge Files**
- `PROJECT_MAP.md`
- `ARCHITECTURE_OVERVIEW.md`
- `DEPENDENCY_MAP.md`
- `DATA_FLOW_MAP.md`
- `PROJECT_GLOSSARY.md`
- `PROJECT_GAPS.md`
- `PROJECT_RISKS.md`
- `PROJECT_ASSUMPTIONS.md`
- `PROJECT_CHANGE_HISTORY.md`
- `FINAL_REPORT.md`

**Domain Catalogs**
- `architecture/SDK_CATALOG.md`
- `architecture/DATA_FLOW_MAP.md`
- `architecture/WEBSOCKET_ARCHITECTURE.md`
- `architecture/FAILURE_AND_RECOVERY.md`
- `api/API_CATALOG.md`
- `broker/BROKER_INTEGRATION_MAP.md`
- `config/CONFIGURATION_CATALOG.md`
- `database/DATABASE_ARCHITECTURE.md`
- `database/DATABASE_COLLECTION_CATALOG.md`
- `database/DATABASE_LIFECYCLE.md`
- `frontend/FRONTEND_ARCHITECTURE.md`
- `frontend/FRONTEND_ROUTE_MAP.md`
- `frontend/FRONTEND_DATA_FLOW.md`
- `runtime/SCHEDULER_AND_LIFECYCLE.md`
- `testing/TESTING_ARCHITECTURE.md`
- `testing/VERIFICATION_MATRIX.md`
- `security/SECURITY_ARCHITECTURE.md`
- `observability/OBSERVABILITY_ARCHITECTURE.md`
- `audits/DUPLICATE_AND_LEGACY_FINDINGS.md`

**Records & Working Files**
- `implementation/015-project-discovery-and-documentation-bootstrap.md`
- `verification/015-project-discovery-verification.md`
- `opencode/001-project-discovery-analysis.md`

### Directories Created
`implementation/`, `verification/`, `opencode/`, `logs/`, `api/`, `database/`, `broker/`, `config/`, `runtime/`, `testing/`, `security/`, `observability/`, `frontend/`, `backend/`, `audits/backend/`, `audits/frontend/`, `audits/architecture/`, `audits/security/`, `audits/runtime/`

### Key Discoveries
1. Backend has 40 router registrations (~450 routes) in `app.py`
2. Frontend has ~174 `page.tsx` files; 41 in non-routable `app/_pages/`
3. `GET /api/health` is registered in two modules
4. Three separate watchlist APIs exist
5. `websockets==13.1` pin is load-bearing for uvicorn 0.30.6
6. 15 engines registered; 5 reported `UNKNOWN`/`REGISTERED` in docs
7. `17_DATABASE_ARCHITECTURE.md` collection counts are estimates

### Verification Performed
- Filesystem inventory of repository root, `python-service/`, `app/`, `docs/`, `tests/`
- Source-level extraction of all REST route decorators and router prefixes from `python-service/api/*.py`
- Source-level extraction of all router imports/`include_router()` calls in `app.py` (40 registrations)
- Source-level extraction of all 86 settings attribute names from `config/settings.py`
- Filesystem enumeration of 166 `page.tsx` files across 5 route groups
- Cross-reference of architecture docs against observed directory structure

**No runtime verification. No tests executed. No build. No lint. No type-check. No dependency audit.**

### Remaining Risks
1. Secret exposure via `/api/settings` unconfirmed (critical)
2. Engine health values are documentation snapshots, not live observations
3. API contracts unvalidated (no OpenAPI in version control)
4. Database schemas/indexes unverified
5. WebSocket behavior entirely untested
6. Scheduler phases never observed firing
7. Broker failover unconfirmed in code
8. Frontend build status unknown; duplicate URLs may be build-blocking
9. 41 frontend page files have unknown liveness
10. No dependency vulnerability scan
11. No test suite executed
12. Backup/restore undocumented for 7 years of audit data

### Known Issues Introduced
- **Serial numbering**: `015` used although it was the first record; if records 001–014 are added later, numbering will need renumbering.
- **Empty directories**: `backend/`, `logs/`, `pending/`, and audit subdirectories remain empty pending future work.
- **Overlapping documents**: `docs/DATA_FLOW_MAP.md` (summary) and `docs/architecture/DATA_FLOW_MAP.md` (detail) overlap by design; cross-referenced rather than merged.

---

## 2026-09-28 — Second Pass: Documentation Authority & Pre-Existing Doc Audit

**Agent**: opencode (documentation bootstrap, continued)
**Record**: this document + `DOCUMENTATION_AUTHORITY.md`
**Verification**: static only — no code executed, no runtime state observed
**Result**: PARTIALLY_COMPLETE

### Application Code Changes
**NONE**

### Files Created
- `docs/DOCUMENTATION_AUTHORITY.md` — declares the canonical document for every topic
- `docs/pending/PENDING-002-build-and-test-verification.md`
- `docs/pending/PENDING-003-static-code-audit.md`
- `docs/logs/LOG-001-2026-09-28-project-discovery.md`

### Files Modified
- `docs/PROJECT_MAP.md` — engine count 15→17, doc counts corrected, authority doc added
- `docs/FINAL_REPORT.md` — findings 8–10 replaced with 8–15; risks R11 → R11–R15
- `docs/audits/DUPLICATE_AND_LEGACY_FINDINGS.md` — added D-11…D-18
- `docs/engines/ENGINE_INVENTORY.md` — **pre-existing file**; correction notice prepended, original table preserved verbatim
- `docs/pending/PENDING-001-live-verification.md` — engine assertion 15→17, WS and DB steps added, fictional-CLI warning added
- `docs/pending/PENDING-003-static-code-audit.md` — file paths corrected, task 0 added, task 5/7 updated
- `docs/implementation/015-…`, `docs/verification/015-…`, `docs/opencode/001-…` — second-pass results appended

### Configuration Changes
**NONE**

### Breaking Changes
**NONE** (documentation only)

### Key Results
Read the previously-unread navigation docs (`00`, `31`, `32`, `34`, `35`,
`WebSocket_ConnectionManager_Flow.md`) and verified their claims against source:

1. **Registered engine count is 17** (14 native + 3 facade), from `app.py:609-626` and
   `legacy_engine_facades.py:428-432`. Five documents claim 15 (13+2). **Wrong.**
2. **`python -m kaushub.*` does not exist** — zero matches repo-wide. Every remediation
   step in `32_ARCHITECTURE_GAPS.md` and every command in `34`/`35` is unexecutable.
3. **All 36 numbered architecture files** carry a 4-WS migration banner over 2-WS body
   text. `35_AI_AGENT_CONTEXT.md` — the AI-agent navigation doc — teaches the wrong model.
4. **`audit_engine` is registered and auto-started** (`app.py:620,629`), contradicting
   `32_ARCHITECTURE_GAPS.md` Gap 2.
5. **`market_watch_engine` is registered** (`app.py:615,629`), contradicting
   `ENGINE_INVENTORY.md`'s "Market Watch (standalone) NOT IMPLEMENTED".
6. **`watchlist_target_engine` exists nowhere in code** despite appearing in 4 documents.
7. **One WebSocket route only** — `/ws/realtime` (`api/ws_gateway.py:278`). The 4-WS model
   is logical channels multiplexed over it. This *clarifies* rather than contradicts D-07.
8. **`config.yaml` does not exist** despite being cited as the config source twice.
9. **`kaushub` aside, 6 `core/engines/` modules are implemented but unregistered**:
   `risk_engine`, `target_engine`, `pnl_engine`, `basket_engine`, and the core
   `order_engine`/`position_engine`. Flagged for a human decision — no code changed.

### Verification Performed
Static grep/read only:
`Get-ChildItem -Filter "kaushub*"` (0 results) · `Select-String '@router.websocket'`
(1 result) · `Select-String 'squareoff'|'sqareoff'` (44 / 0) · engine registration read
from `app.py:609-626` · `FACADES` read from `legacy_engine_facades.py:428-432` ·
UTF-8 scan for `U+FFFD` and `U+2192` across 54 files · `Test-Path config.yaml` (false)

### Remaining Risks
- R12/R13/R14 in `PROJECT_RISKS.md` are **open and Critical/High**.
- The banner/body contradiction (R13) is **still present in all 36 files** — left
  unmodified because rewriting approved architecture content is a human decision.
- The 19 legacy unnumbered files are **not yet deprecated**.
- 6 implemented-but-unregistered engines: status unknown (dead code or registration gap).
- Two 95–110 KB reports remain unread.

---

## Change Log Template (use for future entries)

```
## YYYY-MM-DD — Short Title
**Agent**: <name>
**Record**: implementation/NNN-topic.md
**Verification**: verification/NNN-topic.md
**Result**: COMPLETE | PARTIALLY_COMPLETE | BLOCKED

### Application Code Changes
<list or NONE>

### Files Created
<list>

### Files Modified
<list>

### Files Deleted
<list or NONE>

### Configuration Changes
<list or NONE>

### Breaking Changes
<list or NONE>

### Verification Performed
<list>

### Remaining Risks
<list>
```

---

## 2026-09-28 — Frontend contract audit; critical auth bypass found

**Code change made (owner-approved):** `git checkout HEAD -- tailwind.config.ts` → **R-35 closed**.

**Read:** `lib/kaustubh-types.ts`, `lib/backend.ts`, `lib/realtime-ws.ts`,
`lib/engine-realtime.ts`, `lib/env.ts`, `lib/auth-crypto.ts`, `app/api/auth/login/route.ts`,
`app/api/realtime/token/route.ts`, `connection_engine/connection_engine.py`,
`api/ws_gateway.py`, `test_connection_engine.py`.

### Critical security finding (new)

| Risk | Finding |
|------|---------|
| **R-36** | `kaustubh_session` is **unsigned** `base64(plain JSON)`. One validator, no `middleware.ts`. A client can authenticate itself. |
| **R-37** | Auth **fails open**: no `.auth/app-lock.json` and no `APP_LOCK_PIN` ⇒ `POST {"direct":true}` returns a session cookie with no credentials. **A fresh clone is vulnerable by default**, because `.auth/` is gitignored and `APP_LOCK_PIN` is only in `.env.example`. Verified true in this tree. |
| **R-38** | Forged cookie → `/api/realtime/token` → server-side operator JWT (8 h cache) → the 37 routers with no auth. Currently degrades to anonymous since `APP_USERNAME`/`APP_PASSWORD` are unset. |

Secondary: `Math.random()` PIN salt, single-round SHA-256 over a 6-digit PIN,
non-constant-time `pin === envPin`, no rate limiting, `secure` cookie only in production,
dead `GUEST_EMAIL`/`GUEST_PASSWORD`.

**New**: `security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md`, `frontend/FRONTEND_CONTRACT.md`, `audits/GITIGNORE_AUDIT.md`
**Findings added**: D-19, D-20, D-21, D-22, D-23
**Risks added**: R-34, R-35 (closed), R-36, R-37, R-38 — 38 rows, all IDs unique

### Contract verification — one break suspected, two false positives caught

The engine control channel looked broken (`engine.status` absent from the backend, no
`engines` channel). It is **correct**: `_map_wire_type()` translates the internal
`engine_snapshot` to the wire type, channel routing is table-driven, the payload nests under
`data`, and `test_connection_engine.py:198-251` asserts all of it. `welcome`/
`heartbeatIntervalS` likewise verified. Both "findings" are recorded as **D-23** so they are
not re-reported.

Real contract issues: **C-9** the backend sends a per-session `sequence` the client never
reads (no gap detection), **C-4** a wedged WebSocket permanently suppresses the REST
fallback, **C-5** `validateEnv()` validates nothing, **C-6** mixed `snake_case`/`camelCase`
within single interfaces with no tool able to detect drift from the Python models.

**No application code was modified other than the approved `tailwind.config.ts` restore.**

---

## 2026-09-28 — Version control audit; risk-register ID repair

Read-only `git status -uall` / `ls-tree` / `show` inspection. **No git write command was run.**

| Finding | Detail |
|---------|--------|
| **D-19 / R-34 (Critical)** | **~975 untracked files**; **~98,000 lines** of frontend across ~530 `.ts`/`.tsx`; 209 untracked `.py`. `HEAD` has **141** files, **5** commits, **16** routable pages vs **151** in the working tree. Every count in this docs set describes the working tree, not the repository |
| **R-35 (High)** | `tailwind.config.ts` deleted, uncommitted, and required by Tailwind v3.4.17 → full colour palette, `darkMode`, radius tokens, gradients, accordion animations and the `tailwindcss-animate` plugin are gone; `components/ui/*` would render unstyled. `tsc`/ESLint cannot catch it |
| D-19 (cont.) | 11 uncommitted deletions, 3 code. `(dashboard)/trading` deletion **fixes a real duplicate `/trading` route present in HEAD**; `sidebar.tsx` was unreferenced; `tailwind.config.ts` is a regression |
| **D-20** | `PROJECT_RISKS.md` used **R-17…R-25 twice**, making every reference ambiguous. Pre-existing block renumbered to R-25…R-33; cross-refs in `runtime/SCHEDULER_AND_LIFECYCLE.md` and `security/SECURITY_ARCHITECTURE.md` corrected. 35 rows, 35 unique IDs, no dangling references |
| D-21 | Untracked `archive\legacy\`, `apps\`, `khumbha-ai\`, `config\` extend D-10; `.gitignore` covers only `/.next/` and `next-env.d.ts` |

**New**: `audits/VERSION_CONTROL_STATE.md`
**Edited**: `PROJECT_RISKS.md` (+R-34/R-35, renumbering, repair notice), `audits/DUPLICATE_AND_LEGACY_FINDINGS.md` (D-19…D-21), `audits/FRONTEND_PAGES_AUDIT.md` (§1 caveat, §7), `runtime/SCHEDULER_AND_LIFECYCLE.md`, `security/SECURITY_ARCHITECTURE.md`.

**Awaiting owner decision**: restoring `tailwind.config.ts`; committing the ~975 untracked files.

---

## 2026-09-28 — Corrections: frontend page counts and D-05 withdrawal

Two earlier bootstrap findings were **wrong** and are now corrected.

| Item | Was | Now | Evidence |
|------|-----|-----|----------|
| Total `page.tsx` | 166 | **189** | Re-enumeration |
| Routable `page.tsx` | — | **151** | Route groups stripped |
| Files under `app\_pages\` | 41 | **74** (38 `page.tsx`) | Directory scan |
| `_pages` live files | unknown | **1** | Import graph: `app\(dashboard)\dashboard.tsx:13` |
| D-05 duplicate routes | Medium, "may be build-blocking" | **WITHDRAWN** | 151 routable → 151 distinct route strings |
| R-15 | High | **Low / resolved** | No collision; hygiene only |

**Root cause of the D-05 error**: paths sharing a *leaf name* (`/settings`,
`/market-watch`) were treated as the same URL. They are distinct routes. The original text
even noted "`/trading/market-watch` ≠ `/market-watch`" for one row and then generalised
incorrectly from the rest.

**Root cause of the count error**: the first count did not account for route groups
contributing no URL segment, nor for `app\_pages\` holding 38 pages.

**Files touched**: `audits/FRONTEND_PAGES_AUDIT.md` (new),
`audits/DUPLICATE_AND_LEGACY_FINDINGS.md` (D-04, D-05, D-11 table),
`frontend/FRONTEND_ROUTE_MAP.md`, `frontend/FRONTEND_ARCHITECTURE.md`,
`PROJECT_RISKS.md` (R-15), `PROJECT_MAP.md`, `FINAL_REPORT.md`,
`DOCUMENTATION_AUTHORITY.md`, `pending/PENDING-002`, `logs/LOG-001`,
`implementation/015-*`, `verification/015-*`.

No application code was modified.

---

## Pre-2026-09-28 History

**UNKNOWN.** No git log analysis was performed during this bootstrap. Existing `docs/reports/*.md` files (e.g. `FINAL_REPORT_SIX_ENGINE_RUNTIME_IMPLEMENTATION.md`, `FINAL_REPORT_ORDERS_TERMINAL_REBUILD.md`, `FINAL_REPORT_DATA_CENTER_REAL_DATA_OVERHAUL.md`) describe prior work but were not cross-referenced against commit history.

**Recommended**: `git log --stat -100` to reconstruct.

---

## Related Documents
- `FINAL_REPORT.md` — Master report
- `PROJECT_GAPS.md` — Open items
- `implementation/015-project-discovery-and-documentation-bootstrap.md` — Bootstrap record
