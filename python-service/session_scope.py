"""Watch-list session scoping helper.

Provides a stable logical session/user id for scoping Watch List entries.
The Data Saver workspace is a single-user local app, so we derive a stable id
from the session manager (when a broker session identity is available) with a
deterministic fallback. Returns the same id across requests for the same
install so the Watch List persists across logout/login.
"""
from __future__ import annotations

import os
import uuid


def get_or_create_session_id() -> str:
    """A stable id (per install) used to scope Watch List entries.

    Prefers an env-provided identity; otherwise a deterministic id derived from
    the machine so a user's Watch List survives logout/login and restarts.
    """
    env_id = os.getenv("WATCHLIST_SCOPE_ID", "").strip()
    if env_id:
        return env_id

    # Deterministic per-install scope (same machine -> same Watch List).
    try:
        import socket
        hostname = socket.gethostname() or "local"
    except Exception:
        hostname = "local"
    stable = f"data-saver:{hostname}"
    try:
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, stable))
    except Exception:
        return "data-saver:default"
