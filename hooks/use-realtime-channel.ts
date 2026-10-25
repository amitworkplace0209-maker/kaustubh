'use client';

/**
 * `useRealtimeChannel` — read a backend document over the WebSocket.
 *
 * The hook replaces the old "poll this REST endpoint every N seconds"
 * pattern:
 *
 *   const { data } = useRealtimeChannel('orders');
 *
 * * `data` is the authoritative document the backend pushed over the socket
 *   (already merged with any delta frames).
 * * While the socket has no document yet — or the socket is down — the hook
 *   falls back to the caller's REST loader, so a degraded backend shows the
 *   last known data instead of an empty screen. The fallback poll STOPS as
 *   soon as the socket delivers a document, so a healthy system makes zero
 *   REST calls.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  getChannelDocument,
  getChannelState,
  getRealtimeConnectionState,
  isChannelLive,
  refreshChannel,
  subscribeChannel,
  subscribeChannelState,
  subscribeRealtime,
} from '@/lib/realtime-store';
import type { RealtimeDocument } from '@/lib/realtime-store';
import type { RealtimeLiveState } from '@/lib/realtime-ws';
import { dedupeFetch } from '@/lib/shared-request';

export type RealtimeChannelOptions<T> = {
  /** Set false to keep the channel completely idle. */
  enabled?: boolean;
  /** REST loader used ONLY while the socket has no document. */
  fallback?: () => Promise<T>;
  /**
   * Cache key of the REST fallback. Several hooks may share one channel while
   * wanting DIFFERENT fallback payloads — give each payload its own key so
   * the shared-request cache never hands the wrong shape to a consumer.
   * Defaults to the channel name.
   */
  fallbackKey?: string;
  /** Fallback poll interval (ms). Default 10 s. */
  fallbackMs?: number;
  /** Map the raw document to the shape the caller wants. */
  select?: (document: RealtimeDocument) => T | null;
};

export type RealtimeChannelResult<T> = {
  /** The document (socket first, REST fallback second). */
  data: T | null;
  /** True when the value came from the WebSocket. */
  live: boolean;
  /** True while neither the socket nor the fallback has produced a value. */
  loading: boolean;
  /** Last error from the fallback loader ('' when healthy). */
  error: string;
  /** Epoch ms of the last socket document/delta. */
  updatedAt: number;
  /** Force a reload (after a mutation). */
  refresh: () => void;
};

export function useRealtimeChannel<T = RealtimeDocument>(
  channel: string,
  options: RealtimeChannelOptions<T> = {},
): RealtimeChannelResult<T> {
  const { enabled = true, fallbackMs = 10000 } = options;

  // Keep the callbacks in refs: an inline arrow in the options object would
  // otherwise re-create the effect on every render and restart the poll loop.
  const fallbackRef = useRef(options.fallback);
  fallbackRef.current = options.fallback;
  const selectRef = useRef(options.select);
  selectRef.current = options.select;
  const fallbackKey = options.fallbackKey ?? channel;

  const subscribe = useCallback(
    (cb: () => void) => subscribeChannelState(channel, cb),
    [channel],
  );
  const getSnapshot = useCallback(() => getChannelDocument(channel), [channel]);

  const document = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Re-render on socket state transitions: when the socket drops the REST
  // fallback has to take over again, and when it comes back the fallback has
  // to stop.
  const connection = useSyncExternalStore(
    (cb: () => void) => subscribeRealtime(cb),
    () => getRealtimeConnectionState(),
    () => getRealtimeConnectionState(),
  );

  const [fallbackData, setFallbackData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  // The WebSocket subscription (ref-counted across every consumer).
  useEffect(() => {
    if (!enabled) return;
    return subscribeChannel(channel);
  }, [channel, enabled]);

  // REST fallback — runs ONLY while the socket cannot deliver the document.
  useEffect(() => {
    if (!enabled || !fallbackRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      const loader = fallbackRef.current;
      if (!loader) return;
      try {
        // `dedupeFetch` keeps every hook that shares this fallback key on ONE
        // network request, exactly like the old shared poll timer did.
        const value = await dedupeFetch(
          `rt:${fallbackKey}`,
          () => loader(),
          { ttlMs: Math.max(1000, Math.floor(fallbackMs / 2)) },
        );
        if (cancelled) return;
        setFallbackData(value);
        setError('');
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    const tick = async () => {
      if (cancelled) return;
      const socketHealthy =
        getRealtimeConnectionState() === 'CONNECTED' && isChannelLive(channel);
      if (!socketHealthy) await run();
      if (cancelled) return;
      timer = setTimeout(() => void tick(), fallbackMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [channel, connection, enabled, fallbackKey, fallbackMs, nonce]);

  const refresh = useCallback(() => {
    // Ask the backend to re-push the authoritative document; if the socket is
    // down the fallback effect re-runs and reloads over REST instead.
    void refreshChannel(channel);
    setNonce((n) => n + 1);
  }, [channel]);

  const live = document !== null;
  const selected = useMemo(() => {
    if (!document) return null;
    const select = selectRef.current;
    if (!select) return document as unknown as T;
    return select(document) ?? null;
  }, [document]);

  const data = live ? selected : fallbackData;
  const updatedAt = getChannelState(channel).updatedAt;

  return {
    data,
    live,
    loading: data === null,
    error,
    updatedAt,
    refresh,
  };
}

/** Live connection state of the shared realtime socket. */
export function useRealtimeConnection(): RealtimeLiveState {
  return useSyncExternalStore(
    (cb) => subscribeRealtime(cb),
    () => getRealtimeConnectionState(),
    () => getRealtimeConnectionState(),
  );
}
