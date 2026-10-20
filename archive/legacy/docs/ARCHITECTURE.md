# KAUSTUBH Trading Platform — Architecture Document

## System Architecture

### High-Level Flow

```
Kotak Neo API/SDK
     ↓ (WebSocket + REST)
Python FastAPI Backend (port 8000)
├── KotakSession (singleton, thread-safe)
├── WebSocketManager (tick ingestion)
├── TickBuffer (in-memory → MongoDB bulk write)
├── InstrumentCache (50k+ instruments, in-memory)
├── ExportWorker (background job processor)
├── Scheduler (IST market-hours auto-login/logout)
├── StatusManager (7-service health tracking)
└── 15 API Routers (68 endpoints)
     ↓ (Motor async)
MongoDB (12+ collections)
     ↓ (SSE + REST)
Next.js Frontend (port 3000)
├── Three Workspace Route Groups
│   ├── Trading Terminal (/trading/*)
│   ├── Data Server (/data/*)
│   └── Services (/services/*)
├── 20 Library Modules
├── 3 Custom Hooks
├── 77 Components
└── PWA (service worker + manifest)
```

### Data Flow

1. **Tick Ingestion**: Kotak SDK → WebSocketManager → TickBuffer → MongoDB + SSE fans to frontend
2. **Order Flow**: Frontend → Next.js API → Python Backend → Kotak SDK → Broker
3. **Export Flow**: Frontend → ExportWorker → MongoDB query → Serializer → ZIP → Filesystem/S3
4. **Scheduler Flow**: Timer → Login/Logout at IST market hours → WebSocket subscribe/unsubscribe

---

## Frontend Architecture

- **Framework**: Next.js 15 App Router with React 19
- **Styling**: Tailwind CSS with CSS custom properties for theming
- **UI Components**: shadcn/ui (47 Radix-based primitives)
- **State Management**: External stores with useSyncExternalStore (no Redux/Zustand)
- **Theming**: next-themes with 3 themes (dark, light, AMOLED) + workspace accent colors
- **Routing**: Three route groups with workspace-aware layouts and sidebars
- **Real-time**: SSE (Server-Sent Events) for tick streaming, REST polling for trading data

---

## Backend Architecture

- **Framework**: FastAPI with async/await throughout
- **Database**: MongoDB via Motor (async driver) with 20+ indexes
- **Broker Integration**: Kotak Neo SDK singleton with thread-safe RLock
- **Tick Pipeline**: WebSocket → normalization → in-memory buffer → periodic bulk-write to MongoDB
- **Export Pipeline**: 25 format serializers with plugin architecture
- **Scheduler**: IST-aware daily login/logout timers with holiday calendar
- **Settings**: Key-value store in MongoDB with 160+ defaults

---

## Database Design

12 MongoDB collections:

| Collection | Purpose |
|---|---|
| `ticks` | Tick data (indexed by symbol+ts) |
| `stocks` | Subscribed stocks (unique symbol) |
| `app_logs` | Application logs |
| `notifications` | User notifications |
| `app_settings` | Key-value settings |
| `watchlist` | Stock watchlist |
| `daily_summaries` | Daily rollups |
| `download_history` | Export history |
| `export_jobs` | Async export queue |
| `scheduled_downloads` | Scheduled exports |
| `schedule_runs` | Schedule execution history |
| `basket_orders` | Basket order storage |

---

## Authentication & Security

- **App Lock**: Optional PIN (SHA-256 + salt), stored in `.auth/app-lock.json`
- **Session**: HTTP-only cookie with base64 token
- **Backend**: Currently no auth layer (designed for private network deployment)
- **CORS**: Configurable via `CORS_ORIGINS` env var

---

## PWA Architecture

- Service worker with network-first navigation
- Stale-while-revalidate for static assets
- Offline fallback page
- Web manifest with app icons and shortcuts
- Installable on Android/iOS

---

## Theme System

- CSS custom properties for all colors
- 3 themes: Dark (green-based), Light (neutral), AMOLED (true black)
- Workspace accent colors: Trading (emerald), Data (blue), Services (violet)
- Theme persisted via localStorage (next-themes)

---

## Key Design Patterns

1. **External Store Pattern** — `useSyncExternalStore` for global state (settings, demo engine, triggers, downloads)
2. **Facade Pattern** — `TradingService` routes between demo and live API transparently
3. **Plugin Pattern** — Export serializer registry allows adding formats without modifying core
4. **Singleton Pattern** — `KotakSession`, `InstrumentCache`, `TickBuffer` are module-level singletons
5. **Snapshot Immutability** — Charge snapshots frozen at calculation time, never recomputed

---

## Background Jobs

| Job | Interval | Purpose |
|-----|----------|---------|
| Tick Buffer Flush | 1s | Bulk-write ticks to MongoDB |
| Export Worker | 1s | Process queued export jobs |
| Scheduled Downloads | 20s | Execute due scheduled downloads |
| Scheduler Login/Logout | Daily | Market-hours auto-login/logout |
| Export Cleanup | 6h | Remove expired artifacts (7-day retention) |

---

## Performance Characteristics

- Tick buffer uses rolling window metrics (ticks/sec, writes/sec, trend detection)
- Frontend uses memoization (`useMemo`) for all derived data
- Cards use stable layouts to prevent jumping on data refresh
- SSE provides sub-second tick delivery
- MongoDB indexes ensure fast queries across 12+ collections
