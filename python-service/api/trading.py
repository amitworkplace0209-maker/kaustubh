"""Trading routes — Kotak SDK actions via the shared broker request layer."""
from __future__ import annotations
import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from auth.kotak_client import kotak_session

from services.instrument_cache import instrument_cache
from services.broker_cache import broker_cache
from services.session.session_manager import session_manager
from core.engines import order_engine
from api.search import (
    DEPRECATION_TARGET,
    canonical_instrument_rows,
    legacy_row,
)

router = APIRouter(prefix="/api/trading", tags=["trading"])
log = logging.getLogger("trading")

# Read-only broker endpoints are routed through the shared single-flight,
# TTL'd, cooldown'd broker cache so concurrent dashboard/trading polling can
# never flood the SDK thread pool (the historical cause of SAFE_CALL TIMEOUT
# storms). Mutating actions (place/modify/cancel/square-off) always hit the
# broker directly and are never cached.
_BROKER_CACHE_TTL = 5.0
_BROKER_CACHE_COOLDOWN = 15.0
_BROKER_CACHE_TIMEOUT = 4.0

# Mutating broker actions are bounded by an independent per-call timeout so a
# slow/hung broker response cannot block the endpoint (or the event loop) —
# a slow order call must never stall WebSocket ticks, the scheduler, or other
# unrelated API requests.
_ACTION_TIMEOUT = 8.0


async def _bounded(awaitable, label: str):
    try:
        return await asyncio.wait_for(awaitable, timeout=_ACTION_TIMEOUT)
    except asyncio.TimeoutError:
        log.error("BROKER_ACTION_TIMEOUT %s after %.0fs", label, _ACTION_TIMEOUT)
        raise HTTPException(504, f"Broker request timed out ({label})")


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
    #: Real observed LTP the caller already holds. A real broker ignores it and
    #: prices from its own feed; a price-less paper engine needs it to decide
    #: marketability. Sent only when it is a genuinely positive number.
    expected_ltp: str = "0"
    #: MANUAL / AI / BASKET_MANUAL / BASKET_AI / SYSTEM / SQUAREOFF.
    source: str = "MANUAL"


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


def _require_session(require_kotak: bool = True) -> None:
    """Verify the caller holds an authenticated session.

    Dual-mode isolation boundary:
    * ``require_kotak=True`` (default) — used by every Kotak account, order,
      position and funds endpoint. Dummy mode is served exclusively by
      ``/api/demo/*``; these routes ALWAYS demand a real Kotak Neo session, so
      dummy mode can never read real broker books or place real orders through
      them.
    * ``require_kotak=False`` — market-data only (quote / symbol lookup). The
      shared instrument cache and quote stream stay available to the terminal
      regardless of which mode is active.
    """
    session_manager.auth_gate("trading")
    if require_kotak and not kotak_session.session_active:
        raise HTTPException(403, "Kotak Neo session required")


async def _trade_notify(severity: str, title: str, message: str, event_type: str, meta: dict) -> None:
    """Best-effort broker order notification (ledger store + PWA fan-out).
    Never raises into the order path."""
    try:
        from services.notification_service import notify
        await notify(
            "trade", severity, title, message,
            source="kotak-broker", event_type=event_type, metadata=meta,
        )
    except Exception:
        pass


@router.post("/order/place")
async def place_order(req: PlaceOrderRequest):
    _require_session()
    result = await order_engine.place("kotak", _order_fields(req))
    meta = {"symbol": req.symbol, "token": req.token, "exchange": req.exchange,
            "side": req.transaction_type, "quantity": req.quantity,
            "price": req.price, "product": req.product,
            "order_id": ((result.get("data") or {}) if isinstance(result.get("data"), dict) else {}).get("n_ord_no", "")}
    if not result.get("ok"):
        message = (result.get("error") or {}).get("message") or "; ".join(result.get("reasons") or []) or "order rejected"
        await _trade_notify("error", "Broker order rejected",
                            f"{req.transaction_type} {req.quantity} {req.symbol} — {message}",
                            "ORDER_REJECTED", meta)
        return {"data": {"stat": "NotOk", "remarks": message}}
    placed = result.get("data") or {"data": result}
    await _trade_notify("success", "Broker order placed",
                        f"{req.transaction_type} {req.quantity} {req.symbol} @ ₹{req.price} · {req.product}",
                        "ORDER_PLACED", meta)
    return placed


@router.post("/order/modify")
async def modify_order(req: ModifyOrderRequest):
    _require_session()
    result = await order_engine.modify("kotak", req.order_id, _order_fields(req))
    if not result.get("ok"):
        message = (result.get("error") or {}).get("message") or "; ".join(result.get("reasons") or []) or "order rejected"
        return {"data": {"stat": "NotOk", "remarks": message}}
    await _trade_notify("info", "Broker order modified",
                        f"{req.order_id} → qty {req.quantity} @ ₹{req.price}",
                        "ORDER_MODIFIED",
                        {"order_id": req.order_id, "quantity": req.quantity, "price": req.price})
    return result.get("data") or {"data": result}


@router.post("/order/cancel")
async def cancel_order(req: CancelOrderRequest):
    _require_session()
    result = await order_engine.cancel("kotak", req.order_id)
    if not result.get("ok"):
        message = (result.get("error") or {}).get("message") or "order cancel rejected"
        return {"data": {"stat": "NotOk", "remarks": message}}
    await _trade_notify("info", "Broker order cancelled",
                        f"{req.order_id} — cancelled",
                        "ORDER_CANCELLED", {"order_id": req.order_id})
    return result.get("data") or {"data": result}


@router.get("/orders")
async def order_book():
    _require_session()
    return await broker_cache.get(
        "order_book", kotak_session.async_order_book,
        ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
        timeout=_BROKER_CACHE_TIMEOUT,
    )


@router.get("/order/history")
async def order_history(book: str = "orders", order_id: str = ""):
    _require_session()
    return await kotak_session.async_order_history(book=book, order_id=order_id)


@router.get("/trades")
async def trades():
    """Executed-trade book — MUST come from the SDK trade_report() endpoint
    (not order_report(), which returns the order book)."""
    _require_session()
    return await broker_cache.get(
        "trade_book", kotak_session.async_trade_report,
        ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
        timeout=_BROKER_CACHE_TIMEOUT,
    )


@router.get("/margin")
async def margin(
    token: str = "",
    product: str = "MIS",
    order_type: str = "MKT",
    quantity: str = "1",
    price: str = "0",
    trigger_price: str = "0",
    transaction_type: str = "BUY",
    exchange: str = "nse_cm",
):
    """Real broker-computed margin preview (SDK margin_required). Returns an
    honest `available:false` envelope when it cannot be computed — never a
    fabricated estimate."""
    _require_session()
    result = await kotak_session.async_margin_required(
        exchange=exchange, token=token, product=product, order_type=order_type,
        quantity=quantity, price=price, trigger_price=trigger_price,
        transaction_type=transaction_type,
    )
    if isinstance(result, dict):
        err_key = next(
            (k for k in ("Error", "Error Message", "error", "errorMessage")
             if result.get(k) is not None),
            None,
        )
        if err_key:
            return {"available": False, "message": str(result[err_key])[:300]}
    return {"available": True, "data": result}


def _order_fields(req) -> dict:
    """Stable order-intent dict for the Common Trading Core (Risk→Audit→Adapter)."""
    if hasattr(req, "model_dump"):
        return req.model_dump()
    return req.dict()


def _safe_int(v, default=0):
    try:
        return int(str(v).strip())
    except (ValueError, TypeError):
        return default


def _safe_float(v, default=0.0):
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return default


@router.get("/positions")
async def positions():
    _require_session()
    result = await broker_cache.get(
        "positions", kotak_session.async_positions,
        ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
        timeout=_BROKER_CACHE_TIMEOUT,
    )
    raw_data = result.get("data") if isinstance(result, dict) else result
    if not isinstance(raw_data, list):
        return result

    normalized = []
    for idx, item in enumerate(raw_data):
        if not isinstance(item, dict):
            normalized.append(item)
            continue
        n = dict(item)

        sym = n.get("sym") or n.get("trdSym", "")
        if isinstance(sym, str) and "-" in sym:
            sym = sym.split("-")[0]
        n["sym_clean"] = str(sym)

        trd_sym = n.get("trdSym") or n.get("trading_symbol") or n.get("tradingsymbol") or ""
        n["trdSym_clean"] = str(trd_sym)

        ex_seg = n.get("exSeg") or n.get("exchange_segment") or ""
        n["exSeg_clean"] = str(ex_seg)

        prod = n.get("prod") or n.get("product") or ""
        n["prod_clean"] = str(prod)

        cf_buy = _safe_int(n.get("cfBuyQty"))
        fl_buy = _safe_int(n.get("flBuyQty"))
        cf_sell = _safe_int(n.get("cfSellQty"))
        fl_sell = _safe_int(n.get("flSellQty"))

        total_buy_qty = cf_buy + fl_buy
        total_sell_qty = cf_sell + fl_sell

        n["buy_quantity"] = total_buy_qty
        n["sell_quantity"] = total_sell_qty

        cf_buy_amt = _safe_float(n.get("cfBuyAmt"))
        buy_amt = _safe_float(n.get("buyAmt"))
        cf_sell_amt = _safe_float(n.get("cfSellAmt"))
        sell_amt = _safe_float(n.get("sellAmt"))

        total_buy_amt = cf_buy_amt + buy_amt
        total_sell_amt = cf_sell_amt + sell_amt

        mult = _safe_float(n.get("multiplier"), 1.0)
        if mult == 0:
            mult = 1.0

        n["buy_avg"] = (total_buy_amt / (total_buy_qty * mult)) if total_buy_qty > 0 else 0.0
        n["sell_avg"] = (total_sell_amt / (total_sell_qty * mult)) if total_sell_qty > 0 else 0.0
        n["buy_value"] = total_buy_amt
        n["sell_value"] = total_sell_amt

        net_qty_sdk = _safe_int(n.get("qty") or n.get("net_quantity") or n.get("net_qty"))
        if net_qty_sdk == 0:
            net_qty_computed = total_buy_qty - total_sell_qty
        else:
            net_qty_computed = net_qty_sdk

        n["net_qty"] = net_qty_computed

        if net_qty_computed > 0:
            n["net_average_price"] = n["buy_avg"]
        elif net_qty_computed < 0:
            n["net_average_price"] = n["sell_avg"]
        else:
            if total_buy_qty > 0 and total_sell_qty > 0:
                n["net_average_price"] = n["buy_avg"]
            elif total_buy_qty > 0:
                n["net_average_price"] = n["buy_avg"]
            elif total_sell_qty > 0:
                n["net_average_price"] = n["sell_avg"]
            else:
                n["net_average_price"] = 0.0

        n["avg_price"] = n["net_average_price"]
        n["average_price"] = n["net_average_price"]

        ltp_val = _safe_float(n.get("ltp") or n.get("last_price"))
        n["ltp"] = ltp_val

        pos_type = n.get("trnsTp") or n.get("position_type") or ""
        if not pos_type or pos_type == "NA":
            if net_qty_computed > 0:
                pos_type = "BUY"
            elif net_qty_computed < 0:
                pos_type = "SELL"
            else:
                pos_type = "FLAT"
        n["position_type"] = pos_type

        n["instrument_token"] = str(n.get("tok") or n.get("instrument_token") or n.get("token") or "")
        n["exchange"] = ex_seg
        n["exchange_segment"] = ex_seg
        n["product"] = prod

        if net_qty_computed != 0:
            n["position_status"] = "OPEN"
        elif total_buy_qty > 0 or total_sell_qty > 0:
            n["position_status"] = "CLOSED"
        else:
            n["position_status"] = "FLAT"

        charges_key = next(
            (k for k in ("estimated_charges", "charges", "brokerage")
             if n.get(k) not in (None, "")),
            None,
        )
        charges_known = charges_key is not None
        charges = _safe_float(n[charges_key]) if charges_known else 0.0
        n["charges_known"] = charges_known
        n["estimated_charges"] = charges if charges_known else None

        broker_realized = _safe_float(n.get("realised") or n.get("realized") or n.get("realized_pnl"))
        broker_unrealized = _safe_float(n.get("unrealised") or n.get("unrealized") or n.get("unrealized_pnl"))

        abs_net_qty = abs(net_qty_computed)
        if ltp_val and ltp_val > 0:
            n["market_value"] = abs_net_qty * ltp_val
        elif n["net_average_price"] and n["net_average_price"] > 0:
            n["market_value"] = abs_net_qty * n["net_average_price"]
        else:
            n["market_value"] = 0.0

        if total_sell_qty > 0 or total_buy_qty > 0:
            computed_realized = total_sell_amt - total_buy_amt
        else:
            computed_realized = 0.0

        if broker_realized != 0.0:
            realized = broker_realized
        elif total_buy_qty > 0 and total_sell_qty > 0:
            realized = computed_realized
        elif net_qty_computed == 0 and (total_buy_qty > 0 or total_sell_qty > 0):
            realized = computed_realized
        else:
            realized = broker_realized

        if broker_unrealized != 0.0:
            unrealized = broker_unrealized
        elif net_qty_computed != 0 and ltp_val and ltp_val > 0:
            if net_qty_computed > 0:
                unrealized = (ltp_val - n["buy_avg"]) * abs_net_qty
            else:
                unrealized = (n["sell_avg"] - ltp_val) * abs_net_qty
        else:
            unrealized = broker_unrealized

        n["realised"] = round(realized, 2)
        n["unrealised"] = round(unrealized, 2)

        gross_pnl = round(realized + unrealized, 2)
        n["gross_pnl"] = gross_pnl
        n["net_pnl"] = round(gross_pnl - charges, 2)

        buy_value = n["buy_value"]
        if buy_value > 0:
            n["pnl_percent"] = round((gross_pnl / buy_value) * 100, 2)
        else:
            n["pnl_percent"] = 0.0

        n["last_known_ltp"] = ltp_val if ltp_val and ltp_val > 0 else None
        n["hsUpTm"] = n.get("hsUpTm", "")

        inst_token = n.get("instrument_token", "")
        inst_sym = n.get("sym_clean") or n.get("sym") or ""
        company_name = ""
        inst_info = None
        if inst_token:
            inst_info = instrument_cache.lookup_by_token(inst_token)
        if not inst_info and inst_sym:
            inst_info = instrument_cache.lookup_by_symbol(inst_sym)
        if inst_info:
            company_name = inst_info.get("companyName", "")
            n["company_name"] = company_name
            if not n.get("instrument_token") or n["instrument_token"] == "":
                n["instrument_token"] = inst_info.get("token", "")
        else:
            n["company_name"] = ""

        # Stable position index — deterministic order from the broker response.
        n["position_index"] = idx

        normalized.append(n)

    # Enrich open positions with live OHLC + change data from the quote API.
    open_tokens = [
        {"instrument_token": n["instrument_token"], "exchange_segment": n.get("exchange_segment", "nse_cm")}
        for n in normalized
        if n.get("position_status") == "OPEN" and n.get("instrument_token")
    ]
    if open_tokens:
        try:
            ltp_res = await kotak_session.async_quote(
                instrument_tokens=open_tokens, quote_type="ltp", isIndex=False,
            )
            ohlc_res = await kotak_session.async_quote(
                instrument_tokens=open_tokens, quote_type="ohlc", isIndex=False,
            )
            ltp_data = ltp_res.get("data", []) if isinstance(ltp_res, dict) else []
            ohlc_data = ohlc_res.get("data", []) if isinstance(ohlc_res, dict) else []

            ohlc_map = {}
            for item in ohlc_data:
                if isinstance(item, dict):
                    tok = str(item.get("exchange_token", ""))
                    ohlc_map[tok] = item.get("ohlc", {})

            ltp_map = {}
            for item in ltp_data:
                if isinstance(item, dict):
                    tok = str(item.get("exchange_token", ""))
                    ltp_map[tok] = _safe_float(item.get("ltp") or item.get("last_price"))

            for n in normalized:
                if n.get("position_status") != "OPEN":
                    continue
                tok = n.get("instrument_token", "")
                if not tok:
                    continue
                # Update LTP from quote if better than positions LTP
                q_ltp = ltp_map.get(tok, 0)
                if q_ltp > 0:
                    n["ltp"] = q_ltp
                    abs_qty = abs(n.get("net_qty", 0))
                    n["market_value"] = abs_qty * q_ltp
                    # Recompute unrealized with fresh LTP
                    if n.get("net_qty", 0) > 0:
                        n["unrealised"] = round((q_ltp - n["buy_avg"]) * abs_qty, 2)
                    elif n.get("net_qty", 0) < 0:
                        n["unrealised"] = round((n["sell_avg"] - q_ltp) * abs_qty, 2)
                    gross = round(n["realised"] + n["unrealised"], 2)
                    n["gross_pnl"] = gross
                    chg = _safe_float(n.get("estimated_charges"))
                    n["net_pnl"] = round(gross - chg, 2) if n.get("charges_known") else gross
                    n["last_known_ltp"] = q_ltp

                # OHLC market data
                ohlc = ohlc_map.get(tok, {})
                if ohlc:
                    n["ohlc"] = {
                        "open": _safe_float(ohlc.get("open") or ohlc.get("Open")),
                        "high": _safe_float(ohlc.get("high") or ohlc.get("High")),
                        "low": _safe_float(ohlc.get("low") or ohlc.get("Low")),
                        "close": _safe_float(ohlc.get("close") or ohlc.get("Close")),
                    }
                    n["volume"] = _safe_int(ohlc.get("volume") or ohlc.get("Volume"))
                    n["upper_circuit"] = _safe_float(ohlc.get("upper_circuit") or ohlc.get("uc"))
                    n["lower_circuit"] = _safe_float(ohlc.get("lower_circuit") or ohlc.get("lc"))
        except Exception as e:
            log.warning("OHLC enrichment failed: %s", e)

    return {"data": normalized, "stat": result.get("stat", "ok")}


@router.post("/positions/squareoff")
async def square_off(req: SquareOffRequest):
    _require_session()
    result = await order_engine.square_off("kotak", {
        "exchange": req.exchange, "token": req.token, "symbol": "",
        "product": req.product, "netQuantity": req.quantity, "positionType": req.position_type,
    })
    if not result.get("ok"):
        message = (result.get("error") or {}).get("message") or "square-off rejected"
        return {"data": {"stat": "NotOk", "remarks": message}}
    direction = "SELL" if str(req.position_type).upper() == "LONG" else "BUY"
    await _trade_notify("success", "Broker square-off placed",
                        f"{direction} {req.quantity} (token {req.token}) · {req.product} — square-off",
                        "ORDER_SQUAREOFF",
                        {"token": req.token, "exchange": req.exchange, "side": direction,
                         "quantity": req.quantity, "product": req.product})
    return result.get("data") or {"data": result}


@router.get("/holdings")
async def holdings():
    _require_session()
    return await broker_cache.get(
        "holdings", kotak_session.async_holdings,
        ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
        timeout=_BROKER_CACHE_TIMEOUT,
    )


@router.get("/funds")
async def funds():
    _require_session()
    return await broker_cache.get(
        "limits", kotak_session.async_limits,
        ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
        timeout=_BROKER_CACHE_TIMEOUT,
    )


@router.post("/search")
async def search_scrip(req: SearchScripRequest):
    """Broker scrip search passthrough.

    DEPRECATED: use ``GET /api/search?q=...``. The Search Engine does not own a
    broker scrip lookup, so this remains a direct broker call for the few
    broker-specific callers; it is no longer used for instrument discovery.
    """
    _require_session(require_kotak=False)
    return await kotak_session.async_search_scrip(req.exchange, req.search_text)


@router.post("/search-local")
async def search_scrip_local(req: SearchScripRequest):
    """Local instrument search.

    DEPRECATED: use ``GET /api/search?q=...`` (the canonical Search Engine).
    Retained for existing callers; the lookup now runs through the one
    canonical index instead of its own master scan. The legacy envelope is
    unchanged.
    """
    total_start = time.time()

    rows, meta = canonical_instrument_rows(req.search_text, 10, eq_only=True)
    total_ms = int((time.time() - total_start) * 1000)
    return {
        "data": [legacy_row(r) for r in rows],
        "stat": "ok",
        "source": "search_engine",
        "cache_ms": int(meta.get("tookMs") or 0.0),
        "total_ms": total_ms,
        "instrument_count": meta.get("total", len(rows)),
        "deprecated": True,
        "replacement": DEPRECATION_TARGET,
    }


@router.get("/instrument-cache/status")
async def instrument_cache_status():
    """Check instrument cache status."""
    return instrument_cache.get_status()


@router.get("/instrument-cache/debug")
async def instrument_cache_debug():
    """Debug: sample instruments and field distribution."""
    total = instrument_cache.instrument_count
    if total == 0:
        return {"total": 0, "error": "cache empty"}
    
    # Check first 500 instruments for pInstType and pSeries distribution
    inst_type_counts = {}
    series_counts = {}
    group_counts = {}
    rel_samples = []
    
    for inst in instrument_cache._instruments[:2000]:
        raw = inst.get("raw", {})
        it = raw.get("pInstType", "EMPTY")
        sr = raw.get("pSeries", "EMPTY")
        gr = raw.get("pGroup", "EMPTY")
        inst_type_counts[it] = inst_type_counts.get(it, 0) + 1
        series_counts[sr] = series_counts.get(sr, 0) + 1
        group_counts[gr] = group_counts.get(gr, 0) + 1
    
    # Find RELIANCE and TCS
    samples = {"RELIANCE": [], "TCS": [], "INFY": []}
    for inst in instrument_cache._instruments:
        for key in samples:
            if len(samples[key]) >= 3:
                continue
            if key in inst.get("symbol", "").upper() or key in inst.get("companyName", "").upper() or key in inst.get("tradingSymbol", "").upper():
                raw = inst.get("raw", {})
                samples[key].append({
                    "symbol": inst.get("symbol"),
                    "token": inst.get("token"),
                    "instType": inst.get("instrumentType"),
                    "tradingSymbol": inst.get("tradingSymbol"),
                    "name": inst.get("companyName"),
                    "raw_pGroup": raw.get("pGroup"),
                })

    return {
        "total": total,
        "inst_type_dist": inst_type_counts,
        "series_dist": series_counts,
        "group_dist": group_counts,
        "search_samples": samples,
    }


@router.post("/instrument-cache/reload")
async def instrument_cache_reload():
    """Force reload instrument cache."""
    _require_session()
    success = instrument_cache.load()
    return {
        "success": success,
        **instrument_cache.get_status(),
    }


@router.post("/quote")
async def quote(req: QuoteRequest):
    _require_session(require_kotak=False)
    # Quote payloads are token-specific, so the shared cache groups them by a
    # stable key derived from the requested tokens. This dedups the exact same
    # quote poll (common under frontend polling storms) without mixing tokens.
    key_part = "|".join(
        f'{t.get("instrument_token")}:{t.get("exchange_segment", "nse_cm")}'
        for t in (req.instrument_tokens or [])
    )
    cache_key = f"quote_{req.quote_type}_{key_part}"

    async def _fetch():
        return await kotak_session.async_quote(
            instrument_tokens=req.instrument_tokens,
            quote_type=req.quote_type,
            isIndex=req.isIndex,
        )

    ltp_result = await broker_cache.get(
        cache_key, _fetch,
        ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
        timeout=_BROKER_CACHE_TIMEOUT,
    )
    if ltp_result is None:
        # Broker silent (no Kotak session / after-hours outage / timeout): fall
        # back to the canonical LastPrice chain so the trade page and Dummy mode
        # still price the instrument from the last REAL print (broker snapshot →
        # stored candle close). Never fabricated — an empty quote stays empty.
        fallback = await _last_price_quote(req.instrument_tokens)
        if fallback is not None:
            return fallback
        raise HTTPException(504, "Quote request timed out or broker unavailable")
    # If ltp requested, also fetch ohlc (bounded) to enrich the response
    if req.quote_type == "ltp" and req.instrument_tokens:
        try:
            ohlc_result = await asyncio.wait_for(
                kotak_session.async_quote(
                    instrument_tokens=req.instrument_tokens,
                    quote_type="ohlc",
                    isIndex=req.isIndex,
                ),
                timeout=_BROKER_CACHE_TIMEOUT,
            )
            ltp_data = ltp_result.get("data", []) if isinstance(ltp_result, dict) else []
            ohlc_data = ohlc_result.get("data", []) if isinstance(ohlc_result, dict) else []
            ohlc_map = {str(item.get("exchange_token")): item for item in ohlc_data if isinstance(item, dict)}
            for item in ltp_data:
                if isinstance(item, dict):
                    tok = str(item.get("exchange_token"))
                    ohlc = ohlc_map.get(tok, {}).get("ohlc", {})
                    if ohlc:
                        item["ohlc"] = ohlc
        except Exception:
            pass
    return ltp_result


async def _last_price_quote(instrument_tokens: list[dict]) -> dict | None:
    """Broker-shaped quote from the canonical last-known-price chain.

    Returns ``None`` when nothing real is known for any requested token, so the
    caller keeps its honest 504 instead of inventing a price.
    """
    if not instrument_tokens:
        return None
    from services.instrument_cache import instrument_cache
    from services.last_price import resolve_prices

    refs = []
    for ref in instrument_tokens:
        token = str(ref.get("instrument_token") or "")
        inst = instrument_cache.lookup_by_token(token) if (token and instrument_cache.loaded) else None
        refs.append({
            "token": token,
            "symbol": (inst or {}).get("symbol") or (inst or {}).get("tradingSymbol") or "",
            "segment": ref.get("exchange_segment") or "nse_cm",
        })
    try:
        prices = await resolve_prices(refs, allow_broker=False)
    except Exception as exc:  # noqa: BLE001
        log.debug("last-price quote fallback failed: %s", exc)
        return None
    rows = []
    for ref, price in zip(refs, prices):
        if price.get("ltp") is None:
            continue
        rows.append({
            "exchange_token": ref["token"],
            "display_symbol": ref["symbol"] or ref["token"],
            "exchange": ref["segment"],
            "ltp": str(price["ltp"]),
            "ohlc": {
                "open": str(price.get("open") or ""),
                "high": str(price.get("high") or ""),
                "low": str(price.get("low") or ""),
                "close": str(price.get("prevClose") or ""),
            },
            "source": price.get("source"),
            "status": price.get("status"),
            "asOf": price.get("asOf"),
        })
    if not rows:
        return None
    return {"data": rows, "stat": "Ok", "source": "last_price_fallback"}

