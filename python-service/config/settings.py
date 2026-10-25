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
# Local dev overrides (backend-only secrets like APP_PASSWORD / JWT_SECRET).
# Dotenv never overrides real environment variables; .env.local is gitignored.
from pathlib import Path as _Path
_env_local = _Path(os.path.dirname(os.path.abspath(__file__))).parent / ".env.local"
if _env_local.exists():
    load_dotenv(str(_env_local), override=False)


def _required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _optional(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    return value if value else default


def _env(name: str, default: str = "") -> str:
    return os.getenv(name) or default


class MongoDbConfigurationError(RuntimeError):
    """MONGODB_URI is missing or not a valid MongoDB connection string.

    Raised during configuration validation. The message never contains the URI
    or any credential.
    """


@dataclass
class Settings:
# ---- Kotak SDK credentials ----
    client_id: str = field(default_factory=lambda: _env("CLIENT_ID"))
    consumer_key: str = field(default_factory=lambda: _env("CONSUMER_KEY"))
    mobile_number: str = field(default_factory=lambda: _env("MOBILE_NUMBER"))
    mpin: str = field(default_factory=lambda: _env("MPIN"))
    totp_secret: str = field(default_factory=lambda: _env("TOTP_SECRET"))

    # ---- MongoDB ----
    # MONGODB_URI is REQUIRED and has no default. The backend connects to
    # whatever valid MongoDB URI is provided:
    #   mongodb://127.0.0.1:27017/kaustubh        -> Local MongoDB
    #   mongodb://localhost:27017/kaustubh        -> Local MongoDB
    #   mongodb+srv://user:pass@cluster.net/db    -> MongoDB Atlas
    # The URI decides the destination; the application code does not care.
    #
    # Backend-only secret. Never exposed to the frontend, never printed in logs
    # (only the redacted host is logged) — see database.connection._redact_uri.
    mongodb_uri: str = field(default_factory=lambda: _env("MONGODB_URI"))
    # Database name fallback if URI doesn't contain one.
    mongodb_database: str = field(default_factory=lambda: _env("MONGODB_DATABASE", "kaustubh"))

    # Test database (optional) — used by integration tests to avoid touching
    # the production database. If not set, tests that need MongoDB will use
    # the main MONGODB_URI (or skip if unavailable).
    mongodb_test_uri: str = field(default_factory=lambda: _env("MONGODB_TEST_URI"))
    mongodb_test_database: str = field(default_factory=lambda: _env("MONGODB_TEST_DATABASE", "kaustubh_test"))

    # Shared-connection pool / timeout tuning. ONE client serves the whole
    # process (no per-request connections); Motor reuses sockets from the pool
    # and re-establishes them automatically after a network drop.
    mongodb_server_selection_timeout_ms: int = field(
        default_factory=lambda: int(_optional("MONGODB_SERVER_SELECTION_TIMEOUT_MS", "15000")))  # type: ignore[arg-type]
    mongodb_connect_timeout_ms: int = field(
        default_factory=lambda: int(_optional("MONGODB_CONNECT_TIMEOUT_MS", "15000")))  # type: ignore[arg-type]
    mongodb_socket_timeout_ms: int = field(
        default_factory=lambda: int(_optional("MONGODB_SOCKET_TIMEOUT_MS", "45000")))  # type: ignore[arg-type]
    mongodb_max_pool_size: int = field(
        default_factory=lambda: int(_optional("MONGODB_MAX_POOL_SIZE", "50")))  # type: ignore[arg-type]
    mongodb_min_pool_size: int = field(
        default_factory=lambda: int(_optional("MONGODB_MIN_POOL_SIZE", "5")))  # type: ignore[arg-type]
    mongodb_max_idle_time_ms: int = field(
        default_factory=lambda: int(_optional("MONGODB_MAX_IDLE_TIME_MS", "120000")))  # type: ignore[arg-type]
    mongodb_wait_queue_timeout_ms: int = field(
        default_factory=lambda: int(_optional("MONGODB_WAIT_QUEUE_TIMEOUT_MS", "10000")))  # type: ignore[arg-type]
    # Bounded retries for the INITIAL handshake only. A brand-new cluster or a
    # node failover can need a few seconds; after this the startup fails loudly.
    mongodb_connect_attempts: int = field(
        default_factory=lambda: int(_optional("MONGODB_CONNECT_ATTEMPTS", "3")))  # type: ignore[arg-type]
    mongodb_connect_retry_delay_s: float = field(
        default_factory=lambda: float(_optional("MONGODB_CONNECT_RETRY_DELAY_S", "2.0")))  # type: ignore[arg-type]

    # ---- Atlas daily cleanup (IST) ----
    # Temporary market data is wiped every day at 06:00 Asia/Kolkata so Atlas
    # stays a bounded temporary store. Runs in-process when the backend is up;
    # the Atlas Scheduled Trigger (see atlas_cleanup_trigger.js + docs) covers
    # the backend-offline case.
    atlas_cleanup_enabled: bool = field(default_factory=lambda: _env("ATLAS_CLEANUP_ENABLED", "true").lower() in {"1", "true", "yes", "on"})
    atlas_cleanup_hour: int = field(default_factory=lambda: int(_optional("ATLAS_CLEANUP_HOUR", "6")))  # type: ignore[arg-type]
    atlas_cleanup_minute: int = field(default_factory=lambda: int(_optional("ATLAS_CLEANUP_MINUTE", "0")))  # type: ignore[arg-type]

    # ---- Storage budget guard ----
    # The 06:00 IST wipe keeps Atlas bounded ACROSS days, but a single trading
    # day of 1m candles for the full subscribed universe is ~140 MB, which is
    # enough to exhaust a 512 MB free-tier cluster mid-session - before the next
    # wipe can run. When writes are quota-blocked every write path fails and the
    # API goes down. The guard watches real storage usage and trims the oldest
    # regenerable market data whenever usage crosses the budget, so the cluster
    # is never driven into the write-blocked state in the first place.
    storage_guard_enabled: bool = field(default_factory=lambda: _env("STORAGE_GUARD_ENABLED", "true").lower() in {"1", "true", "yes", "on"})
    # The budget is measured on the APPLICATION database, while Atlas enforces
    # the quota on the WHOLE CLUSTER (database + oplog + engine overhead). The
    # gap on a 512 MB free-tier cluster is ~250 MB, so a 300 MB application
    # budget lets the cluster cross its limit (and write-block every writer)
    # while the guard still reports "43 % full". 180 MB keeps the application
    # database small enough for the CLUSTER to stay under the quota.
    storage_budget_mb: int = field(default_factory=lambda: int(_optional("STORAGE_BUDGET_MB", "180")))  # type: ignore[arg-type]
    # The guard checks the REAL usage often: the Atlas quota is enforced on the
    # WHOLE cluster, so the application database can cross it between two
    # checks (the market-watch writer alone adds ~50 MB per session). A slow
    # check means every writer is failing in the meantime — which is what
    # makes the whole product (and every page) feel hung.
    storage_guard_interval_sec: int = field(default_factory=lambda: int(_optional("STORAGE_GUARD_INTERVAL_SEC", "60")))  # type: ignore[arg-type]
    # ---- Auto-cleanup at % full ----
    # The MongoDB driver never reports the Atlas cluster quota, so "90% full"
    # is measured against this configured capacity (Atlas M0 free tier = 512).
    # Whenever real usage reaches the threshold, the guard auto-runs the safe
    # cleanup pass (temporary market data + telemetry) instead of waiting for
    # the 06:00 IST wipe — the cluster cleans itself before it gets
    # write-blocked.
    storage_capacity_mb: int = field(default_factory=lambda: int(_optional("STORAGE_CAPACITY_MB", "512")))  # type: ignore[arg-type]
    storage_autoclean_pct: int = field(default_factory=lambda: int(_optional("STORAGE_AUTOCLEAN_PCT", "90")))  # type: ignore[arg-type]

    # ------------------------------------------------------------------
    # MongoDB — configuration validation
    #
    # MONGODB_URI is REQUIRED. It can be any valid MongoDB URI:
    #   mongodb://127.0.0.1:27017/kaustubh        -> Local MongoDB
    #   mongodb://localhost:27017/kaustubh        -> Local MongoDB
    #   mongodb+srv://user:pass@cluster.net/db    -> MongoDB Atlas
    # The URI decides the destination; the application code does not care.
    # A missing or malformed MONGODB_URI is a hard, loud startup error.
    # ------------------------------------------------------------------
    def mongodb_config_error(self) -> str | None:
        """Return a human-readable reason the URI is unusable, else None.

        Never returns (or logs) the URI itself — only the variable name and a
        description of what is wrong with it.
        """
        uri = (self.mongodb_uri or "").strip()
        if not uri:
            return (
                "MONGODB_URI is not configured. Add it to "
                "python-service/.env (backend-only, never exposed to the frontend), "
                "e.g. MONGODB_URI=mongodb://127.0.0.1:27017/kaustubh "
                "or MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/kaustubh "
                "?retryWrites=true&w=majority"
            )
        # Accept both mongodb:// and mongodb+srv:// URIs
        if not (uri.startswith("mongodb://") or uri.startswith("mongodb+srv://")):
            return (
                "MONGODB_URI is not a valid MongoDB connection string "
                "(expected mongodb://... or mongodb+srv://...)."
            )
        # For mongodb+srv:// URIs, credentials are required (Atlas requirement)
        if uri.startswith("mongodb+srv://"):
            if "@" not in uri.split("mongodb+srv://", 1)[1].split("/", 1)[0]:
                return (
                    "MONGODB_URI has no credentials. An Atlas SRV URI must contain "
                    "mongodb+srv://<user>:<password>@<cluster>.mongodb.net"
                )
        return None

    def mongodb_is_configured(self) -> bool:
        return self.mongodb_config_error() is None

    def resolved_mongodb_uri(self) -> str:
        """The single MongoDB connection string. Raises if unusable.

        Callers get a precise configuration error instead of a silent failure.
        """
        error = self.mongodb_config_error()
        if error:
            raise MongoDbConfigurationError(error)
        return (self.mongodb_uri or "").strip()

    def mongodb_source(self) -> str:
        """The active database source label: 'local' or 'atlas'.

        Determined from the URI scheme so Data Center / health payloads
        reflect the actual configured destination.
        """
        uri = (self.mongodb_uri or "").strip()
        if uri.startswith("mongodb+srv://"):
            return "atlas"
        return "local"

    def mongodb_host(self) -> str:
        """Credential-free cluster host, safe for logs and health payloads.

        Works with both mongodb:// and mongodb+srv:// URIs.
        Returns "" for malformed URIs so nothing leaks into responses.
        """
        uri = (self.mongodb_uri or "").strip()
        if uri.startswith("mongodb+srv://"):
            authority = uri[len("mongodb+srv://"):].split("/", 1)[0].split("?", 1)[0]
            if "@" not in authority:
                return ""
            host = authority.rsplit("@", 1)[1]
            return host or ""
        if uri.startswith("mongodb://"):
            authority = uri[len("mongodb://"):].split("/", 1)[0].split("?", 1)[0]
            if "@" in authority:
                host = authority.rsplit("@", 1)[1]
            else:
                host = authority
            return host or ""
        return ""

    def mongodb_database_from_uri(self) -> str | None:
        """Extract database name from the URI if present.

        Returns the database name from the URI path, or None if not specified.
        Works with both mongodb:// and mongodb+srv:// URIs.
        """
        uri = (self.mongodb_uri or "").strip()
        if not uri:
            return None
        # Remove scheme
        if uri.startswith("mongodb+srv://"):
            rest = uri[len("mongodb+srv://"):]
        elif uri.startswith("mongodb://"):
            rest = uri[len("mongodb://"):]
        else:
            return None
        # Remove query string
        path_part = rest.split("?", 1)[0]
        # Split by / to get database name
        parts = path_part.split("/", 1)
        if len(parts) > 1 and parts[1]:
            return parts[1]
        return None

    def effective_mongodb_database(self) -> str:
        """Get the effective database name: from URI if present, else fallback."""
        db_from_uri = self.mongodb_database_from_uri()
        if db_from_uri:
            return db_from_uri
        return self.mongodb_database

    def mongodb_test_is_configured(self) -> bool:
        """Return True if MONGODB_TEST_URI is set and valid."""
        uri = (self.mongodb_test_uri or "").strip()
        if not uri:
            return False
        return uri.startswith("mongodb://") or uri.startswith("mongodb+srv://")

    def resolved_mongodb_test_uri(self) -> str | None:
        """The test MongoDB connection string, or None if not configured."""
        if not self.mongodb_test_is_configured():
            return None
        return (self.mongodb_test_uri or "").strip()

    def effective_mongodb_test_database(self) -> str:
        """Get the effective test database name: from URI if present, else fallback."""
        if not self.mongodb_test_is_configured():
            return self.mongodb_test_database
        uri = (self.mongodb_test_uri or "").strip()
        if uri.startswith("mongodb+srv://"):
            rest = uri[len("mongodb+srv://"):]
        elif uri.startswith("mongodb://"):
            rest = uri[len("mongodb://"):]
        else:
            return self.mongodb_test_database
        path_part = rest.split("?", 1)[0]
        parts = path_part.split("/", 1)
        if len(parts) > 1 and parts[1]:
            return parts[1]
        return self.mongodb_test_database

    # ---- Service ----
    host: str = field(default_factory=lambda: _optional("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(_optional("PORT", "8000")))  # type: ignore[arg-type]
    log_level: str = field(default_factory=lambda: _optional("LOG_LEVEL", "info"))

    # ---- CORS ----
    cors_origins: str = field(default_factory=lambda: _optional("CORS_ORIGINS", "http://localhost:3000"))

    # ---- Scheduler (IST) ----
    # 08:50 automatic broker login; 08:55 WebSocket connection;
    # 08:59 tick collection starts. No 08:25 WebSocket preparation.
    login_hour: int = field(default_factory=lambda: int(_optional("LOGIN_HOUR", "8")))
    login_minute: int = field(default_factory=lambda: int(_optional("LOGIN_MINUTE", "50")))
    logout_hour: int = field(default_factory=lambda: int(_optional("LOGOUT_HOUR", "16")))
    logout_minute: int = field(default_factory=lambda: int(_optional("LOGOUT_MINUTE", "0")))
    # ---- WebSocket trading window (IST) ----
    # 08:55 WebSocket connection; 08:59 tick collection starts.
    ws_start_hour: int = field(default_factory=lambda: int(_optional("WS_START_HOUR", "8")))
    ws_start_minute: int = field(default_factory=lambda: int(_optional("WS_START_MINUTE", "55")))
    ws_stop_hour: int = field(default_factory=lambda: int(_optional("WS_STOP_HOUR", "15")))
    ws_stop_minute: int = field(default_factory=lambda: int(_optional("WS_STOP_MINUTE", "31")))
    # ---- Tick collection (IST) ----
    tick_collection_hour: int = field(default_factory=lambda: int(_optional("TICK_COLLECTION_HOUR", "8")))
    tick_collection_minute: int = field(default_factory=lambda: int(_optional("TICK_COLLECTION_MINUTE", "59")))
    # ---- Trading-day phases (IST) — Scheduler Engine #01 ----
    # 08:55-09:00 readiness, 09:00 pre-market, 09:05 limit-order window,
    # 09:10 equilibrium, 09:12 buffer, 09:15 live feed, 15:16 square-off,
    # 15:30 broker feed stop, 15:31 WebSocket close, 16:00 logout.
    pre_market_hour: int = field(default_factory=lambda: int(_optional("PRE_MARKET_START_HOUR", "9")))
    pre_market_minute: int = field(default_factory=lambda: int(_optional("PRE_MARKET_START_MINUTE", "0")))
    limit_order_hour: int = field(default_factory=lambda: int(_optional("LIMIT_ORDER_START_HOUR", "9")))
    limit_order_minute: int = field(default_factory=lambda: int(_optional("LIMIT_ORDER_START_MINUTE", "5")))
    equilibrium_hour: int = field(default_factory=lambda: int(_optional("EQUILIBRIUM_START_HOUR", "9")))
    equilibrium_minute: int = field(default_factory=lambda: int(_optional("EQUILIBRIUM_START_MINUTE", "10")))
    buffer_hour: int = field(default_factory=lambda: int(_optional("BUFFER_START_HOUR", "9")))
    buffer_minute: int = field(default_factory=lambda: int(_optional("BUFFER_START_MINUTE", "12")))
    feed_start_hour: int = field(default_factory=lambda: int(_optional("FEED_START_HOUR", "9")))
    feed_start_minute: int = field(default_factory=lambda: int(_optional("FEED_START_MINUTE", "15")))
    square_off_hour: int = field(default_factory=lambda: int(_optional("SQUARE_OFF_HOUR", "15")))
    square_off_minute: int = field(default_factory=lambda: int(_optional("SQUARE_OFF_MINUTE", "16")))
    feed_stop_hour: int = field(default_factory=lambda: int(_optional("FEED_STOP_HOUR", "15")))
    feed_stop_minute: int = field(default_factory=lambda: int(_optional("FEED_STOP_MINUTE", "30")))
    # Square-off trigger can be disabled without touching the phase machine.
    square_off_enabled: bool = field(default_factory=lambda: _env("SQUARE_OFF_ENABLED", "true").lower() in {"1", "true", "yes", "on"})
    # ---- SDK ----
    environment: str = field(default_factory=lambda: _optional("NEO_ENVIRONMENT", "prod"))

    # ---- Broker operation timeouts (seconds) ----
    broker_login_timeout: float = field(default_factory=lambda: float(_optional("BROKER_LOGIN_TIMEOUT", "30")))  # type: ignore[arg-type]
    broker_api_timeout: float = field(default_factory=lambda: float(_optional("BROKER_API_TIMEOUT", "20")))  # type: ignore[arg-type]
    ws_connect_timeout: float = field(default_factory=lambda: float(_optional("WS_CONNECT_TIMEOUT", "20")))  # type: ignore[arg-type]
    http_request_timeout: float = field(default_factory=lambda: float(_optional("HTTP_REQUEST_TIMEOUT", "15")))  # type: ignore[arg-type]
    health_check_timeout: float = field(default_factory=lambda: float(_optional("HEALTH_CHECK_TIMEOUT", "5")))  # type: ignore[arg-type]

    # ---- Broker mode selection: kotak | shoonya | dummy ----
    # The active broker adapter. Switching is done via the central session
    # manager so only ONE adapter / session / WebSocket is alive at a time.
    # Phase-1 default is DUMMY (the always-on paper engine); a real broker
    # becomes active only via an explicit session switch or a persisted
    # terminal_mode setting.
    broker_mode: str = field(default_factory=lambda: _optional("BROKER_MODE", "dummy").lower())

    # Whether the scheduler drives the Kotak Neo lifecycle. Legacy default ON
    # (the scheduler always drove Kotak; credentials are validated honestly).
    # A Shoonya-only deployment sets KOTAK_ENABLED=false so the scheduler
    # skips Kotak entirely instead of attempting (and failing) TOTP logins.
    kotak_enabled: bool = field(default_factory=lambda: _env("KOTAK_ENABLED", "").lower() not in {"0", "false", "no", "off"})

    # ---- Shoonya SDK credentials (OAuth-based NorenRestApiOAuth) ----
    # All of these are SECRETS. They live only in the backend process env /
    # .env.local and are NEVER exposed to the frontend or logs.
    #   SHOONYA_ENABLED          - "1" turns the adapter on (SDK installed, creds present)
    #   SHOONYA_API_KEY          - API key used to request the OAuth URL
    #   SHOONYA_SECRET_KEY       - client secret used to exchange the auth code
    #   SHOONYA_USER_ID          - Shoonya UID (client code)
    #   SHOONYA_ACCOUNT_ID       - account id used for order placement (usually UID)
    #   SHOONYA_REDIRECT_URL     - callback URL the OAuth flow returns to
    #   SHOONYA_HOST             - noren REST host (default: api.shoonya.com)
    #   SHOONYA_WEBSOCKET        - noren WS host (default: wss://api.shoonya.com/NorenWSTP/)
    # The OAuth code itself (the /QuickAuth `code` param) is a SHORT-LIVED
    # secret used exactly once to obtain the access token. It must never be
    # logged or persisted; it is accepted only via POST /api/shoonya/oauth-code.
    shoonya_enabled: bool = field(default_factory=lambda: _env("SHOONYA_ENABLED", "").lower() in {"1", "true", "yes", "on"})
    shoonya_api_key: str = field(default_factory=lambda: _env("SHOONYA_API_KEY"))
    shoonya_secret_key: str = field(default_factory=lambda: _env("SHOONYA_SECRET_KEY"))
    shoonya_user_id: str = field(default_factory=lambda: _env("SHOONYA_USER_ID"))
    shoonya_account_id: str = field(default_factory=lambda: _env("SHOONYA_ACCOUNT_ID"))
    shoonya_redirect_url: str = field(default_factory=lambda: _env("SHOONYA_REDIRECT_URL", "http://localhost:3000/trading/shoonya-oauth"))
    shoonya_host: str = field(default_factory=lambda: _env("SHOONYA_HOST", "https://api.shoonya.com/NorenWClientTP/"))
    shoonya_websocket: str = field(default_factory=lambda: _env("SHOONYA_WEBSOCKET", "wss://api.shoonya.com/NorenWSTP/"))

    # ---- App / JWT auth (user-level auth layer, independent of broker login) ----
    # The trading terminal's mutating APIs are protected with a signed JWT.
    # APP_USERNAME / APP_PASSWORD / JWT_SECRET are backend-only secrets.
    app_username: str = field(default_factory=lambda: _env("APP_USERNAME", "kaustubh"))
    app_password: str = field(default_factory=lambda: _env("APP_PASSWORD"))
    jwt_secret: str = field(default_factory=lambda: _env("JWT_SECRET"))
    jwt_issuer: str = field(default_factory=lambda: _env("JWT_ISSUER", "kaustubh-backend"))
    jwt_audience: str = field(default_factory=lambda: _env("JWT_AUDIENCE", "kaustubh-terminal"))
    jwt_ttl_seconds: int = field(default_factory=lambda: int(_optional("JWT_TTL_SECONDS", "28800")))  # type: ignore[arg-type]

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

