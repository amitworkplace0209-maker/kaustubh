import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Instrument search for the Data Saver "Add Stock" flow.
 *
 * Proxies to the canonical Search Engine (`/api/search`) — the single
 * instrument-discovery contract. It no longer targets the deprecated
 * `/api/stocks/search` route. Never a per-keystroke master download, never
 * fabricated instruments, and missing live state stays null with an explicit
 * status.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || '';
  const limit = req.nextUrl.searchParams.get('limit') || '12';
  const res = await backendFetch(
    `/api/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}&scope=stocks`,
    { timeoutMs: 8000 },
  );
  if (!res.ok) {
    return Response.json(
      { data: [], source: 'error', reason: res.data?.reason ?? res.error ?? 'Search failed' },
      { status: res.status || 502 },
    );
  }
  return Response.json(res.data);
}
