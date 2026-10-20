# 001-project-discovery-analysis.md

## Purpose
Working analysis document for full project discovery and documentation bootstrap.

## Source
Full repository scan of C:\project on 2026-09-28

## Task/Context
Master prompt requirement: Perform complete forensic discovery, architecture analysis, dependency analysis, documentation bootstrap, and project knowledge-system setup.

## Relevant Files
- C:\project\PROJECT_IMPLEMENTATION_RULE.md (2603 lines)
- C:\project\python-service\app.py (1070 lines)
- C:\project\python-service\requirements.txt
- C:\project\python-service\config\settings.py
- C:\project\package.json
- C:\project\tsconfig.json
- C:\project\docs\architecture\*.md (35+ files)
- C:\project\docs\engines\*.md (25+ files)
- C:\project\docs\reports\*.md (15+ files)
- C:\project\python-service\core\engines\*
- C:\project\python-service\services\*
- C:\project\python-service\brokers\*
- C:\project\python-service\ws_socket\*
- C:\project\app\_pages\*
- C:\project\components\*
- C:\project\lib\*

## Relevant Decisions
1. Create all missing documentation directories per PROJECT_IMPLEMENTATION_RULE.md §49
2. Use serial number 015 for implementation/verification (no existing files)
3. Use serial number 001 for opencode working file (no existing files)
4. Reference existing authoritative docs rather than duplicating
5. Mark unverified items as NOT_VERIFIED
6. Mark conflicts as DOCUMENTATION_CODE_CONFLICT
7. Mark duplicates as DUPLICATE_OR_POSSIBLE_DUPLICATE
8. Mark unresolved dependencies as DEPENDENCY_UNRESOLVED
9. Mark missing docs as DOCUMENTATION_GAP

## Known Limitations

**STATIC ANALYSIS ONLY — zero runtime verification performed.**
- No live backend/frontend running during discovery
- No live MongoDB connection or query
- No live broker credentials or login
- No test execution (`pytest`, `npm test`)
- No build (`npm run build`)
- No type-check (`tsc --noEmit`)
- No lint (`npm run lint`)
- No dependency audit (`pip-audit`, `npm audit`)
- Some engine states UNKNOWN/DEGRADED per docs — require runtime verification
- API request/response schemas not captured (no OpenAPI export)
- `app/_pages/` (41 files) liveness unknown — import graph not built
- `lib/realtime-ws.ts`, `lib/backend.ts`, `lib/kaustubh-types.ts` not read
- `brokers/manager.py`, `brokers/registry.py` not read (failover claims unconfirmed)
- `database/migrations.py` not read (indexes unconfirmed)

## Related Documentation
- Implementation: docs/implementation/015-project-discovery-and-documentation-bootstrap.md
- Verification: docs/verification/015-project-discovery-verification.md
- Master Report: docs/FINAL_REPORT.md
- Project Map: docs/PROJECT_MAP.md
- Architecture Overview: docs/ARCHITECTURE_OVERVIEW.md
- Dependency Map: docs/DEPENDENCY_MAP.md
- Data Flow Map: docs/DATA_FLOW_MAP.md
- Project Glossary: docs/PROJECT_GLOSSARY.md
- Project Gaps: docs/PROJECT_GAPS.md
- Project Risks: docs/PROJECT_RISKS.md
- Project Assumptions: docs/PROJECT_ASSUMPTIONS.md
- Project Change History: docs/PROJECT_CHANGE_HISTORY.md

## Related Implementation Record
docs/implementation/015-project-discovery-and-documentation-bootstrap.md

## Related Verification Record
docs/verification/015-project-discovery-verification.md

## Analysis Summary

### Project Identity
- **Name**: KAUSTUBH / KDS Trading Terminal
- **Type**: Algorithmic trading terminal with PWA interface
- **Architecture**: Engine-first design with session management as single source of truth
- **Backend**: Python/FastAPI (python-service/)
- **Frontend**: Next.js 16.3.4 / React 19.2.8 (app/, components/, lib/, hooks/)
- **Database**: MongoDB (Motor async driver)
- **Primary Broker**: Kotak Neo (kotakneoapi 3.0.7)
- **Secondary Broker**: Shoonya (NorenRestApiOAuth 0.0.41)
- **Paper Trading**: Dummy adapter

### Backend Architecture (python-service/)
```
app.py (FastAPI entry point, 40 router registrations, ~450 routes)
├── api/ (37 modules with routers + 3 extra routers in terminal.py = 40 registrations)
├── auth/ (kotak_client.py - session management)
├── brokers/ (kotak_adapter, shoonya_adapter, dummy, manager, registry)
├── config/ (settings.py - 86 settings)
├── connection_engine/ (WS#3/WS#4 gateway)
├── core/
│   ├── engines/ (engine implementations)
│   ├── event_loop.py
│   └── timezones.py
├── database/ (connection.py, migrations.py)
├── logger/
├── models/
├── runtime/ (singleton.py - process guard)
├── scheduler/ (daily lifecycle orchestration)
├── services/ (30+ service modules incl. session/ and market_watch_engine)
├── tests/ (50+ test files)
├── utils/
├── ws_socket/ (WS#1/WS#2 broker feeds + ws_engine/)
└── start_backend.py (launcher)
```

### Frontend Architecture (Next.js App Router)
```
app/
├── page.tsx, layout.tsx          # /
├── login/page.tsx                # /login
    _pages/ (74 files, 38 page.tsx)  # PRIVATE FOLDER - NOT ROUTED (1 live, 73 unreachable)
├── (ai)/ai/*                     # 14 routes → /ai/*
├── (dashboard)/*                 # 14 routes → /dashboard, /orders, /positions, ...
├── (phase2)/data-saver/*         # 34 routes → /data-saver/*
├── (services)/services/*         # 45 routes → /services/*
├── (trading)/trading/*           # 24 routes → /trading/*
└── api/                          # Next.js API routes (proxy to backend)
components/                       # layout, trading, orders, broker-terminal, dashboard,
                                  # data-center, ui, dummy, kotak, shoonya, settings, pwa
lib/
├── realtime-ws.ts                # WS#3/WS#4 client  (NOT READ)
├── backend.ts                    # REST client        (NOT READ)
├── kaustubh-types.ts             # shared types      (NOT READ)
├── trading-service.ts
├── engine-realtime.ts
└── ...
hooks/                            # use-live-stocks, use-tick-stream, use-realtime-client, ...
tests/                            # TypeScript tests (not run)
```

### Engine Catalog (15 per ENGINE_INVENTORY.md — NOT live-verified)
| # | Engine ID | Type | Doc State | Doc Health | Category |
|---|-----------|------|-----------|------------|----------|
| 1 | feature_engine | Native | RUNNING | HEALTHY | MARKET_DATA |
| 2 | search_engine | Native | RUNNING | HEALTHY | CORE |
| 3 | margin_engine | Native | REGISTERED | UNKNOWN | TRADING |
| 4 | squareoff_engine | Native | REGISTERED | UNKNOWN | TRADING |
| 5 | watchlist_engine | Native | RUNNING | HEALTHY | MARKET_DATA |
| 6 | market_coach | Native | RUNNING | HEALTHY | MARKET_DATA |
| 7 | storage_engine | Native | RUNNING | HEALTHY | STORAGE |
| 8 | scheduler_engine | Facade | RUNNING | HEALTHY | CONTROL |
| 9 | session_manager | Facade | RUNNING | HEALTHY | CORE |
| 10 | connection_manager | Facade | RUNNING | HEALTHY | CONTROL |
| 11 | websocket_engine | Facade | RUNNING | HEALTHY | MARKET_DATA |
| 12 | order_engine | Facade | RUNNING | HEALTHY | TRADING |
| 13 | position_engine | Facade | RUNNING | HEALTHY | TRADING |
| 14 | notification_engine | Facade | REGISTERED | UNKNOWN | CONTROL |
| 15 | db_writer_engine | Native | RUNNING | HEALTHY | STORAGE |

> Registry completeness is **NOT_VERIFIED** — the 15 come from a documentation file, not the runtime registry.

### WebSocket Architecture (4 Channels)
| Channel | Direction | Owner | Purpose |
|---------|-----------|-------|---------|
| WS#1 | Kotak → Backend | ws_manager + ws_engine | Market data (SFeed) |
| WS#2 | Kotak → Backend | order_feed_manager | Order/Position feed |
| WS#3 | Backend → Frontend | connection_engine | Realtime distribution |
| WS#4 | Frontend → Backend | connection_engine + ws_gateway | Commands |

### Broker Adapters
1. **Kotak Neo** (kotakneoapi 3.0.7) - REST + SFeed WebSocket + OrderFeed WebSocket
2. **Shoonya** (NorenRestApiOAuth 0.0.41) - REST + WebSocket (OAuth-based)
3. **Dummy** - Mock adapter using live Kotak feed for paper trading

### Database Collections (MongoDB)
- orders, positions, sessions, market_data, audit_log, targets, notifications, config, users, broker_adapters

### Key Configuration (settings.py — 86 attributes)
- Kotak credentials (`CLIENT_ID`, `CONSUMER_KEY`, `MOBILE_NUMBER`, `MPIN`, `TOTP_SECRET`) — names only, no values recorded
- MongoDB URI (required, no default) + 15 connection/tuning settings
- Scheduler times (login 08:50, WS 08:55, feed start 09:15, squareoff 15:16, feed stop 15:30, WS stop 15:31, logout 16:00)
- Broker mode selection (`broker_mode` = kotak/shoonya/dummy)
- JWT auth (`APP_USERNAME`, `APP_PASSWORD`, `JWT_SECRET`, issuer, audience, TTL)
- WebSocket reconnect (5 settings) and tick buffer (3 settings)

### Dependencies
**Python (pinned in `requirements.txt`)**:
- `kotakneoapi==3.0.7` (critical; fixes RecursionError in 3.0.6)
- `NorenRestApiOAuth==0.0.41`
- `fastapi==0.115.0`, `uvicorn==0.30.6`, `pydantic==2.9.0`
- `motor==3.5.1`, `pymongo==4.8.0`, `dnspython==2.7.0`
- `websockets==13.1` (**hard pin** — uvicorn 0.30.6 imports `websockets.legacy.*`, removed in 14.x)
- `websocket-client==1.9.1`, `pyjwt==2.13.0`, `pyotp==2.10.0`, `cryptography==50.0.1`
- `tenacity`, `structlog`, `psutil`, `python-dotenv`, `python-decouple`
- `openpyxl`, `odfpy`, `fastavro`, `pyyaml`, `tzdata`, `typing_extensions`, `requests`

**Node (from `package.json`)**:
- `next@16.3.4`, `react@19.2.8`, `react-dom@19.2.8`, `typescript@5.9.3`
- 20+ `@radix-ui/*` primitives
- `tailwindcss@3.4.17`, `recharts@2.15.1`, `date-fns@3.6.0`, `zod@3.24.0`
- `lucide-react@0.468.0`, `sonner@1.7.4`, `react-hook-form@7.87.0`
- `react-resizable-panels@2.1.8`, `next-themes@0.4.6`
- `@supabase/supabase-js@2.58.0` (usage UNKNOWN)
- `eslint@9.30.0`, `eslint-config-next@16.3.4`, `eslint-plugin-react-hooks@7.1.1`
- `cmdk`, `vaul`, `input-otp`, `embla-carousel-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate`, `autoprefixer`, `postcss`

## Next Steps
See `docs/FINAL_REPORT.md` §11 for the prioritized plan. Top items:
1. Start backend in `broker_mode=dummy`; verify the engine registry — **expect 17** (14 native + 3 facade), not 15. Then check `/api/settings` for secret leakage.
2. Verify `GET /api/settings` never returns secrets (CRITICAL)
3. `npm run build`, `tsc --noEmit`, `pytest`, `npm test`, `pip-audit`, `npm audit`
4. Export `/openapi.json`; diff against `docs/api/API_CATALOG.md`
5. Import-graph analysis of `app/_pages/**` (41 files)
