# PROJECT_ASSUMPTIONS.md

## KAUSTUBH Trading Platform - Stated Assumptions

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Purpose**: Record every assumption made during discovery so future agents can challenge or confirm them.

---

## Verified Assumptions (Backed by Code)

| ID | Assumption | Evidence |
|----|-----------|----------|
| A-01 | Backend is Python/FastAPI, single process | `python-service/app.py` |
| A-02 | Frontend is Next.js App Router | `package.json`, `app/**/page.tsx` |
| A-03 | MongoDB via async Motor driver | `database/connection.py`, `requirements.txt` |
| A-04 | Kotak Neo is the primary broker | `brokers/kotak_adapter.py`, `BROKER_MODE` default |
| A-05 | Four WebSocket channels exist by design | `docs/architecture/08_WEBSOCKET_ARCHITECTURE.md` + `ws_socket/`, `connection_engine/` |
| A-06 | WS#3 + WS#4 share `/ws/realtime` | `api/ws_gateway.py` |
| A-07 | 40 router registrations in `app.py` | Direct import/include_router scan |
| A-08 | `websockets` is pinned to 13.1 for uvicorn compat | `requirements.txt` + comment |
| A-09 | `_pages/` folders are non-routable | Next.js App Router convention |
| A-10 | Route groups don't affect URLs | Next.js App Router convention |

---

## Unverified Assumptions (Inferred, Not Confirmed)

| ID | Assumption | Confidence | How to Confirm |
|----|-----------|------------|----------------|
| A-11 | Session Manager is the sole subscription authority | High | Read `services/session/` fully |
| A-12 | DB Writer is the only persistence path | High | Grep for `insert_one`/`insert_many` outside db-writer |
| A-13 | Frontend never calls broker APIs directly | High | Grep `lib/backend.ts` and `app/api/*` |
| A-14 | ~~15 engines is the complete registry~~ → **REFUTED 2026-09-28. Code registers 17 (14 native + 3 facade)** — `app.py:609-626`, `legacy_engine_facades.py:428-432` | High | Resolved statically. Live confirmation pending `PENDING-001` |
| A-15 | `broker_mode` switches adapters at runtime | Medium | Read `brokers/manager.py` |
| A-16 | Dummy adapter uses live Kotak LTP | Medium | Read `brokers/dummy.py` |
| A-17 | Scheduler times are IST | High | `core/timezones.py` + settings names |
| A-18 | Shutdown at 16:00 logs out of brokers | Medium | Read `scheduler/__init__.py` |
| A-19 | CORS restricted to frontend origin | Low | Read `app.py` CORS middleware |
| A-20 | Structured logging writes to stdout only | Low | Read `logger/` |

---

## Working Assumptions (Adopted for This Documentation Pass)

| ID | Assumption | Rationale |
|----|-----------|-----------|
| A-21 | Documentation describes intent; code describes current behavior | Per `PROJECT_IMPLEMENTATION_RULE.md` authority hierarchy |
| A-22 | Engine health values in `ENGINE_INVENTORY.md` are historical snapshots, not live | No running system |
| A-23 | Database counts in `17_DATABASE_ARCHITECTURE.md` are estimates | Explicitly marked unmeasured in source docs |
| A-24 | No secrets are present in any committed doc | Governance requirement; verified absence during scan |
| A-25 | Serial `015` is acceptable as the first record | `docs/implementation/` did not previously exist; rule says never guess when records exist — none did |
| A-26 | Repo root is `C:\project`, backend root is `C:\project\python-service` | Confirmed by structure |
| A-27 | Node ≥18 available for build | Next 16 requirement |
| A-28 | Python 3.12+ available | FastAPI + modern typing |
| A-29 | MongoDB is reachable in production | Hard startup dependency |
| A-30 | `(ai)` routes are placeholders | No backend counterpart found |

---

## Assumptions Explicitly NOT Made

These were **not** assumed and remain open:

- That any test passes (none run)
- That any documented endpoint returns successfully
- That the DB schema in `17_DATABASE_ARCHITECTURE.md` matches reality
- That broker failover actually works
- That the AI routes work
- That Supabase is used
- That rate limiting or TLS exist
- That `_pages/` files are all dead (only that they are unroutable)

---

## Related Documents
- `PROJECT_GAPS.md` — Open questions
- `PROJECT_RISKS.md` — Risk register
- `FINAL_REPORT.md` — What was and wasn't done
