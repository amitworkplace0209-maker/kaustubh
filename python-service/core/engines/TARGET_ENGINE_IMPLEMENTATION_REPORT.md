# Target Engine — Implementation Report

**Engine ID:** `target_engine` (NO registry engine id — backend surface is Dummy-scoped)
**Date:** 2026-09-20
**Status:** Backend verified, Service Phase Overview page live.

---

## 1. Implementation overview

Target Engine provides price-target alerts/triggers. The current real backend
surface is Dummy-mode: `api/dummy.py` `GET /api/dummy/targets` + targets CRUD,
and `api/terminal.py` `POST/DELETE /api/terminal/target`. There is no registered
registry engine `target_engine`, so the page states its scope honestly
("Dummy-mode target alerts (no registry engine)") rather than faking a
control-plane snapshot.

**Doc note:** `docs/engines/target-engine.md` does not exist (inventory class F).
The page only implements the real API surface available.

---

## 2. Backend surface

| Endpoint | Source | Status |
|---|---|---|
| `GET /api/dummy/targets` | dummy engine target store | LIVE |
| `POST /api/terminal/target` | arm a target on terminal | LIVE |
| `DELETE /api/terminal/target/{symbol}` | remove a target | LIVE |
| `GET /api/dummy/targets` (global) | market + targets bundle | LIVE |

---

## 3. Frontend

- `app/_pages/target-engine/page.tsx` — Overview: arm-target form (symbol /
  type / value / direction / auto-execute) + armed-targets list with status
  (ACTIVE / TRIGGERED / CANCELLED) and per-row delete. Create/delete call the
  real endpoints.
- `app/(services)/services/target-engine/page.tsx` — wrapper.
- `lib/api.ts` — `getTargets()`, `placeTarget()`, `deleteTarget()`.
- `components/layout/nav.ts` — `target-engine` nav item (flat Overview).

---

## 4. Data integrity verdict

All targets are real rows from the dummy engine store; statuses are the actual
`status` field. Honest empty state ("No targets armed"). No fabricated control
plane.

---

## 5. Known limitations

- No design doc exists for this engine (inventory class F) and no registry
  engine id is registered — out of the gates scope unless a doc + engine appear.
- Executed/triggered timestamps render from the record; they may be null until
  the dummy engine fires the target.