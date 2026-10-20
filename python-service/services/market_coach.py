"""Market Coach Engine — maintains the market stock universe and identifies relevant stocks.

Fetches top stock list, maintains 600+ stock universe where configured,
integrates with Watchlist, prepares stocks for subscriptions, provides
market ranking/input to downstream systems.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

from core.engines.engine_base import EngineBase, EngineState, EngineHealth, EngineCategory
from core.engines.engine_config import ConfigField, read_only


def _mc_int(key: str, default: int) -> int:
    """Live Market Coach knob from the runtime settings bridge."""
    try:
        from services.runtime_settings import rt_int
        return rt_int(key, default)
    except Exception:
        return default

logger = logging.getLogger("app.market_coach")


class MarketCoachEngine(EngineBase):
    engine_id = "market_coach"
    engine_name = "Market Coach"
    engine_category = EngineCategory.MARKET_DATA
    engine_version = "1.0.0"

    config_fields = (
        ConfigField(
            key="mc_refresh_interval_seconds",
            label="Refresh Interval",
            summary="refreshInterval",
            type="number",
            min=10,
            max=3600,
            unit="s",
            group="Universe",
            help="How often the coach re-ranks its universe.",
        ),
        ConfigField(
            key="mc_universe_size",
            label="Universe Limit",
            summary="universeLimit",
            type="number",
            min=10,
            max=5000,
            group="Universe",
            help="Maximum instruments the coach tracks.",
        ),
        read_only("universeSize", "Universe Loaded"),
        read_only("topStocks", "Top Stocks Ranked"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._universe: list[dict] = []
        self._top_stocks: list[dict] = []
        self._rankings: dict[str, dict] = {}
        self._last_refresh: float = 0.0
        self._refresh_interval = _mc_int("mc_refresh_interval_seconds", 300)

    async def _on_start(self) -> None:
        self._load_universe()
        self.set_dependencies(["instrument_cache", "watchlist_engine"])
        self.refresh_config_summary()
        logger.info("[MARKET_COACH] engine started with %d instruments", len(self._universe))

    def refresh_config_summary(self) -> None:
        """Re-derive from the settings bridge so a change shows up at once."""
        self.set_config_summary({
            "universeSize": len(self._universe),
            "topStocks": len(self._top_stocks),
            "refreshInterval": _mc_int("mc_refresh_interval_seconds", self._refresh_interval),
            "universeLimit": _mc_int("mc_universe_size", 500),
        })

    async def _on_stop(self) -> None:
        self._universe.clear()
        self._top_stocks.clear()
        logger.info("[MARKET_COACH] engine stopped")

    def _load_universe(self) -> None:
        """Load stock universe from instrument master."""
        try:
            from services.instrument_cache import instrument_cache
            if instrument_cache and isinstance(instrument_cache, list):
                self._universe = [
                    inst for inst in instrument_cache
                    if (inst.get("instrumentType") or inst.get("instType", "")).upper() in ("EQ", "STE", "BE", "")
                ]
        except ImportError:
            pass

        if not self._universe:
            try:
                import json
                from pathlib import Path
                data_path = Path(__file__).resolve().parent.parent / "data" / "instrument_master.json"
                if data_path.exists():
                    with open(data_path) as f:
                        all_inst = json.load(f)
                    self._universe = [
                        inst for inst in all_inst
                        if (inst.get("instrumentType") or inst.get("instType", "")).upper() in ("EQ", "STE", "BE", "")
                    ]
            except Exception:
                pass

        self._last_refresh = time.time()

    def get_universe(self, limit: int = 600) -> list[dict]:
        return self._universe[:limit]

    def get_top_stocks(self, count: int = 50) -> list[dict]:
        return self._top_stocks[:count]

    def get_tokens_for_subscription(self) -> list[dict]:
        """Return instrument tokens needed for market subscriptions."""
        tokens = []
        for inst in self._universe:
            token = inst.get("token") or inst.get("instrumentToken")
            if token:
                tokens.append({
                    "instrumentToken": str(token),
                    "symbol": inst.get("symbol") or inst.get("trdSym", ""),
                    "exchangeSegment": inst.get("exchangeSegment") or inst.get("exSeg", "nse_cm"),
                })
        return tokens

    def search_universe(self, query: str, limit: int = 20) -> list[dict]:
        query_upper = query.upper()
        results = []
        for inst in self._universe:
            symbol = (inst.get("symbol") or inst.get("trdSym", "")).upper()
            name = (inst.get("name") or inst.get("companyName", "")).upper()
            if query_upper in symbol or query_upper in name:
                results.append({
                    "symbol": inst.get("symbol") or inst.get("trdSym", ""),
                    "name": inst.get("name") or inst.get("companyName", ""),
                    "token": str(inst.get("token") or inst.get("instrumentToken", "")),
                    "exchange": inst.get("exchange", "NSE"),
                })
                if len(results) >= limit:
                    break
        return results

    def needs_refresh(self) -> bool:
        return (time.time() - self._last_refresh) > self._refresh_interval

    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        base["metrics"]["custom"]["universeSize"] = len(self._universe)
        base["metrics"]["custom"]["topStocksCount"] = len(self._top_stocks)
        base["metrics"]["custom"]["lastRefreshAge"] = round(time.time() - self._last_refresh, 0) if self._last_refresh else None
        return base


# Module singleton
market_coach = MarketCoachEngine()
