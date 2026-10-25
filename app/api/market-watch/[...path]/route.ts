import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Market Watch Engine API — thin passthrough to the Python backend
 * (docs/engines/MARKET_WATCH.md). The engine builds the eligible-universe
 * registry, consumes WebSocket ticks, runs 30-second ranking snapshots +
 * Top-5 frequency pins, and publishes controlled UI sections. This route
 * forwards every `/api/market-watch/*` call to the real backend so the UI is
 * fed by the live engine — never fabricated values.
 *
 * Mutations (pins, saved filters) are real WS#4-equivalent backend commands,
 * so POST/DELETE must be forwarded too: the Market Watch pages POST
 * `/api/market-watch/pins` and `/api/market-watch/filters`, and DELETE
 * `/api/market-watch/pins/{token}` and `/api/market-watch/filters/{id}`.
 * A GET-only bridge made every pin and filter action fail with 405.
 */
type RouteCtx = { params: Promise<{ path: string[] }> };

function target(req: NextRequest, path: string[] | undefined): string {
  const suffix = (path ?? []).map(encodeURIComponent).join('/');
  const qs = req.nextUrl.searchParams.toString();
  return `/api/market-watch/${suffix}${qs ? `?${qs}` : ''}`;
}

function fail(res: { ok: boolean; status: number; data: unknown; error?: string }) {
  return Response.json(
    { ok: false, error: res.error || 'Market watch engine unavailable', status: res.status },
    { status: res.status && res.status !== 0 ? res.status : 502 },
  );
}

export async function GET(req: NextRequest, { params }: RouteCtx) {
  const { path } = await params;
  const res = await backendFetch(target(req, path), { timeoutMs: 25000 });
  if (!res.ok || !res.data) return fail(res);
  return Response.json(res.data);
}

/** Forward a JSON mutation, tolerating an empty body. */
async function forward(req: NextRequest, path: string[] | undefined, method: 'POST' | 'DELETE') {
  const raw = await req.text().catch(() => '');
  let body: string | undefined;
  if (raw && raw.trim()) {
    // Pass the caller's JSON through unchanged; never invent a payload.
    try {
      JSON.parse(raw);
      body = raw;
    } catch {
      return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
    }
  }
  const res = await backendFetch(target(req, path), {
    method,
    body,
    timeoutMs: 25000,
  });
  if (!res.ok) {
    // A mutation may legitimately answer with no body (e.g. 204/empty delete).
    if (res.status >= 200 && res.status < 300) return Response.json({ ok: true });
    return fail(res);
  }
  return Response.json(res.data ?? { ok: true });
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path, 'POST');
}

export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path, 'DELETE');
}
