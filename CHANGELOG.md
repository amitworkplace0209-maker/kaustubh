# Changelog

## [Unreleased]

### Positions duplicate-trail race fix (2026-10-07)
- Same order recorded 2–3x in the closed trail (MONEYVIEW x3, TCS x2, CUPID x2) + account over-credited by one TCS -1.18: fill path had no serialization and the trail write wasn't idempotent.
- Fixed with a reentrant fill lock (`_execute_order`/`_refill`/`apply_demo_ltp`), in-lock square-off target lookup (double square-off → honest 404, never a reverse leg), and per-order-id idempotent trail records.
- Live cleanup disclosed: dup groups collapsed (16 → 12), account 144.32 → 145.50; today's closed sums exactly to account. Evidence: `docs/verification/035-positions-duplicate-trail-race-fix.md`.
- Tests 50 passed; `tsc`/`eslint`/build/frontend 400/400 green.

### Positions ghost + double-count fix (2026-10-07)
- Root cause: `_apply_fill` removed closed rows by rebinding its local list while callers saved their own list — zero-net ghosts lived forever and showed in both open and closed. Fixed with in-place removal + lazy ghost purge on read + net≠0 filters on `/state` and the open section.
- Live book repaired from blotter truth (user's RELIANCE avg/charges/realized corrected; disclosed test entry kept in today's history). Verified: 4 clean opens, no duplication, live MTM. Evidence: `docs/verification/034-positions-ghost-duplication-fix.md`.
- Regression tests 8/8; `tsc`/`eslint`/build/frontend 400/400 green.

### Positions live redesign (2026-10-07)
- Live-LTP matching fixed: `useLatestTicks` indexes ticks by symbol + tradingSymbol + token; positions page tries all identifiers (suffixed symbols no longer miss live prices).
- Summary is now 6 live cards: Total / Open / Closed / Charges (separate card) / Total P&L (gross, live-tagged) / Net P&L (gross − charges).
- Verified with a 1-share paper round-trip (squared off; user's MONEYVIEW position untouched; one test closed entry in today's history). Evidence: `docs/verification/033-positions-live-redesign.md`.
- `tsc`/`eslint`/build green, frontend 400/400, backend 133 passed.

### Trade page select + realtime (2026-10-07)
- Diagnosed `/trading/trade`: search engine + proxy + tick-snapshot all live; the gap was WS#3 needing an app session (401 without) — no socket meant frozen LTP after selection.
- `trade-page.tsx`: "Tap to trade" quick-pick strip from live engine boards (one-tap select, search-enriched, board-row fallback); tick-snapshot re-pulls every 15 s until a live tick owns the quote (failures keep last good); honest offline banner with `/login` link. Quote chain unchanged (stream → view → snapshot → seed).
- `tsc`/`eslint`/build green, frontend 400/400 (fallback test extended). Evidence: `docs/verification/032-trade-page-select-realtime.md`.

### WebSocket disconnect fix (2026-10-07)
- Broker feed was flapping (22 connects/21 drops in 8 min, ~9–19 s each, reason `Unknown`): ruled out scheduler kills (no `why` in history), orphan fighters (killed, flap persisted) and subscribe limits (chunked 200/frame, 2681 < 3000 cap). Cause was torn WS state from an earlier tool-timed-out restart; clean stop + fresh start fixed it — 1 connect, 0 drops, 2681 subscribed, ticks 42–540/s, `/health` WS_CONNECTED, Market Watch CONNECTED. Backend now logs to `logs/backend-manual*.log`. Evidence: `docs/verification/031-websocket-disconnect-fix.md`.

### Positions daily reset at 08:50 IST (2026-10-07)
- Day partition (IST, 08:30 cutoff): `api/demo.py::rollover_demo_positions()` auto-settles prior-date open MIS/CO/BO into the closed trail (`AUTO_DAY_ROLLOVER`, backdated to its own date); delivery/carry (CNC/CASH/NRML) untouched; lazy rollover on every `get_dummy_positions()` read; `list_closed_positions` + `GET /api/dummy/positions` scoped to `?date=` (default today) with `tradingDate` in response.
- Scheduler `_ensure_positions_day_rollover`: deterministic 08:50+ IST sweep once per trading date + broker positions cache invalidate.
- UI: both positions pages show "Today · {date} IST · resets 08:50", refetch instantly on IST day-flip; standard-mode charges now use today's executions only.
- Tests: new `test_demo_positions_rollover.py` 6/6 (fake Mongo); touched suites 621 passed; `tsc`/`eslint`/`build`/frontend 400/400 green; live `/api/dummy/positions` returns scoped `tradingDate`. Evidence: `docs/verification/030-positions-daily-reset-0850.md`.

### Market Watch engine read → UI/backend build → full scan (2026-10-07)
- Read the canonical engine (`services/market_watch_engine` + 15 helper modules + 40 REST routes): LOCKED Saturday universe, IST lifecycle, 22 official boards + 10 legacy sections, auto Top-5 vs manual (Mongo, max 20) pins, typed per-stock state. Found 8 engine endpoints no frontend used (`/`, `/history`, tick-saving, `/status`, `/ranking/status`, `/registry`, `/stock/*`, `/weekly/history`) and one live broker side-effect (`GET /symbol/*` → `async_quote` when WS depth missing).
- Backend fix (`python-service/api/market_watch.py` only): `_resolve_token` normalises `-EQ`/`-BE` suffixes both sides — `/symbol/KOTAKBANK-EQ` was `unknown_symbol`, now resolves to token 1922 live (also fixes `/stock/*`, `POST /pins` for suffixed symbols). Backend restarted detached and healthy.
- UI (`components/market-watch/market-watch-live.tsx`): manual pins wired engine-shaped (per-row pin/unpin, DELETE always sends raw token, manual section with count badge + clear), new "Scan all" tab paging the whole ranked universe with breadth, danger (from official `circuit_danger` board — `/rank` flat rows lack typed classification), unavailable and no-price lists.
- Full-universe scan (live, BLOCKING): 15/15/15 universe/eligible/subscribed, all LIVE, ADV 3 / DEC 12 (KOTAKBANK +1.74% top; TATASTEEL −1.94% bottom), danger/unavailable/no-price all zero. Evidence: `docs/verification/029-market-watch-engine-read-ui-build-full-scan.md`.
- `tsc`/`eslint` clean, build compiled, frontend 400/400, backend market-watch 387 passed.

### Market Watch terminal redesign + live verification (2026-10-07)
- Rewrote `components/market-watch/market-watch-live.tsx` (used by `/dashboard/market-watch` and `/trading/market-watch`) from a WS-only mirror with a dead "No data" card into a working terminal: REST-first load (`/progress` + `/sections` + `/boards` + `/pins` + `/ranking`, 60 s reconcile), realtime state-frame patching with per-token tick subscriptions, 30 s tick-snapshot safety net (WS tick → snapshot → REST row, never invented), full-universe debounced search, `/symbol/{token}` detail with quote/circuit/depth, Movers/Gainers/Losers/Pins/Detail tabs, breadth strip, IST clock, honest empty/offline states. doc §24 kept (backend-owned classification/tone only).
- Live-verified against the running backend in market hours: feed CONNECTED, lifecycle BLOCKING, 15/15 live universe (v28), 17 engines (15 RUNNING + 2 REGISTERED), secret redaction (`mongodb_uri` empty, no credential URIs), storage cap active (all tick permissions capped, `accepted: 0`, `STORAGE_CAPPED` ~1M skips), WS transport auth-gated (401 + 4401 without token). Full evidence: `docs/verification/028-market-watch-terminal-redesign-and-live-verification.md`.
- Found (not fixed, recorded): `GET /api/market-watch/symbol/KOTAKBANK-EQ` → `unknown_symbol` while `/symbol/1922` works — `_resolve_token` misses `-EQ` suffixed symbols; terminal prefers token form.
- `tsc` clean, `eslint` clean, `next build` compiled successfully, frontend tests 400/400, backend market-watch suites 387 passed. No PUT/mutation verification ran: effective live DB is production-named `kaustubh`, so PENDING-001/004 mutation steps stay blocked per their own preconditions.

### Kotak Neo SDK 3.0.6 migration + lossless Data Saver rebuild
- Migrated `kotakneoapi` from the git-pinned 3.0.2 commit to the official `kotakneoapi==3.0.6` PyPI wheel (`requirements.txt`). `pip check` clean; diff vs 3.0.2 is limited to feed `client.py` logging (+) and a new `services/historical_data.py` — `models.py`/`protocol.py` are byte-identical, so the 344-field classification and SFeed surface are unchanged and re-verified on 3.0.6.
- `canonical.py` `SDK_VERSION` → `"3.0.6"`; `brokers/capabilities.py` Kotak `supports_historical_data=True` (SDK 3.0.6 adds `HistoricalDataAPI.get_historical_data`); `test_common_trading_core.py` updated.
- **Lossless Data Saver**: new `ws_socket/engine/storage.py` `to_storage_doc()` + built-in `data_saver` consumer (DATA_SAVER / FULL_RAW / P0, registered in `WebSocketEngine.__init__`). Every feed message is routed to it and drained on the feed thread (`engine._drain_data_saver`) into `tick_buffer` → Mongo `db.ticks` as a superset doc: legacy 28-key projection (kept for all existing consumers) + previously-dropped SFeed attributes (yearly_high/low, market_lot, precision, multiplier, auction, full buy/sell depth rows, level, message_type, CAS + market-status values) + envelope + immutable raw `model_dump` blob. Verified end-to-end against MongoDB on 3.0.6 (PASS); router payloads carry `raw` (FULL_RAW) + `raw_reference`/`feed_type`/`feed_level`/`sdk_version`.
- **Legacy projection removed**: `ws_manager._sfeed_to_raw`, `_TICK_FIELD_MAP`, `_INDEX_FIELD_MAP`, the ws_manager→tick_buffer feed, and `services/tick_buffer._normalize_tick`/`_fnum` are gone. `tick_buffer` also skips price-history/timing for CAS and market-status docs. ws_manager keeps metrics/feed-state/market-state bookkeeping.
- Verification report re-generated on 3.0.6 (`docs/kotak_ws_field_verification.txt`, 344 fields) with the recorded live-session measurements (SFeedScrip 12763 / SFeedCasChange 5 / ticks 13371 in / 13370 written; per-stock L4 = 31 DIRECT_WS attributes). Tests: 375 backend passing (incl. 4 new engine/storage tests) — only pre-existing `test_dummy_session` date-rollover failure remains.

### Dummy Phase UI/UX Production-Grade PWA Upgrade
- **Sidebar restructured** (`components/layout/nav.ts`): `DUMMY_SHELL` reorganised into GENERAL / TRADING (Orders single item, Positions, Holdings, Portfolio, Account, Order History) / MARKET (Market Watch, Watchlist) / TOOLS (Calendar, Trading Chart, Risk, Notifications) / SYSTEM (Settings, Theme, Audit Trail, System Health). `DUMMY_ONLY_ROUTES` now includes `/trading/orders`; `mobilePrimary` updated. Standalone sub-routes (`/trading/trade`, `/trading/basket-orders`, `/trading/suggestion`, `/trading/history`) remain fully functional for deep-links.
- **Orders one-page module** (`components/dummy/orders-module.tsx`): ONE professional Orders module for Dummy mode with controlled internal tab system (Trade / Basket Orders / Suggestion / History). Embeds the existing four sub-page components as tab content inside `OrdersModuleProvider` context; a single top tab bar is rendered by the module only; sub-pages suppress their own URL-driven tab bar when embedded. The `/trading/orders` route page (`app/(trading)/trading/orders/page.tsx`) now allows both `dummy` and `kotak-neo` modes via `TerminalRouteGate` + `KotakGate`.
- **OrdersTabs extended** (`components/orders/orders-tabs.tsx`): controlled `value`/`onValueChange` props for embedded module mode; returns `null` when embedded and not controlled (no duplicate tab bars). Standalone routes continue to use URL-driven active state — zero regression.
- **Dashboard redesigned** (`components/dummy/pages/dashboard.tsx`): premium horizontal `MarketSessionCard` at the top (trading date, now IST, session status, next open/close with live countdown, WebSocket status, last update). KPI grid grouped into Account / Exposure & P&L / Orders & Activity with `LivePulse` on real-time values. Broker Terminals & Combined upgraded with honest unavailable/not-active states, combined `configured · active · unavailable` line derived from real backend data. Real Top Gainers/Losers from `/api/statistics/gainers-losers` with loading/empty/error/closed-market states, auto-refresh every 30s. Live Market Watch, Positions, Recent Orders, Targets & Alerts, Trading Activity sections — all showing real backend data with honest empty/error/offline states.
- **`MarketSessionCard`** (`components/dummy/ui.tsx`): premium accent-gradient full-width card replacing the old `SessionCard`. Uses `useCountdownTo` for live countdowns, `useDummyTheme` accent colour, `LiveIndicator` + `StatusBadge`. `SessionCard` kept as backwards-compatible alias.
- **`LivePulse` utility** (`components/dummy/ui.tsx`): subtle, calm value-change flash driven by real backend values only. No fabricated data. Includes `useCountdownTo` hook for live market session countdowns.
- **Top bar phase-isolated for Dummy** (`components/layout/global-topbar.tsx`): when `isDummyMode`, the top bar shows a MARKET status pill (`useDummyMarket` polls `/api/dummy/market-session`) in the status cluster. The Data Saver Alerts button is hidden. The notification bell is replaced by `DummyNotificationPanel` that reads **only** `/api/dummy/notifications` — cross-phase notifications never leak into Dummy. Dummy-specific unread badge drives the bell.
- **Sidebar badge isolated** (`components/layout/phase-sidebar.tsx`): when `config.id === 'trading-dummy'`, the notification badge shows Dummy unread from `/api/dummy/notifications` (`useDummyUnread` hook); Data Saver alert badge is hidden for Dummy shell.
- **PWA verified**: `manifest-trading.json` (serves Dummy + Kotak Trading) already includes `/trading/orders` shortcut; orientation fixed to `any` for responsive landscape support. `sw.js`, `offline.html`, icons (192/512 + maskable) confirmed. `app/layout.tsx` RegisterSW wired. Mobile touch targets on topbar hamburger, search and More menu bumped to `min-h-[44px] min-w-[44px]` for Android touch guidelines.
- **No fake data**: every KPI, market value, gainers/losers, session countdown, badge count, notification, comparison and status indicator comes from the real Dummy backend or the single Kotak WebSocket engine. Unavailable terminals show real `—` / `Unavailable` / `NOT ACTIVE` states. Market closed states shown honestly with timestamp.
- **Backend verification**: all frontend changes verified — `npx tsc --noEmit` clean; `eslint` 0 errors (212 pre-existing warnings); `next build` clean; backend pytest 375 passed / 1 pre-existing failure. `pip check` clean; `neo_api_client` version 3.0.6 confirmed. Live endpoints: `data_saver:route` FULL_RAW P0 online, `publish_errors:0`.

### Central Kotak WebSocket Engine (NEW — Services → WebSocket Engine)
- Single-owner canonical stream engine (`python-service/ws_socket/engine/*`): the existing `ws_manager` remains the only Kotak SFeed connection; a publish hook fans every decoded SFeed message into the engine.
- `canonical.py` — canonical envelope + immutable raw-store (broker values verbatim, no derived fields in raw payload).
- `registry.py` — deduplicated subscription registry (merges subscriptions/watchlist/pins consumers into one broker set).
- `profiles.py` — 7 built-in field profiles validated against the canonical schema; `pins.py` — manual/AI/Top-5 pin intents; `resources.py` — configurable RAM/CPU thresholds + degradation policy (controlled in-process disable, P0 never silently stopped).
- `router.py` — priority-ordered tick routing with backpressure (P0/P1 never gated silently).
- `fields.py` + `verification.py` — 344-field master schema; generates `docs/kotak_ws_field_verification.txt` (344 rows, real SDK-sourced classification).
- Control API `api/ws_engine.py` under `/api/services/websocket/*` (status/metrics/health, subscriptions, watchlist, pins, field-profiles + verification, consumers/routes, raw-stream, resources, connect/disconnect/reconnect, subscribe/unsubscribe) proxied by `app/api/phase2/websocket-engine/[...path]/route.ts`.
- New Services page `/services/websocket-engine` showing live connection, feed, subscriptions, pins, consumers, resources and the 344-field verification table (no fabricated values).
- Backend tests `tests/test_ws_engine.py` (26) + frontend `lib/ws-engine.ts` unit tests (4).

## [2.0.0] — 2026-08-01

### Phase Restructure
- Reorganized navigation into Phase 1 (Data Saver), Phase 2 (Trading Terminal), and System sections
- Rebuilt sidebar with phase-based grouping and icon color coding

### Phase 1 — Data Saver Terminal (NEW)
- **Live Tick Table** (`/live-ticks`): Real-time SSE tick streaming, no dummy rows, pause/resume, symbol filter
- **System Indicators** (`/dashboard`): All 20 required status fields (Python, Node, MongoDB, Kotak, Scheduler, Internet, WebSocket, API, Data Saving, Today's Records, Last Tick, Last Login, Last Logout)
- **Stock Subscription** (`/stocks`): Search, add, subscribe, unsubscribe, delete with live subscribed list
- **Custom Download** (`/downloads`): Single/multiple/all stocks, date range, CSV/JSON

### Phase 2 — Trading Terminal (REBUILT)
- **Trading Dashboard** (`/trading`): Mode indicator, connection status, total amount, position summary, last viewed stock
- **Position** (`/positions`): Total charges, total profit, net profit cards + per-position cards with SL, modify, square off
- **Order** (`/orders`): View Order tab (search, circuit limits, margin, MIS-disable with dark card) + Basket Order tab (balance, push, cancel-on-fill)
- **Account** (`/funds`): Dummy mode (add/withdraw coins) + API mode (real balance from Kotak)
- **Stock** (`/market-watch`): Gainers/Losers with ₹5/₹10/₹20/₹25 filters, sorted by ₹ price movement
- **Settings** (`/settings`): 10 categories (Profile, General, Python, Trading, Data Saver, Download, MongoDB, Logs, Notifications, Security) with 65+ settings
- **Notifications** (`/notifications`): Trading, order, position, login, connection, system alerts

### Backend (NEW + FIXED)
- **Basket Orders**: New model, controller, route with cancel-on-fill logic
- **SSE Live Tick Stream**: `GET /api/ticks/stream` for real-time tick streaming
- **Recent Ticks API**: `GET /api/ticks/recent` for MongoDB fallback
- **Gainers/Losers**: `GET /api/statistics/gainers-losers` with MongoDB aggregation
- **Tick Buffer**: Added EventEmitter for SSE streaming + recent tick ring buffer
- **Trading Controller**: Fixed envelope unwrapping (was sending wrapper to frontend)
- **Tick Controller**: Fixed private property access (buffer.length → stats().bufferLength)
- **Search Endpoint**: Fixed GET→POST method mismatch
- **Settings Service**: Expanded from 10 to 65+ defaults across 10 categories
- **Settings Routes**: Added reset-one and reset-all endpoints

### Python Service (VERIFIED)
- Official Kotak Neo SDK (v2.0.2) — login, session, WebSocket, reconnect, scheduler
- Auto login: Mon-Fri 09:00 IST, auto logout: 16:00 IST
- Tick forwarding to Node.js via HTTP (fire-and-forget with bounded queue)
- WebSocket auto-reconnect with exponential backoff + heartbeat monitoring
- Subscription restoration after reconnect
- Fixed: `forward_log` import was missing (caused crash on all trading API calls)

### PWA
- manifest.json with standalone display, theme color, maskable icons
- Service worker with offline caching and navigation fallback
- Offline page with retry button
- SW auto-registration via client component
- PWA metadata in root layout

### UI Fixes
- Hydration-safe date formatting (mounted guard + safe time helpers)
- No blank pages, no black screens
- All 19 pages build and render correctly
- Toast system fixed (shadcn useToast + Toaster, not Sonner)

## [1.0.0] — 2026-07-31
- Initial project setup with Python + Node.js + MongoDB + Next.js architecture
- Basic dashboard, trading, stocks, downloads, logs, notifications, settings pages
- PWA manifest, service worker, icons
