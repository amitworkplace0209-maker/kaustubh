# FRONTEND_PAGES_AUDIT.md

## Route and page liveness — code-derived

**Created**: 2026-09-28
**Method**: static filesystem + import-graph analysis. **No build was run.**
**Status**: `STATIC_VERIFIED` for file counts and import reachability.
`NOT_VERIFIED`: whether the project actually builds (no `npm run build`).

> **This audit overturns two earlier findings from this bootstrap. Both were wrong.**
> See §6.

---

## 1. Page counts — corrected

| Metric | Count | Note |
|--------|-------|------|
| **Total `page.tsx` under `app\`** | **189** | ~~166 — that figure was wrong~~ |
| Inside `app\_pages\` (non-routable) | 38 | Next.js private folder |
| **Routable pages** | **151** | |
| **Distinct route strings** | **151** | equals the routable page count |
| **Total `.tsx` under `app\_pages\`** | **74** | 38 `page.tsx` + 36 sub-components + 2 `.ts` |
| Directories under `app\_pages\` | 40 | |

Reconciliation: 151 routable + 38 `_pages` = **189** `page.tsx`, consistent.

> ### ⚠ These are WORKING-TREE counts. HEAD contains only 16 routable pages.
>
> All 151 pages describe **this working tree**, which is almost entirely uncommitted:
> 134 of them are untracked, and `git HEAD` holds only 16 pages (15 under `(dashboard)`
> plus `app/page.tsx`).
> A fresh `git clone` does **not** reproduce this application.
> See `docs/audits/VERSION_CONTROL_STATE.md` (**R-34**).
>
> **Correction (2026-09-28)**: an earlier revision of this note claimed "HEAD contains a
> real duplicate route — both `app/(dashboard)/trading/page.tsx` and
> `app/(trading)/trading/page.tsx` resolve to `/trading`." **That is false and is
> withdrawn.** `app/(trading)/trading/page.tsx` is **untracked** and is not in `HEAD`, so
> a fresh clone has **no** duplicate. The collision would only appear if the untracked
> `(trading)` page were committed *without* the working-tree deletion of the
> `(dashboard)` page. That is a hazard for the future commit, not a present build error.

---

## 2. ⚠ There are NO duplicate routes — earlier "build-blocking" claim is REFUTED

151 routable pages produce **151 distinct route strings**. A route string appearing more
than once would be a Next.js build error. **None does.**

### What the earlier finding got wrong
The first pass reported `/settings` in 4 route groups and `/market-watch` in 3 locations,
and flagged them as possible build-blocking collisions. Those were **different paths** that
share a leaf name:

| Leaf name | Actual distinct paths |
|-----------|----------------------|
| `settings` | `/settings` · `/trading/settings` · `/services/settings` · `/ai/settings` · `/data-saver/settings` · `/data-saver/settings/{about,accessibility,app-lock,biometric,privacy,pwa,security,storage,theme}` |
| `market-watch` | `/market-watch` · `/trading/market-watch` · `/services/market-watch` · `/data-saver/watch` |
| `orders` | `/orders` · `/trading/orders` · `/trading/basket-orders` · `/services/order-engine/orders` |
| `notifications` | `/notifications` · `/trading/notifications` · `/services/notifications` · `/data-saver/alerts` · `/data-saver/notifications` |
| `positions` | `/positions` · `/trading/positions` |
| `system` | `/system` · `/services/system` · `/services/system-indicators` |
| `funds`, `holdings`, `portfolio`, `order-history` | each exists at both a flat path and under `/trading` |

Every one of these is a **distinct URL**. Next.js route groups `(dashboard)`, `(services)`,
`(trading)`, `(phase2)`, `(ai)` do not create URL segments, and no two pages resolve to the
same string.

**Consequence**: finding **D-05** and risk **R-15** ("may be build-blocking") should be
withdrawn. `PENDING-002` should no longer treat this as the primary build risk.

---

## 3. `next.config.js` redirect table — intentional, mostly inert

`next.config.js` defines a `redirects()` table with ~40 entries, mapping the **old flat
paths to the new grouped paths**:

```
/orders        → /trading/orders
/positions     → /trading/positions
/settings      → /trading/settings
/market-watch  → /trading/market-watch
/system        → /services/system
/logs          → /services/logs
/phase2/*      → /data-saver/*
/data/*        → /data-saver/*
/              → /login
/workspace     → /login
```

This is evidence of a deliberate, completed **flat-route → route-group migration**.

**Important subtlety**: for paths where a real page still exists at the source
(`/orders`, `/positions`, `/settings`, `/market-watch`, `/funds`, `/holdings`,
`/portfolio`, `/order-history`, `/notifications`, `/system`, `/stocks`, `/live-ticks`,
`/downloads`, `/logs`, `/calculator`, …), **the redirect never fires** — in Next.js a
matching filesystem route takes precedence over a `redirects()` entry. So roughly half the
table is dead configuration, and the flat URLs are served by `(dashboard)/…` pages rather
than redirecting to `/trading/…`.

**Not a defect** — but it means the redirect table is misleading as documentation, and any
redundancy will only surface if a flat page is ever removed. Flagged for the frontend
owner; **no change recommended without a decision**.

---

## 4. `app/_pages/` liveness — 73 of 74 source files are unreachable

`app\_pages\` is a Next.js **private folder** (leading underscore): the router never
generates routes for it. Files inside are importable as modules only.

### Composition (measured 2026-09-28)

| Item | Count |
|---|---|
| **Total files** | **78** |
| `.tsx` | 74 |
| `.ts` | 2 |
| `page.tsx` (of the `.tsx`) | **38** |
| non-`page.tsx` sub-components | 36 |
| top-level directories | **36** (39 including nested) |
| stray `*.before-*-fix` backups | 2 |

> Earlier revisions of this document said "74 files, 40 directories". **74 was the
> `.tsx` count**, not the file count, and 40 over-counted the directories. Both are
> corrected above. The reachability figures (1 live, 73 dead) are unaffected — they
> describe the 74 `.tsx` modules.
>
> **New minor hygiene finding**: two leftover manual backup files sit in the source tree —
> `app\_pages\*.before-select-fix` and `*.before-auto-select-fix`. They are not `.tsx`, so
> they are neither imported nor bundled, but they are committed-adjacent clutter inside
> `app\`. Worth deleting or moving to a scratch location. Not changed here.

### Import graph

**Entry point from the live app — exactly one:**
```
app/(dashboard)/dashboard.tsx:13
    import DashboardPage from '@/app/_pages/dashboard/page';
```

`_pages/dashboard/page.tsx` imports only `react`, `next/link`, `@/components/*` and
`@/lib/*` — **no sibling `_pages` imports**.

**Intra-`_pages` imports exist but form a closed cluster** (all consumers are themselves
unreachable):

| Imported helper | Imported by (all inside `_pages`) |
|-----------------|-----------------------------------|
| `_pages/connection-manager/connection-manager-data` | `configuration`, `connections`, `events`, `page` |
| `_pages/scheduler/scheduler-data` | `ledger`, `page`, `runs`, `timeline` |
| `_pages/session-manager/sm-shared` | 13 session-manager files |
| `_pages/market-watch/mw-shared` | `page` |

### Reachability verdict

| Classification | Count | Detail |
|----------------|-------|--------|
| **LIVE** | **1** | `_pages/dashboard/page.tsx` |
| **DEAD** | **73** | every other file under `app\_pages\` |
| SHADOWED | 0 | no `_pages` file shares a name with a routed page in a way that causes ambiguity — the folder prefix disambiguates |

Largest dead clusters: `session-manager` (15 files), `market-watch` (10),
`scheduler` (5), `connection-manager` (4), `order-engine` (4).

**Interpretation**: `_pages` is the **pre-migration snapshot** of the flat routes, retained
after the move into route groups. One file (`dashboard`) was deliberately re-wired during
the migration; the rest were left behind.

**Not dead**: the 36 non-`page` `.tsx` files are shared sub-components
(`sm-shared`, `mw-shared`, `mw-table`, `status-bar`, `connection-manager-data`,
`scheduler-data`, …) used by the dead pages — so they are dead *transitively*, but they
document intended component structure and should not be pruned blindly.

### Recommendation
**Do not delete.** Deletion is a code change requiring explicit approval, and the shared
sub-components may encode intent the migrated pages did not carry over. Recommended
sequence, in order:
1. Confirm the frontend builds and the 151 routes render (PENDING-002).
2. Ask the owner whether the pre-migration snapshot is wanted as history.
3. If retained, add a `README` in `app\_pages\` explaining it is non-routable and why
   `dashboard` is the one live import. This is a **documentation-only** fix and is the
   low-risk first step.

---

## 5. Route groups (confirmed)

| Group | Prefix in URL | Routable pages |
|-------|---------------|----------------|
| `(dashboard)` | none | 12 |
| `(trading)` | none | 24 |
| `(services)` | none | 45 |
| `(phase2)` | none | 39 |
| `(ai)` | none | 13 |
| *(none — root)* | none | 18 (`/login`, `/`, `/trading`, `/services`, `/data-saver` and subpaths) |

Group segments contribute **nothing** to the URL, as expected.

---

## 6. Corrections to this bootstrap's earlier work

| Earlier claim | Reality | Where corrected |
|---------------|---------|-----------------|
| 166 `page.tsx` files | **189** | §1 |
| 41 files under `app\_pages\` | **74** (38 `page.tsx`) | §1 |
| `/settings` in 4 route groups → build-blocking | **No duplicate routes exist** | §2 |
| `/market-watch` in 3 locations → build-blocking | 4 distinct paths, no collision | §2 |
| 35 frontend pages (`00_ARCHITECTURE_INDEX.md`) | **151** routable | §1 |
| "30+ frontend pages" (`35_AI_AGENT_CONTEXT.md`) | **151** routable, 189 total | §1 |

The "166" and "41" figures were counting errors made before the route-group and private-
folder structure had been properly accounted for. The 151/189/74 figures above were produced
by explicit enumeration with the route groups stripped and are reproducible.

**To close**: D-05 withdrawn; `PENDING-002` reprioritised; `docs/frontend/FRONTEND_ROUTE_MAP.md`
counts corrected.

---

## 7. Build-blocking issues found (revised)

Because §2 withdrew the original duplicate-URL hypothesis, the remaining build risks were
re-checked against git. Two **real** ones surfaced:

| Issue | Status | Detection |
|-------|--------|-----------|
| `/trading` resolved by two files in **HEAD** | **Fixed in working tree** by deleting `(dashboard)/trading/page.tsx` | only visible via `git ls-tree` |
| **`tailwind.config.ts` missing** → no colour palette, no `darkMode`, no `tailwindcss-animate` | **OPEN — unfixed** | `Test-Path` + `git show HEAD:` |

`npm run build` would likely **pass** the first (it is already fixed) and would **not catch**
the second — `tsc` and ESLint both ignore Tailwind configuration. The UI would simply render
unstyled. Details: `VERSION_CONTROL_STATE.md` §3.3, **R-35**.

**All page counts in this document remain `NOT_VERIFIED` for renderability** — no build,
no dev server, no browser session.

---
*Static analysis only. No build, no dev server, no browser.*
