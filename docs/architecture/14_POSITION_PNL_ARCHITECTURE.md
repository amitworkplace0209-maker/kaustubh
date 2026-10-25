# 14_POSITION_PNL_ARCHITECTURE.md — Position + P&L

**STATUS: CURRENT — Migrated 2026-09-23 (WS#2 PositionUpdate + WS#1 LTP + REST reconciliation). Previous doc claimed `position_engine` recomputed unrealized from `feature_engine` per tick — obsolete.**

## 14.1 Ownership

* **Market data ticks:** `WS#1 → WebSocketEngine → EngineEventBus TICK_VALIDATED` (LTP, validated, stale-guarded).
* **Position qty/amounts:** `WS#2 PositionUpdate` (`flBuyQty/flSellQty/buyAmt/sellAmt/posFlg/hsUpTm`) **plus** authoritative `REST positions()` (`quick/user/positions` with `cfBuyQty/flBuyQty/netQty, buyAmt/cfBuyAmt, qty, realised/unrealised where broker provides, ltp where present`). `PositionUpdate` has **no `pnl/mtm` field** (SDK typed model `PositionData` verified — every numeric finance field is `str|None`, no `realized/pnl` key).
* **Trade ledger:** `REST trade_report()` (`quick/user/trades`) — per-execution rows with `trade_id` (not in OrderUpdate).
* **P&L authority:** `Risk Engine` is the canonical deterministic `position/risk/P&L` owner. `position_engine.get_positions("kotak")` and `services/broker_terminal_engine.build_terminal_overview` both call the same normalized `api/trading.py:positions` pipeline and produce `avgPrice/buy_avg/sell_avg, net_qty, realised/unrealised, gross_pnl = realised+unrealised, net_pnl = gross - charges_known, market_value = |net_qty|*ltp`.

## 14.2 Derived Indicative vs Confirmed

| Value | Direct WS field? | PositionUpdate? | LTP? | REST? | Derivation | Display |
|---|---|---|---|---|---|---|
| **Live unrealized MTM** | NO | NO | YES (WS#1 LTP) | PARTIAL (REST ltp if broker sends) | `(LTP - avgBuy)*abs(netQty)` long or `(avgSell - LTP)*abs(netQty)` short | `INDICATIVE · broker not yet confirmed` badge |
| **Realized** | NO | NO | NO | YES (`positions().realised`) | `sellAmt - buyAmt` across both legs when both filled, otherwise broker `realised` where present | `BROKER_CONFIRMED` (asOf `hsUpTm` + `positions()` timestamp) |
| **Gross/Net P&L** | NO | NO | — | — | `gross = realised + unrealised; net = gross - charges_known` | label `DERIVED_WS1_WS2` vs `BROKER_REST` |
| **Charges/Brokerage** | NO | NO | NO | PARTIAL (`trade_report` `charges` + `positions` `estimated_charges` where broker populates) | local `lib/charge-engine.ts` `calculateCharges` estimate — flagged `isEstimated / not broker-confirmed` | never claimed as `BROKER_WS2` |
| **Funds / blockedMargin / cash** | NO | NO | NO | YES `Broker REST limits()` (`quick/user/limits`) | direct | `BROKER_REST` |
| **Holdings** | NO | NO | NO | YES `holdings()` | direct × LTP where needed | `BROKER_REST` |

## 14.3 Flow (Target)

```
Kotak WS#2 PositionUpdate (flBuy/flSell/buyAmt/sellAmt)
    + Kotak WS#1 LTP
    ↓
Risk Engine (netQty = flBuy-flSell or qty, entry = buy_avg/sell_avg, current = LTP)
    ↓ indicative unreal/MTM (debounced 300ms)
    ↓ EngineEventBus position.updated (INDICATIVE)
    ↓ ConnectionManager → WS#3 positions channel → Position Page (badge INDICATIVE)
    ∥  periodic REST positions() (2s spacing, max 15s; immediately on WS#2 reconnect gap)
    ↓           ↘ when REST updateTime > PositionUpdate hsUpTm
    BROKER_CONFIRMED values overwrite derived + flag reconciled
```

## 14.4 Why the Old Section 14.4 Was Obsolete

Old doc: *"`position_engine recalculates unrealized (current_market_price - entry)*qty` from `feature_engine market_data_updated` per tick; position_engine-v2.3.1 as owner, no `WS#2 PositionUpdate` or `Risk Engine` as derived P&L owner"*. That treated every tick as a P&L tick inside the feature engine, never reconciled with broker amounts (`buyAmt/sellAmt`), and conflated `charge_engine` local estimates with broker ledger. The new doc defers to `Risk Engine` as authoritative, uses `WS#2` amounts as the qty/avg base, and reconciles via `REST positions()`; `feature_engine` is intentionally **not** the P&L owner (see `docs/engines/feature-engine.md §30: DOES NOT OWN POSITIONS OR PnL`).

## 14.5 Frontend Contract

Position page consumes `WS#3` `position.update` **plus** `GET /api/trading/positions` snapshot (REST snapshot + WS#3 deltas). Card shows dual badges where applicable: `indicative (live derived) vs broker-confirmed (REST asOf)` per `KOTAK_NEO_WEBSOCKET_COMPLETE_CAPABILITY_AUDIT.md` final diagram. When `brokerWsState` is `DISCONNECTED` or `hsUpTm` age > `stale` the card renders `Stale — broker confirmation pending`, not fabricated `0`.
