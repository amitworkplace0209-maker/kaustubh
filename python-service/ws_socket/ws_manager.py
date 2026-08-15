from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

from auth.kotak_client import kotak_session
from services import tick_buffer

logger = logging.getLogger("websocket")


class WebSocketManager:
    """
    Thin WebSocket manager for Kotak Neo SDK.

    Responsibilities:
    - Register SDK callbacks
    - Track subscriptions
    - Prevent duplicate subscriptions
    - Receive and normalize ticks
    - Send ticks to tick_buffer
    - Expose connection status
    - Cleanly unsubscribe during shutdown

    WebSocket connection/reconnection lifecycle is owned by
    the Kotak Neo SDK and scheduler.
    """

    def __init__(self):
        self._lock = threading.RLock()

        self._connected = False
        self._subscribed_tokens: list[dict] = []
        self._token_symbols: dict[str, str] = {}
        

        self._last_tick_at: float | None = None
        self._tick_count = 0

        self._callbacks_registered = False
        self._callback_client_id: int | None = None

        self._metrics = {
            "ticks_received": 0,
            "ticks_validated": 0,
            "ticks_rejected": 0,
            "connects": 0,
            "disconnects": 0,
            "errors": 0,
            "subscribe_calls": 0,
            "unsubscribe_calls": 0,
            "duplicate_subscriptions_blocked": 0,
        }

    # ---------------------------------------------------------
    # CALLBACKS
    # ---------------------------------------------------------

    def _register_callbacks(self):
        client = kotak_session.client

        if not client:
            return

        client_id = id(client)

        # Important:
        # If Kotak creates a new NeoAPI client after login,
        # callbacks must be registered again.
        if (
            self._callbacks_registered
            and self._callback_client_id == client_id
        ):
            return

        try:
            client.on_message = self._on_message
            client.on_error = self._on_error
            client.on_close = self._on_close
            client.on_open = self._on_open

            self._callbacks_registered = True
            self._callback_client_id = client_id

            logger.info("WebSocket callbacks registered")

        except Exception:
            self._callbacks_registered = False
            self._callback_client_id = None
            logger.exception("Failed to register WebSocket callbacks")

    def _on_open(self, message=None):
        with self._lock:
            self._connected = True
            self._metrics["connects"] += 1

        logger.info("WebSocket connected: %s", message)

    def _on_message(self, message):
        with self._lock:
            connected = self._connected

        if not connected:
          return

    # Kotak SDK stock feed format:
    # {
    #     "type": "stock_feed",
    #     "data": [...]
    # }
        if isinstance(message, dict) and message.get("type") == "stock_feed":
          data = message.get("data")

        if isinstance(data, list):
            ticks = data
        elif isinstance(data, dict):
            ticks = [data]
        else:
            ticks = []

        for tick in ticks:
            if not isinstance(tick, dict):
                continue
            

            with self._lock:
                self._last_tick_at = time.time()
                self._tick_count += 1
                self._metrics["ticks_received"] += 1
                self._metrics["ticks_validated"] += 1
            instrument_token = str(
                tick.get("tk")
                or tick.get("instrumentToken")
                or tick.get("instrument_token")
                or tick.get("token")
                or ""
            )
                

            with self._lock:
                symbol = self._token_symbols.get(instrument_token)

            if symbol:
                tick["symbol"] = symbol
            

            normalized_tick = tick_buffer._normalize_tick(tick)
            
            tick_buffer.add(normalized_tick)

                

            

           

           

        return
        with self._lock:
            self._metrics["ticks_rejected"] += 1

    def _on_error(self, error):
        with self._lock:
            self._metrics["errors"] += 1

        logger.error("WebSocket error: %s", error)

    def _on_close(self, message=None):
        with self._lock:
            self._connected = False
            self._metrics["disconnects"] += 1

        logger.warning("WebSocket closed: %s", message)

    # ---------------------------------------------------------
    # SUBSCRIBE
    # ---------------------------------------------------------

    async def subscribe(self, instrument_tokens: list[dict]) -> dict:
        if not instrument_tokens:
            return {
                "ok": False,
                "message": "No instrument tokens supplied",
                "count": 0,
            }

        

        

        if not kotak_session.logged_in:
            return {
                "ok": False,
                "message": "Not logged in to Kotak",
                "count": 0,
            }

        client = kotak_session.client

        if not client:
            return {
                "ok": False,
                "message": "Kotak SDK client is not available",
                "count": 0,
            }

        self._register_callbacks()

        new_tokens = []

        with self._lock:
            for token in instrument_tokens:
                if _is_duplicate(self._subscribed_tokens, token):
                    self._metrics["duplicate_subscriptions_blocked"] += 1
                    continue

                new_tokens.append(token)

        if not new_tokens:
            return {
                "ok": True,
                "message": "Already subscribed",
                "count": 0,
            }

        try:
            client.subscribe(new_tokens)

        except Exception as exc:
            logger.exception("Kotak subscribe failed")

            return {
                "ok": False,
                "message": str(exc),
                "count": 0,
            }

        # Only update our state AFTER SDK subscription succeeds.
        with self._lock:
            self._subscribed_tokens.extend(new_tokens)
       

            for token in new_tokens:
                instrument_token = str(token.get("instrument_token", ""))
                symbol = token.get("symbol")

                if instrument_token and symbol:
                    self._token_symbols[instrument_token] = str(symbol)

        logger.info(
            "Subscribed to %d tokens",
            len(new_tokens),
        )

        return {
            "ok": True,
            "message": "Subscribed",
            "count": len(new_tokens),
        }

    # ---------------------------------------------------------
    # UNSUBSCRIBE
    # ---------------------------------------------------------

    async def unsubscribe(self, instrument_tokens: list[dict]) -> dict:
        if not instrument_tokens:
            return {
                "ok": True,
                "message": "No instrument tokens supplied",
                "count": 0,
            }

        with self._lock:
            self._metrics["unsubscribe_calls"] += 1

        client = kotak_session.client

        if client:
            try:
                client.un_subscribe(instrument_tokens)

            except Exception as exc:
                logger.exception("Kotak unsubscribe failed")

                return {
                    "ok": False,
                    "message": str(exc),
                    "count": 0,
                }

        with self._lock:
            for token in instrument_tokens:
                self._subscribed_tokens = [
                    existing
                    for existing in self._subscribed_tokens
                    if not (
                        existing.get("instrument_token")
                        == token.get("instrument_token")
                        and existing.get("exchange_segment")
                        == token.get("exchange_segment")
                    )
                ]

        logger.info(
            "Unsubscribed %d tokens",
            len(instrument_tokens),
        )

        return {
            "ok": True,
            "message": "Unsubscribed",
            "count": len(instrument_tokens),
        }

    # ---------------------------------------------------------
    # DISCONNECT
    # ---------------------------------------------------------

    def disconnect(self):
        """
        Called by scheduler during logout/shutdown.

        Does not create or destroy the SDK WebSocket directly.
        It only unsubscribes tracked instruments and clears state.
        """

        with self._lock:
            tokens = list(self._subscribed_tokens)
            self._subscribed_tokens.clear()
            self._connected = False

        client = kotak_session.client

        if client and tokens:
            try:
                client.un_subscribe(tokens)

            except Exception:
                logger.exception(
                    "Failed to unsubscribe during WebSocket shutdown"
                )

        logger.info(
            "WebSocket manager disconnected; cleared %d subscriptions",
            len(tokens),
        )

    # ---------------------------------------------------------
    # STATUS
    # ---------------------------------------------------------

    def status(self) -> dict:
        with self._lock:
            last_tick_at = self._last_tick_at

            return {
                "connected": self._connected,
                "subscribed_symbols": len(self._subscribed_tokens),
                "last_tick_at": (
                    datetime.fromtimestamp(
                        last_tick_at,
                        tz=timezone.utc,
                    ).isoformat()
                    if last_tick_at
                    else None
                ),
                "tick_count": self._tick_count,
                "metrics": dict(self._metrics),
            }

    # ---------------------------------------------------------
    # HEALTH
    # ---------------------------------------------------------

    def health(self) -> dict:
        with self._lock:
            return {
                "healthy": self._connected,
                "connected": self._connected,
                "subscribed": len(self._subscribed_tokens),
                "last_tick_at": self._last_tick_at,
            }

    # ---------------------------------------------------------
    # TICK NORMALIZATION
    # ---------------------------------------------------------

    def _validate_and_normalize(self, message) -> dict | None:
        if not message:
            return None

        if isinstance(message, list):
            if not message:
                return None

            if isinstance(message[0], dict):
                message = message[0]
            else:
                return None

        if not isinstance(message, dict):
            return None

        # Accept a tick only if it contains useful market data.
        if not message.get("symbol") and not message.get("ltp"):
            return None

        return self._normalize_message(message)

    def _normalize_message(self, raw: dict) -> dict:
        ts = raw.get("ts") or raw.get("timestamp")

        if isinstance(ts, str):
            try:
                ts = datetime.fromisoformat(
                    ts.replace("Z", "+00:00")
                )
            except ValueError:
                ts = datetime.now(timezone.utc)

        elif isinstance(ts, (int, float)):
            # SDK timestamps can be milliseconds.
            ts = datetime.fromtimestamp(
                ts / 1000,
                tz=timezone.utc,
            )

        elif not isinstance(ts, datetime):
            ts = datetime.now(timezone.utc)

        return {
            "symbol": raw.get("symbol", ""),
            "instrumentToken": str(
                raw.get("instrument_token")
                or raw.get("token")
                or ""
            ),
            "exchangeSegment": raw.get(
                "exchange_segment",
                "nse_cm",
            ),
            "ltp": _fnum(raw.get("ltp")),
            "open": _fnum(raw.get("open")),
            "high": _fnum(raw.get("high")),
            "low": _fnum(raw.get("low")),
            "close": _fnum(raw.get("close")),
            "volume": _fnum(raw.get("volume")),
            "ltq": _fnum(raw.get("ltq")),
            "tbq": _fnum(raw.get("tbq")),
            "tsq": _fnum(raw.get("tsq")),
            "bp": _fnum(raw.get("bp")),
            "sp": _fnum(raw.get("sp")),
            "bq": _fnum(raw.get("bq")),
            "bs": _fnum(raw.get("bs")),
            "averagePrice": _fnum(
                raw.get("average_price")
            ),
            "change": _fnum(raw.get("change")),
            "changePercent": _fnum(
                raw.get("change_percent")
            ),
            "oi": _fnum(raw.get("oi")),
            "ts": ts.isoformat(),
        }


# -------------------------------------------------------------
# HELPERS
# -------------------------------------------------------------

def _is_duplicate(tokens: list[dict], token: dict) -> bool:
    instrument_token = token.get("instrument_token")
    exchange_segment = token.get("exchange_segment")

    return any(
        existing.get("instrument_token") == instrument_token
        and existing.get("exchange_segment") == exchange_segment
        for existing in tokens
    )


def _fnum(value) -> float | None:
    if value is None:
        return None

    try:
        return float(value)

    except (TypeError, ValueError):
        return None


ws_manager = WebSocketManager()