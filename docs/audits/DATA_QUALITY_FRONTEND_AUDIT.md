# DATA QUALITY FRONTEND AUDIT

Date: 2026-10-01
Scope: `app/(phase2)/data-saver/quality/page.tsx` (canonical, route `/data-saver/quality`),
  `lib/data-quality-client.ts` (new), `hooks/use-quality-events.ts`,
  `app/api/data-quality/[...path]/route.ts` (proxy)
Status: AUDITED — defects found, fixed, tested (020)
Related: `docs/engines/DATA_QUALITY.md`, `docs/implementation/020-data-quality-redesign.md`

## What the UI actually does (after 020)

- One canonical routable page (`/data-saver/quality`, in `next build` route
  table). The `app/_pages/data-quality/page.tsx` copy is dead legacy (73 dead
  pages per `FRONTEND_PAGES_AUDIT.md`) and is NOT the canonical implementation.
- Data flows: page → same-origin `lib/data-quality-client.ts` → Next proxy
  `app/api/data-quality/[...path]` → Python `/api/data-quality/*`. The proxy
  envelope `{ ok, ...payload }` is unwrapped; `{ ok: false }` raises a typed
  `DataQualityError` and the page keeps last-good data with a retry banner.
- Phased loading: ① summary + scan-state + scan/history (first paint),
  ② metrics + pipeline + storage + diagnostics + config (deferred 300ms),
  ③ symbols + issues (deferred 600ms, then 60s cadence), trend (own range
  control), duplicates (manual only, 24h cap).
- Realtime: single SSE fan-out via `useQualityEvents` (no second socket).
  Issues refresh on every quality event; summary phases refresh on
  `quality_scan_completed`.
- Every filter control reaches the backend query via `dqParamsForFilters`
  (hours, symbol, exchange, segment, date, time_from, time_to). Symbol search
  is debounced 500ms. Date offers Today / Yesterday / Custom (date picker);
  Session maps to window presets; the intraday time range applies only when
  its toggle is On.
- Honest states throughout: `Not measured`, `NO_DATA`, `STANDBY`, `RUNNING`,
  `CONFIGURATION UNAVAILABLE`, `NOT MEASURED` latency notes, `—` for
  unmeasured per-symbol cells. No metric is fabricated.

## Defects found and fixed (020)

| # | Location | Defect | Fix |
|---|---|---|---|
| F1 | page `params` memo | Only `hours` + `symbol` passed; Session/Date/Exchange/Segment/Time-Range controls were decorative | Full `dqParamsForFilters` mapping; backend honors the slice |
| F2 | page `stockFilter` | Every keystroke fired the full 7-endpoint refresh | Debounced 500ms (`stockInput` → `stockFilter`) |
| F3 | page `refreshNow` | 7 heavy aggregations fired in parallel on mount and every 30s poll | Split into phase 1/2/3 with deferred timers |
| F4 | page initial effect | Mount fired summary + trend + symbols + issues + config simultaneously | Staggered: phase 1 now, symbols/issues +600ms, trend on range change, config once |
| F5 | page realtime effect | Scan completion refreshed issues only; header stayed stale | `quality_scan_completed` refreshes phase 1 + 2 |
| F6 | page duplicates | Automatic 720h duplicate sweep on every page load | Lazy: manual Refresh only (24h cap), throttled refresh after scans only if already requested |
| F7 | page transport | `lib/api.ts#getDataQuality` hit the backend loopback directly (CORS preflight per read, pool contention with SSE) | Same-origin `lib/data-quality-client.ts` via the Next proxy |
| F8 | page `SymbolRow` | `outOfOrder`/`invalid`/`missing` typed as `number`, rendering backend `0` as fact | Nullable types; `null` renders `—` |
| F9 | page header | Control cluster could overflow at 375px | `flex-wrap` + `overflow-x-clip` |
| F10 | `dimensionDefinition` | Uniqueness described the wrong identity (`symbol, ts`) | Corrected to `token + ts + ltp + volume + bp/sp` |
| F11 | duplicate `useQualityEvents` | A second hook call would have opened a second SSE stream | Merged into the single existing subscription |

## Deliberately not changed

- `app/_pages/data-quality/page.tsx` (dead legacy) left untouched — deletion
  is a separate dead-code decision, not part of this task.
- SSE still connects to the backend event stream directly (`getScheduleEventsUrl`);
  EventSource cannot use the POST-capable proxy shape without a new GET proxy,
  and the existing stream already carries a 15s heartbeat + reconnect.
- Trend chart stays a lightweight inline SVG (no recharts) — the page already
  code-splits heavier chunks elsewhere and the trend is a simple series.

## Tests

- `tests/data-quality-client.test.ts` — 6 tests (filter mapping, empty/ALL
  omission, symbol normalization, envelope unwrap, typed error, same-origin URL).
- `tsc --noEmit` clean; `eslint` on changed files: 0 errors (13 pre-existing
  unused-var warnings); `next build` clean with exactly one `/data-saver/quality` route.
- Full frontend suite: 364/365 (1 pre-existing unrelated failure,
  `topbar-status.test.ts:331`, also failing on 016/017).
