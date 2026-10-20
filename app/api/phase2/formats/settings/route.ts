import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

type Setting = { key: string; value: any; category: string; description: string; updatedAt?: string | null };

const SECTIONS: { id: string; label: string; keys: string[] }[] = [
  { id: 'general', label: 'General', keys: ['download_default_format'] },
  {
    id: 'formats', label: 'Formats', keys: [
      'download_csv', 'download_json', 'download_jsonl', 'download_ndjson',
      'download_txt', 'download_xlsx', 'download_zip', 'download_compression',
    ],
  },
  { id: 'storage', label: 'Storage', keys: ['download_folder', 'download_date_range_days', 'save_path'] },
  {
    id: 'collection', label: 'Data Collection', keys: [
      'data_saver_enabled', 'tick_interval_ms', 'batch_size', 'buffer_size',
      'bulk_insert_size', 'flush_interval_ms', 'retry_count', 'auto_save',
      'data_collection_start', 'data_collection_stop',
    ],
  },
  { id: 'display', label: 'Display', keys: ['display_number_format', 'display_decimal_places'] },
  { id: 'retention', label: 'Retention', keys: ['log_retention_days'] },
];
const ALL_KEYS = new Set(SECTIONS.flatMap((s) => s.keys));

export async function GET(_req: NextRequest) {
  const res = await backendFetch('/api/settings', { timeoutMs: 8000 });
  const settings: Record<string, Setting> = res.data?.settings ?? {};
  const ok = Boolean(res.ok && Object.keys(settings).length);

  const sections = SECTIONS.map((sec) => ({
    id: sec.id,
    label: sec.label,
    settings: sec.keys.map((key) => {
      const s = settings[key];
      return {
        key,
        value: s?.value ?? null,
        description: s?.description ?? '',
        category: s?.category ?? '',
        updatedAt: s?.updatedAt ?? null,
      };
    }),
  }));

  return Response.json({ ok, reason: ok ? undefined : (res.error || 'Settings unavailable'), sections });
}

export async function PUT(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  if (!Array.isArray(body?.settings)) {
    return NextResponse.json({ ok: false, error: 'Expected { settings: [...] }' }, { status: 400 });
  }
  const errors: { key: string; error: string }[] = [];
  const saved: { key: string; value: any }[] = [];
  for (const item of body.settings) {
    if (!ALL_KEYS.has(item.key)) { errors.push({ key: item.key, error: 'Unknown or not-editable setting' }); continue; }
    const res = await backendFetch(`/api/settings/${encodeURIComponent(item.key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value: item.value }),
      timeoutMs: 8000,
    });
    if (res.ok) saved.push({ key: item.key, value: item.value });
    else errors.push({ key: item.key, error: (res.data?.detail as string) || 'Backend rejected setting' });
  }
  if (errors.length > 0) {
    return NextResponse.json({ ok: false, error: 'Some settings failed to save', details: errors }, { status: 400 });
  }
  return Response.json({ ok: true, saved, savedAt: new Date().toISOString() });
}
