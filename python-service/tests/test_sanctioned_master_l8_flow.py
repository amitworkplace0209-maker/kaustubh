"""Sanctioned-master L8 desired-set flow tests (real sanctioned master, eng ok).

End-to-end REAL enrichment chain (no flag fakes, no hardcoded stamping):

1. ``services.sanctioned_master.sanctioned_flags`` — the real flag projector the
   runtime instrument cache stamps onto every master row: ``WIPRO`` → L8 depth
   (``isDepth=True / feedLevel=8 / marketData=L8``), ``NIFTY`` → index feed,
   plain equity (``HDFC``) → L4.
2. ``services.instrument_cache`` REAL parse + token lookup with the sanctioned
   flags stamped onto the rows.
3. The FULL desired-set refresh (``refresh_desired_subscriptions``) enriches the
   persisted seed docs with the real sanctioned flags for all 8 L8 depth tokens
   (``isDepth=True / feedLevel=8 / marketData=L8``), and the ws-preparation keys
   (``subscription_desired_keys``) carry them so the scheduler feeds L8 intent to
   the engine.

Run:  python -m pytest tests/test_sanctioned_master_l8_flow.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services import sanctioned_master
import services.instrument_cache as ic

_TRADE_8 = ("WIPRO", "RELIANCE", "TCS", "INFY", "HDFCBANK",
            "ICICIBANK", "SBIN", "AXISBANK")
_MASTER_CSV = (
    "pSymbolName,pSymbol,pExchSeg,pSeries,pInstType,pTrdSymbol\n"
    "WIPRO,2885,nse_cm,EQ,EQ,WIPRO\n"
    "NIFTY,26000,nse_cm,EQ,EQ,NIFTY 50\n"
    "HDFC,1,nse_cm,EQ,EQ,HDFC\n"
)


def _master_csv(extra: str) -> str:
    lines = [_MASTER_CSV.splitlines()[0]]
    lines.extend(extra.splitlines())
    return "\n".join(lines)


def _mast_extra(rows: str) -> str:
    return _master_csv(rows)


class SanctionedFlagsTest(unittest.TestCase):
    def test_depth_stock_is_l8(self):
        flags = sanctioned_master.sanctioned_flags("WIPRO")
        self.assertFalse(flags["isIndex"])
        self.assertTrue(flags["isDepth"])
        self.assertEqual(flags["feedLevel"], 8)
        self.assertEqual(flags["marketData"], "L8")

    def test_lowercase_symbol_is_normalized(self):
        flags = sanctioned_master.sanctioned_flags("wipro")
        self.assertTrue(flags["isDepth"])
        self.assertEqual(flags["feedLevel"], 8)

    def test_index_symbol_uses_index_feed(self):
        flags = sanctioned_master.sanctioned_flags("NIFTY")
        self.assertTrue(flags["isIndex"])
        self.assertFalse(flags["isDepth"])
        self.assertEqual(flags["marketData"], "INDEX")

    def test_plain_equity_stays_l4(self):
        flags = sanctioned_master.sanctioned_flags("HDFC")
        self.assertFalse(flags["isIndex"])
        self.assertFalse(flags["isDepth"])
        self.assertEqual(flags["feedLevel"], 4)
        self.assertEqual(flags["marketData"], "L4")

    def test_all_depth_stocks_classified(self):
        for sym in _TRADE_8:
            self.assertTrue(sanctioned_master.sanctioned_flags(sym)["isDepth"], sym)


def _stock(token: int, symbol: str) -> dict:
    """Persisted stock doc as the OLD hardcoded API path wrote it: both flags
    explicitly False (the bug being guarded against)."""
    return {
        "symbol": symbol,
        "instrumentToken": str(token),
        "exchangeSegment": "nse_cm",
        "internalIndex": token,
        "isIndex": False,
        "isDepth": False,
        "feedLevel": None,
        "marketData": None,
        "active": True,
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
    }


class FakeStocks:
    def __init__(self, rows):
        self._rows = list(rows)

    def find(self, query=None, projection=None):
        return self

    async def to_list(self, length=None):
        return [dict(r) for r in self._rows]


class FakeDB:
    def __init__(self, stocks):
        self.stocks = FakeStocks(stocks)


class CacheHarness:
    """Seeds the REAL instrument cache (sanctioned-flags stamped) once."""

    @classmethod
    async def seed(cls, token_symbols):
        import csv
        import io

        import services.instrument_cache as ic

        csv_text = _mast_extra(
            "".join(f"{sym},{tok},nse_cm,EQ,EQ,{sym}\n" for tok, sym in token_symbols)
        )
        rows = list(csv.DictReader(io.StringIO(csv_text)))
        parsed = ic.instrument_cache._parse_rows(rows)
        with mock.patch.object(ic.instrument_cache, "_loaded", True):
            ic.instrument_cache._index(parsed)
        return parsed

    @classmethod
    def clear(cls):
        import services.instrument_cache as ic

        with ic.instrument_cache._lock:
            ic.instrument_cache._instruments = []
            ic.instrument_cache._by_symbol = {}
            ic.instrument_cache._by_token = {}
            ic.instrument_cache._loaded = False


class InstrumentCacheFlagsTest(unittest.TestCase):
    @classmethod
    def _parsed_rows(cls):
        import csv
        import io

        import services.instrument_cache as ic

        rows = list(csv.DictReader(io.StringIO(_MASTER_CSV)))
        return ic.instrument_cache._parse_rows(rows)

    def test_parse_rows_stamps_real_flags(self):
        parsed = self._parsed_rows()
        wipro = next(p for p in parsed if p["symbol"] == "WIPRO")
        self.assertTrue(wipro["isDepth"])
        self.assertFalse(wipro["isIndex"])
        self.assertEqual(wipro["feedLevel"], 8)
        self.assertEqual(wipro["marketData"], "L8")

        nifty = next(p for p in parsed if p["symbol"] == "NIFTY")
        self.assertTrue(nifty["isIndex"])
        self.assertEqual(nifty["marketData"], "INDEX")

        hdfc = next(p for p in parsed if p["symbol"] == "HDFC")
        self.assertFalse(hdfc["isDepth"])
        self.assertEqual(hdfc["feedLevel"], 4)
        self.assertEqual(hdfc["marketData"], "L4")

    def test_lookup_by_token_carries_sanctioned_flags(self):
        import services.instrument_cache as ic

        parsed = self._parsed_rows()
        with mock.patch.object(ic.instrument_cache, "_loaded", True):
            ic.instrument_cache._index(parsed)
            inst = ic.instrument_cache.lookup_by_token("2885")
        self.assertIsNotNone(inst)
        self.assertTrue(inst["isDepth"])
        self.assertFalse(inst["isIndex"])
        self.assertEqual(inst["feedLevel"], 8)
        self.assertEqual(inst["marketData"], "L8")


class L8DesiredSetFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import services.session.session_manager as sm

        self.get_db_patch = mock.patch("database.connection.get_db")
        self.mock_db = self.get_db_patch.start()
        self.addCleanup(self.get_db_patch.stop)

        from services.session.session_manager import CentralSessionManager

        self.mgr = CentralSessionManager()
        await CacheHarness.seed([(2885 + i, sym) for i, sym in enumerate(_TRADE_8)])
        self.addCleanup(CacheHarness.clear)

    def _seed_db(self):
        self.mock_db.return_value = FakeDB(
            [_stock(2885 + i, symbol=sym) for i, sym in enumerate(_TRADE_8)]
        )

    async def test_l8_desired_keys_carry_real_flags(self):
        self._seed_db()
        with mock.patch.object(ic.instrument_cache, "_loaded", True):
            await self.mgr.refresh_desired_subscriptions(force=True)
        keys = self.mgr.subscription_desired_keys()
        self.assertEqual(len(keys), 8)
        for k in keys:
            self.assertTrue(k.get("isDepth"), k)
            self.assertFalse(k.get("isIndex"), k)
            self.assertEqual(k.get("feedLevel"), 8, k)
            self.assertEqual(k.get("marketData"), "L8", k)

    async def test_snapshot_rows_carry_enriched_flags(self):
        self._seed_db()
        with mock.patch.object(ic.instrument_cache, "_loaded", True):
            await self.mgr.refresh_desired_subscriptions(force=True)
            rows = self.mgr.subscription_snapshot()["instruments"]
        self.assertEqual(len(rows), 8)
        for row in rows:
            self.assertTrue(row["is_depth"], row)
            self.assertFalse(row["is_index"], row)
            self.assertEqual(row["feed_level"], 8, row)
            self.assertEqual(row["market_data"], "L8", row)


if __name__ == "__main__":
    unittest.main(verbosity=2)
