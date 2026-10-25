"""BrokerManager — selects and exposes the ONE active broker adapter.

Three first-class terminals exist: Kotak Neo, Shoonya and Dummy. The manager
maps a terminal id to its BrokerAdapter and routes all Common Trading Core
calls through the ACTIVE adapter only. Session ownership lives in
``services.session.session_manager``; each adapter owns its broker session.

Terminal switching is an isolated CONTEXT SWITCH — it does NOT logout /
disconnect / destroy the previously selected terminal's session. Each
terminal keeps its own independent session record (dummy/kotak/shoonya) and
is restored when the user switches back. Only an explicit logout or real
broker-session expiry terminates a terminal session.
"""
from __future__ import annotations
import logging
from typing import Any

from config.settings import settings
from services.session.session_manager import session_manager

_log = logging.getLogger("broker_manager")

TERMINALS = ("kotak", "shoonya", "dummy")
_BROKER_NAMES = {"kotak": "Kotak Neo", "shoonya": "Shoonya", "dummy": "Dummy Mode"}

_ADAPTERS: dict[str, Any] = {}


def _ensure_adapters() -> None:
    if _ADAPTERS:
        return
    from brokers.dummy import dummy_adapter
    from brokers.shoonya_adapter import shoonya_adapter
    from auth.kotak_client import kotak_session
    from brokers.kotak_adapter import KotakAdapter
    _ADAPTERS["dummy"] = dummy_adapter
    _ADAPTERS["shoonya"] = shoonya_adapter
    _ADAPTERS["kotak"] = KotakAdapter(kotak_session)


def active_terminal() -> str:
    """The terminal the trading context is currently switched to.

    Resolution order (single authoritative mode):
      1. live central session mode (set by an explicit terminal switch);
      2. persisted ``terminal_mode`` setting (restored across restarts);
      3. env ``settings.broker_mode``.
    """
    session_mode = session_manager.snapshot().get("mode")
    if session_mode in TERMINALS:
        return session_mode
    try:
        from services.runtime_settings import get_runtime_setting
        persisted = get_runtime_setting("terminal_mode")
        if persisted in TERMINALS:
            return str(persisted)
    except Exception:
        pass
    mode = (settings.broker_mode or "kotak").lower()
    return mode if mode in TERMINALS else "kotak"


def get_adapter(terminal: str) -> Any:
    _ensure_adapters()
    term = (terminal or "").lower()
    if term not in TERMINALS:
        raise ValueError(f"Unknown terminal: {terminal!r}")
    return _ADAPTERS[term]


def get_active_adapter() -> Any:
    return get_adapter(active_terminal())


async def switch_terminal(mode: str) -> dict:
    """Switch the active terminal — a pure context switch.

    NEVER logs out or invalidates the previous terminal's session: only the
    ACTIVE CONTEXT changes, and the session manager restores the target
    terminal's record into the active view. Switching back later restores
    the previous terminal's session state. Explicit logout or real broker
    expiry are the ONLY things that terminate a terminal session.
    """
    mode = (mode or "").lower()
    if mode not in TERMINALS:
        raise ValueError("mode must be one of kotak|shoonya|dummy")

    current = active_terminal()
    if current == mode:
        return {
            "ok": True,
            "mode": mode,
            "message": "Already active",
            "changed": False,
        }

    # Pure context switch: set_mode restores the target terminal's session
    # record (from a prior login) into the active view, and moves the current
    # terminal's view to its record. Neither the adapter's broker session nor
    # the WebSocket feed are touched — only the identity changes.
    session_manager.set_mode(mode, broker=_BROKER_NAMES.get(mode, mode))

    _log.info("TERMINAL_SWITCH %s -> %s", current, mode)

    # The new terminal's session is obtained AUTOMATICALLY (Kotak: TOTP+MPIN,
    # Dummy: managed paper session, Shoonya: the stored OAuth session). A
    # failure never fails the switch — the terminal is simply "not connected
    # yet" and the UI shows that state honestly.
    _schedule_auto_login(mode)
    return {
        "ok": True,
        "mode": mode,
        "broker": _BROKER_NAMES.get(mode, mode),
        "current": current,
        "message": f"Terminal switched to {mode}",
        "changed": True,
    }


#: Background auto-login tasks, kept referenced so they are not garbage
#: collected mid-flight.
_AUTO_LOGIN_TASKS: set[Any] = set()


def _schedule_auto_login(terminal: str) -> None:
    """Kick the terminal's auto-login in the background (never blocks a switch)."""
    try:
        import asyncio

        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    try:
        from services.auto_login import auto_login
    except Exception as exc:  # pragma: no cover
        _log.warning("auto-login unavailable after the terminal switch: %s", exc)
        return

    async def _run() -> None:
        try:
            result = await auto_login(terminal, source="terminal_switch")
            if result.ok:
                _log.info(
                    "AUTO_LOGIN after switch terminal=%s method=%s ok",
                    terminal, result.method,
                )
            else:
                _log.info(
                    "AUTO_LOGIN after switch terminal=%s not connected: %s%s",
                    terminal, result.message,
                    f" (requires {result.requires})" if result.requires else "",
                )
        except Exception as exc:  # pragma: no cover
            _log.warning("auto-login failed for terminal=%s: %s", terminal, exc)

    try:
        task = loop.create_task(_run())
    except Exception as exc:  # pragma: no cover
        _log.warning("could not schedule the auto-login for %s: %s", terminal, exc)
        return
    _AUTO_LOGIN_TASKS.add(task)
    task.add_done_callback(_AUTO_LOGIN_TASKS.discard)


def active_mode() -> str:
    return active_terminal()


def register_mode_broker(mode: str, broker: str) -> None:
    session_manager.set_mode(mode, broker=broker)


def is_dummy_mode() -> bool:
    return active_terminal() == "dummy"


def required_user_id() -> str:
    term = active_terminal()
    if term == "dummy":
        return "KAUSTUBH_DUMMY"
    if term == "shoonya":
        return str(settings.shoonya_user_id or "SHOONYA_USER")
    return "KOTAK_NEO"