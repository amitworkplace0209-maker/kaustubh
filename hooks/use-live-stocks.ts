'use client';

// Enhanced useLiveStocks hook — carries ALL available fields from the
// backend. Per-stock tick counting, stale detection, status computation.
// No fake data. Every value comes from the real backend.

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { subscribeTicks, subscribeSseState } from '@/lib/shared-sse';

export type StockStatus = 'LIVE' | 'STALE' | 'WAITING' | 'DISCONNECTED' | 'ERROR' | 'MARKET_CLOSED' | 'UNSUBSCRIBED';

export interface DepthRow {
  price: number | string;
  quantity: number | string;
  orders: number | string;
}

export interface LiveStock {
  symbol: string;
  tradingSymbol: string;
  token: string;
  exchange: string;
  exchangeSegment: string;
  instrumentType: string;
  companyName: string | null;

  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  ltq: number | null;

  bid: number | null;
  bidQty: number | null;
  ask: number | null;
  askQty: number | null;
  tbq: number | null;
  tsq: number | null;

  feedLevel: number | null;
  feedType: string | null;
  depth: { buy: DepthRow[]; sell: DepthRow[] } | null;

  avgPrice: number | null;
  oi: number | null;

  ts: string | null;
  receivedAt: string | null;

  subscribed: boolean;
  subscriptionState: string;
  subscriptionReason: string | null;
  requestStatus: string | null;

  wsSubscribed: boolean;
  wsConnected: boolean;
  wsLifecycleState: string | null;
  wsReason: string | null;

  tickCountToday: number;
  firstTickAt: string | null;

  isIndex: boolean;
  active: boolean;

  // Computed per-stock metrics (from frontend tracking)
  tickCount: number;
  lastTickAtMs: number | null;
  ticksPerSec: number;
  status: StockStatus;
}

export interface TickStats {
  ticksPerSecond: number;
  activeTickStocks: number;
  totalReceived: number;
  totalWritten: number;
  totalWriteErrors: number;
  lastTickAt: string | null;
  lastWriteAt: string | null;
  pipelineRunning: boolean;
  feedLatencyMs: number | null;
  pipelineState: string;
  feedState: string;
}

export interface UseLiveStocksOptions {
  restUrl?: string;
  pollMs?: number;
  sse?: boolean;
  staleThresholdMs?: number;
}

export interface UseLiveStocksResult {
  stocks: LiveStock[];
  bySymbol: Map<string, LiveStock>;
  connected: boolean;
  loading: boolean;
  lastMessageAt: number | null;
  marketClosed: boolean;
  marketSession: string;
  marketStatus: string;
  isTradingDay: boolean;
  schedulerState: string;
  tickStats: TickStats;
  totalTicksReceived: number;
  liveCount: number;
  staleCount: number;
  waitingCount: number;
  errorCount: number;
  refresh: () => void;
}

const STALE_MS = 15_000;
/** Slow reconcile while the shared tick stream is live (ms). */
const REST_RECONCILE_MS = 60_000;

function emptyStock(symbol: string): LiveStock {
  return {
    symbol, tradingSymbol: symbol, token: '',
    exchange: '', exchangeSegment: 'nse_cm', instrumentType: 'EQ',
    companyName: null,
    ltp: null, open: null, high: null, low: null, prevClose: null,
    change: null, changePct: null, volume: null, ltq: null,
    bid: null, bidQty: null, ask: null, askQty: null,
    tbq: null, tsq: null, feedLevel: null, feedType: null, depth: null,
    avgPrice: null, oi: null,
    ts: null, receivedAt: null,
    subscribed: false, subscriptionState: 'NOT_SUBSCRIBED',
    subscriptionReason: null, requestStatus: null,
    wsSubscribed: false, wsConnected: false,
    wsLifecycleState: null, wsReason: null,
    tickCountToday: 0, firstTickAt: null,
    isIndex: false, active: true,
    tickCount: 0, lastTickAtMs: null, ticksPerSec: 0,
    status: 'WAITING',
  };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function isoToMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function computeStatus(
  stock: LiveStock,
  nowMs: number,
  globalConnected: boolean,
  marketClosed: boolean,
): StockStatus {
  if (marketClosed && !globalConnected) return 'MARKET_CLOSED';
  if (!globalConnected && stock.tickCount === 0) return 'DISCONNECTED';
  if (!stock.subscribed && !stock.wsSubscribed) return 'UNSUBSCRIBED';
  if (stock.tickCount === 0) return 'WAITING';
  if (stock.lastTickAtMs != null && nowMs - stock.lastTickAtMs > STALE_MS) return 'STALE';
  if (stock.tickCount > 0 && stock.lastTickAtMs != null && nowMs - stock.lastTickAtMs <= STALE_MS) return 'LIVE';
  return 'WAITING';
}

export function useLiveStocks(opts: UseLiveStocksOptions = {}): UseLiveStocksResult {
  const {
    restUrl = '/api/phase2/ticks?limit=500',
    pollMs = 2000,
    sse = true,
    staleThresholdMs = STALE_MS,
  } = opts;

  const [bySymbol, setBySymbol] = useState<Map<string, LiveStock>>(new Map());
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [marketClosed, setMarketClosed] = useState(false);
  const [marketSession, setMarketSession] = useState('');
  const [marketStatus, setMarketStatus] = useState('');
  const [isTradingDay, setIsTradingDay] = useState(false);
  const [schedulerState, setSchedulerState] = useState('UNKNOWN');
  const [tickStats, setTickStats] = useState<TickStats>({
    ticksPerSecond: 0, activeTickStocks: 0, totalReceived: 0,
    totalWritten: 0, totalWriteErrors: 0, lastTickAt: null,
    lastWriteAt: null, pipelineRunning: false, feedLatencyMs: null,
    pipelineState: 'STOPPED', feedState: 'NO_FEED',
  });

  const pendingRef = useRef<Map<string, Partial<LiveStock>>>(new Map());
  const tickCountsRef = useRef<Map<string, { count: number; window: number[] }>>(new Map());
  const totalReceivedRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(restUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed');
      const d = await res.json();
      const rawTicks: any[] = Array.isArray(d?.ticks) ? d.ticks : [];

      setMarketClosed(Boolean(d.marketClosed));
      setMarketSession(str(d.marketSession) ?? '');
      setMarketStatus(str(d.marketStatus) ?? '');
      setIsTradingDay(Boolean(d.isTradingDay));
      setSchedulerState(str(d.schedulerState) ?? 'UNKNOWN');

      const ts: any = d.tickStats ?? {};
      setTickStats({
        ticksPerSecond: num(ts.ticksPerSecond) ?? 0,
        activeTickStocks: num(ts.activeTickStocks) ?? 0,
        totalReceived: num(ts.totalReceived) ?? 0,
        totalWritten: num(ts.totalWritten) ?? 0,
        totalWriteErrors: num(ts.totalWriteErrors) ?? 0,
        lastTickAt: str(ts.lastTickAt),
        lastWriteAt: str(ts.lastWriteAt),
        pipelineRunning: Boolean(ts.pipelineRunning),
        feedLatencyMs: num(ts.feedLatencyMs),
        pipelineState: str(ts.pipelineState) ?? 'STOPPED',
        feedState: str(ts.feedState) ?? 'NO_FEED',
      });
      totalReceivedRef.current = num(ts.totalReceived) ?? 0;

      setBySymbol((prev) => {
        const next = new Map<string, LiveStock>();
        for (const t of rawTicks) {
          if (!t?.symbol) continue;
          const k = String(t.symbol);
          const existing = prev.get(k);
          const nowMs = Date.now();
          const tickMs = isoToMs(t.ts ?? t.receivedAt);

          const tcRef = tickCountsRef.current.get(k);
          const tickCount = existing ? existing.tickCount + 1 : 1;
          const lastTickAtMs = tickMs ?? nowMs;

          next.set(k, {
            symbol: k,
            tradingSymbol: str(t.tradingSymbol) ?? k,
            token: String(t.token ?? ''),
            exchange: str(t.exchange) ?? 'NSE',
            exchangeSegment: str(t.exchangeSegment) ?? 'nse_cm',
            instrumentType: str(t.instrumentType) ?? 'EQ',
            companyName: str(t.companyName),
            ltp: num(t.ltp),
            open: num(t.open),
            high: num(t.high),
            low: num(t.low),
            prevClose: num(t.prevClose),
            change: num(t.change),
            changePct: num(t.changePct),
            volume: num(t.volume),
            ltq: num(t.ltq),
            bid: num(t.bid),
            bidQty: num(t.bidQty),
            ask: num(t.ask),
            askQty: num(t.askQty),
            tbq: num(t.tbq),
            tsq: num(t.tsq),
            feedLevel: num(t.feedLevel),
            feedType: str(t.feedType),
            depth: t.depth
              ? {
                  buy: Array.isArray(t.depth.buy) ? t.depth.buy : [],
                  sell: Array.isArray(t.depth.sell) ? t.depth.sell : [],
                }
              : null,
            avgPrice: num(t.avgPrice),
            oi: num(t.oi),
            ts: str(t.ts) ?? existing?.ts ?? null,
            receivedAt: str(t.receivedAt) ?? existing?.receivedAt ?? null,
            subscribed: Boolean(t.subscribed),
            subscriptionState: str(t.subscriptionState) ?? (t.subscribed ? 'ACTIVE' : 'NOT_SUBSCRIBED'),
            subscriptionReason: str(t.subscriptionReason),
            requestStatus: str(t.requestStatus),
            wsSubscribed: Boolean(t.wsSubscribed),
            wsConnected: Boolean(t.wsConnected),
            wsLifecycleState: str(t.wsLifecycleState),
            wsReason: str(t.wsReason),
            tickCountToday: num(t.tickCountToday) ?? 0,
            firstTickAt: str(t.firstTickAt),
            isIndex: Boolean(t.isIndex),
            active: t.active !== false,
            tickCount,
            lastTickAtMs,
            ticksPerSec: existing?.ticksPerSec ?? 0,
            status: 'LIVE',
          });
        }
        for (const [k, v] of prev) {
          if (!next.has(k)) next.set(k, v);
        }
        return next;
      });
    } catch {
      // keep last known state
    } finally {
      setLoading(false);
    }
  }, [restUrl]);

  // The shared tick stream (one SSE session) is the primary per-symbol update
  // path; the REST snapshot is the fallback + a slow reconcile so a row's
  // heavy context (depth, tick counters, subscription reason) still refreshes
  // while the stream is live, and the row list is rebuilt fast when it is not.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (pollMs <= 0) return;
    let lastReconcile = Date.now();
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      // Stream live → slow reconcile; stream down → the caller's cadence.
      if (connected && now - lastReconcile < REST_RECONCILE_MS) return;
      lastReconcile = now;
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs, connected]);

  // SSE merge — uses the SHARED single SSE stream (one per session),
  // updates existing per-symbol state from the central feed.
  useEffect(() => {
    if (!sse) return;
    let disposed = false;

    const unsubTicks = subscribeTicks((t) => {
      if (!t?.symbol) return;
      const s = String(t.symbol);
      const nowMs = Date.now();
      const tickMs = isoToMs(t.ts) ?? nowMs;

      const entry: Partial<LiveStock> = { symbol: s };
      if (typeof t.ltp === 'number') entry.ltp = t.ltp;
      if (typeof t.change === 'number') entry.change = t.change;
      if (typeof t.changePercent === 'number') entry.changePct = t.changePercent;
      if (typeof t.open === 'number') entry.open = t.open;
      if (typeof t.high === 'number') entry.high = t.high;
      if (typeof t.low === 'number') entry.low = t.low;
      if (typeof t.close === 'number') entry.prevClose = t.close;
      if (typeof t.volume === 'number') entry.volume = t.volume;
      else if (typeof t.v === 'number') entry.volume = t.v;
      if (typeof t.ltq === 'number') entry.ltq = t.ltq;
      if (typeof t.tbq === 'number') entry.tbq = t.tbq;
      if (typeof t.tsq === 'number') entry.tsq = t.tsq;
      if (typeof t.bp === 'number') entry.bid = t.bp;
      if (typeof t.bq === 'number') entry.bidQty = t.bq;
      if (typeof t.sp === 'number') entry.ask = t.sp;
      if (typeof t.bs === 'number') entry.askQty = t.bs;
      if (typeof t.averagePrice === 'number') entry.avgPrice = t.averagePrice;
      if (typeof t.oi === 'number') entry.oi = t.oi;
      entry.ts = str(t.ts) ?? str(t.timestamp);
      entry.receivedAt = str(t.receivedAt) ?? new Date().toISOString();
      entry.lastTickAtMs = tickMs;

      pendingRef.current.set(s, entry);
      setLastMessageAt(nowMs);
      totalReceivedRef.current += 1;
    });

    const unsubState = subscribeSseState((st) => {
      if (!disposed) setConnected(st.connected);
    });

    const flush = setInterval(() => {
      if (pendingRef.current.size === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = new Map();
      setBySymbol((prev) => {
        const next = new Map(prev);
        for (const [k, patch] of batch) {
          const existing = next.get(k);
          const tickMs = patch.lastTickAtMs ?? existing?.lastTickAtMs;
          const tickCount = (existing?.tickCount ?? 0) + 1;

          next.set(k, {
            ...(existing ?? emptyStock(k)),
            ...patch,
            symbol: k,
            tickCount,
            lastTickAtMs: tickMs ?? null,
            ticksPerSec: existing?.ticksPerSec ?? 0,
          });
        }
        return next;
      });
    }, 1000);

    return () => {
      disposed = true;
      clearInterval(flush);
      unsubTicks();
      unsubState();
      setConnected(false);
    };
  }, [sse]);

  // Tick rate calculation — once per second.
  useEffect(() => {
    const tickWindow: Map<string, number[]> = new Map();
    const interval = setInterval(() => {
      const nowMs = Date.now();
      setBySymbol((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [k, stock] of next) {
          if (stock.lastTickAtMs && nowMs - stock.lastTickAtMs < 2000) {
            const window = tickWindow.get(k) ?? [];
            window.push(nowMs);
            const cutoff = nowMs - 10_000;
            while (window.length > 0 && window[0] < cutoff) window.shift();
            tickWindow.set(k, window);
            const rate = window.length / Math.min(10, (nowMs - window[0]) / 1000);
            if (stock.ticksPerSec !== rate) {
              next.set(k, { ...stock, ticksPerSec: Math.round(rate * 10) / 10 });
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Recompute statuses whenever bySymbol or connected changes.
  const result = useMemo(() => {
    const nowMs = Date.now();
    let liveCount = 0;
    let staleCount = 0;
    let waitingCount = 0;
    let errorCount = 0;

    const updatedStocks = new Map<string, LiveStock>();
    for (const [k, stock] of bySymbol) {
      const status = computeStatus(stock, nowMs, connected, marketClosed);
      updatedStocks.set(k, { ...stock, status });
      switch (status) {
        case 'LIVE': liveCount++; break;
        case 'STALE': staleCount++; break;
        case 'WAITING': waitingCount++; break;
        case 'ERROR': errorCount++; break;
        default: break;
      }
    }

    return {
      stocks: Array.from(updatedStocks.values()),
      bySymbol: updatedStocks,
      liveCount,
      staleCount,
      waitingCount,
      errorCount,
    };
  }, [bySymbol, connected, marketClosed]);

  return {
    ...result,
    connected,
    loading,
    lastMessageAt,
    marketClosed,
    marketSession,
    marketStatus,
    isTradingDay,
    schedulerState,
    tickStats,
    totalTicksReceived: totalReceivedRef.current,
    refresh,
  };
}
