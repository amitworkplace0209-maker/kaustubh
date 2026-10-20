# Broker Architecture

## Two independent concerns

A common mistake is coupling order execution to the market-data feed. This
terminal keeps them **independently selectable** via the Broker Registry
(`brokers/broker_registry.py`):

| Concern | Surfaced as | Backed by |
|---------|-------------|-----------|
| **Trading broker** | where orders/positions/margin go | broker adapter (`brokers/manager.py` → `get_adapter(terminal)`) |
| **Market-data broker** | where live ticks come from | `ws_manager` / WebSocket Engine subscription |

The UI shows both selections separately (Trading Broker and Market Data Broker
cards) so it is always clear which is driving each side.

## Honest capability matrix

From `BROKER_CAPABILITIES`:

| Broker | Trading | Market Data | Auth | Notes |
|--------|:---:|:---:|------|-------|
| `kotak` | ✅ | ✅ | real | implemented (Kotak Neo API + SFeed WS) |
| `shoonya` | ⛔ | ⛔ | — | **NOT IMPLEMENTED** — selection rejected, never faked |
| `dummy` | simulated | simulated | simulated | demo/paper execution with virtual currency |

Guarantees:

- Selecting a `NOT IMPLEMENTED` broker returns an error containing
  `NOT IMPLEMENTED`; it is never accepted as a working broker.
- Status is **read live**: the market-data card reflects `ws_manager.status()`
  (feed connected / stale / receiving), and the trading card reflects the
  adapter's login state. No cached "looks healthy" fiction.

## Adapters

`brokers/manager.py` keeps the registry of adapters and `switch_terminal()`
guards unknown names and is idempotent for same-broker switches. Adapters
expose a common surface: `login()`, `logout()`, `place_order()`, `funds()`,
`positions()`, plus broker-specific capabilities from
`brokers/capabilities.py` (order types, historical data, margin preview,
auth flow, virtual currency).

## Separation of `connection_engine` (gateway)

`connection_engine/` is the second WebSocket (WS #2): it manages client
sessions and an outbox queue for the browser UI. It is the **control gateway**,
distinct from the broker feed (WS #1). This separation is why the Service
Control Center can start/stop market data without disturbing the trading
gateway and vice versa.