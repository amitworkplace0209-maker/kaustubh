# 026 — Market Watch weekly review, report pipeline and stock-selection correctness

## Task

Chat request (Hindi/Urdu, romanised) contained six explicit demands:

1. Update the Market Watch engine and all of its UI pages to be advanced and
   consistent with the documentation and the rules.
2. Run the Market Watch engine now.
3. Build the report that is produced once a week.
4. Add one Report page under the Service phase → Market Watch section.
5. Build everything else that was outstanding.
6. Run the engine and check whether it actually works per the rules, and whether
   stocks are really selected and added.

## Objective

Make Market Watch demonstrably rule-compliant at runtime, restore the weekly
report, add the Report page, and repair the stock selection/addition path so an
operator can actually complete a Saturday review.

## Scope

Market Watch only:

- weekly report generation and scheduling (doc §2, §5)
- the daily/weekly report read endpoints and the Report page (doc §26, §5)
- the weekly review command path — draft, decision, lock (doc §32, §33)
- the observability surface for the review (doc §30)

## Out of Scope

- No redesign of any page outside Market Watch.
- No change to broker access, subscription authority, order placement or risk.
  Those belong to the WebSocket Engine, Session Manager, Order Engine and Risk
  Engine (doc §5, §10, §35).
- No change to the DB Writer's own responsibility or its tick pipeline.
- No front-end change to the trading or data-saver phases (they render the
  socket-only `market-watch-live` view, which has no tabs and no REST surface).

## Source Documentation Read

- `C:\project\PROJECT_IMPLEMENTATION_RULE.md` (whole file, §1–§62)
- `C:\project\docs\engines\MARKET_WATCH.md` (1077 lines — spec §1–§37 and
  Appendix A)
- `C:\project\docs\pending\PENDING-001-live-verification.md`
- `C:\project\docs\pending\PENDING-002-build-and-test-verification.md`
- `C:\project\docs\pending\PENDING-003-static-code-audit.md`
- `C:\project\docs\pending\PENDING-004-db-writer-tick-persistence-live-verification.md`
- `C:\project\docs\frontend\FRONTEND_ROUTE_MAP.md`
- `C:\project\docs\frontend\FRONTEND_DATA_FLOW.md`
- `C:\project\docs\frontend\FRONTEND_ARCHITECTURE.md`
- `C:\project\docs\frontend\FRONTEND_CONTRACT.md`
- `C:\project\docs\audits\MARKET_WATCH_STATUS.md`
- `C:\project\docs\audits/MARKET_WATCH_IMPLEMENTATION_AUDIT.md`

Related existing implementation (read before changing, doc §36):

- `python-service/services/market_watch_universe.py`
- `python-service/services/market_watch_weekly.py`
- `python-service/services/market_watch_report.py`
- `python-service/services/market_watch_engine.py`
- `python-service/services/market_watch_doc_buffer.py`
- `python-service/api/market_watch.py`
- `app/_pages/market-watch/report.tsx`, `weekly.tsx`, `mw-shared.tsx`

No pending file covered this task, so no existing pending task was in conflict
(doc §3). The pending files above remain open and untouched.

## Existing State

Runtime, before any change (live probe against `127.0.0.1:8000`):

| Item | Observed |
|---|---|
| `market_watch_engine` | `state=RUNNING`, `health=HEALTHY`, started, heartbeat alive |
| Locked universe | `2026-W41` v1, **15 symbols**, `unresolvedSymbolCount=0`, `verify.ok=true` |
| `universe_verify` | `ok=true`, `expectedWeekId == loadedWeekId == 2026-W41` |
| Lifecycle | `RUNTIME_INACTIVE` (server clock 23:41 IST — correct, outside 08:50–15:30) |
| `active_subscription_count` | `0` — correct outside the runtime window |
| MongoDB | reachable, database `kaustubh` |
| `market_watch_daily_report` | **3 real stored reports** (2026-09-29, 10-01, 10-02) |
| `market_watch_weekly_reports` | **0 documents** — a weekly report had never been produced |
| `market_candles_1m` | 2947 real candles — real data existed for a weekly review |
| `GET /api/market-watch/report/daily?limit=5` | `{"ok":false,"reason":"READ_ERROR","detail":"'AsyncIOMotorCursor' object is not iterable"}` |
| `GET /api/market-watch/report/daily/{date}` | **HTTP 500** |
| `GET /api/market-watch/weekly/report` | `{"ok":true,"report":null,"reason":"NO_REPORT"}` |

So: the engine ran and its core rules held, but every report reader was broken
while real reports sat unread in Mongo, and no weekly report had ever been built.

## Problems Found

Each item below was reproduced against the running system or read in code.

### P1 — `GET /report/daily/{date}` returned HTTP 500 on every call
`api/market_watch.py` called `get_db().market_watch_daily_report.find_one(...)`
without `await`. Motor returns a coroutine, which is truthy, so the following
`doc.pop("_id", None)` raised `AttributeError` **outside** the `try` block. The
`except` could not catch it. Real reports existed; none could be read.

### P2 — `GET /report/daily` always returned `READ_ERROR`
The same handler iterated an `AsyncIOMotorCursor` synchronously
(`[dict(d) for d in cursor]`). Motor cursors are async-only. The Report page's
list request could never succeed.

### P3 — the REST layer duplicated the canonical readers
`services/market_watch_report.load_report()` / `.recent()` already existed and
were correct — and were **dead code** (doc §26 forbids duplicate
implementations). The REST layer queried Mongo directly instead, which is how
P1 and P2 arose.

### P4 — the weekly report had never been generated
`build_weekly_report` had exactly one caller, `POST /weekly/scan`. The config keys
`weekly.enabled`, `review_weekday` and `review_hhmm` were resolved and exposed but
**consumed by nothing** — no timer, no task, no job. Doc §2 step 8 ("Generate a
weekly report") had no automation at all.

### P5 — the Saturday review could never be completed
`POST /weekly/draft`, `/weekly/decision` and `/weekly/lock` all defaulted
`weekId` to `week_id_for()` — the **current** ISO week. During and after a
trading week that week is already LOCKED, so every command answered
`WEEK_LOCKED`. The UI passed `weekly.weekId`, so the review was unreachable from
the UI. Reproduced live:

```
POST /weekly/draft     {"weekId":"2026-W41"} -> {"ok":false,"reason":"WEEK_LOCKED"}
POST /weekly/draft     {"weekId":"2026-W42"} -> {"ok":true,"draft":{...keptCount:15}}
POST /weekly/decision  {"weekId":"2026-W41","symbol":"SBIN","action":"ADD"}
                                        -> {"ok":false,"reason":"WEEK_LOCKED"}
```

### P6 — an operator's ADD could silently disappear
`record_decision` did a read-modify-write: `get_draft()` read Mongo while
`persist_universe()` handed the draft to the DB Writer's **in-memory buffer**
(flushed every ~3 s). The next decision therefore read a state predating the
previous one and its upsert — keyed `weekId:DRAFT` — overwrote it. Reproduced
live: `REMOVE SBIN` → `ADD TATAMOTORS` → `ADD SBIN` ended at **15** symbols
instead of 16; `TATAMOTORS` was gone with no error anywhere.

### P7 — the whole decision audit trail was being discarded
The decision document carried no `_id`, and `market_watch_doc_buffer._write()`
does `if doc_id is None: continue  # never write an unidentifiable document` —
a **silent** drop for idempotent collections. `market_watch_review_decisions`
held **0 documents** after three successful decisions.

### P8 — an empty draft lost its entire audit state
`record_decision` used `await get_draft(week_id) or WeeklyUniverse(...)`.
`WeeklyUniverse` defines `__len__`, so a zero-symbol draft is **falsy** and the
`or` discarded a real draft the instant its last symbol was removed, dropping
`added`/`removed`/`kept`. Same falsy pattern at
`load_locked_universe`'s `return _cache_loaded and _cached_universe or None`,
which would report an intentionally empty LOCKED week as "no lock at all" —
contradicting doc §2 and risking a widened universe.

### P9 — the lock stamped the wrong validity window
`lock_universe` set `effective_from = week_start()` and `effective_to =
week_start() + 7d` — the week of *now*. With P5 fixed, the Saturday review locks
the **upcoming** week, so next week's universe would have been labelled with this
week's dates, violating doc §6.

### P10 — the Report page rendered a permanently blank Change % column
`report.tsx` typed the row field as `changePercent`; the backend emits `changePct`
(`services/market_watch_report._row`). Every Change % cell rendered as a dash and
the tone logic always read zero, so no report could ever show a real percentage.

### P11 — the Report page could not show a weekly report
`report.tsx` read only the daily endpoint. The weekly report existed solely inside
the Weekly Review tab, so "the report produced once a week" had no home on the
Report page the request asked for.

### P12 — the UI mixed two different weeks under one heading
`weekly.tsx` rendered `Week {weekly.weekId}` (the review target) next to
`weekly.locked.*` (the week the engine is running). Once the target and the locked
week differ, one heading displayed W42 beside W41's lock data. Its `phase` was
also derived from `data.locked`, so a pending review was reported as frozen and
every review command was hidden.

## Design Decision

**1. One canonical reader per document shape.** The REST layer now delegates to
`services.market_watch_report.load_report` / `.recent`. This removes the duplicate
Mongo path (doc §26) and makes the previously dead service functions the single
owner of the document shape. The service, not the route, owns the `_id`-then-`date`
lookup fallback so a document written by an older build is still found rather than
reported as absent.

**2. The review reads one week and locks another — made explicit.** Doc §2 says
the Saturday review *reads* the previous Mon–Fri data and produces the membership
that *starts next*. The implementation had only one derivable week, so both roles
collapsed onto the current (already locked) week. Two named concepts were added to
the canonical week-identity owner, `market_watch_universe`:

- `review_target_week_id()` — the week decisions and the lock apply to
- `week_id_for()` — unchanged, the week the report describes

`next_week_start()` / `next_week_id_for()` / `next_review_at()` derive the
schedule from the already-resolved config rather than adding a second scheduler.
No new engine, scheduler or collection was created (doc §26).

**3. The in-process draft is the authority for its own mutation sequence.** The
overlay is written by `_stage_draft` at the mutation call sites *after* a
successful hand-off, and read by `get_draft` as a copy. Staging at the call sites
rather than inside `persist_universe` keeps the overlay and the hand-off from
disagreeing. It is explicitly scoped to one backend process; a multi-process
deployment would need the state shared, which is recorded as a limitation rather
than assumed away.

**4. A loss must be visible.** The doc buffer's silent `continue` for an
unidentifiable document now counts and logs, and `storage.pipeline` exposes
`totalUnidentifiableDrops`. This is what made P7 invisible for so long.

**5. Automation is advisory only.** `_weekly_review_tick` runs before the
runtime-window gate because the Saturday review happens after the close. It only
ever *builds and stores* the report. It cannot change membership: there is no
write path from that tick to the universe, and the operator's ADD/REMOVE/KEEP and
LOCK remain the only authority (doc §5, §32).

## Files Changed

| File | Change |
|---|---|
| `python-service/api/market_watch.py` | `GET /weekly` returns `targetWeekId`, `reportWeekId`, `targetWeekLocked`, `nextReviewAt`; `/weekly/draft`, `/weekly/decision`, `/weekly/lock` default to `review_target_week_id()`; `/report/daily/{date}` and `/report/daily` delegate to the canonical readers; `/observability` exposes `weeklyReview` |
| `python-service/services/market_watch_engine.py` | `_weekly_review_tick()` added and called before the runtime-window gate; `_weekly_report_for` state + trading-day reset; `weeklyReview` block in `status_snapshot()` |
| `python-service/services/market_watch_universe.py` | `next_week_start` / `next_week_id_for` / `review_target_week_id` / `next_review_at` / `week_start_from_id`; `_draft_overlay` + `_stage_draft`; `get_draft` reads the overlay; `seed_draft_from_locked` and `persist_universe` drop it; falsy `or`/`and` bugs fixed (P8); decision documents carry `_id` and log a refused hand-off (P7); lock window derived from the locked week (P9) |
| `python-service/services/market_watch_doc_buffer.py` | `_note_unidentifiable()` counter + error log; `totalUnidentifiableDrops` in the storage snapshot; reset on buffer reset |
| `app/_pages/market-watch/report.tsx` | Rewritten: Daily + Weekly views, `changePct` fixed (P10), weekly field table with recommendation filter, honest empty states |
| `app/_pages/market-watch/weekly.tsx` | Phase keyed off `targetWeekLocked`; commands use `targetWeekId`; report read from `reportWeekId`; header shows target week, running week and next review time (P12) |
| `app/_pages/market-watch/mw-shared.tsx` | `MwWeeklyResponse` gains `targetWeekId`, `targetWeekLocked`, `reportWeekId`, `nextReviewAt` |
| `python-service/tests/test_market_watch_weekly_universe.py` | `ReviewWindowTargetTest`, `ReviewCommandCompositionTest`, `LockValidityWindowTest`; `_FakeCollection.upsert` now keys on `_id` like the real buffer |

## Files Created

None. No new engine, service, route shell, navigation entry or collection — the
Report page route (`app/(services)/services/market-watch/report/page.tsx`), its
`nav.ts` entry and its tab already existed; the page was broken, so it was
repaired rather than duplicated (doc §27).

## Files Removed

None.

## Backend Changes

**Weekly report automation.** `_weekly_review_tick` fires at most once per
reviewed week, guarded by: `weekly.enabled` on; the IST weekday equals
`review_weekday`; the clock has reached `review_hhmm`; and no report already
exists for that week. The last guard is what makes a backend restart safe — the
report is keyed by `weekId`, so re-running the tick cannot produce a second
report. If the DB Writer refuses the document the engine logs an error and does
not claim success.

**Review-week targeting.** `POST /weekly/scan` and `GET /weekly/report` keep
keying the current ISO week (the week that finished). `/weekly/draft`,
`/weekly/decision` and `/weekly/lock` now key `review_target_week_id()`. A
Monday still targets the current week, because the week being entered may not be
locked yet.

**Report reads.** Both daily endpoints delegate to the service. `_id` is the
primary key, with a `date` fallback for documents written by an earlier build.

**Observability.** `weeklyReview` reports `reviewEnabled`, `reviewWeekday`,
`reviewHhmm`, `rupeeThreshold`, `marginMultiplierThreshold`, `reportWeekId`,
`reportGeneratedAt`, `reportCounts`, `reportWeekIdForNow`, `targetWeekId` and
`nextReviewAt` — so the schedule is observable instead of implicit.

## Frontend Changes

`report.tsx` now has two views behind a segmented control. **Daily** keeps the
existing end-of-day reader with the Change % column fixed and a BLOCKED marker per
row. **Weekly** renders the advisory Saturday review: week selector, threshold and
margin-threshold summary, the six recommendation counters, and a table of the
doc §5 fields (latest/min/max LTP, observations above and at-or-below ₹800, weekly
change %, minimum circuit distance, margin, data completeness, recommendation)
with an ALL/ADD/REMOVE/KEEP/REVIEW filter. Both views keep honest empty states
that name what produces the report instead of showing an invented value.

`weekly.tsx` no longer presents a pending review as frozen. The header states the
week under review, the week the engine is running now, the week the report
describes, and when the next review is scheduled.

## Database Changes

No schema change and no new collection. Two data-hygiene changes inside existing
collections:

- decision documents now carry `_id = "<weekId>:<symbol>"`, matching the existing
  unique index on `(weekId, symbol)` and the buffer's upsert key.
- the in-process draft overlay removes the read/write skew that made sequential
  decisions lossy.

No destructive operation was performed (doc §22). Nothing was dropped; the only
writes were additive report and decision documents.

## API Changes

Additive only — no route was removed or renamed.

| Route | Change |
|---|---|
| `GET /api/market-watch/weekly` | `+targetWeekId`, `+targetWeekLocked`, `+reportWeekId`, `+nextReviewAt` |
| `POST /api/market-watch/weekly/draft` | default week is now the review target |
| `POST /api/market-watch/weekly/decision` | default week is now the review target |
| `POST /api/market-watch/weekly/lock` | default week is now the review target; window from the locked week |
| `GET /api/market-watch/report/daily` | fixed: returns stored reports instead of `READ_ERROR` |
| `GET /api/market-watch/report/daily/{date}` | fixed: returns the report instead of HTTP 500 |
| `GET /api/market-watch/observability` | `+metrics.weeklyReview` |

## Realtime Changes

None. The weekly review is a scheduler action, not a realtime path, and it
publishes only the existing `market_watch.status` event. No event type and no WS
command was added.

## Scheduler/Lifecycle Changes

The review tick is owned by the Market Watch engine's existing 1 s lifecycle loop,
evaluated **before** the runtime-window gate because the Saturday review is
deliberately allowed outside 08:50–15:30. The runtime gate and every other
lifecycle behaviour are unchanged.

## Documentation Changes

- `docs/engines/MARKET_WATCH.md` — Appendix A updated with the review-target
  model, the automation, the report reads and the corrected open-items list.
- `docs/frontend/FRONTEND_ROUTE_MAP.md` — the Market Watch service route list
  corrected (it listed 6 routes and omitted `/weekly` and `/report`).
- `docs/frontend/FRONTEND_DATA_FLOW.md` — Market Watch endpoint count corrected.
- `docs/audits/frontend/MARKET_WATCH_UI_AUDIT.md` — created; no Market Watch
  frontend audit existed.
- `docs/verification/026-market-watch-weekly-review-and-report.md` — created.
- `docs/logs/LOG-008-2026-10-07-market-watch-weekly-review-and-report.md` —
  created.

## Tests

Backend — `C:\project\.venv\Scripts\python.exe -m pytest`:

- `tests/test_market_watch_weekly_universe.py` (added 18 tests)
- `tests/test_market_watch_spec_modules.py`
- `tests/test_market_watch_route.py`
- `tests/test_market_watch_engine.py`
- `tests/test_market_watch_filters.py`
- `tests/test_market_watch_pins.py`
- `tests/test_market_watch_ranking.py`
- then the full `tests/` suite

Frontend:

- `npx tsc --noEmit`
- `npx eslint app/_pages/market-watch/{report,weekly,mw-shared}.tsx`

## Test Results

Actual, not intended:

- `pytest tests/` → **1529 passed, 1 warning, 33 subtests passed** (0 failed)
- `npx tsc --noEmit` → **no output, exit 0**
- `npx eslint app/_pages/market-watch/report.tsx app/_pages/market-watch/weekly.tsx`
  → **no output, exit 0**
- `npx eslint .../mw-shared.tsx` → 0 errors, 1 pre-existing warning at line 1088
  (`Unused eslint-disable directive`), in `useMarketWatchRealtime`, untouched by
  this task

One warning is shared by the whole suite: a `datetime.utcfromtimestamp()`
deprecation from `python-dateutil`, unrelated to this change.

## Verification

Runtime evidence is recorded in
`docs/verification/026-market-watch-weekly-review-and-report.md`. Summary of what
was actually observed against the running backend:

- daily report list returns 3 real stored reports
- a real daily report reads with real counts (2670 tracked, 2670 blocked)
- the weekly report builds from real candles and persists
- review targeting resolves W41 (report) / W42 (lock)
- draft seeding, ADD and REMOVE compose without loss
- decision documents persist
- the full suite and the frontend checks pass

Not proven by this task — see Remaining Issues.

## Remaining Issues

1. **Live broker verification of the review is still outstanding** (doc §37). The
   engine was verified with the market closed: `RUNTIME_INACTIVE`,
   `active_subscription_count=0`, `websocket_status=DISCONNECTED`. Nothing here
   proves a real tick path, a real subscription reconcile or real intraday margin
   during the 08:50–15:30 window. Status is `VERIFIED_WITH_LIMITATIONS`.
2. **The draft overlay is single-process.** Two backend workers would each hold
   their own overlay and could still lose a decision. Recorded, not hidden.
3. **`market_watch_pins` and saved filters still write to Mongo directly**
   (`services/market_watch_pins.py`, `api/market_watch.py` filter routes). This
   was already open in spec Appendix A.12.2 and is **still open**: routing the
   inserts through the DB Writer is possible, but `remove_pin`/`clear_pins` and
   the filter deletes need a delete operation the buffer does not have. Adding one
   changes the DB Writer's contract — a different engine's responsibility — so
   under doc §5/§37 it needs its own scoped change rather than being folded into
   this task.
4. **The Saturday tick has not fired yet in real time.** It was verified by unit
   tests and by direct invocation of its guards; the first unattended Saturday
   18:00 IST run is not yet observed.
5. `/ui` and `/sections` still poll every 12 s (unchanged, pre-existing).
6. `market_watch_live_state` (spec §31) is still not persisted (pre-existing).

## Pending Work

- Live-window verification with real ticks and a real subscription reconcile.
- The pins/filters DB-Writer decision (item 3).
- Observe the first unattended Saturday review tick.

## Final Status

`VERIFIED_WITH_LIMITATIONS`

The weekly report, the Report page, the report readers, the review-week targeting
and the stock selection/addition path are implemented, tested and verified against
the running backend with real stored data. The limitation is item 1: no live
broker window was available, so the engine's rule compliance is proven for the
offline/runtime-gated path, not for a live trading session.
