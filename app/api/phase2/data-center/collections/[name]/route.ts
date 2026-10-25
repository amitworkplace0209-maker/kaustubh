import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Data Center — one collection's real detail (stats, indexes, schema + sample)
 * from the backend `GET /api/system/data-center/collections/{name}`.
 * Loaded lazily when a collection row is expanded; never on page load.
 */
export async function GET(_req: NextRequest, ctx: { params: { name: string } }) {
  const { name } = await ctx.params;
  if (!name) {
    return NextResponse.json({ error: 'missing collection name' }, { status: 400 });
  }

  const res = await backendFetch(
    `/api/system/data-center/collections/${encodeURIComponent(name)}`,
    { timeoutMs: 12000 },
  );

  if (!res.ok || res.data == null) {
    const detail =
      (res.data as any)?.detail ??
      res.error ??
      `Collection detail unavailable (${res.status})`;
    return NextResponse.json({ error: detail }, { status: res.status === 404 ? 404 : 503 });
  }

  return NextResponse.json(res.data);
}