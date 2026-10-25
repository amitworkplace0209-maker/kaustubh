# Khumbha AI — Details

## Routes

| Route | Notes |
|-------|-------|
| `/ai` | redirect (see page) |
| `/ai/dashboard` | AI engine overview |
| `/ai/models` | Model catalog + provider-discovered local models and default selection |
| `/ai/datasets` | Datasets |
| `/ai/training` | Training runs |
| `/ai/inference` | Inference endpoints |
| `/ai/agents` | Agent management |
| `/ai/suggestions` | Deterministic series stats + Market Watch symbol analysis with the local model |
| `/ai/infrastructure` | Runtime infrastructure |
| `/ai/jobs` | Job history |
| `/ai/logs` | Engine logs |
| `/ai/settings` | Bridge endpoint/token, providers, analysis defaults |

All pages are real implementations consuming `lib/ai-api`
(`useSharedPolling` from `lib/shared-request.ts`).

## Local AI bridge

The runtime in `khumbha-ai/` also exposes a device-local provider bridge:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/ai/status` | Cached provider snapshot + summary |
| `GET` | `/api/providers?probe=true\|false` | Provider registry + discovery |
| `POST` | `/api/providers/{id}/probe` | Force one provider probe |
| `PUT` | `/api/providers/{id}` | Save provider URL/enabled/model |
| `PUT` | `/api/ai/defaults` | Default provider/model/temperature/tokens |
| `GET` | `/api/ai/models` | Flat model list across reachable providers |
| `POST` | `/api/ai/chat` | Validated chat completion |
| `POST` | `/api/ai/analyze` | Grounded, advisory-only analysis |

Provider defaults: Ollama `127.0.0.1:11434`, LM Studio `127.0.0.1:1234/v1`,
llama.cpp `127.0.0.1:8080/v1`, custom disabled. Config is written to
`khumbha-ai/local-ai.json` (gitignored).

The browser stores the bridge endpoint and optional token per device:
`khumbha.ai.endpoint` and `khumbha.ai.token` in localStorage.

Environment:

- `AI_CORS_ORIGINS` — include the deployed VM origin.
- `AI_BRIDGE_TOKEN` — require `X-Khumbha-AI-Token` on API routes.
- `AI_HOST` — `127.0.0.1` by default; `0.0.0.0` only for phone/LAN.
- `AI_PORT` — bridge port, default `8001`.
- `AI_PROVIDER_CONFIG` — override the local JSON path.

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

Local-model analysis is returned only from the provider on this device. The
panel shows the actual provider/model and latency; an unreachable bridge,
provider or model is reported as such. Analysis is explanatory only and carries
a disclaimer — no order action exists.