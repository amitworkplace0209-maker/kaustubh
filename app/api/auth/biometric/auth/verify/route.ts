import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import { recordAuthEvent } from '@/lib/auth-db';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';
import { verifyAuthentication } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/auth/biometric/auth/verify — Body: { response: AuthenticationResponseJSON } */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || !body.response || typeof body.response !== 'object') {
    return fail('Missing the WebAuthn authentication response.', 400);
  }

  const result = await verifyAuthentication({
    request,
    response: body.response as never,
  });

  await recordAuthEvent({
    type: result.ok ? 'biometric_login' : 'biometric_failed',
    userId: String(auth.user._id),
    ip: getClientIp(request) || 'unknown',
    userAgent: request.headers.get('user-agent') || 'unknown',
    deviceId: auth.session.deviceId,
    deviceLabel: auth.session.deviceLabel,
    sessionId: auth.session.sessionId,
    success: result.ok,
    detail: result.ok ? 'App unlocked with biometrics' : result.message,
  }).catch(() => {});

  if (!result.ok) return fail(result.message, 401, { code: 'BIOMETRIC_FAILED' });

  return json({ ok: true, unlocked: true, message: 'Unlocked with biometrics.' });
}
