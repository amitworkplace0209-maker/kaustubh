import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Full structured details for one subscription (identity + market data +
 * subscription state + websocket state + data-quality timeline).
 */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') || '').trim();
  const token = (req.nextUrl.searchParams.get('token') || '').trim();
  if (!symbol && !token) {
    return NextResponse.json({ ok: false, error: 'symbol or token is required' }, { status: 400 });
  }
  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  if (token) params.set('token', token);
  const res = await backendFetch(`/api/stocks/details?${params.toString()}`, { timeoutMs: 8000 });
  if (!res.ok) {
    const detail = res.data?.detail as any;
    return NextResponse.json(
      {
        ok: false,
        reason: detail?.reason ?? (typeof res.data?.detail === 'string' ? res.data.detail : res.error ?? 'Details unavailable'),
        subscribed: detail?.subscribed ?? false,
      },
      { status: res.status || 502 },
    );
  }
  return Response.json({ ok: true, ...res.data });
}
