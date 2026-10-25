# BROKER ↔ ENGINE RELATIONSHIP — KAUSTUBH Trading Terminal

> **PART 37**: Trading and Market Data brokers are INDEPENDENT. Engines depend
> on interfaces/adapters, never on broker code directly.

## Isolation Rule

```
        ┌─────────────── Engine Layer ───────────────┐
        │  order_engine   position_engine   margin   │  TRADING
        │  feature_engine watchlist_engine market_coach  market_data
        └───────────────┬───────────────────────────┘
                        │ interfaces only
        ┌───────────────▼───────────────────────────┐
        │        BrokerAdapter (interface)           │
        │   KotakAdapter  │  DummyAdapter  │ Shoonya │
        │   (implemented) │  (implemented) │ (NOT)   │
        └──────┬──────────────────┬─────────────────┘
               │ trading           │ market data
             Kotak Neo SDK      Kotak SDK SFeed
```

## Engine ⇄ Broker Matrix

| Engine | Category | Broker dependency | Adapter used |
|--------|----------|-------------------|-------------|
| order_engine | TRADING | yes (if logged in) | active trading adapter |
| position_engine | TRADING | yes (if logged in) | active trading adapter |
| margin_engine | TRADING | yes | active trading adapter |
| squareoff_engine | TRADING | yes | position/order/margin |
| websocket_engine | MARKET_DATA | yes (Kotak SDK) | KotakAdapter feed |
| feature_engine | MARKET_DATA | no direct | — |
| watchlist_engine | MARKET_DATA | no direct | — |
| market_coach | MARKET_DATA | no direct | — |
| scheduler_engine | CONTROL | Kotak SFeed/SDK | KotakAdapter |
| session_manager | CORE | all (session) | session registry |
| search/storage | CORE/STORAGE | none | — |

## Dummy Mode + Broker Isolation

- Select **trading** DUMMY → order/position/margin use `DummyAdapter`.
- Select **market data** DUMMY → no Kotak SFeed; websocket_engine stays
  DISCONNECTED (honest) rather than subscribing.
- Selecting DUMMY for trading does NOT change market data broker (independent).
- DummyAdapter NEVER calls the Kotak SDK. Scheduler dummy gate prevents Kotak
  login even if the UI/heartbeat path would have.

## NOT IMPLEMENTED

- **Shoonya**: adapter interface exists, no implementation. Never faked —
  UI shows `NOT IMPLEMENTED` and the broker cannot be selected.

---

*Generated: 2026-09-14 | Part 37*