# DEPENDENCY_MAP.md

## KAUSTUBH Trading Platform - Dependency Map

**Last Updated**: 2026-09-28
**Version**: 1.0
**Status**: ACTIVE

---

## Python Dependencies (requirements.txt)

| Package | Version | Purpose | Used By | Criticality | Runtime Req | License |
|---------|---------|---------|---------|-------------|-------------|---------|
| kotakneoapi | 3.0.7 | Kotak Neo SDK (REST + SFeed WS + OrderFeed WS) | auth/kotak_client, brokers/kotak_adapter, ws_socket/ws_manager, ws_socket/order_feed_manager | CRITICAL | Yes | Proprietary |
| NorenRestApiOAuth | 0.0.41 | Shoonya OAuth SDK (REST + WS) | brokers/shoonya_adapter | HIGH | Yes | Proprietary |
| fastapi | 0.115.0 | Web framework | app.py, all api/* | CRITICAL | Yes | MIT |
| uvicorn | 0.30.6 | ASGI server | app.py (main) | CRITICAL | Yes | BSD-3 |
| pydantic | 2.9.0 | Data validation | All models, settings, API | CRITICAL | Yes | MIT |
| motor | 3.5.1 | Async MongoDB driver | database/connection, all DB engines | CRITICAL | Yes | Apache-2.0 |
| dnspython | 2.7.0 | DNS resolver for Atlas SRV | database/connection | HIGH | Yes | MIT |
| psutil | 6.0.0 | Process/system monitoring | runtime/singleton, services | MEDIUM | Yes | BSD-3 |
| websockets | 13.1 | WebSocket protocol (ASGI + kotakneoapi) | uvicorn, kotakneoapi 3.0.7 | CRITICAL | Yes | BSD-3 |
| websocket-client | 1.9.1 | Sync WebSocket client (kotakneoapi) | kotakneoapi 3.0.7 | HIGH | Yes | BSD-3 |
| openpyxl | 3.1.5 | Excel export | api/export_jobs, services/exporter | LOW | No | MIT |
| pyyaml | 6.0.3 | YAML config | config loading | LOW | Yes | MIT |
| odfpy | 1.4.1 | OpenDocument export | services/exporter | LOW | No | Apache-2.0 |
| fastavro | 1.12.2 | Avro serialization | services/serializers | LOW | No | MIT |
| requests | latest | HTTP client (fallback) | Various | LOW | Yes | Apache-2.0 |
| cryptography | 50.0.1 | PBKDF2 PIN + WebAuthn | services/mode_lock | HIGH | Yes | Apache-2.0/BSD |
| python-dotenv | 1.0.0 | .env loading | config/settings.py | HIGH | Yes | BSD-3 |
| pyotp | 2.10.0 | TOTP generation | auth/kotak_client | HIGH | Yes | MIT |
| tenacity | 9.1.4 | Retry logic | Various | MEDIUM | Yes | Apache-2.0 |
| structlog | 26.1.0 | Structured logging | logger/, app.py | MEDIUM | Yes | Apache-2.0 |
| pyjwt | 2.13.0 | JWT auth | services/jwt_auth, api/auth | HIGH | Yes | MIT |
| python-decouple | 3.8 | Config parsing | config/settings.py | MEDIUM | Yes | MIT |
| tzdata | 2026.3 | Timezone data | core/timezones | HIGH | Yes | Apache-2.0 |
| typing_extensions | 4.16.0 | Type hints | Core engines | MEDIUM | Yes | PSF |

**Version Constraints Note**: `websockets==13.1` pinned because uvicorn 0.30.6 imports `websockets.legacy.*` (only exists in 10.x-13.x). kotakneoapi 3.0.7 declares `websockets>=12.0` (no upper bound), so 13.1 satisfies both.

---

## Node Dependencies (package.json)

### Production Dependencies
| Package | Version | Purpose | Used By |
|---------|---------|---------|---------|
| next | 16.3.4 | React framework (App Router) | All frontend |
| react | 19.2.8 | UI library | All components |
| react-dom | 19.2.8 | DOM renderer | All components |
| typescript | 5.9.3 | Type checking | All .ts/.tsx |
| @radix-ui/* | 20+ packages | Accessible UI primitives | components/ui/*, all pages |
| tailwindcss | 3.4.17 | Utility-first CSS | All styling |
| recharts | 2.15.1 | Charting | Dashboard, analytics |
| date-fns | 3.6.0 | Date formatting | Time displays |
| zod | 3.24.0 | Schema validation | API clients, forms |
| lucide-react | 0.468.0 | Icons | All components |
| next-themes | 0.4.6 | Theme switching | Theme provider |
| react-hook-form | 7.87.0 | Form handling | Order entry, settings |
| react-resizable-panels | 2.1.8 | Resizable layouts | Trading terminal |
| sonner | 1.7.4 | Toast notifications | All pages |
| tailwind-merge | 2.6.0 | Class merging | Components |
| tailwindcss-animate | 1.0.7 | Animations | UI |
| vaul | 1.1.2 | Drawer component | Mobile UI |
| class-variance-authority | 0.7.1 | Variant classes | UI components |
| clsx | 2.1.1 | Class composition | Components |
| cmdk | 1.0.4 | Command palette | Universal search |
| embla-carousel-react | 8.5.2 | Carousel | Charts |
| input-otp | 1.4.2 | OTP input | Auth |
| @supabase/supabase-js | 2.58.0 | Supabase client | Auth (optional) |
| @types/node | 24.0.0 | Node types | TypeScript |
| @types/react | 19.0.0 | React types | TypeScript |
| @types/react-dom | 19.0.0 | React DOM types | TypeScript |
| autoprefixer | 10.4.21 | CSS prefixing | Tailwind |
| postcss | 8.4.49 | CSS processing | Tailwind |
| eslint | 9.30.0 | Linting | Code quality |
| eslint-config-next | 16.3.4 | Next.js ESLint | Code quality |
| eslint-plugin-react-hooks | 7.1.1 | React hooks lint | Code quality |

### Dev Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| eslint-plugin-react-hooks | 7.1.1 | React hooks linting |

---

## System Dependencies

| Dependency | Version | Purpose | Runtime Required |
|------------|---------|---------|------------------|
| Python | 3.12+ | Backend runtime | Yes |
| MongoDB | 6.0+ / Atlas | Primary database | Yes |
| Node.js | 18+ | Frontend build/dev | Dev only |
| npm/pnpm | 9+ | Package manager | Dev only |
| Git | 2.30+ | Version control | Dev only |
| OS | Linux/Windows/macOS | Host | Yes |

---

## External Service Dependencies

| Service | Purpose | Access Method | Criticality |
|---------|---------|---------------|-------------|
| Kotak Neo API | Primary broker (orders, market data, positions) | REST + WebSocket (kotakneoapi) | CRITICAL |
| Kotak SFeed WebSocket | Live market data (LTP, OHLC, depth, OI) | WebSocket (WS#1) | CRITICAL |
| Kotak OrderFeed WebSocket | Order/position updates | WebSocket (WS#2) | CRITICAL |
| Shoonya API | Secondary broker | REST + WebSocket (NorenRestApiOAuth) | HIGH |
| MongoDB Atlas | Managed MongoDB (optional) | mongodb+srv:// URI | HIGH (if used) |
| Local MongoDB | Self-hosted MongoDB (optional) | mongodb:// URI | HIGH (if used) |
| NSE/BSE | Exchange (via brokers) | Indirect via brokers | CRITICAL |

---

## Engine-to-Engine Dependencies (from ENGINE_INVENTORY.md & 03_ENGINE_DEPENDENCY_GRAPH.md)

```
Foundation Layer (no deps):
  database_engine
  scheduler_engine

Layer 1:
  connection_engine → database_engine
  feature_engine → database_engine, scheduler_engine

Layer 2:
  risk_engine → margin_engine, order_engine
  margin_engine → database_engine
  order_engine → risk_engine, margin_engine, connection_engine

Layer 3:
  session_engine → connection_engine, websocket_engine
  websocket_engine → connection_engine, scheduler_engine

Layer 4:
  target_engine → feature_engine, watchlist_engine
  watchlist_engine → database_engine, session_engine

Layer 5:
  squareoff_engine → target_engine, watchlist_engine
  audit_engine → all_engines
  watchlist_target_engine → watchlist_engine, target_engine

Additional (from code):
  margin_engine → session_manager, connection_manager (code declares beyond doc)
  market_coach → instrument_cache, watchlist_engine (code) vs feature_engine (doc)
  db_writer_engine → websocket_engine, connection_manager
```

---

## Frontend-to-Backend Dependencies

| Frontend Component | Backend API | WebSocket | Engine |
|--------------------|-------------|-----------|--------|
| Dashboard | /api/system/health, /api/services/engines | WS#3 (engine.status) | All engines |
| Trading Page | /api/trading/* (orders, positions, funds, margin, quote, search) | WS#3 (orders, positions, quotes), WS#4 (place/cancel/modify) | order_engine, risk_engine, margin_engine, position_engine |
| Market Watch | /api/market_watch/*, /api/watchlist_engine/* | WS#3 (market_watch.*) | market_watch_engine, watchlist_engine |
| Session Manager | /api/phase3/session-manager/* | WS#3 (session.*) | session_manager |
| Scheduler | /api/scheduler/*, /api/schedule_events/* | WS#3 (scheduler.*) | scheduler_engine |
| Orders Terminal | /api/trading/orders/*, /api/trading/history/* | WS#3 (orders), WS#4 (commands) | order_engine, broker_terminal |
| Data Center | /api/phase2/data-center/* | WS#3 (storage, exports) | storage_engine, db_writer_engine |
| Settings | /api/settings/* | WS#3 (config.*) | settings_service |
| Search | /api/search, /api/trading/search-local | - | search_engine |
| WebSocket Engine | /api/ws_engine/*, /api/ws_gateway/* | WS#3 (ws_engine.*) | websocket_engine |

---

## Broker Adapter Dependencies

| Adapter | SDK | REST Endpoint | WebSocket | Auth |
|---------|-----|---------------|-----------|------|
| kotak_adapter | kotakneoapi 3.0.7 | https://api.kotaksecurities.com | wss://*.kotaksecurities.com (SFeed + OrderFeed) | OAuth 2.0 + TOTP |
| shoonya_adapter | NorenRestApiOAuth 0.0.41 | https://api.shoonya.com | wss://api.shoonya.com/NorenWSTP/ | OAuth (code exchange) |
| dummy_adapter | None (mock) | In-memory | Uses Kotak WS#1 feed | Mock (any string) |

---

## Critical Dependency Chains

### Startup Chain (must succeed in order)
1. MongoDB connection (database.connection.connect_mongo)
2. Runtime settings refresh (services.runtime_settings)
3. Notification center init (services.notification_center)
4. Dummy adapter auto-ready (brokers.dummy)
5. Tick buffer start (services.tick_buffer)
6. Export worker start (api.export_jobs)
7. Downloads checker start (api.scheduled_downloads)
8. Scheduler start (scheduler.start_scheduler)
9. WebSocket Engine wiring (api.ws_engine)
10. Order Feed Manager start (ws_socket.order_feed_manager)
11. WS Manager start (ws_socket.ws_manager)
12. Session Manager hydrate (services.session.session_manager)
13. Engine Registry registration (services.engine_registry)
14. Connection Engine start (connection_engine.connection_engine)
15. Instrument cache preload (services.instrument_cache)

### Market Data Chain (runtime)
```
Kotak SFeed → ws_manager → ws_engine (validate/normalize)
    → EngineEventBus (TICK_VALIDATED)
    → feature_engine (signals)
    → market_watch_engine (eligibility/ranking)
    → watchlist_engine (tracking)
    → db_writer_engine (via Connection Manager DATA_SAVER)
    → Connection Manager → WS#3 → Frontend
```

### Order Chain (runtime)
```
Frontend WS#4/REST → Connection Manager/API
    → order_engine (validate)
    → risk_engine (pre-trade check)
    → margin_engine (margin check)
    → audit_engine (record decision)
    → broker_terminal_engine → kotak_adapter → Kotak REST
    → Kotak → WS#2 OrderUpdate → OrderFeedManager
    → EngineEventBus (ORDER_UPDATE)
    → order_engine/risk/audit
    → Connection Manager → WS#3 → Frontend
```

---

## Dependency Risk Assessment

| Dependency | Risk | Mitigation |
|------------|------|------------|
| kotakneoapi 3.0.7 | Single source, proprietary, version pinned | Vendor relationship, pinned version tested |
| MongoDB | Single point of failure | Atlas HA / replica set, connection pool resilience |
| websockets 13.1 | Pinned for uvicorn compatibility | Test upgrade path when uvicorn updates |
| Kotak SFeed WS | External service, market hours only | Dummy mode for development, reconnect logic |
| Shoonya OAuth | Secondary, less tested | Kotak primary, Shoonya fallback only |
| JWT_SECRET | Rotation requires re-login | Long TTL (8hr), secure generation |

---

## Related Documents

- `requirements.txt` - Python dependencies
- `package.json` - Node dependencies
- `03_ENGINE_DEPENDENCY_GRAPH.md` - Engine DAG
- `ENGINE_INVENTORY.md` - Engine dependencies
- `08_WEBSOCKET_ARCHITECTURE.md` - WS dependencies
- `SDK_CATALOG.md` - SDK details
- `BROKER_INTEGRATION_MAP.md` - Broker capabilities