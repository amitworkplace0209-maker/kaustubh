# 028 — Market Watch terminal redesign + live verification

Date: 2026-10-07 (IST, live market hours)
Backend: pid set started 11:59:44, `broker_mode=dummy`, Kotak WS CONNECTED
Effective database (observed): `kaustubh` on `cluster0.1ed9ojp.mongodb.net` (Atlas, 49 collections)

## 1. What changed

`components/market-watch/market-watch-live.tsx` was a WS-only mirror: it rendered
solely from `market_watch.status / .ranking / .pins` socket frames and showed a dead
"No data" card whenever nothing had arrived. Both `/dashboard/market-watch` and
`/trading/market-watch` used it, so both routes looked broken outside a live socket.

Redesigned into a working terminal (same file, same routes, no route changes):

- REST first: `/progress` (via `useEngineProgress`) + `/sections` + `/boards` +
  `/pins` + `/ranking` load on mount, so the page paints real engine data with the
  socket down. 60 s reconcile (`RECONCILE_INTERVAL_MS`), manual Refresh button.
- Realtime patch: the three state frames update the same state in place (1 s
  throttle per frame type — the exact throttle that previously froze the shell is
  kept). Visible tokens are subscribed per-token on `market_watch`.
- Tick-snapshot safety net: every 30 s, tokens with no WS tick are refreshed from
  `GET /api/market-watch/tick-snapshot` (real feed values). Overlay order is
  WS tick → snapshot → REST row; rows without any price stay `—`, never invented.
- Full-universe search (`/search`, debounced) with a dropdown; Enter or click opens
  the symbol detail tab.
- Symbol detail (`/symbol/{token}` — token form, see §3) with quote/OHLC, circuit
  bands, engine classification, depth ladder, honest unavailable states.
- Tabs: Movers (engine 1% board) / Gainers+Losers / Losers / Pins / Detail, plus a
  breadth strip (Live/Universe, Adv/Dec, movers count, pins G/L, lifecycle), IST
  clock, WS + feed badges, engine stock-status footer.
- doc §24 kept: classification/tone comes from backend fields only; `fmt*` helpers
  are presentation-only; no client-side ranking or sign-derived tone.

## 2. Live observations (all GET, no mutations — effective DB is prod-named)

| Check | Observed 2026-10-07 ~12:16–12:21 IST |
|---|---|
| `GET /api/market-watch/progress` | 200 — `feedState CONNECTED`, lifecycle `BLOCKING` (prev `MONITORING`, next `FINAL_MONITORING`), `tradingDate 2026-10-07` |
| `GET /api/market-watch/sections` | 200 — `indexVersion 28`, `liveStateCount 15`, `universeSize 15`, `subscribedTokenCount 15`, `statusCounts {LIVE:15}`, top row `KOTAKBANK-EQ @ 439.1 +1.67%` |
| `GET /api/market-watch/ui` | 200 — same v28 snapshot + pinned gainers/losers |
| `GET /api/market-watch/config` | 200 — ranking 30 s, maxGainerPins 5, pageSize 100 |
| `GET /api/market-watch/boards` | 200 (~222 kB) |
| `GET /api/market-watch/pins` | 200 |
| `GET /api/market-watch/ranking` | 200 |
| `GET /api/market-watch/search?q=KOTAK` | 200 — 1 hit, full row incl. 5-level depth, `fiveMinPercent -0.0796` |
| `GET /api/market-watch/symbol/1922` | 200 — `status LIVE`, `dataAgeSec 0.018`, full quote + depth |
| `GET /api/market-watch/tick-snapshot?tokens=1922,5900` | 200 |
| `GET /api/services/engines/summary` | 200 — total **17** (RUNNING 15, REGISTERED 2) — matches PENDING-001's corrected 17-engine count |
| `GET /api/services/engines/broker/status` | 200 — trading `kotak/CONNECTED/sessionActive:true`; marketData `kotak/CONNECTED`, `lastTickAt 2026-10-07T12:20:19+05:30` |
| `GET /health`, `/api/system/health` | 200 — db connected (Atlas, db `kaustubh`, 49 collections, ping ~30–109 ms), ws `WS_CONNECTED`, scheduler `TICK_COLLECTION_RUNNING`, session `SESSION_ACTIVE/mode dummy` |
| `GET /api/settings`, `/api/settings/runtime` | 200 — **no secret values**: `mongodb_uri.value == ""`, no `mongodb+srv://` credentials in either body; `jwt_secret/mpin/totp_secret/consumer_key` absent |
| `GET /api/services/engines/db_writer_engine/tick-persistence` | 200 — `storageCapActive true` (512 MB Atlas quota reason), all three permissions `enabled:false/hardCapped:true/accepted:0`, `skipped 1003996 + 36945`, `STORAGE_CAPPED 1036001` |
| `ws://127.0.0.1:8000/ws/realtime` (raw probe, no token) | TCP connects; first frame `error.event 401 "Unauthorized: a valid gateway token is required (?token=<JWT>)"`, then close 4401. Transport live, auth-gated as designed |

## 3. Backend quirk found (not fixed — recorded)

`GET /api/market-watch/symbol/KOTAKBANK-EQ` → `{"ok":false,"reason":"unknown_symbol"}`,
while `/symbol/1922` (same instrument) → 200. `_resolve_token` fails the `-EQ`
symbol-string lookup against `instrument_cache`/registry. The redesigned terminal
works around it by requesting `/symbol/{token}` (token preferred, symbol fallback).
Recommend a backend follow-up to normalise `-EQ` suffixes in `_resolve_token`.

## 4. Static verification for this change

- `npx tsc --noEmit` — clean
- `npx eslint components/market-watch/market-watch-live.tsx` — clean
- `npm run build` — `✓ Compiled successfully`, `/trading/market-watch` + all routes emitted
- Frontend `npm test` — 400 pass / 0 fail
- Backend market-watch suites — 387 passed
  (`test_market_watch_engine/ranking/pins/filters` 125 + `route/weekly_universe/spec_modules` 262)

## 5. Pending-item impact

- PENDING-002: build/typecheck/lint/frontend-tests/backend-market-watch-tests now have
  fresh 2026-10-07 evidence (this file). Still open per its own criteria:
  version-control posture decision, full backend suite + coverage, dependency audit,
  new auth tests (R-36/37/38).
- PENDING-001: steps 2 (17 engines observed), 3 (secret redaction observed),
  4 (health observed, Mongo-up variant), 6b (WS transport observed, auth-gated),
  8 (broker status observed, no failover — as documented) now have live evidence.
  Still open: effective-DB confirmation is REVERSED — observed DB is the
  production-named `kaustubh`, so all mutation steps stay blocked by its own
  precondition 5; OpenAPI diff; 503-without-Mongo check; `/api/health` winner note
  (observed: `/api/health` returns a minimal `service: kaustubh-python-service`
  body while `/health` + `/api/system/health` return the full component payload).
- PENDING-004: read-only observations recorded (cap active, accepted 0, capped
  skips increasing). All PUT/toggle steps DELIBERATELY NOT RUN — effective DB is
  `kaustubh`, and the task's own precondition forbids writes outside `kaustubh_test`.
- PENDING-003: untouched by this task.

## 6. Files

- Rewrote: `components/market-watch/market-watch-live.tsx` (only file changed)
- Routes unchanged: `app/(dashboard)/market-watch/page.tsx`,
  `app/(trading)/trading/market-watch/page.tsx` (both render this component)
