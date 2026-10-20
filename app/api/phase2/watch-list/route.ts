import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Data Saver Watch List (/data-saver/watch-list).
 * GET returns the persisted Watch List with real live merged market data.
 * POST adds a real NSE EQ stock (validated + persisted + WS subscribe).
 */
export async function GET() {
  const res = await backendFetch('/api/watch-list', { timeoutMs: 8000 });
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, data: [], error: res.data?.reason ?? res.error ?? 'Watch List unavailable' },
      { status: res.status || 502 },
    );
  }
  const d: any = res.data || {};
  const items = (d.data ?? []).map((i: any) => {
    const md = i.marketData ?? {};
    return {
      watchlistId: i.watchlistId ?? null,
      symbol: i.symbol ?? '',
      tradingSymbol: i.tradingSymbol ?? i.symbol ?? '',
      companyName: i.companyName ?? null,
      instrumentToken: String(i.instrumentToken ?? ''),
      exchange: i.exchange ?? 'NSE',
      exchangeSegment: i.exchangeSegment ?? 'nse_cm',
      isin: i.isin ?? null,
      createdAt: i.createdAt ?? null,
      updatedAt: i.updatedAt ?? null,
      marketData: {
        ltp: num(md.ltp),
        change: num(md.change),
        changePct: num(md.changePct),
        prevClose: num(md.prevClose),
        open: num(md.open),
        high: num(md.high),
        low: num(md.low),
        volume: num(md.volume),
        bid: num(md.bid),
        ask: num(md.ask),
        lastTickAt: md.lastTickAt ?? null,
        tickAgeSec: num(md.tickAgeSec),
        available: Boolean(md.available),
        momentum: md.momentum && typeof md.momentum === 'object'
          ? Object.fromEntries(Object.entries(md.momentum).map(([k, v]) => [k, num(v)]))
          : {},
      },
    };
  });
  return Response.json({ ok: true, data: items, session: d.session ?? null });
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const res = await backendFetch('/api/watch-list', {
    method: 'POST',
    body: JSON.stringify({
      symbol: body.symbol ?? '',
      instrumentToken: body.instrumentToken ?? '',
      exchangeSegment: body.exchangeSegment ?? 'nse_cm',
      isin: body.isin ?? null,
      companyName: body.companyName ?? null,
      tradingSymbol: body.tradingSymbol ?? null,
    }),
    timeoutMs: 8000,
  });
  if (!res.ok) {
    const detail = res.data?.detail as any;
    return NextResponse.json(
      { ok: false, error: detail?.reason ?? res.data?.reason ?? res.error ?? 'Add failed' },
      { status: res.status || 400 },
    );
  }
  const d: any = res.data || {};
  return Response.json({ ok: true, status: d.status ?? 'added', reason: d.reason ?? null, data: d.data ?? null });
}

export async function DELETE(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token') || '';
  if (!token) {
    return NextResponse.json({ ok: false, error: 'Token is required' }, { status: 400 });
  }
  const res = await backendFetch(`/api/watch-list/${encodeURIComponent(token)}`, {
    method: 'DELETE',
    timeoutMs: 6000,
  });
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: res.data?.detail ?? res.error ?? 'Remove failed' },
      { status: res.status || 502 },
    );
  }
  return Response.json({ ok: true, ...(res.data ?? {}) });
}
