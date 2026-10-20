# PENDING-003-static-code-audit.md

## Task ID
PENDING-003

## Date Created
2026-09-28

## Priority
**P1 — HIGH**

## Title
Close static-analysis gaps: read unread modules, build import graph, reconcile doc conflicts

## Status
`PENDING`

## Source
`docs/PROJECT_GAPS.md`, `docs/audits/DUPLICATE_AND_LEGACY_FINDINGS.md`

---

## Blocking Reason
These items can be resolved **without a running system** — they only require reading source. They were out of scope for the initial discovery pass.

---

## Tasks

### 0. Reconcile documentation authority (P0 — do this first)
`docs/architecture/` contains **two parallel document sets** (see `DUPLICATE_AND_LEGACY_FINDINGS.md` D-11):
- 36 numbered files `00_ARCHITECTURE_INDEX.md` … `35_AI_AGENT_CONTEXT.md`
- 19 unnumbered files, several subject-identical to numbered ones

**Read first** (unread, high priority, may already answer open questions):
- `C:\project\docs\architecture\00_ARCHITECTURE_INDEX.md` — intended authority order
- `C:\project\docs\architecture\31_CURRENT_VS_TARGET.md` — current vs target state
- `C:\project\docs\architecture\32_ARCHITECTURE_GAPS.md` — **may already document the gaps this bootstrap rediscovered**
- `C:\project\docs\architecture\34_DEVELOPER_ONBOARDING.md` — **may supersede `PROJECT_MAP.md`**
- `C:\project\docs\architecture\35_AI_AGENT_CONTEXT.md` — **may supersede `FINAL_REPORT.md`**

**Then decide**: which set is canonical. Either deprecate the unnumbered set with a header pointer, or fold the numbered set into the unnumbered naming. Also reconcile the new catalogs against numbered peers:

| New file | Overlaps with |
|-----------|---------------|
| `docs/api/API_CATALOG.md` | `28_API_ARCHITECTURE.md` |
| `docs/config/CONFIGURATION_CATALOG.md` | `18_CONFIGURATION_ARCHITECTURE.md` |
| `docs/security/SECURITY_ARCHITECTURE.md` | `25_SECURITY_ARCHITECTURE.md` |
| `docs/observability/OBSERVABILITY_ARCHITECTURE.md` | `27_OBSERVABILITY_ARCHITECTURE.md` |
| `docs/architecture/FAILURE_AND_RECOVERY.md` | `26_ERROR_RECOVERY_ARCHITECTURE.md` |
| `docs/frontend/FRONTEND_ARCHITECTURE.md` | `19_UI_ARCHITECTURE.md` |
| `docs/runtime/SCHEDULER_AND_LIFECYCLE.md` | `04_STARTUP_SHUTDOWN_LIFECYCLE.md`, `05_RUNTIME_LIFECYCLE.md` |

**Output**: A `docs/DOCUMENTATION_AUTHORITY.md` declaring the canonical document for each topic, or a deprecation header added to the non-canonical set.

### 1. Frontend contract layer (P1)
Read and document:
- `C:\project\lib\kaustubh-types.ts` — the frontend/backend contract
- `C:\project\lib\backend.ts` — REST client behavior, error handling
- `C:\project\lib\realtime-ws.ts` — WS#3/WS#4 client, reconnect, gap recovery
- `C:\project\lib\engine-realtime.ts`

**Output**: `docs/frontend/FRONTEND_CONTRACT.md` — document every type and endpoint binding; flag drift against backend Pydantic models.
### 2. Import graph for `app/_pages/` (P1) — ✅ DONE
~~41 page files in a non-routable private folder.~~ **The count was wrong.** `app\_pages\`
holds **78 files across 36 top-level directories** — 74 `.tsx` (of which **38** are `page.tsx`), 2 `.ts`, and 2 stray `*.before-*-fix` backup files.
```powershell
Get-ChildItem -Recurse -Directory "C:\project\app\_pages" | ForEach-Object {
  $n = $_.Name
  $hits = Select-String -Path "C:\project\app\**\*.tsx","C:\project\components\**\*.tsx","C:\project\lib\**\*.ts" -Pattern "_pages[\\/]$n" -ErrorAction SilentlyContinue
  "{0}: {1} import(s)" -f $n, $hits.Count
}
```
**Result**: exactly **1 ACTIVE** — `app\_pages\dashboard\page`, imported by
`app\(dashboard)\dashboard.tsx:13`. The other **73 are DEAD**. Four intra-`_pages`
directories (`connection-manager-data`, `scheduler-data`, `sm-shared`, `mw-shared`) form a
closed cluster whose only consumers are themselves dead. **No file is SHADOWED** — the
151 routable pages produce 151 distinct route strings.
**Output**: `docs/audits/FRONTEND_PAGES_AUDIT.md` §4. **Nothing deleted.**

### 3. Broker failover logic (P1) — ✅ DONE
- `C:\project\python-service\brokers\manager.py` — **existence CONFIRMED** (4,516 B, 132 lines)
- `C:\project\python-service\brokers\broker_registry.py` ✅ confirmed (8,993 B, 258 lines)

**Question**: Does automatic Kotak → Shoonya → Dummy failover exist as
`06_BROKER_ARCHITECTURE.md` / `BROKER_SELECTION_FLOW.md` claim?

**Result: NO. There is no failover at all.** No health check, failure detection, retry,
circuit breaker, or automatic switch exists. `get_trading_status()` / `get_market_data_status()`
compute an honest state and **nothing consumes it**; the only caller of the switch is the
**unauthenticated** engine-control endpoint. Four further defects surfaced:

| # | Finding | Risk |
|---|---------|------|
| B-1 | No failover anywhere; manual-only switch via an open endpoint | R-39 |
| B-2 | Two independent selection systems (`manager.active_terminal()` vs `registry.get/set_trading_broker()`) that never reconcile; registry resets on restart | R-40 |
| B-3 | Shoonya declared all-capabilities-`False` despite a 448-line / 34-def / 16-of-18-protocol adapter; `tests/test_engine_registry.py:301-314` **enforces** the claim | R-41 |
| B-4 | `get_market_data_status()` always reads the global `ws_manager`, so `dummy` reports the real broker's live state | R-42 |

**Output**: `docs/broker/BROKER_SELECTION_AND_FAILOVER.md` (`DOCUMENTATION_CODE_CONFLICT`,
marked as resolved — the gap became a set of defects). `BROKER_INTEGRATION_MAP.md` updated.

> **Note**: `32_ARCHITECTURE_GAPS.md` and `34_DEVELOPER_ONBOARDING.md` reference a
> `python -m kaushub.*` CLI for engine management. **That package does not exist.**
> Engine lifecycle is instead driven over HTTP through `api\engine_control.py`.
> See `docs/DOCUMENTATION_AUTHORITY.md` §5 and finding D-13. The endpoint map is already
> written — `docs/ENGINE_CONTROL_API.md` §2 (also referenced by `PENDING-001`).

### 4. Database migrations and indexes (P1) — ✅ DONE
Read `C:\project\python-service\database\migrations.py` and `connection.py`.
**Result**:
- **Collection names**: **19 `session_manager_*` collections**, not the 11 named in
  `17_DATABASE_ARCHITECTURE.md` — a `DOCUMENTATION_CODE_CONFLICT` (D-20).
- **Indexes**: catalogued in `docs/database/DATABASE_COLLECTION_CATALOG.md` —
  18 unique on `instruments`, 6 on `events`, 1 owner on `revisions`.
- **No TTL**: expiry is application-managed (`expires_at` + `expiry_type`).
- **Migration strategy**: a **custom forward-only ledger** in `schema_migrations`
  (**not** Alembic). Idempotent via the ledger; **no rollback path**; startup does
  **not** use `dry_run`; the lock is released fire-and-forget with a **60-second** stale
  window (cross-worker lock, which implies a multi-worker deployment).
- **Correction**: the repair path **reassigns** `event_id` on duplicates and **preserves
  all records** — it does **not** delete the remainder. An earlier claim to that effect
  was wrong and is now fixed.
- **Still unverified**: effective database name (the `kaustubh_trading` claim), live
  indexes, migration state, document counts. → `PENDING-001` step 6.

### 5. Engine registry — RESOLVED IN PART (P1 remaining work)
The registration count is now **derived from code = 17** (14 native + 3 facade); see
`docs/DOCUMENTATION_AUTHORITY.md` §4 and the correction notice at the top of
`docs/engines/ENGINE_INVENTORY.md`. The 15-engine claim in the architecture set is wrong.

**Still to do**:
- ~~Enumerate the `engine_control` HTTP API~~ — done, `docs/ENGINE_CONTROL_API.md`.
- Decide the status of the **6 implemented-but-unregistered** engines in
  `python-service\core\engines\`: `risk_engine`, `target_engine`, `pnl_engine`,
  `basket_engine`, and the core versions of `order_engine` / `position_engine`. Dead code,
  or a registration gap? **Requires a human decision — do not change code.**
- Determine why `margin_engine` and `squareoff_engine` are registered but omitted from the
  auto-start list (`app.py:629`). Intentional?

### 6. Engine dependency graph reconciliation (P2)
Compare `docs/architecture/03_ENGINE_DEPENDENCY_GRAPH.md` against actual imports in
`core/engines/*.py` and `services/*.py`.

**Known conflicts**: `margin_engine` (doc omits `session_manager`, `connection_manager`),
`market_coach` (doc says `feature_engine`, code suggests `instrument_cache` +
`watchlist_engine`).

### 7. Connection Manager flow doc (P3) — ✅ DONE
`C:\project\docs\architecture\WebSocket_ConnectionManager_Flow.md` has been **read**
(1151 lines). It is the canonical 4-WS reference and is the most detailed WS document in
the repository. Key result: the 4 WebSockets are **logical channels multiplexed over a
single FastAPI route** `/ws/realtime` (`api\ws_gateway.py:278` — the only
`@router.websocket` decorator in the backend). See `docs/DOCUMENTATION_AUTHORITY.md` §3.
**Remaining**: read `08_WEBSOCKET_ARCHITECTURE.md` alongside it and reconcile the
banner/body WS-model contradiction (finding D-14).

> **Refinement 2026-09-28 (D-23)**: the banner/body contradiction is a **documentation**
> problem, **not a code defect**. Statically verified as **correct**: the internal
> `engine_snapshot` **does** map to wire type `engine.status` (channel `engines`, payload
> under `data`), and `welcome.heartbeatIntervalS` is present in seconds. Both earlier
> "missing" claims were **false positives** from grepping the wrong side of the boundary.
> Do not re-raise them.

### 8. Backend audit records (P2)
`docs/audits/backend/` is empty. Produce per-engine audit files:
```
docs/audits/backend/001-feature-engine.md
docs/audits/backend/002-search-engine.md
... (one per engine)
```
Per `PROJECT_IMPLEMENTATION_RULE.md`, backend audits document **what currently does**, not what should.

### 9. Frontend audit records (P2)
`docs/audits/frontend/` is empty. Produce per-area audits of what the UI actually renders.

### 10. Version control and ignore audit (P1) — ✅ DONE *(new, 2026-09-28)*
```powershell
git log --oneline; git ls-tree -r HEAD --name-only | Measure-Object -Line
git status --porcelain -uall | Measure-Object -Line
```
**Result**: **5 commits, 141 tracked files, ~975 untracked** — including ~98k lines of
frontend across ~530 `.ts`/`.tsx` and 209 `.py` files. Routable pages: **16 in `HEAD` vs
151 in the working tree**. A fresh clone cannot reproduce this application (**R-34**,
**GAP-025**). `.gitignore` audit confirms secrets are correctly ignored; the one real gap
is `python-service/downloads/` (48.51 MiB of derived CSV, **GAP-034**). `tailwind.config.ts`
was deleted in the working tree, **restored from `HEAD`** with approval, and re-verified
(**R-35** closed).
**Correction**: an earlier interim claim that `HEAD` "contains both `/trading` pages" is
**false** — `HEAD` has 16 routable pages and does not include the untracked
`app/(trading)/trading/page.tsx`. The collision is hybrid-only.
**Output**: `docs/audits/VERSION_CONTROL_STATE.md`, `docs/audits/GITIGNORE_AUDIT.md`.

---

## Success Criteria
- [x] `lib/` contract layer documented — `docs/frontend/FRONTEND_CONTRACT.md`
- [x] All `_pages` files classified (1 live, 73 dead, 0 shadowed)
- [x] Broker failover **refuted** (→ R-39…R-42)
- [x] Actual collections and index definitions recorded
- [x] Engine registry count reconciled (17)
- [ ] Dependency graph matches code (task 6, open)
- [x] `WebSocket_ConnectionManager_Flow.md` read and cross-referenced
- [ ] Backend and frontend per-area audit records created (tasks 8–9, open)
- [x] Version control and `.gitignore` audited (task 10)

---

## Deliverable
New documents under `docs/audits/`, `docs/frontend/`, `docs/broker/`, plus updates to `docs/engines/ENGINE_INVENTORY.md`, `docs/architecture/03_ENGINE_DEPENDENCY_GRAPH.md`, `docs/database/`, and `docs/testing/VERIFICATION_MATRIX.md`. Update `docs/PROJECT_CHANGE_HISTORY.md`.

---

## Related
- `docs/PROJECT_GAPS.md` GAP-004, GAP-005, GAP-008, GAP-009, GAP-015, GAP-016, GAP-017, GAP-025, GAP-033, GAP-034
- `docs/PROJECT_RISKS.md` R-34…R-42
- `docs/audits/DUPLICATE_AND_LEGACY_FINDINGS.md` D-02, D-04, D-05, D-19…D-23
- `docs/audits/FRONTEND_PAGES_AUDIT.md`, `VERSION_CONTROL_STATE.md`, `GITIGNORE_AUDIT.md`
- `docs/frontend/FRONTEND_CONTRACT.md`
- `docs/broker/BROKER_SELECTION_AND_FAILOVER.md`
- `docs/database/DATABASE_COLLECTION_CATALOG.md`
