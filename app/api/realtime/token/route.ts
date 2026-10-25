import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';
import { verifySessionToken } from '@/lib/auth-crypto';
import { acquireOperatorJwt } from '@/lib/backend-operator';

export const revalidate = 0;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Realtime gateway token proxy.
 *
 * Frontend WebSocket clients cannot set HTTP headers, so the gateway token is
 * handed out REST-first and passed as `?token=` on the WebSocket URL.
 *
 * Auth model:
 *   1. The Next-layer session cookie (`kaustubh_session`) is verified FIRST via
 *      the HMAC signature minted by `lib/auth-crypto`. Unauthenticated callers
 *      get an honest 401 and NEVER touch the backend — this stops the
 *      unauthenticated token spam on /login.
 *   2. When the caller already holds an operator JWT (Authorization /
 *      x-kaustubh-token) it is forwarded unchanged.
 *   3. Otherwise the Next layer obtains an operator JWT from the backend
 *      (`APP_USERNAME` / `APP_PASSWORD`, cached for the JWT lifetime — see
 *      `lib/backend-operator`) and uses it. In insecure/local mode (no backend
 *      password configured) the request is proxied anonymously and the backend
 *      issues an anonymous token.
 *   4. If the backend is in secure mode and the Next layer has no operator
 *      credentials, the proxy responds 502 with a clear configuration message
 *      instead of leaking a backend 401 to the unauthenticated UI loop.
 *
 * The operator credentials below are read from the app process environment
 * first and only then from the backend's own env file on the same machine, so
 * the backend keeps a single source of truth for its password instead of
 * duplicating the secret into a second file. They are used server-side only,
 * never returned to the client and never logged.
 */
export async function GET(req: NextRequest) {
  if (!verifySessionToken(req.cookies.get('kaustubh_session')?.value)) {
    return Response.json(
      {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'No valid app session — log in first.',
      },
      { status: 401 },
    );
  }

  const auth = req.headers.get('authorization');
  const xtoken = req.headers.get('x-kaustubh-token');
  const username = new URL(req.url).searchParams.get('username') ?? '';
  const qs = username ? `?username=${encodeURIComponent(username)}` : '';

  const headers: Record<string, string> = {};
  if (auth) {
    headers.authorization = auth;
  } else if (xtoken) {
    headers['x-kaustubh-token'] = xtoken;
  } else {
    const jwt = await acquireOperatorJwt();
    if (jwt) {
      headers.authorization = `Bearer ${jwt}`;
    } else {
      const res = await backendFetch(`/api/realtime/token${qs}`, { timeoutMs: 8000 });
      if (res.status === 401 && res.data?.ok === false) {
        return Response.json(
          {
            ok: false,
            error: 'BACKEND_SECURE_NO_CREDS',
            message:
              'Backend realtime auth is enabled but no operator credentials are configured on the app layer (APP_USERNAME / APP_PASSWORD).',
          },
          { status: 502 },
        );
      }
      return Response.json(
        res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
        { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
      );
    }
  }

  const res = await backendFetch(`/api/realtime/token${qs}`, {
    headers,
    timeoutMs: 8000,
  });

  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}