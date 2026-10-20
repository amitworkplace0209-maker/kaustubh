"""WS#4 Gateway Command Router — authentication, validation, routing, correlation, ack, duplicate."""

import asyncio
import json
import uuid
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# Helpers to build a mock session
def _mock_session(connection_id="test_conn", username="tester"):
    s = MagicMock()
    s.connection_id = connection_id
    s.username = username
    s.closed = False
    s.sequence = 0
    def next_seq():
        s.sequence += 1
        return s.sequence
    s.next_sequence = next_seq
    # outbox.put spy
    s.outbox = MagicMock()
    s.outbox.put = MagicMock()
    s.mark_activity = MagicMock()
    s.record_error = MagicMock()
    return s


def _mock_ws():
    ws = MagicMock()
    ws.client.host = "127.0.0.1"
    ws.client.port = 12345
    return ws



@pytest.mark.anyio
class TestWsGatewayAuth:
    async def test_unauthenticated_trading_command_rejected(self):
        from api.ws_gateway import _handle_message
        session = _mock_session()
        ws = _mock_ws()
        # Mock auth_gate to raise
        with patch("services.session.session_manager.session_manager.auth_gate", side_effect=Exception("Unauthorized")):
            await _handle_message(session, ws, {"action": "place_order", "request_id": "req1", "order": {"symbol": "RELIANCE", "token": "2885"}})
            # should put error ack
            assert session.outbox.put.called
            arg = session.outbox.put.call_args[0][0]
            assert arg["type"] == "order.ack"
            assert arg["data"]["ok"] is False

    async def test_invalid_payload_rejected(self):
        from api.ws_gateway import _handle_message
        session = _mock_session()
        ws = _mock_ws()
        with patch("services.session.session_manager.session_manager.auth_gate"):
            await _handle_message(session, ws, {"action": "place_order", "request_id": "req1"})
            arg = session.outbox.put.call_args[0][0]
            assert arg["data"]["ok"] is False
            assert "payload required" in arg["data"]["error"]



@pytest.mark.anyio
class TestWsGatewayIdempotency:
    async def test_duplicate_correlation_returns_existing(self):
        from api.ws_gateway import _handle_message
        from services.command_idempotency import get_idempotency_store
        store = get_idempotency_store()
        # pre-seed store with ACCEPTED
        corr = f"corr_{uuid.uuid4().hex[:8]}"
        store.create_pending("kotak", corr, "place_order", {"symbol": "RELIANCE"})
        store.complete("kotak", corr, "ACCEPTED", result={"ok": True, "accepted": True, "orderId": "ORD123"})
        session = _mock_session()
        ws = _mock_ws()
        with patch("services.session.session_manager.session_manager.auth_gate"):
            await _handle_message(session, ws, {"action": "place_order", "request_id": corr, "correlation_id": corr, "order": {"symbol": "RELIANCE"}})
            arg = session.outbox.put.call_args[0][0]
            assert arg["data"]["replayed"] is True
            assert arg["data"]["state"] == "ACCEPTED"
            assert arg["data"]["ok"] is True

    async def test_conflict_same_correlation_different_payload(self):
        from api.ws_gateway import _handle_message
        from services.command_idempotency import get_idempotency_store
        store = get_idempotency_store()
        corr = f"corr_{uuid.uuid4().hex[:8]}"
        store.create_pending("kotak", corr, "place_order", {"symbol": "RELIANCE", "quantity": "10"})
        session = _mock_session()
        ws = _mock_ws()
        with patch("services.session.session_manager.session_manager.auth_gate"):
            await _handle_message(session, ws, {"action": "place_order", "request_id": corr, "correlation_id": corr, "order": {"symbol": "RELIANCE", "quantity": "99"}})
            arg = session.outbox.put.call_args[0][0]
            assert arg["data"]["code"] == "IDEMPOTENCY_CONFLICT"



@pytest.mark.anyio
class TestWsGatewayRouting:
    async def test_place_order_routes_to_order_engine(self):
        from api.ws_gateway import _handle_message
        session = _mock_session()
        ws = _mock_ws()
        fake_result = {"ok": True, "accepted": True, "orderId": "ORD999", "data": {}}
        with patch("services.session.session_manager.session_manager.auth_gate"):
            with patch("core.engines.order_engine.place", new=AsyncMock(return_value=fake_result)):
                await _handle_message(session, ws, {"action": "place_order", "request_id": "req123", "correlation_id": "corr123", "order": {"symbol": "RELIANCE", "token": "2885", "quantity": "1"}})
                arg = session.outbox.put.call_args[0][0]
                assert arg["type"] == "order.ack"
                assert arg["data"]["ok"] is True
                assert arg["data"]["result"]["orderId"] == "ORD999"

    async def test_cancel_routes(self):
        from api.ws_gateway import _handle_message
        session = _mock_session()
        ws = _mock_ws()
        fake_result = {"ok": True, "orderId": "ORD123"}
        with patch("core.engines.order_engine.cancel", new=AsyncMock(return_value=fake_result)):
            await _handle_message(session, ws, {"action": "cancel_order", "request_id": "r1", "order_id": "ORD123"})
            arg = session.outbox.put.call_args[0][0]
            assert arg["data"]["ok"] is True

    async def test_modify_requires_order_id(self):
        from api.ws_gateway import _handle_message
        session = _mock_session()
        ws = _mock_ws()
        await _handle_message(session, ws, {"action": "modify_order", "request_id": "r1", "order": {"price": "100"}})
        arg = session.outbox.put.call_args[0][0]
        assert arg["data"]["ok"] is False
        assert "order_id" in arg["data"]["error"]



@pytest.mark.anyio
class TestWsGatewayAckCorrelation:
    async def test_ack_carries_correlation_id(self):
        from api.ws_gateway import _handle_message
        session = _mock_session()
        ws = _mock_ws()
        fake_result = {"ok": True, "accepted": True}
        with patch("services.session.session_manager.session_manager.auth_gate"):
            with patch("core.engines.order_engine.place", new=AsyncMock(return_value=fake_result)):
                corr = f"corr_{uuid.uuid4().hex[:8]}"
                await _handle_message(session, ws, {"action": "place_order", "request_id": corr, "correlation_id": corr, "order": {"symbol": "RELIANCE", "token": "2885"}})
                frame = session.outbox.put.call_args[0][0]
                assert frame["correlation_id"] == corr
                assert frame["data"]["correlationId"] == corr

    async def test_unknown_action_returns_error(self):
        from api.ws_gateway import _handle_message
        session = _mock_session()
        ws = _mock_ws()
        await _handle_message(session, ws, {"action": "unknown_magic", "request_id": "r1"})
        frame = session.outbox.put.call_args[0][0]
        assert frame["type"] == "error.event"
        assert "unknown action" in frame["data"]["message"]



@pytest.mark.anyio
class TestWsGatewayValidationBypass:
    async def test_does_not_bypass_risk_engine(self):
        """Ensure the gateway does not call broker directly — must go via Order Engine."""
        from api.ws_gateway import _handle_place_order
        import inspect
        src = inspect.getsource(_handle_place_order)
        assert "order_engine" in src.lower() or "order_engine.place" in src
        # Ensure no direct Kotak adapter call in gateway
        assert "kotak_session.place_order" not in src
        assert "KotakSession" not in src or "session_manager" in src


class TestRealtimeWsContract:
    def test_ws4_actions_documented(self):
        import pathlib
        txt = pathlib.Path("api/ws_gateway.py").read_text()
        for action in ["place_order", "cancel_order", "modify_order", "square_off"]:
            assert action in txt

    def test_frontend_realtime_ws_has_correlation(self):
        import pathlib
        path = pathlib.Path("../lib/realtime-ws.ts")
        if not path.exists():
            path = pathlib.Path("C:/project/lib/realtime-ws.ts")
        # utf-8-sig: never inherit the Windows ANSI codec, and tolerate a BOM.
        txt = path.read_text(encoding="utf-8-sig")
        assert "correlation_id" in txt.lower()
        assert "placeOrder" in txt


