'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared single-shot backend loader hook (Service Phase).
 *
 * Calls a `loader` (a `lib/api.ts` helper that reaches the real backend) once
 * on mount and again on `refresh()`. Never interval-polls, never fabricates
 * data. Used by engine pages whose endpoints return plain dicts (no `{ok,
 * data}` envelope) — mirroring the Scheduler `useRaw` pattern.
 */
export function useBackend<T = any>(loader: () => Promise<T> | null): {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);

  // Decides what an error actually is. An ABORTED request (page left mid-load,
  // a newer fetch superseded it, a shared single-flight sibling cancelled) is
  // NOT a backend failure and must never blast "signal is aborted without
  // reason" across the UI. A TIMEOUT means the engine is just slow — keep the
  // last-known data instead of nuking a populated page.
  const applyError = (req: number, e: any) => {
    if (req !== reqRef.current) return;
    const name = e?.name;
    const msg = typeof e?.message === 'string' ? e.message : String(e ?? '');
    if (name === 'AbortError' || /aborted/i.test(msg)) return;
    if (name === 'TimeoutError' || /timed out|timeout/i.test(msg)) {
      setError(null);
      return;
    }
    setError(msg || 'fetch failed');
  };

  const load = useCallback(() => {
    const req = ++reqRef.current;
    setLoading(true);
    Promise.resolve(loader())
      .then((d) => {
        if (req !== reqRef.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: any) => applyError(req, e))
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
  }, [loader]);

  useEffect(() => {
    const req = ++reqRef.current;
    setLoading(true);
    Promise.resolve(loader())
      .then((d) => {
        if (req !== reqRef.current) return;
        setData(d);
      })
      .catch((e: any) => applyError(req, e))
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
    return () => { reqRef.current += 1; };
  }, [loader]);

  return { data, error, loading, refresh: load };
}