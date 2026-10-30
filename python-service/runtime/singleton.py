"""Crash-safe single-instance guard for the KAUSTUBH backend (Windows).

Prevents the ``[WinError 10048]`` duplicate-backend failure by guaranteeing
that only ONE backend process ever reaches the point where it starts sidecars
(scheduler, WebSocket supervisor, tick buffer, workers, MongoDB connect).

Mechanism
---------
* Port preflight — if the port already has a LISTENING socket, start here and
  exit cleanly (either it is our healthy backend → ``AlreadyRunning(healthy)``,
  or an unrelated process → ``AlreadyRunning(unhealthy)``). Never kill anyone.
* Windows named mutex — a live backend holds a named kernel mutex. The mutex
  is released automatically by the OS when the process dies (even on hard
  crash / ``taskkill /F``), so it can never go stale. We reclaim an abandoned
  mutex deterministically via ``WaitForSingleObject``.

This replaces the previous race in which *two* freshly-started processes both
ran the full ASGI lifespan (MongoDB, scheduler, …) and only one later failed
to bind port 8000.
"""
from __future__ import annotations

import ctypes
import datetime as _dt
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

if sys.platform != "win32":  # fcntl does not exist on Windows
    import fcntl

WAIT_OBJECT_0 = 0x00000000
WAIT_ABANDONED = 0x00000080
WAIT_TIMEOUT = 0x00000102
WAIT_FAILED = 0xFFFFFFFF

STATE_STARTING = "STARTING"
STATE_READY = "READY"
STATE_DEGRADED = "DEGRADED"
STATE_STOPPING = "STOPPING"
STATE_STOPPED = "STOPPED"

_ALL_STATES = (STATE_STARTING, STATE_READY, STATE_DEGRADED, STATE_STOPPING, STATE_STOPPED)

_IS_WINDOWS = sys.platform == "win32"


def probe_host(host: str) -> str:
    """Probe host used for socket checks even when uvicorn binds 0.0.0.0."""
    return "127.0.0.1" if host in ("0.0.0.0", "", "::") else host


class AlreadyRunning(RuntimeError):
    """A live backend (or unrelated process) already owns the target port."""

    def __init__(self, message: str, *, pid: int | None = None, healthy: bool = False,
                 kind: str = "backend"):
        super().__init__(message)
        self.pid = pid
        self.healthy = healthy
        self.kind = kind


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _mutex_name(port: int) -> str:
    """Cross-platform lock name derived from the port (safe charset)."""
    token = f"kaustubh-backend-singleton-{port}".encode("utf-8")
    return hashlib.sha1(token).hexdigest()


# ----------------------------------------------------------------------------
# Port preflight (psutil preferred; pure-stdlib fallback)
# ----------------------------------------------------------------------------
def _port_accepts_tcp(host: str, port: int, timeout: float = 0.75) -> bool:
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            return True
        finally:
            s.close()
    except OSError:
        return False


def _probe_health(host: str, port: int, timeout: float = 2.0) -> bool:
    import http.client
    try:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        try:
            conn.request("GET", "/health")
            resp = conn.getresponse()
            return resp.status == 200
        finally:
            conn.close()
    except Exception:
        return False


def _psutil_listener(port: int):
    """Return a dict for the LISTENING socket on ``port`` or None (needs psutil)."""
    try:
        import psutil
    except ImportError:
        return None
    try:
        for conn in psutil.net_connections(kind="tcp"):
            if conn.status == "LISTEN" and getattr(conn.laddr, "port", None) == port:
                return conn
    except Exception:
        return None
    return None


def _process_is_backend(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        import psutil
        proc = psutil.Process(pid)
        cl = " ".join(proc.cmdline() or [])
        name = (proc.name() or "").lower()
    except Exception:
        return False
    if "python" not in name:
        return False
    return "uvicorn" in cl or "start_backend" in cl


def port_listener_info(port: int, host: str = "127.0.0.1") -> dict[str, Any] | None:
    """Identify the current owner of ``port``.

    Returns None when nobody is listening. Otherwise:
      {pid, is_backend, healthy} where ``healthy`` is only meaningful for a
    backend owner. When psutil is missing, ``pid``/``is_backend`` are None and
    the caller must treat any listener as "occupied".
    """
    conn = _psutil_listener(port)
    if conn is not None:
        pid = conn.pid
        is_backend = _process_is_backend(pid)
        healthy = _probe_health(host, port) if is_backend else False
        return {"pid": pid, "is_backend": is_backend, "healthy": healthy}
    # stdlib fallback: can detect occupancy but not identity.
    if _port_accepts_tcp(host, port):
        healthy = _probe_health(host, port)
        return {"pid": None, "is_backend": None, "healthy": healthy}
    return None


# ----------------------------------------------------------------------------
# Runtime state + pid bookkeeping (advisory; the kernel mutex is authoritative)
# ----------------------------------------------------------------------------
class _RuntimeBookkeeping:
    def __init__(self, runtime_dir: Path, port: int, host: str):
        self._dir = Path(runtime_dir)
        self._port = port
        self._host = host
        self._pid_file = self._dir / "backend.pid"
        self._state_file = self._dir / "backend.state"

    def _encode(self, state: str) -> dict[str, Any]:
        return {
            "pid": os.getpid(),
            "port": self._port,
            "host": self._host,
            "instance_id": os.getpid(),
            "state": state,
            "updated_at_utc": _now_iso(),
        }

    def write_starting(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        payload = self._encode(STATE_STARTING)
        self._pid_file.write_text(json.dumps(payload), encoding="utf-8")
        self._state_file.write_text(json.dumps(payload), encoding="utf-8")

    def write_state(self, state: str) -> None:
        if state not in _ALL_STATES:
            raise ValueError(state)
        self._dir.mkdir(parents=True, exist_ok=True)
        payload = self._encode(state)
        try:
            self._pid_file.write_text(json.dumps(payload), encoding="utf-8")
            self._state_file.write_text(json.dumps(payload), encoding="utf-8")
        except OSError:
            pass

    def clear_stopped(self) -> None:
        self.write_state(STATE_STOPPED)
        try:
            if self._pid_file.exists():
                self._pid_file.unlink()  # type: ignore[attr-defined]
        except OSError:
            pass


def read_pid_file(runtime_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((Path(runtime_dir) / "backend.pid").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def read_state_file(runtime_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((Path(runtime_dir) / "backend.state").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


# ----------------------------------------------------------------------------
# The guard
# ----------------------------------------------------------------------------
class SingleInstanceGuard:
    """Held by the singleton backend process. ``release()`` on clean exit."""

    def __init__(self, runtime_dir: Path, port: int, host: str, handle):
        self._runtime_dir = Path(runtime_dir)
        self._port = port
        self._host = host
        self._handle = handle
        self._released = False
        self._bookkeeping = _RuntimeBookkeeping(self._runtime_dir, port, host)
        self._bookkeeping.write_starting()

    @property
    def pid(self) -> int:
        return os.getpid()

    def mark(self, state: str) -> None:
        if not self._released:
            self._bookkeeping.write_state(state)

    def hello(self) -> None:
        """Called AFTER the event loop has bound the port (READY only then)."""
        self.mark(STATE_READY)

    def degrade(self, reason: str) -> None:
        if not self._released:
            self.mark(STATE_DEGRADED)
            try:
                (self._runtime_dir / "degraded.txt").write_text(
                    _now_iso() + " " + reason + "\n", encoding="utf-8"
                )
            except OSError:
                pass

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._bookkeeping.clear_stopped()
        if _IS_WINDOWS:
            try:
                ctypes.windll.kernel32.CloseHandle(self._handle)  # release OS singleton
            except Exception:
                pass
        else:
            try:
                self._handle.close()
            except Exception:
                pass


_ACQUIRED_GUARD: SingleInstanceGuard | None = None


def get_guard() -> SingleInstanceGuard | None:
    """The in-process guard (None when not the singleton owner in this process)."""
    return _ACQUIRED_GUARD


def mark_state(state: str) -> None:
    g = _ACQUIRED_GUARD
    if g is not None:
        g.mark(state)


def acquire(runtime_dir: Path, port: int, host: str = "127.0.0.1",
            *, strict_health: bool = True) -> SingleInstanceGuard:
    """Acquire the backend singleton slot or raise :class:`AlreadyRunning`.

    Call from the launcher BEFORE starting uvicorn. Holds a kernel mutex for
    process lifetime; the OS releases it automatically on any exit.
    """
    global _ACQUIRED_GUARD
    if _ACQUIRED_GUARD is not None:
        return _ACQUIRED_GUARD

    # 1) Preflight: is something already listening?
    probe = probe_host(host)
    info = port_listener_info(port, probe)
    if info:
        if info["is_backend"] is True:
            raise AlreadyRunning(
                f"Backend already running (pid={info['pid']}) on {host}:{port} "
                f"— healthy via /health={info['healthy']}",
                pid=info["pid"], healthy=bool(info["healthy"] or not strict_health),
            )
        if info["is_backend"] is False:
            raise AlreadyRunning(
                f"Port {host}:{port} is occupied by an unrelated process "
                f"(pid={info['pid']}) — not starting to avoid a conflict.",
                pid=info["pid"], healthy=False, kind="conflict",
            )
        raise AlreadyRunning(
            f"Port {host}:{port} is already in use — someone is listening "
            f"(identifiable owner not available).",
            pid=None, healthy=bool(info["healthy"] and not strict_health), kind="unidentified",
        )

    # 2) Kernel single-instance lock.
    # On Windows: named kernel mutex (crash-safe — OS releases on process death).
    # On Linux: fcntl.flock on a lock file (crash-safe — kernel releases on process death).
    if _IS_WINDOWS:
        handle = ctypes.windll.kernel32.CreateMutexW(None, False, _mutex_name(port))
        if not handle:
            raise RuntimeError("CreateMutex failed — cannot enforce single-instance backend")
        result = ctypes.windll.kernel32.WaitForSingleObject(handle, 0)
        if result == WAIT_ABANDONED or result == WAIT_OBJECT_0:
            pass  # we now own the lock (fresh or reclaimed after a crash)
        elif result == WAIT_TIMEOUT:
            ctypes.windll.kernel32.CloseHandle(handle)
            raise AlreadyRunning(
                f"Backend already starting (another process owns the singleton "
                f"lock on port {port})",
                pid=None, healthy=False,
            )
        else:
            ctypes.windll.kernel32.CloseHandle(handle)
            raise RuntimeError(
                f"WaitForSingleObject failed (0x{result:X}) while guarding port {port}"
            )
    else:
        lock_path = Path(runtime_dir) / f"backend-singleton-{port}.lock"
        handle = open(lock_path, "w")
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            handle.close()
            raise AlreadyRunning(
                f"Backend already starting (another process owns the singleton "
                f"lock on port {port})",
                pid=None, healthy=False,
            )

    _ACQUIRED_GUARD = SingleInstanceGuard(runtime_dir, port, host, handle)
    return _ACQUIRED_GUARD


def is_running(runtime_dir: Path, port: int, host: str = "127.0.0.1") -> bool:
    try:
        acquire(runtime_dir, port, host, strict_health=True)
    except AlreadyRunning:
        return True
    except Exception:
        return True
    else:
        return False