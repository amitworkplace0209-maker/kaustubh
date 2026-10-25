# TESTING_ARCHITECTURE.md

## KAUSTUBH Trading Platform - Testing Architecture

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Verification**: Test files enumerated. **No tests were executed. All results `NOT_VERIFIED`.**

---

## Test Locations

| Location | Type | Count (approx) | Status |
|----------|------|----------------|--------|
| `python-service/tests/` | Python (pytest) | ~50 files | Not run |
| `tests/` (root) | TypeScript/Node | present | Not run |
| `python-service/.venv/` | Virtualenv | — | Excluded from scan |

**Note**: `python-service/.venv` contains a large number of files from installed packages. These are third-party tests, NOT project tests, and were excluded from analysis.

---

## Python Test Suite

**Location**: `python-service/tests/`
**Framework**: pytest (implied by structure; `pytest.ini`/`pyproject.toml` config `NOT_VERIFIED`)

**Probable coverage areas** (inferred from directory structure):
- Engine lifecycle tests
- Session Manager tests
- Subscription Registry tests
- WebSocket Engine tests
- Broker adapter tests (likely mocked)
- Database tests (likely require `MONGODB_TEST_URI`)
- Scheduler tests (likely time-mocked)
- Data quality tests
- Export/download tests

**Verification status**: `NOT_VERIFIED`. No test run, no coverage measurement, no pass/fail data.

### Recommended Commands
```bash
cd python-service
pytest -v                      # run all
pytest --cov=. --cov-report=html   # with coverage
pytest -m integration         # integration subset (if markers exist)
```

---

## Frontend Test Suite

**Location**: `tests/` (root)
**Framework**: `NOT_VERIFIED` — check `package.json` scripts and devDependencies.

**Probable tooling**: Vitest or Jest (React 19 + Next 16 typically uses Vitest).

**Verification status**: `NOT_VERIFIED`.

### Recommended Commands
```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

---

## Test Data & Fixtures

**UNKNOWN**: No fixture directory, factory, or seed data was identified.

**Concern**: Broker SDK calls (`kotakneoapi`, `NorenRestApiOAuth`) require live credentials. Tests must either mock these or run against `broker_mode=dummy`.

**Recommended**: A `conftest.py` with broker mocks and a MongoDB fixture using `MONGODB_TEST_URI` / `MONGODB_TEST_DATABASE`.

---

## Test Coverage Gaps (Static Inference)

| Area | Test Evidence | Risk |
|------|---------------|------|
| Broker adapters | `NOT_VERIFIED` | High — order path is money-critical |
| Order Engine state machine | `NOT_VERIFIED` | Critical |
| Risk Engine pre-trade checks | `NOT_VERIFIED` | Critical |
| WebSocket reconnect | `NOT_VERIFIED` | High |
| Scheduler phase transitions | `NOT_VERIFIED` | High |
| Secret redaction in API responses | **No test identified** | **Critical** |
| Route shadowing | **No test identified** | Medium — **disconfirmed** statically; `/api/services/engines/broker/status` cannot collide with `/{engine_id}` (D-01) |
| MongoDB index correctness | Definitions `VERIFIED`; live indexes `NOT_VERIFIED` | Medium |
| TTL behavior | `NOT_VERIFIED` — **no TTL exists**; expiry is application-managed | Low |
| Frontend component tests | `NOT_VERIFIED` | Medium |
| Frontend type safety | `NOT_VERIFIED` | High |
| **Session-token forgery / expiry** | **No test identified** | **Critical** — unsigned, no `expires` field (**R-36**) |
| **App-lock fail-closed behavior** | **No test identified** | **Critical** — `!appLock` grants operator access (**R-37**) |
| **Operator-JWT scoping** | **No test identified** | **High** — backend operator JWT returned to browser (**R-38**) |
| **Broker failover** | **No test — no failover exists** | **High** — nothing to test; design task (**R-39**) |
| **Broker selection consistency** | **No test identified** | **High** — two systems, no reconciliation (**R-40**) |
| **Shoonya capability table** | **Test asserts the *claim*, not reality** | **Medium** — `test_rejects_fake_shoonya_selection` locks in an unverified table (**R-41**) |
| **Migration rollback / dry-run** | **No test identified** | Medium — forward-only, no rollback path |
| **WS `sequence` handling** | **No test identified** | Low — client ignores the field |
| **Doc-vs-code count drift** | **No mechanism at all** | **High** — engines (15 vs 17), pages (174 vs 189), collections (11 vs 19) all disagreed |

### Tests that assert something unverified

A pattern worth flagging: `tests/test_engine_registry.py:301-314` verifies that Shoonya is
rejected as *not implemented* — against a capability table that the adapter's own size
contradicts. **A passing suite is not evidence the code is correct**; here it is evidence
of an untested assumption. Same shape as `_pages` reachability and the 4-WS banners:
the suite was green and the claims were wrong.

### The gating problem

Every gate in the recommended pipeline below is currently **unrunnable or meaningless**:

- `npm run build` / `tsc --noEmit` / `pytest` require an application that **Git does not
  track** (5 commits, ~975 untracked files — **R-34**)
- The tests that do exist are **not wired to any CI**, so nothing runs them
- The auth tests that matter most **do not exist** (R-36/R-37/R-38)

**So the first real testing milestone is not "get tests passing" — it is "commit the
application, then add auth tests for the three Critical findings."**

---

## CI/CD

**Status**: `UNKNOWN`. No `.github/workflows/`, `azure-pipelines.yml`, `.gitlab-ci.yml`, or `Jenkinsfile` was identified in the root scan.

**Impact**: No automated quality gate. Regressions can reach production undetected.
With ~~975 untracked files, there is also **no CI-visible definition of what the
application is** — the pipeline could not be configured correctly even if one existed.

**Recommended pipeline** (in dependency order — the first two are preconditions):
```
0. assert repo completeness   → untracked-file count is 0
1. lint (eslint)             → must pass
2. typecheck (tsc)           → must pass
3. pytest                    → must pass
4. npm test                  → must pass
5. pip-audit / npm audit     → no high/critical
6. secret scan               → no secrets committed
7. openapi diff              → committed spec matches routes
8. codegen check             → TS types match backend schemas
```
Steps 7–8 are the durable fix for the drift that produced most findings in this audit
(GAP-003, GAP-033, GAP-035). Step 0 is not ceremony: without it, steps 1–4 can be
"passing" against a tree nobody can reconstruct.

---

## Verification Matrix

See `VERIFICATION_MATRIX.md` for the full static-vs-runtime verification status.

---

## Test Data Safety

**Rule**: Tests must NEVER connect to the live `kaustubh` database. Always use `MONGODB_TEST_URI` / `MONGODB_TEST_DATABASE` (`kaustubh_test`).

**Risk**: A misconfigured test run against the production database would destroy trading history and 7 years of `audit_log`.

---

## Related Documents
- `VERIFICATION_MATRIX.md` — What is verified vs not (62 items)
- `../PROJECT_GAPS.md` — GAP-014 (test results unknown), GAP-025 (repo incomplete), GAP-035 (no machine-checkable truth)
- `../PROJECT_RISKS.md` — R-10 (no CI), R-34…R-42
- `../FINAL_REPORT.md` — Coverage summary
- `../security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` — the three untested Critical auth findings
- `../broker/BROKER_SELECTION_AND_FAILOVER.md` — failover and selection defects
- `../frontend/FRONTEND_CONTRACT.md` — transport contract (verified correct) and type-drift risk
