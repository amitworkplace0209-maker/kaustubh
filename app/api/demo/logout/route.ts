import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Proxies a demo logout to the Python backend and clears the
 *  kaustubh_session cookie so the frontend session state resets. */
export async function POST(_req: NextRequest) {
  const cookieStore = await cookies();
  cookieStore.delete('kaustubh_session');

  const res = await backendFetch('/api/logout', {
    method: 'POST',
    timeoutMs: 30000,
  });
  return Response.json(res.data || { ok: true, message: 'Logged out' });
}

/** DELETE logout — same as POST for compatibility. */
export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete('kaustubh_session');

  const res = await backendFetch('/api/logout', {
    method: 'POST',
    timeoutMs: 30000,
  });
  return Response.json(res.data || { ok: true, message: 'Logged out' });
}
