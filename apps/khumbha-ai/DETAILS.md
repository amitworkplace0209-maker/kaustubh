# Khumbha AI — Details

## Routes

| Route | Notes |
|-------|-------|
| `/ai` | redirect (see page) |
| `/ai/dashboard` | AI engine overview |
| `/ai/models` | Model catalog |
| `/ai/datasets` | Datasets |
| `/ai/training` | Training runs |
| `/ai/inference` | Inference endpoints |
| `/ai/agents` | Agent management |
| `/ai/suggestions` | AI suggestions |
| `/ai/infrastructure` | Runtime infrastructure |
| `/ai/jobs` | Job history |
| `/ai/logs` | Engine logs |
| `/ai/settings` | AI settings |

All pages are real implementations consuming `lib/ai-api`
(`useSharedPolling` from `lib/shared-request.ts`).

## Shell

- Config: `KHUMBHA_AI_SHELL` in `components/layout/nav.ts`
- `wrapperClass: "ws-phase2"`, sessionMode `none` (no session controls)
- Status endpoints: `/api/phase2/websocket`, `/api/phase2/alerts`,
  `/api/phase2/system`
- Alerts route: `/ai/settings`

## Theme

Default Purple + Dark; user preference persisted at `kaustubh-theme.khumbha-ai`.

## Data rules

Model/agent/inference data comes from the AI API. Unavailable resources render
`Loading` / `Not Connected` / `No Data Available` — never fabricated.