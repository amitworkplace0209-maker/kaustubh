import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Proxies a manual login to the Python backend (POST /api/login). */
export async function POST(_req: NextRequest) {
  const res = await backendFetch('/api/login', {
    method: 'POST',
    timeoutMs: 30000,
  });
  if (!res.ok && res.data === null) {
    return new Response(
      JSON.stringify({ ok: false, message: res.error || 'Login failed' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return Response.json(res.data || { ok: false, message: 'Login failed' });
}

/** Handles logout by proxying to the Python backend and clearing the
 *  kaustubh_session cookie so the frontend session state resets. */
export async function DELETE() {
  const res = await backendFetch('/api/logout', {
    method: 'POST',
    timeoutMs: 30000,
  });
  return Response.json(res.data || { ok: true, message: 'Logged out' });
}
