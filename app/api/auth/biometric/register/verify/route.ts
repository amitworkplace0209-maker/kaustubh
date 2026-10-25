import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import {
  addCredential,
  getCredential,
  listCredentials,
  recordAuthEvent,
} from '@/lib/auth-db';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson, safeDeviceLabel } from '@/lib/auth-validation';
import { verifyRegistration } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/biometric/register/verify
 * Body: { response: RegistrationResponseJSON, deviceLabel?: string }
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request, { requireMpin: true });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || !body.response || typeof body.response !== 'object') {
    return fail('Missing the WebAuthn registration response.', 400);
  }

  try {
    const result = await verifyRegistration({
      request,
      response: body.response as never,
    });
    if (!result.ok) return fail(result.message, 400, { code: 'WEBAUTHN_VERIFY_FAILED' });

    const existing = await getCredential(result.credentialId);
    if (existing) {
      return json({ ok: true, alreadyRegistered: true, message: 'This biometric is already registered.' });
    }

    const deviceLabel = safeDeviceLabel(
      body.deviceLabel,
      auth.session.deviceLabel || 'This device',
    );
    await addCredential({
      credentialId: result.credentialId,
      userId: String(auth.user._id),
      publicKey: result.publicKey,
      counter: result.counter,
      transports: result.transports,
      deviceLabel,
      createdAt: new Date(),
      lastUsedAt: null,
    });

    await recordAuthEvent({
      type: 'biometric_registered',
      userId: String(auth.user._id),
      ip: getClientIp(request) || 'unknown',
      userAgent: request.headers.get('user-agent') || 'unknown',
      deviceId: auth.session.deviceId,
      deviceLabel,
      sessionId: auth.session.sessionId,
      success: true,
      detail: 'WebAuthn credential registered',
    });

    const credentials = await listCredentials(String(auth.user._id));
    return json({
      ok: true,
      registered: true,
      credentialId: result.credentialId,
      biometricCount: credentials.length,
      message: 'Fingerprint / face unlock is now registered.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not save the biometric credential.', 500);
  }
}
