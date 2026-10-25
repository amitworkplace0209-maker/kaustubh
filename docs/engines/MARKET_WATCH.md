MARKET WATCH ENGINE --- UPDATED AUTHORITATIVE SPECIFICATION
Status: Implemented specification (code-aligned, 2026-10-20)
Timezone: Asia/Kolkata
Runtime: 08:50 IST <= runtime < 15:30 IST
Scheduled universe refresh: Every Friday 15:25 IST (manual run allowed any day)

> **READ THIS FIRST.** Sections 1-37 are the specification and are unchanged
> in intent except where the Friday 15:25 scan below explicitly supersedes the
> Saturday-only lock. **APPENDIX A (Implementation Status)** was added on
> 2026-10-05 and maps every clause of this document to the code that now
> implements it, with `file_path:line_number` references. **A.14** records the
> Friday 15:25 scan, the no-expiry Session Manager subscription and the UI.
> Where the spec and the code disagreed, the appendix records which one changed
> and why.

---

## 1. Purpose
Market Watch is a backend-owned market intelligence and monitoring
engine.
It maintains a manually locked weekly universe, receives live broker
ticks only for that universe, refreshes authoritative
instrument/circuit/margin metadata, calculates per-stock live and
timeframe state, classifies/ranks stocks, and publishes processed
results to the frontend.
It does not place orders, write MongoDB directly, or perform Market
Watch calculations in the frontend.

## 2. Core Operating Model
Friday 15:25 --- Scheduled Universe Refresh
Every normal trading Friday at 15:25 IST the engine MUST run the full-universe
screen (holidays are skipped; the manual command still works):
1. Read every active NSE EQ instrument from the Instrument Master.
2. Resolve a real LTP for each candidate (never a hard-coded list).
3. Resolve the broker's MIS margin multiplier for each priced candidate.
4. Keep only stocks that are intraday-eligible, have LTP strictly below
   ₹800, and have a broker-confirmed margin of at least 5x.
5. Persist the survivors as the upcoming week's LOCKED Market Watch universe.
6. Apply them as the Session Manager's daily-universe intent with NO EXPIRY.
7. Reconcile the WebSocket subscription immediately while the engine is inside
   its runtime window, so the next tick for each survivor flows through the
   validated-tick pipeline and is persisted by the DB Writer. A scan finishing
   after 15:30 records the same intent and defers the socket reconcile to the
   next session.

The scan is configuration-driven (`mwr_friday_scan_hhmm`, default `15:25`) and
runs at most once per ISO week. It is also exposed as a manual command on any
day (`POST /api/market-watch/friday-scan`), because an operator may need to
re-run it after a missed schedule or a broker/margin outage.

Saturday --- Weekly Review (advisory)
Every Saturday:
1. Read the previous Monday-Friday saved data.
2. Read Instrument Master data.
3. Review intraday eligibility.
4. Review LTP history.
5. Count observations above/below ₹800.
6. Review circuit behavior.
7. Review margin/leverage information.
8. Generate a weekly report.
9. User manually decides ADD / REMOVE / KEEP.
10. User locks the final universe.

Because the Friday scan already locks the upcoming week, the Saturday review is
**advisory** once that target week is LOCKED: the report still renders, but
membership changes are refused (§33). If the Friday scan did not lock the target
week (disabled, no survivors, broker unavailable), the Saturday manual lock is
still the authority.
Monday-Friday --- Monitor Only
After the list is locked:
Market Watch MUST monitor exactly the locked list and no other stock.

If the Friday scan (or Saturday lock) selected 1200 stocks:
Next week Market Watch subscription universe = exactly those 1200
stocks.

There is no automatic mid-week add/remove.
A stock crossing ₹800, changing margin, becoming attractive, or moving
strongly does not change weekly membership. Such changes are reviewed by the
next Friday scan (or the next manual run), never by a per-tick rule.
3. Universe Separation
Instrument Universe
All instruments available from the broker Instrument Master.
Market Watch Universe
Only the stocks manually approved and locked for the current week.
Instrument Master availability does not authorize Market Watch
subscription.
Instrument Master
      |
      +--> many instruments
      |
      v
Weekly Manual Review
      |
      v
LOCKED MARKET WATCH UNIVERSE
      |
      v
Only locked stocks receive Market Watch monitoring
4. Weekly Flow
MON-FRI SAVED DATA
        |
        v
SATURDAY WEEKLY SCAN
        |
        +--> LTP history
        +--> > ₹800 observations
        +--> <= ₹800 observations
        +--> intraday eligibility
        +--> circuit history
        +--> margin/leverage
        +--> data quality
        |
        v
WEEKLY REPORT
        |
        v
MANUAL ADD / REMOVE / KEEP
        |
        v
FINAL LOCK
        |
        v
VERSIONED WEEKLY UNIVERSE
        |
        v
NEXT MON-FRI
        |
        v
ONLY LOCKED STOCKS
5. Weekly Report
For each reviewed stock, report where data is available:
- Symbol
- Trading symbol
- Company name
- Exchange
- Segment
- Token
- Current/latest known LTP
- Weekly minimum LTP
- Weekly maximum LTP
- Number of observations above ₹800
- Number of observations at/below ₹800
- First observed price
- Last observed price
- Weekly change
- Weekly change %
- Intraday eligible / unavailable / unknown
- Upper circuit
- Lower circuit
- Circuit danger observations
- Minimum circuit distance
- Broker-supported margin value
- Effective leverage/multiplier where available
- 5x threshold status
- Data completeness
- Review recommendation
The report is advisory. The user remains the final authority.
6. Weekly Universe Version
A locked universe must be versioned.
Recommended fields:
week_id
version
effective_from
effective_to
symbols[]
added[]
removed[]
kept[]
locked_at
locked_by
status
Example:
Week: 2026-W41
Version: 8
Final Stocks: 1200
Status: LOCKED
7. Active-Week Subscription Rule
The active subscription set equals the latest locked list.
Prohibited:
Instrument exists in Instrument Master
but is not locked
→ Market Watch subscription ❌

New stock falls below ₹800 mid-week
→ automatic add ❌

Locked stock rises above ₹800 mid-week
→ automatic removal ❌

New attractive stock appears
→ automatic add ❌
Only the next Saturday review can change the following week's
membership.
8. Runtime Window
Market Watch runtime is:
08:50 IST <= runtime < 15:30 IST
Before 08:50:
- Market Watch processing stopped
- no Market Watch-specific subscriptions
- no ranking
- no timeframe processing
- no background Market Watch loops
At/after 15:30:
- Market Watch-specific processing stops
- Market Watch-specific subscriptions are released
- Market Watch timers/tasks stop
- stale live state must not be shown as LIVE
Global broker/session infrastructure and personal subscriptions must not
be stopped merely because Market Watch stops.
Outside the runtime window, frontend may show a valid report/offline
state.
9. Instrument Master and Daily Metadata
For every locked stock, obtain authoritative metadata from the
Instrument Master / broker adapter.
Where available:
- token
- symbol
- trading symbol
- company name
- exchange
- segment
- instrument type
- series
- lot size
- tick size
- precision
- multiplier
- ISIN
- expiry/strike/option type
Refresh required daily market metadata according to the broker/session
lifecycle:
- upper circuit
- lower circuit
- LTP reference
- previous close
- intraday eligibility
- margin information
- other broker trading constraints
Missing values remain null, UNKNOWN, or equivalent. Never fabricate.
10. Broker Data Architecture
Broker REST / Instrument APIs
        |
        +--> Instrument metadata
        +--> Circuit
        +--> Margin / eligibility
        |
Broker WebSocket
        |
        v
WebSocket Engine
        |
        v
Event Bus
        |
        v
Market Watch Engine
Market Watch MUST NOT open a second broker WebSocket.
The WebSocket Engine remains the canonical broker WebSocket owner.
11. Live Tick Pipeline
Broker Tick
    |
WebSocket Engine
    |
Normalize / Validate
    |
Event Bus
    |
Market Watch
    |
    +--> LTP
    +--> ₹ change
    +--> % change
    +--> circuit distance
    +--> margin state
    +--> 1m
    +--> 5m
    +--> 10m
    +--> 30m
    +--> classification
    +--> ranking
    |
    +--> DB Writer
    |
    v
Connection Manager
    |
    v
Frontend
12. Tick Validation
Validate where available:
- token
- symbol
- exchange
- timestamp
- LTP
- event identity/sequence
- data quality
Invalid or malformed ticks must not enter calculation state.
13. DB Writer Ownership
Every validated Market Watch tick is handed to DB Writer.
Market Watch
     |
     v
DB Writer
     |
     v
Persistence Permission
   /         YES        NO
  |          |
 Mongo     suppress
Market Watch MUST NOT write directly to MongoDB.
DB Writer alone decides whether the tick is persisted according to its
configured permission.
No per-tick direct insert_one() from Market Watch.
Batching, buffering, retry, backpressure and MongoDB writes remain DB
Writer responsibilities.
14. Circuit Rule
Market Watch must use actual broker-provided upper/lower circuit prices.
Maintain:
upper_circuit_distance_pct
lower_circuit_distance_pct
Danger condition:
minimum valid circuit distance < 2%
Then:
classification = DANGER
A danger stock is removed from the active frontend publish/calculation
set while its backend state and reason remain auditable.
Do not calculate circuit from LTP.
If circuit data is unavailable:
circuit_status = UNKNOWN
Do not fabricate safety.
15. Intraday Eligibility
Every locked stock has:
ELIGIBLE
UNAVAILABLE
UNKNOWN
If intraday becomes unavailable:
- remove it from active frontend results
- exclude it from active ranking calculations
- retain backend reason/history
- do not automatically change weekly membership
Active removal is not the same as weekly universe removal.
16. ₹800 Rule
The ₹800 threshold is a weekly review criterion.
The report records:
- observations above ₹800
- observations at/below ₹800
- weekly minimum
- weekly maximum
- current/latest LTP
Crossing ₹800 during Monday-Friday does not automatically add/remove the
stock from the locked universe.
17. Margin Rule
Margin is obtained from the authoritative broker/margin owner.
Market Watch may consume:
- required margin
- margin per quantity
- effective leverage/multiplier
- intraday margin eligibility
Market Watch must not invent leverage.
A 5x rule can be a configurable reporting/eligibility threshold, but the
actual broker-provided margin/leverage value remains authoritative.
18. Per-Stock Timeframes
Every active stock is processed independently.
Required:
1 minute
5 minutes
10 minutes
30 minutes
Maintain where valid:
- open
- high
- low
- close/current
- volume
- price change
- percentage change
- start/end time
- tick count
- data quality
19. Timeframe Change
For each stock:
change_1m
change_1m_pct

change_5m
change_5m_pct

change_10m
change_10m_pct

change_30m
change_30m_pct
Conceptually:
change = current_price - timeframe_reference_price

change_pct =
((current_price - timeframe_reference_price)
 / timeframe_reference_price) * 100
Use broker-provided authoritative change fields where applicable.
Never use an arbitrary reference price.
20. Classification
DANGER
circuit distance < 2%
OR
intraday unavailable
GAINER
Valid active stock with positive movement.
LOSER
Valid active stock with negative movement.
NORMAL
Valid active stock with movement below the configured 1% threshold.
Precedence:
DANGER
>
INTRADAY_UNAVAILABLE
>
GAINER / LOSER
>
NORMAL
21. 1% Movers
For each timeframe:
1m
5m
10m
30m
A stock is a 1% mover when:
abs(change_pct) >= 1%
Positive:
>= +1%
Negative:
<= -1%
Suggested frontend state:
GREEN = >= 1% movement
YELLOW = valid but < 1%
RED = danger / unavailable
Backend must provide explicit status; frontend only renders it.
22. Rankings
Backend calculates:
- Top Gainers
- Top Losers
- Top 1% movers --- 1m
- Top 1% movers --- 5m
- Top 1% movers --- 10m
- Top 1% movers --- 30m
- Highest Volume where available
- Most Active where supported
- Circuit Near / Danger
Frontend does not calculate rankings.
23. Frontend Contract
Frontend receives processed state such as:
symbol
company_name
ltp
change
change_pct

upper_circuit
lower_circuit
circuit_distance_pct

margin_value
margin_multiplier
margin_status

change_1m
change_1m_pct
change_5m
change_5m_pct
change_10m
change_10m_pct
change_30m
change_30m_pct

classification
movement_flags
last_tick_at
data_quality
Only available values are sent.
24. Frontend Must Not
Frontend must not:
- calculate LTP change
- calculate change %
- calculate circuit distance
- calculate timeframe movement
- calculate rankings
- calculate margin
- decide eligibility
- decide weekly membership
- connect directly to broker
Frontend only renders backend state.
25. Realtime Frontend Flow
Broker Tick
    |
WebSocket Engine
    |
Event Bus
    |
Market Watch calculation
    |
Changed state
    |
Connection Manager
    |
Frontend WebSocket
    |
Targeted UI update
Do not reload the full page for every tick.
Do not fetch the entire Market Watch REST dataset for every tick.
Use incremental realtime updates.
26. Publish Policy
Backend may maintain full state for the locked universe.
Frontend publication should prioritize:
- Top Gainers
- Top Losers
- Top 1% movers
- visible stocks
- pinned stocks
- selected stocks
- summary counts
Do not stream all locked stocks to the browser at unrestricted UI update
frequency unless explicitly required.
27. State Model
Engine-level:
OFFLINE
PRE_MARKET
WEEKLY_LOCKED
STARTING
SUBSCRIBING
MONITORING
DEGRADED
BLOCKING
STOPPING
STOPPED
REPORTING
Stock-level:
ACTIVE
DANGER
INTRADAY_UNAVAILABLE
STALE
NO_DATA
INVALID
28. Restart and Reconnect
On restart:
1. Load latest locked universe.
2. Verify week/version.
3. Reconcile subscriptions.
4. Subscribe only locked stocks.
5. Restore/rebuild timeframe state where possible.
6. Never discover a new universe automatically.
On broker WebSocket reconnect:
Reconnect
   |
fresh snapshot/reconcile where required
   |
subscription reconciliation
   |
resume locked-universe ticks
No duplicate Market Watch broker connection.
29. Performance
Do not:
- scan the entire Instrument Master every tick
- query MongoDB for every tick
- call broker REST for every tick
- recalculate every timeframe from scratch
- stream unrestricted raw ticks to frontend
- rerender the entire frontend on each tick
- create duplicate WebSockets
- resubscribe on every UI render
Use:
- locked-universe in-memory state
- incremental calculations
- bounded queues
- cached instrument metadata
- event-driven updates
- controlled publish cadence
- DB Writer batching
30. Observability
Track:
locked_universe_count
active_subscription_count
received_tick_count
validated_tick_count
invalid_tick_count

danger_count
intraday_unavailable_count

top_gainers_count
top_losers_count
movers_1m_count
movers_5m_count
movers_10m_count
movers_30m_count

last_tick_at
processing_latency
publish_latency
websocket_status
System must be able to prove:
locked list = intended Market Watch subscription list
subject only to documented broker/session constraints.
31. Suggested Data Collections
market_watch_universe
market_watch_universe_history
market_watch_weekly_reports
market_watch_decisions
market_watch_live_state
market_watch_candles_1m
market_watch_candles_5m
market_watch_candles_10m
market_watch_candles_30m
Tick persistence remains DB Writer-owned.
Do not create duplicate persistence paths.
32. Weekly Manual Commands
Conceptually support:
ADD stock
REMOVE stock
KEEP stock
REVIEW
LOCK
After LOCK:
- assign version
- record added/removed/kept
- record timestamp/user
- freeze universe
- create subscription intent
33. No Mid-Week Auto-Rebalance
Never:
LTP > ₹800
→ auto remove

LTP < ₹800
→ auto add

margin changed
→ auto remove/add

new attractive stock
→ auto add
These observations affect status/reporting, not weekly membership.

The ONLY membership-changing events are:
1. the scheduled Friday 15:25 universe scan, and
2. an explicit manual run of the same scan
   (`POST /api/market-watch/friday-scan`).
Both replace the upcoming week's LOCK as a single deliberate command; neither is
a per-tick or per-observation reaction. A manual run on any other day is an
operator decision, not an automatic rebalance.
34. AI Phase 4
Market Watch may later provide structured context to AI Gateway:
- top stocks
- LTP
- change %
- timeframe movement
- volume
- circuit status
- margin context
- ranking
- data quality
AI must not:
- access broker credentials
- open broker WebSocket
- change the locked universe
- place orders directly
35. Non-Negotiable Rules
1. The Friday 15:25 scan (or an explicit manual run) locks weekly membership;
   the Saturday review is advisory once the target week is locked.
2. Monday-Friday monitors only the locked universe.
3. No automatic mid-week add/remove outside the scheduled/manual scan.
4. Instrument Master is not the Market Watch subscription universe.
5. WebSocket Engine owns broker WebSocket.
6. Market Watch never opens a second broker WebSocket.
7. All Market Watch calculations happen in backend.
8. Frontend only renders processed backend state.
9. DB Writer is the only MongoDB tick persistence owner.
10. Market Watch sends validated ticks to DB Writer.
11. Missing data is never fabricated.
12. Circuit distance uses actual circuit prices.
13. Circuit distance below 2% is danger.
14. Intraday unavailable stocks leave active display/calculation.
15. ₹800 crossing during the week does not change membership.
16. Margin is authoritative from the broker/margin owner.
17. Timeframe calculations are backend-owned.
18. Rankings are backend-owned.
19. Market Watch never places orders.
20. Frontend never calls broker APIs directly.
36. Acceptance Criteria
The engine is accepted only when:
Weekly
- Friday 15:25 scan runs automatically and can be triggered manually on any day.
- The scan screens every active NSE EQ for intraday eligibility, LTP < ₹800
  and margin >= 5x; every rejection carries a reason code.
- The survivors are locked as the upcoming week's universe, versioned and
  audited.
- The Session Manager subscription intent is applied with no expiry and the
  WebSocket subscription is reconciled immediately.
- Saturday scan runs from Monday-Friday saved data.
- Weekly report is generated.
- Manual add/remove/keep works when the target week is not already locked.
- Final lock works.
- Weekly version is persisted.
- Audit record exists.
Active Week
- Only locked stocks are subscribed.
- No unapproved stock receives Market Watch subscription.
- No automatic membership changes occur.
- Real broker ticks are received.
- Instrument/circuit/margin data is obtained from authoritative
  sources.
- 1m/5m/10m/30m calculations work.
- Gainer/loser/1% mover classifications work.
- Circuit danger works.
- Intraday unavailable stocks are excluded from active results.
- Validated ticks reach DB Writer.
- DB Writer permission ON/OFF works.
- Frontend receives processed realtime data.
Performance
- No duplicate broker WebSocket.
- No duplicate subscription registry.
- No direct Market Watch Mongo write.
- No per-tick broker REST polling.
- No unrestricted raw-tick frontend stream.
37. Definition of Complete
Market Watch is not complete merely because the UI renders or tests
pass.
Production verification requires:
Weekly historical review
+
Manual universe lock
+
Exact locked-week subscriptions
+
Real broker ticks
+
Instrument/circuit/margin data
+
Backend calculations
+
1m/5m/10m/30m classification
+
Circuit danger handling
+
DB Writer persistence permission
+
Realtime frontend delivery
+
Restart/reconnect safety
+
Live verification evidence
FINAL OPERATING PRINCIPLE
SATURDAY
Review → Report → Manual ADD/REMOVE → LOCK

MON-FRI
Locked List
    ↓
Instrument Metadata
    ↓
Circuit / Margin / Eligibility
    ↓
Live Broker Ticks
    ↓
Backend Calculations
    ↓
1m / 5m / 10m / 30m
    ↓
Gainers / Losers / 1% Movers / Danger
    ↓
DB Writer
    ↓
Connection Manager
    ↓
Frontend

NO AUTOMATIC MID-WEEK MEMBERSHIP CHANGE.
Core rule:
Saturday decides the Market Watch universe. Monday-Friday Market Watch
only monitors that locked universe. Backend calculates everything. DB
Writer controls persistence. Frontend displays processed results.

---
---

# APPENDIX A — Implementation Status (added 2026-10-05)

This appendix records what the code actually does today. It was written by
scanning `python-service/services/market_watch_*.py`, `python-service/api/market_watch*.py`
and the Market Watch frontend, then closing the gaps.

## A.0 Summary of what changed

The specification above describes a **weekly-locked** Market Watch. Before
2026-10-05 the engine was **daily and master-derived**: it rebuilt the universe
from the sanitised instrument master every refresh interval, had no weekly
universe, no versioning, no lock, no classification vocabulary, and almost none
of the §30 observability metrics. The frontend additionally broke §22, §24 and
§26 by computing its own ranking and its own gainer/loser colour.

Everything in the table below is now implemented and covered by
`python-service/tests/test_market_watch_weekly_universe.py` (59 tests).

| Spec area | Before | Now |
|-----------|--------|-----|
| Weekly universe, version, lock (§2/§4/§6/§7/§32/§33) | **ABSENT** | `services/market_watch_universe.py` |
| Saturday scan + weekly report (§5) | **ABSENT** | `services/market_watch_weekly.py` |
| Instrument Master ≠ subscription universe (§3/§35.2/§35.4) | violated (daily rebuild) | `market_watch_engine._build_locked_universe` |
| Stock states ACTIVE/DANGER/INTRADAY_UNAVAILABLE/STALE/NO_DATA/INVALID (§27) | **ABSENT** | `market_watch_state.SymbolState` |
| Classification + precedence (§20) | **ABSENT** | `SymbolState.evaluate_stock_state` |
| `movement_flags` per timeframe (§21) | **ABSENT** | `SymbolState.evaluate_movement_flags` |
| Circuit status SAFE/NEAR/DANGER/HIT/UNKNOWN (§14) | block reason only | `SymbolState.recompute_circuit_status` |
| Margin value/multiplier/status (§17) | consumed, never surfaced | `SymbolState.apply_margin` + engine hand-off |
| ₹800 observation counters (§16) | **ABSENT** | `SymbolState.observe_threshold` |
| Flat `change_1m`…`change_30m_pct` (§19) | only 5m/10m | `SymbolState.to_public` / `to_compact` |
| Top 1% movers per timeframe (§21/§22) | **ABSENT** | `movers_1pct_{tf}` / `decliners_1pct_{tf}` boards |
| Circuit **Danger** board (§22) | **ABSENT** | `circuit_danger` board |
| received / invalid tick counters (§12/§30) | **ABSENT** | `engine._received_tick_count` / `_invalid_tick_count` |
| All 17 §30 metric names | 1 of 17 present | all present, top level of `status_snapshot().metrics.custom` |
| Weekly/EOD report read endpoints (§26) | report was write-only | `GET /api/market-watch/report/daily[/{date}]` |
| `/tick-snapshot` dropped `eligibility` + `lastTickAt` | bug | fixed, plus all §23 fields |
| `/rank` sort keys | 9 keys | 9 + 14 backend-owned keys |
| `/page` reachable sections | 10 | 10 + every official board |
| Frontend client-side ranking (§22/§24 violation) | `market-watch-live.tsx` sorted raw ticks | reads the engine's 1% board |
| Frontend client-side gainer/loser tone (§24 violation) | sign-derived colour | renders backend `classification` |
| Frontend weekly review UI (§32) | **ABSENT** | `app/_pages/market-watch/weekly.tsx` |
| Frontend report reader (§26) | **ABSENT** (dead "Report tab" link) | `app/_pages/market-watch/report.tsx` |
| Circuit distance / margin / 1m / 30m / classification rendering (§23) | **ABSENT** | `mw-table.tsx`, `rank.tsx`, `symbol.tsx` |

## A.1 §2 / §4 / §6 / §7 / §32 / §33 — weekly locked universe

`services/market_watch_universe.py` (new)

| Item | Reference |
|------|-----------|
| `WeeklyUniverse` dataclass (every §6 field) | `market_watch_universe.py:68` |
| `to_doc()` / `from_doc()` | `:130` / `:167` |
| `week_id_for()` ISO week (`2026-W41`) | `:64` |
| `week_start()` Monday | `:58` |
| `load_locked_universe()` — the ONLY membership source | `:206` |
| `active_symbols()` | `:235` |
| `get_draft()` / `seed_draft_from_locked()` | `:243` / `:300` |
| `record_decision()` ADD/REMOVE/KEEP | `:325` |
| `lock_universe()` — version bump + freeze + history | `:369` |
| `is_locked()` | `:291` |
| `verify_week()` — honest §28 verdict | `:427` |
| `history()` lock audit trail | `:262` |
| `decisions_for()` | `:274` |
| `engine_state_for()` → `WEEKLY_LOCKED` / `OFFLINE` | `:459` |
| Collections | `:44`–`:47` |

Collections created: `market_watch_universe`, `market_watch_universe_history`,
`market_watch_review_decisions`, `market_watch_weekly_reports`.

**Writes go through DB Writer.** `lock_universe` calls
`db_writer_engine.buffer_documents` (`:389`–`:397`) and reports
`persisted: false` honestly when the writer is unavailable, rather than writing
directly (§13/§35.9).

**§33 enforcement is structural.** `record_decision` raises `PermissionError`
when the week is already `LOCKED` (`:337`); `lock_universe` raises on a
double lock (`:377`). There is no code path that can mutate a locked week.

## A.2 §3 / §7 / §35.2 / §35.4 — Instrument Master is not the universe

`services/market_watch_engine.py`

| Item | Reference |
|------|-----------|
| `_build_universe()` routes to the locked path | `:663` |
| `_build_locked_universe()` — membership = locked list only | `:715` |
| `_locked_symbols()` | `:337` |
| `load_locked_universe()` engine method (§28 steps 1-2) | `:349` |
| `universe_verify()` | `:333` |
| Loaded+verified **before** any subscription intent, at start | `:317` |
| `_universe_unresolved` — locked symbols missing from the master | `:765` |

Behaviour in `LOCKED` mode:

* the instrument master supplies **metadata only** (token, name, exchange,
  series, lot size, tick size, precision, multiplier, ISIN, instrument type);
* a locked symbol absent from the master is reported in
  `weekly.unresolvedSymbols`, **never replaced** by a wider set;
* an empty lock yields an **empty universe**, not a fallback to the master.

Config: `MWR_UNIVERSE_SOURCE` = `LOCKED` (default) | `DAILY_MASTER` (legacy
behaviour, retained only so an operator can run before the first lock).

## A.3 §5 — Saturday scan + weekly report

`services/market_watch_weekly.py` (new)

| Item | Reference |
|------|-----------|
| `build_weekly_report()` — the full §5 field list | `:146` |
| `trading_days_for()` Mon-Fri, calendar-aware | `:44` |
| `_week_candles()` — from **persisted** `market_candles_1m` | `:67` |
| `_observe_threshold()` — ≥/≤ ₹800 day counts | `:120` |
| `_last_daily_circuit()` — real circuits + danger days | `:265` |
| `_last_margin()` — Session Manager `marginDecisions` only | `:294` |
| `_recommend()` — advisory ADD/REMOVE/KEEP/REVIEW | `:329` |
| `persist()` via DB Writer | `:351` |
| `load_report()` / `recent_reports()` | `:359` / `:374` |

Every §5 field is present and nullable. `dataCompleteness` reports the share of
the field list the symbol can actually supply, so a gap is visible instead of
being filled in. The report **never** changes membership — that is the LOCK call.

## A.4 §27 / §20 / §21 / §14 / §16 / §17 / §19 — per-symbol state

`services/market_watch_state.py`

| Item | Reference |
|------|-----------|
| `stock_state` field (§27) | `:400` |
| `classification` field (§20) | `:401` |
| `movement_flags` field (§21) | `:402` |
| `intraday_status` (§15) | `:405` |
| `margin_value` / `margin_multiplier` / `margin_status` (§17) | `:411` |
| `observations_above_threshold` / `..._at_or_below_threshold` (§16) | `:416` |
| `data_completeness` | `:419` |
| `circuit_status` (§14) | `:344` |
| `min_circuit_distance_pct()` — smallest **valid** distance | `:566` |
| `recompute_circuit_status()` → SAFE/NEAR/DANGER/HIT/UNKNOWN | `:585` |
| `apply_margin()` | `:627` |
| `observe_threshold()` — sampled, count-only | `:655` |
| `evaluate_movement_flags()` | `:680` |
| `evaluate_stock_state()` — §20 precedence | `:697` |
| `_classify()` | `:729` |
| `_stock_state_from_classification()` | `:751` |
| `to_public()` emits every §23 field + flat `change_{tf}` / `change_{tf}_pct` | `:800` |
| `to_compact()` same, for ranking rows | `:874` |

Vocabulary constants live in `services/market_watch_config.py`:
`STOCK_STATES` (`:255`), `CLASSIFICATIONS` (`:264`), `CIRCUIT_STATUSES`
(`:275`), `INTRADAY_STATUSES` (`:284`), `MARGIN_STATUSES` (`:287`),
`ENGINE_STATES` (`:318`), `WEEK_STATUSES` (`:308`), `REVIEW_ACTIONS` (`:315`),
`RECOMMENDATIONS` (`:320`).

**Circuit distance is never read as zero on a missing side** —
`min_circuit_distance_pct()` filters to non-negative distances, so a symbol with
only an upper circuit still gets a real distance and `circuit_status` stays
`UNKNOWN` rather than faking safety.

**Classification precedence** (`_classify`, `:729`):
`DANGER` (circuit danger/hit) → `INTRADAY_UNAVAILABLE` → movement sign above
`normal_threshold_pct` → `NORMAL`.

## A.5 §22 — rankings

`services/market_watch_engine.py` `_run_official_rankings` (`:1969`)

| Board | Reference |
|-------|-----------|
| `top_gainers` / `top_losers` | `:2032` / `:2036` |
| `highest_volume` | `:2040` |
| `most_active` | `:2043` |
| `circuit_near` | `:2046` |
| **`circuit_danger`** (new) | `:2051` |
| `movers_{tf}` / `decliners_{tf}` | `:2059` |
| **`movers_1pct_{tf}` / `decliners_1pct_{tf}`** (new) | `:2061` |
| `top_movers()` — 1% filter + non-active exclusion | `:2020` |
| `row()` — every §23 field on each board row | `:1976` |

`_NON_ACTIVE_STOCK_STATES` (`:207`) holds `DANGER` and
`INTRADAY_UNAVAILABLE`; a symbol in either state is excluded from the 1%
boards (§14/§15) while remaining auditable in `circuit_danger`.

## A.6 §12 / §30 — validation and observability

`services/market_watch_engine.py`

| Item | Reference |
|------|-----------|
| `received_tick_count` bump | `:1582` |
| LTP validation → `invalid_tick_count` | `:1592` |
| `_record_invalid_tick()` — bounded sample | `:1610` |
| `processing_latency_ms` | `:1620` |
| `publish_latency_ms` | `:2380` |
| `_stock_state_counts()` — zero-filled vocabularies | `:3082` |
| All 17 §30 metrics + `stockStates` + `classificationCounts` + `weekly` | `:3138` |

`GET /api/market-watch/observability` (`api/market_watch.py`) exposes the same
metric names at the top level plus the active thresholds.

`websocket_status` was already computed (`feedState`) but was only wired into
the root endpoint; it is now also in the §30 block.

## A.7 §26 — report read endpoints (previously write-only)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/market-watch/report/daily/{date}` | one stored EOD report |
| `GET /api/market-watch/report/daily?limit=` | recent EOD reports |
| `GET /api/market-watch/weekly/report?weekId=` | one stored weekly report |
| `GET /api/market-watch/weekly/reports?limit=` | recent weekly reports |

The EOD report was always generated (`services/market_watch_report.py`) and
persisted, but nothing could read it.

## A.8 New REST surface

All under `api/market_watch.py`, which grew from **26 to 40 routes**.

| Endpoint | Spec |
|----------|------|
| `GET  /weekly` | §2, §6, §32 — lock + draft + decisions + history + verify |
| `GET  /weekly/universe` | §7, §30 — subscription-set proof |
| `POST /weekly/scan` | §5 — build + persist the weekly report |
| `GET  /weekly/report` | §5 |
| `GET  /weekly/reports` | §5 |
| `POST /weekly/decision` | §32 — ADD / REMOVE / KEEP (rejects a locked week) |
| `POST /weekly/lock` | §6, §32 — version + freeze + history + engine reload |
| `POST /weekly/draft` | §32 — seed the draft from the last lock |
| `GET  /weekly/history` | §6 — lock audit trail |
| `POST /friday-scan` | §2, §33 — run the Friday screen on any day, lock + subscribe |
| `GET  /observability` | §30 |
| `GET  /boards` | §22 — every board incl. the 1% and Circuit Danger boards |
| `GET  /stock/{symbol}` | §23 — one symbol's full backend contract |
| `GET  /report/daily[/{date}]` | §26 |

Changed existing endpoints:

* `GET /tick-snapshot` — `eligibility`, `lastTickAt` and `receivedAt` were
  computed and then **dropped** from the response; they are now returned, along
  with the full §23 field set.
* `GET /rank` — 14 new backend-owned sort keys (`change_1m_pct`,
  `change_30m_pct`, `circuitDistancePct`, `marginMultiplier`, `classification`, …).
* `GET /page` — falls through to the official ranking boards, so `movers_1pct_*`,
  `decliners_1pct_*`, `circuit_danger` and `most_active` are addressable instead
  of returning `unknown_section`.

## A.9 §22 / §23 / §24 / §26 — frontend

| File | Change |
|------|--------|
| `app/_pages/market-watch/mw-shared.tsx` | §20/§21/§23/§27 types, format-only helpers, weekly + observability + boards API clients, `BOARD_LABELS` |
| `app/_pages/market-watch/weekly.tsx` **(new)** | lock status, §28 verify verdict, Friday 15:25 schedule + last outcome + manual run button, scan / seed / decide / lock, weekly report table with the full §5 field list, §30 observability strip, lock history |
| `app/_pages/market-watch/report.tsx` **(new)** | EOD report reader — replaces the dead "Navigate to the Report tab" notice, which pointed at a tab that did not exist |
| `app/_pages/market-watch/mw-table.tsx` | `timeframes` (1m/5m/10m/30m), `circuit` (distance + status + margin), `classification` (+ mover flags), `quality` columns; header now mirrors the enabled columns |
| `app/_pages/market-watch/rank.tsx` | 1m/30m, circuit distance, leverage, classification columns |
| `app/_pages/market-watch/movers.tsx` | 10 → 21 boards including all 8 1% boards, Circuit Danger and Most Active, read from `GET /boards` |
| `app/_pages/market-watch/symbol.tsx` | circuit status + both distances, margin status/value/multiplier, all four timeframes with mover flags, classification, stock state, ₹800 counters, data quality |
| `app/_pages/market-watch/page.tsx` | `weekly` + `report` tabs; dead report notice now opens a real tab |
| `components/market-watch/market-watch-live.tsx` | **§22/§24 fix** — the "Live movers" card used to sort the raw client tick map by `Math.abs(netChangePct)`; it now renders the engine's own 1% board and overlays fresher ticks without re-ranking. Gainers/losers tone comes from backend `classification`, not from the sign of a percentage. Added a `stockStates` strip. |
| `components/layout/nav.ts` | `Weekly Review` and `Report` under Services → Market Watch |
| `app/(services)/services/market-watch/{weekly,report}/page.tsx` **(new)** | route shells |

Deep links work: `?tab=weekly`, `?tab=report`.

## A.10 Configuration (all keys are `runtime setting → env → default`)

| Key | Default | Spec |
|-----|---------|------|
| `mwr_weekly_enabled` | `True` | §2 |
| `mwr_weekly_review_weekday` | `5` (Sat) | §2 |
| `mwr_weekly_review_hhmm` | `18:00` | §2 |
| `mwr_friday_scan_hhmm` | `15:25` | §2 (shared by engine + scheduler ledger) |
| `mwr_price_max` | `800` | §2 (LTP must be strictly below) |
| `mwr_margin_required` | `False` (Friday scan forces `True` per run) | §2, §17 |
| `mwr_margin_multiplier_threshold` | `5.0` | §17 |
| `mwr_intraday_required` | `True` | §2 |
| `mwr_intraday_policy` | `REQUIRE_ELIGIBLE` | §2 |
| `mwr_universe_source` | `LOCKED` | §3, §7, §35.4 |
| `mwr_lock_enabled` | `True` | §32 |
| `mwr_lock_default_user` | `operator` | §6 |
| `mwr_lock_history_retention_weeks` | `104` | §6 |
| `mwr_rupee_threshold` | `800.0` | §16 |
| `mwr_rupee_observation_interval_seconds` | `60.0` | §16 |
| `mwr_danger_circuit_pct` | `2.0` | §14 |
| `mwr_mover_threshold_pct` | `1.0` | §21 |
| `mvr_normal_threshold_pct` → `mwr_normal_threshold_pct` | `1.0` | §20 |

All are exposed at `GET /api/market-watch/config` under `weekly` and at
`GET /api/market-watch/weekly` under `config`.

## A.11 Tests

`python-service/tests/test_market_watch_weekly_universe.py` — 59 tests:

* week identity + the §6 document shape
* ADD / REMOVE / KEEP, invalid action, double lock, lock-disabled
* locked week rejects decisions; verify reports `NO_LOCKED_UNIVERSE` /
  `WEEK_MISMATCH` honestly
* `_build_locked_universe`: only locked symbols, unresolvable symbols reported
  not swapped, empty lock → empty universe
* circuit `UNKNOWN` / `SAFE` / `DANGER` / `HIT`, missing side ≠ zero distance
* ₹800 sampling + split counters + "crossing changes nothing"
* margin `UNAVAILABLE` / `BELOW_THRESHOLD` / `AUTHORITATIVE`
* movement flags, classification + precedence, stale/no-data states
* §23 payload completeness and "missing stays null"
* all 17 §30 metric names present, zero-filled vocabularies, invalid-tick counting
* board existence, DANGER exclusion from the 1% boards, 1% threshold honoured,
  Circuit Danger membership, board rows carrying the §23 contract
* weekly report honest with no data; advisory notes; weekend exclusion
* a structural guard that `mw-shared.tsx` performs no market arithmetic

Full backend suite: **1496 passed**.

Frontend: `npm test` → 392/393. The single failure
(`tests/topbar-status.test.ts` expecting `AUTHENTICATING`) is pre-existing and
unrelated — that file and `lib/topbar-status.ts` were not touched.

## A.12 Still open (deliberately not changed)

1. **`margin_required` remains off by default for live eligibility**
   (`mwr_margin_required = False`), because the live per-tick path does not
   resolve broker margin for every symbol. The Friday scan is different: it
   passes `require_margin=True` explicitly, so the 5x rule is enforced for the
   universe it locks regardless of that global switch. See A.14.
2. **Manual pins and saved filters still write to Mongo directly**
   (`services/market_watch_pins.py`, `api/market_watch.py` filters). This
   predates 2026-10-05 and is user state, not market data. §13 governs tick
   persistence, which is 100% DB-Writer-owned. Moving them behind the writer
   needs those two collections registered in `market_watch_doc_buffer.COLLECTIONS`
   **and a delete operation in the buffer**, which does not exist today:
   `remove_pin`, `clear_pins` and the filter deletes are `delete_many` calls.
   Adding deletes changes the DB Writer's contract — a different engine's
   responsibility — so it is left for its own scoped change (PROJECT
   IMPLEMENTATION_RULE §5/§37) rather than folded into a Market Watch task.
3. **Live broker verification is still outstanding** (§37). Runtime probes on
   2026-10-06 confirmed a lock now exists (`2026-W41` v1, 15 symbols,
   `universe_verify.ok=true`), so the `NO_LOCKED_UNIVERSE` condition no longer
   applies. What remains unproven is the live path itself: no tick ingestion, no
   subscription reconcile, and circuit/margin fields stayed `null` because the
   market was closed. See `docs/verification/026-...md`.
4. **`/ui` and `/sections` still poll every 12 s** on the overview, movers and
   pins tabs. §25 forbids a per-tick refetch (there is none — the tick path is
   socket-only with a 250 ms flush and a 1 s per-type render throttle), but a
   wholesale poll every 12 s is still more traffic than §26 prefers.
5. **`movers.tsx` still subscribes up to 500 raw tokens and `rank.tsx` up to
   400**, which pushes raw ticks to the browser and bypasses the engine's
   controlled publish set. Reduced-board subscriptions would close §26 fully.
6. **The weekly-draft overlay is single-process.** The in-process overlay that
   fixes the read/write skew against the DB Writer buffer (implementation 026)
   assumes one backend worker. Two workers would each hold their own draft copy.
   A shared store would be required before horizontal scaling.

---

## A.13 Weekly review, reports and stock selection (added 2026-10-07)

Implementation `docs/implementation/026-market-watch-weekly-review-report-and-stock-selection.md`
· Verification `docs/verification/026-market-watch-weekly-review-and-report.md`

### A.13.1 The review reads one week and locks another (§2, §5, §6, §32)

§2 defines two different weeks for the Saturday review, and the implementation
now names both instead of collapsing them onto the current ISO week:

| Concept | Helper | Saturday 2026-10-10 resolves to |
|---|---|---|
| Week the report **reads** | `week_id_for()` | `2026-W41` (the Mon–Fri that finished) |
| Week decisions and the **lock** apply to | `review_target_week_id()` | `2026-W42` (the week that starts next) |

`GET /api/market-watch/weekly` returns `reportWeekId`, `targetWeekId`,
`targetWeekLocked` and `nextReviewAt` so the UI never computes an ISO week.
`POST /weekly/scan` and `GET /weekly/report` keep keying the report week;
`POST /weekly/draft`, `/weekly/decision` and `/weekly/lock` now key the target
week. A Monday still targets the current week, because the week being entered may
not be locked yet.

§33 is unchanged and still holds: a LOCKED week refuses every decision.

### A.13.2 The weekly report is now generated automatically (§2 step 8)

`market_watch_engine._weekly_review_tick()` runs on the existing 1 s lifecycle
loop, evaluated **before** the §8 runtime-window gate because the review happens
after the close. It fires at most once per reviewed week, guarded by
`weekly.enabled`, `reviewWeekday`, `reviewHhmm`, and the absence of an existing
report for that week. The last guard makes a restart safe.

It only builds and stores the report. It cannot change membership — there is no
write path from that tick to the universe. `weeklyReview` in
`status_snapshot()` and `/observability` exposes the resolved schedule
(`reviewWeekday`, `reviewHhmm`, `nextReviewAt`) and the last stored report's
counts, so §30 observability no longer depends on reading config.

### A.13.3 Report reads are canonical (§26)

`GET /report/daily` and `GET /report/daily/{date}` delegate to
`services/market_watch_report.load_report` / `.recent`, which were previously
dead code. The REST layer no longer opens its own Mongo path for a Market Watch
collection. `_id` is the primary key with a `date` fallback.

### A.13.4 Correctness fixes in the review command path

| Defect | Fix |
|---|---|
| `record_decision` used `get_draft(...) or WeeklyUniverse(...)`; `WeeklyUniverse.__len__` makes a zero-symbol draft falsy, so a real draft was discarded with its `added`/`removed`/`kept` the moment its last symbol was removed | explicit `is None` check |
| `load_locked_universe` used `return _cache_loaded and _cached_universe or None`, so an intentionally **empty** LOCKED week read as "no lock at all" — risking a widened universe, which §2 forbids | explicit `is None` check |
| Sequential decisions lost each other: `get_draft` read Mongo while `persist_universe` wrote to the DB Writer's unflushed buffer | in-process draft overlay staged at the mutation call sites after a successful hand-off |
| The whole decision audit trail was silently discarded: decision documents had no `_id`, and the buffer's idempotent path drops unidentifiable documents | deterministic `_id = "<weekId>:<symbol>"`; the drop is now counted (`totalUnidentifiableDrops`) and logged |
| `lock_universe` stamped `effective_from`/`effective_to` from `week_start()` (this week) rather than the week being locked | `week_start_from_id(week_id)` |

### A.13.5 Report page

`/services/market-watch/report` renders both stored report surfaces behind a
segmented control: Daily (§26) and Weekly (§5). It reads only; it computes no
count, change or ranking (§24). The weekly table renders the §5 field set with an
ALL/ADD/REMOVE/KEEP/REVIEW filter and states that the report is advisory.
Membership still changes only in `/services/market-watch/weekly` (§32).

---

## A.14 Friday 15:25 universe scan (added 2026-10-20)

This is the implementation of the operating model in §2: the weekly universe is
built from the whole NSE EQ master by a scheduled screen, not from a hard-coded
watchlist.

### A.14.1 Schedule and guards

| Item | Value / reference |
|------|-------------------|
| Automatic time | Friday (weekday 4) 15:25 IST — `mwr_friday_scan_hhmm` |
| Trading-day guard | `market_calendar.is_trading_day(now)`; exchange holidays are skipped |
| Session guard | `SessionManager.snapshot()["active"]`; the automatic run waits for login because the MIS margin rule cannot be satisfied otherwise. Manual runs are not gated. |
| Engine entry point | `MarketWatchEngine._friday_scan_tick` |
| Dedupe key | ISO week (`week_id_for(now)`), so one completed scan per week |
| In-flight guard | `_friday_scan_running_for` + a background `asyncio.Task` |
| Failure retry | 5 minutes, never the 1 s lifecycle cadence |
| Execution | `MarketWatchEngine.run_friday_scan(triggered_by=...)` |

The lifecycle tick only decides *whether* to start the scan. The screen itself
runs in a background task because resolving prices and broker margin for the
whole market can take minutes; blocking the 1 s lifecycle loop would also block
the 15:30 stop and the EOD report.

### A.14.2 Screen semantics

`services/market_watch_weekly_scan.run_scan` gathers candidates from the
validated instrument master and asks `services/market_watch_intraday.screen_records`
to apply the rule:

| Rule | Behaviour |
|------|-----------|
| Intraday | `mwr_intraday_required=True`; `UNKNOWN` is rejected under the default `REQUIRE_ELIGIBLE` policy |
| Price | LTP must be **strictly below** `mwr_price_max` (default ₹800); an LTP equal to the cap is rejected as `PRICE_ABOVE_CAP` |
| Margin | The scan passes `require_margin=True`; a missing broker answer is `MARGIN_UNAVAILABLE`, below `mwr_margin_multiplier_threshold` (default 5x) is `MARGIN_BELOW_THRESHOLD`. The global `mwr_margin_required` switch is not consulted, because it also drives live per-tick eligibility where margin is not resolved for every symbol. |
| Provenance | Every rejection is persisted with its reason code; no stock is selected from an assumed price, margin or entitlement |

`ScanResult` reports `candidates`, `priced`, `marginRequested`,
`marginResolved`, `marginUnavailable`, `selected`, `rejected`, `reasonCounts`
and `priceSourceCounts`, and is stored in `market_watch_weekly_screen`.

Three broker contracts shape the screen:

* Kotak rejects a quote request carrying 50 symbols. `services/last_price.py`
  chunks the universe at 49 and, for this screen only, asks for LTP without a
  second OHLC round-trip.
* Kotak's margin preview carries the required order margin in
  `data.reqdMrgn` (with `data.ordMrgn` as the equivalent figure). The extractor
  reads these fields first; without them a successful broker answer would be
  misread as `MARGIN_UNAVAILABLE`.
* Kotak's `check-margin` endpoint disconnects large concurrent bursts and
  returns HTTP 429 (`stCode: 100025`, "rate limit exceeded") under sustained
  abuse. Margin resolution defaults to three calls in flight with a small
  pacing gap (`MAX_CONCURRENCY = 3`, `MARGIN_MIN_INTERVAL_SECONDS = 0.2`).
  Operators can slow a recovery run without editing code:
  `MWR_MARGIN_CONCURRENCY`, `MWR_MARGIN_MIN_INTERVAL` and
  `MWR_MARGIN_TIMEOUT` override the defaults. A full NSE EQ screen still
  reaches the quota after roughly 500 calls, so the resolver shares a
  rate-limit cooldown across all workers and retries the same symbol:
  30 s, 60 s, 120 s, 240 s, then 300 s. A persistent 429 raises
  `MarginBrokerUnavailable`; it is never recorded as a per-symbol
  `MARGIN_UNAVAILABLE`. Transport blips ("Server disconnected", timeouts) get
  2 s / 5 s / 10 s retries under a 20 s per-call ceiling, then abort the same
  way. A dropped session also raises immediately: continuing would return a
  batch of `UNAVAILABLE` answers that could be mistaken for a complete screen.
  A valid broker answer with no recognisable margin field remains a legitimate
  per-symbol `MARGIN_UNAVAILABLE` and does not abort the screen.

The quote and margin phases share one broker SDK client. If the quote endpoint
is disconnecting, concurrent quote calls can leave that client unusable and
the margin phase then times out. The normal Friday run still prices from live
quotes; an operator recovery run may call `run_scan(..., allow_broker=False)`
to price from stored candle closes and leave the client fresh for margin. The
screen doc records the resulting `priceSourceCounts` (`last_close`), so the
provenance is visible rather than implied.

A recovery run may also prime the resolver with authoritative same-day answers
from an earlier partial screen (`margin_resolver.prime`). Only the symbols
whose calls never completed are re-queried, which keeps a manual recovery
inside the broker session instead of re-spending the whole quota. The normal
Friday run never reuses a previous week's answers; primed values are the same
trading day's broker facts, and the final screen doc still records the complete
`marginRequested` / `marginResolved` / `marginUnavailable` counts.

If the SDK's HTTP/2 transport holds a `check-margin` request open without
returning a response, the operator recovery tool may replace the REST session
with HTTP/1.1 and a 14 s timeout. The application client remains HTTP/2; this
is a transport workaround for a hung stream, not a second margin
implementation.

Because a quota-hit batch is retried rather than skipped, the scan can take
20–30 minutes. The batch loop stops at the first fatal margin failure; the
engine then reports `SCAN_ERROR` and refuses to lock a partial universe.

### A.14.3 Lock, subscription and persistence

1. The survivors are handed to `market_watch_universe.lock_universe` with
   `locked_by="friday_scan_auto"` (or `friday_scan_manual`).
2. The lock target is the **upcoming** ISO week (`next_week_id_for`), because
   the current week is normally already locked. This also makes the result
   ready for Monday without a second review step.
3. The target is checked with `is_locked` **before** the expensive screen. An
   already-LOCKED week (including a restart after a completed scan) returns
   `WEEK_ALREADY_LOCKED` without resolving prices or margin — immediately for a
   manual run, and once the automatic run's session guard passes. `lock_universe`
   still enforces the same rule as a race guard (§33).
4. A partial screen is not a smaller universe. If the candidate master or any
   margin batch fails — or if no candidate gets a price, or at least one priced
   candidate was inside the price band but no authoritative margin answer came
   back — the run reports `SCAN_ERROR`, does not lock, keeps the previous
   universe, and the automatic path retries after a 300 s back-off. A complete
   screen that legitimately selects zero names (including the case where every
   priced candidate is above the cap, so no margin was requested) reports
   `NO_SYMBOLS_SELECTED` and also keeps the previous universe.
5. After a successful lock the engine calls
   `load_locked_universe(refresh=True)` before rebuilding; otherwise it would
   re-apply the previous in-memory lock.
6. `SessionManager.apply_daily_subscription_intent` records every survivor with
   `expires_at=None`, `expiry_type=None` — a session-scoped universe with **no
   expiry**, not a fabricated wall-clock expiry.
7. While the engine is inside its runtime window,
   `api.ws_engine.get_wired_engine().reconcile_broker_subscriptions()` is called
   immediately, so the live socket subscribes the new list without waiting for
   its periodic reconcile. A scan that finishes after the 15:30 stop records the
   same intent but defers the socket reconcile to the next session.
8. Ticks then follow the normal pipeline: WebSocket Engine → validated tick →
   Market Watch state/candles → DB Writer. Market Watch still never writes to
   MongoDB or opens a broker socket.

### A.14.4 Metrics and API

`status_snapshot()["metrics"]["custom"]["fridayScan"]` and
`GET /api/market-watch/weekly.fridayScan` expose the resolved schedule and the
last real outcome:

```json
{
  "enabled": true,
  "scanWeekday": 4,
  "scanHhmm": "15:25",
  "nextScanAt": "2026-10-23T15:25:00+05:30",
  "nextTargetWeekId": "2026-W44",
  "priceCap": 800.0,
  "marginMultiplierThreshold": 5.0,
  "running": false,
  "lastScan": {
    "scanWeekId": "2026-W43",
    "targetWeekId": "2026-W44",
    "symbols": 412,
    "version": 1,
    "trigger": "auto",
    "reason": null,
    "atIso": "..."
  }
}
```

Flat metrics are also set for older consumers: `fridayScanWeekId`,
`fridayScanDataWeekId`, `fridayScanSymbols`, `fridayScanAt`,
`fridayScanTrigger`, `fridayScanReason`.

Manual command: `POST /api/market-watch/friday-scan` (optional
`{"targetWeekId": "..."}`). It runs the same engine method with
`triggered_by="manual"` on any day. The response contains the scan summary
(counts and reason counts; the full per-symbol evidence is persisted in
`market_watch_weekly_screen`), the lock summary (without the non-serialisable
universe object) and the subscription result. A concurrent manual call returns
`SCAN_IN_PROGRESS` instead of starting a second full-market screen.

### A.14.5 Scheduler ledger

The scheduler records the occurrence as `market_watch_friday_scan`
(`MARKET_WATCH_FRIDAY_SCAN`) at the same `mwr_friday_scan_hhmm` time. The ledger
is deductive, like every other job: it never runs the screen. It settles
`COMPLETED` / `ALREADY_SATISFIED` only after observing
`engine._friday_scan_done_for == week_id_for(now)`, and uses the existing
`NOT_FRIDAY`, `NOT_TRADING_DAY`, `RUNTIME_WINDOW_EXPIRED` and `NETWORK_OFFLINE`
reason codes otherwise.

### A.14.6 UI

`app/_pages/market-watch/weekly.tsx` adds a **Friday universe scan** panel:

* resolved scan time, next run and target week from the backend;
* last scan symbols, universe week, version, trigger, reason and timestamp;
* a **Run Friday scan now** button that calls the manual endpoint after a
  confirmation prompt explaining that the active universe is replaced;
* no client-side screening or week arithmetic (§24).

### A.14.7 Tests

* `tests/test_market_watch_friday_scan.py` — Friday status shape, target-week
  selection, already-locked and SCAN_ERROR refusals, zero-survivor behaviour,
  concurrent-trigger guard, lifecycle start/dedupe/back-off/session guard,
  total price/margin outage classification, NSE-EQ candidate filtering,
  subscription intent and the strict price/5x rule.
* `tests/test_scheduler_ledger.py` — the `MARKET_WATCH_FRIDAY_SCAN` ledger
  settles `COMPLETED` / `ALREADY_SATISFIED`, starts catch-up while pending, and
  expires after logout instead of claiming a completion.
* Existing `tests/test_market_watch_engine.py` covers the lifecycle wiring and
  the status snapshot.
* Route coverage includes `POST /api/market-watch/friday-scan` and the
  `fridayScan` field on `GET /api/market-watch/weekly`.

### A.14.8 Deliberate behaviour

* A scan that selects zero stocks **keeps the previous universe** and records
  `NO_SYMBOLS_SELECTED`. It does not clear the lock or retry every second.
* A **partial** screen (candidate master or margin batch failure) or a **total**
  price/margin outage records `SCAN_ERROR`, never locks the survivors, keeps the
  previous universe and lets the automatic path retry after 300 s. It does not
  mark the week done. Without an active broker session the automatic tick waits
  for login instead of starting the screen; a manual run still reports the real
  failure.
* A DB-Writer rejection is reported as `NOT_PERSISTED`; the engine never writes
  directly to MongoDB instead.
* Because the Friday scan locks the upcoming week, the Saturday review is
  advisory when that target is already locked. This is the one intentional
  change to the original Saturday-only model (§2, §33, §35).
* Live broker verification (§37) is still required to prove the full screen on
  a real trading session; nothing in this section fabricates that evidence.

---
*Appendix added 2026-10-05 by static code scan plus targeted runtime probes of
pure functions. No live broker session was used; §37 live verification evidence
is still outstanding.*
*Appendix A.13 added 2026-10-07 after implementation 026 (runtime probes on a
closed market against real stored data; still no live broker session).*
*Appendix A.14 added 2026-10-20 for the Friday 15:25 scan; live broker
verification of a full scan is still outstanding.*