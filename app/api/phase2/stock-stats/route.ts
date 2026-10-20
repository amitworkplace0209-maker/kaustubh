import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Aggregate subscription + WebSocket + tick statistics for the Data Saver
 * Subscription page summary cards.
 */
export async function GET(_req: NextRequest) {
  const res = await backendFetch('/api/stocks/stats', { timeoutMs: 8000 });
  if (!res.ok) {
    return Response.json(
      { ok: false, error: res.data?.detail ?? res.error ?? 'Stats unavailable' },
      { status: res.status || 502 },
    );
  }
  return Response.json({ ok: true, ...res.data });
}
