"""Data Saver storage-doc builder.

Builds the Mongo ``db.ticks`` document. Two storage schemas are supported,
selected by the live runtime setting ``ds_storage_schema``:

* ``legacy`` (default, backwards-compatible): the flat 28-key market-data
  surface (ltp, open, high, low ..., bp/bq/sp/sq, buy/sell arrays) exactly as
  every pre-existing Mongo consumer expects, PLUS every decoded SFeed attribute
  the old ``ws_manager._sfeed_to_raw`` projection used to drop (full depth
  rows, market_lot, precision, multiplier, auction, yearly_high, yearly_low,
  CAS and market-status values), PLUS the immutable raw broker blob and the
  ``master_canonical`` envelope. Nothing is lost on the way to Mongo and the
  original Kotak message is always recoverable.
* ``canonical_only`` (CANONICAL-ONLY STORAGE): market data is persisted EXACTLY
  once, under ``master_canonical.<section>.<field>`` (the 52-field contract
  built by ``ws_socket.engine.master_canonical``). The legacy flat keys and the
  duplicate depth surfaces are NOT written. Document root carries only
  identity/time/feed metadata (index needs) plus the isolated raw audit
  envelope. Depth is authoritative ONLY as ``master_canonical.depth.buy[] /
  sell[]``; derived values live once under ``master_canonical.derived``; raw
  broker data stays in the ``raw`` envelope (never as duplicate market-data
  fields).

No values are fabricated here. Broker fields are copied verbatim from the
canonical ``fields`` block or the master canonical sections; values such as
net_change / net_change_pct come from the SDK decode untouched.
"""

from __future__ import annotations

from datetime import datetime, timezone


def _dt(epoch_seconds) -> datetime | None:
    """Epoch seconds (SDK last_trade_time) -> timezone-aware datetime."""
    if epoch_seconds is None:
        return None
    try:
        return datetime.fromtimestamp(float(epoch_seconds), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def _identity_block(payload: dict) -> dict:
    trading_symbol = str(payload.get("trading_symbol") or "")
    symbol = str(trading_symbol).split("-")[0] if trading_symbol and "-" in trading_symbol else trading_symbol
    return {
        "symbol": symbol,
        "tradingSymbol": trading_symbol,
        "instrumentToken": str(payload.get("instrument_token") or ""),
        "exchangeSegment": payload.get("exchange_segment") or "nse_cm",
        "feed_type": payload.get("feed_type"),
        "feed_level": payload.get("feed_level"),
        "event_id": payload.get("event_id"),
        "event_type": payload.get("event_type"),
        "schema_version": payload.get("schema_version"),
        "sdk_version": payload.get("sdk_version"),
        "source": payload.get("source"),
        "ts": _dt(payload.get("broker_timestamp")),
        "receivedAt": _dt(payload.get("received_at")) or datetime.now(timezone.utc),
    }


def _raw_audit_block(payload: dict) -> dict:
    """Isolated raw broker audit envelope. Never carries market-data fields."""
    raw = payload.get("raw")
    return {
        "raw_reference": payload.get("raw_reference"),
        "raw": raw if isinstance(raw, dict) else None,
    }


def to_storage_doc(payload: dict, storage_schema: str | None = None) -> dict:
    """Build one Mongo tick document from a routed Data Saver payload.

    ``storage_schema`` defaults to the live runtime setting
    ``ds_storage_schema`` (``legacy`` when unset/invalid). When ``canonical_only``
    the document carries ONLY the master canonical market-data representation.
    """
    canonical = payload.get("master_canonical") or {}
    if isinstance(canonical, dict) and canonical and storage_schema is None:
        try:
            from services.runtime_settings import get_runtime_setting

            storage_schema = get_runtime_setting("ds_storage_schema")
        except Exception:
            storage_schema = None

    if isinstance(canonical, dict) and canonical and storage_schema == "canonical_only":
        doc: dict = {
            **(_identity_block(payload)),
            **_raw_audit_block(payload),
            "master_canonical": canonical,
        }
        return doc

    return _legacy_doc(payload)


def _legacy_doc(payload: dict) -> dict:
    """Original legacy flat document shape (superset, backwards-compatible)."""
    fields = payload.get("fields") or {}
    token = str(payload.get("instrument_token") or "")
    segment = payload.get("exchange_segment") or "nse_cm"
    trading_symbol = str(payload.get("trading_symbol") or "")
    symbol = str(trading_symbol).split("-")[0] if trading_symbol and "-" in trading_symbol else trading_symbol

    buy = fields.get("buy") or []
    sell = fields.get("sell") or []
    bp = buy[0].get("price") if buy else None
    bq = buy[0].get("quantity") if buy else None
    sp = sell[0].get("price") if sell else None
    sq = sell[0].get("quantity") if sell else None

    return {
        # identity
        "symbol": symbol,
        "tradingSymbol": trading_symbol,
        "instrumentToken": token,
        "exchangeSegment": segment,

        # ---- legacy 28-key surface (consumers depend on these exact names) ----
        "ltp": fields.get("ltp"),
        "open": fields.get("open"),
        "high": fields.get("high"),
        "low": fields.get("low"),
        "close": fields.get("prev_close"),
        "volume": fields.get("volume"),
        "ltq": fields.get("ltq"),
        "tbq": fields.get("total_buy_quantity"),
        "tsq": fields.get("total_sell_quantity"),
        "bp": bp,
        "bq": bq,
        "sp": sp,
        "sq": sq,
        # Legacy alias: best-bid size. Was previously (incorrectly) the ask
        # quantity — fixed to carry the top-of-book bid quantity.
        "bs": bq,
        "averagePrice": fields.get("avg_price"),
        "change": fields.get("net_change"),
        "changePercent": fields.get("net_change_pct"),
        "oi": fields.get("open_interest"),
        "upper_circuit_limit": fields.get("upper_circuit_limit"),
        "lower_circuit_limit": fields.get("lower_circuit_limit"),
        "total_traded_value": fields.get("total_traded_value"),
        "last_update_time": fields.get("last_update_time"),

        # ---- NEW: previously-dropped decoded SFeed surface (lossless) ----
        "last_trade_time": fields.get("last_trade_time"),
        "yearly_high": fields.get("yearly_high"),
        "yearly_low": fields.get("yearly_low"),
        "market_lot": fields.get("market_lot"),
        "precision": fields.get("precision"),
        "multiplier": fields.get("multiplier"),
        "auction": fields.get("auction"),
        "buy": buy,
        "sell": sell,
        "level": payload.get("feed_level"),
        "message_type": payload.get("feed_type"),

        # ---- CAS / market-status / index extras pass through unchanged ----
        "ref_price": fields.get("ref_price"),
        "imbalance_qty": fields.get("imbalance_qty"),
        "imbalance_qty_at_market": fields.get("imbalance_qty_at_market"),
        "status_code": fields.get("status_code"),
        "status": fields.get("status"),
        "index_name": fields.get("name"),

        # ---- canonical envelope ----
        "event_id": payload.get("event_id"),
        "event_type": payload.get("event_type"),
        "schema_version": payload.get("schema_version"),
        "sdk_version": payload.get("sdk_version"),
        "source": payload.get("source"),
        "feed_type": payload.get("feed_type"),
        "feed_level": payload.get("feed_level"),
        "raw_reference": payload.get("raw_reference"),
        "raw": payload.get("raw"),
        "master_canonical": payload.get("master_canonical"),

        # ---- time fields ----
        "ts": _dt(payload.get("broker_timestamp")),
        "receivedAt": _dt(payload.get("received_at")) or datetime.now(timezone.utc),
    }