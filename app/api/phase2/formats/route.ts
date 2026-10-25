import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Formats & Fields — real registry from the EXISTING backend endpoints:
 *   /api/downloads/formats  -> 25-format serializer registry + defaultFormat
 *   /api/downloads/fields   -> export field list + real per-field metadata
 *   /api/downloads/stats    -> real export tallies
 * No fabricated values; each section handled independently.
 */
export async function GET(_req: NextRequest) {
  const [formatsRes, fieldsRes, statsRes] = await Promise.all([
    backendFetch('/api/downloads/formats', { timeoutMs: 8000 }),
    backendFetch('/api/downloads/fields', { timeoutMs: 8000 }),
    backendFetch('/api/downloads/stats', { timeoutMs: 8000 }),
  ]);

  const formats = formatsRes.ok ? (formatsRes.data?.formats ?? []) : [];
  const defaultFormat = formatsRes.ok ? (formatsRes.data?.defaultFormat ?? null) : null;
  const stats = statsRes.ok ? (statsRes.data ?? {}) : {};

  return Response.json({
    ok: formatsRes.ok,
    reason: formatsRes.ok ? undefined : (formatsRes.error || 'Format registry unavailable'),
    total: formats.length,
    availableCount: formats.filter((f: any) => f.available !== false).length,
    categories: Array.from(new Set(formats.map((f: any) => f.category).filter(Boolean))) as string[],
    defaultFormat,
    formats,
    fields: {
      ok: fieldsRes.ok,
      reason: fieldsRes.ok ? undefined : (fieldsRes.error || 'Field registry unavailable'),
      names: fieldsRes.ok ? (fieldsRes.data?.fields ?? []) : [],
      defaultFields: fieldsRes.ok ? (fieldsRes.data?.defaultFields ?? []) : [],
      details: fieldsRes.ok ? (fieldsRes.data?.fieldDetails ?? []) : [],
    },
    stats: {
      ok: statsRes.ok,
      reason: statsRes.ok ? undefined : (statsRes.error || 'Export stats unavailable'),
      ...stats,
    },
  });
}
