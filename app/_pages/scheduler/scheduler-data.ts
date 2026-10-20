'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEngineStatus } from '@/lib/engine-realtime';
import {
  getSchedulerHistory, getSchedulerReadiness, getSchedulerStatus, getSchedulerSummary,
} from '@/lib/api';
import { subscribeScheduleEvents, subscribeScheduleState } from '@/lib/schedule-sse';

/**
 * Shared data + formatting layer for the SERVICES → Scheduler pages.
 *
 * The engine snapshot comes from useEngineStatus (WS#2 realtime, one-shot REST
 * fallback). The lifecycle endpoints under /api/scheduler/* return plain dicts
 * (no {ok,data}), so they are fetched single-shot here (never interval-polled).
 * The backend is the only clock — countdowns render backend remaining_seconds.
 */
export const ENGINE = '/api/services/engines/scheduler_engine';

export interface SchedulerData {
  engine: any;
  engineError: string | null;
  source: 'api' | 'realtime' | null;
  connected: boolean;
  status: any | null;
  statusError: string | null;
  readiness: any | null;
  readinessError: string | null;
  summary: any | null;
  summaryError: string | null;
  history: any | null;
  historyError: string | null;
}

export function useSchedulerData(): SchedulerData & { loading: boolean; reload: () => void } {
  const { data: engine, error: engineError, source, connected, refresh } =
    useEngineStatus<any>('scheduler_engine', ENGINE);
  const s = useRaw(() => getSchedulerStatus());
  const r = useRaw(() => getSchedulerReadiness());
  const m = useRaw(() => getSchedulerSummary());
  const h = useRaw(() => getSchedulerHistory(50));

  const reload = useCallback(() => {
    refresh();
    s.refresh();
    r.refresh();
    m.refresh();
    h.refresh();
  }, [refresh, s, r, m, h]);

  const loading = !engine && !engineError;
  return {
    engine, engineError, source, connected,
    status: s.data, statusError: s.error,
    readiness: r.data, readinessError: r.error,
    summary: m.data, summaryError: m.error,
    history: h.data, historyError: h.error,
    loading, reload,
  };
}

// ---------------------------------------------------------------------------
// Live schedule-event stream (SSE) — one shared connection per session.
// ---------------------------------------------------------------------------

/**
 * Consume the shared /api/schedule-events/stream. Pages use `refreshKey` as a
 * dependency to refetch their real data whenever a scheduler event lands
 * (no duplicate polling loops). `connected` drives the LIVE / STALE badge.
 */
export function useScheduleEvents(): {
  connected: boolean;
  refreshKey: number;
  lastMessageAt: number | null;
} {
  const [connected, setConnected] = useState(false);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const offState = subscribeScheduleState((s) => setConnected(s.connected));
    const offFrames = subscribeScheduleEvents(() => {
      setLastMessageAt(Date.now());
      setRefreshKey((k) => k + 1);
    });
    return () => {
      offState();
      offFrames();
    };
  }, []);

  return { connected, refreshKey, lastMessageAt };
}

/** 1s client ticker — drives live countdowns / "ago" labels from backend instants. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface LiveSchedulerFrame {
  raw: Record<string, any>;
  receivedAt: number;
  kind: string;
  label: string;
  detail: string;
}

function describeFrame(frame: Record<string, any>): { kind: string; label: string; detail: string } {
  const type = String(frame?.type ?? frame?.event ?? frame?.kind ?? 'event');
  const job = frame?.job_id ?? frame?.jobId ?? frame?.job ?? '';
  const status = frame?.status ?? frame?.state ?? '';
  const reason = frame?.reason ?? frame?.reason_code ?? frame?.message ?? '';
  const label = [type, job].filter(Boolean).join(' · ') || 'scheduler event';
  const detail = [status, reason].filter(Boolean).join(' · ') || '';
  return { kind: type, label, detail };
}

/**
 * Live scheduler event feed — keeps the last N SSE frames (real backend ticks)
 * so Overview / Lifecycle can show "kaunsa event abhi hua" in realtime.
 * Refetch is still driven by `refreshKey` in the data hooks; this only buffers.
 */
export function useLiveSchedulerEvents(max = 25): {
  connected: boolean;
  refreshKey: number;
  lastMessageAt: number | null;
  events: LiveSchedulerFrame[];
} {
  const [connected, setConnected] = useState(false);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [events, setEvents] = useState<LiveSchedulerFrame[]>([]);

  useEffect(() => {
    const offState = subscribeScheduleState((s) => setConnected(s.connected));
    const offFrames = subscribeScheduleEvents((frame) => {
      const at = Date.now();
      const d = describeFrame(frame ?? {});
      setLastMessageAt(at);
      setRefreshKey((k) => k + 1);
      setEvents((prev) => [{ raw: frame ?? {}, receivedAt: at, ...d }, ...prev].slice(0, max));
    });
    return () => {
      offState();
      offFrames();
    };
  }, [max]);

  return { connected, refreshKey, lastMessageAt, events };
}

// ---------------------------------------------------------------------------
// Scheduler event timeline — one canonical order for Overview + Lifecycle.
// Every row resolves from REAL backend payloads only (never fabricated):
//   scheduled time <- status.todaySchedule / summary.day_schedule / phases
//   actual outcome <- history/summary executions matched on job_id
// ---------------------------------------------------------------------------

export interface SchedulerTimelineEvent {
  key: string;
  label: string;
  hint: string;
  jobIds: string[];
  scheduledAt: string | null;
  run: any | null;
  actualAt: string | null;
  displayStatus: string;
  tone: 'done' | 'active' | 'upcoming' | 'failed' | 'missed' | 'idle';
}

export const SCHEDULER_EVENT_ORDER: { key: string; label: string; hint: string; jobIds: string[] }[] = [
  { key: 'login', label: 'Login', hint: 'Broker session login', jobIds: ['login'] },
  { key: 'ws_connect', label: 'WS Connect', hint: 'WebSocket feed connect', jobIds: ['ws_start'] },
  { key: 'tick_collection', label: 'Tick Collection', hint: 'Tick capture start', jobIds: ['tick_collection'] },
  { key: 'pre_market', label: 'Pre-market', hint: 'Phase window', jobIds: [] },
  { key: 'limit_order', label: 'Limit-order window', hint: 'Phase window', jobIds: [] },
  { key: 'equilibrium', label: 'Equilibrium', hint: 'Phase window', jobIds: [] },
  { key: 'buffer', label: 'Buffer', hint: 'Phase window', jobIds: [] },
  { key: 'live_feed', label: 'Live feed', hint: 'Phase window', jobIds: ['market_watch_start'] },
  { key: 'square_off', label: 'Square-off', hint: 'Auto square-off trigger', jobIds: ['square_off'] },
  { key: 'feed_stop', label: 'Feed stop', hint: 'Broker feed stop', jobIds: ['feed_stop'] },
  { key: 'ws_disconnect', label: 'WS Disconnect', hint: 'WebSocket stop', jobIds: ['ws_stop'] },
  { key: 'logout', label: 'Logout', hint: 'Broker session logout', jobIds: ['logout'] },
];

function pickScheduled(
  key: string,
  daySchedule: Record<string, any>,
  statusSchedule: Record<string, any>,
  phases: Record<string, any>,
  summary: any,
): string | null {
  const norm = (v: any): string | null => {
    if (v == null || v === '') return null;
    if (typeof v === 'string') return v;
    return String(v);
  };
  switch (key) {
    case 'login': return norm(daySchedule?.login ?? statusSchedule?.login ?? summary?.login);
    case 'ws_connect': return norm(daySchedule?.ws_connect ?? statusSchedule?.wsConnect ?? summary?.websocket_connect);
    case 'tick_collection': return norm(daySchedule?.tick_collection ?? statusSchedule?.tickCollection ?? summary?.tick_collection);
    case 'ws_disconnect': return norm(daySchedule?.ws_disconnect ?? statusSchedule?.wsDisconnect ?? summary?.websocket_disconnect);
    case 'logout': return norm(daySchedule?.logout ?? statusSchedule?.logout ?? summary?.logout);
    case 'pre_market': return norm(phases?.pre_market);
    case 'limit_order': return norm(phases?.limit_order);
    case 'equilibrium': return norm(phases?.equilibrium);
    case 'buffer': return norm(phases?.buffer);
    case 'live_feed': return norm(phases?.live_feed);
    case 'square_off': return norm(phases?.square_off);
    case 'feed_stop': return norm(phases?.feed_stop);
    default: return null;
  }
}

function toneForRun(status?: string | null): SchedulerTimelineEvent['tone'] {
  const s = String(status ?? '').toUpperCase();
  if (!s || s === '—') return 'idle';
  if (['COMPLETED', 'ALREADY_SATISFIED', 'SUCCESS'].includes(s)) return 'done';
  if (['RUNNING', 'CATCHING_UP', 'CATCH_UP', 'DUE', 'PENDING'].includes(s)) return 'active';
  if (['FAILED', 'ERROR'].includes(s)) return 'failed';
  if (['MISSED', 'MISSED_EXPIRED', 'SKIPPED', 'CANCELLED'].includes(s)) return 'missed';
  if (s.startsWith('WAITING')) return 'upcoming';
  return 'idle';
}

export function buildSchedulerTimeline(args: {
  status?: any | null;
  summary?: any | null;
  history?: any | null;
  now?: number;
}): SchedulerTimelineEvent[] {
  const { status, summary, history, now } = args;
  const daySchedule = (summary?.day_schedule ?? {}) as Record<string, any>;
  const statusSchedule = (status?.todaySchedule ?? {}) as Record<string, any>;
  const phases = (status?.todayPhases ?? summary?.phases ?? {}) as Record<string, any>;
  const executions: any[] = (history?.runs as any[]) || (summary?.executions as any[]) || [];
  const byJob = new Map<string, any>();
  for (const r of executions) {
    const jid = String(r?.job_id ?? r?.jobId ?? '').toLowerCase();
    if (jid && !byJob.has(jid)) byJob.set(jid, r);
  }
  const nowMs = now ?? Date.now();

  return SCHEDULER_EVENT_ORDER.map((def) => {
    const scheduledAt = pickScheduled(def.key, daySchedule, statusSchedule, phases, summary);
    const run = def.jobIds.map((j) => byJob.get(j.toLowerCase())).find(Boolean) ?? null;
    const runStatus = run?.status ?? null;
    const actualAt = run?.actual_at ?? run?.completed_at ?? run?.started_at ?? run?.actual_start ?? run?.actual_completion ?? null;
    let tone = run ? toneForRun(runStatus) : 'idle';
    if (!run && scheduledAt) {
      const t = new Date(scheduledAt).getTime();
      if (!Number.isNaN(t)) tone = t <= nowMs ? 'missed' : 'upcoming';
      else tone = 'upcoming';
    }
    if (!run && !scheduledAt) tone = 'idle';
    return {
      key: def.key,
      label: def.label,
      hint: def.hint,
      jobIds: def.jobIds,
      scheduledAt,
      run,
      actualAt,
      displayStatus: runStatus ?? (scheduledAt ? (tone === 'upcoming' ? 'SCHEDULED' : 'PENDING') : '—'),
      tone: tone as SchedulerTimelineEvent['tone'],
    };
  });
}

/** Live countdown text from a backend instant (ticks every render via useNow). */
export function liveCountdown(nextAtIso?: string | null, fallbackSec?: number | null, nowMs?: number): string {
  if (nextAtIso) {
    const t = new Date(nextAtIso).getTime();
    const n = nowMs ?? Date.now();
    if (!Number.isNaN(t)) {
      const diff = Math.max(0, Math.floor((t - n) / 1000));
      return fmtRemaining(diff);
    }
  }
  if (fallbackSec != null) return fmtRemaining(Number(fallbackSec));
  return '—';
}

// ---------------------------------------------------------------------------
// Raw single-shot fetch (scheduler endpoints return plain dicts, not {ok,data})
// ---------------------------------------------------------------------------

function useRaw<T = any>(loader: () => Promise<T> | null): {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);

  const refresh = useCallback(() => {
    const req = ++reqRef.current;
    setLoading(true);
    Promise.resolve(loader())
      .then((d) => {
        if (req !== reqRef.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: any) => {
        if (req !== reqRef.current) return;
        setError(e?.message ?? 'fetch failed');
      })
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
  }, [loader]);

  useEffect(() => {
    const req = ++reqRef.current;
    setLoading(true);
    Promise.resolve(loader())
      .then((d) => {
        if (req !== reqRef.current) return;
        setData(d);
      })
      .catch((e: any) => {
        if (req !== reqRef.current) return;
        setError(e?.message ?? 'fetch failed');
      })
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
    return () => { reqRef.current += 1; };
  }, [loader]);

  return { data, error, loading, refresh };
}

// ---------------------------------------------------------------------------
// Formatting helpers (all render '—' for missing / not-applicable values)
// ---------------------------------------------------------------------------

export function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '\u2014';
  return Number(n).toLocaleString('en-IN');
}

export function fmtTs(iso?: string | number | null): string {
  if (iso == null) return '\u2014';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '\u2014' : d.toLocaleString();
}

/** Render an IST HH:MM from a backend ISO timestamp (or a plain HH:MM). */
export function fmtHHMM(iso?: string | null): string {
  if (iso == null || iso === '') return '\u2014';
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return typeof iso === 'string' ? iso.slice(0, 5) : '\u2014';
}

/** Human-readable countdown from backend-provided remaining seconds. */
export function fmtRemaining(seconds?: number | null): string {
  const s = Number(seconds);
  if (seconds == null || Number.isNaN(s) || s < 0) return '\u2014';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const parts = h > 0 ? [`${h}h`] : [];
  parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Tones / badges for real values
// ---------------------------------------------------------------------------

export const STATE_TONE: Record<string, string> = {
  RUNNING: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  HEALTHY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  DEGRADED: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  STALE: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  STOPPED: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  REGISTERED: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  ERROR: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  LOGIN_FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  WS_FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  MARKET_CLOSED: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

export const READY_TONE: Record<string, string> = {
  READY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  NOT_READY: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

export const STATUS_BADGE: Record<string, string> = {
  COMPLETED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  ALREADY_SATISFIED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  RUNNING: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  CATCHING_UP: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  MISSED: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  MISSED_EXPIRED: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SKIPPED: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  PENDING: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
};

/** Canonical phase order shared by the timeline pages. */
export const PHASE_ORDER: { key: string; label: string }[] = [
  { key: 'readiness', label: 'Readiness' },
  { key: 'pre_market', label: 'Pre-market' },
  { key: 'limit_order', label: 'Limit-order window' },
  { key: 'equilibrium', label: 'Equilibrium' },
  { key: 'buffer', label: 'Buffer' },
  { key: 'live_feed', label: 'Live feed' },
  { key: 'square_off', label: 'Square-off' },
  { key: 'feed_stop', label: 'Feed stop' },
  { key: 'websocket_close', label: 'WebSocket close' },
  { key: 'logout', label: 'Logout' },
];

// ---------------------------------------------------------------------------
// Runs page — canonical run statuses -> UI vocabulary + tones (real data only)
// ---------------------------------------------------------------------------

/** UI status filter options (spec vocabulary) sent to /api/scheduler/runs. */
export const RUN_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'PENDING', label: 'PENDING' },
  { value: 'DUE', label: 'DUE' },
  { value: 'RUNNING', label: 'RUNNING' },
  { value: 'COMPLETED', label: 'COMPLETED' },
  { value: 'FAILED', label: 'FAILED' },
  { value: 'RETRYING', label: 'RETRYING' },
  { value: 'WAITING', label: 'WAITING' },
  { value: 'ALREADY_SATISFIED', label: 'ALREADY_SATISFIED' },
  { value: 'MISSED_SCHEDULE_CATCHUP', label: 'MISSED_SCHEDULE_CATCHUP' },
  { value: 'SKIPPED', label: 'SKIPPED' },
];

// ---------------------------------------------------------------------------
// Overview / Lifecycle — canonical scheduler runtime states (backend-owned).
// ---------------------------------------------------------------------------

export const LIFECYCLE_STAGES: { key: string; label: string }[] = [
  { key: 'login', label: 'Login' },
  { key: 'session', label: 'Session' },
  { key: 'feed', label: 'WebSocket feed' },
  { key: 'collection', label: 'Tick collection' },
  { key: 'logout', label: 'Logout' },
];

/** Backend runtime state -> which lifecycle stage it belongs to. */
export const STATE_STAGE: Record<string, number> = {
  STARTING: 0,
  WAITING_FOR_LOGIN: 0,
  LOGGING_IN: 0,
  LOGIN_FAILED: 0,
  SESSION_ACTIVE: 1,
  SESSION_EXPIRED: 1,
  WAITING_FOR_WS: 2,
  WS_CONNECTING: 2,
  WS_ACTIVE: 2,
  WS_RECONNECTING: 2,
  WS_DISCONNECTING: 2,
  TICK_COLLECTION: 3,
  TICK_COLLECTION_RUNNING: 3,
  LOGGING_OUT: 4,
  LOGGED_OUT: 4,
};

/** Operational posture for the overview banner (derived from real state). */
export const STATE_OP: Record<string, 'running' | 'degraded' | 'stopped'> = {
  STARTING: 'degraded',
  WAITING_FOR_LOGIN: 'degraded',
  LOGGING_IN: 'degraded',
  LOGIN_FAILED: 'stopped',
  SESSION_ACTIVE: 'running',
  SESSION_EXPIRED: 'stopped',
  WAITING_FOR_WS: 'degraded',
  WS_CONNECTING: 'degraded',
  WS_ACTIVE: 'running',
  WS_RECONNECTING: 'degraded',
  WS_DISCONNECTING: 'degraded',
  TICK_COLLECTION: 'running',
  TICK_COLLECTION_RUNNING: 'running',
  LOGGING_OUT: 'degraded',
  LOGGED_OUT: 'stopped',
  MARKET_CLOSED: 'stopped',
  WAITING_FOR_NEXT_TRADING_DAY: 'stopped',
  ERROR: 'stopped',
};

/** Lifecycle-state badge tones (extends STATE_TONE with every canonical state). */
export const LIFECYCLE_TONE: Record<string, string> = {
  STARTING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  WAITING_FOR_LOGIN: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  LOGGING_IN: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  LOGIN_FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  SESSION_ACTIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  SESSION_EXPIRED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  WAITING_FOR_WS: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  WS_CONNECTING: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  WS_ACTIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  WS_RECONNECTING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  WS_DISCONNECTING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  TICK_COLLECTION: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  TICK_COLLECTION_RUNNING: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  LOGGING_OUT: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  LOGGED_OUT: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  MARKET_CLOSED: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  WAITING_FOR_NEXT_TRADING_DAY: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  ERROR: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

/** Sort keys the backend whitelists for /api/scheduler/runs. */
export const RUN_SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'scheduled_at', label: 'Scheduled' },
  { value: 'updated_at', label: 'Updated' },
  { value: 'started_at', label: 'Actual start' },
  { value: 'completed_at', label: 'Actual completion' },
  { value: 'job_id', label: 'Job' },
  { value: 'status', label: 'Status' },
];

/**
 * Display mapping: canonical backend run status -> {label, tone} render.
 * A caught-up / catching-up run renders RUNNING with the backend `catch_up`
 * flag + trigger (MISSED_SCHEDULE_CATCHUP) surfaced beside the badge.
 */
export const RUN_VIEW: Record<string, { label: string; tone: string }> = {
  SCHEDULED: { label: 'PENDING', tone: 'bg-slate-500/10 text-slate-300 border-slate-500/25' },
  PENDING: { label: 'PENDING', tone: 'bg-slate-500/10 text-slate-300 border-slate-500/25' },
  DUE: { label: 'DUE', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  RUNNING: { label: 'RUNNING', tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  CATCH_UP: { label: 'RUNNING', tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  CATCHING_UP: { label: 'RUNNING', tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  COMPLETED: { label: 'COMPLETED', tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  FAILED: { label: 'FAILED', tone: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  ALREADY_SATISFIED: { label: 'ALREADY_SATISFIED', tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  WAITING_NETWORK: { label: 'WAITING', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  WAITING_BACKEND: { label: 'WAITING', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  WAITING_DEPENDENCY: { label: 'WAITING', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  MISSED: { label: 'MISSED', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  MISSED_EXPIRED: { label: 'SKIPPED', tone: 'bg-slate-500/10 text-slate-300 border-slate-500/25' },
  SKIPPED: { label: 'SKIPPED', tone: 'bg-slate-500/10 text-slate-300 border-slate-500/25' },
  CANCELLED: { label: 'CANCELLED', tone: 'bg-slate-500/10 text-slate-300 border-slate-500/25' },
};

/** How long since an update (drives the STALE DATA / last-updated line). */
export function fmtDuration(ms?: number | null): string {
  const n = Number(ms);
  if (ms == null || Number.isNaN(n) || n < 0) return '\u2014';
  const total = Math.round(n / 1000);
  const s = total % 60;
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** IST HH:MM:SS display (the project clock). Plain HH:MM falls back verbatim. */
export function fmtClockIST(iso?: string | null): string {
  if (iso == null || iso === '') return '\u2014';
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  return typeof iso === 'string' ? iso.slice(0, 5) : '\u2014';
}

/** Full IST date+time with seconds for run detail. */
export function fmtDateTimeIST(iso?: string | null): string {
  if (iso == null || iso === '') return '\u2014';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '\u2014';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}