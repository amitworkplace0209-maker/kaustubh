import type { NextRequest } from 'next/server';
import { requireBackendSession } from '@/lib/auth-proxy';
import { fail, json, readJson } from '@/lib/auth-validation';
import { verifyAuthentication } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/biometric/auth/verify
 * Body: { response: AuthenticationResponseJSON }
 *
 * The assertion is verified here (Node keeps the WebAuthn crypto); the counter
 * update and audit event are persisted by the VM1 data plane.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBackendSession(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || !body.response || typeof body.response !== 'object') {
    return fail('Missing the WebAuthn authentication response.', 400);
  }

  const result = await verifyAuthentication({
    request,
    response: body.response as never,
  });

  if (!result.ok) return fail(result.message, 401, { code: 'BIOMETRIC_FAILED' });

  return json({ ok: true, unlocked: true, message: 'Unlocked with biometrics.' });
}
