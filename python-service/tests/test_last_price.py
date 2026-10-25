"""LastPrice — broker quote batching contract.

Kotak's quote endpoint rejects requests with more than 50 symbols. The weekly
Friday screen asks for the full NSE universe, so a regression here is not a
cosmetic detail: every oversized request becomes a 400, the resolver falls back
to old candle closes, and the screen looks like "no stock has a live price".
"""

from __future__ import annotations

import asyncio

import auth.kotak_client as kotak_client
import services.last_price as last_price


class _FakeKotakSession:
    session_active = True

    def __init__(self) -> None:
        self.calls: list[tuple[int, str]] = []

    async def async_quote(self, *, instrument_tokens, quote_type):
        self.calls.append((len(instrument_tokens), quote_type))
        return {
            "data": [
                {
                    "exchange_token": row["instrument_token"],
                    "ltp": 100.0,
                    "volume": 10,
                }
                for row in instrument_tokens
            ]
        }


def test_broker_quotes_chunks_below_the_50_symbol_broker_limit(monkeypatch):
    fake = _FakeKotakSession()
    monkeypatch.setattr(kotak_client, "kotak_session", fake)

    refs = [
        {"token": str(1000 + i), "symbol": f"SYM{i}", "segment": "nse_cm"}
        for i in range(120)
    ]
    out = asyncio.run(last_price._broker_quotes(refs))

    assert len(out) == 120
    assert fake.calls, "the broker must actually be called"
    # 50 is rejected by the live endpoint; 49 is the measured working ceiling.
    assert all(size <= 49 for size, _quote_type in fake.calls)
    assert {quote_type for _size, quote_type in fake.calls} == {"ltp", "ohlc"}
    # 120 symbols / 49 per chunk = 3 chunks, each asking for ltp + ohlc.
    assert len(fake.calls) == 6


def test_broker_quotes_can_skip_the_ohlc_round_trip(monkeypatch):
    fake = _FakeKotakSession()
    monkeypatch.setattr(kotak_client, "kotak_session", fake)

    refs = [
        {"token": str(2000 + i), "symbol": f"SCAN{i}", "segment": "nse_cm"}
        for i in range(60)
    ]
    out = asyncio.run(last_price._broker_quotes(refs, include_ohlc=False))

    assert len(out) == 60
    assert [quote_type for _size, quote_type in fake.calls] == ["ltp", "ltp"]
