"""Broker adapters — common interface for Kotak / Shoonya / Dummy.

Only the selected adapter is active. Switching mode:
  1. stops the current broker session safely
  2. closes the current broker WebSocket
  3. invalidates the current session
  4. logs into the newly selected broker
  5. creates ONE new broker WebSocket
  6. restores required subscriptions
  7. updates the central session state

This package is a thin dispatcher on top of the existing engines; it does NOT
duplicate the WebSocket or session ownership. The single WebSocket owner
remains ``ws_socket.ws_manager`` and the single session owner is
``services.session.session_manager``.
"""
from __future__ import annotations
