# Market Watch — Implementation Audit

**Specification:** `docs/engines/MARKET_WATCH.md`
**Implementation:** `python-service/`
**Audit date:** 2026-09-26
**Companion:** `docs/engines/MARKET_WATCH_REALTIME_AUDIT.md`

---

## 1. Verdict

The Market Watch feature is implemented as **one canonical engine** with a thin
read-only REST surface, one broker subscription bucket, and DB-Writer-owned
persistence. The spec's realtime intent is met. Two spec defects were found and
resolved explicitly (circuit policy, unreachable lifecycle phases); one
architectural violation in the engine (direct broker-client read) was found and
removed during this audit.

**Not production-signed-off**, because no live broker session was available.
See §7.

**New in this pass** (completed after the original audit):

- **Tick-saving on/off toggle** (doc §23): the operator can now flip
  `persistTicks`, `persistCandles`, `persistDecisions` at runtime via
  `GET/POST /api/market-watch/tick-saving` or the Settings UI. The toggle is
  live (takes effect on the next tick), honest (drops backlog on disable), and
  reported in engine status. Three defects were fixed to make this work:
  `mw_bool` now honours the env tier, the settings keys are registered in
  DEFAULTS + LIVE_KEYS, and the document buffer has a per-collection enable
  gate.
- **Candle recovery bug fixed** (audit L6): `state._timeframes` →
  `state.timeframes` so restored candles are no longer a silent no-op.
- **Missing indexes added** (audit L4): `market_ticks` and all four
  `market_candles_*` collections now have the indexes required for recovery and
  time-range queries.
- **Two dead Settings controls removed**: `ws_tick_persistence` and
  `ds_live_tick_collection` claimed `apply: 'live'` but had zero backend
  readers. They are hidden from the UI; the real tick-persistence switches are
  `ds_collection_enabled` (Data Saver raw ticks) and `mwr_persist_ticks`
  (Market Watch ticks).
- **Stale docs updated**: the "contradiction" in D1 was a documentation drift,
  not a code defect; the code already requires an operator JWT in secure mode.

## 2. Module inventory

| Module | Responsibility |
|---|---|
| `services/market_watch_config.py` | all configuration, reason vocabulary, band policy, lifecycle boundaries |
| `services/market_watch_state.py` | `SymbolState`, `IndexState`, `TimeframeState` |
| `services/market_watch_timeframes.py` | 1m/5m/10m/30m aggregation, storage round-trip, recovery, committer |
| `services/market_watch_filters.py` | price + per-timeframe movement filters |
| `services/market_watch_eligibility.py` | the ordered rule chain and margin consumption |
| `services/market_watch_ledger.py` | daily block/re-entry ledger |
| `services/market_watch_lifecycle.py` | IST phase machine |
| `services/market_watch_indexes.py` | real index tracking |
| `services/market_watch_ranking.py` | official boards + pin tracking |
| `services/market_watch_publish.py` | WS contracts, publish set, coalescing |
| `services/market_watch_doc_buffer.py` | bounded, DB-Writer-owned buffer |
| `services/market_watch_report.py` | EOD report |
| `services/market_watch_engine.py` | the single orchestrator |
| `api/market_watch.py` | REST read surface over the engine |
| `api/ws_gateway.py` | WS#4 command routing |
| `ws_socket/engine/engine.py` | the only writer of the `market_watch` intent bucket |
| `services/db_writer_engine.py` | the only owner of Market Watch persistence |

## 3. Defects found and fixed in this pass

Each was a real behavioural defect, not a style change.

| # | Defect | Impact | Fix |
|---|---|---|---|
| 1 | Index tokens dropped | every index tick discarded | process index before the equity lookup (`engine.py:738`) |
| 2 | `apply_price_tick` called with wrong kwargs | no state ever updated | corrected keyword names |
| 3 | VWAP accumulated as a price average | wrong VWAP on every candle | accumulate real traded turnover only |
| 4 | Cumulative volume used as bucket volume | every candle overstated volume | in-bucket volume deltas only |
| 5 | Single tick produced a VWAP | fabricated statistic | VWAP stays `None` until turnover exists |
| 6 | Candle recovery assigned a raw dict to `TimeframeState` | `AttributeError` on restart | `from_storage_doc(row)` |
| 7 | `tfs.change` used instead of `price_move` | movement filters read a non-existent field | `TimeframeState.price_move` throughout |
| 8 | `REASON_FILTER_FAIL` used but not imported | `NameError` on every filtered evaluation | imported (`eligibility.py:35`) |
| 9 | Margin allow/deny lists inverted | wrong symbols admitted/excluded | explicit allow-set decision, deny-set pass-through |
| 10 | `SUBSCRIBED` unreachable | a lifecycle phase that never occurred | added `filter_start` (09:11) |
| 11 | `FINAL_MONITORING` unreachable | same | added `final_monitoring` (15:05) |
| 12 | Show More paged the capped board | universe silently truncated | pages the full eligible universe |
| 13 | Circuit band computed as full width | thresholds applied to the wrong scale | per-side `(upper−lower)/2` |
| 14 | `dayResetTo` metric never set; stray `_prev_publish_count` | misleading observability | metric restored, stray attribute removed |
| 15 | Document buffer double-counted idempotent writes | inflated write counters | count only real writes |
| 16 | Document buffer used a function-level global counter | cross-call contamination | instance counter |
| 17 | GET-only Next.js bridge | every pin and filter action returned 405 | POST/DELETE forwarded |
| 18 | `lib/realtime-ws.ts` was BOM + mojibake encoded | `read_text()` crashed on Windows | repaired to valid UTF-8; the test now reads `utf-8-sig` |
| 19 | Parallel batch scanner on the REST request path | a second Market Watch implementation | REST rewritten as an engine read; 53 dead defs / ~800 lines deleted |
| 20 | Engine read `kotak_session.intraday_available` | architecture §5 boundary violation | Session Manager + adapter registry only; unknown stays `None` |
| 21 | `/history` and `/progress` described a removed scanner | endpoints lied about their own mechanism | decisions collection and engine lifecycle state |
| 22 | Phase-2 progress/history adapters and their page still typed the deleted batch scanner | UI would render counts the backend no longer produces | reconciled to engine counters and the decision ledger |
| 23 | `/history` sorted on `decidedAt`, a field no writer sets | history silently unordered | sorts on `blocked_at`, the field the ledger writes |
| 24 | `/history` `symbol` / `date` assigned as local `Query` objects | never bound as params; any `symbol` filter raised `AttributeError` | moved into the signature |
| 25 | `market_watch_decisions` had no index; orphaned `market_watch_scans` index remained | unindexed ledger reads; stale index | four decision indexes, scanner index removed |
| 26 | `/progress` read `engine._index_version` (private) | route coupled to engine internals | reads the public `status_snapshot()` |

### 3.1 The circuit-policy spec defect

doc §7's example policy ("20% circuit → block at 18%") is dimensionally
impossible. Distance is measured against the circuit price, so the maximum
attainable distance in a band of `b` is `b/(1+b) × 100` — 16.67% for a 20% band.
An 18% block threshold blocks **every** symbol in a 20% band, including one on
its previous close.

Resolution: ship defaults as a fraction of the attainable distance (block 30%,
near 50%), keep the doc's numbers in `DOC_CIRCUIT_EXAMPLE_POLICY`, keep both
operator-overridable, and pin the degeneracy with a regression test. Full
reasoning in the realtime audit §5.

## 4. Spec conformance

| doc § | Requirement | Status |
|---|---|---|
| §5 | one canonical engine, no parallel implementation | met (defect 19) |
| §6 | ordered rule chain, first failure recorded | met |
| §7 | circuit distance from real circuit prices | met, with the documented policy correction |
| §8 | 09:14 frontend rule | met via lifecycle |
| §9 | official ranking boards, config-capped | met |
| §10 | one tick updates one symbol | met |
| §11 | 1m/5m/10m/30m, real VWAP | met (defects 3-5) |
| §12 | Top-5 pins, pin-change events | met |
| §13 | eligible-count states | met |
| §14 | circuit-near as a ranking signal, not a block | met |
| §15 | controlled publish set, coalescing | met |
| §16 | Show More over the full universe | met (defect 12) |
| §17 | full-universe search | met |
| §21 | day rollover resets every day-scoped component | met |
| §23 | live config surface | met |
| §25 | observability / status | met |
| §26 | EOD report | met, `blocked` flag added per row |
| §27 | DB Writer persistence | met |

## 5. Test evidence

```
tests/test_market_watch_spec_modules.py ..............  147 passed
tests/test_market_watch_engine.py + filters + ranking + pins  124 passed
tests/test_market_watch_route.py ......................  27 passed
full python-service suite .............................  1159 passed, 0 failed
npx tsc --noEmit (frontend) ...........................  clean
```

The 2 previously-reported failures are **resolved**:

1. `tests/test_realtime_gateway.py::test_secure_requires_operator_jwt` —
   the code at `api/ws_gateway.py:132-136` already requires an operator JWT when
   `APP_PASSWORD` is set and answers 401 otherwise. The audit docs were stale;
   the test now passes (14/14). No code change was needed.
2. `tests/test_watchlist_engine.py::test_connecting_when_session_active` —
   watchlist card status, unrelated subsystem. Now passes.

The new suite is deterministic and DB-free: it seeds the engine directly and
uses no broker session, no MongoDB, and no wall-clock dependence.

## 6. Frontend contract

`app/api/market-watch/[...path]/route.ts` is a thin passthrough for GET, POST
and DELETE. The Market Watch pages mutate pins and saved filters over POST and
DELETE, so the previous GET-only bridge made those actions fail with 405.

The two phase-2 Data Saver adapters were still describing the deleted batch
scanner, which would have shown the user counts the backend no longer produces:

| Adapter | Was | Now |
| --- | --- | --- |
| `app/api/phase2/watch/progress/route.ts` | `currentBatch`, `totalBatches`, `nextBatchInSec`, `quoteStats`, `roundComplete` | `feedState`, `lifecycle`, `universe.{total,known,eligible}`, `subscribed`, `withLivePrice`, `statusCounts` |
| `app/api/phase2/watch/history/route.ts` | `scans` (scan-run journal that nothing writes) | `decisions` from `market_watch_decisions`, with `symbol` and `date` filters |

`app/(phase2)/data-saver/watch/page.tsx` was reconciled to match:
`BatchProgress` became `EngineProgress` (lifecycle phase, known / eligible /
subscribed / priced, status counts), and `ScanHistoryRow` / `ScanHistoryPanel`
became `DecisionRow` / `DecisionHistoryPanel`, which renders the real block
reason, threshold, observed value and circuit band per symbol.

`/history` also had a latent bug: `symbol` and `date` were assigned as local
`Query` objects inside the function body, so FastAPI never bound them as query
parameters and any `symbol` filter would have raised `AttributeError` on
`Query.upper()`. They are now real parameters, and `history` sorts on
`blocked_at` — the field the ledger actually writes — instead of a
`decidedAt` that no writer ever set. `market_watch_decisions` gained the
indexes those reads need; the orphaned `market_watch_scans` index was removed.

`lib/realtime-ws.ts` was repaired from BOM + mojibake to valid UTF-8. Its
`correlation_id` and `placeOrder` contract is asserted by
`tests/test_ws_gateway_commands.py`, which now reads `utf-8-sig` so a Windows
ANSI default codec cannot fail it again.

## 7. Outstanding risk — read before trusting this in market

1. **No live verification.** No broker credentials, market hours or MongoDB
   were available. Circuit field formats, index token resolution, and Session
   Manager margin publication are unproven end to end.
2. **Candle recovery is bounded.** Buckets older than process start are
   `INCOMPLETE`, and the report publishes the count rather than guessing.
3. **Re-entry is data-driven only.** `DATA_INVALID` re-enters automatically;
   a business or margin block does not, because the engine has no
   authoritative signal that it changed.

**Resolved risks (previously listed):**

- Circuit policy: shipped defaults (30%/50% of attainable distance) are
  authoritative; doc §7 corrected; the doc's literal numbers remain available
  as `DOC_CIRCUIT_EXAMPLE_POLICY` for traceability.
- "Unrelated security contradiction" in the gateway: this was a documentation
  drift — the code at `api/ws_gateway.py:132-136` already requires an operator
  JWT in secure mode. The test `test_secure_requires_operator_jwt` passes.
- `market_ticks` / `market_candles_*` missing indexes: now present.
- Candle recovery silent no-op: `state._timeframes` → `state.timeframes`.
- Dead Settings controls (`ws_tick_persistence`, `ds_live_tick_collection`)
  claiming `apply: 'live'`: removed from UI schema; real switches are
  `ds_collection_enabled` and `mwr_persist_ticks`.
