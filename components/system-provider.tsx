'use client';

import { createContext, useContext, useMemo } from 'react';
import { getSystemStatus, getSystemMarket } from '@/lib/api';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';

export type SystemData = Record<string, any> | null;

export type SystemState = 'loading' | 'ok' | 'error';

export type SystemContextValue = {
  data: SystemData;
  state: SystemState;
  lastUpdated: number | null;
  /** /api/system/market — canonical market calendar snapshot. Same socket. */
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

/** The `system` document the backend pushes over the WebSocket. */
type SystemDocument = {
  status?: Record<string, any>;
  market?: Record<string, any>;
  state?: Record<string, any>;
};

/**
 * ONE system-state source for the whole app.
 *
 * Every bar (TopBar, WorkspaceTopBar, System page, Dashboard) reads from this
 * one context. The data now arrives over the persistent WebSocket: the
 * backend pushes the authoritative `system` document (the same payload
 * `/api/system` + `/api/system/market` return) whenever its state actually
 * changes. The REST call below is only the degraded fallback — it runs while
 * the socket has no document and stops as soon as one arrives.
 */
export function SystemProvider({
  pollMs = 10000,
  children,
}: {
  pollMs?: number;
  children: React.ReactNode;
}) {
  const { data, error, updatedAt, refresh } = useRealtimeChannel<SystemDocument>('system', {
    fallbackMs: pollMs,
    fallbackKey: 'system',
    fallback: async () => {
      const [status, market] = await Promise.all([getSystemStatus(), getSystemMarket()]);
      return { status, market };
    },
  });

  const status = data?.status ?? null;
  const market = data?.market ?? null;

  const state: SystemState = status ? 'ok' : error ? 'error' : 'loading';

  const value = useMemo<SystemContextValue>(
    () => ({
      data: status,
      state,
      lastUpdated: updatedAt || null,
      market,
      refresh,
    }),
    [status, state, updatedAt, market, refresh],
  );

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}
