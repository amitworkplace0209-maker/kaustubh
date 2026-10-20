# Khumbha AI

Local AI engine application — models, datasets, training, inference, agents
and infrastructure.

- Routes: `/ai/*`
- Shell: `KHUMBHA_AI_SHELL` (`components/layout/nav.ts`)
- Default theme: Purple + Dark
- Session mode: `none`

## Features

- **Dashboard** — AI engine overview.
- **Models / Datasets** — model catalog and dataset management.
- **Training / Inference** — training runs and inference endpoints
  (via `lib/ai-api`).
- **Agents / Suggestions** — agent management and AI suggestions
  (shared polling via `useSharedPolling`).
- **Infrastructure / Jobs / Logs** — runtime infrastructure, job history,
  engine logs.
- **Settings** — AI engine settings.

## Data rules

Inference and system numbers come from the real `lib/ai-api` client. Anything
unavailable is rendered as Loading / Not Connected / No Data Available rather
than fabricated.

See `DETAILS.md` for route inventory.