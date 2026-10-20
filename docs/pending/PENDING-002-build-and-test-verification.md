# PENDING-002-build-and-test-verification.md

## Task ID
PENDING-002

## Date Created
2026-09-28

## Priority
**P1 — HIGH**

## Title
Frontend build, type-check, lint, and full test suite verification

## Status
`PARTIAL` (2026-10-07 evidence below; posture/coverage/audit/auth-tests still open)

> **Update 2026-10-07 — fresh evidence from the Market Watch terminal task**
> (detail: `docs/verification/028-market-watch-terminal-redesign-and-live-verification.md`).
> `npm run build` → `✓ Compiled successfully` (no route collisions; `/trading/market-watch`
> emitted). `npx tsc --noEmit` clean. `npx eslint` on touched files clean.
> `npm test` → **400 pass / 0 fail**. Backend market-watch suites →
> **387 passed** (engine/ranking/pins/filters 125 + route/weekly_universe/spec_modules 262).
> Still open per Success Criteria: version-control posture decision (step 0),
> full backend suite + coverage (only market-watch slices ran), dependency audit,
> and the R-36/37/38 auth tests.

## Source
`docs/FINAL_REPORT.md` §11, `docs/testing/TESTING_ARCHITECTURE.md`, `docs/audits/DUPLICATE_AND_LEGACY_FINDINGS.md` (D-05)

---

## Blocking Reason
No build, type-check, lint, or test has been run.

> **Update 2026-09-28 — the "duplicate URL" hypothesis is WITHDRAWN.**
> Finding D-05 claimed `/settings` and `/market-watch` were implemented at the same URL in
> several route groups and might be build-blocking. **That was wrong.** Enumeration shows
> **151 routable pages → 151 distinct route strings**, so no route collision exists.
> Evidence: `docs/audits/FRONTEND_PAGES_AUDIT.md` §2.
> `npm run build` is still worth running, but for ordinary compile/type/lint reasons.
>
> **Correction to an earlier over-claim**: an interim note in this file and in
> `VERSION_CONTROL_STATE.md` / `DUPLICATE_AND_LEGACY_FINDINGS.md` stated that `HEAD`
> "contains both `/trading` pages". **It does not.** `git ls-tree -r HEAD` lists only
> **16 routable pages**, all under `(dashboard)` plus the root, and does **not** include
> `app/(trading)/trading/page.tsx` — that file is untracked. The collision exists only in a
> *hybrid* tree (untracked `(trading)` route combined with the tracked-but-working-tree-
> deleted `(dashboard)` route). A fresh `HEAD` clone has **no** duplicate. See **D-19**,
> **R-34**.

> ### ⚠ Precondition added 2026-09-28: the application is not in version control
> Steps 1-5 all operate on a working tree that **Git does not track**: 5 commits, 141
> tracked files, **~975 untracked**, including ~98k lines of frontend and 209 `.py` files.
> A clone of this repository **cannot build, run, or reproduce this application** — so a
> "green build" here would be a property of an unreproducible tree.
> **Recommend committing the application before treating build results as meaningful.**
> Evidence: `docs/audits/VERSION_CONTROL_STATE.md`, **R-34**, **GAP-025**.
> The owner has so far chosen audit-only; no staging or commit has been made.

---

## Steps

### 0. Decide the version-control posture (gate for everything below)
```bash
git status --porcelain -uall | Measure-Object -Line   # expect ~970
git ls-tree -r HEAD --name-only | findstr /c:"app/"   # 16 routable pages
```
Then either commit the application in logical slices, or record explicitly that build
results will be **non-reproducible** and carry that caveat into the deliverable.
Docs-only alternatives: add `python-service/downloads/` (48.51 MiB of derived CSV) to
`.gitignore` first, so a later `git add -A` does not commit it (**GAP-034**).

### 1. Frontend build (P0 within this task)
```bash
cd C:\project
npm install
npm run build
```
Expect ordinary compile / type / lint failures. **No route collision is known to exist.**

If the build *does* fail on routing, capture the exact conflicting paths — that would
contradict `FRONTEND_PAGES_AUDIT.md` §2 and should be reported as a new finding.

Also worth noting while the build runs: `app\_pages\` holds **73 unreachable files**
(`FRONTEND_PAGES_AUDIT.md` §4). Expect bundler warnings about them. Do **not** delete
them as part of this task.

`tailwind.config.ts` is present and was restored from `HEAD` (closed **R-35**); a build
should not fail on missing theme tokens.

### 2. Type check
```bash
npx tsc --noEmit
```
**Note**: Check `lib/kaustubh-types.ts` against backend Pydantic models for contract drift.
The hand-written types have **no generator** and no CI check, so drift is undetectable
automatically (**GAP-033**). Four drifts were already found by reading:
`engine.status` naming, heartbeat unit, the ignored `sequence` field, and env var naming.
The WS message envelope itself was verified **correct** (D-23).

### 3. Lint
```bash
npm run lint
```

### 4. Frontend tests
```bash
npm test
```
**Note**: Confirm test framework (Vitest vs Jest) from `package.json`.

### 5. Backend tests
```bash
cd C:\project\python-service
pytest -v
pytest --cov=. --cov-report=html
```
**CRITICAL SAFETY**: Confirm tests connect to `MONGODB_TEST_URI` / `kaustubh_test`, **never** `kaustubh`. A misconfigured test run could destroy trading history and 7 years of `audit_log`.

**Expect a specific known-failing assertion**: `tests/test_engine_registry.py:301-314`
(`test_rejects_fake_shoonya_selection`) asserts Shoonya is *not implemented*, against a
capability table the adapter's own size contradicts (**R-41**). A green suite here is not
evidence the claim is true. Also note `webSocket==13.1` is load-bearing.

### 6. Dependency audit
```bash
pip-audit -r requirements.txt
npm audit
```
**Priority**: The `websockets==13.1` pin is load-bearing (uvicorn 0.30.6 imports `websockets.legacy.*`). Any upgrade must be coordinated.

### 7. Auth tests that do not exist yet (new, 2026-09-28)
No test covers the three Critical auth findings. Recommended additions, in order:
- session token is **signed** and rejected when tampered or expired (**R-36**)
- app lock **fails closed** when no PIN is configured; `direct:true` cannot bypass (**R-37**)
- `/api/realtime/token` returns a **scoped** token, never operator credentials (**R-38**)
- operator-only routes reject a forged cookie (**R-17**)

---

## Success Criteria
- [ ] Version-control posture decided and recorded
- [ ] `npm run build` succeeds (or conflicts documented)
- [ ] `tsc --noEmit` clean
- [ ] `npm run lint` clean
- [ ] Frontend tests pass with recorded counts
- [ ] Backend tests pass with recorded counts
- [ ] Shoonya capability assertion (R-41) either confirmed or the test corrected
- [ ] No critical CVEs, or documented mitigation

---

## Deliverable
Create `docs/verification/017-build-and-test-verification.md`. Update `docs/testing/VERIFICATION_MATRIX.md` and `docs/testing/TESTING_ARCHITECTURE.md`.

---

## Related
- `docs/PROJECT_GAPS.md` GAP-013, GAP-014, GAP-025, GAP-033, GAP-034
- `docs/PROJECT_RISKS.md` R-02, R-10, R-12, R-34, R-35, R-41
- `docs/audits/VERSION_CONTROL_STATE.md` — repository divergence
- `docs/audits/GITIGNORE_AUDIT.md` — `downloads/` not ignored
- `docs/frontend/FRONTEND_CONTRACT.md` — transport verified, types ungenerated
- `docs/security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` — R-36/R-37/R-38
