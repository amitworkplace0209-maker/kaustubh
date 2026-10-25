# 032 — Local AI Bridge and Market Watch / Suggestions Integration

- **Date:** 2026-10-21
- **Agent:** OpenCode (DeepSeek V4.1 Flash Free)
- **Scope:** Khumbha AI phase (`/ai/*`), `khumbha-ai/` runtime, Market Watch symbol detail
- **Status:** VERIFIED_WITH_LIMITATIONS — connector, UI and API contract verified; real external-model execution remains pending on a device with Ollama/LM Studio/llama.cpp (see `docs/pending/PENDING-006-local-ai-real-model-and-browser-verification.md`)

---

## 1. Task

> “kumbh ai ko phase ko degine kro or asa ki uske pass loacl device ke ai model se
> connect kar ske mtlb proejct ka phase to vm pe hoga but jab mai loacal me aap
> download kru to loacle device se ai model use kr ske ye phase or suggetion or
> market watch sab connect hona chye”

The phase must stay served from the VM, but when the user runs the material on
their own device it must use an AI model from that device. Suggestions and
Market Watch must be part of the same flow.

## 2. Objective

1. Add a real, provider-agnostic connector for local model servers.
2. Keep inference, prompts and provider configuration off the VM.
3. Connect the connector to AI Suggestions and Market Watch without inventing
   prices or recommendations.
4. Make every empty/offline state honest.
5. Preserve the existing deterministic numpy runtime.

## 3. Constraints applied

- No fabricated market data. Missing values are `null`, never zero/estimated.
- AI output is explanatory only. No buy/sell/hold, targets, stop-losses or
  predictions; no order path.
- Local inference must stay on the user's device. The VM must not receive
  prompts or completions.
- Existing `khumbha-ai` runtime and its tests must keep working.
- No new Python dependency; the bridge uses the standard library for HTTP.
- No database/schema changes.

## 4. Architecture decision

A **loopback bridge** (`khumbha-ai/`) runs on the user's device. The VM-served
browser talks to it over `http://127.0.0.1:8001` (or a LAN address the user
chooses). The bridge speaks:

- native Ollama (`/api/tags`, `/api/chat`);
- any OpenAI-compatible server (`/v1/models`, `/v1/chat/completions`).

Defaults cover Ollama, LM Studio, llama.cpp server and a custom URL. Discovery,
model selection, analysis prompts and provider errors all live in the bridge,
so the browser stays provider-agnostic.

Full design: `docs/architecture/36_LOCAL_AI_BRIDGE_ARCHITECTURE.md`.

## 5. Bridge implementation

### 5.1 `khumbha-ai/local_ai.py` (new)

- `ProviderRegistry`: thread-safe config + 15-second probe cache.
- `default_config()` / `default_config_path()`: four providers, defaults,
  `AI_PROVIDER_CONFIG` override, atomic JSON writes.
- `normalize_base_url()`: only `http`/`https`, no credentials, length cap,
  metadata-host rejection.
- `normalize_models()`: one shape for Ollama and OpenAI model lists.
- `_http_json()`: timeouts, 2 MB response cap, best-effort sanitised errors,
  never raises at the network boundary.
- `probe()` / `snapshot()`: parallel real discovery, `probe=false` returns the
  last known real state without touching a provider.
- `_resolve()`: explicit provider/model → preferred → default → single
  discovered model; fails with the real list instead of guessing.
- `chat()`: native Ollama or OpenAI-compatible, non-streaming, temperature and
  token bounds, latency metadata.
- `build_analysis_messages()` + `SYSTEM_PROMPT`: grounded, advisory-only
  analysis contract.
- `analyze()`: adds `kind`, `groundedFields`, `contextChars`, `disclaimer`.

### 5.2 `khumbha-ai/main.py` (modified)

New routes:

| Method | Path |
|---|---|
| `GET` | `/api/ai/status` |
| `GET` | `/api/providers` and `/api/ai/providers` |
| `POST` | `/api/providers/{provider_id}/probe` |
| `PUT` | `/api/providers/{provider_id}` |
| `PUT` | `/api/ai/defaults` |
| `GET` | `/api/ai/models` |
| `POST` | `/api/ai/chat` |
| `POST` | `/api/ai/analyze` |

Also added:

- optional `AI_BRIDGE_TOKEN` gate (`X-Khumbha-AI-Token`), with `/health`,
  `/docs`, `/openapi.json` and `OPTIONS` still public;
- CORS origin list from `AI_CORS_ORIGINS`;
- `Access-Control-Allow-Private-Network: true` on every response;
- `localAi` summary in `/health` and `/api/dashboard`;
- consistent 400/404/502/504 error mapping.

### 5.3 Startup and config

- `khumbha-ai/run_ai.cmd`: documents `AI_CORS_ORIGINS`, `AI_BRIDGE_TOKEN`,
  `AI_HOST`, `AI_PORT`, `AI_PROVIDER_CONFIG`; binds `AI_HOST` (default
  `127.0.0.1`) instead of hardcoding loopback.
- `.gitignore`: ignores `khumbha-ai/local-ai.json` and `local-ai.tmp`.
- `khumbha-ai/requirements.txt`: unchanged (standard library HTTP only).

## 6. Frontend implementation

### 6.1 Per-device endpoint and token

`lib/ai-endpoint.ts` (new):

- `DEFAULT_AI_ENDPOINT = NEXT_PUBLIC_AI_API_BASE || http://127.0.0.1:8001`.
- localStorage keys `khumbha.ai.endpoint` and `khumbha.ai.token`.
- URL validation accepts HTTP(S), rejects credentials/malformed values.
- SSR falls back to the build default.

`lib/ai-api.ts` (modified):

- reads the endpoint and token per call;
- cache keys include the endpoint, so switching devices/ports cannot serve a
  response from another bridge.

### 6.2 Bridge client

`lib/local-ai.ts` (new):

- types for providers, models, defaults, snapshots, health and analysis;
- `bridgeFetch` with actionable errors for “bridge absent” and “bridge slow”;
- health, status, providers (probe/no-probe), probe, save provider, save
  defaults, models, chat and analyze helpers;
- `formatModelSize()` and `defaultModelLabel()`.

### 6.3 Context builders

`lib/ai-context.ts` (new, pure):

- `buildMarketWatchContext(detail)`: allowlisted `record`, `quote`, `circuit`,
  four `state` fields and three-level depth; missing values stay `null`.
- `buildMarketWatchBoardContext()`: at most 20 allowlisted rows.
- `buildSuggestionSeriesContext()`: finite numbers only, last 120 points,
  arithmetic summary, deterministic engine suggestion text.
- `contextFields()`: provenance chips for the panel.

### 6.4 Reusable analysis panel

`components/ai/local-ai-analysis.tsx` (new):

- manual only — never calls a model on mount;
- shows bridge state, active provider/model, engine-field count;
- refuses to run when no provider/model server is reachable;
- selects the default provider only when reachable, otherwise uses another
  enabled reachable provider and displays which one;
- renders provider/model, latency, context size, grounded field chips and the
  disclaimer;
- links to `/ai/settings` when configuration is missing.

### 6.5 Page integration

- `components/market-watch/market-watch-live.tsx`: added `SymbolAiRead` to
  symbol detail. It builds the Market Watch context in a child component so
  existing early returns stay hook-free.
- `app/(ai)/ai/suggestions/page.tsx`: rebuilt as two tabs:
  - **Series stats** — deterministic `/api/suggestions`, then an optional local
    model explanation of the same series and engine text.
  - **Market Watch** — loads `GET /api/market-watch/symbol/…`, shows the real
    engine snapshot, then offers the local model explanation.
- `app/(ai)/ai/settings/page.tsx`: bridge endpoint/token, provider cards with
  enable/URL/model/detect/save, analysis defaults, privacy/safety notes.
- `app/(ai)/ai/models/page.tsx`: provider-discovered models with “Use as
  default” (saves provider model + global defaults).
- `app/(ai)/ai/dashboard/page.tsx`: real provider counts/defaults and a
  configure link.

## 7. Data contract

Market Watch context sent to the model contains only engine-owned fields:

```json
{
  "source": "market_watch_engine",
  "asOf": "…",
  "symbol": "…",
  "token": "…",
  "tradingDate": "…",
  "feedState": "…",
  "state": { "status": "…", "dataAgeSec": 0, "intradayEligible": true, "priceSource": "…" },
  "record": { "ltp": 0, "changePercent": 0, "volume": 0, "…": "…" },
  "quote": { "…": "…" },
  "circuit": { "…": "…" },
  "depth": { "source": "…", "available": true, "buy": [], "sell": [] }
}
```

Rules:

- absent/non-finite → `null`, not `0`;
- unknown keys are dropped;
- depth is capped at three levels; boards at twenty rows; series at 120 points;
- serialised context must be ≤ 12,000 characters or the bridge returns `400`.

## 8. Safety

- `SYSTEM_PROMPT` forbids advice, targets, predictions and invented data.
- Context strings are labelled untrusted, so a symbol name cannot become a
  prompt injection.
- No order/broker tool exists in the bridge.
- Prompts/results are not logged or written to `local-ai.json`.
- Every analysis response carries `disclaimer`; the UI renders it.
- Provider failure is reported as failure; there is no cloud fallback.

## 9. Operations

Start on the device:

```bat
cd khumbha-ai
run_ai.cmd
```

VM-served page:

```bat
set AI_CORS_ORIGINS=https://your-vm.example
set AI_BRIDGE_TOKEN=change-me
run_ai.cmd
```

Then `/ai/settings` → endpoint/token → detect provider → save defaults.
`AI_HOST=0.0.0.0` is only for phone/LAN use and must be paired with a token.

## 10. Verification

See `docs/verification/040-local-ai-bridge-and-market-watch-integration.md`.

Summary:

- `python -m unittest -v test_local_ai`: **25/25 pass**.
- `node --test tests/local-ai-context.test.ts`: **9/9 pass**.
- Live HTTP script (mock OpenAI-compatible provider + real uvicorn):
  **38/38 checks pass** — discovery, save, defaults, analyze, prompt contents,
  CORS/PNA, token gate, persistence, honest unreachable state.
- `npm run typecheck`: pass.
- ESLint on all touched files: pass.
- Full `npm test`: 427 pass, 1 fail — pre-existing
  `tests/realtime-client.test.ts` cannot resolve `lib/api-base`.

## 11. Known limitations

- No real Ollama/LM Studio/llama.cpp process was available on this machine, so
  real-model output was not verified. The live test uses a real loopback server
  that implements the OpenAI-compatible protocol.
- Browser Private Network Access is browser/version dependent. The bridge sends
  the opt-in header, but the browser may still block or prompt.
- Non-streaming only. A long CPU-only generation can take a while; the client
  timeout is 185 seconds.
- The bridge token lives in localStorage and is therefore exposed to any script
  on the app origin, like other client-side state.
- LAN mode without `AI_BRIDGE_TOKEN` is unsafe; token is recommended.

## 12. Files

New:

- `khumbha-ai/local_ai.py`
- `khumbha-ai/test_local_ai.py`
- `khumbha-ai/verify_bridge_http.py`
- `lib/ai-endpoint.ts`
- `lib/local-ai.ts`
- `lib/ai-context.ts`
- `components/ai/local-ai-analysis.tsx`
- `tests/local-ai-context.test.ts`
- `docs/architecture/36_LOCAL_AI_BRIDGE_ARCHITECTURE.md`
- `docs/implementation/032-local-ai-bridge-and-market-watch-integration.md`
- `docs/verification/040-local-ai-bridge-and-market-watch-integration.md`
- `docs/pending/PENDING-006-local-ai-real-model-and-browser-verification.md`

Modified:

- `khumbha-ai/main.py`
- `khumbha-ai/run_ai.cmd`
- `lib/ai-api.ts`
- `components/market-watch/market-watch-live.tsx`
- `app/(ai)/ai/dashboard/page.tsx`
- `app/(ai)/ai/models/page.tsx`
- `app/(ai)/ai/settings/page.tsx`
- `app/(ai)/ai/suggestions/page.tsx`
- `.gitignore`
- `docs/architecture/00_ARCHITECTURE_INDEX.md`
- `docs/FEATURE_FLOW_MAP.md`
- `apps/khumbha-ai/README.md`
- `apps/khumbha-ai/DETAILS.md`

Unrelated working-tree change left untouched:

- `python-service/data/instrument_master.json`

## 13. Status

**Done:** connector, provider UI, Market Watch panel, Suggestions flow, tests,
live HTTP verification, documentation.

**Pending external verification:** run against a real Ollama/LM Studio model on
the target device. No code change is expected for that step; it exercises the
same protocol paths already covered by the mock provider.

**Final status:** `VERIFIED_WITH_LIMITATIONS`. Closing task:
`docs/pending/PENDING-006-local-ai-real-model-and-browser-verification.md`.
