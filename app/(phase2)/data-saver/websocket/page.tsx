'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Clock, Database,
  Download, RefreshCw, Search, Server, Trash2, Wifi, WifiOff, X,
  ShieldCheck, Zap, Pause, Play, Gauge,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FreshnessPanel } from '@/components/websocket/ws-freshness';

// recharts is heavy and every chart sits below the fold — each chart bundle
// loads lazily so first paint stays instant.

import { useToast } from '@/hooks/use-toast';
import {
  PageHeader, SectionHeading, EmptyState, LoadingState, StatusBadge,
} from '@/components/design-system';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  getWebsocketHistory, getWebsocketMetrics, getWebsocketDaily,
  getWebsocketRecord, deleteWebsocketRecord, clearWebsocketHistory,
  getWebsocketEventsFiltered,
  getWebsocketTelemetrySeries, runWebsocketCleanupDays, exportWebsocketUrl,
  getWebsocketLive,
} from '@/lib/api';
import { useRealtime, type AppConnectionState } from '@/components/realtime-provider';
import { cn } from '@/lib/utils';
import { ThroughputChart } from '@/components/websocket/ws-charts';
import { BucketsChart } from '@/components/websocket/ws-charts';
import { DailyChart } from '@/components/websocket/ws-charts';
import { HealthDonut } from '@/components/websocket/ws-charts';

/* ────────────────────────────────────────────────────────────────────────────
   Canonical WebSocket state machine.
   CONNECTED is only valid after an actual connection success. RECONNECTING is
   never shown as CONNECTED. BACKEND_UNAVAILABLE dominates when the application
   SSE stream is not CONNECTED (state cannot be trusted).
   ──────────────────────────────────────────────────────────────────────────── */

export type WsMachineState =
  | 'NOT_CONFIGURED'
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'ERROR'
  | 'STOPPED'
  | 'BACKEND_UNAVAILABLE'
  | 'UNKNOWN';

interface WsLive {
  supervisorState?: string;
  state?: string;
  connected?: boolean;
  feedState?: string;
  feedStateSince?: string | null;
  connectionId?: string | null;
  sessionId?: string | null;
  connectedAt?: string | null;
  disconnectedAt?: string | null;
  disconnectReason?: string | null;
  disconnectReasonCode?: string | null;
  currentSessionUptimeSec?: number | null;
  lastMessageAt?: string | null;
  lastTickAt?: string | null;
  secondsSinceTick?: number | null;
  secondsSinceMessage?: number | null;
  messagesReceived?: number;
  ticksReceived?: number;
  errorCount?: number;
  subscriptionCount?: number;
  subscriptionRegistryCount?: number;
  reconnectCount?: number;
  reconnectAttempt?: number | null;
  rates?: Record<string, number | undefined>;
  internetOk?: boolean | null;
  processStartedAt?: string | null;
  connectionHistoryCount?: number;
  market?: Record<string, any>;
}

interface LogEntry {
  key: string;
  ts: number;
  level: 'info' | 'warning' | 'error' | 'success';
  event: string;
  instrument?: string;
  message: string;
}

interface WsMetrics {
  rangeHours: number;
  connections: number;
  totalUptimeSec: number;
  totalDowntimeSec: number;
  eligibleWindowSec: number;
  measuredWindowSec: number;
  uptimePercent?: number | null;
  availabilityPercent?: number | null;
  insufficient?: boolean;
  measuredDays?: string[];
  rangeStartAt?: string;
  rangeEndAt?: string;
  totalMessages: number;
  totalTicks: number;
  totalErrors: number;
  messagesPerSec: number;
  ticksPerSec: number;
  errorsPerConnection: number;
  heartbeatFailures: number;
  dataGaps: number;
  reconnectCount: number;
  reconnectAt?: string[];
}

interface TelemetryPoint {
  bucket?: string;
  timestamp?: string;
  received?: number;
  written?: number;
  errors?: number;
  ticksPerSecond?: number | null;
  writesPerSecond?: number | null;
  wsConnected?: boolean | null;
  wsSubscriptionCount?: number | null;
  wsReconnectCount?: number | null;
  wsLifecycleState?: string | null;
}

interface WsRecord {
  connection_id: string;
  status?: string;
  connected_at?: string;
  disconnected_at?: string;
  duration_sec?: number | null;
  session_id?: string | null;
  messages_received?: number;
  ticks_received?: number;
  error_count?: number;
  heartbeat_failures?: number;
  data_gaps?: number;
  reconnect_count?: number;
  subscription_count?: number;
  reason?: string;
  close_code?: string;
  date?: string;
}

interface WsEvent {
  _id: string;
  connection_id?: string;
  event_type?: string;
  severity?: string;
  message?: string;
  details?: string;
  timestamp?: string;
}

interface WsHistoryResponse {
  records: WsRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface WsEventsResponse {
  events: WsEvent[];
  total: number;
  limit: number;
  offset: number;
}

interface WsDailyResponse {
  summary: {
    date: string;
    connections: number;
    messages: number;
    ticks: number;
    errors: number;
    disconnects: number;
    total_uptime_sec: number;
    answered: boolean;
  } | null;
  availableDates: string[];
}

const PAGE_SIZE = 10;
const LOG_CAP = 120;
const LOG_POLL_MS = 10000;

const RANGES = [
  { hours: 1, label: '1h', resolution: 1 },
  { hours: 6, label: '6h', resolution: 1 },
  { hours: 24, label: '24h', resolution: 5 },
  { hours: 144, label: '6d', resolution: 30 },
];

const INCIDENT_TYPES = ['RECONNECTING', 'RECONNECTED', 'STALE_FEED', 'FEED_RESUMED', 'DISCONNECTED'];

/** Keyword → static gradient chip classes for colorful metric tiles. */
function tileTint(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('error') || l.includes('err ') || l === 'err' || l.includes('downtime') || l.includes('disconnect') || l.includes('offline') || l.includes('fail'))
    return 'from-rose-500 to-pink-600';
  if (l.includes('tick')) return 'from-teal-500 to-emerald-600';
  if (l.includes('msg') || l.includes('message')) return 'from-sky-500 to-blue-600';
  if (l.includes('recon')) return 'from-amber-500 to-orange-600';
  if (l.includes('subscri') || l.includes('registry') || l.includes('sync')) return 'from-violet-500 to-purple-600';
  if (l.includes('feed') || l.includes('receiv')) return 'from-cyan-500 to-teal-600';
  if (l.includes('avail') || l.includes('uptime') || l.includes('health') || l.includes('connect') || l.includes('online') || l.includes('active') || l.includes('run'))
    return 'from-emerald-500 to-green-600';
  if (l.includes('buffer') || l.includes('duration') || l.includes('retention') || l.includes('window'))
    return 'from-amber-500 to-yellow-600';
  if (l.includes('supervisor') || l.includes('pipeline') || l.includes('writ') || l.includes('persist'))
    return 'from-indigo-500 to-blue-600';
  return 'from-slate-500 to-slate-600';
}

/** Hero banner gradient per machine state. */
function heroGradient(s: WsMachineState): string {
  switch (s) {
    case 'CONNECTED': return 'from-emerald-500/20 via-teal-500/10 to-sky-500/15';
    case 'CONNECTING': return 'from-sky-500/20 via-blue-500/10 to-indigo-500/15';
    case 'RECONNECTING': return 'from-amber-500/20 via-orange-500/10 to-yellow-500/10';
    case 'ERROR': case 'BACKEND_UNAVAILABLE': return 'from-rose-500/20 via-red-500/10 to-orange-500/10';
    default: return 'from-slate-500/15 via-slate-500/5 to-slate-500/10';
  }
}

/* State machine → presentation mapping */
const MACHINE_STYLES: Record<WsMachineState, {
  label: string; text: string; dot: string; bg: string; badge: 'success'|'warning'|'danger'|'info'|'neutral';
}> = {
  CONNECTED: { label: 'CONNECTED', text: 'text-success', dot: 'bg-success', bg: 'bg-success/10', badge: 'success' },
  CONNECTING: { label: 'CONNECTING', text: 'text-blue-400', dot: 'bg-blue-400 animate-pulse', bg: 'bg-blue-500/10', badge: 'info' },
  RECONNECTING: { label: 'RECONNECTING', text: 'text-warning', dot: 'bg-warning animate-pulse', bg: 'bg-warning/10', badge: 'warning' },
  DISCONNECTED: { label: 'DISCONNECTED', text: 'text-muted-foreground', dot: 'bg-muted-foreground/60', bg: 'bg-muted/30', badge: 'neutral' },
  ERROR: { label: 'ERROR', text: 'text-destructive', dot: 'bg-destructive', bg: 'bg-destructive/10', badge: 'danger' },
  STOPPED: { label: 'STOPPED', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50', bg: 'bg-muted/30', badge: 'neutral' },
  NOT_CONFIGURED: { label: 'NOT CONFIGURED', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50', bg: 'bg-muted/30', badge: 'neutral' },
  BACKEND_UNAVAILABLE: { label: 'BACKEND UNAVAILABLE', text: 'text-destructive', dot: 'bg-destructive', bg: 'bg-destructive/10', badge: 'danger' },
  UNKNOWN: { label: 'UNKNOWN', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50', bg: 'bg-muted/30', badge: 'neutral' },
};

function deriveWsMachineState(live: WsLive | null, appConnection: AppConnectionState): WsMachineState {
  // The backend is unreachable → no WebSocket state can be truthful.
  if (appConnection !== 'CONNECTED') return 'BACKEND_UNAVAILABLE';
  if (!live) return 'UNKNOWN';

  const sup = String(live.supervisorState ?? '').toUpperCase();
  const st = String(live.state ?? '').toUpperCase();

  // Hard-connected states: only a real connected flag + supervisor CONNECTED.
  if (live.connected === true) return 'CONNECTED';
  if (sup === 'CONNECTED') return 'CONNECTED';

  if (st === 'WS_CONNECTING' || sup === 'CONNECTING') return 'CONNECTING';

  if (st === 'WS_RECONNECTING' || sup === 'RECONNECTING' || sup === 'NETWORK_OFFLINE' || sup === 'AUTH_REQUIRED') {
    return 'RECONNECTING';
  }

  if (sup === 'ERROR' || sup === 'AUTH_FAILED' || sup === 'BROKER_UNAVAILABLE' || st === 'WS_ERROR') {
    return 'ERROR';
  }

  if (sup === 'STOPPED' || sup === 'STOPPING' || st === 'WS_DISCONNECTED' || st === 'WS_WAITING') {
    return live.disconnectedAt ? 'DISCONNECTED' : 'NOT_CONFIGURED';
  }

  if (sup === 'WAITING_FOR_MARKET_WINDOW') return 'NOT_CONFIGURED';

  return 'DISCONNECTED';
}

/** Severity of a persisted WS event → log level (never fabricated). */
function eventLevel(ev: WsEvent): 'info'|'warning'|'error'|'success' {
  const t = String(ev.event_type ?? '').toUpperCase();
  if (t.includes('CONNECTED') || t.includes('RE_CONNECTED') || t === 'FEED_RESUMED') return 'success';
  if (t.includes('RE_CONNECT') || t.includes('STALE') || t.includes('DEGRADED')) return 'warning';
  if (t.includes('ERROR') || t.includes('FAIL') || t.includes('DISCONNECT') || ev.severity === 'error') return 'error';
  return 'info';
}

function fmtDuration(sec?: number | null): string {
  if (sec == null) return '—';
  if (sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtTsIST(ts?: string | null): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return ts; }
}

function fmtTsShort(ts?: string | null): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return ts; }
}

function fmtTsFull(ts?: string | null): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return ts; }
}

function fmtNum(n?: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

/** IST calendar day (YYYY-MM-DD) for a timestamp — the key the backend stores on each record. */
function istTodayKey(now?: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now ?? Date.now()));
}

/** IST calendar day of an ISO timestamp (YYYY-MM-DD), or null when unparseable. */
function istDayKey(ts?: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch { return null; }
}

/** The record's own day when the backend stored one, else derived from connect time. */
function recordDay(r: { date?: string; connected_at?: string }): string | null {
  return r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : istDayKey(r.connected_at);
}

/** Time only — the day now lives in its own column, so it is not repeated here. */
function fmtTsTime(ts?: string | null): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return ts; }
}

/** Whole days between two IST calendar days (b - a), or null when either is unknown. */
function daysBetween(a: string, b: string): number | null {
  const pa = Date.parse(`${a}T00:00:00Z`);
  const pb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null;
  return Math.round((pb - pa) / 86400000);
}

/** "Today" / "Yesterday" / "N days ago" / "12 Oct 2026" for a record's IST day. */
function dayRelativeLabel(day: string, todayKey: string): string {
  const diff = daysBetween(day, todayKey);
  if (diff == null) return day;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff <= 30) return `${diff} days ago`;
  const d = new Date(`${day}T00:00:00+05:30`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtPercent(v?: number | null): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Math.round(v * 10) / 10}%`;
}

const stateStyle = (state?: string) => {
  const s = (state || '').toUpperCase();
  if (s.includes('CONNECTED') && !s.includes('RECONNECT') && !s.includes('DISCONNECT'))
    return { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success', label: 'Connected' };
  if (s.includes('RECEIVING'))
    return { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success', label: 'Receiving' };
  if (s.includes('CONNECTING'))
    return { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400 animate-pulse', label: 'Connecting' };
  if (s.includes('SUBSCRIB'))
    return { bg: 'bg-cyan-500/10', text: 'text-cyan-400', dot: 'bg-cyan-400 animate-pulse', label: 'Subscribing' };
  if (s.includes('RECONNECT'))
    return { bg: 'bg-warning/10', text: 'text-warning', dot: 'bg-warning animate-pulse', label: 'Reconnecting' };
  if (s.includes('WAITING'))
    return { bg: 'bg-muted/30', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50 animate-pulse', label: 'Waiting' };
  if (s.includes('ERROR') || s.includes('FAILED'))
    return { bg: 'bg-destructive/10', text: 'text-destructive', dot: 'bg-destructive', label: 'Error' };
  if (s.includes('STOPPED'))
    return { bg: 'bg-muted/30', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50', label: 'Stopped' };
  if (s.includes('DEGRADED'))
    return { bg: 'bg-orange-500/10', text: 'text-orange-400', dot: 'bg-orange-400', label: 'Degraded' };
  if (s.includes('STALE'))
    return { bg: 'bg-orange-500/10', text: 'text-orange-400', dot: 'bg-orange-400', label: 'Stale' };
  if (s.includes('NO_FEED'))
    return { bg: 'bg-muted/30', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50', label: 'No Feed' };
  if (s.includes('OFFLINE'))
    return { bg: 'bg-destructive/10', text: 'text-destructive', dot: 'bg-destructive', label: 'Offline' };
  return { bg: 'bg-muted/30', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50', label: 'Disconnected' };
};

export default function Phase2WebSocketPage() {
  const { toast } = useToast();
  const { state, appConnection, hydrated } = useRealtime();

  // LIVE — dual backend feed (both 100% real backend data, never fabricated):
  //   1. SSE stream — RealtimeProvider merges the backend's `ws_live` frame
  //      (~every 3s) onto `state.websocket.live`. Always wins when present.
  //   2. HTTP poll — direct GET /api/websocket/live every 5s as fallback +
  //      enrichment (tick pipeline, market calendar, retention policy).
  const [livePoll, setLivePoll] = useState<any>(null);
  const sseLive: WsLive | null = state?.websocket?.live ?? null;
  const live: WsLive | null = sseLive ?? (livePoll?.live as WsLive | null) ?? null;
  const liveSource: 'SSE' | 'POLL' | null = sseLive ? 'SSE' : livePoll?.live ? 'POLL' : null;

  // Canonical state machine state — BACKEND_UNAVAILABLE when SSE isn't connected.
  const machineState = deriveWsMachineState(live, appConnection);
  const backendOnline = appConnection === 'CONNECTED';

  const [metrics, setMetrics] = useState<WsMetrics | null>(null);
  const [rangeIdx, setRangeIdx] = useState(2); // 24h
  const [telemetry, setTelemetry] = useState<{ series: TelemetryPoint[] } | null>(null);
  const [events, setEvents] = useState<WsEventsResponse | null>(null);
  const [daily, setDaily] = useState<WsDailyResponse | null>(null);
  const [history, setHistory] = useState<WsHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // --- LIVE WEBSOCKET LOG (bounded in-memory buffer) ---
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logPaused, setLogPaused] = useState(false);
  const [logFilter, setLogFilter] = useState<'ALL'|'info'|'warning'|'error'|'success'>('ALL');
  // --- Advanced: auto-refresh charts/metrics + event text filter ---
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [eventFilter, setEventFilter] = useState('');
  const logRef = useRef<LogEntry[]>([]);
  const knownEventIds = useRef<Set<string>>(new Set());

  const appendLog = useCallback((entry: LogEntry) => {
    logRef.current = [entry, ...logRef.current].slice(0, LOG_CAP);
    setLog([...logRef.current]);
  }, []);

  const clearLog = useCallback(() => {
    logRef.current = [];
    knownEventIds.current = new Set();
    setLog([]);
  }, []);

  // history filters
  const [historyStatus, setHistoryStatus] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(0);

  // detail drawer
  const [detail, setDetail] = useState<{ record: WsRecord; events: WsEvent[] } | null>(null);

  // destructive-action confirmation dialogs
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [cleanupDays, setCleanupDays] = useState('');
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);

  const fetchMetrics = useCallback(async (hours: number) => {
    try {
      const d = await getWebsocketMetrics(hours);
      if (d) setMetrics(d);
      return d ?? null;
    } catch { return null; }
  }, []);

  const fetchTelemetry = useCallback(async (hours: number, resolution: number) => {
    try {
      const d = await getWebsocketTelemetrySeries(`?hours=${hours}&resolution=${resolution}&limit=3000`);
      if (d) setTelemetry({ series: d.series ?? [] });
      return d ?? null;
    } catch { return null; }
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      const d = await getWebsocketEventsFiltered('?limit=80');
      if (d) {
        setEvents(d);
        // Append any newly-persisted events to the live log (dedup by _id)
        const incoming = (d.events ?? []) as WsEvent[];
        const fresh = incoming.filter((ev) => !knownEventIds.current.has(ev._id));
        if (fresh.length > 0 && !logPaused) {
          fresh.forEach((ev) => {
            knownEventIds.current.add(ev._id);
            const ts = toMs(ev.timestamp);
            appendLog({
              key: ev._id,
              ts: ts ?? Date.now(),
              level: eventLevel(ev),
              event: String(ev.event_type ?? 'event').toUpperCase(),
              message: ev.message ?? ev.details ?? '',
            });
          });
        }
        // Seed the id set even when paused (so resuming doesn't flood duplicates)
        incoming.forEach((ev) => knownEventIds.current.add(ev._id));
      }
      return d ?? null;
    } catch { return null; }
  }, [appendLog, logPaused]);

  const fetchDaily = useCallback(async (date?: string) => {
    try {
      const d = await getWebsocketDaily(date ? `?date=${encodeURIComponent(date)}` : '');
      setDaily(d);
      return d ?? null;
    } catch { return null; }
  }, []);

  const fetchHistory = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(page * PAGE_SIZE));
    if (historyStatus) params.set('status', historyStatus);
    if (search.trim()) params.set('search', search.trim());
    params.set('sort', sort);
    try {
      const d = await getWebsocketHistory(`?${params.toString()}`);
      if (d) setHistory(d);
    } catch { /* table keeps last good data */ }
  }, [historyStatus, search, sort, page]);

  const refreshRealtimeViews = useCallback(async () => {
    const r = RANGES[rangeIdx];
    await Promise.all([
      fetchMetrics(r.hours),
      fetchEvents(),
    ]);
  }, [fetchMetrics, fetchEvents, rangeIdx]);

  const refreshAll = useCallback(async () => {
    const r = RANGES[rangeIdx];
    await Promise.all([
      refreshRealtimeViews(),
      fetchTelemetry(r.hours, r.resolution),
      fetchDaily(),
      fetchHistory(),
    ]);
  }, [refreshRealtimeViews, fetchTelemetry, fetchDaily, fetchHistory, rangeIdx]);

  useEffect(() => {
    refreshAll().finally(() => setLoading(false));
  }, [refreshAll]);

  // Range switch → refetch availability + charts for the new window.
  useEffect(() => {
    const r = RANGES[rangeIdx];
    fetchMetrics(r.hours);
    fetchTelemetry(r.hours, r.resolution);
  }, [rangeIdx, fetchMetrics, fetchTelemetry]);

  // Live log polling: only while the page is mounted and the backend is online.
  // Bounded light request (~10s) that ONLY surfaces genuinely new persisted events.
  useEffect(() => {
    if (!backendOnline) return;
    const id = setInterval(() => { fetchEvents(); }, LOG_POLL_MS);
    return () => clearInterval(id);
  }, [backendOnline, fetchEvents]);

  // Direct backend live poll every 5s — fallback + enrichment for the SSE
  // frame (tick pipeline, market calendar, retention policy). The SSE frame
  // always wins when present; this keeps every card live even if the stream
  // lags for a beat.
  useEffect(() => {
    if (!backendOnline) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const d = await getWebsocketLive();
        if (!cancelled && d) setLivePoll(d);
      } catch { /* SSE frame keeps the UI alive */ }
    };
    pull();
    const id = setInterval(pull, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [backendOnline]);

  // Advanced: chart/metric auto-refresh every 30s (toggleable). The live
  // connection frame already streams at realtime rate via SSE + 5s poll; this
  // only refreshes the history-backed views (metrics, telemetry).
  useEffect(() => {
    if (!autoRefresh || !backendOnline) return;
    const id = setInterval(() => {
      const r = RANGES[rangeIdx];
      fetchMetrics(r.hours);
      fetchTelemetry(r.hours, r.resolution);
    }, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, backendOnline, rangeIdx, fetchMetrics, fetchTelemetry]);

  // Emit a real-time log entry when the state machine transitions, using the
  // backend's OWN timestamps from the live frame (never the browser clock).
  const machineKey = `${machineState}|${live?.connectionId ?? ''}|${live?.connectedAt ?? ''}|${live?.disconnectedAt ?? ''}`;
  const lastMachineKey = useRef<string | null>(null);
  useEffect(() => {
    if (machineKey === lastMachineKey.current) return;
    lastMachineKey.current = machineKey;
    if (!live) return;
    if (logPaused) return;

    const realTs = machineState === 'CONNECTED'
      ? (toMs(live.connectedAt) ?? Date.now())
      : machineState === 'RECONNECTING' || machineState === 'DISCONNECTED'
        ? (toMs(live.disconnectedAt) ?? toMs(live.feedStateSince) ?? Date.now())
        : (toMs(live.feedStateSince) ?? Date.now());

    appendLog({
      key: `machine-${machineState}-${realTs}`,
      ts: realTs,
      level: machineState === 'CONNECTED' ? 'success' : machineState === 'ERROR' ? 'error' : machineState === 'RECONNECTING' ? 'warning' : machineState === 'CONNECTING' ? 'info' : machineState === 'BACKEND_UNAVAILABLE' ? 'error' : 'info',
      event: machineState,
      message: machineStateMessage(machineState, live),
    });

    // State transitions also trigger a refresh of the realtime views.
    refreshRealtimeViews();
  }, [machineKey, machineState, live, logPaused, appendLog, refreshRealtimeViews]);

  // Seed known event ids from the first load (avoids re-adding on mount)
  const firstLoadRef = useRef(true);
  useEffect(() => {
    if (firstLoadRef.current && events) {
      firstLoadRef.current = false;
      (events.events ?? []).forEach((ev) => knownEventIds.current.add(ev._id));
    }
  }, [events]);

  // When the backend drops, append an honest BACKEND_UNAVAILABLE log entry +
  // clear the live-only views so nothing stale stays on screen.
  const lastBackendState = useRef<AppConnectionState>('CONNECTING');
  useEffect(() => {
    const prev = lastBackendState.current;
    lastBackendState.current = appConnection;
    if (prev === 'CONNECTED' && appConnection !== 'CONNECTED') {
      appendLog({
        key: `backend-down-${Date.now()}`,
        ts: Date.now(),
        level: 'error',
        event: 'BACKEND_UNAVAILABLE',
        message: 'Backend connection lost — WebSocket state cannot be trusted until reconnected.',
      });
      setEvents(null);
      setLivePoll(null);
    }
  }, [appConnection, appendLog]);

  const openDetail = async (connectionId: string) => {
    try {
      const d = await getWebsocketRecord(connectionId);
      if (d) setDetail({ record: d.record, events: d.events ?? [] });
    } catch {
      toast({ title: 'Could not load detail', variant: 'destructive' });
    }
  };

  const deleteRow = async (connectionId: string) => {
    try {
      await deleteWebsocketRecord(connectionId);
      toast({ title: 'Record deleted' });
      if (detail?.record?.connection_id === connectionId) setDetail(null);
      fetchHistory();
    } catch {
      toast({ title: 'Delete failed', variant: 'destructive' });
    }
  };

  const handleClearAll = async () => {
    setClearBusy(true);
    try {
      const d = await clearWebsocketHistory();
      toast({ title: 'History cleared', description: `${d?.deleted ?? 0} record(s) removed` });
      setHistory((prev) => prev ? { ...prev, records: [], total: 0 } : prev);
      setClearOpen(false);
      fetchDaily();
      fetchEvents();
    } catch {
      toast({ title: 'Clear failed', variant: 'destructive' });
    } finally {
      setClearBusy(false);
    }
  };

  const handleCleanup = async () => {
    setCleanupBusy(true);
    try {
      const parsed = parseInt(cleanupDays, 10);
      const forced = Number.isFinite(parsed) && parsed >= 1 ? parsed : 0;
      const d = await runWebsocketCleanupDays(forced);
      toast({
        title: 'Retention cleanup done',
        description: `${d?.deleted ?? 0} record(s) removed (${d?.requestedDays ?? d?.retentionDays ?? 7}d)`,
      });
      setCleanupOpen(false);
      setCleanupDays('');
      refreshAll();
    } catch {
      toast({ title: 'Cleanup failed', variant: 'destructive' });
    } finally {
      setCleanupBusy(false);
    }
  };

  const range = RANGES[rangeIdx];
  const st = MACHINE_STYLES[machineState];
  const records = useMemo(() => history?.records ?? [], [history]);
  const total = history?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const summary = daily?.summary;
  const rates = live?.rates ?? {};
  const market = live?.market ?? livePoll?.market ?? null;
  const retentionDays = (broadcastRetentionDays(state) ?? livePoll?.retentionDays ?? null);
  const availability = metrics?.availabilityPercent ?? metrics?.uptimePercent ?? null;

  // Today's IST day + how the visible page breaks down by day. A slow clock
  // tick is enough to re-mark rows if the page is left open across midnight.
  const [browserNow, setBrowserNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setBrowserNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const todayKey = useMemo(() => istTodayKey(browserNow), [browserNow]);
  const todayCount = useMemo(
    () => records.reduce((n, r) => (recordDay(r) === todayKey ? n + 1 : n), 0),
    [records, todayKey],
  );
  const dayBuckets = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      const d = recordDay(r);
      if (d) m.set(d, (m.get(d) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [records]);
  const todayLabel = useMemo(() => {
    const d = new Date(`${todayKey}T00:00:00+05:30`);
    if (isNaN(d.getTime())) return todayKey;
    return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  }, [todayKey]);

  const dailyChartData = useMemo(() => {
    if (!summary) return [];
    return [
      { name: 'Messages', value: summary.messages ?? 0 },
      { name: 'Ticks', value: summary.ticks ?? 0 },
      { name: 'Errors', value: summary.errors ?? 0 },
      { name: 'Disconnects', value: summary.disconnects ?? 0 },
      { name: 'Connections', value: summary.connections ?? 0 },
    ];
  }, [summary]);

  const incidentEvents = useMemo(
    () => (events?.events ?? []).filter((ev) => INCIDENT_TYPES.includes(String(ev.event_type ?? '').toUpperCase())),
    [events],
  );

  const filteredEvents = useMemo(() => {
    const q = eventFilter.trim().toLowerCase();
    const list = (events?.events ?? []).slice(0, 30);
    if (!q) return list;
    return list.filter((ev) =>
      String(ev.event_type ?? '').toLowerCase().includes(q) ||
      String(ev.message ?? '').toLowerCase().includes(q) ||
      String(ev.connection_id ?? '').toLowerCase().includes(q),
    );
  }, [events, eventFilter]);

  if (loading && !backendOnline) {
    return <LoadingState text="Connecting to backend…" />;
  }

  return (
    <div className="space-y-4 pb-2">
      <PageHeader title="WebSocket Monitor" subtitle="Kotak Neo SFeed supervisor · live backend stream (SSE) + 5s HTTP poll fallback · 100% real-time data">
        <div className="flex flex-wrap items-center gap-2">
          <ConnectionStateLabel
            label="Browser Network"
            ok={typeof navigator !== 'undefined' ? navigator.onLine : true}
            okText="ONLINE"
            badText="OFFLINE"
            unknown={typeof navigator === 'undefined' || appConnection === 'CONNECTING' && navigator.onLine}
          />
          <ConnectionStateLabel
            label="Backend"
            ok={backendOnline}
            okText="ONLINE"
            badText={appConnection === 'OFFLINE' ? 'OFFLINE' : appConnection === 'CONNECTING' ? 'CONNECTING' : 'RECONNECTING'}
            unknown={!hydrated && appConnection === 'CONNECTING'}
          />
          <ConnectionStateLabel
            label="Internet"
            ok={!!live?.internetOk}
            okText="ONLINE"
            badText={live?.internetOk == null ? 'UNKNOWN' : 'OFFLINE'}
            unknown={live?.internetOk == null}
          />
          <ConnectionStateLabel
            label="Market"
            ok={(market?.market_status ?? '').toUpperCase() === 'OPEN'}
            okText={String(market?.market_status ?? 'OPEN').toUpperCase()}
            badText={String(market?.market_status ?? 'CLOSED').toUpperCase()}
            unknown={!market}
          />
          <ConnectionStateLabel
            label="Session"
            ok={!!live?.sessionId}
            okText="ACTIVE"
            badText="INACTIVE"
            unknown={!live}
          />
          <Button asChild size="sm" variant="ghost">
            <a href={exportWebsocketUrl(range.hours, 'csv')}>
              <Download className="h-4 w-4 mr-1.5" /> CSV
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={exportWebsocketUrl(range.hours, 'json')}>
              <Download className="h-4 w-4 mr-1.5" /> JSON
            </a>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCleanupOpen(true)}>Cleanup</Button>
          <Button size="sm" variant="ghost" onClick={() => setClearOpen(true)} className="text-destructive">Clear History</Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? 'Auto-refresh ON (30s) — click to pause' : 'Auto-refresh paused — click to resume'}
            className={cn(autoRefresh && 'text-teal-500')}
          >
            {autoRefresh ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            <span className="ml-1 hidden text-[10px] sm:inline">{autoRefresh ? 'Live' : 'Paused'}</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={refreshAll}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </PageHeader>

      {/* ── HERO: live backend status strip (SSE stream + 5s poll fallback) ── */}
      <div className={cn('relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br px-5 py-4', heroGradient(machineState))}>
        <div className="pointer-events-none absolute -right-10 -top-12 h-44 w-44 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -left-8 -bottom-14 h-36 w-36 rounded-full bg-white/5 blur-2xl" />
        <div className="relative flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-3">
            <span className={cn('relative flex h-12 w-12 items-center justify-center rounded-2xl shadow-lg', st.bg)}>
              {machineState === 'CONNECTED' && (
                <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-2xl opacity-20', st.dot)} />
              )}
              <span className={cn('relative h-4 w-4 rounded-full', st.dot)} />
            </span>
            <div>
              <p className={cn('flex items-center gap-2 text-xl font-bold leading-tight', st.text)}>
                {st.label}
                {liveSource && backendOnline && (
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold tracking-wider text-emerald-400">
                    LIVE · {liveSource === 'SSE' ? 'SSE STREAM' : 'HTTP POLL 5s'}
                  </span>
                )}
                {!backendOnline && (
                  <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[9px] font-semibold tracking-wider text-destructive">
                    OFFLINE
                  </span>
                )}
              </p>
              <p className="max-w-[320px] truncate font-mono text-[10px] text-muted-foreground" title={live?.connectionId ?? ''}>
                {live?.connectionId || 'No active connection — waiting for backend live frame'}
              </p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <HeroMini label="Uptime" value={backendOnline && live?.connected ? fmtDuration(live.currentSessionUptimeSec) : '—'} gradient="from-emerald-500 to-green-600" />
            <HeroMini label="Ticks/s" value={rates.ticks_per_second != null ? String(rates.ticks_per_second) : '—'} gradient="from-teal-500 to-emerald-600" />
            <HeroMini label="Msg/s" value={rates.messages_per_second != null ? String(rates.messages_per_second) : '—'} gradient="from-sky-500 to-blue-600" />
            <HeroMini label="Subs" value={live?.subscriptionCount != null ? String(live.subscriptionCount) : '—'} gradient="from-violet-500 to-purple-600" />
            <HeroMini label="Tick age" value={live?.secondsSinceTick != null ? `${live.secondsSinceTick}s` : '—'} gradient="from-amber-500 to-orange-600" />
            <HeroMini label="Health" value={availability != null ? `${Math.round(availability * 10) / 10}%` : '—'} gradient="from-cyan-500 to-teal-600" />
          </div>
        </div>
      </div>

      {/* ── BACKEND UNAVAILABILITY BANNER ─────────────────────────────────── */}
      {!backendOnline && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
          <WifiOff className="h-5 w-5 text-destructive" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-destructive">BACKEND UNAVAILABLE</p>
            <p className="text-xs text-destructive/80">
              {appConnection === 'OFFLINE'
                ? 'The browser lost network connectivity. WebSocket state below is from the last known snapshot and is STALE.'
                : 'The application × backend realtime channel is not connected. Live WebSocket state cannot be trusted — attempting automatic reconnect.'}
            </p>
          </div>
          <StatusBadge status="danger" label={appConnection} />
        </div>
      )}

      {/* ── MARKET CLOSED / NO-FEED AWARENESS ─────────────────────────────── */}
      {backendOnline && live && live.connected === false && machineState !== 'BACKEND_UNAVAILABLE' && (
        <div className="flex items-center gap-3 rounded-xl border border-muted bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span>
            WebSocket is <strong>{st.label}</strong>
            {live.disconnectReason ? ` — ${live.disconnectReason}` : ''}
            {live.reconnectAttempt != null ? ` · reconnect attempt #${live.reconnectAttempt + 1}` : ''}.
            The broker supervisor will keep retrying per its backoff policy.
          </span>
        </div>
      )}

      {/* Row 1: Live Connection + Health Donut */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className={`relative overflow-hidden border-border/50 lg:col-span-2 ${st.bg}`}>
          <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] ${st.dot}`} />
          <CardContent className="px-5 py-4">
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${st.bg}`}>
                <span className={`h-3 w-3 rounded-full ${st.dot}`} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-xl font-bold ${st.text}`}>{st.label}</p>
                <p className="text-[11px] text-muted-foreground font-mono truncate">{live?.connectionId || 'No active connection'}</p>
              </div>
              {live?.feedState && (
                <StatusBadge status={live.feedState === 'RECEIVING' ? 'success' : live.feedState === 'STALE' ? 'warning' : 'neutral'} label={live.feedState} />
              )}
              {backendOnline && live?.connected && !live?.internetOk && (
                <StatusBadge status="danger" label="INTERNET DOWN" />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <LiveMetric label="Duration" value={backendOnline && live?.connected ? fmtDuration(live.currentSessionUptimeSec) : '—'} />
              <LiveMetric label="Messages" value={backendOnline ? fmtNum(live?.messagesReceived) : '—'} sub={rates.messages_per_second != null ? `${rates.messages_per_second} msg/s` : undefined} />
              <LiveMetric label="Ticks" value={backendOnline ? fmtNum(live?.ticksReceived) : '—'} sub={rates.ticks_per_second != null ? `${rates.ticks_per_second} ticks/s` : undefined} />
              <LiveMetric label="Subscriptions" value={backendOnline && live?.subscriptionCount != null ? `${live.subscriptionCount}${live.subscriptionRegistryCount ? ` / ${live.subscriptionRegistryCount}` : ''}` : '—'} />
              <LiveMetric label="Last Tick" value={backendOnline ? fmtTsIST(live?.lastTickAt) : '—'} sub={live?.secondsSinceTick != null ? `${live.secondsSinceTick}s ago` : undefined} />
              <LiveMetric label="Last Message" value={backendOnline ? fmtTsIST(live?.lastMessageAt) : '—'} />
              <LiveMetric label="Supervisor" value={String(live?.supervisorState ?? '—').toUpperCase()} sub={live?.sessionId ? String(live.sessionId).slice(0, 24) : undefined} />
              <LiveMetric label="Errors" value={backendOnline && live?.errorCount != null ? String(live.errorCount) : '—'} />
            </div>
          </CardContent>
        </Card>

        {/* Health Donut (real market-aware availability from persisted history) */}
        <Card className="border-border/50">
          <CardContent className="px-4 py-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">WebSocket Health</p>
              <div className="flex rounded-md border border-border/60 bg-card/40 text-[10px]">
                {RANGES.map((r, i) => (
                  <button
                    key={r.label}
                    onClick={() => setRangeIdx(i)}
                    className={`px-2 py-1 ${i === rangeIdx ? 'bg-muted/40 font-semibold text-foreground' : 'text-muted-foreground'}`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            {(metrics?.totalUptimeSec || 0) > 0 || (metrics?.totalDowntimeSec || 0) > 0 ? (
              <div className="space-y-2">
                <HealthDonut
                  uptimeSec={metrics?.totalUptimeSec ?? 0}
                  downtimeSec={metrics?.totalDowntimeSec ?? 0}
                  availability={availability}
                />
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{fmtDuration(metrics?.totalUptimeSec)} uptime</span>
                  <span>{fmtDuration(metrics?.totalDowntimeSec)} downtime</span>
                </div>
              </div>
            ) : (
              <div className="flex h-[132px] flex-col items-center justify-center text-xs text-muted-foreground">
                {metrics?.insufficient ? 'Insufficient history for this window' : 'No data yet'}
                {metrics?.insufficient && metrics?.measuredDays && (
                  <span className="mt-1 text-[9px] text-muted-foreground/60">
                    {metrics.measuredDays.length} day(s) with records — not enough to claim 0% uptime
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── ADVANCED: feed freshness + connection quality ─────────────────── */}
      <section aria-label="Feed freshness" className="space-y-2">
        <SectionHeading>
          <span className="flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5 text-teal-500" /> Feed Freshness & Quality</span>
        </SectionHeading>
        <FreshnessPanel
          live={{
            secondsSinceTick: live?.secondsSinceTick ?? null,
            secondsSinceMessage: live?.secondsSinceMessage ?? null,
            feedState: live?.feedState ?? null,
            connected: live?.connected ?? null,
          }}
          quality={{
            availabilityPct: availability,
            totalMessages: metrics?.totalMessages ?? null,
            totalErrors: metrics?.totalErrors ?? null,
            reconnectCount: metrics?.reconnectCount ?? live?.reconnectCount ?? null,
          }}
          series={telemetry?.series ?? []}
        />
      </section>

      {/* ── STATE MACHINE + CONNECTION TIMELINE ───────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section aria-label="State machine" className="space-y-2">
          <SectionHeading>WebSocket State Machine</SectionHeading>
          <div className="rounded-xl border border-border/50 bg-card/50 p-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <StatusBadge status={st.badge} label={st.label} />
              <span className="text-[10px] font-mono text-muted-foreground">{machineKey.split('|')[0]}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
              <StateRow label="Connecting" value={live?.connectedAt ? fmtTsIST(live.connectedAt) : '—'} />
              <StateRow label="Disconnect" value={live?.disconnectedAt ? fmtTsIST(live.disconnectedAt) : '—'} />
              <StateRow label="Feed since" value={live?.feedStateSince ? fmtTsIST(live.feedStateSince) : '—'} />
              <StateRow label="Reconnects" value={live?.reconnectCount != null ? String(live.reconnectCount) : '—'} />
              <StateRow label="Backoff attempt" value={live?.reconnectAttempt != null ? String(live.reconnectAttempt) : '—'} />
              <StateRow label="Feed state" value={String(live?.feedState ?? '—')} />
            </div>
            {(!backendOnline || live == null) ? (
              <p className="mt-3 text-[10px] text-muted-foreground">
                No current WebSocket session data — state machine cannot show transitions until the backend is reachable.
              </p>
            ) : (
              <p className="mt-3 text-[10px] text-muted-foreground">
                Transitions below come from REAL backend events (persisted in <code className="font-mono">websocket_events</code>).
              </p>
            )}
          </div>
        </section>

        <section aria-label="Connection timeline" className="space-y-2">
          <SectionHeading>Connection Timeline ({incidentEvents.length})</SectionHeading>
          <div className="rounded-xl border border-border/50 bg-card/40 p-3">
            {incidentEvents.length === 0 ? (
              <div className="flex h-[150px] items-center justify-center text-xs text-muted-foreground">
                No persisted connection events in the last {events?.total ?? 0} event(s) — feed stayed healthy
                {!backendOnline && ' (timestamp sources unavailable while backend is offline)'}.
              </div>
            ) : (
              <Timeline events={incidentEvents} />
            )}
          </div>
        </section>
      </div>

      {/* ── LIVE WEBSOCKET LOG ─────────────────────────────────────────────── */}
      <section aria-label="Live websocket log" className="space-y-2">
        <SectionHeading>Live WebSocket Log</SectionHeading>
        <div className="rounded-xl border border-border/50 bg-card/40 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mr-1">Filter</span>
            {(['ALL','info','warning','error','success'] as const).map((f) => (
              <button key={f}
                onClick={() => setLogFilter(f)}
                className={cn('rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                  logFilter === f ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70')}
                aria-pressed={logFilter === f}
              >{f.toUpperCase()}</button>
            ))}
            <div className="flex-1" />
            <button onClick={() => setLogPaused(p => !p)}
              className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
              aria-pressed={logPaused}
            >{logPaused ? 'Resume' : 'Pause'}</button>
            <button onClick={clearLog}
              className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
              title="Clear view only (does NOT delete persisted history)"
            >Clear view</button>
          </div>

          <div className="max-h-[320px] overflow-y-auto rounded-md border border-border/50 font-mono text-[11px]">
            {log.length === 0 ? (
              <p className="flex items-center justify-center h-[120px] text-xs text-muted-foreground font-sans">
                No events yet — log entries appear on real connect / disconnect / reconnect / error events.
              </p>
            ) : (
              log.filter((e) => logFilter === 'ALL' || e.level === logFilter).map((e) => (
                <div key={e.key} className="flex items-start gap-2 border-b border-border/20 px-3 py-1.5">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTsISTMs(e.ts)}</span>
                  <span className={cn('shrink-0 font-semibold', logLevelText(e.level))}>{e.event}</span>
                  {e.instrument && <span className="shrink-0 text-muted-foreground">{e.instrument}</span>}
                  <span className="flex-1 min-w-0 text-muted-foreground break-words">{e.message}</span>
                </div>
              ))
            )}
          </div>
          {log.length === 0 && (
            <p className="text-[9px] text-muted-foreground/60">
              Transitions are recorded with the backend&apos;s own timestamps (live frame / persisted event time) — never the browser clock.
            </p>
          )}
        </div>
      </section>

      {/* Row 2: Live Rates + Current Connection + Pipeline */}
      <section aria-label="Live metrics" className="space-y-2">
        <SectionHeading>Live Rates{live?.feedState ? ` · Feed ${live.feedState}` : ''}</SectionHeading>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <RateCard label="Msg/s (1s)" value={rates.messages_per_second} />
          <RateCard label="Msg/s (5s avg)" value={rates.messages_5s_average} />
          <RateCard label="Msg/s (60s avg)" value={rates.messages_60s_average} />
          <RateCard label="Tick/s (1s)" value={rates.ticks_per_second} />
          <RateCard label="Tick/s (5s avg)" value={rates.ticks_5s_average} />
          <RateCard label="Tick/s (60s avg)" value={rates.ticks_60s_average} />
        </div>
      </section>

      <section aria-label="Current connection" className="space-y-2">
        <SectionHeading>Current Connection</SectionHeading>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <MetricTile label="Supervisor" value={backendOnline ? String(live?.supervisorState ?? '—').toUpperCase() : 'UNAVAILABLE'} sub={live?.state ? String(live.state).toUpperCase() : undefined} icon={Activity} />
          <MetricTile label="Feed State" value={backendOnline ? String(live?.feedState ?? '—').toUpperCase() : 'UNAVAILABLE'} sub={live?.feedStateSince ? fmtTsIST(live.feedStateSince) : undefined} icon={Wifi} />
          <MetricTile label="Reconnect Attempt" value={backendOnline && live?.reconnectAttempt != null ? String(live.reconnectAttempt) : '—'} sub={live?.reconnectCount != null ? `${live.reconnectCount} reconnects` : undefined} icon={RefreshCw} />
          <MetricTile label="Disconnect Reason" value={backendOnline && live?.disconnectReason ? String(live.disconnectReason).slice(0, 40) : '—'} sub={live?.disconnectReasonCode ? `code ${live.disconnectReasonCode}` : undefined} icon={AlertTriangle} />
          <MetricTile label="Backend Internet" value={backendOnline && live?.internetOk != null ? (live.internetOk ? 'OK' : 'DOWN') : '—'} icon={live?.internetOk ? Wifi : WifiOff} />
          <MetricTile label="Last Connection" value={backendOnline ? fmtTsIST(live?.connectedAt) : '—'} icon={Clock} />
        </div>
      </section>

      <section aria-label="Persistence" className="space-y-2">
        <SectionHeading>MongoDB Persistence Pipeline</SectionHeading>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <MetricTile label="Pipeline" value={backendOnline && pipelineRunning(state) ? 'RUNNING' : 'STOPPED'} sub={backendOnline && pipelineStartedAt(state) ? `since ${fmtTsShort(pipelineStartedAt(state))}` : undefined} icon={Database} />
          <MetricTile label="Written" value={fmtNum(ticksPersisted(state))} sub={fmtNum(ticksAttempted(state)) != '—' ? `${fmtNum(ticksAttempted(state))} attempted` : undefined} icon={Server} />
          <MetricTile label="Write Errors" value={fmtNum(ticksWriteErrors(state))} sub={persistRateLabel(state)} icon={ShieldCheck} />
          <MetricTile label="Buffer" value={bufferLabel(state)} icon={Server} />
          <MetricTile label="Active Stocks" value={fmtNum(activeTickStocks(state))} icon={Zap} />
          <MetricTile label="Retention" value={retentionDays != null ? `${retentionDays}d` : '—'} sub="ws_retention_days policy" icon={Server} />
        </div>
      </section>

      {/* Event timeline (recent persisted events) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section aria-label="Event timeline" className="space-y-2">
          <SectionHeading>Recent Events ({events?.total ?? 0})</SectionHeading>
          <div className="rounded-xl border border-border/50 bg-card/40 p-3">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={eventFilter}
                onChange={(e) => setEventFilter(e.target.value)}
                placeholder="Filter events by type, message or connection…"
                className="w-full rounded-md border border-border/60 bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:border-teal-500/60"
              />
            </div>
            {(events?.events ?? []).length === 0 ? (
              <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
                No persisted events yet — they appear on connect / reconnect / feed issues.
              </div>
            ) : filteredEvents.length === 0 ? (
              <div className="flex h-[80px] items-center justify-center text-xs text-muted-foreground">
                No events match &quot;{eventFilter}&quot;.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
                {filteredEvents.map((ev) => {
                  const tone = eventTone(ev.event_type, ev.severity);
                  return (
                    <div key={ev._id} className="flex items-start gap-2 text-xs">
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                      <span className="flex-1 min-w-0">
                        <span className={`font-medium ${tone.text}`}>{String(ev.event_type ?? 'event').toUpperCase()}</span>
                        {ev.message && <span className="ml-1.5 text-muted-foreground break-words">— {ev.message}</span>}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{fmtTsIST(ev.timestamp)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section aria-label="Reconnect and incident history" className="space-y-2">
          <SectionHeading>Reconnects &amp; Incidents ({incidentEvents.length})</SectionHeading>
          <div className="rounded-xl border border-border/50 bg-card/40 p-3">
            {incidentEvents.length === 0 ? (
              <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
                No reconnects, stale feeds or disconnects in the last {events?.total ?? 0} event(s) — feed stayed healthy.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
                {incidentEvents.map((ev) => {
                  const tone = eventTone(ev.event_type, ev.severity);
                  return (
                    <div key={ev._id} className="flex items-start gap-2 text-xs">
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                      <span className="flex-1 min-w-0">
                        <span className={`font-medium ${tone.text}`}>{String(ev.event_type ?? 'event').toUpperCase()}</span>
                        {ev.message && <span className="ml-1.5 text-muted-foreground break-words">— {ev.message}</span>}
                        {ev.connection_id && (
                          <span className="ml-1.5 font-mono text-[9px] text-muted-foreground/60">{ev.connection_id}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{fmtTsIST(ev.timestamp)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Telemetry charts (real persisted minute buckets, gaps stay gaps) */}
      <section aria-label="Telemetry charts" className="space-y-2">
        <SectionHeading>Feed Telemetry — last {range.label}</SectionHeading>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <div className="rounded-xl border border-teal-500/20 bg-card/40 p-3">
            <p className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-teal-500" /> Throughput
              <span className="text-muted-foreground/60">(ticks/s teal · writes/s sky — real buckets)</span>
            </p>
            <ThroughputChart series={telemetry?.series ?? []} />
          </div>
          <div className="rounded-xl border border-violet-500/20 bg-card/40 p-3">
            <p className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-violet-500" /> Ticks per bucket
              <span className="text-muted-foreground/60">(received violet · written amber)</span>
            </p>
            <BucketsChart series={telemetry?.series ?? []} />
          </div>
        </div>
      </section>

      {/* Metrics */}
      <section aria-label="Metrics" className="space-y-2">
        <SectionHeading>
          Metrics — last {range.label}
          {metrics?.insufficient && <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">insufficient history</span>}
        </SectionHeading>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricTile label="Availability" value={metrics?.insufficient ? 'Insufficient' : fmtPercent(availability)} sub={metrics?.totalUptimeSec != null ? `${fmtDuration(metrics.totalUptimeSec)} measured uptime` : undefined} icon={Clock} />
          <MetricTile label="Total Messages" value={metrics?.totalMessages != null ? fmtNum(metrics.totalMessages) : '—'} sub={metrics?.messagesPerSec != null ? `${metrics.messagesPerSec} msg/s avg` : undefined} icon={Activity} />
          <MetricTile label="Total Ticks" value={metrics?.totalTicks != null ? fmtNum(metrics.totalTicks) : '—'} sub={metrics?.ticksPerSec != null ? `${metrics.ticksPerSec} ticks/s avg` : undefined} icon={Server} />
          <MetricTile label="Connections" value={metrics?.connections != null ? String(metrics.connections) : '—'} sub={metrics?.errorsPerConnection != null ? `${metrics.errorsPerConnection} errors/conn` : undefined} icon={Wifi} />
          <MetricTile label="Reconnects" value={metrics?.reconnectCount != null ? String(metrics.reconnectCount) : '—'} sub={metrics?.heartbeatFailures != null ? `${metrics.heartbeatFailures} heartbeat fails` : undefined} icon={RefreshCw} />
          <MetricTile label="Errors" value={metrics?.totalErrors != null ? String(metrics.totalErrors) : '—'} sub={metrics?.dataGaps != null ? `${metrics.dataGaps} data gaps` : undefined} icon={AlertTriangle} />
        </div>
        {metrics?.insufficient && (
          <p className="text-[10px] text-muted-foreground/70">
            Downtime requires evidence of a lost connection inside an eligible market-open window — days with no records
            are not counted as downtime, so this window reports insufficient history instead of a fabricated 0% / full-day outage.
          </p>
        )}
      </section>

      {/* Today's Summary + Daily Chart */}
      <section aria-label="Daily summary" className="space-y-2">
        <SectionHeading>Today&apos;s Summary</SectionHeading>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="lg:col-span-1 grid grid-cols-2 gap-3">
            {[
              { label: 'Connections', value: summary?.connections != null ? String(summary.connections) : '—' },
              { label: 'Messages', value: summary?.messages != null ? fmtNum(summary.messages) : '—' },
              { label: 'Ticks', value: summary?.ticks != null ? fmtNum(summary.ticks) : '—' },
              { label: 'Errors', value: summary?.errors != null ? String(summary.errors) : '—' },
              { label: 'Disconnects', value: summary?.disconnects != null ? String(summary.disconnects) : '—' },
              { label: 'Uptime', value: fmtDuration(summary?.total_uptime_sec) },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-border/50 bg-card/50 p-3">
                <p className="text-[11px] text-muted-foreground">{s.label}</p>
                <p className="text-lg font-bold tabular-nums mt-0.5">{s.value}</p>
              </div>
            ))}
          </div>
          <div className="lg:col-span-2 rounded-xl border border-border/40 bg-card/40 p-3 h-full">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] text-muted-foreground">Daily breakdown ({summary?.date ?? 'today'})</p>
              <span className="text-[10px] text-muted-foreground/60">from persisted history</span>
            </div>
            {!summary ? (
              <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">No daily history yet</div>
            ) : (
              <DailyChart data={dailyChartData} />
            )}
          </div>
        </div>
      </section>

      {/* Connection History */}
      <section aria-label="History" className="space-y-2">
        <SectionHeading>Connection History ({total} record{total === 1 ? '' : 's'})</SectionHeading>
        <Card className="relative overflow-hidden border-border/50">
          <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-cyan-500 via-sky-500 to-indigo-500" />
          <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-48 w-48 rounded-full bg-sky-500/5 blur-3xl" />
          <CardContent className="relative px-4 py-3.5">

          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-[140px] flex-1">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search connection id, date or reason…"
                className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs focus:border-cyan-500/50 focus:outline-none"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-[10px] tabular-nums">
                <CalendarDays className="h-3 w-3 text-cyan-400" />
                Today <span className="font-semibold">{todayLabel}</span>
                <span className="text-muted-foreground">· {todayCount} here</span>
              </span>
              <select value={historyStatus} onChange={(e) => { setHistoryStatus(e.target.value); setPage(0); }}
                className="h-9 rounded-md border border-input bg-background px-2 text-xs focus:outline-none">
                <option value="">All statuses</option>
                <option value="connected">Connected</option>
                <option value="disconnected">Disconnected</option>
              </select>
              <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }}
                className="h-9 rounded-md border border-input bg-background px-2 text-xs focus:outline-none">
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="longest">Longest duration</option>
                <option value="shortest">Shortest duration</option>
                <option value="most_errors">Most errors</option>
                <option value="most_messages">Most messages</option>
              </select>
            </div>
          </div>

          {records.length === 0 ? (
            <EmptyState icon={WifiOff} title="No connection history" description="WebSocket connections will be logged here automatically" />
          ) : (
            <>
              <div className="hidden max-h-[460px] overflow-auto rounded-lg border border-border/50 md:block">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur text-muted-foreground text-left">
                    <tr className="border-b border-border/50 text-[10px] uppercase tracking-wider">
                      <th className="py-2 pl-3 pr-3 font-semibold">Date</th>
                      <th className="py-2 pr-3 font-semibold">Status</th>
                      <th className="py-2 pr-3 font-semibold">Connection</th>
                      <th className="py-2 pr-3 font-semibold">Time</th>
                      <th className="py-2 pr-3 font-semibold">Duration</th>
                      <th className="py-2 pr-3 text-right font-semibold">Messages</th>
                      <th className="py-2 pr-3 text-right font-semibold">Ticks</th>
                      <th className="py-2 pr-3 text-right font-semibold">Err</th>
                      <th className="py-2 pr-3 font-semibold">Reason</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => {
                      const rs = stateStyle(r.status);
                      const day = recordDay(r);
                      const isToday = day != null && day === todayKey;
                      return (
                        <tr
                          key={r.connection_id}
                          onClick={() => openDetail(r.connection_id)}
                          className={cn(
                            'group cursor-pointer border-b border-border/20 transition-colors hover:bg-muted/25',
                            isToday && 'bg-cyan-500/[0.04]',
                          )}
                        >
                          <td className="whitespace-nowrap py-2 pl-3 pr-3">
                            {day ? (
                              <span className="flex flex-col gap-0.5">
                                <span className={cn('font-mono text-[10px] font-semibold tabular-nums leading-none', isToday ? 'text-cyan-400' : 'text-foreground')}>
                                  {day}
                                </span>
                                <span className={cn('text-[8px] uppercase tracking-wide leading-none', isToday ? 'text-cyan-400/90' : 'text-muted-foreground/70')}>
                                  {dayRelativeLabel(day, todayKey)}
                                </span>
                              </span>
                            ) : (
                              <span className="text-[10px] text-muted-foreground/60">—</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            <span className={`inline-flex items-center gap-1.5 text-[10px] font-medium ${rs.text}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${rs.dot}`} />
                              {rs.label}
                            </span>
                          </td>
                          <td className="py-2 pr-3 font-mono text-[10px] text-muted-foreground max-w-[150px] truncate" title={r.connection_id}>{r.connection_id}</td>
                          <td className="py-2 pr-3 tabular-nums text-muted-foreground">{fmtTsTime(r.connected_at)}</td>
                          <td className="py-2 pr-3 tabular-nums">{fmtDuration(r.duration_sec)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(r.messages_received)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(r.ticks_received)}</td>
                          <td className="py-2 pr-3 text-right">
                            {r.error_count ? <span className="text-destructive font-medium">{r.error_count}</span> : <span className="text-muted-foreground/50">0</span>}
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground max-w-[160px] truncate" title={r.reason || ''}>{r.reason || '—'}</td>
                          <td className="py-2">
                            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100" title="Delete"
                              onClick={(e) => { e.stopPropagation(); deleteRow(r.connection_id); }}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="space-y-2 md:hidden">
                {records.map((r) => {
                  const rs = stateStyle(r.status);
                  const day = recordDay(r);
                  const isToday = day != null && day === todayKey;
                  return (
                    <div
                      key={r.connection_id}
                      onClick={() => openDetail(r.connection_id)}
                      className={cn(
                        'cursor-pointer rounded-lg border bg-card/50 p-3 space-y-2 transition-colors hover:bg-muted/30',
                        isToday ? 'border-cyan-500/40 bg-cyan-500/[0.05]' : 'border-border/50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`inline-flex items-center gap-1.5 text-[10px] font-medium ${rs.text}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${rs.dot}`} />
                          {rs.label}
                        </span>
                        <span className="flex items-center gap-1.5">
                          {day && (
<span className={cn('font-mono text-[10px] font-semibold tabular-nums', isToday ? 'text-cyan-400' : 'text-muted-foreground')}>
                            {day}{isToday ? ' · today' : ''}
                          </span>
                          )}
                          <span className="text-[10px] text-muted-foreground tabular-nums">{fmtDuration(r.duration_sec)}</span>
                        </span>
                      </div>
                      <p className="font-mono text-[10px] text-muted-foreground truncate">{r.connection_id}</p>
                      <p className="text-[10px] text-muted-foreground tabular-nums">connected {fmtTsTime(r.connected_at)} IST</p>
                      <div className="flex gap-4 text-[10px]">
                        <span className="text-muted-foreground">Msg: {fmtNum(r.messages_received)}</span>
                        <span className="text-muted-foreground">Ticks: {fmtNum(r.ticks_received)}</span>
                        {r.error_count ? <span className="text-destructive">Err: {r.error_count}</span> : null}
                      </div>
                      {r.reason && <p className="text-[10px] text-muted-foreground truncate">{r.reason}</p>}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
            <span className="tabular-nums">
              showing {records.length} of {total} · {dayBuckets.length} day(s) on this page
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Prev
                </Button>
                <span className="px-1 tabular-nums">{page + 1} / {totalPages}</span>
                <Button size="sm" variant="ghost" disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </div>
          </CardContent>
        </Card>
      </section>

      {/* Detail drawer */}
      {detail && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
          <div className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-background shadow-2xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-border/50 bg-background/90 px-4 py-3 backdrop-blur">
              <p className="text-sm font-semibold">Connection Detail</p>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setDetail(null)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="space-y-4 p-4">
              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Overview</p>
                <div className="space-y-2 text-xs">
                  <Row label="Connection ID" value={detail.record.connection_id} mono />
                  <Row label="Status" value={(detail.record.status || '—').toUpperCase()} />
                  <Row label="Connected" value={fmtTsFull(detail.record.connected_at)} />
                  <Row label="Disconnected" value={fmtTsFull(detail.record.disconnected_at)} />
                  <Row label="Duration" value={fmtDuration(detail.record.duration_sec)} />
                  <Row label="Session" value={detail.record.session_id || '—'} mono />
                  <Row label="Date" value={detail.record.date || '—'} />
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Traffic</p>
                <div className="space-y-2 text-xs">
                  <Row label="Messages" value={fmtNum(detail.record.messages_received)} />
                  <Row label="Ticks" value={fmtNum(detail.record.ticks_received)} />
                  <Row label="Errors" value={String(detail.record.error_count ?? 0)} />
                  <Row label="Avg msg/s" value={detail.record.duration_sec && detail.record.messages_received ? `${(detail.record.messages_received / detail.record.duration_sec).toFixed(1)}` : '—'} />
                  <Row label="Avg ticks/s" value={detail.record.duration_sec && detail.record.ticks_received ? `${(detail.record.ticks_received / detail.record.duration_sec).toFixed(1)}` : '—'} />
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Health</p>
                <div className="space-y-2 text-xs">
                  <Row label="Heartbeat failures" value={String(detail.record.heartbeat_failures ?? 0)} />
                  <Row label="Data gaps" value={String(detail.record.data_gaps ?? 0)} />
                  <Row label="Reconnects" value={String(detail.record.reconnect_count ?? 0)} />
                  <Row label="Subscriptions" value={String(detail.record.subscription_count ?? 0)} />
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Disconnect</p>
                <div className="space-y-2 text-xs">
                  <Row label="Close code" value={detail.record.close_code || '—'} />
                  <Row label="Reason" value={detail.record.reason || '—'} />
                </div>
              </div>

              <div>
                <SectionHeading>Event Timeline ({detail.events.length})</SectionHeading>
                {detail.events.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No events recorded for this connection.</p>
                ) : (
                  <div className="mt-2 space-y-1">
                    {detail.events.map((ev) => {
                      const sev = ev.severity === 'error' ? 'text-destructive' : ev.severity === 'warning' ? 'text-warning' : ev.severity === 'success' ? 'text-success' : 'text-muted-foreground';
                      return (
                        <div key={ev._id} className="rounded-lg border border-border/30 bg-card/30 px-3 py-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className={`font-medium ${sev}`}>{ev.event_type || 'event'}</span>
                            <span className="text-[10px] text-muted-foreground tabular-nums">{fmtTsIST(ev.timestamp)}</span>
                          </div>
                          {ev.message && <p className="mt-1 text-[10px] text-muted-foreground break-all">{ev.message}</p>}
                          {ev.details && <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70 break-all">{ev.details}</p>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="text-destructive hover:text-destructive"
                  onClick={() => { deleteRow(detail.record.connection_id); setDetail(null); }}>
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDetail(null)}>Close</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cleanup confirmation dialog (retention) */}
      <AlertDialog open={cleanupOpen} onOpenChange={setCleanupOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run retention cleanup?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes WebSocket history + events older than the retention policy
              {retentionDays != null ? ` (ws_retention_days = ${retentionDays}d)` : ''}.
              Optionally override the cutoff by entering a number of days (e.g. 2). This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <input
            value={cleanupDays}
            onChange={(e) => setCleanupDays(e.target.value)}
            placeholder={`Retention days (default ${retentionDays != null ? retentionDays : 7})…`}
            inputMode="numeric"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleanupBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={cleanupBusy} onClick={(e) => { e.preventDefault(); handleCleanup(); }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {cleanupBusy ? 'Cleaning…' : 'Cleanup'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear-all confirmation dialog */}
      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear ALL WebSocket history?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes every persisted connection record and event. This cannot be undone. New activity is recorded as it happens.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={clearBusy} onClick={(e) => { e.preventDefault(); handleClearAll(); }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {clearBusy ? 'Clearing…' : 'Clear all'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ========================================================================== */
/* Presentational helpers                                                     */
/* ========================================================================== */

function machineStateMessage(state: WsMachineState, live: WsLive): string {
  switch (state) {
    case 'CONNECTED':
      return live.feedState
        ? `WebSocket connected · feed ${live.feedState} · ${live.subscriptionCount ?? 0} subscriptions`
        : 'WebSocket connected';
    case 'CONNECTING':
      return live.disconnectReason ? `Connecting (last: ${live.disconnectReason})` : 'Connecting to Kotak SFeed…';
    case 'RECONNECTING':
      return `Reconnecting${live.reconnectAttempt != null ? ` — attempt #${live.reconnectAttempt + 1}` : ''}${live.disconnectReason ? ` (${live.disconnectReason})` : ''}`;
    case 'DISCONNECTED':
      return live.disconnectReason ? `Disconnected — ${live.disconnectReason}` : 'Disconnected';
    case 'ERROR':
      return live.disconnectReason || 'WebSocket error';
    case 'STOPPED':
      return 'Supervisor stopped';
    case 'NOT_CONFIGURED':
      return 'Supervisor waiting for market window';
    case 'BACKEND_UNAVAILABLE':
      return 'Backend unreachable — live state cannot be trusted';
    default:
      return 'State unknown';
  }
}

function Timeline({ events }: { events: WsEvent[] }) {
  const sorted = useMemo(
    () => [...(events ?? [])].sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp)),
    [events],
  );
  return (
    <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
      {sorted.map((ev) => {
        const tone = eventTone(ev.event_type, ev.severity);
        return (
          <div key={ev._id} className="flex items-start gap-2 text-xs">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
            <span className="flex-1 min-w-0">
              <span className={`font-medium ${tone.text}`}>{String(ev.event_type ?? 'event').toUpperCase()}</span>
              {ev.message && <span className="ml-1.5 text-muted-foreground break-words">— {ev.message}</span>}
              {ev.connection_id && (
                <span className="ml-1.5 font-mono text-[9px] text-muted-foreground/60">{ev.connection_id}</span>
              )}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{fmtTsIST(ev.timestamp)}</span>
          </div>
        );
      })}
    </div>
  );
}

function StateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/30 px-2 py-1.5">
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className="font-mono text-xs text-foreground tabular-nums">{value}</div>
    </div>
  );
}

function HeroMini({ label, value, gradient }: { label: string; value: string; gradient: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-3 py-1.5 backdrop-blur">
      <span className={cn('h-7 w-1.5 rounded-full bg-gradient-to-b', gradient)} />
      <span>
        <span className="block text-sm font-bold leading-none tabular-nums">{value}</span>
        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function LiveMetric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-card/40 px-2.5 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-bold tabular-nums">{value}</p>
      {sub && <p className="text-[9px] text-muted-foreground/70">{sub}</p>}
    </div>
  );
}

function RateCard({ label, value }: { label: string; value?: number }) {
  const tint = tileTint(label);
  return (
    <div className="rounded-xl border border-border/50 bg-card/50 p-3 transition-all hover:-translate-y-px hover:shadow-md">
      <div className="flex items-center gap-2">
        <span className={cn('h-6 w-1.5 rounded-full bg-gradient-to-b', tint)} />
        <p className="text-[10px] text-muted-foreground">{label}</p>
      </div>
      <p className="mt-1 text-lg font-bold tabular-nums">{value != null ? value.toFixed(1) : '—'}</p>
    </div>
  );
}

function MetricTile({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon: any }) {
  const tint = tileTint(label);
  return (
    <div className="rounded-xl border border-border/50 bg-card/50 p-3 transition-all hover:-translate-y-px hover:shadow-md">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn('flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm', tint)}>
          <Icon className="h-3 w-3" />
        </span>
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{sub}</p>}
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/20 pb-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium text-right ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  );
}

function ConnectionStateLabel({ label, ok, okText, badText, unknown }: { label: string; ok: boolean; okText: string; badText: string; unknown: boolean }) {
  const tone = unknown ? 'text-muted-foreground' : ok ? 'text-success' : 'text-destructive';
  const dot = unknown ? 'bg-muted-foreground/50' : ok ? 'bg-success' : 'bg-destructive';
  return (
    <span
      className="flex items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-2 py-1 text-[10px]"
      title={`${label}: ${unknown ? 'unknown' : ok ? okText : badText}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="font-medium text-muted-foreground">{label}</span>
      <span className={tone}>{unknown ? '—' : ok ? okText : badText}</span>
    </span>
  );
}

function logLevelText(level: 'info'|'warning'|'error'|'success'): string {
  switch (level) {
    case 'success': return 'text-success';
    case 'warning': return 'text-warning';
    case 'error': return 'text-destructive';
    default: return 'text-muted-foreground';
  }
}

function fmtTsISTMs(ts: number | null | undefined): string {
  if (ts == null) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 1, hour12: false });
  } catch { return '—'; }
}

function toMs(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : 0;
}

const eventTone = (event_type?: string, severity?: string) => {
  const t = String(event_type ?? '').toUpperCase();
  if (t === 'RECONNECTED' || t === 'FEED_RESUMED' || t === 'CONNECTED')
    return { text: 'text-success', dot: 'bg-success' };
  if (t === 'RECONNECTING' || t === 'STALE_FEED' || t === 'DEGRADED')
    return { text: 'text-warning', dot: 'bg-warning' };
  if (t === 'DISCONNECTED' || t === 'ERROR' || t === 'FAILED' || severity === 'error')
    return { text: 'text-destructive', dot: 'bg-destructive' };
  return { text: 'text-muted-foreground', dot: 'bg-muted-foreground/50' };
};

/* Durability helpers — read real quantity from the central state store frame. */
function ticksPersisted(state: Record<string, any>): number | null {
  const ticks = state?.metrics?.ticks;
  if (ticks?.persisted != null) return ticks.persisted;
  return state?.websocket?.live?.ticksReceived ?? null;
}
function ticksAttempted(state: Record<string, any>): number | null {
  return state?.metrics?.ticks?.attempted ?? null;
}
function ticksWriteErrors(state: Record<string, any>): number | null {
  return state?.metrics?.ticks?.persistFailures ?? null;
}
function persistRateLabel(state: Record<string, any>): string | undefined {
  const rate = state?.metrics?.ticks?.successRate;
  if (rate == null) return undefined;
  return `${rate.toFixed(1)}% success`;
}
function pipelineRunning(state: Record<string, any>): boolean {
  return Boolean(state?.metrics?.process?.pipelineRunning);
}
function pipelineStartedAt(state: Record<string, any>): string | null {
  return state?.metrics?.process?.startedAt ?? null;
}
function activeTickStocks(state: Record<string, any>): number | null {
  return state?.metrics?.throughput?.activeInstruments ?? null;
}
function bufferLabel(state: Record<string, any>): string {
  const len = state?.metrics?.process?.bufferLength;
  const max = state?.metrics?.process?.bufferMaxSize;
  if (len == null) return '—';
  if (max == null) return String(len);
  return `${fmtNum(len)} / ${fmtNum(max)}`;
}
function broadcastRetentionDays(state: Record<string, any>): number | null {
  return state?.websocket?.live?.market?.retentionDays ?? state?.websocket?.retentionDays ?? null;
}