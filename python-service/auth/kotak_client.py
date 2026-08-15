"""
Kotak Neo SDK wrapper â€” the ONLY place that touches the official SDK.

Responsibilities:
  - Initialise the NeoAPI client
  - TOTP login + MPIN validation
  - Session introspection (boolean flags only, never raw tokens)
  - Session expiry detection
  - Logout

We never expose credentials, MPIN, or TOTP secret outside this module.
"""
from __future__ import annotations
import asyncio
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from config.settings import settings
from logger import get as get_logger
from utils.totp import generate_totp
from neo_api_client import NeoAPI  # type: ignore[import-not-found]


log = get_logger("login")

# Import the official SDK. Installed from:
#   pip install "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.2#egg=neo_api_client"
try:
     #from neo_api_client import NeoAPI  # type: ignore[import-not-found]

    SDK_AVAILABLE = True
    SDK_VERSION = getattr(NeoAPI, "__version__", "2.0.2")
except Exception as exc:  # pragma: no cover - import-time failure is surfaced via /health
    SDK_AVAILABLE = False
    SDK_VERSION = None
    NeoAPI = None  # type: ignore[assignment]
    log.error("Failed to import neo_api_client SDK", extra={"category": "login", "meta": {"error": str(exc)}})


class KotakSession:
    """Thread-safe wrapper around the NeoAPI client and session state."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.client: Optional[Any] = None
        self.logged_in = False
        self.session_active = False
        self.view_token: Optional[str] = None
        self.session_id: Optional[str] = None
        self.trade_token: Optional[str] = None
        self.user_id: Optional[str] = None
        self.exchanges: list[str] = []
        self.products: list[str] = []
        self.last_login_at: Optional[str] = None
        self.last_logout_at: Optional[str] = None
        self.login_error: Optional[str] = None
        self.login_count = 0

    # ---- lifecycle -----------------------------------------------------------

    def initialise(self) -> None:
        with self._lock:
            if not SDK_AVAILABLE:
                raise RuntimeError("neo_api_client SDK is not installed")
            self.client = NeoAPI(
                environment=settings.environment,
                access_token=None,
                neo_fin_key=None,
                consumer_key=settings.consumer_key,
            )
            log.info("NeoAPI client initialised", extra={"category": "login"})

    def login(self) -> bool:
        with self._lock:
            if not self.client:
                self.initialise()
            try:
                totp = generate_totp(settings.totp_secret, settings.totp_interval, settings.totp_digits)
                log.info("Starting TOTP login", extra={"category": "login"})

                login_resp = self.client.totp_login(
                    mobile_number=settings.mobile_number,
                    ucc=settings.client_id,
                    totp=totp,
                )
                self.view_token = _extract(login_resp, "view_token") or _extract(login_resp, "data", "view_token")
                self.session_id = _extract(login_resp, "session_id") or _extract(login_resp, "data", "session_id")
                log.info(
                    "TOTP login successful",
                    extra={"category": "login", "meta": {"has_view_token": bool(self.view_token)}},
                )

                validate_resp = self.client.totp_validate(mpin=settings.mpin)
                self.trade_token = _extract(validate_resp, "trade_token") or _extract(
                    validate_resp, "data", "trade_token"
                )
                self.user_id = (
                    _extract(validate_resp, "ucc")
                    or _extract(validate_resp, "data", "ucc")
                    or settings.client_id
                )
                self.exchanges = _extract_list(validate_resp, "exch")
                self.products = _extract_list(validate_resp, "product")

                self.logged_in = True
                self.session_active = True
                self.last_login_at = datetime.now(timezone.utc).isoformat()
                self.login_error = None
                self.login_count += 1
                log.info(
                    "Session validated and active",
                    extra={"category": "login", "meta": {"user_id": self.user_id, "login_count": self.login_count}},
                )
                return True
            except Exception as exc:
                self.login_error = str(exc)
                self.logged_in = False
                self.session_active = False
                log.error("Login failed", extra={"category": "login", "meta": {"error": str(exc)}})
                raise

    def logout(self) -> bool:
        with self._lock:
            if not self.client:
                self.logged_in = False
                self.session_active = False
                return True
            try:
                self.client.logout()
            except Exception as exc:
                log.warn("Logout call failed", extra={"category": "login", "meta": {"error": str(exc)}})
            self.client = None
            self.logged_in = False
            self.session_active = False
            self.view_token = None
            self.session_id = None
            self.trade_token = None
            self.last_logout_at = datetime.now(timezone.utc).isoformat()
            log.info("Logged out", extra={"category": "login"})
            return True

    def mark_session_expired(self) -> None:
        """Called by the WebSocket reconnect logic when a 403 is detected."""
        with self._lock:
            self.session_active = False
            log.warn(
                "Session marked as expired",
                extra={"category": "login", "meta": {"last_login": self.last_login_at}},
            )

    def ensure_session(self) -> bool:
        """Re-login if the session is not active. Returns True if session is valid."""
        with self._lock:
            if self.session_active:
                return True
            log.info("Session not active, attempting re-login", extra={"category": "login"})
            return self.login()

    # ---- introspection ------------------------------------------------------

    def session_info(self) -> dict[str, Any]:
        with self._lock:
            return {
                "logged_in": self.logged_in,
                "view_token_present": bool(self.view_token),
                "session_id_present": bool(self.session_id),
                "trade_token_present": bool(self.trade_token),
                "user_id": self.user_id,
                "exchanges": self.exchanges,
                "products": self.products,
                "last_login_at": self.last_login_at,
                "last_logout_at": self.last_logout_at,
                "login_count": self.login_count,
            }

    # ---- trading (official SDK methods) --------------------------------------

    def _require_client(self) -> Any:
        if not self.client or not self.session_active:
            raise RuntimeError("Session not active â€” please login first")
        return self.client

    def place_order(self, **kwargs: Any) -> dict[str, Any]:
        """Place an order via the official SDK place_order method."""
        with self._lock:
            client = self._require_client()
            resp = client.place_order(**kwargs)
            return _to_dict(resp)

    def modify_order(self, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.modify_order(**kwargs)
            return _to_dict(resp)

    def cancel_order(self, order_id: str) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.cancel_order(order_id=order_id)
            return _to_dict(resp)

    def order_history(self, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.order_history(**kwargs)
            return _to_dict(resp)

    def order_book(self) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.order_report()
            return _to_dict(resp)

    def positions(self) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.positions()
            return _to_dict(resp)

    def holdings(self) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.holdings()
            return _to_dict(resp)

    def limits(self) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.limits()
            return _to_dict(resp)

    def search_scrip(self, exchange: str, search_text: str) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
        resp = client.search_scrip(
                 exchange,
                 search_text
        )
        return _to_dict(resp)

    def quote(self, **kwargs: Any) -> dict[str, Any]:
     with self._lock:
        client = self._require_client()

        kwargs.pop("isIndex", None)

        resp = client.quotes(**kwargs)
        return _to_dict(resp)
    def square_off_position(self, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.square_off_position(**kwargs)
            return _to_dict(resp)

    # ---- Async wrappers (run sync SDK calls in thread pool) ----

    async def async_place_order(self, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self.place_order, **kwargs)

    async def async_modify_order(self, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self.modify_order, **kwargs)

    async def async_cancel_order(self, order_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self.cancel_order, order_id)

    async def async_order_history(self, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self.order_history, **kwargs)

    async def async_order_book(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.order_book)

    async def async_positions(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.positions)

    async def async_holdings(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.holdings)

    async def async_limits(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.limits)

    async def async_search_scrip(self, exchange: str, search_text: str) -> dict[str, Any]:
        return await asyncio.to_thread(self.search_scrip, exchange, search_text)

    async def async_quote(self, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self.quote, **kwargs)

    async def async_square_off_position(self, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self.square_off_position, **kwargs)


def _extract(resp: Any, *keys: str) -> Optional[str]:
    """Safely pull a nested string from an SDK response (dict or object)."""
    cur = resp
    for k in keys:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            cur = getattr(cur, k, None)
    return cur if isinstance(cur, str) else None


def _extract_list(resp: Any, key: str) -> list[str]:
    cur = resp
    if isinstance(cur, dict):
        val = cur.get(key)
    else:
        val = getattr(cur, key, None)
    if isinstance(val, list):
        return [str(x) for x in val]
    return []


def _to_dict(resp: Any) -> dict[str, Any]:
    """Normalise an SDK response (dict, list, or object) into a plain dict."""
    if isinstance(resp, dict):
        return resp
    if isinstance(resp, list):
        return {"data": resp}
    if resp is None:
        return {"data": None}
    if hasattr(resp, "__dict__"):
        return {"data": {k: v for k, v in resp.__dict__.items() if not k.startswith("_")}}
    return {"data": str(resp)}


kotak_session = KotakSession()


