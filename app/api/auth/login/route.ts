import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/login — proxy to the VM1 backend app-level auth.
 *
 * The backend performs IP verification, rate limiting, password verification,
 * device-limit checks, OTP issuance and session creation. This route forwards
 * the full cookie header (including any pending-MPIN marker), the real client
 * IP headers and the unchanged JSON body, then relays Set-Cookie back.
 */
export async function POST(request: NextRequest) {
  return proxyAuth(request, '/api/auth/login');
}

/** Legacy DELETE /api/auth/login — log out via backend session revoke. */
export async function DELETE(request: NextRequest) {
  return proxyAuth(request, '/api/auth/session/revoke', { method: 'POST' });
}
