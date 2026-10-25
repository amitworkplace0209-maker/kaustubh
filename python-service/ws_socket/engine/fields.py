"""Master 344-field market-data schema with real Kotak WS evidence.

This is the single source of truth for the Central WebSocket Engine: it lists
every one of the 344 fields of ``master_stock_ai_340_field_schema (1).txt``,
classifies it against the installed SDK (``kotakneoapi`` 3.0.6 /
``neo_api_client``), and records which Kotak SFeed attribute/feed level (if
any) actually provides it. (Classified on 3.0.2, re-verified unchanged on
3.0.6 — models.py / protocol.py are byte-identical between the two.)

Evidence is derived from the installed SDK sources:
- models.py    : SFeedScrip, SFeedScripLite, SFeedIndex, SFeedMarketStatus,
                 SFeedCasChange, DepthLevel, WsToken, MarketStatusCode
- protocol.py  : native_batch wire decode (last_update_time, depth rows,
                 auction flag; header seq_no is discarded)
- quotes.py    : quote REST /quotes/<seg>|<tok>/all client
- scrip_master.py : scrip search / master lookups
- client.py    : SFeedWebSocket subscribe events (scrips/lite/depth/full_depth/index)

Statuses (non-negotiable, one per field):
  DIRECT_WS | WS_CONDITIONAL | QUOTE_REST_ONLY | OTHER_API | DERIVED |
  TARGET_LABEL | NOT_PROVIDED_BY_KOTAK_WS | NOT_VERIFIED

Nothing here is inferred from a REST quote existing — a field is only
DIRECT_WS when it is a real attribute of a typed SFeed message.
"""

from __future__ import annotations

from dataclasses import dataclass

# Category labels from the uploaded schema.
CAT_IDENTITY = "A. IDENTITY, INSTRUMENT & TIME"
CAT_PRICE = "B. PRICE & TRADE DATA"
CAT_VOLUME = "C. VOLUME & TRADE ACTIVITY"
CAT_BBA = "D. BEST BID / ASK"
CAT_DEPTH = "E. ORDER BOOK DEPTH"
CAT_FLOW = "F. ORDER-FLOW / MICROSTRUCTURE FEATURES"
CAT_RETURNS = "G. SHORT-TERM RETURNS / MOMENTUM"
CAT_ROLLING = "H. ROLLING / WINDOW FEATURES"
CAT_VOLATILITY = "I. VOLATILITY / RANGE"
CAT_TA = "J. TECHNICAL INDICATORS"
CAT_MARKET = "K. MARKET / INDEX CONTEXT"
CAT_TIME = "L. TIME / SESSION CONTEXT"
CAT_FNO = "M. FUTURES / F&O"
CAT_OPTIONS = "N. OPTIONS CHAIN / DERIVED OPTIONS FEATURES"
CAT_LIQUIDITY = "O. LIQUIDITY / EXECUTION FEATURES"
CAT_TARGETS = "P. AI TARGET / LABEL FIELDS"

# Statuses.
DIRECT_WS = "DIRECT_WS"
WS_CONDITIONAL = "WS_CONDITIONAL"
QUOTE_REST_ONLY = "QUOTE_REST_ONLY"
OTHER_API = "OTHER_API"
DERIVED = "DERIVED"
TARGET_LABEL = "TARGET_LABEL"
NOT_PROVIDED = "NOT_PROVIDED_BY_KOTAK_WS"
NOT_VERIFIED = "NOT_VERIFIED"

# Feed levels (SFeed Level enum + message contexts).
ANY = "any"
SCRIP = "scrip (level \u22652, subscribe_scrips)"
SCRIP_LITE = "scrip_lite (level 1, subscribe_scrips_lite)"
TOUCH = "touch line (level 4)"
DEPTH = "depth (level 8, subscribe_depth)"
FULL_DEPTH = "full depth (level 16, subscribe_full_depth)"
INDEX = "index (msg 7207, subscribe_indices)"
MARKET_STATUS = "market status (msg 105/6511/6521, subscribe_exchange)"
CAS = "CAS (msg 104, per-script during auction)"
ACK = "subscription ack (msg 1109)"
REST = "N/A - REST"
NA = "-"


@dataclass(frozen=True)
class FieldEntry:
    num: int
    field: str
    category: str
    status: str
    kotak_attr: str
    feed_level: str
    direct_derived: str = "Direct"
    evidence: str = ""
    notes: str = ""


F = FieldEntry

# Collect in schema order; row count must equal 344.
_FIELDS: list[FieldEntry] = [
    # ------------------------------------------------------------------ A
    F(1, "symbol", CAT_IDENTITY, DIRECT_WS, "trading_symbol", ACK,
      evidence="SFeedInstrumentMessage.trading_symbol (models.py), resolved from subscribe ack 1109"),
    F(2, "exchange", CAT_IDENTITY, DIRECT_WS, "exchange_segment", ANY,
      evidence="SFeedBase.exchange_segment (models.py)"),
    F(3, "exchange_token", CAT_IDENTITY, DIRECT_WS, "inputtoken", ANY,
      evidence="WsToken.inputtoken  '<exchange>|<token>' (models.py)"),
    F(4, "instrument_token", CAT_IDENTITY, DIRECT_WS, "instrument_token", ANY,
      evidence="SFeedBase.instrument_token (models.py)"),
    F(5, "instrument_type", CAT_IDENTITY, NOT_PROVIDED, NA, NA,
      evidence="None of the five SFeed message types carry instrument type",
      notes="Reason: no SFeed attribute; obtain from scrip master / quote REST instrumentType."),
    F(6, "timestamp", CAT_IDENTITY, DERIVED, "received_at", NA, "Derived",
      evidence="Engine reception wall-clock; broker sends no wall timestamp in SFeed",
      notes="Canonical 'received_at' field added by engine (raw data untouched)."),
    F(7, "exchange_timestamp", CAT_IDENTITY, DIRECT_WS, "last_update_time (scrip) / last_trade_time (index/lite)", ANY,
      evidence="SFeedScrip.last_update_time, SFeedIndex.last_trade_time, SFeedScripLite.last_trade_time"),
    F(8, "date", CAT_IDENTITY, DERIVED, "-", NA, "Derived",
      evidence="ISO date derived from exchange_timestamp", notes="Feature-Engine / normalizer output."),
    F(9, "trading_session", CAT_IDENTITY, WS_CONDITIONAL, "SFeedMarketStatus.status / status_code", MARKET_STATUS,
      evidence="MarketStatusCode (models.py): market open/closed/pre-open/auction broadcasts",
      notes="Exchange-level session state, not per-instrument."),
    F(10, "sequence_number", CAT_IDENTITY, NOT_PROVIDED, NA, NA,
      evidence="protocol.py header carries seq_no but decode_packet discards it (_seq_no); model has no attribute",
      notes="Reason: SDK does not expose the wire seq_no; cannot be claimed as direct."),
    F(11, "isin", CAT_IDENTITY, OTHER_API, "scrip master isin", REST,
      evidence="neo_api_client.services.scrip_master (search/identifiers); quote REST scrip master"),
    F(12, "company_name", CAT_IDENTITY, OTHER_API, "scrip master companyName", REST,
      evidence="neo_api_client.services.scrip_master search result companyName"),
    F(13, "sector", CAT_IDENTITY, NOT_VERIFIED, NA, NA,
      evidence="Not present in any SFeed message; local/third-party sector mapping source not fixed",
      notes="Pending: pick a sector taxonomy source before claiming."),
    F(14, "industry", CAT_IDENTITY, NOT_VERIFIED, NA, NA,
      evidence="Not present in any SFeed message; local/third-party industry mapping source not fixed",
      notes="Pending: same as sector."),
    F(15, "series", CAT_IDENTITY, OTHER_API, "scrip master series / quote REST", REST,
      evidence="scrip_master/quote response series (EQ/FUT/OPT...); not in SFeed"),
    F(16, "lot_size", CAT_IDENTITY, DIRECT_WS, "market_lot", SCRIP,
      evidence="SFeedScrip.market_lot / SFeedScripLite.market_lot (models.py)"),
    F(17, "tick_size", CAT_IDENTITY, DERIVED, "-", NA, "Derived",
      evidence="1 / 10^precision from SFeedScrip.precision",
      notes="precision is direct; tick_size is computed from it."),
    F(18, "currency", CAT_IDENTITY, OTHER_API, "scrip master currency", REST,
      evidence="scrip master currency field (INR/USD...); not in SFeed"),
    F(19, "market_segment", CAT_IDENTITY, DIRECT_WS, "exchange_segment", ANY,
      evidence="SFeedBase.exchange_segment / WsToken.exchange_segment"),
    F(20, "trading_status", CAT_IDENTITY, WS_CONDITIONAL, "SFeedMarketStatus.status (exchange-level)", MARKET_STATUS,
      evidence="SFeedMarketStatus.status_code/status",
      notes="Per-instrument trading_status bit exists on the wire but is discarded by protocol.py (_trading_status)."),

    # ------------------------------------------------------------------ B
    F(21, "ltp", CAT_PRICE, DIRECT_WS, "last_traded_price", ANY,
      evidence="SFeedScrip/SFeedScripLite/SFeedIndex.last_traded_price"),
    F(22, "ltq", CAT_PRICE, DIRECT_WS, "last_trade_qty", SCRIP,
      evidence="SFeedScrip.last_trade_qty / SFeedScripLite.last_trade_qty"),
    F(23, "last_trade_price", CAT_PRICE, DIRECT_WS, "last_traded_price", ANY,
      evidence="same as ltp"),
    F(24, "last_trade_quantity", CAT_PRICE, DIRECT_WS, "last_trade_qty", SCRIP,
      evidence="same as ltq"),
    F(25, "open", CAT_PRICE, DIRECT_WS, "open_price", SCRIP,
      evidence="SFeedScrip.open_price / SFeedIndex.open_price"),
    F(26, "high", CAT_PRICE, DIRECT_WS, "high_price", SCRIP,
      evidence="SFeedScrip.high_price / SFeedIndex.high_price"),
    F(27, "low", CAT_PRICE, DIRECT_WS, "low_price", SCRIP,
      evidence="SFeedScrip.low_price / SFeedIndex.low_price"),
    F(28, "previous_close", CAT_PRICE, DIRECT_WS, "close_price", SCRIP,
      evidence="SFeedScrip.close_price / SFeedScripLite.close_price (prev-day close during session)"),
    F(29, "price_change", CAT_PRICE, DIRECT_WS, "net_change", SCRIP,
      evidence="SFeedScrip.net_change / SFeedScripLite.net_change / SFeedIndex.change"),
    F(30, "price_change_pct", CAT_PRICE, DIRECT_WS, "net_change_percent", ANY,
      evidence="SFeedScrip/SFeedScripLite/SFeedIndex.net_change_percent (already /100 by protocol)"),
    F(31, "average_trade_price", CAT_PRICE, DIRECT_WS, "average_trade_price", SCRIP,
      evidence="SFeedScrip.average_trade_price (not in lite/index)"),
    F(32, "vwap", CAT_PRICE, DERIVED, "-", NA, "Derived",
      evidence="Feature-Engine: total_traded_value / volume_traded_today, or use average_trade_price",
      notes="No separate VWAP attribute in SFeed."),
    F(33, "upper_circuit", CAT_PRICE, DIRECT_WS, "upper_circuit_limit", SCRIP,
      evidence="SFeedScrip.upper_circuit_limit"),
    F(34, "lower_circuit", CAT_PRICE, DIRECT_WS, "lower_circuit_limit", SCRIP,
      evidence="SFeedScrip.lower_circuit_limit"),
    F(35, "trade_count", CAT_PRICE, NOT_PROVIDED, NA, NA,
      evidence="No trade-count in any SFeed message (only last_trade_qty)",
      notes="Reason: not transmitted; DERIVED possible from tick stream."),
    F(36, "last_trade_timestamp", CAT_PRICE, DIRECT_WS, "last_trade_time", SCRIP,
      evidence="SFeedScrip.last_trade_time (epoch, IST exchange time)"),
    F(37, "first_trade_price", CAT_PRICE, DERIVED, "-", NA, "Derived",
      evidence="Feature-Engine: first tick ltp of the day"),
    F(38, "day_high_timestamp", CAT_PRICE, DERIVED, "-", NA, "Derived",
      evidence="Feature-Engine: wall time when high_price last updated"),
    F(39, "day_low_timestamp", CAT_PRICE, DERIVED, "-", NA, "Derived",
      evidence="Feature-Engine: wall time when low_price last updated"),
    F(40, "settlement_price", CAT_PRICE, NOT_PROVIDED, NA, NA,
      evidence="No settlement price in any SFeed message",
      notes="Reason: not transmitted on market feed."),
    F(41, "indicative_price", CAT_PRICE, WS_CONDITIONAL, "SFeedCasChange.ref_price", CAS,
      evidence="SFeedCasChange.ref_price (models.py) during CAS window only",
      notes="Indicative close (_indicative_close) exists on the wire but is discarded by protocol.py."),
    F(42, "previous_day_high", CAT_PRICE, QUOTE_REST_ONLY, "quote REST previousDayHigh", REST,
      evidence="Kotak quote REST /quotes.../all (previousDayHigh); not in SFeed",
      notes="SFeed only carries yearly_high/low, not prev-day extremes."),
    F(43, "previous_day_low", CAT_PRICE, QUOTE_REST_ONLY, "quote REST previousDayLow", REST,
      evidence="Kotak quote REST /quotes.../all (previousDayLow); not in SFeed"),
    F(44, "previous_day_volume", CAT_PRICE, QUOTE_REST_ONLY, "quote REST previousDayVolume", REST,
      evidence="Kotak quote REST /quotes.../all (previousDayVolume); not in SFeed"),

    # ------------------------------------------------------------------ C
    F(45, "volume", CAT_VOLUME, DIRECT_WS, "volume_traded_today", SCRIP,
      evidence="SFeedScrip.volume_traded_today"),
    F(46, "volume_change", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine delta vs prior snapshot"),
    F(47, "volume_pct_change", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(48, "buy_volume", CAT_VOLUME, DIRECT_WS, "total_buy_quantity", SCRIP,
      evidence="SFeedScrip.total_buy_quantity"),
    F(49, "sell_volume", CAT_VOLUME, DIRECT_WS, "total_sell_quantity", SCRIP,
      evidence="SFeedScrip.total_sell_quantity"),
    F(50, "buy_volume_pct", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(51, "sell_volume_pct", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(52, "volume_imbalance", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(53, "cumulative_volume", CAT_VOLUME, DERIVED, "-", NA, "Derived",
      evidence="volume_traded_today is already today-cumulative; alias/downsample by Feature-Engine"),
    F(54, "average_trade_size", CAT_VOLUME, DERIVED, "-", NA, "Derived",
      evidence="volume / trade_count; trade_count not in SFeed"),
    F(55, "large_trade_volume", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine threshold on trade qty"),
    F(56, "large_trade_count", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(57, "trade_rate", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (ticks/min)"),
    F(58, "buy_trade_count", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine trade-direction inference"),
    F(59, "sell_trade_count", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(60, "buy_sell_trade_ratio", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(61, "volume_velocity", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(62, "volume_acceleration", CAT_VOLUME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ D
    F(63, "best_bid_price", CAT_BBA, DIRECT_WS, "buy[0].price", TOUCH,
      evidence="SFeedScrip.buy first DepthLevel.price"),
    F(64, "best_bid_qty", CAT_BBA, DIRECT_WS, "buy[0].quantity", TOUCH,
      evidence="SFeedScrip.buy first DepthLevel.quantity"),
    F(65, "best_ask_price", CAT_BBA, DIRECT_WS, "sell[0].price", TOUCH,
      evidence="SFeedScrip.sell first DepthLevel.price"),
    F(66, "best_ask_qty", CAT_BBA, DIRECT_WS, "sell[0].quantity", TOUCH,
      evidence="SFeedScrip.sell first DepthLevel.quantity"),
    F(67, "spread", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="ask0-bid0"),
    F(68, "spread_pct", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="spread/ltp"),
    F(69, "mid_price", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="(bid0+ask0)/2"),
    F(70, "bid_ask_imbalance", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(71, "bid_pressure", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(72, "ask_pressure", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(73, "bid_qty_change", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(74, "ask_qty_change", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(75, "mid_price_change", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(76, "microprice", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(77, "microprice_deviation", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(78, "quote_update_rate", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(79, "bid_ask_ratio", CAT_BBA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(80, "top_level_depth", CAT_BBA, DIRECT_WS, "buy[0]+sell[0]", TOUCH,
      evidence="SFeedScrip.buy/sell DepthLevel pairs"),

    # ------------------------------------------------------------------ E
    F(81, "bid1_price", CAT_DEPTH, WS_CONDITIONAL, "buy[0].price", DEPTH,
      evidence="SFeedScrip.buy[i].price, i=0; needs depth/full_depth + buy_depth_count>=1"),
    F(82, "bid1_qty", CAT_DEPTH, WS_CONDITIONAL, "buy[0].quantity", DEPTH,
      evidence="SFeedScrip.buy[i].quantity, i=0"),
    F(83, "bid2_price", CAT_DEPTH, WS_CONDITIONAL, "buy[1].price", DEPTH,
      evidence="SFeedScrip.buy[i].price, i=1; needs buy_depth_count>=2"),
    F(84, "bid2_qty", CAT_DEPTH, WS_CONDITIONAL, "buy[1].quantity", DEPTH,
      evidence="SFeedScrip.buy[i].quantity, i=1"),
    F(85, "bid3_price", CAT_DEPTH, WS_CONDITIONAL, "buy[2].price", DEPTH,
      evidence="SFeedScrip.buy[i].price, i=2"),
    F(86, "bid3_qty", CAT_DEPTH, WS_CONDITIONAL, "buy[2].quantity", DEPTH,
      evidence="SFeedScrip.buy[i].quantity, i=2"),
    F(87, "bid4_price", CAT_DEPTH, WS_CONDITIONAL, "buy[3].price", DEPTH,
      evidence="SFeedScrip.buy[i].price, i=3"),
    F(88, "bid4_qty", CAT_DEPTH, WS_CONDITIONAL, "buy[3].quantity", DEPTH,
      evidence="SFeedScrip.buy[i].quantity, i=3"),
    F(89, "bid5_price", CAT_DEPTH, WS_CONDITIONAL, "buy[4].price", DEPTH,
      evidence="SFeedScrip.buy[i].price, i=4"),
    F(90, "bid5_qty", CAT_DEPTH, WS_CONDITIONAL, "buy[4].quantity", DEPTH,
      evidence="SFeedScrip.buy[i].quantity, i=4"),
    F(91, "total_bid_depth", CAT_DEPTH, DERIVED, "-", NA, "Derived",
      evidence="sum(buy[].quantity) from depth snapshot (direct rows, engine aggregation)"),
    F(92, "weighted_bid_price", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(93, "bid_depth_change", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(94, "bid_depth_imbalance", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(95, "ask1_price", CAT_DEPTH, WS_CONDITIONAL, "sell[0].price", DEPTH,
      evidence="SFeedScrip.sell[i].price, i=0"),
    F(96, "ask1_qty", CAT_DEPTH, WS_CONDITIONAL, "sell[0].quantity", DEPTH,
      evidence="SFeedScrip.sell[i].quantity, i=0"),
    F(97, "ask2_price", CAT_DEPTH, WS_CONDITIONAL, "sell[1].price", DEPTH,
      evidence="SFeedScrip.sell[i].price, i=1"),
    F(98, "ask2_qty", CAT_DEPTH, WS_CONDITIONAL, "sell[1].quantity", DEPTH,
      evidence="SFeedScrip.sell[i].quantity, i=1"),
    F(99, "ask3_price", CAT_DEPTH, WS_CONDITIONAL, "sell[2].price", DEPTH,
      evidence="SFeedScrip.sell[i].price, i=2"),
    F(100, "ask3_qty", CAT_DEPTH, WS_CONDITIONAL, "sell[2].quantity", DEPTH,
      evidence="SFeedScrip.sell[i].quantity, i=2"),
    F(101, "ask4_price", CAT_DEPTH, WS_CONDITIONAL, "sell[3].price", DEPTH,
      evidence="SFeedScrip.sell[i].price, i=3"),
    F(102, "ask4_qty", CAT_DEPTH, WS_CONDITIONAL, "sell[3].quantity", DEPTH,
      evidence="SFeedScrip.sell[i].quantity, i=3"),
    F(103, "ask5_price", CAT_DEPTH, WS_CONDITIONAL, "sell[4].price", DEPTH,
      evidence="SFeedScrip.sell[i].price, i=4"),
    F(104, "ask5_qty", CAT_DEPTH, WS_CONDITIONAL, "sell[4].quantity", DEPTH,
      evidence="SFeedScrip.sell[i].quantity, i=4"),
    F(105, "total_ask_depth", CAT_DEPTH, DERIVED, "-", NA, "Derived",
      evidence="sum(sell[].quantity) from depth snapshot (direct rows, engine aggregation)"),
    F(106, "weighted_ask_price", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(107, "ask_depth_change", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(108, "ask_depth_imbalance", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(109, "total_orderbook_depth", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(110, "orderbook_imbalance", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(111, "depth_imbalance_level1", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(112, "depth_imbalance_level3", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(113, "depth_imbalance_level5", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(114, "book_pressure", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(115, "weighted_mid_price", CAT_DEPTH, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ F
    F(116, "trade_direction", CAT_FLOW, DERIVED, "-", NA, "Derived",
      evidence="SFeed gives no maker/taker tag; infer from trade vs bid/ask", notes="Feature-Engine."),
    F(117, "aggressive_buy_volume", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(118, "aggressive_sell_volume", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(119, "cumulative_delta", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(120, "delta_change", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(121, "order_flow_imbalance", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(122, "bid_cancel_volume", CAT_FLOW, DERIVED, "-", NA, "Derived",
      evidence="From depth snapshot diffs", notes="Feature-Engine."),
    F(123, "ask_cancel_volume", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(124, "bid_add_volume", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(125, "ask_add_volume", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(126, "order_arrival_rate", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(127, "order_cancel_rate", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(128, "order_add_rate", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(129, "net_order_flow", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(130, "signed_volume", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(131, "signed_trade_count", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(132, "buy_sell_pressure", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(133, "liquidity_pressure", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(134, "order_flow_velocity", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(135, "order_flow_acceleration", CAT_FLOW, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ G
    F(136, "return_1s", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(137, "return_5s", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(138, "return_10s", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(139, "return_25s", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(140, "return_30s", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(141, "return_1m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(142, "return_2m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(143, "return_5m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(144, "return_10m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(145, "return_15m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(146, "return_30m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(147, "momentum_5s", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(148, "momentum_10s", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(149, "momentum_30s", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(150, "momentum_1m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(151, "momentum_5m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(152, "momentum_10m", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(153, "price_distance_from_vwap", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(154, "price_distance_from_high", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(155, "price_distance_from_low", CAT_RETURNS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ H
    F(156, "mean_5s", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(157, "mean_10s", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(158, "mean_30s", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(159, "mean_1m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(160, "mean_5m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(161, "mean_10m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(162, "mean_15m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(163, "mean_30m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(164, "median_1m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(165, "rolling_std_1m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(166, "rolling_std_5m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(167, "rolling_std_10m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(168, "rolling_min_1m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(169, "rolling_max_1m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(170, "rolling_min_5m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(171, "rolling_max_5m", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(172, "rolling_volume_mean", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(173, "rolling_volume_std", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(174, "rolling_trade_count", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(175, "rolling_vwap", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(176, "rolling_range", CAT_ROLLING, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ I
    F(177, "volatility_10s", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(178, "volatility_30s", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(179, "volatility_1m", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(180, "volatility_5m", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(181, "volatility_10m", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(182, "realized_volatility", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(183, "parkinson_volatility", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(184, "atr", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(185, "atr_pct", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(186, "range", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(187, "range_pct", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(188, "high_low_range", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(189, "volatility_change", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(190, "volatility_ratio", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(191, "downside_volatility", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(192, "upside_volatility", CAT_VOLATILITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ J
    F(193, "rsi", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(194, "rsi_5", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(195, "rsi_14", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(196, "macd", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(197, "macd_signal", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(198, "macd_histogram", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(199, "ema_9", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(200, "ema_20", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(201, "ema_50", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(202, "ema_100", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(203, "sma_20", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(204, "sma_50", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(205, "bollinger_middle", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(206, "bollinger_upper", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(207, "bollinger_lower", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(208, "bollinger_width", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(209, "stochastic_k", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(210, "stochastic_d", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(211, "adx", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(212, "plus_di", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(213, "minus_di", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(214, "cci", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(215, "williams_r", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(216, "obv", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(217, "mfi", CAT_TA, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ K
    F(218, "nifty_ltp", CAT_MARKET, WS_CONDITIONAL, "SFeedIndex.last_traded_price (NIFTY)", INDEX,
      evidence="SFeedIndex (msg 7207) net index value; requires subscribe_indices for the index token"),
    F(219, "nifty_return", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(220, "nifty_change_pct", CAT_MARKET, WS_CONDITIONAL, "SFeedIndex.net_change_percent", INDEX,
      evidence="SFeedIndex.net_change_percent"),
    F(221, "nifty_vwap", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(222, "banknifty_ltp", CAT_MARKET, WS_CONDITIONAL, "SFeedIndex.last_traded_price (BANKNIFTY)", INDEX,
      evidence="SFeedIndex (msg 7207) for BANKNIFTY index token"),
    F(223, "banknifty_return", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(224, "banknifty_change_pct", CAT_MARKET, WS_CONDITIONAL, "SFeedIndex.net_change_percent", INDEX,
      evidence="SFeedIndex.net_change_percent"),
    F(225, "banknifty_vwap", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(226, "sector_index_ltp", CAT_MARKET, WS_CONDITIONAL, "SFeedIndex.last_traded_price (sector index)", INDEX,
      evidence="SFeedIndex if the sector index token is subscribable via subscribe_indices",
      notes="Depends on which index tokens the feed exposes; verify at runtime."),
    F(227, "sector_return", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(228, "sector_change_pct", CAT_MARKET, WS_CONDITIONAL, "SFeedIndex.net_change_percent", INDEX,
      evidence="SFeedIndex.net_change_percent (sector index)"),
    F(229, "sector_vwap", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(230, "sector_rank", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(231, "market_breadth", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (universe scan)"),
    F(232, "advance_count", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (universe scan)"),
    F(233, "decline_count", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (universe scan)"),
    F(234, "unchanged_count", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (universe scan)"),
    F(235, "advance_decline_ratio", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(236, "index_vwap_distance", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(237, "stock_vs_index_return", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(238, "stock_vs_sector_return", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(239, "relative_strength", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(240, "market_volatility", CAT_MARKET, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ L
    F(241, "seconds_from_open", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (IST session clock)"),
    F(242, "minutes_from_open", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(243, "minutes_to_close", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(244, "seconds_to_close", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(245, "day_of_week", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(246, "day_of_month", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(247, "week_of_year", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(248, "month", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(249, "is_opening_period", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (IST 09:15-09:45)"),
    F(250, "is_closing_period", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (IST 15:00-15:30)"),
    F(251, "is_lunch_period", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(252, "session_progress_pct", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(253, "time_bucket_5m", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(254, "time_bucket_15m", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(255, "opening_range_high", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (first 15m high)"),
    F(256, "opening_range_low", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (first 15m low)"),
    F(257, "opening_range_breakout", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(258, "closing_range", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(259, "gap_from_previous_close", CAT_TIME, DERIVED, "-", NA, "Derived",
      evidence="ltp - close_price (both DIRECT fields; difference is engine output)"),
    F(260, "gap_pct", CAT_TIME, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ M
    F(261, "expiry", CAT_FNO, OTHER_API, "quote REST expiry / scrip master", REST,
      evidence="Kotak quote /quotes.../all expiry; not in SFeed"),
    F(262, "days_to_expiry", CAT_FNO, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(263, "strike_price", CAT_FNO, OTHER_API, "quote REST strikePrice / scrip master", REST,
      evidence="Kotak quote /quotes.../all strikePrice; not in SFeed"),
    F(264, "option_type", CAT_FNO, OTHER_API, "quote REST instrumentType / scrip master", REST,
      evidence="instrumentType CE/PE from scrip master/quote; not in SFeed"),
    F(265, "open_interest", CAT_FNO, DIRECT_WS, "open_interest", SCRIP,
      evidence="SFeedScrip.open_interest"),
    F(266, "previous_open_interest", CAT_FNO, QUOTE_REST_ONLY, "quote REST previousOI", REST,
      evidence="Kotak quote /quotes.../all previousOI; not in SFeed"),
    F(267, "oi_change", CAT_FNO, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (oi - prevOI)"),
    F(268, "oi_change_pct", CAT_FNO, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(269, "futures_price", CAT_FNO, WS_CONDITIONAL, "SFeedScrip.last_traded_price (FUT token)", SCRIP,
      evidence="Only when the corresponding FUT scrip is subscribed; not part of the underlying's message"),
    F(270, "futures_return", CAT_FNO, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(271, "basis", CAT_FNO, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (fut - spot)"),
    F(272, "basis_pct", CAT_FNO, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(273, "futures_volume", CAT_FNO, WS_CONDITIONAL, "SFeedScrip.volume_traded_today (FUT token)", SCRIP,
      evidence="Only when the FUT scrip is subscribed"),
    F(274, "futures_vwap", CAT_FNO, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(275, "futures_spread", CAT_FNO, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(276, "futures_bid", CAT_FNO, WS_CONDITIONAL, "SFeedScrip.buy[0].price (FUT token)", TOUCH,
      evidence="Only when the FUT scrip is subscribed"),
    F(277, "futures_ask", CAT_FNO, WS_CONDITIONAL, "SFeedScrip.sell[0].price (FUT token)", TOUCH,
      evidence="Only when the FUT scrip is subscribed"),
    F(278, "futures_bid_qty", CAT_FNO, WS_CONDITIONAL, "SFeedScrip.buy[0].quantity (FUT token)", TOUCH,
      evidence="Only when the FUT scrip is subscribed"),
    F(279, "futures_ask_qty", CAT_FNO, WS_CONDITIONAL, "SFeedScrip.sell[0].quantity (FUT token)", TOUCH,
      evidence="Only when the FUT scrip is subscribed"),
    F(280, "implied_volatility", CAT_FNO, NOT_PROVIDED, NA, NA,
      evidence="No IV field in any SFeed message; also not verified in the quote REST response",
      notes="Reason: not transmitted by Kotak market feed."),

    # ------------------------------------------------------------------ N
    F(281, "call_volume", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (option chain snapshots)"),
    F(282, "put_volume", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(283, "call_oi", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(284, "put_oi", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(285, "call_oi_change", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(286, "put_oi_change", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(287, "pcr_volume", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(288, "pcr_oi", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(289, "max_pain", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(290, "iv_rank", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(291, "iv_change", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(292, "iv_percentile", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(293, "call_put_spread", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(294, "call_put_volume_ratio", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(295, "call_put_oi_ratio", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(296, "option_chain_depth", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(297, "call_delta", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (BS greeks)"),
    F(298, "put_delta", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (BS greeks)"),
    F(299, "call_gamma", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (BS greeks)"),
    F(300, "put_gamma", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (BS greeks)"),
    F(301, "call_theta", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (BS greeks)"),
    F(302, "put_theta", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (BS greeks)"),
    F(303, "call_vega", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (BS greeks)"),
    F(304, "put_vega", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine (BS greeks)"),
    F(305, "skew", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(306, "volatility_smile_slope", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(307, "atm_iv", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(308, "otm_call_iv", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(309, "otm_put_iv", CAT_OPTIONS, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ O
    F(310, "effective_spread", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(311, "realized_spread", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(312, "quoted_spread", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(313, "liquidity_score", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(314, "depth_score", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(315, "execution_cost_estimate", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(316, "slippage_estimate", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(317, "market_impact_estimate", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(318, "price_impact_per_volume", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),
    F(319, "turnover", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived",
      evidence="SFeedScrip.total_traded_value is the direct turnover value; schema turnover kept as engine alias"),
    F(320, "turnover_velocity", CAT_LIQUIDITY, DERIVED, "-", NA, "Derived", evidence="Feature-Engine"),

    # ------------------------------------------------------------------ P
    F(321, "target_return_10s", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label",
      evidence="Training label from future ticks (Feature-Engine, strictly future window)"),
    F(322, "target_return_30s", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(323, "target_return_1m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(324, "target_return_5m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(325, "target_return_10m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(326, "target_return_15m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(327, "target_return_30m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(328, "target_direction_10s", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(329, "target_direction_30s", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(330, "target_direction_1m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(331, "target_direction_5m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(332, "target_direction_10m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(333, "target_direction_15m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(334, "target_direction_30m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(335, "target_max_future_return_1m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(336, "target_max_future_return_5m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(337, "target_max_future_return_10m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(338, "target_max_future_drawdown_1m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(339, "target_max_future_drawdown_5m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(340, "target_max_future_drawdown_10m", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(341, "target_hit_take_profit", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(342, "target_hit_stop_loss", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(343, "target_risk_reward", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
    F(344, "target_future_vwap_distance", CAT_TARGETS, TARGET_LABEL, "-", NA, "Label", evidence="future window"),
]

# Additional real Kotak SFeed fields discovered and NOT present in the 344-field
# schema (for the verification report's "ADDITIONAL KOTAK FIELDS DISCOVERED").
_ADDITIONAL: list[FieldEntry] = [
    F(1001, "total_traded_value", CAT_PRICE, DIRECT_WS, "total_traded_value", SCRIP,
      evidence="SFeedScrip.total_traded_value (daily turnover value) - not in schema"),
    F(1002, "yearly_high", CAT_PRICE, DIRECT_WS, "yearly_high", SCRIP,
      evidence="SFeedScrip.yearly_high / SFeedIndex.yearly_high - distinct from prev-day high"),
    F(1003, "yearly_low", CAT_PRICE, DIRECT_WS, "yearly_low", SCRIP,
      evidence="SFeedScrip.yearly_low / SFeedIndex.yearly_low"),
    F(1004, "auction", CAT_PRICE, DIRECT_WS, "auction (bool)", SCRIP,
      evidence="SFeedScrip.auction from wire auction_flag (protocol.py)"),
    F(1005, "precision", CAT_IDENTITY, DIRECT_WS, "precision", SCRIP,
      evidence="SFeedScrip.precision / SFeedScripLite/SFeedIndex - decimal places"),
    F(1006, "multiplier", CAT_IDENTITY, DIRECT_WS, "multiplier", SCRIP,
      evidence="SFeedScrip.multiplier (contract multiplier)"),
    F(1007, "bid_order_count / ask_order_count", CAT_DEPTH, WS_CONDITIONAL, "DepthLevel.orders", DEPTH,
      evidence="SFeedScrip.buy[i].orders / sell[i].orders (orders behind each level)"),
    F(1008, "depth_row_count", CAT_DEPTH, WS_CONDITIONAL, "len(buy)/len(sell)", DEPTH,
      evidence="row counts from depth-level packets (protocol.py buy_depth_count/sell_depth_count)"),
    F(1009, "market_status_code", CAT_IDENTITY, DIRECT_WS, "status_code", MARKET_STATUS,
      evidence="SFeedMarketStatus.status_code + MARKET_STATUS_TEXT (models.py)"),
    F(1010, "index_name", CAT_IDENTITY, DIRECT_WS, "name", INDEX,
      evidence="SFeedIndex.name"),
    F(1011, "cas_reference_price", CAT_PRICE, WS_CONDITIONAL, "ref_price", CAS,
      evidence="SFeedCasChange.ref_price during CAS"),
    F(1012, "cas_imbalance_qty", CAT_VOLUME, WS_CONDITIONAL, "imbalance_qty", CAS,
      evidence="SFeedCasChange.imbalance_qty during CAS"),
    F(1013, "cas_imbalance_qty_at_market", CAT_VOLUME, WS_CONDITIONAL, "imbalance_qty_at_market", CAS,
      evidence="SFeedCasChange.imbalance_qty_at_market during CAS"),
    F(1014, "message_type", CAT_IDENTITY, DIRECT_WS, "type", ANY,
      evidence="SFeed*.type ('scrip'/'scrip_lite'/'index'/'market_status'/'cas_change')"),
    F(1015, "feed_level", CAT_IDENTITY, DIRECT_WS, "SFeedScrip.level", SCRIP,
      evidence="SFeedScrip.level (2/4/8/16)"),
    F(1016, "last_update_time", CAT_IDENTITY, DIRECT_WS, "last_update_time", SCRIP,
      evidence="SFeedScrip.last_update_time (market-picture update clock, epoch)"),
    F(1017, "total_buy_quantity / total_sell_quantity", CAT_VOLUME, DIRECT_WS, "total_buy_quantity / total_sell_quantity", SCRIP,
      evidence="SFeedScrip totals (schema buy_volume/sell_volume map to these)"),
    F(1018, "net_change / net_change_percent", CAT_PRICE, DIRECT_WS, "net_change / net_change_percent", SCRIP,
      evidence="SFeedScrip/SFeedScripLite/SFeedIndex (schema price_change / price_change_pct map to these)"),
]


def field_count() -> int:
    return len(_FIELDS)


def get_field(num: int) -> FieldEntry:
    return _FIELDS[num - 1]


def unique_field_names() -> list[str]:
    return [f.field for f in _FIELDS]


def additional_fields() -> list[FieldEntry]:
    return list(_ADDITIONAL)


def status_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for f in _FIELDS:
        counts[f.status] = counts.get(f.status, 0) + 1
    return counts


def not_provided_reasons() -> list[str]:
    return [
        f"Field {f.num} '{f.field}': {f.notes or f.evidence}"
        for f in _FIELDS
        if f.status == NOT_PROVIDED
    ]


def direct_ws_attributes() -> list[str]:
    return [
        f"Field {f.num} '{f.field}' -> SFeed attribute {f.kotak_attr} (feed: {f.feed_level})"
        for f in _FIELDS
        if f.status == DIRECT_WS
    ]