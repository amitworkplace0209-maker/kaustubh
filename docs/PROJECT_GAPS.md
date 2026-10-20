# PROJECT_GAPS.md

## KAUSTUBH Trading Platform - Documentation & Knowledge Gaps

**Last Updated**: 2026-09-28
**Status**: ACTIVE

---

## Gap Register

### GAP-001: Live Runtime Verification Absent
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: Critical
- **Detail**: All engine states, health values, API responses, WebSocket behavior, DB counts, and broker interactions come from documentation, not observation.
- **Resolution**: Run backend in `dummy` broker mode; capture `/api/services/engines`, `/api/system/health`.

### GAP-002: Secret Masking in Settings API Unverified
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: Critical
- **Detail**: `api/settings.py` exposes 8 endpoints reading configuration. Whether `jwt_secret`, `mpin`, `totp_secret` are redacted is unknown.
- **Resolution**: `curl /api/settings` and inspect response body.

### GAP-003: No Committed OpenAPI Specification
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: High
- **Detail**: ~450 routes have no version-controlled schema. `api/API_CATALOG.md` has method+path only.
- **Resolution**: Export `/openapi.json` and commit under `docs/api/OPENAPI.json`.

### GAP-004: ~~`app/_pages/*` Liveness Unknown~~ → **RESOLVED 2026-09-28**
- **Type**: `DOCUMENTATION_GAP` (closed)
- **Severity**: ~~High~~ → **Low** (hygiene only)
- **Was**: 41 `page.tsx` files in a non-routable directory; live-imported vs dead undetermined.
- **Now**: the count was also wrong. `app\_pages\` holds **78** files across **36** top-level directories (38 `page.tsx`;ories). The import graph is built: **exactly 1 file is imported by the live app** — `app\_pages\dashboard\page`, via `app\(dashboard)\dashboard.tsx:13`. The other **73 are unreachable**. Intra-`_pages` imports form a closed cluster (`connection-manager-data`, `scheduler-data`, `sm-shared`, `mw-shared`) whose consumers are themselves dead. `_pages` is the pre-migration snapshot of the flat routes.
- **Resolution**: done. See `audits/FRONTEND_PAGES_AUDIT.md` §4. **Do not delete** — the shared sub-components encode intent. Lowest-risk remaining step is a `README` in `app\_pages\`.

### GAP-005: ~~Route Ordering Hazards Unverified~~ → **RESOLVED 2026-09-28 — no hazard**
- **Type**: `DEPENDENCY_UNRESOLVED` (closed)
- **Severity**: Medium → **None**
- **Detail**: `engine_control.py` declares `GET /{engine_id}` before `GET /broker/status`. FastAPI matches in order, so `broker` may be swallowed.
- **Now**: **disproved.** `/summary` is ordered safely and the two path shapes cannot collide (`/broker/status` is two segments; `/{engine_id}` is one). No ordering hazard exists.
- **Resolution**: done. Recorded as D-01 refutation.

### GAP-009: ~~Broker Failover Claims Unverified~~ → **RESOLVED 2026-09-28 — there is no failover**
- **Type**: `DOCUMENTATION_GAP` (closed, replaced by a finding)
- **Severity**: High → **High (confirmed defect)**
- **Was**: "Broker failover claims unverified."
- **Now**: read in full. `brokers/manager.py` **exists** (prior unknown resolved) and implements no health check, failure detection, retry, circuit breaker, or automatic switch. `get_trading_status()` / `get_market_data_status()` compute an honest state and **nothing consumes it**. Additionally, **two independent selection systems** (`manager.active_terminal()` vs `registry.get/set_trading_broker()`) never reconcile, and the Shoonya capability table contradicts its adapter.
- **Resolution**: nothing to verify — the gap became a defect. See `broker/BROKER_SELECTION_AND_FAILOVER.md`, **R-39…R-42**.

### GAP-006: Duplicate Health Endpoint
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: Medium
- **Detail**: `GET /api/health` in both `api/routes.py` and `api/system.py`. Only one wins.
- **Resolution**: Confirm which, then remove or rename the other.

### GAP-007: Watchlist API Triplication
- **Type**: `DUPLICATE_OR_POSSIBLE_DUPLICATE`
- **Severity**: Medium
- **Detail**: Three modules serve watchlist responsibilities under different prefixes.
- **Resolution**: Define single canonical API; deprecate others.

### GAP-008: Engine Dependency Graph Mismatch
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: Medium
- **Detail**: `03_ENGINE_DEPENDENCY_GRAPH.md` omits code-declared deps for `margin_engine` and `market_coach`.
- **Resolution**: Diff `docs/architecture/03*` against actual imports in `core/engines/*.py`.

### GAP-009: Broker Failover Claims Unverified
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: Medium
- **Detail**: `06_BROKER_ARCHITECTURE.md` describes broker_manager failover and load balancing. `brokers/manager.py` existence confirmed; logic not audited.
- **Resolution**: Read `brokers/manager.py` and `brokers/registry.py` in full.

### GAP-010: Database Collection Counts Are Estimates
- **Type**: `NOT_VERIFIED`
- **Severity**: Medium
- **Detail**: `17_DATABASE_ARCHITECTURE.md` cites specific counts and pool metrics.
- **Resolution**: `db.orders.estimatedDocumentCount()` etc.

### GAP-011: AI Route Group Purpose Unknown
- **Type**: `UNKNOWN`
- **Severity**: Medium
- **Detail**: 14 `(ai)` routes (agents, datasets, inference, models, training) exist with no backend counterpart found in `api/`.
- **Resolution**: Determine if these are placeholders, use a different backend, or unimplemented.

### GAP-012: Supabase Dependency Usage Unknown
- **Type**: `UNKNOWN`
- **Severity**: Low
- **Detail**: `@supabase/supabase-js` 2.58.0 in `package.json`; no matching backend config or usage confirmed.
- **Resolution**: `grep -r "supabase" app components lib`.

### GAP-013: Dependency Vulnerability Scan Not Run
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: High
- **Detail**: No CVE data for 25 Python + 41 Node packages.
- **Resolution**: `pip-audit -r requirements.txt`; `npm audit`.

### GAP-014: Test Results Unknown
- **Type**: `NOT_VERIFIED`
- **Severity**: High
- **Detail**: ~50 Python test files and `tests/` (TypeScript) exist; none executed.
- **Resolution**: `pytest`; `npm test`.

### GAP-015: ~~Git History Not Analyzed~~ → **RESOLVED 2026-09-28 — and the answer is severe**
- **Type**: `DOCUMENTATION_GAP` (closed, replaced by a finding)
- **Severity**: ~~Low~~ → **Critical**
- **Was**: "`PROJECT_CHANGE_HISTORY.md` is a stub; no commit analysis performed."
- **Now**: analyzed read-only. **5 commits, 141 tracked files.** The working tree holds **~975 untracked files**, including **~98,000 lines** of frontend across ~530 `.ts`/`.tsx` and **209** untracked `.py`. Routable pages: **16 in HEAD vs 151 in the working tree.** A fresh `git clone` does not reproduce this application, and none of the static claims in this documentation set are reproducible from the repository.
- **Resolution**: done. See `audits/VERSION_CONTROL_STATE.md` (**R-34**). Recommended: commit the application in logical slices.

### GAP-016: Backend Engine Implementations Not Line-Audited
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: Medium
- **Detail**: 15 engine files identified but not individually verified against their specs.
- **Resolution**: Per-engine audit under `docs/audits/backend/`.
- **Note (2026-09-28)**: the count is **17**, not 15 — 14 native + 3 facade. See `engines/ENGINE_INVENTORY.md` and D-15.

### GAP-017: `components/` and `lib/` Not Exhaustively Read → **PARTIALLY RESOLVED 2026-09-28**
- **Type**: `DOCUMENTATION_GAP` (reduced)
- **Severity**: Medium → **Low for the transport layer**, Medium overall
- **Was**: "Frontend libraries identified by name; internal contracts unverified."
- **Now**: the transport and auth contract **is** verified. Read in full: `lib/kaustubh-types.ts`, `lib/backend.ts`, `lib/realtime-ws.ts`, `lib/engine-realtime.ts`, `lib/env.ts`, `lib/auth-crypto.ts`, `app/api/auth/login/route.ts`, `app/api/realtime/token/route.ts`. **This surfaced a critical finding** (unsigned session token, R-36/R-37/R-38).
- **Still open**: `lib/` is **57 files / ~440 KB**, dominated by `api.ts` (46 KB), `phase2-theme.ts` (46 KB), `topbar-status.ts` (33 KB), `settings-store.ts` (32 KB), `realtime-ws.ts` (32 KB), `data-center.ts` (40 KB). `components/` (137 untracked files) is unread. **No tool can detect drift** between the hand-written TS types and the Python responses, so this gap is structural, not just effort.
- **Resolution**: see `frontend/FRONTEND_CONTRACT.md` (findings C-1…C-13).

### GAP-018: Scheduler Phase Transitions Unverified
- **Type**: `NOT_VERIFIED`
- **Severity**: High
- **Detail**: 12 phase times documented; actual firing order and readiness gates not observed.
- **Resolution**: Run outside market hours with a clock override, or observe a full session.

### GAP-019: Placeholder Engine IDs in Specs
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: Low
- **Detail**: Some `docs/engines/*.md` use `$(...)` template syntax.
- **Resolution**: Replace with actual engine IDs.

### GAP-020: Stale "MIGRATED" Documentation Headers
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: Low
- **Detail**: Several architecture docs carry migration markers without migration dates or targets.
- **Resolution**: Audit and re-date, or remove markers.

### GAP-021: TLS / Rate Limiting Unknown
- **Type**: `UNKNOWN`
- **Severity**: High
- **Detail**: No evidence of HTTPS enforcement, HSTS, or API rate limiting.
- **Resolution**: Inspect reverse-proxy config and FastAPI middleware.

### GAP-022: Retention Job Behavior Unverified
- **Type**: `NOT_VERIFIED`
- **Severity**: Medium
- **Detail**: `atlas_cleanup_*` and `/api/system/cleanup/run` documented; execution not observed.
- **Resolution**: Trigger and inspect.

### GAP-023: PWA Manifest / Service Worker Unverified
- **Type**: `NOT_VERIFIED`
- **Severity**: Low
- **Detail**: `components/pwa/` and `/data-saver/settings/pwa` exist.
- **Resolution**: Build and inspect.

### GAP-024: Notification Delivery Channel Unknown
- **Type**: `UNKNOWN`
- **Severity**: Medium
- **Detail**: `notification_engine` is `REGISTERED`/`UNKNOWN`; delivery mechanism (in-app only? push?) unstated.
- **Resolution**: Read `services/notification_center.py`.

---

## Gaps raised by the 2026-09-28 audit pass

### GAP-025: Repository Does Not Contain Its Own Application
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: Critical
- **Detail**: 5 commits, 141 tracked files, ~975 untracked. 16 routable pages in `HEAD` vs 151 in the working tree; ~98k lines of frontend and 209 `.py` files uncommitted. **A fresh clone cannot build, run, or reproduce this application, and none of this documentation set is reproducible from the repository.** Every static claim here rests on files Git does not track.
- **Resolution**: commit the application in logical slices. See `audits/VERSION_CONTROL_STATE.md`, **R-34**. This is the highest-value action in this document — every other `NOT_VERIFIED` item stays unverifiable until it is fixed.

### GAP-026: Session Token Is Unsigned — Forgeable
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: Critical
- **Detail**: `lib/auth-crypto.ts` builds `kaustubh_session` as base64 of plaintext JSON with **no signature and no `expires` field**. Anyone can mint an operator cookie offline, without credentials. Companion weaknesses: `SHA-256(password + Math.random() salt)` for PINs, and a PBKDF2 iteration count below current guidance.
- **Resolution**: sign the token (HMAC or a server session), enforce expiry server-side, replace the PIN hash. **R-36**, D-22. `security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md`.

### GAP-027: App Lock Fails Open — No App Lock at All by Default
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: Critical
- **Detail**: `app/api/auth/login/route.ts` grants operator access when `!appLock` or `!user`, and `app_lock_enabled` defaults to **false** in `config.py` with no `APP_LOCK_ENABLED` env override. `.env.example` sets `APP_LOCK_PIN`, but `.env` does **not**, and `.auth/` is gitignored. A fresh clone therefore starts **unlocked**, and `POST direct:true` is then the documented no-credential path to operator access.
- **Resolution**: fail **closed** when no PIN is configured; make lock-on-by-default the shipped posture. **R-37**.

### GAP-028: Forged Session Escalates to a Backend Operator JWT
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: High
- **Detail**: `/api/realtime/token` is gated only by the forgeable cookie, then calls `acquireOperatorJwt()` with server-side `APP_USERNAME`/`APP_PASSWORD` (8 h cache) and **returns that JWT to the browser**. Today those vars are unset so it degrades to anonymous; once configured, forging a cookie escalates to operator-level access over the 37 unauthenticated routers. Escalation is latent, not active.
- **Resolution**: mint a narrowly scoped realtime token server-side; never forward operator credentials to a client. **R-38**.

### GAP-029: No Broker Failover Exists
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: High
- **Detail**: no health check, failure detection, retry, circuit breaker, or automatic switch in `brokers/`. Status is computed and never acted on; the only switch caller is the **unauthenticated** engine-control endpoint. Converges with the former GAP-009.
- **Resolution**: `broker/BROKER_SELECTION_AND_FAILOVER.md`, **R-39**.

### GAP-030: Two Broker-Selection Systems That Never Reconcile
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: High
- **Detail**: `manager.active_terminal()` (session-aware, persists across restart) vs `registry.get/set_trading_broker()` (in-memory, resets to `kotak`, supports independent market-data selection). Neither calls the other, so "the active broker" has two sources of truth that can silently disagree — including only after a restart.
- **Resolution**: pick one source of truth. **R-40**.

### GAP-031: Shoonya Capability Table Contradicts Its Adapter, and Tests Enforce It
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: Medium
- **Detail**: all capabilities declared `False`, yet the adapter is 448 lines / 34 defs / 16-of-18 protocol methods — on par with `dummy`, which *is* declared implemented — with zero unimplemented markers. `tests/test_engine_registry.py:301-314` asserts the "not implemented" claim, so the suite locks in the contradiction.
- **Resolution**: read the adapter bodies, then correct either the table or the tests. **R-41**.

### GAP-032: `get_market_data_status()` Reports the Wrong Broker
- **Type**: `DOCUMENTATION_CODE_CONFLICT`
- **Severity**: Medium
- **Detail**: always reads the global `ws_manager`, so selecting `dummy` as market-data broker reports the **real** broker's live WebSocket state (state, symbol count, ticks/s) as the dummy's. `dummy`'s own record is internally inconsistent: `market_data=True` with `websocket=False`.
- **Resolution**: gate the status read on the selected broker. **R-42**.

### GAP-033: Frontend Types Have No Generator — Contract Drift Is Undetectable
- **Type**: `DEPENDENCY_UNRESOLVED`
- **Severity**: Medium
- **Detail**: `lib/kaustubh-types.ts` (~630 lines) is hand-written against Python responses. Backend schemas (pydantic), API route paths, WS message shapes, and env var names all have **no single source of truth** and no drift check. This session found 4 real drifts (engine type, heartbeat unit, `sequence` ignored, mixed naming). The transport is correct, but nothing prevents it regressing.
- **Resolution**: generate TS types from the OpenAPI spec GAP-003 already flags, and CI-check it. Complements GAP-017.

### GAP-034: `.gitignore` Does Not Exclude Downloaded Market Data
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: Low
- **Detail**: `python-service/downloads/` holds 4 files totalling **48.51 MiB** (2 × 23 MB CSV + 2 × 1.2 MB), re-downloadable at runtime, and is **not** ignored — so a future `git add -A` would commit ~48 MiB of derived data. Everything secret *is* correctly ignored (`.env`, `.env*.local`, `.auth/`, caches, logs); no unignored secret pattern was found.
- **Resolution**: add `python-service/downloads/`. **No change made** — the owner selected audit-only. See `audits/GITIGNORE_AUDIT.md`.

### GAP-035: No Machine-Checkable Source of Truth
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: Medium
- **Detail**: the drift that produced most of this session's findings is **structural**. 36 numbered target docs + 19 legacy docs describe the same system with no executable artifact linking code to claims: no OpenAPI spec, no type generation, no test that asserts documented behaviour, no doc CI. Counts (engines, routes, indexes) are re-derived by hand each pass and **already disagreed** across documents at the start of this one.
- **Resolution**: treat GAP-003 (OpenAPI + codegen) as the root fix; most of this register closes as a side effect.

---

## Gaps raised by the 2026-09-28 tick-persistence session (LOG-002)

### GAP-036: Live End-to-End Tick Persistence Never Observed
- **Type**: `NOT_VERIFIED`
- **Severity**: High
- **Detail**: the new DB Writer authority path (classification → permission → dedup → buffer → bulk write) is verified only by static analysis and 1189 automated tests. The routes are confirmed registered and responding over real HTTP, but no live broker feed was observed passing through the decision point, no live MongoDB was inspected, and the `market_ticks` indexes were not re-checked. The resulting documents in `db.ticks` / `db.market_ticks` remain unconfirmed. Note the backend on port 8000 was already running before this change and must be restarted before the new routes return 200.
- **Resolution**: run `docs/pending/PENDING-004-db-writer-tick-persistence-live-verification.md` — the task-specific step-by-step pass. Flip each of the three permissions individually against a live feed and confirm exactly one document per tick, and that an OFF permission produces zero writes. Preconditions from `PENDING-001` apply: confirm the effective database name and `broker_mode=dummy` first.

### GAP-037: DB Writer Settings Panel Never Exercised In A Browser
- **Type**: `NOT_VERIFIED`
- **Severity**: Medium
- **Detail**: the Settings ⚙️ panel and its three toggles on `app/_pages/db-writer/page.tsx` pass `tsc` and `eslint`, but panel open/close, toggle interaction, the rejected-write re-read path, and the real accepted/skipped counters have never been observed against a running backend.
- **Resolution**: exercise with the backend live, including a forced `ok: false` response to confirm the toggle cannot display a rejected value.

### GAP-038: `docs/INDEX.md` Does Not Exist
- **Type**: `DOCUMENTATION_GAP`
- **Severity**: Low
- **Detail**: `docs/INDEX.md` was named as an authoritative input but is absent. There is no single index; entry points are `docs/FINAL_REPORT.md`, `docs/PROJECT_RISKS.md`, `docs/PROJECT_GAPS.md` and the per-domain directories. A newcomer cannot determine which document is current.
- **Resolution**: create `docs/INDEX.md` mapping each domain to its single authoritative document, or amend `PROJECT_IMPLEMENTATION_RULE.md` to name the real entry points.

---

## Closed in this pass

| Former gap | Now | Basis |
|---|---|---|
| GAP-004 `_pages` liveness | closed | 1 live, 73 unreachable (D-04, D-05, D-06) |
| GAP-005 route ordering | closed — no hazard | disconfirmed (D-01) |
| GAP-009 failover claims | closed — replaced by defects | GAP-029…032, R-39…R-42 |
| GAP-015 git history | closed — answer is critical | GAP-025, R-34 |
| GAP-016 engine count | corrected 15 → 17 | D-15 |
| GAP-017 `lib/` + `components/` | reduced | GAP-033 remains |

> **Corrected false positives**, so they are not re-raised: the `/trading` route collision does **not** exist in the working tree (D-05 withdrawn — and `HEAD` does not contain both pages either); the engine snapshot *does* map to `engine.status` with the correct heartbeat unit (D-23); the 4-WS banner claim is a **documentation** contradiction, not a code defect (D-07); settings secret masking is likely safe (D-20 partial); the fake `/api/kaushub/*` "external hangar" is **fiction** (D-11).

---

## Gap Summary

| Severity | Count |
|----------|-------|
| Critical | 5 |
| High | 10 |
| Medium | 17 |
| Low | 7 |
| **Total** | **39** |

**Open**: 14 new (GAP-025…038) · **Reduced**: 1 (GAP-017) · **Closed**: 5 (GAP-004, 005, 009, 015, and GAP-016's count defect)

> The Critical count rose from 2 to 5. That is not documentation drift — GAP-025, 026, 027 are defects found by reading code that earlier passes had marked complete. `FINAL_REPORT.md` has been updated to match.
>
> **2026-09-28 (LOG-002):** +3 gaps. GAP-036 (live tick path never observed) and GAP-037 (Settings panel never exercised in a browser) are verification gaps created by shipping an architecture change without a live run; GAP-038 records that `docs/INDEX.md`, named as an authoritative input, does not exist.

---

## Related Documents
- `PROJECT_RISKS.md` — Risk register (R-34…R-42)
- `FINAL_REPORT.md` — Master report
- `testing/VERIFICATION_MATRIX.md` — Verification status matrix
- `audits/FRONTEND_PAGES_AUDIT.md` — Route and `_pages` import graph
- `audits/VERSION_CONTROL_STATE.md` — Repository divergence
- `audits/GITIGNORE_AUDIT.md` — Ignore coverage
- `audits/DUPLICATE_AND_LEGACY_FINDINGS.md` — D-01…D-23
- `frontend/FRONTEND_CONTRACT.md` — HTTP/WS/type/env/auth contract
- `security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` — Unsigned session token
- `broker/BROKER_SELECTION_AND_FAILOVER.md` — Broker selection and failover
- `database/DATABASE_COLLECTION_CATALOG.md` — Collection and index audit
