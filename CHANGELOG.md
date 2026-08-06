# Changelog

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
- Auto login: Mon-Fri 09:00 IST, auto logout: 15:35 IST
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
