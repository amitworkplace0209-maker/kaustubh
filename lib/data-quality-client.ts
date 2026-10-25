'use client';

/**
 * Data Quality same-origin client (020 redesign).
 *
 * All calls go through the Next.js proxy (`app/api/data-quality/[...path]`),
 * which forwards to the real Python backend (`/api/data-quality/*`). The
 * proxy wraps payloads as `{ ok: true, ...data }` on success and
 * `{ ok: false, error, status }` on backend outage — this client unwraps that
 * envelope and throws a typed error callers can render honestly.
 *
 * Why same-origin instead of `lib/api.ts#getDataQuality` (direct
 * `NEXT_PUBLIC_API_BASE` loopback fetch)? Direct cross-origin loopback fetches
 * force a CORS preflight per read, saturate the loopback connection pool
 * alongside SSE streams, and fail outright when the browser blocks
 * loopback. The proxy keeps every read preflight-free and lets the page work
 * behind the PWA service worker.
 */

export class DataQualityError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'DataQualityError';
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 20000;

function buildQuery(params?: Record<string, string | number | undefined | null>): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const s = String(v);
    if (s === '') continue;
    qs.set(k, s);
  }
  const q = qs.toString();
  return q ? `?${q}` : '';
}

async function dqFetch<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/data-quality/${path}`, {
      ...rest,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...((rest.headers as Record<string, string>) || {}),
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok === false) {
      throw new DataQualityError(
        body?.error || `Data quality service unavailable (HTTP ${res.status})`,
        body?.status ?? res.status,
      );
    }
    // Proxy envelope is `{ ok: true, ...realPayload }` — strip `ok`.
    if (body && typeof body === 'object' && 'ok' in body) {
      const { ok: _dropped, ...payload } = body as Record<string, unknown>;
      return payload as T;
    }
    return body as T;
  } catch (err: unknown) {
    if (err instanceof DataQualityError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new DataQualityError(`Data quality request timed out after ${timeoutMs}ms`, 0);
    }
    throw new DataQualityError(
      err instanceof Error ? err.message : 'Data quality service unavailable',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function dqGet<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined | null>,
  timeoutMs?: number,
): Promise<T> {
  return dqFetch<T>(`${path}${buildQuery(params)}`, { timeoutMs });
}

export function dqPost<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
  return dqFetch<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Filter mapping shared by the page and tests: UI control → backend query. */
export function dqParamsForFilters(f: {
  hours: number;
  symbol: string;
  exchange: string;
  segment: string;
  dateISO: string;
  timeFrom: string;
  timeTo: string;
}): Record<string, string | number> {
  const p: Record<string, string | number> = {};
  if (f.hours > 0) p.hours = f.hours;
  if (f.symbol.trim()) p.symbol = f.symbol.trim().toUpperCase();
  if (f.exchange && f.exchange !== 'ALL') p.exchange = f.exchange;
  if (f.segment && f.segment !== 'All') p.segment = f.segment;
  if (f.dateISO) p.date = f.dateISO;
  if (f.timeFrom) p.time_from = f.timeFrom;
  if (f.timeTo) p.time_to = f.timeTo;
  return p;
}
