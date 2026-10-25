"""Sanctioned Kotak feed classification — single source of truth.

This is the authoritative mapping that decides which NSE CM instruments must
use L8 ``subscribe_depth()`` (depth stocks), which must use the index
``subscribe_index()`` feed, and which stay on the L4 ``subscribe_scrips()``
scrip feed. The runtime instrument cache consults this module when stamping
every instrument row, so ``isIndex / isDepth / feedLevel / marketData`` are
always present on lookups — regardless of whether that master was loaded from
disk, freshly downloaded, or re-indexed after a Kotak reload.

Nothing here ever downgrades an explicit flag: the values below are the
sanctioned defaults; the instrument-specific flags produced from this map are
OR-merged with any persisted stock intent (an explicit depth pin is never
turned off).
"""

# Indices that must use subscribe_index() (Kotak L4 index feed family).
INDEX_SYMBOLS = {
    "NIFTY",
    "BANKNIFTY",
    "FINNIFTY",
    "MIDCPNIFTY",
}

# Popular NSE CM stocks that must use L8 depth (subscribe_depth). These are the
# sanctioned deep-feed instruments; everything else in the EQ master stays on
# the L4 scrip feed.
DEPTH_STOCKS = {
    "WIPRO",
    "RELIANCE",
    "TCS",
    "INFY",
    "HDFCBANK",
    "ICICIBANK",
    "SBIN",
    "AXISBANK",
    "KOTAKBANK",
    "BAJFINANCE",
    "BAJAJFINSV",
    "HINDUNILVR",
    "ITC",
    "LT",
    "TATAMOTORS",
    "MARUTI",
    "SUNPHARMA",
    "DRREDDY",
    "CIPLA",
    "DIVISLAB",
    "M&M",
    "BHARTIARTL",
    "ADANIENT",
    "ADANIPORTS",
    "COALINDIA",
    "NTPC",
    "POWERGRID",
    "BPCL",
    "HINDALCO",
    "VEDL",
    "TATASTEEL",
    "JSWSTEEL",
    "ULTRACEMCO",
    "GRASIM",
    "SHREECEM",
    "ASIANPAINT",
    "TECHM",
    "HIKAL",
    "EIHOTEL",
    "BOSCHLTD",
    "IFCI",
    "ONGC",
    "CUPID",
    "IRCTC",
}


def sanctioned_classification(symbol: str) -> dict:
    """Return the sanctioned {isIndex, isDepth, feedLevel, marketData} flags
    for an uppercased NSE CM symbol. Defaults to the L4 scrip feed.
    """
    sym = str(symbol or "").strip().upper()
    if sym in INDEX_SYMBOLS:
        return {
            "isIndex": True,
            "isDepth": False,
            "feedLevel": None,
            "marketData": "INDEX",
        }
    if sym in DEPTH_STOCKS:
        return {
            "isIndex": False,
            "isDepth": True,
            "feedLevel": 8,
            "marketData": "L8",
        }
    return {
        "isIndex": False,
        "isDepth": False,
        "feedLevel": 4,
        "marketData": "L4",
    }


def sanctioned_flags(symbol: str) -> dict:
    """Return the sanctioned feed-selection flags for ``symbol``.

    The runtime instrument cache stamps every master row with these flags
    (see ``services.instrument_cache._parse_rows``) so any lookup carries
    ``isIndex / isDepth / feedLevel / marketData``. Alias of
    :func:`sanctioned_classification`.
    """
    return sanctioned_classification(symbol)
