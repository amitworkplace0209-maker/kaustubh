"""Listener doctor — regression guard for the "alive but deaf" backend.

On Windows the asyncio Proactor's accept coroutine can die with
``OSError: [WinError 64] The specified network name is no longer available``.
``selector_events._accept_connection`` re-raises any OSError that is not a
resource exhaustion, so the accept loop stops for good: the process keeps
running, the engines keep logging, the kernel still completes handshakes — but
no request is ever served again. Every page then answers "502 Bad Gateway"
while every process looks healthy.

``SingletonServer._listener_doctor`` detects that state (the listener does not
answer HTTP) and re-binds the socket IN PLACE, without re-running the
application lifespan (so no engine is started twice and no state is lost).

This test drives the real server, kills its accept loop the way the OS does,
and asserts that the port serves again — and that the application was NOT
started a second time.

Run:  python -m pytest tests/test_listener_doctor.py -q
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import socket
import sys
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


async def _probe(port: int, timeout: float = 1.5) -> bool:
    """True when the port answers an HTTP request."""
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port), timeout=timeout
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
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass


class _Guard:
    """Minimal stand-in for the runtime singleton guard."""

    def __init__(self) -> None:
        self.hello_count = 0

    def hello(self) -> None:
        self.hello_count += 1

    def degrade(self, why: str) -> None:  # pragma: no cover - not used here
        pass

    def release(self) -> None:  # pragma: no cover - not used here
        pass


class ListenerDoctorTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_dead_accept_loop_is_repaired_in_place(self):
        from uvicorn.config import Config

        from start_backend import SingletonServer

        lifespan_starts = {"count": 0}

        async def app(scope, receive, send):
            if scope["type"] == "lifespan":
                while True:
                    message = await receive()
                    if message["type"] == "lifespan.startup":
                        lifespan_starts["count"] += 1
                        await send({"type": "lifespan.startup.complete"})
                    elif message["type"] == "lifespan.shutdown":
                        await send({"type": "lifespan.shutdown.complete"})
                        return
            if scope["type"] == "http":
                await send({
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"content-type", b"text/plain")],
                })
                await send({"type": "http.response.body", "body": b"ok"})

        port = _free_port()
        config = Config(app, host="127.0.0.1", port=port, lifespan="on", log_level="warning")

        class FastDoctorServer(SingletonServer):
            listener_doctor_interval_s = 0.2
            listener_doctor_failures = 2

        guard = _Guard()
        server = FastDoctorServer(config, guard=guard)
        serve = asyncio.create_task(server.serve())
        try:
            # 1) the listener works
            for _ in range(50):
                if await _probe(port):
                    break
                await asyncio.sleep(0.1)
            self.assertTrue(await _probe(port), "the listener must serve before the failure")

            # 2) kill the accept loop the way the OS does: the socket stops
            #    answering while the process stays alive.
            #    A long-lived connection is kept open on purpose (the browser's
            #    SSE streams behave exactly like this) — the doctor must not
            #    wait for it before re-binding.
            held = None
            with contextlib.suppress(Exception):
                reader, held = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", port), timeout=2.0
                )
            for srv in list(server.servers):
                srv.close()
            await asyncio.sleep(0.3)
            self.assertFalse(
                await _probe(port), "the listener must be dead after the accept loop is killed"
            )

            # 3) the doctor must notice and re-bind the socket
            recovered = False
            for _ in range(80):
                await asyncio.sleep(0.25)
                if await _probe(port):
                    recovered = True
                    break
            self.assertTrue(recovered, "the listener doctor must re-bind the socket")

            # 4) the application must NOT have been started a second time
            self.assertEqual(
                lifespan_starts["count"],
                1,
                "re-binding the socket must not re-run the application lifespan",
            )
        finally:
            server.should_exit = True
            with __import__("contextlib").suppress(Exception):
                await asyncio.wait_for(serve, timeout=10)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
