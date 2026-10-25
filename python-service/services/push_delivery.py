"""Web Push (PWA) delivery — the server half of ``lib/push-notifications``.

Subscriptions are stored in Mongo ``push_subscriptions`` (upsert by endpoint).
``fanout_push`` is best-effort and never raises into the notify path: dead
endpoints (404/410) are pruned, everything else is logged and skipped.

Payload shape matches ``public/sw.js::normalizeNotification`` exactly:
``{kind, symbol, side, price, orderId, title, body, url}`` — the service worker
renders Buy/Sell/Target/StopLoss/PriceAlert titles from these fields.
"""
from __future__ import annotations

import base64
import json as _json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("app")

COLLECTION = "push_subscriptions"

_AUTH_DIR = Path(os.getcwd()) / ".auth"
_VAPID_FILE = _AUTH_DIR / "vapid.json"


def _load_or_create_vapid() -> tuple[str, str]:
    """Return (public_raw_b64url, private_raw_b64url), generating+persisting on first use.

    Env vars (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) take precedence so deployments
    can inject their own. Otherwise keys are generated once and stored in
    ``.auth/vapid.json`` so every restart reuses the same keypair (a changed key
    would invalidate all existing browser subscriptions).
    """
    pub_env = (os.getenv("VAPID_PUBLIC_KEY") or "").strip()
    priv_env = (os.getenv("VAPID_PRIVATE_KEY") or "").strip()
    if pub_env and priv_env:
        return pub_env, priv_env
    try:
        if _VAPID_FILE.exists():
            data = _json.loads(_VAPID_FILE.read_text(encoding="utf-8"))
            if data.get("public") and data.get("private"):
                return str(data["public"]), str(data["private"])
    except Exception as exc:  # noqa: BLE001
        logger.debug("[PUSH] could not read vapid file: %s", exc)
    try:
        from cryptography.hazmat.primitives.asymmetric import ec

        key = ec.generate_private_key(ec.SECP256R1())
        priv_raw = key.private_numbers().private_value.to_bytes(32, "big")
        pub = key.public_key().public_numbers()
        pub_raw = b"\x04" + pub.x.to_bytes(32, "big") + pub.y.to_bytes(32, "big")
        priv_b64 = base64.urlsafe_b64encode(priv_raw).rstrip(b"=").decode()
        pub_b64 = base64.urlsafe_b64encode(pub_raw).rstrip(b"=").decode()
        _AUTH_DIR.mkdir(parents=True, exist_ok=True)
        _VAPID_FILE.write_text(
            _json.dumps({"public": pub_b64, "private": priv_b64}, indent=2),
            encoding="utf-8",
        )
        logger.info("[PUSH] generated new VAPID keypair -> %s", _VAPID_FILE)
        return pub_b64, priv_b64
    except Exception as exc:  # noqa: BLE001
        logger.warning("[PUSH] VAPID key generation failed: %s", exc)
        return "", ""


def _pad_b64(s: str) -> str:
    return s + "=" * (-len(s) % 4)


def push_enabled() -> bool:
    """True only when the VAPID keypair is configured (fails closed otherwise)."""
    pub, priv = _load_or_create_vapid()
    return bool(priv and pub)


def vapid_public_key() -> str:
    return _load_or_create_vapid()[0]


def _claims() -> dict:
    email = (os.getenv("VAPID_CLAIM_EMAIL") or "kaustubh@localhost").strip()
    return {"sub": f"mailto:{email}"}


def _vapid_private_key() -> str:
    return _load_or_create_vapid()[1]


async def register_subscription(sub: dict, label: str = "") -> dict:
    """Upsert a browser push subscription. Raises on invalid input / no DB."""
    from database.connection import get_db

    endpoint = str((sub or {}).get("endpoint") or "").strip()
    keys = (sub or {}).get("keys") or {}
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("subscription needs endpoint + keys.p256dh + keys.auth")
    db = get_db()
    now = datetime.now(timezone.utc)
    doc = {
        "endpoint": endpoint,
        "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
        "label": str(label or "")[:80],
        "userAgent": str((sub or {}).get("userAgent") or "")[:300],
        "createdAt": now,
        "lastUsedAt": now,
        "failures": 0,
    }
    await db[COLLECTION].update_one(
        {"endpoint": endpoint}, {"$set": doc, "$setOnInsert": {"createdAt": now}}, upsert=True,
    )
    return {"ok": True, "endpoint": endpoint}


async def unregister_subscription(endpoint: str) -> dict:
    from database.connection import get_db

    db = get_db()
    res = await db[COLLECTION].delete_one({"endpoint": str(endpoint or "")})
    return {"ok": True, "removed": int(res.deleted_count)}


async def list_subscriptions() -> list[dict]:
    from database.connection import get_db

    db = get_db()
    out = []
    async for doc in db[COLLECTION].find({}):
        doc.pop("_id", None)
        out.append(doc)
    return out


def build_push_payload(
    title: str,
    body: str,
    *,
    kind: str = "executed",
    symbol: str = "",
    side: str = "",
    price: float | None = None,
    order_id: str = "",
    url: str = "/services/notifications",
) -> dict:
    payload: dict[str, Any] = {
        "kind": kind,
        "title": title,
        "body": body,
        "symbol": symbol,
        "url": url,
    }
    if side:
        payload["side"] = side
    if price is not None:
        payload["price"] = price
    if order_id:
        payload["orderId"] = order_id
    return payload


async def fanout_push(payload: dict) -> dict:
    """Send ``payload`` to every stored subscription. Never raises."""
    if not push_enabled():
        return {"ok": False, "reason": "push_disabled", "sent": 0}
    subs = await list_subscriptions()
    if not subs:
        return {"ok": True, "sent": 0, "reason": "no_subscriptions"}
    try:
        from pywebpush import WebPushException, webpush
    except Exception as exc:
        logger.warning("[PUSH] pywebpush unavailable: %s", exc)
        return {"ok": False, "reason": "pywebpush_unavailable", "sent": 0}
    import json as _json2

    vapid_private = _pad_b64(_vapid_private_key())
    sent, pruned, failed = 0, 0, 0
    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": sub["keys"],
                },
                data=_json2.dumps(payload),
                vapid_private_key=vapid_private,
                vapid_claims=_claims(),
            )
            sent += 1
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                try:
                    await unregister_subscription(sub["endpoint"])
                    pruned += 1
                except Exception:
                    pass
            else:
                failed += 1
                logger.debug("[PUSH] fanout failed for %s: %s",
                             str(sub.get("endpoint"))[:60], exc)
    return {"ok": True, "sent": sent, "pruned": pruned, "failed": failed,
            "total": len(subs)}


async def push_test(title: str = "Test notification") -> dict:
    """Send a test push to all subscriptions (UI test button)."""
    return await fanout_push(build_push_payload(
        title, "Push delivery is working — this came from your backend.",
        kind="executed", symbol="KAUSTUBH",
    ))