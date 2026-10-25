import { NextRequest, NextResponse } from 'next/server';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const BACKEND = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

/**
 * Data Center export â€” relay the REAL backend CSV/JSON download
 * (`GET /api/system/data-center/export`) as a browser-downloadable file while
 * preserving the original Content-Type and Content-Disposition.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const kind = (url.searchParams.get('kind') || 'daily').toString();
  const format = (url.searchParams.get('format') || 'csv').toString();
  const days = (url.searchParams.get('days') || '14').toString();

  let res: Response;
  try {
    res = await fetch(
      `${BACKEND}/api/system/data-center/export?kind=${encodeURIComponent(kind)}&format=${encodeURIComponent(format)}&days=${encodeURIComponent(days)}`,
      { cache: 'no-store' },
    );
  } catch {
    return NextResponse.json({ error: 'Backend unreachable' }, { status: 502 });
  }

  const disposition = res.headers.get('Content-Disposition') || '';
  const filename =
    /filename="?([^";]+)"/.exec(disposition)?.[1] ||
    `data-center-${kind}.${format}`;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return new NextResponse(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/plain' } });
  }

  const body = await res.arrayBuffer();
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || (format === 'json' ? 'application/json' : 'text/csv'),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(body.byteLength),
    },
  });
}