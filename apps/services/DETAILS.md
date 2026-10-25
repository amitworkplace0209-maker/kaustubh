# Services — Details

## Routes

| Route | Page source |
|-------|-------------|
| `/services` | redirect (see page) |
| `/services/system` | `_pages/system` |
| `/services/system-indicators` | `_pages/system-indicators` |
| `/services/logs` | real page (`app/(services)/services/logs`) |
| `/services/security` | real page (`app/(services)/services/security`) |
| `/services/notifications` | `_pages/notifications` |
| `/services/settings` | `_pages/settings` |

## Shell

- Config: `SERVICES_SHELL` in `components/layout/nav.ts`
- `wrapperClass: "ws-phase2"`, sessionMode `kotak-dialog`
- Layout: `SettingsBootstrap` → `SystemProvider` → `Shell workspace="services"`
- Status endpoints: `/api/phase2/websocket`, `/api/phase2/alerts`,
  `/api/phase2/system`
- Alerts route: `/services/notifications`

## Live observability

`SystemProvider` (`useSystem`) feeds `system`, `system-indicators`, `logs`, and
the shell's Kotak session badge from the real backend. Indicator badges are
red/green strictly from live probes — no fabricated "all green".

## Theme

Default Ocean + System (follows OS); user preference persisted at
`kaustubh-theme.services`. Note: `security` and `logs` inner pages currently
carry dark-only styling — a light-theme contrast pass is a tracked follow-up
(see `docs/KAUSTUBH_PROJECT_PLAN.md`).