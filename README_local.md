# KAUSTUBH Data Saver

A production-ready backend that **automatically logs in to Kotak Neo, connects the WebSocket, receives live market data, and saves per-second stock data** for monitoring and download.

> This project does **not** place orders or trade. Its only job is reliable market-data capture.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Design Decision: Tick Persistence Path](#design-decision-tick-persistence-path)
3. [Technology Stack](#technology-stack)
4. [Folder Structure](#folder-structure)
5. [Installation](#installation)
6. [Running Locally](#running-locally)
7. [Running on Oracle Cloud VM](#running-on-oracle-cloud-vm)
8. [Environment Variables](#environment-variables)
9. [API Documentation](#api-documentation)
10. [Sequence Diagrams](#sequence-diagrams)
11. [Scheduler](#scheduler)
12. [Logging](#logging)
13. [Error Recovery](#error-recovery)
14. [Performance](#performance)
15. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

Two local services run side by side on the Oracle VM:

```
                         ┌──────────────────────┐
                         │   Kotak Neo Servers    │
                         │  (REST + WebSocket)     │
                         └──────────┬─────────────┘
                                    │  (official SDK only)
                                    ▼
┌─────────────────────────────────────────────────────┐
│                  python-service                      │
│  FastAPI · neo_api_client SDK                        │
│  • TOTP login + MPIN validation                     │
│  • WebSocket subscribe / unsubscribe                 │
│  • Scheduler (09:00 login / 16:00 logout IST)       │
│  • Forwards every tick to Node                      │
└──────────────────────┬──────────────────────────────┘
                       │  POST /api/ticks/ingest (JSON)
                       ▼
┌─────────────────────────────────────────────────────┐
│                   backend (Node.js)                  │
│  Express · Mongoose                                  │
│  • Stock management (CRUD)                           │
│  • Tick buffer → MongoDB bulk writes                 │
│  • Download APIs (CSV / JSON)                        │
│  • Statistics, Logs, System monitoring              │
│  • No Node-side scheduler — Python owns the full window│
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
                ┌──────────────┐
                │   MongoDB     │  (local, on the VM)
                │  ticks, stocks │
                │  app_logs     │
                └──────────────┘
```

**Responsibility split**

| Concern | Owner |
|---|---|
| Kotak Neo SDK (login, TOTP, session, WebSocket) | **Python** |
| Scheduler (09:00 login, 16:00 logout IST) | **Python** (sole owner) |
| Tick persistence to MongoDB | **Node.js** |
| Stock list management | **Node.js** |
| Download APIs (CSV/JSON) | **Node.js** |
| Statistics & monitoring | **Node.js** |
| Structured log storage | **Node.js** (Python forwards log events) |

---

## Design Decision: Tick Persistence Path

**Chosen approach: Python forwards every tick to Node.js; Node buffers and bulk-writes to MongoDB.**

### Why not write to MongoDB directly from Python?

| Factor | Direct Python write | Forward to Node (chosen) |
|---|---|---|
| WebSocket loop blocking | Mongo I/O on the WS thread can stall and drop ticks | Fire-and-forget HTTP enqueue, WS loop never blocks |
| Single responsibility | Python would need Mongo driver + retry logic | Python stays SDK-only; Node owns persistence |
| Write performance | Per-tick writes are slow at ~100 stocks | `insertMany(ordered=false)` bulk writes are 5-10x faster |
| Mongo outage resilience | Ticks lost with no fallback | Node re-queues batches in its buffer |
| One write path | Two persistence codebases | Centralised in Node |
| Stock metadata enrichment | Python must re-fetch from Node | Node already owns the stock list |

The forwarder uses a bounded in-memory queue (20k batches) and a background flush thread, so the WebSocket `on_message` callback is never blocked on network I/O. Node's `TickBuffer` accumulates ticks and flushes to MongoDB every 1 second (configurable) or when the buffer hits 5,000 entries.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, React, PWA, Tailwind CSS |
| Backend | Node.js, Express.js |
| Python service | Python 3.13, FastAPI |
| Kotak SDK | Official `neo_api_client` (v2.0.2, from GitHub) |
| Database | MongoDB (local on Oracle VM) |
| Deployment | Oracle Cloud VM (local processes, no containers) |

**Python version**: The official Kotak Neo SDK supports Python 3.10–3.13. This project targets **Python 3.13** (latest stable within the supported range). Do not use 3.14+.

**No Docker, no cloud DB, no serverless.** Everything runs as local processes on the VM.

---

## Folder Structure

```
kaustubh-data-saver/
├── backend/                      # Node.js service
│   ├── src/
│   │   ├── config/index.js
│   │   ├── controllers/
│   │   │   ├── stockController.js
│   │   │   ├── tickController.js
│   │   │   ├── downloadController.js
│   │   │   ├── statisticsController.js
│   │   │   ├── logController.js
│   │   │   └── systemController.js
│   │   ├── routes/
│   │   │   ├── stocks.js
│   │   │   ├── ticks.js
│   │   │   ├── downloads.js
│   │   │   ├── statistics.js
│   │   │   ├── logs.js
│   │   │   ├── system.js
│   │   │   └── internal.js
│   │   ├── services/
│   │   │   ├── tickBuffer.js
│   │   │   ├── stockService.js
│   │   │   ├── statisticsService.js
│   │   │   ├── logService.js
│   │   │   ├── systemService.js
│   │   │   └── pythonClient.js
│   │   ├── mongodb/
│   │   │   ├── connection.js
│   │   │   └── models/
│   │   │       ├── Stock.js
│   │   │       ├── Tick.js
│   │   │       ├── LogEntry.js
│   │   │       └── DailySummary.js
│   │   ├── download/tickDownload.js
│   │   ├── logs/logger.js
│   │   ├── scheduler/index.js
│   │   └── server.js
│   ├── package.json
│   └── .env.example
│
├── python-service/               # Python service
│   ├── config/
│   │   ├── __init__.py
│   │   └── settings.py
│   ├── auth/
│   │   ├── __init__.py
│   │   └── kotak_client.py
│   ├── scheduler/
│   │   └── __init__.py
│   ├── websocket/
│   │   ├── __init__.py
│   │   └── ws_manager.py
│   ├── services/
│   │   ├── __init__.py
│   │   ├── node_forwarder.py
│   │   └── stock_fetcher.py
│   ├── api/
│   │   ├── __init__.py
│   │   └── routes.py
│   ├── models/
│   │   └── __init__.py
│   ├── logger/
│   │   └── __init__.py
│   ├── utils/
│   │   ├── __init__.py
│   │   └── totp.py
│   ├── app.py
│   ├── requirements.txt
│   └── .env.example
│
└── README.md
```

---

## Installation

### Prerequisites

- **Oracle Cloud VM** (or any Linux machine) with:
  - Python 3.13 installed
  - Node.js 18+ installed
  - MongoDB 7+ installed and running locally
  - `git` (for the SDK install)

### 1. MongoDB setup

Install MongoDB Community Edition on the VM (follow the official MongoDB docs for Oracle Linux / Ubuntu). Start it:

```bash
sudo systemctl start mongod
sudo systemctl enable mongod
```

Verify: `mongosh --eval "db.runCommand({ ping: 1 })"`

### 2. Python service setup

```bash
cd python-service

# Create a virtual environment with Python 3.13
python3.13 -m venv .venv
source .venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install dependencies (includes the official Kotak Neo SDK from GitHub)
pip install -r requirements.txt

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your Kotak credentials
```

**SDK installation note**: The official SDK is installed directly from GitHub per the [official README](https://github.com/Kotak-Neo/Kotak-neo-api-v2):

```bash
pip install "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.2#egg=neo_api_client"
```

This is already in `requirements.txt`. If you need to force-reinstall:

```bash
pip install --force-reinstall "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.2#egg=neo_api_client"
```

### 3. Node.js backend setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env if your MongoDB URI or ports differ
```

---

## Running Locally

Start the three processes in separate terminals (or use a process manager on the VM).

### Terminal 1 — MongoDB

```bash
sudo systemctl start mongod
```

### Terminal 2 — Node.js backend

```bash
cd backend
npm start
# → listens on http://localhost:4000
```

### Terminal 3 — Python service

```bash
cd python-service
source .venv/bin/activate
python app.py
# → listens on http://localhost:8000
```

### Quick verification

```bash
# Node health
curl http://localhost:4000/health

# Python health
curl http://localhost:8000/health

# Add a stock to subscribe
curl -X POST http://localhost:4000/api/stocks \
  -H "Content-Type: application/json" \
  -d '{"symbol":"RELIANCE","instrumentToken":"2885","exchangeSegment":"nse_cm"}'
```

---

## Running on Oracle Cloud VM

For production, run both services as **systemd services** so they auto-start and restart on crash. No Docker.

### 1. MongoDB

Already handled by `systemctl enable mongod`.

### 2. Node.js backend service

Create `/etc/systemd/system/kaustubh-node.service`:

```ini
[Unit]
Description=KAUSTUBH Node.js Backend
After=network.target mongod.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/kaustubh/backend
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 3. Python service

Create `/etc/systemd/system/kaustubh-python.service`:

```ini
[Unit]
Description=KAUSTUBH Python Service
After=network.target kaustubh-node.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/kaustubh/python-service
ExecStart=/home/ubuntu/kaustubh/python-service/.venv/bin/python app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 4. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kaustubh-node
sudo systemctl enable --now kaustubh-python
sudo systemctl status kaustubh-node kaustubh-python
```

### Firewall

Open only the ports you need. If the frontend is hosted separately, expose 4000 (Node API) to the frontend host. The Python service (8000) only needs to be reachable from the Node service (localhost).

```bash
sudo iptables -I INPUT -p tcp --dport 4000 -j ACCEPT
```

---

## Environment Variables

### Python service (`python-service/.env`)

| Variable | Required | Description |
|---|---|---|
| `CLIENT_ID` | Yes | Your Kotak Neo UCC (Unique Client Code) |
| `CONSUMER_KEY` | Yes | From NEO app → Trade API card |
| `CONSUMER_SECRET` | Yes | From NEO app → Trade API card |
| `MOBILE_NUMBER` | Yes | Registered mobile with country code |
| `MPIN` | Yes | Your Neo account MPIN |
| `TOTP_SECRET` | Yes | Base32 TOTP secret from TOTP registration |
| `REDIRECT_URL` | No | OAuth redirect URL (default `https://127.0.0.1:8000/callback`) |
| `MONGODB_URI` | No | Local Mongo URI (informational; Python does not write to Mongo) |
| `NODE_BACKEND_URL` | Yes | Node backend base URL (e.g. `http://localhost:4000`) |
| `LOG_LEVEL` | No | `error` / `warn` / `info` / `debug` (default `info`) |
| `HOST` | No | Bind address (default `0.0.0.0`) |
| `PORT` | No | Listen port (default `8000`) |
| `NEO_ENVIRONMENT` | No | SDK environment (default `prod`) |

### Node.js backend (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | Yes | Local MongoDB connection string |
| `PORT` | No | Listen port (default `4000`) |
| `PYTHON_SERVICE_URL` | No | Python service URL for health checks & scheduler nudges |
| `LOG_LEVEL` | No | Winston log level (default `info`) |
| `BUFFER_FLUSH_INTERVAL_MS` | No | Tick buffer flush interval (default `1000`) |
| `BUFFER_MAX_SIZE` | No | Max ticks before forced flush (default `5000`) |
| `TICK_INGEST_RATE_LIMIT` | No | Per-minute rate limit on ingest endpoint (default `6000`) |

> **Never hardcode secrets.** All credentials live in `.env` files only. Never commit `.env`.

---

## API Documentation

### Python Service (port 8000)

#### `GET /health`
Service health and SDK availability.
```json
{ "status": "ok", "service": "kaustubh-python-service", "uptime_seconds": 120.5, "sdk_loaded": true }
```

#### `GET /status`
Current session and WebSocket state.
```json
{
  "logged_in": true,
  "session_active": true,
  "websocket_connected": true,
  "subscribed_symbols": 42,
  "last_login_at": "2026-07-31T03:30:00Z",
  "last_logout_at": null,
  "reconnect_count": 0,
  "sdk_version": "2.0.2"
}
```

#### `POST /login`
Triggers the full login sequence (TOTP + MPIN), starts the forwarder, fetches the stock list from Node, and subscribes.
```json
{ "ok": true, "message": "Login successful" }
```

#### `POST /logout`
Unsubscribes all tokens, logs out of the SDK, stops the forwarder.
```json
{ "ok": true, "message": "Logout successful" }
```

#### `GET /session`
Session info — **boolean flags only, never raw tokens**.
```json
{
  "logged_in": true,
  "view_token_present": true,
  "session_id_present": true,
  "trade_token_present": true,
  "user_id": "ABC123",
  "exchanges": ["NSE", "BSE"],
  "products": ["CNC", "MIS", "NRML"]
}
```

#### `POST /subscribe`
Subscribe to additional instrument tokens.
```json
// Request
{ "instrument_tokens": [{"instrument_token":"2885","exchange_segment":"nse_cm"}] }
// Response
{ "ok": true, "message": "subscribed", "count": 1 }
```

#### `POST /unsubscribe`
Unsubscribe instrument tokens. Same body shape as `/subscribe`.

---

### Node.js Backend (port 4000)

#### `GET /health`
```json
{ "status": "ok", "service": "kaustubh-node-backend" }
```

#### `GET /api/stocks`
List all managed stocks.
```json
{ "count": 2, "stocks": [{"symbol":"RELIANCE","instrumentToken":"2885","exchangeSegment":"nse_cm","active":true}] }
```
Query param `?active=true` to return only active stocks.

#### `POST /api/stocks`
Add or update a stock. Automatically subscribes on the Python service if active.
```json
// Request
{ "symbol":"RELIANCE", "instrumentToken":"2885", "exchangeSegment":"nse_cm", "isIndex":false, "isDepth":true }
// Response 201
{ "stock": { "symbol":"RELIANCE", "instrumentToken":"2885", ... } }
```

#### `DELETE /api/stocks/:symbol`
Unsubscribes on Python and removes the stock.
```json
{ "deleted": 1, "symbol": "RELIANCE" }
```

#### `POST /api/ticks/ingest`
Internal endpoint called by Python for every tick batch. Pushes ticks into the buffer for bulk MongoDB write.
```json
// Request
{ "ticks": [{"symbol":"RELIANCE","instrumentToken":"2885","ltp":2450.5,"ts":"2026-07-31T09:15:01Z",...}] }
// Response
{ "accepted": 1, "bufferLength": 1 }
```

#### `POST /api/ticks/log`
Internal endpoint for Python to persist structured log events to MongoDB.
```json
{ "category":"websocket","level":"info","message":"WebSocket connected","ts":"2026-07-31T03:30:00Z" }
```

#### `GET /api/downloads`
Download tick data as CSV or JSON.
- `?symbol=RELIANCE` — filter by symbol
- `?start=2026-07-31T09:00:00Z&end=2026-07-31T15:30:00Z` — time range
- `?limit=5000` — max rows (default 1000, max 50000)
- `?format=csv` or `?format=json` (default `json`)

Returns a file download with appropriate `Content-Disposition` header.

#### `GET /api/statistics`
Aggregated statistics.
```json
{
  "totalActiveStocks": 42,
  "totalTicksAllTime": 1250000,
  "perSymbol": [{"_id":"RELIANCE","count":50000,"minLtp":2400,"maxLtp":2480}],
  "todaySummary": {"totalTicks":50000,"totalWrites":50,"reconnectCount":0}
}
```

#### `GET /api/logs`
Query stored log entries.
- `?category=websocket` — filter by category
- `?level=error` — filter by level
- `?start=&end=` — time range
- `?limit=200` — max entries (default 200, max 5000)

#### `GET /api/system`
Full system monitoring — Node memory/CPU, Python health, Mongo status, buffer stats.
```json
{
  "node": { "status":"ok","uptimeSeconds":3600,"memory":{...},"cpuLoad1m":0.42 },
  "python": { "status":"ok","sdk_loaded":true },
  "mongo": { "connected": true },
  "buffer": { "totalReceived":50000,"totalWritten":49998,"bufferLength":2 },
  "activeStocks": 42
}
```

---

## Sequence Diagrams

### Daily Login Sequence (09:00 IST, weekdays)

```
Scheduler        Python Auth        WebSocket Mgr      Node Backend       Kotak Neo
   │                 │                   │                  │               │
   │  09:00 trigger  │                   │                  │               │
   ├────────────────►│                   │                  │               │
   │                 │  totp_login()     │                  │               │
   │                 ├──────────────────────────────────────────────────────►│
   │                 │  view_token+session_id                │              │
   │                 │◄─────────────────────────────────────────────────────│
   │                 │  totp_validate(mpin)│                 │              │
   │                 ├──────────────────────────────────────────────────────►│
   │                 │  trade_token        │                 │              │
   │                 │◄─────────────────────────────────────────────────────│
   │                 │  start forwarder   │                  │              │
   │                 │  fetch stocks      │                  │              │
   │                 ├───────────────────────────────────────►│              │
   │                 │  active stock list │                  │              │
   │                 │◄──────────────────────────────────────│              │
   │                 │  subscribe(tokens) │                  │              │
   │                 ├──────────────────►│                  │              │
   │                 │                   │  subscribe()     │              │
   │                 │                   ├─────────────────────────────────►│
   │                 │                   │  ws connected   │              │
   │                 │                   │◄─────────────────────────────────│
   │                 │                   │  on_message(tick)              │
   │                 │                   │  forward_ticks  │              │
   │                 │                   ├──────────────────►│            │
   │                 │                   │                   │  buffer+bulk│
   │                 │                   │                   │  write      │
   │                 │                   │                   ├────────────►│ MongoDB
```

### Tick Flow (per tick)

```
Kotak WS ──► Python on_message ──► Node forwarder queue ──► Node /api/ticks/ingest
                                                            │
                                                            ▼
                                                    TickBuffer (memory)
                                                            │  (1s or 5000 ticks)
                                                            ▼
                                                    MongoDB bulk insert
```

### Daily Logout Sequence (16:00 IST, weekdays)

```
Scheduler   WebSocket Mgr   Python Auth   Node Forwarder   Kotak Neo
   │              │              │              │               │
   │ 16:00 trigger│              │              │               │
   ├─────────────►│              │              │               │
   │              │ un_subscribe(all)          │               │
   │              ├────────────────────────────────────────────►│
   │              │ disconnect    │              │              │
   │              │              │  logout()    │              │
   │              │              ├─────────────────────────────►│
   │              │              │              │  stop flush  │
   │              │              │  stop forwarder             │
   │              │              ├─────────────►│              │
   │              │              │              │  drain queue │
   │              │              │              │  final write │
   │              │              │              ├────────────►│ MongoDB
```

---

## Scheduler

Both services run schedulers, but **Python is the primary**:

| Time (IST) | Action | Primary | Backup |
|---|---|---|---|
| 09:00, Mon-Fri | Login + subscribe | Python scheduler | — |
| 16:00, Mon-Fri | Unsubscribe + logout | Python scheduler | — |

The Python scheduler computes the next run time using IST wall-clock (independent of host timezone) and reschedules itself after each run. Weekends are skipped.

---

## Logging

Structured JSON logs with daily rotation (30 days retained, auto-zipped).

### Log categories

| Category | File | Content |
|---|---|---|
| `login` | `login.log` | TOTP, MPIN, session events |
| `scheduler` | `scheduler.log` | Login/logout triggers, next-run times |
| `websocket` | `websocket.log` | Connect, disconnect, subscribe, errors |
| `reconnect` | `reconnect.log` | Reconnect attempts and outcomes |
| `error` | `error.log` | All error-level events |
| `performance` | `performance.log` | Buffer flush timings, tick counts |
| `app` | `app.log` | General application events |

Python forwards log events to Node's `POST /api/ticks/log` endpoint, which persists them to the `app_logs` MongoDB collection for querying via `GET /api/logs`.

---

## Error Recovery

| Failure | Detection | Recovery |
|---|---|---|
| Internet loss | WebSocket `on_close` / `on_error` callback | SDK auto-reconnects; forwarder re-queues; scheduler retries next day |
| SDK exception | Try/catch in auth layer | Logged to `error.log`; login retried by scheduler or manual `POST /login` |
| WebSocket disconnect | `on_close` callback | Subscriptions preserved; on reconnect, Python re-subscribes the active list from Node |
| Expired session | `403` from SDK calls | Detected in auth; re-login triggered |
| MongoDB failure | Mongoose connection error | Node buffer re-queues the batch; Mongo reconnection is automatic via Mongoose |
| Node backend down | Python forwarder HTTP error | Ticks queued in Python's bounded queue; flushed when Node recovers |

All services run under systemd with `Restart=always`, so a crashed process restarts within 5 seconds.

---

## Performance

- **Target**: ~100 subscribed stocks, per-second tick processing.
- **Node tick buffer**: bulk `insertMany(ordered=false)` every 1 second or 5,000 ticks — minimises Mongo write round-trips.
- **Python forwarder**: bounded queue (20k batches) + background flush thread — WebSocket loop never blocks on I/O.
- **No polling**: WebSocket is push-based; schedulers use `Timer` with computed delays, not busy-wait loops.
- **Memory**: buffer auto-flushes; queues are bounded; dropped batches are counted and logged.

---

## Troubleshooting

### Python service won't start: `ModuleNotFoundError: No module named 'neo_api_client'`

The SDK must be installed from GitHub (not PyPI). Run:
```bash
source .venv/bin/activate
pip install "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.2#egg=neo_api_client"
```

### Login fails: TOTP error

Ensure `TOTP_SECRET` is the **base32** secret from the Kotak TOTP registration QR code, not the 6-digit code itself. The code is generated from the secret at runtime.

### `GET /health` returns `sdk_loaded: false`

The SDK failed to import. Check the Python service logs (`logs/error.log`). Common cause: wrong Python version (must be 3.10–3.13).

### Node backend can't connect to MongoDB

Verify MongoDB is running: `sudo systemctl status mongod`. Check `MONGODB_URI` in `backend/.env`.

### Python can't reach Node

Check `NODE_BACKEND_URL` in `python-service/.env`. It must point to the Node backend (default `http://localhost:4000`). Verify with `curl http://localhost:4000/health`.

### No ticks appearing in downloads

1. Check `GET /api/system` — is `python.websocket_connected` true?
2. Check `GET /api/system` — is `buffer.totalReceived` increasing?
3. If Python is connected but buffer is empty, check Python logs for forwarder errors.
4. If buffer is receiving but `totalWritten` isn't increasing, check MongoDB connectivity.

### Scheduler not triggering at the right time

The scheduler uses IST (Asia/Kolkata). Verify the VM clock is correct: `timedatectl`. The scheduler computes IST independently of host timezone, so UTC or any local timezone is fine as long as the clock is accurate.

### Port already in use

Change `PORT` in the respective `.env` file. Remember to update `PYTHON_SERVICE_URL` (Node) and `NODE_BACKEND_URL` (Python) if ports change.
