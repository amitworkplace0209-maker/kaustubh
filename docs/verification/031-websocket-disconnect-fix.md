# 031 — WebSocket disconnect fix (broker feed flapping)

Date: 2026-10-07, ~13:00–13:13 IST (market hours)

## 1. Symptom

UI showed WebSocket offline. Live diagnosis: the Kotak SFeed connection was
flapping — 22 connects / 21 disconnects in ~8 min, each drop after 9–19 s with
reason `Unknown`/`unknown_error`, `staleSubscriptionsCleared` up to 2681.
Ticks flowed (~500/s) between drops, so every page flickered live/offline.

## 2. Ruled out (evidence)

- Scheduler kills (`feed_window_expired`, `no_ticks_confirmation`,
  `market_closed`): intentional `disconnect(why)` records its `why` in history —
  no such entries existed, only `Unknown` external closes.
- Stale orphan backends as fighters: two 11:59 python leftovers killed; flap
  continued unchanged, so they were not the cause (removed anyway).
- Subscription burst: restores are chunked (200/frame, `WS_SUBSCRIBE_BATCH_SIZE`),
  SDK cap is 3000 vs 2681 subscribed — not a limit kill. No SDK errors
  (`errors: 0`).

## 3. Root cause

Corrupt WS state in the 12:52 worker from the earlier unclean restart attempt
(`start_backend.py restart` hit the 180 s tool timeout mid-restart and its shell
was killed, leaving supervisor/reader/SDK state torn). A clean stop + fresh
`start_backend.py run` (stdout/stderr to `logs/backend-manual*.log`) ended the
flap immediately: 1 connect, 0 disconnects, stable 5+ min.

## 4. Verified after fix

- `GET /api/services/websocket/status`: CONNECTED, supervisor CONNECTED,
  2681/2681 subscribed, ticks flowing (42–540/s).
- `/health`: websocket `WS_CONNECTED`, scheduler `TICK_COLLECTION_RUNNING`,
  session `SESSION_ACTIVE`, DB connected.
- `broker/status`: marketData CONNECTED (its `ticksPerSecond/subscribedSymbols 0`
  is the known R-42 display bug, not the feed — manager shows real rates).
- Market Watch `/progress` + `/sections`: CONNECTED.
- Frontend Next.js on :3000 running, browser connected — full chain live.
- Order feed (WS#2) self-healed one transient drop in 2 s; healthy.
