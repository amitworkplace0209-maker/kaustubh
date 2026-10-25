# FRONTEND_ARCHITECTURE.md

## KAUSTUBH Trading Platform - Frontend Architecture

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Verification**: Structure confirmed via filesystem scan. Component internals NOT audited; build NOT run.

---

## Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router) | 16.3.4 |
| UI | React / React DOM | 19.2.8 |
| Language | TypeScript | 5.9.3 |
| Styling | Tailwind CSS | 3.4.17 |
| Components | Radix UI primitives | 20+ packages |
| Charts | Recharts | 2.15.1 |
| Validation | Zod | 3.24.0 |
| Forms | React Hook Form | 7.87.0 |
| Layout | react-resizable-panels | 2.1.8 |
| Toasts | Sonner | 1.7.4 |
| Icons | Lucide React | 0.468.0 |
| Dates | date-fns | 3.6.0 |
| Linting | ESLint + next config + react-hooks plugin | 9.30.0 |
| Realtime | Native WebSocket via `lib/realtime-ws.ts` | — |

---

## Directory Structure

```
C:\project\
├── app\                          # Next.js App Router (151 routable page files)
│   ├── page.tsx                  # /
│   ├── layout.tsx                # Root layout
│   ├── login\page.tsx            # /login
    _pages\                   # 78 files / 36 dirs / 38 page.tsx - NOT ROUTED (1 live, 73 unreachable)
│   ├── (ai)\                     # Route group — /ai/*
│   ├── (dashboard)\              # Route group — /dashboard, /orders, ...
│   ├── (phase2)\                 # Route group — /data-saver/*
│   ├── (services)\               # Route group — /services/*
│   ├── (trading)\                # Route group — /trading/*
│   └── api\                      # Next.js API routes (proxy to backend)
├── components\                   # React components
│   ├── layout\                   # shell, sidebar, topbar, phase-switcher
│   ├── trading\                  # order entry, trade page, risk/margin panel
│   ├── orders\                   # history, baskets, suggestions
│   ├── broker-terminal\          # kotak, shoonya, dummy pages
│   ├── dashboard\                # engine status, market session
│   ├── data-center\              # storage, exports, schedules
│   ├── settings\                 # settings UI
│   ├── ui\                       # Radix-based primitives
│   ├── dummy\                    # paper-trading UI
│   ├── kotak\                    # Kotak-specific
│   ├── shoonya\                  # Shoonya-specific
│   └── pwa\                      # PWA install/offline
├── lib\                          # Shared libraries
│   ├── realtime-ws.ts            # WS#3/WS#4 client  ★ CRITICAL
│   ├── backend.ts                # REST API client  ★ CRITICAL
│   ├── kaustubh-types.ts         # Shared TS types  ★ CRITICAL
│   ├── trading-service.ts        # Trading logic client
│   ├── engine-realtime.ts        # Engine-specific realtime
│   └── ...                       # (20+ files)
├── hooks\                        # Custom React hooks
│   ├── use-live-stocks\          # Live price subscription
│   ├── use-tick-stream\          # Tick stream
│   ├── use-realtime-client\      # WS lifecycle
│   └── ...                       # (multiple)
└── tests\                        # TypeScript tests
```

---

## Route Groups (URL-Transparent)

| Group | Pages | URL prefix |
|-------|-------|-----------|
| `(dashboard)` | 14 | `/dashboard`, `/orders`, `/positions`, `/settings`, ... |
| `(trading)` | 24 | `/trading/*` |
| `(services)` | 45 | `/services/*` |
| `(phase2)` | 34 | `/data-saver/*` |
| `(ai)` | 14 | `/ai/*` |

**Important**: Group names are stripped from the URL. `(dashboard)/orders/page.tsx` serves `/orders`, not `/dashboard/orders`.

Full route inventory: `FRONTEND_ROUTE_MAP.md`.

---

## Critical Finding: `app/_pages/` Is Not Routed

Next.js treats folders prefixed with `_` as **private** and excludes them from routing.

`app/_pages/` contains **41 `page.tsx` files** with names like `dashboard`, `market-watch`, `session-manager`, `orders`, `scheduler`.

**Implication**: These have no URL. They are either:
- Composed into routed pages via imports, or
- Legacy duplicates awaiting cleanup

**Status**: `DUPLICATE_OR_POSSIBLE_DUPLICATE` — see `../audits/DUPLICATE_AND_LEGACY_FINDINGS.md`.

---

## Core Libraries

### `lib/realtime-ws.ts` — WebSocket Client
Handles WS#3 (receive) and WS#4 (send) over `WS /ws/realtime`.
- Connect with token from `GET /api/realtime/token`
- Reconnect with backoff
- Route-scoped subscriptions
- Gap recovery via REST rehydration
- Distribute events to subscribed hooks

### `lib/backend.ts` — REST Client
Centralized HTTP client for the FastAPI backend.
- Base URL configuration
- Auth header attachment
- Error normalization
- Typed response handling

### `lib/kaustubh-types.ts` — Shared Types
TypeScript interfaces mirroring backend Pydantic models. **This is the frontend/backend contract — drift here is a real risk.**

### `lib/trading-service.ts`
Trading-specific client methods (order place/modify/cancel, positions, margin).

### `lib/engine-realtime.ts`
Engine-state realtime subscription helpers.

---

## Hooks

| Hook | Purpose |
|------|---------|
| `use-realtime-client` | WS#3/WS#4 lifecycle, reconnection |
| `use-live-stocks` | Subscribe to live prices for a symbol set |
| `use-tick-stream` | High-frequency tick stream |
| `use-live-*` (others) | Domain-specific live data |

**Pattern**: Hooks own WS subscription lifecycle; components consume hook state.

---

## Component Organization

| Directory | Responsibility |
|-----------|---------------|
| `layout/` | App shell, sidebar, topbar, phase switcher, market session indicator |
| `trading/` | Order entry forms, trade ticket, risk/margin panel, position table |
| `orders/` | Order history, baskets, suggestions |
| `broker-terminal/` | Per-broker consoles (Kotak, Shoonya, Dummy) |
| `dashboard/` | Engine status cards, market session, quick stats |
| `data-center/` | Storage views, export configuration, schedule management |
| `settings/` | Settings forms and panels |
| `ui/` | Radix-wrapped primitives (button, dialog, select, table, tabs, ...) |
| `dummy/` | Paper-trading-specific UI |
| `kotak/` | Kotak-specific widgets |
| `shoonya/` | Shoonya-specific widgets |
| `pwa/` | Install prompt, offline banner, service worker registration |

---

## UI Primitives (`components/ui/`)

Built on Radix UI + Tailwind + CVA. Typical set:
`button`, `card`, `dialog`, `dropdown-menu`, `select`, `tabs`, `table`, `input`, `label`, `badge`, `tooltip`, `popover`, `sheet`, `skeleton`, `toast`/`sonner`, `separator`, `scroll-area`, `toggle-group`, `progress`, `switch`, `checkbox`, `radio-group`, `accordion`, `alert`, `avatar`, `calendar`, `carousel`, `command`, `drawer`, `form`, `hover-card`, `input-otp`, `menubar`, `navigation-menu`, `pagination`, `resizable`, `sidebar`, `slider`, `textarea`, `chart`, `context-menu`, `breadcrumb`, `collapsible`

`NOT_VERIFIED` — the exact set was not enumerated; listed from `package.json` Radix dependencies.

---

## Rendering Strategy

| Pattern | Usage | Status |
|---------|-------|--------|
| Server Components | Layout, static shells | `NOT_VERIFIED` |
| Client Components | Interactive pages (most) | `NOT_VERIFIED` |
| Route groups | Code organization without URL change | Confirmed (filesystem) |
| Private folders | `_pages/` excluded from routing | Confirmed (convention) |
| Dynamic segments | `[terminalId]`, `[alertId]`, `[date]`, `[type]`, `[id]` | Confirmed (filesystem) |

---

## PWA

- `components/pwa/` — install prompt, offline handling
- `/data-saver/settings/pwa` — PWA settings page
- Service worker registration: `NOT_VERIFIED`

---

## State Management

**No Redux/Zustand confirmed.** State appears to be:
- React local state / hooks
- Realtime events via `lib/realtime-ws.ts`
- REST refetch via `lib/backend.ts`

**UNKNOWN**: Whether a global client store exists (context-based or library-based).

---

## Build & Quality Gates

| Command | Purpose | Status |
|---------|---------|--------|
| `npm run dev` | Dev server on :3000 | Not run |
| `npm run build` | Production build | Not run |
| `npm run lint` | ESLint | Not run |
| `npx tsc --noEmit` | Type check | Not run |
| `npm test` | Tests (`tests/`) | Not run |

**All build/verification steps are `NOT_VERIFIED`.**

---

## Key Risks

| Risk | Detail | Severity |
|------|--------|----------|
| Type drift | `kaustubh-types.ts` vs backend Pydantic | High |
| **73 dead pages** of 74 in `app/_pages/` | import graph built: 1 live, 73 unreachable | Low |
| Duplicate URLs | Same path in multiple route groups | Medium |
| Build failure unknown | No build has been run | High |
| Bundle size | **189** page components (151 routable) + 20 Radix packages | Medium |
| AI routes unimplemented | 14 routes, no backend found | Low |

---

## Related Documents
- `FRONTEND_ROUTE_MAP.md` — Full route inventory
- `FRONTEND_DATA_FLOW.md` — Data and realtime flow
- `../api/API_CATALOG.md` — Backend endpoints consumed
- `../architecture/SDK_CATALOG.md` — Node dependency detail
- `../audits/DUPLICATE_AND_LEGACY_FINDINGS.md` — Duplication analysis
