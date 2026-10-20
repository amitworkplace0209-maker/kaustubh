"""Search Engine — central discovery layer for KDS.

Responsibilities (docs/engines/search-engine.md §32):

    Search Engine = Find + Rank + Present + Route.

The engine finds and ranks instruments and other approved project entities
(pages, features, actions, watchlists), deduplicates results by canonical
identity, shapes them for the UI, and enriches stock results with canonical
live market state.

It never opens a broker WebSocket, never executes orders, never fabricates
margin, and never owns watchlists or Market Watch rankings. Live values come
from the canonical tick store (``services.tick_buffer``) which is fed by the
WebSocket Engine. 1-Qty margin is supplied by an external authoritative
provider (set at startup); when unavailable it is reported as unavailable —
never guessed from leverage.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from core.engines.engine_config import ConfigField, read_only
from core.engines.engine_base import EngineBase, EngineState, EngineHealth, EngineCategory

logger = logging.getLogger("app.search_engine")

# Live state older than this is surfaced as STALE rather than LIVE.
LIVE_STALE_SECONDS = 30.0

# Hard query bounds (docs/engines/search-engine.md §21).
MAX_QUERY_LENGTH = 64
DEFAULT_LIMIT = 10
MAX_LIMIT = 50

_ALLOWED_SCOPES = ("stocks", "pages", "features", "actions", "watchlists")

# Documented error codes (docs/engines/search-engine.md §21).
ERR_EMPTY_QUERY = "EMPTY_QUERY"
ERR_INVALID_SCOPE = "SEARCH_INVALID_SCOPE"
ERR_INDEX_UNAVAILABLE = "SEARCH_INDEX_UNAVAILABLE"

# Margin status vocabulary (docs/engines/search-engine.md §15).
MARGIN_AVAILABLE = "AVAILABLE"
MARGIN_UNAVAILABLE = "UNAVAILABLE"
MARGIN_STALE = "STALE"
MARGIN_REQUIRES_ORDER_CONTEXT = "REQUIRES_ORDER_CONTEXT"

_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^a-z0-9 &._-]")


def normalize_query(query: str | None) -> dict:
    """Normalize an arbitrary query string into a searchable form.

    Returns ``{"original", "normalized", "tokens", "empty"}``. Original input
    is preserved for display; matching uses the normalized/token forms.
    """
    original = query if isinstance(query, str) else ""
    trimmed = original.strip()[:MAX_QUERY_LENGTH]
    lowered = trimmed.lower()
    cleaned = _PUNCT_RE.sub(" ", lowered)
    normalized = _WS_RE.sub(" ", cleaned).strip()
    tokens = [t for t in normalized.split(" ") if t]
    return {
        "original": trimmed,
        "normalized": normalized,
        "tokens": tokens,
        "empty": len(normalized) == 0,
    }


class SearchEngine(EngineBase):
    engine_id = "search_engine"
    engine_name = "Search Engine"
    engine_category = EngineCategory.CORE
    engine_version = "2.0.0"

    # The Search Engine's config summary is entirely computed output (index size,
    # scopes). There is no operator knob to change, so the settings form shows it
    # as read-only facts rather than offering inputs that would do nothing.
    config_fields = (
        read_only("instrumentCount", "Instruments Indexed"),
        read_only("indexed", "Index Ready"),
        read_only("scopes", "Indexed Scopes"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._instruments: list[dict] = []
        self._index: dict[str, list[int]] = {}  # lowercase token -> list of indices
        self._ltp_cache: dict[str, dict] = {}  # token -> {ltp, timestamp}
        self._built = False
        self._search_count = 0
        self._zero_result_count = 0
        self._stale_rejected = 0
        self._margin_provider: Optional[Callable[[dict], Any]] = None
        # Extensible providers: scope -> callable(query, limit) -> list[dict]
        self._providers: dict[str, Callable[[str, int], list[dict]]] = {
            s: (lambda q, n: []) for s in _ALLOWED_SCOPES
        }

    async def _on_start(self) -> None:
        self._load_instruments()
        self.set_dependencies(["instrument_cache", "websocket_engine"])
        self.set_config_summary({
            "instrumentCount": len(self._instruments),
            "indexed": self._built,
            "scopes": list(_ALLOWED_SCOPES),
        })
        logger.info("[SEARCH] engine started with %d instruments", len(self._instruments))

    async def _on_stop(self) -> None:
        self._instruments.clear()
        self._index.clear()
        self._ltp_cache.clear()
        logger.info("[SEARCH] engine stopped")

    # ------------------------------------------------------------------
    # Provider registry (extensible per doc §6/§39)
    # ------------------------------------------------------------------
    def register_provider(self, scope: str, provider: Callable[[str, int], list[dict]]) -> None:
        """Register a search provider for a scope (stocks/pages/features/...)."""
        if scope not in _ALLOWED_SCOPES:
            raise ValueError(f"unsupported scope: {scope}")
        self._providers[scope] = provider

    def set_margin_provider(self, provider: Optional[Callable[[dict], Any]]) -> None:
        """Register the authoritative 1-Qty margin provider.

        The provider receives the stock result dict and must return either a
        numeric margin, or a dict ``{"margin", "status"}``. It is never used to
        fabricate a value — ``None`` means unavailable.
        """
        self._margin_provider = provider

    def _load_instruments(self) -> None:
        """Load instruments from the instrument cache.

        Path 1 (preferred): pull the already-loaded in-memory list from the
        InstrumentCache singleton (same-process, no disk I/O).
        Path 2 (fallback): read the persisted ``data/instrument_master.json``
        which stores a *dict* ``{"instruments": [...]}``, not a plain list.
        """
        try:
            from services.instrument_cache import instrument_cache
            cached = instrument_cache.get_instruments()
            if cached:
                self._instruments = list(cached)
        except (ImportError, Exception):
            pass

        if not self._instruments:
            try:
                import json
                from pathlib import Path
                data_path = Path(__file__).resolve().parent.parent.parent / "data" / "instrument_master.json"
                if data_path.exists():
                    with open(data_path) as f:
                        payload = json.load(f)
                    if isinstance(payload, dict):
                        self._instruments = payload.get("instruments", [])
                    elif isinstance(payload, list):
                        self._instruments = payload
            except Exception:
                pass

        self._build_index()

    def _symbol(self, inst: dict) -> str:
        return str(inst.get("symbol") or inst.get("pSymbolName") or inst.get("trdSym") or "").upper()

    def _trd_symbol(self, inst: dict) -> str:
        return str(inst.get("tradingSymbol") or inst.get("pTrdSymbol") or inst.get("trdSym") or "").upper()

    def _name(self, inst: dict) -> str:
        return str(inst.get("name") or inst.get("companyName") or inst.get("pDesc") or "").upper()

    def _token(self, inst: dict) -> str:
        return str(inst.get("token") or inst.get("instrumentToken") or inst.get("pSymbol") or "")

    def _build_index(self) -> None:
        """Build search index from instruments."""
        self._index.clear()
        for i, inst in enumerate(self._instruments):
            symbol = self._symbol(inst)
            name = self._name(inst)
            token = self._token(inst)
            isin = str(inst.get("isin") or "").upper()

            for term in {symbol, name, token, isin}:
                if term:
                    self._index.setdefault(term, []).append(i)

            # Index individual words for partial/company-name matching.
            for word in symbol.split():
                if len(word) >= 2:
                    self._index.setdefault(word, []).append(i)
            for word in name.split():
                if len(word) >= 2:
                    self._index.setdefault(word, []).append(i)

        self._built = True

    # ------------------------------------------------------------------
    # Ranking (docs/engines/search-engine.md §8)
    # ------------------------------------------------------------------
    def _score(self, inst: dict, q: str) -> Optional[tuple]:
        """Deterministic rank score. Lower is better; None = no match."""
        q = q.upper()
        symbol = self._symbol(inst)
        trd = self._trd_symbol(inst)
        name = self._name(inst)
        token = self._token(inst).upper()
        isin = str(inst.get("isin") or "").upper()

        if symbol == q:
            return (0, 0, symbol)
        if trd == q:
            return (1, 0, symbol)
        if symbol.startswith(q):
            return (2, len(symbol), symbol)
        if name == q:
            return (3, 0, symbol)
        if name.startswith(q):
            return (4, len(name), symbol)
        if q and (q == token or q == isin):
            return (5, 0, symbol)
        if q and q in symbol:
            return (6, symbol.index(q), symbol)
        if q and q in name:
            return (7, name.index(q), symbol)
        return None

    def search(self, query: str, exchange: str = "nse_cm", limit: int = 20) -> list[dict]:
        """Search instruments by symbol, name, or token (ranked, deduplicated)."""
        if not query or not isinstance(query, str) or not query.strip():
            return []

        nq = normalize_query(query)
        if nq["empty"]:
            return []

        q = nq["normalized"].replace(" ", "").upper()
        q_phrase = nq["normalized"].upper()

        self._search_count += 1
        self.set_metric("totalSearches", self._search_count)

        scored: list[tuple[tuple, int]] = []
        for idx, inst in enumerate(self._instruments):
            score = None
            # Try the compact form first (handles "reliance industries").
            for candidate in (q, q_phrase):
                if not candidate:
                    continue
                s = self._score(inst, candidate)
                if s is not None and (score is None or s < score):
                    score = s
            if score is not None:
                scored.append((score, idx))

        scored.sort(key=lambda pair: pair[0])

        results: list[dict] = []
        seen: set = set()
        for _score, idx in scored:
            inst = self._instruments[idx]
            key = (str(inst.get("exchangeSegment") or inst.get("exchange") or ""), self._token(inst))
            if key in seen:
                continue
            seen.add(key)
            results.append(self._format_instrument(inst))
            if len(results) >= limit:
                break

        if not results:
            self._zero_result_count += 1
        return results

    def get_related(self, symbol: str, limit: int = 10) -> list[dict]:
        """Find related stocks (same sector/index, similar name prefix)."""
        symbol_upper = symbol.upper()
        related: list[dict] = []
        seen: set = set()

        prefix = symbol_upper[:3] if len(symbol_upper) >= 3 else symbol_upper
        for inst in self._instruments:
            sym = self._symbol(inst)
            if sym.startswith(prefix) and sym != symbol_upper and sym not in seen:
                seen.add(sym)
                related.append(self._format_instrument(inst))
                if len(related) >= limit:
                    break

        return related

    # ------------------------------------------------------------------
    # Canonical live state (docs §4/§19)
    # ------------------------------------------------------------------
    def _live_state(self, token: str) -> Optional[dict]:
        """Latest canonical tick for a token from the central tick store."""
        token = str(token)
        try:
            from services import tick_buffer
            latest = tick_buffer.get_latest_ticks().get(token)
        except Exception:
            latest = None
        if latest:
            return latest
        # Fallback to the lightweight LTP cache (kept for compatibility).
        return None

    @staticmethod
    def _tick_timestamp(raw: dict) -> Any:
        """Best available tick timestamp from a canonical tick document.

        ``ws_socket.engine.storage.to_storage_doc`` writes ``ts`` and
        ``receivedAt`` as timezone-aware ``datetime`` objects; older callers and
        tests inject numeric epoch values. Both are accepted here so freshness is
        computed from the same data the store actually holds.
        """
        for key in ("receivedAt", "ts", "timestamp", "lastUpdateTime"):
            value = raw.get(key)
            if value is not None and value != "":
                return value
        return None

    @staticmethod
    def _tick_age_seconds(raw: dict, now: float) -> Optional[float]:
        """Age in seconds of the tick's newest timestamp, or ``None``.

        Handles ``datetime`` (production), numeric epoch seconds, numeric epoch
        milliseconds and ISO-8601 strings. ``None`` means the tick carries no
        usable clock, which is reported honestly rather than assumed fresh.
        """
        for key in ("receivedAt", "ts", "timestamp", "lastUpdateTime"):
            value = raw.get(key)
            if value is None or value == "" or isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                seconds = float(value)
                if seconds > 1e11:  # epoch milliseconds
                    seconds /= 1000.0
                return max(0.0, now - seconds)
            if isinstance(value, datetime):
                ref = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
                return max(0.0, now - ref.timestamp())
            if isinstance(value, str):
                try:
                    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                except ValueError:
                    continue
                ref = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
                return max(0.0, now - ref.timestamp())
        return None

    @staticmethod
    def _iso(value: Any) -> Optional[str]:
        """Render a tick timestamp as an ISO-8601 UTC string for the contract."""
        if value is None or value == "":
            return None
        if isinstance(value, datetime):
            ref = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            return ref.astimezone(timezone.utc).isoformat()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            seconds = float(value)
            if seconds > 1e11:
                seconds /= 1000.0
            try:
                return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
            except (OverflowError, OSError, ValueError):
                return None
        if isinstance(value, str):
            return value
        return None

    def _shape_live(self, raw: dict, fallback_ltp: Optional[float]) -> dict:
        """Shape a raw canonical tick into the documented live-state fields."""
        now = time.time()

        def _f(value: Any) -> Optional[float]:
            try:
                if value is None or value == "":
                    return None
                f = float(value)
                return f if f == f else None
            except (TypeError, ValueError):
                return None

        ltp = _f(raw.get("ltp"))
        if ltp is None:
            ltp = fallback_ltp
        prev_close = _f(raw.get("prevClose") or raw.get("previousClose") or raw.get("close"))
        # The canonical storage document uses ``change``/``changePercent``; the
        # normalized feed surface uses ``netChange``/``netChangePercent``. Read
        # both so the broker's own figures win over a local recomputation.
        change = _f(raw.get("change") if raw.get("change") is not None else raw.get("netChange"))
        change_pct = _f(
            raw.get("changePercent")
            if raw.get("changePercent") is not None
            else raw.get("netChangePercent")
        )
        if change is None and ltp is not None and prev_close not in (None, 0):
            change = ltp - prev_close
        if change_pct is None and change is not None and prev_close not in (None, 0):
            change_pct = (change / prev_close) * 100.0

        # Freshness: measured from the newest clock the tick actually carries.
        age = self._tick_age_seconds(raw, now)
        tick_ts = self._tick_timestamp(raw)

        if ltp is None:
            status = "UNAVAILABLE"
        elif age is not None and age > LIVE_STALE_SECONDS:
            status = "STALE"
        elif age is None:
            # A price with no usable timestamp cannot be claimed as live.
            status = "STALE"
        else:
            status = "LIVE"

        depth = raw.get("depth") or {}
        buy_levels = depth.get("buy") or raw.get("buy") or []
        sell_levels = depth.get("sell") or raw.get("sell") or []
        bid = _f(buy_levels[0].get("price")) if buy_levels and isinstance(buy_levels[0], dict) else None
        ask = _f(sell_levels[0].get("price")) if sell_levels and isinstance(sell_levels[0], dict) else None
        spread = (ask - bid) if (ask is not None and bid is not None) else None

        # Circuit bands are published on the tick as ``*_circuit_limit``; they are
        # broker data and are never derived from LTP.
        upper_circuit = _f(
            raw.get("upper_circuit_limit") or raw.get("upperCircuit") or raw.get("upper_circuit")
        )
        lower_circuit = _f(
            raw.get("lower_circuit_limit") or raw.get("lowerCircuit") or raw.get("lower_circuit")
        )
        source = raw.get("source") or raw.get("feed_type") or "tick_buffer"

        return {
            "ltp": ltp,
            "prevClose": prev_close,
            "change": round(change, 4) if change is not None else None,
            "changePct": round(change_pct, 4) if change_pct is not None else None,
            "volume": _f(raw.get("volume")),
            "bid": bid,
            "ask": ask,
            "spread": round(spread, 4) if spread is not None else None,
            "upperCircuit": upper_circuit,
            "lowerCircuit": lower_circuit,
            "timestamp": self._iso(tick_ts),
            "tickAgeSeconds": round(age, 1) if age is not None else None,
            "liveStatus": status,
            "dataStatus": status,
            "source": source,
        }

    def _fallback_ltp(self, token: str) -> Optional[float]:
        cached = self._ltp_cache.get(str(token))
        if cached and (time.time() - cached.get("timestamp", 0)) < 60:
            return cached.get("ltp")
        return None

    def _enrich_stock(self, result: dict, *, with_margin: bool) -> dict:
        token = result.get("token", "")
        raw = self._live_state(token)
        if raw:
            live = self._shape_live(raw, self._fallback_ltp(token))
        else:
            fallback = self._fallback_ltp(token)
            live = {
                "ltp": fallback,
                "prevClose": None, "change": None, "changePct": None,
                "volume": None, "bid": None, "ask": None, "spread": None,
                "upperCircuit": None, "lowerCircuit": None,
                "timestamp": None, "tickAgeSeconds": None,
                "liveStatus": "STALE" if fallback is not None else "UNAVAILABLE",
                "dataStatus": "STALE" if fallback is not None else "UNAVAILABLE",
                "source": "ltp_cache" if fallback is not None else "unavailable",
            }
        result.update(live)

        # Margin is authoritative-only. Absent provider => unavailable. The reason
        # and source distinguish "not asked for" from "asked for but unavailable"
        # without widening the documented AVAILABLE/UNAVAILABLE/STALE vocabulary.
        margin_cell = {
            "oneQtyMargin": None,
            "marginStatus": MARGIN_UNAVAILABLE,
            "marginSource": "not_requested" if not with_margin else "unavailable",
            "marginReason": None if with_margin else "margin not requested for this search",
        }
        if with_margin and self._margin_provider is not None:
            try:
                value = self._margin_provider(result)
                if isinstance(value, dict):
                    m = value.get("margin")
                    status = value.get("status") or (MARGIN_AVAILABLE if m is not None else MARGIN_UNAVAILABLE)
                    margin_cell = {
                        "oneQtyMargin": m,
                        "marginStatus": status,
                        "marginSource": value.get("source") or "margin_provider",
                        "marginReason": value.get("reason"),
                    }
                elif value is not None:
                    margin_cell = {
                        "oneQtyMargin": float(value),
                        "marginStatus": MARGIN_AVAILABLE,
                        "marginSource": "margin_provider",
                        "marginReason": None,
                    }
                else:
                    margin_cell = {
                        "oneQtyMargin": None,
                        "marginStatus": MARGIN_UNAVAILABLE,
                        "marginSource": "margin_provider",
                        "marginReason": "provider returned no margin",
                    }
            except Exception as exc:
                self.record_error("margin_provider_failed", str(exc))
                margin_cell = {
                    "oneQtyMargin": None,
                    "marginStatus": MARGIN_UNAVAILABLE,
                    "marginSource": "margin_provider",
                    "marginReason": f"margin provider error: {exc}",
                }
        elif with_margin:
            margin_cell["marginReason"] = "no authoritative margin provider registered"
        result.update(margin_cell)
        return result

    def update_ltp(self, token: str, ltp: float) -> None:
        """Update LTP cache (called by Feature Engine / tick consumer)."""
        self._ltp_cache[str(token)] = {"ltp": ltp, "timestamp": time.time()}

    def get_ltp(self, token: str) -> Optional[float]:
        """Get cached LTP for a token."""
        cached = self._ltp_cache.get(str(token))
        if cached:
            age = time.time() - cached.get("timestamp", 0)
            if age < 60:
                return cached.get("ltp")
        return None

    def search_with_ltp(self, query: str, limit: int = 20) -> list[dict]:
        """Search results enriched with cached LTP."""
        results = self.search(query, limit=limit)
        for r in results:
            token = r.get("token", "")
            ltp = self.get_ltp(token)
            r["ltp"] = ltp
            r["ltpSource"] = "live" if ltp is not None else "unavailable"
        return results

    # ------------------------------------------------------------------
    # Scoped/target search (docs §14)
    # ------------------------------------------------------------------
    def search_scoped(
        self,
        query: str,
        scopes: Optional[list[str]] = None,
        limit: int = DEFAULT_LIMIT,
        cursor: int = 0,
        *,
        with_live: bool = True,
        with_margin: bool = False,
    ) -> dict:
        """Execute the documented multi-scope search contract.

        Returns ``{query, normalized, results, total, hasMore, nextCursor,
        scopes, tookMs, errorCode}``.
        """
        started = time.monotonic()
        nq = normalize_query(query)
        if nq["empty"]:
            return {
                "query": nq["original"], "normalized": nq["normalized"],
                "results": [], "total": 0, "hasMore": False, "nextCursor": None,
                "scopes": [], "tookMs": 0.0, "errorCode": ERR_EMPTY_QUERY,
            }

        if not self._built and not self._instruments:
            self._load_instruments()

        requested = list(scopes) if scopes else list(_ALLOWED_SCOPES)
        active_scopes = [s for s in requested if s in _ALLOWED_SCOPES]
        if not active_scopes:
            # A caller asked only for scopes that do not exist. Say so instead of
            # silently answering a different question.
            return {
                "query": nq["original"], "normalized": nq["normalized"],
                "results": [], "total": 0, "hasMore": False, "nextCursor": None,
                "scopes": [], "tookMs": round((time.monotonic() - started) * 1000, 2),
                "errorCode": ERR_INVALID_SCOPE,
            }

        if "stocks" in active_scopes and not self._instruments:
            # The canonical index failed to load. Results would be empty for a
            # reason the caller must be able to distinguish from "no match".
            return {
                "query": nq["original"], "normalized": nq["normalized"],
                "results": [], "total": 0, "hasMore": False, "nextCursor": None,
                "scopes": active_scopes,
                "tookMs": round((time.monotonic() - started) * 1000, 2),
                "errorCode": ERR_INDEX_UNAVAILABLE,
            }

        limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
        cursor = max(0, int(cursor or 0))
        # Pull one extra combined page so hasMore is honest.
        fetch_limit = cursor + limit + 1

        combined: list[dict] = []
        for scope in active_scopes:
            try:
                if scope == "stocks":
                    provider = self._providers["stocks"]
                    rows = provider(nq["normalized"], fetch_limit) or self.search(
                        nq["normalized"], limit=fetch_limit
                    )
                else:
                    rows = self._providers[scope](nq["normalized"], fetch_limit) or []
            except Exception as exc:
                self.record_error(f"provider_failed:{scope}", str(exc))
                rows = []
            for row in rows:
                row = dict(row)
                row.setdefault("type", scope[:-1] if scope.endswith("s") else scope)
                if scope == "stocks":
                    row["type"] = "stock"
                    if with_live:
                        row = self._enrich_stock(row, with_margin=with_margin)
                elif with_margin is False:
                    pass
                combined.append(row)

        # Dedupe by canonical identity.
        deduped: list[dict] = []
        seen: set = set()
        for row in combined:
            key = row.get("id") or f"{row.get('type')}:{row.get('exchange') or ''}:{row.get('token') or row.get('symbol') or ''}"
            if key in seen:
                continue
            seen.add(key)
            deduped.append(row)

        total = len(deduped)
        page = deduped[cursor:cursor + limit]
        has_more = (cursor + limit) < total
        next_cursor = str(cursor + limit) if has_more else None

        took_ms = round((time.monotonic() - started) * 1000, 2)
        self.set_metric("lastSearchTookMs", took_ms)
        self.set_metric("zeroResultCount", self._zero_result_count)
        self.set_metric("staleRejected", self._stale_rejected)

        if not page:
            self._zero_result_count += 1

        return {
            "query": nq["original"],
            "normalized": nq["normalized"],
            "results": page,
            "total": total,
            "hasMore": has_more,
            "nextCursor": next_cursor,
            "scopes": active_scopes,
            "tookMs": took_ms,
            "errorCode": None,
        }

    def reject_stale(self, request_id: int | float, current_id: int | float) -> bool:
        """Stale-query protection helper for callers (§16).

        Returns True when ``request_id`` is older than the latest accepted id,
        meaning the response must be discarded.
        """
        stale = request_id < current_id
        if stale:
            self._stale_rejected += 1
        return stale

    def _format_instrument(self, inst: dict) -> dict:
        symbol = inst.get("symbol") or inst.get("pSymbolName") or inst.get("trdSym") or ""
        token = self._token(inst)
        exchange = inst.get("exchange") or "NSE"
        if isinstance(exchange, str) and exchange.lower() == "nse_cm":
            exchange = "NSE"
        elif isinstance(exchange, str) and exchange.lower() == "bse_cm":
            exchange = "BSE"
        return {
            "type": "stock",
            "id": f"{exchange}:{token}" if token else f"{exchange}:{symbol}",
            "symbol": symbol,
            "tradingSymbol": inst.get("tradingSymbol") or inst.get("pTrdSymbol") or inst.get("trdSym") or "",
            "name": inst.get("name") or inst.get("companyName") or inst.get("pDesc") or "",
            "token": token,
            "exchange": exchange,
            "exchangeSegment": inst.get("exchangeSegment") or inst.get("pExchSeg") or inst.get("exSeg") or "",
            "instrumentType": inst.get("instrumentType") or inst.get("pInstType") or inst.get("instType") or "",
            "series": inst.get("series") or inst.get("pSeries") or "",
            "lotSize": inst.get("lotSize", 1),
            "tickSize": inst.get("tickSize", 0.05),
            "isin": inst.get("isin") or "",
        }

    def instrument_count(self) -> int:
        return len(self._instruments)

    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        base["metrics"]["custom"]["instrumentCount"] = len(self._instruments)
        base["metrics"]["custom"]["indexedTerms"] = len(self._index)
        base["metrics"]["custom"]["searchCount"] = self._search_count
        base["metrics"]["custom"]["zeroResultCount"] = self._zero_result_count
        base["metrics"]["custom"]["ltpCacheSize"] = len(self._ltp_cache)
        base["metrics"]["custom"]["staleRejected"] = self._stale_rejected
        return base


# Module singleton
search_engine = SearchEngine()
