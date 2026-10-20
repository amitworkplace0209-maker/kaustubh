# SCHEDULER_AND_LIFECYCLE.md

## KAUSTUBH Trading Platform - Scheduler & Runtime Lifecycle

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Canonical Source**: `docs/engines/scheduler-engine.md`
**Verification**: Times from `config/settings.py` defaults and docs. **Actual firing NOT_VERIFIED** (requires a market session).

---

## Purpose

The Scheduler Engine (`facade`, auto-start) orchestrates the entire trading day. It is the only component permitted to trigger session-wide lifecycle transitions.

---

## Daily Timeline (IST, Configurable)

| Time | Event | Owner | Config Vars |
|------|-------|-------|-------------|
| **08:50** | Login trigger | Scheduler → Session Manager | `login_hour`, `login_minute` |
| **08:55** | WebSocket start | Scheduler → Connection Manager → WebSocket Engine | `ws_start_hour`, `ws_start_minute` |
| **08:55–09:00** | Readiness check | Scheduler verifies all engines | — |
| *(optional)* | Tick collection start | db_writer_engine | `tick_collection_hour`, `tick_collection_minute` |
| **09:00–09:05** | Pre-market phase | market_coach, watchlist_engine, feature_engine | `pre_market_hour`, `pre_market_minute` |
| **09:05–09:10** | Limit order window | order_engine phase check | `limit_order_hour`, `limit_order_minute` |
| **09:10–09:12** | Equilibrium | Phase transition event | `equilibrium_hour`, `equilibrium_minute` |
| **09:12–09:15** | Buffer | Controlled transition | `buffer_hour`, `buffer_minute` |
| **09:15** | Live feed start | WebSocket Engine → Feature Engine → all | `feed_start_hour`, `feed_start_minute` |
| **09:15–15:16** | Live trading | All engines active | — |
| **15:16** | Square-off trigger | Scheduler → squareoff_engine → order_engine | `square_off_hour`, `square_off_minute` |
| **15:30** | Feed stop | Scheduler → Connection Manager (unsubscribe) | `feed_stop_hour`, `feed_stop_minute` |
| **15:31** | WebSocket close | Scheduler → WebSocket Engine | `ws_stop_hour`, `ws_stop_minute` |
| **16:00** | Logout | Scheduler → Session Manager | `logout_hour`, `logout_minute` |

**Master switch**: `square_off_enabled` (bool) — **HIGH RISK** if false during a live session.

---

## Phases

| Phase | Window | Purpose | Engines Active |
|-------|--------|---------|----------------|
| `PRE_MARKET` | 09:00–09:05 | Build universe, compute rankings, prepare signals | market_coach, watchlist_engine, feature_engine |
| `LIMIT_ORDER` | 09:05–09:10 | Accept limit orders only | order_engine (limit only) |
| `EQUILIBRIUM` | 09:10–09:12 | Transition/settle | all preparing |
| `BUFFER` | 09:12–09:15 | Final buffer before live | all |
| `LIVE` | 09:15–15:16 | Full trading | all |
| `SQUAREOFF` | 15:16 | Close all positions | squareoff_engine, order_engine |
| `FEED_STOP` | 15:30 | Stop market data | connection_manager |
| `POST` | 15:31–16:00 | Wrap up, flush buffers | db_writer_engine |
| `CLOSED` | 16:00+ | Logout, idle | minimal |

Phase names are `INFERRED` from documentation. Exact enum values `NOT_VERIFIED` — read `scheduler/__init__.py`.

---

## Startup Order (from `app.py` lifespan)

```
1. MongoDB connect
2. Runtime settings refresh
3. Notification center init
4. Dummy adapter auto-ready
5. Tick buffer start
6. Export worker start
7. Downloads checker start
8. Scheduler start
9. WebSocket Engine wiring
10. Order Feed Manager start (WS#2)
11. WS Manager start (WS#1)
12. Session Manager hydrate
13. Engine Registry registration
14. Connection Engine start
15. Instrument cache preload
```

**Order matters**: persistence before engines, brokers before subscription orchestration, orchestration before distribution.

**UNVERIFIED**: This ordering was inferred from the sequence of calls observed in `app.py`. Confirm by reading the full lifespan block.

---

## Process Guard

`runtime/singleton.py` uses `psutil` to detect an existing backend process and prevent duplicate instances.

**Why**: Two backends would double-subscribe to broker feeds and double-write to MongoDB.

**Status**: Existence confirmed. Lock mechanism details `NOT_VERIFIED`.

---

## Scheduler API

```
GET  /api/scheduler/status        current phase and state
GET  /api/scheduler/readiness     engine readiness for next phase
GET  /api/scheduler/summary       scheduler summary
GET  /api/scheduler/history       phase transition history
GET  /api/scheduler/runs          run records
GET  /api/scheduler/runs/{run_id} single run detail
GET  /api/schedule-events/health  schedule-events service health
GET  /api/schedule-events/stream  SSE stream of schedule events
```

---

## Frontend Scheduler UI

| Route | Purpose |
|-------|---------|
| `/services/scheduler` | Main scheduler console |
| `/services/scheduler/timeline` | Phase timeline visualization |
| `/services/scheduler/lifecycle` | Lifecycle detail |
| `/services/scheduler/ledger` | Event ledger (audit of transitions) |
| `/services/scheduler/runs` | Historical runs |

---

## Trading Day Boundaries

| Concept | Behavior |
|---------|----------|
| Trading date | IST calendar day; broker holidays excluded (`/api/dummy/calendar`, `/api/dummy/calendar-events`) |
| Weekend/holiday | Scheduler should not trigger; **behavior NOT_VERIFIED** |
| Missed phase (sleep/restart) | **UNKNOWN** — no catch-up mechanism documented |
| Overnight session | Not supported (logout at 16:00) |

**CRITICAL RISK**: If the machine sleeps or the process restarts between 08:50 and 09:15, the scheduler may skip login/WS start. There is no documented catch-up. Manual intervention via `/api/auth/manual-login` and `/api/services/websocket/connect` would be required.

---

## Scheduler Failure Modes

| Failure | Impact | Detection | Recovery |
|---------|--------|-----------|----------|
| Missed login (08:50) | No broker session | `/api/scheduler/status` | Manual login |
| Missed WS start (08:55) | No market data | `/api/services/websocket/health` | Manual connect |
| Clock drift | Wrong phase | Ledger timestamps | NTP |
| Square-off skipped (15:16) | **Positions left open** | Position check after 15:20 | Manual square-off |
| Logout skipped (16:00) | Session left open | `/api/phase3/session-manager/status` | Manual logout |
| Process crash | Full lifecycle lost | `/health` 503 | Restart + manual catch-up |

---

## Related Documents
- `../engines/scheduler-engine.md` — Canonical scheduler spec
- `../config/CONFIGURATION_CATALOG.md` — All scheduler time vars
- `../architecture/FAILURE_AND_RECOVERY.md` — Recovery paths
- `../api/API_CATALOG.md` — Scheduler endpoints
- `../PROJECT_RISKS.md` — R-25, R-26
