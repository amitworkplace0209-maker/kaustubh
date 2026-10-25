import asyncio, json, sys
sys.path.insert(0, ".")
from config.settings import settings  # noqa: F401  (ensures config load)
from auth.kotak_client import kotak_session
from services.instrument_cache import load_instrument_cache, instrument_cache

inst = instrument_cache.lookup_by_symbol("RELIANCE")
print("RELIANCE inst:", {k: inst.get(k) for k in ("token", "exchangeSegment", "tradingSymbol")} if inst else None)

info = kotak_session.session_info()
print("session_info:", json.dumps({k: v for k, v in info.items() if k != "view_token"}, default=str))

async def main():
    tok = str(inst.get("token")) if inst else "2885"
    seg = str(inst.get("exchangeSegment") or "nse_cm")
    payload = [{"exchange_segment": seg, "instrument_token": tok}]
    try:
        raw = await kotak_session.async_quote(instrument_tokens=payload, quote_type="all")
        print("quote all keys:", list(raw.keys()) if isinstance(raw, dict) else type(raw))
        data = raw.get("data") if isinstance(raw, dict) else None
        print("quote data type:", type(data).__name__, "len:", len(data) if hasattr(data, "__len__") else "?")
        if isinstance(data, list) and data:
            it = data[0]
            print("item keys sample:", list(it.keys())[:20] if isinstance(it, dict) else it)
            print("token fields:", {k: it.get(k) for k in ("token", "instrument_token", "exchange_token", "exchange_segment") if isinstance(it, dict)})
            print("misAvailable:", it.get("misAvailable") if isinstance(it, dict) else None)
    except Exception as e:
        print("quote error:", type(e).__name__, str(e)[:300])

asyncio.run(main())