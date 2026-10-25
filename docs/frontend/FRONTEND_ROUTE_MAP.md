# FRONTEND_ROUTE_MAP.md

## KAUSTUBH Trading Platform - Frontend Route Map

**Last Updated**: 2026-09-28
**Version**: 1.1
**Status**: ACTIVE
**Source**: Filesystem enumeration of `C:\project\app\**\page.tsx` with route groups stripped
**Counts** (corrected 2026-09-28 — see `../audits/FRONTEND_PAGES_AUDIT.md` §1):
**189** `page.tsx` total · **151** routable · **38** inside the non-routable `app\_pages\` ·
**74** total files under `app\_pages\`
*(An earlier version of this file said 166 page files — that count was wrong.)*
**Verification**: File paths and route strings verified by enumeration. **RENDERABILITY of
each route is `NOT_VERIFIED`** — no build or dev server was run.
**Duplicate routes**: **none** — 151 routable pages yield 151 distinct route strings. The
earlier "duplicate URL" finding (D-05) is **withdrawn**.

---

## Critical Finding: Route Groups vs URL Paths

Next.js App Router **route groups** are folder names wrapped in parentheses. They organize code without affecting the URL.

| Group | Purpose | Route count |
|-------|---------|-------------|
| `(ai)` | AI/ML feature area | 14 |
| `(dashboard)` | Primary trading dashboard | 12 |
| `(phase2)` | Data Saver / analytics | 34 |
| `(services)` | Engine & service consoles | 45 |
| `(trading)` | Trading terminal | 24 |

`/dashboard` is NOT `/dashboard/dashboard` — the group name is stripped from the URL.

---

## Critical Finding: `app/_pages/` Is NOT Routable

**`DOCUMENTATION_CODE_CONFLICT`**: The `app/_pages/` directory contains **41 `page.tsx` files** but folders prefixed with `_` are **private folders** in Next.js App Router and are **excluded from routing**.

Consequence: these components exist in the repo but have **no URL** of their own. They are likely:
- Imported and rendered by the grouped pages (composition), OR
- Legacy/duplicated page implementations awaiting migration (see `DUPLICATE_AND_LEGACY_FINDINGS.md`)

Examples affected: `app/_pages/dashboard/page.tsx`, `app/_pages/market-watch/page.tsx`, `app/_pages/session-manager/page.tsx`, `app/_pages/orders/page.tsx`, `app/_pages/scheduler/page.tsx`.

**UNRESOLVED**: Which of the 41 `_pages` files are actively imported vs. dead. Requires `grep` for each import path.

---

## Root & Auth Routes

| URL | File | Notes |
|-----|------|-------|
| `/` | `app/page.tsx` | Landing/redirect |
| `/login` | `app/login/page.tsx` | Auth entry |

---

## `(dashboard)` Group — 12 routes

| URL | File | Domain |
|-----|------|--------|
| `/dashboard` | `(dashboard)/dashboard/page.tsx` | Main dashboard |
| `/downloads` | `(dashboard)/downloads/page.tsx` | Downloads |
| `/funds` | `(dashboard)/funds/page.tsx` | Funds |
| `/holdings` | `(dashboard)/holdings/page.tsx` | Holdings |
| `/live-ticks` | `(dashboard)/live-ticks/page.tsx` | Live tick view |
| `/market-watch` | `(dashboard)/market-watch/page.tsx` | Market Watch |
| `/notifications` | `(dashboard)/notifications/page.tsx` | Notifications |
| `/order-history` | `(dashboard)/order-history/page.tsx` | Order history |
| `/orders` | `(dashboard)/orders/page.tsx` | Orders |
| `/portfolio` | `(dashboard)/portfolio/page.tsx` | Portfolio |
| `/positions` | `(dashboard)/positions/page.tsx` | Positions |
| `/settings` | `(dashboard)/settings/page.tsx` | Settings |
| `/stocks` | `(dashboard)/stocks/page.tsx` | Stocks |
| `/system` | `(dashboard)/system/page.tsx` | System |

> Note: `/market-watch`, `/orders`, `/positions`, `/notifications`, `/settings` each also exist under `(trading)` and/or `(phase2)` — see duplicate section.

---

## `(trading)` Group — 24 routes

| URL | File |
|-----|------|
| `/trading` | `(trading)/trading/page.tsx` |
| `/trading/account` | `(trading)/trading/account/page.tsx` |
| `/trading/audit` | `(trading)/trading/audit/page.tsx` |
| `/trading/basket-orders` | `(trading)/trading/basket-orders/page.tsx` |
| `/trading/calculator` | `(trading)/trading/calculator/page.tsx` |
| `/trading/calendar` | `(trading)/trading/calendar/page.tsx` |
| `/trading/dashboard` | `(trading)/trading/dashboard/page.tsx` |
| `/trading/funds` | `(trading)/trading/funds/page.tsx` |
| `/trading/history` | `(trading)/trading/history/page.tsx` |
| `/trading/holdings` | `(trading)/trading/holdings/page.tsx` |
| `/trading/market-watch` | `(trading)/trading/market-watch/page.tsx` |
| `/trading/notifications` | `(trading)/trading/notifications/page.tsx` |
| `/trading/order-history` | `(trading)/trading/order-history/page.tsx` |
| `/trading/orders` | `(trading)/trading/orders/page.tsx` |
| `/trading/portfolio` | `(trading)/trading/portfolio/page.tsx` |
| `/trading/positions` | `(trading)/trading/positions/page.tsx` |
| `/trading/reports` | `(trading)/trading/reports/page.tsx` |
| `/trading/risk` | `(trading)/trading/risk/page.tsx` |
| `/trading/settings` | `(trading)/trading/settings/page.tsx` |
| `/trading/suggestion` | `(trading)/trading/suggestion/page.tsx` |
| `/trading/theme` | `(trading)/trading/theme/page.tsx` |
| `/trading/trade` | `(trading)/trading/trade/page.tsx` |
| `/trading/trading-chart` | `(trading)/trading/trading-chart/page.tsx` |
| `/trading/watchlist` | `(trading)/trading/watchlist/page.tsx` |

---

## `(services)` Group — 45 routes

### Engine Consoles
| URL | File |
|-----|------|
| `/services` | `(services)/services/page.tsx` |
| `/services/audit-engine` | `(services)/services/audit-engine/page.tsx` |
| `/services/feature-engine` | `(services)/services/feature-engine/page.tsx` |
| `/services/margin-engine` | `(services)/services/margin-engine/page.tsx` |
| `/services/order-engine` | `(services)/services/order-engine/page.tsx` |
| `/services/target-engine` | `(services)/services/target-engine/page.tsx` |
| `/services/squareoff` | `(services)/services/squareoff/page.tsx` |
| `/services/websocket-engine` | `(services)/services/websocket-engine/page.tsx` |
| `/services/db-writer` | `(services)/services/db-writer/page.tsx` |
| `/services/storage` | `(services)/services/storage/page.tsx` |
| `/services/feature-engine` | `(services)/services/feature-engine/page.tsx` |

### Order Engine Sub-routes
| URL | File |
|-----|------|
| `/services/order-engine/orders` | `(services)/services/order-engine/orders/page.tsx` |
| `/services/order-engine/basket` | `(services)/services/order-engine/basket/page.tsx` |
| `/services/order-engine/history` | `(services)/services/order-engine/history/page.tsx` |

### Session Manager (14 routes)
| URL | File |
|-----|------|
| `/services/session-manager` | `(services)/services/session-manager/page.tsx` |
| `/services/session-manager/configuration` | `.../configuration/page.tsx` |
| `/services/session-manager/connections` | `.../connections/page.tsx` |
| `/services/session-manager/diagnostics` | `.../diagnostics/page.tsx` |
| `/services/session-manager/expiry` | `.../expiry/page.tsx` |
| `/services/session-manager/history` | `.../history/page.tsx` |
| `/services/session-manager/instruments` | `.../instruments/page.tsx` |
| `/services/session-manager/live-feed` | `.../live-feed/page.tsx` |
| `/services/session-manager/manual-add` | `.../manual-add/page.tsx` |
| `/services/session-manager/pins` | `.../pins/page.tsx` |
| `/services/session-manager/reconcile` | `.../reconcile/page.tsx` |
| `/services/session-manager/session` | `.../session/page.tsx` |
| `/services/session-manager/sources` | `.../sources/page.tsx` |
| `/services/session-manager/subscriptions` | `.../subscriptions/page.tsx` |

### Scheduler (5 routes)
| URL | File |
|-----|------|
| `/services/scheduler` | `(services)/services/scheduler/page.tsx` |
| `/services/scheduler/ledger` | `.../ledger/page.tsx` |
| `/services/scheduler/lifecycle` | `.../lifecycle/page.tsx` |
| `/services/scheduler/runs` | `.../runs/page.tsx` |
| `/services/scheduler/timeline` | `.../timeline/page.tsx` |

### Connection Manager (4 routes)
| URL | File |
|-----|------|
| `/services/connection-manager` | `(services)/services/connection-manager/page.tsx` |
| `/services/connection-manager/configuration` | `.../configuration/page.tsx` |

> Annotated 2026-10-07 (implementation 027). All four route shells are identical
> `next/dynamic` shims that import the shared implementations in
> `app/_pages/connection-manager/` (`page.tsx`, `connections.tsx`, `events.tsx`,
> `configuration.tsx`) plus `cm-shared.tsx` for types, API clients and shared
> primitives. Every surface is **read-only**: the gateway control plane exposes
> status, metadata and diagnostics only (engine spec §13/§38), so no create/pause/
> resume/delete control is offered. There is no `/services/connection-manager/profile`
> — the engine profile uses the shared route
> `/services/system/profile/connection_manager`. See
> `docs/audits/frontend/CONNECTION_MANAGER_UI_AUDIT.md`.
| `/services/connection-manager/connections` | `.../connections/page.tsx` |
| `/services/connection-manager/events` | `.../events/page.tsx` |

### Market Watch Service (8 routes)
| URL | File |
|-----|------|
| `/services/market-watch` | `(services)/services/market-watch/page.tsx` |
| `/services/market-watch/filters` | `.../filters/page.tsx` |
| `/services/market-watch/movers` | `.../movers/page.tsx` |
| `/services/market-watch/pins` | `.../pins/page.tsx` |
| `/services/market-watch/rank` | `.../rank/page.tsx` |
| `/services/market-watch/symbol` | `.../symbol/page.tsx` |
| `/services/market-watch/weekly` | `.../weekly/page.tsx` |
| `/services/market-watch/report` | `.../report/page.tsx` |

> Corrected 2026-10-07 (implementation 026): this list previously showed 6 routes
> and omitted `/weekly` and `/report`, both of which exist. Shared tab
> implementations live in `app/_pages/market-watch/`; each route shell only passes
> an `initialTab`. Deep links: `?tab=weekly`, `?tab=report`.

### Broker Terminal (4 routes)
| URL | File |
|-----|------|
| `/services/broker-terminal` | `(services)/services/broker-terminal/page.tsx` |
| `/services/broker-terminal/terminals` | `.../terminals/page.tsx` |
| `/services/broker-terminal/profile/[terminalId]` | `.../profile/[terminalId]/page.tsx` |

### Other Services
| URL | File |
|-----|------|
| `/services/logs` | `(services)/services/logs/page.tsx` |
| `/services/search` | `(services)/services/search/page.tsx` |
| `/services/security` | `(services)/services/security/page.tsx` |
| `/services/settings` | `(services)/services/settings/page.tsx` |
| `/services/system` | `(services)/services/system/page.tsx` |
| `/services/system-indicators` | `(services)/services/system-indicators/page.tsx` |
| `/services/watchlist` | `(services)/services/watchlist/page.tsx` |
| `/services/theme` | `(services)/services/theme/page.tsx` |

---

## `(phase2)` — Data Saver — 34 routes

### Overview
| URL | File |
|-----|------|
| `/data-saver` | `(phase2)/data-saver/page.tsx` |
| `/data-saver/dashboard` | `.../dashboard/page.tsx` |
| `/data-saver/ticks` | `.../ticks/page.tsx` |
| `/data-saver/analytics` | `.../analytics/page.tsx` |

### Insights
| URL | File |
|-----|------|
| `/data-saver/insights` | `.../insights/page.tsx` |
| `/data-saver/insights/today` | `.../insights/today/page.tsx` |
| `/data-saver/insights/activity` | `.../insights/activity/page.tsx` |
| `/data-saver/insights/attention` | `.../insights/attention/page.tsx` |
| `/data-saver/insights/errors` | `.../insights/errors/page.tsx` |
| `/data-saver/insights/errors/[id]` | `.../insights/errors/[id]/page.tsx` |

### Reports
| URL | File |
|-----|------|
| `/data-saver/insights/reports` | `.../insights/reports/page.tsx` |
| `/data-saver/insights/reports/daily/[date]` | `.../insights/reports/daily/[date]/page.tsx` |
| `/data-saver/insights/reports/weekly` | `.../insights/reports/weekly/page.tsx` |
| `/data-saver/insights/reports/[type]` | `.../insights/reports/[type]/page.tsx` |

### Alerts
| URL | File |
|-----|------|
| `/data-saver/alerts` | `.../alerts/page.tsx` |
| `/data-saver/alerts/[alertId]` | `.../alerts/[alertId]/page.tsx` |

### Data Center & Quality
| URL | File |
|-----|------|
| `/data-saver/data-center` | `.../data-center/page.tsx` |
| `/data-saver/quality` | `.../quality/page.tsx` |

### Downloads & Formats
| URL | File |
|-----|------|
| `/data-saver/downloads` | `.../downloads/page.tsx` |
| `/data-saver/download-history` | `.../download-history/page.tsx` |
| `/data-saver/formats` | `.../formats/page.tsx` |
| `/data-saver/formats/settings` | `.../formats/settings/page.tsx` |

### Schedules
| URL | File |
|-----|------|
| `/data-saver/schedules` | `.../schedules/page.tsx` |
| `/data-saver/schedules/new` | `.../schedules/new/page.tsx` |

### Watch & Subscription
| URL | File |
|-----|------|
| `/data-saver/watch` | `.../watch/page.tsx` |
| `/data-saver/watch-list` | `.../watch-list/page.tsx` |
| `/data-saver/subscription` | `.../subscription/page.tsx` |

### WebSocket
| URL | File |
|-----|------|
| `/data-saver/websocket` | `.../websocket/page.tsx` |

### Notifications
| URL | File |
|-----|------|
| `/data-saver/notifications` | `.../notifications/page.tsx` |
| `/data-saver/notifications/[notificationId]` | `.../notifications/[notificationId]/page.tsx` |

### Settings (11 routes)
| URL | File |
|-----|------|
| `/data-saver/settings` | `.../settings/page.tsx` |
| `/data-saver/settings/[id]` | `.../settings/[id]/page.tsx` |
| `/data-saver/settings/about` | `.../settings/about/page.tsx` |
| `/data-saver/settings/accessibility` | `.../settings/accessibility/page.tsx` |
| `/data-saver/settings/app-lock` | `.../settings/app-lock/page.tsx` |
| `/data-saver/settings/biometric` | `.../settings/biometric/page.tsx` |
| `/data-saver/settings/privacy` | `.../settings/privacy/page.tsx` |
| `/data-saver/settings/pwa` | `.../settings/pwa/page.tsx` |
| `/data-saver/settings/security` | `.../settings/security/page.tsx` |
| `/data-saver/settings/storage` | `.../settings/storage/page.tsx` |
| `/data-saver/settings/theme` | `.../settings/theme/page.tsx` |
| `/data-saver/configuration` | `.../configuration/page.tsx` |

---

## `(ai)` Group — 14 routes

| URL | File |
|-----|------|
| `/ai` | `(ai)/ai/page.tsx` |
| `/ai/dashboard` | `(ai)/ai/dashboard/page.tsx` |
| `/ai/agents` | `(ai)/ai/agents/page.tsx` |
| `/ai/datasets` | `(ai)/ai/datasets/page.tsx` |
| `/ai/inference` | `(ai)/ai/inference/page.tsx` |
| `/ai/infrastructure` | `(ai)/ai/infrastructure/page.tsx` |
| `/ai/jobs` | `(ai)/ai/jobs/page.tsx` |
| `/ai/logs` | `(ai)/ai/logs/page.tsx` |
| `/ai/models` | `(ai)/ai/models/page.tsx` |
| `/ai/settings` | `(ai)/ai/settings/page.tsx` |
| `/ai/suggestions` | `(ai)/ai/suggestions/page.tsx` |
| `/ai/theme` | `(ai)/ai/theme/page.tsx` |
| `/ai/training` | `(ai)/ai/training/page.tsx` |

---

## Dynamic (Parameterized) Routes — 6

| Pattern | Parameter | Source |
|---------|-----------|--------|
| `/services/broker-terminal/profile/[terminalId]` | `terminalId` | broker identity |
| `/data-saver/alerts/[alertId]` | `alertId` | alert identity |
| `/data-saver/notifications/[notificationId]` | `notificationId` | notification identity |
| `/data-saver/insights/errors/[id]` | `id` | error group identity |
| `/data-saver/insights/reports/daily/[date]` | `date` | trading date |
| `/data-saver/insights/reports/[type]` | `type` | report type |
| `/data-saver/settings/[id]` | `id` | settings section |

> **Routing collision risk**: `/data-saver/insights/reports/daily/[date]` and `/data-saver/insights/reports/[type]` overlap. Next.js prefers the more specific static segment (`daily`), so `/reports/weekly` correctly resolves to `[type]`. NOT_VERIFIED at runtime.

---

## URL Path Duplication (Same URL, Multiple Implementations)

`DUPLICATE_OR_POSSIBLE_DUPLICATE` — the same URL is defined in multiple route groups:

| URL | Implementations |
|-----|-----------------|
| `/market-watch` | `(dashboard)`, `(trading)/trading/market-watch`, `services/market-watch` |
| `/orders` | `(dashboard)`, `_pages/orders` (not routable) |
| `/positions` | `(dashboard)`, `(trading)/trading/positions` |
| `/notifications` | `(dashboard)`, `(trading)/trading/notifications`, `(phase2)/data-saver/notifications` |
| `/settings` | `(dashboard)`, `(trading)/trading/settings`, `services/settings`, `data-saver/settings` |
| `/funds` | `(dashboard)`, `(trading)/trading/funds` |
| `/holdings` | `(dashboard)`, `(trading)/trading/holdings` |
| `/portfolio` | `(dashboard)`, `(trading)/trading/portfolio` |
| `/order-history` | `(dashboard)`, `(trading)/trading/order-history` |
| `/watchlist` | `(trading)/trading/watchlist`, `services/watchlist` |
| `/system` | `(dashboard)`, `services/system` |

**Impact**: Only one implementation is served per URL (Next.js build error on true collisions; these are distinct paths except where noted). The duplication is **intentional layering** in some cases (thin re-export/wrapper) and **unresolved divergence risk** in others. Requires per-file comparison.

---

## Non-Routable `_pages` Inventory (41 files, no URL)

`app/_pages/` — excluded from App Router:

```
_pages/audit-engine/       _pages/margin-engine/     _pages/orders/
_pages/broker-terminal/    _pages/market-watch/      _pages/order-history/
_pages/calculator/         _pages/notifications/     _pages/portfolio/
_pages/connection-manager/ _pages/order-engine/      _pages/positions/
_pages/dashboard/          _pages/risk-engine/       _pages/scheduler/
_pages/data-insights/      _pages/search/            _pages/session-manager/
_pages/data-quality/       _pages/settings/          _pages/squareoff/
_pages/data-server-settings/ _pages/stocks/          _pages/storage/
_pages/db-writer/          _pages/system/            _pages/system-indicators/
_pages/downloads/          _pages/target-engine/     _pages/watchlist/
_pages/downloads/formats/  _pages/websocket-engine/
_pages/downloads/schedules/new/
_pages/feature-engine/     _pages/funds/             _pages/holdings/
_pages/live-ticks/         _pages/logs/              _pages/audit-engine/
```

**ACTION REQUIRED**: Determine per file whether it is (a) imported by a routed page, (b) superseded, or (c) dead code.

---

## Route Inventory Summary

| Category | Page files | Routable? |
|----------|-----------|-----------|
| Root + login | 2 | Yes |
| `(dashboard)` | 14 | Yes |
| `(trading)` | 24 | Yes |
| `(services)` | 45 | Yes |
| `(phase2)` | 34 | Yes |
| `(ai)` | 14 | Yes |
| `app/_pages/` | 41 | **No (private folder)** |
| **Total** | **~174** | ~133 routable |

---

## Related Documents
- `FRONTEND_ARCHITECTURE.md` — Component/library structure
- `FRONTEND_DATA_FLOW.md` — Data and realtime flow
- `../api/API_CATALOG.md` — Backend endpoints consumed
- `../audits/DUPLICATE_AND_LEGACY_FINDINGS.md` — Duplication analysis
- `../PROJECT_GAPS.md` — Documentation gaps
