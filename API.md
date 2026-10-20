# KAUSTUBH Trading Platform — API Reference

Backend: FastAPI on port **8000**
Frontend: Next.js on port **3000** (proxies auth routes only)

> **Note:** The Python backend has **no authentication layer**. All routes are open by design — auth is handled exclusively at the Next.js layer via session cookies.

---

## 1. Next.js Auth Routes (port 3000)

| Method | Endpoint | Purpose | Auth | Request Body | Response | Notes |
|--------|----------|---------|------|--------------|----------|-------|
| `GET` | `/api/health` | Health check | None | — | `{ status: string }` | |
| `POST` | `/api/auth/login` | PIN-based login, sets session cookie | None | `{ pin: string }` | `{ success: boolean }` | Sets `session` cookie on success |
| `DELETE` | `/api/auth/login` | Logout, clears session | Session cookie | — | `{ success: boolean }` | |
| `GET` | `/api/auth/session` | Validate current session | Session cookie | — | `{ valid: boolean, ... }` | Returns session state |
| `GET` | `/api/auth/setup` | Check if app lock / initial PIN is configured | None | — | `{ configured: boolean }` | |
| `POST` | `/api/auth/setup` | Create initial PIN | None | `{ pin: string }` | `{ success: boolean }` | One-time setup only |
| `POST` | `/api/auth/pin/change` | Change existing PIN | Session cookie | `{ oldPin: string, newPin: string }` | `{ success: boolean }` | |
| `POST` | `/api/auth/pin/disable` | Disable app lock entirely | Session cookie | `{ pin: string }` | `{ success: boolean }` | |

---

## 2. Session Management

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/health` | Health check with uptime and SDK init status | — | `{ uptime, sdk_status, ... }` | |
| `GET` | `/status` | Full session + WebSocket + scheduler status | — | `{ session, websocket, scheduler, ... }` | |
| `POST` | `/login` | Manual login trigger (Kotak SDK) | — | `{ success, ... }` | Triggers SDK auth flow |
| `POST` | `/logout` | Manual logout | — | `{ success }` | |
| `GET` | `/session` | Session info — token booleans only | — | `{ has_token, is_active, ... }` | Lightweight status check |
| `POST` | `/subscribe` | Subscribe to instrument tokens | `{ tokens: number[] }` | `{ subscribed: number[] }` | WebSocket subscription |
| `POST` | `/unsubscribe` | Unsubscribe from tokens | `{ tokens: number[] }` | `{ unsubscribed: number[] }` | |

---

## 3. Stocks

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/stocks` | List all stocks with search/filter | Query: `search`, `active` | `{ stocks: [...] }` | |
| `POST` | `/api/stocks` | Add a stock + auto-subscribe WS | `{ symbol, token, ... }` | `{ stock, ... }` | Triggers WebSocket subscribe |
| `POST` | `/api/stocks/search` | Kotak SDK stock search (remote) | `{ query: string }` | `{ results: [...] }` | Hits Kotak API |
| `DELETE` | `/api/stocks/bulk` | Bulk delete stocks + WS unsubscribe | `{ symbols: string[] }` | `{ deleted: number }` | |
| `PATCH` | `/api/stocks/{symbol}` | Toggle active status + WS subscribe/unsubscribe | `{ active: boolean }` | `{ stock }` | Active → subscribes WS, Inactive → unsubscribes |
| `DELETE` | `/api/stocks/{symbol}` | Delete single stock | — | `{ deleted: boolean }` | Also unsubscribes WS |

---

## 4. Ticks

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `POST` | `/api/ticks/ingest` | HTTP tick ingestion | `{ symbol, ltp, ... }` | `{ success }` | Main tick entry point |
| `POST` | `/api/ticks/log` | Log a tick event | `{ symbol, event, ... }` | `{ success }` | Supplementary logging |
| `GET` | `/api/ticks/stream` | **SSE** live tick stream | — | `text/event-stream` | Server-Sent Events; long-lived connection |
| `GET` | `/api/ticks/recent` | Recent ticks from MongoDB | Query: `symbol`, `limit` | `{ ticks: [...] }` | REST fallback for recent data |

---

## 5. Downloads

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/downloads/formats` | List available export formats | — | `{ formats: [...] }` | CSV, JSON, Excel, etc. |
| `GET` | `/api/downloads/fields` | List available tick fields for export | — | `{ fields: [...] }` | |
| `GET` | `/api/downloads/preview` | Pre-download size/row estimates | Query: `symbol`, `format`, `dateRange` | `{ rows, size, ... }` | |
| `GET` | `/api/downloads/naming/preview` | Filename pattern preview | Query: `pattern`, `symbol` | `{ filename: string }` | |
| `GET` | `/api/downloads` | Direct download (single/multi stock, ZIP) | Query: `symbols`, `format`, `dateRange` | Binary file / ZIP | Sets `Content-Disposition` header |
| `GET` | `/api/downloads/stats` | Download statistics | — | `{ total, byFormat, ... }` | |
| `DELETE` | `/api/downloads/history/{id}` | Delete history entry + stored file | — | `{ deleted: boolean }` | Removes from MongoDB + disk |
| `GET` | `/api/downloads/history/{id}/file` | Re-download a stored artifact | — | Binary file | Serves previously generated file |
| `GET` | `/api/downloads/history` | Paginated download history | Query: `page`, `limit` | `{ history: [...], total, page }` | |

---

## 6. Export Jobs

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `POST` | `/api/downloads/exports` | Create a new export job | `{ symbols, format, dateRange, ... }` | `{ job }` | Runs asynchronously |
| `GET` | `/api/downloads/exports` | List export jobs with pagination | Query: `page`, `limit` | `{ jobs: [...], total }` | |
| `GET` | `/api/downloads/exports/{id}` | Job status + progress | — | `{ job: { status, progress, ... } }` | Status: pending / running / completed / failed |
| `GET` | `/api/downloads/exports/{id}/download` | Download completed export artifact | — | Binary file | Only available when `status === completed` |
| `POST` | `/api/downloads/exports/{id}/cancel` | Cancel a running/pending job | — | `{ cancelled: boolean }` | |

---

## 7. Statistics

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/statistics` | Per-symbol tick stats + aggregate totals | Query: `symbol` (optional) | `{ symbols: {...}, totals: {...} }` | |
| `GET` | `/api/statistics/gainers-losers` | Today's gainers and losers | — | `{ gainers: [...], losers: [...] }` | Sorted by % change |

---

## 8. Logs

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/logs` | Query application logs with filters | Query: `level`, `search`, `limit`, `offset` | `{ logs: [...], total }` | |

---

## 9. System

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/system` | Full system status | — | `{ cpu, ram, disk, mongo, trading, scheduler }` | Comprehensive health dashboard |
| `GET` | `/api/system/mongo-stats` | MongoDB collection stats + ping latency | — | `{ collections, ping_ms, ... }` | |
| `POST` | `/api/system/logs/clear` | Clear application logs | — | `{ cleared: boolean }` | |
| `GET` | `/api/system/download-history` | Recent download activity | — | `{ downloads: [...] }` | Lightweight summary |
| `GET` | `/api/system/trading-day-stats` | PnL, win/loss ratio, charges | Query: `date` (optional) | `{ pnl, winRate, charges, ... }` | Defaults to current trading day |
| `GET` | `/api/system/trading-history` | Daily/weekly/monthly PnL aggregation | Query: `period` | `{ history: [...] }` | `period`: daily / weekly / monthly |

---

## 10. Settings

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/settings` | Get all settings (160+ keys) | — | `{ settings: {...} }` | Returns full settings map |
| `GET` | `/api/settings/categories` | List setting categories | — | `{ categories: [...] }` | |
| `PUT` | `/api/settings/{key}` | Update a single setting | `{ value: any }` | `{ key, value }` | Type validated per key |
| `POST` | `/api/settings/{key}/reset` | Reset one setting to default | — | `{ key, value, default }` | |
| `POST` | `/api/settings/reset-all` | Reset all settings to defaults | — | `{ reset: number }` | Count of reset keys |

---

## 11. Trading

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `POST` | `/api/trading/order/place` | Place an order | `{ symbol, quantity, price, orderType, ... }` | `{ order }` | Hits Kotak SDK |
| `POST` | `/api/trading/order/modify` | Modify an existing order | `{ orderId, ... }` | `{ order }` | |
| `POST` | `/api/trading/order/cancel` | Cancel an order | `{ orderId }` | `{ cancelled: boolean }` | |
| `GET` | `/api/trading/orders` | Current order book | — | `{ orders: [...] }` | Active orders |
| `GET` | `/api/trading/order/history` | Full order history | Query: `dateRange` | `{ orders: [...] }` | |
| `GET` | `/api/trading/positions` | Positions with normalized PnL | — | `{ positions: [...] }` | PnL values normalized |
| `POST` | `/api/trading/positions/squareoff` | Square off a position | `{ symbol, quantity }` | `{ order }` | Places opposite market order |
| `GET` | `/api/trading/holdings` | Current holdings | — | `{ holdings: [...] }` | |
| `GET` | `/api/trading/funds` | Account funds / margin limits | — | `{ funds: {...} }` | |
| `POST` | `/api/trading/search` | Kotak SDK scrip search (remote) | `{ query: string }` | `{ results: [...] }` | |
| `POST` | `/api/trading/search-local` | Fast local search from instrument cache | `{ query: string }` | `{ results: [...] }` | Instant; no network call |
| `GET` | `/api/trading/instrument-cache/status` | Instrument cache health | — | `{ loaded, count, age, ... }` | |
| `GET` | `/api/trading/instrument-cache/debug` | Cache debug / diagnostic info | — | `{ ... }` | |
| `POST` | `/api/trading/instrument-cache/reload` | Force instrument cache reload | — | `{ reloaded: boolean }` | May take a few seconds |
| `POST` | `/api/trading/quote` | Get LTP + OHLC quote for a symbol | `{ symbol, token }` | `{ ltp, open, high, low, close }` | |

---

## 12. Watchlist

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/watchlist` | List watchlist items (favorites first) | — | `{ watchlist: [...] }` | Sorted: favorited items first |
| `POST` | `/api/watchlist` | Add or update a watchlist item | `{ symbol, token, ... }` | `{ item }` | Upserts by symbol |
| `DELETE` | `/api/watchlist/{symbol}` | Remove from watchlist | — | `{ deleted: boolean }` | |
| `PATCH` | `/api/watchlist/{symbol}/favorite` | Toggle favorite status | — | `{ favorited: boolean }` | Idempotent toggle |

---

## 13. Notifications

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/notifications` | List notifications | Query: `category`, `unread` | `{ notifications: [...] }` | Filterable by category and read status |
| `POST` | `/api/notifications` | Create a notification | `{ title, body, category }` | `{ notification }` | |
| `PUT` | `/api/notifications/read/{id}` | Mark one as read | — | `{ notification }` | |
| `PUT` | `/api/notifications/unread/{id}` | Mark one as unread | — | `{ notification }` | |
| `PUT` | `/api/notifications/read-all` | Mark all as read | — | `{ updated: number }` | |
| `DELETE` | `/api/notifications/{id}` | Delete one notification | — | `{ deleted: boolean }` | |
| `DELETE` | `/api/notifications` | Delete all notifications | — | `{ deleted: number }` | |

---

## 14. Basket Orders

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/baskets` | List all basket orders | — | `{ baskets: [...] }` | |
| `POST` | `/api/baskets` | Create a basket with order items | `{ name, items: [...] }` | `{ basket }` | Items are order templates |
| `PUT` | `/api/baskets/{id}` | Update a basket | `{ name, items: [...] }` | `{ basket }` | |
| `DELETE` | `/api/baskets/{id}` | Delete a basket | — | `{ deleted: boolean }` | |
| `POST` | `/api/baskets/{id}/push` | Execute a basket (sequential) | — | `{ results: [...] }` | Orders placed one after another; partial failure possible |

---

## 15. Demo (Paper Trading)

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/demo/account` | Demo account balance and PnL | — | `{ balance, pnl, ... }` | |
| `GET` | `/api/demo/orders` | Demo order history | — | `{ orders: [...] }` | |
| `GET` | `/api/demo/positions` | Demo positions | — | `{ positions: [...] }` | |
| `POST` | `/api/demo/order/place` | Paper trade with charge calculation | `{ symbol, quantity, price, ... }` | `{ order }` | Simulates brokerage, STT, etc. |
| `POST` | `/api/demo/reset` | Reset demo account to initial state | — | `{ balance }` | Clears all demo orders/positions |

---

## 16. Scheduled Downloads

| Method | Endpoint | Purpose | Request Body | Response | Notes |
|--------|----------|---------|--------------|----------|-------|
| `GET` | `/api/scheduled-downloads/destinations/list` | List available download destinations | — | `{ destinations: [...] }` | Local path, S3, etc. |
| `GET` | `/api/scheduled-downloads/formats/list` | List supported export formats | — | `{ formats: [...] }` | |
| `GET` | `/api/scheduled-downloads/runs` | Run history for all scheduled jobs | — | `{ runs: [...] }` | Past execution records |
| `DELETE` | `/api/scheduled-downloads/runs/{id}` | Delete a run record | — | `{ deleted: boolean }` | |
| `GET` | `/api/scheduled-downloads` | List all scheduled download jobs | — | `{ jobs: [...] }` | |
| `POST` | `/api/scheduled-downloads` | Create a scheduled download job | `{ name, cron, symbols, format, destination, ... }` | `{ job }` | |
| `GET` | `/api/scheduled-downloads/{id}` | Get one scheduled job | — | `{ job }` | |
| `PUT` | `/api/scheduled-downloads/{id}` | Update a scheduled job | `{ ...fields }` | `{ job }` | |
| `DELETE` | `/api/scheduled-downloads/{id}` | Delete a scheduled job | — | `{ deleted: boolean }` | |
| `POST` | `/api/scheduled-downloads/{id}/toggle` | Enable or disable a scheduled job | — | `{ enabled: boolean }` | |
| `POST` | `/api/scheduled-downloads/{id}/run` | Manually execute a scheduled job | — | `{ run }` | Triggers immediate execution outside cron |

---

## Endpoint Count Summary

| Router | Count |
|--------|-------|
| Next.js Auth | 8 |
| Session Management | 7 |
| Stocks | 6 |
| Ticks | 4 |
| Downloads | 9 |
| Export Jobs | 5 |
| Statistics | 2 |
| Logs | 1 |
| System | 6 |
| Settings | 5 |
| Trading | 14 |
| Watchlist | 4 |
| Notifications | 7 |
| Basket Orders | 5 |
| Demo | 5 |
| Scheduled Downloads | 11 |
| **Total** | **104** |
