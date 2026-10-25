# 026 — Market Watch weekly review, report pipeline and stock selection

## Verification ID

026

## Date / Time

2026-10-07, 23:41–23:55 IST (2026-10-06 18:11–18:25 UTC). Backend server clock
reported `2026-10-06T23:41:17+05:30` at the first probe.

## Agent

OpenCode (space-bunny-free), working to `PROJECT_IMPLEMENTATION_RULE.md` v1.0.

## Task / Feature

Six chat demands: make the Market Watch engine and its UI pages advanced and
rule-consistent; run the engine; build the once-a-week report; add a Report page
under Service → Market Watch; finish the rest; and prove the rules hold and that
stocks are really selected and added.

## Expected Behaviour

1. Engine is running and its doc §8 runtime gate, doc §7 locked-universe rule and
   doc §33 immutability rule all hold.
2. `GET /report/daily` lists the stored daily reports; `GET /report/daily/{date}`
   returns one. No 500, no `READ_ERROR`.
3. `POST /weekly/scan` builds a report from the saved Mon–Fri candles and
   persists it.
4. `GET /weekly` separates the week the report describes from the week decisions
   and the lock apply to.
5. `POST /weekly/draft`, `/weekly/decision`, `/weekly/lock` operate on the target
   week instead of answering `WEEK_LOCKED`.
6. Consecutive ADD/REMOVE/KEEP commands compose with no loss.
7. Decision documents are stored.
8. Test suites, TypeScript and lint pass.

## Verification Method

- live API probes against the running backend (`127.0.0.1:8000`)
- direct MongoDB reads/writes through `database.connection` (read-only probes plus
  the additive report/decision writes the task required)
- pure-function checks of the new week-identity helpers
- pytest (targeted suites, then the full suite)
- `npx tsc --noEmit`, `npx eslint`
- source inspection for the doc §13 direct-write paths

## Environment

- OS: Windows, PowerShell 5.1
- Backend: `python-service` under uvicorn, `127.0.0.1:8000`, Python 3.12
  (`.venv`)
- Frontend: Next.js dev server on `127.0.0.1:3000`
- MongoDB: database `kaustubh`, reachable; 11 Market Watch collections inspected
- Market state: **CLOSED**. Server clock 23:41 IST on Tuesday 2026-10-06, far
  outside the doc §8 window 08:50–15:30
- Broker: **not logged in** (`feedState=DISCONNECTED`). No live tick path
- Timezone: Asia/Kolkata (IST) for every Market Watch time in this record
- Secrets: none recorded; all values are redacted or non-sensitive

Consequence: the runtime-window, lock-integrity and report paths were verifiable;
the live tick, subscription-reconcile and intraday-margin paths were **not**.

## Questions / Checks

| # | Check | Method |
|---|---|---|
| C1 | Is the engine running? | `GET /status` |
| C2 | Does the runtime gate hold outside 08:50–15:30? | lifecycle fields + `_in_runtime_window` |
| C3 | Is membership exactly the locked list? | `locked_universe_count`, `weekly/universe`, `universe_verify` |
| C4 | Are there unresolved locked symbols? | `unresolvedSymbolCount` |
| C5 | Does the daily report list work? | `GET /report/daily?limit=30` |
| C6 | Does a single daily report read work? | `GET /report/daily/2026-10-02` |
| C7 | Does the weekly scan build from real candles? | `POST /weekly/scan?weekId=2026-W41` |
| C8 | Is the weekly report persisted and readable? | `GET /weekly/report`, `GET /weekly/reports` |
| C9 | Do report week and lock week resolve correctly? | helper unit checks for Sat/Mon/Friday |
| C10 | Can a draft be seeded for the target week? | `POST /weekly/draft` W41 vs W42 |
| C11 | Do decisions compose without loss? | `REMOVE SBIN` → `ADD TATAMOTORS` → `ADD SBIN` |
| C12 | Are decision documents stored? | Mongo `market_watch_review_decisions` |
| C13 | Does a locked week refuse change? | `POST /weekly/decision` on W41 |
| C14 | Do the full backend tests pass? | `pytest tests/` |
| C15 | Do TypeScript and lint pass? | `tsc --noEmit`, `eslint` |

## Expected Results

- C1 RUNNING/HEALTHY
- C2 `RUNTIME_INACTIVE`, `active_subscription_count=0`
- C3 locked 15, verify `ok=true`, engine universe 15
- C4 `0`
- C5 3 stored reports returned
- C6 real counts, HTTP 200
- C7 15 reviewed, 15 with data, persisted `true`
- C8 `weekId=2026-W41`, 15 rows
- C9 Saturday: report W41, lock target W42
- C10 W41 → `WEEK_LOCKED`; W42 → seeded with 15 kept
- C11 14 → 15 → 16 symbols, `added` grows 1 → 2
- C12 decisions present in Mongo
- C13 `WEEK_LOCKED`
- C14 0 failures
- C15 exit 0

## Actual Results

### C1 — engine running: PASS
```
state=RUNNING  health=HEALTHY  engineId=market_watch  version=2.0.0
startedAtAgo=1066.9  heartbeatAge=928.1  errorCount=0  warningCount=0
dependencies=[websocket_engine, connection_manager, instrument_cache, db_writer_engine]
```

### C2 — runtime gate holds: PASS
```
serverTime=2026-10-06T23:41:17+05:30
lifecycle.state=RUNTIME_INACTIVE   runtimeActive=false
active_subscription_count=0        websocket_status=DISCONNECTED
```
Correct: 23:41 IST is outside 08:50–15:30, so processing is stopped and nothing
is subscribed. This is doc §8 behaving as specified, not a defect.

### C3/C4 — membership equals the locked list: PASS
```
locked_universe_count=15   active_subscription_count=0
weekId=2026-W41  version=1  status=LOCKED  lockedBy=operator
resolvedSymbolCount=15  unresolvedSymbolCount=0  unresolvedSymbols=[]
universe_verify: ok=true reason=null expectedWeekId=2026-W41 loadedWeekId=2026-W41 version=1 symbolCount=15
engineUniverseSize=15  weekly/universe symbols[15]
```
The engine's universe is exactly the 15 locked symbols with none substituted and
none unresolved — doc §7 and doc §28 restart step 4 satisfied.

### C5/C6 — daily report readers: PASS (were broken)

Before the fix:
```
GET /report/daily?limit=5   -> {"ok":false,"reason":"READ_ERROR",
                                "detail":"'AsyncIOMotorCursor' object is not iterable"}
GET /report/daily/2026-10-05 -> HTTP 500 (empty body)
```
After the fix:
```
GET /report/daily?limit=30 -> ok=true count=3 dates=2026-10-02, 2026-10-01, 2026-09-29
GET /report/daily/2026-10-02 -> ok=true
  counts={"universeTracked":2670,"eligible":2670,"subscribed":0,
          "blocked":2670,"withLivePrice":0,"totalValidatedTicks":0}
  topGainers=0 circuitNear=0 blocked=2670
```
Three reports that already existed in Mongo are now reachable. The `blocked:2670`
figure is the real recorded state for that date, not a defect of the reader.

### C7/C8 — weekly report: PASS
```
POST /api/market-watch/weekly/scan?weekId=2026-W41
  ok=true  persisted=true  threshold=800.0
  counts={"reviewed":15,"withData":15,"withoutData":0,
          "recommendAdd":10,"recommendRemove":5,"recommendKeep":0,"recommendReview":0}

GET /weekly/report?weekId=2026-W41 -> ok=true weekId=2026-W41 rows=15
GET /weekly/reports?limit=5         -> reports=1 weeks=2026-W41
```
Real per-symbol values came from real `market_candles_1m` documents, e.g. SBIN
`latestLtp=953.3 weeklyMinLtp=950.3 weeklyMaxLtp=985.95 observationsAboveThreshold=1
weeklyChangePercent=-0.4906 dataCompleteness=0.625 recommendation=ADD`. Fields
with no source stayed `null` (`intradayEligible=null`, `upperCircuit=null`,
`marginStatus="UNAVAILABLE"`) — doc §21, no fabrication.

Before this task `market_watch_weekly_reports` held **0 documents**, so the
once-a-week report had never been produced.

### C9 — review-week targeting: PASS
```
now IST 2026-10-06T23:46 (Tuesday)
  week_id_for(now)          = 2026-W41
  next_week_id_for(now)     = 2026-W42
  review_target_week_id(now)= 2026-W42
Saturday 2026-10-10 18:00 IST
  week_id_for(sat)          = 2026-W41   (report subject = week that finished)
  review_target_week_id(sat)= 2026-W42   (lock target = upcoming week)
  next_week_start(sat)      = 2026-10-12
Monday 2026-10-12
  review_target_week_id     = 2026-W42   (week being entered, may be unlocked)
next_review_at()            = 2026-10-10T18:00:00+05:30
```
The report week and the lock week are provably different, which is doc §2.

### C10 — draft seeding on the target week: PASS (was impossible)
```
POST /weekly/draft {"weekId":"2026-W41"} -> {"ok":false,"reason":"WEEK_LOCKED"}
POST /weekly/draft {"weekId":"2026-W42"} -> {"ok":true,"draft":{"weekId":"2026-W42",
                          "status":"DRAFT","symbolCount":15,"keptCount":15,
                          "sourceWeekId":"2026-W41"}}
```
Stock selection confirmed: the draft is seeded with the previous lock's 15 symbols
as `kept`, and discovers nothing on its own — doc §32.

### C11 — decisions compose: PASS after fix, FAIL before

Before the fix, three rapid commands produced the wrong result:
```
REMOVE SBIN      -> symbols=15 added=0 removed=0 kept=15   (unchanged — stale)
ADD TATAMOTORS   -> symbols=15 added=0 removed=0 kept=15   (unchanged — stale)
ADD SBIN         -> symbols=15 added=0 removed=0 kept=15   (unchanged — stale)
persisted draft : symbolCount=15 added=['SBIN'] kept=14    (TATAMOTORS LOST)
expected        : symbolCount=16 added=['TATAMOTORS','SBIN'] removed=[] kept=14
```
After the fix:
```
REMOVE SBIN     -> symbols=14 added=0 removed=1 kept=14
ADD TATAMOTORS  -> symbols=15 added=1 removed=1 kept=14
ADD SBIN        -> symbols=16 added=2 removed=0 kept=14
EXPECTED        -> symbols=16 added=2 removed=0 kept=14     MATCH
```
Persisted document confirmed identical:
```
{weekId: 2026-W42, status: DRAFT, symbolCount: 16,
 added: 2:['TATAMOTORS','SBIN'], removed: 0:[], kept: 14:[...]}
```
The root cause was `record_decision` using
`await get_draft(...) or WeeklyUniverse(...)` together with `WeeklyUniverse.__len__`:
once the draft had zero symbols it was falsy, so the fetched draft was discarded
and its `added`/`removed`/`kept` were lost. A second, independent cause was the
read/write skew against the DB Writer's unflushed buffer.

### C12 — decision audit trail: PASS after fix, FAIL before
```
before: market_watch_review_decisions count=0   (3 successful decisions, all dropped)
after : stored SBIN=ADD, TCS=REMOVE   _id="2026-W42:<symbol>"
```
Cause: decision documents carried no `_id`, and the buffer's idempotent write path
does `if doc_id is None: continue` — a silent drop. Fixed by giving each decision a
deterministic `_id`, and the drop is now counted and logged
(`totalUnidentifiableDrops`).

### C13 — locked week refuses change: PASS
```
POST /weekly/decision {"weekId":"2026-W41","symbol":"SBIN","action":"ADD"}
  -> {"ok":false,"reason":"WEEK_LOCKED",
      "detail":"week 2026-W41 is LOCKED — membership cannot change (doc §33)"}
```
doc §33 holds. Note this is the behaviour P5 depended on: the guard was correct,
the *default target* was wrong.

### C14 — backend tests: PASS
```
pytest tests/ -> 1529 passed, 1 warning, 33 subtests passed in 15.01s   (0 failed)
```
18 new tests added. One shared pre-existing warning: `datetime.utcfromtimestamp()`
deprecation from `python-dateutil`.

### C15 — frontend checks: PASS
```
npx tsc --noEmit                                   -> no output, exit 0
npx eslint app/_pages/market-watch/report.tsx \
            app/_pages/market-watch/weekly.tsx     -> no output, exit 0
npx eslint app/_pages/market-watch/mw-shared.tsx   -> 0 errors, 1 warning
   warning 1088:5 'Unused eslint-disable directive' — pre-existing, in
   useMarketWatchRealtime, not touched by this task
```

## Evidence

Commands actually run, from `C:\project` unless noted:

| Purpose | Command |
|---|---|
| engine state | `Invoke-RestMethod http://127.0.0.1:8000/api/market-watch/status` |
| weekly state | `.../api/market-watch/weekly` |
| universe proof | `.../api/market-watch/weekly/universe` |
| observability | `.../api/market-watch/observability` |
| report readers | `.../report/daily?limit=30`, `.../report/daily/2026-10-02` |
| weekly scan | `POST .../weekly/scan?weekId=2026-W41` |
| review commands | `POST .../weekly/draft`, `POST .../weekly/decision` |
| Mongo inspection | `.venv\Scripts\python.exe` probe using `database.connection` |
| week helpers | `.venv\Scripts\python.exe` week-identity script |
| tests | `.venv\Scripts\python.exe -m pytest tests/ -q` (from `python-service`) |
| typecheck | `npx tsc --noEmit` |
| lint | `npx eslint app/_pages/market-watch/*.tsx` |

Status for each: PASS unless stated in Actual Results.

## Problems Found

| # | Problem | Status |
|---|---|---|
| P1 | `GET /report/daily/{date}` HTTP 500 — un-awaited Motor `find_one` | FIXED |
| P2 | `GET /report/daily` `READ_ERROR` — sync cursor iteration | FIXED |
| P3 | REST duplicated the canonical service readers (dead code) | FIXED |
| P4 | Weekly report never generated; `reviewWeekday`/`reviewHhmm` unconsumed | FIXED |
| P5 | Review commands targeted the locked current week — `WEEK_LOCKED` always | FIXED |
| P6 | Sequential decisions lost (read vs unflushed write skew) | FIXED |
| P7 | Whole decision audit trail silently dropped (missing `_id`) | FIXED |
| P8 | Empty draft falsy via `__len__` — audit state discarded | FIXED |
| P9 | Lock validity window stamped with the wrong week | FIXED |
| P10 | Report page `changePercent` vs backend `changePct` — blank column | FIXED |
| P11 | Report page could not show a weekly report | FIXED |
| P12 | UI showed target week and locked week under one heading | FIXED |

## Fixes Applied

See `docs/implementation/026-market-watch-weekly-review-report-and-stock-selection.md`
§ Design Decision and § Files Changed for the code of record. Each fix was
re-verified by the check that originally failed.

## Re-verification

Every P-item was re-probed after its fix:

- C5/C6 re-run → real reports listed and read
- C7/C8 re-run → weekly report built, persisted, read back
- C9 re-run via the helper checks → report W41 / lock W42
- C10 re-run → W41 refused, W42 seeded
- C11 re-run → 14 → 15 → 16, matching the expected sequence exactly
- C12 re-run → decision documents present in Mongo
- C14/C15 re-run → 1529 pytest pass, tsc exit 0, eslint 0 errors

## Final Result

**PARTIAL**

Everything in the task scope is implemented, tested and verified against the
running backend with real stored data: the report readers work, the once-a-week
report is produced and readable, the Report page carries Daily and Weekly views,
and stock selection/addition works end to end without loss.

It is not a full PASS because the market was closed and no broker session existed,
so the doc §37 live acceptance criteria were never exercised.

## Remaining Risks

1. **Live tick path unproven.** `received_tick_count=0`, `validated_tick_count=0`,
   `last_tick_at=null`, `ticksPerSecond=null` throughout. Nothing here proves
   tick ingestion, validation, circuit-danger classification, the 1%/5%/10%/30m
   movers, or realtime delivery to the UI.
2. **Subscription reconcile unproven.** `active_subscription_count=0` is correct
   for a closed market, but no reconcile against real broker subscriptions was
   observed.
3. **Circuit and margin fields stayed null.** `upperCircuit=null`,
   `marginStatus="UNAVAILABLE"` — because no live instrument refresh or session
   margin decision existed in this window. The rules that consume them
   (`min_circuit_distance_pct`, the 2% danger threshold) were therefore exercised
   only by unit tests, not by real data.
4. **First unattended Saturday tick not yet observed.** The automation was verified
   by its guards and by unit tests; the 18:00 IST run has not happened yet.
5. **Draft overlay is single-process.** With two backend workers the skew could
   return. Documented, not solved.
6. **`market_watch_pins` / saved filters still write to Mongo directly**
   (doc §13). Still open — needs a DB Writer delete operation, a change to another
   engine's contract.
7. **Universe size is 15 against an `eligibleTarget` of 100**, so the engine
   reports `universeState=CRITICAL_LOW_UNIVERSE`. That is a real, honest warning
   about the operator's chosen membership, not a defect.
8. **No browser/UI verification was performed.** The Report and Weekly Review
   pages were verified by typecheck, lint and the API payloads they consume — not
   by rendering them in a browser.

## Related

- Specification: `docs/engines/MARKET_WATCH.md` (§2, §5, §6, §7, §8, §13, §26,
  §30, §32, §33, §35, §36, §37)
- Implementation: `docs/implementation/026-market-watch-weekly-review-report-and-stock-selection.md`
- Engine audit: `docs/audits/MARKET_WATCH_STATUS.md`
- Frontend audit: `docs/audits/frontend/MARKET_WATCH_UI_AUDIT.md`
- Engine log: `docs/logs/LOG-008-2026-10-07-market-watch-weekly-review-and-report.md`
- Open items carried forward: `docs/engines/MARKET_WATCH.md` Appendix A
