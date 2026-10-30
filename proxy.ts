import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'kaustubh_session';
const MPIN_PENDING_COOKIE = 'kaustubh_mpin_pending';

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

function backendBase(): string | null {
  const raw = (process.env.BACKEND_URL || (process.env.VERCEL ? '' : 'http://127.0.0.1:8000')).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

interface SessionPayload {
  authenticated?: boolean;
  sid?: string;
  exp?: number;
}

/**
 * Read the signed-cookie payload without importing the Node crypto/fs modules.
 *
 * The signature is verified authoritatively by the VM1 backend on every
 * session-gated endpoint (`/api/auth/whoami`). Here we only need the session id
 * to ask the backend whether that row is still live, so a forged cookie can
 * never unlock a page: the sid has to belong to a real, unrevoked session.
 */
function readSessionPayload(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8')) as SessionPayload;
    if (!payload || payload.authenticated !== true) return null;
    if (!payload.sid || !Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * The signed cookie alone is not enough: a session can be revoked from another
 * device, and the signature would otherwise stay valid until it expires. Ask
 * the VM1 backend (which owns the session rows) whether the session is live,
 * with a short per-process cache so page and API traffic does not hammer the
 * backend. Fail closed when the backend is unreachable — the login page still
 * loads and explains the outage.
 */
const SESSION_REVALIDATE_MS = 10_000;
const liveSessions = new Map<string, number>();

function rememberLiveSession(sessionId: string, live: boolean): void {
  if (liveSessions.size > 256) {
    const oldest = liveSessions.keys().next().value;
    if (oldest) liveSessions.delete(oldest);
  }
  liveSessions.set(sessionId, live ? Date.now() + SESSION_REVALIDATE_MS : 0);
}

async function isSessionLive(request: NextRequest, payload: SessionPayload): Promise<boolean> {
  const sid = payload.sid;
  if (!sid) return false;

  const cachedUntil = liveSessions.get(sid) ?? 0;
  if (cachedUntil > Date.now()) return true;
  // A negative result is not cached: the owner may log in again immediately.

  const base = backendBase();
  if (!base) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${base}/api/auth/live?sid=${encodeURIComponent(sid)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data = (await response.json().catch(() => null)) as { ok?: boolean; live?: boolean } | null;
    const live = data?.ok === true && data.live === true;
    if (live) rememberLiveSession(sid, true);
    return live;
  } catch {
    // Backend unreachable: deny rather than trust an unverifiable session.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isAsset(pathname) || isPublic(pathname)) {
    return NextResponse.next();
  }

  const payload = readSessionPayload(request.cookies.get(SESSION_COOKIE)?.value);
  const authenticated = payload ? await isSessionLive(request, payload) : false;
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
