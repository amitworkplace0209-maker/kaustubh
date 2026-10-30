import { NextResponse, type NextRequest } from 'next/server';
import { normalizeAuthPayload } from '@/lib/auth-payload';

/**
 * Server-side bridge for the app-level auth API.
 *
 * On Vercel the frontend has no MongoDB credentials and no private route to
 * the database. Every `/api/auth/*` route is therefore a thin proxy to the
 * VM1 FastAPI backend, which owns the single MongoDB connection. This module
 * centralises that proxy so every route forwards the same things:
 *
 *   * the complete cookie header (session + MPIN-pending marker),
 *   * the real client IP headers (rate limits + audit trail),
 *   * `x-forwarded-proto` (so the backend marks cookies `Secure` over HTTPS),
 *   * the JSON body unchanged.
 *
 * It also forwards `Set-Cookie` back to the browser. Without that the backend
 * could create a session and the browser would never receive the cookie.
 *
 * Failure policy: a missing BACKEND_URL or an unreachable/timed-out backend
 * returns a 503 JSON response (`code: BACKEND_UNAVAILABLE`). The login page
 * renders that error and offers a retry — it is never left waiting forever.
 */

export const AUTH_BACKEND_TIMEOUT_MS = 20_000;

const FORWARDED_HEADERS = [
  'user-agent',
  'origin',
  'referer',
  'accept-language',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'x-vercel-forwarded-for',
  'x-client-ip',
  'true-client-ip',
  'x-forwarded-proto',
  'x-forwarded-host',
] as const;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function backendAuthBase(): string | null {
  const raw = (process.env.BACKEND_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function noStoreJson(payload: unknown, status: number): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

export function backendUnavailable(message?: string): NextResponse {
  return noStoreJson(
    {
      ok: false,
      authenticated: false,
      code: 'BACKEND_UNAVAILABLE',
      error: 'BACKEND_UNAVAILABLE',
      message:
        message ||
        'The authentication service is unavailable right now. Retry in a moment.',
    },
    503,
  );
}

/**
 * Same-origin guard for browser state-changing requests.
 *
 * Cookies are SameSite=Lax, which already blocks cross-site form POSTs in
 * modern browsers. This is a second, explicit layer: when a browser sends an
 * Origin header it must match this deployment (or an explicitly configured
 * AUTH_ORIGIN). Non-browser server-to-server calls (no Origin) are allowed,
 * exactly as the tunnel/health probes require.
 */
export function isSameOriginRequest(request: NextRequest): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = request.headers.get('host');
    if (host && parsed.host === host) return true;
    const allowed = (process.env.AUTH_ORIGIN || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

function forwardHeaders(request: NextRequest): Headers {
  const headers = new Headers({ Accept: 'application/json' });
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  return headers;
}

function appendSetCookies(target: NextResponse, source: Response): void {
  const getSetCookie = (source.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies =
    typeof getSetCookie === 'function'
      ? getSetCookie.call(source.headers)
      : source.headers.get('set-cookie')
        ? [source.headers.get('set-cookie') as string]
        : [];
  for (const cookie of cookies) target.headers.append('Set-Cookie', cookie);
}

export interface BackendCall {
  ok: boolean;
  status: number;
  data: unknown;
  response: Response;
}

async function fetchBackend(
  request: NextRequest,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = backendAuthBase();
  if (!base) throw new Error('BACKEND_URL is not configured');
  const target = path.startsWith('http') ? path : `${base}${path}`;
  const headers = forwardHeaders(request);
  if (init.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_BACKEND_TIMEOUT_MS);
  try {
    return await fetch(target, {
      ...init,
      headers,
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Proxy one auth request to the VM1 backend and relay the JSON body,
 * status code and Set-Cookie headers back to the browser.
 */
export async function proxyAuth(
  request: NextRequest,
  path: string,
  init: RequestInit = {},
): Promise<NextResponse> {
  if (!backendAuthBase()) return backendUnavailable('Backend not configured.');

  if (!isSameOriginRequest(request)) {
    return noStoreJson(
      { ok: false, code: 'ORIGIN_REJECTED', message: 'Cross-site request rejected.' },
      403,
    );
  }

  const method = (init.method || request.method || 'GET').toUpperCase();
  const body =
    init.body !== undefined
      ? init.body
      : method === 'GET' || method === 'HEAD'
        ? undefined
        : await request.text();

  let response: Response;
  try {
    response = await fetchBackend(request, path, {
      ...init,
      method,
      body,
      headers: {
        ...(body ? { 'Content-Type': request.headers.get('content-type') || 'application/json' } : {}),
        ...((init.headers as Record<string, string> | undefined) || {}),
      },
    });
  } catch {
    return backendUnavailable();
  }

  const contentType = response.headers.get('content-type') || 'application/json';
  const text = await response.text().catch(() => '');
  let payload: unknown = null;
  if (text) {
    try {
      payload = normalizeAuthPayload(JSON.parse(text));
    } catch {
      payload = null;
    }
  }

  if (payload === null) {
    // Never relay an HTML error page (or an empty 5xx) as if it were JSON.
    if (response.ok) {
      const fallback = NextResponse.json(
        { ok: false, code: 'INVALID_BACKEND_RESPONSE', message: 'The authentication service returned an invalid response.' },
        { status: 502 },
      );
      fallback.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return fallback;
    }
    const fallback = backendUnavailable('The authentication service returned an invalid response.');
    fallback.headers.set('x-auth-upstream-status', String(response.status));
    return fallback;
  }

  const out = NextResponse.json(payload, {
    status: response.status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': contentType,
    },
  });
  appendSetCookies(out, response);
  return out;
}

/**
 * Call a session-gated backend auth endpoint with the browser's cookies.
 * Used by the WebAuthn routes, which keep the crypto in Node but persist data
 * through VM1.
 */
export async function backendAuthJson(
  request: NextRequest,
  path: string,
  init: RequestInit = {},
): Promise<BackendCall | { ok: false; status: number; data: unknown; response: null }> {
  try {
    const response = await fetchBackend(request, path, {
      ...init,
      method: (init.method || 'GET').toUpperCase(),
    });
    const text = await response.text().catch(() => '');
    let data: unknown = null;
    if (text) {
      try {
        data = normalizeAuthPayload(JSON.parse(text));
      } catch {
        data = null;
      }
    }
    return { ok: response.ok, status: response.status, data, response };
  } catch {
    return { ok: false, status: 0, data: null, response: null };
  }
}

export type BackendSession =
  | {
      ok: true;
      user: Record<string, unknown>;
      session: Record<string, unknown>;
    }
  | { ok: false; response: NextResponse };

/**
 * Mirrors the old `requireSession` contract, but the authority is the VM1
 * backend (it owns the session row and the owner document).
 */
export async function requireBackendSession(
  request: NextRequest,
  options: { requireMpin?: boolean } = {},
): Promise<BackendSession> {
  if (!backendAuthBase()) return { ok: false, response: backendUnavailable('Backend not configured.') };

  const query = options.requireMpin ? '?requireMpin=true' : '';
  const result = await backendAuthJson(request, `/api/auth/whoami${query}`, { method: 'GET' });
  if (result.response === null) return { ok: false, response: backendUnavailable() };

  const data = (result.data || {}) as Record<string, unknown>;
  if (!result.ok || data.ok !== true) {
    const status = result.status || 401;
    const response = noStoreJson(
      data.ok === false
        ? data
        : { ok: false, authenticated: false, code: 'UNAUTHENTICATED', message: 'Your session has expired. Please log in again.' },
      status,
    );
    return { ok: false, response };
  }

  return {
    ok: true,
    user: (data.user || {}) as Record<string, unknown>,
    session: (data.session || {}) as Record<string, unknown>,
  };
}
