'use client';

// Data Saver — Schedules (unified events; rebuilt glass-free).
//
// ONE scheduler page where the user can set ANY event the backend owns —
// from a data download to a quality scan, a pipeline flush, broker login/
// logout, square-off, a full market scan — down to a SERVICE SHUTDOWN —
// plus pure on-device reminders. Download events keep their dedicated rich
// engine (scheduled-downloads; create/edit deep-links there); everything
// else rides the new unified event scheduler:
//   · REST   /api/phase2/sched-events (CRUD + run/toggle/rearm)
//   · WS     `sched_events` channel — pushes the events doc the moment a
//            signature changes (10s re-eval, 20s fresh re-push)
//   · SSE    the SAME schedule-events bus downloads use (DUE/RUNNING/
//            COMPLETED/FAILED/SKIPPED/MISSED frames for both lanes)
//   · Notify on-device notifications with a real lead countdown:
//            browser warnings before nextRun + run outcomes (only for
//            events whose notify policy asks for them).
//
// HONESTY: a value the backend never produced renders — (never a fake 0);
// countdowns are anchored to the server clock (useServerNow), a missed
// one-shot is shown MISSED, and "Shutdown/square-off" actions demand an
// explicit Confirm before the backend will execute them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, BellOff, CalendarClock, CheckCircle2, ChevronDown, Clock, Download,
  FileArchive, Gauge, Globe, Pause, Play, Plus, Radio,
  RefreshCw, Trash2, Pencil, Loader2, Gavel, Smartphone, Wifi, WifiOff, X,
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  EmptyState, LoadingState, fmtCompact, StatusBadge,
} from '@/components/design-system';
import { cn } from '@/lib/utils';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { useScheduleEvents, type ScheduleEvent } from '@/hooks/use-schedule-events';
import { useSettingValue } from '@/lib/settings/store';
import { useServerNow } from '@/lib/time-engine';
import {
  deliverDesktopNotification, claimTag, desktopPermission, requestDesktopPermission,
} from '@/lib/desktop-notifications';

const DASH = '—';
const EV_URL = '/api/phase2/sched-events';
const DL_URL = '/api/phase2/schedules';
const WS_FRESH_MS = 35_000;

/* ========================================================================== */
/* Unified event types (api/sched_events.py + services/event_scheduler.py)     */
/* ========================================================================== */

type Schedule = {
  type: 'once' | 'daily' | 'weekdays' | 'weekly';
  time?: string;
  days?: number[] | null;
  date?: string | null;
  timezone?: string;
};

type NotifyPolicy = {
  onDevice?: boolean;
  leadMinutes?: number;
  onCompletion?: boolean;
};

type UnifiedEvent = {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  schedule: Schedule;
  params?: Record<string, unknown>;
  notify?: NotifyPolicy;
  nextRun?: string | null;
  lastRun?: string | null;
  lastStatus?: string;
  lastError?: string | null;
  runCount?: number;
  failCount?: number;
  completedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type UnifiedDoc = { serverNow?: string; count?: number; events: UnifiedEvent[] };

const KIND_META: Record<string, { label: string; hint: string; chip: string; rail: string; soft: string }> = {
  notify: {
    label: 'Reminder', hint: 'On-device notification at the set time (this browser).',
    chip: 'bg-sky-600 text-white dark:bg-sky-500 dark:text-sky-950',
    rail: 'before:bg-sky-500',
    soft: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-1 ring-sky-500/25',
  },
  quality_scan: {
    label: 'Quality scan', hint: 'Runs the real data-quality scan: metrics, issues, notifications.',
    chip: 'bg-violet-600 text-white dark:bg-violet-500 dark:text-violet-950',
    rail: 'before:bg-violet-500',
    soft: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-1 ring-violet-500/25',
  },
  atlas_cleanup: {
    label: 'Atlas cleanup', hint: 'Safe cleanup of temporary market data + telemetry (audit-logged).',
    chip: 'bg-teal-600 text-white dark:bg-teal-500 dark:text-teal-950',
    rail: 'before:bg-teal-500',
    soft: 'bg-teal-500/10 text-teal-700 dark:text-teal-300 ring-1 ring-teal-500/25',
  },
  flush_pipeline: {
    label: 'Flush pipeline', hint: 'Flushes the in-memory tick buffer to MongoDB immediately.',
    chip: 'bg-cyan-700 text-white dark:bg-cyan-600 dark:text-cyan-950',
    rail: 'before:bg-cyan-600',
    soft: 'bg-cyan-600/10 text-cyan-700 dark:text-cyan-300 ring-1 ring-cyan-600/25',
  },
  session_login: {
    label: 'Session login', hint: 'Logs the broker session in (skipped when one is already live).',
    chip: 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950',
    rail: 'before:bg-emerald-500',
    soft: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/25',
  },
  session_logout: {
    label: 'Session logout', hint: 'Cleanly logs the broker session out.',
    chip: 'bg-amber-600 text-white dark:bg-amber-500 dark:text-amber-950',
    rail: 'before:bg-amber-500',
    soft: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-1 ring-amber-500/25',
  },
  square_off: {
    label: 'Square off', hint: 'Hands close-all to the Square-Off Engine — REAL orders. Confirm required.',
    chip: 'bg-rose-600 text-white dark:bg-rose-500 dark:text-rose-950',
    rail: 'before:bg-rose-500',
    soft: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/25',
  },
  market_scan: {
    label: 'Market scan', hint: 'Recomputes the full NSE scan document immediately.',
    chip: 'bg-purple-700 text-white dark:bg-purple-600 dark:text-purple-950',
    rail: 'before:bg-purple-500',
    soft: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 ring-1 ring-purple-500/25',
  },
  shutdown: {
    label: 'Shutdown', hint: 'Flushes the pipeline, logs the broker out, then EXITS the backend. Confirm required.',
    chip: 'bg-red-700 text-white dark:bg-red-600 dark:text-red-950',
    rail: 'before:bg-red-600',
    soft: 'bg-red-600/10 text-red-700 dark:text-red-300 ring-1 ring-red-600/25',
  },
  download: {
    label: 'Download', hint: 'Scheduled tick/ZIP export job — the dedicated rich form.',
    chip: 'bg-indigo-600 text-white dark:bg-indigo-500 dark:text-indigo-950',
    rail: 'before:bg-indigo-500',
    soft: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-500/25',
  },
};

const DANGER_KINDS = new Set(['square_off', 'shutdown']);
const kindMeta = (k: string) => KIND_META[k] ?? {
  label: k, hint: '', chip: 'bg-slate-600 text-white', rail: 'before:bg-slate-400',
  soft: 'bg-muted text-muted-foreground ring-1 ring-border',
};

type RailKey = 'emerald' | 'rose' | 'amber' | 'sky' | 'violet' | 'teal' | 'cyan' | 'purple' | 'red' | 'indigo' | 'none';

const kindRail = (k: string): RailKey => {
  switch (k) {
    case 'notify': return 'sky';
    case 'quality_scan': return 'violet';
    case 'atlas_cleanup': return 'teal';
    case 'flush_pipeline': return 'cyan';
    case 'session_login': return 'emerald';
    case 'session_logout': return 'amber';
    case 'square_off': return 'rose';
    case 'market_scan': return 'purple';
    case 'shutdown': return 'red';
    case 'download': return 'indigo';
    default: return 'none';
  }
};

/* ========================================================================== */
/* Download-lane types (unchanged engine)                                      */
/* ========================================================================== */

interface ScheduleJob {
  _id: string;
  name: string;
  enabled: boolean;
  symbols?: string[];
  symbolMode?: string;
  fields?: string[];
  formats?: string[];
  schedule?: { type?: string; time?: string; days?: number[]; timezone?: string };
  dateRange?: { type?: string; days?: number; startDate?: string; endDate?: string };
  destination?: string;
  nextRun?: string | null;
  lastRun?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  failCount?: number;
  runCount?: number;
  retry_count?: number;
  nextRetryAt?: string | null;
  failure_reason?: string | null;
  lastFile?: string | null;
  lastFileSize?: number | null;
  historyId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  timezone?: string;
}

interface ScheduleRun {
  _id: string;
  scheduleId: string;
  scheduleName?: string;
  trigger?: string;
  runAt?: string;
  status?: string;
  error?: string;
  stocks?: string[];
  symbolCount?: number;
  historyId?: string;
  fileId?: string;
  fileName?: string;
  fileSizeBytes?: number;
  recordCount?: number;
  durationMs?: number;
  deliveredTo?: string;
}

/* ========================================================================== */
/* Shared helpers                                                              */
/* ========================================================================== */

const fmtBytes = (b: number | null | undefined): string => {
  if (b == null || !Number.isFinite(b) || b <= 0) return DASH;
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
};

const ist = (v?: string | null): string => {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, day: '2-digit', month: '2-digit', year: 'numeric' });
};

const isTodayIst = (v?: string | null): boolean => {
  if (!v) return false;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' })
    === now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
};

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function scheduleText(s?: Schedule): string {
  if (!s) return 'Every day';
  const tz = s.timezone || 'Asia/Kolkata';
  const tzShort = tz.includes('Kolkata') ? 'IST' : tz;
  const rule = s.type === 'weekly' && s.days?.length
    ? `Weekly · ${s.days.map((d) => DAYS[d] ?? '').filter(Boolean).join(', ')}`
    : s.type === 'weekdays' ? 'Weekdays (Mon–Fri)'
    : s.type === 'once' ? `Once · ${s.date ?? DASH}`
    : 'Every day';
  return `${rule} · ${s.time ?? '00:00'} ${tzShort}`;
}

/** Server-anchored countdown — honest dash when there is no target. */
function useCountdownText(target?: string | null): string | null {
  const now = useServerNow();
  return useMemo(() => {
    if (!target) return null;
    const t = Date.parse(target);
    if (!Number.isFinite(t)) return null;
    const diff = t - now;
    if (diff <= 0) return null; // "due" state is shown by status, not a negative timer
    const s = Math.floor(diff / 1000);
    const dd = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return dd > 0 ? `${dd}d ${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }, [target, now]);
}

function statusMeta(status?: string | null, enabled = true): { tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; label: string } {
  const s = (status || '').toLowerCase();
  if (!enabled) return { tone: 'neutral', label: 'Paused' };
  if (s === 'running') return { tone: 'info', label: 'Running…' };
  if (s === 'due') return { tone: 'warning', label: 'Due' };
  if (['success', 'completed', 'ok'].includes(s)) return { tone: 'success', label: 'Completed' };
  if (['failed', 'error'].includes(s)) return { tone: 'danger', label: 'Failed' };
  if (s === 'missed') return { tone: 'danger', label: 'Missed' };
  if (['waiting', 'retrying', 'skipped', 'pending_retry', 'waiting_for_dependency'].includes(s)) return { tone: 'warning', label: s === 'skipped' ? 'Skipped' : s === 'retrying' ? 'Retrying' : 'Waiting' };
  return { tone: 'neutral', label: 'Active' };
}

/* ========================================================================== */
/* Punchy primitives (solid — zero blur, as per the Live Watch family)         */
/* ========================================================================== */

function TransportPill({ transport }: { transport: 'live' | 'poll' | 'none' }) {
  const map = {
    live: { label: 'LIVE · WS push', cls: 'bg-emerald-600 text-white shadow-emerald-600/30 dark:bg-emerald-500' },
    poll: { label: 'REST poll', cls: 'bg-amber-500 text-white shadow-amber-500/30' },
    none: { label: 'offline', cls: 'bg-muted text-muted-foreground' },
  } as const;
  const s = map[transport];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-extrabold tracking-wide shadow-md', s.cls)}>
      <span className={cn('h-1.5 w-1.5 rounded-full bg-white/90', transport === 'live' && 'ds-breathe')} />
      {s.label}
      {transport === 'poll' && <Wifi className="h-3 w-3" />}
      {transport === 'none' && <WifiOff className="h-3 w-3" />}
    </span>
  );
}

/** Solid punchy card with a kind-tinted rail, rise + hover lift. Zero blur. */
function PunchCard({ rail, index, children, className, id }: {
  rail?: 'emerald' | 'rose' | 'amber' | 'sky' | 'violet' | 'teal' | 'cyan' | 'purple' | 'red' | 'indigo' | 'none';
  index?: number; children: React.ReactNode; className?: string; id?: string;
}) {
  const cls: Record<string, string> = {
    emerald: 'before:bg-emerald-500', rose: 'before:bg-rose-500', amber: 'before:bg-amber-500',
    sky: 'before:bg-sky-500', violet: 'before:bg-violet-500', teal: 'before:bg-teal-500',
    cyan: 'before:bg-cyan-500', purple: 'before:bg-purple-500', red: 'before:bg-red-600',
    indigo: 'before:bg-indigo-500', none: 'before:bg-transparent',
  };
  return (
    <div
      id={id}
      style={index != null ? ({ '--ds-i': index % 12 } as React.CSSProperties) : undefined}
      className={cn(
        'ds-card ds-lift group relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_2px_6px_hsl(var(--foreground)/0.05),0_16px_40px_-24px_hsl(var(--foreground)/0.22)]',
        index != null && 'ds-rise',
        'before:absolute before:inset-y-1.5 before:left-0 before:w-[5px] before:rounded-full before:content-[""]',
        cls[rail ?? 'none'],
        className,
      )}
    >
      {children}
    </div>
  );
}

function KindChip({ kind, className }: { kind: string; className?: string }) {
  const m = kindMeta(kind);
  return <span className={cn('inline-flex shrink-0 items-center rounded-lg px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide shadow-sm', m.chip, className)}>{m.label}</span>;
}

function InstallAppButton() {
  const [event, setEvent] = useState<any>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(display-mode: standalone)').matches) setDone(true);
    const onPrompt = (e: Event) => { e.preventDefault(); setEvent(e); };
    const onInstalled = () => { setDone(true); setEvent(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (done || !event) return null;
  return (
    <Button size="sm" variant="ghost"
      onClick={() => { void event.prompt().finally(() => setEvent(null)); }}
      className="rounded-full border border-violet-400/30 bg-violet-500/10 text-[11px] font-semibold text-violet-600 transition hover:bg-violet-500/20 dark:text-violet-400"
      aria-label="Install the Data Saver app"
    >
      <Smartphone className="h-3.5 w-3.5" /> Install app
    </Button>
  );
}

/* ========================================================================== */
/* Data lanes                                                                  */
/* ========================================================================== */

function useUnifiedEvents(paused: boolean) {
  const { subscribe, onFrame, connected } = useFrontendRealtime();
  const [rest, setRest] = useState<UnifiedDoc | null>(null);
  const [wsDoc, setWsDoc] = useState<UnifiedDoc | null>(null);
  const [wsAt, setWsAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pull = useCallback(async () => {
    try {
      const res = await fetch(`${EV_URL}?t=${Date.now()}`, { cache: 'no-store' });
      const body = await res.json();
      if (res.ok && body?.ok !== false && Array.isArray(body?.events)) {
        setRest(body as UnifiedDoc);
        setError(null);
      } else {
        setError(body?.detail || body?.error || `Request failed (${res.status})`);
      }
    } catch {
      setError('events request failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    void pull();
    const id = setInterval(() => { if (alive && document.visibilityState !== 'hidden') void pull(); }, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [pull, paused]);

  useEffect(() => {
    if (paused) return;
    void subscribe([{ channel: 'sched_events' }]).catch(() => {});
  }, [subscribe, paused]);

  useEffect(() => onFrame((frame) => {
    const payload = (frame?.data?.payload ?? frame?.data) as UnifiedDoc | undefined;
    if (frame?.type === 'sched_events.snapshot' && Array.isArray(payload?.events)) {
      setWsDoc(payload);
      setWsAt(Date.now());
    }
  }), [onFrame]);

  const events = useMemo<UnifiedEvent[]>(() => {
    const wsFresh = wsDoc && Date.now() - wsAt < WS_FRESH_MS ? wsDoc : null;
    const src = wsFresh ?? rest;
    if (!src) return [];
    // REST stores ids as `_id`, the WS builder ships `id` — normalise both.
    return (src.events ?? []).map((e: any) => ({ ...e, id: String(e.id ?? e._id ?? '') }));
  }, [rest, wsDoc, wsAt]);

  const serverNow: string | undefined = useMemo(() => {
    const wsFresh = wsDoc && Date.now() - wsAt < WS_FRESH_MS ? wsDoc : null;
    return (wsFresh ?? rest)?.serverNow;
  }, [rest, wsDoc, wsAt]);

  const transport: 'live' | 'poll' | 'none' =
    connected && wsDoc && Date.now() - wsAt < WS_FRESH_MS ? 'live' : (rest ? 'poll' : 'none');

  return { events, serverNow, loading, error, transport, refresh: pull };
}

/* ========================================================================== */
/* On-device notifications — lead countdown + live outcomes                     */
/* ========================================================================== */

type NotifyOut = (p: { tag: string; title: string; body: string; require?: boolean }) => void;

function useScheduleNotifier(
  events: UnifiedEvent[],
  scheduleStates: Map<string, { status: string }>,
  recentEvents: ScheduleEvent[],
  permission: string,
  connected: boolean,
): void {
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const handledLive = useRef<Set<string>>(new Set());

  const notify: NotifyOut = useCallback(async ({ tag, title, body, require }) => {
    if (permission !== 'granted') return;
    if (!claimTag(tag)) return;
    await deliverDesktopNotification({
      title, body, tag,
      url: '/data-saver/schedules',
      severity: require ? 'critical' : 'warning',
      category: 'SCHEDULE',
      requireInteraction: !!require,
    });
  }, [permission]);

  // (1) Pre-run lead reminders from the server-anchored clock. The page
  // re-renders every second via the hero countdown's useServerNow; each
  // second we check whether any notify-policy event entered its lead
  // window. Every reminder is deduped per (event, slot, phase) by tag.
  const serverNow = useServerNow();
  useEffect(() => {
    if (permission !== 'granted') return;
    for (const ev of events) {
      if (!ev.enabled) continue;
      const pol = ev.notify ?? {};
      if (!pol.onDevice) continue;
      const next = ev.nextRun;
      if (!next) continue;
      const target = Date.parse(next);
      if (!Number.isFinite(target)) continue;
      const leadSec = Math.max(0, Number(pol.leadMinutes ?? 0)) * 60;
      const nowSec = Math.floor(serverNow / 1000);
      const targetSec = Math.floor(target / 1000);
      const diffSec = targetSec - nowSec;
      const phases: Array<'lead' | 'time'> = [];
      if (leadSec > 0 && diffSec < leadSec && diffSec > 0) phases.push('lead');
      if (diffSec <= 0 && diffSec > -6) phases.push('time');
      const mins = Math.max(0, Math.round(Math.abs(Math.min(diffSec, 0) || diffSec) / 60));
      for (const phase of phases) {
        const tag = `sched:${ev.id}:${targetSec}:${phase}`;
        void notify({
          tag,
          title: phase === 'lead'
            ? `${diffSec < 60 ? 'Starting now' : `Starting in ~${mins}m`} — ${ev.name}`
            : `Scheduled time — ${ev.name}`,
          body: ev.kind === 'notify'
            ? 'Your reminder (set on the Schedules page).'
            : `${kindMeta(ev.kind).label} · ${scheduleText(ev.schedule)} · time left ${diffSec < 60 ? 'now' : `${mins}m`}`,
          require: DANGER_KINDS.has(ev.kind),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(serverNow / 1000), permission, events, notify]);

  // (2) Live outcome notifications from the SAME SSE stream downloads use.
  useEffect(() => {
    if (!connected || permission !== 'granted') return;
    for (const frame of recentEvents) {
      const phase = ({ SCHEDULE_RUNNING: 'run', SCHEDULE_COMPLETED: 'done', SCHEDULE_FAILED: 'fail', SCHEDULE_SKIPPED: 'skip', SCHEDULE_MISSED: 'missed' } as Record<string, string>)[frame.event];
      if (!phase) continue;
      const id = String(frame.scheduleId ?? '');
      const ev = byId.get(id);
      if (!ev) continue; // download-lane frames keep their existing behaviour
      const pol = ev.notify ?? {};
      if (!pol.onDevice) continue;
      if (phase === 'done' && pol.onCompletion === false) continue;
      const key = `${id}:${frame.eventId ?? frame.ts}:${phase}`;
      if (handledLive.current.has(key)) continue;
      handledLive.current.add(key);
      if (handledLive.current.size > 400) {
        handledLive.current = new Set([...handledLive.current].slice(-200));
      }
      const status = scheduleStates.get(id)?.status;
      const require = ev.kind === 'shutdown' && phase === 'done';
      if (phase === 'run') {
        void notify({
          tag: `sched:${id}:${phase}`,
          title: `Running now — ${ev.name}`,
          body: `${kindMeta(ev.kind).label} execution started on the backend.`,
          require,
        });
      } else if (frame.event === 'SCHEDULE_FAILED') {
        void notify({
          tag: `sched:${id}:${phase}`,
          title: `Failed — ${ev.name}`,
          body: String(frame.error ?? 'Execution failed — open Schedules for the run record.'),
          require: true,
        });
      } else if (phase === 'done') {
        void notify({
          tag: `sched:${id}:${phase}`,
          title: `Completed — ${ev.name}`,
          body: `${kindMeta(ev.kind).label} finished${status ? ` (${status})` : ''}.`,
        });
      } else {
        void notify({
          tag: `sched:${id}:${phase}`,
          title: `${frame.event.replace('SCHEDULE_', '').replace('_', ' ').toLowerCase()} — ${ev.name}`,
          body: String(frame.reason ?? frame.error ?? 'Run skipped by the backend (recorded honestly).'),
        });
      }
    }
  }, [recentEvents, connected, permission, byId, scheduleStates, notify]);
}

/* ========================================================================== */
/* SSE summary helpers for the activity feed                                   */
/* ========================================================================== */

const EVENT_LABELS: Record<string, string> = {
  SCHEDULE_DUE: 'Became due',
  SCHEDULE_RUNNING: 'Started',
  SCHEDULE_EXPORT_STARTED: 'Export started',
  SCHEDULE_COMPLETED: 'Completed',
  SCHEDULE_FAILED: 'Failed',
  SCHEDULE_WAITING: 'Waiting on dependency',
  SCHEDULE_RETRYING: 'Retrying',
  SCHEDULE_SKIPPED: 'Skipped',
  SCHEDULE_MISSED: 'Missed',
  SCHEDULE_CREATED: 'Event created',
  SCHEDULE_UPDATED: 'Event updated',
  SCHEDULE_DELETED: 'Event deleted',
  PACKAGE_READY: 'Package ready',
  PACKAGE_DL_QUEUED: 'Download queued',
  PACKAGE_DL_STARTED: 'Download started',
  PACKAGE_DL_COMPLETED: 'Download completed',
  PACKAGE_DL_FAILED: 'Download failed',
};

function eventTone(event: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (event === 'SCHEDULE_FAILED' || event === 'PACKAGE_DL_FAILED') return 'danger';
  if (event === 'SCHEDULE_COMPLETED' || event === 'PACKAGE_READY' || event === 'PACKAGE_DL_COMPLETED') return 'success';
  if (event === 'SCHEDULE_WAITING' || event === 'SCHEDULE_RETRYING' || event === 'SCHEDULE_SKIPPED' || event === 'SCHEDULE_MISSED') return 'warning';
  if (event === 'SCHEDULE_RUNNING' || event === 'SCHEDULE_DUE' || event === 'SCHEDULE_EXPORT_STARTED' || event === 'PACKAGE_DL_STARTED' || event === 'PACKAGE_DL_QUEUED') return 'info';
  return 'neutral';
}

function feedLine(ev: ScheduleEvent): string {
  const prefix = new Date(ev.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  let detail = String(ev.scheduleName ?? '').trim();
  if (ev.event === 'PACKAGE_READY') detail = String((ev as any).filename ?? detail);
  if (ev.event === 'SCHEDULE_COMPLETED') detail = String((ev as any).recordCount != null ? `${fmtCompact((ev as any).recordCount)} records` : detail);
  if (ev.event === 'SCHEDULE_FAILED') detail = String((ev as any).error ?? detail);
  if (ev.event === 'SCHEDULE_WAITING') detail = String((ev as any).reason ?? detail);
  return [prefix, EVENT_LABELS[ev.event] ?? ev.event, detail].filter(Boolean).join(' — ');
}

/* ========================================================================== */
/* Create / Edit event dialog                                                  */
/* ========================================================================== */

function CreateEventDialog({
  open, onOpenChange, editing, kindsMeta, onSaved,
}: {
  open: boolean; onOpenChange: (v: boolean) => void;
  editing: UnifiedEvent | null;
  kindsMeta: Array<{ kind: string; label: string; description: string; requiresConfirm: boolean }>;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [kind, setKind] = useState<string>('notify');
  const [name, setName] = useState('');
  const [type, setType] = useState<Schedule['type']>('daily');
  const [time, setTime] = useState('09:00');
  const [date, setDate] = useState(() => new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [onDevice, setOnDevice] = useState(true);
  const [lead, setLead] = useState(5);
  const [onCompletion, setOnCompletion] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormError(null); setSaved(false); setConfirm(false);
    if (editing) {
      const s = editing.schedule ?? {} as Schedule;
      setKind(editing.kind); setName(editing.name);
      setType(s.type ?? 'daily');
      setTime(s.time ?? '09:00');
      setDate(s.date ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10));
      setDays((s.days?.length ? s.days : [0, 1, 2, 3, 4]));
      const n = editing.notify ?? {};
      setOnDevice(n.onDevice !== false);
      setLead(Number(n.leadMinutes ?? 5));
      setOnCompletion(n.onCompletion !== false);
      setConfirm(Boolean(editing.params?.confirm));
    } else {
      setKind('notify'); setName(''); setType('daily'); setTime('09:00');
      setDate(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
      setDays([0, 1, 2, 3, 4]);
      setOnDevice(true); setLead(5); setOnCompletion(true); setConfirm(false);
    }
  }, [open, editing]);

  const submit = async () => {
    if (!name.trim()) { setFormError('Name is required.'); return; }
    if (type === 'weekly' && days.length === 0) { setFormError('Pick at least one day for a weekly schedule.'); return; }
    if (type === 'once' && !date) { setFormError('Pick the date for a one-shot event.'); return; }
    if (DANGER_KINDS.has(kind) && !confirm) { setFormError(`"${kindMeta(kind).label}" needs the Confirm checkbox — the backend refuses to run it silently.`); return; }
    setBusy(true); setFormError(null);
    const schedule: any = { type, time, timezone: 'Asia/Kolkata' };
    if (type === 'weekly') schedule.days = days;
    if (type === 'once') schedule.date = date;
    const body: any = {
      name: name.trim(),
      kind,
      enabled: true,
      schedule,
      notify: { onDevice, leadMinutes: lead, onCompletion },
    };
    if (DANGER_KINDS.has(kind)) body.params = { confirm };
    try {
      const res = await fetch(isEdit ? `${EV_URL}/${encodeURIComponent(editing!.id)}` : EV_URL, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.ok !== false) {
        setSaved(true);
        onSaved();
        setTimeout(() => onOpenChange(false), 600);
      } else {
        setFormError(d?.detail || d?.error || `Backend refused (${res.status}).`);
      }
    } catch {
      setFormError('Request failed — is the backend reachable?');
    } finally {
      setBusy(false);
    }
  };

  const catalog = kindsMeta;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit scheduled event' : 'New scheduled event'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update the schedule or its notification policy.' : 'Pick what should happen and when — the backend runs the real hook.'}
          </DialogDescription>
        </DialogHeader>

        {/* kind */}
        {!isEdit && (
          <div>
            <p className="mb-1.5 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">What should run</p>
            <div className="grid grid-cols-2 gap-1.5">
              {catalog.map((k) => (
                <button key={k.kind} type="button" onClick={() => setKind(k.kind)} title={k.description}
                  className={cn('flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-left text-[11px] font-bold transition ring-1',
                    kind === k.kind ? 'shadow-md ring-transparent' : 'bg-card text-muted-foreground ring-border hover:text-foreground')}>
                  <KindChip kind={k.kind} className={kind === k.kind ? '' : 'opacity-90'} />
                  {k.requiresConfirm && <span className="text-rose-500">•</span>}
                </button>
              ))}
              <button type="button"
                onClick={() => onOpenChange(false)}
                className="flex items-center gap-1.5 rounded-xl bg-card px-2.5 py-2 text-left text-[11px] font-bold text-muted-foreground ring-1 ring-border transition hover:text-foreground"
                title="Geneva-grade multi-step download form — deep link">
                <span className="inline-flex shrink-0 items-center rounded-lg bg-indigo-600 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-white shadow-sm dark:bg-indigo-500 dark:text-indigo-950">Download</span>
                <span>Full form →</span>
              </button>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {kindMeta(kind).hint}
            </p>
          </div>
        )}

        {/* schedule */}
        <div className="space-y-2">
          <p className="text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">When</p>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Event name (e.g. Night flush)"
            className="h-9" maxLength={120} aria-label="Event name" />
          <div className="flex flex-wrap gap-2">
            <div className="flex overflow-hidden rounded-full border border-border bg-muted/40 p-0.5" role="group" aria-label="Repeat">
              {([['once', 'Once'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly']] as const).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setType(v)}
                  className={cn('rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase transition',
                    type === v ? 'bg-foreground text-background shadow' : 'text-muted-foreground hover:text-foreground')}>
                  {label}
                </button>
              ))}
            </div>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-9 w-[120px] rounded-full" aria-label="Time of day" />
            {type === 'once' && (
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-[160px] rounded-full" aria-label="Date" />
            )}
          </div>
          {type === 'weekly' && (
            <div className="flex gap-1" role="group" aria-label="Days of week">
              {DAYS.map((d, i) => (
                <button key={d} type="button" onClick={() => setDays((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))}
                  className={cn('h-8 w-11 rounded-lg text-[10px] font-extrabold uppercase transition ring-1',
                    days.includes(i) ? 'bg-violet-600 text-white ring-transparent shadow' : 'bg-card text-muted-foreground ring-border hover:text-foreground')}>
                  {d.slice(0, 2)}
                </button>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">Timezone Asia/Kolkata{type === 'weekdays' ? ' — repeats Mon–Fri automatically' : ''}.</p>
        </div>

        {/* notify */}
        <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">
            <Bell className="h-3 w-3" /> On-device notification
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">Notify this device before the event (browser notification)</span>
            <Switch checked={onDevice} onCheckedChange={setOnDevice} aria-label="On-device notification" />
          </div>
          {onDevice && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase text-muted-foreground">Lead</span>
              <div className="flex overflow-hidden rounded-full border border-border bg-background p-0.5" role="group" aria-label="Lead minutes">
                {[0, 1, 5, 10, 30, 60].map((m) => (
                  <button key={m} type="button" onClick={() => setLead(m)}
                    className={cn('rounded-full px-2.5 py-0.5 text-[10px] font-extrabold tabular-nums transition',
                      lead === m ? 'bg-sky-600 text-white shadow' : 'text-muted-foreground hover:text-foreground')}>
                    {m === 0 ? 'at time' : `${m}m`}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground">before · {lead === 0 ? 'notify exactly at the scheduled time' : `${lead} min before`}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">Also notify when the run completes</span>
            <Switch checked={onCompletion} onCheckedChange={setOnCompletion} aria-label="Completion notification" />
          </div>
        </div>

        {/* danger confirm */}
        {DANGER_KINDS.has(kind) && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/5 p-3">
            <p className="flex items-center gap-1.5 text-xs font-bold text-rose-600 dark:text-rose-400">
              <Gavel className="h-3.5 w-3.5" /> {kindMeta(kind).label} is a REAL action
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{kindMeta(kind).hint}</p>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs font-semibold">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)}
                className="h-4 w-4 rounded border-rose-400 accent-rose-600" />
              I confirm {kind === 'shutdown' ? 'the backend must shut down at the scheduled time' : 'close-all orders may fire at the scheduled time'}
            </label>
            {!confirm && <p className="mt-1 text-[10px] text-rose-500/80">Unconfirmed events are recorded SKIPPED at run time — never executed.</p>}
          </div>
        )}

        {formError && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs font-semibold text-destructive">{formError}</p>
        )}
        {saved && (
          <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> Saved — the countdown is live on the card.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={busy} className="min-w-[96px]">
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}{isEdit ? 'Save changes' : 'Schedule event'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ========================================================================== */
/* Timeline sections                                                           */
/* ========================================================================== */

/** Next upcoming event across BOTH lanes — the hero. */
function heroPick(unified: UnifiedEvent[], jobs: ScheduleJob[]): { rail: RailKey; name: string; sub: string; target: string } | null {
  const targets: Array<{ at: number; name: string; sub: string; rail: RailKey; target: string }> = [];
  for (const e of unified) {
    if (!e.enabled || !e.nextRun) continue;
    const at = Date.parse(e.nextRun);
    if (Number.isFinite(at)) targets.push({ at, name: e.name, sub: `${kindMeta(e.kind).label} · ${scheduleText(e.schedule)}`, rail: kindRail(e.kind), target: e.nextRun });
  }
  for (const j of jobs) {
    if (!j.enabled || !j.nextRun) continue;
    const at = Date.parse(j.nextRun);
    if (Number.isFinite(at)) targets.push({ at, name: j.name, sub: `Download · ${scheduleText(j.schedule as Schedule)}`, rail: 'indigo', target: j.nextRun });
  }
  if (!targets.length) return null;
  targets.sort((a, b) => a.at - b.at);
  const t = targets[0];
  return { rail: t.rail, name: t.name, sub: t.sub, target: t.target };
}

function HeroCountdown({ pick }: { pick: ReturnType<typeof heroPick> }) {
  const text = useCountdownText(pick?.target ?? null);
  const now = useServerNow();
  const leftMs = pick?.target ? Date.parse(pick.target) - now : null;
  const urgent = leftMs != null && leftMs > 0 && leftMs < 15 * 60_000;
  return (
    <PunchCard rail={pick?.rail ?? 'none'} className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">Next up on this machine</span>
            {pick && <span className="rounded bg-muted px-1.5 py-px text-[9px] font-black uppercase text-muted-foreground">time left</span>}
          </div>
          <p className="mt-0.5 truncate text-base font-black tracking-tight">{pick ? pick.name : DASH}</p>
          <p className="text-[11px] font-semibold text-muted-foreground">{pick ? pick.sub : 'No enabled event has a future slot — schedule one below.'}</p>
        </div>
        <div className="text-right">
          <p className={cn(
            'text-3xl font-black tabular-nums leading-none sm:text-4xl',
            urgent ? 'ds-breathe text-amber-600 dark:text-amber-400' : pick ? '' : 'text-muted-foreground',
          )}>
            {text ?? <span className="text-muted-foreground">{DASH}</span>}
          </p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {pick ? `to ${new Date(pick.target!).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'no schedule pending'}
          </p>
        </div>
      </div>
    </PunchCard>
  );
}

/* ----------------------------- unified event card ---------------------------- */

function UnifiedEventCard({ ev, index, liveStatus, busy, onRun, onToggle, onEdit, onDelete, onRearm, onHistory }: {
  ev: UnifiedEvent; index: number; liveStatus?: string; busy: boolean;
  onRun: () => void; onToggle: () => void; onEdit: () => void; onDelete: () => void; onRearm: () => void; onHistory: () => void;
}) {
  const m = kindMeta(ev.kind);
  const live = liveStatus && liveStatus !== 'idle' ? statusMeta(liveStatus, true) : null;
  const stored = ev.enabled ? statusMeta(ev.lastStatus ?? null, true) : { tone: 'neutral' as const, label: 'Paused' };
  const display = live ?? stored;
  const countdown = useCountdownText(ev.enabled ? ev.nextRun : null);
  const done = Boolean(ev.completedAt);
  const needsRearm = !ev.enabled || done || !ev.nextRun;
  const pol = ev.notify ?? {};
  return (
    <PunchCard rail={kindRail(ev.kind)} index={index}
      className={cn('p-3.5', liveStatus === 'running' && 'ring-1 ring-info/40')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-black tracking-tight">{ev.name}</span>
            <KindChip kind={ev.kind} />
            {DANGER_KINDS.has(ev.kind) && Boolean(ev.params?.confirm) && (
              <span className="rounded bg-foreground px-1 py-px text-[8px] font-black uppercase text-background">confirmed</span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] font-semibold text-muted-foreground">{scheduleText(ev.schedule)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={onToggle} title={ev.enabled ? 'Pause' : 'Resume'} aria-label={ev.enabled ? 'Pause event' : 'Resume event'}
            className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground">
            {ev.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button type="button" onClick={onEdit} title="Edit" aria-label="Edit event"
            className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onDelete} title="Delete" aria-label="Delete event"
            className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Time left</p>
          <p className={cn('text-2xl font-black tabular-nums leading-none', liveStatus === 'running' && 'ds-breathe text-sky-600 dark:text-sky-400')}>
            {liveStatus === 'running' ? 'running…'
              : done ? <span className="text-muted-foreground">done</span>
              : ev.enabled && !countdown ? (ev.lastStatus === 'missed' ? 'missed' : '—')
              : <>{countdown ?? DASH}</>}
          </p>
          {ev.enabled && ev.nextRun && countdown && (
            <p className="text-[10px] font-bold tabular-nums text-muted-foreground">
              at {new Date(ev.nextRun).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={live?.tone ?? display.tone} label={live?.label ?? display.label} />
          <p className="text-[10px] font-bold tabular-nums text-muted-foreground">
            {fmtCompact(ev.runCount ?? 0) as any} runs{(ev.failCount ?? 0) > 0 ? ` · ${ev.failCount} failed` : ''}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {pol.onDevice && (
          <span className={cn('inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-bold', m.soft)}>
            <Bell className="h-3 w-3" /> {Number(pol.leadMinutes ?? 0) === 0 ? 'notify at time' : `${pol.leadMinutes}m lead`}{pol.onCompletion === false ? '' : ' + done'}
          </span>
        )}
        {ev.lastError && (
          <span className="max-w-full truncate rounded-lg bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive" title={ev.lastError}>{ev.lastError}</span>
        )}
        <span className="flex-1" />
        {needsRearm && (
          <Button size="sm" variant="outline" className="h-7 gap-1 rounded-full text-[10px]" onClick={onRearm}>
            <RefreshCw className="h-3 w-3" /> Re-arm
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 gap-1 rounded-full text-[10px]" onClick={onHistory}>
          <Clock className="h-3 w-3" /> Runs
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 rounded-full text-[10px]" onClick={onRun} disabled={busy || liveStatus === 'running'}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run now
        </Button>
      </div>
    </PunchCard>
  );
}

/* ----------------------------- download job card ----------------------------- */

function DownloadJobCard({ job, index, live, busy, pkg, onRun, onToggle, onDelete }: {
  job: ScheduleJob; index: number; live?: { status: string; packageReady?: any };
  busy: boolean; pkg?: 'running' | 'done' | 'failed';
  onRun: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const serverNow = useServerNow();
  const countdown = useCountdownText(job.enabled ? job.nextRun : null);
  const isLiveRunning = live?.status === 'running';
  const isLiveDue = live?.status === 'due';
  const meta = statusMeta(job.lastStatus, job.enabled);
  const stockCount = job.symbolMode === 'custom' ? (job.symbols?.length ?? 0) : (job.symbolMode === 'all' ? 'All' : 'Active');
  const fmtCount = (job.formats ?? []).map((f) => f.toUpperCase()).join(', ') || DASH;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(`${DL_URL}?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setRuns(((d?.runs?.bySchedule ?? {})[job._id] ?? []) as ScheduleRun[]); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, job._id]);

  const runningAgo = job.lastRun ? Math.max(0, Math.floor((serverNow - Date.parse(job.lastRun)) / 60000)) : null;
  const waitingNow = job.enabled && ['WAITING_FOR_DEPENDENCY', 'WAITING', 'PENDING_RETRY', 'RETRYING'].includes((job.lastStatus || '').toUpperCase());

  return (
    <PunchCard rail="indigo" index={index} className={cn('p-3.5', isLiveRunning && 'ring-1 ring-info/40')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-black tracking-tight">{job.name}</span>
            <KindChip kind="download" />
          </div>
          <p className="mt-0.5 text-[11px] font-semibold text-muted-foreground">{scheduleText(job.schedule as Schedule)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={onToggle} title={job.enabled ? 'Pause' : 'Resume'} aria-label="Toggle download schedule"
            className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground">
            {job.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <Button asChild size="sm" variant="ghost" className="h-7 rounded-full text-muted-foreground hover:text-foreground" title="Edit — full download form">
            <Link href={`/data-saver/schedules/new?edit=${job._id}`} aria-label="Edit download schedule"><Pencil className="h-3.5 w-3.5" /></Link>
          </Button>
          <button type="button" onClick={onDelete} title="Delete" aria-label="Delete download schedule"
            className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div><p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Stocks</p><p className="mt-0.5 text-xs font-bold">{stockCount === 'All' || stockCount === 'Active' ? stockCount : `${stockCount} selected`}</p></div>
        <div><p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Format</p><p className="mt-0.5 text-xs font-bold">{fmtCount}</p></div>
        <div><p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Range</p><p className="mt-0.5 text-xs font-bold capitalize">{(job.dateRange?.type || 'previous_day').replace(/_/g, ' ')}</p></div>
        <div><p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Time left</p>
          <p className="mt-0.5 text-xs font-black tabular-nums">
            {isLiveRunning ? 'running…' : job.enabled ? (countdown ?? DASH) : 'Paused'}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <StatusBadge status={isLiveRunning ? 'info' as const : isLiveDue ? 'warning' as const : (live && ['success', 'failed', 'waiting', 'retrying', 'skipped', 'missed'].includes(live.status) ? statusMeta(live.status, true).tone : meta.tone)}
          label={isLiveRunning ? 'Running…' : isLiveDue ? 'Due now' : (live && ['success', 'failed', 'waiting', 'retrying', 'skipped', 'missed'].includes(live.status) ? statusMeta(live.status, true).label : meta.label)} />
        {pkg === 'running' && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 dark:text-indigo-400"><Download className="h-3 w-3 animate-bounce" /> downloading</span>
        )}
        {pkg === 'done' && <StatusBadge status="success" label="Downloaded" />}
        <span className="text-[10px] font-bold tabular-nums text-muted-foreground">
          {fmtCompact(job.runCount) as any} runs · last {runningAgo != null ? `${runningAgo}m ago` : DASH}
        </span>
        {job.lastError && job.lastStatus && !['success', 'completed'].includes((job.lastStatus || '').toLowerCase()) && (
          <span className="max-w-[220px] truncate rounded-lg bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive" title={job.lastError}>{job.lastError}</span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="outline" className="h-7 gap-1 rounded-full text-[10px]" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="h-3 w-3" /> : <Clock className="h-3 w-3" />} History
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 rounded-full text-[10px]" onClick={onRun} disabled={busy || isLiveRunning}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run now
        </Button>
      </div>

      {job.lastFile && job.historyId && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1 text-[10px]"><FileArchive className="h-3 w-3" /> {job.lastFile} · {fmtBytes(job.lastFileSize)}</Badge>
          <Button size="sm" variant="outline" className="h-7 gap-1 rounded-full text-[10px]" asChild>
            <a href={`/api/phase2/download-history/${job.historyId}/file`} download={job.lastFile}><Download className="h-3 w-3" /> Package</a>
          </Button>
        </div>
      )}

      {waitingNow && (
        <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[10px]">
          <b className="text-amber-600 dark:text-amber-400">Export waiting</b>
          <span className="text-muted-foreground"> — {job.failure_reason || job.lastError || 'dependency unavailable'}
            {job.nextRetryAt ? ` · retry ${ist(job.nextRetryAt)}` : ''}</span>
        </div>
      )}

      {open && (
        <div className="mt-3 border-t border-dashed border-border/70 pt-2">
          {runs.length === 0 ? <p className="text-[11px] text-muted-foreground">No executions recorded yet.</p> : (
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border/60 text-left uppercase tracking-wider text-muted-foreground">
                  <th className="py-1 pr-2 font-semibold">When</th>
                  <th className="py-1 pr-2 font-semibold">Trigger</th>
                  <th className="py-1 pr-2 font-semibold">Status</th>
                  <th className="py-1 pr-2 text-right font-semibold">Records</th>
                  <th className="py-1 text-right font-semibold">Zip</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 8).map((r) => {
                  const rm = statusMeta(r.status, true);
                  return (
                    <tr key={r._id} className="border-b border-border/30">
                      <td className="py-1 pr-2 tabular-nums whitespace-nowrap">{ist(r.runAt)}</td>
                      <td className="py-1 pr-2 capitalize">{r.trigger ?? DASH}</td>
                      <td className="py-1 pr-2"><StatusBadge status={rm.tone} label={rm.label} /></td>
                      <td className="py-1 pr-2 text-right tabular-nums">{fmtCompact(r.recordCount) as any}</td>
                      <td className="py-1 text-right tabular-nums">{fmtBytes(r.fileSizeBytes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </PunchCard>
  );
}

/* ------------------------- unified run history dialog ------------------------ */

type UnifiedRun = {
  _id?: string; startedAt?: string | null; finishedAt?: string | null; scheduledAt?: string | null;
  trigger?: string; status?: string; error?: string | null; durationMs?: number | null; result?: Record<string, unknown> | null;
};

function RunHistoryDialog({ ev, onOpenChange }: { ev: UnifiedEvent | null; onOpenChange: (v: boolean) => void }) {
  const [runs, setRuns] = useState<UnifiedRun[] | null>(null);
  useEffect(() => {
    if (!ev) return;
    setRuns(null);
    let alive = true;
    fetch(`${EV_URL}/runs?eventId=${encodeURIComponent(ev.id)}&limit=50`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setRuns(Array.isArray(d?.items) ? d.items as UnifiedRun[] : []); })
      .catch(() => { if (alive) setRuns([]); });
    return () => { alive = false; };
  }, [ev]);

  return (
    <Dialog open={!!ev} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Run history — {ev?.name ?? ''}</DialogTitle>
          <DialogDescription>{ev ? `${kindMeta(ev.kind).label} · capped at 50 recent runs` : ''}</DialogDescription>
        </DialogHeader>
        {runs === null ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading run records…</div>
        ) : runs.length === 0 ? (
          <p className="py-4 text-xs text-muted-foreground">No runs yet — the record starts with the first execution.</p>
        ) : (
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-border/60 text-left uppercase tracking-wider text-muted-foreground">
                <th className="py-1 pr-2 font-semibold">Started</th>
                <th className="py-1 pr-2 font-semibold">Trigger</th>
                <th className="py-1 pr-2 font-semibold">Status</th>
                <th className="py-1 text-right font-semibold">ms</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => {
                const rm = statusMeta(r.status, true);
                return (
                  <tr key={r._id ?? i} className="border-b border-border/30 align-top">
                    <td className="py-1.5 pr-2 tabular-nums whitespace-nowrap">{ist(r.startedAt)}</td>
                    <td className="py-1.5 pr-2">{r.trigger ?? DASH}</td>
                    <td className="py-1.5 pr-2">
                      <StatusBadge status={rm.tone} label={rm.label} />
                      {r.error && <p className="mt-0.5 max-w-[220px] truncate text-[9px] text-muted-foreground" title={r.error}>{r.error}</p>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{r.durationMs ?? DASH}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ========================================================================== */
/* Page                                                                        */
/* ========================================================================== */

export default function Phase2SchedulesPage() {
  const [paused, setPaused] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // downloads lane (existing engine — REST only, 30s)
  const [dlLoading, setDlLoading] = useState(true);
  const [dlError, setDlError] = useState<string | null>(null);
  const [dlData, setDlData] = useState<any>(null);
  const dlRef = useRef<any>(null); dlRef.current = dlData;
  const [runningSet, setRunningSet] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<Record<string, 'running' | 'done' | 'failed'>>({});
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const mounted = useRef(true);

  // unified lane (REST + WS push)
  const { events, loading: evLoading, error, transport, refresh: refreshEv } = useUnifiedEvents(paused);

  // SSE — feeds BOTH lanes (downloads already publish there; the unified
  // scheduler reuses the same event grammar with origin=event_scheduler).
  const { connected, recentEvents, scheduleStates } = useScheduleEvents(!paused);
  const serverNow = useServerNow();

  // notification permission
  const [permission, setPermission] = useState<string>('default');
  useEffect(() => { setPermission(desktopPermission()); }, []);
  const askPermission = async () => {
    const p = await requestDesktopPermission();
    setPermission(p === 'unsupported' ? 'unsupported' : String(p));
  };

  useScheduleNotifier(events, scheduleStates, recentEvents, permission, connected);

  const autoDownloadWhenOnline = useSettingValue('ds_auto_download_when_online');
  const deviceId = useSettingValue('ds_device_id') || 'default-device';

  /* ------------------------------ downloads lane ------------------------- */
  const fetchDl = useCallback(async () => {
    try {
      const res = await fetch(`${DL_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const d = await res.json();
      if (!mounted.current) return;
      setDlData(d);
      setDlError(null);
    } catch (e) {
      if (!mounted.current) return;
      setDlError(e instanceof Error ? e.message : 'Failed to load schedules');
    } finally {
      if (mounted.current) setDlLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { fetchDl(); }, [fetchDl, refreshKey]);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => { if (document.visibilityState !== 'hidden') fetchDl(); }, 30000);
    return () => clearInterval(id);
  }, [fetchDl, paused]);

  const jobs: ScheduleJob[] = useMemo(() => dlData?.jobs ?? [], [dlData]);
  const health = dlData?.health && dlData.health.ok !== false ? dlData.health : null;
  const deps: any[] = health?.dependencies?.checks ?? [];
  const market = health?.market ?? null;

  const handlePackageReady = useCallback((ev: ScheduleEvent) => {
    const packageId = String((ev as any).packageId ?? '');
    const historyId = String((ev as any).historyId ?? '');
    const filename = String((ev as any).filename ?? '');
    const jobName = String(ev.scheduleName ?? 'package');
    if (!packageId || !historyId) return;
    fetch(`/api/phase2/schedules/packages/${encodeURIComponent(packageId)}/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', deviceId }),
    }).catch(() => {});
    if (autoDownloadWhenOnline) {
      const a = document.createElement('a');
      a.href = `/api/phase2/download-history/${encodeURIComponent(historyId)}/file`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setDownloading((prev) => ({ ...prev, [packageId]: 'running' }));
      setTimeout(() => setDownloading((prev) => ({ ...prev, [packageId]: 'done' })), 4000);
    }
    setAutoLog((prev) => [`${new Date(ev.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} ${jobName}${autoDownloadWhenOnline ? ` — download started (${filename || historyId})` : ' — package marked for your device (auto-download off in settings)'}`, ...prev].slice(0, 30));
  }, [autoDownloadWhenOnline, deviceId]);

  const handledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!connected) return;
    for (const ev of recentEvents) {
      if (ev.event === 'PACKAGE_READY') {
        const key = String(ev.eventId ?? '');
        if (key && !handledRef.current.has(key)) {
          handledRef.current.add(key);
          handlePackageReady(ev);
        }
      }
    }
  }, [recentEvents, connected, handlePackageReady]);

  /* --------------------------- unified lane actions ---------------------- */
  const evBusy = useRef<Set<string>>(new Set());
  const [evRunning, setEvRunning] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UnifiedEvent | null>(null);
  const [historyFor, setHistoryFor] = useState<UnifiedEvent | null>(null);

  const withEvBusy = async (id: string, fn: () => Promise<void>) => {
    if (evBusy.current.has(id)) return;
    evBusy.current.add(id);
    setEvRunning((p) => new Set(p).add(id));
    try { await fn(); } finally {
      evBusy.current.delete(id);
      setEvRunning((p) => { const n = new Set(p); n.delete(id); return n; });
    }
  };

  const refreshAll = useCallback(() => { void refreshEv(); void fetchDl(); }, [refreshEv, fetchDl]);

  const evRun = (e: UnifiedEvent) => void withEvBusy(e.id, async () => {
    try { await fetch(`${EV_URL}/${encodeURIComponent(e.id)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* backend offline — refresh reconciles */ }
    setTimeout(refreshAll, 900);
  });
  const evToggle = (e: UnifiedEvent) => void withEvBusy(e.id, async () => {
    try { await fetch(`${EV_URL}/${encodeURIComponent(e.id)}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { }
    setTimeout(refreshAll, 700);
  });
  const evDelete = (e: UnifiedEvent) => void withEvBusy(e.id, async () => {
    if (!window.confirm(`Delete event "${e.name}"? Its run history goes with it.`)) return;
    try { await fetch(`${EV_URL}/${encodeURIComponent(e.id)}`, { method: 'DELETE' }); } catch { }
    setTimeout(refreshAll, 700);
  });
  const evRearm = (e: UnifiedEvent) => void withEvBusy(e.id, async () => {
    try {
      const res = await fetch(`${EV_URL}/${encodeURIComponent(e.id)}/rearm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json().catch(() => null);
      if (res.status === 422) window.alert(String(d?.detail ?? 'One-shot date already past — edit the date first.'));
    } catch { }
    setTimeout(refreshAll, 700);
  });

  /* ------------------------------- derived ------------------------------- */
  const jobsActive = jobs.filter((j) => j.enabled).length;
  const todayDone = (Object.values(dlData?.runs?.bySchedule ?? {}) as ScheduleRun[]).flat()
    .filter((r) => (r.status === 'success' || r.status === 'completed') && isTodayIst(r.runAt)).length;
  const liveRunning = events.filter((e) => scheduleStates.get(e.id)?.status === 'running').length
    + jobs.filter((j) => scheduleStates.get(j._id)?.status === 'running').length;

  // filters
  const [filter, setFilter] = useState<'all' | 'reminders' | 'system' | 'downloads'>('all');
  const [q, setQ] = useState('');
  const qNorm = q.trim().toLowerCase();
  const filters = useMemo<Array<[typeof filter, string]>>(() => [['all', 'All'], ['reminders', 'Reminders'], ['system', 'System'], ['downloads', 'Downloads']], []);
  const showDownloads = filter === 'all' || filter === 'downloads';
  const showSystem = filter === 'all' || filter === 'system' || filter === 'reminders';
  const unified = useMemo(() => {
    const list = events.filter((e) => filter === 'all' ? true : filter === 'reminders' ? e.kind === 'notify' : filter === 'system' ? e.kind !== 'notify' : false);
    return list
      .filter((e) => !qNorm || e.name.toLowerCase().includes(qNorm) || e.kind.includes(qNorm))
      .sort((a, b) => {
        const av = a.enabled && a.nextRun ? Date.parse(a.nextRun) : Infinity;
        const bv = b.enabled && b.nextRun ? Date.parse(b.nextRun) : Infinity;
        if (av !== bv) return av - bv;
        return (b.runCount ?? 0) - (a.runCount ?? 0);
      });
  }, [events, filter, qNorm]);
  const dlJobs = useMemo(() => jobs
    .filter((j) => !qNorm || j.name.toLowerCase().includes(qNorm))
    .sort((a, b) => {
      const av = a.enabled && a.nextRun ? Date.parse(a.nextRun) : Infinity;
      const bv = b.enabled && b.nextRun ? Date.parse(b.nextRun) : Infinity;
      return av - bv;
    }), [jobs, qNorm]);

  const hero = useMemo(() => heroPick(events, jobs), [events, jobs]);

  const kindsMeta: Array<{ kind: string; label: string; description: string; requiresConfirm: boolean }> = useMemo(() => {
    const src: any[] = [];
    // the honest catalog mirrors the backend registry (see services/event_scheduler.py)
    for (const k of Object.keys(KIND_META)) {
      if (k === 'download') continue;
      src.push({ kind: k, label: kindMeta(k).label, description: kindMeta(k).hint, requiresConfirm: DANGER_KINDS.has(k) });
    }
    return src;
  }, []);

  const loading = (evLoading || dlLoading) && !dlData && events.length === 0;

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-3 pb-24 pt-4 sm:px-5 bottom-nav-offset">
      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-30 -mx-3 border-b border-border/60 bg-background/95 px-3 py-3 sm:-mx-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-600/25">
              <CalendarClock className="h-4.5 w-4.5" />
            </span>
            <div>
              <h1 className="text-lg font-black leading-tight tracking-tight">Schedules</h1>
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
                <TransportPill transport={transport} />
                {serverNow > 0 && (
                  <span className="tabular-nums">{new Date(serverNow).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {permission === 'granted' ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[10px] font-bold text-sky-600 dark:text-sky-400" title="On-device notifications are ON">
                <Bell className="h-3 w-3" /> Notify on
              </span>
            ) : permission === 'denied' ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-[10px] font-bold text-muted-foreground" title="Browser notifications blocked — enable them in the browser settings">
                <BellOff className="h-3 w-3" /> Notify blocked
              </span>
            ) : (
              <Button size="sm" variant="outline" className="h-8 rounded-full border-sky-500/40 text-[11px] font-bold text-sky-600 dark:text-sky-400" onClick={askPermission}>
                <Bell className="h-3.5 w-3.5" /> Enable notifications
              </Button>
            )}
            <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full" aria-label={paused ? 'Resume' : 'Pause'} onClick={() => setPaused((p) => !p)}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full" aria-label="Refresh"
              onClick={() => { setRefreshKey((k) => k + 1); void refreshEv(); }}>
              <RefreshCw className={cn('h-4 w-4', (evLoading || dlLoading) && 'animate-spin')} />
            </Button>
            <InstallAppButton />
            <Button size="sm" className="rounded-full" onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="mr-1 h-3.5 w-3.5" /> New event
            </Button>
          </div>
        </div>
      </header>

      {loading ? (
        <LoadingState text="Loading schedules…" />
      ) : (error && !dlData) ? (
        <EmptyState icon={WifiOff} title="Scheduler unavailable"
          description={`The backend scheduler document could not be read (${error}).`}
          action={<Button size="sm" variant="outline" onClick={() => { void refreshEv(); void fetchDl(); }}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>} />
      ) : (
        <>
          {/* ------------------------------------------------------ hero */}
          <HeroCountdown pick={hero} />

          {/* ---------------------------------------------------- summary */}
          <PunchCard rail="none" className="p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {[
                { label: 'Events', v: events.length, tone: 'text-violet-600 dark:text-violet-400' },
                { label: 'Enabled', v: events.filter((e) => e.enabled).length, tone: 'text-emerald-600 dark:text-emerald-400' },
                { label: 'Downloads', v: `${jobsActive}/${jobs.length}`, tone: 'text-indigo-600 dark:text-indigo-400' },
                { label: 'Running now', v: liveRunning, tone: liveRunning > 0 ? 'text-sky-600 dark:text-sky-400' : 'text-muted-foreground' },
                { label: 'Done today', v: todayDone, tone: 'text-teal-600 dark:text-teal-400' },
                { label: 'Recently failed', v: events.filter((e) => e.lastStatus === 'failed').length, tone: 'text-rose-600 dark:text-rose-400' },
              ].map((s) => (
                <div key={s.label} className="rounded-xl bg-muted/40 px-3 py-2 text-center ring-1 ring-border/50">
                  <p className={cn('text-lg font-black tabular-nums leading-tight', s.tone)}>{s.v}</p>
                  <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
          </PunchCard>

          {/* ------------------------------------------------ dependencies */}
          {health && (
            <PunchCard rail="none" className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">Download dependencies</span>
                <span className="text-[10px] font-bold text-muted-foreground">
                  Market: <b className="text-foreground capitalize">{market?.market_status || DASH}</b> · {market?.market_date} · {market?.trading_day ? 'Trading day' : (market?.closure_reason || 'Non-trading day')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {deps.map((c: any) => (
                  <span key={c.dependency} title={c.reason}
                    className={cn('inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold',
                      c.available ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/25' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 ring-1 ring-rose-500/25')}>
                    <span className={cn('h-1.5 w-1.5 rounded-full', c.available ? 'bg-emerald-500' : 'bg-rose-500')} />
                    {c.dependency}
                  </span>
                ))}
              </div>
            </PunchCard>
          )}

          {/* ------------------------------------------------ downloads failure */}
          {dlError && (
            <PunchCard rail="red" className="p-3">
              <p className="flex items-center justify-between gap-2 text-[11px] font-semibold">
                <span><span className="text-destructive font-bold">Downloads lane: </span>{dlError} — showing the last known rows.</span>
                <Button size="sm" variant="outline" className="h-6 rounded-full text-[10px]" onClick={() => { setRefreshKey((k) => k + 1); }}>Retry</Button>
              </p>
            </PunchCard>
          )}

          {/* ------------------------------------------------ filter bar */}
          <PunchCard rail="none" className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-full border border-border bg-muted/40 p-0.5" role="group" aria-label="Lane filter">
                {filters.map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setFilter(v)}
                    className={cn('rounded-full px-3 py-1 text-[11px] font-extrabold transition',
                      filter === v ? 'bg-foreground text-background shadow' : 'text-muted-foreground hover:text-foreground')}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="relative flex-1 min-w-[160px]">
                <Globe className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events…"
                  className="h-8 rounded-full pl-8 text-xs" aria-label="Search events" />
              </div>
              {q && <Button size="sm" variant="ghost" className="h-8 rounded-full px-2" onClick={() => setQ('')} aria-label="Clear search"><X className="h-3.5 w-3.5" /></Button>}
            </div>
          </PunchCard>

          {/* --------------------------------------------- unified events */}
          <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2 xl:grid-cols-3">
            {showSystem && unified.map((e, i) => (
              <UnifiedEventCard key={e.id} ev={e} index={i} liveStatus={scheduleStates.get(e.id)?.status} busy={evRunning.has(e.id)}
                onRun={() => evRun(e)} onToggle={() => evToggle(e)}
                onEdit={() => { setEditing(e); setDialogOpen(true); }}
                onDelete={() => evDelete(e)} onRearm={() => evRearm(e)} onHistory={() => setHistoryFor(e)} />
            ))}
            {showDownloads && dlJobs.map((j, i) => {
              const pkgEv = (scheduleStates.get(j._id) as any)?.packageReady as any;
              const pkgId = pkgEv?.packageId != null ? String(pkgEv.packageId) : '';
              return (
              <DownloadJobCard key={j._id} job={j} index={i}
                live={(() => { const l = scheduleStates.get(j._id); return l ? { status: l.status, packageReady: (l as any).packageReady } : undefined; })()}
                busy={runningSet.has(j._id)}
                pkg={pkgId ? downloading[pkgId] : undefined}
                onRun={async () => {
                  setRunningSet((p) => new Set(p).add(j._id));
                  try { await fetch(`${DL_URL}/${encodeURIComponent(j._id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run' }) }); } catch { }
                  setTimeout(fetchDl, 1500);
                  setRunningSet((p) => { const n = new Set(p); n.delete(j._id); return n; });
                }}
                onToggle={async () => {
                  try { await fetch(`${DL_URL}/${encodeURIComponent(j._id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { }
                  fetchDl();
                }}
                onDelete={async () => {
                  if (!window.confirm(`Delete schedule "${j.name}"? Historical execution records will be kept.`)) return;
                  try { await fetch(`${DL_URL}/${encodeURIComponent(j._id)}`, { method: 'DELETE' }); } catch { }
                  fetchDl();
                }} />
              );
            })}
          </div>

          {unified.length === 0 && dlJobs.length === 0 && !evLoading && !dlLoading && (
            <EmptyState icon={CalendarClock} title="Nothing scheduled yet"
              description="Schedule ANY event — a download export, a quality scan, a pipeline flush, broker login/logout, square-off, a market scan, a device reminder — even a service shutdown. Pick a kind, set the time, done."
              action={<Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}><Plus className="mr-1 h-3.5 w-3.5" /> New event</Button>} />
          )}
          {showSystem && unified.length === 0 && (filter === 'reminders' || filter === 'system') && !evLoading && (
            <PunchCard rail="none" className="p-4">
              <p className="text-xs font-semibold text-muted-foreground">
                No{filter === 'reminders' ? ' reminders' : ' system actions'} on this scheduler yet — schedule one with “New event”.
              </p>
            </PunchCard>
          )}

          {/* ------------------------------------------- live activity */}
          <section aria-label="Live activity" className="space-y-2">
            <PunchCard rail="none" className="p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">
                  <Radio className={cn('h-3.5 w-3.5', connected ? 'text-success ds-breathe' : 'text-muted-foreground')} /> Live activity — both lanes
                </span>
                <span className="text-[10px] font-bold text-muted-foreground">
                  {connected ? 'connected to the scheduler bus' : 'connecting…'}
                </span>
              </div>
              {!connected ? (
                <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting to the live event stream…</p>
              ) : recentEvents.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No scheduler events yet — runs appear here live for downloads AND unified events.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {recentEvents.slice(0, 12).map((ev) => (
                    <li key={ev.eventId} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      <StatusBadge status={eventTone(ev.event)} label={EVENT_LABELS[ev.event] ?? ev.event} />
                      <span className="min-w-0 flex-1 text-foreground">{feedLine(ev)}</span>
                      <span className="whitespace-nowrap text-muted-foreground tabular-nums">{new Date(ev.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PunchCard>
          </section>

          {autoLog.length > 0 && (
            <PunchCard rail="none" className="p-3.5">
              <span className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">Auto downloads</span>
              <ul className="mt-1.5 space-y-1">
                {autoLog.slice(0, 8).map((line, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /><span>{line}</span>
                  </li>
                ))}
              </ul>
            </PunchCard>
          )}

          {/* -------------------------------------------- provenance */}
          <details className="group rounded-2xl border border-border/70 bg-card p-3 text-xs">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-bold text-muted-foreground transition hover:text-foreground">
              <span className="flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" /> Schedules provenance — how every section is fed</span>
              <span className="text-[10px] font-semibold">{transport === 'live' ? 'LIVE · WS push' : transport === 'poll' ? 'REST poll' : 'offline'}</span>
            </summary>
            <div className="mt-2 grid gap-x-6 gap-y-1.5 text-[11px] text-muted-foreground sm:grid-cols-2">
              <p><b className="text-foreground">Unified events:</b> the event scheduler&apos;s own engine (Mongo <code>scheduled_events</code>) — CRUD at <code>/api/sched-events</code>, 5s due-precision loop, run history capped per event.</p>
              <p><b className="text-foreground">Every kind is a REAL hook:</b> quality scan, atlas cleanup, tick-buffer flush, broker login/logout, square-off engine, full market scan, service shutdown, pure reminders. Nothing invented — an unconfigured action is plainly shown as its label.</p>
              <p><b className="text-foreground">Downloads lane:</b> the dedicated scheduled-downloads engine (ZIP exports, packages, dependency health) — create/edit deep-links to its full form.</p>
              <p><b className="text-foreground">Countdowns:</b> anchored to the backend clock every second (no local-device trust); <span className="font-bold">—</span> means the backend has no future slot right now.</p>
              <p><b className="text-foreground">Notifications:</b> browser-native only when you allow them; lead reminders + run results arrive per event&apos;s notify policy, deduped per slot — a notification you never configured never pops.</p>
              <p><b className="text-foreground">Danger gates:</b> square-off and shutdown require an explicit Confirm; without it the backend records SKIPPED and never acts.</p>
              <p><b className="text-foreground">Live:</b> the <code>sched_events</code> WS push + the same schedule-events SSE stream both lanes share (DUE → RUNNING → COMPLETED/FAILED/SKIPPED/MISSED).</p>
              <p><b className="text-foreground">Honesty:</b> a MISSED one-shot is recorded MISSED — it is never silently executed and never shown as run.</p>
            </div>
          </details>
        </>
      )}

      {/* ----------------------------------------------- dialogs */}
      <CreateEventDialog
        open={dialogOpen} onOpenChange={setDialogOpen} editing={editing}
        kindsMeta={kindsMeta} onSaved={refreshAll} />
      <RunHistoryDialog ev={historyFor} onOpenChange={(v) => { if (!v) setHistoryFor(null); }} />
    </div>
  );
}
