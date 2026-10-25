'use client';

// Data Saver — Stock Subscription.
//
// REAL-TIME
// The list is patched straight off the shared SSE tick stream (/api/ticks/stream):
// LTP, change, volume, OHLC and "last tick" update per symbol the moment a tick
// arrives, with a flash on the price move. The 5s poll still runs, but it now only
// refreshes registry facts (subscription state, counts, master) — the prices are
// no longer waiting on it.
//
// LOOK
// Creamy, theme-aware surfaces on the same `ds-*` system as the dashboard, over
// a slow drifting aurora field.
//
// HONESTY
// Nothing here is inferred: a metric the backend cannot measure shows "Not
// available" — never a 0 and never a guess.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, BarChart3, CheckCircle2, ChevronRight, Clock, Database,
  Info, Loader2, LogIn, Plus, Radio, RefreshCw, Search, Square, SquareCheck,
  TrendingDown, TrendingUp, Wifi, WifiOff, X, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { SectionHeading, StatusBadge, EmptyState, LoadingState } from '@/components/design-system';
import { subscribeTicks, subscribeSseState } from '@/lib/shared-sse';
import { triggerLogin } from '@/lib/api';
import { getCached, clearCache } from '@/lib/request-cache';
import { useDataSaver } from '@/components/phase2/data-saver-provider';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';
import { SEARCH_SUGGESTION_LIMIT, type CanonicalInstrument } from '@/lib/instrument-search';
import { cn } from '@/lib/utils';

/* ========================================================================== */
/* Types (all derived from the REAL backend — nothing fabricated)              */
/* ========================================================================== */

interface Subscription {
  symbol: string;
  exchange: string;
  token: string;
  type: string;
  companyName: string;
  tradingSymbol: string;
  isin: string;
  status: string;
  requestStatus: string;
  subscribedAt: string | null;
  wsConnected: boolean;
  wsState: string | null;
  wsReason: string | null;
  tickCountToday: number | null;
  lastTick: string | null;
  ticksPerSec: number | null;
  ltp: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prevClose: number | null;
  volume: number | null;
  marketAvailable: boolean;
  instrumentMasterAvailable: boolean;
  market: MarketContext | null;
  selected?: boolean;
}

interface MarketContext {
  status: string | null; session: string | null; date: string | null;
  dayClass: string | null; tradingDay: boolean | null; closureReason: string | null;
}

interface InstrumentMasterState {
  state: string | null; source: string | null; instrumentCount: number | null;
  nseEqCount: number | null; lastLoadAt: string | null; reason: string | null; loaded: boolean;
}

type WebSocketState = 'ACTIVE' | 'PENDING' | 'INACTIVE';
type DataState = 'LIVE' | 'STALE' | 'NO_DATA' | 'INACTIVE';
type SubscriptionState = 'ACTIVE' | 'PENDING' | 'INACTIVE' | 'FAILED';
type Freshness = 'LIVE' | 'STALE' | 'NO_DATA' | 'NOT_SUBSCRIBED';
type StateTone = 'success' | 'warning' | 'danger' | 'neutral';

interface StockStats {
  totalSubscriptions: number; active: number; inactive: number;
  wsConnectedSubscriptions: number; wsSubscribed: number; wsNotSubscribed: number;
  live: number; stale: number; noData: number; ticksToday: number;
  ticksPerSecond: number | null; activeTickStocks: number;
  websocketConnected: boolean; websocketReason?: string | null;
  instrumentMasterLoaded: boolean; instrumentCount: number;
}

/* ========================================================================== */
/* Formatting — never a fake "--"; show "Not available" instead.                */
/* ========================================================================== */

const notAvail = 'Not available';

/** Slow REST reconcile for the subscription list while the tick stream is live (ms). */
const LIST_RECONCILE_MS = 60_000;

function numOf(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmtPrice(v: number | null | undefined): string {
  return numOf(v) == null ? notAvail : numOf(v)!.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtChange(v: number | null | undefined): string {
  const n = numOf(v);
  if (n == null) return notAvail;
  return `${n > 0 ? '+' : ''}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtNumber(v: number | null | undefined): string {
  const n = numOf(v);
  return n == null ? notAvail : n.toLocaleString('en-IN');
}
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return notAvail;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return notAvail;
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return notAvail;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return notAvail;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}
/** Seconds since an ISO timestamp; null when unparseable. UI clock only. */
function ageOf(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

function changeToneClass(v: number | null | undefined): string {
  const n = numOf(v);
  if (n == null || n === 0) return 'text-muted-foreground';
  return n > 0 ? 'text-success' : 'text-destructive';
}
function ChangeIcon({ v }: { v: number | null | undefined }) {
  const n = numOf(v);
  if (n == null || n === 0) return null;
  return n > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />;
}
function isLive(wsConnected: boolean, lastTick: string | null): boolean {
  if (!wsConnected || !lastTick) return false;
  return Date.now() - Date.parse(lastTick) < 10_000;
}
function freshnessOf(s: Subscription): Freshness {
  if (s.status === 'inactive') return 'NOT_SUBSCRIBED';
  if (!s.marketAvailable || !s.lastTick) return 'NO_DATA';
  return isLive(s.wsConnected, s.lastTick) ? 'LIVE' : 'STALE';
}
function subscriptionStateOf(s: Subscription): SubscriptionState {
  if (s.status === 'inactive') return 'INACTIVE';
  const rs = String(s.requestStatus ?? '').toLowerCase();
  if (rs === 'failed' || rs === 'error') return 'FAILED';
  if (rs === 'pending' || rs === 'queued') return 'PENDING';
  return 'ACTIVE';
}
function wsStateOf(s: Subscription): WebSocketState {
  if (s.wsConnected) return 'ACTIVE';
  const st = String(s.wsState ?? '').toLowerCase();
  return st === 'pending' || st === 'connecting' ? 'PENDING' : 'INACTIVE';
}
function dataStateOf(s: Subscription): DataState {
  const f = freshnessOf(s);
  return f === 'NOT_SUBSCRIBED' ? 'INACTIVE' : f;
}
function stateTone(state: string): StateTone {
  const s = String(state).toUpperCase();
  if (['ACTIVE', 'LOADED', 'CONNECTED', 'LIVE', 'OK', 'READY', 'COMPLETE'].includes(s)) return 'success';
  if (['PENDING', 'STALE', 'PARTIAL', 'DEGRADED'].includes(s)) return 'warning';
  if (['FAILED', 'INACTIVE', 'DISCONNECTED', 'ERROR', 'NOT_AVAILABLE'].includes(s)) return 'danger';
  return 'neutral';
}
function stateLabel(state: string, connected: boolean | null): string {
  if (connected === true && ['ACTIVE', 'CONNECTED', 'LIVE'].includes(String(state).toUpperCase())) return 'Connected';
  return String(state).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ========================================================================== */
/* Surfaces                                                                    */
/* ========================================================================== */

function Aurora() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="ds-drift-a absolute -left-32 -top-32 h-[34rem] w-[34rem] rounded-full bg-primary/10 blur-[110px]" />
      <div className="ds-drift-b absolute -right-40 top-20 h-[36rem] w-[36rem] rounded-full bg-info/10 blur-[120px]" />
      <div className="ds-drift-c absolute -bottom-40 left-1/3 h-[30rem] w-[30rem] rounded-full bg-success/8 blur-[120px]" />
    </div>
  );
}

const ACCENT: Record<string, { rail: string; chip: string; text: string }> = {
  amber: { rail: 'from-amber-400/70 to-orange-400/40', chip: 'from-amber-400/90 to-orange-500/80', text: 'text-amber-600 dark:text-amber-400' },
  teal: { rail: 'from-teal-400/70 to-emerald-400/40', chip: 'from-teal-400/90 to-emerald-500/80', text: 'text-teal-600 dark:text-teal-400' },
  violet: { rail: 'from-violet-400/70 to-purple-400/40', chip: 'from-violet-400/90 to-purple-500/80', text: 'text-violet-600 dark:text-violet-400' },
  sky: { rail: 'from-sky-400/70 to-blue-400/40', chip: 'from-sky-400/90 to-blue-500/80', text: 'text-sky-600 dark:text-sky-400' },
  emerald: { rail: 'from-emerald-400/70 to-teal-400/40', chip: 'from-emerald-400/90 to-teal-500/80', text: 'text-emerald-600 dark:text-emerald-400' },
  slate: { rail: 'from-slate-400/60 to-slate-300/30', chip: 'from-slate-400/90 to-slate-500/80', text: 'text-slate-600 dark:text-slate-300' },
};

const TONE_PILL: Record<StateTone, string> = {
  success: 'border-success/25 bg-success/10 text-success',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  danger: 'border-destructive/25 bg-destructive/10 text-destructive',
  neutral: 'border-border/60 bg-muted/40 text-muted-foreground',
};
const TONE_TEXT: Record<StateTone, string> = {
  success: 'text-success', warning: 'text-warning',
  danger: 'text-destructive', neutral: 'text-muted-foreground',
};
const TONE_DOT: Record<StateTone, string> = {
  success: 'bg-success', warning: 'bg-warning',
  danger: 'bg-destructive', neutral: 'bg-muted-foreground/40',
};

function SoftCard({ accent = 'slate', children, className, lift = false, index }: {
  accent?: string; children: React.ReactNode; className?: string; lift?: boolean; index?: number;
}) {
  const a = ACCENT[accent] ?? ACCENT.slate;
  return (
    <div
      style={index != null ? ({ '--ds-i': index } as React.CSSProperties) : undefined}
      className={cn(
        'ds-card relative overflow-hidden rounded-2xl border border-border/50 bg-card/75 shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] backdrop-blur-xl',
        lift && 'ds-lift', index != null && 'ds-rise', className,
      )}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2.5px] bg-gradient-to-r', a.rail)} />
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-52 w-52 rounded-full bg-primary opacity-[0.04] blur-3xl" />
      {children}
    </div>
  );
}

function PulseDot({ tone, live }: { tone: StateTone; live?: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {live && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-50', TONE_DOT[tone])} />}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', TONE_DOT[tone])} />
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/30 py-[5px] last:border-0">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[11px] font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/* ========================================================================== */
/* Page                                                                        */
/* ========================================================================== */

export default function Phase2SubscriptionPage() {
  const { sessionActive, refresh: refreshWorkspace } = useDataSaver();

  const [loading, setLoading] = useState(true);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [stats, setStats] = useState<StockStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [group, setGroup] = useState<'All' | 'My Stocks'>('All');
  const [instrumentMasterAvailable, setInstrumentMasterAvailable] = useState(false);
  const [masterState, setMasterState] = useState<InstrumentMasterState | null>(null);
  const [market, setMarket] = useState<MarketContext | null>(null);

  // ---- Real-time ----
  const [streamConnected, setStreamConnected] = useState(false);
  /** Read inside the interval callback without re-installing the timer. */
  const streamConnectedRef = useRef(false);
  streamConnectedRef.current = streamConnected;
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const [ticksSeen, setTicksSeen] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedResult, setSelectedResult] = useState<CanonicalInstrument | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeMsg, setSubscribeMsg] = useState<string | null>(null);
  const [subscribeMsgTone, setSubscribeMsgTone] = useState<'ok' | 'warn' | 'err'>('ok');

  const [details, setDetails] = useState<any | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const [confirm, setConfirm] = useState<{ type: 'single' | 'bulk'; symbols: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'warn' | 'err'; message: string } | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const mountedRef = useRef(true);
  const pollingRef = useRef(false);
  const subsRef = useRef<Subscription[]>([]);
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Browser clock — UI only, drives the live "x s ago" tick age.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { subsRef.current = subscriptions; }, [subscriptions]);

  const {
    results, status: searchStatus, error: searchError, errorCode: searchErrorCode, clear: clearSearch,
  } = useInstrumentSearch(query, { limit: SEARCH_SUGGESTION_LIMIT });

  const searching = searchStatus === 'debouncing' || searchStatus === 'loading';
  const indexUnavailable = searchErrorCode === 'SEARCH_INDEX_UNAVAILABLE';
  const searchHint = indexUnavailable
    ? 'The NSE instrument master is not loaded yet. It is loaded automatically after a broker login.'
    : null;
  const searchErrorText = indexUnavailable ? null : searchError;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /* ---- Live tick stream: patch each subscribed symbol as ticks arrive ---- */
  useEffect(() => {
    // Captured once so the cleanup always clears the map it was writing to,
    // even if the ref is reassigned before the effect tears down.
    const timers = flashTimers.current;
    const offState = subscribeSseState((s) => setStreamConnected(s.connected));
    const offTicks = subscribeTicks((frame: Record<string, unknown>) => {
      const token = String(frame.tk ?? frame.instrumentToken ?? frame.token ?? '');
      if (!token) return;
      const cur = subsRef.current.find((s) => String(s.token) === token);
      if (!cur) return;

      const nextLtp = numOf(frame.ltp ?? frame.last_price) ?? cur.ltp;
      const prevLtp = cur.ltp;
      if (nextLtp != null && prevLtp != null && nextLtp !== prevLtp) {
        const dir = nextLtp > prevLtp ? 'up' : 'down';
        setFlash((p) => ({ ...p, [token]: dir }));
        const old = flashTimers.current.get(token);
        if (old) clearTimeout(old);
        flashTimers.current.set(token, setTimeout(() => {
          setFlash((p) => { const n = { ...p }; delete n[token]; return n; });
        }, 900));
      }

      const lastTick = typeof frame.ts === 'string'
        ? frame.ts
        : typeof frame.receivedAt === 'string' ? frame.receivedAt : null;

      setSubscriptions((prev) => prev.map((s) => (String(s.token) === token ? {
        ...s,
        ltp: nextLtp,
        change: numOf(frame.change) ?? s.change,
        changePercent: numOf(frame.changePercent ?? frame.changePct) ?? s.changePercent,
        volume: numOf(frame.volume) ?? s.volume,
        high: numOf(frame.high) ?? s.high,
        low: numOf(frame.low) ?? s.low,
        open: numOf(frame.open) ?? s.open,
        prevClose: numOf(frame.close) ?? s.prevClose,
        marketAvailable: true,
        wsConnected: true,
        lastTick: lastTick ?? s.lastTick,
      } : s)));
      setTicksSeen((n) => n + 1);
    });

    return () => {
      offState();
      offTicks();
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const showToast = useCallback((tone: 'ok' | 'warn' | 'err', message: string) => {
    setToast({ tone, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchData = useCallback(async () => {
    if (pollingRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    pollingRef.current = true;
    try {
      const [subRes, statRes] = await Promise.all([
        getCached('phase2/subscriptions', () =>
          fetch('/api/phase2/subscriptions', { cache: 'no-store' }).then(async (r) => {
            const d = await r.json().catch(() => null);
            return { status: r.status, data: d };
          }),
          { maxAgeMs: 12000, swrMs: 30000 },
        ),
        getCached('phase2/stock-stats', () =>
          fetch('/api/phase2/stock-stats', { cache: 'no-store' }).then(async (r) => {
            const d = await r.json().catch(() => null);
            return { status: r.status, data: d };
          }),
          { maxAgeMs: 12000, swrMs: 30000 },
        ),
      ]);
      if (!mountedRef.current) return;
      let subs: Subscription[] = [];
      let st: StockStats | null = null;
      let masterAvail = false;
      if (subRes.data != null) {
        const d = subRes.data as any;
        subs = Array.isArray(d.subscriptions) ? d.subscriptions : [];
        masterAvail = Boolean(d.instrumentMasterAvailable);
        setMasterState(d.instrumentMasterState ?? null);
        setMarket(d.market ?? null);
      } else {
        setLoadError('Failed to load subscriptions');
      }
      if (statRes.data != null) st = (statRes.data as any).stats ?? null;
      if (!mountedRef.current) return;
      setSubscriptions((prev) => {
        const selected = new Set(prev.filter((p) => p.selected).map((p) => p.symbol));
        // Prices already patched by the live stream are kept when the poll has
        // no fresher value, so a slow poll can never blank a live price.
        return subs.map((s) => {
          const prevRow = prev.find((p) => p.token === s.token);
          const keepLive = prevRow && prevRow.lastTick && (!s.lastTick || Date.parse(prevRow.lastTick) > Date.parse(s.lastTick));
          return {
            ...s,
            selected: selected.has(s.symbol),
            ...(keepLive ? {
              ltp: prevRow.ltp, change: prevRow.change, changePercent: prevRow.changePercent,
              volume: prevRow.volume, high: prevRow.high, low: prevRow.low,
              open: prevRow.open, lastTick: prevRow.lastTick,
            } : {}),
          };
        });
      });
      setStats(st);
      setInstrumentMasterAvailable(masterAvail);
      setLoading(false);
      setLoadError(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setLoading(false);
      setLoadError(e?.message ?? 'Failed to load subscriptions');
    } finally {
      pollingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let lastReconcile = Date.now();
    fetchData();
    // The live LTP arrives over the shared tick stream, and the subscription
    // list itself only changes when THIS page subscribes/unsubscribes, so the
    // REST poll is a fallback: 5 s only while the stream is down, a 60 s
    // reconcile while it is live.
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (streamConnectedRef.current && Date.now() - lastReconcile < LIST_RECONCILE_MS) return;
      lastReconcile = Date.now();
      fetchData();
    }, 5000);
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      lastReconcile = Date.now();
      fetchData();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchData]);

  const handleSubscribe = async () => {
    if (!selectedResult) return;
    setSubscribing(true);
    setSubscribeMsg(null);
    try {
      const res = await fetch('/api/phase2/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: selectedResult.symbol, instrumentToken: selectedResult.token }),
      });
      const d = await res.json();
      if (!res.ok) {
        setSubscribeMsgTone('err');
        setSubscribeMsg(d.error ?? 'Subscription rejected');
      } else if (d.status === 'already_subscribed') {
        setSubscribeMsgTone('warn');
        setSubscribeMsg(`Already subscribed to ${selectedResult.symbol}.`);
      } else {
        setSubscribeMsgTone('ok');
        setSubscribeMsg(d.reason ?? `Subscribed to ${selectedResult.symbol}.`);
        clearCache('phase2/subscriptions');
        clearCache('phase2/stock-stats');
        fetchData();
      }
    } catch {
      setSubscribeMsgTone('err');
      setSubscribeMsg('Subscription request failed');
    } finally {
      if (mountedRef.current) setSubscribing(false);
    }
  };

  const openDetails = async (symbol: string) => {
    setDetailsOpen(true);
    setDetailsLoading(true);
    setDetailsError(null);
    setDetails(null);
    try {
      const res = await fetch(`/api/phase2/stock-details?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
      const d = await res.json();
      if (!mountedRef.current) return;
      if (!res.ok) { setDetailsError(d.reason ?? 'Details unavailable'); setDetails(null); }
      else setDetails(d);
    } catch {
      if (!mountedRef.current) return;
      setDetailsError('Details request failed');
    } finally {
      if (mountedRef.current) setDetailsLoading(false);
    }
  };

  const toggleSelect = (symbol: string) =>
    setSubscriptions((prev) => prev.map((s) => (s.symbol === symbol ? { ...s, selected: !s.selected } : s)));

  const toggleSelectAll = () => {
    const all = filtered.length > 0 && filtered.every((s) => s.selected);
    const sel = new Set(filtered.map((s) => s.symbol));
    setSubscriptions((prev) => prev.map((s) => (sel.has(s.symbol) ? { ...s, selected: !all } : s)));
  };

  const clearSelection = () => setSubscriptions((prev) => prev.map((s) => ({ ...s, selected: false })));

  const handleManualLogin = async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    try {
      const res: any = await triggerLogin();
      // The backend answers `{ ok, message }`. Read `ok` explicitly — the old
      // `res && res.ok !== false` treated ANY non-object response (an HTML error
      // page, a 200 with the wrong body) as success and showed a green toast
      // for a login that never happened.
      const ok = res != null && typeof res === 'object' && res.ok === true;
      const message =
        typeof res?.message === 'string' && res.message.trim()
          ? res.message.trim()
          : ok
            ? 'Login successful'
            : 'Login request was rejected';
      showToast(ok ? 'ok' : 'err', message);
      if (ok) {
        clearCache('phase2/subscriptions');
        clearCache('phase2/stock-stats');
        // `sessionActive` is derived from the workspace dashboard snapshot, which
        // only re-polls every 10s. Without this nudge the "session inactive"
        // banner would sit there for another poll cycle and the user would read
        // a successful login as a failure.
        refreshWorkspace();
        setTimeout(fetchData, 2000);
      }
    } catch (e: any) {
      showToast('err', e?.message ?? 'Login request failed');
    } finally {
      setLoginBusy(false);
    }
  };

  const runUnsubscribe = async (symbols: string[]) => {
    setBusy(true);
    try {
      const res = await fetch('/api/phase2/subscriptions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
      });
      const d = await res.json();
      if (!res.ok) showToast('err', d.error ?? 'Unsubscribe failed');
      else showToast('ok', `Unsubscribed ${symbols.length} stock${symbols.length > 1 ? 's' : ''}`);
      clearCache('phase2/subscriptions');
      clearCache('phase2/stock-stats');
      fetchData();
    } catch {
      showToast('err', 'Unsubscribe request failed');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const filtered = useMemo(() => subscriptions.filter((s) => {
    if (search) {
      const q = search.toLowerCase();
      if (!s.symbol.toLowerCase().includes(q)
        && !s.token.includes(q)
        && !s.companyName.toLowerCase().includes(q)
        && !s.tradingSymbol.toLowerCase().includes(q)) return false;
    }
    const f = freshnessOf(s);
    if (statusFilter === 'live' && f !== 'LIVE') return false;
    if (statusFilter === 'stale' && f !== 'STALE') return false;
    if (statusFilter === 'nodata' && f !== 'NO_DATA') return false;
    if (statusFilter === 'active' && s.status === 'inactive') return false;
    return true;
  }), [subscriptions, search, statusFilter]);

  const selectedCount = subscriptions.filter((s) => s.selected).length;
  const allSelected = filtered.length > 0 && filtered.every((s) => s.selected);

  const counts = useMemo(() => ({
    total: subscriptions.length,
    active: subscriptions.filter((s) => s.status !== 'inactive').length,
    live: subscriptions.filter((s) => freshnessOf(s) === 'LIVE').length,
    stale: subscriptions.filter((s) => freshnessOf(s) === 'STALE').length,
    noData: subscriptions.filter((s) => freshnessOf(s) === 'NO_DATA').length,
  }), [subscriptions]);

  const feedTone: StateTone = stats?.websocketConnected && streamConnected ? 'success' : streamConnected ? 'warning' : 'danger';
  const canSearch = instrumentMasterAvailable;
  const liveClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(now));

  return (
    <div className="relative min-h-full">
      <Aurora />

      <div className="relative z-10 space-y-4 pb-10">

        {/* ══════════════ HERO ══════════════ */}
        <header className="ds-card relative overflow-hidden rounded-3xl border border-border/50 bg-card/70 p-4 shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.05),0_24px_60px_-32px_hsl(var(--foreground)/0.25)] backdrop-blur-2xl sm:p-5">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="ds-drift-a absolute -left-24 -top-28 h-80 w-80 rounded-full bg-primary/12 blur-[90px]" />
            <div className="ds-drift-b absolute -bottom-32 right-0 h-80 w-80 rounded-full bg-info/10 blur-[90px]" />
          </div>

          <div className="relative flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 shadow-lg shadow-primary/25">
                  <Radio className="h-5 w-5 text-primary-foreground" />
                  {feedTone === 'success' && <span className="absolute -inset-0.5 -z-10 rounded-2xl bg-primary/25 ds-breathe" />}
                </span>
                <div>
                  <h1 className="text-xl font-semibold leading-tight tracking-[-0.02em]">Stock Subscription</h1>
                  <p className="text-[11px] text-muted-foreground">NSE EQ instruments · live tick collection</p>
                </div>
              </div>

              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold', TONE_PILL[feedTone])}>
                  <PulseDot tone={feedTone} live={feedTone === 'success'} />
                  {feedTone === 'success' ? 'Live stream' : feedTone === 'warning' ? 'Stream reconnecting' : 'Stream down'}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground backdrop-blur">
                  <Clock className="h-3 w-3" /> {liveClock} IST
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground backdrop-blur">
                  <Activity className="h-3 w-3" /> {fmtNumber(ticksSeen)} ticks this session
                </span>
                {market?.status && (
                  <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                    market.status === 'OPEN' ? TONE_PILL.success : TONE_PILL.neutral)}>
                    {market.status === 'OPEN' ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {market.status}{market.session ? ` · ${market.session}` : ''}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" onClick={() => setAddOpen(true)} className="rounded-full">
                    <Plus className="h-3.5 w-3.5" /> Add Stock
                  </Button>
                  <Button size="sm" variant="ghost" onClick={fetchData} aria-label="Refresh"
                    className="rounded-full transition-transform duration-300 hover:scale-105">
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto sm:grid-cols-4 lg:w-[400px]">
              {[
                { label: 'Subscribed', value: fmtNumber(counts.active), accent: 'amber' },
                { label: 'Live now', value: fmtNumber(counts.live), accent: 'emerald' },
                { label: 'Ticks today', value: stats?.ticksToday != null ? fmtNumber(stats.ticksToday) : '—', accent: 'sky' },
                { label: 'Ticks / sec', value: stats?.ticksPerSecond != null ? stats.ticksPerSecond.toFixed(2) : '—', accent: 'teal' },
              ].map((h, i) => (
                <div key={h.label} style={{ '--ds-i': i } as React.CSSProperties}
                  className="ds-rise ds-lift rounded-2xl border border-border/40 bg-background/50 px-3 py-2.5 backdrop-blur">
                  <p className={cn('text-lg font-semibold leading-none tracking-tight tabular-nums', ACCENT[h.accent].text)}>{h.value}</p>
                  <p className="mt-1.5 truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">{h.label}</p>
                </div>
              ))}
            </div>
          </div>
        </header>

        {/* Broker session banner */}
        {!sessionActive && (
          <div className="flex flex-col gap-2 rounded-2xl border border-warning/25 bg-warning/5 px-4 py-3 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-[12px] text-warning">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Broker session is inactive — live WebSocket data and search are unavailable until a login completes.
            </p>
            <Button size="sm" variant="outline" onClick={handleManualLogin} disabled={loginBusy} className="gap-1.5">
              {loginBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
              Manual Login
            </Button>
          </div>
        )}

        {/* ══════════════ SUMMARY ══════════════ */}
        <section aria-label="Summary" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { icon: Database, title: 'Subscriptions', value: String(counts.total), sub: 'in the registry', accent: 'slate', hint: 'Total instruments in the subscription registry.' },
            { icon: CheckCircle2, title: 'Active', value: String(counts.active), sub: 'registered & enabled', accent: 'emerald', hint: 'Registered and enabled in the registry.' },
            { icon: Activity, title: 'Live now', value: String(counts.live), sub: 'tick in last 10s', accent: 'teal', hint: 'Receiving a tick in the last 10 seconds.' },
            { icon: BarChart3, title: 'Stale', value: String(counts.stale), sub: counts.noData > 0 ? `${counts.noData} with no data` : 'tick older than 10s', accent: 'amber', hint: 'Tick older than 10 seconds.' },
            { icon: Wifi, title: 'On WS feed', value: stats?.wsSubscribed != null ? fmtNumber(stats.wsSubscribed) : '—', sub: stats?.websocketConnected ? 'feed connected' : 'feed down', accent: 'sky', hint: 'Subscriptions present on the live WebSocket feed.' },
            { icon: Radio, title: 'Ticks today', value: stats?.ticksToday != null ? fmtNumber(stats.ticksToday) : '—', sub: stats?.ticksPerSecond != null ? `${stats.ticksPerSecond.toFixed(2)}/sec` : 'rate n/a', accent: 'violet', hint: 'Total ticks persisted today across all subscribed instruments.' },
          ].map((c, i) => {
            const a = ACCENT[c.accent];
            return (
              <SoftCard key={c.title} accent={c.accent} lift index={i} className="p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <span className={cn('flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md transition-transform duration-300 group-hover:scale-110', a.chip)}>
                    <c.icon className="h-4 w-4" />
                  </span>
                </div>
                <p className="mt-2.5 text-2xl font-semibold leading-none tracking-[-0.03em] tabular-nums">{c.value}</p>
                <p className="mt-1.5 truncate text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground" title={c.hint}>{c.title}</p>
                <p className="mt-1 truncate text-[10px] text-muted-foreground/80">{c.sub}</p>
              </SoftCard>
            );
          })}
        </section>

        {/* ══════════════ MASTER + MARKET ══════════════ */}
        <MasterStatusPanel state={masterState} market={market} onRefresh={fetchData} />

        {/* ══════════════ CONTROLS ══════════════ */}
        <section aria-label="Controls" className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {(['All', 'My Stocks'] as const).map((g) => {
                const n = g === 'All' ? subscriptions.length : subscriptions.filter((s) => s.status !== 'inactive').length;
                const on = group === g;
                return (
                  <button key={g} onClick={() => setGroup(g)}
                    className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-all duration-300',
                      on ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border/50 bg-card/60 text-muted-foreground hover:border-border hover:text-foreground')}>
                    {g}<span className="tabular-nums opacity-60">{n}</span>
                  </button>
                );
              })}
            </div>

            <div className="relative ml-auto min-w-[200px] flex-1 sm:max-w-sm">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search symbol, token, ISIN or company…"
                value={search} onChange={(e) => setSearch(e.target.value)}
                className="h-9 rounded-xl border-border/50 bg-card/60 pl-8 backdrop-blur-xl focus:border-primary/50" />
            </div>

            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by state"
              className="h-9 rounded-xl border border-border/50 bg-card/60 px-2.5 text-[11px] backdrop-blur-xl">
              <option value="all">All states</option>
              <option value="live">Live</option>
              <option value="stale">Stale</option>
              <option value="nodata">No data</option>
              <option value="active">Active only</option>
            </select>

            <Button size="sm" variant="ghost" onClick={toggleSelectAll} className="h-9 rounded-xl text-[11px]">
              {allSelected ? <SquareCheck className="h-3.5 w-3.5 text-primary" /> : <Square className="h-3.5 w-3.5" />}
              Select all
            </Button>
          </div>

          {selectedCount > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/25 bg-primary/[0.06] px-4 py-2.5 backdrop-blur-xl">
              <span className="text-[11px] font-semibold text-primary">{selectedCount} selected</span>
              <Button size="sm" variant="ghost" onClick={clearSelection} className="h-7 text-[11px]">Clear</Button>
              <Button size="sm" variant="destructive" className="h-7 text-[11px]"
                onClick={() => setConfirm({ type: 'bulk', symbols: subscriptions.filter((s) => s.selected).map((s) => s.symbol) })}>
                Unsubscribe selected
              </Button>
            </div>
          )}
        </section>

        {/* ══════════════ LIST ══════════════ */}
        <section aria-label="Subscriptions">
          {loading ? (
            <LoadingState text="Loading subscriptions…" />
          ) : loadError ? (
            <EmptyState icon={XCircle} title="Failed to load subscriptions" description={loadError}
              action={<Button size="sm" variant="outline" onClick={fetchData}>Retry</Button>} />
          ) : subscriptions.length === 0 ? (
            <SoftCard accent="amber" className="p-4">
              <EmptyState icon={Radio} title="No subscriptions yet"
                description="Add an NSE equity instrument to start collecting live tick data"
                action={<Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-3.5 w-3.5" /> Add Stock</Button>} />
            </SoftCard>
          ) : filtered.length === 0 ? (
            <SoftCard accent="slate" className="p-4">
              <EmptyState icon={Search} title="No matching subscriptions" description="Try a different search or filter" />
            </SoftCard>
          ) : (
            <>
              <SectionHeading>{group === 'My Stocks' ? 'My Stocks' : 'Subscriptions'} · {filtered.length}</SectionHeading>
              <div className="mt-2 grid grid-cols-1 gap-2.5">
                {filtered.map((s, i) => (
                  <StockCard key={s.token} s={s} now={now} flash={flash[String(s.token)]} index={i}
                    onToggleSelect={() => toggleSelect(s.symbol)}
                    onDetails={() => openDetails(s.symbol)}
                    onUnsubscribe={() => setConfirm({ type: 'single', symbols: [s.symbol] })} />
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ══════════════ ADD STOCK ══════════════ */}
      <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) { setQuery(''); clearSearch(); setSelectedResult(null); setSubscribeMsg(null); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Stock</DialogTitle>
            <DialogDescription>Search the real NSE equity instrument master. Only valid NSE EQ equities can be subscribed.</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search symbol, company, token or ISIN…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedResult(null); setSubscribeMsg(null); }}
              className="pl-8" autoFocus />
          </div>

          {!canSearch && !searching && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The NSE instrument master is not loaded yet. It will load automatically after a broker login.
            </p>
          )}
          {searchHint && <p className="flex items-start gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />{searchHint}</p>}
          {searchErrorText && <p className="text-xs text-destructive">{searchErrorText}</p>}

          {searching ? (
            <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…</p>
          ) : searchStatus === 'empty' ? (
            <EmptyState icon={Search} title="No instruments found" description="No NSE equity matches. Try the symbol, trading symbol, or company name." className="py-8" />
          ) : (
            <div className="space-y-1.5">
              {results.map((r) => (
                <button key={r.token} onClick={() => setSelectedResult(r)}
                  className={cn('w-full rounded-xl border p-2.5 text-left transition-all duration-300', selectedResult?.token === r.token
                    ? 'border-primary/50 bg-primary/[0.06]'
                    : 'border-border/50 bg-card/40 hover:border-border/70')}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{r.symbol || r.tradingSymbol}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{r.name || r.tradingSymbol}</p>
                    </div>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">EQ</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
                    <span>Token: {r.token}</span>{r.isin && <span>ISIN: {r.isin}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}

          {selectedResult && (
            <div className="rounded-xl border border-border/50 bg-card/40 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Selected — preview</p>
              <div className="mt-1 grid grid-cols-2 gap-x-4">
                <DetailRow label="Symbol" value={selectedResult.symbol || selectedResult.tradingSymbol} />
                <DetailRow label="Company" value={selectedResult.name || notAvail} />
                <DetailRow label="Segment" value="NSE EQ" />
                <DetailRow label="Token" value={selectedResult.token || notAvail} />
                <DetailRow label="ISIN" value={selectedResult.isin || notAvail} />
              </div>
            </div>
          )}

          {subscribeMsg && (
            <p className={cn('flex items-start gap-2 rounded-xl border px-3 py-2 text-xs',
              subscribeMsgTone === 'ok' && TONE_PILL.success,
              subscribeMsgTone === 'warn' && TONE_PILL.warning,
              subscribeMsgTone === 'err' && TONE_PILL.danger)}>
              {subscribeMsgTone === 'ok' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                : subscribeMsgTone === 'warn' ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {subscribeMsg}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Close</Button>
            <Button onClick={handleSubscribe} disabled={!selectedResult || subscribing} className="gap-1.5">
              {subscribing && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Subscribe
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════ DETAILS ══════════════ */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{details?.identity?.companyName ?? 'Stock Details'}</DialogTitle>
            <DialogDescription>{details ? `${details.identity?.symbol ?? ''} · NSE EQ` : notAvail}</DialogDescription>
          </DialogHeader>
          {detailsLoading ? (
            <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-3/4" /><Skeleton className="h-6 w-1/2" /></div>
          ) : detailsError ? (
            <EmptyState icon={XCircle} title="Details unavailable" description={detailsError} className="py-8" />
          ) : details ? <DetailsView details={details} /> : null}
        </DialogContent>
      </Dialog>

      {/* ══════════════ CONFIRM ══════════════ */}
      <Dialog open={confirm != null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Unsubscribe stock{(confirm?.symbols.length ?? 0) > 1 ? 's' : ''}?</DialogTitle>
            <DialogDescription>
              This will remove {confirm?.symbols.length ?? 0} instrument{(confirm?.symbols.length ?? 0) > 1 ? 's' : ''} from the registry and the live WebSocket feed. Tick collection will stop.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={() => confirm && runUnsubscribe(confirm.symbols)} disabled={busy} className="gap-1.5">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Unsubscribe
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════ TOAST ══════════════ */}
      {toast && (
        <div className={cn('bottom-nav-offset fixed right-4 z-toast max-w-sm animate-in fade-in slide-in-from-bottom-2 rounded-2xl border bg-card/95 px-4 py-3 text-sm shadow-xl backdrop-blur-xl',
          toast.tone === 'ok' && 'border-success/30', toast.tone === 'err' && 'border-destructive/30', toast.tone === 'warn' && 'border-warning/30')}>
          <span className="flex items-start gap-2">
            {toast.tone === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              : toast.tone === 'err' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
            <span>{toast.message}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */
/* Stock card                                                                  */
/* ========================================================================== */

const FRESH_ACCENT: Record<DataState, string> = {
  LIVE: 'from-emerald-400/70 to-teal-400/40',
  STALE: 'from-amber-400/70 to-orange-400/40',
  NO_DATA: 'from-slate-400/60 to-slate-300/30',
  INACTIVE: 'from-destructive/50 to-rose-300/30',
};

function StockCard({ s, now, flash, index, onToggleSelect, onDetails, onUnsubscribe }: {
  s: Subscription; now: number; flash?: 'up' | 'down'; index: number;
  onToggleSelect: () => void; onDetails: () => void; onUnsubscribe: () => void;
}) {
  const active = s.status !== 'inactive';
  const chTone = changeToneClass(s.change);
  const dataState = dataStateOf(s);
  const dataTone = dataState === 'LIVE' ? 'success' : dataState === 'STALE' ? 'warning' : dataState === 'NO_DATA' ? 'neutral' : 'danger';
  const tickAge = ageOf(s.lastTick, now);
  const company = s.companyName === notAvail ? s.tradingSymbol : s.companyName;

  return (
    <div
      style={{ '--ds-i': index } as React.CSSProperties}
      className={cn('ds-card ds-rise ds-lift group relative overflow-hidden rounded-2xl border border-border/50 bg-card/75 shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] backdrop-blur-xl',
        s.selected && 'border-primary/45 ring-1 ring-primary/20')}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2.5px] bg-gradient-to-r', FRESH_ACCENT[dataState])} />

      <div className="flex flex-col gap-3.5 p-4 lg:flex-row lg:items-center lg:gap-5">
        {/* Identity */}
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <button onClick={onToggleSelect} className="mt-0.5 shrink-0 text-muted-foreground transition-transform duration-300 hover:scale-110 hover:text-foreground" aria-label="Toggle select">
            {s.selected ? <SquareCheck className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4" />}
          </button>
          <div className="min-w-0">
            {/* A <div>, not a <p>: <Badge> renders a <div>, and a <div> is not
                valid inside a <p> — that invalid nesting was producing React's
                "In HTML, <div> cannot be a descendant of <p>" hydration warning
                on every render of this list. */}
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold tracking-tight">{s.symbol}</span>
              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">EQ</Badge>
              <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em]', TONE_PILL[dataTone])}>
                <PulseDot tone={dataTone} live={dataState === 'LIVE'} />
                {dataState.replace(/_/g, ' ')}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{company}</p>
            <p className="mt-0.5 truncate text-[10px] tabular-nums text-muted-foreground/80">
              Token {s.token || notAvail}{s.isin !== notAvail && s.isin ? ` · ${s.isin}` : ''}
            </p>
          </div>
        </div>

        {/* Live price */}
        <div className="min-w-0 lg:w-[13rem] lg:shrink-0">
          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">LTP</p>
          <div className="flex items-baseline gap-2">
            <span className={cn('text-xl font-semibold leading-7 tracking-[-0.02em] tabular-nums transition-colors duration-500',
              flash === 'up' ? 'text-success' : flash === 'down' ? 'text-destructive' : chTone)}>
              {fmtPrice(s.ltp)}
            </span>
            {s.change != null && s.changePercent != null ? (
              <span className={cn('flex items-center gap-1 text-[11px] font-semibold tabular-nums', chTone)}>
                <ChangeIcon v={s.change} />{fmtChange(s.change)} ({fmtChange(s.changePercent)}%)
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground">{notAvail}</span>
            )}
          </div>
          <div className="mt-1 grid grid-cols-4 gap-1.5 text-[10px] tabular-nums">
            <span><span className="text-muted-foreground/70">O </span>{fmtPrice(s.open)}</span>
            <span><span className="text-success/80">H </span>{fmtPrice(s.high)}</span>
            <span><span className="text-destructive/80">L </span>{fmtPrice(s.low)}</span>
            <span><span className="text-muted-foreground/70">C </span>{fmtPrice(s.close)}</span>
          </div>
        </div>

        {/* Three independent state cells */}
        <div className="grid shrink-0 grid-cols-3 gap-1.5 lg:w-[17rem]">
          <StateCell label="Subscription" state={subscriptionStateOf(s)} reason={active ? undefined : 'Not subscribed'} icon={Database} />
          <StateCell label="WebSocket" state={wsStateOf(s)}
            reason={s.wsConnected ? 'Feed connected' : (s.wsReason && s.wsReason !== 'Connected' ? s.wsReason : 'Feed not connected')}
            icon={Wifi} />
          <StateCell label="Data" state={dataState}
            reason={!s.marketAvailable ? 'No data yet' : s.lastTick ? `Last tick ${fmtTime(s.lastTick)}` : 'No data yet'}
            icon={Activity} />
        </div>

        {/* Live counters */}
        <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-1 text-[11px] tabular-nums lg:w-[11rem]">
          <div className="flex items-center justify-between gap-2 lg:justify-start">
            <span className="flex items-center gap-1 text-muted-foreground">
              {s.wsConnected ? <Wifi className="h-3 w-3 text-success" /> : <WifiOff className="h-3 w-3 text-destructive" />} Feed
            </span>
            <span className={s.wsConnected ? 'text-success' : 'text-destructive'}>{s.wsConnected ? 'Up' : 'Down'}</span>
          </div>
          <div className="flex items-center justify-between gap-2 lg:justify-start">
            <span className="text-muted-foreground">Ticks</span>
            <span>{s.tickCountToday != null ? fmtNumber(s.tickCountToday) : notAvail}</span>
          </div>
          <div className="flex items-center justify-between gap-2 lg:justify-start">
            <span className="text-muted-foreground">Vol</span>
            <span>{s.volume != null ? fmtNumber(s.volume) : notAvail}</span>
          </div>
          <div className="flex items-center justify-between gap-2 lg:justify-start">
            <span className="text-muted-foreground">Age</span>
            <span className={cn(tickAge == null ? 'text-muted-foreground' : tickAge <= 10 ? 'text-success' : tickAge <= 60 ? 'text-warning' : 'text-destructive')}>
              {tickAge == null ? '—' : `${tickAge}s`}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-2 lg:w-[11rem]">
          <Button size="sm" variant="outline" className="h-8 flex-1 rounded-xl text-[11px]" onClick={onDetails}>
            Details <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          {active ? (
            <Button size="sm" variant="ghost" className="h-8 flex-1 rounded-xl text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onUnsubscribe}>
              <X className="h-3.5 w-3.5" /> Remove
            </Button>
          ) : (
            <Badge variant="secondary" className="h-8 flex-1 justify-center rounded-xl text-[10px]">Inactive</Badge>
          )}
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Panels                                                                      */
/* ========================================================================== */

/** Separate SUBSCRIPTION / WEBSOCKET / DATA state — three independent layers. */
function StateCell({ label, state, reason, icon: Icon }: {
  label: string; state: string; reason?: string | null; icon: React.ElementType;
}) {
  const tone = stateTone(state);
  return (
    <div className="rounded-xl border border-border/40 bg-background/40 px-2.5 py-1.5 transition-colors hover:border-border/60">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-muted-foreground" />
        <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">{label}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} />
        <span className={cn('text-[11px] font-semibold', TONE_TEXT[tone])}>{stateLabel(state, null)}</span>
      </div>
      <p className="mt-0.5 h-3 truncate text-[9px] leading-tight text-muted-foreground/80" title={reason ?? undefined}>{reason ?? ''}</p>
    </div>
  );
}

function MasterStatusPanel({ state, market, onRefresh }: {
  state: InstrumentMasterState | null; market: MarketContext | null; onRefresh: () => void;
}) {
  const st = state?.state ?? 'NOT_AVAILABLE';
  const tone = stateTone(st);
  return (
    <SoftCard accent={tone === 'success' ? 'emerald' : tone === 'warning' ? 'amber' : 'slate'} className="p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Instrument master</span>
          <span className={cn('rounded-full border px-2 py-0.5 text-[9px] font-semibold', TONE_PILL[tone])}>{stateLabel(st, null)}</span>
        </div>
        <button onClick={onRefresh} aria-label="Refresh master status" className="rounded p-1 text-muted-foreground transition-transform duration-300 hover:scale-110 hover:text-foreground">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1 text-[11px] tabular-nums">
        {([
          ['Instruments', state?.instrumentCount != null ? fmtNumber(state.instrumentCount) : notAvail],
          ['NSE EQ', state?.nseEqCount != null ? fmtNumber(state.nseEqCount) : notAvail],
          ['Source', state?.source != null && state.source !== 'none' ? state.source : notAvail],
          ['Last load', state?.lastLoadAt ? fmtDate(state.lastLoadAt) : notAvail],
        ] as [string, string][]).map(([k, v]) => (
          <span key={k}><span className="text-muted-foreground">{k} </span><span className="font-medium">{v}</span></span>
        ))}
        {market && (
          <span>
            <span className="text-muted-foreground">Market </span>
            <span className={cn('font-medium', market.status === 'OPEN' ? 'text-success' : 'text-muted-foreground')}>
              {market.status ?? notAvail}
            </span>
            {market.session && market.session !== market.status && <span className="text-muted-foreground"> · {market.session}</span>}
          </span>
        )}
      </div>

      {state?.reason && st !== 'LOADED' && (
        <p className="mt-2 flex items-start gap-1.5 text-[10px] text-warning"><Info className="mt-0.5 h-3 w-3 shrink-0" />{state.reason}</p>
      )}
      {market?.closureReason && market.status === 'CLOSED' && (
        <p className="mt-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          Market closed: {market.closureReason}.{market.date ? ` Market date ${fmtDate(market.date)}.` : ''} Data shows the last known value.
        </p>
      )}
    </SoftCard>
  );
}

/* ========================================================================== */
/* Details view                                                                */
/* ========================================================================== */

function DetailsView({ details }: { details: any }) {
  const identity = details.identity ?? {};
  const md = details.marketData ?? {};
  const sub = details.subscription ?? {};
  const ws = details.websocket ?? {};
  const ts = details.tickStats ?? {};
  const timeline: Array<{ event: string; at: string }> = details.timeline ?? [];
  const mdTone = changeToneClass(md.change);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border/50 bg-card/40 p-3.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Instrument</p>
        <div className="mt-1 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <DetailRow label="Symbol" value={identity.symbol ?? identity.tradingSymbol ?? notAvail} />
          <DetailRow label="Segment" value="NSE EQ" />
          <DetailRow label="Trading symbol" value={identity.tradingSymbol ?? notAvail} />
          <DetailRow label="Company" value={identity.companyName ?? notAvail} />
          <DetailRow label="Token" value={String(identity.instrumentToken ?? notAvail)} />
          <DetailRow label="ISIN" value={identity.isin ?? notAvail} />
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card/40 p-3.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Market data</p>
        <div className="mt-2 flex items-end justify-between">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">LTP</p>
            <p className={cn('text-2xl font-semibold tracking-tight tabular-nums', mdTone)}>{fmtPrice(md.ltp)}</p>
          </div>
          {md.change != null && md.changePercent != null ? (
            <div className="text-right">
              <p className={cn('flex items-center justify-end gap-1 text-sm font-semibold tabular-nums', mdTone)}>
                <ChangeIcon v={md.change} />{fmtChange(md.change)}
              </p>
              <p className={cn('text-[11px] tabular-nums', mdTone)}>({fmtChange(md.changePercent)}%)</p>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">{notAvail}</p>
          )}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-muted/30 px-2 py-1.5 text-[11px] tabular-nums">
          <div><span className="text-muted-foreground">Open </span>{fmtPrice(md.open)}</div>
          <div><span className="text-success">High </span>{fmtPrice(md.high)}</div>
          <div><span className="text-destructive">Low </span>{fmtPrice(md.low)}</div>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg bg-muted/30 px-2 py-1.5 text-[11px] tabular-nums sm:grid-cols-4">
          <div><span className="text-muted-foreground">Close </span>{fmtPrice(md.close)}</div>
          <div><span className="text-muted-foreground">Prev close </span>{fmtPrice(md.prevClose)}</div>
          <div><span className="text-muted-foreground">Volume </span>{fmtNumber(md.volume)}</div>
          <div><span className="text-muted-foreground">Last tick </span>{fmtTime(md.lastTickAt ?? ts.lastTickAt)}</div>
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card/40 p-3.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Status</p>
        <div className="mt-1 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <DetailRow label="Subscription" value={sub.state ?? notAvail} />
          <DetailRow label="Request status" value={sub.requestStatus ?? notAvail} />
          <DetailRow label="Subscribed at" value={fmtDate(sub.subscribedAt)} />
          <DetailRow label="Market" value={details.market?.status ?? notAvail} />
          {ws.disconnectReason && <DetailRow label="WS reason" value={ws.disconnectReason} />}
          {ws.reconnectCount != null && <DetailRow label="Reconnects" value={fmtNumber(ws.reconnectCount)} />}
          {ws.ticksReceived != null && <DetailRow label="Ticks received" value={fmtNumber(ws.ticksReceived)} />}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/30 py-[5px]">
          <span className="text-[11px] text-muted-foreground">WebSocket</span>
          <StatusBadge status={ws.connected ? 'success' : 'danger'} label={ws.connected ? 'Connected' : 'Disconnected'} />
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card/40 p-3.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Data quality</p>
        <div className="mt-1 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <DetailRow label="Ticks today" value={fmtNumber(ts.tickCountToday)} />
          <DetailRow label="First tick" value={fmtTime(ts.firstTickAt)} />
          <DetailRow label="Last tick" value={fmtTime(ts.lastTickAt)} />
          <DetailRow label="Save failures" value={details.quality?.saveFailures != null ? fmtNumber(details.quality.saveFailures) : 'Not measured'} />
          <DetailRow label="Duplicate ticks" value={details.quality?.duplicateTicks != null ? fmtNumber(details.quality.duplicateTicks) : 'Not measured'} />
          <DetailRow label="Out-of-order ticks" value={details.quality?.outOfOrderTicks != null ? fmtNumber(details.quality.outOfOrderTicks) : 'Not measured'} />
        </div>
      </div>

      {timeline.length > 0 && (
        <div className="rounded-xl border border-border/50 bg-card/40 p-3.5">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Timeline</p>
          <ol className="mt-1.5 space-y-1">
            {timeline.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-2 border-b border-border/25 py-1 text-[11px] last:border-0">
                <span className="truncate text-muted-foreground">{t.event}</span>
                <span className="shrink-0 font-medium tabular-nums">{fmtDate(t.at)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}