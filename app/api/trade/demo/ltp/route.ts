import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Dummy/paper LTP update proxy.
 * Forwards updateDemoLtp to `/api/demo/ltp` so live tape prices reach the
 * paper engine same-origin.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await backendFetch('/api/demo/ltp', {
    method: 'POST',
    body: body || undefined,
    timeoutMs: 15000,
  });
  if (!res.ok || res.data === undefined) {
    return Response.json(
      { error: res.error || 'Dummy LTP service unavailable', status: res.status },
      { status: res.status && res.status !== 0 ? res.status : 502 },
    );
  }
  return Response.json(res.data);
}