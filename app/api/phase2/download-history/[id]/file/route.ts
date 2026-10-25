import { NextRequest, NextResponse } from 'next/server';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const BACKEND = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

/**
 * Proxy a stored export artifact from the REAL backend
 * `GET /api/downloads/history/{id}/file` and stream it back as an attachment
 * so the user can actually download the file from Download History.
 */
export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: 'missing id' }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/downloads/history/${encodeURIComponent(id)}/file`, {
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'Backend unreachable' }, { status: 502 });
  }

  const disposition = res.headers.get('Content-Disposition') || '';
  const filename = /filename="?([^";]+)"/.exec(disposition)?.[1] || `${id}.zip`;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return new NextResponse(text, { status: res.status });
  }

  const body = await res.arrayBuffer();
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(body.byteLength),
    },
  });
}
