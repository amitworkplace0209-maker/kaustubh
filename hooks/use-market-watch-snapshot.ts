'use client';

/**
 * Central tick-store snapshot for ONE instrument.
 *
 * `GET /api/market-watch/tick-snapshot?tokens=…` answers from the central
 * tick store (the live WS#1 feed the backend subscribes to). It is the only
 * source that carries the FULL day context — open / high / low / prev close /
 * volume / upper & lower circuit — so the order ticket can price an order and
 * show the day's range even when the browser socket is not connected.
 *
 * Behaviour:
 *   · one request on selection, then a slow poll (15 s) that STOPS as soon as
 *     a streamed tick owns the price (`paused`), so the page never competes
 *     with the live feed;
 *   · a row without data (`hasData: false`) never blanks the last good row.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getMarketWatchTickSnapshot, type MarketWatchTickRow } from '@/lib/api';

export interface MarketWatchSnapshotState {
  row: MarketWatchTickRow | null;
  loading: boolean;
  error: string | null;
  /** Epoch ms of the last successful pull. */
  updatedAt: number | null;
  /** Force a fresh pull (used right after an order is placed). */
  refresh: () => void;
}

export function useMarketWatchSnapshot(
  token: string | null,
  options: { paused?: boolean; pollMs?: number } = {},
): MarketWatchSnapshotState {
  const { paused = false, pollMs = 15000 } = options;
  const [row, setRow] = useState<MarketWatchTickRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!token) {
      setRow(null);
      setError(null);
      setUpdatedAt(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inflight = false;

    const pull = async () => {
      if (inflight || cancelled) return;
      inflight = true;
      setLoading(true);
      try {
        const res = await getMarketWatchTickSnapshot([token]);
        if (cancelled) return;
        const next = res?.rows?.[token] ?? null;
        // A row without data must NOT wipe the last good snapshot.
        if (next && next.hasData !== false) {
          setRow(next);
          setUpdatedAt(Date.now());
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'snapshot unavailable');
      } finally {
        inflight = false;
        if (!cancelled) setLoading(false);
      }
    };

    void pull();
    timer = setInterval(() => {
      if (pausedRef.current) return; // a streamed tick owns the price
      if (typeof document !== 'undefined' && document.hidden) return;
      void pull();
    }, pollMs);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [token, pollMs, nonce]);

  return { row, loading, error, updatedAt, refresh };
}
