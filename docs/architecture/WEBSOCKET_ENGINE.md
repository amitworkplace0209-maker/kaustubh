# WEBSOCKET_ENGINE.md — Feeding the Canonical Stream

## Ownership

- `ws_socket.ws_manager.WebSocketManager` is the **single** `SFeedWebSocket`
  owner (connects, reconnects, subscribes, publishes). No competing owner.
- `ws_socket.engine.engine.WebSocketEngine` composes it; it never opens a socket
  or owns a broker registry of its own.
- The engine consumes the **Session Manager** desired set as a first-class
  registry consumer (`"session_manager"`), merges its own pins on top, and
  computes the broker delta. It does not decide the set.

## Consumed / produced contract

Consumed from the Session Manager:
- `subscription_desired_keys_by_row()` → registry consumer intent.
- `set_pin_intents()` (merge of `PinManager.list()`).
- `mark_subscription_routing()` / `set_required_fields()` mirrors.

Produced onto the Engine Event Bus (only source of tick events):
- `TICK_RECEIVED` (raw ingress, unvalidated)
- `TICK_VALIDATED` (canonicalized, flat payload consumed by Feature Engine)
- `TICK_REJECTED` (canonicalization refusal with reason)

Contributed back to the Session Manager:
- broker acks (`mark_broker_subscribed` / `mark_broker_unsubscribed`) — actually
  sent by ws_manager on the engine's behalf after every subscribe/unsubscribe.

## Broker delta (`reconcile_broker_subscriptions`)

```
desired = _sync_desired()          # registry intents + pins + session_manager
to_sub, to_unsub = registry.broker_diff(_broker_subscribed)
if to_unsub:      owner.unsubscribe(to_unsub); drop acked set
if to_sub:        owner.subscribe(to_sub);      add acked set
```

Expired/inactive tokens are never produced by the manager, so they fall into
`to_unsub` and leave the broker feed.

## Pre-login sequence (08:25)

1. `scheduler._prep_ws()` → `session_manager.subscription_desired_keys()`.
2. `ws_manager.prepare_subscriptions(desired)` — merges into the surviving
   registry WITHOUT contacting the broker (safe pre-login).
3. `tick_buffer.start()`; `ws_manager.start_supervisor()` (State
   `WAITING_FOR_MARKET_WINDOW`/`STOPPED` → starts).
4. Routing stamped `PREPARING`; scheduler state `WS_PREPARING`; one
   `WEBSOCKET_PREP` event/day (guarded by `_ws_prep_started`).
5. Post-login (08:50) the supervisor connects and applies the staged tokens;
   acks mirror back into the Session Manager.

`subscribe()` still requires `kotak_session.logged_in` — that gate is what makes
the supervisor path the correct pre-login route.

## Reconnect / restore

`_supervisor_restore_subscriptions()` rebuilds the registry first from the
Session Manager (`_reload_subscriptions_from_session_manager()`), with MongoDB
`stocks` as a final fallback, then re-subscribes through `subscribe()`
(which re-acks). The registry survives reconnects (`_subscription_registry`).

## Monitoring

- `engine.status()` — `connection_connected`, `subscription_count`,
  `desired_subscriptions`, `subscription_state` (Session Manager counts),
  `active_consumers/routes`, `pins`, `raw_bucket_tokens`, RAM.
- `engine.health()` — `ok`, `connection_ok`, `feed_stale`.
- Services page facade metrics: `subscribed`, `pinned`, `expired`, `inactive`,
  `subscriptionRevision`, `routing`.
- Structured logs: `[WS-ENGINE]`, `[WS-SUPERVISOR]`, `[SCHEDULER]
  event=WEBSOCKET_PREP`, `[SESSION_MANAGER] event=SUBSCRIPTIONS_UPDATED`,
  `[WEBSOCKET] event=FEED_REJECTED`.