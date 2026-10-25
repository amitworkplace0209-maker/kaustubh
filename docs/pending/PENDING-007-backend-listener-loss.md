# PENDING-007-backend-listener-loss.md

## Task ID

PENDING-007

## Date Created

2026-10-21

## Priority

**P1 — HIGH** (the platform is unavailable while it happens; it is self-healing but the root cause is unknown)

## Title

The FastAPI backend loses its HTTP listener on Windows while the process stays alive

## Status

`PENDING` (mitigated, root cause open)

## Source

- Found during: `docs/implementation/033-trade-page-full-rebuild.md` §6 P7
- Verified in: `docs/verification/041-trade-page-full-rebuild.md` §3.4

## Context

On this Windows host the backend process keeps running while its **listening socket
disappears**: `GET /health` refuses new connections, the process is alive, the engines keep
logging as if healthy, and every page answers `500 Internal Server Error` / `502 Bad
Gateway` through the Next.js proxy.

Observed repeatedly on 2026-10-21 (14:2x, 15:2x, 15:3x). The symptom is exactly what
`python-service/watchdog_backend.py` documents:

> The backend occasionally loses its HTTP listener while the process keeps running. On a
> transient network-stack hiccup Windows reports `WinError 64 (The specified network name is
> no longer available)`; uvicorn/asyncio then stops answering new connections
> (asyncio "Accept failed on a socket"), but the web app engines keep logging as if healthy
> and `runtime/backend.state` stays READY.

## What was done in this task

- The watchdog's `GRACE_AFTER_START` was raised from 45 s to 240 s. The cold start on this
  machine takes ~100-140 s, so the old grace turned every cold start into a
  kill-and-restart loop that left the platform permanently down.
- The watchdog now heals the situation: after three failed probes it kills the
  listener-dead process and launches a fresh one.
- The watchdog's infinite relaunch loop was fixed (it relaunched forever when the
  launcher refused to duplicate a healthy backend — it now ADOPTS the running instance).

## Update 2026-10-22 — the root cause is fixed IN the launcher

`python-service/start_backend.py` now runs a **listener doctor** inside the server
process:

* it probes the listener over HTTP (a TCP connect cannot tell — with a dead accept loop
  the kernel still completes the handshake, so the connect succeeds while nothing is
  served);
* when two consecutive probes fail it closes the dead listening socket and binds a
  fresh one **without re-running the application lifespan** (no engine starts twice, no
  state is lost);
* the accepted connections are deliberately left alone, so a re-bind does not drop the
  browser's SSE streams.

**Production evidence (2026-10-22):**

```
11:26:29 [ERROR] supervisor: LISTENER_DEAD — the listening socket stopped accepting on 0.0.0.0:8000; re-binding it
11:26:31 [INFO]  supervisor: Application: LISTENING re-bound on 0.0.0.0:8000 (instance=1928)
11:28:35 / 11:28:38   (same cycle)
11:39:02 / 11:39:04   (same cycle)
```

Outage per event: **~10 s** (was 2-4 minutes with a full process restart).

**Regression guard:** `python-service/tests/test_listener_doctor.py` — it drives the real
server, kills its accept loop, and asserts that the port serves again AND that the
application lifespan ran exactly once. It holds a long-lived connection open (the
browser's SSE streams behave like this) because the first version of the fix hung on
`wait_closed()`.

The doctor is a MITIGATION, not a cure: the underlying Windows network-stack defect
(`WinError 64` in the asyncio Proactor's accept coroutine) is still open.

## Open items

### 1. Root cause of the lost listening socket — MITIGATED, NOT CURED


**Captured evidence (2026-10-21 15:53:31, `logs/backend_rebuild_live.err.log`):**

```
future: <Task finished name='Task-83' coro=<IocpProactor.accept.<locals>.accept_coro() done,
  defined at ...\Lib\asyncio\windows_events.py:563> exception=OSError(64, 'The specified
  network name is no longer available')
2026-10-21 15:53:31,237 [ERROR] asyncio: Accept failed on a socket
OSError: [WinError 64] The specified network name is no longer available
```

So the failure IS the documented Windows network-stack hiccup: the asyncio **IocpProactor's
accept coroutine dies with `WinError 64`**, asyncio's `_accept_connection` logs it through
the exception handler, and the process keeps running with a socket that can no longer
accept. uvicorn does not re-create the listening socket, so every later connection is
refused while the engines keep logging as if healthy.

**What is still open:** why the network stack reports `WinError 64` on this host (a
transient adapter/network condition). That is outside the application.

**How to close the APPLICATION side:**

1. In the launcher (`python-service/start_backend.py`), supervise the accept loop: when
   `Server.startup()`/`serve()` reports a dead listener, re-create the bound socket and
   hand it to `Server.startup(sockets=...)` again — the launcher already owns the
   bind-before-lifespan mechanism, so it can re-bind.
2. Alternatively, keep the watchdog running as the supervisor (it already kills and
   relaunches a listener-dead backend); the missing piece is that the watchdog must be
   RUNNING — the platform's default launcher does not start it.

### 2. A health signal that reflects the LISTENER, not the process — NOT_IMPLEMENTED

**What is missing:** `runtime/backend.state` still says `READY` while the socket is gone.

**How to close it:** have the launcher flip the runtime state to `DEGRADED` when the
health probe fails while the process is alive, so the UI can show "the backend is not
answering" instead of a blank page.

### 3. The operator's frontend loses the session with the backend — NOT_HANDLED

A backend restart drops the broker session (the Kotak Neo login is MANUAL/TOTP based).
`POST /api/auth/manual-login` restores it (the backend holds the TOTP secret; the browser
never sees it). Document it in the operator runbook.

## Explicitly NOT pending (verified)

- The watchdog now waits long enough for a cold start → **PASS** (the backend stayed up and
  served traffic).
- The watchdog heals a listener-dead backend → **PASS** (the backend came back after the
  kill/relaunch cycle).

## Blocks

This defect **blocks every live verification** of the platform, because a dead listener
makes every page answer `500 / 502 Bad Gateway`. The live-verification runbook
(`docs/pending/PENDING-008-trade-page-live-verification.md`) therefore starts with a
health preflight and starts the watchdog if the backend is deaf.

## Final status

`PENDING` — the platform self-heals, but the root cause of the lost socket is unknown.
