"""Canonical launcher for the KAUSTUBH FastAPI backend (single-instance).

What changed and why
--------------------
The previous launcher used ``uvicorn.Config(...)`` + ``uvicorn.run()``.
Uvicorn's ``Server.serve()`` executes the application **lifespan before** it
binds the listening socket, so a second process started while port 8000 was
already owned ran the entire application startup (MongoDB, scheduler, WebSocket
supervisor, tick buffer, workers) and only THEN died with:

    ERROR: [Errno 10048] error while attempting to bind on address ...
    [WinError 10048] only one usage of each socket address ...

This launcher fixes that in three layers:

1. **Single-instance preflight** — ``runtime/singleton.acquire()`` takes an
   OS-level named mutex (crash-safe: the kernel releases it when the process
   dies, even on ``taskkill /F``) and probes port 8000. If a healthy backend is
   already running it exits immediately with ``BACKEND ALREADY RUNNING`` and
   never boots a second set of sidecars.
2. **Bind before lifespan** — we create and bind the listening socket
   ourselves and hand it to ``uvicorn.Server.startup(sockets=...)`` (the same
   mechanism uvicorn uses for ``--reload`` parent processes). The application
   lifespan therefore only ever starts after the port is genuinely ours.
3. **Accurate READY** — runtime state flips to READY and
   ``Application: LISTENING ...`` is logged only after that bound socket has
   been handed to the event loop.

Developer workflow is unchanged: ``run_backend.cmd`` (i.e. ``python
start_backend.py``) still works; when a backend is already up it prints a clear
message and exits 0 instead of killing or duplicating anything.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import socket
import sys
import time
from pathlib import Path

import uvicorn
from uvicorn.config import Config

from config.settings import settings

RUNTIME_DIR = Path(__file__).resolve().parent / "runtime"


def logger() -> logging.Logger:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    if not logging.getLogger("supervisor").handlers:
        logging.basicConfig(
            level=level,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        )
        # Some SDKs (e.g. neo-api-client) set the ROOT logger level to WARNING
        # when the app is imported. Named loggers that inherit that effective
        # level would silently drop our single-instance INFO diagnostics, so
        # give each one an explicit INFO level + its own INFO console handler
        # (same pattern app.py uses for the "app" logger).
        for name in (
            "supervisor",
            "scheduler",
            "websocket",
            "ws_gateway",
            "connection_engine",
        ):
            named = logging.getLogger(name)
            named.setLevel(level)
            named.propagate = False
            named.addHandler(_make_info_console_handler())
    return logging.getLogger("supervisor")


def _make_info_console_handler() -> logging.Handler:
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )
    return handler


LOG = logger()


def _signal_name(sig) -> str:
    names = {
        getattr(signal, name, None): name
        for name in ("SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP", "SIGQUIT",
                     "SIGILL", "SIGSEGV", "CTRL_C_EVENT", "CTRL_BREAK_EVENT")
    }
    if sig is None:
        return "none"
    if sig in names:
        return names[sig]
    if isinstance(sig, int):
        try:
            return signal.Signals(sig).name
        except ValueError:
            return str(sig)
    return str(sig)


class SingletonServer(uvicorn.Server):
    """uvicorn.Server that owns the port BEFORE the app lifespan runs, and
    reports READY only after the listener is actually bound.

    It also supervises the listener itself: on Windows the asyncio accept
    coroutine can die with ``WinError 64`` and never recover, which leaves the
    process alive but deaf. The doctor re-binds the socket in that case (see
    ``_listener_doctor``).
    """

    #: How often the doctor probes the listener (seconds).
    listener_doctor_interval_s: float = 2.0
    #: Consecutive failed probes before the socket is re-bound.
    listener_doctor_failures: int = 2
    #: How long a single probe waits for an HTTP response (seconds).
    listener_doctor_timeout_s: float = 1.5

    def __init__(self, *args, guard, **kwargs):
        super().__init__(*args, **kwargs)
        self._guard = guard
        self._listener_failures = 0

    def handle_exit(self, sig, frame):  # type: ignore[override]
        name = _signal_name(sig)
        LOG.error("PROCESS_SHUTDOWN_REQUESTED signal=%s -> graceful shutdown (uvicorn)", name)
        try:
            from services.event_history import record_event
            record_event("process", "shutdown_requested", "info", f"Received {name}")
        except Exception:
            pass
        super().handle_exit(sig, frame)

    # ------------------------------------------------------------------
    # Bind BEFORE lifespan: pass a pre-bound socket that we own.
    # ------------------------------------------------------------------
    def _prebound_socket(self, reuseaddr: bool = True) -> socket.socket:
        host, port = self.config.host, self.config.port
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if reuseaddr:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
            sock.listen(128)
            LOG.info("Binding to %s:%s (socket owned before lifespan)", host, port)
        except OSError as exc:
            sock.close()
            LOG.error(
                "START_REFUSED %s:%s already in use (code %s). Another backend holds it. "
                "Run: python start_backend.py status",
                host, port, exc.winerror,
            )
            raise
        return sock

    async def startup(self, sockets=None):  # type: ignore[no-untyped-def]
        if sockets is None:
            sockets = [self._prebound_socket()]
        await super().startup(sockets)
        # uvicorn sets self.started = True only after create_server(bind) succeeded.
        if self.started and not self.should_exit:
            self._guard.hello()
            LOG.info(
                "Application: LISTENING on %s:%s (instance=%d)",
                self.config.host, self.config.port, os.getpid(),
            )
        else:
            self._guard.degrade("started before listener bind")
            LOG.error("Application did NOT reach the listening state.")

    # ------------------------------------------------------------------
    # LISTENER DOCTOR
    #
    # On Windows the asyncio Proactor's accept coroutine can die with
    # ``OSError: [WinError 64] The specified network name is no longer
    # available``. ``selector_events._accept_connection`` re-raises any OSError
    # that is not a resource exhaustion, so the accept loop STOPS for good: the
    # process keeps running, the engines keep logging, the kernel still
    # completes handshakes (the socket is still listening) — but no request is
    # ever served again. The whole platform answers "502 Bad Gateway" while
    # every process looks healthy.
    #
    # The doctor detects that state (the listener does not answer HTTP) and
    # RE-BINDS the socket in place. The application lifespan is NOT re-run, so
    # no engine is started twice and no state is lost.
    # ------------------------------------------------------------------
    async def main_loop(self):  # type: ignore[no-untyped-def]
        doctor = asyncio.create_task(self._listener_doctor())
        try:
            await super().main_loop()
        finally:
            doctor.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await doctor

    async def _listener_answers(self, timeout: float | None = None) -> bool:
        """True when the listener still serves an HTTP response.

        A TCP connect alone cannot tell: with a dead accept loop the kernel
        still completes the handshake, so the connect succeeds while nothing is
        ever served. The probe therefore asks for a real HTTP response.
        """
        if timeout is None:
            timeout = self.listener_doctor_timeout_s
        host = self.config.host or "0.0.0.0"
        if host in ("0.0.0.0", "::", ""):
            host = "127.0.0.1"
        port = int(self.config.port)
        writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=timeout
            )
            writer.write(
                b"GET /api/terminal/state HTTP/1.1\r\n"
                b"Host: localhost\r\nConnection: close\r\n\r\n"
            )
            await writer.drain()
            head = await asyncio.wait_for(reader.read(16), timeout=timeout)
            return head.startswith(b"HTTP/")
        except (OSError, asyncio.TimeoutError, ValueError):
            return False
        finally:
            if writer is not None:
                with contextlib.suppress(Exception):
                    writer.close()
                    await writer.wait_closed()

    async def _rebind_listener(self) -> None:
        """Replace the dead listening socket with a fresh one."""
        LOG.error(
            "LISTENER_DEAD — the listening socket stopped accepting on %s:%s; re-binding it",
            self.config.host, self.config.port,
        )
        for srv in list(getattr(self, "servers", [])):
            with contextlib.suppress(Exception):
                self.servers.remove(srv)
            # close() releases the LISTENING socket. wait_closed() must NOT be
            # awaited unbounded: it waits for every in-flight connection (the
            # browser's long-lived SSE streams never end), which would hang the
            # doctor forever. The accepted connections are deliberately left
            # alone — they are still healthy.
            with contextlib.suppress(Exception):
                srv.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(srv.wait_closed(), timeout=2.0)
        # Give the OS a moment to release the port before re-binding it.
        await asyncio.sleep(0.5)

        last_error: Exception | None = None
        for _ in range(5):
            try:
                # NO SO_REUSEADDR here: on Windows it would let the new socket
                # bind on top of a port the old (dead) socket still holds, and
                # the kernel would then hand connections to the dead one.
                sock = self._prebound_socket(reuseaddr=False)
            except OSError as exc:  # the port is still held — retry shortly
                last_error = exc
                await asyncio.sleep(1.0)
                continue
            loop = asyncio.get_running_loop()
            config = self.config

            def create_protocol(_loop=None):  # type: ignore[no-untyped-def]
                return config.http_protocol_class(  # type: ignore[call-arg]
                    config=config,
                    server_state=self.server_state,
                    app_state=self.lifespan.state,
                    _loop=_loop,
                )

            server = await loop.create_server(
                create_protocol, sock=sock, ssl=config.ssl, backlog=config.backlog
            )
            self.servers.append(server)
            self._guard.hello()
            LOG.info(
                "Application: LISTENING re-bound on %s:%s (instance=%d)",
                self.config.host, self.config.port, os.getpid(),
            )
            return
        raise last_error or OSError("could not re-bind the listening socket")

    async def _listener_doctor(self) -> None:
        """Watch the listener and re-bind it when the accept loop dies."""
        while True:
            await asyncio.sleep(self.listener_doctor_interval_s)
            if self.should_exit:
                return
            try:
                if await self._listener_answers():
                    self._listener_failures = 0
                    continue
                self._listener_failures += 1
                if self._listener_failures < self.listener_doctor_failures:
                    continue
                await self._rebind_listener()
                self._listener_failures = 0
            except asyncio.CancelledError:
                raise
            except Exception:
                LOG.exception("listener doctor failed — will retry")
                self._listener_failures = 0


def _preflight(host: str, port: int):
    """Acquire the singleton. Exits cleanly if another backend already runs."""
    from runtime.singleton import AlreadyRunning, acquire

    try:
        guard = acquire(RUNTIME_DIR, port, host, strict_health=True)
    except AlreadyRunning as exc:
        LOG.info("BACKEND ALREADY RUNNING pid=%s healthy=%s on port=%s",
                 exc.pid, exc.healthy, port)
        print(
            f"BACKEND ALREADY RUNNING pid={exc.pid} healthy={exc.healthy} "
            f"on port {port}. No second instance started."
        )
        raise SystemExit(0 if exc.healthy else 2) from exc
    return guard


def _run_foreground(host: str, port: int) -> int:
    guard = _preflight(host, port)
    LOG.info("KAUSTUBH supervisor starting (app:app, host=%s, port=%s, instance=%d)",
             host, port, os.getpid())
    try:
        from services.event_history import record_event
        record_event("process", "supervisor_started", "info",
                     f"start_backend.py supervisor up (instance={os.getpid()})")
    except Exception:
        LOG.debug("supervisor_started event skipped")

    config = Config(
        "app:app",
        host=host,
        port=port,
        reload=False,
        log_level=settings.log_level,
        lifespan="on",
    )
    server = SingletonServer(config, guard=guard)
    try:
        # uvicorn.Server.run() -> asyncio.run(serve); serve() -> _serve() ->
        # startup(sockets) (our overridden method, pre-bound) -> lifespan.startup
        server.run()
    except SystemExit:
        raise
    finally:
        guard.release()
    return 0


def _stop() -> int:
    """Stop ONLY a verified KAUSTUBH backend; never kill unrelated processes."""
    from runtime.singleton import port_listener_info, probe_host
    host, port = settings.host, settings.port
    probe = probe_host(host)
    info = port_listener_info(port, probe)
    if info is None:
        # No listener; clean up a stale pid file if it exists.
        try:
            pidfile = RUNTIME_DIR / "backend.pid"
            if pidfile.exists():
                print(f"No backend on {probe}:{port}. Stale pid file removed.")
                pidfile.unlink()
            else:
                print(f"No KAUSTUBH backend running on {probe}:{port}.")
        except OSError:
            print(f"No KAUSTUBH backend running on {probe}:{port}.")
        return 0
    pid = info["pid"]
    if info["is_backend"] is not True:
        print(f"Port {probe}:{port} is owned by pid={pid} (does not look like the "
              f"KAUSTUBH backend). NOT stopping it.")
        return 2
    print(f"Stopping KAUSTUBH backend pid={pid} on {probe}:{port} "
          f"(health={'ok' if info['healthy'] else 'n/a'}).")
    try:
        os.kill(pid, signal.SIGTERM)  # Windows: terminates that PID only
    except OSError as exc:
        print(f"Could not signal pid={pid}: {exc}")
        return 3
    for _ in range(60):  # bounded poll until the port is released
        time.sleep(0.5)
        try:
            if port_listener_info(port, probe) is None:
                print(f"Backend stopped; port {probe}:{port} released.")
                return 0
        except Exception:
            pass
    print(f"Backend pid={pid} signalled; port {probe}:{port} still bound (possible "
          f"TIME_WAIT). Check: netstat -ano | findstr :{port}")
    return 4


def _status() -> int:
    from runtime.singleton import port_listener_info, probe_host
    host, port = settings.host, settings.port
    probe = probe_host(host)
    info = port_listener_info(port, probe)
    print(f"KAUSTUBH backend status (target {probe}:{port})")
    if info is None:
        print("  status: NOT RUNNING")
        try:
            st = (RUNTIME_DIR / "backend.state").read_text(encoding="utf-8").strip()
            if st:
                print(f"  last-recorded state: {st}")
        except OSError:
            pass
        return 1
    print(f"  pid: {info['pid']}")
    print(f"  looks_like_backend: {info['is_backend']}")
    print(f"  health: {'OK' if info['healthy'] else 'UNKNOWN/DEGRADED'}")
    return 0 if (info["healthy"] or info["is_backend"] is True) else 2


def _restart() -> int:
    rc = _stop()
    if rc not in (0, 4):
        return rc
    from runtime.singleton import port_listener_info, probe_host
    probe = probe_host(settings.host)
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            if port_listener_info(settings.port, probe) is None:
                break
        except Exception:
            pass
        time.sleep(0.5)
    time.sleep(0.5)
    LOG.info("Restarting backend on %s:%s", settings.host, settings.port)
    return _run_foreground(settings.host, settings.port)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="start_backend",
        description="KAUSTUBH backend launcher (single-instance, port-safe).")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("status", help="print who owns the backend port + health")
    sub.add_parser("stop", help="stop only the verified KAUSTUBH backend")
    sub.add_parser("restart", help="stop the verified backend then start one")
    sub.add_parser("run", help="start the backend (default = run)")
    args = parser.parse_args(argv)

    cmd = args.command or "run"
    if cmd == "status":
        return _status()
    if cmd == "stop":
        return _stop()
    if cmd == "restart":
        return _restart()
    return _run_foreground(settings.host, settings.port)


if __name__ == "__main__":
    sys.exit(main())