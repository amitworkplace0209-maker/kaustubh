# KAUSTUBH Trading Platform — Installation Guide

## Prerequisites

- **Node.js** 18+ (for Next.js frontend and Node.js backend)
- **Python** 3.10–3.13 (for Kotak Neo SDK service)
- **MongoDB** 5.0+ (for tick storage and app data)
- **npm** or **yarn**

## 1. Frontend (Next.js + PWA)

```bash
npm install
npm run build    # production build
npm run dev      # development server (port 3000)
```

## 2. Backend (Node.js)

```bash
cd backend
npm install
cp .env.example .env   # configure MongoDB URI and Python service URL
npm start              # starts on port 4000
```

### Backend Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 4000 | Node.js backend port |
| MONGODB_URI | mongodb://localhost:27017/kaustubh | MongoDB connection string |
| PYTHON_SERVICE_URL | http://localhost:8000 | Python service base URL |

## 3. Python Service (Kotak Neo SDK)

```bash
cd python-service
pip install -r requirements.txt
cp .env.example .env   # configure Kotak credentials
python app.py          # starts on port 8000
```

### Python Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| CLIENT_ID | Yes | Kotak Neo client ID (UCC) |
| CONSUMER_KEY | Yes | Kotak API consumer key |
| CONSUMER_SECRET | Yes | Kotak API consumer secret |
| MOBILE_NUMBER | Yes | Registered mobile number |
| MPIN | Yes | Kotak Neo MPIN |
| TOTP_SECRET | Yes | TOTP secret for 2FA |
| NODE_BACKEND_URL | Yes | Node.js backend URL (e.g., http://localhost:4000) |
| MONGODB_URI | No | MongoDB URI (defaults to localhost) |
| LOGIN_HOUR | No | Auto-login hour IST (default: 9) |
| LOGIN_MINUTE | No | Auto-login minute IST (default: 0) |
| LOGOUT_HOUR | No | Auto-logout hour IST (default: 15) |
| LOGOUT_MINUTE | No | Auto-logout minute IST (default: 35) |

## 4. MongoDB

Start MongoDB locally or use a cloud instance:

```bash
# Local MongoDB
mongod --dbpath /var/lib/mongodb

# Or use MongoDB Atlas (cloud)
# Set MONGODB_URI in backend/.env and python-service/.env
```

## 5. Running All Services

```bash
# Terminal 1: MongoDB
mongod

# Terminal 2: Python Service
cd python-service
python app.py

# Terminal 3: Node.js Backend
cd backend
npm start

# Terminal 4: Frontend
npm run dev
```

## 6. PWA Installation (Android)

1. Deploy to an HTTPS URL
2. Open the URL in Chrome on Android
3. Chrome will prompt "Add to Home Screen"
4. The app installs as a standalone app with its own icon

## Architecture

```
Python Service (port 8000)
  ├── Kotak Neo SDK (login, WebSocket, ticks)
  ├── Scheduler (09:00 login, 16:00 logout IST)
  └── Tick Forwarder → Node.js

Node.js Backend (port 4000)
  ├── Tick Buffer + Bulk Insert → MongoDB
  ├── Trading API proxy → Python
  ├── Dashboard/Settings/Downloads/Logs
  └── SSE Live Tick Stream → Frontend

Next.js Frontend (port 3000)
  ├── Phase 1: Data Saver (Dashboard, Stocks, Live Ticks, Downloads)
  ├── Phase 2: Trading (Dashboard, Positions, Orders, Account, Stocks, Settings, Notifications)
  └── PWA (manifest, service worker, offline)
```
