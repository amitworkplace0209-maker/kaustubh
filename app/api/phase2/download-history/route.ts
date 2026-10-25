import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Download History. Rendered from the real /api/downloads/history export
 * records with enriched metadata.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const qs = new URLSearchParams();
  if (sp.get('limit')) qs.set('limit', sp.get('limit')!);
  if (sp.get('offset')) qs.set('offset', sp.get('offset')!);
  if (sp.get('search')) qs.set('search', sp.get('search')!);
  if (sp.get('format')) qs.set('format', sp.get('format')!);
  if (sp.get('source')) qs.set('source', sp.get('source')!);
  if (sp.get('status')) qs.set('status', sp.get('status')!);
  const q = qs.toString();

  const res = await backendFetch(`/api/downloads/history?limit=50${q ? `&${q}` : ''}`, { timeoutMs: 8000 });
  const items = res.data?.items ?? [];
  const summary = res.data?.summary ?? {};

  const jobs = items.map((h: any) => {
    const stocks: string[] = Array.isArray(h.symbols) ? h.symbols : h.symbols ? [h.symbols] : [];
    const missingStocks: string[] = Array.isArray(h.missingSymbols) ? h.missingSymbols : [];
    const fmt: string = h.format ?? 'csv';
    const ts = h.ts ?? '';
    const dateStart = h.dateStart ?? '';
    const dateEnd = h.dateEnd ?? '';
    const dateRange = [dateStart, dateEnd].filter(Boolean).join(' → ');
    const fields: string[] = Array.isArray(h.fields) ? h.fields : typeof h.fields === 'string' ? h.fields.split(',').filter(Boolean) : [];

    const statusRaw = h.status ?? 'completed';
    let status = 'completed';
    if (statusRaw === 'failed') status = 'failed';
    else if (statusRaw === 'success') status = 'completed';
    else if (statusRaw === 'processing') status = 'processing';
    else if (statusRaw === 'queued') status = 'queued';
    else if (statusRaw === 'cancelled') status = 'cancelled';

    return {
      id: h._id ?? '',
      createdAt: ts,
      completedAt: h.completedAt ?? ts,
      user: h.source === 'scheduled' ? 'Scheduler' : 'Manual',
      dataset: fmt.toUpperCase().includes('zip') || fmt.includes(',') ? 'Multi-format Archive' : 'Tick Data',
      stocks,
      missingStocks,
      stockCount: stocks.length,
      timeRange: dateRange || ts.slice(0, 10),
      dateStart,
      dateEnd,
      format: fmt,
      compression: h.packagedAs === 'zip' ? 'ZIP' : 'None',
      size: fmtBytes(h.fileSizeBytes),
      sizeBytes: h.fileSizeBytes,
      status,
      records: typeof h.count === 'number' ? h.count : null,
      durationMs: typeof h.durationMs === 'number' ? h.durationMs : null,
      fileName: h.fileName || null,
      fileId: h.fileId || null,
      jobId: h.jobId || null,
      fields,
      fieldCount: fields.length,
      dataType: h.dataType || 'tick-data',
      source: h.source || 'manual',
      scheduleId: h.scheduleId || null,
      scheduleName: h.scheduleName || null,
    };
  });

  return Response.json({
    jobs,
    summary: {
      totalJobs: summary.totalJobs ?? jobs.length,
      totalSize: summary.totalSize ?? 0,
      totalSizeFormatted: fmtBytes(summary.totalSize ?? 0),
      totalRecords: summary.totalRecords ?? 0,
      statusCounts: summary.statusCounts ?? {},
    },
  });
}

function fmtBytes(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 'Not available';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
