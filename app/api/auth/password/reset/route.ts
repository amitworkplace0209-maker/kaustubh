import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/password/reset — verify MPIN then reset the owner password.
 *
 * Proxied to the VM1 backend which validates MPIN against OWNER_MPIN and
 * updates the stored scrypt password hash in MongoDB.
 */
export async function POST(request: NextRequest) {
  return proxyAuth(request, '/api/auth/password/reset');
}
