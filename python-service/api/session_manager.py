"""Session Manager Engine API — Phase 3 control plane.

Single authoritative API for the "what is subscribed / how" state:
canonical instruments, lifecycle transitions (subscribe / unsubscribe / pin /
unpin / activate / deactivate / expire / remove), real expiries, feed level,
routing targets, per-connection applied revisions and the reconcile sweep.

Every response uses the standard ``{ok, data?|error?}`` envelope and is
serialized through ``services.json_safe`` (never exposes credentials).
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Body

from services.json_safe import sanitize_for_json
from services.session.session_manager import session_manager

logger = logging.getLogger("app.session_manager_api")

router = APIRouter(prefix="/api/phase3/session-manager", tags=["session-manager"])


def _ok(data) -> dict:
    return {"ok": True, "data": sanitize_for_json(data)}


def _bad(message: str) -> dict:
    return {"ok": False, "error": message}


# ------------------------------------------------------------------
# Scope: show the Market Watch LIST stocks only, never the whole master
# ------------------------------------------------------------------
# The Session Manager registry holds the full instrument master (~2.7k rows).
# `?scope=market_watch` collapses every registry view to the stocks that are
# actually on the Market Watch engine's working list — the rows tagged with the
# daily-universe source — so the control plane surfaces the watched stocks only.
MARKET_WATCH_SOURCE = "market_watch_daily_universe"


def _norm_scope(scope: Optional[str]) -> Optional[str]:
    s = str(scope or "").strip().lower().replace("-", "_")
    if s in {"market_watch", "marketwatch", "mw", "market_watch_list", "market_watch_list_only"}:
        return "market_watch"
    return s or None


def _is_market_watch_row(row: dict) -> bool:
    srcs = [str(s).lower() for s in (row.get("sources") or [])]
    if MARKET_WATCH_SOURCE in srcs:
        return True
    return str(row.get("source") or "").lower() == MARKET_WATCH_SOURCE


def _scoped_rows(rows, scope: Optional[str]) -> list[dict]:
    if scope != "market_watch":
        return list(rows)
    return [r for r in rows if _is_market_watch_row(r)]


def _rescope_overview(data: dict, scope: Optional[str]) -> dict:
    """Recompute overview aggregates from the scoped rows only (never guessed)."""
    if scope != "market_watch":
        return data
    rows = _scoped_rows(data.get("instruments") or [], scope)
    total_all = (data.get("counts") or {}).get("total")
    status_counts: dict[str, int] = {}
    level_counts: dict[str, int] = {}
    for row in rows:
        status = row.get("status") or "UNKNOWN"
        status_counts[status] = status_counts.get(status, 0) + 1
        level = f"L{row.get('feed_level')}" if row.get("feed_level") else (row.get("market_data") or "UNSET")
        level_counts[level] = level_counts.get(level, 0) + 1
    counts = dict(data.get("counts") or {})
    counts["total"] = len(rows)
    counts["desired"] = sum(1 for r in rows if r.get("desired"))
    counts["subscribed"] = sum(1 for r in rows if r.get("subscribed"))
    counts["pinned"] = sum(1 for r in rows if r.get("pin") is not None)
    data["counts"] = counts
    data["statusCounts"] = status_counts
    data["feedLevelCounts"] = level_counts
    data["scope"] = {"mode": "market_watch", "marketWatch": len(rows), "all": total_all}
    # The overview page renders aggregates, not the canonical rows; dropping the
    # raw array keeps the payload small and the page fast. /instruments serves it.
    data.pop("instruments", None)
    return data


def _iid_split(iid: str) -> dict:
    """Split ``broker|segment|token`` (or ``segment|token``) into a row."""
    parts = str(iid or "").split("|")
    if len(parts) == 3:
        broker, segment, token = parts
    elif len(parts) == 2:
        segment, token = parts
        broker = "kotak"
    else:
        return {}
    if not segment or not token:
        return {}
    return {"broker": broker, "exchange_segment": segment, "instrument_token": token}


def _row_for(body: dict) -> Optional[dict]:
    """Normalize a request body into an instrument row (or None)."""
    if not body:
        return None
    row = dict(body)
    if "instrument_id" in row and not row.get("exchange_segment"):
        parts = str(row["instrument_id"]).split("|")
        if len(parts) == 3:
            row["broker"], row["exchange_segment"], row["instrument_token"] = parts
        elif len(parts) == 2:
            row["exchange_segment"], row["instrument_token"] = parts
    return row


def _unwrap(func, *args, **kwargs) -> dict:
    try:
        result = func(*args, **kwargs)
        if result is None:
            return _bad("instrument not found")
        if isinstance(result, dict) and result.get("error"):
            return _bad(result["error"])
        row = {k: v for k, v in dict(result).items() if k != "ok"}
        return _ok(row)
    except (KeyError, ValueError, TypeError) as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001 - defensive
        logger.exception("session manager API error")
        return _bad(f"{exc.__class__.__name__}: {exc}")


async def _audit(event: str, message: str = "", status: str = "info",
                 meta: dict | None = None) -> None:
    """Best-effort audit trail via the Audit Engine (never raises).

    Spec §34: every important control-plane action (manual add, lifecycle
    transition, reconcile, configuration change) is recorded in the ONE
    audit ledger through ``services.audit_engine`` — no second audit DB.
    """
    try:
        from services.audit_engine import audit_engine
        await audit_engine.record(
            source="session_manager", event=event, status=status,
            message=message,
            meta={"api": "session-manager", **(meta or {})},
        )
    except Exception:  # noqa: BLE001 - audit is best-effort, never blocks a control action
        logger.debug("audit record failed (%s): %s", event, message, exc_info=True)


# ------------------------------------------------------------------
# Overview / health
# ------------------------------------------------------------------
@router.get("/overview")
async def overview(scope: Optional[str] = None):
    """Full Session Manager Engine status (Control Center payload).

    ``?scope=market_watch`` narrows every registry aggregate (counts,
    statusCounts, feedLevelCounts) to the Market Watch working-list stocks
    (source ``market_watch_daily_universe``) instead of the full instrument
    master. Always a real recompute from scoped rows — never a guessed number.
    """
    return _ok(_rescope_overview(session_manager.phase3_snapshot(), _norm_scope(scope)))


@router.get("/status")
async def status(scope: Optional[str] = None):
    """Alias of /overview."""
    return _ok(_rescope_overview(session_manager.phase3_snapshot(), _norm_scope(scope)))


@router.get("/health")
async def health():
    return _ok(session_manager.phase3_health())


@router.get("/revision")
async def revision():
    return _ok(session_manager.revision_status())


@router.get("/connections")
async def connections():
    """Feed-link rollup + two advanced, fully real blocks:

    - ``history``: restart-safe connection timeline from the DB event ledger
      (``system_events``) merged with live ring events — websocket up/down,
      revision bumps, login/state transitions. When Mongo is down only the
      in-memory rows are returned (honest, never fabricated).
    - ``owner``: the owner session's real lifecycle + websocket state (feed
      links depend on it), verbatim from the session snapshot.
    """
    payload: dict[str, Any] = {
        "connections": session_manager.connections_snapshot(),
        "revision": session_manager.revision_status(),
    }
    try:
        from services.event_history import mongo_events, recent_events

        merged: list[dict] = []
        for row in await mongo_events(limit=120, source="session"):
            row["persisted"] = True  # real flag: row came from the DB ledger
            merged.append(row)
        for row in recent_events(limit=60, source="session"):
            row.setdefault("persisted", False)  # fresh ring row (may flush later)
            merged.append(row)

        interesting = []
        for row in merged:
            ev = str(row.get("event") or "").upper()
            if ev.startswith(("WEBSOCKET_", "SUBSCRIPTIONS_", "LOGIN_", "STATE:", "MODE_")):
                interesting.append(row)
        seen: set[tuple] = set()
        history: list[dict] = []
        for row in sorted(interesting, key=lambda r: str(r.get("ts") or ""), reverse=True):
            key = (str(row.get("ts")), str(row.get("event")), str(row.get("message")))
            if key in seen:
                continue
            seen.add(key)
            history.append(row)
        payload["history"] = history[:80]
    except Exception as exc:  # noqa: BLE001
        logger.debug("connection history load failed: %s", exc)
        payload["history"] = []

    snap = session_manager.snapshot()
    payload["owner"] = {
        "state": snap.get("state"),
        "stateMessage": snap.get("stateMessage"),
        "stateSince": snap.get("stateSince"),
        "lifecycleState": snap.get("lifecycleState"),
        "websocket": snap.get("websocket"),
        "broker": snap.get("broker"),
        "mode": snap.get("mode"),
    }
    return _ok(payload)


@router.get("/subscriptions")
async def subscriptions():
    return _ok(session_manager.subscriptions_view())


@router.get("/subscriptions/daily-intent")
async def subscriptions_daily_intent():
    """Current-day Market Watch daily-universe subscription intent (doc §5/§14)."""
    return _ok(session_manager.daily_intent_snapshot())


@router.get("/sources")
async def sources():
    """Source rollup + the Market Watch engine's own live registry facts.

    The Market Watch engine owns the authoritative eligible universe (regis-
    try, eligibility, subscription, feed state) — those verbatim engine facts
    ride along in ``marketWatch`` so the page shows the engine's real state
    instead of a guessed proxy. When the engine is unavailable the block is
    None (honest), never a fabricated number.
    """
    view = session_manager.sources_view()
    try:
        from services.market_watch_engine import market_watch_engine

        registry = market_watch_engine.registry() or []
        view["marketWatch"] = {
            "universeSize": int(market_watch_engine.universe_size() or 0),
            "eligibleCount": sum(1 for r in registry if r.get("intradayEligible")),
            "subscribedTokenCount": int(market_watch_engine.subscribed_token_count() or 0),
            "feedState": market_watch_engine.feed_state(),
            "statusCounts": dict(market_watch_engine.status_counts() or {}),
        }
    except Exception as exc:  # noqa: BLE001 - engine optional; stay honest
        logger.debug("market watch facts unavailable on /sources: %s", exc)
        view["marketWatch"] = None
    return _ok(view)


@router.get("/pins")
async def pins():
    return _ok(session_manager.pins_view())


@router.get("/expiry")
async def expiry(scope: Optional[str] = None):
    """Expiry classification — ``?scope=market_watch`` keeps only the Market
    Watch list stocks in every bucket (counts recomputed from real rows)."""
    view = session_manager.expiry_view()
    s = _norm_scope(scope)
    if s == "market_watch":
        buckets = view.get("rows") or {}
        scoped = {k: _scoped_rows(list(v or []), s) for k, v in buckets.items()}
        view = dict(view)
        for key in ("today", "nday", "custom", "expiring", "expired", "no_expiry"):
            view[key] = len(scoped.get(key) or [])
        view["rows"] = scoped
        view["scope"] = s
    return _ok(view)


@router.get("/events")
async def events(limit: int = 100, instrument_id: Optional[str] = None,
                 since_revision: Optional[int] = None, event: Optional[str] = None):
    try:
        from services.session import instrument_store
        from database.connection import get_db
        db = get_db()
        rows = await instrument_store.load_events(
            db=db, limit=max(1, min(limit, 2000)),
            instrument_id=instrument_id,
            since_revision=since_revision,
            event=event,
        )
        return _ok(rows)
    except Exception as exc:  # noqa: BLE001
        logger.warning("events load failed: %s", exc)
        return _ok(session_manager.snapshot().get("events", [])[-limit:])


# ------------------------------------------------------------------
# Unified history (session + instrument ledgers merged server-side)
# ------------------------------------------------------------------
def _history_category(ev: str, row: dict | None = None) -> str:
    """Real category of a history row — derived from the event name and the
    row's own status/severity, never from anything outside the row."""
    e = str(ev or "").upper()
    st = str((row or {}).get("status") or (row or {}).get("severity") or "").upper()
    if "REVISION" in e or "SUBSCRIPTIONS" in e or "RECONCILE" in e:
        return "revision"
    if "UNSUBSCR" in e:
        return "unsubscribe"
    if "SUBSCR" in e:
        return "subscribe"
    if "WEBSOCKET" in e or e.startswith("WS_"):
        return "websocket"
    if "PIN" in e:
        return "pin"
    if "EXPIR" in e:
        return "expire"
    if "UPSERT" in e or e.startswith("STOCK_"):
        return "instrument"
    if e.startswith("LOGIN") or "LOGOUT" in e or e.startswith("STATE") or "SESSION" in e or e.startswith("MODE"):
        return "session"
    if "ERROR" in e or "FAIL" in e or "FAILED" in st or "ERROR" in st:
        return "error"
    return "other"


@router.get("/history")
async def history(limit: int = 500, category: Optional[str] = None,
                  source: Optional[str] = None, q: Optional[str] = None):
    """Unified, restart-safe history across BOTH real ledgers, merged
    server-side into one normalized schema (newest-first, deduped):

    - session ledger: ``system_events`` (source=session) + live rings —
      login / state / websocket / revision rows; ``persisted`` says DB vs live.
    - instrument ledger: the sm ``sm_events`` collection — per-instrument
      audit rows (subscribe/unsubscribe/upsert/pin/expire) with symbol.

    ``?category=`` filters on the row's real category, ``?source=`` selects
    "session"/"instrument"/both, ``?q=`` is a substring search over
    event/instrument/symbol/message. ``stats`` is computed from the full
    merged set (before filters) so chips and KPIs are always genuine counts.
    """
    limit = max(1, min(int(limit), 1000))
    want = (source or "all").lower()
    raw: list[tuple[str, dict]] = []

    if want in ("all", "session"):
        try:
            from services.event_history import mongo_events, recent_events
            for r in await mongo_events(limit=limit, source="session"):
                r["persisted"] = True  # real DB marker
                raw.append(("session", r))
            for r in recent_events(limit=min(limit, 120), source="session"):
                r.setdefault("persisted", False)
                raw.append(("session", r))
        except Exception as exc:  # noqa: BLE001
            logger.debug("session ledger load failed: %s", exc)
        for e in reversed(session_manager.snapshot().get("events") or []):
            raw.append(("session", {
                "source": "session", "event": e.get("event"), "message": e.get("message"),
                "ts": e.get("at"), "meta": e.get("meta"), "persisted": False,
            }))

    if want in ("all", "instrument"):
        try:
            from services.session import instrument_store
            from database.connection import get_db
            for r in await instrument_store.load_events(db=get_db(), limit=limit):
                r["persisted"] = True
                r.setdefault("ledger", "instrument")
                raw.append(("instrument", r))
        except Exception as exc:  # noqa: BLE001
            logger.debug("instrument ledger load failed: %s", exc)

    def _message_of(r: dict) -> str:
        details = str(r.get("details") or "")
        msg = str(r.get("message") or "")
        meta_msg = str((r.get("meta") or {}).get("message") or "") if isinstance(r.get("meta"), dict) else ""
        return details or msg or meta_msg

    def _instrument_of(r: dict) -> str | None:
        if r.get("instrument_id"):
            return str(r["instrument_id"])
        if r.get("instrument_token"):
            return f"{str(r.get('exchange_segment') or '')}|{r.get('instrument_token')}"
        return None

    norm: list[dict] = []
    for ledger, r in raw:
        ev = str(r.get("event") or r.get("event_type") or "EVENT")
        ts = r.get("ts")
        norm.append({
            "ts": ts,
            "day": str(ts)[:10] if ts else "unknown",
            "event": ev,
            "category": _history_category(ev, r),
            "ledger": ledger,
            "status": r.get("status") or r.get("state"),
            "severity": r.get("severity"),
            "message": _message_of(r) or None,
            "instrument": _instrument_of(r),
            "symbol": r.get("symbol"),
            "revision": r.get("revision"),
            "persisted": bool(r.get("persisted", True)),
            "meta": r.get("meta") if isinstance(r.get("meta"), dict) else None,
        })

    seen: set[tuple] = set()
    deduped: list[dict] = []
    for row in norm:
        # seconds-level key: the DB rounds sub-seconds (608901 → 608000) while
        # the in-memory ring keeps microseconds, which would keep both copies.
        key = (str(row["ts"] or "")[:19], row["event"], str(row["message"]))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    deduped.sort(key=lambda r: str(r["ts"] or ""), reverse=True)
    # category chip counts stay pre-filter (global ledger mix), everything else
    # describes exactly the rows served below — no scope confusion.
    category_totals: list[dict] = []
    cat_counts: dict[str, int] = {}
    for r in deduped:
        cat_counts[r["category"]] = cat_counts.get(r["category"], 0) + 1
    category_totals = [{"category": k, "count": v} for k, v in sorted(cat_counts.items(), key=lambda kv: -kv[1])]

    cat = (category or "all").lower()
    if cat and cat != "all":
        deduped = [r for r in deduped if r["category"] == cat]
    if q:
        qq = str(q).strip().lower()
        if qq:
            deduped = [r for r in deduped if qq in str(r["event"]).lower()
                       or qq in str(r["message"] or "").lower()
                       or qq in str(r["instrument"] or "").lower()
                       or qq in str(r["symbol"] or "").lower()]
    served = deduped[:limit]

    # stats FROM THE SERVED ROWS so KPIs match what the page actually shows,
    # plus real aggregations: events per IST day and the most-touched symbols.
    by_day: dict[str, int] = {}
    symbol_counts: dict[str, int] = {}
    for r in served:
        if r["day"] != "unknown":
            by_day[r["day"]] = by_day.get(r["day"], 0) + 1
        sym = r.get("symbol")
        if sym:
            symbol_counts[str(sym)] = symbol_counts.get(str(sym), 0) + 1
    stats: dict[str, Any] = {
        "total": len(served),
        "errors": sum(1 for r in served if r["category"] == "error" or str(r.get("severity") or "").upper() == "ERROR"),
        "instruments": len({r["instrument"] for r in served if r["instrument"]}),
        "symbols": len({str(r["symbol"]) for r in served if r["symbol"]}),
        "persisted": sum(1 for r in served if r["persisted"]),
        "live": sum(1 for r in served if not r["persisted"]),
        "session_rows": sum(1 for r in served if r["ledger"] == "session"),
        "instrument_rows": sum(1 for r in served if r["ledger"] == "instrument"),
        "first_ts": served[-1]["ts"] if served else None,
        "last_ts": served[0]["ts"] if served else None,
        "categories": category_totals,
        "days": sorted(({"day": d, "count": c} for d, c in by_day.items()), key=lambda x: x["day"], reverse=True),
        "top_symbols": sorted(({"symbol": k, "count": v} for k, v in symbol_counts.items()), key=lambda x: -x["count"])[:10],
    }
    return _ok({"rows": served, "stats": stats})


# ------------------------------------------------------------------
# Instruments
# ------------------------------------------------------------------
@router.get("/instruments")
async def instruments(broker: Optional[str] = None, source: Optional[str] = None,
                      desired: Optional[bool] = None, active: Optional[bool] = None,
                      pinned: Optional[bool] = None, status: Optional[str] = None,
                      search: Optional[str] = None, expires_before: Optional[str] = None,
                      scope: Optional[str] = None, limit: int = 500):
    """Canonical instrument list with real filters (never guessed counts).

    ``?scope=market_watch`` returns only the Market Watch working-list stocks —
    the daily-universe source — instead of every instrument on the master.
    """
    rows = _scoped_rows(session_manager.subscription_snapshot()["instruments"], _norm_scope(scope))
    if broker:
        rows = [r for r in rows if (r.get("broker") or "kotak").lower() == broker.lower()]
    if source:
        rows = [r for r in rows if source.lower() in [str(s).lower() for s in (r.get("sources") or [])]
                or (r.get("source") or "").lower() == source.lower()]
    if desired is not None:
        rows = [r for r in rows if bool(r.get("desired")) == bool(desired)]
    if active is not None:
        rows = [r for r in rows if bool(r.get("active")) == bool(active)]
    if pinned is not None:
        rows = [r for r in rows if (r.get("pin") is not None) == bool(pinned)]
    if status:
        rows = [r for r in rows if (r.get("status") or "").upper() == status.upper()]
    if search:
        q = str(search).lower()
        rows = [r for r in rows if q in (r.get("symbol") or "").lower()
                or q in str(r.get("instrument_token") or "").lower()
                or q in (r.get("instrument_key") or "").lower()]
    if expires_before:
        import time
        try:
            cutoff = float(expires_before)
            rows = [r for r in rows if (r.get("expires_at")
                    and time.mktime(__import__("datetime").datetime.fromisoformat(r["expires_at"]).utctimetuple()) <= cutoff)]
        except Exception:  # noqa: BLE001 - treat as no filter
            pass
    rows = rows[: max(1, min(limit, 5000))]
    return _ok(rows)


@router.get("/instruments/{instrument_id}")
async def instrument_detail(instrument_id: str):
    row = _iid_split(instrument_id)
    if not row:
        return _bad("invalid instrument_id (expected broker|segment|token)")
    return _unwrap(session_manager._canonical_read_row, (row["exchange_segment"], row["instrument_token"]))


@router.post("/instruments")
async def upsert(body: dict = Body(...)):
    """Create or MERGE one canonical instrument (never duplicates a key).
    ``feed_level`` accepts 4/8/16 or a market_data tier L4/L8/L16."""
    row = _row_for(body)
    if not row:
        return _bad("instrument body required")
    try:
        result = await session_manager.upsert_instrument(row)
    except (KeyError, ValueError, TypeError) as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001 - defensive
        logger.exception("instrument upsert failed")
        return _bad(f"{exc.__class__.__name__}: {exc}")
    await _audit(
        "MANUAL_ADD",
        message=f"upsert {row.get('exchange_segment')}|{row.get('instrument_token')}"
                f"{' ' + row.get('symbol', '') if row.get('symbol') else ''}",
        status=("error" if (isinstance(result, dict) and result.get("error")) else "info"),
        meta={"instrument_key": f"{row.get('exchange_segment')}|{row.get('instrument_token')}",
              "symbol": row.get("symbol") or ""},
    )
    return _unwrap(lambda *_: result)


# ------------------------------------------------------------------
# Lifecycle transitions (single or batch)
# ------------------------------------------------------------------
def _rows_list(body: dict) -> list[dict]:
    tokens = body.get("tokens") or body.get("instruments")
    if isinstance(tokens, list) and tokens:
        return [_row_for({"exchange_segment": str(t.get("exchange_segment") or t.get("exchangeSegment") or "nse_cm"),
                          "instrument_token": str(t.get("instrument_token") or t.get("instrumentToken") or ""),
                          "symbol": t.get("symbol", "")}) for t in tokens]
    return [_row_for(body)]


async def _apply_lifecycle(body: dict, action: str, extra=None) -> dict:
    rows = [r for r in _rows_list(body) if r]
    if not rows:
        return _bad("instrument_token required")
    results = []
    for row in rows:
        try:
            if action == "subscribe":
                res = await session_manager.subscribe_instrument(row, source=body.get("source", "manual"))
            elif action == "unsubscribe":
                res = await session_manager.unsubscribe_instrument(row, source=body.get("source", "manual"))
            elif action == "pin":
                res = await session_manager.pin_instrument(
                    row, source=body.get("source", "manual"),
                    priority=body.get("priority", 1),
                    profile_id=body.get("profile_id", "PINNED_HIGH"),
                    consumers=body.get("consumers"),
                    reason=body.get("reason", ""),
                    expires_at=body.get("expires_at"),
                )
            elif action == "unpin":
                res = await session_manager.unpin_instrument(row, source=body.get("source", "manual"))
            elif action == "activate":
                res = await session_manager.activate_instrument(row, source=body.get("source", "manual"))
            elif action == "deactivate":
                res = await session_manager.deactivate_instrument(row, source=body.get("source", "manual"))
            elif action == "expire":
                expires_at = body.get("expires_at") or extra
                if expires_at is None:
                    import time
                    expires_at = time.time()
                res = await session_manager.set_instrument_expiry(
                    row, expires_at=expires_at, expiry_type=body.get("expiry_type", "DURATION"),
                    label=body.get("expiry_label"), source=body.get("source", "manual"))
            elif action == "remove":
                res = await session_manager.remove_instrument(
                    row, purge=bool(body.get("purge", False)), source=body.get("source", "manual"))
            elif action == "error":
                res = await session_manager.mark_instrument_error(
                    row, message=body.get("message", "instrument error"), source=body.get("source", "manual"))
            elif action == "clear-error":
                res = await session_manager.clear_instrument_error(row, source=body.get("source", "manual"))
            else:
                return _bad(f"unknown lifecycle action '{action}'")
            results.append(res)
            await _audit(
                f"INSTRUMENT_{action.upper()}",
                message=f"{action} {row.get('exchange_segment')}|{row.get('instrument_token')}"
                        f"{' ' + row.get('symbol', '') if row.get('symbol') else ''}",
                status=("error" if (isinstance(res, dict) and res.get("error")) else "info"),
                meta={"action": action,
                      "instrument_key": f"{row.get('exchange_segment')}|{row.get('instrument_token')}",
                      "symbol": row.get("symbol") or ""},
            )
        except (KeyError, ValueError, TypeError) as exc:
            return _bad(str(exc))
        except Exception as exc:  # noqa: BLE001 - defensive
            logger.exception("lifecycle %s failed", action)
            return _bad(f"{exc.__class__.__name__}: {exc}")
    return _ok({"applied": len(results), "instruments": results})


@router.post("/instruments/{instrument_id}/subscribe")
async def subscribe(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "subscribe")


@router.post("/instruments/{instrument_id}/unsubscribe")
async def unsubscribe(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "unsubscribe")


@router.post("/instruments/{instrument_id}/pin")
async def pin(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "pin")


@router.post("/instruments/{instrument_id}/unpin")
async def unpin(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "unpin")


@router.post("/instruments/{instrument_id}/activate")
async def activate(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "activate")


@router.post("/instruments/{instrument_id}/deactivate")
async def deactivate(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "deactivate")


@router.post("/instruments/{instrument_id}/expire")
async def expire(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "expire")


@router.post("/instruments/{instrument_id}/remove")
async def remove(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "remove")


@router.post("/instruments/{instrument_id}/error")
async def mark_error(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "error")


@router.post("/instruments/{instrument_id}/clear-error")
async def clear_error(instrument_id: str, body: dict = Body(default={})):
    row = _iid_split(instrument_id) or _row_for(body)
    if not row.get("exchange_segment") or not row.get("instrument_token"):
        return _bad("invalid instrument_id")
    return await _apply_lifecycle({**row, **body, "instrument_token": row["instrument_token"]}, "clear-error")


# ------------------------------------------------------------------
# Reconcile
# ------------------------------------------------------------------
@router.post("/reconcile")
async def reconcile():
    """Run every real expiry sweep + request normalization (honest, never
    fabricates expiries) and notify the WebSocket Engine to re-sync."""
    try:
        import time
        result = await session_manager.reconcile(now_ts=time.time())
    except Exception as exc:  # noqa: BLE001 - defensive
        return _bad(f"{exc.__class__.__name__}: {exc}")
    expired = 0
    failed = 0
    if isinstance(result, dict):
        expired = int(result.get("expired") or result.get("expiries_applied") or 0)
        failed_rows = result.get("errors") or result.get("failures") or []
        failed = len(failed_rows) if isinstance(failed_rows, list) else 0
    await _audit(
        "RECONCILE",
        message=f"reconcile completed (expired={expired}, failures={failed})",
        status="error" if failed else "info",
        meta={"expired": expired, "failures": failed},
    )
    return _ok(result)


# ------------------------------------------------------------------
# Session detail / history
# ------------------------------------------------------------------
@router.get("/session")
async def session_detail():
    """Structured Session Manager session view (identity, lifecycle,
    per-terminal records, websocket, routing, event ring tail). Safe —
    only identifiers / derived values, never credentials."""
    snap = session_manager.snapshot()
    return _ok({
        "identity": {
            "sessionId": snap.get("sessionId"),
            "sessionReference": snap.get("sessionReference"),
            "mode": snap.get("mode"),
            "broker": snap.get("broker"),
            "userId": snap.get("userId"),
            "loginSource": snap.get("loginSource"),
            "loginTime": snap.get("loginTime"),
            "expiresAt": snap.get("expiresAt"),
            "validatedAt": snap.get("validatedAt"),
            "remainingSeconds": snap.get("remainingSeconds"),
            "sessionDurationSeconds": snap.get("sessionDurationSeconds"),
        },
        "lifecycle": {
            "state": snap.get("state"),
            "stateMessage": snap.get("stateMessage"),
            "stateSince": snap.get("stateSince"),
            "lifecycleState": snap.get("lifecycleState"),
            "active": snap.get("active"),
        },
        "websocket": snap.get("websocket"),
        "routing": snap.get("sessionRouting"),
        "terminalSessions": snap.get("terminalSessions"),
        "sessionHistory": snap.get("sessionHistory"),
        "lastLogout": snap.get("lastLogout"),
        "lastActivityAt": snap.get("lastActivityAt"),
        "lastAuthError": snap.get("lastAuthError"),
        "lastAuthErrorAt": snap.get("lastAuthErrorAt"),
        "lastRestError": snap.get("lastRestError"),
        "events": (snap.get("events") or [])[-50:],
    })


@router.get("/session/history")
async def session_history(limit: int = 100):
    """Session lifecycle history: dedicated event_history ledger rows
    (``system_events`` source=session, restart-safe) merged with the
    in-memory event rings, newest-first. Honest: when MongoDB is down only
    the in-memory events are returned."""
    limit = max(1, min(int(limit), 500))
    merged: list[dict] = []
    try:
        from services.event_history import mongo_events, recent_events
        for row in await mongo_events(limit=limit, source="session"):
            row["persisted"] = True  # real flag for the UI: this row came from the DB ledger
            merged.append(row)
        for row in recent_events(limit=limit, source="session"):
            row.setdefault("persisted", False)  # fresh ring-buffer row (may flush to DB later)
            merged.append(row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("session history load failed: %s", exc)
    for e in reversed(session_manager.snapshot().get("events") or []):
        merged.append({
            "source": "session",
            "event": e.get("event"),
            "message": e.get("message"),
            "ts": e.get("at"),
            "meta": e.get("meta"),
            "persisted": False,
        })
    seen: set[tuple] = set()
    out: list[dict] = []
    for row in merged:
        key = (str(row.get("ts")), str(row.get("event")), str(row.get("message")))
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return _ok(out[:limit])


# ------------------------------------------------------------------
# Diagnostics
# ------------------------------------------------------------------
@router.get("/diagnostics")
async def diagnostics():
    """Assembled diagnostics for the Session Manager control plane: registry
    state/health of the session_manager engine + its dependencies, session
    health, revision intent/apply, per-connection state, MongoDB
    connectivity, effective configuration and the recent event distribution.
    Everything is derived from real state — never fabricated."""
    result: dict = {}
    try:
        from services.engine_registry import get_engine_registry
        engines: dict[str, dict] = {}
        for status in get_engine_registry().get_all_statuses():
            eid = status.get("engineId")
            if eid in ("session_manager", "connection_manager", "websocket_engine", "scheduler_engine"):
                engines[eid] = {
                    "state": status.get("state"),
                    "health": status.get("health"),
                    "healthReason": status.get("healthReason"),
                    "heartbeatAge": status.get("heartbeatAge"),
                    "managed": bool(status.get("managed", False)),
                    "version": status.get("version"),
                    "recentErrors": (status.get("recentErrors") or [])[:5],
                }
        result["engines"] = engines
    except Exception as exc:  # noqa: BLE001
        result["engines"] = {"error": f"{exc.__class__.__name__}: {exc}"}

    result["sessionHealth"] = session_manager.phase3_health()
    result["revisionStatus"] = session_manager.revision_status()
    result["connections"] = session_manager.connections_snapshot()

    try:
        from database.connection import is_mongo_connected
        result["mongo"] = {"connected": bool(is_mongo_connected())}
    except Exception as exc:  # noqa: BLE001
        result["mongo"] = {"connected": False, "error": str(exc)}

    try:
        from services.session import session_manager_config
        result["config"] = await session_manager_config.state()
    except Exception as exc:  # noqa: BLE001
        result["config"] = {"error": f"{exc.__class__.__name__}: {exc}"}

    event_counts: dict[str, int] = {}
    for e in session_manager.snapshot().get("events") or []:
        k = e.get("event") or "UNKNOWN"
        event_counts[k] = event_counts.get(k, 0) + 1
    result["recentSessionEvents"] = event_counts
    result["lastRestError"] = session_manager.snapshot().get("lastRestError")
    return _ok(result)


# ------------------------------------------------------------------
# Configuration (persisted; applies live to the runtime sessions)
# ------------------------------------------------------------------
@router.get("/config")
async def config_read():
    from services.session import session_manager_config
    config = await session_manager_config.get_config()
    state = await session_manager_config.state()
    return _ok({"config": config, "state": state})


@router.put("/config")
async def config_update(body: dict = Body(...)):
    """Persist + live-apply a config patch. Accepts either a raw patch
    (``{"session_lifetime_seconds": 7200}``) or a wrapped
    ``{"config": {...}, "updatedBy": "..."}`` payload."""
    from services.session import session_manager_config
    patch = body.get("config") if isinstance(body.get("config"), dict) else body
    try:
        config = await session_manager_config.set_config(
            patch, updated_by=str(body.get("updatedBy") or "manual"))
    except ValueError as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001 - defensive
        logger.exception("session config update failed")
        return _bad(f"{exc.__class__.__name__}: {exc}")
    await _audit(
        "CONFIG_CHANGE",
        message="session manager configuration updated",
        meta={f"{k}": str(v) for k, v in (dict(patch).items() if isinstance(patch, dict) else {}.items())},
    )
    return _ok(config)


@router.post("/config/reset")
async def config_reset_all():
    from services.session import session_manager_config
    result = await session_manager_config.reset_config()
    await _audit("CONFIG_RESET", message="session manager configuration reset to defaults",
                 status="warning")
    return _ok(result)


@router.post("/config/{key}/reset")
async def config_reset_key(key: str):
    from services.session import session_manager_config
    try:
        result = await session_manager_config.reset_config(key=key)
    except ValueError as exc:
        return _bad(str(exc))
    await _audit("CONFIG_RESET", message=f"session configuration key reset: {key}",
                 status="warning", meta={"key": key})
    return _ok(result)