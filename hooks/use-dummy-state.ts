'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDummyState, type DummyState } from '@/lib/dummy';

export function useDummyState(pollMs = 3000, enabled = true) {
  const [state, setState] = useState<DummyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await getDummyState();
      if (mounted.current) {
        setState(next);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'state refresh failed');
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;
    setLoading(true);
    void refresh().finally(() => {
      if (mounted.current) setLoading(false);
    });
    const interval = window.setInterval(() => void refresh(), Math.max(pollMs, 1500));
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [refresh, pollMs, enabled]);

  return { state, error, loading, refresh };
}