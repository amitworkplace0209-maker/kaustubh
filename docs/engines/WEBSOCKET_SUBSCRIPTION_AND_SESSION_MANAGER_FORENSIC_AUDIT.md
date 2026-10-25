# WEBSOCKET SUBSCRIPTION + SESSION MANAGER — FORENSIC AUDIT

**Scope:** Read-only forensic audit of the WebSocket stock subscription path and Session Manager.
**Audited tree:** `python-service/` (application code), `docs/` (written design / target).
**Mode:** AUDIT ONLY. No code edits, no config changes, no broker login, no orders placed.
**Date:** 2026-09-22

---

## 1. Executive Summary

The runtime contract "2,668 eligible instruments but only 8 subscribed" is **reproduced exactly by the
code, and is not a broker limitation**. The Kotak SFeed WebSocket, the Subscription Registry, and the
`WebSocketEngine` are all capable of subscribing the full eligible universe; nothing in the subscribe
pipeline truncates at 8.

The 8-limit **is** the number of `active => true` documents in the Mongo `stocks` collection
(`session_manager.refresh_desired_subscriptions()` builds its desired set *only* from that query). The
2,668-instrument eligible universe lives in `MarketWatchEngine._registry` and is merged into the
WebSocket Engine's registry (`engine._sync_desired()`) **only** when `reconcile_broker_subscriptions()`
runs — and that function is invoked *only* from control-plane/consumer triggers (frontend WS#2 channels
or explicit reconcile APIs), **never** from the scheduler's 08:55 WS start. At market open the scheduler
calls `ws_manager.subscribe(session_manager.subscription_desired_keys())` directly, which returns the 8
`stocks_db` rows.

Therefore the documented "full market watch" desired-universe expansion (2,668 → WS subscription)
**does not occur** at startup; live coverage stays 8 while 2,660 members report honest `NO_DATA`.

---

## 2. Scope, Constraints and Method

- **Constraints honoured:** no code written, no settings touched, no broker session opened, no orders.
  Only file reads and deterministic source searches were performed.
- **Method:** end-to-end trace of the subscription decision chain in this order:
  1. Universe build (`MarketWatchEngine`)
  2. Desired-set derivation (`SessionManager`)
  3. Broker subscribe execution (`WebSocketManager`)
  4. Registry merge / diff (`WebSocketEngine` + `SubscriptionRegistry`)
  5. Supervisor reconnect / restore path
  6. Every API/engine trigger that calls `reconcile_broker_subscriptions`
  7. Comparison against the written target docs and the published runtime verification report.
- **Evidence style:** every claim is anchored to `FILE:LINE` of this repo.

---

## 3. Runtime Evidence (verified, from the project's own verification runs)

The observed runtime snapshot (documented in
`docs/engines/MARKET_WATCH_ENGINE_RUNTIME_VERIFICATION_REPORT.md`):

| Metric | Value | Source |
|---|---|---|
| Eligible universe (`eligibleUniverseCount`) | **2,668** (`source=kotak_scrip_master`, `state=LOADED`) | report:49 |
| `subscriptionState` | `total 8 / subscribed 8 / desired 8 / pinned 0` | report:22 |
| Live-state counts (`statusCounts`) | `LIVE 8 / STALE 0 / NO_DATA 2660 / PENDING 0 / INACTIVE 0` | report:51 |
| Wire messages / ticks received | `24,393 / 24,389` | report:36 |
| `ticks_validated / ticks_rejected / malformed` | `24,389 / 0 / 0` | report:36-43 |
| Subscription rows | 8 rows, all `SUBSCRIBED`, `desired`, **`source stocks_db`**, feed `L8` | report:59-66 |
| Verified gap (report's own words) | "desired set fed to the feed is the 8 `stocks_db` instruments. Desired-universe expansion (2668 → WS subscription) does not occur this session" | report:69 |

**Conclusion of §3:** 8 is a *desired-set* number, not a *capacity* number. The feed received and
validated 24,389 ticks without loss (0 rejected), which also proves the broker socket accepted the L8
depth feed for the 8 stocks without errors.

---

## 4. Component Inventory and Roles

| Component | File | Role in the chain |
|---|---|---|
| `MarketWatchEngine` | `services/market_watch_engine.py` | Builds/owns the 2,668 eligible universe; ranks; auto-pins; exposes `desired_subscriptions()` / `eligible_subscription_payload()` |
| `CentralSessionManager` | `services/session/session_manager.py` | Single source of truth for "what is subscribed"; derives the desired set from Mongo `stocks`; owns canonical `_subs` records + broker ack mirror |
| `SubscriptionRegistry` | `ws_socket/engine/registry.py` | Merges every consumer intent, dedups by `(exchange_segment, instrument_token)`, produces the broker diff |
| `WebSocketEngine` | `ws_socket/engine/engine.py` | Facade between broker owner and registry; `_sync_desired()` merges mw/pins/session-manager intents; `reconcile_broker_subscriptions()` pushes the diff |
| `WebSocketManager` | `ws_socket/ws_manager.py` | Owns the single Kotak `SFeedWebSocket`; supervisor (connect/reconnect); `subscribe()`/`unsubscribe()`; ACK mirror |
| `KotakSession` | `auth/kotak_client.py` | Broker login/session + SDK client |
| `Scheduler` | `scheduler/__init__.py` | Decides *when* (08:50 login, 08:55 WS); calls `refresh_desired_subscriptions()` + `ws_manager.subscribe()` |
| `ConnectionEngine` | `connection_engine/connection_engine.py` | Backend→frontend realtime WS#2; consumer registry; the ONLY auto path that invokes `reconcile_broker_subscriptions()` (on frontend channel changes) |
| `sanctioned_master` | `services/sanctioned_master.py` | Sanctioned L8/index/L4 feed classification per instrument |
| `instrument_store` | `services/session/instrument_store.py` | Mongo persistence of canonical records + `KNOWN_SOURCES` |
| `api/*` route modules | `api/stocks.py`, `api/routes.py`, `api/watch_list.py`, `api/session_manager.py`, `api/ws_engine.py` | REST entry-points that mutate the desired set or trigger reconcile |

### Chinese-whispers boundary (as implemented)

- **Session Manager decides WHAT** (`subscription_desired_keys()`).
- **WebSocket Engine decides the diff** (`registry.broker_diff()`), but only when asked.
- **WebSocket Manager (supervisor) decides WHEN to connect/reconnect**, restoring from the registry or
  the Session Manager / Mongo fallback.
- **Scheduler decides WHEN the market day starts**; at that moment it bypasses the registry entirely and
  subscribes `subscription_desired_keys()` directly (`scheduler/__init__.py:1554,1564`).

---

## 5. Ownership Table (who owns what)

| Capability | Owner | Evidence |
|---|---|---|
| Broker session lifecycle (login/logout, markers) | Scheduler triggers; `KotakSession` executes; `CentralSessionManager` records | `scheduler/__init__.py:1500-1546`; `app.py:722-726` |
| Broker SDK client socket (single `SFeedWebSocket`) | `ws_manager` (one owner) | `app.py:455-468`; `ws_manager.py:5` |
| Instrument master (download/persist/lookup) | `services/instrument_cache` (+ `services/instrument_cache.py`) | `app.py:588-596`; `scheduler/__init__.py:1504-1513` |
| Sanctioned feed classification (L8/INDEX/L4) | `services/sanctioned_master.py` | `sanctioned_master.py:1-15`; consulted by `instrument_cache` |
| Market Watch eligible universe (2,668) | `market_watch_engine._registry` | `market_watch_engine.py:366-371` |
| `db.stocks` collection (subscription persistence) | Written by stocks/watchlist/lists subscribe APIs; read by `refresh_desired_subscriptions` + downloads + scheduler fallbacks | `api/stocks.py:501-614`, `api/watch_list.py:139-143`, `api/routes.py:214-237`; `session_manager.py:1439` |
| Active WS subscription state (what was actually sent/acked) | `ws_manager._subscribed_tokens` + `_subscription_registry` + `_subscribed_feed_levels`; mirrored into `session_manager._subs["subscribed"]` | `ws_manager.py:247-255,1357-1367`; `session_manager.py:1639-1657` |
| Desired-set derivation (the one source of truth) | `CentralSessionManager.refresh_desired_subscriptions()` | `session_manager.py:1422-1582` |
| Registry merge / dedup / diff | `SubscriptionRegistry` | `ws_socket/engine/registry.py:51-214` |
| Actual Kotak subscribe call | `ws_manager.subscribe()` → `_send_subscribe()` → SDK `subscribe_depth/index/...` | `ws_manager.py:1306-1378,2102-2111` |
| Broker ACK accounting | `ws_manager` extends its own sets, then `session_manager.mark_broker_subscribed()` | `ws_manager.py:1357-1375` |
| Reconnect / resubscribe | `ws_manager` supervisor | `ws_manager.py:424-568,608-731` |
| Tick validation / normalization / publish | `WebSocketEngine.on_feed_message` → `TICK_VALIDATED` event bus | `ws_socket/engine/engine.py:108-287` |
| Publish realtime data to the UI | `ConnectionEngine` (WS#2) | `connection_engine/connection_engine.py` |

---

## 6. Architecture: Two WebSockets and the intent flow

```
           SCHEDULER (08:50 login → 08:55 WS)
              │  scheduler/__init__.py:1553-1564
              ▼
   session_manager.refresh_desired_subscriptions()   │ READ db.stocks({active:true})  → 8 rows
              ▼
   ws_manager.subscribe(subscription_desired_keys()) │ DIRECT KOTAK subscribe (8)
              ▼
   KOTAK SFeed WS (WS#1)  ── ticks ──►  WebSocketEngine.on_feed_message  ──► TICK_VALIDATED
                                                                │
                                              MarketWatchEngine._listen_loop (8 LIVE / 2660 NO_DATA)

   FRONTIER2 (frontend UI)
      │  WS#2
      ▼
   ConnectionEngine ── consumer channel subscribe/unsubscribe ──► engine.reconcile_broker_subscriptions()   [ONLY AUTO TRIGGER]
```

The two subscriptions pipes (A and B) are:

- **Pipe A (runtime, used every market day):** scheduler → session manager desired (from `db.stocks`) →
  `ws_manager.subscribe()`. Feeds exactly the `stocks_db` set (8).
- **Pipe B (`_sync_desired` → registry → broker_diff → subscribe):** merges Market Watch's 2,668 eligible
  payload, pins, and the session-manager desired set. **Only reached through
  `reconcile_broker_subscriptions()`, which the scheduler never calls.**

This duality is the root cause: **Pipe B exists, is correct, and would subscribe 2,668 — but no
startup/reconnect hook ever activates it.**

---

## 7. Chain trace — Part 1: where the 2,668 eligible universe lives

1. `app.py:588-596` preloads the instrument master (`load_instrument_cache()`); scheduler also loads it
   at login (`scheduler/__init__.py:1504-1513`).
2. `market_watch_engine._build_universe()` filters the master to NSE EQ + active + intraday-eligible and
   writes `_registry` / `_universe` (`market_watch_engine.py:366-371`); refresh cadence
   `_maybe_refresh_universe()` (`market_watch_engine.py:375-382`, interval `UNIVERSE_REFRESH_INTERVAL_SECONDS`).
3. Eligibility count `_eligible_token_count()` sums `intradayEligible` rows (`market_watch_engine.py:384-386`).
   → **2,668 in the verified session.**
4. Exposed for subscription purposes:
   - `desired_subscriptions()` — eligible tokens not yet seen as subscribed (`market_watch_engine.py:391-402`)
   - `eligible_subscription_payload()` — all eligible rows with a `subscribed` flag (`market_watch_engine.py:404-417`)
5. Important nuance: `market_watch_engine._subscribed_tokens` is populated observationally from
   `TICK_VALIDATED` events, not from broker intent (`market_watch_engine.py:446-448`). So Market Watch's
   `subscribedTokenCount=8` is "received a tick" — matching the 8 actually fed.

---

## 8. Chain trace — Part 2: where the 8 desired tokens come from

`session_manager.refresh_desired_subscriptions()` (`session_manager.py:1422-1582`):

1. Throttled 10 s unless `force` (`session_manager.py:1432-1435`).
2. **Queries `db.stocks.find({"active": True})`** (`session_manager.py:1439-1440`). This is the *only*
   DB input to the desired set.
3. For each stock row it enriches feed flags from the sanctioned instrument master, defaulting equities
   to L8 depth (`session_manager.py:1465-1495`); **index rows are forced to `market_data=INDEX`,
   `is_depth=False`** (`session_manager.py:1480-1483`).
4. Rows are seeded `desired=True, active=True, source=="stocks_db", sources==["stocks_db"]`
   (`session_manager.py:1505-1508`).
5. A sweep deactivates any previously-desired record whose source vanished from `db.stocks`
   (`session_manager.py:1549-1561`) — "removed from the market universe" is treated as a *stocks* decision.
6. `subscription_desired_keys()` returns only `desired` rows not in blocked states
   (`session_manager.py:2709-2735`); `subscription_desired_keys_by_row()` same with full detail
   (`session_manager.py:2737-2752`).

**This is the entire feed-set authority on the runtime path.** With 8 active `stocks` documents, the
desired set is 8.

---

## 9. Chain trace — Part 3: the Kotak subscribe call and ACK mirror

1. `scheduler._start_ws()` (08:55):
   - `await session_manager.refresh_desired_subscriptions()` (`scheduler/__init__.py:1553`)
   - `tokens = session_manager.subscription_desired_keys()` (`scheduler/__init__.py:1554`)
   - `await ws_manager.subscribe(tokens)` (`scheduler/__init__.py:1564`)
   - Failure paths return False / store error (`scheduler/__init__.py:1559-1571`).
2. `ws_manager.subscribe()` (`ws_manager.py:1306-1378`):
   - Guards: empty list, `kotak_session.logged_in`, `client`, then `_ensure_connected()` (`ws_manager.py:1307-1327`).
   - Dedup against `_subscribed_tokens` and within batch (`ws_manager.py:1329-1346`).
   - `await _send_subscribe(ws, new_tokens)` (`ws_manager.py:1349`).
   - On success: extends `_subscribed_tokens`, records symbols + feed levels, updates `_subscription_registry`
     (`ws_manager.py:1357-1367`), then mirrors `session_manager.mark_broker_subscribed(new_tokens)`
     (`ws_manager.py:1371-1375`).
3. `_send_subscribe` / `_group_intents` map each token to its SDK feed family (`ws_manager.py:2065-2111`):
   - index → `ws.subscribe_index(...)` (`ws_manager.py:2081-2082,2107`)
   - L16 → `subscribe_full_depth(...)` (`ws_manager.py:2083-2084,2109`)
   - L8 / feedLevel 8 / `isDepth` → `subscribe_depth(...)` (`ws_manager.py:2085-2086,2111`)
   - L1/L4/touch → `subscribe_scrips(...)` (`ws_manager.py:2087-2088,2105`)
   - unclassified → L8 depth default (`ws_manager.py:2090`)
4. Registry token assembly (when Pipe B runs) merges the highest feed tier across consumers; the base
   default is L8 (`ws_socket/engine/registry.py:166-207`, `RegistryEntry.market_data="L8"` at
   `registry.py:32`).
5. ACK-side: `mark_broker_subscribed` flips canonical `_subs[key]["subscribed"]=True` and bumps the
   revision (`session_manager.py:1639-1657`); the mirror confirm line states desired set is the
   authoritative single source (`session_manager.py:2710-2716`).

---

## 10. Chain trace — Part 4: supervisor reconnect / restore

**Supervisor lifecycle** (`ws_manager.py:329-568`):
- `start_supervisor()` — requested by scheduler (docstring "called by scheduler at 09:13" is stale; the
  scheduler's WS connect constant is 08:55, see `config/settings.py:68-70`) (`ws_manager.py:329-346`).
- `_supervisor_loop()` → `_supervisor_tick()` every ≤5 s (`ws_manager.py:424-447`).
- `_supervisor_tick` handles: market window (`_is_market_window`), `ws_enabled` runtime flag, session
  active, internet checks, and transitions `WAITING/STOPPED→CONNECTING`,
  `DISCONNECTED→RECONNECTING`, backoff `RECONNECTING` (`ws_manager.py:449-566`).

**Restore on connect** (`_supervisor_connect` → `_supervisor_restore_subscriptions`):
- `_supervisor_connect()` connects then `await self._supervisor_restore_subscriptions()` (`ws_manager.py:608-631`).
- `_supervisor_restore_subscriptions()`:
  1. Use the in-memory `_subscription_registry` if non-empty (`ws_manager.py:639-641`). After a
     scheduler `_start_ws`, this registry holds exactly the 8 tokens that were sent to the broker
     (`ws_manager.py:1366-1367`).
  2. Else `_reload_subscriptions_from_session_manager()` — `refresh_desired_subscriptions(force=True)` +
     `subscription_desired_keys()` (`ws_manager.py:670-693`) → the same 8.
  3. Else `_reload_subscriptions_from_db()` — `db.stocks.find({"active": True})`, length 500
     (`ws_manager.py:695-731`) → the same 8.
  4. `subscribe(registry)` (`ws_manager.py:655`).
- Every reconnect therefore resubscribes at most the `stocks_db` set. **The 2,668 universe is never part
  of any reconnect restore path.**

---

## 11. The disconnect — why 2,668 never becomes 8+ subscriptions

The only code that would widen the set is the registry merge:

`engine._sync_desired()` (`ws_socket/engine/engine.py:325-399`):
- Pulls `market_watch_engine.eligible_subscription_payload()` and adds a **2,668-row `"market_watch"`
  intent bucket** with `feed_level="L8"` (`engine.py:337-354`).
- Adds pin intents (`engine.py:355-358`).
- Adds the Session Manager desired set as a `"session_manager"` consumer (`engine.py:361-380`).
- Rebuilds the `SubscriptionRegistry._intents` and computes `desired = self.registry.desired()`
  (`engine.py:382-397`).
- **Result:** a registry-eager desired set of ~2,676 unique tokens.

`engine.reconcile_broker_subscriptions()` (`engine.py:511-559`):
- calls `_sync_desired()` (`engine.py:515`)
- `to_sub, to_unsub = self.registry.broker_diff(self._broker_subscribed)` (`engine.py:518`)
- unsubscribes revoked tokens and `await self.owner.subscribe(to_sub)` (`engine.py:526-557`).

**Callers of `reconcile_broker_subscriptions` (full inventory):**

| Caller | Trigger | Evidence |
|---|---|---|
| `connection_engine` consumer subscribe | Frontend WS#2 adds/removes a *market* channel with tokens (`changed_broker=True`) | `connection_engine/connection_engine.py:413-427, 466-475` |
| `api/ws_engine.py` endpoints | Explicit control-plane reconcile / pin / consumer calls | `api/ws_engine.py:259,270,362,442,456` |
| `connection_manager_engine.reconcile()` | Service-control API call only | `services/connection_manager_engine.py:136-146` |
| `websocket_engine.reconcile()` | Service-control API call only | `services/websocket_engine.py:99-104` |

**Not called at startup/connect:**
- `services/connection_manager_engine._on_start` starts the connection engine but does **not** reconcile
  subscriptions (`connection_manager_engine.py:45-64`).
- `SessionFacade._on_start` calls `session_manager.reconcile()` — which only enforces **expiries**, it
  never touches the broker (`legacy_engine_facades.py:124-133`; `session_manager.py:2474-2534`).
- Scheduler's `_start_ws` never calls reconcile (`scheduler/__init__.py:1553-1564`).

**So Pipe B fires only when a frontend consumer actually subscribes a market channel over WS#2 (or an
admin hits a reconcile API).** Absent that, the registry-eager 2,668 never reaches the broker.

---

## 12. Subscription source matrix (who feeds the desired set)

| Source | Writer (file:line) | Channel to desired set | Feed-level treatment | Broker-subscribed automatically? |
|---|---|---|---|---|
| `stocks_db` | `api/stocks.py:501-614`, `api/watch_list.py:139-143`, `api/routes.py:214-237` (write `db.stocks`); read by `session_manager.refresh_desired_subscriptions` (`session_manager.py:1439`) | `session_manager._subs` desired + ack | L8 default for EQ; INDEX for indices (`session_manager.py:1480-1495`) | **YES** via scheduler `_start_ws` + supervisor restore |
| `watchlist` | `api/watchlist.py::add_to_watchlist → upsert_instrument(source="watchlist")` | canonical `instrument_store` + `_subs` (via lifecycle) | preserved; sanctioned master defaults | Only if `subscribe_instrument` run + reconcile/Pipe B triggered |
| `scanner` (market watch scanner) | `api/market_watch.py` scanner round | reads instrument master only; feeds `_process_tick`; does not write desired rows | n/a | No |
| `market_watch` (eligible universe) | `market_watch_engine.py:391-417` | merged by `engine._sync_desired` **only** (`engine.py:337-354`) as registry consumer | L8 default (`engine.py:353`) | **NO** unless `reconcile_broker_subscriptions()` runs |
| `session-api` (Phase-3) | `api/session_manager.py:318-331` (`subscribe`/`unsubscribe` lifecycle actions, source `manual`/body); `api/session_manager.py:407` `/reconcile` | `session_manager.subscribe_instrument/unsubscribe_instrument` → `_subs` + events | explicit `feed_level`/`market_data` | Only if desired + engine reconcile executes |
| pins (auto/manual) | `ws_socket/engine/pins.py`; `set_pin_intents` (`session_manager.py:1584` ff) | `_subs["pin"]` independent of subscription flag | cannot downgrade below sanctioned/registry tier | No (pin ≠ subscribed) |

**Key matrix take-away:** the `stocks_db` source is the only source that flows end-to-end to the Kotak
subscribe call without an explicit reconcile hand-wave.

---

## 13. Session Manager state vocabulary (the authoritative status model)

- Subscription states: `SUBSCRIBED`, `SUBSCRIBED_PINNED`, `PINNED`, `NOT_SUBSCRIBED`, `EXPIRED`,
  `INACTIVE` (`session_manager.py:1333-1376`); Phase-3 `status` adds `SUBSCRIBE_REQUESTED`,
  `SUBSCRIBED`, `SUBSCRIBED_AND_PINNED`, `PINNED_ONLY`, `ACTIVE`, `INACTIVE`, `EXPIRING`, `EXPIRED`,
  `UNSUBSCRIBE_REQUESTED`, `UNSUBSCRIBED`, `ERROR` (`docs/architecture/SESSION_MANAGER_ENGINE.md:8-114`).
- `ACTIVE` is derived live from a validated tick within `TICK_ACTIVE_WINDOW_SECONDS` (default 60 s)
  (`session_manager.py:237`; `docs/architecture/SESSION_MANAGER_ENGINE.md:103`).
- Every mutation bumps `revision` and stamps SUBSCRIPTION_UPDATED (`session_manager.py:1572-1581`).
- Persistence: `session_manager_instruments`, `session_manager_events`, `session_manager_revisions`,
  `session_manager_config` (`instrument_store.py:30-32`, `session_manager_config.py:30`).

---

## 14. Feed family routing (L1/L4/L8/L16/INDEX)

- `sanctioned_master.py` declares `INDEX_SYMBOLS` (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY → `subscribe_index`)
  and `DEPTH_STOCKS` (→ `subscribe_depth`) (`sanctioned_master.py:17-50`); master stamps are OR-merged,
  never downgraded (`sanctioned_master.py:11-14`).
- Runtime grouping lives in `_group_intents` (`ws_manager.py:2065-2091`) and `RegistryEntry._token_dict`
  merge (`registry.py:166-207`): highest tier wins; default L8.
- Kotak capability cross-check (`docs/KOTAK_NEO_WEBSOCKET_COMPLETE_CAPABILITY_AUDIT.md`):
  SDK methods `subscribe_scrips(_lite)/subscribe_depth/subscribe_full_depth/subscribe_index/subscribe_exchange`
  all supported (`capability-audit:82,115`); L8 = 5×5 depth (`capability-audit:222-231`); L16 requires
  the deeper feed; project's `marketData` tag mapping L1/L4/L8/L16 at `capability-audit:231`.
- **Feed capability is not the constraint.** The capability audit documents no per-scrip-count cap that
  would stop a 2,668-token `subscribe_depth` batch.

---

## 15. Mongo collections involved

| Collection | Purpose | Written / read by |
|---|---|---|
| `stocks` | Raw subscription persistence (the 8) | write: `api/stocks.py:501-614`, `api/watch_list.py`, `api/routes.py`; read: `session_manager.py:1439`, `ws_manager.py:700`, `api/downloads.py:315-317,411-413` |
| `session_manager_instruments` | Canonical desired/pinned/expiry/feed records | `instrument_store.py:30-32`; written by lifecycle upserts, `_persist_many` (`session_manager.py:1577`) |
| `session_manager_events` / `session_manager_revisions` | Event/revision ledger | `instrument_store.py:30-32`; `_persist_record` / revision stamps |
| `session_manager_config` | Session/expiry/tick config knobs | `session_manager_config.py:30` |

---

## 16. Docs vs code — MARKET_WATCH.md

| Written target (`docs/engines/MARKET_WATCH.md`) | Current code | Verdict |
|---|---|---|
| §4 "09:13 Subscribe eligible tokens through WebSocket Engine" (line 138) | Only `stocks_db` tokens are subscribed; eligible universe only enters the registry via reconcile | **GAP** |
| §4 flow "Eligible NSE universe → Market Watch registry → WebSocket subscriptions" (lines 138, 686-691) | Registry (2,668) is fed to the broker only under `reconcile_broker_subscriptions`, never at startup | **GAP** |
| §1/§33 "Receive live ticks through the WebSocket Engine" for "full eligible universe state" | Full live state is maintained (status model), but ticks arrive for 8 | **PARTIAL** |
| §20 stock status PENDING/LIVE/STALE/NO_DATA/INACTIVE (lines 464-481) | Implemented and honest — 2,660 `NO_DATA` | **MATCH** |
| §24 WS failure → reconnect → resubscribe (lines 561-567) | Supervisor reconnect resubscribes registry (8) | **MATCH for the set it resubscribes** |
| §25 observables (`eligibleUniverseCount`, `subscribedTokenCount`, `noDataInstrumentCount`) | Exposed (`market_watch_engine.py` metrics; report:49-51) | **MATCH** |

---

## 17. Docs vs code — SESSION MANAGER.md / session-manager engine

| Written target | Current code | Verdict |
|---|---|---|
| "Session Manager is the authoritative manager for … subscription registry; WebSocket Engine gets the active list on start" (`session-manager.md:1011-1018, 387-388`; `websocket-engine.md:15`) | **MATCH**: `subscription_desired_keys()` is the feed-set authority; scheduler and supervisor both read it | **MATCH** |
| Golden rule #3 "WebSocket startup par Session Manager se active stock list lega" (`session-manager.md:936`) | Scheduler reads session-manager desired keys (`scheduler/__init__.py:1553-1554`) | **MATCH** |
| Session Manager "evens/subscription registry" including Scripless universe? | Desired set is `db.stocks`-only; Market Watch universe is a *separate* engine registry parity not owned by Session Manager | **GAP vs "full market watch" intent** |
| "Multiple subscribers allowed, actual feed subscription single" (`session-manager.md:938-939`) | Registry dedups by `(segment, token)` (`registry.py:122-131`) | **MATCH** |

---

## 18. Docs vs code — WEBSOCKET ENGINE / WEBSOCKET.md + capability audit

| Written target | Current code | Verdict |
|---|---|---|
| `websocket-engine.md:15` — engine obtains active list from Session Manager | Yes → scheduler/supervisor path | **MATCH** |
| `websocket-engine.md:2267+` "Subscription sync `subscribe_to_desired_pins` (idempotent regenerate+regroup)" | This legacy facade method exists as implied by engine reports; the actual broker sync is `reconcile_broker_subscriptions` on the WebSocketEngine | **MATCH (naming noted)** |
| Capability audit — L8 depth, index, full-depth, scrips all available | `_group_intents` routes to the exact SDK methods | **MATCH** |
| Capability audit — "cross-intent duplicate blocked; per-(token,intent) set" | `SubscriptionRegistry` dedup + `ws_manager.subscribe` in-batch dedup | **MATCH** |

---

## 19. Docs vs code — runtime verification report (own shipped evidence)

The implementation audit already calls this explicitly: lines
`docs/engines/MARKET_WATCH_ENGINE_IMPLEMENTATION_AUDIT_REPORT.md:318-320` describe the **intended**
chain as "`refresh_desired_subscriptions` → `MarketWatchEngine.desired_subscriptions()` /
`eligible_subscription_payload()` → engine enrichment (`engine.py:339`) → broker subscribe",
and `MARKET_WATCH_ENGINE_RUNTIME_VERIFICATION_REPORT.md:69` states the expansion did not occur this
session. **The code and the shipped report agree:** the merge exists, the callers are absent, so 8/2668.

---

## 20. Reconnect / resubscribe matrix

| Scenario | Code path | Result set |
|---|---|---|
| Scheduler 08:55 WS connect | `scheduler/__init__.py:1553-1564` | `session_manager.subscription_desired_keys()` → 8 |
| Supervisor first connect (market window opens) | `ws_manager.py:513-517` → `_supervisor_connect` → `_supervisor_restore_subscriptions` | registry (8) → session manager (8) → mongo (8) |
| Internet drop/restore | `ws_manager.py:525-530, 505-510, 483-503` | reconnect → restore (8) |
| Unexpected disconnect | `ws_manager.py:532-541` → `RECONNECTING` backoff → `_supervisor_connect` | restore (8) |
| Reconnect cap exhausted | `ws_manager.py:545-548, 586-606` → `STOPPED` | stops — does not widen |
| Frontend consumer adds market channel over WS#2 | `connection_engine/connection_engine.py:413-427` | `reconcile_broker_subscriptions` → `_sync_desired` → **would include 2,668** |
| Explicit reconcile API | `api/ws_engine.py:259,270,362,442,456` | same as above |

---

## 21. Answers A–G

1. **A. Why does only 8 subscribe when 2,668 are eligible?**
   The broker-set does not come from the eligible universe; it comes from `db.stocks[:active]`
   (`session_manager.py:1439`), which has exactly 8 active docs. The 2,668-universe merge exists but is
   only executed by `reconcile_broker_subscriptions`, which the scheduler never calls.

2. **B. Who decides the desired set on the market-open path?**
   `CentralSessionManager.refresh_desired_subscriptions()` (`session_manager.py:1422`) → the only
   DB input is Mongo `stocks` (8). `subscription_desired_keys()` is the sole read authority
   (`session_manager.py:2709-2735`).

3. **C. Is there code that would subscribe the universe if invoked?**
   Yes: `engine._sync_desired()` + `engine.reconcile_broker_subscriptions()` would build a ~2,676
   registry-eager set and push the diff through `ws_manager.subscribe` (`engine.py:325-399, 511-559`).

4. **D. What triggers that widening code at runtime?**
   Only consumer channel changes over WS#2 (`connection_engine.py:421,475`) or explicit control APIs;
   none at startup (`connection_manager_engine.py:45-64` starts only the connection engine; `SessionFacade`
   `_on_start` only calls `session_manager.reconcile`, expiry-only, `legacy_engine_facades.py:124-133`).

5. **E. Is the 8-limit a broker/Kotak limit?**
   No. The capability audit documents L8/scrips/index/full-depth subscription methods with no scrip-count
   cap, and the session's own 24,389-tick ingestion showed zero rejection.

6. **F. Is `stocks_db` the only source that ever reaches the broker?**
   On the automatic path, yes. `watchlist`/`session-api`/Phase-3 desired rows only reach the broker if a
   reconcile/consumer trigger runs. `market_watch` never reaches the broker unless the same trigger runs.

7. **G. Does the code fabricate market data for the 2,660 NO_DATA members?**
   No. They are reported honestly as `NO_DATA` with `ltp null` (report:51,75). `_process_tick` only marks
   LIVE on a real validated tick (`market_watch_engine.py:440-448`).

---

## 22. Critical question — should 2,668 become desired directly, or should Session Manager own the merge?

**Current code (as-is):**
- Session Manager owns the *desired* set but derives it **only** from `db.stocks` (`session_manager.py:1439`).
- Market Watch owns the *eligible universe* in a separate engine registry (`market_watch_engine.py:366-371`).
- The WebSocket Engine merges the two only inside `_sync_desired()` (`engine.py:325-399`), gated by
  `reconcile_broker_subscriptions()`.
- Net effect: Scheduler's startup set is the `stocks_db` set; the eligible-universe merge is inert at
  startup.

**Documented target (written docs):**
- "Session Manager is the authoritative manager for subscription registry" (`session-manager.md:1011-1018`),
  "active stock list" at WS start (`session-manager.md:387-388`).
- MARKET_WATCH target subscribes the *eligible* tokens through the WebSocket Engine (`MARKET_WATCH.md:138`).
- `SESSION_MANAGER_ENGINE.md` "Producers": desired set is "rebuilt … from active `stocks`" — i.e. even the
  written doc scopes the Session Manager's desired set to `stocks`; the universe expansion to 2,668 is
  only implied by MARKET_WATCH's "subscribe eligible tokens".

**Gap (code vs written intent):**
- The docs never explicitly make Session Manager merge the 2,668 eligible universe. The implementation
  whiplashes between two models:
  - Session Manager `stocks`-only desired (the runtime truth), and
  - Market Watch eligible-universe "subscription-ready payload" (the full-market ambition).
  The merge point the code already provides (`_sync_desired`) is precisely where the written intent lives.

**What would change (no implementation performed):**
- **Option 1 (engine-path, least invasive):** have the scheduler's WS-start call
  `engine.reconcile_broker_subscriptions()` after `subscribe(tokens)` (or replace the direct subscribe).
  Because `_sync_desired` already injects `market_watch.eligible_subscription_payload()` (2,668) and the
  session-manager desired set (8) into the registry, the resulting broker diff would subscribe the merged
  unique set (~2,676, L8 for equities per registry default).
- **Option 2 (session-manager-path, matches "single source of truth"):** make
  `refresh_desired_subscriptions()` fold `market_watch_engine.eligible_subscription_payload()` into the
  `_subs` desired records (or make Market Watch push eligible tokens into the canonical store), so
  `subscription_desired_keys()` returns the full universe and `_start_ws` subscribes it unchanged.
- **Consequence to document regardless of option:** broker-side batch size, `subscribe_depth` capacity,
  L8 depth throughput, and memory/CPU on 2,668 simultaneous feeds must be validated before flipping the
  switch; feed-family routing already handles indices (L4 index feed) separately.

---

## 23. Findings (numbered, read-only)

1. `db.stocks` active-count is the effective subscription cap at startup — currently 8.
2. The "widening" pipe (registry merge + reconcile) is fully implemented but has no scheduler/
   supervisor caller at startup.
3. Reconnect resubscribes from the broker-applied registry (≤ 8) — it cannot widen the set.
4. The verification report's own §F14/§2 gap statements corroborate the 8/2,668 split.
5. No fabricated market data; the 2,660 NO_DATA members are honest.
6. Kotak feed capability is not the limiting factor.

---

## 24. Wrap-up and how to re-verify

- Re-verify the same facts without touching code by reading:
  `session_manager.py:1422-1582,2709-2752`, `ws_manager.py:1306-1378,2065-2123,424-731`,
  `ws_socket/engine/engine.py:325-399,511-559`, `services/connection_manager_engine.py:45-64,136-146`,
  `scheduler/__init__.py:1548-1574`.
- To confirm "reconcile would subscribe 2,668": trigger the documented control-plane reconcile
  (`POST /api/ws-engine/reconcile` or the connection-manager reconcile) during a live session and observe
  `subscriptionCount` jump — no code change required, but **this is a broker mutation** and is out of
  scope of this read-only audit; it is listed only as the empirically lowest-cost proof.