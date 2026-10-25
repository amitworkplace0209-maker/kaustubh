# KAUSTUBH Trading Platform — Project Structure

## Architecture

Two-phase application sharing one backend (Python + Node.js + MongoDB):

- **Phase 1 — Data Saver Terminal**: Collect and store live market ticks
- **Phase 2 — Trading Terminal**: Trade with real Kotak Neo API or dummy mode
- **Phase 3 — AI**: Not implemented (no AI code generated)

## Directory Structure

```
project/
├── app/                          # Next.js App Router
│   ├── (dashboard)/              # Dashboard route group
│   │   ├── dashboard/            # Phase 1: System Indicators
│   │   ├── stocks/               # Phase 1: Stock Subscription
│   │   ├── live-ticks/           # Phase 1: Live Tick Table (SSE)
│   │   ├── downloads/            # Phase 1: Custom Download
│   │   ├── trading/             # Phase 2: Trading Dashboard
│   │   ├── positions/           # Phase 2: Position
│   │   ├── orders/              # Phase 2: Order (View + Basket)
│   │   ├── funds/               # Phase 2: Account
│   │   ├── market-watch/        # Phase 2: Stock (Gainers/Losers)
│   │   ├── settings/            # Phase 2: Settings (10 categories)
│   │   ├── notifications/       # Phase 2: Notifications
│   │   ├── order-history/       # System: Order History
│   │   ├── holdings/            # System: Holdings
│   │   ├── portfolio/           # System: Portfolio
│   │   ├── logs/                # System: Logs
│   │   ├── system/              # System: System Status
│   │   └── layout.tsx           # Dashboard layout (sidebar + toaster)
│   ├── globals.css              # Tailwind + theme variables
│   ├── layout.tsx               # Root layout (PWA metadata, theme)
│   └── page.tsx                 # Landing → redirect to /dashboard
├── components/
│   ├── ui/                      # shadcn/ui components (40+ files)
│   ├── pwa/
│   │   └── register-sw.tsx      # Service worker registration
│   ├── sidebar.tsx              # Phase 1/Phase 2/System navigation
│   └── theme-provider.tsx       # next-themes wrapper
├── lib/
│   ├── api.ts                   # Frontend API client (all endpoints)
│   └── utils.ts                 # Utility functions
├── hooks/
│   └── use-toast.ts             # Toast hook
├── public/                      # PWA assets
│   ├── manifest.json
│   ├── sw.js
│   ├── offline.html
│   └── icon-*.png
├── backend/                     # Node.js backend
│   └── src/
│       ├── server.js            # Express app entry
│       ├── config/              # Backend config
│       ├── controllers/         # Route controllers (11 files)
│       ├── routes/              # Express routes (12 files)
│       ├── services/            # Business logic (8 files)
│       ├── mongodb/
│       │   ├── connection.js    # MongoDB connection
│       │   └── models/          # Mongoose models (8 files)
│       ├── download/            # CSV/JSON download logic
│       ├── logs/                # Logger
│       └── scheduler/           # Node scheduler
├── python-service/              # Python FastAPI service
│   ├── app.py                   # FastAPI entry
│   ├── api/routes.py            # All endpoints
│   ├── auth/kotak_client.py     # Official Kotak Neo SDK wrapper
│   ├── config/settings.py       # Settings from .env
│   ├── scheduler/__init__.py    # Auto login/logout scheduler
│   ├── websocket/ws_manager.py  # WebSocket + reconnect
│   ├── services/
│   │   ├── node_forwarder.py    # Tick forwarding to Node
│   │   └── stock_fetcher.py     # Active stock fetcher
│   ├── models/__init__.py       # Pydantic models
│   └── utils/totp.py            # TOTP generation
├── tailwind.config.ts           # Tailwind theme config
├── package.json                 # Frontend dependencies
└── FINAL_VERIFICATION.md        # Verification report
```

## Data Flow

```
Kotak Neo API → Python SDK → WebSocket → on_message → forward_ticks → Node.js
Node.js → tickBuffer → SSE stream → Frontend Live Tick Table
Node.js → tickBuffer → bulk insert → MongoDB
Node.js → /api/system → Dashboard (Python + Node + Mongo + Trading stats)
Frontend → /api/trading → Node.js → Python → Kotak SDK → Order/Position/Holding/Funds
```

## Shared Backend (No Duplicates)

- **One Python service** — handles SDK, login, WebSocket, scheduler
- **One Node.js backend** — handles buffering, MongoDB, API, downloads, settings
- **One MongoDB** — shared by both services
- **One scheduler** — in Python (09:00 login, 15:35 logout IST)
- **One WebSocket** — in Python (forwards ticks to Node)
