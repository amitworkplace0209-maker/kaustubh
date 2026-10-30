import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/auth/mpin/verify — verify the MPIN and clear the pending marker. */
export async function POST(request: NextRequest) {
  return proxyAuth(request, '/api/auth/mpin/verify');
}
