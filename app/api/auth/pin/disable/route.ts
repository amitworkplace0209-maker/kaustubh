import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Legacy /api/auth/pin/disable — body { pin }. */
export async function POST(request: NextRequest) {
  return proxyAuth(request, '/api/auth/pin/disable');
}
