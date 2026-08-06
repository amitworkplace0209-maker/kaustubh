"""
Kotak Neo Python SDK — FastAPI backend settings.

All application configuration lives here. Loaded from environment variables
at import time via dotenv.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


def _required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _optional(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    return value if value else default


@dataclass
class Settings:
    # ---- Kotak SDK credentials ----
    client_id: str = field(default_factory=lambda: _required("CLIENT_ID"))
    consumer_key: str = field(default_factory=lambda: _required("CONSUMER_KEY"))
    consumer_secret: str = field(default_factory=lambda: _required("CONSUMER_SECRET"))
    mobile_number: str = field(default_factory=lambda: _required("MOBILE_NUMBER"))
    mpin: str = field(default_factory=lambda: _required("MPIN"))
    totp_secret: str = field(default_factory=lambda: _required("TOTP_SECRET"))

    # ---- MongoDB ----
    mongodb_uri: str = field(default_factory=lambda: _optional("MONGODB_URI", "mongodb://localhost:27017/kaustubh"))
    mongodb_database: str = field(default_factory=lambda: _optional("MONGODB_DATABASE", "kaustubh"))

    # ---- Service ----
    host: str = field(default_factory=lambda: _optional("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(_optional("PORT", "8000")))  # type: ignore[arg-type]
    log_level: str = field(default_factory=lambda: _optional("LOG_LEVEL", "info"))

    # ---- CORS ----
    cors_origins: str = field(default_factory=lambda: _optional("CORS_ORIGINS", "*"))

    # ---- Scheduler (IST) ----
    login_hour: int = field(default_factory=lambda: int(_optional("LOGIN_HOUR", "9")))  # type: ignore[arg-type]
    login_minute: int = field(default_factory=lambda: int(_optional("LOGIN_MINUTE", "0")))  # type: ignore[arg-type]
    logout_hour: int = field(default_factory=lambda: int(_optional("LOGOUT_HOUR", "15")))  # type: ignore[arg-type]
    logout_minute: int = field(default_factory=lambda: int(_optional("LOGOUT_MINUTE", "35")))  # type: ignore[arg-type]

    # ---- SDK ----
    environment: str = field(default_factory=lambda: _optional("NEO_ENVIRONMENT", "prod"))

    # ---- WebSocket reconnect ----
    ws_reconnect_initial_delay: float = field(default_factory=lambda: float(_optional("WS_RECONNECT_INITIAL_DELAY", "1.0")))  # type: ignore[arg-type]
    ws_reconnect_max_delay: float = field(default_factory=lambda: float(_optional("WS_RECONNECT_MAX_DELAY", "60.0")))  # type: ignore[arg-type]
    ws_reconnect_max_attempts: int = field(default_factory=lambda: int(_optional("WS_RECONNECT_MAX_ATTEMPTS", "0")))  # type: ignore[arg-type]
    ws_heartbeat_timeout_sec: int = field(default_factory=lambda: int(_optional("WS_HEARTBEAT_TIMEOUT_SEC", "30")))  # type: ignore[arg-type]
    ws_heartbeat_interval_sec: int = field(default_factory=lambda: int(_optional("WS_HEARTBEAT_INTERVAL_SEC", "5")))  # type: ignore[arg-type]

    # ---- Tick buffer ----
    buffer_flush_interval_ms: int = field(default_factory=lambda: int(_optional("BUFFER_FLUSH_INTERVAL_MS", "1000")))  # type: ignore[arg-type]
    buffer_max_size: int = field(default_factory=lambda: int(_optional("BUFFER_MAX_SIZE", "5000")))  # type: ignore[arg-type]
    bulk_insert_size: int = field(default_factory=lambda: int(_optional("BULK_INSERT_SIZE", "1000")))  # type: ignore[arg-type]

    # ---- TOTP ----
    totp_issuer: str = field(default_factory=lambda: _optional("TOTP_ISSUER", "kotakneo.com"))
    totp_digits: int = 6
    totp_interval: int = 30


settings = Settings()
