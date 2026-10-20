"""Risk Engine Service Phase API — pre-execution validation for every order.

The Risk Engine is a mandatory pre-execution safety gate that evaluates every
order request against active risk policy and returns a structured decision.
"""
from __future__ import annotations

from fastapi import APIRouter, Body
from pydantic import BaseModel

from core.engines.risk_engine import risk_engine, RiskDecision

router = APIRouter(prefix="/api/services/risk", tags=["risk-engine"])

def _ok(data) -> dict:
    return {"ok": True, "data": data}

def _bad(message: str) -> dict:
    return {"ok": False, "error": message}

class ValidateOrderRequest(BaseModel):
    terminal: str = "kotak"
    symbol: str = ""
    token: str = ""
    exchange: str = "nse_cm"
    transaction_type: str = "BUY"
    product: str = "MIS"
    order_type: str = "MKT"
    quantity: str = "1"
    price: str = "0"
    trigger_price: str = "0"
    expected_ltp: float = 0.0
    max_order_value: float | None = None

@router.post("/validate")
async def validate_order(req: ValidateOrderRequest):
    """Validate an order request against active risk policy."""
    try:
        decision = await risk_engine.validate_order(
            terminal=req.terminal,
            symbol=req.symbol,
            token=req.token,
            exchange=req.exchange,
            transaction_type=req.transaction_type,
            product=req.product,
            order_type=req.order_type,
            quantity=req.quantity,
            price=req.price,
            trigger_price=req.trigger_price,
            expected_ltp=req.expected_ltp,
            max_order_value=req.max_order_value,
        )
    except Exception as exc:
        return _bad(f"validation error: {exc}")
    return _ok(decision.to_dict())

@router.get("/snapshot")
async def get_snapshot(terminal: str = "kotak"):
    """Real risk posture for the given terminal (funds + positions)."""
    try:
        data = await risk_engine.snapshot(terminal)
    except Exception as exc:
        return _bad(f"snapshot error: {exc}")
    return _ok(data)

@router.get("/config")
async def get_config():
    """Return the current risk engine configuration + live counters."""
    from core.engines.risk_engine import (
        _MAX_QTY_PER_SYMBOL,
        _MAX_ORDER_VALUE,
        _MAX_DAILY_LOSS_PCT,
        _MAX_TOTAL_EXPOSURE,
        _DUPLICATE_ORDER_SILO_SEC,
        _ORDER_TYPE_WHITELIST,
        _TX_WHITELIST,
        _BLOCKED_SYMBOLS,
        risk_engine,
    )
    return {
        "ok": True,
        "data": {
            "maxQtyPerSymbol": _MAX_QTY_PER_SYMBOL,
            "maxOrderValue": _MAX_ORDER_VALUE,
            "maxDailyLossPct": _MAX_DAILY_LOSS_PCT,
            "maxTotalExposure": _MAX_TOTAL_EXPOSURE,
            "duplicateOrderSiloSec": _DUPLICATE_ORDER_SILO_SEC,
            "orderTypeWhitelist": sorted(_ORDER_TYPE_WHITELIST),
            "txWhitelist": sorted(_TX_WHITELIST),
            "blockedSymbols": sorted(_BLOCKED_SYMBOLS),
            "stats": {
                "validations": risk_engine._validation_count,
                "blocks": risk_engine._block_count,
                "recentDecisions": risk_engine.recent_decisions(),
            },
        }
    }

class UpdateConfigRequest(BaseModel):
    maxQtyPerSymbol: int | None = None
    maxOrderValue: float | None = None
    maxDailyLossPct: float | None = None
    maxTotalExposure: float | None = None
    duplicateOrderSiloSec: float | None = None
    orderTypeWhitelist: list[str] | None = None
    txWhitelist: list[str] | None = None
    blockedSymbols: list[str] | None = None

@router.patch("/config")
async def update_config(req: UpdateConfigRequest):
    """Update risk engine configuration at runtime (validated + normalized)."""
    import core.engines.risk_engine as re
    if req.maxQtyPerSymbol is not None:
        if int(req.maxQtyPerSymbol) < 0:
            return _bad("maxQtyPerSymbol must be >= 0 (0 = unlimited)")
        re._MAX_QTY_PER_SYMBOL = int(req.maxQtyPerSymbol)
    if req.maxOrderValue is not None:
        if float(req.maxOrderValue) < 0:
            return _bad("maxOrderValue must be >= 0 (0 = unlimited)")
        re._MAX_ORDER_VALUE = float(req.maxOrderValue)
    if req.maxDailyLossPct is not None:
        if not 0 <= float(req.maxDailyLossPct) <= 100:
            return _bad("maxDailyLossPct must be between 0 and 100")
        re._MAX_DAILY_LOSS_PCT = float(req.maxDailyLossPct)
    if req.maxTotalExposure is not None:
        if float(req.maxTotalExposure) < 0:
            return _bad("maxTotalExposure must be >= 0 (0 = unlimited)")
        re._MAX_TOTAL_EXPOSURE = float(req.maxTotalExposure)
    if req.duplicateOrderSiloSec is not None:
        if float(req.duplicateOrderSiloSec) < 0:
            return _bad("duplicateOrderSiloSec must be >= 0")
        re._DUPLICATE_ORDER_SILO_SEC = float(req.duplicateOrderSiloSec)
    if req.orderTypeWhitelist is not None:
        cleaned = {str(o).strip().upper() for o in req.orderTypeWhitelist if str(o).strip()}
        if not cleaned:
            return _bad("orderTypeWhitelist must keep at least one order type")
        re._ORDER_TYPE_WHITELIST = cleaned
    if req.txWhitelist is not None:
        cleaned = {str(t).strip().upper() for t in req.txWhitelist if str(t).strip()}
        if not cleaned:
            return _bad("txWhitelist must keep at least one transaction type")
        re._TX_WHITELIST = cleaned
    if req.blockedSymbols is not None:
        re._BLOCKED_SYMBOLS = {str(s).strip().upper() for s in req.blockedSymbols if str(s).strip()}
    return await get_config()