import { NextRequest } from 'next/server';
import { backendAuthJson, requireBackendSession } from '@/lib/auth-proxy';
import { acquireOperatorJwt } from '@/lib/backend-operator';

export const revalidate = 0;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Trading JWT handoff — makes the trade page work without re-typing the
 * backend password on every reload.
 *
 * WHY THIS EXISTS
 * The broker surface (`/api/terminal/connect|order|modify|cancel|…`) is
 * JWT-gated and `lib/terminal-service` keeps that JWT in browser memory ONLY.
 * Without a UI that mints it, every non-Dummy terminal rendered "No session" +
 * "RISK LOCKED" after a fresh load and no order could ever be placed — the
 * sign-in card existed but was never mounted anywhere in the app.
 *
 * WHAT IT DOES
 * Requires a live app session on VM1 (signature AND session row, with MPIN or
 * biometric setup completed) and then asks VM1 to mint the backend operator JWT
 * for that session. VM1 owns the signing secret, so Vercel does NOT need a copy
 * of APP_PASSWORD. The older `acquireOperatorJwt()` path remains only as a
 * rollout fallback for a backend that does not yet expose
 * `/api/auth/operator-token`.
 *
 * The token is served over same-origin fetch only (cookies are SameSite=Lax),
 * is used in memory (never localStorage), and the backend still enforces a
 * valid unexpired JWT on every mutation — this route grants nothing that the
 * signed-in operator could not already do from this browser.
 */
export async function GET(request: NextRequest) {
  const auth = await requireBackendSession(request, { requireMpin: true });
  if (!auth.ok) return auth.response;

  const minted = await backendAuthJson(request, '/api/auth/operator-token', { method: 'POST' });
  const mintedData = (minted.data ?? {}) as Record<string, unknown>;
  const mintedToken = typeof mintedData.token === 'string' ? mintedData.token : '';

  if (minted.ok && mintedToken) {
    return Response.json({ ok: true, token: mintedToken });
  }

  // Only fall back for an older backend without the endpoint. Any other
  // failure is real and must not be hidden behind a duplicate credential path.
  if (minted.response && minted.status !== 404 && minted.status !== 405) {
    return Response.json(
      mintedData.ok === false ? mintedData : { ok: false, error: 'OPERATOR_TOKEN_FAILED' },
      { status: minted.status },
    );
  }

  const token = await acquireOperatorJwt();
  if (!token) {
    return Response.json(
      {
        ok: false,
        error: 'OPERATOR_TOKEN_UNAVAILABLE',
        message:
          'VM1 could not mint a trading token for this session and no operator credentials are configured on the app layer.',
      },
      { status: 502 },
    );
  }

  return Response.json({ ok: true, token });
}
