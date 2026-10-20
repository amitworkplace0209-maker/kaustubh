# DB Writer Service Page — Tick Persistence Settings Audit — 2026-09-28

- **Page:** `app/_pages/db-writer/page.tsx` (route wrapper
  `app/(services)/services/db-writer/page.tsx` — unchanged, no new page created)
- **Change:** added a Settings ⚙️ control with the three independent tick
  persistence toggles, plus a live tick-persistence status card.
- **Verdict:** `VERIFIED_WITH_LIMITATIONS` (typecheck + lint + unit tests; not
  exercised in a browser)

---

## 1. Requirement mapping

| Requirement | Implementation |
|---|---|
| Settings ⚙️ control | `<Settings/>` button in `PageHeader` → inline `SectionCard` panel |
| Toggle 1 | `personalNoExpiry` — "Personal Stocks — No Expiry" |
| Toggle 2 | `personalOneDay` — "Personal Stocks — 1-Day Expiry" |
| Toggle 3 | `marketWatchOneDay` — "Market Watch Stocks — 1-Day" |
| Independent | Each `Switch` maps to exactly one backend permission name; the PUT body contains only the changed key |
| Read authoritative state | `GET {ENGINE}/tick-persistence` on panel open and after every write |
| No optimistic state | Toggles render `permissions[key].enabled` (backend-reported). A write adopts the response verbatim; on `!ok` or a network error the panel re-reads via `loadPermissions()` |
| Show live status | "Tick persistence — live status" card from `data.tickPersistence` (accepted / skipped / overlap deduped / unknown source rejected) |
| No fabricated data | `fmtNum` renders `—` for missing values; an absent payload renders `EmptyState` |

## 2. Authority boundary

The frontend never computes a classification, never infers eligibility, and never
sends anything but a permission name and a boolean. All classification and the
persist/skip decision happen server-side in `db_writer_engine`. The page displays
`owner: db_writer_engine` in the status card header.

## 3. Error handling

| Condition | Behaviour |
|---|---|
| Backend `ok: false` | `permError` set to `json.error`, authoritative state re-read |
| Non-2xx / network error | `permError` set from the thrown message, state re-read |
| Write in flight | Only the affected `Switch` is `disabled` (`savingKey`) |
| Permissions not loaded yet | `LoadingState`, then the three rows |

## 4. Honest-copy checks

- "1-day" is described as a session/subscription classification, **not** a MongoDB
  TTL, so no operator infers automatic deletion.
- The status card states that the DB Write Engine is the only authority and that
  Market Watch offers but cannot toggle persistence.
- Each row shows its real `settingKey` and real accepted/skipped counters.

## 5. Checks run

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean (exit 0) |
| `npx eslint app/_pages/db-writer/page.tsx` | clean (exit 0) |
| `npm test` | 273/274; the single failure is the pre-existing, unrelated `tests/topbar-status.test.ts:336` |

## 6. Not verified

- No browser run: the panel's open/close, toggle interaction and error toasts were
  not exercised against a live backend.
- No live metrics were observed, so the accepted/skipped values shown to an
  operator remain untested in a real session.
