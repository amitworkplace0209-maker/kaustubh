# 004 — Tick Analytics trace (024 working file)

Date: 2026-10-02
Purpose: preserve the reasoning trail behind the 024 Tick Analytics work so a
future agent can retrace it without re-reading everything. Permanent knowledge
lives in `engines/TICK_ANALYTICS.md`, `implementation/024-*`,
`verification/023-*` and `logs/LOG-006-*`; this file is the scratch trace.

## Starting shape (what was really there)

The brief said "rebuild /data-saver/analytics 0-to-1". Before touching
anything, the actual boundary had to be pinned down, because Tick Analytics
sits next to four engines that all look like they own tick data:

- WS Engine / broker feed — owns the *feed*.
- DB Writer — owns *persistence* into `ticks`.
- Data Quality — owns *error/duplicate measurement*.
- Data Center — owns *storage/telemetry presentation*.

Tick Analytics owns **none** of them. It is a read-only consumer that
aggregates their telemetry, plus **one** collection of its own
(`tick_analytics_daily`). Everything in this change obeys that: no tick write,
no new socket, no new writer, no scheduler other than the two loops it added
to `app.py` for itself.

## Why history is a stored document, not a query

The tempting implementation is `db.ticks.aggregate([...group by day...])` on
`GET /daily`. Three reasons not to:

1. It makes the request path unbounded (the exact class of bug that caused the
   720 h page-load stall in Data Quality, per `opencode/003`).
2. It cannot be honest: an empty result looks identical to "the day never
   had data", so the UI would show `0 ticks`.
3. It cannot carry provenance — you lose the distinction between
   `daily_summaries.totalTicks` (writer-side, restart-safe) and
   `ticks.count` (storage-side).

So: `build_day()` computes once, `_persist()` stores it, `list_days()` reads
stored docs with a `SUMMARY_FIELDS` projection, and anything missing goes on
a queue that a background loop drains.

## Three defects found by *running* it (not by reading it)

These are the reason the verification record drives real HTTP instead of
stopping at unit tests.

### 1. Cache key collision in `quality_slice`

`data_quality._cache_key(hours, symbol, extra_match)` — the function
signature takes `start_override`/`end_override` but the key does not include
them. Building `2026-10-01` and then `2026-09-30` inside the 60 s TTL would
return day 1's metrics for day 2. Already known from `opencode/003` (item 3
there) but the same trap reappeared in the new caller.

Fix: vary the key through `extra_match={"ts": {"$gte": ..., "$lt": ...}}`,
which *is* part of the key.

### 2. `get_day(refresh=True)` did not refresh

```python
if fresh_enough or not today:
    _day_cache[...] = stored
    if fresh_enough:
        return stored          # <- returns before build_day, even when refresh=True
```

`backfill_once()` calls `get_day(date, refresh=True)`, so every queued day was
being "rebuilt" by re-reading the document it was queued to rebuild. The
smoking gun: the first real backfill run reported `built 6 day(s)` while every
row still carried its previous `NO_DATA` status.

Fix: the whole stored-document read is now under `if not refresh:`.

Lesson to keep: when `refresh` is a boolean on a read-through cache, make sure
the flag is checked on **every** short-circuit, not just the in-memory one.

### 3. `NO_DATA` was hiding real writer activity

Real data, 2026-10-01:

```
daily_summaries.totalTicks = 15811
ticks collection           = 0 documents
old status                 = NO_DATA     <- claims "nothing happened"
```

The environment genuinely has no stored ticks (pre-existing, not caused by
this work), but labelling the day `NO_DATA` says "there was no data" when the
truth is "data arrived and was not retained". That is the difference between a
*missing metric* and an *absent measurement* — the honesty contract is about
the latter being named, not papered over.

New rule (implemented in both `build_day` and `build_report`):

```
if storedDocs == 0 and not writer_activity:  NO_DATA
elif anything missing:                        PARTIAL   # + storedTickDocuments
else:                                         COMPLETE
```

The report also gained a always-present `reason` field (`NO_TICK_DATA` only
for the true-empty case).

## Frontend traps avoided

- **`honest(99.5, '%')`** — an early `maximumFractionDigits: 2` rounded to
  `100%` for any value ≥ 99.5. Now `Number.isInteger(n) ? 0 : 2`.
- **`mergeLive()`** — the realtime frame is a *partial* document. Merging it
  naively would overwrite a good REST value with `undefined`/`0`. The helper
  drops explicit null/undefined and never writes `0` over a REST value.
- **Legacy `/api/ticks/recent` fallback in the BFF** — attractive (keeps the
  chart alive when the engine fails) but it is a second, unlabelled source
  sitting beside labelled engine metrics. Removed; the `live` section now
  degrades to `PARTIAL` + `missing[]`.
- **Section param split** — `PATH_PARAM_KEYS` vs `QUERY_PARAM_KEYS` exist
  because `/symbol-stats/{symbol}` and `/daily/{date}` must not leak into the
  query string; there is a test asserting it.

## Environment note (worth remembering)

The backend runs behind a **singleton guard**: `start_backend.py` takes a named
mutex and probes port 8000, and `app.py` re-checks it at import and
`SystemExit`s. So:

- you cannot run a second instance to test new code while the old one lives;
- `python -c "import app"` prints
  `BACKEND ALREADY RUNNING pid=... refusing to start a duplicate instance.` and
  exits **0** — that is the guard, not an error in the change;
- the workaround used here is a **scratch FastAPI app that mounts only the
  router** under `fastapi.testclient.TestClient`, with a lifespan that calls
  `connect_mongo()`. That gives real HTTP + real Mongo without touching the
  live process.

Also: `python -c "..."` must run with cwd `python-service`, otherwise
`.env` (and therefore `MONGODB_URI`) is not picked up and `connect_mongo`
raises `MongoDbConfigurationError`. File-based scripts were unaffected only by
accident of how the dotenv search resolves; do not rely on it.

## Test notes

- Backend: 36 in `test_tick_analytics_daily.py` + 32 existing
  `test_tick_analytics.py` = 68, all green. Full suite 1417 passed with 1
  pre-existing unrelated failure (`test_ws_engine` sdk_version).
- Frontend: 28 in `tests/tick-analytics.test.ts`. `node --test` needs the
  explicit `.ts` import extension (`from '../lib/tick-analytics.ts'`).
- Pre-existing unrelated frontend failure: `tests/topbar-status.test.ts:331`
  (`INACTIVE` vs `AUTHENTICATING`) — do not "fix" it inside this change.

## Next session entry point

1. Confirm with the operator, then restart the backend so the live process
   serves `/api/data-saver/tick-analytics/*`; re-run the scratch-app smoke
   against port 8000.
2. Browser pass on `/data-saver/analytics` (375/768/1440/1920).
3. Decide whether `ticks` being empty while `daily_summaries` records activity
   is retention, a cap, or a permission — separate investigation.

---

## Round 2 � page redesign traps

- **The payload is the contract, not the spec's column names.** The first pass
  of Top Symbols read `firstAt` / `lastAt` / `avgTickRate`; `symbolStats` rows
  are actually `{symbol, ticks, firstTickAt, lastTickAt, activeDurationSec,
  avgRate, sharePct}`. Nothing threw � every cell just rendered `�`. Always
  read the builder (`tick_analytics_daily.py:913-921`) before wiring a column.
- **`summary()` returns no `symbol` / `depth` / `wsConnected`.** Anything the
  page wants from those must come from `status.connected`, `lastTick.ageSec`
  or the standalone endpoints; `live.payload` is the flat `live_event()` shape.
- **Per-source `received` / `persisted` are `None` by design** (`sources.rows`),
  and per-symbol persisted/failed is not measured at all. Render `�` + a
  footnote; do not borrow a day-level number into a symbol row.
- **`SECTIONS` had only 9 entries** while `TICK_ANALYTICS.md` listed 14 � the
  doc table was wrong, not the code. Fixed the doc; `allowed[]` in the BFF now
  derives from `SECTIONS` so the two cannot drift again.
- Symbol search was already wired (`useInstrumentSearch` + `searchInstruments`
  exact-match fallback on Enter); it needed no change, only verification.
