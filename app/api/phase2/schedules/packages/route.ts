import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = new URLSearchParams();
  if (sp.get('limit')) q.set('limit', sp.get('limit')!);
  if (sp.get('offset')) q.set('offset', sp.get('offset')!);
  if (sp.get('scheduleId')) q.set('scheduleId', sp.get('scheduleId')!);
  const qs = q.toString();

  const res = await backendFetch(`/api/scheduled-downloads/packages${qs ? `?${qs}` : ''}`, {
    timeoutMs: 8000,
  });
  if (!res.ok) {
    return Response.json({ ok: false, error: res.error || 'Failed to load packages', items: [], total: 0 }, { status: res.status || 502 });
  }
  const data = res.data ?? {};
  return Response.json({ ok: true, items: data.items ?? [], total: data.total ?? 0 });
}
