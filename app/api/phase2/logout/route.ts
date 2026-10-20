import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Proxies a real logout to the Python backend (POST /api/logout). */
export async function POST(_req: NextRequest) {
  const res = await backendFetch('/api/logout', {
    method: 'POST',
    timeoutMs: 30000,
  });
  if (!res.ok && res.data === null) {
    return new Response(
      JSON.stringify({ ok: false, message: res.error || 'Logout failed' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return Response.json(res.data || { ok: false, message: 'Logout failed' });
}
