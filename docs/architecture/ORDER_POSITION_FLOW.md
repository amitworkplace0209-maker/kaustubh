# Order & Position Flow

## Order placement

```
Client / Scheduler / Square-Off Engine
        │
        ▼
Order Engine  (core/engines/order_engine.py · place / modify / cancel)
        │
        ├─ Risk Engine      core/engines/risk_engine.py
        │     validate_terminal / symbol-token / qty / order type /
        │     trigger presence / duplicate suppression / margin check
        │
        ├─ Margin Engine    core/engines/margin_engine.py
        │     real broker funds() → available margin
        │     MIS 1:5 → 20% of order value blocked · exposure ≤ 80% of capital
        │     ₹5 lakh order-value cap      (fail  →  MARGIN_REJECTED event)
        │
        ▼
Broker Adapter  (brokers/manager.py → get_adapter(terminal))
        │
        ▼
Broker API  →  orderId  →  ORDER_FILLED / ORDER_REJECTED …
        ▼
Audit / Notification / Event Bus
```

Key safety rules from the Margin Engine:

| Rule | Behaviour |
|------|-----------|
| No live session | order rejected before margin math runs (`NOT_LOGGED_IN`) |
| Unreachable broker funds | margin resolves to `0.0` + gate rejects — never a false OK |
| MIS product | 20% of order value held as margin |
| Exposure cap | total exposure may not exceed 80% of available capital |
| Large order | single order value capped at ₹5,00,000 |

## Position reconciliation

```
Broker positions / tradebook  →  Position Engine (core/engines/position_engine.py)
        │  get_positions(terminal)
        ▼
PnL Engine (core/engines/pnl_engine.py)
        │  normalize_position (LONG/SHORT, avg price, net qty)
        │  compute_totals (unrealized / realized / gross PnL)
        ▼
Position rows → UI (gateway WS #2) and Square-Off Engine
```

## Square-off

```
Scheduler | manual | emergency
        ▼
Square-Off Engine (core/engines/squareoff_engine.py)
        ├─ manual requires confirmation_token  (else CONFIRMATION_REQUIRED)
        ├─ no concurrent run  (ALREADY_IN_PROGRESS guard)
        ├─ fetch/validate positions, drop zero-qty rows
        ├─ per position: close via Order Engine MKT (BUY for short / SELL for long)
        │     retry up to 3 attempts · partial fills tracked
        └─ overall COMPLETED / PARTIAL / FAILED
        ▼
SQUARE_OFF_STARTED / COMPLETED / FAILED events → UI + audit
```

Safety properties: idempotent requestId per run, in-progress lock to prevent
double square-off, retry policy confined to the order attempt, and a
verification pass via the position engine before a run is marked COMPLETED.