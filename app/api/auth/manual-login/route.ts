import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';
import { requireBackendSession } from '@/lib/auth-proxy';

export const revalidate = 0;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/manual-login — legacy bridge to the Python backend operator
 * login. It used to be callable by anyone, which exposed the backend. It is now
 * gated on a live owner session with MPIN/biometric setup completed.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBackendSession(request, { requireMpin: true });
  if (!auth.ok) return auth.response;

  const res = await backendFetch('/api/login', {
    method: 'POST',
    timeoutMs: 30000,
  });
  if (!res.ok && res.data === null) {
    return Response.json(
      { ok: false, message: res.error || 'Login failed' },
      { status: 502 },
    );
  }
  return Response.json(res.data || { ok: false, message: 'Login failed' });
}

/** Legacy logout bridge. */
export async function DELETE(request: NextRequest) {
  const auth = await requireBackendSession(request);
  if (!auth.ok) return auth.response;

  const res = await backendFetch('/api/logout', {
    method: 'POST',
    timeoutMs: 30000,
  });
  return Response.json(res.data || { ok: true, message: 'Logged out' });
}
