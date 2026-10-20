import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Thin proxy over the REAL backend /api/system. Surfaces the scheduler,
 * session, websocket, buffer and mongo state that the Data Saver topbar,
 * dashboard and the downloads Data Center page consume. No fabricated values —
 * every field maps 1:1 to the live Python backend.
 *
 * Fields are additive on purpose: consumers read only what they need and a
 * missing measurement comes back as null, never a made-up number.
 */
export async function GET(_req: NextRequest) {
  const res = await backendFetch('/api/system', { timeoutMs: 6000 });
  const sys: any = res.data || {};

  const python: any = sys.pythonStatus || {};
  const sched: any = sys.schedulerInfo || {};
  const schedState: any = sys.schedulerState || {};
  const schedInfo: any = sys.schedulerInfo || {};
  const buffer: any = sys.buffer || {};
  const mongoState: any = sys.mongo || {};
  const node: any = sys.node || {};
  const wsDetail: any = sys.websocketDetail || {};

  const schedulerState = String(
    schedState.state ?? schedState.status ?? 'UNKNOWN',
  ).toUpperCase();

  const marketStatus = String(
    sched.market_status ?? sched.marketSession ?? schedInfo.market_status ?? '',
  ).toUpperCase();

  return Response.json({
    connected: Boolean(sys.websocketConnected),
    internetConnected: Boolean(sys.internetConnected),
    feedLatencyMs:
      typeof sys.feedLatencyMs === 'number' ? sys.feedLatencyMs : null,
    generatedAt: sys.generatedAt ?? new Date().toISOString(),
    activeStocks: typeof sys.activeStocks === 'number' ? sys.activeStocks : null,
    totalStocks: typeof sys.totalStocks === 'number' ? sys.totalStocks : null,
    todayRecords: typeof sys.todayRecords === 'number' ? sys.todayRecords : null,
    todayInserts: typeof sys.todayInserts === 'number' ? sys.todayInserts : null,
    errorCount: typeof sys.errorCount === 'number' ? sys.errorCount : null,
    liveData:
      typeof sys.liveData === 'object' && sys.liveData
        ? {
            ticksPerSecond:
              typeof sys.liveData.ticksPerSecond === 'number' ? sys.liveData.ticksPerSecond : null,
            lastTickAt:
              typeof sys.liveData.lastTickAt === 'number' ? sys.liveData.lastTickAt : null,
            activeTickStocks:
              typeof sys.liveData.activeTickStocks === 'number' ? sys.liveData.activeTickStocks : null,
          }
        : null,
    market: {
      status: marketStatus,
      session: sched.market_session ?? sched.marketStatus ?? null,
      tradingDay: Boolean(sched.is_trading_day ?? schedInfo.is_trading_day),
    },
    mongo: {
      connected: Boolean(mongoState.connected ?? sys.mongo_connected),
    },
    buffer: {
      bufferLength:
        typeof buffer.bufferLength === 'number' ? buffer.bufferLength : null,
      bufferMaxSize:
        typeof buffer.bufferMaxSize === 'number' ? buffer.bufferMaxSize : null,
      mapsPerSec:
        typeof buffer.mapsPerSec === 'number' ? buffer.mapsPerSec : null,
      ticksPerSecond:
        typeof buffer.ticksPerSecond === 'number' ? buffer.ticksPerSecond : null,
      writesPerSecond:
        typeof buffer.writesPerSecond === 'number' ? buffer.writesPerSecond : null,
      tickRateTrend:
        typeof buffer.tickRateTrend === 'string' ? buffer.tickRateTrend : null,
      rollingWindowSec:
        typeof buffer.rollingWindowSec === 'number' ? buffer.rollingWindowSec : null,
      activeTickStocks:
        typeof buffer.activeTickStocks === 'number' ? buffer.activeTickStocks : null,
      lastTickAt:
        typeof buffer.lastTickAt === 'number' ? buffer.lastTickAt : null,
    },
    node: {
      status: typeof node.status === 'string' ? node.status : null,
      diskTotalBytes: typeof node.diskTotalBytes === 'number' ? node.diskTotalBytes : null,
      diskUsedBytes: typeof node.diskUsedBytes === 'number' ? node.diskUsedBytes : null,
      diskPercent: typeof node.diskPercent === 'number' ? node.diskPercent : null,
    },
    websocketDetail: {
      connected: Boolean(wsDetail.connected ?? sys.websocketConnected),
      subscribed_symbols:
        typeof wsDetail.subscribed_symbols === 'number' ? wsDetail.subscribed_symbols : null,
      disconnect_reason: wsDetail.disconnect_reason ?? sys.wsDisconnectReason ?? null,
      connected_at: wsDetail.connected_at ?? null,
    },
    session: {
      active: Boolean(python.session_active),
      loggedIn: Boolean(python.logged_in ?? python.session_active),
    },
    scheduler: {
      running: Boolean(
        sched.running ?? schedState.running ?? schedInfo.running ?? false,
      ),
      state: schedulerState,
      lastRun: schedState.last_run ?? schedInfo.last_run ?? null,
      nextRun: schedState.next_run ?? schedInfo.next_run ?? null,
      tickCount:
        typeof schedState.ticks_processed === 'number'
          ? schedState.ticks_processed
          : typeof schedInfo.ticks_processed === 'number'
            ? schedInfo.ticks_processed
            : null,
    },
  });
}