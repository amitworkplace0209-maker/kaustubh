# Services

Backend health, observability and security application — system status, logs,
notifications and security posture.

- Routes: `/services/*`
- Shell: `SERVICES_SHELL` (`components/layout/nav.ts`)
- Default theme: Ocean + System
- Session mode: `kotak-dialog`
- Layout wraps `SystemProvider` + `SettingsBootstrap` (live backend status).

## Features

- **System Status / System Indicators** — live backend probes (Python
  process, MongoDB, WebSocket, scheduler, session, broker).
- **Logs** — application log viewer (real backend logs).
- **Security** — security posture page.
- **Notifications / Settings** — system notifications and application settings.

## Status honesty

The shell's WebSocket / Database / Scheduler / Session badges are driven by the
live status endpoints. When the backend is unreachable the indicators go red
with `Not Connected` — never faked to green.

See `DETAILS.md` for route inventory.