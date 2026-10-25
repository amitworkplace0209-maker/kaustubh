import { NextRequest, NextResponse } from 'next/server';
import { MPIN_PENDING_COOKIE, verifySessionToken } from '@/lib/auth-crypto';
import { getOwner, getSessionDoc } from '@/lib/auth-db';

const SESSION_COOKIE = 'kaustubh_session';

/** JSON, not HTML — a fetch() caller must never receive the login page. */
const API_PREFIX = '/api';

/**
 * The first login (and the one-time signup) issues a session so the MPIN can be
 * saved, but marks it MPIN-pending. Until the MPIN is set the app must stay
 * closed — even if the user types a protected URL directly — so this is the
 * only group of routes reachable with that cookie still present.
 */
const MPIN_SETUP_PATHS = [
  '/api/auth/mpin/setup',
  '/api/auth/session',
  '/api/auth/status',
  '/api/auth/logout',
];

function isMpinSetupPath(pathname: string): boolean {
  return MPIN_SETUP_PATHS.includes(pathname);
}

/**
 * Assets that must stay reachable before login, otherwise the browser cannot
 * render the login page itself (fonts, chunks, PWA icons, service worker).
 */
const ASSET_PREFIXES = ['/_next', '/sw.js', '/offline.html', '/manifest', '/icon-', '/apple-', '/favicon'];

/**
 * Public routes. `/login` is the only public page; the auth endpoints below are
 * the ones needed to bootstrap the single-owner account and its session.
 * Everything else — every page and every API route — requires a session.
 */
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/status',
  '/api/auth/session',
  '/api/auth/logout',
  '/api/auth/login/verify-otp',
  '/api/health',
  '/offline.html',
  '/manifest.json',
  '/sw.js',
];

function isAsset(pathname: string): boolean {
  return ASSET_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(prefix));
}

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function isAuthenticated(request: NextRequest): boolean {
  return Boolean(verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value));
}

/**
 * The signature alone is not enough: a session can be revoked from another
 * device, and the signed cookie would otherwise stay valid until it expires.
 * Verify the database row too, with a short per-process cache so page and API
 * traffic does not hammer MongoDB. Fail closed when the database is
 * unreachable — the login page still loads and explains the outage.
 */
const SESSION_REVALIDATE_MS = 10_000;
const liveSessions = new Map<string, number>();

function rememberLiveSession(sessionId: string, expiresAt: number): void {
  // Bound the cache: this app only ever has two live sessions, but a long
  // running process must not grow the map on every new login.
  if (liveSessions.size > 64) {
    const oldest = liveSessions.keys().next().value;
    if (oldest) liveSessions.delete(oldest);
  }
  liveSessions.set(sessionId, Math.min(Date.now() + SESSION_REVALIDATE_MS, expiresAt));
}

async function isSessionLive(request: NextRequest): Promise<boolean> {
  if (!isAuthenticated(request)) return false;
  const payload = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!payload?.sid) return false;

  const cachedUntil = liveSessions.get(payload.sid) ?? 0;
  if (cachedUntil > Date.now()) return true;

  try {
    const session = await getSessionDoc(payload.sid);
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      liveSessions.delete(payload.sid);
      return false;
    }
    const owner = await getOwner();
    if (!owner || String(owner._id) !== session.userId) {
      liveSessions.delete(payload.sid);
      return false;
    }
    rememberLiveSession(payload.sid, session.expiresAt.getTime());
    return true;
  } catch {
    // MongoDB unreachable: deny rather than trust an unverifiable session.
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isAsset(pathname) || isPublic(pathname)) {
    return NextResponse.next();
  }

  const authenticated = await isSessionLive(request);
  const isApi = pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);

  // First-run lock: the session exists only so the owner can save the MPIN.
  // Without this, opening a protected URL directly would skip the mandatory
  // setup step and expose the app with a valid session.
  const mpinPending = request.cookies.get(MPIN_PENDING_COOKIE)?.value === '1';
  if (authenticated && mpinPending && !isMpinSetupPath(pathname)) {
    if (isApi) {
      return NextResponse.json(
        {
          ok: false,
          authenticated: true,
          needsMpinSetup: true,
          code: 'MPIN_SETUP_REQUIRED',
          error: 'MPIN_SETUP_REQUIRED',
          message: 'Set your MPIN before using the app.',
        },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const setupUrl = request.nextUrl.clone();
    setupUrl.pathname = '/login';
    setupUrl.search = '';
    setupUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(setupUrl);
  }

  if (isApi) {
    if (authenticated) return NextResponse.next();
    return NextResponse.json(
      {
        ok: false,
        authenticated: false,
        code: 'UNAUTHENTICATED',
        error: 'UNAUTHENTICATED',
        message: 'No valid app session — log in first.',
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (authenticated) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  loginUrl.searchParams.set('from', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
