import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Dummy/paper positions proxy.
 * Forwards getDemoPositions to the open `/api/demo/positions` engine
 * same-origin (5-second poll from the trade page order card).
 */
export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const res = await backendFetch(`/api/demo/positions${qs ? `?${qs}` : ''}`, { timeoutMs: 15000 });
  if (!res.ok || res.data === undefined) {
    return Response.json(
      { error: res.error || 'Dummy positions service unavailable', status: res.status },
      { status: res.status && res.status !== 0 ? res.status : 502 },
    );
  }
  return Response.json(res.data);
}