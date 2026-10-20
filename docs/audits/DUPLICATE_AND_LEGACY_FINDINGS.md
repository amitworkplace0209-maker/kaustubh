# DUPLICATE_AND_LEGACY_FINDINGS.md

## KAUSTUBH Trading Platform - Duplicate & Legacy Analysis

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Method**: Static filesystem + source inspection.
**IMPORTANT**: This is an **analysis document, not a cleanup instruction**. No file was deleted, renamed, or moved.

---

## Summary

| Category | Findings | Severity |
|----------|----------|----------|
| Duplicate backend APIs | 3 | Medium |
| Duplicate frontend pages | 41 unroutable + ~11 duplicate URLs | Medium |
| Duplicate health endpoint | 1 | Medium |
| Legacy/stale documentation | 5+ | Low |
| Placeholder content | 3+ | Low |

---

## D-01: Health Endpoint Registered Twice

**Marker**: `DOCUMENTATION_CODE_CONFLICT`
**Severity**: Medium

| Module | Route |
|--------|-------|
| `python-service/api/routes.py` | `GET /api/health` |
| `python-service/api/system.py` | `GET /api/health` |

**Analysis**: FastAPI matches routes in registration order. In `app.py`, `session_router` (from `routes.py`) is registered first (line 66 import, first `include_router`), `system_router` ninth. Therefore `/api/health` resolves to `routes.py`. `system.py`'s version is unreachable.

**Impact**: Two different health payloads exist; only one is served. Documentation referencing "the" health endpoint may be wrong.

**Recommended**: Verify with `curl`, then remove or rename the dead route. **Do not remove without confirming which is used.**

---

## D-02: Watchlist API Triplication

**Marker**: `DUPLICATE_OR_POSSIBLE_DUPLICATE`
**Severity**: Medium

| Module | Prefix | Responsibility |
|--------|--------|---------------|
| `api/watchlist.py` | `/api/watchlist` | Simple symbol/favorite watchlist |
| `api/watch_list.py` | `/api/watch-list` | Watchlist with hidden flags |
| `api/watchlist_engine.py` | `/api/watchlist-engine` | Full watchlist engine (cards, dynamic kinds, screening, ordering, subscriptions) |

**Analysis**: Three different APIs with different prefixes, overlapping concepts (`favorite` vs `hidden` vs engine-managed watchlists). `watchlist_engine.py` is clearly the most capable.

**Impact**: Unclear which is canonical. Frontend has `/trading/watchlist`, `/services/watchlist`, and `/data-saver/watch-list` — potentially all calling different APIs.

**Recommended**: Define `watchlist_engine` as canonical; document the others as legacy or distinct scopes. **Requires per-file comparison first.**

---

## D-03: Duplicate `/api/trading` Prefix

**Marker**: `DUPLICATE_OR_POSSIBLE_DUPLICATE`
**Severity**: Medium

| Module | Prefix | Tag |
|--------|--------|-----|
| `api/trading.py` | `/api/trading` | `trading` |
| `api/trading_dashboard.py` | `/api/trading` | `trading` |

**Analysis**: Both register under the same prefix with the same tag. No path collision (paths differ), but OpenAPI grouping is muddled.

**Impact**: Low functional risk; documentation/clarity risk.

---

## D-04: 74 Non-Routable Files in `app/_pages/` (38 are pages)

**Marker**: `DUPLICATE_OR_POSSIBLE_DUPLICATE`
**Severity**: Medium
**Corrected 2026-09-28**: was stated as "41 files". Actual: **74** `.tsx` files in **40**
directories, of which **38** are `page.tsx`. Full analysis: `docs/audits/FRONTEND_PAGES_AUDIT.md`.

**Analysis**: `app/_pages/` is a Next.js **private folder** (underscore prefix) and is excluded from routing. It contains 41 `page.tsx` files whose names closely mirror routed pages:

| `_pages/` file | Routed equivalent |
|---------------|-------------------|
| `dashboard/` | `(dashboard)/dashboard/` |
| `market-watch/` | `(dashboard)/market-watch/`, `(services)/services/market-watch/` |
| `orders/` | `(dashboard)/orders/`, `(trading)/trading/orders/` |
| `positions/` | `(dashboard)/positions/`, `(trading)/trading/positions/` |
| `session-manager/` | `(services)/services/session-manager/` |
| `scheduler/` | `(services)/services/scheduler/` |
| `order-engine/` | `(services)/services/order-engine/` |
| `settings/` | `(dashboard)/settings/`, `(services)/services/settings/`, ... |
| `websocket-engine/` | `(services)/services/websocket-engine/` |
| `downloads/` | `(dashboard)/downloads/`, `(phase2)/data-saver/downloads/` |

**Two possible explanations**:
1. **Composition** — routed pages import these as sub-components (legitimate pattern).
2. **Legacy** — the App Router migration moved to route groups and left the old directory behind.

**Status**: `UNKNOWN`. Requires import-graph analysis.

**Recommended**: ~~For each of the 41 files, run `grep -r "_pages/<name>" app components lib`. Files with zero imports are dead code candidates.~~
→ **DONE.** The import graph was built: **exactly 1** of the 74 files is imported by the
live app (`app\_pages\dashboard\page`, via `app\(dashboard)\dashboard.tsx:13`). The other
**73 are unreachable**. Largest dead clusters: `session-manager` (15), `market-watch` (10),
`scheduler` (5), `connection-manager` (4), `order-engine` (4). Interpretation: `_pages` is
the pre-migration snapshot of the flat routes, retained after the move into route groups.
**Do not delete** — see `FRONTEND_PAGES_AUDIT.md` §4 for the recommended sequence.

**DO NOT DELETE** until this analysis is complete and approved.

---

## D-05: ~~Duplicate Frontend URLs Across Route Groups~~ → **WITHDRAWN 2026-09-28**

**Marker**: `DUPLICATE_OR_POSSIBLE_DUPLICATE`
**Severity**: ~~Medium~~ → **None — finding withdrawn**

> ### ⚠ THIS FINDING WAS WRONG. It has been withdrawn.
>
> The first pass listed leaf names appearing at several paths and inferred that
> "4 implementations of `/settings`" and "3 of `/market-watch`" meant duplicate route
> strings — i.e. a build-blocking conflict. **They are not duplicates.** Every entry is a
> *distinct URL*:
>
> - `/settings` · `/trading/settings` · `/services/settings` · `/ai/settings` ·
>   `/data-saver/settings` (+ 9 `data-saver/settings/{sub}` pages)
> - `/market-watch` · `/trading/market-watch` · `/services/market-watch` ·
>   `/data-saver/watch`
>
> **Measured**: 151 routable `page.tsx` files yield **151 distinct route strings**.
> A duplicate would require a string to appear more than once. **None does.**
>
> **There is no build-blocking route collision.** The original analysis had already noted
> "`/trading/market-watch` ≠ `/market-watch`" for one row and then generalised wrongly from
> the rest.
>
> **Evidence and full route table**: `docs/audits/FRONTEND_PAGES_AUDIT.md` §2
> **Also corrected there**: the "166 `page.tsx`" and "41 `_pages` files" figures were
> counting errors; the real figures are **189** `page.tsx`, **151** routable, **74** files
> under `app\_pages\`.
>
> **Action taken**: `PENDING-002` no longer treats this as the primary build risk;
> `R-15` reduced to low. `npm run build` is still worth running (PENDING-002), but for
> ordinary compile/type reasons, not to surface a known collision.

<details><summary>Original (withdrawn) analysis, retained for traceability</summary>

| URL | Implemented in |
|-----|----------------|
| `/market-watch` | `(dashboard)`, `(trading)/trading/market-watch`, `(services)/services/market-watch` |
| `/settings` | `(dashboard)`, `(trading)/trading/settings`, `(services)/services/settings`, `(phase2)/data-saver/settings` |
| `/notifications` | `(dashboard)`, `(trading)/trading/notifications`, `(phase2)/data-saver/notifications` |
| `/positions` | `(dashboard)`, `(trading)/trading/positions` |
| `/orders` | `(dashboard)` only (routed) |
| `/funds` | `(dashboard)`, `(trading)/trading/funds` |
| `/holdings` | `(dashboard)`, `(trading)/trading/holdings` |
| `/portfolio` | `(dashboard)`, `(trading)/trading/portfolio` |
| `/order-history` | `(dashboard)`, `(trading)/trading/order-history` |
| `/watchlist` | `(trading)/trading/watchlist`, `(services)/services/watchlist` |
| `/system` | `(dashboard)`, `(services)/services/system` |

**Original (incorrect) impact claim**: *"Next.js will error on a build if two groups define
the identical route path with the same segment structure. Since the build has not been run,
this is a potential build-blocking conflict."*

**Why it was wrong**: the rows above list *different paths that share a leaf name*. Group
segments `(dashboard)`, `(trading)`, `(services)`, `(phase2)`, `(ai)` do not contribute URL
segments, but the directory names after them do — `trading/market-watch` and
`services/market-watch` are different routes from `market-watch`.

</details>

---

## D-06: Stale "MIGRATED" Documentation Headers

**Marker**: `DOCUMENTATION_GAP`
**Severity**: Low

**Analysis**: Several files in `docs/architecture/` carry "MIGRATED" markers in their headers, e.g. `01_SYSTEM_OVERVIEW.md` ("4-WS architecture migrated..."). These markers lack migration dates, source/target systems, or completion criteria.

**Impact**: New agents may believe the codebase is mid-migration.

**Recommended**: Add date + scope, or remove. Files: `01_SYSTEM_OVERVIEW.md`, `08_WEBSOCKET_ARCHITECTURE.md`, `17_DATABASE_ARCHITECTURE.md`, `06_BROKER_ARCHITECTURE.md`.

---

## D-07: Placeholder Engine IDs in Specs

**Marker**: `DOCUMENTATION_GAP`
**Severity**: Low

**Analysis**: Some `docs/engines/*.md` files use `$(...)` template syntax for `engine_id` rather than the actual ID.

**Impact**: Specs cannot be machine-validated against the engine registry.

**Recommended**: Replace placeholders with real IDs from `docs/engines/ENGINE_INVENTORY.md`.

---

## D-08: Engine Inventory vs Engine Spec Files Mismatch

**Marker**: `DOCUMENTATION_GAP`
**Severity**: Low

| Source | Count |
|--------|-------|
| `ENGINE_INVENTORY.md` registered engines | 15 |
| Distinct `docs/engines/*.md` files | 25+ (includes sub-pages, reports, audits) |

**Analysis**: The extra files are legitimately sub-documents (e.g. `db_writer_engine_detailed.md`, `MARKET_WATCH.md`, `scheduler-engine.md`), not duplicate engines. Not a real conflict, but the count discrepancy needs an explicit note in the inventory.

**Recommended**: Add a file-to-engine mapping table to `ENGINE_INVENTORY.md`.

---

## D-09: Multiple Reports Describing Overlapping Work

**Marker**: `DUPLICATE_OR_POSSIBLE_DUPLICATE`
**Severity**: Low

```
docs/reports/FINAL_REPORT_SIX_ENGINE_RUNTIME_IMPLEMENTATION.md
docs/reports/FINAL_REPORT_ORDERS_TERMINAL_REBUILD.md
docs/reports/FINAL_REPORT_DATA_CENTER_REAL_DATA_OVERHAUL.md
```

**Analysis**: Three "FINAL_REPORT_*" documents for different subsystems. Not duplicates of each other, but the naming convention collides with the new `docs/FINAL_REPORT.md` master report, which could confuse.

**Recommended**: Keep as-is (historical records), but note in `PROJECT_MAP.md` that `docs/FINAL_REPORT.md` is the current master. *(Already done.)*

---

## D-13: The `python -m kaushub.*` CLI Does Not Exist ⚠ CRITICAL

**Marker**: `DOCUMENTATION_CODE_CONFLICT`
**Severity**: **Critical** — the only documented remediation path is fictional

**Discovered on the 2026-09-28 second pass** (reading `32`, `34`, `35`).

`32_ARCHITECTURE_GAPS.md` and `34_DEVELOPER_ONBOARDING.md` instruct operators to run:

```bash
python -m kaushub.engine start audit_engine
python -m kaushub.engine restart sqareoff_engine
python -m kaushub.engine status <name>
python -m kaushub.engine reconcile positions
python -m kaushub.cli start
python -m kaushub.cli status
python -m kaushub.db.query <collection> <filter>
```

**Verification**: `Get-ChildItem -Recurse -Path C:\project -Filter "kaushub*"` returned
**no results**. `python-service\` contains no `cli.py` and no `__main__.py`.
Actual entry points: `app.py`, `start_backend.py`, `watchdog_backend.py`.

**Every command above fails immediately.** All 4 "open" gaps in `32_ARCHITECTURE_GAPS.md`
are therefore unfixable as documented. Engine lifecycle is instead driven over HTTP via
`api/engine_control.py` (tests: `test_engine_control_api.py`, `test_engine_registry.py`).

**See** `docs/DOCUMENTATION_AUTHORITY.md` §5.

---

## D-14: Banner-Body Contradiction Across the Entire Numbered Architecture Set ⚠ CRITICAL

**Marker**: `DOCUMENTATION_CODE_CONFLICT`
**Severity**: **Critical** — misleads any agent following the AI-context doc

All 36 numbered files open with:
> `STATUS: MIGRATED 2026-09-23 — 4-WS model … now WS#1 SFeed + WS#2 OrderFeed +
> WS#3 Backend→Frontend + WS#4 Frontend→Backend.`

**The bodies still describe the superseded 2-WS model:**

| File:line | Body text |
|-----------|-----------|
| `00_ARCHITECTURE_INDEX.md:53` | "WS#1 = broker feed … WS#2 = backend→frontend" |
| `31_CURRENT_VS_TARGET.md:30-35` | Section "WS#1 vs WS#2 Separation" … "✅ Confirmed" |
| `34_DEVELOPER_ONBOARDING.md:12` | "WS#1/WS#2 Separation …" |
| `35_AI_AGENT_CONTEXT.md:19-20, 30` | "WS#1: Broker feed … WS#2: Backend→frontend"; "WS#1 ≠ WS#2" |

**The 2026-09-23 migration was applied as a banner only; bodies were never rewritten.**
`35_AI_AGENT_CONTEXT.md` — the file explicitly written for AI agents — therefore teaches
the wrong WebSocket model.

**Also — banner character damage (precise, measured)**: a UTF-8 scan of all 54 files in
`docs\architecture\` shows the banner's two `→` arrows were **transliterated to ASCII `?`**
(exactly 2 `?` per banner file), and **28 of 54 files contain exactly one U+FFFD
replacement character** where the banner's dash belongs. Bodies are otherwise valid UTF-8
and render arrows correctly (40 files contain real `U+2192`, up to 286 occurrences in
`FINAL_PRODUCTION_ARCHITECTURE_AUDIT_REPORT.md`). Localized banner damage, not general
corruption — but grepping for `Backend→Frontend` will not match.

**See** `docs/DOCUMENTATION_AUTHORITY.md` §2.

---

## D-15: Engine Count and Classification Are Wrong in 5 Documents

**Marker**: `DOCUMENTATION_CODE_CONFLICT`
**Severity**: High

Source of truth: `python-service\app.py:609-626` + `services\legacy_engine_facades.py:428-432`.

| Claim | Documentation | Code |
|-------|--------------|------|
| Total engines | **15** (`00`, `31`, `34`, `35`) | **17** (14 native + 3 facade) |
| Native / facade | 13 / 2 | **14 / 3** |
| `sqareoff_engine` | 5 docs | `squareoff_engine` — 0 hits for `sqareoff` in code, 44 for `squareoff` |
| `session_engine` | `00`:83, `35`:45 | `session_manager_engine` |
| `connection_engine` | `00`:84, `35`:46 | `connection_manager_engine` |
| `watchlist_target_engine` | `00`, `31`:26, `32` Gap 3, `35`:51 | **does not exist** |
| `database_engine` | `00`:88, `35`:49 | not registered as an engine |
| `broker_manager` | `00`:87, `35`:48 | not registered as an engine |

**Undocumented registered engines**: `market_watch_engine`, `market_coach`,
`storage_engine`, `db_writer_engine`, `session_manager_engine`,
`connection_manager_engine`, plus facades `scheduler_engine`, `order_engine`,
`position_engine`.

**Implemented but not registered** (in `core/engines/`, absent from the registry):
`risk_engine`, `order_engine`*, `position_engine`*, `target_engine`, `pnl_engine`,
`basket_engine` <sub>*facade-covered</sub>.
`risk_engine` is referenced in `app.py` **only as an API router** (`app.py:111,1023`).

**Also**: `margin_engine` and `squareoff_engine` are registered but **omitted from the
auto-start list** (`app.py:629`). The docs describe `squareoff_engine` as needing a manual
restart — in code it is never started automatically at all.

**See** `docs/DOCUMENTATION_AUTHORITY.md` §4.

---

## D-16: `32_ARCHITECTURE_GAPS.md` Gap 2 Is Contradicted by Code

**Marker**: `DOCUMENTATION_CODE_CONFLICT`
**Severity**: High

`32_ARCHITECTURE_GAPS.md` Gap 2 states `audit_engine` is `UNKNOWN` with root cause
"Engine not yet started at runtime", remediation "Start engine manually".

**Code registers and auto-starts it**:
- `app.py:620` — `audit_engine` in the registration list
- `app.py:629` — `audit_engine` in the auto-start list

Either the code changed after 2026-09-23, or the observation was wrong. Either way the gap
register is stale. See also D-13 (the prescribed fix command does not exist).

---

## D-17: Misc Verified Factual Errors in the Numbered Set

**Marker**: `DOCUMENTATION_CODE_CONFLICT`
**Severity**: Medium

| Claim | File:line | Verified reality |
|-------|-----------|-----------------|
| `C:\project\config.yaml` is the config source | `35`:69, `35`:90 | **Does not exist**; no `config*.y*ml` outside `.venv`. Real: `python-service\config\settings.py` |
| Frontend code is `app\_pages\` | `35`:89, `34`:28 | `_pages\` is a **non-routable** Next.js private folder; 74 files, 38 of them `page.tsx`, of which only 1 is live |
| "30+ frontend pages" | `00`:94, `35`:67 | **151** routable `page.tsx` (**189** total) |
| "25+ engine docs" | `34`:20, `35`:54 | **31** files |
| "35 architecture files" | `00`:93, `34`:21/66/137, `35`:55 | **36** numbered files |
| `cd C:\project; pip install -r requirements.txt` | `34`:37-38 | `requirements.txt` is in `python-service\`; no root copy |
| Tests in `python-service\tests\` | `34`:59 | ✅ **Correct** — 68 test modules |
| "10 RUNNING, 1 DEGRADED, 3 UNKNOWN" (=14) | `35`:24, `31`:61 | The tables below say **12/1/2** (=15). Prose contradicts its own table in both docs |

---

## D-18: All Runtime-State Claims in the Numbered Set Are `NOT_VERIFIED`

**Marker**: `NOT_VERIFIED`
**Severity**: High

Every current-state claim in `31_CURRENT_VS_TARGET.md` and `35_AI_AGENT_CONTEXT.md` —
engine states, "15 symbol feeds", "24 frontend connections", "12 active users",
"12/15 engines reporting", "All 3 brokers active", "MongoDB … all collections active" — is
**`NOT_VERIFIED`**.

Reasons:
1. No timestamped run log accompanies any figure.
2. The prescribed validation process is fictional (D-13).
3. Prose and tables contradict each other (D-17).
4. `00`:50 and `35`:28 declare engine docs to be **target** architecture, yet `31`:88 and
   `35`:115 present the tables as "observed runtime state".

`docs/DOCUMENTATION_AUTHORITY.md` §7 has the full analysis. Only `PENDING-001` can
establish real state.

---

## D-11: `docs/architecture/` Contains Two Parallel Document Sets

**Marker**: `DUPLICATE_OR_POSSIBLE_DUPLICATE`
**Severity**: High (documentation authority is ambiguous)

**Discovered during the final cross-check pass.**

`docs/architecture/` holds 36 numbered files (`00_`–`35_`) **and** 19 unnumbered files. Several unnumbered files cover the same subject as numbered ones:

| Unnumbered | Overlaps with | Notes |
|-----------|---------------|-------|
| `ENGINE_ARCHITECTURE.md` | `02_ENGINE_ARCHITECTURE.md` | Subject-identical |
| `ENGINE_DEPENDENCY_GRAPH.md` | `03_ENGINE_DEPENDENCY_GRAPH.md` | Subject-identical |
| `BROKER_ARCHITECTURE.md` | `06_BROKER_ARCHITECTURE.md` | Subject-identical |
| `SESSION_MANAGER_ENGINE.md` | `07_SESSION_ARCHITECTURE.md` | Overlapping |
| `REALTIME_DATA_FLOW.md` | `09_REALTIME_DATA_FLOW.md` | Subject-identical |
| `ORDER_POSITION_FLOW.md` | `11_TRADING_FLOW.md` / `12_ORDER_LIFECYCLE.md` / `14_POSITION_PNL_ARCHITECTURE.md` | Overlapping |
| `SCHEDULER_LIFECYCLE.md` | `04_STARTUP_SHUTDOWN_LIFECYCLE.md` / `05_RUNTIME_LIFECYCLE.md` | Overlapping |
| `WEBSOCKET_ENGINE.md` | `08_WEBSOCKET_ARCHITECTURE.md` | Overlapping |
| `PHASE_1_2_3_4_RESPONSIBILITIES.md` | `20_SERVICE_PHASE_ARCHITECTURE.md`, `21_PHASE_1_ARCHITECTURE.md`, `22_PHASE_2_ARCHITECTURE.md` | Overlapping |
| `DATA_FLOW_MAP.md` | `10_MARKET_DATA_FLOW.md` (and root `docs/DATA_FLOW_MAP.md`) | Overlapping |
| `FAILURE_AND_RECOVERY.md` | `26_ERROR_RECOVERY_ARCHITECTURE.md` | Overlapping |
| `SDK_CATALOG.md` | (new, created by this bootstrap) | No prior equivalent |
| `WEBSOCKET_ARCHITECTURE.md` | `08_WEBSOCKET_ARCHITECTURE.md` | Overlapping |
| `ENGINE.md` | `02_ENGINE_ARCHITECTURE.md` | Overlapping |

**Analysis**: The numbered set appears to be a later, structured series (it includes `00_ARCHITECTURE_INDEX.md`, `31_CURRENT_VS_TARGET.md`, `32_ARCHITECTURE_GAPS.md`, `34_DEVELOPER_ONBOARDING.md`, `35_AI_AGENT_CONTEXT.md` — a coherent doc programme). The unnumbered set appears older and ad hoc.

**Impact**: A new agent reading `ENGINE_ARCHITECTURE.md` instead of `02_ENGINE_ARCHITECTURE.md` may get stale guidance. **Documentation authority is currently ambiguous.**

**Also overlapping with newly created catalogs:**
| New file | Overlaps with |
|-----------|---------------|
| `api/API_CATALOG.md` | `28_API_ARCHITECTURE.md` |
| `config/CONFIGURATION_CATALOG.md` | `18_CONFIGURATION_ARCHITECTURE.md` |
| `security/SECURITY_ARCHITECTURE.md` | `25_SECURITY_ARCHITECTURE.md` |
| `observability/OBSERVABILITY_ARCHITECTURE.md` | `27_OBSERVABILITY_ARCHITECTURE.md` |
| `architecture/FAILURE_AND_RECOVERY.md` | `26_ERROR_RECOVERY_ARCHITECTURE.md` |
| `frontend/FRONTEND_ARCHITECTURE.md` | `19_UI_ARCHITECTURE.md` |

**Recommended**:
1. Read `00_ARCHITECTURE_INDEX.md` to learn the intended authority order.
2. Read `31_CURRENT_VS_TARGET.md` and `32_ARCHITECTURE_GAPS.md` — they may already document much of what this bootstrap rediscovered.
3. Read `34_DEVELOPER_ONBOARDING.md` and `35_AI_AGENT_CONTEXT.md` — they may be the correct pre-existing entry points, which would make `PROJECT_MAP.md` partially redundant.
4. Then either deprecate the unnumbered set with a header pointing to the numbered set, or fold the numbered set into the unnumbered naming.

**Tracked in** `docs/pending/PENDING-003-static-code-audit.md`.

---

## D-12: `docs/reports/` Also Has Two Naming Conventions

**Marker**: Informational
**Severity**: Low

`docs/reports/` contains 7 `FINAL_REPORT_*.md` files plus 15 audit/verification `.txt`/`.json`/`.md` files. The `FINAL_REPORT_*` prefix collides conceptually with the new `docs/FINAL_REPORT.md` master report.

**Mitigation**: `PROJECT_MAP.md` explicitly states that `docs/FINAL_REPORT.md` is the current master. The `reports/FINAL_REPORT_*` files are historical subsystem records.

---

## D-10: No `src/`, `backend/`, `frontend/`, `services/`, `engines/` Root Directories

**Marker**: Informational
**Severity**: None

**Analysis**: The project uses `python-service/` for backend and root-level `app/`, `components/`, `lib/`, `hooks/` for frontend. This is unconventional but internally consistent. `services/` and `engines/` exist only *inside* `python-service/`.

**Impact**: Documentation written assuming a standard layout would be wrong. `PROJECT_MAP.md` records the actual layout.

---

## Cleanup Priority

| Priority | Finding | Action (requires approval) |
|----------|---------|---------------------------|
| P0 | D-05 | Run `npm run build` to detect real route collisions |
| P0 | D-04 | Import-graph analysis of 41 `_pages` files |
| P1 | D-01 | Confirm which `/api/health` is live; remove dead route |
| P1 | D-02 | Decide canonical watchlist API |
| P2 | D-03 | Split `/api/trading` tags for clarity |
| P2 | D-06, D-07, D-08 | Documentation hygiene |
| P3 | D-09 | Naming note (already added to PROJECT_MAP) |

---

## Rules for Future Cleanup Work

Per `PROJECT_IMPLEMENTATION_RULE.md`:
1. **Never delete without explicit approval.**
2. **Document the duplicate** (done here) **before** changing anything.
3. **Verify with tests** after any removal.
4. **Update `PROJECT_CHANGE_HISTORY.md`** for every removal.
5. **Preserve git history** — commit, don't rewrite.

---

## D-19: ~98,000 Lines of Application Code Are Uncommitted — CRITICAL

**Marker**: `DOCUMENTATION_GAP`
**Severity**: **Critical**
**Discovered**: 2026-09-28 via read-only `git status --porcelain -uall`
**Full analysis**: `docs/audits/VERSION_CONTROL_STATE.md`

| Metric | Value |
|--------|-------|
| Commits | 3 |
| Tracked files in HEAD | **141** |
| Untracked files | **970** |
| Routable `page.tsx` in HEAD | **16** |
| Routable `page.tsx` in working tree | **151** |
| Untracked `.ts`/`.tsx` in `app`,`components`,`lib`,`hooks` | 480 files / **~97,925 lines** |
| Untracked `.py` in `python-service` | 207 |

**Analysis**: The repository history contains an almost-empty frontend (16 pages, all under
`(dashboard)`) while the working tree contains a 151-page Next.js application plus 207
uncommitted Python modules. **This documentation set describes the working tree, not the
repository.** A fresh `git clone` produces a different application.

**Impact**: catastrophic data-loss exposure (no history exists for the real code), plus a
reproducibility failure for every static claim in this documentation set. Not detectable by
build, type-check, or lint.

**Also found — 11 uncommitted deletions**, 3 of them code:
- `app/(dashboard)/trading/page.tsx` — **CORRECTION**: an earlier revision of this entry
  claimed "HEAD holds **both** this and `(trading)/trading/page.tsx`, which both resolve to
  `/trading` — a genuine duplicate-route build error." **That is false and is withdrawn.**
  `app/(trading)/trading/page.tsx` is **untracked**; `git ls-tree -r HEAD` lists 16 routable
  pages (15 under `(dashboard)` + `app/page.tsx`) and **no** `(trading)` group. A fresh
  clone therefore has **no** duplicate. The collision would arise only if the untracked
  `(trading)` page were committed *without* this deletion — a hazard for the future commit,
  not a present build error. **D-05 remains withdrawn.**
- `components/sidebar.tsx` — 201 lines, **referenced by nothing**; already superseded by
  `components/layout/phase-sidebar.tsx`. Harmless.
- **`tailwind.config.ts`** — **a real regression** (since **restored**, see R-35). It *was*
  tracked in `HEAD` and deleted in the working tree; it is not "never committed". Tailwind is
  v3.4.17 and `globals.css` uses
  v3 directives, so this file is required. Deleting it removes `darkMode: ['class']`, the entire
  semantic colour palette (`background`/`foreground`/`card`/`primary`/`success`/`border`/`ring`/…),
  radius tokens, `gradient-radial`/`gradient-conic`, the accordion keyframes, and the
  `tailwindcss-animate` plugin. The `shadcn`-style `components/ui/*` layer will render
  **unstyled**. No `tailwind.config.js` replacement exists.

**Recommended**: restore `tailwind.config.ts`; commit the application in logical slices.
**Requires owner approval — both are code changes.** See **R-34**, **R-35**.

---

## D-20: Risk Register Used R-17…R-25 Twice

**Marker**: `DOCUMENTATION_CODE_CONFLICT`
**Severity**: Low (self-inflicted, now fixed)

**Analysis**: `PROJECT_RISKS.md` contained two independent blocks using overlapping IDs
R-17 through R-25, so a reference to "R-20" was ambiguous. The pre-existing block was
renumbered to **R-25…R-33**, the security block keeps **R-17…R-24**, and **R-34/R-35** were
added for D-19. Cross-references in `runtime/SCHEDULER_AND_LIFECYCLE.md` and
`security/SECURITY_ARCHITECTURE.md` were corrected. **All IDs are now unique.**

---

## D-21: Untracked Directories Outside the Documented Tree

**Marker**: `DOCUMENTATION_GAP`
**Severity**: Low

Extends D-10 ("no `src/`, `backend/`, `frontend/`, `services/`, `engines/` root
directories"). Present in the working tree, absent from history:

| Dir | Files | Notes |
|-----|-------|-------|
| `archive\legacy\` | 41 | legacy tree |
| `apps\` | 8 | `data-saver`, `khumbha-ai`, `services`, `trading-terminal` |
| `khumbha-ai\` | 6 | `main.py`, `bg_stdout.log`, `bg_stderr.log`, `__pycache__` |
| `config\` | 2 | `brokerage.ts`, `statutory-charges.ts` |

`khumbha-ai\` contains captured process logs and a `__pycache__` directory; `.gitignore`
covers only `/.next/` and `next-env.d.ts`, so these would be committed by accident.

---

## D-22: Frontend Session Is an Unsigned Cookie — CRITICAL

**Marker**: `DOCUMENTATION_CODE_CONFLICT`
**Severity**: **Critical**
**Discovered**: 2026-09-28 while auditing the frontend contract
**Full analysis**: `docs/security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md`

`lib/auth-crypto.ts:52-59` — `createSessionToken()` is `Buffer.from(JSON.stringify({authenticated, iat, exp})).toString('base64')`.
**No HMAC, no signature, no encryption, no server-side session.** The only validator in the
codebase is `app/api/realtime/token/route.ts:30-38`, which decodes the cookie and checks
`authenticated === true && exp > Date.now()`. There is **no `middleware.ts`**.

A client can therefore authenticate itself with
`base64('{"authenticated":true,"exp":99999999999999}')`.

**A second, independent bypass**: `app/api/auth/login/route.ts:38-50` — with app lock
unconfigured, `POST {"direct": true}` returns a session cookie with **no credentials**.
`isAppLockConfigured()` **fails open** (`:5-10`), and `.auth/` is gitignored while
`APP_LOCK_PIN` exists only in `.env.example` — so **a fresh clone is vulnerable by default.**
Verified true in the current tree: no `.auth/app-lock.json`, no `APP_LOCK_PIN`.

**Escalation**: `/api/realtime/token` is gated *only* by that cookie, then mints a real
backend **operator JWT** from server-side `APP_USERNAME`/`APP_PASSWORD` with an 8 h cache
(`:27-45`) and returns it to the caller. Those vars are currently unset, so it degrades to
anonymous — but the design permits operator-level access to the 37 unauthenticated routers
(R-17) the moment they are configured.

Secondary: `Math.random()` salt, single-round SHA-256 for a 6-digit PIN, non-constant-time
`pin === envPin` at `:19`, no rate limiting (R-29), `secure` cookie only when
`NODE_ENV === 'production'`, and dead `GUEST_EMAIL`/`GUEST_PASSWORD` accessors.

**Risks**: **R-36**, **R-37**, **R-38**. **No code was changed.**

---

## D-23: Two Grep False-Positives Recorded to Prevent Re-Reporting

**Marker**: `DOCUMENTATION_GAP`
**Severity**: Informational

While auditing the WebSocket contract, two searches produced findings that were **false**.
Both are recorded so they are not re-raised as bugs:

1. **`engine.status` appears nowhere in the backend** — false. A `"type": "…"` literal scan
   returns ~80 hits without it, because the value is produced by `_map_wire_type()`
   (`connection_engine.py:184-185`), not written literally. Channel routing is likewise
   table-driven at `:88`. The contract is **correct** and covered by
   `test_connection_engine.py:198-251`.
2. **`heartbeatIntervalS` appears nowhere** — false. Built at `ws_gateway.py:336` from
   `client.py:29`.

**Lesson applied**: a keyword search proves *absence of a literal*, not *absence of a
behaviour*. Both conclusions were overturned by reading the mapping function and the tests.

---

## Related Documents
- `../frontend/FRONTEND_ROUTE_MAP.md` — Route inventory
- `../api/API_CATALOG.md` — Route registry
- `../PROJECT_GAPS.md` — Related gaps
- `../FINAL_REPORT.md` — Conflict summary
