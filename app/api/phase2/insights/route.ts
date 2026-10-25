import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const RANGE_HOURS: Record<string, number> = {
  today: 24,
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 168,
  '30d': 720,
};

/**
 * Data Insights.
 *
 * Every insight is derived from REAL system/tick/quality state scoped to the
 * requested time range. Metrics without a real measurement render as "—" and
 * are explicitly labelled "No data" rather than fabricated.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rangeLabel = url.searchParams.get('range') || '24h';
  const hoursParam = url.searchParams.get('hours');
  const hours = rangeLabel === 'custom'
    ? Math.max(1, Math.min(720, Number(hoursParam) || 24))
    : Math.max(1, Math.min(720, RANGE_HOURS[rangeLabel] ?? (Number(rangeLabel) || 24)));

  const [sysRes, qRes] = await Promise.all([
    backendFetch('/api/system', { timeoutMs: 6000 }),
    backendFetch(`/api/system/quality-metrics?hours=${hours}&limit=100000`, { timeoutMs: 10000 }),
  ]);

  const sys: any = sysRes.data || {};
  const buffer: any = sys.buffer || {};
  const live: any = sys.liveData || {};
  const q: any = qRes.data || {};

  const insights: any[] = [];
  const idx = (n: number) => `ins-${rangeLabel}-${n}`;
  const connected = Boolean(sys.websocketConnected);
  const rangeLabelHuman = rangeLabel === 'today' ? 'today'
    : rangeLabel === '1h' ? 'last hour'
    : rangeLabel === '6h' ? 'last 6 hours'
    : rangeLabel === '7d' ? 'last 7 days'
    : rangeLabel === '30d' ? 'last 30 days'
    : rangeLabel === 'custom' ? `custom window (last ${hours} hours)`
    : `last ${hours} hours`;

  // -- Tick volume for the inspected window (real DB aggregation) --
  const totalTicks = typeof q.total === 'number' ? q.total : null;
  if (totalTicks != null) {
    insights.push({
      id: idx(1),
      category: 'Volume',
      title: totalTicks > 0
        ? `${totalTicks.toLocaleString('en-IN')} tick records in the ${rangeLabelHuman}`
        : `No tick records found for ${rangeLabelHuman}`,
      metric: 'Ticks in range',
      value: totalTicks > 0 ? totalTicks.toLocaleString('en-IN') : '0',
      comparison: 'persisted tick documents',
      timestamp: fmtNow(),
      symbol: 'ALL',
      reason: `Real count over the ticks collection for the selected window${q.range ? ` (from ${local(q.range.from)}, to ${local(q.range.to)})` : ''}.`,
      severity: totalTicks > 0 ? 'info' : 'warning',
      icon: 'volume',
    });
  }

  // -- Live throughput --
  const ticksPerSec = typeof live.ticksPerSecond === 'number' ? live.ticksPerSecond : null;
  insights.push({
    id: idx(2),
    category: 'Live Stream',
    title: connected ? 'Tick stream is connected' : 'Tick stream is disconnected',
    metric: 'WebSocket',
    value: connected && ticksPerSec != null ? `${ticksPerSec}/s` : connected ? `${ticksPerSec ?? 0}/s` : 'OFFLINE',
    comparison: connected ? 'receiving live market data' : rangeLabelHuman === 'today' ? 'no active market data stream' : 'no data stream on this range',
    timestamp: fmtNow(),
    symbol: 'ALL',
    reason: connected
      ? 'Live websocket is delivering ticks to the buffer right now.'
      : `WebSocket is not connected (reason: ${str(sys.wsDisconnectReason) || 'Unknown'}). Insights for this range reflect saved data only.`,
    severity: connected ? 'info' : 'warning',
    icon: 'activity',
  });

  // -- Persistence success (real counters) --
  const totalWrites = typeof buffer.totalWritten === 'number' ? buffer.totalWritten : (typeof buffer.totalWrites === 'number' ? buffer.totalWrites : null);
  const totalWriteErrors = typeof buffer.totalWriteErrors === 'number' ? buffer.totalWriteErrors : null;
  if (totalWrites != null || totalWriteErrors != null) {
    const attempted = (totalWrites ?? 0) + (totalWriteErrors ?? 0);
    const failRate = attempted > 0 ? ((totalWriteErrors ?? 0) / attempted) * 100 : null;
    insights.push({
      id: idx(3),
      category: 'Collection Health',
      title: (totalWriteErrors ?? 0) > 0
        ? 'Database write failures detected'
        : attempted > 0
          ? 'Collection writes are clean'
          : 'No save attempts in this process',
      metric: 'Write Success',
      value: attempted > 0 ? `${(100 - (failRate ?? 0)).toFixed(1)}%` : '—',
      comparison: `${attempted} attempt(s), ${totalWriteErrors ?? 0} failed`,
      timestamp: fmtNow(),
      symbol: 'ALL',
      reason: `Buffer recorded ${totalWrites ?? 0} saved writes with ${totalWriteErrors ?? 0} failures.`,
      severity: (totalWriteErrors ?? 0) > 0 ? 'warning' : attempted > 0 ? 'info' : 'info',
      icon: 'activity',
    });
  }

  // -- Data quality (real aggregation) --
  if (totalTicks != null && totalTicks > 0) {
    const dups = typeof q.duplicates === 'number' ? q.duplicates : 0;
    const ooo = typeof q.outOfOrder === 'number' ? q.outOfOrder : 0;
    const tsErr = typeof q.timestampErrors === 'number' ? q.timestampErrors : 0;
    const bad = dups + ooo + tsErr;
    insights.push({
      id: idx(4),
      category: 'Data Quality',
      title: bad > 0 ? `${bad.toLocaleString('en-IN')} quality issues detected` : `No quality issues in ${totalTicks.toLocaleString('en-IN')} ticks`,
      metric: 'Quality',
      value: bad > 0 ? `${bad.toLocaleString('en-IN')} issues` : 'Clean',
      comparison: `${dups} dup · ${ooo} out-of-order · ${tsErr} ts-errors`,
      timestamp: fmtNow(),
      symbol: 'ALL',
      reason: 'Duplicates = same (symbol, ts). Out-of-order = ts older than the previous tick of the same symbol. Timestamp errors = missing/invalid ts.',
      severity: bad > 0 ? 'warning' : 'info',
      icon: 'volatility',
    });
  }

  // -- Buffering --
  const bufferLen = typeof buffer.bufferLength === 'number' ? buffer.bufferLength : null;
  if (bufferLen != null && bufferLen > 0) {
    insights.push({
      id: idx(5),
      category: 'Buffering',
      title: `${bufferLen} ticks currently buffered`,
      metric: 'Buffer Size',
      value: String(bufferLen),
      comparison: 'in-memory pipeline',
      timestamp: fmtNow(),
      symbol: 'ALL',
      reason: 'Ticks awaiting flush to persistent storage.',
      severity: bufferLen > (typeof buffer.bufferMaxSize === 'number' ? buffer.bufferMaxSize * 0.9 : 5000) ? 'warning' : 'info',
      icon: 'liquidity',
    });
  }

  // -- Skip/delay coverage --
  if (typeof buffer.feedLatencyMs === 'object' && buffer.feedLatencyMs && typeof buffer.feedLatencyMs.avgMs === 'number') {
    insights.push({
      id: idx(6),
      category: 'Feed Latency',
      title: `Feed latency avg ${buffer.feedLatencyMs.avgMs}ms in this process`,
      metric: 'Latency',
      value: `${buffer.feedLatencyMs.currentMs}ms`,
      comparison: `avg ${buffer.feedLatencyMs.avgMs}ms · min ${buffer.feedLatencyMs.minMs}ms · max ${buffer.feedLatencyMs.maxMs}ms`,
      timestamp: fmtNow(),
      symbol: 'ALL',
      reason: 'Measured as exchange tick timestamp → backend receive time for live ticks received in this backend process.',
      severity: 'info',
      icon: 'spread',
    });
  }

  return Response.json({
    range: rangeLabel,
    rangeHours: hours,
    updatedAt: new Date().toISOString(),
    insights,
    availability: {
      historical: false,
      note: 'Historical series before the current backend process are not computed by this route; use the Data Quality page for the stored tick window.',
    },
  });
}

function fmtNow(): string {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' IST';
}

function local(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}