'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getRealtimeConnectionState, subscribeRealtime } from '@/lib/realtime-store';

const BASE = '/api/services/engines/audit_engine';

/** 1s client ticker — clocks + "ago" labels. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN');
}

export function fmtTs(iso?: string | number | null): string {
  if (iso == null || iso === '') return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

export function fmtClockIST(iso?: string | number | null): string {
  if (iso == null || iso === '') return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

export function fmtAgo(ts: string | number | null | undefined, now: number): string {
  if (ts == null || ts === '') return '—';
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function getJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body?.data ?? body;
}

export const fetchAuditSummary = (): Promise<any> => getJson(`${BASE}/summary`);

export interface AuditFilters {
  search: string;
  source: string;
  event: string;
  category: string;
  severity: string;
  correlation_id: string;
  limit: number;
}

export const EMPTY_FILTERS: AuditFilters = {
  search: '', source: '', event: '', category: '', severity: '', correlation_id: '', limit: 50,
};

export const fetchAuditQuery = (f: AuditFilters): Promise<any[]> => {
  const q = new URLSearchParams();
  q.set('limit', String(f.limit));
  if (f.search) q.set('search', f.search);
  if (f.source) q.set('source', f.source);
  if (f.event) q.set('event', f.event);
  if (f.category) q.set('category', f.category);
  if (f.severity) q.set('severity', f.severity);
  if (f.correlation_id) q.set('correlation_id', f.correlation_id);
  return getJson(`${BASE}/query?${q.toString()}`).then((d: any) => d?.events ?? []);
};

export const fetchAuditTrace = (correlationId: string): Promise<any[]> =>
  getJson(`${BASE}/trace/${encodeURIComponent(correlationId)}`).then((d: any) => d?.events ?? []);

export const postAuditRecord = (body: Record<string, any>): Promise<any> =>
  getJson(`${BASE}/record`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const postAuditFlush = (): Promise<any> =>
  getJson(`${BASE}/flush`, { method: 'POST' });

/** Live aggregated posture (real MongoDB aggregations). */
export function useAuditSummary(intervalMs = 15000): {
  data: any | null; error: string | null; loading: boolean; lastUpdated: number | null; refresh: () => void;
} {
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const reqRef = useRef(0);
  /** Re-evaluated on every socket transition — drives the reconcile cadence. */
  const [socketState, setSocketState] = useState<string>(() =>
    typeof window === 'undefined' ? 'DISCONNECTED' : getRealtimeConnectionState(),
  );

  const refresh = useCallback(() => {
    const req = ++reqRef.current;
    setLoading(true);
    fetchAuditSummary()
      .then((d) => {
        if (req !== reqRef.current) return;
        setData(d); setError(d?.error ? String(d.error) : null); setLastUpdated(Date.now());
      })
      .catch((e: any) => {
        if (req !== reqRef.current) return;
        setError(e?.message ?? 'summary failed');
      })
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    setSocketState(getRealtimeConnectionState());
    return subscribeRealtime(() => setSocketState(getRealtimeConnectionState()));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    // While the WebSocket is UP the audit page already renders its engine
    // status from the pushed `engine.status` frames, so the summary only needs
    // a slow reconcile. While the socket is DOWN this is the only carrier —
    // keep the caller's cadence.
    const cadence = socketState === 'CONNECTED' ? Math.max(intervalMs * 4, 60000) : intervalMs;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      refresh();
    }, cadence);
    return () => { reqRef.current += 1; clearInterval(t); };
  }, [socketState, intervalMs, refresh]);

  return { data, error, loading, lastUpdated, refresh };
}

export const SEVERITY_TONE: Record<string, string> = {
  info: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  warning: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  error: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  critical: 'bg-rose-500/25 text-rose-200 border-rose-500/50',
  security: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
};

export const CATEGORY_COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#94a3b8', '#e879f9'];
