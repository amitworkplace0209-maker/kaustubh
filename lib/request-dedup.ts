'use client';

/**
 * Client-side request deduplication.
 *
 * If the same request key is already in flight, new callers receive the same
 * promise instead of creating duplicate network requests. Once the request
 * completes, the entry is removed and the next call starts fresh.
 *
 * This prevents the "request storm" where navigating between pages or rapid
 * symbol changes fire N identical backend requests.
 */

const inflight = new Map<string, Promise<any>>();

/**
 * Deduplicate an async operation by key. If a request with the same key is
 * already in flight, returns the existing promise. Otherwise starts a new one.
 *
 * @example
 * ```ts
 * const data = await dedupFetch('analytics-RELIANCE-5m', () =>
 *   fetch('/api/phase2/analytics?symbol=RELIANCE&range=5m').then(r => r.json())
 * );
 * ```
 */
export async function dedupFetch<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * Check if a request with the given key is currently in flight.
 */
export function isInFlight(key: string): boolean {
  return inflight.has(key);
}

/**
 * Abort and remove an in-flight request (best-effort; the fn may still
 * complete but its result will be ignored by the caller).
 */
export function abortRequest(key: string): void {
  inflight.delete(key);
}
