"""Connection Engine — backend → frontend realtime (WebSocket #2) layer.

Implements the master-architecture *second* WebSocket: one persistent,
authenticated connection per operator frontend that carries every realtime
event (market ticks, positions/orders, notifications, system status) as a
single envelope stream. It is the bridge between the Kotak Central WebSocket
Engine tick router and connected frontend sessions.
"""
from connection_engine.client import ClientSession, Outbox
from connection_engine.connection_engine import ConnectionEngine

# The ONE application-wide Connection Engine singleton (wired once at app boot).
connection_engine = ConnectionEngine()

__all__ = ["ClientSession", "Outbox", "ConnectionEngine", "connection_engine"]