"""Trading routes — direct Kotak SDK calls (no proxy)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from auth.kotak_client import kotak_session

router = APIRouter(prefix="/api/trading", tags=["trading"])


class PlaceOrderRequest(BaseModel):
    exchange: str = "nse_cm"
    symbol: str = ""
    token: str = ""
    transaction_type: str = "BUY"
    product: str = "MIS"
    order_type: str = "MKT"
    quantity: str = "1"
    price: str = "0"
    trigger_price: str = "0"
    disclosed_quantity: str = "0"
    validity: str = "DAY"
    amo: str = "NO"
    market_protection: str = "NO"


class ModifyOrderRequest(BaseModel):
    order_id: str
    exchange: str = "nse_cm"
    token: str = ""
    quantity: str = "1"
    price: str = "0"
    trigger_price: str = "0"
    order_type: str = "MKT"
    validity: str = "DAY"
    disclosed_quantity: str = "0"


class CancelOrderRequest(BaseModel):
    order_id: str


class SquareOffRequest(BaseModel):
    exchange: str = "nse_cm"
    token: str = ""
    product: str = "MIS"
    quantity: str = "1"
    position_type: str = "LONG"


class SearchScripRequest(BaseModel):
    exchange: str = "nse_cm"
    search_text: str = ""


class QuoteRequest(BaseModel):
    instrument_tokens: list[dict] = []
    quote_type: str = "ltp"
    isIndex: bool = False


def _require_session():
    if not kotak_session.session_active:
        raise HTTPException(403, "Not logged in to Kotak")


@router.post("/order/place")
async def place_order(req: PlaceOrderRequest):
    _require_session()
    result = await kotak_session.async_place_order(
        exchange=req.exchange, token=req.token, transaction_type=req.transaction_type,
        product=req.product, order_type=req.order_type, quantity=req.quantity,
        price=req.price, trigger_price=req.trigger_price,
        disclosed_quantity=req.disclosed_quantity, validity=req.validity,
        amo=req.amo, market_protection=req.market_protection,
    )
    return result


@router.post("/order/modify")
async def modify_order(req: ModifyOrderRequest):
    _require_session()
    result = await kotak_session.async_modify_order(
        order_id=req.order_id, exchange=req.exchange, token=req.token,
        quantity=req.quantity, price=req.price, trigger_price=req.trigger_price,
        order_type=req.order_type, validity=req.validity,
        disclosed_quantity=req.disclosed_quantity,
    )
    return result


@router.post("/order/cancel")
async def cancel_order(req: CancelOrderRequest):
    _require_session()
    result = await kotak_session.async_cancel_order(req.order_id)
    return result


@router.get("/orders")
async def order_book():
    _require_session()
    return await kotak_session.async_order_book()


@router.get("/order/history")
async def order_history(book: str = "orders", order_id: str = ""):
    _require_session()
    return await kotak_session.async_order_history(book=book, order_id=order_id)


@router.get("/positions")
async def positions():
    _require_session()
    return await kotak_session.async_positions()


@router.post("/positions/squareoff")
async def square_off(req: SquareOffRequest):
    _require_session()
    return await kotak_session.async_square_off_position(
        exchange=req.exchange, token=req.token, product=req.product,
        quantity=req.quantity, position_type=req.position_type,
    )


@router.get("/holdings")
async def holdings():
    _require_session()
    return await kotak_session.async_holdings()


@router.get("/funds")
async def funds():
    _require_session()
    return await kotak_session.async_limits()


@router.post("/search")
async def search_scrip(req: SearchScripRequest):
    _require_session()
    return await kotak_session.async_search_scrip(req.exchange, req.search_text)


@router.post("/quote")
async def quote(req: QuoteRequest):
    _require_session()
    return await kotak_session.async_quote(
        instrument_tokens=req.instrument_tokens,
        quote_type=req.quote_type,
        isIndex=req.isIndex,
    )

