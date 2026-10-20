# Market Watch UI Audit

Current implementation of the Market Watch user interface.

Companion to the engine specification `docs/engines/MARKET_WATCH.md` and the
engine audit `docs/audits/MARKET_WATCH_STATUS.md`. This file records **what the UI
actually is**, not what it should be (PROJECT_IMPLEMENTATION_RULE.md §9).

Last verified: 2026-10-07 (IST) — implementation 026.

---

## 1. Routes

### 1.1 Service phase — the full tabbed Market Watch

Only the Service phase exposes Market Watch with tabs, navigation children and
REST reads. Route shells live under `app/(services)/services/market-watch/` and
each renders the shared implementation in `app/_pages/market-watch/` with an
`initialTab`.

| Route | Shell file | `initialTab` |
|---|---|---|
| `/services/market-watch` | `page.tsx` | `overview` |
| `/services/market-watch/movers` | `movers/page.tsx` | `movers` |
| `/services/market-watch/rank` | `rank/page.tsx` | `rank` |
| `/services/market-watch/filters` | `filters/page.tsx` | `filters` |
| `/services/market-watch/pins` | `pins/page.tsx` | `pins` |
| `/services/market-watch/symbol` | `symbol/page.tsx` | `symbol` |
| `/services/market-watch/weekly` | `weekly/page.tsx` | `weekly` |
| `/services/market-watch/report` | `report/page.tsx` | `report` |

Deep links work through `?tab=` (read from `window.location`, so no Suspense
boundary is needed): `?tab=report`, `?tab=weekly`, and `?search=<SYMBOL>`.

### 1.2 Other phases — socket-only, no tabs

| Route | Renders | Nav children |
|---|---|---|
| `/trading/market-watch` | `components/market-watch/market-watch-live` + `ShoonyaTradeGate` | none |
| `/data-saver/watch` | same | none |
| `/dashboard/market-watch` | same | none |

`market-watch-live.tsx` renders only what the shared realtime socket delivers
(`market_watch.status`, `market_watch.ranking`, `market_watch.pins` and raw ticks).
It performs no REST polling and never loops. Consequence: **the weekly review and
both reports are reachable only from the Service phase.**

### 1.3 API bridge

`app/api/market-watch/[...path]/route.ts` — `revalidate = 0`,
`dynamic = 'force-dynamic'`. Forwards GET (25 s timeout), POST and DELETE to the
Python backend. On failure it returns a structured error rather than an empty 200.

---

## 2. Shared implementation — `app/_pages/market-watch/`

| File | Lines | Purpose |
|---|---|---|
| `page.tsx` | ~191 | Tab shell, tab registry, offline gate, deep links |
| `mw-shared.tsx` | ~1290 | Types, formatters, every Market Watch API client, realtime hook, lifecycle |
| `mw-table.tsx` | 348 | `MwTableShell`, `MwRowRow`, `PinBadges`, `StockStatus` |
| `overview.tsx` | 193 | Engine overview |
| `movers.tsx` | 304 | 21 ranking boards |
| `rank.tsx` | 215 | Virtualized volume & rank |
| `filters.tsx` | 381 | Filter/screener |
| `pins.tsx` | 200 | Pins |
| `symbol.tsx` | 345 | Stock detail |
| `status-bar.tsx` | 252 | Engine phase / lifecycle indicator |
| `weekly.tsx` | ~640 | Saturday review: scan, ADD/REMOVE/KEEP, lock |
| `report.tsx` | ~560 | Daily + Weekly reports |

---

## 3. Navigation

`components/layout/nav.ts` — the Services → Market group, children at lines
537–548:

| Nav id | Label | href |
|---|---|---|
| `market-watch` | Market Watch | `/services/market-watch` |
| `market-watch-overview` | Overview | `/services/market-watch` |
| `market-watch-movers` | Movers | `/services/market-watch/movers` |
| `market-watch-rank` | Volume & Rank | `/services/market-watch/rank` |
| `market-watch-filters` | Filters | `/services/market-watch/filters` |
| `market-watch-pins` | Pins | `/services/market-watch/pins` |
| `market-watch-symbol` | Stock Detail | `/services/market-watch/symbol` |
| `market-watch-weekly` | Weekly Review | `/services/market-watch/weekly` |
| `market-watch-report` | Report | `/services/market-watch/report` |

`lib/navigation/registry.ts` derives the search index and breadcrumbs from
`nav.ts` automatically — no separate registration exists or is needed.
`lib/system-engines.ts:177` maps the `market_watch` engine to
`/services/market-watch`; that mapping is engine-level, so a page needs no entry.

---

## 4. Report page (current)

`report.tsx` renders two views behind a segmented control, both read-only from
stored backend documents.

**Daily** — `GET /api/market-watch/report/daily?limit=30` then
`/report/daily/{date}`.
Header grid: date, generated, generation duration, tracked, eligible, subscribed,
with-price, validated ticks, blocked, data-quality class count.
Boards: top gainers, top decliners by price change, highest volume, most active,
circuit near, blocked (only when non-empty). Notes are listed verbatim.

**Weekly** — `GET /api/market-watch/weekly/reports?limit=26` then
`/weekly/report?weekId=`.
Summary: week, generated, days reviewed, universe size, ₹ threshold, margin
threshold. Six recommendation counters. Table of the doc §5 fields with an
ALL/ADD/REMOVE/KEEP/REVIEW filter. A standing note that the report is advisory and
that membership changes only in Weekly Review.

### 4.1 Field-name contract

Row fields come from `services/market_watch_report._row`. The backend emits
**`changePct`** and the frontend types and renders `changePct`. It previously
typed `changePercent`, which rendered a dash in every Change % cell and made the
gain/loss tone always read zero (implementation 026, P10).

### 4.2 States

| State | Behaviour |
|---|---|
| Loading | "Loading stored reports…" |
| Empty (daily) | Names that a report is generated near each close |
| Empty (weekly) | Names that the Saturday review produces it |
| Error | Amber banner, reason text; per-list failure does not hide the other view |
| Offline | The shell's `RUNTIME_INACTIVE` gate offers "Open Report" for stored reports |

---

## 5. Weekly Review page (current)

`weekly.tsx` owns the only membership-changing flow (doc §32).

Commands, all backend-owned; the UI never edits the universe locally:

| Command | Endpoint |
|---|---|
| Scan / build report | `POST /weekly/scan` |
| Seed draft from previous lock | `POST /weekly/draft` |
| Record ADD / REMOVE / KEEP | `POST /weekly/decision` |
| Lock | `POST /weekly/lock` |
| Read report | `GET /weekly/report?weekId=` |
| History | `GET /weekly/history?limit=` |

Phase is derived as: target week locked → `locked`; else a draft exists →
`review`; else `scan`.

The header states the week under review, the week the engine is running now, the
week the report describes, and the next scheduled review time. This separation is
load-bearing (implementation 026, P12): previously one heading mixed the review
target with the running lock, and the phase was keyed off the presence of any
lock, which hid every review command.

Polling: the observability strip polls every 15 s. Nothing else on this page
polls.

---

## 6. Realtime

`useMarketWatchRealtime(tokens)` in `mw-shared.tsx` — ref-counted token
subscription with a 1000 ms per-frame throttle, accepting only
`market_watch.status`, `market_watch.ranking` and `market_watch.pins`.

REST `/progress` is the source of truth; socket status frames patch into it via
`mergeStatusFrame`.

Constants: `RAW_TICK_BUDGET=120`, `POLL_INTERVAL_MS=12000`,
`RECONCILE_INTERVAL_MS=60000`, `FRESHNESS_STALE_S=3`, `FRESHNESS_PENDING_S=12`.

---

## 7. Endpoints consumed

| Endpoint | Called from |
|---|---|
| `/progress` | `mw-shared.tsx` |
| `/ui`, `/ranking`, `/pins` (+POST/DELETE) | `overview.tsx`, `pins.tsx`, `symbol.tsx`, `movers.tsx` |
| `/sections`, `/boards`, `/page`, `/search` | `movers.tsx` |
| `/rank` | `mw-shared.tsx` |
| `/config`, `/filters` (+POST/DELETE/detail/apply) | `filters.tsx` |
| `/symbol/{symbol}` | `symbol.tsx` |
| `/weekly`, `/weekly/universe`, `/weekly/report`, `/weekly/reports`, `/weekly/history`, `/weekly/scan`, `/weekly/decision`, `/weekly/draft`, `/weekly/lock` | `weekly.tsx`, `mw-shared.tsx` |
| `/observability` | `weekly.tsx` |
| `/report/daily`, `/report/daily/{date}` | `report.tsx` |
| `/weeklyReview` block inside `/observability` | consumed via `/observability` |

`lib/api.ts` is not used by these pages; its only Market Watch function is
`getMarketWatchTickSnapshot`.

---

## 8. Rule compliance observed in the UI

- Every number is rendered from a backend payload. No page recomputes a change, a
  count or a ranking (doc §24).
- A value the backend did not compute renders as `DASH`, never as zero.
- Membership changes only through the four review commands; the UI has no local
  universe editing (doc §32).
- No page calls a broker API (doc §35.20).
- Report and Weekly Review pages perform no realtime subscription — they read
  stored documents (doc §26).

---

## 9. Known defects and limitations

| # | Item | Severity | Status |
|---|---|---|---|
| D1 | `movers.tsx` subscribes up to 500 raw tokens, `rank.tsx` up to 400 | medium | open |
| D2 | `/ui` and `/sections` poll every 12 s instead of being push-driven | medium | open (pre-existing) |
| D3 | Observability strip polls every 15 s | low | open by design |
| D4 | Trading and data-saver Market Watch views have no review/report access | low | open — by design, socket-only |
| D5 | `mw-shared.tsx:1088` unused eslint-disable directive | trivial | open (pre-existing) |
| D6 | No browser-rendered verification of these pages | — | see verification 026 §Remaining Risks |

## 10. Tests

- No unit or component tests exist for any Market Watch UI file.
- Frontend checks run for these files: `npx tsc --noEmit` and `npx eslint`.
- Runtime verification of the UI is **not** covered by any automated test; see
  `docs/verification/026-market-watch-weekly-review-and-report.md`.

## 11. Verification status

| Area | Status |
|---|---|
| Routes, nav, tab registry | verified by source inspection + typecheck |
| Report page payloads | verified against live API responses |
| Weekly Review command flow | verified by live API probes |
| Rendered UI in a browser | **NOT VERIFIED** |
| Realtime delivery in a browser | **NOT VERIFIED** |
