/**
 * VM management — thin browser client for the read/mutation endpoints.
 *
 * Split from `lib/vm-management` so the presentation rules stay importable by
 * node tests with no bundler aliases involved. All calls are same-origin; the
 * Next.js rewrite forwards `/api/vm/*` to the Python service.
 *
 * AUTHENTICATION
 * The Python API requires an operator JWT on every route (reads included), so a
 * direct request to the service port cannot read host health. The browser gets
 * that short-lived JWT from the session-gated `/api/auth/trading-token` route —
 * the same credential the terminal already uses for mutations — and keeps it in
 * memory only. One retry is made if the backend reports an expired token.
 */

import { API_BASE } from '@/lib/api-base';
import { jwtExpiresAt } from './vm-management';
import type {
  VmAction, VmApiError, VmDetailData, VmId, VmIncident, VmOverviewData,
} from './vm-management';

export class VmApiFailure extends Error {
  readonly code: string;
  readonly status: number;

  constructor(error: VmApiError) {
    super(error.message);
    this.name = 'VmApiFailure';
    this.code = error.code;
    this.status = error.status;
  }
}

function errorFromBody(body: unknown, status: number): VmApiError {
  const record = (body ?? {}) as Record<string, unknown>;
  const detail = record.detail;
  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>;
    return {
      code: String(d.code ?? 'API_ERROR'),
      message: String(d.message ?? `Request failed (HTTP ${status})`),
      status,
    };
  }
  return {
    code: String(record.code ?? record.error ?? 'API_ERROR'),
    message: String(record.message ?? (typeof detail === 'string' ? detail : `Request failed (HTTP ${status})`)),
    status,
  };
}

async function vmRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: 'no-store',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new VmApiFailure({
      code: 'NETWORK_ERROR',
      message: `Cannot reach the KDS API: ${cause instanceof Error ? cause.message : 'network error'}`,
      status: 0,
    });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new VmApiFailure(errorFromBody(body, res.status));
  const envelope = body as { ok?: boolean; data?: T } | null;
  if (!envelope || envelope.ok !== true || envelope.data === undefined) {
    throw new VmApiFailure({
      code: 'INVALID_RESPONSE',
      message: 'The API returned an unexpected response shape.',
      status: res.status,
    });
  }
  return envelope.data;
}

// ---------------------------------------------------------------------------
// operator credential (memory only)
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;
let tokenPromise: Promise<string> | null = null;

async function getOperatorToken(force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expiresAt - 30_000 > Date.now()) {
    return cachedToken.token;
  }
  if (!tokenPromise) {
    tokenPromise = (async () => {
      let res: Response;
      try {
        res = await fetch('/api/auth/trading-token', { cache: 'no-store' });
      } catch (cause) {
        throw new VmApiFailure({
          code: 'NETWORK_ERROR',
          message: `Cannot reach the auth service: ${cause instanceof Error ? cause.message : 'network error'}`,
          status: 0,
        });
      }
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; token?: unknown; code?: unknown; error?: unknown; message?: unknown }
        | null;
      if (!res.ok || body?.ok !== true || typeof body.token !== 'string' || !body.token) {
        throw new VmApiFailure({
          code: String(body?.code ?? body?.error ?? 'OPERATOR_JWT_REQUIRED'),
          message: String(body?.message ?? 'Sign in again to authorise this request.'),
          status: res.status || 401,
        });
      }
      cachedToken = {
        token: body.token,
        // A missing/unreadable exp falls back to a short cache, never to "valid forever".
        expiresAt: jwtExpiresAt(body.token) ?? Date.now() + 60_000,
      };
      return cachedToken.token;
    })().finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

function withBearer(init: RequestInit, token: string): RequestInit {
  return {
    ...init,
    headers: {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      Authorization: `Bearer ${token}`,
    },
  };
}

/**
 * Authenticated request. A 401 means the credential was rejected before the
 * handler ran, so exactly one refresh-and-retry is safe (and never loops).
 */
async function authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getOperatorToken();
  try {
    return await vmRequest<T>(path, withBearer(init, token));
  } catch (cause) {
    if (cause instanceof VmApiFailure && cause.status === 401) {
      const fresh = await getOperatorToken(true);
      return vmRequest<T>(path, withBearer(init, fresh));
    }
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export function getVmOverview(signal?: AbortSignal): Promise<VmOverviewData> {
  return authRequest<VmOverviewData>('/api/vm/overview', { signal });
}

export function getVmDetail(vmId: VmId, signal?: AbortSignal): Promise<VmDetailData> {
  return authRequest<VmDetailData>(`/api/vm/${vmId}`, { signal });
}

// ---------------------------------------------------------------------------
// operator mutations
// ---------------------------------------------------------------------------

export function acknowledgeIncident(id: string, reason = ''): Promise<VmIncident> {
  return authRequest<VmIncident>(`/api/vm/incidents/${encodeURIComponent(id)}/acknowledge`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function resolveIncident(id: string, reason = ''): Promise<VmIncident> {
  return authRequest<VmIncident>(`/api/vm/incidents/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function requestRestart(vmId: VmId, service: string, reason = ''): Promise<{ action: VmAction; message: string }> {
  return authRequest<{ action: VmAction; message: string }>('/api/vm/remediations', {
    method: 'POST',
    body: JSON.stringify({ vm_id: vmId, service, confirm: true, reason }),
  });
}
