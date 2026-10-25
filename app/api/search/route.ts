import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Global Search Engine proxy.
 *
 * The browser always calls the SAME-ORIGIN /api/search (no cross-origin
 * loopback, no per-host connection-pool starvation, no CORS) and this thin
 * route forwards to the real Python /api/search engine. The raw engine
 * envelope passess through untouched so callers (searchGlobal) keep getting
 * { query, results, total, hasMore, nextCursor, scopes, tookMs, errorCode }.
 */
export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const target = `/api/search${qs ? `?${qs}` : ''}`;
  const res = await backendFetch(target, { timeoutMs: 15000 });
  if (!res.ok || res.data === undefined) {
    return Response.json(
      { error: res.error || 'Global Search Engine unavailable', status: res.status },
      { status: res.status && res.status !== 0 ? res.status : 502 },
    );
  }
  return Response.json(res.data);
}