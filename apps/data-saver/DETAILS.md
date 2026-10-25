# Data Saver — Details

## Routes

| Route | Notes |
|-------|-------|
| `/data-saver` | redirect → `/data-saver/dashboard` |
| `/data-saver/dashboard` | Live status + summary |
| `/data-saver/subscription` | Stock subscription management |
| `/data-saver/ticks` | Live tick table (real WebSocket stream) |
| `/data-saver/watch` | Market watch |
| `/data-saver/data-center` | Jobs/data pipeline (`dc-schedules`) |
| `/data-saver/formats` | Export formats |
| `/data-saver/schedules` | Scheduled downloads |
| `/data-saver/schedules/new` | Create/edit schedule (delegates to `_pages/downloads/schedules/new`) |
| `/data-saver/downloads` | Custom range downloads |
| `/data-saver/download-history` | Download history |
| `/data-saver/quality` | Data quality |
| `/data-saver/analytics` | Tick analytics |
| `/data-saver/insights` | Data insights |
| `/data-saver/configuration` | Configuration settings |
| `/data-saver/alerts` | Alert rules |
| `/data-saver/websocket` | WebSocket diagnostics |

## Shell

- Config: `DATA_SAVER_SHELL` in `components/layout/nav.ts`
- `wrapperClass: "ws-phase2"`, sessionMode `phase2-toggle`
  (POST `/api/phase2/login` / `/api/phase2/logout`)
- Status endpoints: `/api/phase2/websocket`, `/api/phase2/alerts`,
  `/api/phase2/system`
- Alerts route: `/data-saver/alerts`
- Navigation built from `lib/phase2-nav.ts`

## Why this is the master reference

Data Saver is the most complete visual implementation of the unified shell,
theme tokens, card/status patterns, and the real-data UI language
(`Loading` / `Not Connected` / `Stale`). All other applications mirror its
structure; only theme tokens change per application.

## Theme

Default Saffron + Light; user preference persisted at `kaustubh-theme.data-saver`.
Legacy single-key preference (`phase2_theme_state`) is migrated into this app
once.