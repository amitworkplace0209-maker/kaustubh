"""Encrypted at-rest store for broker SESSION material.

Why
---
Shoonya's OAuth handshake yields a bearer token (``access_token``) plus the
broker's ``susertoken``. To make the terminal AUTO-LOGIN possible — a restart
or a terminal switch must not need a browser — that material has to survive a
restart, and it must never sit on disk in the clear: it IS the account.

The blob is encrypted with Fernet (AES-128-CBC + HMAC-SHA256) before it
touches the disk. The key is resolved in this order:

1. ``TERMINAL_CREDENTIAL_KEY`` — a base64 Fernet key (32 urlsafe bytes).
2. ``JWT_SECRET`` — the key is then derived as ``SHA-256(secret)`` so the
   existing app secret protects the file without any new setup.
3. A key file under ``runtime/`` — generated once, written with owner-only
   permissions, and git-ignored.

Nothing in this module is ever logged, returned by an API route, or written to
the database. The only public surface is: save / load / clear / has.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import stat
from pathlib import Path
from typing import Any

from config.settings import settings

_log = logging.getLogger("terminal_credentials")

RUNTIME_DIR = Path(__file__).resolve().parent.parent / "runtime"
STORE_PATH = RUNTIME_DIR / "terminal_credentials.json"
KEY_PATH = RUNTIME_DIR / "terminal_credential.key"

#: Terminals whose session material may be stored.
STORED_TERMINALS = ("shoonya",)


def _fernet():
    """Build a Fernet instance for the current key material."""
    from cryptography.fernet import Fernet

    key: bytes | None = None
    explicit = (os.environ.get("TERMINAL_CREDENTIAL_KEY") or "").strip()
    if explicit:
        try:
            key = base64.urlsafe_b64decode(explicit.encode())
        except Exception:
            _log.error("TERMINAL_CREDENTIAL_KEY is not a valid base64 Fernet key")
            return None
    elif (settings.jwt_secret or "").strip():
        key = hashlib.sha256(settings.jwt_secret.encode()).digest()

    if key is None:
        key = _load_or_create_key()
    if not key:
        return None
    try:
        return Fernet(base64.urlsafe_b64encode(key))
    except Exception:
        return None


def _load_or_create_key() -> bytes | None:
    """Read (or create once) the local key file."""
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        if KEY_PATH.exists():
            return base64.urlsafe_b64decode(KEY_PATH.read_text(encoding="utf-8").strip().encode())
        raw = os.urandom(32)
        encoded = base64.urlsafe_b64encode(raw)
        KEY_PATH.write_text(encoded.decode(), encoding="utf-8")
        try:
            os.chmod(KEY_PATH, stat.S_IRUSR | stat.S_IWUSR)
        except Exception:
            pass
        _log.info("TERMINAL_CREDENTIAL_KEY generated at %s (owner-only)", KEY_PATH)
        return raw
    except Exception as exc:
        _log.error("could not prepare the terminal credential key: %s", exc)
        return None


def _read_store() -> dict[str, str]:
    try:
        path = Path(STORE_PATH)
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_store(store: dict[str, str]) -> bool:
    try:
        path = Path(STORE_PATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(store, indent=2), encoding="utf-8")
        tmp.replace(path)
        try:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        except Exception:
            pass
        return True
    except Exception as exc:
        _log.error("could not write the terminal credential store: %s", exc)
        return False


def save_session_material(terminal: str, material: dict[str, Any]) -> bool:
    """Encrypt and persist a terminal's session material.

    ``material`` may contain any of: access_token, susertoken, user_id,
    account_id, refresh_token, expires_at. Nothing else is stored, and the
    values are never logged.
    """
    term = (terminal or "").lower()
    if term not in STORED_TERMINALS or not material:
        return False
    fernet = _fernet()
    if fernet is None:
        return False
    allowed = {
        k: v
        for k, v in material.items()
        if k in {"access_token", "susertoken", "user_id", "account_id", "refresh_token", "expires_at"}
        and v not in (None, "")
    }
    if not allowed:
        return False
    try:
        blob = fernet.encrypt(json.dumps(allowed).encode()).decode()
    except Exception as exc:
        _log.error("could not encrypt the %s session material: %s", term, exc)
        return False
    store = _read_store()
    store[term] = blob
    ok = _write_store(store)
    if ok:
        _log.info("TERMINAL_SESSION_MATERIAL_SAVED terminal=%s fields=%s", term, sorted(allowed))
    return ok


def load_session_material(terminal: str) -> dict[str, Any] | None:
    """Decrypt and return a terminal's stored session material (or None)."""
    term = (terminal or "").lower()
    blob = _read_store().get(term)
    if not blob:
        return None
    fernet = _fernet()
    if fernet is None:
        return None
    try:
        raw = fernet.decrypt(blob.encode())
        data = json.loads(raw.decode())
        return data if isinstance(data, dict) else None
    except Exception:
        _log.warning("TERMINAL_SESSION_MATERIAL_UNREADABLE terminal=%s (re-auth needed)", term)
        return None


def clear_session_material(terminal: str) -> bool:
    term = (terminal or "").lower()
    store = _read_store()
    if term not in store:
        return False
    store.pop(term, None)
    return _write_store(store)


def has_session_material(terminal: str) -> bool:
    return bool(_read_store().get((terminal or "").lower()))
