import type { NextRequest } from 'next/server';
import { proxyAuth } from '@/lib/auth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/auth/login/verify-otp — second-device OTP verification on VM1. */
export async function POST(request: NextRequest) {
  return proxyAuth(request, '/api/auth/login/verify-otp');
}
