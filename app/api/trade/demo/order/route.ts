import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Dummy/paper order placement proxy.
 * Forwards the browser's placeDemoOrder to the open `/api/demo/order/place`
 * engine same-origin (no fragile cross-origin loopback fetch).
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await backendFetch('/api/demo/order/place', {
    method: 'POST',
    body: body || undefined,
    timeoutMs: 20000,
  });
  if (!res.ok || res.data === undefined) {
    return Response.json(
      { error: res.error || 'Dummy order service unavailable', status: res.status },
      { status: res.status && res.status !== 0 ? res.status : 502 },
    );
  }
  return Response.json(res.data);
}