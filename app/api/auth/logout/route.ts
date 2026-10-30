import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST/DELETE /api/auth/logout — revoke the current app session on VM1 and
 * clear both auth cookies (the backend returns the clearing Set-Cookie headers).
 *
 * The broker logout lives at /api/logout and is handled by manual-login; this
 * endpoint only ends the app session.
 */
export async function POST(request: NextRequest) {
  return proxyAuth(request, '/api/auth/session/revoke', { method: 'POST' });
}

export async function DELETE(request: NextRequest) {
  return proxyAuth(request, '/api/auth/session/revoke', { method: 'POST' });
}
