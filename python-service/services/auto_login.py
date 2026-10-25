"""Terminal-aware AUTO-LOGIN.

Every terminal obtains a session in its own way, and only one of them needs a
human:

===========  ==========================================================  =========
terminal     how the session is obtained                                 human?
===========  ==========================================================  =========
``kotak``    TOTP (time-based one-time password) + MPIN, both held by the  no
             backend. The SDK call is ``kotak_session.login()``.
``dummy``    a managed paper session — there is no broker to call.        no
``shoonya``  OAuth. The Noren SDK has NO password/TOTP login, so the      once
             FIRST session needs the browser handshake. Afterwards the
             bearer token is stored ENCRYPTED and every later start
             restores it (``ShoonyaAdapter.restore_session()``).
===========  ==========================================================  =========

This module is the ONE entry point. The app startup, the terminal switch and
the scheduler all call :func:`auto_login`, so a terminal can never be left
without the session it is able to obtain on its own.

Nothing here ever logs a secret: the result carries only a method name, a
message and (for Shoonya) the OAuth URL the operator has to open.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

_log = logging.getLogger("auto_login")

#: How long a terminal's login may take before it is abandoned.
LOGIN_TIMEOUT_S = 45.0


@dataclass
class AutoLoginResult:
    """The honest outcome of an auto-login attempt."""

    ok: bool
    terminal: str
    #: "totp" | "managed" | "oauth_restore" | "none"
    method: str = "none"
    #: Set when a human step is required ("oauth_handshake").
    requires: str | None = None
    #: The URL the operator must open (Shoonya OAuth only).
    oauth_url: str | None = None
    message: str = ""
    detail: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "terminal": self.terminal,
            "method": self.method,
            "requires": self.requires,
            "oauthUrl": self.oauth_url,
            "message": self.message,
            "detail": self.detail,
        }


async def _auto_login_kotak(register_central: bool) -> AutoLoginResult:
    """TOTP + MPIN — fully automatic, the backend holds both secrets."""
    try:
        from auth.kotak_client import kotak_session
    except Exception as exc:  # pragma: no cover
        return AutoLoginResult(False, "kotak", detail=str(exc))

    if kotak_session.session_active:
        return AutoLoginResult(True, "kotak", method="totp", message="Kotak session already active")
    try:
        ok = await asyncio.wait_for(
            asyncio.to_thread(kotak_session.login, source="auto"), timeout=LOGIN_TIMEOUT_S
        )
    except asyncio.TimeoutError:
        return AutoLoginResult(
            False, "kotak", method="totp",
            message=f"Kotak login timed out after {LOGIN_TIMEOUT_S:g}s",
        )
    except Exception as exc:
        return AutoLoginResult(False, "kotak", method="totp", message="Kotak login failed", detail=str(exc))

    if not ok or not kotak_session.session_active:
        return AutoLoginResult(
            False, "kotak", method="totp", message="Kotak login did not establish a session"
        )
    return AutoLoginResult(True, "kotak", method="totp", message="Kotak session established")


async def _auto_login_dummy(register_central: bool) -> AutoLoginResult:
    """The paper engine has no broker — the session is managed locally."""
    try:
        from services.session.session_manager import session_manager

        session_manager.register_terminal_login(
            "dummy", broker="Dummy Mode", user_id="KAUSTUBH_DUMMY",
            session_ref="dummy-managed-session", login_source="AUTO",
            state_message="managed paper session",
        )
    except Exception as exc:  # pragma: no cover
        return AutoLoginResult(False, "dummy", method="managed", detail=str(exc))
    return AutoLoginResult(True, "dummy", method="managed", message="Dummy paper session ready")


async def _auto_login_shoonya(register_central: bool) -> AutoLoginResult:
    """Restore the stored OAuth session, or report that a handshake is needed."""
    try:
        from brokers.shoonya_adapter import shoonya_adapter
    except Exception as exc:  # pragma: no cover
        return AutoLoginResult(False, "shoonya", detail=str(exc))

    if shoonya_adapter.is_logged_in:
        return AutoLoginResult(True, "shoonya", method="oauth_restore", message="Shoonya session already active")
    if not shoonya_adapter.enabled:
        return AutoLoginResult(
            False, "shoonya", method="none",
            message=(
                "Shoonya is not enabled — set SHOONYA_ENABLED=1 and fill the SHOONYA_* "
                "secrets in the backend .env"
            ),
        )
    try:
        restored = await shoonya_adapter.restore_session(register_central=register_central)
    except Exception as exc:
        return AutoLoginResult(False, "shoonya", method="oauth_restore", detail=str(exc))

    if restored:
        return AutoLoginResult(
            True, "shoonya", method="oauth_restore", message="Shoonya session restored"
        )

    # No usable stored session — the operator has to complete the handshake.
    oauth_url = None
    try:
        oauth_url = shoonya_adapter.oauth_url()
    except Exception:
        oauth_url = None
    return AutoLoginResult(
        False, "shoonya", method="none", requires="oauth_handshake",
        oauth_url=oauth_url,
        message=(
            "Shoonya needs its one-time OAuth handshake: open the link, approve the "
            "app, and paste the returned code. After that the session is stored "
            "encrypted and every later start is automatic."
        ),
    )


async def auto_login(
    terminal: str,
    *,
    source: str = "auto",
    register_central: bool = True,
) -> AutoLoginResult:
    """Obtain a session for ``terminal`` the way THAT terminal can obtain it."""
    term = (terminal or "").lower()
    if term == "kotak":
        return await _auto_login_kotak(register_central)
    if term == "dummy":
        return await _auto_login_dummy(register_central)
    if term == "shoonya":
        return await _auto_login_shoonya(register_central)
    return AutoLoginResult(False, term, method="none", message=f"unknown terminal: {term}")


async def auto_login_active_terminal(
    *, source: str = "auto", register_central: bool = True
) -> AutoLoginResult:
    """Auto-login for whichever terminal is ACTIVE right now."""
    try:
        from brokers.manager import active_terminal

        terminal = active_terminal()
    except Exception as exc:  # pragma: no cover
        return AutoLoginResult(False, "unknown", method="none", detail=str(exc))
    result = await auto_login(terminal, source=source, register_central=register_central)
    _log.info(
        "AUTO_LOGIN terminal=%s method=%s ok=%s%s",
        result.terminal, result.method, result.ok,
        f" requires={result.requires}" if result.requires else "",
    )
    return result
