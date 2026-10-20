# DB Writer Tick Persistence Audit — 2026-09-28

- **Scope:** `services/db_writer_engine.py`, `services/market_watch_engine.py`,
  `services/market_watch_doc_buffer.py`, `services/tick_buffer.py`,
  `services/market_watch_config.py`, `services/settings_service.py`,
  `services/runtime_settings.py`, `api/engine_control.py`.
- **Task:** DB Write Engine as the single authority for tick persistence.
- **Verdict:** `VERIFIED_WITH_LIMITATIONS` (automated tests only; no live run).

---

## 1. Pre-change finding (resolved)

There were **two parallel tick pipelines**, and only one consulted the DB Writer's
permissions.

| | Pipeline A (personal / data saver) | Pipeline B (Market Watch) |
|---|---|---|
| Entry | `connection_engine._drain_persistence` | `market_watch_engine._persist_tick` |
| Authority check | `db_writer_engine._should_persist_tick()` | **none** |
| Gate | `dbw_*` settings (default OFF) | `mwr_persist_ticks` (default **True**) |
| Buffer | `tick_buffer` → `db.ticks` | `market_watch_doc_buffer` → `db.market_ticks` |

Consequences before the change: `dbw_market_watch_ticks` had no effect on Market
Watch tick writes; Market Watch ticks were persisted by default; and turning the
DB Writer's Market Watch permission off did not stop the writes. Market Watch was
effectively a co-owner of tick persistence.

Resolved: Market Watch now hands off via
`db_writer_engine.ingest_market_watch_ticks()`, which classifies, checks the
permission, dedupes, and only then buffers.

## 2. Second finding: dead overlap branch (resolved)

`_get_tick_source()` short-circuited on `market_watch`, so the
personal+market-watch overlap branches in `_should_persist_tick()` could never
run and `overlapping_sources_deduped` was structurally always `0`. The
"persist at most once" rule was unenforced. Fixed with
`_get_tick_classifications()` returning the full set.

## 3. Authority map after the change

| Concern | Owner | Enforced by |
|---|---|---|
| Classification | DB Writer | `_get_tick_classifications()` (Session Manager only) |
| Persist / do not persist | DB Writer | `should_persist_tick()` |
| Permission values | DB Writer | `TICK_PERSISTENCE_PERMISSIONS` → `settings_service` |
| Buffering / batching / retry | DB Writer | `tick_buffer`, `market_watch_doc_buffer` |
| MongoDB writes | DB Writer | `bulk_write` in the two buffers |
| Offering a tick | Market Watch | `mwr_persist_ticks` (ANDed, not authoritative) |

## 4. Permission integrity

| Permission | Key | In `DEFAULTS` | Default | In `LIVE_KEYS` |
|---|---|---|---|---|
| `personalNoExpiry` | `dbw_personal_no_expiry_ticks` | yes | `False` | yes |
| `personalOneDay` | `dbw_personal_expiry_ticks` | yes | `False` | yes |
| `marketWatchOneDay` | `dbw_market_watch_ticks` | yes | `False` | yes |

All three are pre-existing keys. No default was invented; the project's existing
`False` (OFF) was already correct. One registry
(`TICK_PERSISTENCE_PERMISSIONS`) feeds the API, the status snapshot and the
decision logic, so they cannot drift apart.

## 5. Direct MongoDB writes relevant to ticks

| Site | Collection | Verdict |
|---|---|---|
| `services/tick_buffer.py:669` | `db.ticks` (bulk) | DB Writer owned — correct |
| `services/market_watch_doc_buffer.py:282` | `db.market_ticks` (bulk) | DB Writer-owned buffer, reached only through the DB Writer's authority for ticks — correct |
| `services/market_watch_engine.py` tick path | — | **no** MongoDB call; hands off to the DB Writer — correct |

Other Market Watch direct writes (pins, config, ledger, daily report) are outside
the tick path and unchanged by this task.

## 6. Retention honesty

No MongoDB TTL index exists in this project; expiry is application-managed
(`expires_at` / `expiry_type`), and `mwr_tick_retention_days` +
`services/atlas_cleanup.py` bound growth. "1-day" in `PERSONAL_ONE_DAY` /
`MARKET_WATCH_ONE_DAY` is a **session/subscription classification**, not a TTL.
This is stated in the engine spec and in the UI copy so an operator does not infer
automatic deletion.

## 7. Verification

- `python -m pytest -q` → **1189 passed, 0 failed**
- New `TickPersistenceAuthorityTest` + `TickPersistenceApiTest`, including two
  unavailable-storage regressions
- New/updated Market Watch regression tests (2 cases)
- `npx tsc --noEmit` clean; `eslint` clean; `npm test` 273/274 (1 pre-existing
  unrelated failure at `tests/topbar-status.test.ts:336`)

## 8. Open items

- Live broker + live MongoDB confirmation (`NOT_VERIFIED`).
- Service page Settings panel not exercised in a browser.

Both are covered by the step-by-step pass in
`docs/pending/PENDING-004-db-writer-tick-persistence-live-verification.md`.
**The backend on port 8000 predates this change and must be restarted first** —
until then the new routes return 404.
- Legacy aliases `TickSource.PERSONAL_EXPIRY` / `TickSource.MARKET_WATCH` are
  retained for compatibility; they are value-equal to the canonical names, not a
  second classification system.
