'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getSystemStatus, getSystemMarket } from '@/lib/api';

export type SystemData = Record<string, any> | null;

export type SystemState = 'loading' | 'ok' | 'error';

export type SystemContextValue = {
  data: SystemData;
  state: SystemState;
  lastUpdated: number | null;
  /** /api/system/market — canonical market calendar snapshot. Same poll loop. */
  market: SystemData;
  refresh: () => void;
};

const SystemContext = createContext<SystemContextValue>({
  data: null,
  state: 'loading',
  lastUpdated: null,
  market: null,
  refresh: () => {},
});

export function useSystem() {
  return useContext(SystemContext);
}

/**
 * Single /api/system poller for the whole app. Every bar (TopBar,
 * WorkspaceTopBar, System page, Dashboard) reads from this one context
 * instead of running its own interval, cutting N overlapping pollers to 1.
 */
export function SystemProvider({
  pollMs = 10000,
  children,
}: {
  pollMs?: number;
  children: React.ReactNode;
}) {
  const [data, setData] = useState<SystemData>(null);
  const [state, setState] = useState<SystemState>('loading');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [market, setMarket] = useState<SystemData>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  const fetchNow = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const [res, mk] = await Promise.all([getSystemStatus(), getSystemMarket()]);
      if (!mountedRef.current) return;
      setData(res);
      setMarket(mk);
      setState('ok');
      setLastUpdated(Date.now());
    } catch {
      if (mountedRef.current) setState('error');
    } finally {
      busyRef.current = false;
    }
  }, []);

  const refresh = useCallback(() => {
    void fetchNow();
  }, [fetchNow]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchNow();

    const interval = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void fetchNow();
    }, pollMs);

    const onSessionChange = () => void fetchNow();
    const onVisible = () => {
      if (!document.hidden) void fetchNow();
    };
    window.addEventListener('kotak-session-changed', onSessionChange);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      mountedRef.current = false;
      busyRef.current = false;
      clearInterval(interval);
      window.removeEventListener('kotak-session-changed', onSessionChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchNow, pollMs]);

  return (
    <SystemContext.Provider value={{ data, state, lastUpdated, market, refresh }}>
      {children}
    </SystemContext.Provider>
  );
}