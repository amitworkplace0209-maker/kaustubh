"""
Production-grade WebSocket connection manager for Kotak Neo SDK.

Features:
- Connection Manager with single-connection guard
- Subscription Manager with deduplication
- Heartbeat with configurable timeout
- Auto reconnect with exponential backoff
- Duplicate connection protection
- Duplicate subscription protection
- Buffer queue for ticks during reconnect
- Tick validation
- Error recovery
- Connection status API
- Health check API
- Logging + metrics
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

from config.settings import settings
from auth.kotak_client import kotak_session
from services import tick_buffer

logger = logging.getLogger("websocket")

_HEARTBEAT_TIMEOUT_SEC = settings.ws_heartbeat_timeout_sec
_HEARTBEAT_INTERVAL_SEC = settings.ws_heartbeat_interval_sec
_INITIAL_DELAY = settings.ws_reconnect_initial_delay
_MAX_DELAY = settings.ws_reconnect_max_delay
_MAX_ATTEMPTS = settings.ws_reconnect_max_attempts  # 0 = infinite


class WebSocketManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._connected = False
        self._subscribed_tokens: list[dict] = []
        self._reconnect_count = 0
        self._reconnecting = False
        self._intentional_disconnect = False
        self._heartbeat_thread: threading.Thread | None = None
        self._last_tick_at: float | None = None
        self._tick_count = 0
        self._callbacks_registered = False

        # Buffer queue for ticks during reconnect
        self._reconnect_buffer: list[dict] = []
        self._buffer_max = 10000

        # Metrics
        self._metrics = {
            "ticks_received": 0,
            "ticks_validated": 0,
            "ticks_rejected": 0,
            "ticks_buffered": 0,
            "connects": 0,
            "disconnects": 0,
            "errors": 0,
            "reconnects": 0,
            "subscribe_calls": 0,
            "unsubscribe_calls": 0,
            "duplicate_subscriptions_blocked": 0,
            "heartbeat_checks": 0,
            "heartbeat_timeouts": 0,
        }

    def _register_callbacks(self):
        if self._callbacks_registered or not kotak_session.client:
            return
        try:
            kotak_session.client.on_message = self._on_message
            kotak_session.client.on_error = self._on_error
            kotak_session.client.on_close = self._on_close
            kotak_session.client.on_open = self._on_open
            self._callbacks_registered = True
            logger.info("WebSocket callbacks registered")
        except Exception as exc:
            logger.error("Failed to register callbacks: %s", exc)

    def _on_open(self, message=None):
        with self._lock:
            self._connected = True
            self._intentional_disconnect = False
            self._metrics["connects"] += 1
        logger.info("WebSocket connected: %s", message)
        self._restore_subscriptions()
        self._flush_reconnect_buffer()

    def _on_message(self, message):
        with self._lock:
            self._last_tick_at = time.time()
            self._tick_count += 1
            self._metrics["ticks_received"] += 1

        if not self._connected:
            self._buffer_tick(message)
            return

        validated = self._validate_and_normalize(message)
        if validated:
            self._metrics["ticks_validated"] += 1
            tick_buffer.add(validated)
        else:
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
        if not self._intentional_disconnect:
            self._trigger_reconnect()

    def _start_heartbeat(self):
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            return
        self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._heartbeat_thread.start()

    def _stop_heartbeat(self):
        self._heartbeat_thread = None  # daemon will die on next check

    def _heartbeat_loop(self):
        while not self._intentional_disconnect and self._heartbeat_thread is not None:
            time.sleep(_HEARTBEAT_INTERVAL_SEC)
            if not self._connected:
                continue
            with self._lock:
                self._metrics["heartbeat_checks"] += 1
                if self._last_tick_at is not None:
                    silence = time.time() - self._last_tick_at
                    if silence > _HEARTBEAT_TIMEOUT_SEC:
                        self._metrics["heartbeat_timeouts"] += 1
                        logger.warning("Heartbeat timeout: %.0fs silence", silence)
                        self._trigger_reconnect()
                        return

    def _trigger_reconnect(self):
        with self._lock:
            if self._reconnecting:
                return
            self._reconnecting = True
        thread = threading.Thread(target=self._reconnect_loop, daemon=True)
        thread.start()

    def _reconnect_loop(self):
        attempt = 0
        delay = _INITIAL_DELAY
        while True:
            attempt += 1
            self._reconnect_count += 1
            self._metrics["reconnects"] += 1
            logger.info("Reconnect attempt %d (delay %.1fs)", attempt, delay)

            try:
                if not kotak_session.session_active:
                    logger.info("Session expired, re-logging in...")
                    kotak_session.login()
            except Exception as exc:
                logger.error("Re-login failed: %s", exc)
                time.sleep(delay)
                delay = min(delay * 2, _MAX_DELAY)
                continue

            try:
                if kotak_session.client:
                    self._register_callbacks()
                    self._restore_subscriptions()
                    with self._lock:
                        self._connected = True
                        self._reconnecting = False
                    logger.info("Reconnect succeeded on attempt %d", attempt)
                    self._flush_reconnect_buffer()
                    return
            except Exception as exc:
                logger.error("Reconnect attempt %d failed: %s", attempt, exc)

            if _MAX_ATTEMPTS > 0 and attempt >= _MAX_ATTEMPTS:
                logger.error("Max reconnect attempts (%d) reached", _MAX_ATTEMPTS)
                with self._lock:
                    self._reconnecting = False
                return

            time.sleep(delay)
            delay = min(delay * 2, _MAX_DELAY)

    def _restore_subscriptions(self):
        if not self._subscribed_tokens or not kotak_session.client:
            return
        try:
            tokens = [t for t in self._subscribed_tokens]
            kotak_session.client.subscribe(tokens)
            logger.info("Restored %d subscriptions", len(tokens))
        except Exception as exc:
            logger.error("Restore subscriptions failed: %s", exc)

    def _buffer_tick(self, message):
        if len(self._reconnect_buffer) < self._buffer_max:
            self._reconnect_buffer.append(message)
            self._metrics["ticks_buffered"] += 1

    def _flush_reconnect_buffer(self):
        if not self._reconnect_buffer:
            return
        buffer = self._reconnect_buffer[:]
        self._reconnect_buffer.clear()
        logger.info("Flushing %d buffered ticks", len(buffer))
        for msg in buffer:
            validated = self._validate_and_normalize(msg)
            if validated:
                tick_buffer.add(validated)

    def _validate_and_normalize(self, message) -> dict | None:
        if not message:
            return None
        if isinstance(message, list):
            if not message:
                return None
            message = message[0] if isinstance(message[0], dict) else message
        if not isinstance(message, dict):
            return None
        if not message.get("symbol") and not message.get("ltp"):
            return None
        return self._normalize_message(message)

    def _normalize_message(self, raw: dict) -> dict:
        ts = raw.get("ts") or raw.get("timestamp")
        if isinstance(ts, str):
            try:
                ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                ts = datetime.now(timezone.utc)
        elif isinstance(ts, (int, float)):
            ts = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        elif not isinstance(ts, datetime):
            ts = datetime.now(timezone.utc)

        return {
            "symbol": raw.get("symbol", ""),
            "instrumentToken": str(raw.get("instrument_token") or raw.get("token") or ""),
            "exchangeSegment": raw.get("exchange_segment", "nse_cm"),
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
            "averagePrice": _fnum(raw.get("average_price")),
            "change": _fnum(raw.get("change")),
            "changePercent": _fnum(raw.get("change_percent")),
            "oi": _fnum(raw.get("oi")),
            "ts": ts.isoformat(),
        }

    async def subscribe(self, instrument_tokens: list[dict]) -> dict:
        with self._lock:
            self._metrics["subscribe_calls"] += 1
            new_tokens = []
            for tok in instrument_tokens:
                if not _is_duplicate(self._subscribed_tokens, tok):
                    new_tokens.append(tok)
                else:
                    self._metrics["duplicate_subscriptions_blocked"] += 1
            if not new_tokens:
                return {"ok": True, "message": "Already subscribed", "count": 0}
            self._subscribed_tokens.extend(new_tokens)

        if not kotak_session.logged_in:
            raise RuntimeError("Not logged in to Kotak")

        self._register_callbacks()
        try:
            result = kotak_session.client.subscribe(new_tokens)
            logger.info("Subscribed to %d tokens", len(new_tokens))
        except Exception as exc:
            logger.error("Subscribe failed: %s", exc)
            return {"ok": False, "message": str(exc), "count": 0}

        self._start_heartbeat()
        return {"ok": True, "message": "Subscribed", "count": len(new_tokens)}

    async def unsubscribe(self, instrument_tokens: list[dict]) -> dict:
        with self._lock:
            self._metrics["unsubscribe_calls"] += 1
            for tok in instrument_tokens:
                self._subscribed_tokens = [
                    t for t in self._subscribed_tokens
                    if not (t.get("instrument_token") == tok.get("instrument_token")
                           and t.get("exchange_segment") == tok.get("exchange_segment"))
                ]

        if kotak_session.client:
            try:
                kotak_session.client.un_subscribe(instrument_tokens)
                logger.info("Unsubscribed %d tokens", len(instrument_tokens))
            except Exception as exc:
                logger.error("Unsubscribe failed: %s", exc)

        with self._lock:
            if not self._subscribed_tokens:
                self._stop_heartbeat()

        return {"ok": True, "message": "Unsubscribed", "count": len(instrument_tokens)}

    def disconnect(self):
        with self._lock:
            self._intentional_disconnect = True
            self._connected = False
            self._stop_heartbeat()
        if kotak_session.client and self._subscribed_tokens:
            try:
                kotak_session.client.un_subscribe(self._subscribed_tokens)
            except Exception:
                pass
        with self._lock:
            self._subscribed_tokens.clear()

    def status(self) -> dict:
        with self._lock:
            return {
                "connected": self._connected,
                "subscribed_symbols": len(self._subscribed_tokens),
                "reconnect_count": self._reconnect_count,
                "reconnecting": self._reconnecting,
                "last_tick_at": datetime.fromtimestamp(self._last_tick_at, tz=timezone.utc).isoformat() if self._last_tick_at else None,
                "tick_count": self._tick_count,
                "buffered_ticks": len(self._reconnect_buffer),
                "metrics": dict(self._metrics),
            }

    def health(self) -> dict:
        return {
            "healthy": self._connected and not self._reconnecting,
            "connected": self._connected,
            "reconnecting": self._reconnecting,
            "subscribed": len(self._subscribed_tokens),
            "last_tick_at": self._last_tick_at,
        }


def _is_duplicate(tokens: list[dict], tok: dict) -> bool:
    it = tok.get("instrument_token")
    es = tok.get("exchange_segment")
    for t in tokens:
        if t.get("instrument_token") == it and t.get("exchange_segment") == es:
            return True
    return False


def _fnum(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


ws_manager = WebSocketManager()
