import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/auth/devices — every active login with its IP and timestamps. */
export async function GET(request: NextRequest) {
  return proxyAuth(request, '/api/auth/devices');
}
