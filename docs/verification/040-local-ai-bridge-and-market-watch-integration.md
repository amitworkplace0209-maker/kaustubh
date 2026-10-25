# 040 — Local AI Bridge and Market Watch / Suggestions: Verification

- **Verification ID:** 040
- **Subject:** `docs/implementation/032-local-ai-bridge-and-market-watch-integration.md`
- **Architecture:** `docs/architecture/36_LOCAL_AI_BRIDGE_ARCHITECTURE.md`
- **Date:** 2026-10-21
- **Agent:** OpenCode (DeepSeek V4.1 Flash Free)
- **Final Result:** **PASS** for the connector, API and integration contract.
  **LIMITED** for real external-model execution: no Ollama/LM Studio/llama.cpp
  was installed on this machine, so a real loopback mock provider was used.

---

## 1. Environment

| Item | Value |
|---|---|
| OS | Windows |
| Python | 3.12.10 |
| FastAPI | 0.115.0 |
| uvicorn | 0.30.6 |
| Node | v24.18.0 |
| Bridge test port | `127.0.0.1:18992` |
| Mock provider port | `127.0.0.1:18991` |
| Real Ollama port | `127.0.0.1:11434` — **closed / not installed** |
| Real LM Studio port | `127.0.0.1:1234` — **not installed** |

## 2. What was verified

1. The bridge starts as a real uvicorn process and serves health/status.
2. The registry exposes all four providers with honest defaults.
3. An OpenAI-compatible provider can be saved, probed and discovered.
4. Analysis uses the saved provider/model, not a guessed one.
5. The prompt carries the guardrails and the whitelisted context.
6. The response carries grounding metadata and the disclaimer.
7. Invalid kinds and empty contexts are rejected.
8. CORS preflight allows the VM origin, the token header and private network.
9. `AI_BRIDGE_TOKEN` rejects missing/wrong tokens and accepts the right one.
10. An unreachable provider stays unreachable; no fallback output.
11. Provider config is persisted without prompts/context.
12. The frontend/context unit tests pass.
13. TypeScript and ESLint pass on every touched file.

## 3. Method

### 3.1 Python tests

```bat
cd khumbha-ai
C:\project\.venv\Scripts\python.exe -m unittest -v test_local_ai
```

The suite includes a real `ThreadingHTTPServer` on loopback that implements
`GET /v1/models` and `POST /v1/chat/completions`. It also imports the actual
FastAPI app for route tests (health, providers, status, analyze, CORS).

### 3.2 TypeScript tests

```bat
node --test tests/local-ai-context.test.ts
```

Covers the allowlist, non-finite numbers, null preservation, board cap, series
arithmetic/truncation, provenance chips and endpoint validation.

### 3.3 Live HTTP script

`khumbha-ai/verify_bridge_http.py` (re-runnable) started:

1. the mock OpenAI-compatible provider on a free loopback port;
2. the real bridge via
   `python -m uvicorn main:app --host 127.0.0.1 --port <free>` with a temporary
   `AI_PROVIDER_CONFIG`, `AI_CORS_ORIGINS=https://khumbha.example.com`, and no
   token;
3. then the same bridge with `AI_BRIDGE_TOKEN=verify-secret-token`;
4. then a fresh config with an unreachable provider.

It called the routes with `urllib` exactly as a browser would and asserted the
status, JSON and headers.

```bat
cd khumbha-ai
C:\project\.venv\Scripts\python.exe verify_bridge_http.py
```

## 4. Results

### 4.1 Python suite — PASS

```
Ran 25 tests in 1.377s
OK
```

Coverage: URL validation (loopback/LAN accepted; metadata host, credentials,
non-HTTP rejected), model normalisation (Ollama/OpenAI/empty), prompt guardrails
and size limit, message validation, config persistence/defaults, probe
discovery, unreachable provider, stale-cache refresh, disabled-provider summary,
chat, analyze grounding, health/status/providers/analyze routes, CORS
preflight.

### 4.2 TypeScript context suite — PASS

```
tests 9
pass 9
fail 0
```

### 4.3 Live HTTP — PASS (38/38)

Phase 1 — discovery, analysis, CORS:

```
GET  /health                              200  bridge=true  version=1.1.0
GET  /api/providers?probe=false           200  ollama,lmstudio,llamacpp,custom
PUT  /api/providers/custom                200  enabled=true reachable=true
GET  /api/ai/models                       200  [("custom","mock-verify-model")]
PUT  /api/ai/defaults                     200  provider=custom model=mock-verify-model
POST /api/ai/analyze                     200  provider=custom model=mock-verify-model
                                               groundedFields=6 contextChars=117
OPTIONS /api/ai/analyze                   200  allow-origin=https://khumbha.example.com
                                               allow-headers=content-type,x-khumbha-ai-token
                                               allow-private-network=true
```

Prompt observed by the mock provider:

```
stream=false
model=mock-verify-model
messages[0] contains "NOT a financial adviser"
messages[0] contains "Use ONLY the JSON context"
messages[1] contains "\"last\": 2941.5"
messages[1] contains "untrusted values"
```

Negative checks:

```
POST /api/ai/analyze  kind=not_a_kind        400
POST /api/ai/analyze  context={}             400
```

Persistence checks:

```
local-ai.json contains the saved provider URL        PASS
local-ai.json does not contain the system prompt     PASS
local-ai.json does not contain "RELIANCE"            PASS
```

Phase 2 — token gate:

```
GET  /health                          (no token)  200  public
GET  /api/ai/status                   (no token)  401
GET  /api/ai/status                   (wrong)     401
GET  /api/ai/status                   (correct)   200  summary.bridge=true
POST /api/ai/analyze                  (correct)   200  kind=suggestion_series
```

Phase 3 — honest failure:

```
PUT  /api/providers/custom  url=127.0.0.1:9/v1
     -> 200, reachable=false, error="[WinError 10061] … refused"

POST /api/ai/analyze (default=custom, provider down)
     -> 502, detail="local provider 'custom' failed: …"
```

### 4.4 Frontend checks — PASS

```bat
npm run typecheck
> tsc --noEmit
exit 0
```

```bat
npx eslint <all touched TS/TSX files>
exit 0, no output
```

Touched files linted: the four `/ai` pages, `market-watch-live.tsx`,
`local-ai-analysis.tsx`, `ai-api.ts`, `ai-endpoint.ts`, `local-ai.ts`,
`ai-context.ts`, `tests/local-ai-context.test.ts`.

### 4.5 Full suite — 427 pass / 1 pre-existing failure

```
tests 428
pass 427
fail 1
```

Failure:

```
tests/realtime-client.test.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\project\lib\api-base'
imported from C:\project\lib\realtime-ws.ts
```

This is unrelated to the local-AI work and is a full-suite-only
resolution/ordering problem, not a missing file: `lib/api-base.ts` exists, and
`npx tsx --test tests/realtime-client.test.ts` passes **16/16** when run
standalone. The failure reproduces only when the full suite loads
`tests/realtime-client.test.ts` alongside the other files. It was already
failing before this task.

### 4.6 Re-run confirmation — 2026-10-21

The full verification set was re-run after the final edits:

| Command | Result |
|---|---|
| `python -m unittest -v test_local_ai` | 25/25 pass |
| `npx tsx --test tests/local-ai-context.test.ts` | 9/9 pass |
| `python verify_bridge_http.py` | 38/38 checks pass |
| `npm run typecheck` | pass |
| `npx eslint <touched files>` | pass, no output |
| `npm test` | 427/428 pass |
| `npx tsx --test tests/realtime-client.test.ts` | 16/16 pass |

## 5. What was not verified

- **Real model output.** No Ollama/LM Studio/llama.cpp runtime is installed on
  this machine. The mock provider proves the protocol, discovery, prompt and
  error handling, but not the quality/latency of a specific model.
- **A real browser session against a real provider.** The UI was typechecked and
  linted; the HTTP contract it calls was exercised directly. Browser Private
  Network Access behaviour remains browser/version dependent.
- **Phone/LAN mode.** `AI_HOST=0.0.0.0` and a LAN endpoint were not exercised;
  the code path is the same server, with a different bind address.

Tracked in
`docs/pending/PENDING-006-local-ai-real-model-and-browser-verification.md`.

## 6. Honesty checks

- No price, percentage, volume or model answer was generated by the test script.
  The mock content is clearly synthetic; production responses come from a real
  provider or the request fails.
- An unreachable provider returns `502`; it never falls back to another output.
- Missing context fields survive as `null` and are described as unavailable.
- `local-ai.json` contains configuration only — no prompts, completions or
  market data.

## 7. Verdict

**Connector and integration contract: PASS.**

**Real-device model execution: PENDING** — requires a machine with Ollama, LM
Studio or llama.cpp running. No code defect was found in the protocol path; the
mock provider exercises the same Ollama/OpenAI request shapes.

**Final status: `VERIFIED_WITH_LIMITATIONS`.** Closing task:
`docs/pending/PENDING-006-local-ai-real-model-and-browser-verification.md`.

Re-run:

```bat
cd khumbha-ai
C:\project\.venv\Scripts\python.exe -m unittest -v test_local_ai
C:\project\.venv\Scripts\python.exe verify_bridge_http.py
cd ..
npx tsx --test tests/local-ai-context.test.ts
npm run typecheck
```
