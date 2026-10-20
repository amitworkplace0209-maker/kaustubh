import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Formats preview — REAL pre-download estimates from the existing backend.
 *  Not fabricated: counts actual matching docs + measures real serialized
 *  bytes from a sample of stored ticks. */
export async function GET(req: NextRequest) {
  const limit = req.nextUrl.searchParams.get('limit') || '5000';
  const fmt = req.nextUrl.searchParams.get('format') || 'csv';
  const symbol = req.nextUrl.searchParams.get('symbol') || '';
  const res = await backendFetch(
    `/api/downloads/preview?limit=${limit}&format=${encodeURIComponent(fmt)}&symbol=${encodeURIComponent(symbol)}&all=true`,
    { timeoutMs: 8000 },
  );
  return Response.json(res.data ?? { ok: false, estimatedRecords: 0 }, { status: res.ok ? 200 : 502 });
}
