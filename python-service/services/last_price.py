"""LastPrice — the canonical last-known price resolver.

One honest chain, shared by every surface that needs a price when the live
websocket feed is not streaming (market closed, weekend, feed down, or a
Dummy-mode user with no broker feed at all):

  1. ``websocket``  — the central tick buffer (the same real broker feed every
                      terminal shares, when it is up);
  2. ``broker``     — a batched on-demand quote through the real broker session
                      (Kotak keeps returning the last traded price after hours);
  3. ``last_close`` — the newest stored 1-minute candle close in MongoDB, i.e.
                      the last price this system actually recorded.

Nothing is ever fabricated: when all three are silent the resolver returns
``ltp=None`` and the caller renders "—".

Every resolved value carries ``source``, ``status`` ("LIVE" | "STALE") and
``asOf`` so the UI can label a snapshot honestly instead of pretending it is
live. The paper engine uses the same chain, which is what makes Dummy mode
self-sufficient: orders can be priced and filled from the last real price even
when nobody has a terminal open.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

_log = logging.getLogger("last_price")

#: How long a resolved price stays reusable in-process. Short enough that a
#: fresh broker print lands quickly, long enough that a debounced search and
#: the follow-up card render share one broker round-trip.
_CACHE_TTL = 20.0
#: Candle fallback changes only when a new candle closes — cache it longer.
_CANDLE_CACHE_TTL = 60.0
#: Hard ceiling on one broker quote round-trip (never hang a search).
_BROKER_TIMEOUT = 3.5

_CACHE: dict[str, tuple[float, dict]] = {}

_EMPTY: dict[str, Any] = {
    "ltp": None, "prevClose": None, "open": None, "high": None, "low": None,
    "volume": None, "change": None, "changePct": None,
    "source": "unavailable", "status": "UNAVAILABLE", "asOf": None,
}


def _num(value: Any) -> Optional[float]:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n <= 0:  # NaN / non-positive
        return None
    return n


def _cache_key(token: str, symbol: str) -> str:
    return f"{(token or '').strip()}|{(symbol or '').strip().upper()}"


def _cache_get(key: str, ttl: float) -> Optional[dict]:
    hit = _CACHE.get(key)
    if hit and (time.time() - hit[0]) < ttl:
        return dict(hit[1])
    return None


def _cache_put(key: str, value: dict) -> None:
    _CACHE[key] = (time.time(), dict(value))
    # Bound the table — prices are cheap to re-resolve.
    if len(_CACHE) > 2048:
        for stale_key in list(_CACHE.keys())[:1024]:
            _CACHE.pop(stale_key, None)


def _decorate(row: dict, *, status: str, source: str) -> dict:
    ltp = _num(row.get("ltp"))
    prev = _num(row.get("prevClose"))
    change = row.get("change")
    if change is None and ltp is not None and prev is not None:
        change = round(ltp - prev, 4)
    change_pct = row.get("changePct")
    if change_pct is None and change is not None and prev:
        change_pct = round((change / prev) * 100, 4)
    return {
        "ltp": ltp,
        "prevClose": prev,
        "open": _num(row.get("open")),
        "high": _num(row.get("high")),
        "low": _num(row.get("low")),
        "volume": _num(row.get("volume")),
        "change": change,
        "changePct": change_pct,
        "source": source,
        "status": status if ltp is not None else "UNAVAILABLE",
        "asOf": row.get("asOf"),
    }


# --------------------------------------------------------------------------- #
# 1. websocket tick buffer
# --------------------------------------------------------------------------- #

def _tick_price(token: str, symbol: str) -> Optional[float]:
    try:
        from services import tick_buffer as tb
    except Exception:
        return None
    for key in (token, symbol, symbol.upper() if symbol else ""):
        if not key:
            continue
        try:
            px = tb.latest_ltp(str(key))
        except Exception:
            continue
        if px is not None and _num(px):
            return float(px)
    return None


# --------------------------------------------------------------------------- #
# 2. stored 1-minute candles (the last price really recorded)
# --------------------------------------------------------------------------- #

async def last_close(token: str = "", symbol: str = "") -> dict:
    """Newest stored 1-minute candle close (+ the previous session's close).

    Async because the platform's MongoDB client is Motor (async). A short
    in-process cache (``_CANDLE_CACHE_TTL``) keeps the round-trip off repeated
    renders, which matters because the paper engine's fill path calls this.
    """
    sym = (symbol or "").strip().upper()
    tok = str(token or "").strip()
    cache_key = f"candle:{_cache_key(tok, sym)}"
    cached = _cache_get(cache_key, _CANDLE_CACHE_TTL)
    if cached is not None:
        return cached

    out = dict(_EMPTY, source="last_close")
    if not sym and not tok:
        return out
    try:
        from database.connection import get_db, is_mongo_connected
        if not is_mongo_connected():
            return out
        col = get_db()["market_candles_1m"]
        query: dict[str, Any]
        if sym:
            query = {"symbol": sym}
        else:
            query = {"instrumentToken": tok}
        docs = await col.find(query).sort([("bucketStartEpoch", -1)]).limit(1).to_list(1)
        if not docs and tok:
            docs = await col.find({"instrumentToken": tok}).sort([("bucketStartEpoch", -1)]).limit(1).to_list(1)
        if not docs:
            return out
        doc = docs[0]
        close = _num(doc.get("close"))
        if close is None:
            return out
        prev_close = None
        date = str(doc.get("date") or "")
        if date:
            prev_docs = await (
                col.find({**query, "date": {"$lt": date}})
                .sort([("bucketStartEpoch", -1)])
                .limit(1)
                .to_list(1)
            )
            if prev_docs:
                prev_close = _num(prev_docs[0].get("close"))
        as_of = doc.get("bucketStart") or doc.get("closedAt") or None
        out = _decorate(
            {
                "ltp": close,
                "prevClose": prev_close,
                "open": doc.get("open"),
                "high": doc.get("high"),
                "low": doc.get("low"),
                "volume": doc.get("volume"),
                "asOf": as_of,
            },
            status="STALE",
            source="last_close",
        )
        _cache_put(cache_key, out)
        return out
    except Exception as exc:  # noqa: BLE001 — a price lookup must never raise
        _log.debug("last_close lookup failed for %s/%s: %s", sym, tok, exc)
        return out


def cached_last_close(token: str = "", symbol: str = "") -> dict:
    """Cache-only variant for sync callers (no I/O — ``{}`` when cold)."""
    sym = (symbol or "").strip().upper()
    tok = str(token or "").strip()
    return _cache_get(f"candle:{_cache_key(tok, sym)}", _CANDLE_CACHE_TTL) or {}


# --------------------------------------------------------------------------- #
# 3. on-demand broker quotes (batched, cached)
# --------------------------------------------------------------------------- #

#: Kotak's quote endpoint advertises a 50-symbol maximum but rejects a request
#: that carries exactly 50 ("Please set the Neo symbol max value to 50"). The
#: measured working ceiling is 49. A weekly scan asks for the whole NSE
#: universe, so the resolver MUST chunk or every full-size request fails as a
#: 400 and the scan silently falls back to old candle closes. The chunk cap is
#: a broker contract, not a tuning knob.
_BROKER_QUOTE_CHUNK = 49
#: Chunks are independent; a small amount of concurrency keeps a 2700-symbol
#: scan inside its batch timeout without looking like a rate-limit attack.
_BROKER_QUOTE_CONCURRENCY = 3


async def _shoonya_quotes(refs: list[dict]) -> dict[str, dict]:
    """Quotes through the ACTIVE broker when that broker is Shoonya.

    The resolver used to be hard-wired to Kotak, so a Shoonya terminal still
    priced its dropdowns with Kotak's prints. The data must come from the
    broker the user is actually trading on, so the chain follows the ACTIVE
    terminal.
    """
    try:
        from brokers.manager import active_terminal, get_adapter

        if active_terminal() != "shoonya":
            return {}
        adapter = get_adapter("shoonya")
        if not getattr(adapter, "is_logged_in", False):
            return {}
    except Exception:
        return {}

    token_refs = [
        {"exchange_segment": str(r.get("segment") or "nse_cm"), "instrument_token": str(r.get("token") or "")}
        for r in refs
        if str(r.get("token") or "").isdigit()
    ]
    if not token_refs:
        return {}
    try:
        payload = await asyncio.wait_for(
            adapter.quote(token_refs, "ltp"), timeout=_BROKER_TIMEOUT
        )
    except Exception as exc:  # noqa: BLE001
        _log.debug("shoonya quote failed for %d symbols: %s", len(token_refs), exc)
        return {}

    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return {}
    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        token = str(row.get("exchange_token") or "")
        ohlc = row.get("ohlc") or {}
        ltp = _num(row.get("ltp") if row.get("ltp") is not None else row.get("last_price"))
        if not token or ltp is None:
            continue
        close_raw = _num(ohlc.get("close"))
        prev_close = close_raw if (close_raw is not None and abs(close_raw - ltp) > 1e-9) else None
        out[token] = _decorate(
            {
                "ltp": ltp,
                "prevClose": prev_close,
                "open": ohlc.get("open"),
                "high": ohlc.get("high"),
                "low": ohlc.get("low"),
                "volume": row.get("volume") or ohlc.get("volume"),
                "asOf": datetime.now(timezone.utc).isoformat(),
            },
            status="STALE",
            source="broker",
        )
    return out


async def _broker_quotes(
    refs: list[dict],
    *,
    include_ohlc: bool = True,
) -> dict[str, dict]:
    """Batched broker quotes through the real broker session.

    Kotak rejects a quote call carrying 50 symbols; 49 is the measured working
    ceiling. We therefore split the requested refs into 49-symbol chunks and
    issue a bounded number in parallel. Results are keyed by token so callers
    can look up either token or symbol. Returns ``{}`` when no real broker
    session is active — never a message, never a guess.

    ``include_ohlc=False`` skips the second broker round-trip when the caller
    only needs an LTP (the Friday universe screen). That halves broker traffic
    for a full-market scan and avoids rate-limit pressure on the margin calls
    that follow it.
    """
    # The quote must come from the broker the user is trading ON. When the
    # active terminal is Shoonya, Kotak's prints are the wrong broker's data
    # (and Kotak often has no session at all in that mode).
    try:
        from brokers.manager import active_terminal

        if active_terminal() != "kotak":
            return await _shoonya_quotes(refs)
    except Exception:
        pass

    try:
        from auth.kotak_client import kotak_session
    except Exception:
        return {}
    if not getattr(kotak_session, "session_active", False):
        return {}

    tokens = [
        {"exchange_segment": str(r.get("segment") or "nse_cm"), "instrument_token": str(r.get("token"))}
        for r in refs
        if str(r.get("token") or "").isdigit()
    ]
    if not tokens:
        return {}

    def _rows(payload: Any) -> list[dict]:
        if not isinstance(payload, dict):
            return []
        data = payload.get("data")
        if isinstance(data, list):
            return [r for r in data if isinstance(r, dict)]
        if isinstance(data, dict):
            return [data]
        return []

    semaphore = asyncio.Semaphore(_BROKER_QUOTE_CONCURRENCY)

    async def _one_chunk(chunk: list[dict]) -> tuple[list[dict], list[dict]]:
        async with semaphore:
            async def _one(quote_type: str):
                try:
                    return await asyncio.wait_for(
                        kotak_session.async_quote(instrument_tokens=chunk, quote_type=quote_type),
                        timeout=_BROKER_TIMEOUT,
                    )
                except Exception as exc:  # noqa: BLE001
                    _log.debug(
                        "broker %s quote failed for %d symbols: %s",
                        quote_type, len(chunk), exc,
                    )
                    return None

            if include_ohlc:
                ltp_res, ohlc_res = await asyncio.gather(_one("ltp"), _one("ohlc"))
            else:
                ltp_res, ohlc_res = await _one("ltp"), None
        return _rows(ltp_res), _rows(ohlc_res)

    chunks = [
        tokens[start:start + _BROKER_QUOTE_CHUNK]
        for start in range(0, len(tokens), _BROKER_QUOTE_CHUNK)
    ]
    batches = await asyncio.gather(
        *(_one_chunk(chunk) for chunk in chunks),
        return_exceptions=True,
    )

    ltp_rows: list[dict] = []
    ohlc_by_token: dict[str, dict] = {}
    for batch in batches:
        if isinstance(batch, BaseException):
            _log.debug("broker quote chunk failed: %s", batch)
            continue
        ltp_part, ohlc_part = batch
        ltp_rows.extend(ltp_part)
        for row in ohlc_part:
            ohlc_by_token[str(row.get("exchange_token"))] = row

    out: dict[str, dict] = {}
    for row in ltp_rows:
        token = str(row.get("exchange_token") or "")
        ohlc = (ohlc_by_token.get(token) or {}).get("ohlc") or row.get("ohlc") or {}
        ltp = _num(row.get("ltp") if row.get("ltp") is not None else row.get("last_price"))
        if ltp is None:
            continue
        # The broker echoes the last price into `ohlc.close` after hours, so a
        # close identical to the LTP is NOT a previous close — leaving it out
        # beats showing a fabricated 0.00% change.
        close_raw = _num(ohlc.get("close"))
        prev_close = close_raw if (close_raw is not None and abs(close_raw - ltp) > 1e-9) else None
        out[token] = _decorate(
            {
                "ltp": ltp,
                "prevClose": prev_close,
                "open": ohlc.get("open"),
                "high": ohlc.get("high"),
                "low": ohlc.get("low"),
                "volume": row.get("volume") or ohlc.get("volume"),
                "asOf": datetime.now(timezone.utc).isoformat(),
            },
            status="STALE",
            source="broker",
        )
    return out


# --------------------------------------------------------------------------- #
# Public resolver
# --------------------------------------------------------------------------- #

async def resolve_prices(
    refs: Iterable[dict],
    *,
    allow_broker: bool = True,
    include_ohlc: bool = True,
) -> list[dict]:
    """Resolve a batch of ``{"token", "symbol", "segment"}`` refs.

    Returns one result per input ref, in the same order. Resolution order per
    row: tick buffer → broker (batched, only for rows the buffer missed) →
    stored candle close. Values are cached briefly so a dropdown and the
    order card share one resolution. ``include_ohlc=False`` is for callers that
    only need the LTP and want to spare the broker the second quote round-trip.
    """
    wanted = [
        {
            "token": str(r.get("token") or "").strip(),
            "symbol": str(r.get("symbol") or "").strip().upper(),
            "segment": str(r.get("segment") or r.get("exchange") or "nse_cm").strip().lower(),
        }
        for r in refs
    ]
    results: list[Optional[dict]] = [None] * len(wanted)

    pending: list[int] = []
    for idx, ref in enumerate(wanted):
        key = _cache_key(ref["token"], ref["symbol"])
        cached = _cache_get(key, _CACHE_TTL)
        if cached is not None:
            results[idx] = cached
            continue
        tick = _tick_price(ref["token"], ref["symbol"])
        if tick is not None:
            resolved = _decorate({"ltp": tick, "asOf": datetime.now(timezone.utc).isoformat()},
                                 status="LIVE", source="websocket")
            _cache_put(key, resolved)
            results[idx] = resolved
            continue
        pending.append(idx)

    broker_rows: dict[str, dict] = {}
    if pending and allow_broker:
        broker_rows = await _broker_quotes(
            [wanted[i] for i in pending], include_ohlc=include_ohlc,
        )

    for idx in pending:
        ref = wanted[idx]
        key = _cache_key(ref["token"], ref["symbol"])
        resolved = broker_rows.get(ref["token"])
        if resolved is None:
            cached_candle = _cache_get(f"candle:{key}", _CANDLE_CACHE_TTL)
            resolved = cached_candle if cached_candle is not None else await last_close(ref["token"], ref["symbol"])
            if resolved.get("ltp") is not None:
                _cache_put(f"candle:{key}", resolved)
        if resolved.get("ltp") is not None:
            _cache_put(key, resolved)
        results[idx] = resolved

    return [r if r is not None else dict(_EMPTY) for r in results]


async def resolve_price(
    token: str = "",
    symbol: str = "",
    exchange: str = "nse_cm",
    *,
    allow_broker: bool = True,
) -> dict:
    """Single-instrument convenience wrapper around :func:`resolve_prices`."""
    rows = await resolve_prices(
        [{"token": token, "symbol": symbol, "segment": exchange}],
        allow_broker=allow_broker,
    )
    return rows[0] if rows else dict(_EMPTY)


def cached_price(token: str = "", symbol: str = "") -> Optional[dict]:
    """The in-process cached resolution for an instrument, if still fresh."""
    return _cache_get(_cache_key(token, symbol), _CACHE_TTL)


def clear_cache() -> None:
    _CACHE.clear()
