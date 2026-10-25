import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * WebSocket Monitor. Maps the REAL backend connection/buffer state onto the
 * monitor's data contract. Metrics the backend doesn't expose default to 0
 * (number-typed fields the page must render) but real values always win.
 */
export async function GET(req: NextRequest) {
  const res = await backendFetch('/api/system', { timeoutMs: 6000 });
  const sys: any = res.data || {};
  const wsDetail: any = sys.websocketDetail || {};
  const buffer: any = sys.buffer || {};
  const pythonStatus: any = sys.pythonStatus || {};

  const connected = Boolean(sys.websocketConnected);
  const connectionState = connected ? 'CONNECTED' : 'DISCONNECTED';

  const mapsPerSec = typeof buffer.mapsPerSec === 'number' ? buffer.mapsPerSec : 0;
  const ticksPerSec = typeof buffer.ticksPerSecond === 'number' ? buffer.ticksPerSecond : 0;
  const subscriptions: string[] = Array.isArray(wsDetail.subscribed_symbols)
    ? wsDetail.subscribed_symbols
    : (Array.isArray(sys.subscribed_symbols) ? sys.subscribed_symbols : []);
  const reconnectCount = typeof wsDetail.reconnect_count === 'number' ? wsDetail.reconnect_count : 0;
  const totalWriteErrors = typeof buffer.totalWriteErrors === 'number' ? buffer.totalWriteErrors : 0;
  const bufferLength = typeof buffer.bufferLength === 'number' ? buffer.bufferLength : 0;
  const droppedRecords = typeof buffer.dropped === 'number' ? buffer.dropped : (totalWriteErrors);

  const bufferCapacity = 10000;

  return Response.json({
    connectionState,
    currentConnection: connected ? 'Kotak Neo WebSocket' : null,
    // Same-origin by design: `server.mjs` tunnels `/ws/*` to the private
    // backend, so the browser never learns the backend host.
    apiEndpoint: `${req.nextUrl.protocol === 'https:' ? 'wss' : 'ws'}://${req.nextUrl.host}/ws/realtime`,
    sessionActive: Boolean(pythonStatus.session_active),
    heartbeat: null,
    latency: null,
    lastMessage: null,
    messagesPerSec: mapsPerSec || ticksPerSec || 0,
    reconnectCount,
    failedReconnectCount: 0,
    subscriptionCount: subscriptions.length,
    activeSubscriptions: typeof pythonStatus.subscribed_symbols === 'number' ? [] : subscriptions,
    droppedMessages: droppedRecords,
    processingQueue: bufferLength,
    bufferStatus: {
      size: bufferLength,
      capacity: bufferCapacity,
      utilization: bufferCapacity > 0 ? Math.min((bufferLength / bufferCapacity) * 100, 100) : 0,
      oldestRecord: buffer.oldestTs ?? null,
      newestRecord: buffer.lastWriteAt ?? null,
      flushStatus: totalWriteErrors > 0 ? 'error' : 'idle',
      droppedRecords,
    },
    errorCount: totalWriteErrors,
    logs: [],
    reconnectStrategy: {
      type: 'exponential',
      initialDelay: 1000,
      maxDelay: 60000,
      multiplier: 2,
      currentAttempt: 0,
      nextRetryIn: connected ? 0 : 10,
    },
  });
}
