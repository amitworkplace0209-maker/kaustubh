"""Auto-heal supervisor for the KAUSTUBH FastAPI backend on Windows.

Why
---
The backend occasionally loses its HTTP listener while the process keeps
running. On a transient network-stack hiccup Windows reports ``WinError 64
(The specified network name is no longer available)``; uvicorn/asyncio then
stops answering new connections (asyncio "Accept failed on a socket"), but the
web app engines keep logging as if healthy and ``runtime/backend.state`` stays
READY. Every new HTTP request is refused -> the trading page looks broken
(blank search, no data) even though "the backend is running".

Start/stop alone cannot fix that (a watchdog that only restarts after the
process exits never fires), so this supervisor:

  1. polls ``GET /health`` every few seconds,
  2. adopts an already-healthy backend (no duplicate instance), and
  3. when the probe starts failing while the process is alive (listener dead),
     force-kills the backend and launches a fresh one via ``start_backend.py``.

Launcher: ``run_backend_watchdog.cmd``  (stdlib only, Windows).
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DIR = Path(__file__).resolve().parent
HEALTH_URL = "http://127.0.0.1:8000/health"
PIDFILE = DIR / "runtime" / "backend.pid"
CHILD_LOG = DIR / "watchdog_child.log"

CHECK_EVERY = 5            # probe interval (s)
PROBE_TIMEOUT = 4          # single health request timeout (s)
KILL_AFTER_FAILS = 3       # consecutive failed probes before killing
# Grace period before the watchdog may kill a backend it just started.
#
# It was 45 s, which is SHORTER than a cold start on this machine: the app
# binds the port first, then the lifespan boots MongoDB, the instrument master
# (2 685 instruments), the session manager, the tick buffer and every engine
# before `/health` answers — measured at ~100-140 s on a warm MongoDB and
# longer with a cold cache. A 45 s grace therefore turned every cold start
# into a kill-and-restart loop: the watchdog killed a backend that was still
# booting, the operator was left with a permanently dead backend, and every
# page (the trade page included) answered "Internal Server Error".
#
# 240 s covers a full cold start with margin. The watchdog still reacts to the
# real failure mode it exists for — a process that is alive but has lost its
# listener — because that case is detected long after the grace period.
GRACE_AFTER_START = 240    # don't kill during startup/slow-feed warmup (s)
CRASH_LOOP_WINDOW = 20     # a child alive shorter than this counts as a crash
CRASH_LOOP_MAX = 3         # repeated quick exits trigger a longer backoff
LONG_BACKOFF = 20          # extra sleep after repeated startup crashes

LOG = print


def stamp() -> str:
    return time.strftime("%H:%M:%S")


def log(msg: str) -> None:
    LOG(f"{stamp()} [watchdog] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------
def health_ok() -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=PROBE_TIMEOUT) as r:
            if r.status == 200:
                payload = json.loads(r.read().decode("utf-8"))
                return bool(payload.get("ok")) and bool(payload.get("status") == "ok")
        return False
    except Exception:
        return False


def pidfile_pid() -> int | None:
    try:
        data = json.loads(PIDFILE.read_text(encoding="utf-8"))
        return int(data["pid"])
    except Exception:
        return None


def kill_pid(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        r = subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            capture_output=True, text=True, timeout=20,
        )
        return r.returncode == 0 or "not found" in (r.stderr or "").lower()
    except Exception:
        return False


def graceful_stop() -> bool:
    """Best-effort ``start_backend.py stop`` (only touches a verified backend)."""
    try:
        r = subprocess.run(
            [sys.executable, "start_backend.py", "stop"],
            cwd=str(DIR), capture_output=True, text=True, timeout=60,
        )
        log("graceful stop -> " + (r.stdout + r.stderr).strip().replace("\n", " | ")[:300])
        return r.returncode == 0
    except Exception as exc:
        log(f"graceful stop failed: {exc}")
        return False


class Watchdog:
    def __init__(self) -> None:
        self.child: subprocess.Popen | None = None
        self.started_at = 0.0
        self.fails = 0
        self.quick_exits = 0
        self.adopted = False

    # -- process management -------------------------------------------------
    def launch(self) -> None:
        log(f"launching backend via start_backend.py (python={sys.executable})")
        logf = open(CHILD_LOG, "a", encoding="utf-8", buffering=1)
        try:
            self.child = subprocess.Popen(
                [sys.executable, "start_backend.py", "run"],
                cwd=str(DIR),
                stdout=logf,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as exc:
            log(f"launch failed: {exc}")
            self.child = None
            logf.close()
            return
        self.started_at = time.time()
        self.fails = 0

    def kill_zombie(self) -> None:
        """Take back the port + singleton from a dead-listener stale process."""
        graceful_stop()
        pid = pidfile_pid()
        if pid:
            log(f"force-killing stale backend pid={pid}")
            kill_pid(pid)
            time.sleep(3)

    def ensure_backend(self) -> str:
        """Returns 'ok' | 'started' | 'restarting'."""
        if self.child is not None:
            rc = self.child.poll()
            if rc is None:
                return "ok"
            self.child = None
            # The launcher exits 0 (and 2) when a healthy backend already owns
            # the port — "BACKEND ALREADY RUNNING ... refusing to start a
            # duplicate instance". Re-launching in that case is an infinite
            # loop: every relaunch exits immediately, forever, while the
            # healthy instance keeps serving. So the health probe decides
            # first: if something healthy is serving, ADOPT it.
            if health_ok():
                self.adopted = True
                log(f"child exited rc={rc} but a healthy backend is serving -> adopting it")
                return "ok"
            self.quick_exits += 1
            log(f"backend exited rc={rc}")
            time.sleep(3)
            if self.quick_exits >= CRASH_LOOP_MAX:
                log(f"{CRASH_LOOP_MAX} rapid exits -> backoff {LONG_BACKOFF}s")
                self.quick_exits = 0
                time.sleep(LONG_BACKOFF)
            self.launch()
            return "started"
        if health_ok():
            if not self.adopted:
                self.adopted = True
                log(f"adopting already-healthy backend (pid={pidfile_pid()})")
            return "ok"
        # No child and no healthy backend: either a zombie holds the singleton,
        # or nothing ever ran. Clear stale holders, then start fresh.
        self.kill_zombie()
        time.sleep(2)
        self.launch()
        return "started"

    # -- health loop --------------------------------------------------------
    def run(self) -> None:
        log("watchdog online: probes GET /health every %ds" % CHECK_EVERY)
        while True:
            try:
                state = self.ensure_backend()
                if state not in ("ok",):
                    continue
                since = time.time() - self.started_at if self.child is not None else 0.0
                if health_ok():
                    self.fails = 0
                    self.quick_exits = 0
                    continue
                self.fails += 1
                cur = pidfile_pid() if self.child is None else self.child.pid
                log(f"health probe failed #{self.fails} (pid={cur})")
                if self.fails >= KILL_AFTER_FAILS and since > GRACE_AFTER_START:
                    log("LISTENER DEAD after %s consecutive probe failures -> killing %s"
                        % (self.fails, cur if cur else "(adopted)"))
                    # Kill whatever represents the backend: our child or the zombie.
                    if self.child is not None:
                        kill_pid(self.child.pid)
                    self.child = None
                    self.kill_zombie()
                    time.sleep(3)
                    self.launch()
            except Exception as exc:  # keep the supervisor alive at all costs
                log(f"loop error: {exc}")
            time.sleep(CHECK_EVERY)


if __name__ == "__main__":
    try:
        Watchdog().run()
    except KeyboardInterrupt:
        log("watchdog stopped")
        sys.exit(0)