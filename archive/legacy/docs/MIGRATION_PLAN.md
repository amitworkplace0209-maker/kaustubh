# Migration Plan: Node.js → Python FastAPI

## 1. Migration Plan

### Current Architecture
```
Next.js → Node.js (Express, port 4000) → Python (FastAPI, port 8000) → Kotak SDK → MongoDB
                                       ↑_________________________________|
                                       Python forwards ticks back to Node.js via HTTP
```

### Target Architecture
```
Next.js → Python (FastAPI, port 8000) → Kotak SDK → MongoDB
```

### Migration Strategy
1. Python absorbs ALL Node.js business logic (tick buffer, settings, stocks, downloads, statistics, system dashboard, watchlist, notifications, baskets, logs, scheduler, SSE)
2. Python connects directly to MongoDB (Motor async driver)
3. Remove `node_forwarder.py` — Python writes ticks to MongoDB itself
4. Frontend `lib/api.ts` repointed to Python (port 8000)
5. Node.js backend directory deleted

---

## 2. Backend Features Still in Node.js (to migrate)

| Feature | Node.js Location | Python Target |
|---------|-----------------|---------------|
| Tick buffer (batch + flush) | services/tickBuffer.js | services/tick_buffer.py |
| SSE live tick stream | controllers/tickController.js | api/routes/ticks.py |
| IST scheduler | scheduler/index.js | scheduler/__init__.py (upgrade) |
| Settings (90+ defaults) | services/settingsService.js | services/settings_service.py |
| Stock CRUD + auto-subscribe | controllers/stockController.js + services/stockService.js | api/routes/stocks.py |
| Download export (6 formats) | download/tickDownload.js + controllers/downloadController.js | api/routes/downloads.py |
| Statistics + gainers/losers | services/statisticsService.js | api/routes/statistics.py |
| System dashboard | controllers/systemController.js | api/routes/system.py |
| Watchlist CRUD | controllers/watchlistController.js | api/routes/watchlist.py |
| Notifications CRUD | controllers/notificationController.js | api/routes/notifications.py |
| Basket orders + OCO | controllers/basketController.js | api/routes/baskets.py |
| Logs query/clear | controllers/logController.js + services/logService.js | api/routes/logs.py |
| MongoDB stats | controllers/systemController.js | api/routes/system.py |
| Download history | controllers/systemController.js | api/routes/system.py |
| Trading day stats | controllers/systemController.js | api/routes/system.py |
| Trading history aggregation | controllers/systemController.js | api/routes/system.py |
| Python proxy layer | services/pythonClient.js + controllers/tradingController.js | ELIMINATED (direct) |
| Internal stocks endpoint | routes/internal.js | ELIMINATED (Python has direct DB access) |

## 3. Features Already in Python (to keep/upgrade)

| Feature | Python Location | Status |
|---------|----------------|--------|
| Kotak login/logout | auth/kotak_client.py | Keep, minor fixes |
| Trading endpoints (11) | api/routes.py | Keep, move to separate router |
| WebSocket manager | websocket/ws_manager.py | Major upgrade needed |
| Scheduler | scheduler/__init__.py | Upgrade (holiday, retry, login-now) |
| TOTP | utils/totp.py | Keep |
| Logger | logger/__init__.py | Keep, add DB persistence |
| Pydantic models | models/__init__.py | Keep, add validation |
| Config | config/settings.py | Add MongoDB URI fields |

## 4. Remaining Work

1. Add Motor (async MongoDB) connection
2. Build all MongoDB collection definitions
3. Build tick buffer with bulk insert
4. Build SSE endpoint
5. Build all CRUD routers (stocks, settings, watchlist, notifications, baskets, logs, downloads, statistics, system)
6. Upgrade WebSocket manager (heartbeat, dedup, buffer, reconnect, metrics)
7. Upgrade scheduler (holiday calendar, login-now, retry)
8. Remove node_forwarder.py
9. Repoint frontend to Python
10. Delete Node.js backend
11. Build + verify

## 5. WebSocket Issues

| Issue | Fix |
|-------|-----|
| Hardcoded constants ignore settings | Use settings values |
| `_intentional_disconnect` never reset | Reset on new subscribe |
| Heartbeat never stops on unsubscribe | Stop when zero subscriptions |
| Double subscribe from _on_open + _reconnect | Guard with flag |
| `connected` flag race conditions | Use lock consistently |
| `kotak_session.client` accessed without lock | Go through kotak_session methods |
| No tick validation | Add validation before buffering |
| No buffer queue during reconnect | Add in-memory buffer, flush on reconnect |
| No duplicate connection protection | Add connection guard |
| No metrics | Add counters for all events |
| Raw tick included in every forward | Make optional, default off |

## 6. Database Issues

| Issue | Fix |
|-------|-----|
| No indexes on `download_history` | Add ts index |
| `raw` field in ticks doubles storage | Make optional via setting |
| No TTL on ticks | Add optional TTL |
| No connection pool config | Configure maxPoolSize |

## 7. API Issues

| Issue | Fix |
|-------|-----|
| No input validation on order fields | Add Pydantic validators |
| No auth on any endpoint | Add API key middleware |
| CORS wide open | Restrict to frontend origin |
| Inconsistent response shapes | Standardize all responses |
| No rate limiting | Add slowapi rate limiting |

## 8. Performance Issues

| Issue | Fix |
|-------|-----|
| Node forwarder adds HTTP hop | Eliminate (direct MongoDB) |
| No bulk write batching in Python | Use Motor bulk_write |
| SSE heartbeat every 15s | Keep, but use async generator |
| Statistics aggregation scans full day | Add time-based index hint |

## 9. Security Issues

| Issue | Fix |
|-------|-----|
| No auth on trading endpoints | Add API key header check |
| CORS `*` | Restrict origins |
| Credentials in env | Keep, but add .env to .gitignore |
| Error messages leak internals | Sanitize error responses |
| No HTTPS enforcement | Document reverse proxy requirement |

## 10. Final Implementation Roadmap

### Phase 1: Python Backend (this session)
- MongoDB connection (Motor)
- All collection definitions
- Tick buffer + bulk insert
- All CRUD routers
- SSE endpoint
- Settings system
- Download export
- Statistics
- System dashboard
- WebSocket upgrade
- Scheduler upgrade
- Remove node_forwarder

### Phase 2: Frontend Migration (this session)
- Repoint lib/api.ts to Python
- Verify all pages load

### Phase 3: Cleanup (this session)
- Delete Node.js backend
- Build + typecheck
- Verify
