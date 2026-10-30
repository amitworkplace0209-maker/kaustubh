import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';
import { backendAuthJson, requireBackendSession } from '@/lib/auth-proxy';
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
 *   1. The live app session is verified FIRST against the VM1 backend (which
 *      owns the session rows), exactly like every other session-gated route.
 *      Unauthenticated callers get an honest 401 and NEVER touch the backend
 *      token endpoint — this stops the unauthenticated token spam on /login.
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
  const session = await requireBackendSession(req);
  if (!session.ok) return session.response;

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
    let jwt = await acquireOperatorJwt();

    // Vercel does not hold APP_PASSWORD: ask VM1 to mint the operator JWT from
    // the already-validated app session. Only fall through for an older
    // backend that predates /api/auth/operator-token.
    if (!jwt) {
      const minted = await backendAuthJson(req, '/api/auth/operator-token', { method: 'POST' });
      const mintedData = (minted.data ?? {}) as Record<string, unknown>;
      if (minted.ok && typeof mintedData.token === 'string' && mintedData.token) {
        jwt = mintedData.token;
      } else if (minted.response && minted.status !== 404 && minted.status !== 405) {
        return Response.json(
          mintedData.ok === false ? mintedData : { ok: false, error: 'OPERATOR_TOKEN_FAILED' },
          { status: minted.status },
        );
      }
    }

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
              'Backend realtime auth is enabled but VM1 could not mint an operator token for this session.',
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