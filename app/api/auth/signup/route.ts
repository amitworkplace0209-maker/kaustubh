import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/signup — one-time owner creation on VM1.
 *
 * The backend enforces the owner-only signup contract (no automatic owner,
 * env-configured credentials, signup open only while no owner exists).
 */
export async function POST(request: NextRequest) {
  return proxyAuth(request, '/api/auth/signup');
}
