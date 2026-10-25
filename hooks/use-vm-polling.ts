'use client';

/**
 * Visibility-aware polling for the VM pages.
 *
 * The dashboard already polls its other screens on an 8s cadence; this hook
 * keeps the same rhythm but adds the two guards a monitoring page needs:
 *
 * 1. A hidden tab does not poll at all (no background load on a phone).
 * 2. A failed refresh NEVER clears the last good payload — it is surfaced as
 *    `error` alongside `lastUpdated`, so the UI can say "last received at …"
 *    instead of pretending the numbers are current or blanking the screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { VmApiError } from '@/lib/vm-management';

export const VM_POLL_MS = 8_000;

export interface VmPollingResult<T> {
  data: T | null;
  error: VmApiError | null;
  loading: boolean;
  refreshing: boolean;
  lastUpdated: number | null;
  refresh: () => void;
}

interface Options {
  intervalMs?: number;
  enabled?: boolean;
}

function toApiError(cause: unknown): VmApiError {
  if (cause && typeof cause === 'object' && 'code' in cause && 'message' in cause && 'status' in cause) {
    const e = cause as { code: unknown; message: unknown; status: unknown };
    return { code: String(e.code), message: String(e.message), status: Number(e.status) || 0 };
  }
  return {
    code: 'UNKNOWN_ERROR',
    message: cause instanceof Error ? cause.message : 'Unexpected error',
    status: 0,
  };
}

export function useVmPolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  { intervalMs = VM_POLL_MS, enabled = true }: Options = {},
): VmPollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<VmApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const mountedRef = useRef(true);
  const inFlightRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, []);

  const run = useCallback(async () => {
    if (!enabled) return;
    // One request at a time: a slow backend must not stack heartbeats.
    if (inFlightRef.current) return;
    const controller = new AbortController();
    inFlightRef.current = controller;
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    try {
      const next = await fetcherRef.current(controller.signal);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setData(next);
      setError(null);
      setLastUpdated(Date.now());
    } catch (cause) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (controller.signal.aborted) return;
      setError(toApiError(cause));
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
      if (inFlightRef.current === controller) inFlightRef.current = null;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void run();
    return () => {
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, [enabled, run]);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void run();
    };
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (typeof document === 'undefined' || document.hidden) return;
      void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, run]);

  const refresh = useCallback(() => {
    void run();
  }, [run]);

  return { data, error, loading, refreshing, lastUpdated, refresh };
}
