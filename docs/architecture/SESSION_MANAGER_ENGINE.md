# SESSION_MANAGER_ENGINE.md — Subscription-State Authority

The Session Manager is the single source of truth for **what is subscribed**.
The WebSocket Engine decides *how* to connect/feed; it never decides *what*
should be subscribed on its own. The Scheduler decides *when*; it never reads
`db.stocks` for the feed set.

## Canonical vocabulary

| State | Meaning |
|---|---|
| `SUBSCRIBED` | Broker ack recorded; no pin. |
| `PINNED` | Engine pin intent present; broker has NOT acked (yet). |
| `SUBSCRIBED+PINNED` | Broker ack **and** pin. |
| `NOT SUBSCRIBED` | Desired (or known) but broker ack absent. |
| `EXPIRED` | Real expiry reached — never fabricated; equities carry `None` expiry. |
| `INACTIVE` | Stock removed/deactivated; no pin; never re-sent to the broker. |

PIN ≠ SUBSCRIPTION. A removed pin never unsubscribes an instrument another
consumer still requires.

## Broker-WebSocket lifecycle reporting

`ws_manager` reports every REAL broker-feed transition into the Session Manager
so its session state is authoritative (`mark_ws_connecting`,
`mark_ws_connected`, `mark_ws_reconnecting`, `mark_ws_disconnected`). The feed
window check uses the live `sched_ws_start_time` / `sched_ws_stop_time` runtime
settings and the holiday-aware trading calendar, so exchange holidays are never
treated as open and a 15:31+ restart never reconnects the feed.

## State block (`subscriptionState` in `snapshot()`)

- `revision` — increments on every real state change (cheap diffing).
- `last_updated_at`, `routing` `{state, owner}`.
- `counts` — `desired`, `subscribed`, `pinned`, `pinned_only`, `not_subscribed`,
  `expired`, `inactive`, `total`, plus `revision` and `last_updated_at`.
- `instruments` — per-instrument rows carrying `exchange_segment`,
  `instrument_token`, `instrument_key`, `symbol`, `trading_symbol`, `is_index`,
  `is_depth`, `state`, `desired`, `active`, `subscribed`, `source`, `pin`,
  `expires_at`, `expiry_label`, `routing`, `required_fields`, `last_update_at`.

Never includes credentials. Serialized through `services/json_safe`.

## Producers

- `refresh_desired_subscriptions(force=False)` — rebuilds the DESIRED set from
  active `stocks` (10 s throttle). Instruments no longer active become
  INACTIVE (still reported, never subscribed).
- `set_pin_intents(pins)` — engine `PinManager.list()` merge; pin-only
  instruments are still DESIRED.
- `mark_broker_subscribed(rows)` / `mark_broker_unsubscribed(rows, reason)` —
  broker acks (ws_manager reports after every send/unsubscribe).
- `expire_subscription(row, expires_at)` / `deactivate_subscription(row)` —
  real expiry only.
- `mark_subscription_routing(state, owner)` — which connection routes the feed.
- `set_required_fields(rows)` — field requirements of consuming profiles.
- `mark_instrument_tick(row, at)` — last validated-tick timestamp.

Every mutation bumps `revision` and stamps
`[SESSION_MANAGER] event=SUBSCRIPTIONS_UPDATED` (structured log + event ledger).

## Consumers

- Scheduler `_prep_ws()` / `_start_ws()` — `subscription_desired_keys()`.
- WebSocket Engine `_sync_desired()` — registry consumer `"session_manager"`,
  delta via `SubscriptionRegistry.broker_diff`, and mirror of acks/pins/routing.
- ws_manager reconnect — `_reload_subscriptions_from_session_manager()`.
- Facades — `subscribed` / `pinned` / `expired` / `inactive` metrics on the
  Services page; `subscriptionRevision`, `routing`.

## Ordering guarantees

1. Desired set is derived in ONE place (Session Manager).
2. EXPIRED / INACTIVE are never returned by `subscription_desired_keys_*`.
3. The engine unsubscribes tokens the manager no longer desires
   (`reconcile_broker_subscriptions` returns `to_unsubscribe`).
4. Pre-login (08:25) staging goes through `ws_manager.prepare_subscriptions()`
   (registry pre-warm) — never `subscribe()` (gate: requires `logged_in`).

---

# Phase 3 — Session Manager Engine (control plane)

The existing Session Manager (same singleton, **not** a parallel engine) is the
single authoritative record of *instrument intent & lifecycle*: what is wanted,
at what feed level, by which consumers, over which connection, and how much
real time is left before it expires. The WebSocket Engine remains the
*how* (connect/feed/reconcile); the Scheduler the *when*.

## Canonical `status` vocabulary (new field; legacy `state` preserved)

Legacy `state` values (`SUBSCRIBED`, `PINNED`, `SUBSCRIBED+PINNED`,
`NOT SUBSCRIBED`, `EXPIRED`, `INACTIVE`) are unchanged and asserted by existing
tests. The Phase 3 `status` field adds precision:

| `status` | Meaning | Derivation |
|---|---|---|
| `NOT_SUBSCRIBED` | Catalogued, desired, not acked | canonical default |
| `SUBSCRIBE_REQUESTED` | `desired`+`sub_requested`, no ack yet | request flags |
| `SUBSCRIBED` | Broker ack present, no pin | ack set |
| `SUBSCRIBED_AND_PINNED` | Broker ack **and** pin | ack + pin set |
| `PINNED_ONLY` | Pin intent, broker not acked | pin set |
| `ACTIVE` | ack + a validated tick within `TICK_ACTIVE_WINDOW_SECONDS` (60 s) | ack + `last_tick_at` fresh |
| `INACTIVE` | soft-deactivated (legacy) | `active=False` |
| `EXPIRING` | > now within `EXPIRY_WARNING_SECONDS` (15 min) | real `expires_at` |
| `EXPIRED` | wall clock passed real `expires_at` | never fabricated |
| `UNSUBSCRIBE_REQUESTED` | cancel requested, ack pending | `unsub_requested` |
| `UNSUBSCRIBED` | no longer desired / not pinned / not acked | derived |
| `ERROR` | explicit `mark_instrument_error` | stored error |

`ACTIVE` is **derived live** from `last_tick_at` — no tick, no ACTIVE.

Constants: `SUPPORTED_FEED_LEVELS = (4, 8, 16)`, `DEFAULT_FEED_LEVEL = 8`,
`MARKET_DATA_TIERS = L4/L8/L16`, `EXPIRY_TYPES = PERMANENT/SESSION/TRADE/DURATION/ONE_SHOT`,
`DEFAULT_CONNECTION = "KOTAK-WS-01"`.

## Data model (per instrument row)

`instrument_id = broker|exchange_segment|instrument_token` (`broker` default
`kotak`) — the unique Mongo identity. Durable fields include `symbol`,
`feed_level`, `market_data`, `sources` (accumulate), `desired`, `active`,
`advertised`, `pinned` (map), real `expires_at`/`expiry_type`/`expiry_label`,
`required_fields`, `routing_targets`, `connection_targets`, `error`,
`archived`, `created_at`/`updated_at`.

## Persistence (Mongo, best-effort)

- Collections: `session_manager_instruments` (canonical records),
  `session_manager_events` (event ledger), `session_manager_revisions`
  (revision history). Indexed by `instrument_id` / `instrument_token` /
  `revision` / `event` in `database/connection.py::_ensure_indexes`.
- Timestamps stored as **epoch floats**; the API/UI surface ISO strings.
- Write path gated by `SESSION_MANAGER_PERSIST` env or `is_mongo_connected()`.
  All writes are best-effort and never raise into request paths.
- `reload_instruments()` hydrates the in-memory set at startup (crash recovery;
  app.py startup calls it). Runtime facets (broker acks) are NOT rebuilt — the
  engine re-acks on reconnect.

## Producers (Phase 3 methods)

`reload_instruments`, `upsert_instrument` (idempotent merge), `subscribe_instrument`,
`unsubscribe_instrument`, `pin_instrument`, `unpin_instrument`,
`activate_instrument`, `deactivate_instrument`, `set_instrument_expiry`,
`remove_instrument` (archive or purge), `mark_instrument_error`,
`clear_instrument_error`, `update_routing_metadata`, `reconcile`,
`track_instrument` (user-facing add flows), `mark_connection_connected/disconnected`,
`mark_revision_applied`, `revision_status`, `connections_snapshot`,
`phase3_health`, `phase3_snapshot`.

Every mutation bumps `subscription_revision`, publishes an Engine Event Bus
event (`SUBSCRIPTION_UPDATED` / `SESSION_INSTRUMENT_*`), and persists the
canonical record.

## Input sources (never duplicates)

- `api/watchlist.py::add_to_watchlist` → `upsert_instrument(source="watchlist")`
- `api/stocks.py::add_stock` → `upsert_instrument(source="search")`
- `api/routes.py POST /api/subscribe` → `upsert_instrument(source="trading")`
- `POST /api/phase3/session-manager/instruments` → source `manual` (or body).

## Engine reconciliation contract (WebSocket Engine)

1. `subscription_desired_keys()` / `subscription_desired_keys_by_row()` —
   the ONLY feed set authority (never includes EXPIRED/INACTIVE/UNSUBSCRIBED).
2. `_sync_session_manager_routing` mirrors route state + marks
   `KOTAK-WS-01` connected/disconnected on owner lifecycles.
3. `_sync_session_manager_intents` mirrors `feed_level`, `required_fields`,
   `routing_targets`, `connection_targets` back onto canonical rows.
4. Broker subscribe/unsubscribe ACKs call `mark_broker_subscribed` /
   `mark_broker_unsubscribed`; that counts as having applied the set →
   `mark_revision_applied(revision, "KOTAK-WS-01")`.
5. Every `TICK_VALIDATED` calls `mark_instrument_tick` (drives ACTIVE).

## Control-plane API

`/api/phase3/session-manager/*` (FastAPI, `{ok, data|error}` envelope):
`GET /overview|/status|/health|/revision|/connections|/events|/instruments`,
`GET /instruments/{broker|segment|token}`, `POST /instruments`, lifecycle
actions `/subscribe|/unsubscribe|/pin|/unpin|/activate|/deactivate|/expire|
/remove|/error|/clear-error`, `POST /reconcile`.

Frontend: `/services/session-manager` (nav.ts SERVICES_SHELL System group) →
`/api/phase3/session-manager/[...path]` Next.js proxy → FastAPI. Overview /
Instruments / Reconcile tabs; all values real, missing = N/A.