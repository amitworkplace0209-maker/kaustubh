"""Shoonya adapter — real broker adapter over the official OAuth SDK.

SDK: NorenRestApiOAuth (dist) / NorenRestApiPy.NorenApi (module), class
NorenApi(host, websocket). Verified installed version 0.0.41.

Auth flow (OAuth, matches the Shoonya Python SDK documentation):
  1. ``oauth_url()``        -> the user opens this URL in a browser.
  2. ``accept_auth_code()`` -> the SHORT-LIVED auth code the redirect returns.
     It is used exactly once and never logged or persisted.
  3. ``login()``            -> exchanges the code for the access token,
     injects the OAuth header, stores credentials and offers the order/quote
     WebSocket feeds.

Every secret (api_key, secret_key, uid, account id, auth code, access token)
is kept in the process only and is NEVER exposed via the API, logs or DB.
"""
from __future__ import annotations
import logging
import time
from typing import Any, Callable

from config.settings import settings
from services.session.session_manager import session_manager

from brokers.base import BrokerAdapter
from brokers.models import BrokerError, safe_float
from brokers.capabilities import Capabilities

_log = logging.getLogger("shoonya_adapter")


try:  # official OAuth SDK — import guarded so the backend boots without it
    from NorenRestApiPy.NorenApi import NorenApi as _NorenApi  # type: ignore
    SHOONYA_SDK_AVAILABLE = True
except Exception as exc:  # pragma: no cover - startup resilience
    _NorenApi = None  # type: ignore[assignment]
    SHOONYA_SDK_AVAILABLE = False
    _log.error("Shoonya SDK import failed: %s", exc)


# Noren pages are equites via their trading web / mobile app. 'N' = NSE, 'B' = BSE.
# UI-level CASH = full-payment cash delivery ("C"), same as CNC.
_PROD_MAP = {"MIS": "I", "INTRADAY": "I", "CNC": "C", "DELIVERY": "C", "CASH": "C", "NRML": "M", "NORMAL": "M"}
_TX_MAP = {"BUY": "B", "SELL": "S"}
_ORDER_TYPE_MAP = {"MKT": "MKT", "L": "LMT", "LIMIT": "LMT", "SL": "SL-LMT", "SL-L": "SL-LMT", "SL-M": "SL-MKT", "SLM": "SL-MKT"}


class ShoonyaAdapter(BrokerAdapter):
    mode = "shoonya"
    broker_name = "Shoonya"
    terminal_id = "shoonya"

    def __init__(self) -> None:
        self._client: Any = None
        self._logged_in = False
        self._pending_auth_code: str | None = None
        self._access_token_set: bool = False
        self._ws_started = False
        # When a background (scheduler-driven) feed is open, callbacks write to
        # the terminal-scoped record instead of the central view/ws state.
        self._feed_scope: str | None = None
        # The OAuth handshake yields (access_token, user_id, refresh_token,
        # account_id) plus the broker's susertoken. It is persisted ENCRYPTED so
        # the terminal can auto-login after a restart without a browser
        # (see services/terminal_credentials.py).
        self._session_material: dict[str, Any] = {}

    # ---- capability / availability ----------------------------------------

    @property
    def capabilities(self) -> dict[str, Any]:
        return Capabilities.SHOONYA.to_dict()

    @property
    def enabled(self) -> bool:
        if not SHOONYA_SDK_AVAILABLE:
            return False
        if not settings.shoonya_enabled:
            return False
        return bool(
            settings.shoonya_api_key and settings.shoonya_secret_key
            and settings.shoonya_user_id and settings.shoonya_account_id
        )

    @property
    def is_logged_in(self) -> bool:
        return bool(self._logged_in and self._access_token_set)

    # ---- OAuth helpers -----------------------------------------------------

    def oauth_url(self) -> str | None:
        if not self.enabled:
            return None
        self._ensure_client()
        return self._client.getOAuthURL(
            f"{settings.shoonya_host.rstrip('/')}/QuickAuth/", settings.shoonya_api_key
        )

    def accept_auth_code(self, auth_code: str) -> None:
        if not auth_code or not str(auth_code).strip():
            raise BrokerError("INVALID_REQUEST", "Shoonya auth code is empty")
        self._pending_auth_code = str(auth_code).strip()
        _log.info("SHOONYA_OAUTH_CODE_ACCEPTED (short-lived code held in memory only)")

    # ---- auto-login (session restore) -------------------------------------

    def has_stored_session(self) -> bool:
        """True when an encrypted OAuth session is on disk for this terminal."""
        try:
            from services.terminal_credentials import has_session_material

            return has_session_material(self.terminal_id)
        except Exception:
            return False

    async def restore_session(self, register_central: bool = True, ws_scope: str | None = None) -> bool:
        """Restore the broker session from the STORED OAuth material.

        The Noren OAuth SDK has NO password/TOTP login — the handshake is a
        browser redirect. What it does have is a Bearer token, and
        ``set_session(userid, password, usertoken, accesstoken)`` restores a
        session from that material alone. So the FIRST login is an interactive
        handshake and every later start is automatic: the token is stored
        encrypted and re-injected here.

        Returns False (without raising) when there is nothing to restore or the
        broker rejects the stored token — the caller then needs a fresh
        handshake.
        """
        if not self.enabled:
            raise BrokerError(
                "UNSUPPORTED",
                "Shoonya terminal is not enabled — install NorenRestApiOAuth and set the "
                "SHOONYA_* secrets in the backend environment",
            )
        try:
            from services.terminal_credentials import load_session_material
        except Exception as exc:  # pragma: no cover
            _log.warning("Shoonya session restore unavailable: %s", exc)
            return False

        material = load_session_material(self.terminal_id)
        if not material:
            _log.info("SHOONYA_RESTORE_NO_MATERIAL (an OAuth handshake is required)")
            return False

        access_token = str(material.get("access_token") or "")
        susertoken = str(material.get("susertoken") or "")
        user_id = str(material.get("user_id") or settings.shoonya_user_id)
        account_id = str(material.get("account_id") or settings.shoonya_account_id)
        if not access_token:
            return False

        try:
            self._ensure_client()
            # The password argument is unused by the OAuth flow (the
            # Authorization header is the Bearer token) — the SDK's signature
            # requires it, so an empty string is passed.
            self._client.set_session(user_id, "", susertoken, access_token)
            self._client.injectOAuthHeader(access_token, user_id, account_id)
            self._client.set_credentials(access_token, user_id, account_id)
            self._session_material = dict(material)
            self._access_token_set = True
            self._logged_in = True
            if register_central:
                session_manager.set_mode("shoonya", broker=self.broker_name, user_id=user_id)
                session_manager.mark_login_success(
                    mode="shoonya", broker=self.broker_name, user_id=user_id,
                    session_ref="shoonya-oauth-session", login_source="AUTO",
                )
            else:
                session_manager.register_terminal_login(
                    "shoonya", broker=self.broker_name, user_id=user_id,
                    session_ref="shoonya-oauth-session", login_source="AUTO",
                    state_message="restored Shoonya OAuth session",
                )
            _log.info("SHOONYA_RESTORE_SUCCESS register_central=%s", register_central)
            await self._start_feed(ws_scope=ws_scope)
            return True
        except Exception as exc:
            self._logged_in = False
            self._access_token_set = False
            _log.warning("SHOONYA_RESTORE_FAILED %s (a fresh OAuth handshake is required)", exc)
            if register_central:
                session_manager.mark_login_failure(str(exc))
            return False

    # ---- session lifecycle -------------------------------------------------

    def _ensure_client(self) -> None:
        if self._client is not None:
            return
        if not SHOONYA_SDK_AVAILABLE:
            raise BrokerError("BROKER_UNAVAILABLE", "NorenRestApiOAuth SDK not installed")
        self._client = _NorenApi(
            host=settings.shoonya_host,
            websocket=settings.shoonya_websocket,
        )

    async def login(self, register_central: bool = True, ws_scope: str | None = None) -> bool:
        if not self.enabled:
            raise BrokerError(
                "UNSUPPORTED",
                "Shoonya terminal is not enabled — install NorenRestApiOAuth and set the "
                "SHOONYA_* secrets in the backend environment",
            )
        code = getattr(self, "_pending_auth_code", None)
        if not code:
            raise BrokerError(
                "AUTH_FAILED",
                "No Shoonya OAuth code — complete the broker OAuth handshake first "
                "(exchange the redirect code via the oauth-code endpoint)",
            )
        try:
            self._ensure_client()
            if register_central:
                session_manager.mark_login_started()
            token = await self._exchange_auth_code(code)
            self._pending_auth_code = None  # one-time use; never reused
            self._client.injectOAuthHeader(token, settings.shoonya_user_id, settings.shoonya_account_id)
            self._client.set_credentials(token, settings.shoonya_user_id, settings.shoonya_account_id)
            self._access_token_set = True
            self._logged_in = True
            # Persist the session material ENCRYPTED so a restart can restore the
            # session without a browser (the auto-login path).
            try:
                from services.terminal_credentials import save_session_material

                save_session_material(self.terminal_id, self._session_material)
            except Exception as exc:  # pragma: no cover - persistence is best effort
                _log.warning("Shoonya session material could not be persisted: %s", exc)
            if register_central:
                session_manager.set_mode("shoonya", broker=self.broker_name, user_id=settings.shoonya_user_id)
                session_manager.mark_login_success(
                    mode="shoonya", broker=self.broker_name,
                    user_id=settings.shoonya_user_id, session_ref="shoonya-oauth-session",
                )
            else:
                # Background (scheduler-driven) login: write only the terminal
                # record; never switch the user's active view.
                session_manager.register_terminal_login(
                    "shoonya", broker=self.broker_name,
                    user_id=settings.shoonya_user_id,
                    session_ref="shoonya-oauth-session",
                    login_source="SCHEDULER",
                    state_message="scheduled Shoonya login",
                )
            _log.info("SHOONYA_LOGIN_SUCCESS register_central=%s", register_central)
            await self._start_feed(ws_scope=ws_scope)
            return True
        except BrokerError:
            raise
        except Exception as exc:
            self._logged_in = False
            if register_central:
                session_manager.mark_login_failure(str(exc))
            else:
                session_manager.register_terminal_logout(
                    "shoonya", reason=f"login_failed: {exc}")
            _log.error("SHOONYA_LOGIN_FAILED %s", exc)
            raise BrokerError("AUTH_FAILED", f"Shoonya OAuth exchange failed: {exc}")

    async def _exchange_auth_code(self, code: str) -> str:
        """Exchange the OAuth code for the access token.

        The Noren SDK's ``getAccessToken`` returns a 4-tuple
        ``(access_token, user_id, refresh_token, account_id)`` — NOT a plain
        string. It also stores the broker's ``susertoken`` on the client
        instance. Treating the tuple as the token (as this adapter used to)
        produced a session whose Authorization header was a tuple: every
        broker call then failed with an auth error.
        """
        import asyncio

        result = await asyncio.to_thread(
            self._client.getAccessToken,
            code, settings.shoonya_secret_key, settings.shoonya_api_key, settings.shoonya_user_id,
        )
        if result is None:
            raise BrokerError("AUTH_FAILED", "Shoonya rejected the OAuth code")
        if isinstance(result, (tuple, list)):
            access_token = str(result[0] or "")
            user_id = str(result[1] or settings.shoonya_user_id)
            refresh_token = str(result[2] or "")
            account_id = str(result[3] or settings.shoonya_account_id)
        else:  # a future SDK that returns only the token
            access_token = str(result or "")
            user_id = settings.shoonya_user_id
            refresh_token = ""
            account_id = settings.shoonya_account_id
        if not access_token:
            raise BrokerError("AUTH_FAILED", "Shoonya returned an empty access token")
        self._session_material = {
            "access_token": access_token,
            "susertoken": str(getattr(self._client, "_NorenApi__susertoken", "") or ""),
            "user_id": user_id,
            "account_id": account_id,
            "refresh_token": refresh_token,
        }
        return access_token

    async def logout(self, reason: str | None = None, register_central: bool = True) -> bool:
        if self._ws_started:
            try:
                self._client.close_websocket()
            except Exception as exc:  # pragma: no cover
                _log.warn("Shoonya WS close failed: %s", exc)
            self._ws_started = False
        if self._client is not None:
            try:
                # never leaks: logout is a plain REST call using stored headers
                self._client.logout()
            except Exception as exc:  # pragma: no cover
                _log.warn("Shoonya logout call failed: %s", exc)
        self._logged_in = False
        self._access_token_set = False
        self._feed_scope = None
        if register_central:
            session_manager.mark_logout(reason or "manual_logout")
        else:
            session_manager.register_terminal_logout(
                "shoonya", reason=reason or "scheduled_logout")
        _log.info("SHOONYA_LOGOUT reason=%s", reason)
        return True

    # ---- WebSocket feeds ---------------------------------------------------

    async def _start_feed(self, ws_scope: str | None = None) -> None:
        """Open the Shoonya order/market feed (supervised, bounded) and
        subscribe to the order-update stream. Market feeds are subscription
        driven by the terminal's watchlists at the app level.

        ``ws_scope`` — when set (background/scheduler feed) every callback
        writes to that terminal's OWN record via the session manager; the
        central view and global ws state are left untouched.
        """
        if self._ws_started or self._client is None:
            return
        scope = ws_scope or self._feed_scope
        try:
            import asyncio

            def _open_cb():
                if scope:
                    session_manager.register_terminal_ws(
                        scope, "CONNECTED", reason=None)
                else:
                    session_manager.mark_ws_connected()

            def _close_cb():
                self._ws_started = False
                if scope:
                    session_manager.register_terminal_ws(
                        scope, "DISCONNECTED", reason="websocket_failure")
                else:
                    session_manager.mark_ws_disconnected("websocket_failure")

            def _err_cb(err):
                self._ws_started = False
                if scope:
                    session_manager.register_terminal_ws(
                        scope, "DISCONNECTED", reason=f"websocket_error: {err}")
                else:
                    session_manager.mark_ws_disconnected(f"websocket_error: {err}")

            await asyncio.to_thread(
                self._client.start_websocket,
                subscribe_callback=self._on_tick,
                order_update_callback=self._on_order_update,
                socket_open_callback=_open_cb,
                socket_close_callback=_close_cb,
                socket_error_callback=_err_cb,
            )
            self._client.subscribe_orders()
            self._ws_started = True
            self._feed_scope = scope
            if scope:
                session_manager.register_terminal_ws(scope, "CONNECTING")
            else:
                session_manager.mark_ws_connecting()
            _log.info("SHOONYA_WS_STARTED scope=%s", scope or "central")
        except Exception as exc:  # pragma: no cover
            _log.warn("Shoonya WS start failed (session still active): %s", exc)

    async def ensure_feed(self, ws_scope: str | None = None) -> bool:
        """(Re)start the feed when the socket is not currently open."""
        if self._ws_started or self._client is None:
            return self._ws_started
        await self._start_feed(ws_scope=ws_scope)
        return self._ws_started

    def stop_feed(self, reason: str | None = None) -> None:
        """Close the Shoonya order feed; the OAuth session stays valid."""
        if self._ws_started:
            try:
                self._client.close_websocket()
            except Exception as exc:  # pragma: no cover
                _log.warn("Shoonya WS close failed: %s", exc)
            self._ws_started = False
        if self._feed_scope:
            session_manager.register_terminal_ws(
                self._feed_scope, "STOPPED", reason=reason or "scheduled_disconnect")
        self._feed_scope = None

    def _on_tick(self, message: Any) -> None:
        if self._feed_scope:
            session_manager.register_terminal_ws(
                self._feed_scope, "CONNECTED", last_message_at=time.time())
            return
        session_manager.mark_ws_message()

    def _on_order_update(self, message: Any) -> None:
        if self._feed_scope:
            session_manager.register_terminal_ws(
                self._feed_scope, "CONNECTED", last_message_at=time.time())
            return
        session_manager.mark_ws_message()

    # ---- read endpoints ----------------------------------------------------

    async def funds(self) -> dict[str, Any]:
        self._require()
        return await self._call(lambda: self._client.get_limits())

    async def positions(self) -> dict[str, Any]:
        self._require()
        return await self._call(lambda: self._client.get_positions())

    async def holdings(self) -> dict[str, Any]:
        self._require()
        return await self._call(lambda: self._client.get_holdings())

    async def orders(self) -> dict[str, Any]:
        self._require()
        return await self._call(lambda: self._client.get_order_book())

    async def order_history(self, order_id: str | None = None) -> dict[str, Any]:
        self._require()
        if order_id:
            return await self._call(lambda: self._client.single_order_history(order_id))
        return await self.orders()

    async def trade_book(self) -> dict[str, Any]:
        self._require()
        return await self._call(lambda: self._client.get_trade_book())

    # ---- order actions -----------------------------------------------------

    async def place_order(
        self,
        *,
        exchange: str = "nse_esc",
        token: str = "",
        symbol: str = "",
        transaction_type: str = "BUY",
        product: str = "MIS",
        order_type: str = "MKT",
        quantity: str = "1",
        price: str = "0",
        trigger_price: str = "0",
        validity: str = "DAY",
        disclosed_quantity: str = "0",
        amo: str = "NO",
        market_protection: str = "NO",
        client_id: str = "",
        expected_ltp: str = "0",
    ) -> dict[str, Any]:
        # Accepted for contract parity — Noren resolves its own LTP server-side.
        self._require()
        product_type = _PROD_MAP.get(str(product).upper(), "I")
        price_type = _ORDER_TYPE_MAP.get(str(order_type).upper(), "MKT")
        buy_or_sell = _TX_MAP.get(str(transaction_type).upper(), "B")
        try:
            result = await self._call(lambda: self._client.place_order(
                buy_or_sell=buy_or_sell,
                product_type=product_type,
                exchange=self._exchange_code(exchange),
                tradingsymbol=symbol or str(token),
                quantity=str(quantity),
                discloseqty=str(disclosed_quantity) or "0",
                price_type=price_type,
                price=safe_float(price),
                trigger_price=safe_float(trigger_price) or None,
                retention=str(validity) or "DAY",
                amo=str(amo) or None,
            ))
            return {"data": result, "stat": "ok", "isShoonya": True}
        except Exception as exc:
            raise self._normalize_exc(exc, "place_order")

    async def modify_order(
        self,
        *,
        order_id: str,
        exchange: str = "nse_esc",
        token: str = "",
        symbol: str = "",
        quantity: str = "1",
        price: str = "0",
        trigger_price: str = "0",
        order_type: str = "MKT",
        validity: str = "DAY",
        disclosed_quantity: str = "0",
    ) -> dict[str, Any]:
        self._require()
        price_type = _ORDER_TYPE_MAP.get(str(order_type).upper(), "MKT")
        try:
            result = await self._call(lambda: self._client.modify_order(
                orderno=str(order_id),
                exchange=self._exchange_code(exchange),
                tradingsymbol=str(symbol) or str(token),
                newquantity=str(quantity),
                newprice_type=price_type,
                newprice=safe_float(price),
                newtrigger_price=safe_float(trigger_price) or None,
            ))
            return {"data": result, "stat": "ok", "isShoonya": True}
        except Exception as exc:
            raise self._normalize_exc(exc, "modify_order")

    async def cancel_order(self, order_id: str) -> dict[str, Any]:
        self._require()
        try:
            result = await self._call(lambda: self._client.cancel_order(orderno=str(order_id)))
            return {"data": result, "stat": "ok", "isShoonya": True}
        except Exception as exc:
            raise self._normalize_exc(exc, "cancel_order")

    async def square_off(
        self,
        *,
        exchange: str = "nse_esc",
        token: str = "",
        symbol: str = "",
        product: str = "MIS",
        quantity: str = "1",
        position_type: str = "LONG",
    ) -> dict[str, Any]:
        pos_exchange = self._exchange_code(exchange)
        # Square-off is executed as an opposite-direction market order (the
        # standard Noren behaviour for MIS/NRML positions).
        try:
            tx_type = "SELL" if str(position_type).upper() in ("LONG", "BUY") else "BUY"
            return await self.place_order(
                exchange=exchange, token=token, symbol=symbol,
                transaction_type=tx_type, product=product, order_type="MKT",
                quantity=quantity, price="0", trigger_price="0",
            )
        except Exception as exc:
            raise self._normalize_exc(exc, "square_off")

    # ---- market data -------------------------------------------------------

    async def search(self, exchange: str = "nse_cm", search_text: str = "") -> dict[str, Any]:
        self._require()
        try:
            result = await self._call(lambda: self._client.searchscrip(self._exchange_code(exchange), search_text))
            values = result.get("values", []) if isinstance(result, dict) else []
            return {"data": values, "stat": "ok", "source": "shoonya_api"}
        except Exception as exc:
            raise self._normalize_exc(exc, "search")

    async def quote(self, instrument_tokens: list[dict], quote_type: str = "ltp") -> dict[str, Any]:
        self._require()
        rows = []
        try:
            for token_ref in instrument_tokens or []:
                exchange = self._exchange_code(token_ref.get("exchange_segment", "nse_cm"))
                token = str(token_ref.get("instrument_token", "") or "")
                result = await self._call(lambda: self._client.get_quotes(exchange, token))
                if isinstance(result, dict):
                    rows.append(
                        {
                            "exchange_token": token,
                            "last_price": safe_float(result.get("lp") or result.get("ltp")),
                            "open": safe_float(result.get("oc")),
                            "high": safe_float(result.get("h")),
                            "low": safe_float(result.get("l")),
                            "close": safe_float(result.get("lc")),
                            "volume": result.get("v"),
                            "ltp": safe_float(result.get("lp") or result.get("ltp")),
                            "ohlc": {
                                "open": safe_float(result.get("oc")),
                                "high": safe_float(result.get("h")),
                                "low": safe_float(result.get("l")),
                                "close": safe_float(result.get("lc")),
                            },
                        }
                    )
            return {"data": rows, "stat": "ok", "source": "shoonya_api"}
        except Exception as exc:
            raise self._normalize_exc(exc, "quote")

    # ---- helpers -----------------------------------------------------------

    async def _call(self, fn: Callable[[], Any]) -> dict[str, Any]:
        """Run a blocking Shoonya SDK call in a thread with a bounded timeout."""
        import asyncio

        return await asyncio.wait_for(
            asyncio.to_thread(fn), timeout=settings.broker_api_timeout,
        )

    def _require(self) -> None:
        if not self.enabled:
            raise BrokerError(
                "UNSUPPORTED",
                "Shoonya terminal is not enabled — set the SHOONYA_* secrets",
            )
        if not self.is_logged_in:
            raise BrokerError("NOT_LOGGED_IN", "Shoonya session required (complete OAuth login first)")

    @staticmethod
    def _exchange_code(exchange: str) -> str:
        ex = (exchange or "").lower()
        if "bse" in ex:
            return "B"
        if "nfo" in ex or "mcx" in ex:
            return "N"
        return "N"

    @staticmethod
    def _normalize_exc(exc: Exception, action: str) -> BrokerError:
        text = str(exc)
        lowered = text.lower()
        if any(k in lowered for k in ("timesout", "timeout", "timed out")):
            return BrokerError("ORDER_TIMEOUT", f"{action} timed out", meta={"detail": text})
        if any(k in lowered for k in ("no token", "access", "unauthorised", "invalid token", "session")):
            return BrokerError("AUTH_FAILED", f"{action} rejected: {text}")
        if any(k in lowered for k in ("margin", "insufficient", "exposures")):
            return BrokerError("INSUFFICIENT_MARGIN", f"{action} rejected: {text}")
        if "rejected" in lowered or "error" in lowered:
            return BrokerError("ORDER_REJECTED", f"{action} rejected: {text}")
        return BrokerError("BROKER_UNAVAILABLE", f"{action} failed: {text}")


shoonya_adapter = ShoonyaAdapter()