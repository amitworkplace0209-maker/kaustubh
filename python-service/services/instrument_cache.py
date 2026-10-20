"""
In-memory instrument master cache for fast local search.

Loads the REAL NSE CM (cash-market) scrip master from the Kotak SDK once,
builds indexed lookup, and serves fast local search (<10ms).

Session-independence / persistence
-----------------------------------
The scrip master is downloaded through the Kotak SDK client, which only
exists during an active broker session. To keep the instrument master
searchable even when the session is inactive, every successful real download
is persisted to a local file (``data/instrument_master.json``). When no SDK
client is available, ``load()`` falls back to that persisted file (real data
downloaded earlier — never fabricated). Status exposes the true source so the
UI can explain LOADED / LOADING / FAILED / NOT_AVAILABLE honestly.

Only safe operational metadata is cached and returned: symbol, token, trading
symbol, company name, exchange segment, series, lot/tick size and ISIN.
Broker credentials and other .env secrets are never written or exposed.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import csv
import io
from typing import Any, Optional

import requests

from auth.kotak_client import kotak_session
from services import sanctioned_master

logger = logging.getLogger("instrument_cache")

_PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DATA_DIR = os.path.join(_PKG_DIR, "data")
_CACHE_FILE = os.path.join(_DATA_DIR, "instrument_master.json")


class InstrumentCache:
    """Thread-safe in-memory instrument cache with indexed search.

    Indexing preferences real NSE cash-market equities (``series``/``type``
    of ``EQ``, exchange ``nse_cm``) so a symbol resolves to its EQ instrument
    rather than a derivative row.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._instruments: list[dict] = []
        self._by_symbol: dict[str, dict] = {}
        self._by_token: dict[str, dict] = {}
        self._by_name_lower: dict[str, list[dict]] = {}
        self._by_isin: dict[str, dict] = {}
        self._loaded = False
        self._loading = False
        self._last_load_at: Optional[str] = None
        self._load_error: Optional[str] = None
        self._load_count = 0
        self._source: str = "none"

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def loading(self) -> bool:
        return self._loading

    @property
    def instrument_count(self) -> int:
        return len(self._instruments)

    @property
    def instruments(self) -> list[dict]:
        """Read-only snapshot of the loaded instrument list."""
        with self._lock:
            return list(self._instruments)

    def get_instruments(self) -> list[dict]:
        """Thread-safe access to the current instrument list (empty if not loaded)."""
        with self._lock:
            return list(self._instruments) if self._loaded else []

    @property
    def source(self) -> str:
        return self._source

    @property
    def last_load_at(self) -> Optional[str]:
        return self._last_load_at

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    # ------------------------------------------------------------------ #
    # Loading
    # ------------------------------------------------------------------ #
    def load(self) -> bool:
        """Load the instrument master.

        Path 1 (preferred, real): download the NSE CM scrip master CSV via the
        Kotak SDK client, index it and persist it locally.
        Path 2 (fallback, real): if no SDK client is available, load the last
        persisted real master from disk so search still works.
        """
        with self._lock:
            if self._loading:
                return False
            self._loading = True

        try:
            client = kotak_session.client
            if client:
                ok = self._download_and_index(client)
            else:
                ok = self._load_from_disk()
            return ok
        finally:
            with self._lock:
                self._loading = False

    def _download_and_index(self, client) -> bool:
        start = time.time()
        logger.info("Loading NSE CM instrument master from Kotak scrip master...")
        try:
            csv_url = client.scrip_master(exchange_segment="nse_cm")
            if not csv_url or not isinstance(csv_url, str):
                raise RuntimeError(f"Invalid scrip master URL: {csv_url}")
            logger.info("Downloading NSE CM scrip master CSV: %s", csv_url[:80])
            resp = requests.get(csv_url, timeout=30)
            resp.raise_for_status()
            reader = csv.DictReader(io.StringIO(resp.text))
            instruments = self._parse_rows(reader)
            if not instruments:
                raise RuntimeError("Scrip master CSV contained no parseable rows")
            self._index(instruments)
            self._persist()
            elapsed_ms = int((time.time() - start) * 1000)
            with self._lock:
                self._last_load_at = time.strftime("%Y-%m-%dT%H:%M:%S")
                self._load_error = None
                self._load_count += 1
                self._source = "kotak_scrip_master"
                self._loaded = True
            logger.info("Instrument cache loaded: %d instruments in %dms", len(instruments), elapsed_ms)
            return True
        except Exception as exc:
            with self._lock:
                self._load_error = str(exc)
            logger.error("Instrument cache download failed: %s", exc)
            return False

    def _load_from_disk(self) -> bool:
        try:
            if not os.path.exists(_CACHE_FILE):
                with self._lock:
                    self._load_error = (
                        "No SDK session and no persisted instrument master. "
                        "A broker login is required to download the NSE instrument master."
                    )
                logger.warning("Instrument cache: no persisted master available")
                return False
            with open(_CACHE_FILE, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
            instruments = payload.get("instruments", [])
            if not instruments:
                raise RuntimeError("Persisted instrument master is empty")
            self._index(instruments)
            with self._lock:
                self._last_load_at = payload.get("downloadedAt") or time.strftime("%Y-%m-%dT%H:%M:%S")
                self._load_error = None
                self._load_count += 1
                self._source = "cache_file"
                self._loaded = True
            logger.info(
                "Instrument cache loaded from disk: %d instruments (source=%s)",
                len(instruments), self._source,
            )
            return True
        except Exception as exc:
            with self._lock:
                self._load_error = str(exc)
            logger.error("Instrument cache disk load failed: %s", exc)
            return False

    @staticmethod
    def _series_of(row: dict) -> str:
        return (row.get("pSeries") or row.get("pGroup") or "").strip().upper()

    @property
    def depth_symbols(self) -> set[str]:
        return set(sanctioned_master.DEPTH_STOCKS)

    @property
    def index_symbols(self) -> set[str]:
        return set(sanctioned_master.INDEX_SYMBOLS)

    def _parse_rows(self, reader) -> list[dict]:
        instruments: list[dict] = []
        for row in reader:
            row = {k.strip(): v.strip() if isinstance(v, str) else v for k, v in row.items()}
            symbol = row.get("pSymbolName", "")
            token = row.get("pSymbol", row.get("tk", ""))
            exchange_seg = row.get("pExchSeg", "nse_cm")
            series = self._series_of(row)
            inst_type = (row.get("pInstType") or row.get("pGroup") or "").strip().upper()
            name = row.get("pDesc", "")
            trading_symbol = row.get("pTrdSymbol", symbol)
            lot_size = row.get("iBoardLotQty", row.get("lLotSize", "1"))
            tick_size = row.get("dTickSize", "0.05")
            isin = (row.get("pISIN") or row.get("ISIN") or "").strip()

            if not symbol or not token:
                continue

            flags = sanctioned_master.sanctioned_flags(symbol)
            instruments.append({
                "symbol": symbol,
                "token": str(token),
                "exchange": exchange_seg,
                "exchangeSegment": exchange_seg,
                "tradingSymbol": trading_symbol,
                "companyName": name,
                "series": series,
                "instrumentType": inst_type,
                "segment": inst_type or series,
                "lotSize": lot_size,
                "tickSize": tick_size,
                "isin": isin,
                **flags,
            })
        return instruments

    def _index(self, instruments: list[dict]) -> None:
        by_symbol: dict[str, dict] = {}
        by_token: dict[str, dict] = {}
        by_name_lower: dict[str, list[dict]] = {}
        by_isin: dict[str, dict] = {}

        def _is_eq_of(series: str, inst_type: str) -> bool:
            return series == "EQ" or inst_type == "EQ"

        for inst in instruments:
            series = str(inst.get("series") or "").upper()
            inst_type = str(inst.get("instrumentType") or "").upper()
            token = str(inst.get("token") or "")
            symbol = str(inst.get("symbol") or "").upper()
            name_key = str(inst.get("companyName") or "").lower()
            isin = str(inst.get("isin") or "").strip().upper()

            if token:
                existing = by_token.get(token)
                if existing:
                    if _is_eq_of(series, inst_type) and not _is_eq_of(
                        str(existing.get("series") or "").upper(),
                        str(existing.get("instrumentType") or "").upper(),
                    ):
                        by_token[token] = inst
                else:
                    by_token[token] = inst

            if name_key:
                by_name_lower.setdefault(name_key, []).append(inst)

            if isin:
                existing_isin = by_isin.get(isin)
                if existing_isin:
                    if _is_eq_of(series, inst_type) and not _is_eq_of(
                        str(existing_isin.get("series") or "").upper(),
                        str(existing_isin.get("instrumentType") or "").upper(),
                    ):
                        by_isin[isin] = inst
                else:
                    by_isin[isin] = inst

            if symbol:
                existing = by_symbol.get(symbol)
                if existing:
                    if _is_eq_of(series, inst_type) and not _is_eq_of(
                        str(existing.get("series") or "").upper(),
                        str(existing.get("instrumentType") or "").upper(),
                    ):
                        by_symbol[symbol] = inst
                else:
                    by_symbol[symbol] = inst

        with self._lock:
            self._instruments = list(instruments)
            self._by_symbol = by_symbol
            self._by_token = by_token
            self._by_name_lower = by_name_lower
            self._by_isin = by_isin

    def _persist(self) -> None:
        try:
            os.makedirs(_DATA_DIR, exist_ok=True)
            with self._lock:
                instruments = list(self._instruments)
            payload = {
                "downloadedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "instrumentCount": len(instruments),
                "instruments": instruments,
            }
            tmp = _CACHE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            os.replace(tmp, _CACHE_FILE)
            logger.info("Instrument master persisted to %s", _CACHE_FILE)
        except Exception as exc:
            logger.warning("Could not persist instrument master: %s", exc)

    # ------------------------------------------------------------------ #
    # Search / lookup
    # ------------------------------------------------------------------ #
    def search(
        self,
        query: str,
        exchange: str = "nse_cm",
        eq_only: bool = True,
        limit: int = 10,
    ) -> list[dict]:
        """
        Fast local search. Returns ranked real instruments.

        Ranking:
        1. Exact EQ symbol match
        2. Exact token match
        3. Exact ISIN match
        4. Exact symbol match
        5. Starts-with symbol match
        6. Starts-with name match
        7. Contains symbol match
        8. Contains name match
        9. Contains token / ISIN match
        """
        if not self._loaded or not query.strip():
            return []

        q = query.strip().upper()
        q_lower = q.lower()
        results: list[dict] = []
        seen_tokens: set[str] = set()

        def _add(inst: dict):
            tok = str(inst.get("token") or "")
            if tok and tok not in seen_tokens:
                seen_tokens.add(tok)
                results.append(inst)

        def _matches(inst: dict) -> bool:
            if eq_only and not self.is_nse_eq(inst):
                return False
            if exchange and inst.get("exchange", "") != exchange:
                return False
            return True

        exact = self._by_symbol.get(q)
        if exact and _matches(exact):
            _add(exact)

        token_exact = self._by_token.get(q)
        if token_exact and _matches(token_exact):
            _add(token_exact)

        isin_exact = self._by_isin.get(q)
        if isin_exact and _matches(isin_exact):
            _add(isin_exact)

        if not seen_tokens:
            for sym, inst in self._by_symbol.items():
                if sym == q and _matches(inst):
                    _add(inst)

        for sym, inst in self._by_symbol.items():
            if sym.startswith(q) and _matches(inst):
                _add(inst)
            if len(results) >= limit * 2:
                break

        for name_key, insts in self._by_name_lower.items():
            if name_key.startswith(q_lower):
                for inst in insts:
                    if _matches(inst):
                        _add(inst)
                if len(results) >= limit * 2:
                    break

        for sym, inst in self._by_symbol.items():
            if q in sym and not sym.startswith(q) and _matches(inst):
                _add(inst)
            if len(results) >= limit * 2:
                break

        for name_key, insts in self._by_name_lower.items():
            if q_lower in name_key and not name_key.startswith(q_lower):
                for inst in insts:
                    if _matches(inst):
                        _add(inst)
                if len(results) >= limit * 2:
                    break

        for tok, inst in self._by_token.items():
            if q in tok and tok != q and _matches(inst):
                _add(inst)
            if len(results) >= limit * 2:
                break
        for isin, inst in self._by_isin.items():
            isin_up = isin.upper()
            if q in isin_up and isin_up != q and _matches(inst):
                _add(inst)
            if len(results) >= limit * 2:
                break

        return results[:limit]

    def lookup_by_token(self, token: str) -> Optional[dict]:
        if not self._loaded or not token:
            return None
        return self._by_token.get(str(token))

    def lookup_by_symbol(self, symbol: str) -> Optional[dict]:
        if not self._loaded or not symbol:
            return None
        return self._by_symbol.get(symbol.upper())

    def lookup_by_isin(self, isin: str) -> Optional[dict]:
        if not self._loaded or not isin:
            return None
        return self._by_isin.get(isin.strip().upper())

    def is_nse_eq(self, inst: Optional[dict]) -> bool:
        if not inst:
            return False
        exchange = str(inst.get("exchange") or inst.get("exchangeSegment") or "").lower()
        if exchange not in {"nse_cm", "nse_cash", "nse_eq"}:
            return False
        series = str(inst.get("series") or "").upper()
        inst_type = str(inst.get("instrumentType") or "").upper()
        return series == "EQ" or inst_type == "EQ"

    # ------------------------------------------------------------------ #
    # Status
    # ------------------------------------------------------------------ #
    def state(self) -> dict:
        """Structured status for the UI.

        state: LOADED / LOADING / FAILED / NOT_AVAILABLE
        """
        with self._lock:
            if self._loading:
                state = "LOADING"
            elif self._loaded:
                state = "LOADED"
            elif self._load_error:
                state = "FAILED"
            else:
                state = "NOT_AVAILABLE"

            instruments = list(self._instruments)
            nse_eq = sum(1 for i in instruments if self.is_nse_eq(i))
            return {
                "state": state,
                "loaded": self._loaded,
                "loading": self._loading,
                "source": self._source,
                "instrumentCount": len(instruments),
                "nseEqCount": nse_eq,
                "lastLoadAt": self._last_load_at,
                "lastUpdated": self._last_load_at,
                "reason": self._load_error,
                "loadCount": self._load_count,
            }

    def get_status(self) -> dict:
        with self._lock:
            return {
                "loaded": self._loaded,
                "loading": self._loading,
                "instrument_count": len(self._instruments),
                "last_load_at": self._last_load_at,
                "load_error": self._load_error,
                "load_count": self._load_count,
                "source": self._source,
            }


# Global singleton
instrument_cache = InstrumentCache()


def load_instrument_cache() -> bool:
    """Load the instrument cache. Call after a successful login."""
    return instrument_cache.load()


def instrument_cache_state() -> dict:
    """Return the structured instrument-master status (for startup/reporting)."""
    return instrument_cache.state()
