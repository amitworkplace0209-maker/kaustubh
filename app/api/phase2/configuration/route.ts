import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

type Setting = { key: string; value: any; category: string; description: string };

const SECTION_DEFS: {
  id: string; title: string; icon: string;
  keys: { key: string; type: 'boolean' | 'number' | 'string' | 'select'; options?: string[]; min?: number; max?: number; unit?: string; recommended?: any }[];
}[] = [
  {
    id: 'collection', title: 'Data Collection', icon: 'collection',
    keys: [
      { key: 'data_saver_enabled', type: 'boolean' },
      { key: 'tick_interval_ms', type: 'number', min: 100, max: 10000, unit: 'ms' },
      { key: 'batch_size', type: 'number', min: 10, max: 10000 },
      { key: 'data_collection_start', type: 'string' },
      { key: 'data_collection_stop', type: 'string' },
      { key: 'auto_save', type: 'boolean' },
    ],
  },
  {
    id: 'storage', title: 'Storage & Buffer', icon: 'storage',
    keys: [
      { key: 'buffer_size', type: 'number', min: 100, max: 100000 },
      { key: 'bulk_insert_size', type: 'number', min: 1, max: 10000 },
      { key: 'flush_interval_ms', type: 'number', min: 100, max: 60000, unit: 'ms' },
      { key: 'retry_count', type: 'number', min: 0, max: 20 },
      { key: 'save_path', type: 'string' },
      { key: 'download_folder', type: 'string' },
    ],
  },
  {
    id: 'processing', title: 'Processing & Scheduler', icon: 'processing',
    keys: [
      { key: 'scheduler_enabled', type: 'boolean' },
      { key: 'scheduler_login_time', type: 'string' },
      { key: 'scheduler_logout_time', type: 'string' },
      { key: 'auto_reconnect', type: 'boolean' },
      { key: 'scheduled_download_enabled', type: 'boolean' },
    ],
  },
  {
    id: 'download', title: 'Downloads', icon: 'download',
    keys: [
      { key: 'download_default_format', type: 'select', options: [] },
      { key: 'download_date_range_days', type: 'number', min: 1, max: 365, unit: 'days' },
      { key: 'download_compression', type: 'boolean' },
      { key: 'download_zip', type: 'boolean' },
    ],
  },
  {
    id: 'performance', title: 'Performance', icon: 'performance',
    keys: [
      { key: 'adv_retry_count', type: 'number', min: 0, max: 20 },
      { key: 'adv_retry_delay', type: 'number', min: 0, max: 60000, unit: 'ms' },
      { key: 'adv_quote_timeout', type: 'number', min: 1, max: 60, unit: 's' },
      { key: 'adv_order_timeout', type: 'number', min: 1, max: 120, unit: 's' },
    ],
  },
  {
    id: 'ui', title: 'Interface', icon: 'ui',
    keys: [
      { key: 'theme', type: 'select', options: ['dark', 'light', 'system', 'amoled'] },
      { key: 'display_density', type: 'select', options: ['compact', 'comfortable', 'spacious'] },
      { key: 'display_number_format', type: 'select', options: ['indian', 'international'] },
      { key: 'card_radius', type: 'number', min: 0, max: 24, unit: 'px' },
      { key: 'compact_mode', type: 'boolean' },
    ],
  },
];

export async function GET(_req: NextRequest) {
  const res = await backendFetch('/api/settings', { timeoutMs: 8000 });
  const settings: Record<string, Setting> = res.data?.settings ?? {};
  const byKey = new Map<string, Setting>();
  for (const k of Object.keys(settings)) byKey.set(k, settings[k]);

  // Real available download formats for the select option.
  let formats: string[] = [];
  try {
    const f = await backendFetch('/api/downloads/formats', { timeoutMs: 6000 });
    formats = (f.data?.formats ?? []).map((x: any) => x.id ?? x.format ?? '');
  } catch { /* keep empty */ }

  const setVal = (key: string, type: string) => {
    const s = byKey.get(key);
    if (!s?.value) return type === 'boolean' ? false : type === 'number' ? 0 : '';
    return s.value;
  };

  const sections = SECTION_DEFS.map((def) => ({
    id: def.id,
    title: def.title,
    icon: def.icon,
    settings: def.keys.map((k) => {
      const type = k.key === 'download_default_format' ? 'select' : k.type;
      return {
        key: k.key,
        label: labelOf(k.key),
        description: byKey.get(k.key)?.description ?? '',
        type,
        value: setVal(k.key, type),
        recommended: type === 'boolean' ? true : undefined,
        options: type === 'select' && k.key === 'download_default_format' ? (formats.length ? formats : ['csv', 'json', 'jsonl', 'parquet']) : k.options,
        min: k.min,
        max: k.max,
        unit: k.unit,
      };
    }),
  }));

  return Response.json({ sections });
}

export async function PUT(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const key: string = body.key ?? '';
  if (!key) return NextResponse.json({ ok: false, error: 'Missing setting key' }, { status: 400 });

  // Persist to the REAL backend settings store.
  const res = await backendFetch(`/api/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value: body.value }),
    timeoutMs: 8000,
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.data?.detail ?? 'Backend rejected setting' }, { status: res.status || 400 });
  }
  return Response.json({ ok: true, data: res.data });
}

function labelOf(key: string): string {
  return key
    .replace(/^(download_|adv_|data_|scheduler_)/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
