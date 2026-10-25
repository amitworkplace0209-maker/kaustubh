# Khumbha AI

Local AI engine application — models, datasets, training, inference, agents
and infrastructure.

- Routes: `/ai/*`
- Shell: `KHUMBHA_AI_SHELL` (`components/layout/nav.ts`)
- Default theme: Purple + Dark
- Session mode: `none`

## Features

- **Dashboard** — AI engine overview, including live local-provider counts.
- **Models / Datasets** — model catalog and dataset management.
- **Training / Inference** — training runs and inference endpoints
  (via `lib/ai-api`).
- **Agents / Suggestions** — agent management and AI suggestions
  (shared polling via `useSharedPolling`). Suggestions can explain a real
  series or a real Market Watch symbol with the model on this device.
- **Infrastructure / Jobs / Logs** — runtime infrastructure, job history,
  engine logs.
- **Settings** — bridge endpoint/token, Ollama / LM Studio / llama.cpp /
  custom provider configuration, and analysis defaults.

## Local AI model bridge

The AI phase is served by the VM, but inference runs on the device in
`khumbha-ai/` (default `http://127.0.0.1:8001`). The browser talks to that
loopback bridge; the VM never receives prompts, completions, provider URLs or
the bridge token.

- Providers: Ollama (native API), LM Studio, llama.cpp server, any
  OpenAI-compatible URL.
- Endpoint and optional token are stored per device in localStorage.
- Provider URLs/models/defaults are stored in `khumbha-ai/local-ai.json`
  (gitignored).
- Market Watch symbol detail and `/ai/suggestions` share the same manual
  “Analyze with local AI” panel.
- The model is advisory only: no orders, no targets, no predictions, no cloud
  fallback.

Setup: start `khumbha-ai/run_ai.cmd`, then open `/ai/settings` and detect the
provider. For a VM-served page, add the VM origin to `AI_CORS_ORIGINS` and set
`AI_BRIDGE_TOKEN` if the bridge is exposed beyond loopback.

Verification: 25/25 Python tests, 9/9 context tests and 38/38 live HTTP checks
against a real loopback mock provider. Execution against a real
Ollama/LM Studio/llama.cpp model is still pending — see
`docs/pending/PENDING-006-local-ai-real-model-and-browser-verification.md`.

See `docs/architecture/36_LOCAL_AI_BRIDGE_ARCHITECTURE.md` for the full design.

## Data rules

Inference and system numbers come from the real `lib/ai-api` client. Anything
unavailable is rendered as Loading / Not Connected / No Data Available rather
than fabricated. Model analysis returns only what the local provider actually
produced; an offline provider is shown as offline.

See `DETAILS.md` for route inventory.