'use client';

// ---- Shared live-tick consumer for the Data Center stock list ----
//
// Reuses the app's SINGLE backend SSE fanout (/api/ticks/stream — the same
// stream used by Dashboard/Stocks/Positions). No extra WebSocket anywhere.
// Incoming ticks are buffered in a ref and flushed to state once per second
// so fast markets don't re-render the stock table on every message.

import { useEffect, useRef, useState } from 'react';
import { getRecentTicks } from '@/lib/api';
import { subscribeTicks, subscribeSseState } from '@/lib/shared-sse';

export interface DcLiveTick {
  symbol: string;
  ltp: number | null;
  ts: string;
}

export interface UseLatestTicksResult {
  /** symbol -> latest tick (batched, capped). */
  latest: Map<string, DcLiveTick>;
  connected: boolean;
  lastMessageAt: number | null;
}

const MAX_TRACKED = 1500;

/**
 * All lookup keys a tick answers to: bare symbol, trading symbol (-EQ form)
 * and instrument token. Positions/orders store different identifiers, so
 * indexing all three is what makes live-price matching actually hit.
 */
function tickKeys(t: { symbol?: unknown; tradingSymbol?: unknown; instrumentToken?: unknown; token?: unknown }): string[] {
  const out: string[] = [];
  for (const v of [t.symbol, t.tradingSymbol, t.instrumentToken, t.token]) {
    const s = String(v ?? '').trim();
    if (s) out.push(s);
  }
  return out;
}

export function useLatestTicks(enabled = true): UseLatestTicksResult {
  const [latest, setLatest] = useState<Map<string, DcLiveTick>>(new Map());
  const [connected, setConnected] = useState(false);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);

  const pendingRef = useRef<Map<string, DcLiveTick>>(new Map());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Backfill from the recent-ticks REST endpoint (real stored ticks).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getRecentTicks(200)
      .then((data) => {
        if (cancelled) return;
        const arr = data?.ticks ?? data?.data ?? [];
        setLatest((prev) => {
          const next = new Map(prev);
          for (const t of Array.isArray(arr) ? arr : []) {
            if (t?.symbol && !next.has(t.symbol)) {
              next.set(t.symbol, { symbol: t.symbol, ltp: t.ltp ?? null, ts: t.ts ?? '' });
            }
          }
          return next;
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);

  // Subscribe to the SHARED SSE stream (one connection per session).
  useEffect(() => {
    if (!enabled) return;

    const unsubTicks = subscribeTicks((t) => {
      const keys = tickKeys(t ?? {});
      if (keys.length === 0) return;
      const tick: DcLiveTick = {
        symbol: String((t as Record<string, unknown>).symbol ?? keys[0]),
        ltp: typeof (t as Record<string, unknown>).ltp === 'number' ? (t as Record<string, unknown>).ltp as number : null,
        ts: typeof (t as Record<string, unknown>).ts === 'string' ? (t as Record<string, unknown>).ts as string : '',
      };
      for (const k of keys) pendingRef.current.set(k, tick);
      setLastMessageAt(Date.now());
    });

    const unsubState = subscribeSseState((s) => {
      setConnected(s.connected);
      if (s.lastMessageAt != null) setLastMessageAt(s.lastMessageAt);
    });

    // Batched flush: apply buffered ticks at most once per second.
    const flush = setInterval(() => {
      if (pendingRef.current.size === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = new Map();
      setLatest((prev) => {
        const next = new Map(prev);
        for (const [k, v] of batch) next.set(k, v);
        while (next.size > MAX_TRACKED) {
          const first = next.keys().next().value;
          if (first == null) break;
          next.delete(first);
        }
        return next;
      });
    }, 1000);

    return () => {
      clearInterval(flush);
      unsubTicks();
      unsubState();
      setConnected(false);
    };
  }, [enabled]);

  return { latest, connected, lastMessageAt };
}
