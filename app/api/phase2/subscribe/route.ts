import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Subscribe to an NSE EQ instrument (validated + persisted + WebSocket).
 * Proxies to the backend which handles validation, persistence and applying
 * the subscription to the live feed. Returns the real outcome + reason.
 */
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}

  const symbol = String(body.symbol ?? '').trim();
  const instrumentToken = String(body.instrumentToken ?? '').trim();
  if (!symbol && !instrumentToken) {
    return NextResponse.json(
      { ok: false, error: 'A symbol or instrument token is required.' },
      { status: 400 },
    );
  }

  const res = await backendFetch('/api/stocks/subscribe', {
    method: 'POST',
    body: JSON.stringify({ symbol, instrumentToken, exchangeSegment: body.exchangeSegment ?? 'nse_cm' }),
    timeoutMs: 10000,
  });
  if (!res.ok) {
    const detail = res.data?.detail as any;
    return NextResponse.json(
      {
        ok: false,
        error: detail?.reason ?? res.data?.reason ?? (typeof res.data?.detail === 'string' ? res.data.detail : res.error ?? 'Subscribe failed'),
        action: detail?.action ?? 'subscribe',
        status: detail?.status ?? 'rejected',
      },
      { status: res.status || 502 },
    );
  }
  return Response.json({ ok: true, ...res.data });
}
