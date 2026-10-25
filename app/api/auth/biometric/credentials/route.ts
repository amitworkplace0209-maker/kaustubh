import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import { listCredentials, recordAuthEvent, removeCredential } from '@/lib/auth-db';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/auth/biometric/credentials — registered authenticators (no secrets). */
export async function GET(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  try {
    const credentials = await listCredentials(String(auth.user._id));
    return json({
      ok: true,
      hasMpin: Boolean(auth.user.mpinHash),
      biometricCount: credentials.length,
      credentials: credentials.map((cred) => ({
        id: cred.credentialId,
        deviceLabel: cred.deviceLabel,
        transports: cred.transports ?? [],
        createdAt: cred.createdAt.toISOString(),
        lastUsedAt: cred.lastUsedAt ? cred.lastUsedAt.toISOString() : null,
      })),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The auth database is unavailable.', 503);
  }
}

/**
 * DELETE /api/auth/biometric/credentials
 * Body/query: { credentialId }
 *
 * The last credential cannot be removed while no MPIN exists — otherwise the
 * owner would have no way back in.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const credentialId =
    String(body?.credentialId ?? '').trim() ||
    String(request.nextUrl.searchParams.get('credentialId') ?? '').trim();

  if (!credentialId) return fail('Specify credentialId.', 400);

  try {
    const credentials = await listCredentials(String(auth.user._id));
    const target = credentials.find((cred) => cred.credentialId === credentialId);
    if (!target) return fail('That biometric credential was not found.', 404);
    if (credentials.length <= 1 && !auth.user.mpinHash) {
      return fail(
        'This is your only unlock method. Set an MPIN before removing it.',
        409,
        { code: 'LAST_UNLOCK_METHOD' },
      );
    }

    const removed = await removeCredential(credentialId, String(auth.user._id));
    await recordAuthEvent({
      type: 'biometric_removed',
      userId: String(auth.user._id),
      ip: getClientIp(request) || 'unknown',
      userAgent: request.headers.get('user-agent') || 'unknown',
      deviceId: auth.session.deviceId,
      deviceLabel: target.deviceLabel,
      sessionId: auth.session.sessionId,
      success: removed,
      detail: removed ? 'WebAuthn credential removed' : 'Credential not found',
    }).catch(() => {});

    const remaining = await listCredentials(String(auth.user._id));
    return json({
      ok: removed,
      removed,
      biometricCount: remaining.length,
      message: removed ? 'Biometric credential removed.' : 'That credential was already removed.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not remove the credential.', 500);
  }
}
