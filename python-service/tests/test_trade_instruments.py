"""Trade-page instrument suggestions.

The behaviour under test is safety-critical for the trade page: a suggestion
must always be an instrument the broker is genuinely subscribed to, and the
ranking must never silently substitute a near-miss for what the user typed.
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest import mock

from api import trade_instruments as ti


def _rec(token, symbol, **over):
    """A canonical ``_subs`` record.

    Shaped like the real in-memory registry: real booleans for
    ``active``/``desired``, a ``state`` string, and no ``instrument_id`` /
    ``status`` / ``subscription_state`` columns (those belong to the persisted
    document, not this layer).
    """
    base = {
        "instrument_token": token,
        "exchange_segment": "nse_cm",
        "symbol": symbol,
        "trading_symbol": symbol,
        "state": "SUBSCRIBED",
        "subscribed": True,
        "active": True,
        "desired": True,
        "is_index": False,
        "pin": None,
        "expiry_label": None,
    }
    base.update(over)
    return base


REGISTRY = {
    "1": _rec("1", "RELIANCE"),
    "2": _rec("2", "RELIANCEIND"),
    "3": _rec("3", "LTIM"),
    "4": _rec("4", "ALLTIME"),
    "5": _rec("5", "AGASTYAEN"),
    "6": _rec("6", "HEROMOTORS", pin={"note": "keep"}),
    "7": _rec("7", "GAS"),
    "8": _rec("8", "TCS"),
    # Excluded rows: inactive, not desired, expired, wrong segment.
    "9": _rec("9", "HIDDEN", active=False),
    "11": _rec("11", "UNWANTED", desired=False),
    "12": _rec("12", "STALE", state="EXPIRED"),
    "10": _rec("10", "BSEONLY", exchange_segment="bse_cm"),
}


def _patch_registry(registry=None):
    """Point the route's module-level ``session_manager`` at a fake registry.

    Patching the singleton's own attribute does not work: ``CentralSessionManager``
    resolves ``active_registry`` through its own lookup rather than the instance
    ``__dict__``, so the patch is ignored. Replacing the name the route reads is
    both reliable and a truer statement of the dependency.
    """
    fake = SimpleNamespace(
        active_registry=lambda: dict(registry if registry is not None else REGISTRY)
    )
    return mock.patch.object(ti, "session_manager", fake)


class SuggestionRowTests(unittest.TestCase):
    def test_display_symbol_prefers_trading_symbol(self):
        self.assertEqual(ti._display_symbol(_rec("1", "A", trading_symbol="B")), "B")

    def test_display_symbol_falls_back_to_token(self):
        self.assertEqual(ti._display_symbol({"instrument_token": "42"}), "42")

    def test_is_active_accepts_real_booleans(self):
        self.assertTrue(ti._is_active(_rec("1", "A")))
        self.assertFalse(ti._is_active(_rec("1", "A", active=False)))
        self.assertFalse(ti._is_active(_rec("1", "A", desired=False)))

    def test_is_active_accepts_string_spellings(self):
        self.assertTrue(ti._is_active(_rec("1", "A", active="True", desired="True")))
        self.assertFalse(ti._is_active(_rec("1", "A", active="False")))
        self.assertFalse(ti._is_active(_rec("1", "A", desired="False")))

    def test_expired_state_is_not_active(self):
        self.assertFalse(ti._is_active(_rec("1", "A", state="EXPIRED")))

    def test_suggestion_carries_real_broker_token(self):
        row = ti._suggestion(_rec("766171", "HEROMOTORS"))
        self.assertEqual(row["instrumentToken"], "766171")
        self.assertEqual(row["exchangeSegment"], "nse_cm")
        self.assertEqual(row["symbol"], "HEROMOTORS")
        self.assertEqual(row["state"], "SUBSCRIBED")
        self.assertTrue(row["subscribed"])

    def test_suggestion_does_not_fabricate_an_instrument_id(self):
        """instrument_id lives on the persisted doc, not the registry record."""
        row = ti._suggestion(_rec("1", "A", instrument_id="kotak|nse_cm|1"))
        self.assertNotIn("instrument_id", row)
        self.assertNotIn("instrumentId", row)


class RankingTests(unittest.TestCase):
    def test_exact_match_beats_prefix_beats_substring(self):
        rows = [ti._suggestion(r) for r in REGISTRY.values()]
        ranked = ti._rank("reliance", rows)
        self.assertEqual(ranked[0]["symbol"], "RELIANCE")
        self.assertEqual(ranked[1]["symbol"], "RELIANCEIND")

    def test_exact_match_wins_even_when_alphabetically_later(self):
        rows = [ti._suggestion(r) for r in REGISTRY.values()]
        ranked = ti._rank("ltim", rows)
        self.assertEqual(ranked[0]["symbol"], "LTIM")

    def test_no_substring_decoys(self):
        """A typed symbol must never come back with a near-miss neighbour.

        "LTIM" is a substring of "ALLTIME" and "GAS" of "MOOILGAS". Offering
        those beside the typed symbol puts one mis-click away from trading the
        wrong security, so matching stops at prefix.
        """
        rows = [ti._suggestion(r) for r in REGISTRY.values()]
        self.assertEqual([r["symbol"] for r in ti._rank("ltim", rows)], ["LTIM"])
        self.assertEqual([r["symbol"] for r in ti._rank("gas", rows)], ["GAS"])

    def test_unavailable_symbol_returns_nothing_at_all(self):
        """An unsubscribed symbol must produce an empty result, not a decoy."""
        rows = [ti._suggestion(_rec("1", "TCS"))]  # LTIM is not in the universe
        self.assertEqual(ti._rank("ltim", rows), [])
        self.assertEqual(ti._rank("xyz", rows), [])

    def test_prefix_match_outranks_nothing(self):
        rows = [ti._suggestion(r) for r in REGISTRY.values()]
        ranked = [r["symbol"] for r in ti._rank("reliance", rows)]
        self.assertEqual(ranked, ["RELIANCE", "RELIANCEIND"])

    def test_pinned_leads_its_band(self):
        rows = [
            ti._suggestion(_rec("1", "ABCMOVE")),
            ti._suggestion(_rec("2", "ABCKEEP", pin={"note": "keep"})),
        ]
        self.assertEqual(ti._rank("abc", rows)[0]["symbol"], "ABCKEEP")

    def test_empty_query_puts_pinned_first(self):
        rows = [ti._suggestion(r) for r in REGISTRY.values()]
        ranked = ti._rank("", rows)
        self.assertEqual(ranked[0]["symbol"], "HEROMOTORS")

    def test_empty_query_is_alphabetical_within_bands(self):
        rows = [ti._suggestion(r) for r in REGISTRY.values()]
        ranked = [r["symbol"] for r in ti._rank("", rows)]
        rest = ranked[1:]
        self.assertEqual(rest, sorted(rest))


class SuggestEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_suggest_excludes_inactive_and_other_segments(self):
        with _patch_registry():
            out = await ti.suggest_instruments(
                q="", limit=50, exchangeSegment="nse_cm", includeInactive=False
            )
        symbols = {i["symbol"] for i in out["data"]["items"]}
        self.assertNotIn("HIDDEN", symbols)
        self.assertNotIn("UNWANTED", symbols)
        self.assertNotIn("STALE", symbols)
        self.assertNotIn("BSEONLY", symbols)
        self.assertEqual(out["data"]["total"], 8)

    async def test_suggest_can_include_inactive_when_asked(self):
        with _patch_registry():
            out = await ti.suggest_instruments(
                q="", limit=50, exchangeSegment="nse_cm", includeInactive=True
            )
        symbols = {i["symbol"] for i in out["data"]["items"]}
        self.assertIn("HIDDEN", symbols)
        self.assertNotIn("BSEONLY", symbols, "segment filter must still apply")

    async def test_suggest_respects_limit(self):
        with _patch_registry():
            out = await ti.suggest_instruments(
                q="", limit=2, exchangeSegment="nse_cm", includeInactive=False
            )
        self.assertEqual(len(out["data"]["items"]), 2)
        self.assertEqual(out["data"]["matched"], 8)

    async def test_suggest_puts_the_typed_symbol_first(self):
        with _patch_registry():
            out = await ti.suggest_instruments(
                q="LTIM", limit=20, exchangeSegment="nse_cm", includeInactive=False
            )
        symbols = [i["symbol"] for i in out["data"]["items"]]
        self.assertEqual(symbols[0], "LTIM")

    async def test_suggest_unknown_returns_empty_not_guess(self):
        with _patch_registry():
            out = await ti.suggest_instruments(
                q="ZZZZ", limit=20, exchangeSegment="nse_cm", includeInactive=False
            )
        self.assertEqual(out["data"]["items"], [])
        self.assertEqual(out["data"]["matched"], 0)


class DetailEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_detail_resolves_by_segment_and_token(self):
        with _patch_registry():
            out = await ti.instrument_detail("nse_cm", "1")
        self.assertEqual(out["data"]["symbol"], "RELIANCE")

    async def test_detail_404s_for_wrong_segment(self):
        with _patch_registry():
            with self.assertRaises(Exception) as ctx:
                await ti.instrument_detail("bse_cm", "1")
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_detail_404s_for_unknown_token(self):
        with _patch_registry():
            with self.assertRaises(Exception) as ctx:
                await ti.instrument_detail("nse_cm", "999999")
        self.assertEqual(ctx.exception.status_code, 404)


class UniverseEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_universe_returns_browsable_rows(self):
        with _patch_registry():
            out = await ti.instrument_universe(exchangeSegment="nse_cm", includeInactive=False)
        self.assertEqual(out["data"]["total"], 8)
        self.assertTrue(all(i["instrumentToken"] for i in out["data"]["items"]))


if __name__ == "__main__":
    unittest.main()
