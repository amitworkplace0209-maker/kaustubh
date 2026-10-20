# Broker Terminal Engine — Implementation Report

**Layer:** Broker Terminal integration / terminal-state gateway (concept + adapter layer; NOT a registered registry engine)
**Date:** 2026-09-20
**Status:** Backend verified, Service Phase Overview + Terminals pages live.

---

## 1. Implementation overview

Broker Terminal Engine is the centralized broker-integration and terminal-state
layer for Kotak Neo, Shoonya and Dummy. The frontend MUST NOT fetch broker data
independently — all data flows through one backend surface: adapters
normalize/validate, produce the canonical state, then emit event/state updates
to Connection Manager (WS#2) and the UI.

Backend surface: `brokers/manager.py` (`TERMINALS`, `active_terminal`,
`get_adapter`, `switch_terminal`), `brokers/models.py` (`BrokerError`),
`api/trading_dashboard.py` `GET /api/trading/brokers/status` (per-terminal
enabled / isLoggedIn / sessionState / last-success / lastError),
`api/terminal.py` `GET /list`, `GET /state`, `POST /switch`.

---

## 2. Backend surface

| Endpoint | Source | Status |
|---|---|---|
| `GET /api/trading/brokers/status` | per-terminal operational status | LIVE |
| `GET /api/terminal/list` | terminal registry | LIVE |
| `GET /api/terminal/state` | active-terminal snapshot (no secrets) | LIVE |
| `POST /api/terminal/switch` | switch active terminal (mode-unlock) | LIVE |
| `GET /api/terminal/audit` | per-terminal audit trail | LIVE |

---

## 3. Frontend

- `app/_pages/broker-terminal/page.tsx` — Overview: active terminal + login
  badge, per-terminal status cards (enabled / login / session state / last
  success / last error), broker surface provenance note.
- `app/_pages/broker-terminal/terminals.tsx` — Terminals: terminal registry (or
  adapter list) + real audit trail rows from `GET /api/terminal/audit`.
- `app/(services)/services/broker-terminal/{,terminals}/page.tsx` — wrappers.
- `lib/api.ts` — `getBrokersStatus()`, `getTerminalList()`,
  `getTerminalState()`, `getTerminalAudit()`.
- `components/layout/nav.ts` — `broker-terminal` nav item with Overview +
  Terminals children.

---

## 4. Data integrity verdict

Every status field is real adapter/cache state; no broker value is fabricated.
Login badges reflect `adapter.is_logged_in`, session state the real session
snapshot, last-success/lastError the broker cache truth. Nothing is shown when
a terminal is unavailable — the pages render honest unavailable states.

---

## 5. Known limitations

- Broker Terminal is a concept/adapter layer, not a registered engine id; the
  page does not fake a control-plane snapshot.
- Terminal switching is available at `/api/terminal/switch`; the pages surface
  state but do not auto-switch (session/mode-unlock flows are kept in the
  dedicated login UX).