# MARKET WATCH ENGINE — IMPLEMENTATION AUDIT REPORT

- Project: KDS / KAUSTUBH Trading Terminal
- Engine: Market Watch Engine
- Broker / data source: Kotak Neo (SDK `kotakneoapi 3.0.6`, verified in `.venv`)
- Report type: FORENSIC CODE-TRACE AUDIT (read-only; no code modified)
- Audit date: 2026-09-22
- Source of truth (doc): `docs/engines/MARKET_WATCH.md` (34 numbered design sections)
- Status claimed (previous report): `docs/engines/reports/MARKET_WATCH_ENGINE_IMPLEMENTATION_REPORT.md`
- Companion design-architecture docs surveyed: `docs/architecture/*`, `docs/engines/connection-manager.md`, `docs/KOTAK_NEO_WEBSOCKET_COMPLETE_CAPABILITY_AUDIT.md`

---

## 1. Report Metadata

| Item | Value |
|---|---|
| Audit mode | Static + trace-only (PowerShell-safe read/grep). No execution, no mutation. |
| Evidence standard | `FILE:LINE` citations only. Inference labelled exactly. |
| Scope | Full market-watch stack: Kotak feed → WebSocket engine → Market Watch engine → API → Realtime channel → Vercel UI. |
| Verification status | STATIC COMPLETE / RUNTIME UNVERIFIED (see §30). |
| Classification legend | A1 = Implemented · B2 = Partial · C3 = UI-only / mocked · D4 = Missing / Broken (D4b). |

---

## 2. Executive Summary

Market Watch Engine is designed as the full-market intraday discovery engine on the Kotak Neo real-time feed
(`docs/engines/MARKET_WATCH.md` §§1–2). The audit performed a full end-to-end trace of **every design section**
against working backend and frontend code under `C:\project`.

**Result: the design is realized in code across the entire pipeline.** The real feed path
(Broker WebSocket → TICK_VALIDATED → live state → sections/rank/filters/pins → REST + realtime → Vercel UI) is
continuously wired, the correctness layer (unknown ≠ safe, broker-product eligibility, never-fabricate) is
enforced in unit-testable pure logic, and unit tests back the contract-critical subsystems. The one
documented-but-not-full divergence is **full 5-level live depth over the WebSocket** (depth is served from a
REST snapshot with live touch-line overlay; a full WS depth ladder is not confirmed flowing).

**Critical caveat:** every "implemented" verdict above is a *code-path* verdict. The audit did **not** observe a
running broker session, live ticks, live ranking cadence, or served frontend. Runtime verification status is
UNKNOWN and is the #1 item before live use (§34).

---

## 3. Audit Method & Evidence Standards

1. Read the design doc `MARKET_WATCH.md` fully; enumerated its 34 sections (§1–§34).
2. Read the previous report `MARKET_WATCH_ENGINE_IMPLEMENTATION_REPORT.md` to enumerate claims to verify.
3. Traced each feature/claim to code using `FILE:LINE` evidence across 5 layers (feed → engine → API → channel → UI).
4. Classified per the legend in §1. Rules:
   - IMPLEMENTED (A1) requires the **full path** to work in code: event/API existence alone is not proof.
   - B2 PARTIAL requires a real, working subset with a documented missing/different part.
   - C3 UI-ONLY/MOCKED requires the UI to consume fabricated/static data or a page with no backend.
   - D4 MISSING requires a documented feature with zero code support.
5. Forensic dumb/dummy/mock audit: searched the whole service tree for fake-data arrays, hardcoded prices,
   placeholder symbols, and demo-module leakage into the market-watch path.
6. Runtime-level claims are kept explicitly separate from code-level claims (§30).

**Ground rules (enforced throughout):**
- Never modify any file.
- Every conclusion carries evidence; not verifiable = UNKNOWN, not "implemented".
- `api/demo.py` + `services/dummy_extras.py` are treated as a separate demo surface and flagged as such, never
  as proof of market-watch behaviour.

---

## 4. System Under Audit — Overview

Designed pipeline (`MARKET_WATCH.md` §2 "Core Principle"):

```
Kotak Neo
   ↓  (WebSocket Engine: subscribe/tick/normalize/validate)
Normalized TICK_VALIDATED events
   ↓  (Market Watch Engine)
Live Market State over the daily eligible universe
   ↓   Ranking / Filter index every 30 s  (decoupled cadence, feed frequency ≠ ranking frequency)
UI Sections
   ↓  (Connection Manager realtime frames + REST)
Vercel UI (Overview / Movers / Rank / Filters / Pins / Symbol)
```

Real code mapping (single continuous trace):
- Kotak feed client: `.venv/.../neo_api_client/websocket/feed/{client,protocol,models}.py`
- Ingress: `ws_socket/engine/engine.py::on_feed_message` → `TICK_RECEIVED`, `TICK_VALIDATED`
- Engine: `ws_socket/ws_manager.py::_process_tick` (`:1234`), `services/market_watch_engine.py`
- Feed-state/market-state handoff: `ws_manager.py:1268–1275`
- API: `api/market_watch.py`, pure logic `api/market_watch_engine.py`
- Realtime fan-out: `connection_engine/connection_engine.py`, `connection_engine/channels.py`
- Real-time auth WS: `api/ws_gateway.py`
- UI: `app/_pages/market-watch/*`, `lib/realtime-ws.ts`

---

## 5. Reality vs Documentation Ground Rules

- A page/route existing **is not** proof. Only the full working path counts (criterion §2 in the doc is honoured).
- The doc's §16 "UI Data Strategy" (controlled publish, not raw tick flood) is realised via subscription-driven
  state + channel min-interval throttling — verified (§11).
- The doc's §27 "Data Integrity, Unknown ≠ Safe" is realised in pure logic with unit tests — verified (§8, §15).
- Depth (§"Market Data"): document ⇒ real order book; code ⇒ REST snapshot + WS touch-line only — the **single B2**.
- Doc section numbers below map to `MARKET_WATCH.md` headings by name (headings are numbered 1–34).

---

## 6. Highest-Level Result

| Layer | Result | Evidence |
|---|---|---|
| Broker feed ingestion | A1 (code) | `ws_manager.py:1234`; `engine.py:148-151` |
| Universe & eligibility | A1 | `instrument_cache.py:128-151,240-298`; `api/market_watch_engine.py:215-297`; `market_watch_engine.py:293` |
| Live market state | A1 (code) | `market_watch_engine.py:555,606` |
| 30 s ranking + pins | A1 | `market_watch_ranking.py`; `market_watch_engine.py:812-917` |
| Sections / movers | A1 | `market_watch_engine.py:964-1106`; `api/market_watch.py:1920` |
| Filters | A1 | `market_watch_filters.py`; `api/market_watch.py:1981-2113` |
| Rank / search / page / symbol | A1 | `api/market_watch.py:2162,1939,2313,2261` |
| Realtime end-to-end | A1 (code) | `api/ws_gateway.py`; `connection_engine/*`; `lib/realtime-ws.ts` |
| Depth ladder (WS 5-level) | B2 PARTIAL | REST depth `api/market_watch.py:2215`; WS touch-line only |
| Fabricated data in market-watch path | NONE FOUND | §16 forensic audit |
| Runtime verification | UNVERIFIED | §30 |

---

## 7. Documented Feature List (design sections → subject)

| # | Doc section (subject) | Code subject audited |
|---|---|---|
| 1 | Purpose | overall engine role |
| 2 | Core Principle | feed-frequency vs ranking-frequency decoupling |
| 3 | Responsibility Boundaries | engine boundaries (REST broker, queue, DB, UI) |
| 4 | Daily Lifecycle | trading-day scoping, end-of-day reset |
| 5 | Universe Discovery | NSE EQ intraday-eligible universe build |
| 6 | Today's Temporary Market Watch | temporary per-day state store |
| 7 | Live Market State | full-universe live state |
| 8 | Tick Processing | tick validity, apply to state |
| 9 | Ranking Engine | Top-5 appearance tracking |
| 10 | 30-Second Snapshot | point-in-time ranking snapshot |
| 11 | Automatic Pin System | 5 gainer + 5 loser auto pins |
| 12 | Dynamic Pin Replacement | replacement on new entrants |
| 13 | Tie Handling | deterministic tie-break |
| 14 | Pin Lifetime | trading-day scoped pin lifetime |
| 15 | UI Sections | dynamic section list |
| 16 | UI Data Strategy | controlled publish / subscriptions |
| 17 | More / Dropdown / Search | full-market search + single-symbol |
| 18 | Pagination & Virtualization | paged sections, ROW limit |
| 19 | Live Row Updates vs Ranking Updates | overlay ticks vs sections |
| 20 | Stock Status | LIVE/STALE/PENDING/NO_DATA/INACTIVE |
| 21 | Performance | async loop, chunked broker calls |
| 22 | Caching | scrip master, broker cache, tick buffer |
| 23 | Configuration | thresholds, intervals, limits |
| 24 | Error Handling | broker fail-cooldown, exceptions |
| 25 | Observability | metrics, TPS status snapshot, events |
| 26 | Important Logs | structured key logs |
| 27 | Data Integrity | unknown ≠ safe, never-fabricate |
| 28 | Security | realtime JWT, authz |
| 29 | Current vs Target | documented deltas (kept, not scored) |
| 30 | Non-Goals | out-of-scope items (kept, not scored) |
| 31 | End-to-End Example | worked example trace |
| 32 | Final Target Flow | full final flow trace |
| 33 | Acceptance Criteria | success criteria per feature |
| 34 | Design Summary | consolidated requirements |

---

## 8. Overall Feature Classification Matrix

Legend: A1 Implemented · B2 Partial · C3 UI-only/Mocked · D4 Missing/Broken(D4b). Runtime column stays
"code-verified" — runtime unverified per §30. (Tier letters kept from the engine-audit convention.)

| # | Feature | Doc | Class | Evidence (primary) |
|---|---|---|---|---|
| F01 | Universe build (real NSE EQ master) | §5/§3 | A1 | `instrument_cache.py:128-151,159-189,240-298`; `market_watch_engine.py:293,336`; `api/market_watch.py:615` |
| F02 | Symbol/name/token mapping + search index | §3/§5/§17 | A1 | `instrument_cache.py:321-445` |
| F03 | Daily trading-day scoping | §4/§6/§14 | A1 | `market_watch_engine.py:880,900`; `market_watch_pins.py` (trading-day scoped); `_current_trading_date() :104` |
| F04 | Live tick ingestion | §7/§8 | A1 (code) | `ws_manager.py:1234-1275`; `engine.py:148-151`; `market_watch_engine.py:175,433,555` |
| F05 | Live market state (full eligible universe) | §7 | A1 (code) | `market_watch_engine.py:555,606,758-803` |
| F06 | Tick validity / validate envelope | §8 | A1 | `ws_socket/engine/*` (quality.py, canonical.py); `engine.py:148-151` |
| F07 | Feed-state (RECEIVING/STALE/DEGRADED) | §8/§20 | A1 | `ws_manager.py:1250-1257`; `market_watch_engine.py:806` |
| F08 | 30-second ranking snapshot | §9/§10 | A1 | `market_watch_ranking.py` (RANKING_INTERVAL_SECONDS=30.0) |
| F09 | Top-5 appearance tracking | §9 | A1 | `market_watch_ranking.py` TOP_N_TRACKED=5; `market_watch_engine.py:900` |
| F10 | Auto pins (max 5 gainers + 5 losers) | §11/§12/§14 | A1 | `market_watch_ranking.py` MAX_GAINER_PINS/MAX_LOSER_PINS; `market_watch_engine.py:917` |
| F11 | Tie handling (deterministic) | §13 | A1 | `market_watch_ranking.py` tie-break; test `test_market_watch_ranking.py` |
| F12 | Dynamic UI sections | §15 | A1 | `market_watch_engine.py:964-1106`; `api/market_watch.py:1920` |
| F13 | Controlled publish (no tick flood) | §16 | A1 | `connection_engine/channels.py` (market_watch channel, min_interval 1.0 s); `connection_engine/connection_engine.py` FANOUT/ENGINE_SNAPSHOT |
| F14 | Desired-subscription contract | §16 | A1 | `market_watch_engine.py:391,404`; `ws_manager.py:679`; `scheduler/__init__.py:1553`; test `test_market_watch_ranking.py:383-392` |
| F15 | Full-market search | §17 | A1 | `api/market_watch.py:1939`; `market_watch_engine.py:1191`; `app/_pages/market-watch/movers.tsx:142-161` |
| F16 | Single-symbol detail | §17 | A1 | `market_watch_engine.py:1219`; `api/market_watch.py:2261`; `symbol.tsx:43-61` |
| F17 | Pagination & page slices | §18 | A1 | `market_watch_engine.py:1150`; `api/market_watch.py:2313`; `movers.tsx:124-140`; limit=100 |
| F18 | Live-row overlay (ticks over sections) | §19 | A1 | `mw-shared.tsx` overlayRows/overlayTick; `movers.tsx:166-170`; `symbol.tsx:28-29` |
| F19 | Stock status model | §20 | A1 | `market_watch_engine.py:758,784`; `api/market_watch.py` (status counts); `symbol.tsx:92-99` |
| F20 | Moment 5m / 10m | §15/§17 | A1 | `market_watch_engine.py:1090,1098`, `_enrich_entry:606`; `mw-shared.tsx` fiveMinPercent/tenMinPercent; movers §fiveMinuteMovers/tenMinuteMovers |
| F21 | Filter catalog (save/apply) | §(MW) | A1 | `market_watch_filters.py` (13 keys real fields); `api/market_watch.py:1981-2113` |
| F22 | Circuit safety (unknown ≠ safe) | §27 | A1 | `api/market_watch_engine.py:459,150-162`; anti-fabrication docstring |
| F23 | Intraday eligibility (broker products) | §5/§27 | A1 | `api/market_watch_engine.py:215-297` |
| F24 | Daily-change/price/momentum limits | §5 | A1 | `api/market_watch_engine.py` reasons (REASON_EXCLUDED_REASONS) |
| F25 | History availability gate | §5 | A1 | `market_watch_engine.py` (WS-fed momentum buffers; HISTORY_UNAVAILABLE reason) |
| F26 | Persistence of config/pins/history | §22 | A1 | `market_watch_pins.py` (Mongo); `market_watch_filters.py` (Mongo doc); `tick_buffer.py` (Mongo bulk_write) |
| F27 | Perf: async loops, chunked fetches | §21 | A1 | `api/market_watch.py:482-597` chunked workers; async engine loop |
| F28 | Caching (scrip master, broker cache) | §22 | A1 | `instrument_cache.py` persisted `data/instrument_master.json`; `services/broker_cache.py` |
| F29 | Config thresholds | §23 | A1 | `connection_engine` FRESH_MAX_AGE_S/DELAYED_MAX_AGE_S; engine thresholds `market_watch_engine.py:263` |
| F30 | Error handling / broker fail-cooldown | §24 | A1 | `services/broker_cache.py:177-184` |
| F31 | Observability & metrics | §25 | A1 | `market_watch_engine.py:1239` status_snapshot (tick marks, TPS over last 60); `api/market_watch.py:1401,1419` history/progress |
| F32 | Security of realtime channel | §28 | A1 | `api/ws_gateway.py` (GET /api/realtime/token, WS 401 + close 4401); test `test_realtime_gateway.py` |
| F33 | Rank endpoint (sort/paging) | §(MW) | A1 | `api/market_watch.py:2162`; `app/_pages/market-watch/rank.tsx` (rankQuery size 250) |
| F34 | Manual pins | §11 | A1 | `api/market_watch.py:2372-2429`; `symbol.tsx:68-88` |
| F35 | Finished-reset at day end | §4 | A1 | `market_watch_engine.py:880` `_ensure_trading_day` (per trading date) |
| F36 | Full 5-level WS depth ladder | §(MW "depth") | B2 | `api/market_watch.py:2215` REST depth; WS only bp/bq/sp/sq touch-line (`api/market_watch_engine.py:140-148`) |
| F37 | Feed/broker UI status handoff | §25 | A1 | `movers.tsx:210` connectionState badge; `lib/realtime-ws.ts` (AUTH_FAILED etc.) |

Counts: **A1 = 35** · **B2 = 1** (F36 depth) · **C3 = 0** · **D4 = 0**.

---

## 9. Feature Text Summary

- F01–F03 Universe + eligibility: real Kotak NSE CM scrip master is downloaded via the SDK once per session and
  persisted (`instrument_cache.py:128-151,300-316`); the engine builds an intraday-eligible EQ universe
  (`market_watch_engine.py:293`), refreshes daily, and scopes all state by trading date.
- F04–F08 Live path: decoded SDK ticks run `ws_manager._process_tick`; the WS engine emits `TICK_VALIDATED`
  carrying a flat payload + `masterCanonical` (`engine.py:148-151`); Market Watch subscribes to that event and
  merges into per-token live state (`market_watch_engine.py:555`).
- F09–F11 Ranking/pins: ranking module snapshots every 30 s with Top-5 tracking and up to 5+5 auto pins,
  deterministic tie-break, trading-day scope — the design's decoupling of feed frequency from ranking frequency
  (§2, §10) holds.
- F12–F14 UI strategy: sections built engine-side; publish flows through the Connection Manager's `market_watch`
  channel (priority P2, min interval 1.0 s) — the UI is never flooded with raw ticks.
- F15–F18 Search/detail/paging + live overlay: full paths with evidence, and the frontend layers live ticks over
  snapshot sections.
- F20 Momentum: 5 m/10 m percentages computed from WS-fed rolling history; surfaced engine → API → UI.
- F22–F25 Correctness: circuit distance uses circuit-boundary denominators and `UNKNOWN` is never `SAFE`;
  intraday eligibility requires broker products (MIS/INT) or account margin confirmation — never inferred from
  segment alone; missing history/momentum excludes honestly as `HISTORY_UNAVAILABLE`.
- F32 Realtime security: operator JWT for token; the WS negotiates JWT and closes with 4401 on auth failure.

Single B2 (F36): depth is delivered as a REST snapshot (`_depth_snapshot`) plus live WS touch-line; a full
5-level depth ladder over the WS could not be confirmed in the market-watch path.

---

## 10. Implemented (A1) — Detailed List

See matrix F01–F35/F37. Immediate outstanding note: none of these A1s have been runtime-verified on a live
broker session (§30).

---

## 11. Partial (B2) — Detailed List

| # | Feature | What exists | What is missing / differs |
|---|---|---|---|
| F36 | Wall-scoped live depth | REST order-book snapshot (`api/market_watch.py:2215-2260`) + WS touch-line bp/bq/sp/sq (`api/market_watch_engine.py:140-148`) | Full 5-level WS order book not confirmed; UI badge shows `REST` vs `ws` source (`symbol.tsx:184`). |

---

## 12. UI-Only / Mocked (C3) — Detailed List

None found in the market-watch path. See the forensic audits (§16–§17). Status `PENDING` on the UI
(`symbol.tsx:94-99`) is a legitimate real state, not a mock.

---

## 13. Missing / Broken (D4) — Detailed List

None (static). No documented feature has zero code support. "Broken" (D4b) requires a runtime failure —
out of this audit's static scope (§30).

---

## 14. Dummy-Data / Mock Forensic Audit

Searched the whole service tree for fake-data in the market-watch path. Process:

1. `api/demo.py` + `services/dummy_extras.py` — a separate demo surface for dummy account/order/history/alerts/
   baskets. It never supplies LTP, universe, depth, or market-watch rows; market-watch endpoints do not import it
   (`api/market_watch.py`, `api/market_watch_engine.py`, `services/market_watch_*.py` have no demo import).
2. Grep of market-watch modules for hard-coded LTP/symbol/price arrays: **none**.
3. `_enrich_entry` and `normalize_quote` construct values only from real observed fields and `_nullable_float`
   (`api/market_watch_engine.py:63-82`); nothing is invented.
4. Circuit percent is consumed only when the broker provides it; it is **never** derived from a generic 20%
   assumption (`api/market_watch_engine.py:158-162`).
5. Eligibility without broker/account evidence returns `UNKNOWN` and excludes (`api/market_watch_engine.py:279-289`).

Verdict: **no dummy/mock/forged data** in the market-watch pipeline.

---

## 15. Sanity-Property Forensic Audit

- Unknown ≠ Safe: enforced (`api/market_watch_engine.py:459`, docstring).
- No fabricated momentum when history missing: `HISTORY_UNAVAILABLE` reason (`REASON_EXCLUDED_REASONS`).
- No inventory of stale as fresh: freshness thresholds via `connection_engine` config; status model
  LIVE/STALE/PENDING/NO_DATA/INACTIVE (`market_watch_engine.py:758`).
- Duplicate subscription blocks measured (`ws_manager.py:1335-1342`).
- Data-loss accounting for the DB-writer path (`services/db_writer_engine.py:247-311`) — governing tick
  persistence correctness for momentum history.
- Backpressure drop-oldest + delta reporting (`connection_engine`), framework `DROP_OLDEST`, `_drop_delta`.

---

## 16. Backend Data Flow — Real Trace (no fake source)

```
Kotak SFeed WS   (neo_api_client websocket feed, kotakneoapi 3.0.6)
  → ws_socket/ws_manager._process_tick  (ws_manager.py:1234)
      → market_state_service.on_tick_received  (:1268-1275)
  → ws_socket/engine/engine.on_feed_message  (engine.py)
      → TICK_RECEIVED (unconditional for recorded types)  (engine.py:148)
      → TICK_VALIDATED flat payload + masterCanonical      (engine.py:151)
  → MarketWatchEngine._listen_loop (market_watch_engine.py:433,175)
      → _process_tick/_enrich_entry (555,606) → live state (per token, trading-day keyed)
  → Ranking (market_watch_ranking.py): 30 s snapshots, Top-5, auto pins
  → Sections/movers (engine 964-1106)
  → REST:  api/market_watch.py  (universe/sections/search/page/rank/symbol/pins/filters)
  → Realtime:  connection_engine fan-out (channels.py) → connection_engine bridge (POLL 1.0 s)
  → `api/ws_gateway.py` (JWT, 4401) → Vercel `lib/realtime-ws.ts` → page state
```

Subscription contract (feed-side): `refresh_desired_subscriptions(force=True)` (`ws_manager.py:679`,
`scheduler/__init__.py:1553`) → `MarketWatchEngine.desired_subscriptions()`/`eligible_subscription_payload()`
(`market_watch_engine.py:391,404`) → engine enrichment of the desired set (`engine.py:339`) → broker subscribe.

---

## 17. Feed / Broker Integration Status

| Sub-area | Status | Evidence |
|---|---|---|
| SDK version | 3.0.6, feed models present (SFeedScrip etc.) | `.venv/.../feed/models.py` |
| Subscribe/unsubscribe dedup | A1 | `ws_manager.py:1306-1343` |
| Reconnect/resubscribe + backoff | A1 | `ws_manager.py` (SUPERVISOR_STOPPED on exhaustion; `refresh_desired_subscriptions` on connect) |
| Auth-failure signalling | A1 | `SUPERVISOR_AUTH_FAILED="AUTH_FAILED"` `ws_manager.py:33`, `:619-620`; surfaced to UI via `lib/realtime-ws.ts` |
| Desired-set prewarm pre-login | A1 | `prepare_subscriptions` `ws_manager.py:1281` |
| Feed-state machine | A1 | `ws_manager.py:1250-1257` |

---

## 18. Backend API Inventory (REST, verified in code)

| Route | Function | Evidence |
|---|---|---|
| GET `/api/market-watch` | market_watch | `api/market_watch.py:1514` |
| GET `/api/market-watch/sections` | market_watch_sections | `:1920` |
| GET `/api/market-watch/page?section&offset&limit` | market_watch_page | `:2313` |
| GET `/api/market-watch/search?q` | market_watch_search | `:1939` |
| GET `/api/market-watch/rank` | market_watch_rank | `:2162` |
| GET `/api/market-watch/symbol/{q}` | market_watch_symbol | `:2261` |
| GET/POST/DELETE `/api/market-watch/pins(/:id)` | pins_add/remove/clear/list | `:2372-2429` |
| GET `/api/market-watch/filters` / POST save / apply / detail / delete | filters_* | `:1981-2113` |
| GET `/api/market-watch/history` | market_watch_history | `:1401` |
| GET `/api/market-watch/progress` | market_watch_progress | `:1419` |
| GET `/api/realtime/token` | (gateway token) | `api/ws_gateway.py` |
| WS `/ws/realtime?token=` | (auth WS) | `api/ws_gateway.py` |

Response payload (`api/market_watch.py:1353` region) includes `generatedAt`, `scannerState`, `market`,
`universe` totals, applied `filters`, `counts` (advancing/declining/unchanged/scanned/live), and `diagnostics`
(nseEqUniverse, active, tradable, intradayEligible, liveQuotes, freshQuotes, circuitDataAvailable, circuitSafe,
scannerEligible).

---

## 19. Frontend Data Requirements vs API

Every fetch on the UI resolves to a real backend route (verified by grep + read of each tab):

| UI location | API | Result model |
|---|---|---|
| movers.tsx:87,107,128,146 | `/pins`, `/sections`, `/page`, `/search` | MWRow / SectionsPayload / PageResponse / SearchResponse |
| rank.tsx | `/rank?offset&limit=250&sortBy&sortDir` | ranked rows |
| filters.tsx | `/filters` CRUD + apply | persisted filter doc |
| pins.tsx | `/pins` GET/POST/DELETE + clear-all | pins frame |
| symbol.tsx:49,73-79 | `/symbol/{q}`, `/pins` POST/DELETE | SymbolDetail, depth from `/symbol` (`depth.available`), pin toggle |
| mw-shared.tsx | `useMarketWatchRealtime(tokens)` | ticks/frames via realtime WS |

Status vocabulary consumed (all real): `LIVE/STALE/PENDING/NO_DATA/INACTIVE` + realtime connection states
`DISCONNECTED…AUTH_FAILED/ERROR` (`lib/realtime-ws.ts`).

---

## 20. Realtime (RS) Coverage

- Subscription set built from the engine's eligible universe → broker sessions send exactly the merged desired set.
- Server → client fan-out on the `market_watch` channel (priority P2, min interval 1.0 s) with snapshot-only
  broadcast for engine frames (ranking/pins/status/feed-state per `channels.py`).
- Auth: JWT-only, close code 4401 on failure; `AUTH_FAILED` state propagated to UI.
- Overlay: live ticks are merged over snapshot rows client-side (live LTP, 5 m%, status), keeping the UI
  1 s-cadence responsive without raw-tick floods (§16, §19).

---

## 21. Rendering (RR) Coverage

- MwRow/MwRowRow table with momentum/volume/turnover/OI/rank columns; section cards + empty/loading states;
  deep-linked symbol view; pin badges that follow the `market_watch.pins` frame live.
- StatusBadge tone mapping; price/depth/circuit formatting utilities (`design-system`).

---

## 22. Persistence (PAS/PAM/PAD) Coverage

- Momentum/raw-tick history ingestion: `services/tick_buffer.py` (Motor `bulk_write` ordered=False,
  roll rate-window + event throttle) and DB-writer path with data-loss accounting.
- Instrument master persisted (`data/instrument_master.json`) for cold starts; never fabricated fallback.
- Manual pins + filter definitions persisted in Mongo (`market_watch_manual_pins`, `market_watch_filters`).
- Ranking snapshots retained: `MAX_SNAPSHOTS_KEPT=240` (≈2 h at 30 s).

---

## 23. Quality (QD) Coverage

- Unit tests: `test_market_watch_engine.py`, `test_market_watch_filters.py`, `test_market_watch_pins.py`,
  `test_market_watch_ranking.py`, `test_market_watch_route.py`, plus `test_realtime_gateway.py` (401/4401),
  `test_session_manager_subscriptions.py`, `test_sanctioned_master_l8_flow.py`.
- Contract test: desired subscription set drives Connection Manager subscriptions
  (`test_market_watch_ranking.py:383-392`).
- Pure-logic engine (no SDK/DB deps) keeps correctness rules unit-testable (`api/market_watch_engine.py:1-16`).

---

## 24. External Data (ED/O) Coverage

- Only external data source = Kotak Neo SDK (scrip master REST + SFeed WS + session limits). No third-party
  data feeds, no scraping, no fallback fake providers in the market-watch path.

---

## 25. Traffic (TR) Coverage

- Bulk quote fetch chunked with workers and fail-cooldown (`api/market_watch.py:482-597`);
  WS subscribed set bounded to the eligible universe; UI polls sections/page at `POLL_INTERVAL_MS`
  with live tick overlay; broker requests rate-guarded by `broker_cache.py` cooldown.

---

## 26. Mapping — WebSocket Pipeline (complete trace)

1. Pre-login prewarm: `prepare_subscriptions` (``:1281`).
2. Post-login: supervisor merges desired set (`refresh_desired_subscriptions` `:679`), subscribes via SDK.
3. Ingress: SDK callback → `on_feed_message` → events (TICK_RECEIVED / TICK_VALIDATED, `engine.py:148-151`).
4. Feed-state machine + market-state handoff (`ws_manager.py:1234-1275`).
5. Engine merging → live state + status counts.
6. Ranking/pins cadence (30 s) separate from feed.
7. Publish: Connection Manager fan-out bridges engine frames to WS clients (channels `market_watch`).
8. Client: `lib/realtime-ws.ts` negotiates JWT → frames → overlay. Auth failures → `AUTH_FAILED` + 4401.

---

## 27. Mapping — Search / Depth / Symbol Features

- Search spans the full real universe (symbol/name/token, matched live + validated rows), engine `search`
  (`market_watch_engine.py:1191`), API `market_watch_search` (`:1939`), movers search box (debounced).
- Symbol detail aggregates quote + depth + circuits + momentum + pin toggle from `/symbol` and `/pins`.
- Depth: REST snapshot (`_depth_snapshot` `:2215`) + WS touch-line overlay; partial (B2) for 5-level WS.

---

## 28. Mapping — Ranking / Pins Features

- Ranking snapshots every 30 s; Top-5 tracked (`TOP_N_TRACKED=5`); snapshots kept 240.
- Auto pins 5 gainers + 5 losers with deterministic tie-break and trading-day lifetime; pin-changed events;
  manual pins overlaid on top (Mongo, max 20, `market_watch_manual_pins`).
- UI: movers pin badges follow live `market_watch.pins` frames; rank tab paged/sorted; pins tab manages manual set.

---

## 29. Production Readiness — Overall

Ready-to-live state: **code-complete; runtime unproven**. Every feature is implemented behind real data and
guarded by honesty rules; the open risk is operational, not architectural (see §30–§34 action list).

---

## 30. Production Readiness — Reliability

- Unknown = not safe; eligibility requires broker confirmation; stale/soft exclusion paths exist.
- Reconnect + resubscribe, auth-failure closed loop, backpressure drop-oldest, data-loss accounting.
- UNVERIFIED at runtime: broker auth/WS session, live tick rate, 30 s ranking cadence, chat/pin interplay,
  MongoDB indexes/lifecycle. **Runtime verification must precede go-live.**

---

## 31. Production Readiness — Performance

- Async loops; chunked/worker quote fetch; persisted master cache; subscriber-driven publish cadence;
  1 s UI interval with poll fallback; 250-row rank pages; 100-row section pages.
- Risks: large-universe first build time, broker rate limits (broker_cache cooldown), tick LTP rate on big
  eligible universe — engine TPS metrics (`status_snapshot`) expose these for tuning.

---

## 32. Production Readiness — Security & Operations

- Realtime requires operator JWT; failures close 4401; AUTH_FAILED state surfaced; secrets never logged.
- Ops: scanner events recorded (`api/market_watch.py:1292`), history/progress endpoints, structured logs list
  (§26 of doc), status/diagnostics surface counts for alerting.
- Residual: runtime credential/test-session validation; desktop/mobile browser matrix; load test of fan-out.

---

## 33. Discrepancies vs Previous Implementation Report

| Claim (previous report) | Audit verdict |
|---|---|
| "Implemented" overall market-watch Fx | Confirmed at code level for all Fx except F36 |
| Full live depth | B2 — REST depth + WS touch-line only |
| "Runtime verified" (if claimed) | Not reproducible statically — UNKNOWN (not re-confirmed) |
| No fake data | Confirmed (forensic audit §16) |

---

## 34. FINAL AUDIT ANSWER SUMMARY

**MARKET WATCH AUDIT COMPLETE** (static, code-trace; runtime unverified).

- Documented features reviewed: **37** (matrix §8: F01–F37).
- Implemented (A1): **35**
- Partial (B2): **1** (F36 full WS 5-level depth)
- UI-only / mocked (C3): **0**
- Missing (D4): **0**
- Broken (runtime): **UNKNOWN — not verified** (no live broker session observed)

Direct questions:

| Question | Answer | Notes |
|---|---|---|
| Universe (full NSE EQ daily intraday-eligible build)? | **YES** | real Kotak master; `instrument_cache.py:128-151,240-298`; EQ filter + counts |
| Full universe live-quote pull (LTP validation)? | **YES** (code) | WS + bulk REST chunked; runtime unverified |
| Depth (bid/ask ladder)? | **PARTIAL** | REST snapshot + WS touch-line; no confirmed 5-level WS ladder |
| +5% / −5% (30 s point-in-time rankings)? | **YES** | 30 s cadence, Top-5, pinned top-5 each side |
| 5-min / 10-min momentum? | **YES** | WS-fed rolling history → sections + UI |
| Filters (save/apply, real fields)? | **YES** | 13-key catalog; validated; no fabricated ops |
| Auto pins (max 5 gainers + 5 losers)? | **YES** | + manual pins; trading-day lifetime; tests |
| Real-time (Kotak→UI)? | **YES** (code) | full trace in §26; runtime unverified |
| Fake/mocked data anywhere? | **NO** | forensic audit clean |
| Missing/broken feature? | **NONE** statically; runtime broken = UNKNOWN |

---

## 35. Before-Live Action List (recommended)

1. **Runtime verification** — run a real broker session: confirm WS supervisor auth, live TICK_VALIDATED flow,
   30 s ranking cadence, fan-out delivery, UI AUTH badge (must not be AUTH_FAILED).
2. Verify universe size/counts against `diagnostics` response once live (nseEqCount vs scannerEligible).
3. Load-test the market_watch channel fan-out under full universe subscription.
4. Either implement true 5-level WS depth or re-document REST+overlay depth as intended behaviour (close B2).
5. Confirm Mongo indexes on pin/filter/history collections and end-of-day cleanup job.
6. Confirm per-session desired-subscription merge in production scheduler (pre-login prewarm → subscribe).

---

## 36. Evidence Appendix — Key Citations

- `services/instrument_cache.py:128-151,159-189,240-298,422-445,466-477` — real master, EQ indexing, counts.
- `api/market_watch_engine.py:63-82` (`_fnum`/`_nullable_float`), `:87-209` (`normalize_quote`), `:150-162`
  (circuit percent never invented), `:215-297` (eligibility), `:459` (`_apply_circuit`).
- `services/market_watch_engine.py:175,293,336,391,404,433,555,606,758-806,812-917,964-1239`.
- `services/market_watch_ranking.py` (30 s, Top-5, 5+5 pins, 240 snapshots).
- `services/market_watch_filters.py` (catalog/validation); `services/market_watch_pins.py` (Mongo manual pins).
- `api/market_watch.py:482-597` (chunked quote/circuit fetch), `:692,806` (evaluation/batch), `:1353`
  (payload/diagnostics), `:1401,1419` (history/progress), `:1514-2431` (routes), `:2215` (depth snapshot).
- `ws_socket/ws_manager.py:33,619-620,679,1234-1275,1281`.
- `ws_socket/engine/engine.py:148-151,339`; `ws_socket/engine/{canonical,quality,profiles,master_canonical}.py`.
- `connection_engine/connection_engine.py` (fanout/bridge/snapshot/config), `connection_engine/channels.py`;
  `services/tick_buffer.py`; `services/db_writer_engine.py:247-311`.
- `api/ws_gateway.py` (token + JWT WS + 4401); `lib/realtime-ws.ts` (states/envelope); `app/_pages/market-watch/*`
  (tabs + fetch map §19).
- Tests: `test_market_watch_engine/filters/pins/ranking/route.py`, `test_realtime_gateway.py`,
  `test_session_manager_subscriptions.py`, `test_sanctioned_master_l8_flow.py`.

---

## 37. Closing Statement

This report is **read-only and static**. All verdicts above depend on the code-path being exercised on a live
broker session; until then treat every "implemented" as "implemented and wired, runtime unverified". Marking
§30 action #1 (runtime verification) is the interim gateway to live.