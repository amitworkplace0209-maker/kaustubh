import { NextRequest } from 'next/server';
import { verifySessionToken } from '@/lib/auth-crypto';
import { acquireOperatorJwt, operatorCredentials } from '@/lib/backend-operator';

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
 * Verifies the Next-layer `kaustubh_session` cookie (HMAC-signed, same check as
 * the proxy gate) and then returns the backend operator JWT that the Next layer
 * already obtains for server-side calls. The password (`APP_PASSWORD`) never
 * leaves the server; the browser only receives the short-lived JWT it was
 * previously expected to hold after typing the password itself.
 *
 * The token is served over same-origin fetch only (cookies are SameSite=Lax),
 * is used in memory (never localStorage), and the backend still enforces a
 * valid unexpired JWT on every mutation — this route grants nothing that the
 * signed-in operator could not already do from this browser.
 */
export async function GET(req: NextRequest) {
  if (!verifySessionToken(req.cookies.get('kaustubh_session')?.value)) {
    return Response.json(
      { ok: false, error: 'UNAUTHENTICATED', message: 'No valid app session — log in first.' },
      { status: 401 },
    );
  }

  if (!operatorCredentials()) {
    return Response.json(
      {
        ok: false,
        error: 'NO_OPERATOR_CREDENTIALS',
        message:
          'Backend trading auth is enabled but no operator credentials are configured on the app layer (APP_USERNAME / APP_PASSWORD).',
      },
      { status: 502 },
    );
  }

  const token = await acquireOperatorJwt();
  if (!token) {
    return Response.json(
      { ok: false, error: 'OPERATOR_LOGIN_FAILED', message: 'Backend operator login failed.' },
      { status: 502 },
    );
  }

  return Response.json({ ok: true, token });
}
