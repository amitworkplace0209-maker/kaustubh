import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySessionToken } from '@/lib/auth-crypto';

export async function GET() {
  const cookieStore = await cookies();
  const payload = verifySessionToken(cookieStore.get('kaustubh_session')?.value);
  return NextResponse.json({ authenticated: Boolean(payload) });
}
