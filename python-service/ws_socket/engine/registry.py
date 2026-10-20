"""Subscription registry: one unique broker subscription set from all intents.

Consumers declare instrument intents (segment, token, symbol). The registry
merges every intent, deduplicates by ``(exchange_segment, instrument_token)``,
and produces the diff the broker owner must apply. No consumer can ask twice
for the same instrument behind the scenes: RELIANCE subscribed + watchlist +
pin + position + alert is ONE broker subscription.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field


@dataclass(frozen=True)
class InstrumentKey:
    exchange_segment: str
    instrument_token: str

    def __str__(self) -> str:
        return f"{self.exchange_segment}|{self.instrument_token}"


@dataclass
class RegistryEntry:
    key: InstrumentKey
    symbol: str | None = None
    is_index: bool = False
    is_depth: bool = False
    feed_level: int | None = None
    market_data: str = "L8"


_TIER_TO_LABEL = {1: "L1", 4: "L4", 8: "L8", 16: "L16"}


def _tier_of(market_data=None, feed_level=None) -> int:
    """Resolve an intent's feed tier (1/4/8/16) from marketData or feedLevel."""
    md = str(market_data or "").upper()
    for label in (16, 8, 4, 1):
        if md == f"L{label}":
            return label
    try:
        level = int(feed_level)
    except (TypeError, ValueError):
        level = 0
    return level if level in (1, 4, 8, 16) else 0


class SubscriptionRegistry:
    """Merges consumer intents into one deduplicated desired set."""

    def __init__(self) -> None:
        # consumer_id -> {InstrumentKey: RegistryEntry}
        self._intents: dict[str, dict[InstrumentKey, RegistryEntry]] = {}
        self._symbols: dict[InstrumentKey, str] = {}
        # Last-known feed flags per key, retained after intent removal so the
        # engine can unsubscribe on the SAME feed family it subscribed with.
        self._feed_memory: dict[InstrumentKey, dict] = {}

    # -- mutation ------------------------------------------------------
    def add_instrument(self, consumer: str, segment: str, token: str, symbol: str | None = None,
                         is_index: bool = False, is_depth: bool = False,
                         feed_level: int | None = None, market_data: str = "L8") -> bool:
        key = InstrumentKey(segment, str(token))
        bucket = self._intents.setdefault(consumer, {})
        if key not in bucket:
            bucket[key] = RegistryEntry(key=key, symbol=symbol, is_index=is_index, is_depth=is_depth,
                                        feed_level=feed_level, market_data=market_data)
        else:
            # Update metadata on re-add (in case feed_level changed)
            existing = bucket[key]
            bucket[key] = RegistryEntry(key=key, symbol=symbol or existing.symbol,
                                        is_index=is_index or existing.is_index,
                                        is_depth=is_depth or existing.is_depth,
                                        feed_level=feed_level or existing.feed_level,
                                        market_data=market_data or existing.market_data)
        if symbol:
            self._symbols[key] = symbol
        return True

    def add_instruments(self, consumer: str, tokens: list[dict]) -> int:
        added = 0
        for token in tokens:
            segment = str(token.get("exchange_segment") or token.get("exchangeSegment") or "")
            number = token.get("instrument_token") or token.get("instrumentToken")
            if not segment or number is None:
                continue
            is_index = bool(token.get("isIndex", token.get("is_index", False)))
            is_depth = bool(token.get("isDepth", token.get("is_depth", False)))
            feed_level = token.get("feedLevel", token.get("feed_level"))
            market_data = str(token.get("marketData", token.get("market_data", "L8")))
            if self.add_instrument(consumer, segment, str(number), token.get("symbol"),
                                     is_index, is_depth, feed_level, market_data):
                added += 1
        return added

    def remove_instrument(self, consumer: str, segment: str, token: str) -> bool:
        bucket = self._intents.get(consumer)
        if not bucket:
            return False
        key = InstrumentKey(segment, str(token))
        removed = bucket.pop(key, None)
        if not bucket:
            self._intents.pop(consumer, None)
        if removed:
            self._rebuild_symbols()
        return removed is not None

    def clear_consumer(self, consumer: str) -> int:
        bucket = self._intents.pop(consumer, None)
        if bucket:
            self._rebuild_symbols()
            return len(bucket)
        return 0

    def has_consumer(self, consumer: str) -> bool:
        return bool(self._intents.get(consumer))

    # -- read ----------------------------------------------------------
    def desired(self) -> list[dict]:
        """Unique desired broker tokens (deduplicated across all consumers)."""
        seen: set[InstrumentKey] = set()
        out: list[dict] = []
        for key in self._all_keys():
            if key in seen:
                continue
            seen.add(key)
            out.append(self._token_dict(key))
        return out

    def unique_count(self) -> int:
        return len({key for key in self._all_keys()})

    def instruments_for(self, consumer: str) -> list[dict]:
        out = []
        for key in (self._intents.get(consumer) or {}):
            out.append(self._token_dict(key))
        return out

    def get_symbol(self, key: InstrumentKey) -> str | None:
        return self._symbols.get(key)

    def raw_intents(self) -> dict[str, list[dict]]:
        result: dict[str, list[dict]] = {}
        for consumer, entries in self._intents.items():
            result[consumer] = [self._token_dict(e.key) for e in entries.values()]
        return result

    # -- diffing -------------------------------------------------------
    def broker_diff(self, broker_subscribed: set[InstrumentKey]) -> tuple[list[dict], list[dict]]:
        """Return (to_subscribe, to_unsubscribe) vs the broker's current set."""
        wanted = set(self._all_keys())
        to_sub = [self._token_dict(k) for k in sorted(wanted - broker_subscribed, key=str)]
        to_unsub = [
            self._token_dict(k)
            for k in sorted(broker_subscribed - wanted, key=str)
        ]
        return to_sub, to_unsub

    # -- helpers -------------------------------------------------------
    def _all_keys(self) -> list[InstrumentKey]:
        return [key for entries in self._intents.values() for key in entries]

    def _token_dict(self, key: InstrumentKey) -> dict:
        """Build the broker token for a key, merging feed flags across ALL
        consumers that want it. The highest tier always wins (depth/full-depth
        is richer); an L4 pin can never downgrade the default L8 depth.
        Tokens with no classification default to L8 depth (isDepth)."""
        token = {
            "instrument_token": key.instrument_token,
            "exchange_segment": key.exchange_segment,
        }
        entries = self._find_entries(key)
        merged = self._feed_memory.get(key) or {
            "symbol": self._symbols.get(key),
            "is_index": False,
            "is_depth": False,
            "feed_level": None,
            "market_data": "L8",
        }
        for entry in entries:
            if entry.symbol:
                merged = dict(merged)
                merged["symbol"] = entry.symbol
            if entry.is_index:
                merged = dict(merged)
                merged["is_index"] = True
        if entries:
            tier = max([_tier_of(entry.market_data, entry.feed_level) for entry in entries] + [8])
            merged = dict(merged)
            merged["market_data"] = (
                "INDEX" if merged.get("is_index") else _TIER_TO_LABEL.get(tier, "L8")
            )
            merged["feed_level"] = None if merged.get("is_index") else tier
            merged["is_depth"] = bool(not merged.get("is_index") and tier >= 8)
            self._feed_memory[key] = merged
        if merged.get("symbol"):
            token["symbol"] = merged["symbol"]
        token["isIndex"] = bool(merged.get("is_index"))
        token["isDepth"] = bool(merged.get("is_depth"))
        if merged.get("feed_level") is not None:
            token["feedLevel"] = merged["feed_level"]
        if merged.get("market_data"):
            token["marketData"] = merged["market_data"]
        return token

    def _find_entries(self, key: InstrumentKey) -> list[RegistryEntry]:
        found: list[RegistryEntry] = []
        for entries in self._intents.values():
            if key in entries:
                found.append(entries[key])
        return found

    def _rebuild_symbols(self) -> None:
        self._symbols = {}
        for entries in self._intents.values():
            for entry in entries.values():
                if entry.symbol:
                    self._symbols[entry.key] = entry.symbol


def broker_symbol(key: InstrumentKey) -> str:
    return ""


def parse_instrument_body(body: dict) -> list[dict]:
    """Accept flexible instrument request bodies: {array} or {segment, token(s)}."""
    tokens = body.get("tokens") or body.get("instruments")
    if isinstance(tokens, list) and tokens:
        return tokens
    if body.get("instrument_token") or body.get("instrumentToken"):
        return [body]
    return []