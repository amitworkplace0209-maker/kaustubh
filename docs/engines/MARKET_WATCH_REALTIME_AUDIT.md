# Market Watch — Realtime Audit

**Scope:** `docs/engines/MARKET_WATCH.md` as implemented in `python-service/`
**Audit date:** 2026-09-26
**Method:** static source audit + deterministic unit/regression execution (no broker session required)

---

## 1. What Market Watch is allowed to touch

| Allowed | Forbidden | Enforcement |
|---|---|---|
| Canonical Event Bus (`TICK_VALIDATED`) | Kotak client / any direct broker call | engine subscribes to the bus; no broker import in `services/market_watch_*.py` |
| WebSocket Engine subscription intents | Its own broker socket | intents are published into the shared `market_watch` bucket; `ws_socket/engine/engine.py:341-364` is the only writer |
| Session Manager margin decisions | Computing broker margin | `margin_decision()` reads a published decision or reports "no authoritative decision" |
| DB Writer buffered persistence | Synchronous MongoDB writes | `market_watch_doc_buffer` → DB Writer |
| Instrument master (read) | A second universe builder | one `_build_universe()` in `services/market_watch_engine.py:450` |
| Order placement | — | no order path exists in the engine |

Verified: no `kotak` / `async_quote` / `order_place` import in any
`services/market_watch_*.py`.

## 2. Realtime data path

```
broker WS#1/#2  ->  Connection Manager  ->  Engine Event Bus
                                              |  TICK_VALIDATED
                                              v
                            MarketWatchEngine._process_tick()      (engine.py:1067)
                                    |
                    +---------------+----------------+
                    |                                |
        typed SymbolState + TimeframeState    eligibility + block ledger
        (1m/5m/10m/30m, VWAP from          (data -> instrument -> business ->
         real traded volume)                price -> circuit -> liquidity -> margin)
                    |                                |
                    +---------------+----------------+
                                    v
                       publish_policy  --(coalesce 250ms)-->  WS#3 to frontend
                                    |
                                    v
                      market_watch_doc_buffer --(3s flush)-->  DB Writer
```

Index tokens are consumed by `index_tracker.apply_tick()` **before** the
equity-state lookup (`engine.py:738`), so index ticks are never dropped and
never enter the equity universe.

## 3. Cadence (resolved configuration)

| Loop | Interval | Source |
|---|---|---|
| Official rankings | 30 s | `MWR_RANKING_INTERVAL_SECONDS` |
| Timeframe candle commit | 5 s | `MWR_TIMEFRAME_COMMIT_INTERVAL_SECONDS` |
| Status broadcast | 10 s | `MWR_STATUS_INTERVAL_SECONDS` |
| Index publish | 1 s | `MWR_INDEX_PUBLISH_INTERVAL_SECONDS` |
| Universe refresh | 300 s | `MWR_UNIVERSE_REFRESH_SECONDS` |
| Stale threshold | 30 s | `MWR_STALE_THRESHOLD_SECONDS` |
| No-data threshold | 3 × stale (90 s) | `MWR_NO_DATA_MULTIPLIER` |
| Publish coalesce | 250 ms | `MWR_PUBLISH_COALESCE_MS` |

Cadence is configuration-driven; no value is hardcoded in a loop.

## 4. Lifecycle (IST, resolved)

| Phase | Time | Meaning |
|---|---|---|
| `PRE_MARKET` | 09:00 | registry built, no ticks expected |
| `DISCOVERY` | 09:10 | scan the real master |
| `FILTERING` | 09:11 | filters evaluated on real metrics |
| `SUBSCRIBED` | 09:14 | intents published to the WS Engine |
| `ACTIVE` | 09:14 | continuous high-frequency publish |
| `FINAL_MONITORING` | 15:05 | no new promotions |
| `STOPPED` | 15:15 | Market Watch intents released only |
| `REPORTING` | 15:20 | EOD report built |
| `REPORT_READY` | 15:25 | report published |

Every phase is reachable: `filter_start` exists so `DISCOVERY`/`FILTERING`
are non-empty, and `final_monitoring` exists so `FINAL_MONITORING` is
reachable. At 15:15 the engine clears only its own intents — the global
broker socket and every other engine continue.

## 5. Circuit-distance policy — a spec defect, and the chosen resolution

doc §7 defines distance against the circuit price and gives this example:

```
5% circuit  -> block at 3%
10% circuit -> block at 8%
15% circuit -> block at 13%
20% circuit -> block at 18%
```

Distance is `(circuit − ltp) / circuit × 100`. The **largest distance a symbol
can ever have inside a band of `b` percent is `b/(1+b) × 100`** — 16.67% for a
20% band. A block threshold of 18% therefore blocks **every** stock in a 20%
band, including one sitting exactly on its previous close, and the engine
would have no eligible universe at all.

The doc labels those numbers "configurable thresholds, not universal market
facts", so the implementation:

* ships defaults expressed as a **fraction of the attainable distance** —
  block at 30%, circuit-near ranking signal at 50%:
  `{2: 0.6, 5: 1.5, 10: 2.7, 20: 5.0}` and
  `{2: 1.0, 5: 2.5, 10: 4.5, 20: 8.3}`;
* keeps the doc's example verbatim in `DOC_CIRCUIT_EXAMPLE_POLICY` so it stays
  referenceable and auditable;
* leaves both fully operator-overridable via `MWR_CIRCUIT_BLOCK_PCT` /
  `MWR_CIRCUIT_NEAR_PCT`;
* pins the degeneracy as a regression test
  (`test_a_threshold_above_the_attainable_distance_would_block_everything`).

Band lookup matches the exact band, else the **nearest** configured band,
because brokers publish bands such as 19.98% rather than a round 20%.

## 6. Honesty audit — fabrication checkpoints

| Value | Behaviour when unavailable |
|---|---|
| LTP / OHLC / volume | `None`; status `PENDING` → `NO_DATA` after 3 × stale |
| VWAP | `None` until real traded turnover exists; never a price average |
| Circuit prices | distance `None`; never inferred from daily change % |
| Margin decision | `MARGIN_INELIGIBLE` + "no authoritative margin decision" |
| Index levels | omitted; never substituted |
| Ranking | a symbol with no `changePercent` sorts last, in both directions |
| EOD report | a symbol with no tick appears in no ranking; blocked symbols stay ranked but are flagged `blocked: true` |
| Show More | pages the whole eligible universe, never truncated at the board cap |

## 7. Frontend command path (WS#4)

`api/ws_gateway.py` routes a `market_watch.*` action to
`market_watch_engine.handle_ws_command()` (`ws_gateway.py:463`,
handler at `:614`), answers the requesting session with a correlated
`request_id`/`correlation_id` acknowledgement, converts `market_watch.error`
into an error frame, and publishes successful events to the bus.

Verified command coverage in `tests/test_market_watch_spec_modules.py`:
show-more paging, pin/unpin, snapshot, and missing-`request_id` rejection.

## 8. Execution evidence

```
tests/test_market_watch_spec_modules.py ....... 127 passed
tests/test_market_watch_engine.py + filters + ranking + pins ... 124 passed
full python-service suite ..................... 1110 passed, 2 failed
```

The 2 failures are pre-existing and outside Market Watch; both reproduce in
isolation and touch no Market Watch file:

* `tests/test_realtime_gateway.py::test_secure_requires_operator_jwt` —
  `get_realtime_token` deliberately allows anonymous bootstrap issuance.
* `tests/test_watchlist_engine.py::test_connecting_when_session_active`.

All Market Watch modules and `api/ws_gateway.py` byte-compile cleanly.

## 9. Residual risks

1. **No live-session verification.** Every result above is static or
   deterministic unit evidence. Circuit formats, index token availability and
   margin-decision publication are unproven against a live broker feed.
2. **Circuit policy is an operator decision.** The shipped defaults are
   defensible but opinionated; a desk may want the doc's literal numbers,
   which will disable a 20% band entirely.
3. **Re-entry is data-driven only.** A symbol blocked for a data reason
   (`DATA_INVALID`) re-enters automatically; a business/margin block does not,
   because the engine has no authoritative signal that it changed.
4. **Candle recovery is bounded.** Buckets older than the process start are
   marked `INCOMPLETE` rather than reconstructed; the report states the count.
