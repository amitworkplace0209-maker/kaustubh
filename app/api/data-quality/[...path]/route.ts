import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Data Quality proxy.
 *
 * Forwards /api/data-quality/* calls to the real backend quality engine
 * (python-service/api/quality.py). Passes query params and JSON bodies
 * through untouched so the frontend always receives REAL backend data.
 *
 * On backend outage it returns a normalized { ok:false, error, status }
 * envelope so the page keeps its previous data and shows retry UX.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const { path: pathSegs } = await params;
  const sub = (pathSegs ?? []).join('/');
  const qs = req.nextUrl.searchParams.toString();
  const path = `/api/data-quality${sub ? `/${sub}` : ''}${qs ? `?${qs}` : ''}`;
  const res = await backendFetch(path, { timeoutMs: 20000 });

  if (!res.ok || res.data === undefined) {
    return Response.json(
      { ok: false, error: res.error || 'Data quality service unavailable', status: res.status },
      { status: res.status && res.status !== 0 ? res.status : 502 },
    );
  }
  return Response.json({ ok: true, ...res.data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const { path: pathSegs } = await params;
  const sub = (pathSegs ?? []).join('/');
  const body = await req.text();
  const path = `/api/data-quality${sub ? `/${sub}` : ''}`;
  const res = await backendFetch(path, {
    method: 'POST',
    body: body || undefined,
    timeoutMs: 20000,
  });
  if (!res.ok || res.data === undefined) {
    return Response.json(
      { ok: false, error: res.error || 'Data quality service unavailable', status: res.status },
      { status: res.status && res.status !== 0 ? res.status : 502 },
    );
  }
  return Response.json({ ok: true, ...res.data });
}