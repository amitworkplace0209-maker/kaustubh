import { NextRequest } from 'next/server';
import { backendFetch, backendText } from '@/lib/backend';
import {
  SECTIONS,
  backendPath,
  isSectionId,
  rangeSec,
  type SectionId,
} from '@/lib/tick-analytics';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Tick Analytics BFF proxy.
 *
 * ONE route, section-scoped: the page fetches each section independently so a
 * slow or unavailable section degrades to its own PARTIAL/UNAVAILABLE state
 * instead of failing the whole page. Every section is a pass-through of a real
 * backend endpoint -- nothing is computed here and nothing is fabricated here.
 *
 *   ?section=summary                      -- one lightweight page snapshot
 *   ?section=daily&days=30                -- pre-aggregated daily rows
 *   ?section=day&date=YYYY-MM-DD          -- full daily document (periods, minute buckets)
 *   ?section=top&date=&limit=&offset=     -- top symbols for a day
 *   ?section=symbolStats&symbol=&date=    -- selected-symbol facts
 *   ?section=report&date=                 -- authoritative report for one IST day
 *   ?section=reports&days=60              -- report history from stored documents
 *   ?section=export&date=&days=&format=   -- backend CSV/JSON export
 *   ?section=live&symbol=&range=          -- live engine block (state/metrics/timeseries/...)
 *
 * Single-flight: concurrent identical requests share one in-flight backend
 * call instead of stampeding the backend.
 */

const inflight = new Map<string, Promise<Response>>();

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const rawSection = sp.get('section') || 'summary';
  if (!isSectionId(rawSection)) {
    return Response.json(
      { error: 'UNKNOWN_SECTION', section: rawSection, allowed: SECTIONS },
      { status: 400 },
    );
  }
  const section = rawSection;
  const params = collectParams(section, sp);

  const key = `${section}|${JSON.stringify(params)}`;
  const existing = inflight.get(key);
  if (existing) {
    const res = await existing;
    return res.clone();
  }

  const promise = buildResponse(section, params);
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

type Params = Record<string, string | number | undefined>;

function collectParams(section: SectionId, sp: URLSearchParams): Params {
  const p: Params = {};
  const set = (k: string) => {
    const v = sp.get(k);
    if (v != null && v !== '') p[k] = v;
  };
  if (section === 'live') {
    p.symbol = sp.get('symbol') || 'RELIANCE';
    p.range = sp.get('range') || '5m';
    return p;
  }
  for (const k of ['date', 'days', 'limit', 'offset', 'symbol', 'format']) set(k);
  if (section === 'daily' && p.days == null) p.days = 30;
  if (section === 'reports' && p.days == null) p.days = 60;
  if (section === 'export' && p.days == null) p.days = 30;
  return p;
}

async function buildResponse(section: SectionId, params: Params): Promise<Response> {
  if (section === 'live') return liveBlock(params);

  const path = backendPath(section, params);

  if (section === 'export') {
    const res = await backendText(path, { timeoutMs: 20000 });
    if (!res.ok) return upstreamError(section, res.status, res.error);
    const format = String(params.format || 'csv');
    return new Response(res.text, {
      status: 200,
      headers: {
        'Content-Type': format === 'json' ? 'application/json' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="tick-analytics-${params.date || params.days || 'export'}.${format === 'json' ? 'json' : 'csv'}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const res = await backendFetch<unknown>(path, { timeoutMs: 20000 });
  if (!res.ok) return upstreamError(section, res.status, res.error);
  return Response.json(wrap(section, params, res.data), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * The live block is assembled from the live engine endpoints. It is the ONE
 * section that may be PARTIAL (some engines up, some down) -- the page renders
 * whatever arrived and lists the rest in `missing`.
 */
async function liveBlock(params: Params): Promise<Response> {
  const symbol = String(params.symbol || 'RELIANCE');
  const range = String(params.range || '5m');
  const sec = rangeSec(range);
  const enc = encodeURIComponent(symbol);

  const [stateRes, metricsRes, timeseriesRes, symbolRes, anomaliesRes, marketWideRes] =
    await Promise.all([
      backendFetch('/api/data-saver/tick-analytics/state', { timeoutMs: 6000 }),
      backendFetch('/api/data-saver/tick-analytics/metrics', { timeoutMs: 6000 }),
      backendFetch('/api/data-saver/tick-analytics/timeseries', {
        method: 'POST',
        body: JSON.stringify({ symbol, rangeSec: sec }),
        timeoutMs: 8000,
      }),
      backendFetch(`/api/data-saver/tick-analytics/symbol/${enc}`, { timeoutMs: 8000 }),
      backendFetch('/api/data-saver/tick-analytics/anomalies', {
        method: 'POST',
        body: JSON.stringify({ symbol, rangeSec: sec }),
        timeoutMs: 8000,
      }),
      backendFetch('/api/data-saver/tick-analytics/market-wide', { timeoutMs: 6000 }),
    ]);

  const missing: string[] = [];
  if (!stateRes.ok) missing.push('state');
  if (!metricsRes.ok) missing.push('metrics');
  if (!timeseriesRes.ok) missing.push('timeseries');
  if (!symbolRes.ok) missing.push('symbol');
  if (!anomaliesRes.ok) missing.push('anomalies');
  if (!marketWideRes.ok) missing.push('marketWide');

  const status = missing.length === 0 ? 'COMPLETE' : missing.length === 6 ? 'UNAVAILABLE' : 'PARTIAL';

  const symbolPayload = (symbolRes.data ?? {}) as Record<string, any>;

  return Response.json(
    {
      status,
      missing,
      generatedAt: new Date().toISOString(),
      source: 'tick-analytics-engine',
      state: stateRes.ok ? stateRes.data : null,
      metrics: metricsRes.ok ? metricsRes.data : null,
      timeseries: timeseriesRes.ok ? timeseriesRes.data : emptyTimeseries(symbol, sec),
      symbol: symbolRes.ok ? symbolPayload : { available: false, reason: 'ENGINE_UNAVAILABLE', symbol },
      depth: symbolRes.ok
        ? (symbolPayload.depth ?? { available: false, reason: 'DEPTH_UNAVAILABLE' })
        : { available: false, reason: 'ENGINE_UNAVAILABLE' },
      anomalies: anomaliesRes.ok
        ? anomaliesRes.data
        : { available: false, reason: 'ENGINE_UNAVAILABLE', anomalies: [] },
      marketWide: marketWideRes.ok ? marketWideRes.data : null,
      live: liveFromState(stateRes.data),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function wrap(section: SectionId, params: Params, data: unknown): Record<string, unknown> {
  return {
    section,
    params,
    status: 'COMPLETE',
    missing: [],
    generatedAt: new Date().toISOString(),
    data,
  };
}

function upstreamError(section: SectionId, status: number, error?: string): Response {
  return Response.json(
    {
      section,
      status: 'UNAVAILABLE',
      // Never a silent zero: the page shows UNAVAILABLE + this reason.
      missing: [error || `upstream_${status}`],
      generatedAt: new Date().toISOString(),
      data: null,
    },
    { status: status === 0 ? 502 : 200 },
  );
}

function emptyTimeseries(symbol: string, sec: number) {
  return {
    symbol: symbol.toUpperCase(),
    rangeSec: sec,
    buckets: [],
    source: 'FALLBACK_EMPTY',
    available: false,
  };
}

function liveFromState(state: any) {
  if (!state) {
    return {
      connected: false,
      pipelineState: 'UNKNOWN',
      feedState: 'NO_FEED',
      schedulerState: '',
      marketStatus: 'CLOSED',
      marketSession: '',
      ticksPerSecond: null,
      lastTickAt: null,
    };
  }
  return {
    connected: Boolean(state.ws?.connected),
    pipelineState: state.session?.pipelineRunning ? 'RUNNING' : 'STOPPED',
    feedState: state.feedStatus ?? 'NO_LIVE_DATA',
    schedulerState: '',
    marketStatus: state.marketState ?? 'UNKNOWN',
    marketSession: state.marketSession ?? '',
    ticksPerSecond: state.rate?.ticksPerSecond ?? null,
    lastTickAt: state.tick?.lastTickAt ?? null,
  };
}
