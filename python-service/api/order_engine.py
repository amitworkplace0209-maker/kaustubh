"""Order Engine API — the single control surface for the Order Engine page.

``docs/engines/order-engine.md`` defines Order Engine as one controlled path for
every order: validate → risk → broker adapter → execution state → result
distribution. This router is the view of that engine for the UI, and it is
deliberately the only place the page places, modifies or cancels an order — so
the page cannot reach a broker (or the paper store) by any other route.

Three things it adds on top of the raw terminal endpoints:

* a **canonical order row** — every terminal's native order shape folded into one
  vocabulary, so a Kotak ``not_Ok`` and a paper ``TRIGGER_PENDING`` are
  comparable rows and not two different tables to read;
* the **state machine** the doc specifies, with counts derived from live orders
  rather than a hard-coded list;
* the **real-time data provenance** — whether a live price exists right now and
  where it came from, so the page can say "waiting for live market data" instead
  of implying the feed is healthy.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from brokers.manager import active_terminal, get_adapter
from brokers.models import BrokerError, safe_float
from core.engines import order_engine

logger = logging.getLogger("order_engine_api")

router = APIRouter(prefix="/api/order-engine", tags=["order-engine"])


# ---------------------------------------------------------------------------
# Canonical status model (docs/engines/order-engine.md §24)
# ---------------------------------------------------------------------------
#: Accepted by the broker, still working. NOT executed.
WORKING = ("PENDING", "OPEN", "TRIGGER_PENDING", "PARTIALLY_FILLED", "SUBMITTED", "NEW", "ACK")
#: Fully executed against the real market.
EXECUTED = ("COMPLETE", "COMPLETED", "FILLED", "EXECUTED", "TRADED")
#: Refused — locally, by risk, or by the broker itself.
REJECTED = ("REJECTED", "REJECT", "NOTOK", "FAILED", "EXPIRED")
#: Withdrawn on request.
CANCELLED = ("CANCELLED", "CANCELED")

_STATE_ORDER = WORKING + EXECUTED + REJECTED + CANCELLED


def canonical_status(raw: Any) -> str:
    """Fold any terminal's native status into the doc's state machine.

    Brokers disagree on wording for the same event (Kotak ``complete``,
    Shoonya ``COMPLETE``, paper ``TRIGGER_PENDING``), and a handful of the
    tokens they return contain spaces. Normalizing here is what lets one status
    column and one status filter work across every terminal.
    """
    text = str(raw or "").strip().upper().replace("_", " ").replace("-", " ")
    text = " ".join(text.split())
    if text in _STATE_ORDER:
        return text
    if text in ("NOT TRADED", "NOT OK", "NOTOK", "OPEN PENDING", "TRIGGERED", "NOT TRAED"):
        return "PENDING"
    if "PARTIAL" in text or "PARTFULL" in text:
        return "PARTIALLY_FILLED"
    if text in ("COMPLETE", "COMPLETED", "FILLED", "FULLY FILLED", "TRADED", "EXECUTED"):
        return "COMPLETE"
    if "CANCEL" in text:
        return "CANCELLED"
    if "REJECT" in text or text in ("FAIL", "FAILED", "ERROR", "EXPIRED", "NOTOK"):
        return "REJECTED"
    if "TRIGGER" in text:
        return "TRIGGER_PENDING"
    if not text:
        return "UNKNOWN"
    if "PEND" in text or "NEW" in text or "OPEN" in text or "ACK" in text or "QUEU" in text:
        return "PENDING"
    return "UNKNOWN"


def is_working(status: Any) -> bool:
    return canonical_status(status) in WORKING


def _pick(row: dict, *keys: str, default: Any = "") -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return default


def canonical_order(row: dict, terminal: str) -> dict:
    """One order row, whatever the terminal's native shape is."""
    qty = int(safe_float(_pick(row, "quantity", "qty", "Quantity", default=0)))
    filled = int(safe_float(_pick(row, "filledQuantity", "fldQty", "FilledQty", default=0)))
    avg = safe_float(_pick(row, "averageTradedPrice", "avgPrice", "AvgPrc", default=0))
    price = safe_float(_pick(row, "price", "prc", "Prc", default=0))
    raw_status = _pick(row, "status", "ordSt", "orderStatus", "order_status", "stat", default="")
    return {
        "orderId": str(_pick(row, "orderId", "nOrdNo", "n_ord_no", "orderid", "order_id", default="")),
        "symbol": str(_pick(row, "symbol", "tradingSymbol", "trdSym", "tradingsymbol", default="")).upper(),
        "token": str(_pick(row, "token", "instrumentToken", default="")),
        "terminal": terminal,
        "broker": _BROKER_LABEL.get(terminal, terminal),
        "isPaper": terminal == "dummy",
        "side": str(_pick(row, "transactionType", "trnsTp", "buyOrSell", "txnType", default="")).upper(),
        "product": str(_pick(row, "product", "prd", default="")),
        "orderType": str(_pick(row, "orderType", "ordType", default="")),
        "quantity": qty,
        "filledQuantity": filled,
        "pendingQuantity": max(qty - filled, 0),
        "price": price,
        "triggerPrice": safe_float(_pick(row, "triggerPrice", "trgPrice", default=0)),
        "averagePrice": avg,
        "orderValue": safe_float(_pick(row, "orderValue", default=price * qty)),
        "status": canonical_status(raw_status),
        "rawStatus": str(raw_status or ""),
        "working": is_working(raw_status),
        "executed": canonical_status(raw_status) == "COMPLETE",
        "reason": str(_pick(row, "errorMessage", "remarks", "reason", "message", default="") or ""),
        "waitingReason": str(row.get("waitingReason") or ""),
        "awaitingLtp": bool(row.get("awaitingLtp")),
        "source": str(_pick(row, "source", default="MANUAL")).upper(),
        "basketId": row.get("basketId") or row.get("basket_id"),
        "correlationId": row.get("correlationId") or row.get("correlation_id") or "",
        "charges": safe_float(_pick(row, "charges", "totalCharges", default=0)),
        "placedAt": str(_pick(row, "orderDate", "orderTime", "placedAt", "exchangeTime", default="")),
    }


_BROKER_LABEL = {"kotak": "KOTAK", "shoonya": "SHOONYA", "dummy": "DUMMY"}


# ---------------------------------------------------------------------------
# Feed provenance — never let the page imply data that is not arriving
# ---------------------------------------------------------------------------
async def _market_data_status() -> dict[str, Any]:
    try:
        from services import tick_buffer

        stats = tick_buffer.stats()
    except Exception as exc:  # noqa: BLE001
        logger.debug("order-engine tick stats unavailable: %s", exc)
        stats = {}
    tps = float(stats.get("ticksPerSecond", 0.0) or 0.0)
    receiving = tps > 0
    try:
        from services.paper_market_feed import paper_market_feed

        paper = paper_market_feed.status()
    except Exception as exc:  # noqa: BLE001
        logger.debug("paper feed status unavailable: %s", exc)
        paper = {"running": False}
    return {
        "liveFeedReceiving": receiving,
        "ticksPerSecond": tps,
        "latestTickCount": int(stats.get("latestTickCount", 0) or 0),
        "lastTickAt": stats.get("lastTickAt"),
        "feedState": stats.get("feedState") or "NO_FEED",
        "source": "services.tick_buffer (WS#1 real broker feed)",
        "paperFeed": paper,
        "message": (
            "Live market data flowing" if receiving
            else "No live market data — new orders stay working until a real price arrives"
        ),
    }


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------
class OrderRequest(BaseModel):
    exchange: str = "nse_cm"
    exchange_segment: str = "NSE_CM"
    token: str = ""
    symbol: str = ""
    trading_symbol: str = ""
    transaction_type: str = "BUY"
    product: str = "MIS"
    order_type: str = "MKT"
    quantity: str = "1"
    price: str = "0"
    trigger_price: str = "0"
    disclosed_quantity: str = "0"
    validity: str = "DAY"
    source: str = "MANUAL"
    basket_id: str | None = None
    correlation_id: str = ""
    #: Only ever a genuinely observed real price. The page sends the live LTP it
    #: already renders; the engine falls back to the backend's own tick buffer,
    #: and parks the order if neither has one. Nothing here is ever invented.
    expected_ltp: str = "0"


class OrderIdRequest(BaseModel):
    order_id: str
    reason: str = ""


class ModifyEngineRequest(BaseModel):
    order_id: str
    quantity: str = "0"
    price: str = "0"
    trigger_price: str = "0"
    order_type: str = "MKT"
    exchange: str = "nse_cm"
    transaction_type: str = "BUY"
    product: str = "MIS"
    validity: str = "DAY"
    disclosed_quantity: str = "0"
    token: str = ""
    symbol: str = ""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/state")
async def order_engine_state() -> dict[str, Any]:
    """Engine identity, active terminal/session, state machine + feed status."""
    terminal = active_terminal()
    try:
        adapter = get_adapter(terminal)
        connected = bool(adapter.is_logged_in)
        capabilities = adapter.capabilities
    except Exception as exc:  # noqa: BLE001
        logger.debug("order-engine adapter probe failed: %s", exc)
        adapter, connected, capabilities = None, False, {}

    return {
        "ok": True,
        "engine": "order_engine",
        "terminal": terminal,
        "broker": _BROKER_LABEL.get(terminal, terminal),
        "isPaper": terminal == "dummy",
        "connected": connected,
        "capabilities": capabilities,
        "states": {
            "working": list(WORKING),
            "executed": list(EXECUTED),
            "rejected": list(REJECTED),
            "cancelled": list(CANCELLED),
        },
        "marketData": await _market_data_status(),
    }


@router.get("/orders")
async def order_engine_orders(terminal: str = "") -> dict[str, Any]:
    """Canonical live order book for a terminal, plus state-machine counts."""
    mode = terminal if terminal in ("kotak", "shoonya", "dummy") else active_terminal()
    try:
        adapter = get_adapter(mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    connected = bool(adapter.is_logged_in)
    if not connected:
        return {
            "ok": True, "terminal": mode, "broker": _BROKER_LABEL.get(mode, mode),
            "isPaper": mode == "dummy", "connected": False, "orders": [], "counts": {},
            "total": 0, "message": f"{adapter.broker_name} not connected",
            "marketData": await _market_data_status(),
        }

    try:
        raw = await adapter.orders()
    except BrokerError as exc:
        return {
            "ok": True, "terminal": mode, "connected": False, "orders": [], "counts": {},
            "total": 0, "message": exc.message,
            "marketData": await _market_data_status(),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("order-engine order book failed: %s", exc)
        return {
            "ok": True, "terminal": mode, "connected": True, "orders": [], "counts": {},
            "total": 0, "message": f"order book unavailable: {exc}",
            "marketData": await _market_data_status(),
        }

    rows = _extract_rows(raw)
    orders = [canonical_order(r, mode) for r in rows]

    counts: dict[str, int] = {}
    for order in orders:
        counts[order["status"]] = counts.get(order["status"], 0) + 1
    counts["TOTAL"] = len(orders)
    counts["WORKING"] = sum(1 for o in orders if o["working"])

    return {
        "ok": True,
        "terminal": mode,
        "broker": _BROKER_LABEL.get(mode, mode),
        "isPaper": mode == "dummy",
        "connected": True,
        "orders": orders,
        "counts": counts,
        "total": len(orders),
        "marketData": await _market_data_status(),
    }


def _extract_rows(raw: Any) -> list[dict]:
    """Pull the order list out of whatever envelope the terminal returns."""
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    if not isinstance(raw, dict):
        return []
    for key in ("orderBook", "orders", "data", "tradeBook", "trade_book"):
        value = raw.get(key)
        if isinstance(value, list):
            return [r for r in value if isinstance(r, dict)]
        if isinstance(value, dict):
            nested = _extract_rows(value)
            if nested:
                return nested
    return []


@router.post("/place")
async def order_engine_place(body: OrderRequest) -> dict[str, Any]:
    """Place an order on the active terminal through the Order Engine.

    This is the page's only placement route. Risk → Audit → Adapter, and the
    response distinguishes ACCEPTED-WORKING from EXECUTED, because those are
    different facts and the doc requires the UI to tell them apart.
    """
    terminal = active_terminal()
    intent = body.model_dump()
    intent["terminal"] = terminal
    try:
        result = await order_engine.place(terminal, intent)
    except BrokerError as exc:
        raise HTTPException(502, exc.message) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    broker_result = result.get("data") if isinstance(result.get("data"), dict) else {}
    demo_order = broker_result.get("demoOrder") if isinstance(broker_result, dict) else None
    order_row = canonical_order(demo_order or {}, terminal) if isinstance(demo_order, dict) else None
    return {
        **result,
        "order": order_row,
        "status": result.get("status") or (order_row or {}).get("status") or "UNKNOWN",
        "marketData": await _market_data_status(),
    }


@router.post("/cancel")
async def order_engine_cancel(body: OrderIdRequest) -> dict[str, Any]:
    """Cancel an order on the active terminal through the Order Engine."""
    terminal = active_terminal()
    try:
        result = await order_engine.cancel(terminal, body.order_id)
    except BrokerError as exc:
        raise HTTPException(502, exc.message) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**result, "status": "CANCELLED" if result.get("ok") else "CANCEL_FAILED"}


@router.post("/modify")
async def order_engine_modify(body: ModifyEngineRequest) -> dict[str, Any]:
    """Modify a working order on the active terminal through the Order Engine.

    The engine's risk gate still runs, so a modification that would leave the
    order invalid (a stop without a trigger, a limit without a price) is refused
    before it reaches the terminal.
    """
    terminal = active_terminal()
    try:
        result = await order_engine.modify(terminal, body.order_id, body.model_dump())
    except BrokerError as exc:
        raise HTTPException(502, exc.message) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**result, "status": "MODIFIED" if result.get("ok") else "MODIFY_FAILED"}


@router.get("/history")
async def order_engine_history(terminal: str = "", limit: int = 200) -> dict[str, Any]:
    """Order history for a terminal, canonicalised to the same row shape."""
    mode = terminal if terminal in ("kotak", "shoonya", "dummy") else active_terminal()
    try:
        adapter = get_adapter(mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not adapter.is_logged_in:
        return {"ok": True, "terminal": mode, "connected": False, "orders": [],
                "message": f"{adapter.broker_name} not connected"}
    try:
        raw = await adapter.order_history()
    except Exception as exc:  # noqa: BLE001
        logger.warning("order-engine history failed: %s", exc)
        return {"ok": True, "terminal": mode, "connected": True, "orders": [], "message": str(exc)}
    rows = _extract_rows(raw)[: max(1, min(int(limit or 200), 1000))]
    return {
        "ok": True, "terminal": mode, "broker": _BROKER_LABEL.get(mode, mode),
        "isPaper": mode == "dummy", "connected": True,
        "orders": [canonical_order(r, mode) for r in rows],
    }


# ---------------------------------------------------------------------------
# Per-broker engine pages — one detail endpoint per broker engine
# ---------------------------------------------------------------------------
#: How an order physically reaches the broker, per terminal — factual code
#: paths (the page shows the actual wiring, not marketing copy).
_ENGINE_PATH = {
    "dummy": "/api/trade/demo/order or /api/order-engine/place → order_engine.place → DummyAdapter.place_order → paper engine (LTP-matched)",
    "kotak": "/api/terminal/order → order_engine.place → KotakAdapter.place_order → neo_api_client place_order → response back to the page",
    "shoonya": "/api/terminal/order → order_engine.place → ShoonyaAdapter.place_order → NorenRestApiPy place_order → response back to the page",
}
_SDK_INFO = {
    "kotak": {"sdk": "Kotak Neo (neo_api_client)", "module": "auth/kotak_client.py + brokers/kotak_adapter.py"},
    "shoonya": {"sdk": "Shoonya Noren (NorenRestApiPy)", "module": "brokers/shoonya_adapter.py"},
    "dummy": {"sdk": "Internal paper engine (api/demo.py — app_settings/demo_orders)", "module": "api/demo.py + brokers/dummy.py"},
}


def _count_by(rows: list[dict], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        k = str(r.get(key) or "?").upper() or "?"
        out[k] = out.get(k, 0) + 1
    return out


def _parse_ts(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


async def _paper_flow_block() -> dict[str, Any]:
    """REAL paper-engine verification, computed from the stored order book.

    Every dummy surface (terminal trade page → ``/api/trade/demo/order``,
    order page → ``/api/order-engine/place``, suggestions, baskets) writes the
    SAME ``app_settings/demo_orders`` document through the Order Engine — these
    counts prove the flow with real rows, per source, per status.
    """
    from api import demo as paper

    orders = [o for o in await paper.get_dummy_orders() if isinstance(o, dict)]
    now = datetime.now(timezone.utc)
    window = now - timedelta(hours=24)
    placed24 = filled24 = resting_now = 0
    fill_sources: dict[str, int] = {}
    last_fill: dict | None = None
    last_resting: dict | None = None
    EXEC_SET = {"COMPLETE", "COMPLETED", "FILLED", "EXECUTED", "TRADED"}
    REST_SET = {"PENDING", "OPEN", "TRIGGER_PENDING", "PARTIALLY_FILLED", "SUBMITTED"}
    for o in orders:
        status = str(o.get("status") or "UNKNOWN").upper()
        placed_t = _parse_ts(o.get("orderDate")) or _parse_ts(o.get("placedAt"))
        if placed_t and placed_t >= window:
            placed24 += 1
        if status in EXEC_SET:
            fs = str(o.get("fillSource") or "unknown").lower()
            fill_sources[fs] = fill_sources.get(fs, 0) + 1
            t = _parse_ts(o.get("filledAt"))
            if t and t >= window:
                filled24 += 1
            if last_fill is None or (_parse_ts(last_fill.get("filledAt")) or datetime.min.replace(tzinfo=timezone.utc)) < (t or datetime.min.replace(tzinfo=timezone.utc)):
                last_fill = o
        elif status in REST_SET:
            resting_now += 1
            if last_resting is None:
                last_resting = o
    try:
        account = await paper.get_dummy_account()
    except Exception as exc:  # noqa: BLE001
        account = {"error": str(exc)[:200]}
    try:
        from services import dummy_extras

        prefs = await dummy_extras.get_prefs()
    except Exception as exc:  # noqa: BLE001
        prefs = {"error": str(exc)[:200]}
    try:
        from services.paper_market_feed import paper_market_feed

        feed = paper_market_feed.status()
    except Exception as exc:  # noqa: BLE001
        feed = {"running": False, "error": str(exc)[:200]}
    return {
        "store": "app_settings/demo_orders (single authoritative paper order book)",
        "producers": _count_by(orders, "source"),
        "byStatus": _count_by(orders, "status"),
        "totalDistinct": len(orders),
        "placedLast24h": placed24,
        "filledLast24h": filled24,
        "restingNow": resting_now,
        "fillSources": fill_sources,
        "lastFill": last_fill,
        "lastResting": last_resting,
        "account": account,
        "prefs": prefs,
        "feed": feed,
    }


@router.get("/engine/{terminal}")
async def order_engine_terminal_detail(terminal: str, summary: bool = False) -> dict[str, Any]:
    """One broker engine's full page data — Dummy, Kotak or Shoonya, separated.

    * dummy   → the PAPER engine: connected state, LTP fill model (exact
                counts of what filled vs what is resting and WHY), the
                producers that fed the engine (trade page / order page /
                suggestions / baskets), paper feed + account.
    * kotak   → real session + the Kotak WS#2 order feed that keeps order
                status updating in real time, plus the live order book.
    * shoonya → real session + OAuth availability, plus the live order book.

    Everything here is read-only and comes from the live adapters — a
    disconnected broker reports exactly what is unavailable instead of
    silently returning zeros.
    """
    mode = terminal if terminal in ("kotak", "shoonya", "dummy") else ""
    if not mode:
        raise HTTPException(400, "terminal must be kotak, shoonya or dummy")
    try:
        adapter = get_adapter(mode)
        connected = bool(adapter.is_logged_in)
        capabilities = adapter.capabilities
        broker_name = adapter.broker_name
    except Exception as exc:  # noqa: BLE001
        logger.debug("terminal detail adapter probe failed (%s): %s", mode, exc)
        adapter, connected, capabilities, broker_name = None, False, {}, mode

    detail: dict[str, Any] = {
        "ok": True,
        "terminal": mode,
        "broker": _BROKER_LABEL.get(mode, mode),
        "brokerName": broker_name or _BROKER_LABEL.get(mode, mode),
        "isPaper": mode == "dummy",
        "engineKind": "paper" if mode == "dummy" else "sdk",
        "enginePath": _ENGINE_PATH.get(mode, ""),
        "sdk": _SDK_INFO.get(mode, {}),
        "connected": connected,
        "capabilities": capabilities or {},
        "marketData": await _market_data_status(),
        "orders": [],
        "counts": {},
        "total": 0,
        "message": "" if connected else f"{broker_name or mode} not connected — order book unavailable",
    }

    if adapter is not None and connected:
        try:
            raw = await adapter.orders()
            rows = _extract_rows(raw)
            canonical = [canonical_order(r, mode) for r in rows]
            detail["total"] = len(canonical)
            counts: dict[str, int] = {}
            for o in canonical:
                counts[o["status"]] = counts.get(o["status"], 0) + 1
            counts["TOTAL"] = len(canonical)
            counts["WORKING"] = sum(1 for o in canonical if o["working"])
            detail["counts"] = counts
            if summary:
                canonical.sort(key=lambda o: str(o.get("placedAt") or ""), reverse=True)
                detail["orders"] = canonical[:12]
            else:
                detail["orders"] = canonical
        except Exception as exc:  # noqa: BLE001
            detail["message"] = f"order book unavailable: {exc}"[:300]

    if mode == "dummy":
        try:
            detail["paper"] = await _paper_flow_block()
        except Exception as exc:  # noqa: BLE001
            detail["paper"] = {"error": str(exc)[:300]}
    elif mode == "kotak":
        try:
            from ws_socket.order_feed_manager import order_feed_manager

            detail["orderFeed"] = order_feed_manager.status()
        except Exception as exc:  # noqa: BLE001
            detail["orderFeed"] = {"error": str(exc)[:300]}
    elif mode == "shoonya":
        try:
            oauth_url = get_adapter("shoonya").oauth_url()
            detail["oauth"] = {"available": bool(oauth_url), "url": oauth_url or None}
        except Exception as exc:  # noqa: BLE001
            detail["oauth"] = {"available": False, "error": str(exc)[:300]}
    return detail


# ---------------------------------------------------------------------------
# Settings — one aggregated page surface for the Order Engine service
# ---------------------------------------------------------------------------
@router.get("/settings")
async def order_engine_settings() -> dict[str, Any]:
    """Paper-engine prefs + engine runtime + mode-lock — read-only aggregate.

    Sources: ``services.dummy_extras`` (paper simulation prefs), the Order
    Engine facade status (registry metrics: broker / logged-in / managed), and
    ``services.mode_lock`` (terminal switching gate). Nothing is fabricated;
    a missing service degrades its own block with an error string.
    """
    from services import dummy_extras

    try:
        prefs = await dummy_extras.get_prefs()
    except Exception as exc:  # noqa: BLE001
        prefs = {"error": str(exc)[:200]}
    try:
        from services.mode_lock import mode_lock_status

        lock = await mode_lock_status()
    except Exception as exc:  # noqa: BLE001
        lock = {"error": str(exc)[:200]}
    runtime: dict[str, Any] = {}
    try:
        from services.legacy_engine_facades import order_facade

        runtime = order_facade.status_snapshot()
    except Exception as exc:  # noqa: BLE001
        runtime = {"error": str(exc)[:200]}
    try:
        from api import demo as paper

        model = {
            "mktSlippage": paper.MKT_SLIPPAGE,
            "lmtTolerance": paper.LMT_TOLERANCE,
            "charges": paper.CHARGE_RATES,
        }
    except Exception as exc:  # noqa: BLE001
        model = {"error": str(exc)[:200]}
    from services.json_safe import sanitize_for_json

    return {
        "ok": True,
        "prefs": sanitize_for_json(prefs),
        "modeLock": sanitize_for_json(lock),
        "engineRuntime": sanitize_for_json(runtime),
        "paperModel": model,
    }


class EngineSettingsUpdate(BaseModel):
    prefs: dict[str, Any] = {}


@router.post("/settings")
async def order_engine_settings_update(body: EngineSettingsUpdate) -> dict[str, Any]:
    """Apply paper-engine prefs. Unknown keys are dropped by the service."""
    from services import dummy_extras

    try:
        updated = await dummy_extras.update_prefs(body.prefs)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"prefs update failed: {exc}") from exc
    from services.json_safe import sanitize_for_json

    return {"ok": bool(updated), "prefs": sanitize_for_json(updated)}