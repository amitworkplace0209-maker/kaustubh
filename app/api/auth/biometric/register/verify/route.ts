import type { NextRequest } from 'next/server';
import { backendAuthJson, requireBackendSession } from '@/lib/auth-proxy';
import { fail, json, readJson, safeDeviceLabel } from '@/lib/auth-validation';
import { verifyRegistration } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/biometric/register/verify
 * Body: { response: RegistrationResponseJSON, deviceLabel?: string }
 *
 * The attestation is verified here (Node keeps the WebAuthn crypto); the public
 * key + device label are persisted by the VM1 data plane, which also records
 * the audit event.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBackendSession(request, { requireMpin: true });
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

    const deviceLabel = safeDeviceLabel(
      body.deviceLabel,
      (auth.session.deviceLabel as string) || 'This device',
    );

    const stored = await backendAuthJson(request, '/api/auth/webauthn/credentials', {
      method: 'POST',
      body: JSON.stringify({
        credentialId: result.credentialId,
        publicKey: result.publicKey,
        counter: result.counter,
        transports: result.transports,
        deviceLabel,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!stored.response) return fail('The authentication service is unavailable.', 503);
    if (!stored.ok) {
      return fail('Could not save the biometric credential.', stored.status || 500);
    }
    return json(stored.data as Record<string, unknown>, stored.status);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not save the biometric credential.', 500);
  }
}
