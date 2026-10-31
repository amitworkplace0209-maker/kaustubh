# KAUSTUBH Auth — Deployment Guide

## Overview

Single-owner authentication system with:
- **One-time signup** (name + password; email & MPIN pre-defined in `.env`)
- **Login** (email + password + MPIN, all three required)
- **App lock** — after session/refresh, unlock with MPIN only (no re-login)
- **Forgot password** — verify MPIN → set new password
- **Biometric** — fingerprint / face unlock option (WebAuthn)
- **Single user** — singleton owner in MongoDB
- **Session persistence** — 7-day cookie, no repeated login

## Files Changed

### Frontend (Next.js)
| File | Change |
|------|--------|
| `app/login/page.tsx` | Complete redesign: boot → signup → login → unlock → workspace → reset-password flow |
| `app/globals.css` | Added `.login-chip` CSS class |
| `app/api/auth/password/reset/route.ts` | New: POST proxy to backend `/api/auth/password/reset` |
| `.env` | Added `AUTH_MONGODB_URI`, `AUTH_MONGODB_DB`, `AUTH_RP_NAME` |

### Backend (Python FastAPI on VM1)
| File | Change |
|------|--------|
| `python-service/api/auth_app.py` | Added `POST /api/auth/password/reset` — verifies MPIN, rotates password hash |

## Local Development

### Prerequisites
1. **MongoDB** must be running locally on `127.0.0.1:27017`
2. Install dependencies: `npm ci`
3. Copy `.env.example` → `.env` (already configured)

### Run locally
```bash
npm run dev
```
Open `http://localhost:3000/login`

### First-time setup (empty MongoDB)
1. Open `/login` → sees **Signup** screen (no owner exists yet)
2. Enter **Name** (e.g. "Kaustubh")
3. Email & MPIN are fixed from `OWNER_EMAIL` / `OWNER_MPIN` in `.env` (read-only)
4. Create **Password** (10+ chars, upper+lower+number)
5. Click **Create owner account** → session created, redirected to workspace
6. On next visit → **Login** screen (email + password + MPIN)
7. After session → **App Lock** (MPIN only) to unlock

### Forgot password flow
1. On login screen, click **"Forgot password?"**
2. Enter your 6-digit MPIN
3. Set new password (10+ chars) + confirm
4. Password hash rotated in MongoDB → redirected to login

## Deployment to VM1 (Backend)

1. Copy `deploy/vm1-backend.env.template` → `/etc/kds/backend.env` on VM1
2. Fill in all `<REPLACE_*>` values:
   - `MONGODB_URI` — MongoDB connection string (VM2 or Atlas)
   - `AUTH_SESSION_SECRET` — `openssl rand -hex 48`
   - `AUTH_SIGNUP_EMAIL` — owner email
   - `AUTH_SIGNUP_MPIN` — 6-digit signup MPIN
   - `CORS_ORIGINS` — your Vercel production origin(s)
3. Run: `bash deploy/deploy-vm1-backend.sh`
4. Verify: `curl http://<VM1_IP>:8000/api/auth/status`

## Deployment to Vercel (Frontend)

1. Push code to GitHub: `git push origin main`
2. Import repo in Vercel
3. Add environment variables in Vercel project settings:
   - `BACKEND_URL` — public HTTPS URL of VM1 backend
   - `AUTH_RP_ID`, `AUTH_ORIGIN`, `AUTH_RP_NAME` — optional, for biometrics
4. Deploy

## Environment Variables Summary

### `.env` (local / frontend)
```
OWNER_EMAIL=amitworkplace0209@gmail.com
OWNER_MPIN=123456
AUTH_SIGNUP_EMAIL=amitworkplace0209@gmail.com
AUTH_SIGNUP_MPIN=123456
AUTH_SESSION_SECRET=<64+ hex chars>
AUTH_MAX_ACTIVE_SESSIONS=2
AUTH_MONGODB_URI=mongodb://127.0.0.1:27017/kaustubh
AUTH_MONGODB_DB=kaustubh
AUTH_RP_NAME=KAUSTUBH Trading Platform
```

### `/etc/kds/backend.env` (VM1 backend only)
```
MONGODB_URI=mongodb://<user>:<pass>@<host>:27017/<db>?authSource=admin
AUTH_SESSION_SECRET=<64+ hex chars>
AUTH_SIGNUP_EMAIL=<owner email>
AUTH_SIGNUP_MPIN=<6-digit mpin>
CORS_ORIGINS=https://<your-vercel-app>.vercel.app
```

## Security Notes
- `.env` is git-ignored — never commit real secrets
- MPIN is validated against `OWNER_MPIN` env var, never stored in MongoDB
- Passwords are hashed with scrypt (N=16384)
- Sessions are HMAC-SHA256 signed, 7-day TTL, httpOnly cookies
- Signup closes permanently after first owner exists
