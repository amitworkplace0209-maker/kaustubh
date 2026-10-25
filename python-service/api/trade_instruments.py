"""Trade-page instrument suggestions — the broker's own universe, not a search.

Why this exists
---------------
The trade page used to pick instruments through the generic Search Engine,
which searches the *instrument master*. That is the wrong source for placing or
quoting a trade for three reasons:

1. The master is a separate dataset from what the broker is actually
   subscribed to, so it can happily return an instrument whose token the live
   feed never receives - the user then selects a symbol that can never have a
   live price.
2. The master is matched fuzzily, so an abbreviation silently resolves to a
   different instrument (``LTIM`` surfaced ``ALLTIME``, ``GAS`` surfaced
   ``AGASTYAEN``). On a trading page a near-miss is a real hazard, not a
   cosmetic bug.
3. It cannot answer "what can I actually trade right now" without re-deriving
   broker state through search-side heuristics.

So suggestions come from :meth:`session_manager.active_registry` - the canonical
record per instrument, keyed by the broker token we have genuinely subscribed.
An instrument that appears here is one the feed can quote.

Matching is exact and prefix-only, with each band alphabetical so row 1 is
always guessable. There is no substring band and no fuzzy/edit-distance
fallback, and that omission is deliberate rather than an oversight.

Substring matching looks harmless and is not, on a trading page: "LTIM" is a
substring of "ALLTIME" and "GAS" of "MOOILGAS", so a typed symbol the user
means can come back with an unrelated instrument sitting right next to it. One
mis-click on that row is a trade in the wrong security. When the typed symbol
is genuinely not in the subscribed universe the honest answer is an empty
result the page renders as "not available" - not a plausible-looking decoy.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from services.session.session_manager import session_manager
from services.json_safe import sanitize_for_json

logger = logging.getLogger("app.trade_instruments")

router = APIRouter(prefix="/api/trade/instruments", tags=["trade-instruments"])

# The registry holds ~2.7k instruments; keep the response small and the matching
# cheap by capping how much the caller can ask for.
_MAX_LIMIT = 100
_DEFAULT_LIMIT = 20


def _display_symbol(rec: dict[str, Any]) -> str:
    """Best available label for an instrument, preferring the tradable symbol."""
    for key in ("trading_symbol", "symbol"):
        value = rec.get(key)
        if value:
            return str(value)
    return str(rec.get("instrument_token") or "")


def _is_active(rec: dict[str, Any]) -> bool:
    """Only offer instruments the session considers usable right now.

    ``_subs`` stores real booleans for ``active``/``desired`` and a ``state``
    string, unlike the persisted document where the same fields are strings.
    Both spellings are accepted so a record from either layer is judged the
    same way.
    """
    active = rec.get("active")
    if isinstance(active, str):
        if active.strip().lower() in {"false", "0", "none", ""}:
            return False
    elif active is not None and not bool(active):
        return False
    desired = rec.get("desired")
    if isinstance(desired, str):
        if desired.strip().lower() in {"false", "0"}:
            return False
    elif desired is not None and not bool(desired):
        return False
    state = str(rec.get("state") or rec.get("status") or "").strip().upper()
    return state not in {"EXPIRED", "BLOCKED", "REMOVED"}


def _suggestion(rec: dict[str, Any]) -> dict[str, Any]:
    """One suggestion row, shaped for the trade page picker.

    Only fields the canonical registry actually carries are emitted. The
    persisted document has richer columns (``instrument_id``, ``status``), but
    those are a lagging snapshot; deriving them here would risk handing the
    page an identifier the live session does not agree with.
    """
    return {
        "symbol": _display_symbol(rec),
        "instrumentToken": str(rec.get("instrument_token") or ""),
        "exchangeSegment": str(rec.get("exchange_segment") or "nse_cm"),
        "state": str(rec.get("state") or ""),
        "subscribed": bool(rec.get("subscribed")),
        "isIndex": bool(rec.get("is_index")),
        "expiryLabel": rec.get("expiry_label"),
        "pinned": bool(rec.get("pin")),
    }


def _rank(query: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Exact matches, then prefix matches - alphabetical within each band.

    Pinned instruments lead their band. Deterministic ordering matters more
    than clever ranking here: the user has to be able to predict what row 1
    is, and "the symbol I typed, or the closest symbol I typed" is a rule that
    never surprises anyone.
    """
    if not query:
        return sorted(rows, key=lambda r: (not r["pinned"], r["symbol"]))
    upper = query.upper()
    exact = [r for r in rows if r["symbol"].upper() == upper]
    prefix = [
        r for r in rows
        if r["symbol"].upper() != upper and r["symbol"].upper().startswith(upper)
    ]
    for band in (exact, prefix):
        band.sort(key=lambda r: (not r["pinned"], r["symbol"]))
    return exact + prefix


@router.get("/suggest")
async def suggest_instruments(
    q: str = Query("", max_length=32, description="Symbol prefix typed by the user"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    exchangeSegment: str = Query("nse_cm", max_length=16),
    includeInactive: bool = Query(False, description="Include instruments the session has deactivated"),
):
    """Suggest tradable instruments from the broker's subscribed registry.

    Returns an empty list rather than guessing when nothing matches, so the
    page can say "not available" instead of offering a near-miss symbol.
    """
    registry = session_manager.active_registry()
    segment = (exchangeSegment or "").strip()
    query = (q or "").strip()

    rows: list[dict[str, Any]] = []
    for rec in registry.values():
        if segment and str(rec.get("exchange_segment") or "") != segment:
            continue
        if not includeInactive and not _is_active(rec):
            continue
        row = _suggestion(rec)
        if not row["symbol"] or not row["instrumentToken"]:
            continue
        rows.append(row)

    ranked = _rank(query, rows)
    return {
        "ok": True,
        "data": {
            "query": query,
            "exchangeSegment": segment,
            "total": len(rows),
            "matched": len(ranked),
            "items": sanitize_for_json(ranked[:limit]),
        },
    }


@router.get("/{exchange_segment}/{instrument_token}")
async def instrument_detail(exchange_segment: str, instrument_token: str):
    """Resolve one canonical registry record by segment + broker token."""
    rec = session_manager.active_registry().get(str(instrument_token))
    if not rec or str(rec.get("exchange_segment") or "") != exchange_segment:
        raise HTTPException(status_code=404, detail="instrument not in the subscribed registry")
    return {"ok": True, "data": sanitize_for_json(_suggestion(rec))}


@router.get("")
async def instrument_universe(
    exchangeSegment: str = Query("nse_cm", max_length=16),
    includeInactive: bool = Query(False),
):
    """The full tradable universe, so the page can browse without typing."""
    registry = session_manager.active_registry()
    segment = (exchangeSegment or "").strip()
    rows: list[dict[str, Any]] = []
    for rec in registry.values():
        if segment and str(rec.get("exchange_segment") or "") != segment:
            continue
        if not includeInactive and not _is_active(rec):
            continue
        row = _suggestion(rec)
        if row["symbol"] and row["instrumentToken"]:
            rows.append(row)
    rows.sort(key=lambda r: (not r["pinned"], r["symbol"]))
    return {
        "ok": True,
        "data": {
            "exchangeSegment": segment,
            "total": len(rows),
            "items": sanitize_for_json(rows[:_MAX_LIMIT]),
        },
    }


__all__ = ["router"]
