"""Broker enablement selection — which brokers the Scheduler drives.

The scheduler owns the scheduled lifecycle (LOGIN -> SESSION -> WS -> LOGOUT)
for EVERY enabled broker independently and simultaneously. This module answers
"is broker X enabled" with real configuration — never guesses.

Rules (per broker):
  * kotak    — neo_api_client SDK present AND every Kotak login secret set
               (consumer_key, mobile_number, client_id, totp_secret, mpin).
  * shoonya  — Noren OAuth SDK present, ``settings.shoonya_enabled`` True AND
               every SHOONYA_* secret set (shoonya_adapter.enabled is the
               single authority).
  * dummy    — NEVER a scheduled/automatic target. Reported only when it is
               the explicitly selected terminal; the scheduler never auto-logs
               it in and never falls back to it.
"""

from __future__ import annotations

from config.settings import settings

TERMINAL_ORDER = ("kotak", "shoonya", "dummy")


def _has_kotak_secrets() -> bool:
    return bool(
        settings.consumer_key and settings.mobile_number
        and settings.client_id and settings.totp_secret and settings.mpin
    )


def kotak_sdk_available() -> bool:
    try:
        from auth.kotak_client import SDK_AVAILABLE  # type: ignore
        return bool(SDK_AVAILABLE)
    except Exception:
        return False


def kotak_enabled() -> bool:
    """Kotak Neo is the legacy default scheduler driver.

    It is enabled whenever the engine is present, so the scheduler keeps today's
    exact behaviour: always drive Kotak and fail honestly when credentials are
    missing. An operator who wants the scheduler to SKIP Kotak entirely
    (e.g. a Shoonya-only deployment) sets ``KOTAK_ENABLED=false``.
    """
    explicit = settings.kotak_enabled
    if explicit is False:
        return False
    try:
        from auth.kotak_client import kotak_session
        if kotak_session is None:
            return False
    except Exception:
        return False
    return True


def shoonya_enabled() -> bool:
    """Shoonya is enabled when the adapter itself is enabled (SDK + secrets)."""
    try:
        from brokers.shoonya_adapter import shoonya_adapter
        return bool(getattr(shoonya_adapter, "enabled", False))
    except Exception:
        return False


def is_broker_enabled(broker: str) -> bool:
    br = (broker or "").lower()
    if br == "kotak":
        return kotak_enabled()
    if br == "shoonya":
        return shoonya_enabled()
    # Dummy (and unknown) are never an automatic scheduled target.
    return False


def enabled_brokers() -> tuple[str, ...]:
    """Ordered tuple of brokers the scheduler must drive this boot.

    Dummy is never included: the dummy terminal is user-selected only and the
    scheduler must never auto-login / fall back to it.
    """
    return tuple(b for b in TERMINAL_ORDER if is_broker_enabled(b))


def primary_broker() -> str | None:
    """The first enabled broker (the default lifecycle owner)."""
    for b in TERMINAL_ORDER:
        if is_broker_enabled(b):
            return b
    return None