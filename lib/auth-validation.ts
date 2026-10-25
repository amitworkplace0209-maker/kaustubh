import type { NextRequest } from 'next/server';
import type { AuthSessionDoc, AuthUserDoc } from '@/lib/auth-db';
import { describeUserAgent, maskEmail, requestContext } from '@/lib/auth-config';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  emailMasked: string;
  hasMpin: boolean;
  mpinUpdatedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export function publicUser(user: AuthUserDoc, revealEmail = true): PublicUser {
  return {
    id: user._id ? String(user._id) : '',
    name: user.name,
    email: revealEmail ? user.email : maskEmail(user.email),
    emailMasked: maskEmail(user.email),
    hasMpin: Boolean(user.mpinHash),
    mpinUpdatedAt: user.mpinUpdatedAt ?? null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

export function publicSession(session: AuthSessionDoc, currentSessionId?: string) {
  return {
    id: session.sessionId,
    deviceId: session.deviceId,
    deviceLabel: session.deviceLabel || describeUserAgent(session.userAgent),
    ip: session.ip,
    userAgent: session.userAgent,
    kind: session.kind,
    current: session.sessionId === currentSessionId,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

export function validName(name: string): string | null {
  if (name.length < 2) return 'Name must be at least 2 characters.';
  if (name.length > 40) return 'Name must be at most 40 characters.';
  // Unicode letters/numbers (constructor form keeps the es5 tsconfig target
  // happy while still allowing `\p{...}` at runtime).
  const namePattern = new RegExp("^[\\p{L}\\p{N} ._'’-]+$", 'u');
  if (!namePattern.test(name)) {
    return 'Name may only contain letters, numbers, spaces, dots, dashes, underscores and apostrophes.';
  }
  return null;
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function validEmail(email: string): string | null {
  if (email.length < 5 || email.length > 254) return 'Enter a valid email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return 'Enter a valid email address.';
  return null;
}

export function validatePassword(password: unknown): string | null {
  const value = String(password ?? '');
  if (value.length < 10) return 'Password must be at least 10 characters.';
  if (value.length > 128) return 'Password must be at most 128 characters.';
  if (!/[a-z]/.test(value)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(value)) return 'Password must include an uppercase letter.';
  if (!/\d/.test(value)) return 'Password must include a number.';
  if (/\s/.test(value)) return 'Password must not contain spaces.';
  if (/^(.)\1+$/.test(value)) return 'Password is too weak.';
  return null;
}

const WEAK_MPINS = new Set([
  '000000', '111111', '222222', '333333', '444444', '555555',
  '666666', '777777', '888888', '999999', '123456', '654321',
  '121212', '112233', '123123', '159753', '147258', '102030',
]);

export function validateMpin(mpin: unknown): string | null {
  const value = String(mpin ?? '');
  if (!/^\d{6}$/.test(value)) return 'MPIN must be exactly 6 digits.';
  if (WEAK_MPINS.has(value)) return 'That MPIN is too easy to guess. Choose another 6-digit MPIN.';
  if (/^(\d)\1{5}$/.test(value)) return 'That MPIN is too easy to guess. Choose another 6-digit MPIN.';
  const digits = value.split('').map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return 'Sequential MPINs are not allowed. Choose another 6-digit MPIN.';
  return null;
}

export function clientMeta(request: NextRequest) {
  const ctx = requestContext(request);
  return {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    deviceLabel: ctx.deviceLabel,
    origin: ctx.origin,
    hostname: ctx.hostname,
    secure: ctx.secure,
  };
}

export function safeDeviceId(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (/^[A-Za-z0-9_-]{8,80}$/.test(raw)) return raw;
  return '';
}

export function safeDeviceLabel(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return raw || fallback;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, message, error: message, ...extra }, status);
}

export async function readJson(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
