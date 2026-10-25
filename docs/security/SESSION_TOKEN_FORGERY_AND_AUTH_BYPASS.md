# SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md

## Unauthenticated session forgery → backend operator JWT

**Created**: 2026-09-28
**Severity**: **CRITICAL**
**Marker**: `DOCUMENTATION_CODE_CONFLICT` (code is unambiguous; the risk is in the design)
**Method**: static reading of `lib/auth-crypto.ts`, `lib/env.ts`,
`app/api/auth/login/route.ts`, `app/api/realtime/token/route.ts`.
**No server was started. No request was sent. No cookie was forged or transmitted.**
**Runtime exploitability is `NOT_VERIFIED`** — but the code path admits no ambiguity.

---

## 1. Summary

`kaustubh_session` is **not a signed token**. It is `base64(unsiged JSON)`. The only
validation anywhere in the codebase is a decode plus two boolean checks. **Any client can
authenticate itself by sending a cookie it wrote itself**, with no PIN, no secret, and no
server state.

That forged cookie is the *sole* gate on the endpoint which mints **real backend operator
JWTs** from server-side `APP_USERNAME`/`APP_PASSWORD`. Chained, this yields:

```
attacker-crafted cookie  ->  passes sessionIsValid()  ->  /api/realtime/token
        ->  server-side operator credentials  ->  genuine backend operator JWT
        ->  the 37 routers that have no auth (R-17)  ->  engine stop / broker select
```

Two **independent** bypasses exist, either of which is sufficient on its own.

---

## 2. Bypass 1 — unsigned session token (structural)

### 2.1 Tokens are unsigned

`lib/auth-crypto.ts:52-59`

```ts
export function createSessionToken(): string {
  const payload = {
    authenticated: true,
    iat: Date.now(),
    exp: Date.now() + 24 * 60 * 60 * 1000,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}
```

No HMAC, no signature, no encryption, no server-side nonce, no lookup. The token is
**readable and writable by the client**. `createHash`/`timingSafeEqual` are imported in
this file and used for the PIN — but never for the session token.

### 2.2 Validation is a decode and two checks

`app/api/realtime/token/route.ts:30-38` — the **only** session validator found:

```ts
function sessionIsValid(cookie: string | undefined): boolean {
  if (!cookie) return false;
  try {
    const payload = JSON.parse(Buffer.from(cookie, 'base64').toString('utf8'));
    return Boolean(payload && payload.authenticated === true && Number(payload.exp) > Date.now());
  } catch {
    return false;
  }
}
```

A search across `app\`, `lib\` and `middleware.ts` for `verifySession`, `validateSession`,
`checkSession`, `verifyToken`, `parseSession` and `authenticated ===` returned **exactly
this one function**. There is **no `middleware.ts`** in the project, so no edge gate either.

### 2.3 The forgery

The whole token schema is visible in the source, so an attacker needs no guessing:

```bash
# forge a session valid until the year 5138
printf '{"authenticated":true,"iat":0,"exp":99999999999999}' | base64
# -> eyJhdXRoZW50aWNhdGVkIjp0cnVlLCJpYXQiOjAsImV4cCI6OTk5OTk5OTk5OTk5fQ

curl -H 'Cookie: kaustubh_session=eyJhdXRoZW50aWNhdGVkIjp0cnVlLCJpYXQiOjAsImV4cCI6OTk5OTk5OTk5OTk5fQ' \
     http://127.0.0.1:3000/api/realtime/token
```

`exp` is only compared with `> Date.now()`, so any future value is accepted. There is no
upper bound, no `iat` check, and no revocation.

---

## 3. Bypass 2 — `direct: true` needs no credentials at all

`app/api/auth/login/route.ts:38-50`

```ts
if (direct) {
  const locked = await isAppLockConfigured();
  if (locked) {
    return Response.json({ ok: false, message: 'App Lock is enabled - PIN is required' }, { status: 403 });
  }
  const token = createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set('kaustubh_session', token, setSessionCookie());
  return Response.json({ ok: true, message: 'Authenticated' });
}
```

With app lock unconfigured, `POST /api/auth/login {"direct": true}` returns a session
cookie **with no PIN, no password, and no proof of anything**.

### 3.1 `isAppLockConfigured()` fails open

`app/api/auth/login/route.ts:5-10`

```ts
const config = await loadConfig();
if (config?.pinHash) return true;
if (process.env.APP_LOCK_PIN) return true;
return false;   // <- fail OPEN
```

`loadConfig()` (`lib/auth-crypto.ts:28-36`) returns `null` whenever the file is missing
**or unparseable** — `catch { return null; }`. So a deleted file, a corrupt file, a
permissions error, or a fresh clone all resolve to *lock disabled*.

### 3.2 The current tree is in exactly that state

| Precondition | State on this machine |
|---|---|
| `C:\project\.auth\app-lock.json` | **does not exist** (the `.auth\` directory exists but is empty) |
| `APP_LOCK_PIN` in `.env` | **not set** (declared only in `.env.example`) |
| `APP_LOCK_PIN` in `python-service\.env` | **not set** |

→ `isAppLockConfigured()` returns `false` → **Bypass 2 is live right now.**

`.auth/` is listed in `.gitignore:32`, and `APP_LOCK_PIN` exists only in `.env.example`, so
**a fresh clone reproduces the bypass by default.** This is not a local misconfiguration; it
is the default state of the repository.

---

## 4. Why it escalates: the token endpoint mints operator credentials

`app/api/realtime/token/route.ts:40-45`

```ts
async function acquireOperatorJwt(): Promise<string | null> {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  if (!username || !password) return null;
  ...
```

Per the file's own docstring (lines 13-25), the intended model is:

1. validate the Next-layer session cookie — *"Unauthenticated callers get an honest 401 and
   NEVER touch the backend - this stops the unauthenticated token spam on /login."*
2. otherwise obtain an **operator JWT** from the backend using server-side
   `APP_USERNAME`/`APP_PASSWORD`, cached for the JWT lifetime
3. or, in insecure/local mode, proxy anonymously and let the backend issue an anonymous token

Step 1 is the only thing standing between the internet and step 2. Since step 1 is
forgeable, **the control described in step 1 does not exist.** Note that
`APP_USERNAME`/`APP_PASSWORD` are *not* currently set, so today the escalation degrades to
an anonymous token — but the design permits full operator escalation the moment they are
configured, and the fail-open PIN check would allow an attacker to set them.

`cachedOperatorJwt` is a module-level singleton (line 28) with an 8-hour TTL
(`OPERATOR_JWT_TTL_MS = 28_800_000`), so one successful forgery yields a long-lived
credential.

---

## 5. Secondary weaknesses in the same code path

| # | Issue | Location |
|---|-------|----------|
| a | **`Math.random()` used for the PIN salt** — not cryptographically secure; should be `crypto.randomBytes`. Salt is `sha256(Date.now() + Math.random())` | `lib/auth-crypto.ts:19-21` |
| b | **Single-round SHA-256 for PIN hashing** — no PBKDF2/scrypt/argon2/bcrypt. A 6-digit PIN is ~10^6 candidates; one SHA-256 each is seconds on a GPU | `lib/auth-crypto.ts:15-17` |
| c | **Non-constant-time comparison** for the env-PIN path (`pin === envPin`) while the hash path correctly uses `constantTimeCompare` — inconsistent, and leaks length/prefix via timing | `app/api/auth/login/route.ts:19` |
| d | **No rate limiting or lockout** on the PIN endpoint — 6 digits, no throttling. Corroborates **R-29** | `app/api/auth/login/route.ts:33` |
| e | `secure: process.env.NODE_ENV === 'production'` — in every non-production environment the session cookie is sent over plaintext HTTP | `app/api/auth/login/route.ts:26` |
| f | PIN must be exactly 6 digits (`/^\d{6}$/`), which caps the search space at 10^6 and makes (b) worse | `app/api/auth/login/route.ts:59` |
| g | `GUEST_EMAIL` / `GUEST_PASSWORD` accessors exist in `lib/env.ts:24-26` and are documented in `.env.example`, but are **referenced nowhere** in `app\`, `lib\`, `components\` or `hooks\`. Dead code, but a standing invitation to reintroduce static credentials | `lib/env.ts` |

---

## 6. Assessment

| Question | Answer |
|----------|--------|
| Is the token signed? | **No** |
| Can a client mint a valid session? | **Yes** — `base64` of a 3-key JSON object |
| Is there any other validation? | **No** — one decode + two boolean checks, no `middleware.ts` |
| Is the fail-open PIN path live now? | **Yes** — no `app-lock.json`, no `APP_LOCK_PIN` |
| Is a fresh clone affected by default? | **Yes** — `.auth/` is gitignored, `APP_LOCK_PIN` only in `.env.example` |
| Does it escalate to backend operator credentials? | **Yes by design**; currently degrades to anonymous because `APP_USERNAME`/`APP_PASSWORD` are unset |
| Was it exploited? | **Unknown and unknowable from here.** No logs, WAF, or history were inspected |
| Is it network-reachable? | **Unknown** — depends on deployment (see `AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md`) |

**The structural flaws are certain; only the reachability is unproven.** That is the worst
possible combination: an exploit whose exploitability cannot be dismissed.

---

## 7. Remediation (documented only — no code changed)

Ordered by dependency. Items 1-2 are prerequisites for trusting anything else.

1. **Sign the session token.** HMAC-SHA-256 over the payload with a secret from
   `SESSION_SECRET` (or reuse a hardened `JWT_SECRET`), compared with `timingSafeEqual`.
   Alternatively store an opaque random session id server-side and keep only the id in the
   cookie. **Do not ship unsigned cookies, even for an app lock.**
2. **Fail closed on the PIN path.** `isAppLockConfigured()` should return `true` (or the
   route should refuse) when no config is present, and `loadConfig()` should distinguish
   "absent" from "corrupt". Gate `direct: true` behind an explicit non-production flag.
3. **Fix the escalation.** `/api/realtime/token` must not hand an operator JWT to a caller
   whose identity is only a client-held cookie. Once (1) lands this is largely resolved;
   until then treat the endpoint as public.
4. **Move the token minting server-side only** and never return operator credentials to the
   browser — the client needs a *realtime* token, not the operator JWT.
5. Replace `Math.random()` with `crypto.randomBytes`; replace single-round SHA-256 with
   `scrypt`/`argon2`; use `constantTimeCompare` on the env-PIN path too.
6. Add rate limiting and lockout to `/api/auth/login` (**R-29**).
7. Delete the unused `GUEST_EMAIL`/`GUEST_PASSWORD` accessors, or implement them properly.
8. Set `secure: true` unconditionally when served over HTTPS; set `maxAge` to a shorter
   window than 24 h.

---

## 8. Documentation impact

- The claim in `34_DEVELOPER_ONBOARDING.md` / `35_AI_AGENT_CONTEXT.md` that the frontend
  session is a secure login is **not supported by the code**. The Next-layer "session" is
  an unsigned cookie over an app-lock PIN, and the *real* authentication boundary is the
  backend operator JWT — which the Next layer holds on the user's behalf.
- `docs/security/SECURITY_ARCHITECTURE.md` describes a token model that does not match
  `lib/auth-crypto.ts`. It should be corrected to state that the Next session is unsigned.

---

## Related
- `security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` — R-17, R-18, R-19
- `PROJECT_RISKS.md` — **R-36**, R-37, R-29
- `audits/DUPLICATE_AND_LEGACY_FINDINGS.md` — D-22
- `audits/VERSION_CONTROL_STATE.md` — why a fresh clone is the *default* vulnerable state

---
*Static reading only. No request was sent, no cookie was created, no server was started.*
