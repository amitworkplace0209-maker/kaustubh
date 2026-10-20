# Audit Engine — Implementation Report

**Engine ID:** `audit_engine` (registered registry engine)
**Date:** 2026-09-20
**Status:** Backend verified, Service Phase Overview page live.

---

## 1. Implementation overview

Audit Engine is the append-only, immutable, timestamped, source-attributed,
correlation-aware decision + activity trail. It records trading, risk, broker,
configuration, security and operational events (What / When / Who / Which
engine / What decision / Why / State at time / Policy version / Terminal /
before-after).

The backend lives in `core/engines/audit_engine.py`: `record_decision()` (kind
`decision`, accepted flag + risk_reasons), `record_action()` (kind `action`,
status + broker_stat), ring buffer + `_persist()` to MongoDB
(`db.audit_trail`), and `recent_from_db(terminal, limit)` for queryable history.

---

## 2. Backend surface

| Endpoint | Source | Status |
|---|---|---|
| `GET /api/services/engines/audit_engine` | registry engine | LIVE |
| `GET /api/terminal/audit?limit` | `recent_from_db` (durable Mongo) | LIVE |

---

## 3. Frontend

- `app/_pages/audit-engine/page.tsx` — Overview: engine snapshot (state/health/
  heartbeat), ring stats, immutability guarantees, and the real audit trail
  from `GET /api/terminal/audit` with a limit selector (25/50/100/200) and
  kind-toned badges (decision / action / system / security / config / error).
- `app/(services)/services/audit-engine/page.tsx` — wrapper.
- `lib/api.ts` — `getTerminalAudit()`.
- `components/layout/nav.ts` — `audit-engine` nav item in the Security group.

---

## 4. Data integrity verdict

Every row is a real persisted audit document; no events are fabricated. Honest
empty state ("No audit entries yet"). The append-only/immutable guarantees are
asserted as engine properties, not emulated by the UI.

---

## 5. Known limitations

- The trail is read through the terminal gateway (`/api/terminal/audit`), which
  requires an active terminal; when none is active the endpoint returns its
  honest error and the page renders it.
- Historical version-based queries (whole policy-version trail) are not
  exposed; the durable `audit_trail` collection holds all decisions/actions.