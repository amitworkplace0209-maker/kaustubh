'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared single-shot backend loader hook (Service Phase).
 *
 * Calls a `loader` (a `lib/api.ts` helper that reaches the real backend) once
 * on mount and again on `refresh()`. Never interval-polls, never fabricates
 * data.
 *
 * The loader is held in a ref and the mount effect has NO dependency on its
 * identity. Call sites frequently pass an inline arrow function
 * (`useBackend(() => getX())`); treating that as an effect dependency ran the
 * fetch again on every render, and because the fetch calls `setState` that
 * produced a self-sustaining request/render loop. If a page needs new data
 * when its inputs change it must call `refresh()` explicitly.
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
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  // React StrictMode mounts an effect, cleans it up, then mounts it again in
  // development. Without this, every page's one-shot read went out twice (two
  // overlapping 5-15 s backend requests). The second mount reuses the first
  // mount's promise; an explicit refresh() is never deduped.
  const mountPromiseRef = useRef<Promise<T | null> | null>(null);

  // Decides what an error actually is. An ABORTED request (page left mid-load,
  // a newer fetch superseded it) is NOT a backend failure and must never blast
  // "signal is aborted without reason" across the UI. A TIMEOUT is still an
  // honest failure: keep the last-known data on screen AND report it, rather
  // than pretending the request succeeded.
  const applyError = useCallback((req: number, e: any) => {
    if (req !== reqRef.current) return;
    const name = e?.name;
    const msg = typeof e?.message === 'string' ? e.message : String(e ?? '');
    if (name === 'AbortError' || /aborted/i.test(msg)) return;
    setError(msg || 'fetch failed');
  }, []);

  const load = useCallback((opts?: { reuseMount?: boolean }) => {
    const req = ++reqRef.current;
    setLoading(true);

    let request = opts?.reuseMount ? mountPromiseRef.current : null;
    if (!request) {
      request = Promise.resolve().then(() => loaderRef.current());
      if (opts?.reuseMount) {
        mountPromiseRef.current = request;
        const clear = () => {
          if (mountPromiseRef.current === request) mountPromiseRef.current = null;
        };
        request.then(clear, clear);
      }
    }

    request
      .then((d) => {
        if (req !== reqRef.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: any) => applyError(req, e))
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
  }, [applyError]);

  useEffect(() => {
    load({ reuseMount: true });
    return () => {
      // Invalidate any in-flight response from this mount.
      reqRef.current += 1;
    };
  }, [load]);

  return { data, error, loading, refresh: load };
}
