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
import re
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from config.settings import settings
from logger import get as get_logger
from utils.totp import generate_totp
from neo_api_client import NeoAPI  # type: ignore[import-not-found]


log = get_logger("login")


def _sdk_dist_version() -> Optional[str]:
    """Read the installed SDK version from package metadata.

    Never imports ``__version__`` from the SDK (v3 exposes no such export) and
    never blocks backend startup — if the metadata is unavailable the version
    is simply reported as None.
    """
    try:
        from importlib.metadata import version
        return version("kotakneoapi")
    except Exception:
        return None


# Import the official SDK (kotakneoapi 3.x distribution; its import module name
# remained "neo_api_client", so `from neo_api_client import NeoAPI` is the
# correct v3 import — NOT the removed v2 "neo-api-client" distribution).
# Installed from:
#   pip install kotakneoapi==3.0.7   (official PyPI wheel; import name neo_api_client)
try:
    SDK_AVAILABLE = True
    SDK_VERSION = _sdk_dist_version()
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
        self._limit_segments: list[str] = []
        self._limits_ok: bool = False
        self.intraday_available: bool = False
        self.last_login_at: Optional[str] = None
        self.last_logout_at: Optional[str] = None
        self.session_validated_at: Optional[str] = None
        self.login_error: Optional[str] = None
        self.login_count = 0
        self.login_source: Optional[str] = None
        self.last_reauth_at: Optional[str] = None

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

    def login(self, source: Optional[str] = None) -> bool:
        with self._lock:
            if self.session_active and self.client is not None:
                log.info("Login skipped: session already active (source=%s)", source)
                return True
            if not self.client:
                self.initialise()
            try:
                totp = generate_totp(settings.totp_secret, settings.totp_interval, settings.totp_digits)
                log.info("Starting TOTP login", extra={"category": "login", "meta": {"source": source}})

                login_resp = self.client.totp_login(
                    mobile_number=settings.mobile_number,
                    ucc=settings.client_id,
                    totp=totp,
                )
                # kotakneoapi (v3) returns tokens under the "data" envelope:
                #   login    -> data.token (view token), data.sid, data.ucc
                #   validate -> data.token (trade token), data.rid, data.baseUrl
                self.view_token = _extract(login_resp, "data", "token") or _extract(login_resp, "view_token")
                self.session_id = _extract(login_resp, "data", "sid") or _extract(login_resp, "session_id")
                if not self.view_token:
                    raise RuntimeError(f"TOTP login rejected: {_trim_error(login_resp)}")
                log.info(
                    "TOTP login successful",
                    extra={"category": "login", "meta": {"has_view_token": bool(self.view_token)}},
                )

                validate_resp = self.client.totp_validate(mpin=settings.mpin)
                self.trade_token = _extract(validate_resp, "data", "token") or _extract(
                    validate_resp, "trade_token"
                )
                if not self.trade_token:
                    raise RuntimeError(f"MPIN validation rejected: {_trim_error(validate_resp)}")
                self.user_id = (
                    _extract(validate_resp, "ucc")
                    or _extract(validate_resp, "data", "ucc")
                    or settings.client_id
                )
                # Kotak sends both as comma-joined STRINGS (e.g. "MIS,CNC").
                # Parse every plausible shape (list, joined string, list of
                # dicts, top-level or nested under the "data" envelope).
                self.exchanges = _extract_str_list(validate_resp, "exch", "exchange", "exchanges")
                self.products = _extract_str_list(validate_resp, "product", "products")
                log.info(
                    "Session validated and active",
                    extra={
                        "category": "login",
                        "meta": {
                            "user_id": self.user_id,
                            "exchanges": self.exchanges,
                            "products": self.products,
                            "login_count": self.login_count,
                            "source": source,
                            "validate_keys": _dict_keys(validate_resp),
                            "data_keys": _dict_keys(validate_resp.get("data") if isinstance(validate_resp, dict) else None),
                            "data_exch": (validate_resp.get("data") or {}).get("exch") if isinstance(validate_resp, dict) else None,
                            "data_product": (validate_resp.get("data") or {}).get("product") if isinstance(validate_resp, dict) else None,
                        },
                    },
                )

                now_iso = datetime.now(timezone.utc).isoformat()
                self.logged_in = True
                self.session_active = True
                self.last_login_at = now_iso
                self.session_validated_at = now_iso
                self.login_error = None
                self.login_count += 1
                self.login_source = source
                # The validate envelope carries NO product/exchange lists, so
                # pull them from the limits API (authoritative, per-product
                # margin-eligibility). Best-effort: never blocks login.
                try:
                    self.refresh_limits()
                except Exception as exc:
                    log.warn(
                        "Limits refresh failed",
                        extra={"category": "login", "meta": {"error": str(exc)}},
                    )
                log.info(
                    "Limits populated",
                    extra={
                        "category": "login",
                        "meta": {
                            "products": self.products,
                            "exchanges": self.exchanges,
                            "segments": self._limit_segments,
                        },
                    },
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
            self.login_source = None
            log.info("Logged out", extra={"category": "login"})
            return True

    def mark_session_expired(self, reason: str = "unknown") -> None:
        """Called when the session is detected as expired (e.g. a 403)."""
        with self._lock:
            self.session_active = False
            self.last_reauth_at = datetime.now(timezone.utc).isoformat()
            log.warn(
                "Session marked as expired",
                extra={"category": "login", "meta": {"reason": reason, "last_login": self.last_login_at}},
            )

    def ensure_session(self) -> bool:
        """Re-login if the session is not active. Returns True if session is valid."""
        with self._lock:
            if self.session_active:
                return True
            log.info("Session not active, attempting re-login", extra={"category": "login"})
            return self.login()

    def refresh_limits(self) -> dict[str, Any]:
        """Query account limits — the authoritative products/exchanges/segments.

        The broker's validate envelope does NOT expose product or exchange
        lists (confirmed against a live session). The limits API returns the
        account's margin summary; its ``MisPrsnt`` fields confirm MIS is
        actually configured for the account. Coresidency with a validated
        trade token is the honest account-level basis for intraday eligibility
        used by the scanner.
        """
        with self._lock:
            client = self._require_client_no_raise()
        if client is None:
            return {}
        try:
            resp = client.limits()
        except Exception as exc:
            log.warn("Limits fetch failed", extra={"category": "login", "meta": {"error": str(exc)}})
            return {}
        keys = _dict_keys(resp) or []
        has_mis_margin = bool(keys) and any("Mis" in k for k in keys)
        with self._lock:
            self._limits_ok = bool(keys)
            self.intraday_available = has_mis_margin and bool(self.trade_token)
        products, exchanges, segments = _extract_limits(resp)
        with self._lock:
            if products:
                self.products = products
            if exchanges:
                self.exchanges = exchanges
            if segments:
                self._limit_segments = list(dict.fromkeys(segments))
        log.info(
            "Limits refreshed",
            extra={
                "category": "login",
                "meta": {
                    "products": self.products,
                    "exchanges": self.exchanges,
                    "segments": self._limit_segments,
                    "intraday_available": self.intraday_available,
                    "has_mis_margin": has_mis_margin,
                    "keys": keys[:10],
                },
            },
        )
        return {"products": products, "exchanges": exchanges, "segments": segments}

    def _require_client_no_raise(self) -> Any:
        """Like ``_require_client`` but returns None instead of raising."""
        if not self.client or not self.session_active:
            return None
        return self.client

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

    def session_detail(self) -> dict[str, Any]:
        """Extended session view for the dashboard (extra fields only)."""
        with self._lock:
            return {
                "session_active": self.session_active,
                "session_validated_at": self.session_validated_at,
                "login_source": self.login_source,
                "last_login_error": self.login_error,
                "last_reauth_at": self.last_reauth_at,
            }

    # ---- trading (official SDK methods) --------------------------------------

    def _require_client(self) -> Any:
        if not self.client or not self.session_active:
            raise RuntimeError("Session not active â€” please login first")
        return self.client

    def place_order(self, **kwargs: Any) -> dict[str, Any]:
        """Place an order via the official SDK place_order method.

        kotakneoapi (v3) dropped the legacy ``exchange=`` / ``token=`` /
        ``market_protection=`` arguments in favour of ``exchange_segment=`` and
        ``trading_symbol=`` (the trading symbol is resolved from the instrument
        token via the instrument cache). The mapping happens here so callers
        (baskets, trading UI) keep sending the stable legacy shape.
        """
        with self._lock:
            client = self._require_client()
            try:
                params = _normalize_order_kwargs(kwargs)
                trading_symbol = _resolve_trading_symbol(params["token"])
            except RuntimeError as exc:
                return {"Error": str(exc)}
            if not trading_symbol:
                return {
                    "Error": f"Could not resolve a trading symbol for token {params['token']!r} "
                    f"(instrument cache not loaded for {params['exchange_segment']})"
                }
            resp = client.place_order(
                exchange_segment=params["exchange_segment"],
                product=params["product"],
                price=params["price"],
                order_type=params["order_type"],
                quantity=params["quantity"],
                validity=params["validity"],
                trading_symbol=trading_symbol,
                transaction_type=params["transaction_type"],
                amo=params["amo"],
                disclosed_quantity=params["disclosed_quantity"],
                trigger_price=params["trigger_price"],
            )
            return _to_dict(resp)

    def modify_order(self, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            kwargs = dict(kwargs)
            kwargs.pop("exchange", None)
            kwargs.pop("token", None)
            kwargs.pop("market_protection", None)
            resp = client.modify_order(
                order_id=str(kwargs["order_id"]),
                price=kwargs["price"],
                order_type=_ORDER_TYPE_ALIAS.get(str(kwargs.get("order_type") or "MKT"), "MKT"),
                quantity=kwargs["quantity"],
                validity=kwargs["validity"],
                trigger_price=kwargs.get("trigger_price") or "0",
                disclosed_quantity=kwargs.get("disclosed_quantity") or "0",
            )
            return _to_dict(resp)

    def cancel_order(self, order_id: str) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.cancel_order(order_id=order_id)
            return _to_dict(resp)

    def order_history(self, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            # kotakneoapi (v3) only supports order_history(order_id=...); the
            # full book is order_report(). The legacy UI passes book="orders"
            # alongside order_id — drop book= and fall back to the full book
            # when no order id is supplied.
            kwargs = dict(kwargs)
            kwargs.pop("book", None)
            order_id = str(kwargs.pop("order_id", None) or "").strip()
            if order_id:
                resp = client.order_history(order_id=order_id)
            else:
                resp = client.order_report()
            return _to_dict(resp)

    def order_book(self) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()
            resp = client.order_report()
            return _to_dict(resp)

    def trade_report(self) -> dict[str, Any]:
        """Executed trades via the SDK's dedicated trade_report endpoint.

        The v3 SDK exposes order_report() separately from trade_report(); the
        trade book MUST come from trade_report() (order_report re-returns the
        order book, not executions).
        """
        with self._lock:
            client = self._require_client()
            resp = client.trade_report()
            return _to_dict(resp)

    def margin_required(self, **kwargs: Any) -> dict[str, Any]:
        """Real broker-computed margin preview via the SDK's margin API.

        Exact-match values only (no aliases): order_type L|MKT|SL|SL-M, product
        CNC|NRML|MIS|MTF, transaction_type B|S. Returns the broker's computed
        margin or an SDK error envelope — never a local estimate.
        """
        with self._lock:
            client = self._require_client()
        params = _normalize_margin_kwargs(kwargs)
        if isinstance(params, str):
            return {"Error": params}
        try:
            resp = client.margin_required(
                exchange_segment=params["exchange_segment"],
                price=params["price"],
                order_type=params["order_type"],
                product=params["product"],
                quantity=params["quantity"],
                instrument_token=params["instrument_token"],
                transaction_type=params["transaction_type"],
                trigger_price=params["trigger_price"],
                broker_name="KOTAK",
                branch_id="ONLINE",
            )
            return _to_dict(resp)
        except Exception as exc:
            return {"Error Message": str(exc)}

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
        # v3 signature is search_scrip(exchange_segment=..., symbol=...). Call it
        # by keyword: the positional form happens to work today but silently
        # reorders against any future parameter change.
        resp = client.search_scrip(exchange_segment=exchange, symbol=search_text)
        return _to_dict(resp)

    def quote(self, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()

        kwargs.pop("isIndex", None)
        tokens = _normalize_quote_tokens(kwargs.get("instrument_tokens") or kwargs.get("tokens"))
        if isinstance(tokens, str):
            return {"Error": tokens}
        quote_type = kwargs.get("quote_type") or "all"
        resp = client.quotes(instrument_tokens=tokens, quote_type=quote_type)
        return _to_dict(resp)

    def square_off_position(self, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            client = self._require_client()

        # kotakneoapi (v3) removed the v2 square_off_position REST call, so a
        # square-off is executed as an opposite-direction market order (the
        # standard v3 behaviour). position_type LONG -> SELL, SHORT -> BUY.
        position_type = str(kwargs.get("position_type") or "LONG").upper()
        transaction_type = "BUY" if position_type in ("SHORT", "SELL", "S") else "SELL"
        order_kwargs = dict(kwargs)
        order_kwargs["transaction_type"] = transaction_type
        order_kwargs.setdefault("order_type", "MKT")
        order_kwargs.setdefault("price", "0")
        order_kwargs.setdefault("trigger_price", "0")
        order_kwargs.setdefault("validity", "DAY")
        order_kwargs.setdefault("amo", "NO")
        order_kwargs.setdefault("disclosed_quantity", "0")
        result = self.place_order(**order_kwargs)
        result["note"] = "square_off executed via opposite market order (v3 adapter)"
        return result

    # ---- Async wrappers (run sync SDK calls in thread pool) ----

    async def async_login(self, source: Optional[str] = None) -> bool:
        """Async login wrapper (blocking SDK call offloaded to a thread)."""
        return await asyncio.to_thread(self.login, source=source)

    async def async_logout(self) -> bool:
        """Async logout wrapper (blocking SDK call offloaded to a thread)."""
        return await asyncio.to_thread(self.logout)

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

    async def async_trade_report(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.trade_report)

    async def async_margin_required(self, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self.margin_required, **kwargs)

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


# ---- v3 (kotakneoapi) mapping helpers ----

_EXCHANGE_ALIAS = {
    "nse_cm": "nse_cm", "nse": "nse_cm", "NSE": "nse_cm", "NSE_CM": "nse_cm", "NSECM": "nse_cm",
    "bse_cm": "bse_cm", "bse": "bse_cm", "BSE": "bse_cm", "BSE_CM": "bse_cm", "BSECM": "bse_cm",
    "nse_fo": "nse_fo", "nfo": "nse_fo", "NFO": "nse_fo",
    "bse_fo": "bse_fo", "bfo": "bse_fo", "BFO": "bse_fo",
    "mcx_fo": "mcx_fo", "mcx": "mcx_fo", "MCX": "mcx_fo",
}
_VALID_EXCHANGE_SEGMENTS = {"nse_cm", "bse_cm", "nse_fo", "bse_fo", "mcx_fo"}

_PRODUCT_ALIAS = {
    "MIS": "MIS", "mis": "MIS",
    "CNC": "CNC", "cnc": "CNC",
    "NRML": "NRML", "nrml": "NRML", "Normal": "NRML", "NRML normal": "NRML",
    "MTF": "MTF", "mtf": "MTF",
    "INTRADAY": "INTRADAY", "INT": "INT",
    "CO": "CO", "COVER ORDER": "CO",
    "BO": "BO", "BRACKET ORDER": "BO",
    "CASH AND CARRY": "CNC",
    # UI-level cash equity = full-payment delivery on the broker.
    "CASH": "CNC", "cash": "CNC",
}
_ORDER_TYPE_ALIAS = {
    "L": "L", "l": "L", "Limit": "L", "LIMIT": "L",
    "MKT": "MKT", "mkt": "MKT", "Market": "MKT", "MARKET": "MKT",
    "SL": "SL", "sl": "SL", "SLL": "SL",
    "SL-M": "SL-M", "sl-m": "SL-M", "SLM": "SL-M",
}
_TX_TYPE_ALIAS = {
    "B": "B", "BUY": "B", "Buy": "B", "buy": "B",
    "S": "S", "SELL": "S", "Sell": "S", "sell": "S",
}


def _normalize_order_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Map legacy order kwargs to kotakneoapi (v3) validation values."""
    exchange_segment = str(kwargs.get("exchange") or kwargs.get("exchange_segment") or "nse_cm")
    exchange_segment = _EXCHANGE_ALIAS.get(exchange_segment, exchange_segment)
    if exchange_segment not in _VALID_EXCHANGE_SEGMENTS:
        raise RuntimeError(f"Unsupported exchange_segment: {exchange_segment!r}")
    product = _PRODUCT_ALIAS.get(str(kwargs.get("product") or "MIS"))
    if product is None:
        raise RuntimeError(f"Unsupported product: {kwargs.get('product')!r}")
    return {
        "exchange_segment": exchange_segment,
        "token": str(kwargs.get("token") or ""),
        "product": product,
        "order_type": _ORDER_TYPE_ALIAS.get(str(kwargs.get("order_type") or "MKT"), "MKT"),
        "transaction_type": _TX_TYPE_ALIAS.get(str(kwargs.get("transaction_type") or "BUY"), "B"),
        "price": kwargs.get("price") if kwargs.get("price") is not None else "0",
        "quantity": kwargs.get("quantity"),
        "validity": kwargs.get("validity") or "DAY",
        "trigger_price": kwargs.get("trigger_price") or "0",
        "disclosed_quantity": kwargs.get("disclosed_quantity") or "0",
        "amo": kwargs.get("amo") or "NO",
    }


def _resolve_trading_symbol(token: str) -> str:
    """Resolve a numeric instrument token to its trading symbol via the cache.

    A non-numeric token is treated as a trading symbol already passed through
    by the caller. The instrument cache import stays lazy to avoid a circular
    import (services/instrument_cache imports auth.kotak_client).
    """
    token = (token or "").strip()
    if not token:
        return ""
    if not token.isdigit():
        return token
    from services.instrument_cache import instrument_cache

    inst = instrument_cache.lookup_by_token(token)
    if inst and inst.get("tradingSymbol"):
        return str(inst["tradingSymbol"])
    return ""


def _normalize_margin_kwargs(kwargs: dict[str, Any]) -> dict[str, Any] | str:
    """Map the stable order shape to the SDK margin_required exact-match values.

    Returns a params dict on success, or an error message string on invalid
    input (the SDK rejects aliases — L|MKT|SL|SL-M, CNC|NRML|MIS|MTF, B|S).
    """
    exchange_segment = str(kwargs.get("exchange") or kwargs.get("exchange_segment") or "nse_cm")
    exchange_segment = _EXCHANGE_ALIAS.get(exchange_segment, exchange_segment)
    if exchange_segment not in _VALID_EXCHANGE_SEGMENTS:
        return f"Unsupported exchange_segment: {exchange_segment!r}"
    product = _PRODUCT_ALIAS.get(str(kwargs.get("product") or "MIS"), str(kwargs.get("product") or "MIS"))
    order_type = _ORDER_TYPE_ALIAS.get(str(kwargs.get("order_type") or "MKT"), str(kwargs.get("order_type") or "MKT"))
    transaction_type = _TX_TYPE_ALIAS.get(str(kwargs.get("transaction_type") or "BUY"), str(kwargs.get("transaction_type") or "BUY"))
    price = str(kwargs.get("price") or "0")
    quantity = str(kwargs.get("quantity") or "")
    instrument_token = str(
        kwargs.get("token")
        or kwargs.get("instrument_token")
        or (kwargs.get("instrumentToken") or "")
    )
    if not quantity or float(quantity) <= 0:
        return "quantity must be a non-zero positive value"
    if not instrument_token or not instrument_token.isdigit():
        if not instrument_token:
            return "instrument_token required for margin calculation"
        return f"invalid instrument_token: {instrument_token!r}"
    return {
        "exchange_segment": exchange_segment,
        "price": price,
        "order_type": order_type,
        "product": product,
        "quantity": quantity,
        "instrument_token": instrument_token,
        "transaction_type": transaction_type,
        "trigger_price": str(kwargs.get("trigger_price") or "") or None,
    }


def _normalize_quote_tokens(tokens: Any) -> Any:
    """Normalise quote tokens to the v3 {"exchange_segment", "instrument_token"} shape.

    Returns a list on success, or an error message string on invalid input.
    """
    if not isinstance(tokens, list) or not tokens:
        return "No instrument tokens supplied"
    normalized = []
    for token in tokens:
        if not isinstance(token, dict):
            return f"Invalid instrument token entry: {token!r}"
        instrument_token = str(token.get("instrument_token") or token.get("instrumentToken") or "").strip()
        exchange_segment = str(token.get("exchange_segment") or token.get("exchange") or "nse_cm")
        exchange_segment = _EXCHANGE_ALIAS.get(exchange_segment, exchange_segment)
        if not instrument_token:
            return f"Instrument token entry missing instrument_token: {token!r}"
        normalized.append({"exchange_segment": exchange_segment, "instrument_token": instrument_token})
    return normalized


def _trim_error(resp: Any) -> str:
    """Return a short, human-readable description of an SDK error response."""
    if isinstance(resp, dict):
        for key in ("error", "Error", "Error Message", "errorMessage", "message", "description"):
            value = resp.get(key)
            if value is not None:
                return str(value)
        if "data" in resp:
            return _trim_error(resp["data"])
        return str(resp)[:240]
    return str(resp)[:240]


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


def _extract_limits(resp: Any) -> tuple[list[str], list[str], list[str]]:
    """Parse the limits payload into canonical product/exchange/segment lists.

    The broker returns one row per (exchange, segment, product) margin limit;
    some deployments also send dedicated ``productList``/``exchangeList``
    keys. Any shape maps through the same alias normaliser used by the rest of
    the login flow.
    """
    resp = _to_dict(resp)
    data = resp.get("data") if isinstance(resp.get("data"), (dict, list)) else resp

    products: list[str] = []
    exchanges: list[str] = []
    segments: list[str] = []

    rows = data if isinstance(data, list) else [data]
    for row in rows:
        if not isinstance(row, dict):
            continue
        products += _extract_str_list(row, "product", "prod", "productCode")
        exchanges += _extract_str_list(row, "exch", "exchange", "exchangeCode", "exchSeg")
        segments += _extract_str_list(row, "seg", "segment", "exchangeSegment", "exchange_segment")

    if isinstance(data, dict):
        products += _extract_str_list(data, "productList", "products", "productListArray")
        exchanges += _extract_str_list(data, "exchangeList", "exchanges", "exchangeListArray")
        segments += _extract_str_list(data, "segmentList", "segments", "segmentListArray")

    def _uniq(values: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for v in values:
            if v and v not in seen:
                seen.add(v)
                out.append(v)
        return out

    return _uniq(products), _uniq(exchanges), _uniq(segments)


def _dict_keys(resp: Any) -> list[str] | None:
    """Key names of a response envelope (for diagnostic logging only)."""
    if isinstance(resp, dict):
        return list(resp.keys())
    if isinstance(resp, (tuple, list)) and resp and isinstance(resp[0], dict):
        return list(resp[0].keys())
    return None


def _extract_str_list(resp: Any, *keys: str) -> list[str]:
    """Robustly parse a Kotak session field that may arrive as a list, a
    comma/pipe/space-joined STRING (e.g. ``"MIS,CNC"``), or a list of dicts
    (e.g. ``[{"code": "MIS"}]``), either top-level or inside the ``data``
    envelope. Returns canonical, uppercased, alias-normalised tokens.
    """
    if not isinstance(resp, dict):
        resp = _to_dict(resp)
    raw: Any = None
    envelopes = [resp, resp.get("data") if isinstance(resp.get("data"), dict) else None]
    for env in envelopes:
        if not isinstance(env, dict):
            continue
        for k in keys:
            v = env.get(k)
            if v is not None:
                raw = v
                break
        if raw is not None:
            break

    tokens: list[str] = []
    if raw is None:
        return tokens
    if isinstance(raw, str):
        parts = re.split(r"[,\|/;]+", raw.strip())
        tokens = [p.strip() for p in parts if p.strip()]
    elif isinstance(raw, (list, tuple)):
        for item in raw:
            if isinstance(item, str):
                tokens.append(item)
            elif isinstance(item, dict):
                for k in ("productCode", "product", "code", "exchSeg", "segment", "name"):
                    v = item.get(k)
                    if isinstance(v, str) and v.strip():
                        tokens.append(v)
                        break

    seen: set[str] = set()
    result: list[str] = []
    for t in tokens:
        t = str(t).strip()
        canon = _PRODUCT_ALIAS.get(t) or _PRODUCT_ALIAS.get(t.upper()) or t.upper()
        if canon and canon not in seen:
            seen.add(canon)
            result.append(canon)
    return result


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


