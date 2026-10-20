'use client';

// ---- Live Data Quality stream ----
//
// Single-shot snapshot (GET /api/data-quality/live) + live updates over the
// app's EXISTING shared SSE fan-out (/api/schedule-events/stream), which the
// backend now feeds with aggregated `quality_live` frames every ~1s.
//
// No REST polling, no second socket, no per-tick messages: the backend
// aggregates internally and the UI only re-renders the metric state.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getScheduleEventsUrl } from '@/lib/api';
import { dqGet } from '@/lib/data-quality-client';

export interface DQEngineRef {
  connected?: boolean | null;
  running?: boolean | null;
  state?: string | null;
  feedState?: string | null;
  subscriptions?: number | null;
  subscribed?: number | null;
  activeSymbols?: number | null;
  lastTickAt?: string | null;
  [key: string]: unknown;
}

export interface DQThroughput {
  ingressPerSec?: number | null;
  processingPerSec?: number | null;
  writePerSec?: number | null;
  dropPerSec?: number | null;
  failPerSec?: number | null;
  tickRate?: number | null;
}

export interface DQIngestion {
  received?: number | null;
  queued?: number | null;
  written?: number | null;
  failed?: number | null;
  dropped?: number | null;
  pending?: number | null;
  queueDepth?: number | null;
  queueCapacity?: number | null;
  writeRate?: number | null;
  writeLatencyMs?: number | null;
  batchSize?: number | null;
  flushIntervalMs?: number | null;
  lastWriteAt?: string | null;
  lastWriteError?: string | null;
  lastFailedWriteAt?: string | null;
  uptimeSec?: number | null;
}

export interface DQIssue {
  ts?: string | null;
  title: string;
  detail?: string;
  severity?: string;
  source?: string;
  symbol?: string | null;
}

export interface DataQualityLive {
  timestamp?: string | null;
  totalTicks?: number | null;
  tickRate?: number | null;
  receivedTicks?: number | null;
  savedTicks?: number | null;
  savedPct?: number | null;
  failedTicks?: number | null;
  failedPct?: number | null;
  duplicateTicks?: number | null;
  duplicatePct?: number | null;
  droppedTicks?: number | null;
  droppedPct?: number | null;
  activeSymbols?: number | null;
  tickingSymbols?: number | null;
  writesPerSecond?: number | null;
  queueDepth?: number | null;
  queueCapacity?: number | null;
  latencyMs?: number | null;
  freshnessMs?: number | null;
  freshnessState?: string | null;
  lastTickAt?: string | null;
  lastWriteAt?: string | null;
  writeAgeMs?: number | null;
  writeAgeState?: string | null;
  throughput?: DQThroughput | null;
  ingestion?: DQIngestion | null;
  scheduler?: DQEngineRef | null;
  session?: DQEngineRef & { active?: boolean | null } | null;
  websocket?: DQEngineRef | null;
  marketWatch?: DQEngineRef | null;
  dbWriter?: DQEngineRef | null;
  mongodb?: DQEngineRef & { source?: string | null; pingMs?: number | null } | null;
  pipeline?: Array<{ name: string; state?: string | null; ok?: boolean | null }>;
  recentIssues?: DQIssue[];
}

export interface UseDataQualityLiveResult {
  data: DataQualityLive | null;
  sseConnected: boolean;
  /** True while frames arrive on time and backend freshness is LIVE. */
  live: boolean;
  /** True when the stream or the feed has gone quiet (show STALE, not fake live). */
  stale: boolean;
  lastUpdateAt: number | null;
  error: string | null;
  retry: () => void;
}

const STALE_AFTER_MS = 6000;

export function useDataQualityLive(enabled = true): UseDataQualityLiveResult {
  const [data, setData] = useState<DataQualityLive | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const esRef = useRef<EventSource | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFrameAt = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const mountedRef = useRef(true);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // 1) One lightweight snapshot on open — never polled again.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    mountedRef.current = true;
    dqGet<DataQualityLive>('live', undefined, 8000)
      .then((snap) => {
        if (cancelled || !mountedRef.current) return;
        setData(snap);
        const now = Date.now();
        lastFrameAt.current = now;
        setLastUpdateAt(now);
        setStale(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return;
        const msg = err instanceof Error ? err.message : 'Data quality service unavailable';
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  // 2) Single SSE subscription for `quality_live` frames.
  useEffect(() => {
    if (!enabled) return;

    const connect = () => {
      if (esRef.current) {
        try {
          esRef.current.close();
        } catch {
          /* ignore */
        }
        esRef.current = null;
      }
      let es: EventSource;
      try {
        es = new EventSource(getScheduleEventsUrl());
      } catch {
        setSseConnected(false);
        if (enabledRef.current && mountedRef.current) {
          retryTimer.current = setTimeout(connect, 3000);
        }
        return;
      }
      esRef.current = es;

      es.onopen = () => {
        if (!mountedRef.current) return;
        setSseConnected(true);
        setError(null);
      };
      es.onerror = () => {
        if (!mountedRef.current) return;
        setSseConnected(false);
        try {
          es.close();
        } catch {
          /* ignore */
        }
        esRef.current = null;
        if (enabledRef.current && mountedRef.current) {
          retryTimer.current = setTimeout(connect, 3000);
        }
      };
      es.onmessage = (event) => {
        if (!mountedRef.current) return;
        if (!event.data || event.data === ': heartbeat') return;
        try {
          const ev = JSON.parse(event.data) as Record<string, unknown>;
          const type = String(ev?.type ?? ev?.event ?? '');
          if (type !== 'quality_live') return;
          const now = Date.now();
          lastFrameAt.current = now;
          setLastUpdateAt(now);
          setStale(false);
          setError(null);
          const { type: _t, ...rest } = ev;
          void _t;
          setData(rest as DataQualityLive);
        } catch {
          /* malformed frame — ignore, next 2s frame converges */
        }
      };
    };

    mountedRef.current = true;
    connect();

    // Stale watchdog: no frame for a while => visibly STALE, never fake LIVE.
    staleTimer.current = setInterval(() => {
      if (!mountedRef.current) return;
      if (lastFrameAt.current === 0) return; // snapshot not yet arrived
      if (Date.now() - lastFrameAt.current > STALE_AFTER_MS) {
        setStale((s) => (s ? s : true));
        setSseConnected((c) => c); // keep socket state as-is; staleness is separate
      }
    }, 1000);

    return () => {
      mountedRef.current = false;
      try {
        esRef.current?.close();
      } catch {
        /* ignore */
      }
      esRef.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (staleTimer.current) clearInterval(staleTimer.current);
      setSseConnected(false);
    };
  }, [enabled, nonce]);

  // Keep mountedRef true across StrictMode remount inner cleanup.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const freshness = (data?.freshnessState ?? '').toUpperCase();
  const live = !stale && freshness === 'LIVE';

  return { data, sseConnected, live, stale, lastUpdateAt, error, retry };
}
