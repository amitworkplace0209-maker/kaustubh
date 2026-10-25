# API_CATALOG.md

## KAUSTUBH Trading Platform - REST API Catalog

**Last Updated**: 2026-09-28
**Version**: 1.0
**Status**: ACTIVE (statically derived from `python-service/api/*.py`)
**Verification**: Route definitions extracted from source. Request/response schemas NOT_VERIFIED.
**Base URL**: `http://localhost:8000`

---

## Router Registry (38 routers included in `app.py`)

| # | Variable | Module | Prefix | Tags | Route Count |
|---|----------|--------|--------|------|-------------|
| 1 | `session_router` | `api/routes.py` | *(none)* | session | 20 |
| 2 | `auth_router` | `api/auth.py` | `/api/auth` | auth | 3 |
| 3 | `stocks_router` | `api/stocks.py` | `/api/stocks` | stocks | 12 |
| 4 | `ticks_router` | `api/ticks.py` | `/api/ticks` | ticks | 3 |
| 5 | `downloads_router` | `api/downloads.py` | `/api/downloads` | downloads | 10 |
| 6 | `export_jobs_router` | `api/export_jobs.py` | `/api/downloads/exports` | export-jobs | 7 |
| 7 | `statistics_router` | `api/statistics.py` | `/api/statistics` | statistics | 2 |
| 8 | `logs_router` | `api/logs.py` | `/api/logs` | logs | 1 |
| 9 | `system_router` | `api/system.py` | `/api/system` | system | 16 |
| 10 | `settings_router` | `api/settings.py` | `/api/settings` | settings | 8 |
| 11 | `trading_router` | `api/trading.py` | `/api/trading` | trading | 15 |
| 12 | `trading_dashboard_router` | `api/trading_dashboard.py` | `/api/trading` | trading | 4 |
| 13 | `watchlist_router` | `api/watchlist.py` | `/api/watchlist` | watchlist | 4 |
| 14 | `watch_list_router` | `api/watch_list.py` | `/api/watch-list` | watch-list | 5 |
| 15 | `market_watch_router` | `api/market_watch.py` | `/api/market-watch` | market-watch | 24 |
| 16 | `search_router` | `api/search.py` | `/api/search` | search | 4 |
| 17 | `watchlist_engine_router` | `api/watchlist_engine.py` | `/api/watchlist-engine` | watchlist-engine | 13 |
| 18 | `notifications_router` | `api/notifications.py` | `/api/notifications` | notifications | 13 |
| 19 | `baskets_router` | `api/baskets.py` | `/api/baskets` | baskets | 5 |
| 20 | `demo_router` | `api/demo.py` | `/api/demo` | demo | 11 |
| 21 | `scheduled_downloads_router` | `api/scheduled_downloads.py` | `/api/scheduled-downloads` | scheduled-downloads | 17 |
| 22 | `schedule_events_router` | `api/schedule_events.py` | `/api/schedule-events` | schedule-events | 2 |
| 23 | `quality_router` | `api/quality.py` | `/api/data-quality` | data-quality | 20 |
| 24 | `websocket_router` | `api/websocket.py` | `/api/websocket` | websocket | 18 |
| 25 | `insights_router` | `api/insights.py` | `/api/data-saver/insights` | data-saver-insights | 22 |
| 26 | `alerts_router` | `api/alerts.py` | `/api/alerts` | alerts | 14 |
| 27 | `tick_analytics_router` | `api/tick_analytics.py` | `/api/data-saver/tick-analytics` | tick-analytics | 22 |
| 28 | `terminal_router` | `api/terminal.py` | `/api/terminal` | terminal | 27 |
| 29 | `user_router` | `api/terminal.py` | `/api/user` | auth | *see module* |
| 30 | `shoonya_router` | `api/terminal.py` | `/api/shoonya` | terminal | *see module* |
| 31 | `security_router` | `api/security.py` | `/api/terminal/security` | terminal-security | 8 |
| 32 | `data_center_router` | `api/data_center.py` | `/api/system/data-center` | data-center | 10 |
| 33 | `cleanup_router` | `api/cleanup.py` | `/api/system/cleanup` | cleanup | 2 |
| 34 | `ws_engine_router` | `api/ws_engine.py` | `/api/services/websocket` | websocket-engine | 44 |
| 35 | `ws_gateway_router` | `api/ws_gateway.py` | *(none)* | realtime | 10 + 1 WS |
| 36 | `dummy_router` | `api/dummy.py` | `/api/dummy` | dummy-terminal | 48 |
| 37 | `engine_control_router` | `api/engine_control.py` | `/api/services/engines` | engine-control | 22 |
| 38 | `storage_engine_router` | `api/storage_engine.py` | `/api/services/storage` | storage-engine | 5 |
| 39 | `session_manager_router` | `api/session_manager.py` | `/api/phase3/session-manager` | session-manager | 29 |
| 40 | `risk_engine_router` | `api/risk_engine.py` | `/api/services/risk` | risk-engine | 3 |

> **Note**: `trading.py` and `trading_dashboard.py` both register under `/api/trading`; `routes.py` and `ws_gateway.py` register without a prefix. FastAPI resolves same-path collisions by registration order — potential ambiguity, see `DUPLICATE_AND_LEGACY_FINDINGS.md`.

**Total Routes (approximate)**: ~450 across 40 router registrations.

---

## Critical Endpoints

### Health & System
| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| GET | `/health` | `routes.py` | Root health probe |
| GET | `/api/health` | `routes.py`, `system.py` | Health (duplicate path) |
| GET | `/api/system/health` | `system.py` | System health w/ MongoDB status |
| GET | `/api/system/dashboard` | `system.py` | Aggregated dashboard payload |
| GET | `/api/system/market` | `system.py` | Market session state |
| GET | `/api/system/time` | `system.py` | Server IST time |
| GET | `/api/system/mongo-stats` | `system.py` | MongoDB stats |
| GET | `/api/system/trading-day-stats` | `system.py` | Per-day trading stats |
| GET | `/api/system/quality-metrics` | `system.py` | Data quality metrics |
| POST | `/api/system/logs/clear` | `system.py` | Clear logs |
| GET | `/api/system/cleanup/status` | `cleanup.py` | Retention job status |
| POST | `/api/system/cleanup/run` | `cleanup.py` | Trigger retention cleanup |

### WebSocket (WS#3 / WS#4)
| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| WS | `/ws/realtime` | `ws_gateway.py` | **WS#3 + WS#4 unified channel** |
| GET | `/api/realtime/token` | `ws_gateway.py` | Issue realtime auth token |
| GET | `/api/realtime/status` | `ws_gateway.py` | Gateway status |
| GET | `/api/realtime/sessions` | `ws_gateway.py` | Active WS sessions |
| GET | `/api/realtime/health` | `ws_gateway.py` | Gateway health |
| GET | `/api/realtime/order-feed` | `ws_gateway.py` | WS#2 order feed status |
| GET | `/api/realtime/architecture` | `ws_gateway.py` | Architecture self-report |

### Engine Control
| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| GET | `/api/services/engines` | `engine_control.py` | List all engines |
| GET | `/api/services/engines/summary` | `engine_control.py` | Engine state summary |
| GET | `/api/services/engines/dependency-graph` | `engine_control.py` | DAG |
| GET | `/api/services/engines/{engine_id}` | `engine_control.py` | Engine detail |
| GET | `/api/services/engines/{engine_id}/health` | `engine_control.py` | Engine health |
| GET | `/api/services/engines/{engine_id}/metrics` | `engine_control.py` | Engine metrics |
| GET | `/api/services/engines/{engine_id}/dependencies` | `engine_control.py` | Deps |
| GET | `/api/services/engines/{engine_id}/errors` | `engine_control.py` | Error log |
| GET | `/api/services/engines/{engine_id}/activity` | `engine_control.py` | Activity |
| POST | `/api/services/engines/{engine_id}/start` | `engine_control.py` | Start engine |
| POST | `/api/services/engines/{engine_id}/stop` | `engine_control.py` | Stop engine |
| POST | `/api/services/engines/{engine_id}/restart` | `engine_control.py` | Restart engine |
| POST | `/api/services/engines/{engine_id}/heartbeat` | `engine_control.py` | Manual heartbeat |
| POST | `/api/services/engines/heartbeat-all` | `engine_control.py` | Broadcast heartbeat |
| POST | `/api/services/engines/health-check` | `engine_control.py` | Global health check |
| POST | `/api/services/engines/db_writer_engine/flush` | `engine_control.py` | Flush DB writer |
| GET | `/api/services/engines/feature_engine/latest` | `engine_control.py` | Latest feature output |
| GET | `/api/services/engines/broker/status` | `engine_control.py` | Broker status |
| GET | `/api/services/engines/broker/list` | `engine_control.py` | Broker list |
| GET | `/api/services/engines/broker/trading` | `engine_control.py` | Trading broker |
| GET | `/api/services/engines/broker/market-data` | `engine_control.py` | MD broker |
| POST | `/api/services/engines/broker/trading/select` | `engine_control.py` | Select trading broker |
| POST | `/api/services/engines/broker/market-data/select` | `engine_control.py` | Select MD broker |

### Trading
| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| POST | `/api/trading/order/place` | `trading.py` | Place order |
| POST | `/api/trading/order/modify` | `trading.py` | Modify order |
| POST | `/api/trading/order/cancel` | `trading.py` | Cancel order |
| GET | `/api/trading/orders` | `trading.py` | Live orders |
| GET | `/api/trading/order/history` | `trading.py` | Order history |
| GET | `/api/trading/trades` | `trading.py` | Trades |
| GET | `/api/trading/margin` | `trading.py` | Margin |
| GET | `/api/trading/positions` | `trading.py` | Positions |
| POST | `/api/trading/positions/squareoff` | `trading.py` | Square off |
| GET | `/api/trading/holdings` | `trading.py` | Holdings |
| GET | `/api/trading/funds` | `trading.py` | Funds |
| POST | `/api/trading/quote` | `trading.py` | Quote request |
| POST | `/api/trading/search` | `trading.py` | Instrument search |
| POST | `/api/trading/search-local` | `trading.py` | Local instrument search |
| GET | `/api/trading/instrument-cache/status` | `trading.py` | Cache status |
| GET | `/api/trading/instrument-cache/debug` | `trading.py` | Cache debug |
| POST | `/api/trading/instrument-cache/reload` | `trading.py` | Reload cache |
| GET | `/api/trading/brokers/status` | `trading_dashboard.py` | Broker status |
| GET | `/api/trading/brokers/overview` | `trading_dashboard.py` | Broker overview |
| GET | `/api/trading/dashboard` | `trading_dashboard.py` | Trading dashboard |
| POST | `/api/trading/brokers/refresh` | `trading_dashboard.py` | Refresh brokers |

### Session & Auth
| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| POST | `/api/auth/manual-login` | `auth.py` | Manual broker login |
| POST | `/api/auth/logout` | `auth.py` | Logout |
| DELETE | `/api/auth/login` | `auth.py` | Cancel pending login |
| GET | `/session/state` | `routes.py` | Session state |
| GET | `/session/history` | `routes.py` | Session history |
| GET | `/sessions` | `routes.py` | All sessions |
| POST | `/mode` | `routes.py` | Set mode |
| POST | `/login` | `routes.py` | Login |
| POST | `/api/login` | `routes.py` | Login (alias) |
| POST | `/logout` | `routes.py` | Logout |
| POST | `/api/logout` | `routes.py` | Logout (alias) |
| GET | `/session` | `routes.py` | Session detail |
| POST | `/subscribe` | `routes.py` | Subscribe |
| POST | `/unsubscribe` | `routes.py` | Unsubscribe |
| GET | `/api/session/status` | `routes.py` | Session status |
| GET | `/api/phase3/session-manager/overview` | `session_manager.py` | SM overview |
| GET | `/api/phase3/session-manager/status` | `session_manager.py` | SM status |
| GET | `/api/phase3/session-manager/health` | `session_manager.py` | SM health |
| GET | `/api/phase3/session-manager/revision` | `session_manager.py` | Current revision |
| GET | `/api/phase3/session-manager/connections` | `session_manager.py` | Broker connections |
| GET | `/api/phase3/session-manager/subscriptions` | `session_manager.py` | Subscriptions |
| GET | `/api/phase3/session-manager/subscriptions/daily-intent` | `session_manager.py` | Daily intent |
| GET | `/api/phase3/session-manager/sources` | `session_manager.py` | Sources |
| GET | `/api/phase3/session-manager/pins` | `session_manager.py` | Pins |
| GET | `/api/phase3/session-manager/expiry` | `session_manager.py` | Expiry |
| GET | `/api/phase3/session-manager/events` | `session_manager.py` | SM events |
| GET | `/api/phase3/session-manager/instruments` | `session_manager.py` | Instrument list |
| GET | `/api/phase3/session-manager/instruments/{id}` | `session_manager.py` | Instrument detail |
| POST | `/api/phase3/session-manager/instruments` | `session_manager.py` | Create instrument |
| POST | `/api/phase3/session-manager/instruments/{id}/{action}` | `session_manager.py` | subscribe/unsubscribe/pin/unpin/activate/deactivate/expire/remove/error/clear-error |
| POST | `/api/phase3/session-manager/reconcile` | `session_manager.py` | Reconcile |
| GET | `/api/phase3/session-manager/diagnostics` | `session_manager.py` | SM diagnostics |
| GET | `/api/phase3/session-manager/config` | `session_manager.py` | SM config |
| PUT | `/api/phase3/session-manager/config` | `session_manager.py` | Update SM config |
| POST | `/api/phase3/session-manager/config/reset` | `session_manager.py` | Reset SM config |
| POST | `/api/phase3/session-manager/config/{key}/reset` | `session_manager.py` | Reset one key |

### Security
| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| GET | `/api/terminal/security` | `security.py` | Security state |
| POST | `/api/terminal/security/pin` | `security.py` | Set PIN |
| POST | `/api/terminal/security/lock` | `security.py` | Lock terminal |
| POST | `/api/terminal/security/unlock` | `security.py` | Unlock terminal |
| POST | `/api/terminal/security/webauthn/register/begin` | `security.py` | WebAuthn reg start |
| POST | `/api/terminal/security/webauthn/register/complete` | `security.py` | WebAuthn reg finish |
| POST | `/api/terminal/security/webauthn/authenticate/begin` | `security.py` | WebAuthn auth start |
| POST | `/api/terminal/security/webauthn/authenticate/complete` | `security.py` | WebAuthn auth finish |

---

## Complete Route Index (by module)

### `api/routes.py` (prefix: none) — 20
`GET /health` · `GET /api/health` · `GET /status` · `GET /session/state` · `GET /session/history` · `GET /sessions` · `POST /mode` · `POST /login` · `POST /api/login` · `POST /logout` · `POST /api/logout` · `GET /session` · `POST /subscribe` · `POST /unsubscribe` · `GET /api/session/status` · `GET /api/scheduler/status` · `GET /api/scheduler/readiness` · `GET /api/scheduler/summary` · `GET /api/scheduler/history` · `GET /api/scheduler/runs` · `GET /api/scheduler/runs/{run_id}`

### `api/auth.py` — 3
`POST /api/auth/manual-login` · `POST /api/auth/logout` · `DELETE /api/auth/login`

### `api/stocks.py` — 12
`GET /api/stocks` · `GET /api/stocks/list` · `GET /api/stocks/search` · `GET /api/stocks/instrument-master/status` · `GET /api/stocks/validate` · `POST /api/stocks/subscribe` · `GET /api/stocks/details` · `GET /api/stocks/stats` · `POST /api/stocks` · `POST /api/stocks/search` · `DELETE /api/stocks/bulk` · `PATCH /api/stocks/{symbol}` · `DELETE /api/stocks/{symbol}`

### `api/ticks.py` — 3
`GET /api/ticks/stream` · `GET /api/ticks/recent` · `GET /api/ticks/stats`

### `api/downloads.py` — 10
`GET /api/downloads/formats` · `GET /api/downloads/fields` · `GET /api/downloads/preview` · `GET /api/downloads/naming/preview` · `GET /api/downloads` · `GET /api/downloads/stats` · `DELETE /api/downloads/history/bulk` · `DELETE /api/downloads/history/{entry_id}` · `GET /api/downloads/history/{entry_id}/file` · `GET /api/downloads/history`

### `api/export_jobs.py` — 7
`POST /api/downloads/exports` · `GET /api/downloads/exports` · `GET /api/downloads/exports/{job_id}` · `GET /api/downloads/exports/{job_id}/download` · `POST /api/downloads/exports/{job_id}/cancel` · `POST /api/downloads/exports/{job_id}/retry` · `DELETE /api/downloads/exports` · `DELETE /api/downloads/exports/{job_id}`

### `api/statistics.py` — 2
`GET /api/statistics` · `GET /api/statistics/gainers-losers`

### `api/logs.py` — 1
`GET /api/logs`

### `api/system.py` — 16
`GET /api/system` · `GET /api/system/health` · `GET /api/system/quality-metrics` · `GET /api/system/events` · `GET /api/system/scheduler` · `GET /api/system/session` · `GET /api/system/websocket` · `GET /api/system/time` · `GET /api/system/market` · `GET /api/system/mongo-stats` · `POST /api/system/logs/clear` · `GET /api/system/download-history` · `GET /api/system/trading-day-stats` · `GET /api/system/trading-history` · `GET /api/system/dashboard`

### `api/settings.py` — 8
`GET /api/settings` · `GET /api/settings/categories` · `GET /api/settings/grouped` · `GET /api/settings/runtime` · `GET /api/settings/{key}` · `PATCH /api/settings` · `PUT /api/settings/{key}` · `POST /api/settings/{key}/reset` · `POST /api/settings/reset-all`

### `api/trading.py` — 15
`POST /api/trading/order/place` · `POST /api/trading/order/modify` · `POST /api/trading/order/cancel` · `GET /api/trading/orders` · `GET /api/trading/order/history` · `GET /api/trading/trades` · `GET /api/trading/margin` · `GET /api/trading/positions` · `POST /api/trading/positions/squareoff` · `GET /api/trading/holdings` · `GET /api/trading/funds` · `POST /api/trading/search` · `POST /api/trading/search-local` · `GET /api/trading/instrument-cache/status` · `GET /api/trading/instrument-cache/debug` · `POST /api/trading/instrument-cache/reload` · `POST /api/trading/quote`

### `api/trading_dashboard.py` — 4
`GET /api/trading/brokers/status` · `GET /api/trading/brokers/overview` · `GET /api/trading/dashboard` · `POST /api/trading/brokers/refresh`

### `api/watchlist.py` — 4
`GET /api/watchlist` · `POST /api/watchlist` · `DELETE /api/watchlist/{symbol}` · `PATCH /api/watchlist/{symbol}/favorite`

### `api/watch_list.py` — 5
`GET /api/watch-list` · `POST /api/watch-list` · `DELETE /api/watch-list/{token}` · `PUT /api/watch-list/hidden` · `GET /api/watch-list/hidden`

### `api/market_watch.py` — 24
`GET /api/market-watch/history` · `GET /api/market-watch/progress` · `GET /api/market-watch` · `GET /api/market-watch/tick-snapshot` · `GET /api/market-watch/sections` · `GET /api/market-watch/search` · `GET /api/market-watch/config` · `GET /api/market-watch/tick-saving` · `POST /api/market-watch/tick-saving` · `GET /api/market-watch/filters` · `POST /api/market-watch/filters` · `GET /api/market-watch/filters/{filter_id}` · `POST /api/market-watch/filters/apply` · `DELETE /api/market-watch/filters/{filter_id}` · `GET /api/market-watch/rank` · `GET /api/market-watch/symbol/{symbol_or_token}` · `GET /api/market-watch/page` · `GET /api/market-watch/ui` · `GET /api/market-watch/registry` · `GET /api/market-watch/status` · `GET /api/market-watch/ranking` · `GET /api/market-watch/pins` · `POST /api/market-watch/pins` · `DELETE /api/market-watch/pins/{symbol_or_token}` · `DELETE /api/market-watch/pins` · `GET /api/market-watch/ranking/status`

### `api/search.py` — 4
`GET /api/search` · `GET /api/search/suggest` · `POST /api/search` · `GET /api/search/status`

### `api/watchlist_engine.py` — 13
`GET /api/watchlist-engine` · `POST /api/watchlist-engine` · `PATCH /api/watchlist-engine/{watchlist_id}` · `DELETE /api/watchlist-engine/{watchlist_id}` · `POST /api/watchlist-engine/cards` · `GET /api/watchlist-engine/{watchlist_id}/cards` · `POST /api/watchlist-engine/{watchlist_id}/symbols` · `DELETE /api/watchlist-engine/{watchlist_id}/symbols/{token}` · `PUT /api/watchlist-engine/{watchlist_id}/order` · `GET /api/watchlist-engine/dynamic/{kind}` · `POST /api/watchlist-engine/dynamic/{kind}` · `POST /api/watchlist-engine/screen` · `GET /api/watchlist-engine/subscriptions` · `GET /api/watchlist-engine/meta/dynamic-kinds`

### `api/notifications.py` — 13
`GET /api/notifications` · `GET /api/notifications/summary` · `GET /api/notifications/unread-count` · `GET /api/notifications/settings` · `PATCH /api/notifications/settings` · `POST /api/notifications` · `POST /api/notifications/mark-many` · `POST /api/notifications/delete-many` · `POST /api/notifications/delete-read` · `PATCH /api/notifications/{item_id}` · `PUT /api/notifications/read/{item_id}` · `PUT /api/notifications/unread/{item_id}` · `PUT /api/notifications/read-all` · `DELETE /api/notifications/{item_id}` · `GET /api/notifications/{item_id}` · `DELETE /api/notifications`

### `api/baskets.py` — 5
`GET /api/baskets` · `POST /api/baskets` · `PUT /api/baskets/{basket_id}` · `DELETE /api/baskets/{basket_id}` · `POST /api/baskets/{basket_id}/push`

### `api/demo.py` — 11
`GET /api/demo/account` · `GET /api/demo/orders` · `GET /api/demo/positions` · `GET /api/demo/transactions` · `GET /api/demo/transactions/{txn_id}` · `GET /api/demo/daily-report` · `POST /api/demo/order/place` · `POST /api/demo/order/cancel` · `POST /api/demo/position/squareoff` · `POST /api/demo/ltp` · `POST /api/demo/funds/add` · `POST /api/demo/funds/withdraw` · `POST /api/demo/reset`

### `api/scheduled_downloads.py` — 17
`GET /api/scheduled-downloads/destinations/list` · `GET /api/scheduled-downloads/formats/list` · `GET /api/scheduled-downloads/runs` · `GET /api/scheduled-downloads/health` · `GET /api/scheduled-downloads/runs/{run_id}` · `DELETE /api/scheduled-downloads/runs/{run_id}` · `GET /api/scheduled-downloads` · `POST /api/scheduled-downloads` · `GET /api/scheduled-downloads/packages` · `GET /api/scheduled-downloads/packages/{package_id}` · `POST /api/scheduled-downloads/packages/{package_id}/download` · `POST /api/scheduled-downloads/{job_id}/duplicate` · `POST /api/scheduled-downloads/test-config` · `GET /api/scheduled-downloads/{job_id}` · `PUT /api/scheduled-downloads/{job_id}` · `DELETE /api/scheduled-downloads/{job_id}` · `POST /api/scheduled-downloads/{job_id}/toggle` · `POST /api/scheduled-downloads/{job_id}/run`

### `api/schedule_events.py` — 2
`GET /api/schedule-events/stream` (SSE) · `GET /api/schedule-events/health`

### `api/quality.py` — 20
`GET /api/data-quality/config` · `POST /api/data-quality/config` · `GET /api/data-quality/summary` · `GET /api/data-quality/metrics` · `GET /api/data-quality/issues` · `POST /api/data-quality/issues/{issue_id}/{action}` · `GET /api/data-quality/scan-state` · `POST /api/data-quality/scan` · `POST /api/data-quality/scan/if-due` · `GET /api/data-quality/scan/history` · `GET /api/data-quality/duplicates` · `POST /api/data-quality/duplicates/delete` · `GET /api/data-quality/dimensions` · `GET /api/data-quality/symbols` · `GET /api/data-quality/symbol/{sym}` · `GET /api/data-quality/trend` · `POST /api/data-quality/snapshot` · `GET /api/data-quality/pipeline` · `GET /api/data-quality/storage` · `GET /api/data-quality/diagnostics`

### `api/websocket.py` — 18
`GET /api/websocket/system/stream` · `GET /api/websocket/system/status` · `GET /api/websocket/status` · `GET /api/websocket/live` · `GET /api/websocket/history` · `GET /api/websocket/history/{connection_id}` · `DELETE /api/websocket/history/{connection_id}` · `POST /api/websocket/history/delete-day` · `POST /api/websocket/history/delete-older-than` · `POST /api/websocket/history/clear-all` · `GET /api/websocket/events` · `GET /api/websocket/daily` · `GET /api/websocket/metrics` · `GET /api/websocket/telemetry` · `GET /api/websocket/subscriptions` · `GET /api/websocket/export` · `GET /api/websocket/stream` (SSE) · `POST /api/websocket/cleanup`

### `api/insights.py` — 22
`GET /api/data-saver/insights/live` · `/summary` · `/cards` · `/events` · `/events/{event_id}` · `/errors` · `/errors/{group_id}` · `/incidents` · `/today` · `/attention` · `/telemetry` · `/api-telemetry` · `/search` · `/reports` · `/reports/daily/{date}` · `/reports/weekly` · `/reports/{report_type}` · `POST /reports/generate` · `POST /events/export` · `/compare` · `POST /telemetry/flush`

### `api/alerts.py` — 14
`GET /api/alerts` · `GET /api/alerts/summary` · `GET /api/alerts/rules` · `POST /api/alerts/rules/{rule_id}/enabled` · `GET /api/alerts/settings` · `PATCH /api/alerts/settings` · `POST /api/alerts/delete-many` · `POST /api/alerts/delete-all` · `GET /api/alerts/{alert_id}` · `POST /api/alerts/{alert_id}/acknowledge` · `POST /api/alerts/acknowledge-all` · `POST /api/alerts/{alert_id}/resolve` · `DELETE /api/alerts/{alert_id}` · `DELETE /api/alerts` · `POST /api/alerts/retention/run`

### `api/tick_analytics.py` — 22

Redesigned analytics surface (14):
`GET /api/data-saver/tick-analytics/summary` · `/daily` · `/daily/{date}` ·
`/top-symbols` · `/symbol-stats/{symbol}` · `/rate` · `/persistence` ·
`/sources` · `/storage` · `/quality` · `/latency` · `/report` · `/reports` ·
`/export?format=csv|json`

Preserved live surface (8):
`GET /api/data-saver/tick-analytics/state` · `/metrics` · `POST /timeseries` · `GET /symbol/{symbol}` · `GET /depth/{symbol}` · `GET /market-wide` · `POST /history` · `POST /anomalies`

Engine doc: `docs/engines/TICK_ANALYTICS.md`.

### `api/terminal.py` — 27 (terminal_router)
`GET /api/terminal/list` · `/state` · `POST /switch` · `POST /connect` · `POST /disconnect` · `GET /oauth-link` · `POST /oauth-code` · `GET /account/{terminal}` · `GET /positions/{terminal}` · `GET /holdings/{terminal}` · `GET /orders/{terminal}` · `GET /orders/{terminal}/{order_id}/history` · `GET /trades/{terminal}` · `GET /search` · `GET /quote` · `GET /margin` · `GET /audit` · `POST /order` · `POST /order/modify` · `POST /order/cancel` · `POST /order/square-off` · `POST /order/basket` · `GET /targets` · `POST /target` · `DELETE /target/{symbol}`
Plus `user_router` (`/api/user`) and `shoonya_router` (`/api/shoonya`) in the same module — route details NOT_VERIFIED (dynamically assembled).

### `api/security.py` — 8
`GET /api/terminal/security` · `POST /pin` · `POST /lock` · `POST /unlock` · `POST /webauthn/register/begin` · `POST /webauthn/register/complete` · `POST /webauthn/authenticate/begin` · `POST /webauthn/authenticate/complete`

### `api/data_center.py` — 10
`GET /api/system/data-center/overview` · `/history` · `/ticks-history` · `/api-telemetry` · `/storage-trend` · `/snapshots` · `POST /snapshots/capture` · `GET /collections/all` · `GET /collections/{name}` · `POST /deep-scan` · `GET /export`

### `api/cleanup.py` — 2
`GET /api/system/cleanup/status` · `POST /api/system/cleanup/run`

### `api/ws_engine.py` — 44
`GET /api/services/websocket/status` · `/health` · `/metrics` · `/history` · `/events` · `/history/{connection_id}` · `/daily` · `/config` · `/quality` · `/latency` · `/quality/{instrument_token}` · `PUT /quality/thresholds` · `GET /subscriptions` · `POST /subscriptions` · `DELETE /subscriptions/{id}` · `GET /watchlist` · `GET /pins` · `POST /pins` · `DELETE /pins/{id}` · `GET /field-profiles` · `POST /field-profiles` · `PUT /field-profiles/{id}` · `DELETE /field-profiles/{id}` · `GET /field-verification` · `GET /field-verification/label/{field_name}` · `GET /routes` · `GET /consumers` · `POST /consumers` · `PUT /consumers/{id}` · `DELETE /consumers/{id}` · `GET /consumers/{id}/drain` · `GET /raw-stream` · `GET /live-feed` · `GET /raw/{reference}` · `GET /resources` · `PUT /resources` · `POST /connect` · `POST /disconnect` · `POST /reconnect` · `POST /subscribe` · `POST /unsubscribe`

### `api/ws_gateway.py` — 10 + 1 WS (prefix: none)
`GET /api/realtime/token` · `/status` · `/sessions` · `/fields` · `/health` · `/events` · `/connections/{connection_id}` · `/config` · `/order-feed` · `/architecture` · **`WS /ws/realtime`**

### `api/dummy.py` — 48
`GET /api/dummy/suggestions` · `POST /suggestions` · `POST /suggestions/{id}/process` · `POST /suggestions/{id}/reject` · `DELETE /suggestions/{id}` · `GET /state` · `GET /session` · `POST /session/reset` · `GET /portfolio` · `GET /holdings` · `GET /risk` · `GET /history` · `POST /maintenance/retention` · `GET /market-session` · `GET /calendar` · `GET /baskets` · `POST /baskets` · `DELETE /baskets/{id}` · `POST /baskets/execute` · `GET /alerts` · `POST /alerts` · `DELETE /alerts/{id}` · `GET /targets` · `POST /targets` · `DELETE /targets/{id}` · `GET /notifications` · `POST /notifications/read` · `POST /notifications/read-all` · `DELETE /notifications/{nid}` · `DELETE /notifications` · `GET /prefs` · `POST /prefs` · `POST /order/modify` · `POST /preview` · `GET /positions` · `GET /comparison` · `GET /audit` · `GET /watchlists` · `POST /watchlists` · `DELETE /watchlists/{id}` · `POST /watchlists/active` · `POST /watchlists/{id}/symbols` · `POST /watchlists/{id}/symbols/remove` · `GET /calendar-events` · `POST /calendar-events` · `PATCH /calendar-events/{id}` · `DELETE /calendar-events/{id}`

### `api/engine_control.py` — 22
See Critical Endpoints → Engine Control above.

### `api/storage_engine.py` — 5
`GET /api/services/storage` · `/history` · `/events` · `/config` · `POST /config` · `POST /snapshot`

### `api/risk_engine.py` — 3
`POST /api/services/risk/validate` · `GET /config` · `PATCH /config`

---

## Known API Issues

1. **`DOCUMENTATION_CODE_CONFLICT`**: `GET /api/health` registered in both `routes.py` and `system.py`. FastAPI matches first-registered; behavior depends on registration order in `app.py` (`system_router` is registered at position 9, `session_router` at position 1 — so `/api/health` resolves to `routes.py`).
2. **`DUPLICATE_OR_POSSIBLE_DUPLICATE`**: `/api/trading` prefix shared by `trading.py` and `trading_dashboard.py`.
3. **`DUPLICATE_OR_POSSIBLE_DUPLICATE`**: Watchlist surface is split across three modules: `watchlist.py` (`/api/watchlist`), `watch_list.py` (`/api/watch-list`), `watchlist_engine.py` (`/api/watchlist-engine`).
4. **Route ordering hazard**: `engine_control.py` defines `GET /{engine_id}` before `GET /broker/status`. Engine IDs such as `broker` could shadow the static path depending on registration order within the module. NOT_VERIFIED at runtime.
5. **No OpenAPI spec committed** — schemas are derivable at runtime from FastAPI but NOT captured in this catalog.

---

## Related Documents
- `ARCHITECTURE_OVERVIEW.md` — System layers
- `../architecture/WEBSOCKET_ARCHITECTURE.md` — WS#3/WS#4 detail
- `../frontend/FRONTEND_DATA_FLOW.md` — Which pages call which endpoints
- `../broker/BROKER_INTEGRATION_MAP.md` — Broker API coverage
- `../runtime/SCHEDULER_AND_LIFECYCLE.md` — Scheduler endpoints
