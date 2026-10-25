"""Watchlist Engine — state, live card model, metrics, screening and ranking.

Target architecture (docs/engines/watchlist-engine.md):

    WebSocket Engine -> Connection Manager -> Watchlist Engine -> Watchlist UI

Live market data is read from the ONE canonical market-data store
(``services.tick_buffer``) that the Connection Manager / WebSocket Engine feed.
This engine never opens its own broker WebSocket and never fabricates a value:
missing live data is reported as ``CONNECTING``/``DISCONNECTED`` and missing
metrics as ``None``.

Responsibilities:
    * watchlist state + symbol registry (create/rename/delete/add/remove/reorder)
    * normalize live data into the stable stock-card model
    * derived metrics (change, change %, 5-min %, 10-min %)
    * dynamic screening + deterministic ranking
    * publish the required subscription set for the Connection Manager
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Optional

from core.engines.engine_base import EngineBase, EngineState, EngineHealth, EngineCategory
from core.engines.engine_config import ConfigField, read_only
from services.engine_event_bus import get_event_bus, EngineEvent, EngineEvents

logger = logging.getLogger("app.watchlist_engine")

# Live state older than this is surfaced as STALE, never LIVE.
STALE_AFTER_SECONDS = 30.0

DEFAULT_WATCHLIST_ID = "my-stocks"


def _default_watchlist() -> str:
    """Live default watchlist id (runtime settings bridge -> built-in default)."""
    try:
        from services.runtime_settings import get_runtime_setting
        value = get_runtime_setting("wl_default_watchlist")
        if value:
            return str(value)
    except Exception:
        pass
    return DEFAULT_WATCHLIST_ID

CARD_STATUS_LIVE = "LIVE"
CARD_STATUS_STALE = "STALE"
CARD_STATUS_CONNECTING = "CONNECTING"
CARD_STATUS_DISCONNECTED = "DISCONNECTED"

_SUPPORTED_OPS = {"gt", "gte", "lt", "lte", "eq", "ne"}

# Built-in dynamic list definitions: (metric, descending, optional threshold).
_DYNAMIC_LISTS: dict[str, dict] = {
    "top_gainers": {"metric": "changePercent", "desc": True},
    "pct_gainers": {"metric": "changePercent", "desc": True},
    "price_gainers": {"metric": "change", "desc": True},
    "top_losers": {"metric": "changePercent", "desc": False},
    "pct_losers": {"metric": "changePercent", "desc": False},
    "price_losers": {"metric": "change", "desc": False},
    "movers_up": {"metric": "changePercent", "desc": True, "min": 1.0},
    "movers_down": {"metric": "changePercent", "desc": False, "max": -1.0},
    "m5_gainers": {"metric": "fiveMinPercent", "desc": True},
    "m5_losers": {"metric": "fiveMinPercent", "desc": False},
    "m10_gainers": {"metric": "tenMinPercent", "desc": True},
    "m10_losers": {"metric": "tenMinPercent", "desc": False},
}


def _to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


class WatchlistEngine(EngineBase):
    engine_id = "watchlist_engine"
    engine_name = "Watchlist Engine"
    engine_category = EngineCategory.MARKET_DATA
    engine_version = "2.0.0"

    config_fields = (
        ConfigField(
            key="wl_default_watchlist",
            label="Default Watchlist",
            summary="defaultWatchlist",
            type="text",
            group="Lists",
            help="Watchlist opened when none is named.",
        ),
        read_only("engineVersion", "Engine Version"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.RLock()
        self._watchlists: dict[str, dict] = {
            DEFAULT_WATCHLIST_ID: {
                "id": DEFAULT_WATCHLIST_ID,
                "name": "My Stocks",
                "type": "personal",
                "symbols": [],
                "createdAt": time.time(),
                "updatedAt": time.time(),
            }
        }
        self._ltp_cache: dict[str, dict] = {}  # token -> {ltp, timestamp, symbol}
        self._update_count = 0
        self._tick_count = 0

    async def _on_start(self) -> None:
        self._subscriber_queue = await get_event_bus().subscribe([EngineEvents.TICK_VALIDATED])
        self._listener_task = asyncio.create_task(self._listen_loop())
        self.set_dependencies(["connection_manager", "search_engine"])
        self.set_config_summary({
            "defaultWatchlist": _default_watchlist(),
            "engineVersion": "2.0.0",
        })
        logger.info("[WATCHLIST] engine started")

    async def _on_stop(self) -> None:
        task = getattr(self, "_listener_task", None)
        if task:
            task.cancel()
            try:
                await task
            except Exception:
                pass
        q = getattr(self, "_subscriber_queue", None)
        if q:
            await get_event_bus().unsubscribe(q)
        logger.info("[WATCHLIST] engine stopped")

    async def _listen_loop(self) -> None:
        q = getattr(self, "_subscriber_queue", None)
        if not q:
            return
        while True:
            try:
                event = await q.get()
                tick = event.get("data", {}) or {}
                token = tick.get("instrumentToken") or tick.get("token", "")
                if token:
                    self._tick_count += 1
                    self._ltp_cache[str(token)] = {
                        "ltp": tick.get("ltp") or tick.get("lastPrice"),
                        "timestamp": time.time(),
                        "symbol": tick.get("symbol", ""),
                    }
                    self.set_metric("tickCount", self._tick_count)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Watchlist management
    # ------------------------------------------------------------------
    def create_watchlist(self, name: str, wl_type: str = "personal", watchlist_id: str | None = None) -> dict:
        name = (name or "").strip()
        if not name:
            return {"ok": False, "error": "name required"}
        wl_id = watchlist_id or re_slug(name)
        with self._lock:
            if wl_id in self._watchlists:
                return {"ok": False, "error": "already exists"}
            entry = {"id": wl_id, "name": name, "type": wl_type, "symbols": [],
                     "createdAt": time.time(), "updatedAt": time.time()}
            self._watchlists[wl_id] = entry
        self._bump_update()
        return {"ok": True, "watchlist": self._public_watchlist(entry)}

    def rename_watchlist(self, watchlist_id: str, name: str) -> dict:
        with self._lock:
            wl = self._watchlists.get(watchlist_id)
            if not wl:
                return {"ok": False, "error": "not found"}
            wl["name"] = (name or "").strip() or wl["name"]
            wl["updatedAt"] = time.time()
        self._bump_update()
        return {"ok": True, "watchlist": self._public_watchlist(wl)}

    def delete_watchlist(self, watchlist_id: str) -> dict:
        if watchlist_id == DEFAULT_WATCHLIST_ID:
            return {"ok": False, "error": "cannot delete default watchlist"}
        with self._lock:
            removed = self._watchlists.pop(watchlist_id, None)
        if not removed:
            return {"ok": False, "error": "not found"}
        self._bump_update()
        return {"ok": True}

    def add_stock(self, watchlist_id: str, symbol: str, token: str, **kwargs) -> dict:
        token = str(token or "")
        if not token:
            return {"ok": False, "error": "token required"}
        with self._lock:
            wl = self._watchlists.setdefault(watchlist_id, {
                "id": watchlist_id, "name": watchlist_id, "type": "personal",
                "symbols": [], "createdAt": time.time(), "updatedAt": time.time(),
            })
            if any(str(s.get("token")) == token for s in wl["symbols"]):
                return {"ok": False, "error": "already exists"}
            entry = {
                "symbol": (symbol or "").upper(),
                "token": token,
                "exchange": kwargs.get("exchange") or "nse_cm",
                "exchangeSegment": kwargs.get("exchangeSegment") or kwargs.get("exchange") or "nse_cm",
                "tradingSymbol": kwargs.get("tradingSymbol") or "",
                "companyName": kwargs.get("companyName") or kwargs.get("name") or "",
                "isin": kwargs.get("isin") or "",
                "order": len(wl["symbols"]),
                "addedAt": time.time(),
            }
            wl["symbols"].append(entry)
            wl["updatedAt"] = time.time()
        self._bump_update()
        return {"ok": True, "entry": entry}

    def remove_stock(self, watchlist_id: str, token: str) -> dict:
        token = str(token or "")
        with self._lock:
            wl = self._watchlists.get(watchlist_id)
            if not wl:
                return {"ok": False, "error": "not found"}
            before = len(wl["symbols"])
            wl["symbols"] = [s for s in wl["symbols"] if str(s.get("token")) != token]
            removed = before > len(wl["symbols"])
            if removed:
                wl["updatedAt"] = time.time()
        if removed:
            self._bump_update()
        return {"ok": removed}

    def reorder(self, watchlist_id: str, tokens: list[str]) -> dict:
        with self._lock:
            wl = self._watchlists.get(watchlist_id)
            if not wl:
                return {"ok": False, "error": "not found"}
            order = {str(t): i for i, t in enumerate(tokens or [])}
            for entry in wl["symbols"]:
                entry["order"] = order.get(str(entry.get("token")), entry.get("order", 0))
            wl["symbols"].sort(key=lambda s: s.get("order", 0))
            wl["updatedAt"] = time.time()
        self._bump_update()
        return {"ok": True}

    def get_watchlist(self, watchlist_id: str = DEFAULT_WATCHLIST_ID) -> list[dict]:
        with self._lock:
            wl = self._watchlists.get(watchlist_id)
            return [dict(s) for s in wl["symbols"]] if wl else []

    def list_watchlists(self) -> list[str]:
        with self._lock:
            return list(self._watchlists.keys())

    def list_watchlist_meta(self) -> list[dict]:
        with self._lock:
            return [self._public_watchlist(wl) for wl in self._watchlists.values()]

    def _public_watchlist(self, wl: dict) -> dict:
        return {"id": wl["id"], "name": wl["name"], "type": wl["type"],
                "count": len(wl["symbols"]), "updatedAt": wl["updatedAt"]}

    # ------------------------------------------------------------------
    # Connection Manager contract
    # ------------------------------------------------------------------
    def desired_subscriptions(self, watchlist_id: str | None = None) -> list[dict]:
        """Canonical required-subscription set for the Connection Manager.

        The engine does not subscribe to the broker itself; it publishes the
        symbols/tokens the live layer must deliver.
        """
        with self._lock:
            if watchlist_id:
                lists = [self._watchlists.get(watchlist_id)] if self._watchlists.get(watchlist_id) else []
            else:
                lists = list(self._watchlists.values())
        seen: set[str] = set()
        out: list[dict] = []
        for wl in lists:
            for s in wl["symbols"]:
                token = str(s.get("token"))
                if token in seen:
                    continue
                seen.add(token)
                out.append({"symbol": s.get("symbol"), "exchange": s.get("exchange"),
                            "token": token, "exchangeSegment": s.get("exchangeSegment")})
        return out

    def active_tokens(self) -> set[str]:
        return {str(s.get("token")) for wl in self._watchlists.values() for s in wl["symbols"]}

    # ------------------------------------------------------------------
    # Live card model + metrics
    # ------------------------------------------------------------------
    def _latest_tick(self, token: str) -> Optional[dict]:
        try:
            from services import tick_buffer
            return tick_buffer.get_latest_ticks().get(str(token))
        except Exception:
            return None

    def _session_active(self) -> bool:
        """Feed-session liveness for cards that have no tick yet.

        The card's ``ltp`` comes from the tick buffer, which is fed by the
        *scheduled broker* session (Kotak) -- not by the order-routing
        terminal. Reading only ``session_manager.snapshot()`` reported the
        managed terminal, so a Dummy terminal made every data card show
        DISCONNECTED while the real feed was streaming. Prefer the real
        Kotak session and fall back to the managed terminal session.
        """
        try:
            from auth.kotak_client import kotak_session
            if kotak_session.session_active:
                return True
        except Exception:
            pass
        try:
            from services.session.session_manager import session_manager
            snap = session_manager.snapshot()
            return bool(snap.get("active")) or bool(session_manager.is_active())
        except Exception:
            return False

    def _status_for(self, ltp: Optional[float], age: Optional[float]) -> str:
        if ltp is None:
            return CARD_STATUS_CONNECTING if self._session_active() else CARD_STATUS_DISCONNECTED
        if age is not None and age > STALE_AFTER_SECONDS:
            return CARD_STATUS_STALE
        return CARD_STATUS_LIVE

    def card_for_token(self, token: str, entry: dict | None = None) -> dict:
        """Stable normalized stock-card model (docs §6)."""
        token = str(token)
        if entry is None:
            for s in self.get_watchlist(DEFAULT_WATCHLIST_ID):
                if str(s.get("token")) == token:
                    entry = s
                    break
        entry = entry or {}
        latest = self._latest_tick(token) or {}
        ltp = _to_float(latest.get("ltp"))
        if ltp is None:
            cached = self._ltp_cache.get(token)
            ltp = _to_float(cached.get("ltp")) if cached else None

        prev_close = _to_float(latest.get("prevClose") or latest.get("previousClose") or latest.get("close"))
        change = _to_float(latest.get("netChange"))
        change_pct = _to_float(latest.get("netChangePercent"))
        if change is None and ltp is not None and prev_close not in (None, 0):
            change = ltp - prev_close
        if change_pct is None and change is not None and prev_close not in (None, 0):
            change_pct = (change / prev_close) * 100.0

        five_min: Optional[float] = None
        ten_min: Optional[float] = None
        try:
            from services import tick_buffer
            momentum = tick_buffer.momentum_windows(token, ltp) or {}
            five_min = _to_float(momentum.get("5m"))
            ten_min = _to_float(momentum.get("10m"))
        except Exception:
            pass

        age = None
        received = latest.get("receivedAt")
        if isinstance(received, (int, float)):
            age = max(0.0, time.time() - float(received))
        elif isinstance(latest.get("timestamp"), (int, float)):
            age = max(0.0, time.time() - float(latest["timestamp"]))

        depth = latest.get("depth") or {}
        buy_levels = depth.get("buy") or []
        sell_levels = depth.get("sell") or []
        bid = _to_float(latest.get("bp"))
        ask = _to_float(latest.get("sp"))
        if bid is None and buy_levels and isinstance(buy_levels[0], dict):
            bid = _to_float(buy_levels[0].get("price"))
        if ask is None and sell_levels and isinstance(sell_levels[0], dict):
            ask = _to_float(sell_levels[0].get("price"))
        spread = (ask - bid) if (ask is not None and bid is not None) else None

        last_tick = latest.get("timestamp") or latest.get("brokerUpdateTimestamp")
        if isinstance(last_tick, (int, float)):
            last_tick = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(float(last_tick)))

        return {
            "symbol": entry.get("symbol") or latest.get("symbol") or "",
            "tradingSymbol": entry.get("tradingSymbol") or "",
            "companyName": entry.get("companyName") or "",
            "token": token,
            "exchange": entry.get("exchange") or "nse_cm",
            "exchangeSegment": entry.get("exchangeSegment") or entry.get("exchange") or "nse_cm",
            "ltp": ltp,
            "change": round(change, 4) if change is not None else None,
            "changePercent": round(change_pct, 4) if change_pct is not None else None,
            "volume": _to_float(latest.get("volume")),
            "bid": bid,
            "ask": ask,
            "spread": round(spread, 4) if spread is not None else None,
            "fiveMinPercent": round(five_min, 4) if five_min is not None else None,
            "tenMinPercent": round(ten_min, 4) if ten_min is not None else None,
            "lastTick": last_tick,
            "tickAgeSeconds": round(age, 1) if age is not None else None,
            "status": self._status_for(ltp, age),
        }

    def get_watchlist_with_ltp(self, watchlist_id: str = DEFAULT_WATCHLIST_ID) -> list[dict]:
        """Backward-compatible alias returning the normalized card model."""
        return self.get_cards(watchlist_id)

    def get_cards(self, watchlist_id: str = DEFAULT_WATCHLIST_ID) -> list[dict]:
        with self._lock:
            wl = self._watchlists.get(watchlist_id)
            symbols = [dict(s) for s in wl["symbols"]] if wl else []
        cards = [self.card_for_token(s.get("token"), s) for s in symbols]
        cards.sort(key=lambda c: (c.get("symbol") or ""))
        return cards

    # ------------------------------------------------------------------
    # Dynamic screening + ranking (docs §8-§10)
    # ------------------------------------------------------------------
    def _universe_entries(self, watchlist_id: str | None = None) -> list[dict]:
        with self._lock:
            if watchlist_id:
                wl = self._watchlists.get(watchlist_id)
                return [dict(s) for s in wl["symbols"]] if wl else []
            entries: list[dict] = []
            seen: set[str] = set()
            for wl in self._watchlists.values():
                for s in wl["symbols"]:
                    if str(s.get("token")) not in seen:
                        seen.add(str(s.get("token")))
                        entries.append(dict(s))
            return entries

    def dynamic_list(self, kind: str, watchlist_id: str | None = None,
                     limit: int = 20, universe: Optional[list[dict]] = None) -> list[dict]:
        """Rank the watchlist universe by a built-in dynamic rule."""
        spec = _DYNAMIC_LISTS.get(kind)
        if not spec:
            raise ValueError(f"unknown dynamic list: {kind}")
        entries = universe if universe is not None else self._universe_entries(watchlist_id)
        cards = [self.card_for_token(s.get("token"), s) for s in entries]
        metric = spec["metric"]
        cards = [c for c in cards if c.get(metric) is not None]
        if "min" in spec:
            cards = [c for c in cards if c[metric] >= spec["min"]]
        if "max" in spec:
            cards = [c for c in cards if c[metric] <= spec["max"]]
        cards.sort(key=lambda c: (
            -c[metric] if spec["desc"] else c[metric],
            c.get("symbol") or "",
        ))
        return cards[:max(1, int(limit))]

    def screen(self, rules: list[dict], watchlist_id: str | None = None,
               limit: int = 50, universe: Optional[list[dict]] = None) -> list[dict]:
        """Evaluate AND-combined rules against normalized cards (docs §9)."""
        entries = universe if universe is not None else self._universe_entries(watchlist_id)
        cards = [self.card_for_token(s.get("token"), s) for s in entries]
        out = []
        for card in cards:
            if self._matches(card, rules):
                out.append(card)
        out.sort(key=lambda c: (-(c.get("changePercent") or 0.0), c.get("symbol") or ""))
        return out[:max(1, int(limit))]

    @staticmethod
    def _matches(card: dict, rules: list[dict]) -> bool:
        for rule in rules or []:
            field = rule.get("field")
            op = rule.get("op", "gt")
            target = _to_float(rule.get("value"))
            actual = _to_float(card.get(field))
            if field not in card or actual is None or target is None or op not in _SUPPORTED_OPS:
                return False
            if op == "gt" and not actual > target:
                return False
            if op == "gte" and not actual >= target:
                return False
            if op == "lt" and not actual < target:
                return False
            if op == "lte" and not actual <= target:
                return False
            if op == "eq" and not actual == target:
                return False
            if op == "ne" and not actual != target:
                return False
        return True

    def dynamic_list_kinds(self) -> list[str]:
        return sorted(_DYNAMIC_LISTS.keys())

    # ------------------------------------------------------------------
    # Metrics / lifecycle
    # ------------------------------------------------------------------
    def _bump_update(self) -> None:
        self._update_count += 1
        self.set_metric("totalUpdates", self._update_count)

    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        with self._lock:
            total_stocks = sum(len(wl["symbols"]) for wl in self._watchlists.values())
            watchlist_count = len(self._watchlists)
        custom = base.setdefault("metrics", {}).setdefault("custom", {})
        custom["watchlistCount"] = watchlist_count
        custom["totalStocks"] = total_stocks
        custom["ltpCacheSize"] = len(self._ltp_cache)
        custom["tickCount"] = self._tick_count
        custom["activeTokens"] = len(self.active_tokens())
        return base


def re_slug(name: str) -> str:
    """Stable slug for a watchlist id."""
    out = []
    for ch in name.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in " -_":
            out.append("-")
    slug = "".join(out).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or str(int(time.time()))


# Module singleton
watchlist_engine = WatchlistEngine()
