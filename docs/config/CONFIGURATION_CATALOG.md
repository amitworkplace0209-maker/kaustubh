# CONFIGURATION_CATALOG.md

## KAUSTUBH Trading Platform - Configuration Catalog

**Last Updated**: 2026-09-28
**Version**: 1.0
**Status**: ACTIVE
**Source**: `C:\project\python-service\config\settings.py` (class attributes)
**Verification**: Variable NAMES and defaults extracted from source. Effective runtime values NOT_VERIFIED (no running process).
**SECURITY**: This document records **names, types, and defaults only**. Actual secret values must NEVER appear here. Use `<REDACTED>`.

---

## Configuration Loading Order (highest priority first)

1. Environment variables (OS / process)
2. `python-service/.env`
3. `python-service/config/.env.local` (backend-only, gitignored)
4. MongoDB-persisted runtime settings (`services/runtime_settings`)
5. Code defaults in `settings.py`

**Required (no default)**: `mongodb_uri` — startup fails without it.

---

## Category 1: Kotak Neo Credentials (CRITICAL — SECRET)

| Variable | Default | Required | Secret | Purpose |
|----------|---------|----------|--------|---------|
| `client_id` | — | Yes | Yes | Kotak API client ID |
| `consumer_key` | — | Yes | Yes | Kotak API consumer key |
| `mobile_number` | — | Yes | Yes | Registered mobile (10 digits) |
| `mpin` | — | Yes | Yes | 4-digit MPIN (PBKDF2-hashed at rest) |
| `totp_secret` | — | Yes | Yes | TOTP seed for OTP generation |

**Handling**: Read only inside `auth/kotak_client.py` and `brokers/kotak_adapter.py`. Never returned by any endpoint. Documented as `<REDACTED>`.

---

## Category 2: MongoDB Connection (CRITICAL)

| Variable | Default | Purpose |
|----------|---------|---------|
| `mongodb_uri` | **required** | Connection string (`mongodb://` or `mongodb+srv://`) |
| `mongodb_database` | `kaustubh` | Database name |
| `mongodb_test_uri` | — | Test-suite URI |
| `mongodb_test_database` | `kaustubh_test` | Test-suite database |
| `mongodb_server_selection_timeout_ms` | — | Server selection timeout |
| `mongodb_connect_timeout_ms` | — | Connect timeout |
| `mongodb_socket_timeout_ms` | — | Socket timeout |
| `mongodb_max_pool_size` | — | Max pool size |
| `mongodb_min_pool_size` | — | Min pool size |
| `mongodb_max_idle_time_ms` | — | Max idle time |
| `mongodb_wait_queue_timeout_ms` | — | Wait-queue timeout |
| `mongodb_connect_attempts` | — | Retry attempts |
| `mongodb_connect_retry_delay_s` | — | Retry delay (seconds) |
| `atlas_cleanup_enabled` | — | Enable Atlas-side TTL/cleanup job |
| `atlas_cleanup_hour` | — | Cleanup hour (IST) |
| `atlas_cleanup_minute` | — | Cleanup minute |

---

## Category 3: Server / Logging / CORS

| Variable | Default | Purpose |
|----------|---------|---------|
| `host` | — | Bind host |
| `port` | — | Bind port (typically 8000) |
| `log_level` | — | Logging level (DEBUG/INFO/WARNING/ERROR) |
| `cors_origins` | — | Allowed CORS origins (frontend URL) |
| `environment` | — | `development` / `production` |

**Risk**: Overly broad `cors_origins` (e.g. `*`) in production would be a security finding. Actual value NOT_VERIFIED.

---

## Category 4: Scheduler Timeline (IST — 28 variables)

| Variable | Default | Phase |
|----------|---------|-------|
| `login_hour` / `login_minute` | 08:50 | Login trigger |
| `ws_start_hour` / `ws_start_minute` | 08:55 | WebSocket start |
| `tick_collection_hour` / `tick_collection_minute` | — | Tick collection |
| `pre_market_hour` / `pre_market_minute` | 09:00 | Pre-market |
| `limit_order_hour` / `limit_order_minute` | 09:05 | Limit order window |
| `equilibrium_hour` / `equilibrium_minute` | 09:10 | Equilibrium |
| `buffer_hour` / `buffer_minute` | 09:12 | Buffer |
| `feed_start_hour` / `feed_start_minute` | 09:15 | Live feed start |
| `square_off_hour` / `square_off_minute` | 15:16 | Square-off |
| `feed_stop_hour` / `feed_stop_minute` | 15:30 | Feed stop |
| `ws_stop_hour` / `ws_stop_minute` | 15:31 | WebSocket stop |
| `logout_hour` / `logout_minute` | 16:00 | Logout |
| `square_off_enabled` | — | Master square-off switch |

**Risk**: Setting `square_off_enabled=false` during a live session leaves real positions un-squared-off. Treat as a high-risk operational toggle.

---

## Category 5: Broker Mode Selection

| Variable | Default | Purpose |
|----------|---------|---------|
| `broker_mode` | — | Active broker: `kotak` / `shoonya` / `dummy` |
| `kotak_enabled` | — | Enable Kotak adapter |
| `shoonya_enabled` | — | Enable Shoonya adapter |
| `broker_login_timeout` | — | Login timeout (s) |
| `broker_api_timeout` | — | Broker REST timeout (s) |
| `ws_connect_timeout` | — | WebSocket connect timeout (s) |
| `http_request_timeout` | — | Generic HTTP timeout (s) |
| `health_check_timeout` | — | Health probe timeout (s) |

---

## Category 6: Shoonya Credentials (SECRET)

| Variable | Secret | Purpose |
|----------|--------|---------|
| `shoonya_api_key` | Yes | OAuth API key |
| `shoonya_secret_key` | Yes | OAuth secret |
| `shoonya_user_id` | Yes | Shoonya user ID |
| `shoonya_account_id` | Yes | Shoonya account ID |
| `shoonya_redirect_url` | No | OAuth redirect URL |
| `shoonya_host` | No | Override host |
| `shoonya_websocket` | No | WebSocket endpoint URL |

---

## Category 7: App Auth / JWT (SECRET)

| Variable | Secret | Purpose |
|----------|--------|---------|
| `app_username` | Yes | Backend login username |
| `app_password` | Yes | Backend login password |
| `jwt_secret` | **Yes** | JWT signing key |
| `jwt_issuer` | No | `iss` claim |
| `jwt_audience` | No | `aud` claim |
| `jwt_ttl_seconds` | No | Token lifetime (commonly 8h) |

**Risk**: `jwt_secret` default/weak value would allow token forgery. Actual value NOT_VERIFIED.

---

## Category 8: WebSocket Reliability

| Variable | Purpose |
|----------|---------|
| `ws_reconnect_initial_delay` | Backoff start (s) |
| `ws_reconnect_max_delay` | Backoff cap (s) |
| `ws_reconnect_max_attempts` | Max retry count |
| `ws_heartbeat_timeout_sec` | Heartbeat timeout |
| `ws_heartbeat_interval_sec` | Heartbeat interval |

---

## Category 9: Tick Buffer / Bulk Write

| Variable | Purpose |
|----------|---------|
| `buffer_flush_interval_ms` | Tick buffer flush cadence |
| `buffer_max_size` | Max buffered ticks before flush |
| `bulk_insert_size` | MongoDB bulk insert chunk size |

**Performance coupling**: `bulk_insert_size` and `buffer_max_size` interact with `mongodb_max_pool_size`; large values can starve the connection pool during market hours.

---

## Category 10: TOTP (Kotak OTP)

| Variable | Purpose |
|----------|---------|
| `totp_issuer` | Issuer label in authenticator apps |
| `totp_digits` | Digit count (typically 6) |
| `totp_interval` | Time step (typically 30s) |

---

## Complete Variable Index (86 settings)

```
Category 1 — Kotak (5):      client_id, consumer_key, mobile_number, mpin, totp_secret
Category 2 — MongoDB (16):   mongodb_uri, mongodb_database, mongodb_test_uri, mongodb_test_database,
                             mongodb_server_selection_timeout_ms, mongodb_connect_timeout_ms,
                             mongodb_socket_timeout_ms, mongodb_max_pool_size, mongodb_min_pool_size,
                             mongodb_max_idle_time_ms, mongodb_wait_queue_timeout_ms,
                             mongodb_connect_attempts, mongodb_connect_retry_delay_s,
                             atlas_cleanup_enabled, atlas_cleanup_hour, atlas_cleanup_minute
Category 3 — Server (6):     host, port, log_level, cors_origins, environment
                             (+ broker_login_timeout is in Cat 5)
Category 4 — Scheduler (27): login_*, ws_start_*, tick_collection_*, pre_market_*, limit_order_*,
                             equilibrium_*, buffer_*, feed_start_*, square_off_*, feed_stop_*,
                             ws_stop_*, logout_*, square_off_enabled
Category 5 — Broker (9):     broker_mode, kotak_enabled, shoonya_enabled, broker_login_timeout,
                             broker_api_timeout, ws_connect_timeout, http_request_timeout,
                             health_check_timeout
Category 6 — Shoonya (7):    shoonya_api_key, shoonya_secret_key, shoonya_user_id,
                             shoonya_account_id, shoonya_redirect_url, shoonya_host, shoonya_websocket
Category 7 — JWT (6):        app_username, app_password, jwt_secret, jwt_issuer, jwt_audience,
                             jwt_ttl_seconds
Category 8 — WS (5):         ws_reconnect_initial_delay, ws_reconnect_max_delay,
                             ws_reconnect_max_attempts, ws_heartbeat_timeout_sec,
                             ws_heartbeat_interval_sec
Category 9 — Buffer (3):     buffer_flush_interval_ms, buffer_max_size, bulk_insert_size
Category 10 — TOTP (3):      totp_issuer, totp_digits, totp_interval
```

---

## Runtime-Overridable Settings

`api/settings.py` exposes:
- `GET /api/settings` — list
- `GET /api/settings/categories` — grouped by category
- `GET /api/settings/grouped` — grouped view
- `GET /api/settings/runtime` — runtime (MongoDB-persisted) values
- `GET /api/settings/{key}` — single value
- `PATCH /api/settings` — bulk update
- `PUT /api/settings/{key}` — single update
- `POST /api/settings/{key}/reset` — reset one to default
- `POST /api/settings/reset-all` — reset everything

**SECURITY CONCERN — NOT_VERIFIED**: If `GET /api/settings` returns all values including `jwt_secret`, `mpin`, and `totp_secret`, that is a **critical vulnerability**. Requires live verification that secret values are masked/redacted in API responses. This is a **top-priority pending verification item**.

---

## Unknowns

- **UNKNOWN**: Which settings are declared vs. actually consumed. `settings.py` attributes may be unused legacy.
- **UNKNOWN**: Whether `.env` or `.env.local` files exist in the deployment.
- **NOT_VERIFIED**: Whether defaults in `settings.py` match documented values in `PROJECT_IMPLEMENTATION_RULE.md`.
- **NOT_VERIFIED**: Secret masking behavior in `/api/settings` responses.

---

## Related Documents
- `../runtime/SCHEDULER_AND_LIFECYCLE.md` — Scheduler phase consumers
- `../security/SECURITY_ARCHITECTURE.md` — Secret handling
- `../architecture/SDK_CATALOG.md` — SDK-specific config
- `../PROJECT_RISKS.md` — Configuration risk register
