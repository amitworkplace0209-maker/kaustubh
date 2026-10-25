import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Formats schema — real tick fields + defaults from the existing backend. */
export async function GET(_req: NextRequest) {
  const res = await backendFetch('/api/downloads/fields', { timeoutMs: 8000 });
  return Response.json(res.data ?? { fields: [], defaultFields: [] }, { status: res.ok ? 200 : 502 });
}
