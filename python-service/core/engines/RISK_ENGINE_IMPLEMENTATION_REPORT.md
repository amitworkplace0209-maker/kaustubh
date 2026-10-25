# Risk Engine — Implementation Report

**Engine ID:** `risk_engine` (decision service; NOT a registry engine — API-backed router)
**Date:** 2026-09-20
**Status:** Backend mounted + fixed, Service Phase Overview + Configuration pages live.

---

## 1. Implementation overview

Risk Engine is the configurable, explainable, multi-rule trading risk decision
layer. Every trading request (Manual / AI / Basket) must pass through it before
Order Engine execution. The backend lives in `api/risk_engine.py`
(prefix `/api/services/risk`).

**Historical bug (fixed in this phase):** the router was defined but **never
mounted** in `python-service/app.py` — a dead API surface. It is now included
(`from api.risk_engine import router as risk_engine_router`;
`app.include_router(risk_engine_router)`), and the broken PATCH re-fetch
(`router.routes[0].endpoint.__wrapped__()`) was replaced with
`return await get_config()`.

**Merged responsibility:** risk engine owns the position/P&L surface
(`position-engine.md` responsibilities: PositionFacade + `pnl_engine.py`) —
reflected on the page's "Positions (owned by Risk Engine)" panel.

---

## 2. Backend surface

| Endpoint | Source | Status |
|---|---|---|
| `GET /api/services/risk/config` | risk policy constants | LIVE (mounted) |
| `PATCH /api/services/risk/config` | runtime policy update | LIVE (mounted) |
| `POST /api/services/risk/validate` | real decision from active policy | LIVE (mounted) |

Decision payload (explainable): every applicable rule with actual value,
threshold, PASS/FAIL; final ALLOW / WARNING / BLOCK. Deterministic hard rules
are authoritative — AI is never the final safety authority.

---

## 3. Frontend

- `app/_pages/risk-engine/page.tsx` — Overview: policy summary, live decision
  sandbox (real `POST /api/services/risk/validate`), merged Position/P&L panel
  (real `/api/trading/positions` via consolidated dashboard).
- `app/_pages/risk-engine/configuration.tsx` — Configuration: editable
  thresholds + whitelist/blocked lists, saved via real `PATCH
  /api/services/risk/config` (backend-enforced, never mock).
- `app/(services)/services/risk-engine/{,configuration}/page.tsx` — wrappers.
- `lib/api.ts` — `getRiskConfig()`, `validateRiskOrder()`.
- `components/layout/nav.ts` — `risk-engine` nav item with Overview +
  Configuration children.

---

## 4. Data integrity verdict

No fabricated decisions. Every threshold/value on both pages is the real
runtime policy; the sandbox posts a real order intent and renders the real
decision + rule trace. Missing values render `—`. Positions/P&L come from the
real broker (honest envelopes when not logged in).

---

## 5. Known limitations

- Risk engine has no registry engine id — the page states "API-backed (not a
  registry engine)" rather than faking a control-plane snapshot.
- The decision trace is returned per-validate; no historical decision
  repository is exposed yet (audit_engine persists decisions — see Audit
  Engine report).