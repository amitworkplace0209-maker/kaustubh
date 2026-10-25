"""P&L Engine — canonical realized / unrealized / net computations.

Consumes raw rows from the ACTIVE adapter's ``positions()`` (Kotak, Shoonya or
Dummy) and produces the canonical shape consumed by the terminal UI. All math
is real — nothing is fabricated; unknown fields resolve to zero rather than
invented numbers.
"""
from __future__ import annotations
from typing import Any, Callable

from brokers.models import safe_float


def normalize_position(row: Any, index: int = 0) -> dict:
    """Normalize one broker-native position row into the canonical shape."""
    if not isinstance(row, dict):
        return {"index": index, "raw": row}

    sym = str(row.get("sym") or row.get("symbol") or row.get("trdSym") or "").split("-")[0]
    exch = str(row.get("exSeg") or row.get("exchange") or row.get("exchange_segment") or "")
    prod = str(row.get("prod") or row.get("product") or "")

    mult = safe_float(row.get("multiplier"), 1.0) or 1.0
    cf_buy = int(safe_float(row.get("cfBuyQty")))
    fl_buy = int(safe_float(row.get("flBuyQty")))
    cf_sell = int(safe_float(row.get("cfSellQty")))
    fl_sell = int(safe_float(row.get("flSellQty")))
    buy_qty = cf_buy + fl_buy
    sell_qty = cf_sell + fl_sell
    # Canonical (Dummy / Shoonya) rows carry the quantities under their
    # canonical names instead of the Kotak CF/FL split.
    if buy_qty == 0:
        buy_qty = int(safe_float(row.get("buyQuantity") or row.get("buy_qty")))
    if sell_qty == 0:
        sell_qty = int(safe_float(row.get("sellQuantity") or row.get("sell_qty")))

    buy_amt = safe_float(row.get("cfBuyAmt")) + safe_float(row.get("buyAmt"))
    sell_amt = safe_float(row.get("cfSellAmt")) + safe_float(row.get("sellAmt"))

    buy_avg = (buy_amt / (buy_qty * mult)) if buy_qty > 0 else 0.0
    sell_avg = (sell_amt / (sell_qty * mult)) if sell_qty > 0 else 0.0
    # Canonical rows already carry the per-share average price.
    if buy_avg == 0 and buy_qty > 0:
        buy_avg = safe_float(row.get("averageBuyPrice") or row.get("buy_avg"))
    if sell_avg == 0 and sell_qty > 0:
        sell_avg = safe_float(row.get("averageSellPrice") or row.get("sell_avg"))

    net_qty = int(safe_float(row.get("qty") or row.get("netQuantity") or row.get("net_qty")))
    if net_qty == 0:
        net_qty = buy_qty - sell_qty

    net_avg = buy_avg if net_qty >= 0 else sell_avg

    ltp = safe_float(row.get("ltp") or row.get("last_price") or row.get("lastPrice"))
    market_value = abs(net_qty) * (ltp if ltp > 0 else net_avg)

    realized = safe_float(row.get("realised") or row.get("realized") or row.get("realizedPnl") or row.get("realized_pnl"))
    if realized == 0 and (sell_qty > 0 or buy_qty > 0):
        realized = round(sell_amt - buy_amt, 2)

    if ltp > 0 and net_qty > 0:
        unrealized = (ltp - buy_avg) * abs(net_qty)
    elif ltp > 0 and net_qty < 0:
        unrealized = (sell_avg - ltp) * abs(net_qty)
    else:
        unrealized = safe_float(row.get("unrealised") or row.get("unrealized") or row.get("unrealizedPnl"))

    charges = safe_float(
        row.get("estimated_charges") or row.get("charges")
        or row.get("brokerage") or row.get("estimatedCharges")
    )
    charges_known = bool(
        row.get("estimated_charges") is not None or row.get("charges") is not None
        or row.get("brokerage") is not None or row.get("estimatedCharges") is not None
    )

    gross = round(realized + unrealized, 2)
    net = round(gross - charges, 2) if charges_known else gross

    return {
        "index": index,
        "symbol": sym,
        "tradingSymbol": str(row.get("trdSym") or row.get("tradingSymbol") or row.get("tradingsymbol") or ""),
        "token": str(row.get("tok") or row.get("token") or row.get("instrument_token") or ""),
        "exchange": exch,
        "exchangeSegment": exch,
        "product": prod,
        "netQuantity": net_qty,
        "buyQuantity": buy_qty,
        "sellQuantity": sell_qty,
        "averageBuyPrice": round(buy_avg, 2),
        "averageSellPrice": round(sell_avg, 2),
        "averagePrice": round(net_avg, 2),
        "ltp": ltp if ltp > 0 else None,
        "marketValue": market_value,
        "positionType": "LONG" if net_qty > 0 else ("SHORT" if net_qty < 0 else "FLAT"),
        "realizedPnl": round(realized, 2),
        "unrealizedPnl": round(unrealized, 2),
        "grossPnl": gross,
        "estimatedCharges": charges if charges_known else None,
        "netPnl": net,
    }


def compute_totals(rows: list[dict]) -> dict:
    realized = round(sum(r.get("realizedPnl", 0) or 0 for r in rows), 2)
    unrealized = round(sum(r.get("unrealizedPnl", 0) or 0 for r in rows), 2)
    gross = round(realized + unrealized, 2)
    market_value = round(sum(r.get("marketValue", 0) or 0 for r in rows), 2)
    return {
        "realizedPnl": realized,
        "unrealizedPnl": unrealized,
        "grossPnl": gross,
        "netPnl": gross,
        "marketValue": market_value,
        "openPositions": sum(1 for r in rows if r.get("positionType") != "FLAT"),
    }