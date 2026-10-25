# Local Connect Engine

## Purpose

The **Local Connect Engine** (`/services/local-connect-engine`) is the single place where
the KAUSTUBH frontend safely connects to an app running on the *same device*
(localhost). It auto-detects the local backend, authenticates, and opens a
permission-scoped bridge. No broker credentials ever leave the device; only a
short-lived session token is exchanged.

## What it connects to

| Target | Default URL | Discovery endpoint | Purpose |
|---|---|---|---|
| KAUSTUBH backend (local app) | `http://127.0.0.1:8000` | `GET /api/local-connect/discover` | System status, engines, market data, orders |
| Khumbha AI bridge | `http://127.0.0.1:8001` | `GET /health` | Local model providers, chat, analysis |

## Auto-detection

On mount (and on "Auto-detect") the engine probes, in order:

1. `http://127.0.0.1:8000` then `http://localhost:8000` — the KAUSTUBH backend.
2. `http://127.0.0.1:8001` then `http://localhost:8001` — the Khumbha AI bridge.

The first responder for each target is recorded as the detected endpoint and shown
in the UI with a green/red status badge.

## Authentication flow (safe bridge)

1. **Discover** — `GET /api/local-connect/discover` returns backend identity,
   version, and the full capability list.
2. **Handshake** — `POST /api/local-connect/handshake` with
   `{ device_id, bridge_id, permissions }`. The backend mints a short-lived
   (8 hour) session token bound to the requested permission set and returns
   `{ session_token, token_type: "Bearer", expires_in, granted_permissions }`.
3. **Use** — subsequent backend calls carry `X-Local-Connect-Token: <token>`.
   The backend validates via `GET /api/local-connect/session`.
4. **Revoke** — `POST /api/local-connect/revoke` with `{ session_token }`
   invalidates the session immediately. The frontend also clears its local copy.

The Khumbha AI bridge uses its own `X-Khumbha-AI-Token` (configured in its
settings). The two tokens are independent; the engine stores both locally.

## Permissions

Every capability is an on/off toggle persisted per device in
`localStorage` (`kaustubh.local-connect.permissions`). Toggles cover:

- Local AI bridge: read status, read models, chat, analyze
- Broker terminals: Dummy, Kotak Neo, Shoonya
- Order engine: place, cancel, modify
- Realtime/WebSocket: live feed read, control
- Connection manager: read, control
- Data/database: read, download, export
- Market data read
- Suggestions: read, run
- System/scheduler: read, control, config
- Backend: health, system, engines, market data

The granted set is sent during handshake and returned as `granted_permissions`.

## Files

- Frontend page: `app/_pages/local-connect-engine/page.tsx`
- Route: `app/(services)/services/local-connect-engine/page.tsx`
- Sidebar entry: `components/layout/nav.ts` (Engines group)
- Topbar context: `lib/topbar/context-registry.ts`
- Backend API: `python-service/api/local_connect.py`
- Backend registration: `python-service/app.py`

## Security notes

- Tokens are generated with `secrets.token_urlsafe` and stored only in the
  browser's `localStorage` on that device.
- Sessions expire after 8 hours and are pruned on access.
- Revoking clears both the backend session and the local copy.
- The engine never sends broker credentials or provider URLs to any other origin.