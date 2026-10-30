import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Legacy /api/auth/setup — kept for the existing Settings → Security card.
 * GET reports whether an unlock secret exists; POST creates the initial MPIN.
 */
export async function GET(request: NextRequest) {
  return proxyAuth(request, '/api/auth/setup');
}

export async function POST(request: NextRequest) {
  return proxyAuth(request, '/api/auth/setup');
}
