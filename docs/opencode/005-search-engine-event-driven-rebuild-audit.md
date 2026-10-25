# 005 — Search Engine Event-Driven Rebuild: Audit and Design Decisions

- **Purpose:** OpenCode working reference. Records the audit that preceded the
  Search Engine rebuild and the architecture decisions taken, so a future agent
  can continue without the original chat.
- **Date:** 2026-10-02
- **Agent:** OpenCode
- **Status:** Design approved, implementation in progress.
- **Governing rule:** `C:\project\PROJECT_IMPLEMENTATION_RULE.md`

Related Engine Specification: `docs/engines/search-engine.md`
Related Engine Specification: `docs/engines/margin-engine.md`
Related Engine Specification: `docs/engines/connection-manager.md`
Related Engine Specification: `docs/engines/websocket-engine.md`
Related Architecture: `docs/architecture/08_WEBSOCKET_ARCHITECTURE.md`
Related Architecture: `docs/architecture/10_MARKET_DATA_FLOW.md`
Related Implementation: `docs/implementation/018-search-engine-single-canonical-instrument-discovery.md`
Related Verification: `docs/verification/018-search-engine-single-canonical-instrument-discovery-verification.md`
Related Pending: `docs/pending/PENDING-001-live-verification.md`,
`docs/pending/PENDING-003-static-code-audit.md`

---

## 1. Governance

- `PROJECT_IMPLEMENTATION_RULE.md` read in full (2603 lines).
- Mandatory order satisfied: `docs/pending/` (all 4) → engine specs → frontend
  specs/audits → architecture → implementation/verification history.
- Highest implementation serial = `025`, highest verification serial = `025`.
  This work therefore uses `026` for both.
- `docs/opencode/` highest serial was `004`; this file is `005`.
- `docs/INDEX.md` does not exist and was not fabricated.
- `docs/backend/` exists but is EMPTY (rule #49 requires it; noted, not created).
- `docs/audits/backend/002-search-engine.md` does NOT exist, yet
  `docs/pending/PENDING-003-static-code-audit.md` task 8 names it as a required
  output. This rebuild creates it.

---

## 2. Current implementation — verified facts

### 2.1 `python-service/core/engines/search_engine.py` (717 lines)

| Fact | Location |
| --- | --- |
| `class SearchEngine(EngineBase)`, `engine_id="search_engine"`, version `2.0.0` | `:78-82` |
| Registered in `app.py` `:730` and auto-started `:748` | `app.py` |
| `LIVE_STALE_SECONDS = 30.0`, `MAX_QUERY_LENGTH = 64`, `DEFAULT_LIMIT = 10`, `MAX_LIMIT = 50` | `:34-39` |
| `_ALLOWED_SCOPES = ("stocks","pages","features","actions","watchlists")` | `:41` |
| `_build_index()` builds `_index` (term → list of instrument indices) | `:178-199` |
| `search()` iterates `enumerate(self._instruments)` — **full universe scan** | `:247` |
| `search()` **never reads `self._index`** | `:231-275` |
| `_live_state()` reads `services.tick_buffer.get_latest_ticks()` per result row | `:297-308` |
| No `EngineEventBus` subscription, no `publish`, no `state_store` usage | whole file |
| `_ltp_cache` written only by `update_ltp()`, which has **no production caller** | `:527` |
| Margin only via injected `self._margin_provider` | `:124`, `:488` |
| `status_snapshot()` extends `EngineBase.status_snapshot()` | `:705-713` |

**Defect D-SE-1 (performance):** the index is built but unused. Every keystroke
scores all instruments. Requirement "no full-universe scan per keystroke" is
violated.

**Defect D-SE-2 (event-driven):** the engine is request/response only. It has no
event subscription, so it cannot project live state, detect freshness
transitions, or push anything.

### 2.2 `python-service/api/search.py` (253 lines)

| Fact | Location |
| --- | --- |
| Imports `from auth.kotak_client import kotak_session` | `:23` |
| Calls `kotak_session.async_margin_required(...)` **directly from the API layer** | `:112-120` |
| `_MARGIN_TTL_SECONDS = 15.0`, `_MARGIN_PRODUCT = "MIS"` | `:36-37` |
| `_margin_cache: dict[tuple, tuple[float, Optional[float]]]` — **unbounded** | `:38` |

**Defect D-SE-3 (ownership):** the API layer bypasses the Margin Engine and calls
the broker session directly. This violates "MARGIN AND FUNDS DATA → SINGLE
MARGIN ENGINE" and the websocket-engine rule that the Broker Terminal is the only
broker boundary.

**Defect D-SE-4 (recorded, previously unfixed):** `docs/FINAL_REPORT.md:655-656`
already states "`api/search.py` `_margin_cache` is unbounded
(`_MARGIN_TTL_SECONDS = 15.0`) — observed, not changed." Unbounded growth on every
new (segment, token) pair.

### 2.3 `python-service/core/engines/margin_engine.py` (239 lines)

- Registered `app.py:731`, **not** auto-started (absent from `app.py:748-752`).
- `get_margin_info(terminal)` → `adapter.funds()` — the one correct broker path.
- `validate_order()` computes `order_value * 0.20  # 20% intraday margin`
  (`:124`) — a **fabricated margin estimate**.

**Defect D-ME-1 (out of scope, recorded):** `validate_order` fabricates margin.
This rebuild does not use it and does not modify it; it is recorded for a separate
task because the rule set forbids deriving margin from leverage.

### 2.4 Canonical plumbing verified

| Concern | Owner | Verified fact |
| --- | --- | --- |
| Broker market socket (WS#1) | `ws_socket/ws_manager.py` | single `SFeedWebSocket` owner |
| Subscription intent | Session Manager | `ws_socket/engine/engine.py:340-431` merges registry intents + pins + `market_watch` + `session_manager` |
| Registry | `ws_socket/engine/registry.py` | `add_instrument`, `raw_intents`, `desired`, `broker_diff` dedup by `InstrumentKey` |
| Engine event bus | `services/engine_event_bus.py` | `subscribe(event_types)` returns an `asyncio.Queue`; `EngineEvents.TICK_VALIDATED` |
| `TICK_VALIDATED` payload | `ws_socket/engine/engine.py:306-335` | keys: `instrumentToken, exchangeSegment, symbol, ltp, lastPrice, volume, timestamp, open, high, low, prevClose, netChange, netChangePercent, receivedAt, brokerUpdateTimestamp, source` (+`masterCanonical`) |
| Engine → browser | `services.event_bus.get_event_bus().publish(frame)` | precedent `services/market_watch_engine.py:1284,1332-1335` |
| Frame fan-out | `connection_engine/connection_engine.py:911-938` `_bridge_loop` → `_broadcast_frame` `:1132` | drains `state_store` **and** `event_bus` |
| Browser endpoint | `api/ws_gateway.py` `WS /ws/realtime` | one route, logical channels multiplexed |
| Channel catalogue | `connection_engine/channels.py` | 4 market + 7 state channels |

**Verified registry fact:** `raw_intents()` (`registry.py:145`) snapshots every
consumer bucket, and `_sync_desired()` (`engine.py:348`) rebuilds from it. Any
consumer registered via `registry.add_instrument` survives reconciliation.

**Verified channel-routing fact:** `_route_state_channel`
(`connection_engine.py:249-269`) special-cases the `market_watch.` prefix. A
`search.` prefix currently falls through to `"system"`.

---

## 3. Requirement conflicts found (rule #38 — requirement change rule)

### C-1 Margin ownership

- `docs/engines/search-engine.md` §14.1: margin "comes only from the
  authoritative broker provider", owner recorded as "Broker margin authority"
  (`docs/implementation/018-...md:47`).
- `docs/engines/margin-engine.md` §1/§3: per-instrument margin display is
  explicitly **not** the Margin Engine's job; it owns AI capital allocation.
- `docs/engines/search-engine.md` §26: "Margin Engine — Margin data/calculation
  authority where applicable".
- New task requirement: margin availability/status must be queried from the
  canonical Margin Engine.

**Resolution:** the AI-allocation ownership of the Margin Engine is unchanged.
The specification change is narrow and additive: the Margin Engine becomes the
**single read owner of broker required-margin and funds**, exposing a read-only
per-instrument query. The Search Engine consumes it. `api/search.py` stops
importing `kotak_session`. Both specs are updated before code.

### C-2 Subscription authority

- `docs/engines/websocket-engine.md` §5: "Session Manager is the source of the
  active subscription list." §3: "Session Manager owns instrument subscription."
- New task requirement: selection must yield live state through the shared broker
  connection with no duplicate connection.

**Resolution:** the Search Engine does **not** register its own broker intent.
Selection is a UI-level act; the browser issues the canonical
`{"action":"subscribe","channels":[{"channel":"trading","instruments":[...]}]}`
command on `WS /ws/realtime`, which the Connection Manager turns into a
`WS_CLIENT` registry intent. The registry dedupes to exactly one broker
subscription. Zero new broker connections. Session Manager and WebSocket Engine
ownership is untouched.

### C-3 Two price streams

- `docs/architecture/08_WEBSOCKET_ARCHITECTURE.md:19`: the flow must be
  `WebSocket Engine → Event Bus → {…, Connection Manager}`, never a chained
  re-broadcast. `:184`: "Connection Manager never calculates risk/margin".
- `docs/engines/websocket-engine.md` §31: "The engine should not become a general
  UI broadcast server."
- New task requirement: a dedicated `search.instrument.live.updated` realtime
  event carrying ltp/change/circuit/freshness.

**Resolution:** one consumption, two projections, no duplicate tick stream. The
Search Engine subscribes once to `TICK_VALIDATED` and builds its own bounded
projection. The canonical `market.*` frames remain the browser's authoritative
price path. `search.instrument.live.updated` is a **coalesced, state-change-gated
mirror** of the Search Engine's own projection plus freshness/lifecycle/margin
state, emitted at most once per second per instrument and only when the projection
actually changed. The frontend merges monotonically by `brokerTimestamp`, so no
flicker and no double-processing.

---

## 4. Design decisions

**D1 — Event-driven live state.**
Subscribe to `EngineEvents.TICK_VALIDATED`, `WEBSOCKET_CONNECTED`,
`WEBSOCKET_DISCONNECTED`, `WEBSOCKET_RECONNECTED`, `MARKET_CLOSED` via
`get_event_bus().subscribe([...])`, draining in a task, exactly the
`services/market_watch_engine.py:307` pattern. Maintain a bounded projection for
tracked instruments only. `services/tick_buffer` remains a bootstrap fallback for
instruments not yet tracked, with the source reported honestly.

**D2 — Real index, no per-keystroke scan.**
Keep the documented deterministic ranking, but reach candidates through:
exact-term map, bisect over a sorted symbol list, and a bounded word-prefix map.
Only candidates are scored. Determinism and ranking order are unchanged; the
universe scan is removed.

**D3 — Selection without a second broker path.**
`select_instrument()` records selection state, ensures the instrument is tracked,
and returns the canonical subscription descriptor. It never opens a socket.

**D4 — Dedicated realtime contract.**
New state channel `search`; `_route_state_channel` gains a `search.` prefix rule;
frames published through `services.event_bus`. Payload carries only what the
frontend needs. No raw broker payloads, no depth ladder, no order context.

**D5 — Margin through the Margin Engine.**
`MarginEngine.required_margin()` is the single broker-margin caller: read-only,
TTL-cached with a bounded LRU, returning
`{margin, status, source, reason}` using the documented vocabulary. `api/search.py`
calls it and no longer imports `kotak_session`.

**D6 — Bounded memory everywhere.**
Projection, recent list, and margin cache all have explicit caps.

**D7 — Preserve public API.**
`normalize_query`, `search`, `search_scoped`, `reject_stale`,
`instrument_count`, `status_snapshot`, `register_provider`, `set_margin_provider`
keep their signatures so `api/search.py`, `api/stocks.py`, `api/trading.py` and
`tests/test_search_engine.py` keep working.

---

## 5. Known limitations

- Live broker verification is NOT possible in this session; the final status must
  be `IMPLEMENTED_NOT_VERIFIED` or `VERIFIED_WITH_LIMITATIONS`.
- `docs/engines/search-engine.md` §6 non-instrument scopes (pages, features,
  actions, watchlists) remain the pre-existing provider stubs. They are preserved,
  not extended. Recorded as remaining work.
- `docs/architecture/03_ENGINE_DEPENDENCY_GRAPH.md` omits `search_engine`. Needs
  updating once the dependency set changes.
- `docs/FINAL_REPORT.md:171` records an engine-count conflict (17 in code vs 15 in
  documents). Registering/starting engines changes the count and the doc must be
  reconciled.