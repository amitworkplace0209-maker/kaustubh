# Data Center — Frontend Planes & Responsive UI Audit

- **Scope:** `app/(phase2)/data-saver/data-center/page.tsx`,
  `components/data-center/dc-planes.tsx` (new), `lib/data-center.ts`,
  `lib/data-center-store.ts`, `app/api/phase2/data-center/route.ts`.
- **Method:** Static read of the real components, `tsc --noEmit`, `next build`,
  `eslint` on the changed files, and `node --test` unit tests over the pure
  normalizers. **No browser, no dev server, no screenshot** was run.
- **Date:** 2026-09-28
- **Status:** `IMPLEMENTED_NOT_VERIFIED` (no browser rendering was observed)

---

## 1. Scope discipline — what was *not* created

This was an in-place upgrade of the one canonical page. Verified against
`next build` route output, which still lists exactly one Data Center page:

```
○ /data-saver/data-center
```

Explicitly **not** created: a `/data-center` alias, a desktop variant, a mobile
variant, a second engine, or a second PWA. The existing PWA infrastructure
(`public/sw.js` v7, `public/manifest.json`, `app/layout.tsx` with
`viewportFit: 'cover'`) was already in the working tree and already precached
`/data-saver/data-center`; it was **not** re-architected by this work.

---

## 2. Panels added

All in `components/data-center/dc-planes.tsx`, all read-only, all rendering the
plane's own `source` string in the footer:

| Component | Backend plane | Cadence |
| --- | --- | --- |
| `DatabaseIdentityPanel` | `database` | 15s |
| `EngineOwnershipPanel` | `engines` | 60s |
| `EngineTopologyPanel` | `topology` | 60s |
| `DbWriterPipelinePanel` | `dbwriter` | 15s |
| `CollectionOwnershipPanel` | `ownership` | 60s |
| `RetentionPlanePanel` | `retention` | 60s |

The page header status now prefers the **live** `database` plane's identity and
falls back to the legacy overview, rather than guessing from storage totals.

---

## 3. Honesty rules enforced in the normalizers

`lib/data-center.ts` gained six `normalize*Plane()` functions plus
`normalizeDcEnvelope()`. Each was written against one rule: **a missing
measurement stays missing.** A test per plane asserts it.

| Mistake the normalizer prevents |
| --- |
| `str(undefined)` → `""` used as a value | → `null` (renders `N/A`) |
| `Number(null)` → `0` | → `null` (`NOT MEASURED`), never `0` |
| a failed section → `{}` | → `null` + a separate `error` string |
| an empty array from a failed fetch | → `null` + `error`, not "nothing exists" |
| a boolean-ish field → `Boolean(x)` | → `x == null ? null : Boolean(x)` |

`null` renders as `N/A` / `UNKNOWN` / `NOT AVAILABLE` / `NOT CONFIGURED` /
`NOT VERIFIED`, never as `0` or `--`.

---

## 4. Defects found and fixed during this work

| # | Defect | Impact | Fix |
| --- | --- | --- | --- |
| F1 | `LIVE_PLANES = ['database', 'dbwriter']` and `ALL_SECTIONS` contained **`'dbwriter'`**, but the proxy's key is **`'dbWriter'`** | the proxy's `parseSections()` silently filters unknown names, so the **15s live poll never requested DB Writer**. The panel kept its first-load value forever, with no error anywhere. `FETCH_SECTIONS` was already correct, which is why the bug was invisible until the 15s poll | corrected to `'dbWriter'`, and the whole set is now derived from a single typed list |
| F2 | Section names were duplicated as untyped string literals in three places, with **two different naming conventions** (wire `api-telemetry`/`dbWriter` vs state `apiTelemetry`/`dbWriter`) | a typo is not a compile error and not a runtime error — it is a silently frozen panel (F1) | added `DC_WIRE_SECTIONS` + `dcWireSection()` in `lib/data-center.ts`; `ALL_SECTIONS` is now derived from it and the other three lists are `satisfies readonly DcWireSection[]` |
| F3 | `fetchRaw(days, sections: readonly string[])` and `urlFor(..., readonly string[])` erased the section type before it reached the URL builder | removed the last opportunity for a type error on a section name | both are now `readonly DcWireSection[]` |
| F4 | `pick()` in `normalizeDcEnvelope()` returned `ok: false` for a section **absent** from the payload | a *targeted* poll (live-only or slow-only) would have produced a phantom "section unavailable" error for every section it did not ask for | absence is now `{ present: false, ok: true, error: null }` — not-requested ≠ failed. The store already only applies `present` sections, so this removes a latent trap |
| F5 | `DcDbWriterPlane` had no `authoritative` field although the backend sends it | the UI could not state that DB Writer is the single writer | added `authoritative: boolean` + normalizer; the panel surfaces it |

F1 is the significant one: it was a real, user-visible defect that produced a
panel frozen at stale data with no error indicator — precisely the failure mode
this page is supposed to make impossible.

### Regression guards added

- `every wire section name is actually served by the proxy route` — reads
  `route.ts`, extracts the `SECTIONS` keys, and asserts the set is **exactly**
  `DC_WIRE_SECTIONS`, in both directions. A future rename that drifts on either
  side now fails the suite.
- `wire section names map 1:1 onto state keys` — locks `apiTelemetry → api-telemetry`
  and asserts `'dbwriter'` is *not* a valid wire name.
- `envelope carries every plane independently` — one failing section must not
  blank or error the others, and absent sections must not error.

---

## 5. Responsive / PWA review

Implemented:

- Wide data tables scroll inside their own container (`overflow-x-auto` +
  `min-w-0` on the flex/grid child) instead of forcing the page wider.
- Grids and search/filter controls collapse at narrow widths; the DB Writer
  permission rows and the ownership table remain readable at 375px.
- `overflow-x-clip` on the page container as a second line of defence.
- Top **and** bottom `env(safe-area-inset-*)` padding so the last panel is not
  hidden behind the iOS home indicator in standalone mode.

**Not verified:** no browser was launched, so none of the required widths
(375 / 390 / 430 / 768 / 1024 / 1280 / 1440 / 1920) has been observed. The
above is a code-level review only. See *Limitations*.

---

## 6. Accessibility / semantics review (static)

- The live/slow cadence is stated in the page footer, not implied.
- Every panel footer shows the backend `source` string, so a number on screen
  can be traced to a module path without opening devtools.
- Unavailable panels render an explicit reason instead of an empty card.
- Table markup uses `<table>` with a `<caption>`-equivalent header row, and the
  scroll container is keyboard-focusable via `tabIndex` where it scrolls.

**Not verified:** no screen-reader pass, no contrast measurement, no focus-order
check in a real browser.

---

## 7. Limitations (unverified without a browser)

1. **No rendering was observed.** No dev server, no Playwright/screenshot, no
   manual QA. Layout correctness, safe-area behaviour, and the table-scroll
   affordance are reasoned about, not seen.
2. **No live API was observed.** The panels were exercised only against
   hand-written fixtures; the real envelope from a live backend has not been
   rendered.
3. **Ownership-map labels are static text** in the backend and are rendered as
   given, so any mojibake in the backend map (e.g. the pre-existing
   `TICK_PERSISTENCE_LABELS` encoding damage) is displayed verbatim.
4. **The existing test suite has one pre-existing failure**, in
   `tests/topbar-status.test.ts:331` (`canonical session state never invents
   ACTIVE`). That file imports only `lib/topbar-status.ts`, which none of this
   work touches; the failure is present on the untouched tree and is **not** a
   regression from this work.
5. The repo has pre-existing lint warnings outside the changed files; the
   changed files lint clean.

---

## 8. Realtime intake + page hierarchy update (2026-10-01, serial 022)

Related implementation: `docs/implementation/022-data-center-realtime-snapshot-push-and-page-redesign.md`
Related verification: `docs/verification/022-data-center-realtime-snapshot-push-and-page-redesign-verification.md`

### 8.1 Page structure (current)

`app/(phase2)/data-saver/data-center/page.tsx` still renders **every** panel that
existed before (nothing was removed); the body is now grouped into five named
regions with a shared `Region` helper (top-level heading + description +
`space-y-3` body), and the outer container spacing is `space-y-6`:

1. **Overview** — health strip, runtime, session, database.
2. **Realtime** — `RealtimePanel` (moved up from mid-page, because it is the
   surface this change is about).
3. **Storage & pipeline** — collections + collection detail sheet, scheduler,
   market data, persistence, infrastructure-live (`StorageEngineLivePanel`),
   collection ownership, retention, cleanup.
4. **Engines** — engine monitor (`EnginesLiveGrid`), engine ownership, engine
   topology.
5. **History & telemetry** — daily tick storage (charts + write table),
   persisted snapshots, API telemetry, workers, event trail.

`PageHeader` carries a fourth status chip beside the three realtime surfaces:
`Live · WS#2` (success) when the store is streaming, otherwise `Polling 15s`
(info). The page footer now states the delivery path explicitly
("snapshot delivered live over WS#2 (15s poll as fallback)" vs "by the 15 s REST
poll").

### 8.2 Store: how the push reaches the page (current)

`lib/data-center-store.ts`:

- `DcStoreState` gained `snapshotSource: 'poll' | 'realtime'`,
  `realtimeUpdatedAt: number | null`, `realtimeConnected: boolean`.
- `attachRealtime()` (called from `startTimers()`) registers
  `realtimeClient.onFrame` (filters `data_center.snapshot`, body =
  `frame.data?.data ?? frame.data`) and `realtimeClient.onStateChange`
  (`realtimeConnected`, re-subscribes on `CONNECTED`), then subscribes
  `[{channel: 'data_center'}]`.
- `detachRealtime()` (called from `stopTimers()`) removes both listeners and
  issues a real `unsubscribe` for `data_center`, so a page the user has left
  stops the backend from building snapshots.
- `applyRealtimeSnapshot(raw)` normalises through the same `normalizeSnapshot`
  and rejects an incompatible schema, a `transportError` document, or a document
  whose `generatedAt` is older than the one already displayed.
- `refreshSnapshot()` sets `snapshotSource: 'poll'`; the push sets `'realtime'`.
- Page `streaming` = connected **and** realtime-sourced **and** younger than 20 s.

### 8.3 Deliberate non-change

`lib/engine-realtime.ts` has **no** net change. A `useDataCenterSnapshot()` hook
was written first and reverted: `useFrontendRealtime()` re-renders consumers at
market-tick rate (~4 Hz), and this page is very long, so a tick-rate React context
would re-render far more often than the 5 s snapshot it displays. The push is
therefore attached in the store singleton, which already owns the snapshot, the
poll and the subscriber refcount.

### 8.4 Verification state of this UI change

- `tsc --noEmit` clean; targeted eslint clean; Next route resolves (307 auth
  redirect, no compile error).
- **Not observed in a browser.** The five-region layout, the `Live · WS#2` badge
  transition and the poll fallback in the rendered UI are unverified; see
  verification/022 "Remaining Risks".
- `lib/data-center-store.ts` is still not covered by `npm test`, including the
  new `applyRealtimeSnapshot` rejection rules.
- Pre-existing `tests/topbar-status.test.ts:331` failure still present (019).
