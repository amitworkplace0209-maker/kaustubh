import type { NextRequest } from 'next/server';
import { backendAuthJson, requireBackendSession } from '@/lib/auth-proxy';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/auth/biometric/credentials — registered authenticators (no secrets). */
export async function GET(request: NextRequest) {
  const auth = await requireBackendSession(request);
  if (!auth.ok) return auth.response;

  const result = await backendAuthJson(request, '/api/auth/webauthn/credentials', { method: 'GET' });
  if (!result.response) return fail('The authentication service is unavailable.', 503);
  if (!result.ok) return fail('Could not load biometric credentials.', result.status);
  return json(result.data as Record<string, unknown>);
}

/**
 * DELETE /api/auth/biometric/credentials
 * Body/query: { credentialId }
 *
 * The last credential cannot be removed while no MPIN exists — otherwise the
 * owner would have no way back in. The VM1 data plane enforces that rule and
 * records the audit event.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireBackendSession(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const credentialId =
    String(body?.credentialId ?? '').trim() ||
    String(request.nextUrl.searchParams.get('credentialId') ?? '').trim();

  if (!credentialId) return fail('Specify credentialId.', 400);

  const result = await backendAuthJson(request, '/api/auth/webauthn/credentials/remove', {
    method: 'POST',
    body: JSON.stringify({ credentialId }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!result.response) return fail('The authentication service is unavailable.', 503);
  return json((result.data || { ok: false, message: 'Could not remove the credential.' }) as Record<string, unknown>, result.status);
}
