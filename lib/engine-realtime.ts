'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { normalizeEngineStatusPayload, type EngineStatusMap } from '@/lib/engine-status';

/**
 * Engine control-plane hooks fed by WebSocket #2 (Backend ⇄ Frontend) through
 * the Connection Manager — NOT by per-page REST polling.
 *
 * The backend pushes a live `engine.status` frame on the `engines` channel
 * (built from the Engine Registry; see connection_engine.ConnectionEngine.
 * engine_snapshot). Pages subscribe once and render from the pushed snapshot.
 *
 * Resilience: every consumer may pass a REST `fallbackPath` that is fetched
 * EXACTLY ONCE on mount, so the page still renders before the socket is up or
 * if the gateway is unreachable. Once a realtime snapshot for that engine
 * arrives it wins — the fallback is never polled on an interval.
 */

export type { EngineStatusMap };

export const ENGINES_CHANNEL = 'engines';

export function useEngines(
  fallbackPath: string | null = '/api/services/engines',
): {
  engines: EngineStatusMap;
  updatedAt: number | null;
  connected: boolean;
  source: 'api' | 'realtime' | null;
} {
  const { subscribe, onFrame, connected } = useFrontendRealtime();
  const [engines, setEngines] = useState<EngineStatusMap>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [source, setSource] = useState<'api' | 'realtime' | null>(null);
  const realtimeRef = useRef(false);

  useEffect(() => {
    void subscribe([{ channel: ENGINES_CHANNEL }]).catch(() => {});
  }, [subscribe]);

  // One-shot REST fallback. WS#2 intentionally pauses outside the market
  // window (`WAITING_FOR_MARKET_WINDOW`), so without this the map stayed empty
  // and the trade page rendered "0/4 engines" while four engines were actually
  // running. The realtime snapshot always wins once it arrives.
  useEffect(() => {
    if (!fallbackPath) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(fallbackPath, { cache: 'no-store', credentials: 'same-origin' });
        const body = await res.json().catch(() => null);
        if (cancelled || realtimeRef.current || !res.ok || !body?.ok) return;
        const next = normalizeEngineStatusPayload(body.data);
        if (!next) return;
        setEngines(next);
        setUpdatedAt(Date.now());
        setSource('api');
      } catch {
        /* honest empty state — the page renders unknown, never a fake count */
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [fallbackPath]);

  useEffect(() => {
    const off = onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      const next = normalizeEngineStatusPayload(frame.data?.engines);
      if (!next) return;
      realtimeRef.current = true;
      setEngines(next);
      setUpdatedAt(Date.now());
      setSource('realtime');
    });
    return off;
  }, [onFrame]);

  return { engines, updatedAt, connected, source };
}

/**
 * One engine's live status. Subscribes to the shared `engines` channel and
 * returns the registry snapshot keyed by `engineId` (identical shape to
 * `GET /api/services/engines/{engineId}`).
 */
export function useEngineStatus<T = any>(
  engineId: string,
  fallbackPath?: string,
): {
  data: T | null;
  error: string | null;
  source: 'api' | 'realtime' | null;
  updatedAt: number | null;
  connected: boolean;
  refresh: () => void;
} {
  const { subscribe, onFrame, connected } = useFrontendRealtime();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'api' | 'realtime' | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const realtimeRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!fallbackPath) return;
    try {
      const res = await fetch(fallbackPath, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        if (!realtimeRef.current) setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      if (!realtimeRef.current) {
        setData(body.data as T);
        setSource('api');
        setError(null);
      }
    } catch (e: any) {
      if (!realtimeRef.current) setError(e?.message ?? 'fetch failed');
    }
  }, [fallbackPath]);

  useEffect(() => {
    void subscribe([{ channel: ENGINES_CHANNEL }]).catch(() => {});
  }, [subscribe]);

  useEffect(() => {
    const off = onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      const snapshot = frame.data?.engines;
      const status = engineId && snapshot ? snapshot[engineId] : null;
      if (!status) return;
      realtimeRef.current = true;
      setData(status as T);
      setSource('realtime');
      setUpdatedAt(Date.now());
      setError(null);
    });
    return off;
  }, [engineId, onFrame]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, source, updatedAt, connected, refresh };
}

/**
 * Single-shot REST fetch (mount + manual refresh) for secondary detail data
 * that is not a realtime channel. Never installs an interval — this is the
 * replacement for the old per-page `usePoll(path, intervalMs)` helper.
 */
export function useOneShot<T = any>(
  path: string | null,
  enabled = true,
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!path) return;
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const res = await fetch(path, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (req !== reqRef.current) return;
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(body.data as T);
      setError(null);
    } catch (e: any) {
      if (req === reqRef.current) setError(e?.message ?? 'fetch failed');
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [refresh, enabled]);

  return { data, error, loading, refresh };
}
