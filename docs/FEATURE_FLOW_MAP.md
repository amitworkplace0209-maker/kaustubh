# FEATURE_FLOW_MAP.md — Har Feature Kaise Kaam Karta Hai (Current State)

> **Ye doc kis liye hai:** Isme project ka **har feature** listed hai — wo kya hai, kahan se
> start hota hai (entry point), andar kya hota hai (flow), aur kaunsi files/engines involved
> hain. Sab kuch **actual source code** se nikala gaya hai (2026-10-05 scan).
>
> **Code hi authority hai.** Jahan purane docs (`docs/architecture/00_`–`35_`, `docs/engines/`)
> code se alag baat karte hain, unka claim yahan nahi maana gaya. Is file ka authority order:
> `source code` > `docs/api|config|database|frontend/*` (code-extracted) > baaki legacy docs.
>
> **Language:** Hinglish (technical terms English mein). Tables/flow English.

**Created**: 2026-10-05
**Scope**: `C:\project` full repo scan
**Method**: Static code scan. Koi code run nahi kiya, koi runtime state observe nahi kiya.

---

## 0. TL;DR — Ek nazar mein

| # | Feature | Layer | Entry Point |
|---|---------|-------|-------------|
| F01 | App Shell & Navigation | Frontend | `components/layout/app-shell.tsx:24` |
| F02 | Authentication & App Lock | Next | `app/login/page.tsx` |
| F03 | API Proxy Layer (61 routes) | Next | `lib/backend.ts:11` |
| F04 | Realtime WebSocket (WS#3/#4) | Both | `python-service/api/ws_gateway.py:278` |
| F05 | Market Data Pipeline | Backend | `python-service/ws_socket/ws_manager.py` |
| F06 | Session & Subscription Mgmt | Backend | `services/session/session_manager.py:313` |
| F07 | Order Management | Both | `components/orders/trade/order-ticket.tsx` |
| F08 | Basket Orders | Both | `components/orders/basket/basket-page.tsx` |
| F09 | Suggestions Inbox | Both | `components/orders/suggestion/suggestion-page.tsx` |
| F10 | Risk & Margin | Both | `core/engines/margin_engine.py` |
| F11 | Target / SL / Squareoff | Backend | `core/engines/target_engine.py`, `squareoff_engine.py` |
| F12 | Positions / Holdings / Funds | Both | `lib/account-service.ts:320` |
| F13 | Statutory Charges Engine | Frontend | `lib/charge-engine.ts:281` |
| F14 | Market Watch | Both | `services/market_watch_engine.py:200` |
| F15 | Watchlist Engine | Both | `services/watchlist_engine.py:73` |
| F16 | Stock Subscription | Backend | `api/stocks.py:474` |
| F17 | Live Ticks (SSE) | Both | `api/ticks.py:26` |
| F18 | Downloads / Exports (25 formats) | Backend | `api/downloads.py:270` |
| F19 | Scheduled Downloads (cron) | Backend | `api/scheduled_downloads.py` |
| F20 | Data Center (observability) | Backend | `services/data_center.py:966` |
| F21 | Data Quality | Backend | `api/quality.py:606` |
| F22 | Tick Analytics | Backend | `api/tick_analytics.py:85` |
| F23 | Insights & Reports | Backend | `api/insights.py:26` |
| F24 | Notifications & Alerts | Backend | `services/notification_center.py:209` |
| F25 | WebSocket Engine Diagnostics | Backend | `api/ws_engine.py:83` |
| F26 | Engine Control Plane | Backend | `api/engine_control.py:32` |
| F27 | Storage Engine & Retention | Backend | `services/storage_engine.py:131` |
| F28 | DB Writer Engine | Backend | `services/db_writer_engine.py:303` |
| F29 | Settings System | Both | `lib/settings/schema.ts:18` |
| F30 | Theme Engine | Frontend | `lib/phase2-theme.ts:208` |
| F31 | Scheduler (IST daily timeline) | Backend | `scheduler/__init__.py:395` |
| F32 | Terminal Mode Switching | Both | `lib/terminal-mode.ts:56` |
| F33 | Security (PIN / WebAuthn / Mode Lock) | Backend | `api/security.py:85` |
| F34 | Instrument Search & Master | Both | `services/instrument_cache.py` |
| F35 | Khumbha AI App | Separate | `khumbha-ai/main.py:34` |
| F36 | PWA (offline + push) | Frontend | `public/sw.js` |
| F37 | Broker Adapters | Backend | `brokers/broker_registry.py:55` |
| F38 | Audit Trail | Backend | `services/audit_engine.py` |
| F39 | Tests | Both | `tests/*.test.ts`, `python-service/tests/` |

---

## 1. Project Identity & Stack

| Layer | Tech | Version / Entry |
|-------|------|-----------------|
| Frontend | Next.js App Router + React + TypeScript + Tailwind | `app/layout.tsx:38` |
| BaaS Proxy | Next.js Route Handlers (61 files) | `lib/backend.ts` |
| Backend | Python + FastAPI + uvicorn + Motor (async Mongo) | `python-service/app.py:1032` |
| Database | MongoDB (local ya Atlas) | `python-service/database/connection.py` |
| AI Runtime | Standalone FastAPI (numpy) | `khumbha-ai/main.py:34` |
| Realtime | 1 WebSocket route, 4 logical channels | `api/ws_gateway.py:278` |

**Ports**: Frontend `3000` · Backend `8000` · AI `8001`

### 1.1 Commands (verified from `package.json:5-12`)

```bash
npm run dev         # next dev
npm run build       # next build
npm run start       # next start
npm run lint        # eslint .
npm run typecheck   # tsc --noEmit
npm test            # node --test "tests/*.test.ts"
```

Backend ke liye: `python-service/start_backend.py` (`run|status|stop|restart`),
`python-service/watchdog_backend.py`.

### 1.2 Repo Shape (measured counts)

| Path | Count | Role |
|------|-------|------|
| `app/` | **188** `page.tsx`, **61** `route.ts` | Next App Router — 5 route groups |
| `components/` | **190** files | UI + layout + trading + terminal |
| `lib/` | **65** files | API clients, stores, engines (client-side) |
| `hooks/` | 9 files | Custom hooks |
| `python-service/api/` | **41** modules | FastAPI routers |
| `python-service/` | ~200 `.py` | Engines, services, brokers, WS stack |
| `docs/` | ~230 files | Documentation (2 parallel sets — see §12) |
| `archive/legacy/` | 50 files | Dead code, `tsconfig.json:43` se excluded |

### 1.3 App Route Groups (`app/`)

| Group | Base path | Shell config | Pages |
|-------|-----------|--------------|-------|
| `(phase2)` | `/data-saver/*` | `DATA_SAVER_SHELL` (`lib/nav.ts:109`) | ~34 |
| `(trading)` | `/trading/*` | `getTradingShellConfig(mode)` (`lib/nav.ts:685`) | ~23 |
| `(services)` | `/services/*` | `SERVICES_SHELL` (`lib/nav.ts:469`) | ~45 |
| `(ai)` | `/ai/*` | `KHUMBHA_AI_SHELL` (`lib/nav.ts:609`) | ~14 |
| `(dashboard)` | flat legacy | reuses `<Shell workspace="trading">` (`app/(dashboard)/layout.tsx:11`) | ~14 |
| `app/_pages/` | **not routable** | Next private folder — par live implementation yahin hai | 38 `page.tsx` |

> **Important:** `app/_pages/` private folder hai, route nahi. Par `/services/*` ke
> wrapper pages `dynamic(() => import('@/app/_pages/…'))` se yahin se load karte hain.
> Yani asli page implementation `_pages/` mein hai, routing `app/(services)/` se hoti hai.

---

## 2. Application Shell & Navigation (F01)

### Kya hai?
Poora UI ka frame — sidebar, topbar, mobile nav, overlays. Har app (Data Saver / Trading /
Services / AI) apna alag shell config use karta hai.

### Kaise kaam karta hai?

```
app/layout.tsx:38
  └─ AppProviders (components/layout/app-providers.tsx:37)
       ├─ 1. ThemeProvider          ← active app ka palette apply
       ├─ 2. AuthProvider           ← session; realtime isko gate karta hai
       ├─ 3. PhaseProvider          ← route se "phase" identity
       ├─ 4. TerminalProvider       ← DUMMY / KOTAK / SHOONYA context
       ├─ 5. RealtimeProvider       ← backend SSE bridge
       ├─ 6. FrontendRealtimeProvider ← /ws/realtime socket (WS#3 down / WS#4 up)
       ├─ 7. SessionSyncProvider    ← central session countdown
       ├─ 8. SettingsBootstrap      ← persisted prefs load
       ├─ 9. SystemProvider         ← /api/system poll
       └─ TerminalModeReconciler    ← UI mode ↔ backend session_manager.mode sync
  └─ per-group Shell
       └─ GlobalTopBar
       └─ PhaseShell (PhaseSidebar + PhaseContent)
       └─ PhaseMobileNavigation
       └─ GlobalOverlays
```

Provider order **important** hai — `AuthProvider` `RealtimeProvider` se pehle hai, warna
realtime bina session ke connect ho jayega.

`DataSaverProvider` (`components/phase2/data-saver-provider.tsx`) **sirf** `(phase2)` layout
mein mounted hai (`app/(phase2)/layout.tsx:6`) — baaki apps ko nahi milta.

### Topbar Status Engine
`lib/topbar-status.ts` — pure functions, koi network nahi:
- `deriveStatus()` `:179` — overall health
- `deriveApiEntry()` `:528` · `deriveFeedEntry()` `:556` · `derivePipelineEntry()` `:599`
- `deriveCpuEntry()` `:637` · `deriveMemEntry()` `:660` · `deriveOrdersEntry()` `:682`
- `summarize()` `:764` · `canonicalSessionState()` `:481`
- `maskUser()` `:505` / `maskSession()` `:513` — PII masking

Context registry: `lib/topbar/context-registry.ts` — `getTerminalContext()` `:108`,
`resolvePageContext()` `:248`, `getBreadcrumb()` `:286`, `rankSearchResults()` `:339`.

### Global Search
`components/layout/universal-search.tsx` → `lib/navigation/registry.ts`
`getSearchIndex()` `:108`, `getBreadcrumb()` `:147`, `getNavigationGroups()` `:78`.

### Backward-compat Redirects
`next.config.js:9-58` — 30+ redirects (`/phase2/*` → `/data-saver/*`, `/data/*` →
`/data-saver/*`, legacy flat → `/trading/*`).

---

## 3. Authentication & App Lock (F02)

### Kya hai?
Do **alag-alag** auth layers hain. Ye confusion sabse common hai — dhyan se padho.

| Layer | Kya hai | Storage |
|------|---------|---------|
| **Next layer** (F02) | App-lock: 6-digit PIN → HMAC signed cookie | `.auth/app-lock.json` (filesystem) |
| **Backend layer** (F33) | Broker session + mode lock (PIN/WebAuthn) | MongoDB + in-memory |

### Next layer routes

| Route | File | Methods |
|-------|------|---------|
| `/login` | `app/login/page.tsx` | UI |
| `/api/auth/login` | `app/api/auth/login/route.ts:33`, `:89` | POST (PIN), DELETE |
| `/api/auth/logout` | `app/api/auth/logout/route.ts:13`, `:29` | POST, DELETE → backend `/api/logout` |
| `/api/auth/manual-login` | `app/api/auth/manual-login/route.ts:8`, `:24` | POST → backend `/api/login` |
| `/api/auth/session` | `app/api/auth/session/route.ts:5` | GET |
| `/api/auth/setup` | `app/api/auth/setup/route.ts:8`, `:26` | GET, POST |
| `/api/auth/pin/change` | `app/api/auth/pin/change/route.ts` | POST |
| `/api/auth/pin/disable` | `app/api/auth/pin/disable/route.ts` | POST |
| `/api/demo/login` `/logout` | `app/api/demo/login/route.ts:9` | POST/DELETE |
| `/api/phase2/login` `/logout` | `app/api/phase2/login/route.ts:8` | POST |
| `/api/health` | `app/api/health/route.ts:23` | GET → backend `/api/system/health` |

### Crypto (`lib/auth-crypto.ts`)
```
hashPin(pin, salt)             :16   sha256(pin + salt)
generateSalt()                 :20
constantTimeCompare()          :24   timing-safe compare
createSessionToken()           :109  base64url(payload).base64url(HMAC-SHA256), TTL 24h (:107)
verifySessionToken()           :119  constant-time sig check + exp check
resolveSessionSecret()         :64   APP_SESSION_SECRET → .auth/session-secret → generated (0o600)
loadConfig/saveConfig/remove   :29/39/46   .auth/app-lock.json
```

PIN regex 6 digits: `app/api/auth/login/route.ts:59`.

> ⚠ **Known defect (F02-S1):** Root mein `proxy.ts` hai jo HMAC session gate karta hai,
> par Next.js 16 mein middleware file ka naam `middleware.ts` hona chahiye. `middleware.ts`
> exist nahi karta (`Test-Path` = False) → **ye gate runtime pe kabhi nahi chalta**,
> bhale `API.md` aur `proxy.ts:72` claim karte hon.

---

## 4. API Proxy Layer (F03)

### Kya hai?
Browser direct Python backend ko call nahi karta (CORS + preflight problem). 61 Next
route handlers proxy ka kaam karti hain.

### Core bridge — `lib/backend.ts`
| Function | Line | Behaviour |
|----------|------|-----------|
| `backendFetch()` | `:11` | 12s default timeout, AbortController |
| `backendJson()` | `:54` | JSON parse |
| `backendText()` | `:66` | 20s, raw CSV ke liye |
| `proxyFail()` | `:106` | error envelope |

Base URL resolve: `BACKEND_URL || NEXT_PUBLIC_API_BASE || http://127.0.0.1:8000` (`lib/backend.ts:9`).

### Route → Backend mapping (representative)

| Next route | Backend target |
|------------|----------------|
| `/api/phase2/dashboard` `route.ts:174` | `/api/system/dashboard?hours=` — **60 KB aggregation** |
| `/api/phase2/system` `:16` | `/api/system` |
| `/api/phase2/alerts` `:22`, `:117` | `/api/notifications?limit=100`, `/api/system/dashboard`, `PUT /api/notifications/read-all` |
| `/api/phase2/analytics` `:38` | 6× `/api/data-saver/tick-analytics/*` + CSV (backendText) |
| `/api/phase2/quality` `:16` | `/api/system/quality-metrics`, `/api/system`, `/api/statistics`, `/api/stocks?active=true` |
| `/api/phase2/ticks` `:48` | `/api/ticks/recent`, `/api/stocks`, `/api/ticks/stats` |
| `/api/phase2/subscriptions` `:12`, `:78` | `/api/stocks?active=false`, `/api/system`, `POST /api/stocks/bulk` |
| `/api/phase2/watch-list` `:18`, `:63`, `:89` | `/api/watch-list` GET/POST/DELETE |
| `/api/phase2/schedules` `:18`, `:51` | `/api/scheduled-downloads`, `/runs`, `/health` |
| `/api/phase2/data-center` `:90`, `:135` | 7 parallel fetch + `POST .../snapshots/capture`, `/deep-scan` |
| `/api/phase2/configuration` `:75`, `:118` | `/api/settings`, `/api/downloads/formats`, `PUT /api/settings/{key}` |
| `/api/data-quality/[...path]` `:17`, `:36` | `/api/data-quality/*` wrapped in `{ok, ...}` envelope |
| `/api/market-watch/[...path]` `:36`, `:69`, `:74` | `/api/market-watch/*` |
| `/api/services/engines` + `[...path]` | `/api/services/engines*` |
| `/api/services/storage` + `[...path]` | `/api/services/storage*` |
| `/api/phase2/websocket-engine/[...path]` `:24`–`:72` | `/api/services/websocket/*` GET/POST/PUT/DELETE |
| `/api/phase3/session-manager/[...path]` `:24`, `:39` | `/api/phase3/session-manager/*` |
| `/api/realtime/token` `:111` | `POST /api/user/login`, `/api/realtime/token` (`runtime='nodejs'`) |
| `/api/trade/demo/{ltp,order,positions}` `:14` | `/api/demo/*` |

### Client-side
`lib/api.ts` (**47 KB, ~300 exported functions**) — `apiFetch()` `:35` with timeout,
abort-reason, **no-preflight GET**, priority hint. Organised: system `:90-96`, stocks
`:107-126`, settings `:128-137`, downloads `:140-251`, schedules `:304-361`, scheduler
`:366-378`, realtime `:380-386`, watchlist `:388-447`, notifications `:450-478`,
alerts `:482-513`, websocket `:520-551`, trading `:555-666`, search `:622-651`,
types `:668-921`.

**Do access paths hain** ( dono valid):
1. Direct cross-origin `lib/api.ts` → `http://127.0.0.1:8000` (GET preflight-free)
2. Same-origin proxy `/api/phase2/*` → aggregation, CORS-free

---

## 5. Realtime WebSocket — WS#3 / WS#4 (F04)

### Kya hai?
Ek **hi** WebSocket route code mein hai: `/ws/realtime`. Upar se 4 *logical channels*
multiplex hote hain (WS#1/WS#2 broker side ke hain, client ko dikhte nahi).

> **Ye sabse important clarification hai.** Docs mein "4 WebSockets" likha hai.
> Code scan me: `@router.websocket()` decorators poore `api/` me **exactly 1** —
> `api/ws_gateway.py:278`. `/ws...` path strings bhi exactly 1.
> WS#1 (Kotak SFeed) aur WS#2 (OrderFeed) broker↔backend hain, browser se connected nahi.

| Logical channel | Direction | Kaun |
|-----------------|-----------|------|
| WS#1 | Kotak Neo → Backend | Market data SFeed (`ws_socket/ws_manager.py`) |
| WS#2 | Kotak Neo → Backend | Order/position feed (`ws_socket/order_feed_manager.py`) |
| **WS#3** | Backend → Frontend | `connection_engine` fan-out |
| **WS#4** | Frontend → Backend | Commands (place/cancel order, subscribe) |

### Channels (`python-service/connection_engine/channels.py`)

**Market channels** (`:12`) — tick data, field-profile + priority ke saath:
| Channel | Profile | Priority | Min interval |
|---------|---------|----------|--------------|
| `watchlist` | WATCHLIST_LIGHT | P2 | 1.0s |
| `market_watch` | WATCHLIST_LIGHT | P2 | 1.0s |
| `trading` | POSITION_CRITICAL | P1 | 0.5s |
| `ai` | AI_HIGH | P1 | 0.4s |

**State channels** (`:36`) — non-tick, backend events se bridged:
`positions` · `orders` · `notifications` · `system` · `data` · `engines` ·
`market_watch` · `data_center`

### Flow
```
Frontend: lib/realtime-ws.ts RealtimeClient:129 (singleton :834)
  ├─ connect() :217   → GET /api/realtime/token → ws://.../ws/realtime
  ├─ auth     → token verify (ws_gateway.py:413 auth.ok)
  ├─ subscribe(specs) :475  → { action:'subscribe', channels:[...], request_id }
  │     server: connection_engine.subscribe() (ws_gateway.py:421) → subscription.ack :422
  ├─ unsubscribe(specs) :550 → ws_gateway.py:428
  ├─ requestSnapshot() :576
  ├─ placeOrder()  :590 → order.ack (ws_gateway.py:482-554)
  └─ cancelOrder() :598
        ↓ WS#3 frames (envelope: type, event_id, timestamp, sequence, channel, symbol, schema_version, data)
  getTicks() :173 / getTick() :177 / onFrame() :186 / onStateChange() :181
        ↓
  hooks/use-live-stocks.ts:173  → components
```

Token helper: `getRealtimeToken()` `:837`, URL builder `realtimeWsUrl()` `:106`.

---

## 6. Market Data Pipeline (F05)

### Kya hai?
Kotak Neo ke SFeed WebSocket se raw market data aata hai, canonical form me convert hota
hai, feature/quality/risk engines se guzarta hai, Mongo me persist hota hai, aur frontend
ko WS#3 se fan-out hota hai.

### Flow
```
Kotak Neo SFeed
  ↓ WS#1
ws_socket/ws_manager.py  (96 KB — SFeed ka SOLE owner; supervisor, reconnect, subscribe/ACK)
  ↓
ws_socket/engine/  (12 modules)
  ├─ engine.py            WebSocketEngine :49
  ├─ canonical.py         PreservedRawStore :240
  ├─ master_canonical.py  MasterCanonical :354
  ├─ registry.py          SubscriptionRegistry :51
  ├─ router.py            TickRouter :72
  ├─ quality.py           FeedQualityMonitor :286
  ├─ fields.py            344-field master schema
  ├─ profiles.py          FieldProfileStore :139
  ├─ pins.py              PinManager :74
  ├─ resources.py         ResourceMonitor :91
  ├─ verification.py      field verification
  └─ storage.py           to_storage_doc()  ← DATA_SAVER consumer
  ↓
EngineEventBus (services/engine_event_bus.py — EngineEvents :60, EngineEventBus :138)
  events: TICK_RECEIVED / VALIDATED / REJECTED
  ├─→ feature_engine, market_coach, watchlist_engine, risk_engine
  ├─→ storage.py → tick_buffer.py → Mongo db.ticks
  └─→ connection_engine → WS#3 → FrontendRealtimeProvider → hooks → components
```

Diagnostics UI: `/data-saver/websocket` page (93 KB) + `/api/phase2/websocket-engine/*`
proxy → `api/ws_engine.py` (38 endpoints). Key: `/status` `:83`, `/field-verification`
`:348`, `/field-profiles` `:319`, `/consumers` `:366`, `/routes` `:361`, `/raw-stream`
`:400`, `/resources` `:421`, `/connect|disconnect|reconnect` `:434/439/444`.

---

## 7. Session & Subscription Management (F06)

### Kya hai?
Kaunse instruments broker se subscribe rahe hain, ye **ek hi jagah** decide hota hai.
`CentralSessionManager` 165 KB ka hai aur ~100 methods hain.

### Flow
```
Scheduler (08:50 login → 08:55 WS start)
  ↓
CentralSessionManager (services/session/session_manager.py:313)
  ├─ refresh_desired_subscriptions() :1554
  ├─ apply_daily_subscription_intent() :1758
  ├─ set_pin_intents() :1922
  ├─ subscribe_instrument() :2414 / unsubscribe_instrument() :2465
  ├─ mark_broker_subscribed() :1977
  ├─ expire_subscription() :2030
  ├─ reconcile() :2812
  ├─ connections_snapshot() :2941
  ├─ phase3_snapshot() :3000
  └─ auth_gate() :3473
  ↓ daily intent + revision++
SubscriptionRegistry (ws_socket/engine/registry.py:51) — merge / dedup / diff
  ↓
WebSocketEngine → ws_manager → Kotak SFeed
```

### API (`api/session_manager.py`, 33 endpoints, prefix `/api/phase3/session-manager`)
`/overview` `:101` · `/revision` `:118` · `/connections` `:123` ·
`/subscriptions/daily-intent` `:136` · `/instruments` `:179` · `/reconcile` `:407` ·
`/session/history` `:474` · `/diagnostics` `:511` · `/config` `:566`

**UI**: `/services/session-manager/*` — 14 pages (session, instruments, subscriptions,
sources, pins, expiry, connections, live-feed, history, reconcile, configuration,
diagnostics, manual-add).

---

## 8. Order Management (F07)

### Kya hai?
Order ticket se lekar broker tak, aur wapas order update/ack tak — poora lifecycle.

### Flow
```
components/orders/trade/order-ticket.tsx
  │  (form: qty / price / order type / product)
  ├─ charges-panel.tsx       live charge breakdown  → lib/charge-engine.ts
  ├─ risk-margin-panel.tsx   margin availability
  ├─ target-panel.tsx        TARGET / STOP_LOSS arming
  ├─ order-preview.tsx       pre-submit preview
  └─ execution-state.tsx     order lifecycle view
  ↓
useFrontendRealtime().placeOrder()  (WS#4, realtime-ws.ts:590)
   — ya —
lib/api.ts#placeOrder → REST /api/trading/order/place
  ↓
api/trading.py:118
  ↓
OrderEngine → RiskEngine → MarginEngine → AuditEngine
  ↓
broker adapter (kotak_adapter.py)
  ↓
Kotak REST
  ↓ WS#2
order_feed_manager.py → EngineEventBus
  ↓
connection_engine → WS#3 → UI
  + on reconnect: REST order_report / trade_report poll
```

### Supporting files
| File | Kaam |
|------|------|
| `components/orders/trade/auth-gate.tsx` | session gate |
| `components/orders/trade/capabilities.ts` | broker capability flags |
| `components/orders/trade/lifecycle.ts` | order status machine |
| `lib/order-workspace.ts` | `ORDER_ROUTES` `:12`, `marginAfterOrder()` `:39`, `hasMarginShortfall()` `:48`, `chargesTotal()` `:57`, `validateTicket()` `:82` |
| `lib/normalizers.ts` | `normalizeOrderStatus()` `:57`, `orderStatusLabel()` `:70`, `orderStatusBadgeClasses()` `:83` |
| `lib/basket-draft.ts` | draft persistence `:81-103` |
| `components/orders/notification-bell.tsx` | unread badge + dropdown |

**UI**: `/trading/orders` (`app/(trading)/trading/orders/page.tsx:16`) — tabbed module
Trade / Basket / Suggestion / History via `components/orders/orders-tabs.tsx`.

---

## 9. Basket Orders (F08)

```
components/orders/basket/basket-page.tsx (75 KB)
  ├─ basket-execution.tsx   sequential push runner
  └─ types.ts
  ↓ draft: lib/basket-draft.ts (setBasketDraft/takeBasketDraft/clearBasketDraft :81-103)
  ↓ push
api/baskets.py  →  POST /api/baskets/{id}/push :224
  ↓
lib/terminal-service.ts#placeTerminalBasket() :303
  ↓
same order pipeline as F07 (per-leg)
```

Legacy UI bhi maujood: `components/orders/basket-manager.tsx` (41 KB),
`components/orders/basket-order-panel.tsx`.

**UI**: `/trading/basket-orders` (`app/(trading)/trading/basket-orders/page.tsx:8`).

---

## 10. Suggestions Inbox (F09)

```
components/orders/suggestion/suggestion-page.tsx (30 KB)
  ├─ suggestion-pipeline.tsx   accept / reject pipeline
  └─ types.ts
  ↓ accept
order engine → normal F07 pipeline
  ↓
Backend source: api/dummy.py /suggestions :203
                 services/dummy_extras.py (69 KB — dummy-mode suggestions)
```

**UI**: `/trading/suggestion` (`app/(trading)/trading/suggestion/page.tsx:8`).

---

## 11. Risk & Margin (F10)

```
core/engines/margin_engine.py     (registered but NOT auto-started — app.py:748 se bahar)
core/engines/risk_engine.py       (implement hai par REGISTERED NAHI — sirf API router)
  ↓
api/risk_engine.py  prefix /api/services/risk  (4 endpoints)
  ├─ /validate  :35
  ├─ /snapshot  :57
  └─ /config    :66
  ↓
Frontend: components/risk/risk-dashboard.tsx  (mode-aware)
          components/orders/trade/risk-margin-panel.tsx
          lib/order-workspace.ts#hasMarginShortfall() :48
```

> ⚠ **Known inconsistency (F10-S1):** `DOCUMENTATION_AUTHORITY.md §4` sahi tha —
> `risk_engine`, `target_engine`, `pnl_engine`, `basket_engine` `core/engines/` mein
> implemented hain par **engine registry mein registered nahi** hain.
> `margin_engine` aur `squareoff_engine` registered hain par **auto-start nahi** hote.

**API**: `/api/services/risk/*` via `/api/phase3/...` style proxies.

---

## 12. Target / Stop-Loss / Squareoff (F11)

```
core/engines/target_engine.py       implemented, NOT registered
core/engines/squareoff_engine.py    registered, NOT auto-started
  ↓
Frontend arming: components/orders/trade/target-panel.tsx
                 lib/terminal-service.ts targets :392-404
                 lib/terminal-service.ts#riskPrecheck() :412
  ↓
lib/trigger-store.ts  getTriggerStore() :196 / useTriggers() :211 / triggerHit() :220
  ↓
hooks/use-trigger-engine.ts:29  (TriggerOutcome :21)
  ↓
Backend: /api/services/margin-engine, /api/services/squareoff (services app pages)
```

**UI**: `/services/squareoff`, `/services/target-engine`, `/services/margin-engine`.

---

## 13. Positions / Holdings / Funds (F12)

```
lib/account-service.ts (20 KB)
  ├─ marginUtilisationState()   :87
  ├─ normalizeAccountFunds()    :117
  ├─ normalizeFundsTransaction():244
  ├─ getAccountFunds()          :320
  ├─ getLedgerTransactions()    :358
  ├─ getDailyReport()           :376
  ├─ useAccountData()           :433
  └─ ACCOUNT_STALE_MS = 60_000  :412
  ↓
lib/normalizers.ts  normalizeFunds() :33, normalizePosition() :133
lib/demo-engine.ts  getDemoEngine() :528, useDemoAccount() :565,
                    useDemoTransactions() :572, MAX_DEMO_TRANSACTION_AMOUNT :95
  ↓
Backend: api/trading.py (positions/holdings/funds) · api/demo.py/account :1073
         api/terminal.py (per-terminal account/positions/orders/trades)
```

**UI**: `/trading/positions`, `/holdings`, `/portfolio`, `/funds`, `/account`, `/order-history`.
Dummy mode: `DummyPositions`, `DummyHoldings`, `DummyPortfolio`, `DummyAccount`,
`DummyOrderHistory`. Kotak: `app/_pages/{positions,holdings,portfolio,funds,order-history}/page`.

---

## 14. Statutory Charges Engine (F13)

### Kya hai?
Brokerage, STT, exchange charges, SEBI, stamp duty, GST — sab client side compute hota hai.
**Rule: koi bhi React component me charge rate hard-code nahi hai.**

### Rate tables (`config/`)
`config/brokerage.ts`
- `BROKERAGE_PROFILES` `:42` — Standard Equity Intraday/Delivery 0.03%, Dummy Flat ₹10
- `DUMMY_BROKERAGE_MODE` `:101`
- `resolveBrokerageProfile()` `:115` — **date-aware**, purani history kabhi edit nahi hoti

`config/statutory-charges.ts`
- `STT_CONFIG` `:28` · `EXCHANGE_CHARGES_CONFIG` `:49` · `SEBI_TURNOVER_FEE` `:65`
- `GST_RATE` `:69` · `STAMP_DUTY_CONFIG` `:77`
- `latestApplicable()` `:104` → date-aware resolvers `:110, :123, :133, :139, :145`

### Computation (`lib/charge-engine.ts`)
```
CALCULATION_VERSION = '2024-10-01.1'   :25
normalizeExecution()     :84    duplicate executions hatao
dedupeExecutions()        :109
calculateBrokerage()      :126
calculateSTT()            :146
calculateExchangeCharges():162
calculateSEBICharges()    :173
calculateStampDuty()      :183
calculateGST()            :218
calculateTotalCharges()   :231
calculateCharges()        :281   ← main entry
calculateExecutionCharges():341
buildChargeSnapshot()     :407
```

Service layer: `lib/charge-service.ts` — `estimateFillCharges()` `:66`,
`extractBrokerCharges()` `:104`, `kotakRowToTrade()` `:148`, `demoOrderToTrade()` `:186`,
`calculatePositionCharges()` `:226`. Snapshot store: `lib/charge-snapshot-store.ts:91`.

**UI**: `components/orders/trade/charges-panel.tsx` (live breakdown).

---

## 15. Market Watch (F14)

### Kya hai?
Live movers, ranking, filters, pins — sab `MarketWatchEngine` se. Yeh engine 125 KB ka
hai aur 18 satellite modules me banta hai.

> **2026-10-05 update.** `docs/engines/MARKET_WATCH.md` ke against ek full gap
> analysis hua tha. Spec **weekly-locked** universe describe karta hai, code
> **daily master-derived** universe banata tha. Neeche bataye gaye changes ke baad
> weekly lock, classification, circuit danger, margin contract, ₹800 counters,
> 1% mover boards aur §30 observability metrics sab implement ho chuke hain.
> Poora clause-by-clause map `docs/engines/MARKET_WATCH.md` **APPENDIX A** mein hai.

### Weekly cadence (spec §2 — naya)
```
SATURDAY  Mon-Fri saved data → weekly scan → report → ADD/REMOVE/KEEP → LOCK
MON-FRI    sirf LOCKED list monitor hoti hai. Koi auto add/remove nahi.

services/market_watch_weekly.py    (new)
  build_weekly_report()  :146   ← doc §5 ka poora field list
  trading_days_for()     :44    ← Mon-Fri, calendar-aware
  _week_candles()        :67    ← persisted market_candles_1m se
  _observe_threshold()   :120   ← ≥/≤ ₹800 day counts
  _last_daily_circuit()  :265   ← real circuits + danger days
  _last_margin()         :294   ← sirf Session Manager ka marginDecisions
  _recommend()           :329   ← advisory ADD/REMOVE/KEEP/REVIEW
  persist()              :351   ← DB Writer ke through

services/market_watch_universe.py  (new)
  WeeklyUniverse         :68    ← doc §6 ka versioned lock document
  week_id_for()          :64    ← "2026-W41"
  load_locked_universe() :206   ← ONLY membership source
  record_decision()      :325   ← ADD/REMOVE/KEEP (locked week pe PermissionError)
  lock_universe()        :369   ← version bump + freeze + history
  verify_week()          :427   ← doc §28 step 2, honest verdict
  history()              :262   ← lock audit trail
```

### Engine flow
```
services/market_watch_engine.py  MarketWatchEngine :200
  satellites: config, filters, ranking, state, timeframes, lifecycle, ledger,
              publish, pins, eligibility, doc_buffer, indexes, report
  ↓
doc §3/§7 — Instrument Master metadata ONLY, membership = locked list:
  _build_universe()          :663   → routes to locked path
  _build_locked_universe()   :715   ← membership = exactly the locked symbols
  _locked_symbols()          :337
  load_locked_universe()     :349   ← doc §28 steps 1-2, start par
  _universe_unresolved       :765   ← master me na mile, report (replace nahi)
  ↓
Per-tick (spec §11/§14/§16/§17/§19/§20/§21):
  _process_tick()            :1582  received vs invalid counters
  _record_invalid_tick()     :1610  bounded invalid sample
  _apply_state_tick()        :1064
    ├ recompute_circuit_status()   ← doc §14 SAFE/NEAR/DANGER/HIT/UNKNOWN
    ├ evaluate_movement_flags()    ← doc §21 per-tf 1% flags
    ├ observe_threshold()          ← doc §16 ₹800 counters (count-only)
    ├ _apply_margin_from_session() ← doc §17 authoritative broker margin
    └ evaluate_stock_state()       ← doc §20/§27 classification + stock state
  ↓
Official boards (spec §22) — _run_official_rankings :1969
  top_gainers :2032 · top_losers :2036 · highest_volume :2040
  most_active :2043 · circuit_near :2046 · circuit_danger :2051  (NEW)
  movers_{tf} / decliners_{tf}        :2059
  movers_1pct_{tf} / decliners_1pct_{tf}  :2061  (NEW — doc §21/§22)
  ↓ DANGER + INTRADAY_UNAVAILABLE in koi bhi 1% board me nahi (doc §14/§15)
  ↓
DB Writer hand-off: ingest_market_watch_ticks / buffer_candles / buffer_documents
  ↓
Connection Manager → WS#3 channel "market_watch" → frontend
```

### State model (spec §27 — naya)
`services/market_watch_state.py` `SymbolState`:

| Field group | Reference |
|-------------|-----------|
| `stock_state` ACTIVE/DANGER/INTRADAY_UNAVAILABLE/STALE/NO_DATA/INVALID | `:400` |
| `classification` DANGER/INTRADAY_UNAVAILABLE/GAINER/LOSER/NORMAL | `:401` |
| `movement_flags` per timeframe | `:402` |
| `intraday_status` ELIGIBLE/UNAVAILABLE/UNKNOWN | `:405` |
| `margin_value` / `margin_multiplier` / `margin_status` | `:411` |
| `observations_above_threshold` / `..._at_or_below_threshold` | `:416` |
| `circuit_status` + `min_circuit_distance_pct()` | `:344` / `:566` |
| `evaluate_stock_state()` — doc §20 precedence | `:697` |
| `to_public()` — doc §23 ka poora contract + flat `change_{tf}` | `:800` |

Vocabulary: `services/market_watch_config.py` — `STOCK_STATES` `:255`,
`CLASSIFICATIONS` `:264`, `CIRCUIT_STATUSES` `:275`, `ENGINE_STATES` `:318`,
`WEEK_STATUSES` `:308`.

### Observability (spec §30 — naya)
```
GET /api/market-watch/observability
  + status_snapshot().metrics.custom  engine.py :3138
locked_universe_count · active_subscription_count · received_tick_count
validated_tick_count · invalid_tick_count · danger_count
intraday_unavailable_count · top_gainers_count · top_losers_count
movers_{1m,5m,10m,30m}_count · last_tick_at
processing_latency_ms · publish_latency_ms · websocket_status
+ stockStates · classificationCounts · weekly (lock verify block)
```

### API — 26 se 40 routes
```
api/market_watch.py  prefix /api/market-watch
  Naye (spec §5/§6/§26/§30/§32):
    GET  /weekly · /weekly/universe · /weekly/report · /weekly/reports
         /weekly/history · /observability · /boards · /stock/{symbol}
         /report/daily[/{date}]
    POST /weekly/scan · /weekly/decision · /weekly/lock · /weekly/draft
  Badle:
    /tick-snapshot  → ab eligibility + lastTickAt + doc §23 fields bhi bhejta hai
    /rank           → +14 backend-owned sort keys
    /page           → official boards bhi addressable (pehle unknown_section)
  ↓
api/market_watch_engine.py  prefix /api/market-watch-engine (engine control)
  ↓
Frontend:
  app/_pages/market-watch/  mw-shared · page · weekly (NEW) · report (NEW)
                           overview · movers · rank · filters · pins · symbol
                           status-bar · mw-table
  components/market-watch/market-watch-live.tsx (terminal live view)
  WS#3 channels: state "market_watch" + market "market_watch"
  ↓
UI: /trading/market-watch · /data-saver/watch · /services/market-watch/{page,movers,
    rank,filters,pins,symbol,weekly,report}
```

### Config (spec §2/§14/§16/§17/§21)
`services/market_watch_config.py` `WeeklyConfig` — sab `runtime setting → env → default`:
`mwr_weekly_enabled` · `mwr_weekly_review_weekday` (5=Sat) · `mwr_universe_source`
(**LOCKED** default, doc §3) · `mwr_lock_enabled` · `mwr_lock_default_user` ·
`mwr_rupee_threshold` (800) · `mwr_danger_circuit_pct` (2.0) ·
`mwr_mover_threshold_pct` (1.0) · `mwr_margin_multiplier_threshold` (5.0)

### Tests
`python-service/tests/test_market_watch_weekly_universe.py` — **59 tests** (weekly lock,
classification precedence, circuit UNKNOWN semantics, ₹800 count-only, margin
authority, 1% board exclusion, §30 metrics, doc §24 frontend guard).

> ⚠ **Known defect (F14-S1):** `app/(dashboard)/market-watch/{filters,movers,pins,rank,symbol}`
> — paanchon sub-routes **same** `_pages/market-watch/page` import karte hain. Code me
> inke beech koi differentiation nahi hai.
>
> ⚠ **Open (F14-S2):** weekly lock abhi tak nahi chalaya gaya. Jab tak operator
> `POST /weekly/scan` → decisions → `POST /weekly/lock` nahi chalata,
> `universe_verify.reason = NO_LOCKED_UNIVERSE` hoga aur engine (sahi tarah) empty
> universe monitor karega. Doc §37 ki live verification abhi baki hai.

---

## 16. Watchlist Engine (F15)

```
services/watchlist_engine.py  WatchlistEngine :73
  ↓
api/watchlist_engine.py  prefix /api/watchlist-engine  (15 endpoints)
  ├─ /cards        :103
  ├─ /screen       :179
  └─ /dynamic/{kind} :156
  ↓
api/watchlist.py  (4 endpoints — favorites-first sort)
api/watch_list.py (6 endpoints — /hidden :343, :414)
  ↓
Frontend: lib/api.ts watchlist fns :388-447
  WS#3: market channel "watchlist" (WATCHLIST_LIGHT profile, P2, 1.0s)
  ↓
UI: /trading/watchlist, /data-saver/watch, /data-saver/watch-list, /services/watchlist
```

---

## 17. Stock Subscription (F16)

```
api/stocks.py  prefix /api/stocks  (14 endpoints)
  ├─ /subscribe  :474
  ├─ /details    :598
  ├─ /stats      :682
  ├─ /bulk       :880
  └─ /search, /active…
  ↓
lib/api.ts stocks :107-126
  ↓
Frontend: /data-saver/subscription
  proxy: /api/phase2/subscribe :12, /api/phase2/subscription-search :16,
         /api/phase2/subscriptions :12/:78
  ↓
CentralSessionManager (F06) — yahin se broker subscription decide hoti hai
```

---

## 18. Live Ticks (F17)

**Do paths hain:**

**A) SSE (server-sent events)**
```
hooks/use-tick-stream.ts:123   NormalizedTick :23, TickStreamState :52
lib/shared-sse.ts  subscribeTicks() :120, subscribeSseState() :132
  ↓
api/ticks.py  prefix /api/ticks
  ├─ /stream  :26   SSE
  ├─ /recent  :55
  └─ /stats   :68
  ↓
UI: /data-saver/ticks
```

**B) WebSocket (WS#3)** — `hooks/use-live-stocks.ts:173`
```
StockStatus :10  → LIVE | STALE | WAITING | DISCONNECTED | ERROR | MARKET_CLOSED | UNSUBSCRIBED
DepthRow :12 · LiveStock :18 · TickStats :77
  ↓
hooks/use-latest-ticks.ts:29  (DcLiveTick :14)
  ↓
components render tables/cards
```

---

## 19. Downloads / Exports (F18)

### Kya hai?
25 export formats — CSV se Parquet tak, plus compression variants.

```
api/downloads.py  prefix /api/downloads  (12 endpoints)
  ├─ /formats          :270
  ├─ /preview          :295
  ├─ /history          history list
  └─ /history/{id}/file :658   raw stream
api/export_jobs.py  prefix /api/downloads/exports  (8 — async job lifecycle)
  ↓
services/exporter.py + services/destinations.py
  ↓
Serializers: services/serializers.py  (25 formats)
  CSV · TSV · CSV-BOM · TXT · MD · HTML · XML · SQL · JSON · JSONL · NDJSON ·
  YAML · TOML · XLSX · ODS · Parquet · Feather · ArrowIPC · Avro · SQLite ·
  ZIP · GZip · JSON.GZ · JSONL.GZ
  ↓
Frontend:
  lib/api.ts downloads/exports :140-251
  lib/downloads-store.ts · lib/download-state.ts · lib/format-store.ts · lib/format.ts
  proxy: /api/phase2/downloads/{formats,preview,schema,settings}
         /api/phase2/download-history :11
         /api/phase2/download-history/[id]/file :21   (raw stream)
  ↓
UI: /data-saver/downloads (51 KB), /formats, /download-history
```

**Async jobs** (long exports) ke liye `api/export_jobs.py` — job lifecycle + poll.

---

## 20. Scheduled Downloads (F19)

```
api/scheduled_downloads.py (60 KB, 22 endpoints, prefix /api/scheduled-downloads)
  ├─ /runs      :1033
  ├─ /packages  :1220
  ├─ /{id}/run  :1533   (manual trigger)
  ├─ PUT /{id} · DELETE /{id}
  └─ /test-config
api/schedule_events.py  prefix /api/schedule-events
  └─ /stream :29   SSE — schedule run events
  ↓
Download checker loop: app.py:626-637 (startup)
  ↓
Frontend:
  hooks/use-schedule-events.ts:51  (ScheduleEvent :18, ScheduleState :29)
  lib/schedule-sse.ts  subscribeScheduleEvents() :118, getScheduleSseState() :142
  proxy: /api/phase2/schedules :18/:51, /[id] :26/:42/:55,
         /packages :15, /packages/[packageId]/download :19, /test-config :11
  ↓
UI: /data-saver/schedules, /schedules/new
```

---

## 21. Data Center — Observability (F20)

### Kya hai?
7 "planes" me poora system snapshot. Data Saver ka master UI reference yahi hai.

```
services/data_center.py  PLANES :966
  ├─ database_plane()  :479
  ├─ engines_plane()   :567
  ├─ topology_plane()  :657
  ├─ db_writer_plane() :720
  ├─ ownership_plane() :793
  └─ retention_plane() :890
Snapshot loop: data_center.start_snapshot_loop()  (app.py:840)
  ↓
api/data_center.py  prefix /api/system/data-center  (20 endpoints)
  ├─ /snapshot        :106
  ├─ /deep-scan       :472
  ├─ /deep-scan/{jobId}
  ├─ /export          :554
  ├─ /database :626 · /engines :632 · /topology :638
  ├─ /db-writer :644 · /ownership :650 · /retention :656
  └─ /collections/{name} · /snapshots/capture
  ↓
Frontend (normalizers — 30 functions):
  lib/data-center.ts (58 KB)
    normalizeDcEnvelope() :1322 · DC_WIRE_SECTIONS :1448
    normalizeDatabasePlane() :1070 · normalizeEnginesPlane() :1159
    normalizeTopologyPlane() :1170 · normalizeDbWriterPlane() :1206
    normalizeOwnershipPlane() :1242 · normalizeRetentionPlane() :1275
    deriveStatusStrip() :1566 · LATENCY_BANDS :58
  lib/data-center-snapshot.ts  DC_SNAPSHOT_SCHEMA_VERSION = 2 :21, DcSnapshot :307,
    normalizeSnapshot() :723, normalizeDeepScanJob() :841
  lib/data-center-store.ts  useDataCenterStore() :815,
    dataCenterActions :820 (capture / deep-scan / cleanup)
  lib/data-center-status.ts  deriveHealthRows() :161, useDataCenter() :356
  ↓
proxy: /api/phase2/data-center :90/:135  (7 parallel backendFetch)
       /api/phase2/data-center/snapshot :28
       /api/phase2/data-center/collections/[name] :18
       /api/phase2/data-center/export :21
  ↓
UI: /data-saver/data-center (52 KB) + error.tsx + loading.tsx
WS#3: state channel "data_center" (aggregated single authoritative doc)
```

---

## 22. Data Quality (F21)

```
services/data_quality.py (46 KB) + services/data_quality_live.py (27 KB)
  ↓ live loop: app.py _dq_live_loop :327 (interval _DQ_LIVE_INTERVAL_SEC)
  ↓
api/quality.py (71 KB, 22 endpoints, prefix /api/data-quality)
  ├─ /summary  :606
  ├─ /metrics  :718
  ├─ /duplicates :1047
  └─ /live     :1818
  ↓
Frontend:
  lib/data-quality-client.ts  DataQualityError :20, dqGet :85, dqPost :93,
    dqParamsForFilters :101  (same-origin, preflight-free)
  hooks/use-data-quality-live.ts:116
    DQEngineRef :16 · DQThroughput :28 · DQIngestion :37 · DQIssue :56
  proxy: /api/data-quality/[...path] :17/:36  → { ok, ... } envelope
  WS#3: state channel "data"
  ↓
UI: /data-saver/quality
```

---

## 23. Tick Analytics (F22)

```
services/tick_analytics.py (78 KB — operational analytics)
services/tick_analytics_daily.py (48 KB — daily rollups)
  ↓ publish loop :365  · backfill loop :409  (app.py)
  ↓
api/tick_analytics.py  prefix /api/data-saver/tick-analytics  (21 endpoints)
  ├─ /metrics    :85
  ├─ /timeseries :95
  ├─ /anomalies  :150
  ├─ /daily      :177
  └─ /export     :286
  + state, symbol/*, market-wide
  ↓
Frontend:
  lib/tick-analytics.ts  SECTIONS :21, backendPath() :54,
    statusTone() :256, statusLabel() :267, dailyRowStatus() :279, mergeLive() :400
  lib/reason-taxonomy.ts  REASON_TAXONOMY :26, classifyEvent() :103,
    classifyWsReason() :111, reasonBreakdown() :122
  proxy: /api/phase2/analytics :38  (6 endpoints + CSV via backendText)
  ↓
UI: /data-saver/analytics (83 KB)
```

---

## 24. Insights & Reports (F23)

```
services/ds_insights.py (87 KB — ledger / telemetry / incidents / reports)
  ↓ loops: _telemetry_sampler_loop :189 (60s)
          _incident_correlator_loop :203 (5s)
          _daily_report_loop :216 (60s)
  ↓
api/insights.py  prefix /api/data-saver/insights  (24 endpoints)
  ├─ /live        :26
  ├─ /events      :84
  ├─ /errors      :118
  ├─ /incidents   :141
  ├─ /reports/*   :194-232
  └─ /telemetry/flush :279
  ↓
Frontend:
  lib/insights.ts  24 client fns :529-631, useInsightsStream() :719
  proxy: /api/phase2/insights :23  (system + quality-metrics, limit=100000)
  ↓
UI (9 pages): /data-saver/insights, /today, /attention, /activity, /errors,
              /errors/[id], /reports, /reports/[type], /reports/daily/[date], /reports/weekly
```

---

## 25. Notifications & Alerts (F24)

```
services/notification_center.py (77 KB)  rules :209 + retention loop
  ↓ retention loop: app.py:818 (ncenter_task)
services/notification_engine.py  (registry-registered, auto-started app.py:748)
  ↓
api/notifications.py  prefix /api/notifications  (17 endpoints)
  ├─ /summary      :113
  ├─ /unread-count :118
  └─ /read-all     :215
api/alerts.py  prefix /api/alerts  (16 endpoints)
  ├─ /rules        :88
  ├─ /{id}/acknowledge :144
  └─ /{id}/resolve      :158
  ↓
Frontend:
  lib/shared-notifications.ts  useNotificationsPoll() :52, useNotificationsCache() :67,
    useUnreadCount() :86, useActiveAlertBadge() :145, notificationActions :183
  lib/push-notifications.ts  requestNotificationPermission() :34,
    subscribeToPushNotifications() :59, unsubscribeFromPushNotifications() :92
  proxy: /api/phase2/alerts :22/:117
  ↓
UI: /data-saver/notifications + [notificationId], /data-saver/alerts + [alertId],
    /trading/notifications
  WS#3: state channel "notifications"
  Push: public/sw.js NOTIFICATION_TYPES :33, normalizeNotification() :43
Topbar: components/layout/topbar/{notification-center,alert-control}.tsx
```

---

## 26. WebSocket Engine Diagnostics (F25)

```
api/ws_engine.py  prefix /api/services/websocket  (38 endpoints)
  ├─ /status             :83
  ├─ /field-profiles     :319
  ├─ /field-verification :348
  ├─ /routes             :361
  ├─ /consumers          :366
  ├─ /raw-stream         :400
  ├─ /resources          :421
  └─ /connect :434 · /disconnect :439 · /reconnect :444
services/websocket_history_service.py (28 KB)  ← history storage
  ↓
proxy: /api/phase2/websocket-engine/[...path] :24/:39/:56/:72 (GET/POST/PUT/DELETE)
  ↓
Frontend:
  lib/ws-engine.ts  STATUS_ORDER :11, statusTone() :41,
    fieldRowsFiltered() :62, countsByStatus() :75
  lib/engine-realtime.ts  useEngines() :24, useEngineStatus() :56, useOneShot() :124
  ↓
UI: /data-saver/websocket (93 KB)
```

---

## 27. Engine Control Plane (F26)

### Kya hai?
17 engines ka lifecycle (start/stop/restart), health, metrics, dependency graph — sab HTTP se.

```
services/engine_registry.py  EngineRegistry :26
  ├─ register()            :42
  ├─ start() / stop() / restart()  :70 / :81 / :94
  ├─ get_status()          :104
  ├─ get_health()          :115
  ├─ dependency_graph()    :188
  ├─ summary()             :205
  └─ get_engine_registry() :281
Base class: core/engines/engine_base.py
  EngineState :22 · EngineHealth :38 · EngineCategory :45 ·
  EngineMetrics :56 · EngineBase :79
  ↓
api/engine_control.py  prefix /api/services/engines  (26 endpoints)
  ├─ /summary            :32
  ├─ /dependency-graph   :44
  ├─ /{id}/health        :61
  ├─ /{id}/metrics       :61-93 range
  ├─ /{id}/dependencies · /errors · /activity
  ├─ /{id}/start :104 · /stop · /restart · /heartbeat
  ├─ /broker/*           :136-169
  └─ /db_writer_engine/{flush :189, tick-persistence :200}
  ↓
Frontend:
  proxy /api/services/engines :17/:26, /api/services/engines/[...path] :19/:34
  lib/engine-realtime.ts (useEngines / useEngineStatus / useOneShot)
  ↓
UI: /services/* (engine pages), /services/system, /services/system-indicators
```

### 17 Registered Engines (verified from `app.py:728-745`)

| # | engine_id | Type | Auto-start (`app.py:748`) |
|---|-----------|------|----------------------------|
| 1 | `feature_engine` | native | ✅ |
| 2 | `search_engine` | native | ✅ |
| 3 | `margin_engine` | native | ❌ registered only |
| 4 | `squareoff_engine` | native | ❌ registered only |
| 5 | `watchlist_engine` | native | ✅ |
| 6 | `market_watch_engine` | native | ✅ |
| 7 | `market_coach` | native | ✅ |
| 8 | `storage_engine` | native | ✅ |
| 9 | `db_writer_engine` | native | ✅ |
| 10 | `notification_engine` | native | ✅ |
| 11 | `audit_engine` | native | ✅ |
| 12 | `session_manager_engine` | native | ✅ |
| 13 | `connection_manager_engine` | native | ✅ |
| 14 | `websocket_engine` | native | ✅ |
| 15 | `scheduler_engine` | facade (`SchedulerFacade`) | ❌ status sync only |
| 16 | `order_engine` | facade (`OrderFacade`) | ❌ status sync only |
| 17 | `position_engine` | facade (`PositionFacade`) | ❌ status sync only |

**14 native + 3 facade = 17.** Facades `services/legacy_engine_facades.py:428-432`.
Facade full state mirror nahi karte — sirf `_sync_status()` + `heartbeat()` (`app.py:756-761`).

> ⚠ Purane docs "15 engines (13 native + 2 facade)" bolte hain — **galat**. Code = 17.

---

## 28. Storage Engine & Retention (F27)

```
services/storage_engine.py  StorageEngine :131  (43 KB)
services/storage_guard.py
services/atlas_cleanup.py
api/storage_engine.py  prefix /api/services/storage  (6 endpoints)
  ├─ /snapshot :82
  └─ +5 more
api/cleanup.py  prefix /api/system/cleanup  (4 endpoints)
  ├─ /run      :33
  └─ /storage  :44/:51
  ↓ retention loop: app.py:811  (_retention_cleanup_loop :169, interval 6h)
  ↓ retention_plane() :890 (data center se linked)
  ↓
Frontend: proxy /api/services/storage :13/:22, /api/services/storage/[...path] :19/:34
          /data-saver/settings/storage
  ↓
UI: /services/storage, /data-saver/data-center (retention plane)
```

---

## 29. DB Writer Engine (F28)

### Kya hai?
Har tick Mongo me jayega ya nahi — ye **decision engine** hai. Retention aur cost control yahan se.

```
services/db_writer_engine.py (77 KB)
  DBWriterEngine :303
  ├─ evaluate()                :897   tick evaluate karo
  ├─ _decision()               :858
  ├─ should_persist_tick()     :996
  ├─ ingest_market_watch_ticks() :1269
  ├─ tick_persistence_settings()  :1428
  ├─ DropReason                :235
  └─ TickPersistenceUnavailable :287
  ↓
services/tick_buffer.py (33 KB)  batch → Mongo
  ↓
Mongo `db.ticks` — superset document:
  legacy 28 keys + full SFeed payload + raw model_dump
  ↓
api/engine_control.py  /db_writer_engine/flush :189
                        /db_writer_engine/tick-persistence :200
  ↓
Frontend: lib/data-center.ts normalizeDbWriterPlane() :1206
          /services/db-writer
```

---

## 30. Settings System (F29)

### Kya hai?
19 sections ka control center. Har app ka apna settings page hai, schema shared hai.

```
Frontend schema: lib/settings/schema.ts (50 KB)
  SECTIONS :18  → 19 sections:
    general, appearance, theme, data-saver, market-data, websocket, database,
    scheduler, notifications, alerts, security, app-lock, biometric, pwa,
    privacy, storage, performance, accessibility, advanced, about
  SECTION_INDEX :1477 · ALL_FIELDS :1479 · LIVE_KEYS :1497 · searchSections() :1511
  Types: lib/settings/types.ts  SettingsFieldDef :14, SettingsSectionDef :45
  Icons: lib/settings/icons.ts  ICONS :25, iconFor() :48
  Paths: lib/settings/paths.ts  PHASE_ROUTE = '/data-saver'

Frontend store: lib/settings/store.ts
  getSettingsState() :63 · refreshSettings() :112 · hydrateSettings() :148
  setSettingValue() :210 · resetSettingValue() :250 · resetSettingAll() :266
  exportSettingsBundle() :287 · importSettingsBundle() :308 · useSettings() :392

Per-app phase config: lib/settings/phase-config.ts
  DATA_SAVER_PHASE :75 · TRADING_PHASE :114 · SERVICES_PHASE :154
  KHUMBHA_AI_PHASE :193 · PHASE_REGISTRY :231

Terminal/trading settings: lib/settings-store.ts (33 KB)
  TradingMode :20 ('dummy'|'kotak-neo'|'shoonya') · TerminalId :23
  converters :26-47 · PER_MODE_GROUPS :300
  useTradingSettings() :800 · useAccountMode() :810 · useTradingMode() :819

  ↓
Backend: services/settings_service.py (57 KB)
  api/settings.py  prefix /api/settings  (9 endpoints)
  ├─ GET /runtime :87
  ├─ PUT /{key} :122 · /{key}/reset :132 · /reset-all :142
  ↓
proxy: /api/phase2/settings :12/:24, /api/phase2/configuration :75/:118
  ↓
UI: /data-saver/settings (+12 sub-pages), /trading/settings, /services/settings,
    /data-saver/configuration
```

Settings sub-pages: `about`, `accessibility`, `app-lock`, `biometric`, `privacy`, `pwa`,
`security`, `storage`, `theme`, `[id]`.

---

## 31. Theme Engine (F30)

```
lib/phase2-theme.ts (46 KB)
  MULTI_COLOR_THEMES  :208
  SINGLE_COLOR_THEMES :241
  THEME_REGISTRY      :268
  buildThemePalette() :352
  storageKeyForApp()  :397   ← har app ka alag localStorage key
  usePhase2Theme()    :950
  ACCENT_PRESETS      :980
  resolvePaletteHex() :1053
lib/dummy-theme.ts  DUMMY_ACCENTS :5, useDummyTheme() :166, setters :183-207
  ↓
ThemeProvider (components/layout/theme-provider.tsx)  ← app-providers me #1
  ↓
UI: /trading/theme (components/theme/theme-studio.tsx),
    /data-saver/settings/theme, /services/theme, /ai/theme,
    layout/topbar/theme-selector.tsx
```

Tests: `tests/theme-studio.test.ts`, `tests/theme-scope.test.ts`.

---

## 32. Scheduler (F31)

### Kya hai?
Din bhar ka IST lifecycle — login, WS start, market phases, square-off, logout. Sab
time-based aur trading-day aware.

```
python-service/scheduler/__init__.py (117 KB)
  _is_trading_day()   :216
  _sched_times()      :342
  _trading_phase()    :369
  SchedulerController :395
  start_scheduler() :2404 · stop_scheduler() :2408
  do_login() :2412 · do_logout() :2416
  get_scheduler_info() :2420 · get_scheduler_state() · get_scheduler_phases()
  get_scheduler_readiness() · get_scheduler_summary()
  get_scheduler_history() · get_scheduler_runs()
  Support: scheduler/broker_lifecycle.py · scheduler/persist.py (70 KB)
```

### Daily IST Timeline
```
08:50  broker login
08:55  WebSocket start
09:00  ─ pre-market ─ 09:15
09:15  LIVE market
15:16  square-off
15:30  feed stop
16:00  logout
```

Dummy-mode daily rollover: `_dummy_session_loop` `:148` (30s poll), started `app.py:784`,
`ensure_dummy_session()` `:783`.

**API**: `api/routes.py` — `/api/scheduler/{status,readiness,summary,history,runs}`
(22 endpoints total in that module).

**UI**: `/services/scheduler/{page,lifecycle,timeline,runs,ledger}`.

---

## 33. Terminal Mode Switching (F32)

### Kya hai?
3 trading terminals hain — DUMMY (paper), KOTAK (live), SHOONYA (live). Switching ek
centralised, PIN/WebAuthn-protected operation hai.

```
lib/settings-store.ts
  TradingMode :20 = 'dummy' | 'kotak-neo' | 'shoonya'
  TerminalId :23
lib/terminal-mode.ts
  switchTo() :56 · useTerminalSwitch() :75
lib/terminal-service.ts (14 KB, 40 API calls)
  loginWithPassword()  :38
  switchTerminal()     :167
  getModeLockStatus()  :195
  unlockWithPin()      :206
  WebAuthn × 4         :219-237
  Shoonya OAuth link   :260 · callback :265
  placeTerminalOrder() :293 · placeTerminalBasket() :303
  targets              :392-404
  riskPrecheck()       :412
lib/trading-service.ts
  KotakNeoTradingService :109 · DummyTradingService :263 · TradingService :358
  normalizeDemoPositions() :164
lib/kotak.ts
  KOTAK_CAPABILITIES :19 · getKotakMarginPreview() :69 · getKotakAudit() :110
  ↓
Backend api/terminal.py  (27 endpoints)
  /api/terminal/list :122 · /switch :159 · /oauth-link :207
  + per-terminal account / positions / orders / trades
  + /api/user/* · /api/shoonya/*
  ↓
ModeReconciler (components/terminal/mode-reconciler.tsx)
  ← UI mode ↔ backend session_manager.mode sync
  ↓
UI selector: components/layout/sidebar-terminal-switcher.tsx (13 KB) — the ONLY selector
Mode gates: KotakGate (components/kotak/ui.tsx:52)
            DummyGate (components/dummy/gate.tsx:5)
            TerminalRouteGate (components/terminal/route-scope.tsx:18)
Shell: getTradingShellConfig(mode) (lib/nav.ts:685)
       KOTAK_NEO_SHELL :145 · TRADING_SHELL :232 · DUMMY_SHELL :311 · SHOONYA_SHELL :399
```

---

## 34. Security — PIN / WebAuthn / Mode Lock (F33)

```
services/mode_lock.py (19 KB)  ← PIN lock state machine
  ↓
api/security.py  prefix /api/terminal/security  (7 endpoints)
  ├─ /pin            :85
  ├─ /lock           :105
  ├─ /unlock         :116
  └─ WebAuthn × 4    :142-168
  ↓
Frontend: lib/terminal-service.ts  getModeLockStatus() :195, unlockWithPin() :206,
          WebAuthn :219-237
  ↓
UI: /data-saver/settings/{security,app-lock,biometric,privacy}, /services/security
```

> ⚠ **Open security finding (documented, unresolved):**
> `docs/security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` ke mutabiq 37/40 backend
> routers **unauthenticated** hain, `HOST=0.0.0.0` hai, aur CORS `*` hai. Saath hi
> `proxy.ts` ki wajah se **Next-layer HMAC gate bhi inactive** hai (F02-S1).
> Iska matlab: local network par koi bhi browser directly backend API hit kar sakta hai.

---

## 35. Instrument Search & Master (F34)

```
python-service/data/instrument_master.json   (3.4 MB — NSE master)
services/instrument_cache.py (18 KB)
  update_instrument_master.py (ops script)
Preload at startup: app.py:796-804
  ↓
api/search.py  prefix /api/search  (4 endpoints)
  ├─ GET  / :148
  ├─ POST / :175
  ├─ /suggest :163
  └─ /status  :186
api/trade_instruments.py  prefix /api/trade/instruments
  └─ /suggest :129
  ↓
Frontend:
  lib/instrument-search.ts
    CanonicalInstrument :45 · shouldSearch() :109
    normalizeSearchResult() :151 · normalizeSearchResponse() :195
    SEARCH_MIN_CHARS = 2 :100 · SEARCH_DEBOUNCE_MS = 300 :102 · SEARCH_MAX_WAIT_MS = 8000 :106
  hooks/use-instrument-search.ts:118  (15s TTL cache :37, max 50 entries :39,
    clearInstrumentSearchCache() :72, InstrumentSearchStatus :76)
  lib/instrument-search-client.ts  searchInstruments() :27
  lib/api.ts search :622-651
  ↓
UI: components/orders/trade/instrument-search.tsx (15 KB), components/orders/stock-search.tsx (32 KB)
Contract: lib/kaustubh-types.ts
```

---

## 36. Khumbha AI App (F35)

### Kya hai?
Trading backend se **bilkul alag** ek chhota FastAPI service. Sirf numpy + psutil.
Deliberately independent — trading backend crash hone par bhi AI chalta rahe.

```
Frontend:
  lib/ai-api.ts
    AI_BASE :6 = NEXT_PUBLIC_AI_API_BASE || http://127.0.0.1:8001
    aiHealth :21 · aiDashboard :23 · aiHardware :26
    aiModels :29 · aiDatasets :32 · aiJobs :35 · aiAgents :38 · aiLogs :41
    aiModelStart/Stop :43/:44 · aiAgentStart/Stop :46/:47
    aiTrain :49 · aiInfer :52 · aiSuggest :55
  ↓
Backend: khumbha-ai/main.py (416 lines, 34 se start)
  _fit() numpy lstsq :49  · _predict() :63
  /health :212 · /api/hardware :217 · /api/dashboard :222
  /api/models :247 · /api/models/{id}/start :266 · /stop :275
  /api/datasets :284 · /api/training/start :289
  /api/jobs :328 · /api/inference/run :333
  /api/suggestions :361 · /api/agents :380
  /api/agents/{id}/start :385 · /stop :395 · /api/logs :404
  deps: fastapi, uvicorn, numpy, psutil  (run: khumbha-ai/run_ai.cmd)
  ↓
UI: /ai/* (14 pages)
  dashboard · models · datasets · training · inference · agents · suggestions
  infrastructure · jobs · logs · settings · theme
  Shell: KHUMBHA_AI_SHELL (lib/nav.ts:609) — Main / Runtime / Infrastructure
```

---

## 37. PWA (F36)

```
public/sw.js (12 KB, cache v7)
  CACHE_NAME = 'kaustubh-v7' :2 · DATA_CACHE :3 · OFFLINE_URL :4
  STATIC_ASSETS :6
  Push: NOTIFICATION_TYPES :33 · normalizeNotification() :43
public/offline.html
Manifests (5): manifest.json (start_url /login + shortcuts)
              manifest-data.json · manifest-trading.json
              manifest-services.json · manifest-ai.json
Icons: icon-192/512.png + -maskable variants
  ↓
components/pwa/register-sw.tsx:21
  ⚠ PROD ONLY — dev me unregister karta hai
  controllerchange wait · push permission · beforeinstallprompt capture
components/pwa/pwa-identity.tsx:20
  PRODUCT_MANIFESTS :8 — path se <link rel=manifest> + theme-color swap
  ↓
app/layout.tsx:10 metadata · :28 viewportFit 'cover', userScalable false
  ↓
UI: /data-saver/settings/pwa
```

---

## 38. Broker Adapters (F37)

```
brokers/broker_registry.py
  BrokerCapability :27
  BROKER_CAPABILITIES :55   ← kotak: all yes · shoonya: all no · dummy: partial
brokers/capabilities.py
  BrokerCapabilities :11
  Capabilities.KOTAK :63 · Capabilities.SHOONYA :87 · Capabilities.DUMMY :111
  capabilities_for() :141
brokers/
  kotak_adapter.py   ← kotakneoapi 3.0.7
  shoonya_adapter.py (21 KB) ← NorenRestApiOAuth 0.0.41
  dummy.py           ← paper trading adapter
  manager.py · selection.py · base.py · models.py
  broker_cache.py · broker_terminal_engine.py
  ↓
Session lifecycle: services/session/session_manager.py + scheduler/broker_lifecycle.py
  ↓
Probes (ops scripts): _probe_kotak_live_fields.py
                    _probe_kotak_wipro_depth.py · _probe_quote.py
```

| Broker | Library | Capabilities |
|--------|---------|--------------|
| Kotak Neo | `kotakneoapi==3.0.7` | all supported |
| Shoonya | `NorenRestApiOAuth==0.0.41` | none supported (reduced surface) |
| Dummy | in-house | partial |

---

## 39. Audit Trail (F38)

```
Audit har order ke saath chalta hai — order pipeline ke andar (F07):
  order-ticket → OrderEngine → RiskEngine → MarginEngine → AuditEngine
  ↓
services/audit_engine.py   (registered app.py:739 + auto-started app.py:748)
  → Mongo `audit_log` collection
  ↓
Frontend: lib/kotak.ts  getKotakAudit() :110  ·  lib/kaustubh-types.ts  AuditEvent :196
  ↓
UI: /trading/audit  (components/kotak/pages/audit.tsx  ·  DummyAudit)
```

---

## 40. Backend App Bootstrap (reference)

`python-service/app.py` (1251 lines) — `lifespan()` `:508`:

| Step | Line | Kaam |
|------|------|------|
| 1 | `:512` | `set_loop()` — event loop capture |
| 2 | `:530-558` | Mongo connect — **missing `MONGODB_URI` = hard fail** |
| 3 | `:582-603` | Runtime settings bootstrap |
| 4 | `:606` | Notification center init |
| 5 | `:619-624` | Dummy managed paper session |
| 6 | `:626-637` | Tick buffer · export worker · downloads checker · scheduler |
| 7 | `:642-652` | WS engine ← → `ws_manager` wiring |
| 8 | `:657-662` | WS#2 order-feed supervisor |
| 9 | `:664+` | WS#1 market-data supervisor |
| 10 | `:704-765` | **17 engines register** (`:728-745`) + auto-start (`:748`) |
| 11 | `:770-775` | Connection Engine start (WS#3/#4 gateway) |
| 12 | `:781-791` | Dummy daily session + loop |
| 13 | `:796-804` | Instrument master preload |
| 14 | `:808-893` | Retention · notification · insights · live-frame · DQ · tick-analytics loops |
| — | `:895-1030` | Shutdown (reverse order, bounded) |
| 15 | `:1032` | `app = FastAPI(...)` |
| 16 | `:1040` | `GET /health` |
| 17 | `:1050` | CORS |
| 18 | `:1076-1095` | `IstTimestampMiddleware` — raw ASGI, `+00:00` → `+05:30` rewrite |
| 19 | `:1133/:1142/:1153` | Exception handlers (HTTP / PyMongo / Assertion → 503) |
| 20 | `:1164-1204` | **41 `include_router` calls** |
| 21 | `:1216` | Request-logging middleware |

### Background Loops
| Loop | Fn | Interval |
|------|-----|----------|
| Dummy session rollover | `_dummy_session_loop` `:148` | 30s |
| Retention cleanup | `_retention_cleanup_loop` `:169` | 6h |
| Telemetry sampler | `_telemetry_sampler_loop` `:189` | 60s |
| Incident correlator | `_incident_correlator_loop` `:203` | 5s |
| Daily report | `_daily_report_loop` `:216` | 60s |
| Live frame | `_live_frame_loop` `:280` | `_LIVE_FRAME_INTERVAL_SEC` |
| DQ live | `_dq_live_loop` `:327` | `_DQ_LIVE_INTERVAL_SEC` |
| Tick analytics publish | `_tick_analytics_publish_loop` `:365` | `_TICK_ANALYTICS_INTERVAL_SEC` |
| Tick analytics backfill | `_tick_analytics_backfill_loop` `:409` | `_TICK_ANALYTICS_BACKFILL_SEC` |
| Startup report | `_startup_report` `:429` | one-shot |

### Backend Route Modules (41 files, `python-service/api/`)

| Module | Prefix | Endpoints |
|--------|--------|-----------|
| `routes.py` | `/` | 22 — health, status, session, scheduler, `/login` `:146`, `/logout` `:171`, `/subscribe` `:214` |
| `system.py` (87 KB) | `/api/system` | 15 — `/health` `:112` (503 on DB down), `/quality-metrics` `:655`, `/mongo-stats` `:826`, `/trading-day-stats` `:986`, `/dashboard` `:1222` |
| `stocks.py` | `/api/stocks` | 14 |
| `ticks.py` | `/api/ticks` | 4 |
| `downloads.py` | `/api/downloads` | 12 |
| `export_jobs.py` | `/api/downloads/exports` | 8 |
| `scheduled_downloads.py` (60 KB) | `/api/scheduled-downloads` | 22 |
| `schedule_events.py` | `/api/schedule-events` | 2 (SSE) |
| `settings.py` | `/api/settings` | 9 |
| `trading.py` | `/api/trading` | 16 |
| `trading_dashboard.py` | `/api/trading` | 4 |
| `terminal.py` | `/api/terminal` + `/api/user` + `/api/shoonya` | 27 |
| `market_watch.py` (67 KB) | `/api/market-watch` | 30 |
| `market_watch_engine.py` | `/api/market-watch-engine` | engine control |
| `quality.py` (71 KB) | `/api/data-quality` | 22 |
| `tick_analytics.py` | `/api/data-saver/tick-analytics` | 21 |
| `insights.py` | `/api/data-saver/insights` | 24 |
| `data_center.py` | `/api/system/data-center` | 20 |
| `session_manager.py` | `/api/phase3/session-manager` | 33 |
| `ws_engine.py` | `/api/services/websocket` | 38 |
| `ws_gateway.py` (34 KB) | `/api/realtime/*` + `WS /ws/realtime` `:278` | 11 |
| `websocket.py` | `/api/websocket` | 21 (SSE `/system/stream` `:99`) |
| `engine_control.py` | `/api/services/engines` | 26 |
| `storage_engine.py` | `/api/services/storage` | 6 |
| `risk_engine.py` | `/api/services/risk` | 4 |
| `notifications.py` | `/api/notifications` | 17 |
| `alerts.py` | `/api/alerts` | 16 |
| `watchlist.py` | `/api/watchlist` | 4 |
| `watch_list.py` | `/api/watch-list` | 6 |
| `watchlist_engine.py` | `/api/watchlist-engine` | 15 |
| `baskets.py` | `/api/baskets` | 5 |
| `demo.py` (59 KB) | `/api/demo` | 17 |
| `dummy.py` (21 KB) | `/api/dummy` | 55 |
| `search.py` | `/api/search` | 4 |
| `trade_instruments.py` | `/api/trade/instruments` | 3 |
| `statistics.py` | `/api/statistics` | 2 |
| `logs.py` | `/api/logs` | 1 |
| `cleanup.py` | `/api/system/cleanup` | 4 |
| `security.py` | `/api/terminal/security` | 7 |
| `auth.py` | `/api/auth` | 3 |

### Database (`database/connection.py`, 35 KB)
```
connect_mongo() · disconnect_mongo() · is_mongo_connected()
get_mongo_info()
MongoConnectionError · MongoDbConfigurationError
database/migrations.py (13 KB)
```
Collections: 19× `session_manager_*`, `db.ticks`, `orders`, `positions`, `notifications`,
`audit_log`, `config`.

Config: `config/settings.py` — **86 settings fields** via `dotenv` (`.env` + gitignored
`.env.local`). `MongoDbConfigurationError` `:38`.

---

## 41. Cross-Cutting Flows (ek nazar mein)

### 41.1 Market Data
```
Kotak SFeed
  → WS#1 → ws_manager.py
  → ws_socket/engine (canonical / fields / quality / router)
  → EngineEventBus (TICK_RECEIVED / VALIDATED / REJECTED)
     ├─→ feature_engine, market_coach, watchlist_engine, risk_engine
     ├─→ storage.py (DATA_SAVER / FULL_RAW) → tick_buffer → Mongo db.ticks
     └─→ connection_engine → WS#3 → FrontendRealtimeProvider → hooks → components
```

### 41.2 Order
```
order-ticket.tsx
  → WS#4 placeOrder (ya REST /api/trading/order/place)
  → order_engine → risk_engine → margin_engine → audit_engine
  → broker adapter → Kotak REST
  → WS#2 OrderUpdate → order_feed_manager
  → EngineEventBus → connection_engine → WS#3 → UI
  + reconnect pe REST order_report / trade_report poll
```

### 41.3 Session / Subscriptions
```
Scheduler (08:50 login → 08:55 WS)
  → CentralSessionManager
  → market_coach / MarketWatchEngine (universe, ranking, pins)
  → SessionManager daily intent + revision++
  → SubscriptionRegistry (merge / dedup / diff)
  → WebSocketEngine → ws_manager → Kotak SFeed
```

### 41.4 Storage
```
Feed message
  → tick_buffer
  → DBWriterEngine.evaluate()  ← persistence decision
  → Mongo db.ticks (superset: legacy 28 keys + full SFeed + raw model_dump)
  → storage_engine / retention_plane / storage_guard / atlas_cleanup
```

### 41.5 Auth (dual, layered)
```
LAYER 1 — Next
  6-digit PIN → .auth/app-lock.json → HMAC cookie
  → intended proxy.ts gate   ⚠ INACTIVE (no middleware.ts)

LAYER 2 — Backend
  session_manager.mode / mode_lock (PIN + WebAuthn) / broker login
```

---

## 42. Custom Hooks (reference)

### `hooks/` (9 files)
| Hook | Line | Purpose |
|------|------|---------|
| `use-live-stocks.ts` | `:173` | `StockStatus` `:10`, `DepthRow` `:12`, `LiveStock` `:18`, `TickStats` `:77` — WS channels subscribe + frames merge |
| `use-tick-stream.ts` | `:123` | `NormalizedTick` `:23`, `TickStreamState` `:52` — high-freq tick stream |
| `use-latest-ticks.ts` | `:29` | `DcLiveTick` `:14` |
| `use-instrument-search.ts` | `:118` | 15s TTL cache `:37`, max 50 `:39`, `InstrumentSearchStatus` `:76` |
| `use-data-quality-live.ts` | `:116` | `DQEngineRef` `:16`, `DQThroughput` `:28`, `DQIngestion` `:37`, `DQIssue` `:56` |
| `use-schedule-events.ts` | `:51` | `ScheduleEvent` `:18`, `ScheduleState` `:29` — SSE |
| `use-trigger-engine.ts` | `:29` | `TriggerOutcome` `:21` — TARGET / STOP_LOSS |
| `use-dummy-state.ts` | `:6` | dummy state poll (3s default) |
| `use-toast.ts` | `:74` | shadcn toast reducer |

### `lib/` ke andar ke hooks
`useEngines`/`useEngineStatus`/`useOneShot` (`engine-realtime.ts`) ·
`useNotificationsPoll`/`useUnreadCount`/`useActiveAlertBadge` (`shared-notifications.ts`) ·
`useSharedPolling`/`useCachedResource` (`shared-request.ts`) ·
`useSettings`/`useSettingValue` (`settings/store.ts`) ·
`useTradingSettings`/`useTradingMode`/`useAccountMode` (`settings-store.ts`) ·
`usePhase2Theme` (`phase2-theme.ts`) · `useDummyTheme` (`dummy-theme.ts`) ·
`useServerNow`/`useCountdown` (`time-engine.ts`) · `useDataCenter` (`data-center-status.ts`) ·
`useDataCenterStore` (`data-center-store.ts`) · `useBackend` (`use-backend.ts`) ·
`useTerminalSwitch` (`terminal-mode.ts`) · `useInsightsStream` (`insights.ts`) ·
`useTriggers` (`trigger-store.ts`) · `useBasketDraft` (`basket-draft.ts`) ·
`useDownloadsState` (`downloads-store.ts`) · `useDownloadSettings` (`download-state.ts`)

### Request infra (3 layers — kaunsa kab?)
| File | Key fns |
|------|---------|
| `lib/request-dedup.ts` | `dedupFetch()` `:27`, `abortRequest()` `:47` |
| `lib/request-cache.ts` | `getCached()` `:69`, `clearCache()` `:112` |
| `lib/shared-request.ts` | `dedupeFetch()` `:37`, `invalidateCache()` `:69`, `useSharedPolling()` `:125`, `useCachedResource()` `:172` |

---

## 43. Tests

### Frontend — 25 suites, `node --test "tests/*.test.ts"`
Notable: `realtime-client.test.ts` (15 KB) · `topbar-status.test.ts` (17 KB) ·
`nav-utils.test.ts` (11 KB) · `data-center-snapshot.test.ts` (22 KB) ·
`charge-engine.test.ts` (15 KB) · `tick-analytics.test.ts` (14 KB) ·
`ws-engine.test.ts` (10 KB) · `dummy.test.ts` (11 KB) · `proxy-session-gate.test.ts` ·
`auth-session.test.ts` · `basket-engine.test.ts` · `theme-studio.test.ts` ·
`theme-scope.test.ts` · `market-calendar.test.ts` · `ist.test.ts` ·
`order-engine.test.ts` · `history-orders.test.ts` · `instrument-search.test.ts` ·
`data-quality-client.test.ts` · `data-center-planes.test.ts` · `data-center.test.ts` ·
`orders-workspace.test.ts` · `request-cache.test.ts` · `suggestion-pipeline.test.ts` ·
`topbar-context.test.ts` · `trade-quote-fallback.test.ts`

### Backend — 60+ test modules, `python-service/tests/`
Highlights: `test_db_writer_engine.py` (63 KB) ·
`test_market_watch_spec_modules.py` (88 KB) · `test_ws_engine.py` ·
`test_session_manager_*` · `test_data_center_*` · `test_scheduler_*` ·
`test_notification_center.py` · `test_realtime_gateway.py` · `test_dual_*`

---

## 44. Known Defects & Inconsistencies (code-verified)

| # | Issue | Evidence | Impact |
|---|-------|----------|--------|
| 1 | **`proxy.ts` wired nahi hai.** Next 16 ko `middleware.ts` chahiye; file exist nahi karti | `Test-Path middleware.ts` = False; `proxy.ts:72` claims gate | HMAC session gate **kabhi nahi chalta**. `API.md` galat |
| 2 | **`README.md` 0 bytes** | file size 0 | Real readme `README_local.md` (28 KB) — par wo purana Node+Python split layout describe karta hai |
| 3 | **Root `watchlist.py` orphan hai** | repo root vs `api/watchlist.py` | Duplicate router — dead code |
| 4 | **`bolt.diy/` ek stray file hai** | `bolt.diy/app/lib/.server/llm/stream-text.ts` (311 lines), `tsconfig.json:42` se excluded | Koi active code import nahi karta. `.bolt/` bhi remnant hai |
| 5 | **Engine count mismatch** | code: 17 (`app.py:728-745`); docs: "15 (13 native + 2 facade)" | Docs galat. `DOCUMENTATION_AUTHORITY.md §4` sahi tha |
| 6 | **Unregistered engines** | `core/engines/` mein `risk_engine`, `target_engine`, `pnl_engine`, `basket_engine` — koi bhi registry mein nahi | Dead code ya registration gap — decision chahiye |
| 7 | **`margin_engine` / `squareoff_engine` auto-start nahi hote** | `app.py:748` list se bahar | Registered but stopped |
| 8 | **Stale backup files** | `api/system.py.before-mongo-fix`, `-2`, `-before-mongo-stats-final-fix`; `scheduler/__init__.py` ×3; `settings_service.py` ×1 | Repo clutter, confusion |
| 9 | **Version control dirty** | 141 tracked vs 359 untracked/modified | Fresh clone **build nahi hoga** (`docs/audits/VERSION_CONTROL_STATE.md`) |
| 10 | **Security exposure** | 37/40 routers unauthenticated · `HOST=0.0.0.0` · CORS `*` | LAN par koi bhi browser backend hit kar sakta hai (`docs/security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md`) |
| 11 | **market-watch sub-routes identical** | `app/(dashboard)/market-watch/{filters,movers,pins,rank,symbol}` — paanchon same `_pages/market-watch/page` import karte hain | Sub-routes code me differentiate nahi |
| 12 | **Bade artifacts repo me** | `data/instrument_master.json` 3.4 MB · `python-service/downloads/` 23 MB JSONL ×3 · `logs/uvicorn-stderr.log` 5 MB · `khumbha-ai/bg_*.log` | Repo bloat |
| 13 | **Docs me banner/body contradiction** | 36 numbered files me 4-WS banner, body me 2-WS text (`DOCUMENTATION_AUTHORITY.md §2`) | AI agents galat WS model form karte hain |
| 14 | **Fictional CLI commands** | `32_ARCHITECTURE_GAPS.md`, `34_DEVELOPER_ONBOARDING.md` me `python -m kaushub.*` — **koi `kaushub` package exist nahi karta** | Poora documented remediation path unexecutable |
| 15 | **`app/_pages/` private folder** par live implementation | 38 `page.tsx` — `dynamic(import('@/app/_pages/…'))` se load | Docs isko "frontend code" samajhte hain — galat |
| 16 | **Market Watch weekly lock abhi tak nahi chala** | `universe_verify.reason = NO_LOCKED_UNIVERSE`; `mwr_universe_source = LOCKED` | Engine sahi tarah empty universe monitor karta hai. Operator ko `POST /api/market-watch/weekly/scan` → decisions → `/weekly/lock` chalana hoga (doc §37 live verification) |
| 17 | **Market Watch manual pins + saved filters direct Mongo write** | `services/market_watch_pins.py:109,124,136`, `api/market_watch.py` filters | User state hai, market data nahi — doc §13 tick persistence govern karta hai jo 100% DB-Writer-owned hai. Inhe writer ke peeche laane ke liye un collections ko `market_watch_doc_buffer.COLLECTIONS` me register karna padega |
| 18 | **Market Watch UI 12s pe full-dataset poll** | `overview.tsx` `/ui`+`/ranking`+`pins`, `movers.tsx` `/sections`, `pins.tsx`, `filters.tsx`, `mw-shared.tsx` `/progress` | Doc §25 per-tick refetch banata hai (wo nahi hai — tick path socket-only hai), par §26 poora dataset prefer nahi karta |
| 19 | **Market Watch 500/400 raw token subscriptions** | `movers.tsx:63-74` (500), `rank.tsx:44` (400) | Raw ticks browser ko push hote hain, engine ka controlled publish set bypass ho jata hai — doc §26 residual gap |

---

## 45. Documentation Authority (is file ke liye)

`docs/DOCUMENTATION_AUTHORITY.md` ke mutabiq, jab docs aur code clash karein:

1. **Actual source code** — hamesha jeetta.
2. `docs/architecture/00_ARCHITECTURE_INDEX.md`
3. Numbered set `00_`–`35_` — **target** architecture
4. `docs/engines/*.md` — **target/approved**, current implementation nahi
5. `docs/api/`, `docs/config/`, `docs/database/`, `docs/frontend/` — code se extract kiye gaye, **current** state
6. Unnumbered legacy set — historical, superseded

**Is file (`FEATURE_FLOW_MAP.md`) ka position:** ye code se extract hua hai, isliye
category 5 ke saath jaanta hai — lekin ye **current-state features** ka nazaariya hai,
isliye category 3/4 ke "target" claims ko override karta hai. Engine count (17),
WS route count (1), page count (188) — teeno yahan code se hain.

---

## 46. Quick Reference — Kahan Kya Dekhein

| Main tumhe ye dekhna hai | Toh ye kholo |
|--------------------------|--------------|
| Ek page ka UI | `app/(phase2)/...` ya `app/(trading)/...` → `app/_pages/...` |
| Ek API endpoint | `python-service/api/<module>.py` |
| Frontend se backend call | `lib/api.ts` ya `app/api/**/route.ts` |
| Order ka full journey | §41.2 (F07 + F37) |
| Market data ka full journey | §41.1 (F05 + F04) |
| Engine health | `python-service/app.py:704-765` ya `/services/system` |
| Charge calculation | `lib/charge-engine.ts` + `config/statutory-charges.ts` |
| Realtime channels | `python-service/connection_engine/channels.py` |
| Startup order | `python-service/app.py:508-893` |
| IST trading day timeline | `python-service/scheduler/__init__.py:342-369` |
| Theme / settings schema | `lib/settings/schema.ts:18`, `lib/phase2-theme.ts:208` |
| Data Center planes | `python-service/services/data_center.py:966` |

---

*Static analysis only. Koi code execute nahi kiya, koi runtime state observe nahi kiya,
koi secrets read nahi kiye. Sab `file_path:line_number` references scan ke time ke hain
aur drift ho sakte hain.*