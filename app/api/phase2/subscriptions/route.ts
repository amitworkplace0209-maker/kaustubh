import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Stock subscriptions for the Data Saver "Subscription Management" page.
 * GET pulls REAL subscribed stocks (with live market data, tick stats,
 * identity and websocket state); DELETE removes them (registry + WS).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || '';
  const [stocksRes, sysRes] = await Promise.all([
    backendFetch(`/api/stocks?active=false${q ? `&q=${encodeURIComponent(q)}` : ''}`, { timeoutMs: 8000 }),
    backendFetch('/api/system', { timeoutMs: 6000 }),
  ]);

  const stocks = stocksRes.data?.data ?? [];
  const sys: any = sysRes.data || {};
  const connected = Boolean(sys.websocketConnected);

  const subscriptions = stocks.map((s: any) => {
    const active = s.active !== false;
    const md = s.marketData ?? {};
    const identity = s.identity ?? {};
    const sub = s.subscription ?? {};
    const ws = s.websocket ?? {};
    const tstats = s.tickStats ?? {};
    return {
      symbol: s.symbol ?? '',
      exchange: String(s.exchangeSegment ?? 'nse_cm').toUpperCase().includes('BSE') ? 'BSE' : 'NSE',
      token: String(s.instrumentToken ?? ''),
      type: 'EQ',
      companyName: identity.companyName ?? 'Not available',
      tradingSymbol: identity.tradingSymbol ?? s.symbol ?? '',
      isin: identity.isin ?? 'Not available',
      status: active ? (sub.state ?? 'active') : 'inactive',
      requestStatus: sub.requestStatus ?? (active ? 'registered' : 'inactive'),
      subscribedAt: sub.subscribedAt ?? null,
      wsConnected: Boolean(connected),
      wsState: ws.lifecycleState ?? null,
      wsReason: ws.disconnectReason ?? (connected ? 'Connected' : 'WebSocket disconnected'),
      dataReceived: typeof tstats.tickCountToday === 'number' ? tstats.tickCountToday : null,
      tickCountToday: typeof tstats.tickCountToday === 'number' ? tstats.tickCountToday : 0,
      lastTick: md.lastTickAt ?? tstats.lastTickAt ?? null,
      ticksPerSec: typeof md.ticksPerSec === 'number' ? md.ticksPerSec : null,
      ltp: md.ltp ?? null,
      change: md.change ?? null,
      changePercent: md.changePercent ?? null,
      open: md.open ?? null,
      high: md.high ?? null,
      low: md.low ?? null,
      close: md.close ?? null,
      prevClose: md.prevClose ?? null,
      volume: md.volume ?? null,
      marketAvailable: Boolean(md.available),
      instrumentMasterAvailable: Boolean(s.instrumentMasterAvailable),
      market: s.market ?? null,
      selected: false,
    };
  });

  const market = sys.instrumentMasterState ?? null;
  return Response.json({
    subscriptions,
    websocket: { connected },
    instrumentMasterAvailable: sys.instrumentCacheLoaded ?? sys.instrumentMasterAvailable ?? false,
    instrumentMasterState: market,
    market: Array.isArray(subscriptions) && subscriptions[0]?.market ? subscriptions[0].market : null,
  });
}

/**
 * Unsubscribe a stock: remove it from the REAL stocks registry + Websocket.
 * DELETE /stocks/bulk handles a list in one call.
 */
export async function DELETE(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}

  const symbols: string[] = Array.isArray(body.symbols) && body.symbols.length
    ? body.symbols
    : (typeof body.symbol === 'string' && body.symbol ? [body.symbol] : []);

  if (!symbols.length) return NextResponse.json({ ok: false, error: 'No symbols provided' }, { status: 400 });

  const res = await backendFetch('/api/stocks/bulk', {
    method: 'DELETE',
    body: JSON.stringify({ symbols }),
    timeoutMs: 8000,
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.data?.detail ?? 'Backend error' }, { status: res.status || 400 });
  }
  return Response.json({ ok: true, deleted: res.data?.deleted ?? symbols.length });
}
