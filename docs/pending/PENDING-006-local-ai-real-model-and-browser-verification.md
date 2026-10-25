# PENDING-006-local-ai-real-model-and-browser-verification.md

## Task ID

PENDING-006

## Date Created

2026-10-21

## Priority

**P2 — MEDIUM** (the connector is usable and contract-verified; this blocks a
`COMPLETE` verdict, not the feature itself)

## Title

Close real-model, real-browser and LAN verification for the device-local AI bridge

## Status

`PENDING`

## Source

- Architecture: `docs/architecture/36_LOCAL_AI_BRIDGE_ARCHITECTURE.md`
- Implementation: `docs/implementation/032-local-ai-bridge-and-market-watch-integration.md`
- Verification: `docs/verification/040-local-ai-bridge-and-market-watch-integration.md`

## Context

The loopback bridge, provider registry, analysis panel and the Market
Watch / Suggestions integrations are implemented. The full contract was verified
against a **real loopback mock provider**:

- 25/25 Python tests
- 9/9 TypeScript context tests
- 38/38 live HTTP checks
- `npm run typecheck` and ESLint pass

What could not be verified on this machine: **no real Ollama, LM Studio or
llama.cpp runtime was installed** and port `11434` was closed. No code defect was
found in the protocol path; the mock provider exercises the same request shapes.

## Open items

### 1. Real Ollama end to end — NOT_VERIFIED

1. Install/start Ollama and pull one model, e.g. `ollama pull llama3.2:3b`.
2. Start the bridge with `khumbha-ai\run_ai.cmd` (default `127.0.0.1:8001`).
3. Open `/ai/settings`, keep endpoint `http://127.0.0.1:8001`, probe Ollama.
4. Expected: Ollama card reports reachable, the pulled model appears in
   `/ai/models`, and defaults can be saved.
5. Open a Market Watch symbol, run **Analyze with local AI**, then run one
   Suggestions series analysis.
6. Expected: provider/model shown, grounding fields listed, latency reported,
   response has `What the data shows` / `Risk / uncertainty` / `Verify next`,
   and no buy/sell/hold, target, stop-loss or prediction.

Record: model name, prompt size, latency, and whether the answer stayed within
the contract.

### 2. Real OpenAI-compatible server — NOT_VERIFIED

Repeat item 1 with either:

- LM Studio local server (`http://127.0.0.1:1234/v1`), or
- llama.cpp server (`http://127.0.0.1:8080/v1`).

This proves the second protocol adapter with a real runtime, not only the mock.

### 3. Real browser and Private Network Access — NOT_VERIFIED

Open the VM-served app in a real browser and call the loopback bridge.

- Expected: probe/analyze succeed, or the browser explicitly blocks/prompts PNA.
- If blocked: document the exact browser/version and use LAN mode. **Do not**
  route inference through the VM as a workaround.
- In DevTools → Network, confirm provider URLs, prompts and completions are sent
  only to the bridge/LAN address, never to the VM origin.

### 4. LAN / phone mode with token — NOT_VERIFIED

1. Set `AI_HOST=0.0.0.0` and a strong `AI_BRIDGE_TOKEN`, then restart the bridge.
2. Set `AI_CORS_ORIGINS` to the deployed origin.
3. On a phone on the same LAN, set the endpoint to `http://<pc-lan-ip>:8001`
   and the same token in `/ai/settings`.
4. Expected: `401` without/with a wrong token; probe and analyze succeed with
   the correct token.
5. Close the bridge port on the router/firewall afterwards.

### 5. Model quality and latency — UNKNOWN

CPU-only generation can exceed the 185-second client timeout. Record whether the
chosen model completes, how long it takes, and whether a smaller model is needed.
This is a device-capacity observation, not a code defect.

### 6. Full-suite test failure — NOT_OWNED_HERE

`npm test` is 427/428 because `tests/realtime-client.test.ts` fails with
`ERR_MODULE_NOT_FOUND` only in the full suite. `lib/api-base.ts` exists and the
file passes **16/16** standalone (`npx tsx --test tests/realtime-client.test.ts`).
Unrelated to local AI; fix or record separately.

## Explicitly NOT pending (verified)

- Provider registry exposes four honest, disabled-by-default cards — **PASS**
- Real HTTP discovery and chat against a loopback OpenAI-compatible mock — **PASS**
- Saved provider/model is used, never guessed — **PASS**
- Whitelisted context, `null` preservation, 12,000-char cap — **PASS**
- Advisory-only prompt, grounding metadata and disclaimer — **PASS**
- Invalid kind / empty context rejected `400`; provider down `502` — **PASS**
- Token gate, CORS preflight and private-network header — **PASS**
- Config persisted without prompts/completions/market data — **PASS**
- Typecheck and ESLint on every touched file — **PASS**

## How to close

1. Run items 1–4 on a device with a real model runtime.
2. Append the observed results to
   `docs/verification/040-local-ai-bridge-and-market-watch-integration.md`
   (new sub-section under §4, and update §5).
3. Update the status line in
   `docs/implementation/032-local-ai-bridge-and-market-watch-integration.md`.
4. Mark this file `CLOSED` with the date and the verification evidence.

## Final status of the parent task

`VERIFIED_WITH_LIMITATIONS` until items 1–3 close.
