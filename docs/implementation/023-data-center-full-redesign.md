# 023 — Data Center Full Redesign (0-to-1, real canonical data only)

- **Task:** Redesign the Data Center page from zero around real database, storage,
  tick-persistence, pipeline, history, telemetry and cleanup data. Remove the
  Runtime/Session bulk, repetitive engine cards and internal diagnostics from the
  main view; keep and redesign only `ATLAS DAILY CLEANUP — 06:00 IST`,
  `API TELEMETRY (24H)` and `STORAGE ENGINE — LIVE INFRASTRUCTURE` as special
  sections. No fake, sample, dummy or inferred data.
- **Status:** `IMPLEMENTED_PENDING_VERIFICATION` — the page is rebuilt, the full
  frontend typecheck, ESLint and `next build` pass, and the real backend
  contracts were read before mapping. Browser-level, live-backend and responsive
  verification are **not** yet performed in this session; see §9.
- **Serial predecessor:** `docs/implementation/022-data-center-realtime-snapshot-push-and-page-redesign.md`
- **Direct predecessor (Data Center):** `docs/implementation/022-data-center-realtime-snapshot-push-and-page-redesign.md`
- **Date:** 2026-10-02
- **Agent:** OpenCode

---

## 1. Task

The `/data-saver/data-center` page presented a large, low-signal surface: a big
Runtime/Session block, repetitive per-engine cards, redundant connection/health
repeats and internal diagnostics sat above the handful of facts an operator
actually needs — how big the database is, how many ticks arrived, how many were
saved, how many were skipped, and how fresh the data is.

The page had to be rebuilt 0-to-1 so that the primary journey answers those
questions from real canonical telemetry, with unavailable facts stated honestly
instead of being filled in.

## 2. Objective

- Present Database, Storage, Tick Persistence, Tick Pipeline, Activity, History,
  Telemetry and Cleanup as the primary content, in that order.
- Remove Runtime/Session bulk, repetitive engine cards, redundant
  connection/health detail and internal diagnostics from the main view.
- Retain exactly three special sections: `ATLAS DAILY CLEANUP — 06:00 IST`,
  `API TELEMETRY (24H)`, `STORAGE ENGINE — LIVE INFRASTRUCTURE`.
- Show `NOT MEASURED` / `UNAVAILABLE` (or a compact em dash) — never `0`, never a
  guess — for any metric the backend did not measure.
- Keep the page read-only and responsive across 375 → 1920 px.

## 3. Scope

Frontend only:

- `app/(phase2)/data-saver/data-center/page.tsx` — rebuilt 0-to-1.
- `app/(phase2)/data-saver/data-center/loading.tsx` — skeleton realigned to the
  new section order so first paint fills in rather than re-flows.
- `lib/data-center-store.ts` — one-line change to `FETCH_SECTIONS` (see §5).

No backend, schema, route, engine, socket, worker or scheduler change.

## 4. Out of Scope

- **No backend change at all.** Every rendered value is read from the existing
  contracts, so no new telemetry was invented and no engine was touched.
- No new REST route, no schema change (`schemaVersion` stays 2), no new component
  in `components/data-center/`.
- **No tick writes, no direct MongoDB access, no second DB Writer, no second
  WebSocket.** The page remains strictly read-only.
- No tabs, no new navigation entry, no new page.
- Removal of Runtime/Session from the *main view* only — the facts are still
  reachable, collapsed, under Advanced diagnostics.

## 5. Backend contracts read before mapping

Each value was bound to a real field, read from the live contract, rather than
guessed:

| UI fact | Canonical source |
| --- | --- |
| Provider / database / host / server version / pool | `DcSnapshot.database` |
| Database storage, data size, index size, documents, collections, ping | `DcSnapshot.storage` |
| Host capacity / used / free / usage | `DcOverview.system.disk*` (Storage Engine host probe) |
| Received / saved / buffer / last flush / feed latency | `DcSnapshot.persistence` |
| Received / duplicates / invalid / accepted / written / writeFailed / pending | `DcWriter.dbWriter.dataLoss` (DB Writer reconciliation) |
| Per-source accepted + skipped | `db_writer.settings.permissions[*]` |
| Per-source ON / OFF / CAPPED | `db_writer.permissions[*]` |
| Subscribed symbols, feed/lifecycle state, stale/no-data | `DcSnapshot.marketData` |
| Intra-day tick buckets | `DcTicksPayload.points` (`ticks` section) |
| Daily written / symbols / API / scheduler / storage | `DcHistoryPayload.rows` |
| Storage growth over time | `DcTrendPayload.points` |
| Requests, success %, error rate, P50/P95/P99, slowest endpoints | `DcApiTelemetry` |
| 06:00 IST cleanup runs | `DcCleanupPayload` |

### 5.1 `FETCH_SECTIONS` change

`ticks` (the intra-day activity aggregate) was previously in the wire superset
but **not** requested, so `store.ticks` was permanently `null` and no intra-day
chart could be built from real data. It was added to `FETCH_SECTIONS`. Because it
is not in `CRITICAL_SECTIONS`, it lands in `BACKGROUND_SECTIONS` automatically and
can never gate first paint — the critical-round guarantee is unchanged.

## 6. What changed on the page

New primary journey:

1. **System** — overall state badge, unavailable-section count, build time, and a
   5-tile freshness strip (last tick / last persisted / last flush / last
   heartbeat / snapshot age).
2. **Database status + Storage totals** — provider, database, connection, server
   version, host, pool, ping, plus two explicitly separated panels:
   `HOST STORAGE` (capacity/used/free/usage) and `DATABASE STORAGE`
   (storage/data/index/documents). These are never merged into one number.
3. **Tick persistence** — Received, Saved, Skipped, Failed, Symbols, Last Flush,
   plus Current Buffer / Accepted / Duplicates / Invalid, and a source-wise table
   (`Personal — No Expiry`, `Personal — 1 Day`, `Market Watch`) with ON/OFF/CAPPED.
4. **Tick pipeline** — `Market feed → Received → Validated → Buffered →
   Persisted → MongoDB` as a real flow with per-stage state, plus feed latency,
   write errors, last tick, last write.
5. **Tick activity** — today's intra-day received-vs-persisted strip, and a daily
   history table for the selected window.
6. **Storage** — daily ticks + storage growth charts, and a collection storage
   table (documents, storage, data, indexes, health).
7. The three retained special sections.
8. **Advanced diagnostics** — collapsed by default: engine health & retention,
   market & session state, unavailable sections.

Removed from the main view: the Runtime panel, the Session panel, the redundant
Realtime/Scheduler panel repetition, and the flat per-engine card grid.

### 6.1 Honest handling of derived values

Two values are presentational arithmetic on backend-owned numbers rather than
independent measurements, and both are labelled so they cannot be mistaken for a
separate backend counter:

- **Skipped** = `duplicates + invalid` from DB Writer's reconciliation, with the
  sub-label `duplicates + invalid`.
- **Host free** = `diskTotalBytes − diskUsedBytes`.

Everything else is a direct backend field. No value is derived by querying the
database from the browser.

## 7. Design rules kept

- Responsive from 375 → 1920 px; KPI grids step `2 → 3 → 6` columns, wide tables
  scroll inside their own container (`overflow-x-clip` + `min-w-*`) so the page
  never scrolls horizontally, and the pipeline flow is a single non-wrapping row
  of stages.
- recharts stays out of the first payload: `dc-charts` is a dynamic import, and
  the intra-day activity strip is rendered with plain divs.
- Every section that the backend could not read renders its real reason via
  `Unavailable` / `SectionError`, and every panel prints its `source` and
  measurement age.
- Tones map to the contract's states (`success`/`warning`/`danger`/`neutral`); an
  unmeasured value is muted and never coloured as if it were measured.

## 8. Verification performed

| Check | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | pass (whole project) |
| `npx eslint` on changed files | pass (0 errors, 0 warnings) |
| `npx next build` | pass — `✓ Compiled successfully`, `○ /data-saver/data-center` |

Contract conformance was achieved by reading the TypeScript contract files and the
backend producers (`db_writer_engine.py` accounting + permission surface,
`data_center_planes.py` plane wiring, `data_center_snapshot.py` sections) before
writing any markup.

## 9. NOT yet verified — required before this can be called done

- Live backend run: real snapshot values observed in the browser.
- Browser pass: all sections populated with real data, refresh, realtime badge,
  window switch, cleanup card.
- Responsive pass at 375, 390, 430, 768, 1024, 1280, 1440, 1920 px with no
  horizontal scroll, overlap or clipping.
- Performance: first payload excludes recharts; measured LCP/CLS.
- PWA: installability and offline shell behaviour after the redesign.

Until those are done the correct status is `IMPLEMENTED_PENDING_VERIFICATION`, and
a verification record must be written as the next serial under
`docs/verification/`.

## 10. Known gaps to resolve in a later change

- Per-day **received / skipped / error** history is not available per day; the
  daily table shows what the aggregation really returns (written, symbols, API,
  scheduler, storage). `NOT MEASURED` is rendered rather than back-filled.
- Per-day storage **added** (delta) is not reported; storage size is shown as an
  absolute per-day figure.
- `P50/P95/P99` render only when the API telemetry service has histogram data for
  the window; otherwise `—` with the reason.

## 11. Files

- `app/(phase2)/data-saver/data-center/page.tsx` — rebuilt page.
- `app/(phase2)/data-saver/data-center/loading.tsx` — realigned skeleton.
- `lib/data-center-store.ts` — `ticks` added to `FETCH_SECTIONS`.
- `docs/implementation/023-data-center-full-redesign.md` — this record.