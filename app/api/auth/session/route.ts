import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/auth/session — single source of truth for the UI session
 * (authenticated state, MPIN setup, unlock state, device count and sessions).
 */
export async function GET(request: NextRequest) {
  return proxyAuth(request, '/api/auth/session');
}
