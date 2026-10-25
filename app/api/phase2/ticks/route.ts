import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function isoTime(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  return null;
}

function isoFromAny(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string' && v) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  return null;
}

function seg(v: unknown): string {
  const s = String(v ?? '');
  return s.toUpperCase().includes('BSE') ? 'BSE' : 'NSE';
}

function instType(v: unknown): string {
  const s = String(v ?? '');
  if (s) return s;
  return 'EQ';
}

/**
 * Live Tick Monitor — enhanced endpoint.
 * Fetches REAL ticks from the backend plus REAL stock/subscription context.
 * Every value is derived from the actual backend state.
 */
export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit') || '200') || 200, 1), 200);
  const symbol = req.nextUrl.searchParams.get('symbol') || '';

  // Use the lightweight /api/ticks/stats (in-memory buffer + websocket +
  // scheduler context) instead of building the full /api/system snapshot
  // (which can block on broker calls and heavy MongoDB scanning). This keeps
  // the tick feed fast while staying fully derived from real backend state.
  const [ticksRes, stocksRes, wsStatusRes] = await Promise.all([
    backendFetch(`/api/ticks/recent?limit=${limit}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`, { timeoutMs: 8000 }),
    backendFetch('/api/stocks', { timeoutMs: 8000 }),
    backendFetch('/api/ticks/stats', { timeoutMs: 4000 }),
  ]);

  const rawTicks: any[] = ticksRes.data?.data ?? [];
  const rawStocks: any[] = stocksRes.data?.data ?? [];
  const wsStatus: any = wsStatusRes.data || {};
  const wsConnected = Boolean(wsStatus.connected ?? wsStatus.state === 'CONNECTED');

  const marketSnap: any = wsStatus.marketState ?? {};
  const schedulerState: string = wsStatus.schedulerState ?? 'UNKNOWN';
  const marketSession: string = marketSnap.market_session ?? '';
  const marketStatus: string = marketSnap.market_status ?? '';
  const isTradingDay = Boolean(marketSnap.trading_day ?? marketSnap.isTradingDay);
  // Use the backend's authoritative pipeline and feed state
  const pipelineState: string = wsStatus.pipelineState ?? 'STOPPED';
  const feedState: string = wsStatus.feedState ?? 'NO_FEED';
  const diagnostics: any = wsStatus.diagnostics ?? {};
  const marketClosed = marketStatus === 'CLOSED' || (!wsConnected && rawTicks.length === 0);

  const bufferStats: any = wsStatus.bufferStatus ?? {};
  const liveData: any = wsStatus.liveData ?? {};

  const tickStats = {
    ticksPerSecond: num(liveData.ticksPerSecond) ?? num(bufferStats.ticksPerSecond) ?? 0,
    activeTickStocks: num(liveData.activeTickStocks) ?? num(bufferStats.activeTickStocks) ?? 0,
    totalReceived: num(bufferStats.totalReceived) ?? 0,
    totalWritten: num(bufferStats.totalWritten) ?? 0,
    totalWriteErrors: num(bufferStats.totalWriteErrors) ?? 0,
    lastTickAt: isoFromAny(bufferStats.lastTickAt) ?? isoFromAny(liveData.lastTickAt),
    lastWriteAt: isoFromAny(bufferStats.lastWriteAt) ?? isoFromAny(liveData.lastWriteAt),
    pipelineRunning: Boolean(bufferStats.pipelineRunning),
    feedLatencyMs: num(bufferStats.feedLatencyMs?.currentMs),
    pipelineState,
    feedState,
  };

  const stockMap = new Map<string, any>();
  for (const s of rawStocks) {
    const sym = String(s.symbol ?? '').toUpperCase();
    if (sym) stockMap.set(sym, s);
  }

  const enrichedTicks = rawTicks.map((t: any) => {
    const ltp = num(t.ltp);
    const prevClose = num(t.close);
    const change = num(t.change);
    const changePct = num(t.changePercent);
    const open = num(t.open);
    const high = num(t.high);
    const low = num(t.low);

    const symbol = str(t.symbol) ?? '';
    const stock = stockMap.get(symbol.toUpperCase()) ?? null;

    const subscription: any = stock?.subscription ?? null;
    const wsStock: any = stock?.websocket ?? null;
    const identity: any = stock?.identity ?? null;
    const tickStatsStock: any = stock?.tickStats ?? null;

    return {
      symbol,
      tradingSymbol: str(t.tradingSymbol) ?? symbol,
      token: String(t.instrumentToken ?? ''),
      exchange: seg(t.exchangeSegment),
      exchangeSegment: str(t.exchangeSegment) ?? 'nse_cm',
      instrumentType: instType(identity?.instrumentType) ?? 'EQ',
      companyName: str(identity?.companyName),

      ltp,
      open,
      high,
      low,
      prevClose,
      change,
      changePct,
      volume: num(t.volume),
      ltq: num(t.ltq),

      bid: num(t.bp),
      bidQty: num(t.bq),
      ask: num(t.sp),
      askQty: num(t.bs),
      tbq: num(t.tbq),
      tsq: num(t.tsq),

      feedLevel: num(t.feed_level ?? t.level),
      feedType: str(t.feed_type ?? t.message_type),
      depth: Array.isArray(t.buy) || Array.isArray(t.sell)
        ? { buy: Array.isArray(t.buy) ? t.buy : [], sell: Array.isArray(t.sell) ? t.sell : [] }
        : undefined,

      avgPrice: num(t.averagePrice),
      oi: num(t.oi),

      ts: isoTime(t.ts ?? t.timestamp),
      receivedAt: isoTime(t.receivedAt),

      subscribed: subscription?.subscribed ?? false,
      subscriptionState: str(subscription?.state) ?? (subscription?.subscribed ? 'ACTIVE' : 'NOT_SUBSCRIBED'),
      subscriptionReason: str(subscription?.reason),
      requestStatus: str(subscription?.requestStatus),

      wsSubscribed: wsStock?.subscribed ?? false,
      wsConnected: wsStock?.connected ?? false,
      wsLifecycleState: str(wsStock?.lifecycleState),
      wsReason: str(wsStock?.reason),

      tickCountToday: num(tickStatsStock?.tickCountToday) ?? 0,
      firstTickAt: isoFromAny(tickStatsStock?.firstTickAt),

      isIndex: stock?.isIndex ?? false,
      active: stock?.active ?? true,
    };
  });

  return Response.json({
    ticks: enrichedTicks,
    wsConnected,
    marketClosed,
    marketSession,
    marketStatus,
    isTradingDay,
    schedulerState,
    tickStats,
    pipelineState,
    feedState,
    diagnostics,
  });
}
