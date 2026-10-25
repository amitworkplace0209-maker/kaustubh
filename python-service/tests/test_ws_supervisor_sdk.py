"""Integration tests for the BrokerWebSocketSupervisor's SDK-aligned call path.

These validate that ws_manager calls the installed Kotak Neo SDK using the
correct signatures (NO unsupported keyword args such as connect(max_connect_retries=0)),
using a faithful mock of the real SFeedWebSocket contract.
"""

import asyncio
import importlib
from unittest import mock

from ws_socket.ws_manager import WebSocketManager

# NOTE: `ws_socket.ws_manager` resolves to the WebSocketManager singleton
# because ws_socket/__init__.py does `from ws_socket.ws_manager import ws_manager`
# which shadows the package attribute. Import the module via importlib instead.
ws_manager_mod = importlib.import_module("ws_socket.ws_manager")


class FakeWs:
    """Mimics the real SFeedWebSocket contract (connect() takes NO args)."""

    def __init__(self):
        self.is_connected = True
        self.on_connect = None
        self.on_disconnect = None
        self.on_error = None
        self.access_token = "edit_token"
        self.url = "wss://sfeed.kotaksecurities.com/apifeed"

    async def connect(self):
        # Real signature is connect(self) -> None. No kwargs accepted.
        if self.on_connect:
            self.on_connect()

    async def close(self):
        if self.on_disconnect:
            self.on_disconnect()

    async def subscribe_scrips(self, tokens):
        for t in tokens:
            self.subscribed.append(t)

    async def subscribe_index(self, tokens):
        for t in tokens:
            self.subscribed.append(t)

    async def subscribe_full_depth(self, tokens):
        for t in tokens:
            self.subscribed.append(t)

    async def subscribe_depth(self, tokens):
        for t in tokens:
            self.subscribed.append(t)

    async def unsubscribe_scrips(self, tokens):
        pass

    async def unsubscribe_index(self, tokens):
        pass

    async def unsubscribe_full_depth(self, tokens):
        pass

    async def unsubscribe_depth(self, tokens):
        pass


class FakeClient:
    """Mimics NeoAPI with a create_websocket that accepts constructor kwargs."""

    def __init__(self):
        self.last_kwargs = None

    def create_websocket(self, url=None, **kwargs):
        self.last_kwargs = kwargs
        ws = FakeWs()
        ws.subscribed = []
        return ws


def test_connect_fresh_uses_constructor_kwargs_not_connect_args():
    """Regression: max_connect_retries/max_reconnect_attempts must go to the
    constructor (create_websocket), NEVER to connect()."""

    captured = {}

    async def run():
        mgr = WebSocketManager()
        client = FakeClient()
        with mock.patch.object(ws_manager_mod.kotak_session, "client", client):
            # Also patch _start_reader to avoid needing a real event loop task
            with mock.patch.object(mgr, "_start_reader"):
                ws = await mgr._connect_fresh()
        captured["ws"] = ws
        captured["kwargs"] = client.last_kwargs

    asyncio.run(run())

    assert captured["ws"] is not None, "connection should succeed"
    # Constructor must receive both policy kwargs
    assert captured["kwargs"]["max_reconnect_attempts"] == 0
    assert captured["kwargs"]["max_connect_retries"] == 0


def test_connect_fresh_logs_reason_when_client_absent():
    async def run():
        mgr = WebSocketManager()
        with mock.patch.object(ws_manager_mod.kotak_session, "client", None):
            ws = await mgr._connect_fresh()
        return ws, mgr._last_connect_error

    ws, err = asyncio.run(run())
    assert ws is None
    assert err is not None


def test_bad_connect_signature_would_raise():
    """Guard: the real SDK connect() must NOT accept keyword args.
    If a future SDK adds max_connect_retries to connect(), this test keeps us honest."""
    import inspect
    from neo_api_client.websocket.feed.client import SFeedWebSocket
    sig = inspect.signature(SFeedWebSocket.connect)
    var_keyword = [
        p for p in sig.parameters.values()
        if p.kind == inspect.Parameter.VAR_KEYWORD
    ]
    assert not var_keyword, "SDK connect() unexpectedly accepts **kwargs"
    assert list(sig.parameters) == ["self"], "SDK connect() should take only self"


def test_subscribe_path_builds_ws_tokens():
    # Capture the shared FakeWs instance so we can assert on what got subscribed
    holder = {}

    async def run():
        mgr = WebSocketManager()
        client = FakeClient()
        with mock.patch.object(ws_manager_mod.kotak_session, "client", client):
            with mock.patch.object(ws_manager_mod.kotak_session, "logged_in", True):
                with mock.patch.object(mgr, "_start_reader"):
                    ws = await mgr._connect_fresh()
                holder["ws"] = ws
                # subscribe() calls _ensure_connected which sees the existing ws
                result = await mgr.subscribe([
                    {"instrument_token": "1333", "exchange_segment": "nse_cm", "symbol": "RELIANCE"},
                    {"instrument_token": "1333", "exchange_segment": "nse_cm", "symbol": "RELIANCE"},  # dup
                ])
        return result

    result = asyncio.run(run())
    assert result["count"] == 1, "dedup should reduce 2 -> 1 new"
    assert holder["ws"] is not None
    # The shared FakeWs should have received exactly ONE WsToken after dedup
    assert len(holder["ws"].subscribed) == 1


def test_publish_ws_engine_event_forwards_event_type():
    """ws_manager publishes WS lifecycle events to the engine event bus so
    market-data engines (e.g. market_watch feed_state) stay truthful."""

    class FakeBus:
        def __init__(self):
            self.events = []

        async def publish(self, event):
            self.events.append(event.event_type)
            return 1

    fake_bus = FakeBus()
    scheduled = []

    with mock.patch("services.engine_event_bus.get_event_bus", return_value=fake_bus), \
         mock.patch.object(WebSocketManager, "_schedule_async", side_effect=lambda coro: scheduled.append(coro)):
        WebSocketManager._publish_ws_engine_event("WEBSOCKET_CONNECTED", {"reason": "connected"})
        WebSocketManager._publish_ws_engine_event("WEBSOCKET_DISCONNECTED", {"reason": "drop"})

    assert len(scheduled) == 2, "both lifecycle events must be scheduled"
    assert all(asyncio.iscoroutine(c) for c in scheduled)
    for coro in scheduled:
        asyncio.run(coro)
    # EngineEvent exposes event_type as a constructor keyword -> attribute
    assert fake_bus.events == ["WEBSOCKET_CONNECTED", "WEBSOCKET_DISCONNECTED"]


def test_publish_ws_engine_event_survives_bus_failures():
    """A broken bus must never break the SDK callback that publishes it."""

    class BoomBus:
        async def publish(self, event):
            raise RuntimeError("bus down")

    with mock.patch("services.engine_event_bus.get_event_bus", return_value=BoomBus()):
        WebSocketManager._publish_ws_engine_event("WEBSOCKET_CONNECTED")  # must not raise