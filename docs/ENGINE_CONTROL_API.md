# ENGINE_CONTROL_API.md

## The real replacement for the fictional `python -m kaushub.*` CLI

**Created**: 2026-09-28
**Source**: `python-service\api\engine_control.py` (211 lines), read in full
**Purpose**: the architecture documents tell operators to run `python -m kaushub.engine …`
commands that do not exist (finding **D-13**). This file records what actually exists.

**Security warning first**: this router has **no authentication** and the backend binds
`0.0.0.0`. Read `docs/security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` before using
any endpoint on a non-loopback interface.

---

## 1. What actually exists

### Backend process control — `python-service\start_backend.py`
A real CLI *does* exist, just not under the name the docs use:

```powershell
cd C:\project\python-service
python start_backend.py            # run (default)
python start_backend.py run        # run, explicit
python start_backend.py status     # who owns port 8000 + health
python start_backend.py stop       # SIGTERM only the verified KAUSTUBH backend
python start_backend.py restart    # stop, wait for release, then run
```

It is single-instance: `runtime/singleton.py` takes an OS named mutex and probes the
port, so a second backend exits with `BACKEND ALREADY RUNNING` rather than duplicating
sidecars. It binds the socket **before** running the app lifespan
(`SingletonServer._prebound_socket`, line 130), so a port conflict fails before MongoDB,
the scheduler, or the WebSocket supervisor are touched.

### Engine control — HTTP only
**There is no per-engine CLI.** Engine lifecycle is reachable only over HTTP, via the
router below.

| Documented (fictional) | Real equivalent |
|------------------------|-----------------|
| `python -m kaushub.engine start <id>` | `POST /api/services/engines/{engine_id}/start` |
| `python -m kaushub.engine stop <id>` | `POST /api/services/engines/{engine_id}/stop` |
| `python -m kaushub.engine restart <id>` | `POST /api/services/engines/{engine_id}/restart` |
| `python -m kaushub.engine status <id>` | `GET /api/services/engines/{engine_id}` |
| `python -m kaushub.engine logs <id>` | `GET /api/services/engines/{engine_id}/errors`, `.../activity` |
| `python -m kaushub.engine diagnose <id>` | `GET /api/services/engines/{engine_id}/health` |
| `python -m kaushub.engine reconcile positions` | **no equivalent found** — see §4 |
| `python -m kaushub.cli start` | `python start_backend.py` |
| `python -m kaushub.cli status` | `python start_backend.py status` |
| `python -m kaushub.db.query <coll> <filter>` | **no equivalent found** — see §4 |
| `python -m kaushub.db.connect` | **no equivalent found** — see §4 |

---

## 2. Router: `/api/services/engines`

Declared `engine_control.py:18`. Handler bodies are thin wrappers over
`services/engine_registry.py` (`get_engine_registry()`) and
`brokers/broker_registry.py`.

### Read
| Method | Path | Handler | Line |
|--------|------|---------|------|
| GET | `/summary` | `engine_summary` | 32 |
| GET | *(empty)* | `all_engines` | 38 |
| GET | `/dependency-graph` | `dependency_graph` | 44 |
| GET | `/{engine_id}` | `engine_status` | 53 |
| GET | `/{engine_id}/health` | `engine_health` | 61 |
| GET | `/{engine_id}/metrics` | `engine_metrics` | 69 |
| GET | `/{engine_id}/dependencies` | `engine_dependencies` | 77 |
| GET | `/{engine_id}/errors?limit=20` | `engine_errors` | 85 |
| GET | `/{engine_id}/activity?limit=30` | `engine_activity` | 93 |

### Lifecycle (mutating)
| Method | Path | Handler | Line |
|--------|------|---------|------|
| POST | `/{engine_id}/start` | `engine_start` | 104 |
| POST | `/{engine_id}/stop` | `engine_stop` | 110 |
| POST | `/{engine_id}/restart` | `engine_restart` | 119 |
| POST | `/{engine_id}/heartbeat` | `engine_heartbeat` | 125 |
| POST | `/heartbeat-all` | `heartbeat_all` | 208 |
| POST | `/health-check` | `health_check_all` | 180 |
| POST | `/db_writer_engine/flush` | `db_writer_flush` | 189 |

### Broker control (mutating)
| Method | Path | Handler | Line |
|--------|------|---------|------|
| GET | `/broker/status` | `broker_status` | 136 |
| GET | `/broker/list` | `broker_list` | 143 |
| GET | `/broker/trading` | `trading_broker_status` | 149 |
| GET | `/broker/market-data` | `market_data_broker_status` | 155 |
| **POST** | `/broker/trading/select` | `select_trading_broker` | 161 |
| **POST** | `/broker/market-data/select` | `select_market_data_broker` | 169 |

### Other
| Method | Path | Handler | Line |
|--------|------|---------|------|
| GET | `/feature_engine/latest?tokens=a,b` | `feature_engine_latest` | 197 |

### Response envelope
Handlers return via two helpers:
- `_ok(data)` → `{"ok": True, "data": sanitize_for_json(data)}` (line 21)
- `_bad(message)` → `{"ok": False, "error": …}` (line 25)

`stop` has one distinct shape — when the registry reports
`requiresConfirmation` and the request body lacks `confirm`, it returns
`{"ok": False, "error": …, "requiresConfirmation": True}` (line 114-115).

---

## 3. Route-ordering check (resolves an earlier concern)

`PENDING-001` previously flagged `/api/services/engines/broker/status` as a possible
collision with `/{engine_id}`. **On inspection it is not.** FastAPI matches in
declaration order, but the path *shapes* differ:

- `/{engine_id}` (line 53) is a **single** segment → cannot match `broker/status`
- `/{engine_id}/health` (line 61) is two segments with a **literal** `health` →
  cannot match `broker/list` or `broker/status`
- `/summary` (line 32) is declared **before** `/{engine_id}` (line 53), so it wins

Literal two-segment broker paths (`/broker/status`, `/broker/list`, …) are declared at
lines 136-155, after the `/{engine_id}/…` family, but no pattern in that family can
shadow them. `/db_writer_engine/flush` (line 189) is a fully literal path.

**Conclusion**: no shadowing found. The assertion remains in `PENDING-001` as a cheap
sanity check rather than a suspected defect.

---

## 4. Gaps: documented commands with no real equivalent

| Fictional command | Status | Note |
|-------------------|--------|------|
| `kaushub.engine reconcile positions` | **no endpoint found** | `EngineRegistry` exposes no reconcile operation. `32_ARCHITECTURE_GAPS.md` Gap 1's remediation step 1 has **no** real counterpart. A `reconcile` concept does appear in test names (`test_scheduler_reconcile_lifecycle.py`, `test_kotak_margin_tradebook.py`) and in scheduler code — worth tracing in `PENDING-003`. |
| `kaushub.db.query <coll> <filter>` | **no endpoint found** | No ad-hoc database query endpoint. Correctly so — that would be a serious injection surface. Verification should use `mongosh` instead. |
| `kaushub.db.connect` | **no endpoint found** | Connection is managed at startup; no runtime reconnect control exposed. |
| `kaushub.engine logs <id>` | partial | `/{engine_id}/errors` and `/{engine_id}/activity` cover recent events, not log streaming. |

**Consequence**: `32_ARCHITECTURE_GAPS.md` Gap 1 (squareoff reconciliation) **cannot be
executed at all** — not even by translating to the correct command, because the operation
does not exist over HTTP.

---

## 5. Registry internals worth knowing

`services/engine_registry.py` (285 lines) — the object these endpoints delegate to:

| Member | Line | Purpose |
|--------|------|---------|
| `register(engine)` | 42 | add; rejects duplicate ids unless replaced |
| `unregister(engine_id)` | 55 | remove |
| `get(engine_id)` | 63 | lookup |
| `get_status` / `get_all_statuses` | 104 / 110 | status views |
| `get_health` | 115 | health view |
| `get_metrics` | 126 | metrics |
| `get_dependencies` | 132 | dependency view |
| `heartbeat` / `heartbeat_all` | 157 / 164 | liveness |
| `dependency_graph()` | 188 | full graph |
| `summary()` | 205 | roll-up |
| `_check_dependencies(engine_id)` | 235 | gate — **body not yet read** |
| `_safety_check(engine_id)` | 247 | gate — **body not yet read** |
| `_notify_dependents(engine_id, event)` | 267 | cascade |
| `get_engine_registry()` | 281 | module singleton |

`start` / `stop` / `restart` are awaited by the handlers but are **not** in this listing —
they are presumably `async` methods on the class; I read the `def`/`async def` signature
lines and did not read every body. `_check_dependencies` and `_safety_check` are the
likely places where a `stop` would be refused, and they are the most important thing to
read next for understanding real behaviour.

**Only one production call site registers engines**: `app.py:626`, `registry.register(eng)`.
Registration order and the auto-start subset are documented in
`docs/DOCUMENTATION_AUTHORITY.md` §4.

---

## 6. Suggested first commands (once a test-mode backend is up)

```powershell
# Enumerate — expect 17 engines (14 native + 3 facade)
curl http://127.0.0.1:8000/api/services/engines
curl http://127.0.0.1:8000/api/services/engines/summary

# Which of the registered-but-not-auto-started engines are actually up?
curl http://127.0.0.1:8000/api/services/engines/margin_engine
curl http://127.0.0.1:8000/api/services/engines/squareoff_engine

# The two engines the gap doc invents
curl http://127.0.0.1:8000/api/services/engines/audit_engine
curl http://127.0.0.1:8000/api/services/engines/watchlist_target_engine   # expect 404

# Broker state
curl http://127.0.0.1:8000/api/services/engines/broker/list
```

Avoid `POST` routes unless the target engine is known to be disposable — on a live
system `stop` is not reversible from outside the process.

---
*Static analysis. No endpoint was called.*
