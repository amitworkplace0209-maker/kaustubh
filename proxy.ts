import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/auth-crypto';

const SESSION_COOKIE = 'kaustubh_session';

/**
 * Paths that must NEVER be gated on authentication.
 *
 * CRITICAL (root cause of the "black screen / periodic reload / API request
 * storm"): ALL `/api/*` routes must be excluded. Before this fix the matcher
 * guarded every route, so when the `kaustubh_session` cookie was absent every
 * polling request (`/api/data-saver/dashboard`, `/api/phase2/system`,
 * `/api/phase2/websocket`, `/api/phase2/alerts`) was 307-redirected to
 * `/login`, which:
 *   - returned the login HTML instead of JSON to `fetch()`, breaking polling,
 *   - made the browser perform full document navigations to the (dark) login
 *     page — the visible "screen goes black" symptom,
 *   - and re-fetched all PWA assets (`/sw.js`, `/manifest.json`, icons) on
 *     every bounce (the repeated full-page-load requests in the network log).
 *
 * Authentication for API routes is enforced by each route (HTTP 401) instead
 * of by an HTML redirect, so a failed/absent session can never blank the page
 * or reload the browser.
 */
const UNGUARDED_PREFIXES = [
  '/api',            // all API routes — never send HTML redirects to JSON callers
  '/_next',          // Next.js assets
  '/icon',           // PWA icons
  '/manifest',       // PWA manifests (`.json`)
  '/sw.js',
  '/offline.html',
  '/favicon.ico',
];

const PUBLIC_PATHS = ['/login', '/api/auth', '/api/health'];

function isPublic(pathname: string): boolean {
  if (UNGUARDED_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) return true;
  return false;
}

/**
 * Root cause of "the page does not work / stock cannot be selected".
 *
 * The `kaustubh_session` cookie is an HMAC-signed token of the form
 * `base64url(payload).base64url(HMAC-SHA256(payload))` — see
 * `createSessionToken`/`verifySessionToken` in `lib/auth-crypto.ts`.
 *
 * This guard used to re-implement verification by base64-decoding the WHOLE
 * cookie and `JSON.parse`-ing it. That is wrong twice over:
 *   1. the payload is `base64url`, not `base64`, and
 *   2. the cookie also carries a `.` + signature suffix, so decoding the full
 *      value never yields the payload JSON.
 *
 * `JSON.parse` therefore always threw, the `catch` returned `false`, and EVERY
 * guarded page (including `/trading/trade`) 307-redirected back to `/login`
 * even with a perfectly valid session — `/api/auth/session` reported
 * `{"authenticated":true}` while the navigation never left `/login`.
 *
 * Verification must go through `verifySessionToken`, which checks the HMAC
 * signature in constant time and the `exp` claim. Proxy runs on the Node.js
 * runtime (Next.js 16 default) so this module — and the server-only session
 * secret it reads from `APP_SESSION_SECRET` / `.auth/session-secret` — is
 * available here. It MUST NOT be downgraded to a bare decode: that was the
 * original R-37 forgeable-cookie vulnerability.
 */
function isAuthenticated(request: NextRequest): boolean {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value) !== null;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Never gate static assets, PWA files, or API routes (see top of file).
  if (isPublic(pathname) || pathname === '/') {
    return NextResponse.next();
  }

  if (!isAuthenticated(request)) {
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') {
      loginUrl.searchParams.set('from', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Match everything EXCEPT internal/static files. We still match `/api`
  // here so the proxy runs and short-circuits via isPublic; the guard
  // itself never redirects API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|manifest).*)'],
};
