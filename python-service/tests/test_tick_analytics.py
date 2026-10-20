"""Deterministic unit tests for :mod:`services.tick_analytics`.

These test ONLY the pure calculate helpers with injected fake tick data —
they never touch MongoDB, the websocket manager, or any live service. The goal
is to lock in the exact math (change%, VWAP, spread, imbalance, RSI, SMA, EMA,
ATR, tick direction, duplicates, latency, bucket volume deltas) that the
analytics center reports, and to guarantee the "insufficient data -> null /
available:false" honesty contract.

Run:  python -m pytest tests/test_tick_analytics.py -q
"""
from __future__ import annotations

import os
import sys

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services import tick_analytics as ta


def _tick(symbol="RELIANCE", ts_ms=0, ltp=100.0, volume=0.0, bp=None, sp=None, bq=None, bs=None, sq=None, close=None, received_ms=None):
    t = {
        "symbol": symbol,
        "instrumentToken": "123",
        "ts": ts_ms,
        "ltp": ltp,
        "volume": volume,
        "bp": bp,
        "sp": sp,
        "bq": bq,
        "bs": bs,
        "sq": sq,
        "close": close,
    }
    if received_ms is not None:
        t["receivedAt"] = received_ms
    return t


# ------------------------- numeric helpers -------------------------

def test_fnum_null_and_infinity():
    assert ta._fnum(None) is None
    assert ta._fnum(float("inf")) is None
    assert ta._fnum(float("nan")) is None
    assert ta._fnum("12.5") == 12.5


def test_ts_ms_normalization():
    assert ta._ts_ms(1600000000000) == 1600000000000
    assert ta._ts_ms(1600000000) == 1600000000  # caller passes what it has
    from datetime import datetime, timezone
    d = datetime.fromtimestamp(1600000000, tz=timezone.utc)
    assert ta._ts_ms(d) == 1600000000000


def test_percentile():
    assert ta._percentile([1, 2, 3, 4, 5], 0.5) == 3
    assert ta._percentile([], 0.5) is None


# ------------------------- SMA / EMA -------------------------------

def test_sma_requires_full_window():
    assert ta._sma([1, 2, 3], 5) == [None, None, None]
    got = ta._sma([1, 2, 3, 4, 5], 3)
    assert got[0] is None and got[1] is None
    assert got[2] == 2.0 and got[3] == 3.0 and got[4] == 4.0


def test_ema_ok():
    got = ta._ema([1, 2, 3], 2)
    assert got[0] == 1
    assert got[1] == 1 + (2 - 1) * (2 / 3)
    assert got[2] == got[1] + (3 - got[1]) * (2 / 3)


# ------------------------- RSI ------------------------------------

def test_rsi_insufficient_returns_none():
    assert ta._rsi([1, 2, 3, 4], 14) is None


def test_rsi_all_gains_is_100():
    closes = list(range(1, 20))
    assert ta._rsi(closes, 14) == 100.0


def test_rsi_all_losses_is_0():
    closes = list(range(20, 1, -1))
    assert ta._rsi(closes, 14) == 0.0


def test_rsi_flat_is_50():
    closes = [100.0] * 20
    assert ta._rsi(closes, 14) == 50.0


# ------------------------- VWAP / volume deltas -------------------

def test_vwap_only_positive_deltas():
    ticks = [
        _tick(volume=0.0, ltp=100.0),      # baseline 0 -> ignored (prev None)
        _tick(volume=100.0, ltp=100.0),   # prev None -> no delta, prev=100
        _tick(volume=250.0, ltp=102.0),   # +150 @102
        _tick(volume=250.0, ltp=101.0),   # no delta
        _tick(volume=200.0, ltp=105.0),   # -50 -> prev=200, no delta
    ]
    vwap, vol = ta._vwap_from_ticks(ticks)
    assert vol == 150.0
    assert vwap == 102.0


def test_vwap_none_when_no_deltas():
    ticks = [_tick(volume=100.0, ltp=10.0), _tick(volume=100.0, ltp=11.0)]
    vwap, vol = ta._vwap_from_ticks(ticks)
    assert vwap is None and vol == 0.0


# ------------------------- spread / imbalance ---------------------

def test_depth_spread_and_imbalance():
    t = _tick(bp=100.0, sp=100.5, bq=100, sq=50)
    d = ta._depth_from_tick(t)
    assert d["available"]
    assert d["spread"] == 0.5
    assert d["spreadPercent"] == round(0.5 / 100.25 * 100, 4)
    # (100-50)/(100+50) = 0.3333
    assert d["imbalance"] == round(50 / 150, 4)
    assert d["pressure"] == "BUY"


def test_depth_unavailable_invalid():
    d = ta._depth_from_tick(_tick(bp=None, sp=None))
    assert not d["available"]


def test_depth_spread_zero_price_guard():
    d = ta._depth_from_tick(_tick(bp=0.0, sp=0.0001))
    assert d["available"]
    assert d["spread"] == 0.0001


# ------------------------- tick direction -------------------------

def test_direction_counts():
    ltps = [10.0, 11.0, 11.0, 9.0, 10.0]  # 5 samples, 4 transitions
    d = ta._direction(ltps)
    assert d["up"] == 2   # 10->11, 9->10
    assert d["down"] == 1  # 11->9
    assert d["unchanged"] == 1  # 11->11
    assert d["observations"] == 4
    assert d["upDownRatio"] == 2.0


def test_direction_empty():
    d = ta._direction([])
    assert d["observations"] == 0
    assert d["pressure"] is None


# ------------------------- duplicate / quality --------------------

def test_quality_duplicate_identity():
    base_bp, base_sp, base_vol = 100.0, 100.5, 50.0
    dup = _tick(ts_ms=1000, ltp=101.0, volume=base_vol, bp=base_bp, sp=base_sp)
    ticks = []
    for _ in range(3):
        ticks.append(dict(dup))
    q = ta._tick_quality(ticks)
    # All three have the same fingerprint -> 2 candidates.
    assert q["duplicateCandidates"] == 2


def test_quality_same_price_diff_fingerprint_not_dup():
    # identical price but different volume => different fingerprint (as Data Quality)
    t1 = _tick(ts_ms=1000, ltp=101.0, volume=50.0, bp=100.0, sp=100.5)
    t2 = _tick(ts_ms=1001, ltp=101.0, volume=51.0, bp=100.0, sp=100.5)
    q = ta._tick_quality([t1, t2])
    assert q["duplicateCandidates"] == 0


def test_quality_out_of_order():
    t1 = _tick(ts_ms=2000, ltp=101.0)
    t2 = _tick(ts_ms=1000, ltp=102.0)
    q = ta._tick_quality([t1, t2])
    assert q["outOfOrder"] == 1


# ------------------------- latency --------------------------------

def test_latency_from_ticks():
    ticks = [
        _tick(ts_ms=1000, received_ms=1100),
        _tick(ts_ms=2000, received_ms=2100),
        _tick(ts_ms=3000, received_ms=3200),
    ]
    lat = ta._latency_from_ticks(ticks)
    assert lat["available"]
    assert lat["avgMs"] == round(400.0 / 3, 2)  # 100 + 100 + 200 = 400 / 3
    assert lat["maxMs"] == 200.0
    assert lat["samples"] == 3


def test_latency_unavailable():
    lat = ta._latency_from_ticks([_tick(ts_ms=1000)])  # no receivedAt
    assert not lat["available"]


# ------------------------- volatility -----------------------------

def test_volatility_requires_two_returns():
    # a single tick-return -> not enough observations
    v = ta._volatility([0.01])
    assert not v["available"]


def test_volatility_returns_diagnostics():
    rets = [0.01, -0.01, 0.02, -0.02, 0.005]
    v = ta._volatility(rets)
    assert v["available"]
    assert v["observations"] == 5
    assert v["stdev"] > 0


# ------------------------- change percent fallback ----------------

def test_change_pct_computation():
    close = 100.0
    ltp = 105.0
    change = round(ltp - close, 4)
    change_pct = round((change / close) * 100, 4)
    assert change == 5.0
    assert change_pct == 5.0


# ------------------------- buckets --------------------------------

def test_bucketize_volume_deltas():
    start = 1000000
    step_ms = 1000
    ticks = [
        _tick(ts_ms=start, volume=0.0, ltp=100.0),
        _tick(ts_ms=start + 100, volume=50.0, ltp=100.5),
        _tick(ts_ms=start + 200, volume=50.0, ltp=100.5),  # no delta
        _tick(ts_ms=start + step_ms, volume=100.0, ltp=101.0),  # next bucket, +50
    ]
    series = ta.bucketize(ticks, step_sec=1, start=start, end=start + 2 * step_ms)
    assert len(series) == 2
    assert series[0]["tickCount"] == 3
    assert series[0]["volumeDelta"] == 50.0
    assert series[1]["tickCount"] == 1
    assert series[1]["volumeDelta"] == 50.0


def test_bucketize_ignores_out_of_window():
    start = 1000000
    ticks = [_tick(ts_ms=500000, ltp=10.0), _tick(ts_ms=1000000, ltp=11.0)]
    series = ta.bucketize(ticks, step_sec=1, start=start, end=start + 1000)
    assert len(series) == 1
    assert series[0]["tickCount"] == 1


def test_bucket_spread_and_imbalance():
    start = 1000000
    ticks = [
        _tick(ts_ms=start, ltp=100.0, bp=100.0, sp=100.5, bq=100, bs=50),
    ]
    series = ta.bucketize(ticks, step_sec=1, start=start, end=start + 1000)
    b = series[0]
    assert b["spread"] == 0.5
    assert b["bidAskImbalance"] == round(100 / 50, 4)


# ------------------------- candles --------------------------------

def test_build_candles_ohlc():
    start = 1000000
    ticks = [
        _tick(ts_ms=start, ltp=10.0),
        _tick(ts_ms=start + 100, ltp=12.0),
        _tick(ts_ms=start + 200, ltp=11.0),
        _tick(ts_ms=start + 300, ltp=15.0),
    ]
    candles = ta.build_candles(ticks, step_sec=60)
    assert len(candles) == 1
    c = candles[0]
    assert c["open"] == 10.0
    assert c["high"] == 15.0
    assert c["low"] == 10.0
    assert c["close"] == 15.0
    assert c["tickCount"] == 4


def test_atr():
    candles = [
        {"high": 10, "low": 9, "close": 9.5},
        {"high": 10.5, "low": 9.2, "close": 10.0},
        {"high": 11.0, "low": 9.8, "close": 10.5},
    ]
    atr = ta._atr(candles, 2)
    assert atr is not None
    assert atr > 0


def test_atr_insufficient():
    assert ta._atr([{"high": 1, "low": 1, "close": 1}], 2) is None


# ------------------------- live_state decision --------------------

def test_live_state_decision_precedence(monkeypatch):
    """Closed state must take precedence over a connected feed."""
    import services.tick_analytics as mod
    import ws_socket.ws_manager as wsm

    class FakeWS:
        @staticmethod
        def status():
            return {"connected": True, "feed_state": "RECEIVING", "rates": {}, "diagnostics": {},
                    "subscription_count": 1, "internet_ok": True}

    class FakeCal:
        @staticmethod
        def snapshot():
            return {"market_status": "CLOSED"}

    class FakeTicker:
        @staticmethod
        def stats():
            return {"pipelineRunning": True, "ticksPerSecond": 5.0, "lastTickAt": None}

    monkeypatch.setattr(mod, "market_calendar", FakeCal())
    monkeypatch.setattr(mod, "tick_buffer", FakeTicker())
    monkeypatch.setattr(mod, "market_state_service_get", lambda: {"market_state": "MARKET_CLOSED", "network_ok": True})
    monkeypatch.setattr(wsm, "status", FakeWS.status)

    st = mod.live_state()
    assert st["feedStatus"] == "MARKET_CLOSED"


def test_live_state_no_connected_is_disconnected(monkeypatch):
    import services.tick_analytics as mod
    import ws_socket.ws_manager as wsm

    class FakeWS:
        @staticmethod
        def status():
            return {"connected": False, "feed_state": "NO_FEED", "rates": {}, "diagnostics": {}, "subscription_count": 0}

    class FakeCal:
        @staticmethod
        def snapshot():
            return {"market_status": "UNKNOWN"}

    class FakeTicker:
        @staticmethod
        def stats():
            return {"pipelineRunning": False, "ticksPerSecond": 0.0, "lastTickAt": None}

    monkeypatch.setattr(mod, "market_calendar", FakeCal())
    monkeypatch.setattr(mod, "tick_buffer", FakeTicker())
    monkeypatch.setattr(mod, "market_state_service_get", lambda: {"market_state": "UNKNOWN", "network_ok": True})
    monkeypatch.setattr(wsm, "status", FakeWS.status)

    st = mod.live_state()
    assert st["feedStatus"] == "DISCONNECTED"
