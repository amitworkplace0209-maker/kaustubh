# 029 — Market Watch engine read → UI/backend build → full-universe scan

Date: 2026-10-07, live market hours (BLOCKING phase)
Backend: fresh `start_backend.py run` process (fix live from boot), Kotak WS CONNECTED

## 1. Engine read (what the engine owns)

Single source of truth: `services.market_watch_engine.MarketWatchEngine`
(`engine_id="market_watch"`, 14 native + 3 facade = 17 registered, 15 RUNNING).

- **Universe**: `mwr_universe_source=LOCKED` (default) — membership is exactly the
  Saturday-locked weekly list (`market_watch_universe`), master only enriches
  metadata. `DAILY_MASTER` legacy mode rebuilds all NSE EQ. Live run: 15/15/15
  (universe/eligible/subscribed).
- **Lifecycle** (IST wall-clock): `PRE_MARKET → DISCOVERY → FILTERING → SUBSCRIBED →
  MONITORING → BLOCKING → FINAL_MONITORING → MARKET_WATCH_STOPPED → REPORTING →
  COMPLETED`, plus `RUNTIME_INACTIVE` outside `08:50–15:30`. Monitoring promotes to
  BLOCKING on first official ranking. 1 s reconcile loop; ranking/publish every
  30 s (`ranking_interval_seconds`); index 1 s; publish coalesce 250 ms.
- **Per-stock typed state** (`SymbolState`): price/day (ltp/prev/change/volume/vwap/
  OHLC), circuit (upper/lower, distance both sides, band, SAFE|NEAR|DANGER|HIT|
  UNKNOWN), tick age, ledger (ELIGIBLE|BLOCKED|PENDING + 8 block reasons),
  quality (LIVE|…|UNAVAILABLE), business (`stockState`, `classification` with
  DANGER > INTRADAY_UNAVAILABLE > GAINER/LOSER > NORMAL precedence), per-timeframe
  1m/5m/10m/30m change, margin (authoritative broker values only), ₹800
  observation counters. Numerics stay `None` when missing — never 0.
- **Boards**: 22 official (`top_gainers/losers`, `highest_volume`, `most_active`,
  `circuit_near/danger`, `movers/decliners[_1pct]_1m/5m/10m/30m`) + 10 legacy
  sections. Auto Top-5 frequency pins (30 s, in-memory, day-scoped); manual pins
  separate (Mongo, max 20, day-scoped). Weekly Sat 18:00 review → draft →
  ADD/REMOVE/KEEP decisions → lock (versioned, Mon–Sun effective).
- **REST surface** (`api/market_watch.py`, 40 routes): main read, sections, boards,
  rank, page (any official board pageable), search, `symbol/{token-or-symbol}`,
  `stock/{token}` (typed record), registry, ui, tick-snapshot, ranking(+status),
  pins CRUD, filters CRUD + catalog + apply, config, tick-saving GET/POST, weekly
  ×8, observability, history, progress, status, report/daily ×2.
- **Previously unused by any frontend**: main `GET /`, `/history`, tick-saving
  GET/POST, `/status`, `/ranking/status`, `/registry`, `/stock/{*}`, standalone
  `/weekly/history`. Side-effect warning: `GET /symbol/*` calls broker
  `async_quote` when WS depth is missing and session is active — cache/debounce.

## 2. Built per the engine

Backend (`python-service/api/market_watch.py`, only file touched):

- `_resolve_token` now normalises NSE series suffixes (`-EQ`, `-BE`) on both sides,
  so bare ↔ suffixed resolve in either direction (registry/cache carry either
  form). Verified live: `/symbol/KOTAKBANK-EQ` was `unknown_symbol`, now
  `ok:true token 1922`. Benefits `/symbol/*`, `/stock/*`, `POST /pins` alike.
  Backend suites using this path: 387 passed.

UI (`components/market-watch/market-watch-live.tsx`, both market-watch routes):

- **Manual pins, engine-shaped**: per-row Pin/Unpin button (DELETE always sends the
  raw token, as the route requires), Pins tab gains a Manual section (add by
  symbol-or-token, unpin, clear-all, `manualCount/maxManualPins` badge,
  day-scoped note). Auto pins (socket) and manual pins (REST) stored separately —
  the frame can never wipe the manual list (same guard as services PinsTab).
- **"Scan all" tab** (`UniverseScan`): pages `GET /rank?limit=1000` end-to-end over
  the engine universe + `GET /registry` (size/feed) + `GET /boards`
  (`circuit_danger` board, because `/rank` serves legacy flat rows where the
  typed `classification` may be null). Tallies only backend-provided values into
  status distribution, adv/dec/unchanged, top-10 gainers/losers, danger,
  intraday-unavailable, and no-live-price chip lists. Auto-runs on tab open +
  Re-scan button.
- doc §24 kept throughout: no client ranking, no sign-derived tone, missing stays `—`.

## 3. Full-universe scan results (engine REST, broker-free, ~12:45 IST)

- Registry: **15/15/15** (universe/eligible/subscribed), feed CONNECTED,
  lifecycle **BLOCKING**, `statusCounts {LIVE:15}` — Saturday-locked universe,
  every stock priced.
- Breadth: **ADV 3 / DEC 12 / UNCHANGED 0**. DANGER 0, INTRADAY_UNAVAILABLE 0,
  NO_PRICE 0. 1% timeframe boards empty (no ±1% moves); `circuit_near/danger` 0.
- Top: KOTAKBANK-EQ 439.40 **+1.74%**, BAJFINANCE +0.38%, AXISBANK +0.21% |
  TATASTEEL −1.94%, ADANIENT −1.81%, INFY −1.70%, MARUTI −1.64%, LT −1.60%.
- Engine counters: ticks received 219153 / validated 3809 / invalid 224;
  classCounts {GAINER 1, LOSER 7, NORMAL 7}.
- Note: `/rank` rows carry `classification: null` (legacy flat rows) while the
  engine typed state classifies (observability proves it) — Scan tab reads danger
  from the official `circuit_danger` board for this reason. A future backend pass
  could project `classification` into rank rows.

## 4. Verification

- `npx tsc --noEmit` clean, `eslint` on touched file clean,
  `npm run build` ✓ compiled, `npm test` 400/400, backend market-watch suites
  387 passed. Backend restarted detached (`start_backend.py run`) and healthy
  (`/health` 200) after the fix.
