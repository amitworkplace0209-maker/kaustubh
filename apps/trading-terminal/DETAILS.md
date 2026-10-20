# Trading Terminal — Details

## Routes

| Route | Page source |
|-------|-------------|
| `/trading` | redirect → `/trading/dashboard` |
| `/trading/dashboard` | `_pages/dashboard` |
| `/trading/orders` | `_pages/orders` |
| `/trading/positions` | `_pages/positions` |
| `/trading/holdings` | `_pages/holdings` |
| `/trading/portfolio` | `_pages/portfolio` |
| `/trading/funds` | `_pages/funds` |
| `/trading/order-history` | `_pages/order-history` |
| `/trading/calculator` | `_pages/calculator` |
| `/trading/market-watch` | `_pages/market-watch` |
| `/trading/notifications` | `_pages/notifications` |
| `/trading/settings` | `_pages/settings` |

All wrappers delegate to the canonical implementations under `app/_pages/`.

## Shell

- Config: `TRADING_SHELL` in `components/layout/nav.ts`
- `wrapperClass: "ws-phase2"`, sessionMode `kotak-dialog`
- Status endpoints: `/api/phase2/websocket`, `/api/phase2/alerts`,
  `/api/phase2/system`
- Alerts route: `/trading/notifications`

## Shared trading widgets

- `components/orders/order-entry.tsx` — order entry + charge estimate
- `components/orders/orders-sidebar.tsx` — trading-page navigation
  (settings → `/trading/settings`)
- `components/orders/notification-bell.tsx` — unread badge + dropdown
  (DOWNLOAD → `/data-saver/downloads`)
- `components/orders/history-view.tsx` — execution/fill history

## Theme

Default Saffron + Light; user preference persisted at `kaustubh-theme.trading`.
Account mode (Demo/LIVE) comes from `lib/settings-store.ts` and is shown in the
topbar. Trading terminal now supports three terminals (Kotak Neo / Shoonya /
Dummy) via `components/layout/sidebar-terminal-switcher.tsx` (the single
selector, under the "Trading Terminal" sidebar header — a plain context switch
with no password / Mode Lock prompt) backed by `lib/terminal-mode.ts` and the
backend `/api/terminal/*` surface.