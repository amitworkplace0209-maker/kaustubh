"""Watchlist Engine API (docs/engines/watchlist-engine.md).

Exposes the Watchlist Engine's normalized card model and dynamic ranking to
the UI while keeping watchlist persistence in the existing DB-backed
``/api/watchlist`` routes. The engine owns live-data processing, derived
metrics (change %, 5-min %, 10-min %) and dynamic screening/ranking.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services.watchlist_engine import watchlist_engine

router = APIRouter(prefix="/api/watchlist-engine", tags=["watchlist-engine"])


class StockRef(BaseModel):
    symbol: str = ""
    token: str = ""
    exchange: str = "nse_cm"
    exchangeSegment: str = ""
    tradingSymbol: str = ""
    companyName: str = ""
    isin: str = ""


class CardsRequest(BaseModel):
    stocks: list[StockRef] = Field(default_factory=list)


class CreateWatchlistRequest(BaseModel):
    name: str
    watchlistId: str | None = None
    type: str = "personal"


class RenameWatchlistRequest(BaseModel):
    name: str


class AddSymbolRequest(BaseModel):
    symbol: str = ""
    token: str
    exchange: str = "nse_cm"
    exchangeSegment: str = ""
    tradingSymbol: str = ""
    companyName: str = ""
    isin: str = ""


class ReorderRequest(BaseModel):
    tokens: list[str] = Field(default_factory=list)


class ScreenRule(BaseModel):
    field: str
    op: str = "gt"
    value: float


class ScreenRequest(BaseModel):
    rules: list[ScreenRule] = Field(default_factory=list)
    watchlistId: str | None = None
    limit: int = 50


class DynamicRequest(BaseModel):
    stocks: list[StockRef] = Field(default_factory=list)
    limit: int = 20


@router.get("")
async def list_watchlists():
    return {"data": watchlist_engine.list_watchlist_meta()}


@router.post("")
async def create_watchlist(req: CreateWatchlistRequest):
    result = watchlist_engine.create_watchlist(req.name, req.type, req.watchlistId)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result.get("error"))
    return result


@router.patch("/{watchlist_id}")
async def rename_watchlist(watchlist_id: str, req: RenameWatchlistRequest):
    result = watchlist_engine.rename_watchlist(watchlist_id, req.name)
    if not result["ok"]:
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


@router.delete("/{watchlist_id}")
async def delete_watchlist(watchlist_id: str):
    result = watchlist_engine.delete_watchlist(watchlist_id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result.get("error"))
    return result


@router.post("/cards")
async def project_cards(req: CardsRequest):
    """Normalize arbitrary stocks into the stable live card model.

    Used by the DB-backed watchlist so live processing, metrics and status all
    come from the engine instead of the UI.
    """
    cards = [
        watchlist_engine.card_for_token(
            str(s.token),
            {"symbol": s.symbol, "token": s.token, "exchange": s.exchange,
             "exchangeSegment": s.exchangeSegment or s.exchange,
             "tradingSymbol": s.tradingSymbol, "companyName": s.companyName,
             "isin": s.isin},
        )
        for s in req.stocks
    ]
    return {"data": cards}


@router.get("/{watchlist_id}/cards")
async def get_cards(watchlist_id: str):
    return {"data": watchlist_engine.get_cards(watchlist_id)}


@router.post("/{watchlist_id}/symbols")
async def add_symbol(watchlist_id: str, req: AddSymbolRequest):
    result = watchlist_engine.add_stock(
        watchlist_id, req.symbol, req.token,
        exchange=req.exchange, exchangeSegment=req.exchangeSegment,
        tradingSymbol=req.tradingSymbol, companyName=req.companyName, isin=req.isin,
    )
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result.get("error"))
    return result


@router.delete("/{watchlist_id}/symbols/{token}")
async def remove_symbol(watchlist_id: str, token: str):
    result = watchlist_engine.remove_stock(watchlist_id, token)
    if not result["ok"]:
        raise HTTPException(status_code=404, detail="not found")
    return result


@router.put("/{watchlist_id}/order")
async def reorder(watchlist_id: str, req: ReorderRequest):
    result = watchlist_engine.reorder(watchlist_id, req.tokens)
    if not result["ok"]:
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


@router.get("/dynamic/{kind}")
async def dynamic_list(
    kind: str,
    watchlistId: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
):
    try:
        return {"kind": kind, "data": watchlist_engine.dynamic_list(kind, watchlistId, limit)}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/dynamic/{kind}")
async def dynamic_list_for_universe(kind: str, req: DynamicRequest):
    """Rank an explicit stock universe (e.g. the DB-backed watchlist rows)."""
    universe = [s.model_dump() for s in req.stocks]
    try:
        data = watchlist_engine.dynamic_list(kind, None, req.limit, universe=universe)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"kind": kind, "data": data}


@router.post("/screen")
async def screen(req: ScreenRequest):
    rules = [r.model_dump() for r in req.rules]
    return {"data": watchlist_engine.screen(rules, req.watchlistId, req.limit)}


@router.get("/subscriptions")
async def subscriptions(watchlistId: str | None = Query(default=None)):
    """The required live-subscription set for the Connection Manager."""
    return {"data": watchlist_engine.desired_subscriptions(watchlistId)}


@router.get("/meta/dynamic-kinds")
async def dynamic_kinds():
    return {"data": watchlist_engine.dynamic_list_kinds()}
