'use client';

// ---- Data Center status hooks (Downloads / legacy consumers) ----
//
// The `useDataCenter` model used by the older Data Center surfaces (downloads
// page: summary cards, stock selection, health panel) polls the REAL backend
// `/api/system` through the light `/api/phase2/system` proxy and derives ONE
// normalized `DataCenterStatus` + `HealthRow[]`. Live-ness and stability come
// straight from real measurements — a missing value is null and renders "N/A"
// on the consumer side; nothing is fabricated.
//
// Lives in its own module (imports React) so the pure normalizers in
// `lib/data-center.ts` stay `node --test`-friendly.

import { useEffect, useState, useSyncExternalStore } from 'react';

export const TICK_STALE_MS = 10_000; // a tick older than this is "stale" in lists

const POLL_MS = 10_000;
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 30_000;

export type TrendDirection = 'rising' | 'stable' | 'falling';
export type HealthState = 'ok' | 'degraded' | 'failed' | 'unavailable';
export type LiveFreshness = 'live' | 'stale' | 'offline' | 'connecting';

export interface HealthRow {
  key: 'database' | 'tick-stream' | 'tick-storage' | 'tick-buffer' | 'websocket' | 'scheduler';
  state: HealthState;
  value: string;
  detail: string;
}

export interface DataCenterStatus {
  online: boolean;
  generatedAt: string | null;
  totalStocks: number | null;
  activeStocks: number | null;
  database: { connected: boolean; dbName: string | null };
  tickStream: {
    tickRatePerSec: number | null;
    trend: TrendDirection;
    rollingWindowSec: number;
    feedLatencyMs: number | null;
  };
  webSocket: {
    connected: boolean;
    subscribedSymbols: number | null;
    disconnectReason: string | null;
  };
  scheduler: { running: boolean; state: string | null; lastRun: string | null };
  tickStorage: { todayRecords: number | null; todayInserts: number | null; errorCount: number | null };
  tickBuffer: { bufferLength: number | null; bufferCapacity: number | null };
  storage: { diskPercent: number | null; diskUsedBytes: number | null; diskTotalBytes: number | null };
}

// ---- primitives -----------------------------------------------------------

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function fmtNum(v: number | null): string {
  return v == null ? '\u2014' : v.toLocaleString('en-IN');
}

function shortTime(isoStr: string | null): string {
  if (!isoStr) return '\u2014';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '\u2014';
  return d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

/** Rate label: enough precision for sparse ticks, plain numbers for fast. */
export function formatRate(rate: number): string {
  if (rate == null || !Number.isFinite(rate)) return 'N/A';
  if (rate >= 100) return String(Math.round(rate));
  if (rate >= 10) return rate.toFixed(1);
  return rate.toFixed(2);
}

/** Local clock that ticks on the requested interval (for staleness checks). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), Math.max(intervalMs, 1000));
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ---- normalization ---------------------------------------------------------

function normalizeStatus(raw: unknown): DataCenterStatus {
  const o = (raw ?? {}) as Record<string, unknown>;
  const node = (o.node ?? {}) as Record<string, unknown>;
  const buffer = (o.buffer ?? {}) as Record<string, unknown>;
  const ws = (o.websocketDetail ?? {}) as Record<string, unknown>;
  const sched = (o.schedulerInfo ?? {}) as Record<string, unknown>;
  const schedState = (o.schedulerState ?? {}) as Record<string, unknown>;
  const liveData = (o.liveData ?? {}) as Record<string, unknown>;

  const trendRaw = String(buffer.tickRateTrend ?? 'stable').toLowerCase();
  const trend: TrendDirection =
    trendRaw === 'rising' || trendRaw === 'falling' ? trendRaw : 'stable';

  return {
    online: Boolean(o.internetConnected ?? (o.node as Record<string, unknown>).status === 'ok'),
    generatedAt: str(o.generatedAt),
    totalStocks: int(o.totalStocks),
    activeStocks: int(o.activeStocks),
    database: {
      connected: Boolean((o.mongo as Record<string, unknown>)?.connected ?? o.websocketConnected),
      dbName: str(o.mongoDbName),
    },
    tickStream: {
      tickRatePerSec: num(liveData.ticksPerSecond ?? buffer.ticksPerSecond),
      trend,
      rollingWindowSec: int(buffer.rollingWindowSec) ?? 10,
      feedLatencyMs: num(o.feedLatencyMs),
    },
    webSocket: {
      connected: Boolean(ws.connected ?? o.websocketConnected),
      subscribedSymbols: int(ws.subscribed_symbols ?? ws.subscribedSymbols),
      disconnectReason: str(o.wsDisconnectReason ?? ws.disconnect_reason),
    },
    scheduler: {
      running: Boolean(sched.running ?? schedState.running),
      state: str(schedState.state ?? schedState.status ?? sched.running_state ?? sched.state),
      lastRun: str(schedState.last_run ?? schedState.lastRun ?? sched.last_run ?? sched.lastRun),
    },
    tickStorage: {
      todayRecords: int(o.todayRecords),
      todayInserts: int(o.todayInserts),
      errorCount: int(o.errorCount),
    },
    tickBuffer: {
      bufferLength: int(buffer.bufferLength),
      bufferCapacity: int(buffer.bufferMaxSize ?? buffer.bufferCapacity),
    },
    storage: {
      diskPercent: num(node.diskPercent),
      diskUsedBytes: int(node.diskUsedBytes),
      diskTotalBytes: int(node.diskTotalBytes),
    },
  };
}

/** Six service rows — every state/value derives from REAL measurements. */
export function deriveHealthRows(
  status: DataCenterStatus | null,
  opts: { sseConnected: boolean; nowMs?: number },
): HealthRow[] {
  if (!status) return [];

  const db = status.database;
  const rate = status.tickStream.tickRatePerSec;
  const feed = status.tickStream.feedLatencyMs;
  const ts = status.tickStorage;
  const tb = status.tickBuffer;
  const ws = status.webSocket;
  const sc = status.scheduler;

  const bufferUtil =
    tb.bufferCapacity != null && tb.bufferCapacity > 0 && tb.bufferLength != null
      ? tb.bufferLength / tb.bufferCapacity
      : null;

  const rows: HealthRow[] = [
    {
      key: 'database',
      state: db.connected ? 'ok' : 'unavailable',
      value: db.connected ? 'Up' : 'Timeout',
      detail: db.connected ? db.dbName ?? 'MongoDB connected' : 'MongoDB unreachable',
    },
    {
      key: 'tick-stream',
      state: rate != null && rate > 0 ? 'ok' : opts.sseConnected ? 'degraded' : 'failed',
      value: rate != null ? `${formatRate(rate)}/s` : 'Idle',
      detail: feed != null
        ? `${feed.toFixed(0)}ms feed lag`
        : opts.sseConnected
          ? 'SSE stream connected'
          : 'No live tick stream',
    },
    {
      key: 'tick-storage',
      state: ts.errorCount != null && ts.errorCount > 0 ? 'degraded' : ts.todayInserts != null ? 'ok' : 'unavailable',
      value: ts.todayInserts != null ? `${fmtNum(ts.todayInserts)} saved` : '\u2014',
      detail: ts.errorCount != null && ts.errorCount > 0
        ? `${fmtNum(ts.errorCount)} write errors`
        : ts.todayRecords != null
          ? `${fmtNum(ts.todayRecords)} records today`
          : 'No ticks today',
    },
    {
      key: 'tick-buffer',
      state: bufferUtil != null && bufferUtil >= 0.8 ? 'degraded' : tb.bufferLength != null ? 'ok' : 'unavailable',
      value: `${tb.bufferLength != null ? fmtNum(tb.bufferLength) : '\u2014'}${tb.bufferCapacity != null ? ` / ${fmtNum(tb.bufferCapacity)}` : ''}`,
      detail: `buffered ticks \u00B7 ${status.tickStream.rollingWindowSec}s window`,
    },
    {
      key: 'websocket',
      state: ws.connected ? 'ok' : ws.disconnectReason ? 'failed' : 'unavailable',
      value: ws.connected ? 'Connected' : 'Disconnected',
      detail: ws.connected
        ? ws.subscribedSymbols != null ? `${fmtNum(ws.subscribedSymbols)} subscribed` : 'websocket connected'
        : ws.disconnectReason ?? 'Not connected',
    },
    {
      key: 'scheduler',
      state: sc.running ? 'ok' : 'unavailable',
      value: sc.running ? 'Running' : 'Stopped',
      detail: sc.lastRun ? `last run ${shortTime(sc.lastRun)}` : sc.state ?? 'no runs yet',
    },
  ];
  void opts.nowMs;
  return rows;
}

// ---- store ----------------------------------------------------------------

export interface DataCenterHook {
  status: DataCenterStatus | null;
  error: string | null;
  loading: boolean;
  now: number;
  lastSuccessAt: number | null;
  freshness: LiveFreshness;
  refresh: () => Promise<void>;
}

interface StoreState {
  status: DataCenterStatus | null;
  error: string | null;
  loading: boolean;
  now: number;
  lastSuccessAt: number | null;
  freshness: LiveFreshness;
}

const INITIAL: StoreState = {
  status: null,
  error: null,
  loading: true,
  now: Date.now(),
  lastSuccessAt: null,
  freshness: 'connecting',
};

function computeFreshness(s: Omit<StoreState, 'freshness'>): LiveFreshness {
  if (s.status == null && s.error != null && !s.loading) return 'offline';
  if (s.status == null) return s.loading ? 'connecting' : 'offline';
  if (s.lastSuccessAt == null) return 'connecting';
  return Date.now() - s.lastSuccessAt <= STALE_AFTER_MS ? 'live' : 'stale';
}

class DataCenterStatusStore {
  private state: StoreState = { ...INITIAL };
  private snapshot: StoreState = this.state;
  private listeners = new Set<() => void>();
  private busy = false;
  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private inflightController: AbortController | null = null;

  constructor() {
    // Lazy start: only begin polling when the first subscriber attaches.
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.started && typeof window !== 'undefined') {
      this.startTimers();
    }
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): StoreState => this.snapshot;

  private setState(patch: Partial<StoreState>): void {
    const merged = { ...this.state, ...patch };
    merged.freshness = computeFreshness(merged);
    this.state = merged;
    this.snapshot = this.state;
    this.listeners.forEach((l) => l());
  }

  private startTimers(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void this.refresh();
    }, POLL_MS);
    this.heartbeatTimer = setInterval(() => {
      this.setState({ now: Date.now() });
    }, HEARTBEAT_MS);
  }

  async refresh(force = false): Promise<void> {
    if (this.busy && !force) return;
    if (!this.started && typeof window !== 'undefined') {
      this.startTimers();
      return;
    }
    this.busy = true;
    this.setState({ loading: true });
    this.inflightController?.abort();
    const controller = new AbortController();
    this.inflightController = controller;
    try {
      const res = await fetch('/api/phase2/system', { signal: controller.signal });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      if (controller.signal.aborted) return;
      this.setState({
        status: normalizeStatus(data),
        error: null,
        loading: false,
        lastSuccessAt: Date.now(),
        now: Date.now(),
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      this.setState({
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to reach the status endpoint',
      });
    } finally {
      this.busy = false;
      if (this.inflightController === controller) this.inflightController = null;
      if (!controller.signal.aborted) this.setState({});
    }
  }
}

const store = new DataCenterStatusStore();

/** Shared status hook for the downloads Data Center surface. */
export function useDataCenter(): DataCenterHook {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    status: s.status,
    error: s.error,
    loading: s.loading,
    now: s.now,
    lastSuccessAt: s.lastSuccessAt,
    freshness: s.freshness,
    refresh: () => store.refresh(true),
  };
}