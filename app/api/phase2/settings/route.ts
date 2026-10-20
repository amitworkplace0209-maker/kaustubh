import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Settings proxy — passthrough to the backend `/api/settings` key-value store.
 * Used to persist the Market Watch default max stock price (and any future
 * Data Saver knobs) so the user's choices survive logout / restart.
 */
export async function GET() {
  const res = await backendFetch('/api/settings', { timeoutMs: 6000 });
  if (!res.ok || !res.data) {
    return NextResponse.json(
      { ok: false, settings: {}, error: res.error || 'Settings unavailable' },
      { status: res.status && res.status !== 0 ? res.status : 502 },
    );
  }
  const d: any = res.data;
  return NextResponse.json({ ok: true, settings: d.settings ?? {} });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* ignore */ }

  // Accept { key: value } batches and write each through the backend's PUT
  // contract: PUT /api/settings/{key} with { value }.
  const results: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!key || typeof key !== 'string') continue;
    const res = await backendFetch(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      timeoutMs: 6000,
      body: JSON.stringify({ value }),
    });
    if (res.ok && res.data) {
      const d: any = res.data;
      results[key] = { ok: true, value: d?.setting?.value ?? value };
    } else {
      results[key] = { ok: false, error: res.error || String((res.data as any)?.detail ?? 'failed') };
    }
  }

  const anyFail = Object.values(results).some((r) => !r.ok);
  return NextResponse.json({ ok: !anyFail, results }, { status: anyFail ? 502 : 200 });
}
