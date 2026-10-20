# Data Saver

Market data collection and management application — stock subscriptions, live
ticks, scheduled downloads, analytics and quality monitoring.

- Routes: `/data-saver/*` (`/data-saver` redirects to `/data-saver/dashboard`)
- Shell: `DATA_SAVER_SHELL` (`components/layout/nav.ts`)
- Default theme: Saffron + Light
- Session mode: `phase2-toggle` (`/api/phase2/login` `/api/phase2/logout`)
- **Master UI reference** for visual consistency across the four applications.

## Features

- **Dashboard / Subscription** — live status + stock subscription management.
- **Live Tick Table / Market Watch** — real-time tick streaming over the
  shared WebSocket, no dummy rows.
- **Data Center / Formats / Schedules** — data pipeline, export formats,
  scheduled downloads (create/edit at `/data-saver/schedules/new`).
- **Downloads / Download History** — custom range exports and history.
- **Quality / Analytics / Insights** — data quality, tick analytics,
  data insights.
- **Configuration / Alerts / WebSocket** — settings, alert rules, websocket
  diagnostics.

## Backend contract

Endpoints probed by the shell: `/api/phase2/websocket`,
`/api/phase2/alerts`, `/api/phase2/system`. Live ticks stream from the single
backend websocket via `ws_manager`.

See `DETAILS.md` for the route/manifest inventory.