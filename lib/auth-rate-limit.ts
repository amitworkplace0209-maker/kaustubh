/**
 * Small in-process sliding-window limiter for auth endpoints.
 *
 * On a single VM this is exact. On serverless/multi-instance it is per-instance
 * (still a meaningful speed bump), because the durable audit trail in MongoDB
 * remains the source of truth. No external dependency is required.
 */

interface Entry {
  hits: number[];
}

const buckets = new Map<string, Entry>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, entry] of buckets) {
    entry.hits = entry.hits.filter((t) => now - t < 60 * 60 * 1000);
    if (!entry.hits.length) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const entry = buckets.get(key) ?? { hits: [] };
  entry.hits = entry.hits.filter((t) => now - t < windowMs);
  if (entry.hits.length >= limit) {
    const oldest = entry.hits[0];
    buckets.set(key, entry);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }
  entry.hits.push(now);
  buckets.set(key, entry);
  return { allowed: true, remaining: Math.max(0, limit - entry.hits.length), retryAfterSec: 0 };
}

export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

export const LIMITS = {
  signup: { limit: 5, windowMs: 60 * 60 * 1000 },
  login: { limit: 12, windowMs: 10 * 60 * 1000 },
  otpVerify: { limit: 10, windowMs: 10 * 60 * 1000 },
  mpin: { limit: 8, windowMs: 5 * 60 * 1000 },
  webauthn: { limit: 20, windowMs: 10 * 60 * 1000 },
} as const;
