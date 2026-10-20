"""Dummy Trading Terminal resources — terminal-scoped state for the Dummy UI.

Everything here is persisted under the ``app_settings`` document store with
the ``dummy_*`` key prefix and is owned by the Dummy terminal ONLY (never read
from / written to any real broker). It supplements the authoritative paper
engine in ``api/demo.py`` (orders / positions / balance) with the Dummy
terminal's own surface:

  * basket templates + execution audit (policy / expiry),
  * price alerts (dedup by cooldown),
  * target positions (PERCENT / FIXED / AMOUNT, idempotent auto-execute),
  * daily-history equity snapshots partitioned by IST trading date,
  * terminal-scoped notifications,
  * risk / holdings / portfolio aggregations and market-session reads.

Execution, fills, margin and the funds ledger remain exclusively in
``api/demo.py``; this module never mutates order/position/account state except
through the demo engine functions it reuses for target auto square-off.
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Optional

from database.connection import get_db

logger = logging.getLogger("app")

from core.timezones import IST
#: The Dummy day partition — 12:00 AM IST (midnight), same boundary as the
#: daily session lifecycle: a new IST calendar date is a new trading date.
IST_CUTOFF = dtime(0, 0)
RETENTION_DAYS = 7
MAX_NOTIFICATIONS = 200

KEY_BASKETS = "dummy_baskets"
KEY_ALERTS = "dummy_alerts"
KEY_TARGETS = "dummy_targets"
KEY_HISTORY = "dummy_daily_history"
KEY_NOTIFICATIONS = "dummy_notifications"
KEY_PREFS = "dummy_prefs"
KEY_WATCHLISTS = "dummy_watchlists"
KEY_CLOSED_POSITIONS = "dummy_closed_positions"
KEY_CALENDAR_EVENTS = "dummy_calendar_events"
KEY_AUDIT = "dummy_audit_events"

MAX_CLOSED_POSITIONS = 500
MAX_AUDIT_EVENTS = 500

DEFAULT_PREFS = {
    "autoRefreshMs": 3000,
    "defaultProduct": "MIS",
    "defaultOrderType": "MKT",
    "defaultBasketPolicy": "ALL",
    "confirmBasketExecute": True,
    "alertCooldownSec": 60,
    "autoSquareOffOnTarget": True,
    "retentionDays": RETENTION_DAYS,
    # Daily-session starting capital (the configured virtual balance that a
    # fresh IST calendar day opens with at 12:00 AM IST).
    "startingCapital": 100000,
    # Simulation model (all effective defaults identical to the engine's real
    # behaviour: 10 bps slippage, no order caps, no external delivery).
    "slippageBps": 10,
    "maxDailyOrders": 0,
    "maxOrderValue": 0,
    # Notification delivery policy (in-app always stored; popup/sound/push are
    # capability-gated frontend behaviours; nothing here fabricates events).
    "notificationDelivery": {"inApp": True, "popup": False, "sound": False, "push": False},
}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _now_ist() -> datetime:
    return datetime.now(IST)


def _ist_offset(dt: datetime) -> datetime:
    return dt.astimezone(IST) if dt.tzinfo else dt.replace(tzinfo=IST)


def trading_date(value: datetime) -> str:
    """IST calendar-date partition: the Dummy day flips at 12:00 AM IST
    (midnight) — every event belongs to its own IST calendar date."""
    ist = _ist_offset(value)
    return ist.date().isoformat()


def _session_aware_trading_date() -> str:
    """The Dummy session trading date (12:00 AM IST flip — the lifecycle owner).

    Used for day-scoped surfaces (notifications, "today" filters) so they
    always align with ``services.dummy_session``. Falls back to the IST
    calendar-date partition when the lifecycle module is unavailable."""
    try:
        from services.dummy_session import session_date_for
        return session_date_for(_now_utc())
    except Exception:
        return trading_date(_now_utc())


def _millis() -> int:
    return int(time.time() * 1000)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{time.time() * 1000:.0f}_{uuid.uuid4().hex[:6]}"


async def _get_doc(key: str, default: Any) -> Any:
    db = get_db()
    doc = await db.app_settings.find_one({"key": key})
    if doc and doc.get("value") is not None:
        return doc["value"]
    return default


async def _set_doc(key: str, value: Any) -> None:
    db = get_db()
    await db.app_settings.update_one(
        {"key": key},
        {"$set": {"key": key, "value": value, "category": "dummy", "description": key, "updatedAt": _now_utc()}},
        upsert=True,
    )


# --------------------------------------------------------------------------- #
# Notifications (terminal-scoped)
# --------------------------------------------------------------------------- #
async def get_dummy_notifications() -> list:
    return await _get_doc(KEY_NOTIFICATIONS, [])


async def _save_notifications(items: list) -> None:
    await _set_doc(KEY_NOTIFICATIONS, items[:MAX_NOTIFICATIONS])


_PUSH_KIND_BY_CATEGORY = {
    "ORDER": "order_executed",
    "BASKET": "order_executed",
    "TARGET": "target",
    "ALERT": "price_alert",
    "SUGGESTION": "ai_suggestion",
}


async def notify(category: str, title: str, message: str, meta: Optional[dict] = None,
                 push: bool = True) -> dict:
    items = await get_dummy_notifications()
    today = _session_aware_trading_date()
    entry = {
        "id": _new_id("NTF"),
        "category": category,
        "title": title,
        "message": message,
        "meta": dict(meta) if meta else {},
        "read": False,
        "ts": _now_utc().isoformat(),
        "tradingDate": today,
    }
    items.insert(0, entry)
    await _save_notifications(items[:MAX_NOTIFICATIONS])
    # PWA fan-out (best-effort; skipped unless devices subscribed). Callers
    # that already pushed through notification_service pass push=False so one
    # event never buzzes twice.
    if push:
        try:
            from services import push_delivery as _push

            m = entry["meta"]
            try:
                price = float(m.get("price")) if m.get("price") not in (None, "") else None
            except (TypeError, ValueError):
                price = None
            await _push.fanout_push(_push.build_push_payload(
                title, message,
                kind=_PUSH_KIND_BY_CATEGORY.get(str(category).upper(), "order_executed"),
                symbol=str(m.get("symbol") or ""),
                side=str(m.get("side") or m.get("transactionType") or ""),
                price=price,
                order_id=str(m.get("order_id") or m.get("orderId") or ""),
            ))
        except Exception:
            pass
    return entry


async def list_notifications(category: str = "", limit: int = 100) -> dict:
    """List today's Dummy notifications.

    Counters (unread / total) are ALWAYS restricted to the current IST trading
    date so yesterday's records can never leak into today's badge. Older
    history remains in the store (permanent notification history) but is not
    reported as today's state.
    """
    items = await get_dummy_notifications()
    today = _session_aware_trading_date()
    current = [i for i in items if i.get("tradingDate") == today]
    if not current:
        current = [i for i in items if not i.get("tradingDate")]  # legacy fallback
    if category and category != "ALL":
        current = [i for i in current if i.get("category") == category]
    unread = sum(1 for i in current if not i.get("read"))
    return {"data": current[: min(max(int(limit), 1), 200)], "unread": unread, "total": len(current),
            "tradingDate": today}


async def mark_notification_read(nid: str) -> bool:
    items = await get_dummy_notifications()
    for i in items:
        if i.get("id") == nid:
            i["read"] = True
            await _save_notifications(items)
            return True
    return False


async def mark_all_notifications_read() -> int:
    items = await get_dummy_notifications()
    touched = 0
    for i in items:
        if not i.get("read"):
            i["read"] = True
            touched += 1
    if touched:
        await _save_notifications(items)
    return touched


async def delete_notification(nid: str) -> bool:
    items = await get_dummy_notifications()
    removed = [i for i in items if i.get("id") != nid]
    if len(removed) == len(items):
        return False
    await _save_notifications(removed)
    return True


async def clear_notifications() -> int:
    items = await get_dummy_notifications()
    count = len(items)
    await _save_notifications([])
    return count


# --------------------------------------------------------------------------- #
# Basket templates + execution audit
# --------------------------------------------------------------------------- #
async def get_baskets() -> list:
    return await _get_doc(KEY_BASKETS, [])


def _validate_basket(name: str, legs: list, policy: Any) -> None:
    if not name or not str(name).strip():
        raise ValueError("basket name is required")
    if not isinstance(legs, list) or not legs:
        raise ValueError("basket must contain at least one leg")
    if len(legs) > 20:
        raise ValueError("basket supports at most 20 legs")
    for idx, leg in enumerate(legs):
        if not str(leg.get("symbol") or "").strip():
            raise ValueError(f"leg {idx + 1}: symbol is required")
        try:
            qty = int(leg.get("quantity", 0))
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            raise ValueError(f"leg {idx + 1} ({leg.get('symbol')}): quantity must be positive")
        txn = str(leg.get("transactionType") or "").upper()
        if txn not in ("BUY", "SELL"):
            raise ValueError(f"leg {idx + 1} ({leg.get('symbol')}): transactionType must be BUY|SELL")
    mode = str((policy or {}).get("mode") or "ALL").upper()
    if mode not in ("ALL", "MIN", "EXACT"):
        raise ValueError("policy.mode must be ALL | MIN | EXACT")
    if mode != "ALL":
        try:
            minimum = int((policy or {}).get("minimum", 0) or 0)
        except (TypeError, ValueError):
            minimum = 0
        if not (1 <= minimum <= len(legs)):
            raise ValueError("policy.minimum must be between 1 and the number of legs")


async def create_basket(name: str, legs: list, policy: dict | None = None,
                        expirySeconds: int = 0, instructions: str = "") -> dict:
    _validate_basket(name, legs, policy)
    baskets = await get_baskets()
    basket = {
        "id": _new_id("BSK"),
        "name": str(name).strip(),
        "legs": legs,
        "policy": {
            "mode": str((policy or {}).get("mode") or "ALL").upper(),
            "minimum": int((policy or {}).get("minimum", 0) or 0),
        },
        "expirySeconds": int(expirySeconds or 0),
        "instructions": str(instructions or ""),
        "createdAt": _now_utc().isoformat(),
        "audit": [],
    }
    baskets.insert(0, basket)
    baskets = baskets[:100]
    await _set_doc(KEY_BASKETS, baskets)
    return basket


async def get_basket(basket_id: str) -> Optional[dict]:
    baskets = await get_baskets()
    return next((b for b in baskets if b.get("id") == basket_id), None)


def _basket_expired(basket: dict, now: datetime) -> bool:
    expiry = int(basket.get("expirySeconds") or 0)
    if expiry <= 0:
        return False
    try:
        created = datetime.fromisoformat(basket.get("createdAt"))
    except (TypeError, ValueError):
        return False
    return (now - created).total_seconds() > expiry


async def delete_basket(basket_id: str) -> bool:
    baskets = await get_baskets()
    removed = [b for b in baskets if b.get("id") != basket_id]
    if len(removed) == len(baskets):
        return False
    await _set_doc(KEY_BASKETS, removed)
    return True


async def execute_basket(basket_id: str, ltp_map: Optional[dict] = None) -> dict:
    """Execute every leg through the demo engine; record per-leg results and a
    basket-level audit summary. ``ltp_map`` supplies real LTP for symbols with
    no pushed price (never fabricated — absent prices reject the leg)."""
    from api.demo import execute_dummy_order, remember_ltp

    basket = await get_basket(basket_id)
    if basket is None:
        raise KeyError(f"basket {basket_id} not found")
    if _basket_expired(basket, _now_utc()):
        raise ValueError(
            f"basket '{basket['name']}' has expired (created "
            f"{basket.get('createdAt')}, expiry {int(basket.get('expirySeconds') or 0)}s)")

    results = []
    for leg in basket.get("legs", []):
        symbol = str(leg.get("symbol") or "").strip().upper()
        ltp = float((ltp_map or {}).get(symbol, 0) or 0)
        if ltp > 0:
            remember_ltp(symbol, ltp)
        try:
            res = await execute_dummy_order(
                symbol=symbol,
                tradingSymbol=leg.get("tradingSymbol") or leg.get("symbol"),
                exchange=leg.get("exchange") or "nse_cm",
                exchangeSegment=leg.get("exchangeSegment") or "NSE_CM",
                token=leg.get("token") or "",
                transactionType=str(leg.get("transactionType") or "BUY"),
                product=leg.get("product") or "MIS",
                orderType=str(leg.get("orderType") or "MKT"),
                quantity=int(leg.get("quantity") or 0),
                price=float(leg.get("price") or 0),
                triggerPrice=float(leg.get("triggerPrice") or 0),
                ltp=ltp,
                source="BASKET",
            )
        except Exception as exc:
            results.append({"symbol": symbol, "ok": False, "message": str(exc)})
            continue
        order = res.get("demoOrder") or {}
        results.append({
            "symbol": symbol,
            "ok": res.get("stat") == "Ok",
            "message": order.get("errorMessage") or None,
            "orderId": order.get("orderId"),
            "status": order.get("status"),
            "transactionType": order.get("transactionType"),
            "quantity": order.get("quantity"),
        })

    filled = [r for r in results if r.get("ok")]
    policy = basket.get("policy") or {}
    mode = str(policy.get("mode") or "ALL").upper()
    minimum = int(policy.get("minimum") or 0)
    failed = sum(1 for r in results if not r.get("ok"))
    ok = filled and (mode == "ALL" or len(filled) >= minimum or mode == "MIN" and len(filled) >= minimum or mode == "EXACT" and len(filled) == len(results))
    if mode == "ALL" and failed:
        ok = False
    summary = {
        "at": _now_utc().isoformat(),
        "totalLegs": len(results),
        "filled": len(filled),
        "failed": failed,
        "ok": bool(ok),
        "policyMode": mode,
        "policyMinimum": minimum,
        "legResults": results,
    }
    baskets = await get_baskets()
    for b in baskets:
        if b.get("id") == basket_id:
            b.setdefault("audit", []).insert(0, summary)
            b["audit"] = b["audit"][:50]
    await _set_doc(KEY_BASKETS, baskets)
    await notify(
        "basket",
        "Basket executed",
        f"{basket['name']}: {len(filled)}/{len(results)} legs filled",
        {"basketId": basket_id, "filled": len(filled), "total": len(results)},
    )
    return {"ok": bool(ok), "basket": {**basket, "audit": basket.get("audit", [])}, "summary": summary}


async def execute_inline_basket(legs: list, policy: dict | None = None,
                                ltp_map: Optional[dict] = None) -> dict:
    _validate_basket("inline", legs, policy)
    basket = await create_basket("Inline basket", legs, policy, expirySeconds=0)
    try:
        result = await execute_basket(basket["id"], ltp_map)
        return {**result, "inline": True}
    finally:
        await delete_basket(basket["id"])


# --------------------------------------------------------------------------- #
# Price alerts (dedup by cooldown)
# --------------------------------------------------------------------------- #
async def get_alerts() -> list:
    return await _get_doc(KEY_ALERTS, [])


async def create_alert(symbol: str, condition: str, price: float,
                       cooldownSec: int = 0, note: str = "") -> dict:
    symbol = str(symbol or "").strip().upper()
    condition = str(condition or "").upper()
    if not symbol:
        raise ValueError("symbol is required")
    if condition not in ("ABOVE", "BELOW"):
        raise ValueError("condition must be ABOVE | BELOW")
    price = float(price)
    if price <= 0:
        raise ValueError("alert price must be positive")
    cooldown = int(cooldownSec or 0)
    if cooldown < 0:
        raise ValueError("cooldownSec cannot be negative")
    alerts = await get_alerts()
    alert = {
        "id": _new_id("ALR"),
        "symbol": symbol,
        "condition": condition,
        "price": round(price, 2),
        "cooldownSec": cooldown,
        "status": "ACTIVE",
        "note": str(note or ""),
        "lastTriggeredAt": None,
        "scope": "DAILY",
        "sessionDate": _session_aware_trading_date(),
        "createdAt": _now_utc().isoformat(),
    }
    alerts.insert(0, alert)
    alerts = alerts[:100]
    await _set_doc(KEY_ALERTS, alerts)
    return alert


async def delete_alert(alert_id: str) -> bool:
    alerts = await get_alerts()
    removed = [a for a in alerts if a.get("id") != alert_id]
    if len(removed) == len(alerts):
        return False
    await _set_doc(KEY_ALERTS, removed)
    return True


def _alert_hit(alert: dict, ltp: float) -> bool:
    condition = str(alert.get("condition") or "").upper()
    price = float(alert.get("price") or 0)
    if condition == "ABOVE":
        return ltp >= price
    if condition == "BELOW":
        return ltp <= price
    return False


async def evaluate_dummy_alerts(ltp_map: dict[str, float]) -> list[dict]:
    """Evaluate active alerts against the pushed real LTP.

    DAILY-scoped one-time alerts fire ONCE per trading date (status becomes
    TRIGGERED and they are never re-armed within the day). CONTINUOUS alerts
    persist and honour the per-alert cooldown (dedup). Never stale."""
    alerts = await get_alerts()
    now = _now_utc()
    today = _session_aware_trading_date()
    created: list[dict] = []
    changed = False
    for alert in alerts:
        if alert.get("status") != "ACTIVE":
            continue
        # A DAILY one-time alert created on a previous session is invalid on
        # the new day (never re-arm stale one-time alerts).
        if alert.get("scope") == "DAILY" and alert.get("sessionDate") != today:
            alert["status"] = "EXPIRED"
            changed = True
            continue
        symbol = str(alert.get("symbol") or "").upper()
        ltp = float(ltp_map.get(symbol, 0) or 0)
        if ltp <= 0:
            continue
        if _alert_hit(alert, ltp):
            last = alert.get("lastTriggeredAt")
            cooldown = int(alert.get("cooldownSec") or 0)
            if last:
                try:
                    since = (now - datetime.fromisoformat(last)).total_seconds()
                except (TypeError, ValueError):
                    since = cooldown + 1
                if since < cooldown:
                    continue
            alert["lastTriggeredAt"] = now.isoformat()
            changed = True
            await notify(
                "alert",
                "Price alert triggered",
                f"{symbol} crossed {alert['condition']} {alert['price']:.2f} (LTP {ltp:.2f})",
                {"symbol": symbol, "ltp": ltp, "alertId": alert["id"]},
            )
            entry = {**alert, "ltpAtTrigger": round(ltp, 2)}
            created.append(entry)
            if alert.get("scope") == "DAILY":
                alert["status"] = "TRIGGERED"
                alert["triggeredAt"] = now.isoformat()
                alert["triggeredDate"] = today
    if changed:
        await _set_doc(KEY_ALERTS, alerts)
    return created


# --------------------------------------------------------------------------- #
# Target positions (idempotent auto square-off)
# --------------------------------------------------------------------------- #
async def get_targets() -> list:
    return await _get_doc(KEY_TARGETS, [])


async def set_target(symbol: str, targetType: str, value: float,
                     direction: str = "PROFIT", autoExecute: bool = True) -> dict:
    symbol = str(symbol or "").strip().upper()
    target_type = str(targetType or "").upper()
    if not symbol:
        raise ValueError("symbol is required")
    if target_type not in ("PERCENT", "FIXED", "AMOUNT"):
        raise ValueError("targetType must be PERCENT | FIXED | AMOUNT")
    value = float(value)
    if value <= 0:
        raise ValueError("target value must be positive")
    direction = str(direction or "PROFIT").upper()
    if direction not in ("PROFIT", "LOSS"):
        raise ValueError("direction must be PROFIT | LOSS")
    targets = await get_targets()
    targets = [t for t in targets if not (t.get("symbol") == symbol and t.get("direction") == direction)]
    target = {
        "id": _new_id("TGT"),
        "symbol": symbol,
        "targetType": target_type,
        "value": round(value, 4),
        "direction": direction,
        "autoExecute": bool(autoExecute),
        "status": "PENDING",
        "triggeredAt": None,
        "executedAt": None,
        "refPrice": None,
        "sessionDate": _session_aware_trading_date(),
        "createdAt": _now_utc().isoformat(),
    }
    targets.insert(0, target)
    targets = targets[:100]
    await _set_doc(KEY_TARGETS, targets)
    return target


async def delete_target(target_id: str) -> bool:
    targets = await get_targets()
    removed = [t for t in targets if t.get("id") != target_id]
    if len(removed) == len(targets):
        return False
    await _set_doc(KEY_TARGETS, removed)
    return True


async def expire_stale_daily_items(previous_date: str) -> dict:
    """Session rollover transition for one-time daily configuration.

    DAILY-scope one-time price alerts created on a previous trading date are
    EXPIRED (never re-armed on the new day). Pending targets created on a
    previous date without an open position are also EXPIRED. Permanently
    configured (CONTINUOUS) alerts and already-executed records are preserved.
    """
    today = _session_aware_trading_date()
    changed = False

    alerts = await get_alerts()
    for alert in alerts:
        if alert.get("status") != "ACTIVE":
            continue
        if alert.get("scope") == "DAILY" and alert.get("sessionDate") == previous_date:
            alert["status"] = "EXPIRED"
            alert["expiredAt"] = _now_utc().isoformat()
            changed = True
    if changed:
        await _set_doc(KEY_ALERTS, alerts)

    targets = await get_targets()
    target_changed = False
    for target in targets:
        if target.get("status") == "PENDING" and target.get("sessionDate") == previous_date:
            target["status"] = "EXPIRED"
            target["expiredAt"] = _now_utc().isoformat()
            target_changed = True
    if target_changed:
        await _set_doc(KEY_TARGETS, targets)

    return {"alertsExpired": sum(1 for a in alerts if a.get("status") == "EXPIRED" and a.get("expiredAt")),
            "targetsExpired": sum(1 for t in targets if t.get("status") == "EXPIRED" and t.get("expiredAt")),
            "previousDate": previous_date, "today": today}


def _target_ref_price(target: dict, position: dict) -> float:
    ttype = str(target.get("targetType") or "").upper()
    value = float(target.get("value") or 0)
    direction = str(target.get("direction") or "PROFIT").upper()
    net = int(position.get("netQuantity") or 0)
    qty = abs(net)
    is_long = net > 0
    base = float(position.get("averageBuyPrice") if is_long else position.get("averageSellPrice") or 0)
    if base <= 0 or qty <= 0:
        return 0.0
    sign = 1 if is_long else -1
    if ttype == "PERCENT":
        move = abs(base) * value / 100.0
        return round(base + sign * move, 2)
    if ttype == "FIXED":
        return round(base + sign * value, 2)
    return round(base + sign * value / qty, 2)  # AMOUNT


def _target_crossed(ref: float, ltp: float, target: dict) -> bool:
    direction = str(target.get("direction") or "PROFIT").upper()
    is_profit = direction == "PROFIT"
    net = int((target.get("positionSide") or "LONG"))  # set by caller
    return (net > 0 and ((is_profit and ltp >= ref) or (not is_profit and ltp <= ref))) or (
        net < 0 and ((is_profit and ltp <= ref) or (not is_profit and ltp >= ref)))


async def evaluate_dummy_targets(ltp_map: dict[str, float], positions: list) -> list[dict]:
    """Auto-execute pending targets when the pushed LTP crosses the ref price.
    Guarded by the PENDING status so a target executes at most once. Returns
    the executed targets."""
    from api.demo import squareoff_dummy_position

    targets = await get_targets()
    if not targets:
        return []
    by_symbol: dict[str, dict] = {}
    for p in positions:
        by_symbol.setdefault(str(p.get("symbol") or "").upper(), p)
    executed: list[dict] = []
    changed = False
    for target in targets:
        if target.get("status") != "PENDING":
            continue
        symbol = str(target.get("symbol") or "").upper()
        position = by_symbol.get(symbol)
        if position is None:
            continue
        net = int(position.get("netQuantity") or 0)
        if net == 0:
            continue
        target["positionSide"] = net
        ref = _target_ref_price(target, position)
        ltp = float(ltp_map.get(symbol, 0) or 0)
        if ref <= 0 or ltp <= 0:
            continue
        if not _target_crossed(ref, ltp, target):
            continue
        target["status"] = "TRIGGERED"
        target["triggeredAt"] = _now_utc().isoformat()
        target["refPrice"] = ref
        changed = True
        if bool(target.get("autoExecute")):
            try:
                sq = await squareoff_dummy_position(symbol, str(position.get("product") or "MIS"), source="TARGET")
                order = sq.get("demoOrder") or {}
                target["status"] = "EXECUTED"
                target["executedAt"] = _now_utc().isoformat()
                target["orderId"] = order.get("orderId")
            except Exception as exc:
                target["status"] = "TRIGGERED"
                target["executeError"] = str(exc)
        await notify(
            "target",
            "Target reached",
            f"{symbol} hit {target['targetType']} target ({target['direction']}) — LTP {ltp:.2f}, ref {ref:.2f}",
            {"symbol": symbol, "ltp": ltp, "ref": ref, "targetId": target["id"], "status": target["status"]},
        )
        executed.append({**target})
    if changed:
        await _set_doc(KEY_TARGETS, targets)
    return executed


# --------------------------------------------------------------------------- #
# Daily history (IST trading-date partition) + retention + portfolio
# --------------------------------------------------------------------------- #
async def _load_history() -> list:
    return await _get_doc(KEY_HISTORY, [])


async def _save_history(items: list) -> None:
    items = items[:400]
    await _set_doc(KEY_HISTORY, items)


async def ensure_today_snapshot() -> dict:
    from api.demo import get_dummy_account, get_dummy_orders

    account = await get_dummy_account()
    orders = await get_dummy_orders()
    today = _session_aware_trading_date()
    snapshot = {
        "date": today,
        "balance": round(float(account.get("balance") or 0), 2),
        "usedMargin": round(float(account.get("usedMargin") or 0), 2),
        "realizedPnl": round(float(account.get("realizedPnl") or 0), 2),
        "unrealizedPnl": round(float(account.get("unrealizedPnl") or 0), 2),
        "totalPnl": round(float(account.get("totalPnl") or 0), 2),
        "totalCharges": round(float(account.get("totalCharges") or 0), 2),
        "orders": int(account.get("dailyOrders") or 0),
        "updatedAt": _now_utc().isoformat(),
    }
    history = await _load_history()
    for i, h in enumerate(history):
        if h.get("date") == today:
            history[i] = snapshot
            break
    else:
        history.insert(0, snapshot)
    await _save_history(history)
    return snapshot


async def portfolio_summary() -> dict:
    from api.demo import get_dummy_account

    account = await get_dummy_account()
    today = await ensure_today_snapshot()
    history = await _load_history()
    balance = float(account.get("balance") or 0)
    realized = float(account.get("realizedPnl") or 0)
    unrealized = float(account.get("unrealizedPnl") or 0)
    equity = round(balance + realized + unrealized, 2)
    return {
        "equity": equity,
        "balance": round(balance, 2),
        "realizedPnl": round(realized, 2),
        "unrealizedPnl": round(unrealized, 2),
        "totalPnl": round(float(account.get("totalPnl") or 0), 2),
        "totalCharges": round(float(account.get("totalCharges") or 0), 2),
        "today": today,
        "history": history,
        "startDate": account.get("startDate"),
    }


async def history_series(days: int = 7) -> dict:
    await ensure_today_snapshot()
    history = await _load_history()
    return {"data": history[: max(1, min(int(days), 30))], "tradingDate": _session_aware_trading_date()}


async def apply_retention(cutoff_days: int = RETENTION_DAYS) -> int:
    """Drop demo orders older than ``cutoff_days`` (IST trading-date based) so
    the Dummy order store never grows unbounded. Returns purged count."""
    from api.demo import get_dummy_orders, _save_orders

    cutoff = trading_date(_now_utc() - timedelta(days=cutoff_days))
    orders = await get_dummy_orders()
    kept = []
    purged = 0
    for o in orders:
        order_date = ""
        try:
            order_date = trading_date(datetime.fromisoformat(o.get("orderDate") or ""))
        except (TypeError, ValueError):
            order_date = ""
        if order_date and order_date < cutoff:
            purged += 1
            continue
        kept.append(o)
    if purged:
        await _save_orders(kept)
    return purged


# --------------------------------------------------------------------------- #
# Holdings / risk
# --------------------------------------------------------------------------- #
async def holdings_summary() -> dict:
    from api.demo import get_dummy_positions

    positions = await get_dummy_positions()
    holdings = []
    for p in positions:
        net = int(p.get("netQuantity") or 0)
        long_qty = int(p.get("buyQuantity") or 0)
        if net <= 0:
            continue
        ltp = float(p.get("ltp") or 0)
        current = long_qty * ltp
        holdings.append({
            "symbol": p.get("symbol"),
            "tradingSymbol": p.get("tradingSymbol") or p.get("symbol"),
            "token": p.get("token"),
            "exchange": p.get("exchange"),
            "product": p.get("product"),
            "quantity": long_qty,
            "averageBuyPrice": round(float(p.get("averageBuyPrice") or 0), 2),
            "ltp": round(ltp, 2),
            "marketValue": round(current, 2),
            "unrealizedPnl": round(float(p.get("unrealizedPnl") or 0), 2),
        })
    total_value = round(sum(h["marketValue"] for h in holdings), 2)
    total_pnl = round(sum(h["unrealizedPnl"] for h in holdings), 2)
    return {"data": holdings, "totalValue": total_value, "totalPnl": total_pnl, "count": len(holdings)}


async def risk_summary() -> dict:
    from api.demo import get_dummy_account, get_dummy_positions, get_dummy_orders

    account = await get_dummy_account()
    positions = await get_dummy_positions()
    orders = await get_dummy_orders()
    alerts = await get_alerts()
    targets = await get_targets()
    balance = float(account.get("balance") or 0)
    used = float(account.get("usedMargin") or 0)
    free = float(account.get("freeMargin") or 0)
    open_positions = sum(1 for p in positions if int(p.get("netQuantity") or 0) != 0)
    today_orders = int(account.get("dailyOrders") or 0)
    exposure = sum(
        abs(int(p.get("netQuantity") or 0)) * float(p.get("ltp") or 0) * (0.2 if p.get("product") == "MIS" else 1.0)
        for p in positions
    )
    margin_util = round(used / balance * 100, 2) if balance > 0 else 0.0
    pending_targets = sum(1 for t in targets if t.get("status") == "PENDING")
    return {
        "balance": round(balance, 2),
        "usedMargin": round(used, 2),
        "freeMargin": round(free, 2),
        "marginUtilizationPct": margin_util,
        "exposure": round(exposure, 2),
        "openPositions": open_positions,
        "todayOrders": today_orders,
        "activeAlerts": sum(1 for a in alerts if a.get("status") == "ACTIVE"),
        "pendingTargets": pending_targets,
    }


# --------------------------------------------------------------------------- #
# Market session / calendar reads
# --------------------------------------------------------------------------- #
def market_snapshot() -> dict:
    from services.market_calendar import snapshot as calendar_snapshot

    snap = calendar_snapshot()
    snap["tradingDate"] = _session_aware_trading_date()
    snap["dummySessionDate"] = _session_aware_trading_date()
    return snap


def calendar_payload() -> dict:
    from services.market_calendar import (
        KNOWN_HOLIDAYS,
        MARKET_SESSIONS,
        closure_reason,
        day_class,
        is_trading_day,
        next_trading_day,
        snapshot as calendar_snapshot,
    )

    now = _now_ist()
    today = now.date()
    year = today.year
    holidays = sorted(
        ({"date": d, "name": "NSE/BSE holiday"} for d in KNOWN_HOLIDAYS if d.startswith(f"{year}-") or d.startswith(f"{year + 1}-")),
        key=lambda h: h["date"],
    )
    return {
        "snapshot": calendar_snapshot(),
        "sessions": [{"id": s, "label": s.replace("_", " ").title()} for s in MARKET_SESSIONS],
        "holidays": holidays,
        "is_trading_day": is_trading_day(),
        "day_class": day_class(),
        "next_trading_day": str(next_trading_day()) if next_trading_day() else None,
        "closure_reason": closure_reason(),
        "constraints": {
            "PRE_OPEN": "09:00 IST",
            "OPEN": "09:15–15:30 IST",
            "POST_CLOSE": "15:30–16:00 IST",
        },
    }


# --------------------------------------------------------------------------- #
# LTP side-effects (called from the demo engine's LTP funnel)
# --------------------------------------------------------------------------- #
async def on_dummy_ltp(ltp_map: dict[str, float], positions: list) -> dict:
    """Evaluate alerts + targets after the demo engine applied fresh LTP.
    Never raises: side-effects best-effort so a Dummy UI refresh is never
    blocked by an alert/target evaluation failure."""
    triggered_alerts: list[dict] = []
    executed_targets: list[dict] = []
    for fn in (evaluate_dummy_alerts, evaluate_dummy_targets):
        try:
            if fn is evaluate_dummy_targets:
                out = await fn(ltp_map, positions)
            else:
                out = await fn(ltp_map)
        except Exception as exc:
            logger.warning("dummy ltp side-effect %s failed: %s", getattr(fn, "__name__", "?"), exc)
            continue
        if fn is evaluate_dummy_alerts:
            triggered_alerts = out
        else:
            executed_targets = out
    return {"alerts": triggered_alerts, "targets": executed_targets}


# --------------------------------------------------------------------------- #
# Dummy terminal preferences
# --------------------------------------------------------------------------- #
async def get_prefs() -> dict:
    stored = await _get_doc(KEY_PREFS, {})
    return {**DEFAULT_PREFS, **(stored or {})}


async def update_prefs(patch: dict) -> dict:
    current = await get_prefs()
    merged = {**current}
    for key in DEFAULT_PREFS:
        if key in patch:
            merged[key] = patch[key]
    delivery = patch.get("notificationDelivery")
    if isinstance(delivery, dict) or isinstance(merged.get("notificationDelivery"), dict):
        base = dict(DEFAULT_PREFS["notificationDelivery"])
        stored = dict(merged.get("notificationDelivery") or {})
        overrides = dict(delivery or {})
        merged["notificationDelivery"] = {**base, **stored, **overrides}
    await _set_doc(KEY_PREFS, merged)
    return merged


# --------------------------------------------------------------------------- #
# Closed positions (paper settlement trail)
# --------------------------------------------------------------------------- #
async def record_closed_position(
    symbol: str,
    trading_symbol: str,
    exchange: str,
    exchange_segment: str,
    token: str,
    product: str,
    side: str,
    quantity: int,
    average_price: float,
    exit_price: float,
    realized_pnl: float,
    charges: float,
    reason: str = "EXECUTED",
    closed_at: Optional[datetime] = None,
    order_id: str = "",
) -> dict:
    """Append a settled position to the terminal-scoped closed trail. Called by
    the demo engine when a net-open position reverts to FLAT (close via trade,
    square-off or target auto square-off). Read-only for the Dummy UI.

    Idempotent per ``order_id``: concurrent square-offs of the same position
    (double-click, overlapping LTP funnels) must record exactly one trail
    entry — a repeat with the same order id returns the existing record.
    """
    closed = await _get_doc(KEY_CLOSED_POSITIONS, [])
    if order_id:
        for existing in closed:
            if existing.get("orderId") == order_id:
                return existing
    record = {
        "id": _new_id("closed"),
        "orderId": str(order_id or ""),
        "symbol": str(symbol).strip().upper(),
        "tradingSymbol": trading_symbol or symbol,
        "exchange": exchange or "nse_cm",
        "exchangeSegment": exchange_segment or "NSE_CM",
        "token": token or "",
        "product": product or "MIS",
        "side": side,
        "quantity": int(quantity or 0),
        "averagePrice": round(float(average_price or 0), 2),
        "exitPrice": round(float(exit_price or 0), 2),
        "realizedPnl": round(float(realized_pnl or 0), 2),
        "charges": round(float(charges or 0), 2),
        "netPnl": round(float(realized_pnl or 0) - float(charges or 0), 2),
        "reason": reason,
        "closedAt": (closed_at or _now_utc()).isoformat(),
        "tradingDate": trading_date(closed_at or _now_utc()),
    }
    closed.insert(0, record)
    closed[:] = closed[:MAX_CLOSED_POSITIONS]
    await _set_doc(KEY_CLOSED_POSITIONS, closed)
    return record


async def list_closed_positions(limit: int = 200, date: str = "") -> list:
    """Closed trail, newest first. ``date`` (YYYY-MM-DD) scopes to one trading
    date so yesterday's settlements never leak into today's page; empty keeps
    the full trail (history/audit callers)."""
    items = await _get_doc(KEY_CLOSED_POSITIONS, [])
    items = items or []
    if date:
        items = [c for c in items if str(c.get("tradingDate") or "") == str(date)]
    return items[: max(1, min(int(limit), MAX_CLOSED_POSITIONS))]


async def clear_closed_positions() -> int:
    count = len(await _get_doc(KEY_CLOSED_POSITIONS, []))
    await _set_doc(KEY_CLOSED_POSITIONS, [])
    return count


# --------------------------------------------------------------------------- #
# P&L reports — daily / weekly / monthly, all from permanent MongoDB stores
# --------------------------------------------------------------------------- #
_EXECUTED_STATUSES = ("COMPLETE", "FILLED", "EXECUTED")


def _book_report_row(date_str: str, starting_capital: float, account: dict,
                     orders: list, status: str) -> dict:
    """One report row from a day's frozen book (session archive or live store).

    P&L is gross realized minus charges (the engine tracks them separately);
    orders/filled/turnover come from the day's real order rows — nothing is
    estimated or fabricated.
    """
    orders = orders or []
    filled = [o for o in orders if str(o.get("status") or "").upper() in _EXECUTED_STATUSES]
    turnover = round(sum(
        float(o.get("averageTradedPrice") or 0) * int(o.get("filledQuantity") or 0)
        for o in filled
    ), 2)
    realized = round(float((account or {}).get("realizedPnl") or 0), 2)
    charges = round(float((account or {}).get("totalCharges") or 0), 2)
    return {
        "date": date_str,
        "status": status,
        "startingCapital": round(float(starting_capital or 0), 2),
        "closingBalance": round(float((account or {}).get("balance") or 0), 2),
        "realizedPnl": realized,
        "charges": charges,
        "netPnl": round(realized - charges, 2),
        "orders": len(orders),
        "filled": len(filled),
        "turnover": turnover,
    }


def _session_report_row(session: dict) -> dict:
    """Report row for a stored session document (permanent archive first)."""
    archive = (session or {}).get("archive") or {}
    account = archive.get("account") or {}
    orders = archive.get("orders") or []
    if account or orders:
        return _book_report_row(
            str(session.get("trading_date") or ""),
            session.get("starting_capital") or 0,
            account, orders,
            str(session.get("status") or "CLOSED"),
        )
    # Sessions closed before counter-refresh existed: session-level counters.
    realized = round(float(session.get("realized_pnl") or 0), 2)
    charges = round(float(session.get("charges") or 0), 2)
    return {
        "date": str(session.get("trading_date") or ""),
        "status": str(session.get("status") or "CLOSED"),
        "startingCapital": round(float(session.get("starting_capital") or 0), 2),
        "closingBalance": round(float(session.get("available_capital")
                                      or session.get("starting_capital") or 0), 2),
        "realizedPnl": realized,
        "charges": charges,
        "netPnl": round(realized - charges, 2),
        "orders": int(session.get("order_count") or 0),
        "filled": int(session.get("trade_count") or 0),
        "turnover": round(float(session.get("turnover") or 0), 2),
    }


async def _live_report_row() -> dict:
    """Today's still-open book, read live (same derivation as archived rows)."""
    from api.demo import get_dummy_account, get_dummy_orders
    from services.dummy_session import session_date_for

    today = session_date_for(_now_utc())
    account = await get_dummy_account()
    orders = await get_dummy_orders()
    try:
        prefs = await get_prefs()
        starting = float(prefs.get("startingCapital") or 100000)
    except Exception:
        starting = 100000.0
    return _book_report_row(today, starting, account, orders, "LIVE")


def _aggregate_rows(rows: list, key_fn, label_fn) -> list:
    buckets: dict[str, dict] = {}
    order: list[str] = []
    for r in rows:
        if not r.get("date"):
            continue
        key = key_fn(str(r["date"]))
        if key is None:
            continue
        bucket = buckets.get(key)
        if bucket is None:
            bucket = buckets[key] = {
                "key": key, "label": label_fn(key),
                "start": str(r["date"]), "end": str(r["date"]), "days": 0,
                "realizedPnl": 0.0, "charges": 0.0, "netPnl": 0.0,
                "orders": 0, "filled": 0, "turnover": 0.0,
            }
            order.append(key)
        # Rows arrive newest-first: track the true span either way.
        bucket["start"] = min(bucket["start"], str(r["date"]))
        bucket["end"] = max(bucket["end"], str(r["date"]))
        bucket["days"] += 1
        bucket["realizedPnl"] = round(bucket["realizedPnl"] + float(r.get("realizedPnl") or 0), 2)
        bucket["charges"] = round(bucket["charges"] + float(r.get("charges") or 0), 2)
        bucket["netPnl"] = round(bucket["netPnl"] + float(r.get("netPnl") or 0), 2)
        bucket["orders"] += int(r.get("orders") or 0)
        bucket["filled"] += int(r.get("filled") or 0)
        bucket["turnover"] = round(bucket["turnover"] + float(r.get("turnover") or 0), 2)
    return [buckets[k] for k in order]


def _week_key(day_str: str) -> Optional[str]:
    try:
        d = date.fromisoformat(day_str[:10])
        iso_year, iso_week, _ = d.isocalendar()
        return f"{iso_year}-W{iso_week:02d}"
    except (TypeError, ValueError):
        return None


def _week_label(key: str) -> str:
    try:
        iso_year, week = key.split("-W")
        monday = date.fromisocalendar(int(iso_year), int(week), 1)
        sunday = date.fromisocalendar(int(iso_year), int(week), 7)
        return f"{monday.strftime('%d %b')} – {sunday.strftime('%d %b %Y')}"
    except (TypeError, ValueError):
        return key


def _month_label(key: str) -> str:
    try:
        d = date.fromisoformat(f"{key}-01")
        return d.strftime("%b %Y")
    except (TypeError, ValueError):
        return key


async def build_pnl_reports(range_: str = "daily", limit: int = 60) -> dict:
    """Daily / weekly / monthly P&L report from permanent MongoDB stores.

    Daily rows come from the closed-session archive (frozen account + the
    day's real order rows) plus today's live book; weekly/monthly aggregate
    those daily rows. ``limit`` caps returned rows (1..365).
    """
    from services.dummy_session import session_date_for

    want = str(range_ or "daily").strip().lower()
    if want not in ("daily", "weekly", "monthly"):
        want = "daily"
    limit = max(1, min(int(limit or 60), 365))
    today = session_date_for(_now_utc())

    sessions: list = []
    try:
        db = get_db()
        cursor = db["dummy_daily_sessions"].find(
            {"terminal": "dummy"}, sort=[("trading_date", -1)],
        )
        sessions = await cursor.to_list(length=400)
    except Exception as exc:
        logger.warning("pnl reports session read skipped: %s", exc)

    daily: list = []
    for s in sessions or []:
        # Today's still-open session is replaced below by the live book read.
        if str(s.get("trading_date") or "") == today and str(s.get("status") or "") == "OPEN":
            continue
        row = _session_report_row(s)
        if row.get("date"):
            daily.append(row)
    try:
        daily.insert(0, await _live_report_row())
    except Exception as exc:
        logger.warning("pnl reports live row skipped: %s", exc)

    if want == "weekly":
        rows = _aggregate_rows(daily, _week_key, _week_label)
    elif want == "monthly":
        rows = _aggregate_rows(daily, lambda d: d[:7], _month_label)
    else:
        rows = daily
    return {
        "range": want,
        "rows": rows[:limit],
        "generatedAt": _now_utc().isoformat(),
        "tradingDate": today,
    }


# --------------------------------------------------------------------------- #
# Audit trail (terminal-scoped operational log)
# --------------------------------------------------------------------------- #
async def record_audit(category: str, action: str, meta: Optional[dict] = None) -> dict:
    """Append an operational audit event. Best-effort safe for any caller."""
    items = await _get_doc(KEY_AUDIT, [])
    record = {
        "id": _new_id("audit"),
        "ts": _now_utc().isoformat(),
        "category": category,
        "action": action,
        "meta": meta or {},
    }
    items.insert(0, record)
    items[:] = items[:MAX_AUDIT_EVENTS]
    await _set_doc(KEY_AUDIT, items)
    return record


async def list_audit(category: str = "", limit: int = 100) -> list:
    items = await _get_doc(KEY_AUDIT, [])
    filtered = [i for i in (items or []) if not category or i.get("category") == category]
    return filtered[: max(1, min(int(limit), MAX_AUDIT_EVENTS))]


# --------------------------------------------------------------------------- #
# Watchlists (terminal-scoped, multi-list)
# --------------------------------------------------------------------------- #
async def list_watchlists() -> dict:
    payload = await _get_doc(KEY_WATCHLISTS, None)
    if not isinstance(payload, dict) or not payload.get("items"):
        payload = {"activeId": "", "items": []}
    items = payload.get("items") or []
    active_id = payload.get("activeId") or (items[0]["id"] if items else "")
    return {"activeId": active_id, "items": items}


async def _save_watchlists(payload: dict) -> None:
    await _set_doc(KEY_WATCHLISTS, payload)


async def create_watchlist(name: str, symbols: Optional[list] = None) -> dict:
    payload = await list_watchlists()
    slug = str(name or "Watchlist").strip() or "Watchlist"
    duplicate = next((w for w in payload["items"] if w.get("name", "").strip().lower() == slug.lower()), None)
    if duplicate is not None:
        raise ValueError(f"A watchlist named {slug!r} already exists")
    watchlist = {"id": _new_id("wl"), "name": slug, "createdAt": _now_utc().isoformat(), "symbols": list(symbols or [])}
    payload["items"].append(watchlist)
    if not payload.get("activeId"):
        payload["activeId"] = watchlist["id"]
    await _save_watchlists(payload)
    return watchlist


async def delete_watchlist(watchlist_id: str) -> bool:
    payload = await list_watchlists()
    items = payload["items"]
    target = next((w for w in items if w["id"] == watchlist_id), None)
    if target is None:
        return False
    if len(items) == 1:
        raise ValueError("Cannot delete the last watchlist")
    remaining = [w for w in items if w["id"] != watchlist_id]
    active = payload["activeId"]
    if active == watchlist_id:
        active = remaining[0]["id"]
    await _save_watchlists({"activeId": active, "items": remaining})
    return True


async def set_active_watchlist(watchlist_id: str) -> bool:
    payload = await list_watchlists()
    if payload["activeId"] == watchlist_id:
        return True
    if not any(w["id"] == watchlist_id for w in payload["items"]):
        return False
    payload["activeId"] = watchlist_id
    await _save_watchlists(payload)
    return True


async def add_watchlist_symbol(watchlist_id: str, item: dict) -> bool:
    symbol = str(item.get("symbol") or "").strip().upper()
    if not symbol:
        raise ValueError("symbol required")
    payload = await list_watchlists()
    target = next((w for w in payload["items"] if w["id"] == watchlist_id), None)
    if target is None:
        # Auto-create when the store is empty (first interaction).
        target = create_watchlist_sync(payload, "My Watchlist")
    if any(str(s.get("symbol") or "").strip().upper() == symbol for s in target["symbols"]):
        return True
    target["symbols"].append({
        "symbol": symbol,
        "tradingSymbol": item.get("tradingSymbol") or symbol,
        "exchange": item.get("exchange") or "nse_cm",
        "exchangeSegment": item.get("exchangeSegment") or "NSE_CM",
        "token": item.get("token") or "",
        "addedAt": _now_utc().isoformat(),
    })
    await _save_watchlists({"activeId": payload["activeId"], "items": payload["items"]})
    return True


def create_watchlist_sync(payload: dict, name: str) -> dict:
    watchlist = {"id": _new_id("wl"), "name": name, "createdAt": _now_utc().isoformat(), "symbols": []}
    payload["items"].append(watchlist)
    if not payload.get("activeId"):
        payload["activeId"] = watchlist["id"]
    return watchlist


async def remove_watchlist_symbol(watchlist_id: str, symbol: str) -> bool:
    key = str(symbol or "").strip().upper()
    if not key:
        return False
    payload = await list_watchlists()
    target = next((w for w in payload["items"] if w["id"] == watchlist_id), None)
    if target is None:
        return False
    before = len(target["symbols"])
    target["symbols"] = [s for s in target["symbols"] if str(s.get("symbol") or "").strip().upper() != key]
    await _save_watchlists({"activeId": payload["activeId"], "items": payload["items"]})
    return len(target["symbols"]) < before


async def watchlist_symbols(watchlist_id: str, fallback_active: bool = True) -> list:
    payload = await list_watchlists()
    if watchlist_id:
        target = next((w for w in payload["items"] if w["id"] == watchlist_id), None)
        if target is not None:
            return target["symbols"]
    if fallback_active:
        target = next((w for w in payload["items"] if w["id"] == payload["activeId"]), None)
        if target is not None:
            return target["symbols"]
    return []


# --------------------------------------------------------------------------- #
# Calendar events (terminal-scoped user events on top of the market calendar)
# --------------------------------------------------------------------------- #
_EVENT_CATEGORIES = ("TRADING", "MARKET", "PERSONAL")


async def list_calendar_events(date_from: str = "", date_to: str = "") -> list:
    items = await _get_doc(KEY_CALENDAR_EVENTS, [])
    out = items or []
    if date_from:
        out = [e for e in out if e.get("date", "") >= date_from]
    if date_to:
        out = [e for e in out if e.get("date", "") <= date_to]
    return out


async def create_calendar_event(date: str, category: str, title: str, note: str = "",
                                pinned: bool = False, reminderMinutes: Optional[int] = None) -> dict:
    if not str(date or "").strip():
        raise ValueError("date required (YYYY-MM-DD)")
    if not str(title or "").strip():
        raise ValueError("title required")
    cat = str(category or "PERSONAL").upper()
    if cat not in _EVENT_CATEGORIES:
        raise ValueError(f"category must be one of {_EVENT_CATEGORIES}")
    reminder = reminderMinutes
    if reminder is not None and not (0 <= int(reminder) <= 10080):
        raise ValueError("reminderMinutes must be between 0 and 10080")
    items = await list_calendar_events()
    event = {
        "id": _new_id("ev"),
        "date": str(date).strip(),
        "category": cat,
        "title": str(title).strip(),
        "note": str(note or "").strip(),
        "pinned": bool(pinned),
        "reminderMinutes": reminder,
        "createdAt": _now_utc().isoformat(),
        "updatedAt": _now_utc().isoformat(),
    }
    items.insert(0, event)
    items[:] = items[:1000]
    await _set_doc(KEY_CALENDAR_EVENTS, items)
    return event


async def update_calendar_event(event_id: str, patch: dict) -> Optional[dict]:
    items = await list_calendar_events()
    target = next((e for e in items if e["id"] == event_id), None)
    if target is None:
        return None
    allowed = ("date", "category", "title", "note", "pinned", "reminderMinutes")
    for key in allowed:
        if key in patch:
            if key == "category":
                cat = str(patch[key]).upper()
                if cat not in _EVENT_CATEGORIES:
                    raise ValueError(f"category must be one of {_EVENT_CATEGORIES}")
                target[key] = cat
            elif key == "reminderMinutes":
                rm = patch[key]
                if rm is not None and not (0 <= int(rm) <= 10080):
                    raise ValueError("reminderMinutes must be between 0 and 10080")
                target[key] = rm
            elif key == "date" and not str(patch[key] or "").strip():
                raise ValueError("date required (YYYY-MM-DD)")
            else:
                target[key] = patch[key]
    target["updatedAt"] = _now_utc().isoformat()
    await _set_doc(KEY_CALENDAR_EVENTS, items)
    return target


async def delete_calendar_event(event_id: str) -> bool:
    items = await list_calendar_events()
    before = len(items)
    items = [e for e in items if e["id"] != event_id]
    if len(items) == before:
        return False
    await _set_doc(KEY_CALENDAR_EVENTS, items)
    return True


# --------------------------------------------------------------------------- #
# AI Suggestion pipeline (Khumbha AI future integration, Phase 4)
# --------------------------------------------------------------------------- #
KEY_SUGGESTIONS = "dummy_suggestions"

MAX_SUGGESTIONS = 200

SUGGESTION_STATUSES = (
    "RECEIVED", "VALIDATING", "VALIDATED", "REJECTED", "DUPLICATE",
    "EXPIRED", "RISK_REJECTED", "EXECUTING", "EXECUTED", "FAILED", "CANCELLED",
)

SUGGESTION_TYPES = ("NORMAL", "BASKET")

SUGGESTION_PIPELINE = (
    "RECEIVED", "VALIDATED", "DUPLICATE_CHECK", "EXPIRY_CHECK", "RISK_CHECK",
    "ORDER_ENGINE", "DUMMY_BROKER", "RESULT", "NOTIFICATION", "AUDIT",
)

# An AI suggestion is considered a candidate duplicate of a live/executed one
# when the same symbol + direction recurs within this window at a similar entry.
DUPLICATE_WINDOW_SECONDS = 900  # 15 minutes
DUPLICATE_ENTRY_TOLERANCE = 0.005  # 0.5%


def _parse_expiry(raw: Any) -> Optional[str]:
    """Accept an ISO-8601 string or a number of seconds-from-now and return an
    ISO UTC string, or None when unset/invalid."""
    if raw in (None, "", 0, "0"):
        return None
    try:
        secs = float(raw)
        if isinstance(raw, (int, float)) or (raw.isdigit() and 0 < secs < 10_000_000):
            return (_now_utc() + timedelta(seconds=secs)).isoformat()
    except (TypeError, ValueError):
        pass
    text = str(raw).strip()
    try:
        dt = datetime.fromisoformat(text)
        return dt.astimezone(timezone.utc).isoformat()
    except ValueError:
        return None


async def get_suggestions() -> list:
    return await _get_doc(KEY_SUGGESTIONS, [])


async def get_suggestion(suggestion_id: str) -> Optional[dict]:
    items = await get_suggestions()
    return next((s for s in items if s.get("id") == suggestion_id), None)


async def delete_suggestion(suggestion_id: str) -> bool:
    items = await get_suggestions()
    removed = [s for s in items if s.get("id") != suggestion_id]
    if len(removed) == len(items):
        return False
    await _set_doc(KEY_SUGGESTIONS, removed)
    await record_audit("suggestion", "DELETED", {"suggestionId": suggestion_id})
    return True


def _computed_expected_value(s: dict) -> float:
    entry = float(s.get("entry") or 0)
    target = float(s.get("target") or 0)
    qty = int(s.get("quantity") or 0)
    direction = 1 if str(s.get("direction") or "BUY").upper() == "BUY" else -1
    if entry <= 0 or qty <= 0 or target <= 0:
        return 0.0
    return round((target - entry) * direction * qty, 2)


def _computed_risk_value(s: dict) -> float:
    entry = float(s.get("entry") or 0)
    stop = float(s.get("stopLoss") or 0)
    qty = int(s.get("quantity") or 0)
    direction = 1 if str(s.get("direction") or "BUY").upper() == "BUY" else -1
    if entry <= 0 or qty <= 0 or stop <= 0:
        return 0.0
    return round((entry - stop) * direction * qty, 2)


def _validate_suggestion_payload(payload: dict) -> None:
    symbol = str(payload.get("symbol") or "").strip().upper()
    if not symbol:
        raise ValueError("suggestion symbol is required")
    direction = str(payload.get("direction") or "").upper()
    if direction not in ("BUY", "SELL"):
        raise ValueError("suggestion direction must be BUY | SELL")
    try:
        quantity = int(payload.get("quantity") or 0)
    except (TypeError, ValueError):
        quantity = 0
    if quantity <= 0:
        raise ValueError("suggestion quantity must be positive")
    try:
        entry = float(payload.get("entry") or payload.get("price") or 0)
    except (TypeError, ValueError):
        entry = 0.0
    if entry <= 0:
        raise ValueError("suggestion entry price must be positive")
    confidence = float(payload.get("confidence") or 0)
    if not (0 <= confidence <= 100):
        raise ValueError("suggestion confidence must be between 0 and 100")
    itype = str(payload.get("type") or "NORMAL").upper()
    if itype not in SUGGESTION_TYPES:
        raise ValueError("suggestion type must be NORMAL | BASKET")
    if itype == "BASKET":
        legs = payload.get("legs") or []
        if not isinstance(legs, list) or not legs:
            raise ValueError("BASKET suggestion requires legs")


async def receive_suggestion(payload: dict, source: str = "KHUMBHA_AI") -> dict:
    """Ingest a suggestion from a model/AI source. The model NEVER places an
    order directly — the suggestion enters the validated pipeline (receiver →
    validate → duplicate → expiry → risk → order engine → dummy broker)."""
    _validate_suggestion_payload(payload)
    suggestions = await get_suggestions()
    symbol = str(payload.get("symbol") or "").strip().upper()
    direction = str(payload.get("direction") or "").upper()
    itype = str(payload.get("type") or "NORMAL").upper()
    entry = round(float(payload.get("entry") or payload.get("price") or 0), 2)
    target = round(float(payload.get("target") or 0), 2)
    stop = round(float(payload.get("stopLoss") or 0), 2)
    quantity = int(payload.get("quantity") or 0)
    source_label = str(payload.get("model") or payload.get("source") or source)
    expiry = _parse_expiry(payload.get("expiry"))
    suggestion = {
        "id": _new_id("SUG"),
        "source": source_label,
        "model": str(payload.get("model") or source_label),
        "symbol": symbol,
        "direction": direction,
        "confidence": round(float(payload.get("confidence") or 0), 1),
        "quantity": quantity,
        "entry": entry,
        "target": target,
        "stopLoss": stop,
        "expectedValue": round(float(payload.get("expectedValue") or 0) or _computed_expected_value({
            "entry": entry, "target": target, "quantity": quantity, "direction": direction,
        }), 2),
        "risk": round(float(payload.get("risk") or 0) or _computed_risk_value({
            "entry": entry, "stopLoss": stop, "quantity": quantity, "direction": direction,
        }), 2),
        "type": itype,
        "legs": list(payload.get("legs") or []),
        "reason": str(payload.get("reason") or ""),
        "product": str(payload.get("product") or "MIS").upper(),
        "orderType": str(payload.get("orderType") or "MKT"),
        "expiry": expiry,
        "status": "RECEIVED",
        "pipeline": ["RECEIVED"],
        "checks": [],
        "orderId": None,
        "duplicateOf": None,
        "error": None,
        "rejectReason": None,
        "processedAt": None,
        "createdAt": _now_utc().isoformat(),
    }
    suggestions.insert(0, suggestion)
    suggestions[:] = suggestions[:MAX_SUGGESTIONS]
    await _set_doc(KEY_SUGGESTIONS, suggestions)
    await notify(
        "ai", "AI suggestion received",
        f"{source_label} → {symbol} {direction} {quantity} @ {entry}",
        {"suggestionId": suggestion["id"], "symbol": symbol, "direction": direction},
    )
    await record_audit("suggestion", "RECEIVED", {"suggestionId": suggestion["id"], "source": source_label})
    return suggestion


def _suggestion_expired(s: dict) -> bool:
    expiry = s.get("expiry")
    if not expiry:
        return False
    try:
        return _now_utc() > datetime.fromisoformat(str(expiry))
    except (TypeError, ValueError):
        return False


def validate_suggestion_structure(s: dict, ltp_map: Optional[dict] = None) -> list[dict]:
    """Structural + market sanity checks. Never touches order/position state."""
    checks: list[dict] = []
    symbol = str(s.get("symbol") or "").strip().upper()
    quantity = int(s.get("quantity") or 0)
    entry = float(s.get("entry") or 0)
    target = float(s.get("target") or 0)
    stop = float(s.get("stopLoss") or 0)
    confidence = float(s.get("confidence") or 0)
    itype = str(s.get("type") or "NORMAL").upper()
    ltp = float((ltp_map or {}).get(symbol, 0) or 0)

    checks.append({
        "name": "symbol", "label": "Symbol present",
        "passed": bool(symbol),
        "message": symbol or "symbol is empty",
    })
    known = False
    if symbol:
        try:
            from api.demo import known_ltp as _known_ltp
        except ImportError:
            _known_ltp = lambda _sym: 0.0
        try:
            from services.instrument_cache import instrument_cache
            known = bool(instrument_cache.lookup_by_symbol(symbol)) or _known_ltp(symbol) > 0
        except Exception:
            known = _known_ltp(symbol) > 0
    checks.append({
        "name": "instrument", "label": "Instrument recognised",
        "passed": known,
        "message": f"{symbol} not found in the shared instrument cache yet" if not known else "known instrument",
    })
    checks.append({
        "name": "direction", "label": "Direction valid",
        "passed": str(s.get("direction") or "").upper() in ("BUY", "SELL"),
        "message": "direction must be BUY | SELL",
    })
    checks.append({
        "name": "quantity", "label": "Quantity positive",
        "passed": quantity > 0,
        "message": f"quantity {quantity} <= 0",
    })
    checks.append({
        "name": "entry", "label": "Entry price positive",
        "passed": entry > 0,
        "message": f"entry {entry} <= 0",
    })
    checks.append({
        "name": "confidence", "label": "Confidence within 0–100",
        "passed": 0 <= confidence <= 100,
        "message": f"confidence {confidence} out of range",
    })
    if ltp > 0 and entry > 0:
        drift = abs(ltp - entry) / ltp
        checks.append({
            "name": "entry_proximity", "label": "Entry near live LTP",
            "passed": drift <= 0.05,
            "message": f"entry {entry:.2f} is {drift * 100:.1f}% from live LTP {ltp:.2f}",
        })
    if target > 0 and stop > 0 and entry > 0:
        direction = str(s.get("direction") or "BUY").upper()
        sensible = (target > entry > stop) if direction == "BUY" else (target < entry < stop)
        checks.append({
            "name": "stops", "label": "Target / stop-loss bracket sane",
            "passed": sensible,
            "message": "target must be on the profit side and stop-loss on the risk side of entry",
        })
    checks.append({
        "name": "type", "label": "Normal or Basket",
        "passed": itype in SUGGESTION_TYPES,
        "message": "type must be NORMAL | BASKET",
    })
    return checks


async def _duplicate_of(s: dict) -> Optional[dict]:
    symbol = str(s.get("symbol") or "").upper()
    direction = str(s.get("direction") or "BUY").upper()
    entry = float(s.get("entry") or 0)
    try:
        created = datetime.fromisoformat(s.get("createdAt"))
    except (TypeError, ValueError):
        created = _now_utc()
    items = await get_suggestions()
    live_statuses = {"RECEIVED", "VALIDATING", "VALIDATED", "EXECUTING"}
    for other in items:
        if other.get("id") == s.get("id"):
            continue
        if other.get("status") not in live_statuses:
            continue
        if str(other.get("symbol") or "").upper() != symbol:
            continue
        if str(other.get("direction") or "").upper() != direction:
            continue
        other_entry = float(other.get("entry") or 0)
        if entry <= 0 or other_entry <= 0:
            continue
        if abs(other_entry - entry) / entry > DUPLICATE_ENTRY_TOLERANCE:
            continue
        try:
            other_created = datetime.fromisoformat(other.get("createdAt"))
        except (TypeError, ValueError):
            other_created = _now_utc()
        if (created - other_created).total_seconds() > DUPLICATE_WINDOW_SECONDS:
            continue
        return other
    return None


async def _risk_check_suggestion(s: dict) -> dict:
    """Risk Engine gate: margin, daily cap and per-order value cap. Reads the
    dummy account + terminal prefs; never mutates them."""
    from api.demo import get_dummy_account

    account = await get_dummy_account()
    free_margin = float(account.get("freeMargin") or 0)
    prefs = await get_prefs()
    quantity = int(s.get("quantity") or 0)
    entry = float(s.get("entry") or 0)
    itype = str(s.get("type") or "NORMAL").upper()

    if itype == "BASKET":
        legs = s.get("legs") or []
        if not legs:
            return {"passed": False, "reason": "BASKET suggestion has no legs"}
        value = 0.0
        for leg in legs:
            value += float(leg.get("price") or leg.get("entry") or 0) * int(leg.get("quantity") or 0)
    else:
        value = quantity * entry
    margin_factor = 0.2 if str(s.get("product") or "MIS").upper() == "MIS" else 1.0
    margin_required = round(value * margin_factor, 2)
    max_value = float(prefs.get("maxOrderValue") or 0)
    max_orders = int(prefs.get("maxDailyOrders") or 0)
    today_orders = int(account.get("dailyOrders") or 0)
    reasons = []
    if margin_required > free_margin:
        reasons.append(f"margin {margin_required:.2f} > free {free_margin:.2f}")
    if max_value > 0 and value > max_value:
        reasons.append(f"order value {value:.2f} > cap {max_value:.2f}")
    if max_orders > 0 and today_orders >= max_orders:
        reasons.append(f"daily order cap {max_orders} reached")
    return {
        "passed": not reasons,
        "reason": "; ".join(reasons) if reasons else "ok",
        "marginRequired": round(margin_required, 2),
        "freeMargin": round(free_margin, 2),
        "orderValue": round(value, 2),
        "factor": margin_factor,
    }


async def _save_suggestion(s: dict) -> None:
    items = await get_suggestions()
    for i, cur in enumerate(items):
        if cur.get("id") == s.get("id"):
            items[i] = s
            break
    else:
        items.insert(0, s)
    await _set_doc(KEY_SUGGESTIONS, items[:MAX_SUGGESTIONS])


async def _finish_suggestion(s: dict, status: str, *, error: Optional[str] = None,
                             reject_reason: Optional[str] = None, extra: Optional[dict] = None) -> dict:
    """Terminal transition shared by every pipeline exit — writes state, emits a
    notification and appends an audit record exactly once."""
    s["status"] = status
    if error is not None:
        s["error"] = str(error)[:500]
    if reject_reason is not None:
        s["rejectReason"] = str(reject_reason)[:500]
    if s.get("status") not in s.get("pipeline", []):
        s.setdefault("pipeline", []).append(status)
    s["processedAt"] = _now_utc().isoformat()
    extra = dict(extra or {})
    extra.update({"suggestionId": s["id"], "symbol": s.get("symbol"), "status": status})
    await _save_suggestion(s)
    await notify(
        "ai",
        f"AI suggestion {status.replace('_', ' ').title()}",
        f"{s.get('symbol')} {s.get('direction')} {s.get('quantity')} @ {s.get('entry')}"
        + (f" — {reject_reason}" if reject_reason else f" — {error}" if error else ""),
        extra,
    )
    await record_audit("suggestion", status, extra)
    return s


async def process_suggestion(suggestion_id: str, ltp_map: Optional[dict] = None) -> dict:
    """Run the mandatory suggestion pipeline. An AI model CANNOT bypass this:
       receiver → validate → duplicate → expiry → Risk Engine → Order Engine →
       Dummy Broker Simulator → result → notification → audit."""
    s = await get_suggestion(suggestion_id)
    if s is None:
        raise KeyError(f"suggestion {suggestion_id} not found")
    if s.get("status") not in ("RECEIVED",):
        raise ValueError(f"suggestion {suggestion_id} cannot be processed from status {s.get('status')}")

    s["status"] = "VALIDATING"
    s.setdefault("pipeline", []).append("VALIDATING")
    await _save_suggestion(s)

    checks = validate_suggestion_structure(s, ltp_map)
    s["checks"] = checks
    await _save_suggestion(s)
    failed = [c for c in checks if not c.get("passed")]
    if failed:
        detail = "; ".join(f"{c.get('name')}: {c.get('message')}" for c in failed)
        return await _finish_suggestion(s, "REJECTED", error=detail,
                                        reject_reason=f"validation failed — {detail}")

    s["status"] = "VALIDATED"
    s.setdefault("pipeline", []).append("VALIDATED")
    await _save_suggestion(s)

    dup = await _duplicate_of(s)
    if dup is not None:
        s["duplicateOf"] = dup["id"]
        s["pipeline"].append("DUPLICATE_CHECK")
        return await _finish_suggestion(s, "DUPLICATE",
                                        error=f"duplicate of {dup['id']}",
                                        reject_reason=f"duplicate of {dup['id']} ({dup.get('symbol')})")

    if _suggestion_expired(s):
        s["pipeline"].append("EXPIRY_CHECK")
        return await _finish_suggestion(s, "EXPIRED", error="suggestion expired before execution")

    risk = await _risk_check_suggestion(s)
    s["pipeline"].append("RISK_CHECK")
    if not risk.get("passed"):
        s["risk"] = {k: v for k, v in risk.items() if k in ("marginRequired", "freeMargin", "orderValue", "factor")}
        return await _finish_suggestion(s, "RISK_REJECTED",
                                        error=risk.get("reason"), reject_reason=f"risk engine rejected — {risk.get('reason')}")

    s["status"] = "EXECUTING"
    s.setdefault("pipeline", []).append("EXECUTING")
    await _save_suggestion(s)

    try:
        from api.demo import execute_dummy_order, remember_ltp

        ltp = float((ltp_map or {}).get(str(s["symbol"]).upper(), 0) or 0)
        if ltp > 0:
            remember_ltp(s["symbol"], ltp)

        if str(s.get("type") or "NORMAL").upper() == "BASKET":
            legs = []
            for leg in s.get("legs") or []:
                legs.append({**leg, "symbol": str(leg.get("symbol") or "").upper()})
            result = await _execute_suggestion_basket(s, legs, ltp_map)
            order_id = result.get("summary", {}).get("orderIds", [""])[0] if result.get("summary", {}).get("orderIds") else ""
            s["result"] = result
        else:
            res = await execute_dummy_order(
                symbol=s["symbol"],
                tradingSymbol=str(s.get("symbol") or "").upper(),
                exchange=str(s.get("exchange") or "nse_cm"),
                exchangeSegment=str(s.get("exchangeSegment") or "NSE_CM"),
                token=str(s.get("token") or ""),
                transactionType=s["direction"],
                product=s.get("product") or "MIS",
                orderType=s.get("orderType") or "MKT",
                quantity=int(s["quantity"]),
                price=float(s.get("entry") or 0),
                triggerPrice=float(s.get("triggerPrice") or 0),
                ltp=ltp,
                source="SUGGESTION",
            )
            order = res.get("demoOrder") or {}
            order_id = order.get("orderId")
            s["result"] = order

        s["orderId"] = order_id
        s["pipeline"].extend(["ORDER_ENGINE", "DUMMY_BROKER", "RESULT", "NOTIFICATION", "AUDIT"])
        return await _finish_suggestion(s, "EXECUTED", extra={"orderId": order_id})
    except Exception as exc:
        return await _finish_suggestion(s, "FAILED", error=str(exc), reject_reason=str(exc)[:500])


async def _execute_suggestion_basket(s: dict, legs: list, ltp_map: Optional[dict] = None) -> dict:
    """Basket-type suggestions route through the same inline basket executor the
    manual Basket Orders page uses (Risk → Order → Dummy Broker per leg)."""
    from api.demo import remember_ltp

    for leg in legs:
        sym = str(leg.get("symbol") or "").upper()
        ltp = float((ltp_map or {}).get(sym, 0) or 0)
        if ltp > 0:
            remember_ltp(sym, ltp)
    policy = {"mode": "ALL", "minimum": len(legs)}
    return await execute_inline_basket(legs, policy, ltp_map)


async def reject_suggestion(suggestion_id: str, reason: str = "") -> dict:
    s = await get_suggestion(suggestion_id)
    if s is None:
        raise KeyError(f"suggestion {suggestion_id} not found")
    if s.get("status") in ("EXECUTED", "FAILED", "CANCELLED"):
        raise ValueError(f"suggestion {suggestion_id} cannot be rejected from status {s.get('status')}")
    return await _finish_suggestion(s, "CANCELLED", reject_reason=reason or "rejected by user")


# --------------------------------------------------------------------------- #
# Broker comparison (read-only, never fabricates a connected broker's state)
# --------------------------------------------------------------------------- #
# The comparison now delegates to the shared Broker Terminal Engine so the
# "Broker Data — Live" cards and the Broker Terminal pages always agree with
# the active terminal dashboards. Dummy Mode reports its paper account only
# once it has been started (same honest rule as Kotak / Shoonya).
# --------------------------------------------------------------------------- #
async def build_terminal_comparison() -> dict:
    """Full per-terminal read for the Dashboards' Kotak / Shoonya / Dummy /
    Combined cards — a thin compatibility alias over the Broker Terminal Engine
    (GET /api/trading/brokers/overview)."""
    from services.broker_terminal_engine import build_terminal_overview

    overview = await build_terminal_overview()
    terminals = overview["terminals"]
    return {
        "ok": True,
        "kotak": terminals["kotak"],
        "shoonya": terminals["shoonya"],
        "dummy": terminals["dummy"],
        "combined": overview["combined"],
    }