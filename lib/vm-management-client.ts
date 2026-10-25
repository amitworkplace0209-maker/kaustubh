/**
 * VM management — thin browser client for the read/mutation endpoints.
 *
 * Split from `lib/vm-management` so the presentation rules stay importable by
 * node tests with no bundler aliases involved. All calls are same-origin; the
 * Next.js rewrite forwards `/api/vm/*` to the Python service.
 */

import { API_BASE } from '@/lib/api-base';
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

export function getVmOverview(signal?: AbortSignal): Promise<VmOverviewData> {
  return vmRequest<VmOverviewData>('/api/vm/overview', { signal });
}

export function getVmDetail(vmId: VmId, signal?: AbortSignal): Promise<VmDetailData> {
  return vmRequest<VmDetailData>(`/api/vm/${vmId}`, { signal });
}

export async function getOperatorJwt(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/trading-token', { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) return null;
    return typeof body.token === 'string' && body.token ? body.token : null;
  } catch {
    return null;
  }
}

async function operatorRequest<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getOperatorJwt();
  if (!token) {
    throw new VmApiFailure({
      code: 'OPERATOR_JWT_REQUIRED',
      message: 'No operator credential is available. Sign in again before changing an incident.',
      status: 401,
    });
  }
  return vmRequest<T>(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

export function acknowledgeIncident(id: string, reason = ''): Promise<VmIncident> {
  return operatorRequest<VmIncident>(`/api/vm/incidents/${encodeURIComponent(id)}/acknowledge`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function resolveIncident(id: string, reason = ''): Promise<VmIncident> {
  return operatorRequest<VmIncident>(`/api/vm/incidents/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function requestRestart(vmId: VmId, service: string, reason = ''): Promise<{ action: VmAction; message: string }> {
  return operatorRequest<{ action: VmAction; message: string }>('/api/vm/remediations', {
    method: 'POST',
    body: JSON.stringify({ vm_id: vmId, service, confirm: true, reason }),
  });
}
