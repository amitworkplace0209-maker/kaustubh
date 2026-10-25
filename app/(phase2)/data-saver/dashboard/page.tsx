'use client';

// Data Saver — Dashboard (redesigned from scratch).
//
// LOOK
// A vivid, colour-forward surface that is tuned for BOTH dark and light: every
// card carries a gradient accent rail, a soft theme-tinted glow, a hover
// spotlight and a sheen sweep (transform/opacity only). The whole page floats
// over a slow drifting aurora field. All animations are disabled under
// prefers-reduced-motion.
//
// DATA — TWO LANES, ONE TRUTH
//  · WebSocket (primary): the backend pushes a live `dashboard` document over
//    WS#3 (state changes instantly + 6s telemetry). The provider merges every
//    frame shallowly over the REST envelope — live fields win, heavy REST-only
//    detail (events, alerts, storage categories, states cards) is preserved.
//  · REST (fallback): `/api/data-saver/dashboard` keeps polling while the
//    socket is down. The header badge shows which lane delivered the newest
//    data. A transport that cannot deliver renders "—" honesty: a number the
//    backend cannot measure is NEVER invented, not by WS and not by REST.
//
// CONTENT
// Hero (transport + market + countdown) -> status strip -> KPI grid -> live
// flow -> scheduler -> session + pipeline -> storage + quality -> alerts +
// events -> quick links -> diagnostics. Floating live assistant (chat) is
// mounted at the end of the page.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity, AlertCircle, ArrowRight, CalendarClock, CheckCircle2, Clock,
  Cpu, Database, Download, Gauge, HardDrive, History, Layers, ListChecks,
  Pause, Play, Radio, RefreshCw, Server, Shield, Sparkles, Smartphone, Timer,
  TrendingDown, TrendingUp, Wifi, WifiOff, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionHeading, StatusBadge, EmptyState, LoadingState } from '@/components/design-system';
import { fmtBytes, fmtUptime } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { useDataSaver } from '@/components/phase2/data-saver-provider';
import { DashboardFlow } from '@/components/phase2/dashboard-flow';
import { DashboardChat } from '@/components/phase2/dashboard-chat';

const DASH = '—';

/* ========================================================================== */
/* PWA                                                                         */
/* ========================================================================== */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** True when the app already runs as an installed PWA. */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Install-app button wired to the browser's own install flow (never fake). */
function InstallAppButton() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (isStandalone()) setDone(true);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDone(true);
      setEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (done || !event) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => { void event.prompt().finally(() => setEvent(null)); }}
      className="rounded-full border border-emerald-400/30 bg-emerald-500/10 text-[11px] font-semibold text-emerald-600 transition hover:bg-emerald-500/20 dark:text-emerald-400"
      aria-label="Install the Data Saver app"
    >
      <Smartphone className="h-3.5 w-3.5" /> Install app
    </Button>
  );
}

/* ========================================================================== */
/* Ambient background                                                          */
/* ========================================================================== */

function Aurora() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="ds-drift-a absolute -left-32 -top-32 h-[34rem] w-[34rem] rounded-full bg-primary/10 blur-[110px]" />
      <div className="ds-drift-b absolute -right-40 top-24 h-[38rem] w-[38rem] rounded-full bg-info/10 blur-[120px]" />
      <div className="ds-drift-c absolute -bottom-40 left-1/4 h-[32rem] w-[32rem] rounded-full bg-purple/10 blur-[120px]" />
      <div className="ds-drift-b absolute right-1/3 -bottom-52 h-[26rem] w-[26rem] rounded-full bg-rose/10 blur-[110px]" />
      <div className="ds-drift-a absolute -top-20 right-10 h-[22rem] w-[22rem] rounded-full bg-teal/10 blur-[100px]" />
    </div>
  );
}

/* ========================================================================== */
/* Primitives                                                                  */
/* ========================================================================== */

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Vivid but desaturable accents — readable on both light and dark. */
const ACCENT: Record<string, { rail: string; chip: string; text: string; glow: string }> = {
  teal:    { rail: 'from-teal-400 via-emerald-400 to-teal-300',    chip: 'from-teal-400 to-emerald-500',   text: 'text-teal-600 dark:text-teal-300',      glow: 'via-teal-500/20' },
  sky:     { rail: 'from-sky-400 via-blue-400 to-cyan-300',        chip: 'from-sky-400 to-blue-500',       text: 'text-sky-600 dark:text-sky-300',        glow: 'via-sky-500/20' },
  violet:  { rail: 'from-violet-400 via-purple-400 to-fuchsia-300', chip: 'from-violet-400 to-purple-500', text: 'text-violet-600 dark:text-violet-300',  glow: 'via-violet-500/20' },
  amber:   { rail: 'from-amber-400 via-orange-400 to-yellow-300',  chip: 'from-amber-400 to-orange-500',   text: 'text-amber-600 dark:text-amber-300',    glow: 'via-amber-500/20' },
  rose:    { rail: 'from-rose-400 via-pink-400 to-red-300',        chip: 'from-rose-400 to-pink-500',      text: 'text-rose-600 dark:text-rose-300',      glow: 'via-rose-500/20' },
  emerald: { rail: 'from-emerald-400 via-green-400 to-lime-300',   chip: 'from-emerald-400 to-teal-500',   text: 'text-emerald-600 dark:text-emerald-300', glow: 'via-emerald-500/20' },
  slate:   { rail: 'from-slate-400 via-zinc-400 to-slate-300',     chip: 'from-slate-400 to-slate-500',    text: 'text-slate-600 dark:text-slate-300',    glow: 'via-slate-500/15' },
};

const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success', warning: 'bg-warning', danger: 'bg-destructive',
  info: 'bg-info', neutral: 'bg-muted-foreground/40',
};
const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success', warning: 'text-warning', danger: 'text-destructive',
  info: 'text-info', neutral: 'text-muted-foreground',
};
const TONE_PILL: Record<Tone, string> = {
  success: 'border-success/25 bg-success/10 text-success',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  danger: 'border-destructive/25 bg-destructive/10 text-destructive',
  info: 'border-info/25 bg-info/10 text-info',
  neutral: 'border-border/60 bg-muted/40 text-muted-foreground',
};

/**
 * The page's single surface: theme-aware glass with a colored rail, a soft
 * accent glow and a hover spotlight that follows a fixed soft gradient.
 */
function SoftCard({
  accent = 'slate', children, className, lift = true, index,
}: {
  accent?: string; children: React.ReactNode; className?: string;
  lift?: boolean; index?: number;
}) {
  const a = ACCENT[accent] ?? ACCENT.slate;
  return (
    <div
      style={index != null ? ({ '--ds-i': index } as React.CSSProperties) : undefined}
      className={cn(
        'ds-card group relative overflow-hidden rounded-3xl border border-border/50 bg-card/75 shadow-[0_1px_3px_hsl(var(--foreground)/0.04),0_18px_44px_-28px_hsl(var(--foreground)/0.18)] backdrop-blur-2xl',
        lift && 'ds-lift',
        index != null && 'ds-rise',
        className,
      )}
    >
      {/* accent rail */}
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r opacity-80', a.rail)} />
      {/* accent glow */}
      <span aria-hidden className={cn('pointer-events-none absolute -right-24 -top-28 h-56 w-56 rounded-full bg-gradient-to-br from-transparent blur-3xl', a.glow, 'to-transparent')} />
      {/* hover spotlight */}
      <span aria-hidden className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        style={{ background: 'radial-gradient(420px circle at 22% 0%, hsl(var(--primary) / 0.055), transparent 62%)' }} />
      {children}
    </div>
  );
}

/** Small label + value block used inside cards. */
function Stat({ label, value, tone, hint }: { label: string; value: React.ReactNode; tone?: Tone; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-background/40 px-2.5 py-2 transition-colors duration-300 hover:border-border/70" title={hint}>
      <p className="truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">{label}</p>
      <p className={cn('mt-0.5 truncate text-[15px] font-semibold leading-5 tracking-tight tabular-nums', tone ? TONE_TEXT[tone] : 'text-foreground')}>
        {value}
      </p>
    </div>
  );
}

function DetailRow({ label, value, hint, mono = true, valueClass }: {
  label: string; value: React.ReactNode; hint?: string; mono?: boolean; valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/30 py-[5px] last:border-0">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-right text-[11px] font-medium', valueClass, mono && 'tabular-nums')}
        title={hint ?? (typeof value === 'string' ? value : undefined)}>{value}</span>
    </div>
  );
}

function PulseDot({ tone, live }: { tone: Tone; live?: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {live && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-50', TONE_DOT[tone])} />}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', TONE_DOT[tone])} />
    </span>
  );
}

function SubHeading({ icon: Icon, children, right }: { icon?: React.ElementType; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}{children}
      </p>
      {right}
    </div>
  );
}

/** Soft conic ring — storage %, quality score, session countdown. */
function Ring({ pct, label, sub, size = 124, colors, tone }: {
  pct: number | null; label: string; sub?: string; size?: number;
  colors: [string, string]; tone?: 'ok' | 'warn' | 'bad' | 'live';
}) {
  if (pct == null) {
    return (
      <div className="flex shrink-0 flex-col items-center justify-center rounded-full border border-dashed border-border/60 text-center"
        style={{ height: size, width: size }}>
        <span className="px-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
        <span className="mt-0.5 text-[9px] text-muted-foreground/60">not measured</span>
      </div>
    );
  }
  const p = Math.max(0, Math.min(100, pct));
  const glow = tone === 'ok' ? 'shadow-success/25' : tone === 'warn' ? 'shadow-warning/25'
    : tone === 'bad' ? 'shadow-destructive/25' : 'shadow-primary/20';
  return (
    <div className={cn('relative flex shrink-0 items-center justify-center rounded-full transition-shadow duration-500', glow)}
      style={{ height: size, width: size, background: `conic-gradient(${colors[0]} 0% ${p}%, ${colors[1]} ${p}% 100%)` }}>
      <div className="absolute inset-[8px] rounded-full bg-card" />
      <div className="relative flex flex-col items-center justify-center">
        <span className="text-xl font-semibold leading-none tracking-tight tabular-nums">{p.toFixed(1)}%</span>
        <span className="mt-1 text-[8px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
        {sub && <span className="mt-0.5 max-w-[86px] truncate text-[9px] text-muted-foreground/70">{sub}</span>}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
function fmtNum(v: number | null | undefined): string {
  return num(v) == null ? DASH : v!.toLocaleString('en-IN');
}
function fmtTs(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
}
function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
/** Seconds from `now` until an ISO timestamp; null when unmeasurable. */
function secondsUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((t - now) / 1000));
}
function stateTone(state?: string | null): Tone {
  const s = String(state ?? '').toLowerCase();
  if (['ok', 'up', 'running', 'live', 'connected', 'success', 'green', 'healthy', 'ready'].includes(s)) return 'success';
  if (['degraded', 'warning', 'warn', 'stale', 'pending'].includes(s)) return 'warning';
  if (['error', 'down', 'failed', 'critical', 'red', 'unhealthy'].includes(s)) return 'danger';
  return 'neutral';
}
function ledgerTone(status: string | null | undefined): Tone {
  const s = String(status ?? '').toLowerCase();
  if (['completed', 'success', 'ok', 'done'].includes(s)) return 'success';
  if (['missed', 'warning', 'recovered', 'catching_up', 'catchup'].includes(s)) return 'warning';
  if (['failed', 'error'].includes(s)) return 'danger';
  if (['waiting', 'queued', 'pending'].includes(s)) return 'info';
  return 'neutral';
}
function eventTone(sev: string | null | undefined): Tone {
  const s = String(sev ?? '').toLowerCase();
  if (['error', 'critical', 'fatal'].includes(s)) return 'danger';
  if (['warn', 'warning'].includes(s)) return 'warning';
  if (['ok', 'success', 'resolved', 'recovered'].includes(s)) return 'success';
  return 'info';
}

/* ========================================================================== */
/* Diagnostics                                                                 */
/* ========================================================================== */

function TechDetails({ entries }: { entries: { key: string; state: any }[] }) {
  if (entries.length === 0) return null;
  return (
    <details className="group relative overflow-hidden rounded-2xl border border-border/40 bg-card/50 px-4 py-2.5 text-[11px] text-muted-foreground backdrop-blur-xl">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors hover:text-foreground">
        <Sparkles className="h-3 w-3" />
        Technical details · sources &amp; diagnostics
        <span className="ml-auto text-[9px] font-normal normal-case tracking-normal text-muted-foreground/60 group-open:hidden">click to expand</span>
      </summary>
      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {entries.map(({ key, state }) => (
          <div key={key} className="min-w-0 rounded-xl border border-border/40 bg-background/40 px-2.5 py-1.5">
            <p className="flex items-center gap-1.5">
              <span className="truncate text-[10px] font-semibold text-foreground/85">{key}</span>
              <StatusBadge status={stateTone(state?.status)} label={String(state?.status ?? 'na')} className="ml-auto shrink-0" />
            </p>
            <p className="truncate font-mono text-[10px]">{String(state?.value ?? DASH)}</p>
            <p className="truncate text-[10px] text-muted-foreground/85">{state?.reason || ''}</p>
            <p className="truncate text-[9px] text-muted-foreground/60">
              Source: {state?.source || DASH}
              {state?.lastUpdated ? <> · {timeAgo(state.lastUpdated, Date.now())}</> : null}
            </p>
            {Array.isArray(state?.detail) && state.detail.length > 0 && (
              <p className="truncate text-[9px] text-muted-foreground/60">Details: {state.detail.join(' · ')}</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/* ========================================================================== */
/* Dashboard                                                                   */
/* ========================================================================== */

function DashboardView() {
  const {
    data, error: fetchError, errorReason, loading, hasData, consecutiveFailures,
    refresh, paused, setPaused, transport, liveUpdatedAt, socketState,
  } = useDataSaver();

  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const d: any = data ?? {};
  const updatedAt = (d.updatedAt as string | null) ?? null;
  const st: Record<string, any> = d.states && typeof d.states === 'object' ? d.states : {};

  const sched: any = useMemo(() => d.scheduler ?? {}, [d.scheduler]);
  const ledger: any = useMemo(() => sched.ledger ?? {}, [sched.ledger]);
  const ledgerJobsToday: any = sched.ledgerJobsToday ?? {};
  const sess: any = d.session ?? {};
  const pipe: any = d.pipeline ?? {};
  const stor: any = d.storage ?? {};
  const mongo: any = d.mongo ?? {};
  const ws: any = d.ws ?? {};
  const qual: any = d.quality ?? {};
  const subscribed: any = d.subscribedStocks ?? {};
  const alerts: any[] = Array.isArray(d.alerts) ? d.alerts : [];
  const events: any[] = Array.isArray(d.events) ? d.events : [];

  const marketClosed = ['EXCHANGE_HOLIDAY', 'WEEKEND', 'MARKET_CLOSED', 'NO_TICKS_AFTER_CONFIRMATION'].includes(String(sched.marketState ?? ''));
  const marketOpen = !marketClosed;
  const pipelineLive = pipe.state === 'live';
  const ticksToday = num(d.ticksToday);
  const dataSaved = num(d.dataSaved);
  const qualityScore = num(d.qualityScore);
  const wsUptimeSec = num(d.wsUptimeSec);

  const storageUsedPct = stor.used != null && stor.capacity != null && stor.capacity > 0
    ? Number(((stor.used / stor.capacity) * 100).toFixed(1))
    : null;

  const currentReason = str(st['pipeline.state']?.reason)
    || (pipelineLive ? 'Pipeline is receiving market data and persisting ticks.'
      : sched.marketReasonMessage ?? `Market is closed${sched.closureReason ? ` — ${sched.closureReason}` : ''}. Data collection is paused until the next trading day.`)
    || 'No reason reported by the backend.';

  const liveClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(now));

  const filteredEvents = events.filter((e) => {
    const n = String(e.event ?? '');
    return !n.startsWith('state:') && n !== 'REST_SUCCESS';
  });
  const alertEvents = events.filter((e) => /^ALERT(_CREATED|_RESOLVED)?$/.test(String(e.event ?? '')));
  const techEntries = Object.entries(st).map(([key, state]) => ({ key, state }));

  /* ---------------- Scheduler: happened / counts / upcoming ---------------- */

  /** Real lifecycle statuses produced by the backend's
   *  `_scheduler_event_lifecycle` — never guessed from times alone. */
  const lifecycleTone = (raw: unknown): Tone => {
    const s = String(raw ?? '').toUpperCase();
    if (['COMPLETED'].includes(s)) return 'success';
    if (['RUNNING', 'ACTIVE'].includes(s)) return 'info';
    if (['FAILED'].includes(s)) return 'danger';
    if (['RETRYING', 'CATCHING_UP', 'SKIPPED', 'WAITING', 'DUE'].includes(s)) return 'warning';
    return 'neutral'; // UPCOMING / NOT_APPLICABLE / unknown
  };

  const lifecycle: {
    key: string; label: string; status: Tone; statusLabel: string;
    at: string | null; scheduled: string | null; explanation: string | null; source: string | null;
  }[] = useMemo(() => {
    if (Array.isArray(sched.lifecycle) && sched.lifecycle.length > 0) {
      return sched.lifecycle.map((it: any) => ({
        key: String(it?.code ?? it?.label ?? DASH),
        label: String(it?.label ?? it?.code ?? DASH).replace(/_/g, ' '),
        status: lifecycleTone(it?.status),
        statusLabel: String(it?.status ?? 'unknown').toLowerCase(),
        at: str(it?.actual),
        scheduled: str(it?.scheduled),
        explanation: str(it?.explanation),
        source: str(it?.actualSource),
      }));
    }
    // Fallback to the canonical window timestamps when no lifecycle block exists
    // (windowTimes keys per scheduler get_schedule(): login / ws_connect /
    // tick_collection_start / ws_disconnect / logout — real ISO times).
    const w: any = sched.windowTimes ?? {};
    const mk = (code: string, label: string, iso: unknown) => ({
      key: code, label, status: (str(iso) ? 'success' : 'neutral') as Tone,
      statusLabel: str(iso) ? 'recorded' : 'not recorded',
      at: str(iso), scheduled: str(iso), explanation: null, source: null,
    });
    return [
      mk('login', 'login', w.login),
      mk('ws_connect', 'ws connect', w.ws_connect),
      mk('tick_collection', 'tick collection', w.tick_collection_start),
      mk('ws_disconnect', 'ws disconnect', w.ws_disconnect),
      mk('logout', 'logout', w.logout),
    ];
  }, [sched]);

  const happenedCount = lifecycle.filter((l) => l.at != null).length;

  const upcoming = useMemo(() => [
    { key: 'next_login', label: 'Next login', at: sched.nextLogin },
    { key: 'next_ws_start', label: 'WebSocket connect', at: sched.nextWsStart },
    { key: 'next_tick', label: 'Tick collection', at: sched.nextTickCollection },
    { key: 'next_ws_stop', label: 'WebSocket stop', at: sched.nextWsStop },
    { key: 'next_market', label: 'Next market open', at: sched.nextMarketOpen },
  ].filter((u) => u.at != null), [sched]);

  const runCounts = useMemo(() => ([
    { label: 'Total runs', value: num(ledger.totalRuns), tone: 'neutral' as Tone },
    { label: 'Completed', value: num(ledger.completed), tone: 'success' as Tone },
    { label: 'Missed', value: num(ledger.missed), tone: 'warning' as Tone },
    { label: 'Recovered', value: num(ledger.recovered), tone: 'success' as Tone },
    { label: 'Waiting network', value: num(ledger.waitingNetwork), tone: 'warning' as Tone },
    { label: 'Waiting backend', value: num(ledger.waitingBackend), tone: 'neutral' as Tone },
    { label: 'Failed', value: num(ledger.failed), tone: 'danger' as Tone },
    { label: 'Skipped / expired', value: num(ledger.skipped), tone: 'neutral' as Tone },
  ]), [ledger]);

  const noData = !hasData && !loading && data === null;

  if (loading && !hasData) return <div className="relative p-4"><LoadingState text="Loading dashboard…" /></div>;

  if (noData) {
    return (
      <div className="relative space-y-4 p-4">
        <Aurora />
        <SoftCard accent="teal" className="p-5">
          <h1 className="text-base font-semibold tracking-tight">Data Saver</h1>
          <p className="text-xs text-muted-foreground">Live overview of data collection, storage, pipeline health, and scheduler state</p>
        </SoftCard>
        <SectionCard title="No data yet" icon={Activity}>
          <EmptyState
            icon={Activity}
            title="No snapshot received yet."
            description="The dashboard has not received a valid payload from either lane (WebSocket push or REST). It loads automatically as soon as data becomes available."
            action={<Button size="sm" variant="outline" onClick={refresh}><RefreshCw className="mr-2 h-4 w-4" /> Retry</Button>}
          />
        </SectionCard>
      </div>
    );
  }

  /* ---------------- KPI tiles ---------------- */
  const kpis = [
    {
      href: '/data-saver/subscription', icon: Radio, accent: 'amber', title: 'Subscribed Stocks',
      value: fmtNum(num(subscribed.active)),
      tone: ((num(subscribed.active) ?? 0) > 0 ? 'success' : 'neutral') as Tone,
      sub: subscribed.total != null
        ? <>of {fmtNum(num(subscribed.total))} on watch{subscribed.byWs != null ? <> · {fmtNum(num(subscribed.byWs))} on WS</> : null}</>
        : 'No subscription measurement available',
    },
    {
      href: '/data-saver/ticks', icon: Activity, accent: 'teal', title: 'Active Instruments',
      value: fmtNum(num(d.activeInstruments)),
      tone: ((num(d.activeInstruments) ?? 0) > 0 ? 'success' : 'neutral') as Tone,
      sub: num(d.activeInstruments) != null ? 'Instruments receiving ticks now' : 'No active feed to measure',
    },
    {
      href: '/data-saver/ticks', icon: Zap, accent: 'sky', title: 'Ticks Today',
      value: fmtNum(ticksToday),
      tone: (ticksToday != null ? (ticksToday > 0 ? 'success' : 'warning') : 'neutral') as Tone,
      sub: ticksToday == null
        ? (mongo.connected ? 'No ticks captured today (market/schedule)' : 'Unmeasured — MongoDB offline')
        : ticksToday > 0
          ? <>persisted since midnight{dataSaved != null && dataSaved !== ticksToday ? <> · ledger {fmtNum(dataSaved)}</> : null}</>
          : 'No ticks captured today',
    },
    {
      href: '/data-saver/insights', icon: Database, accent: 'violet', title: 'Total Records',
      value: fmtNum(num(d.totalRecordsInDb)),
      tone: ((num(d.totalRecordsInDb) ?? 0) > 0 ? 'success' : 'neutral') as Tone,
      sub: num(d.totalRecordsInDb) != null ? 'Tick documents in the MongoDB ticks collection' : 'MongoDB did not report a count',
    },
    {
      href: '/data-saver/insights', icon: HardDrive, accent: 'violet', title: 'Storage Used',
      value: storageUsedPct != null ? `${storageUsedPct.toFixed(1)}%` : DASH,
      tone: (storageUsedPct == null ? 'neutral' : storageUsedPct >= 90 ? 'warning' : 'success') as Tone,
      sub: stor.used != null && stor.capacity != null ? <>{fmtBytes(stor.used)} of {fmtBytes(stor.capacity)}</> : 'No storage measurement available',
    },
    {
      href: '/data-saver/websocket', icon: Gauge, accent: 'emerald', title: 'Ticks / sec',
      value: pipelineLive ? fmtNum(num(pipe.ticksPerSec)) : DASH,
      tone: (pipelineLive && (num(pipe.ticksPerSec) ?? 0) > 0 ? 'success' : 'neutral') as Tone,
      sub: pipelineLive
        ? num(pipe.ticksPerSec) != null && (num(pipe.ticksPerSec) ?? 0) > 0
          ? <>live rate over rolling 10s{pipe.savedPerSec != null ? <> · saving {fmtNum(num(pipe.savedPerSec))}/s</> : null}</>
          : 'Connected, no ticks in rolling window yet'
        : 'No active feed — rate not measured',
    },
  ];

  const chips: { label: string; value: string; tone: Tone; hint?: string }[] = [
    { label: 'Market', value: sched.marketState ?? sched.marketStatus ?? 'UNKNOWN', tone: sched.isTradingDay ? 'success' : 'info', hint: sched.marketReasonMessage ?? st['scheduler.market']?.reason },
    { label: 'Scheduler', value: sched.running ? 'Running' : 'Stopped', tone: sched.running ? 'success' : 'danger', hint: `State ${sched.state ?? DASH} · ${sched.enabled ? 'enabled' : 'disabled'}` },
    { label: 'Session', value: sess.active ? 'Active' : 'Inactive', tone: sess.active ? 'success' : marketClosed ? 'info' : 'warning', hint: st['session.status']?.reason },
    { label: 'Feed WS#1', value: ws.connected ? 'Connected' : 'Disconnected', tone: ws.connected ? 'success' : marketClosed ? 'info' : 'danger', hint: ws.disconnectReason ? `Reason: ${ws.disconnectReason}` : st['ws.connection']?.reason },
    { label: 'Database', value: mongo.connected ? 'Connected' : 'Disconnected', tone: mongo.connected ? 'success' : 'danger', hint: st['system.mongo']?.reason },
    { label: 'Internet', value: ws.internetOk ? 'Online' : 'Offline', tone: ws.internetOk ? 'success' : 'danger', hint: st['system.internet']?.reason },
    { label: 'Pipeline', value: pipelineLive ? 'Running' : 'Stopped', tone: pipelineLive ? 'success' : marketClosed ? 'info' : 'warning', hint: currentReason },
  ];

  const qualityDims = [
    { label: 'Duplicate rate', value: qual.duplicateRate != null ? `${qual.duplicateRate.toFixed(2)}%` : null, count: num(qual.duplicates), good: (qual.duplicateRate ?? 1) < 1 },
    { label: 'Out-of-order', value: qual.outOfOrderRate != null ? `${qual.outOfOrderRate.toFixed(2)}%` : null, count: num(qual.outOfOrder), good: (qual.outOfOrderRate ?? 1) < 0.5 },
    { label: 'Timestamp errors', value: fmtNum(num(qual.timestampErrors)), good: (num(qual.timestampErrors) ?? 1) === 0 },
    { label: 'Schema errors', value: fmtNum(num(qual.schemaErrors)), good: (num(qual.schemaErrors) ?? 1) === 0 },
    { label: 'Invalid LTP', value: fmtNum(num(qual.invalidLtp)), good: (num(qual.invalidLtp) ?? 1) === 0 },
    { label: 'Save failures', value: qual.saveFailureRate != null ? `${qual.saveFailureRate.toFixed(2)}%` : fmtNum(num(qual.saveFailures)), good: (num(qual.saveFailures) ?? 1) === 0 },
    { label: 'Gaps / missing', value: fmtNum(num(qual.missing)), good: (num(qual.missing) ?? 1) === 0 },
  ];

  const storageCategories = [
    { label: 'Raw ticks', value: stor.rawData, color: 'from-orange-400 to-amber-300', dot: 'bg-orange-400', tip: 'ticks collection on-disk size (MongoDB)' },
    { label: 'Metadata', value: stor.metadata, color: 'from-blue-400 to-sky-300', dot: 'bg-blue-400', tip: 'all non-ticks collections on disk' },
    { label: 'Indexes', value: stor.indexBytes, color: 'from-violet-400 to-purple-300', dot: 'bg-violet-400', tip: 'real index sizes across collections' },
  ];

  const quickLinks = [
    { href: '/data-saver/subscription', icon: Radio, title: 'Subscriptions', desc: 'Active instruments', accent: 'amber' },
    { href: '/data-saver/ticks', icon: Activity, title: 'Tick Browser', desc: 'Inspect captured ticks', accent: 'teal' },
    { href: '/data-saver/quality', icon: Shield, title: 'Data Quality', desc: 'Score & breaches', accent: 'emerald' },
    { href: '/data-saver/websocket', icon: Wifi, title: 'WebSocket', desc: 'Lifecycle & latency', accent: 'sky' },
    { href: '/data-saver/schedules', icon: CalendarClock, title: 'Schedules', desc: 'Windows & lifecycle', accent: 'violet' },
    { href: '/data-saver/downloads', icon: Download, title: 'Downloads', desc: 'Export & delivery', accent: 'rose' },
    { href: '/data-saver/insights', icon: Layers, title: 'Insights', desc: 'Events & reports', accent: 'slate' },
    { href: '/data-saver/settings', icon: ListChecks, title: 'Settings', desc: 'PWA, storage, theme', accent: 'amber' },
  ];

  /* ---------------- transport badges ---------------- */
  const transportPill = fetchError
    ? { cls: TONE_PILL.danger as string, text: 'Offline — both lanes failed', dot: 'danger' as Tone, live: false }
    : transport === 'live'
      ? { cls: TONE_PILL.success as string, text: `WS push · ${timeAgo(updatedAt, now)}`, dot: 'success' as Tone, live: true }
      : liveUpdatedAt
        ? { cls: TONE_PILL.info as string, text: `WS stalled · REST fallback`, dot: 'info' as Tone, live: false }
        : { cls: TONE_PILL.neutral as string, text: `REST poll · ${timeAgo(updatedAt, now)}`, dot: 'neutral' as Tone, live: true };

  const schedRemaining = sched.remainingSeconds != null ? Math.max(0, sched.remainingSeconds - 0) : null;

  return (
    <div className="relative min-h-full">
      <Aurora />

      <div className="relative z-10 space-y-4 pb-10">

        {/* ══════════════ HERO ══════════════ */}
        <header className="ds-card relative overflow-hidden rounded-3xl border border-border/50 bg-card/70 p-4 shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.05),0_24px_60px_-32px_hsl(var(--foreground)/0.25)] backdrop-blur-2xl sm:p-5">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="ds-drift-a absolute -left-24 -top-28 h-80 w-80 rounded-full bg-primary/12 blur-[90px]" />
            <div className="ds-drift-b absolute -bottom-32 right-0 h-80 w-80 rounded-full bg-info/10 blur-[90px]" />
            <div className="ds-drift-c absolute right-1/3 -top-16 h-56 w-56 rounded-full bg-purple/10 blur-[70px]" />
          </div>

          <div className="relative flex flex-wrap items-start justify-between gap-5">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-400 via-emerald-500 to-sky-500 shadow-lg shadow-emerald-500/25">
                  <Activity className="h-5 w-5 text-white" />
                  {pipelineLive && <span className="ds-breathe absolute -inset-0.5 -z-10 rounded-2xl bg-emerald-400/25" />}
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold leading-tight tracking-[-0.02em]">Data Saver</h1>
                  <p className="text-[11px] text-muted-foreground">Collection · storage · pipeline · scheduler</p>
                </div>
              </div>

              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold', transportPill.cls)}>
                  <PulseDot tone={transportPill.dot} live={transportPill.live} />
                  {transportPill.text}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground backdrop-blur">
                  <Clock className="h-3 w-3" /> {liveClock} IST
                </span>
                <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                  marketOpen ? TONE_PILL.success : marketClosed ? TONE_PILL.neutral : TONE_PILL.warning)}>
                  {marketOpen ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {String(sched.marketState ?? sched.marketStatus ?? 'UNKNOWN').replace(/_/g, ' ')}
                </span>
                {schedRemaining != null && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-primary">
                    <Timer className="h-3 w-3" /> {fmtCountdown(schedRemaining)}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <InstallAppButton />
                  <Button size="sm"
                    variant="ghost"
                    onClick={() => setPaused(!paused)}
                    aria-label={paused ? 'Resume live updates' : 'Pause live updates'}
                    className="rounded-full">
                    {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={refresh} aria-label="Force refresh" disabled={loading}
                    className="rounded-full transition-transform duration-300 hover:scale-105">
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  </Button>
                </span>
              </div>

              <p className="mt-3 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
                <span className="font-semibold text-foreground/80">Current reason · </span>{currentReason}
              </p>
            </div>

            {/* Hero KPIs */}
            <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto sm:grid-cols-4 lg:w-[420px]">
              {[
                { label: 'Ticks today', value: fmtNum(ticksToday), accent: 'teal' },
                { label: 'Ticks / sec', value: pipelineLive ? fmtNum(num(pipe.ticksPerSec)) : DASH, accent: 'sky' },
                { label: 'Storage', value: storageUsedPct != null ? `${storageUsedPct.toFixed(0)}%` : DASH, accent: 'violet' },
                { label: 'WS uptime', value: wsUptimeSec != null ? fmtUptime(wsUptimeSec) : DASH, accent: 'amber' },
              ].map((h, i) => {
                const a = ACCENT[h.accent];
                return (
                  <div key={h.label} style={{ '--ds-i': i } as React.CSSProperties}
                    className="ds-rise ds-lift rounded-2xl border border-border/40 bg-background/50 px-3 py-2.5 backdrop-blur">
                    <p className={cn('text-lg font-semibold leading-none tabular-nums tracking-tight', a.text)}>{h.value}</p>
                    <p className="mt-1.5 truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">{h.label}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </header>

        {fetchError && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-2.5 text-xs text-destructive backdrop-blur-xl">
            <AlertCircle className="h-4 w-4" />
            <span className="font-semibold">Dashboard data temporarily unavailable.</span>
            <span className="text-destructive/80">{errorReason ? `Reason: ${errorReason}` : 'Backend unreachable.'}</span>
            <span className="tabular-nums text-destructive/70">Last good: {updatedAt ? fmtTs(updatedAt) : 'none yet'}</span>
            {consecutiveFailures > 1 && <span className="text-destructive/70">Retry {consecutiveFailures}… auto-retrying.</span>}
            <button type="button" onClick={refresh}
              className="ml-auto inline-flex items-center gap-1 rounded-full border border-destructive/30 px-2.5 py-0.5 font-semibold transition hover:bg-destructive/10">
              <RefreshCw className="h-3 w-3" /> Retry now
            </button>
          </div>
        )}

        {/* ══════════════ LIVE STATUS STRIP ══════════════ */}
        <section aria-label="System status" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {chips.map((c, i) => (
            <div key={c.label} title={c.hint} style={{ '--ds-i': i } as React.CSSProperties}
              className="ds-rise ds-lift flex items-center gap-2.5 rounded-2xl border border-border/40 bg-card/65 px-3 py-2.5 backdrop-blur-xl">
              <PulseDot tone={c.tone} live={c.tone === 'success'} />
              <div className="min-w-0 leading-tight">
                <p className="truncate text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">{c.label}</p>
                <p className={cn('truncate text-[11px] font-semibold', TONE_TEXT[c.tone])}>{c.value}</p>
              </div>
            </div>
          ))}
        </section>

        {/* ══════════════ KPI GRID ══════════════ */}
        <section aria-label="Overview">
          <SectionHeading>Overview</SectionHeading>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {kpis.map((k, i) => {
              const a = ACCENT[k.accent] ?? ACCENT.slate;
              return (
                <Link key={k.title} href={k.href} className="block h-full" style={{ '--ds-i': i } as React.CSSProperties}>
                  <SoftCard accent={k.accent} index={i} className="h-full p-4">
                    <div className="flex items-start justify-between gap-2">
                      <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md transition-transform duration-300 group-hover:scale-110', a.chip)}>
                        <k.icon className="h-4 w-4" />
                      </span>
                      <span className={cn('rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em]', TONE_PILL[k.tone])}>
                        {k.tone === 'success' ? 'OK' : k.tone === 'warning' ? 'WARN' : k.tone === 'danger' ? 'ERR' : 'IDLE'}
                      </span>
                    </div>
                    <p className="mt-3 text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{k.value}</p>
                    <p className="mt-1.5 truncate text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{k.title}</p>
                    <p className="mt-1.5 line-clamp-2 min-h-[2.1rem] text-[10px] leading-relaxed text-muted-foreground/85">{k.sub}</p>
                    <p className="mt-2 flex items-center gap-1 text-[9px] text-muted-foreground/60">
                      {timeAgo(updatedAt, now)}
                      <ArrowRight className="h-2.5 w-2.5 -translate-x-1 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
                    </p>
                  </SoftCard>
                </Link>
              );
            })}
          </div>
        </section>

        {/* ══════════════ LIVE FLOW ══════════════ */}
        <DashboardFlow />

        {/* ══════════════ SCHEDULER ══════════════ */}
        <SoftCard accent="amber" className="p-4 sm:p-5" index={0}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-md">
                <Cpu className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold tracking-tight">Scheduler</h2>
                <p className="text-[10px] text-muted-foreground">
                  {happenedCount}/{lifecycle.length} steps recorded today
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={sched.running ? 'success' : 'danger'} label={sched.running ? 'Running' : 'Stopped'} />
              <Link href="/data-saver/schedules" className="text-[10px] text-muted-foreground transition-colors hover:text-foreground">Schedules</Link>
            </div>
          </div>

          {!sched.state ? (
            <div className="mt-4"><EmptyState icon={Cpu} title="Scheduler unavailable" description="No scheduler state reported by the backend" /></div>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <Stat label="State" value={String(sched.state ?? DASH)} />
                <Stat label="Market" value={sched.marketStatus ?? DASH} tone={marketOpen ? 'success' : 'neutral'} />
                <Stat label="Trading day" value={sched.isTradingDay ? 'Yes' : 'No'} tone={sched.isTradingDay ? 'success' : 'neutral'} />
              </div>

              <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-3">

                {/* WHAT HAPPENED */}
                <div className="lg:col-span-1">
                  <SubHeading icon={History} right={
                    <span className={cn('rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]',
                      sched.isTradingDay ? TONE_PILL.success : TONE_PILL.neutral)}>
                      {sched.isTradingDay ? `Today ${sched.marketDate ? `· ${String(sched.marketDate).slice(0, 10)}` : ''}`
                        : sched.nextMarketOpen ? `Next · ${String(sched.nextMarketOpen).slice(0, 10)}` : 'Closed'}
                    </span>
                  }>What happened</SubHeading>

                  {sess.active === true && String(sess.loginSource ?? '').toUpperCase() === 'MANUAL' && (
                    <div className="mb-2 rounded-xl border border-info/25 bg-info/10 px-2.5 py-2">
                      <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-info">
                        <PulseDot tone="info" live /> Manual login · active session
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-info/80">
                        Logged in {sess.lastLoginAt ? fmtTs(sess.lastLoginAt) : DASH} IST. Disappears automatically when the session ends.
                      </p>
                    </div>
                  )}

                  <ol className="relative space-y-2">
                    {lifecycle.map((l, i) => (
                      <li key={`${l.key}-${i}`} className="relative flex items-center gap-3" title={l.explanation ?? undefined}>
                        {i < lifecycle.length - 1 && <span aria-hidden className="absolute left-[7px] top-5 h-[calc(100%+0.5rem)] w-px bg-border/60" />}
                        <PulseDot tone={l.status} live={l.status === 'info'} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[11px] font-medium capitalize">{l.label}</span>
                            {l.source && (
                              <span className="shrink-0 rounded bg-muted px-1 text-[8px] font-bold uppercase tracking-wide text-muted-foreground/70">
                                {l.source}
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-[9px] tabular-nums text-muted-foreground/70">
                            {l.at
                              ? <>{fmtTs(l.at)} <span className="text-muted-foreground/50">({timeAgo(l.at, now)})</span></>
                              : l.scheduled
                                ? <span className="text-muted-foreground/60">scheduled {fmtTs(l.scheduled)} · {l.statusLabel}</span>
                                : <>no scheduled time today</>}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>

                  <div className="mt-3 rounded-xl border border-border/40 bg-background/40 px-2.5 py-2">
                    <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Windows</p>
                    <DetailRow label="Login" value={`${sched.loginTime ?? DASH} – ${sched.logoutTime ?? DASH}`} />
                    <DetailRow label="WebSocket" value={`${sched.wsStartTime ?? DASH} – ${sched.wsStopTime ?? DASH}`} />
                    <DetailRow label="Tick collection" value={sched.tickCollectionTime ?? DASH} />
                  </div>
                </div>

                {/* HOW MANY */}
                <div className="lg:col-span-1">
                  <SubHeading icon={ListChecks} right={
                    ledger.timezone ? <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{ledger.timezone}</span> : undefined
                  }>How many</SubHeading>

                  {num(ledger.totalRuns) != null && num(ledger.totalRuns)! > 0 ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        {runCounts.map((r) => (
                          <div key={r.label} className="rounded-xl border border-border/40 bg-background/40 px-2.5 py-2 transition-colors hover:border-border/70">
                            <p className="truncate text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">{r.label}</p>
                            <p className={cn('mt-0.5 text-base font-semibold leading-5 tabular-nums', TONE_TEXT[r.tone])}>{fmtNum(r.value)}</p>
                          </div>
                        ))}
                      </div>

                      {ledgerJobsToday && Object.keys(ledgerJobsToday).length > 0 && (
                        <div className="mt-2.5">
                          <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Jobs today</p>
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(ledgerJobsToday).map(([job, status]) => (
                              <StatusBadge key={job} status={ledgerTone(String(status))}
                                label={`${String(job).replace(/_/g, ' ')} · ${String(status ?? '').replace(/_/g, ' ')}`} />
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mt-2.5 rounded-xl border border-border/40 bg-background/40 px-2.5 py-1.5">
                        <DetailRow label="Last successful" value={fmtTs(ledger.lastSuccessfulRun)} />
                        <DetailRow label="Last failed" value={fmtTs(ledger.lastFailedRun)} />
                        <DetailRow label="Last network wait" value={fmtTs(ledger.lastWaitingNetworkRun)} />
                      </div>
                    </>
                  ) : (
                    <p className="rounded-xl border border-dashed border-border/50 px-3 py-6 text-center text-[11px] text-muted-foreground">
                      No persisted runs recorded for today yet.
                    </p>
                  )}
                </div>

                {/* WHAT'S NEXT */}
                <div className="lg:col-span-1">
                  <SubHeading icon={CalendarClock} right={
                    schedRemaining != null
                      ? <span className="rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-primary">
                          {fmtCountdown(schedRemaining)}
                        </span>
                      : undefined
                  }>What&apos;s next</SubHeading>

                  {upcoming.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border/50 px-3 py-6 text-center text-[11px] text-muted-foreground">
                      No upcoming scheduler events reported.
                    </p>
                  ) : (
                    <ol className="space-y-2">
                      {upcoming.map((u, i) => {
                        const inSec = secondsUntil(u.at, now);
                        const isNext = String(sched.nextEvent ?? '') !== '' && i === 0;
                        return (
                          <li key={u.key} className="flex items-center gap-3 rounded-xl border border-border/40 bg-background/40 px-2.5 py-2 transition-colors hover:border-border/70">
                            <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                              isNext ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground')}>
                              <Clock className="h-3.5 w-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[11px] font-medium">{u.label}</span>
                                {isNext && <span className="shrink-0 rounded bg-primary/15 px-1 text-[8px] font-bold uppercase text-primary">next</span>}
                              </span>
                              <span className="block text-[9px] tabular-nums text-muted-foreground/80">{fmtTs(u.at)}</span>
                            </span>
                            <span className={cn('shrink-0 text-[11px] font-semibold tabular-nums',
                              inSec == null ? 'text-muted-foreground/50' : isNext ? 'text-primary' : 'text-muted-foreground')}>
                              {inSec == null ? DASH : fmtCountdown(inSec)}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  )}

                  <div className="mt-2.5 rounded-xl border border-border/40 bg-background/40 px-2.5 py-1.5">
                    <DetailRow label="State since" value={fmtTs(sched.stateSince)} />
                    <DetailRow label="Session owner" value={sched.sessionOwner ? String(sched.sessionOwner).toUpperCase() : 'None'} mono={false} />
                  </div>

                  {sched.loginError && <p className="mt-2 rounded-xl border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-[10px] text-warning">Login error: {sched.loginError}</p>}
                  {sched.wsError && <p className="mt-2 rounded-xl border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-[10px] text-warning">WebSocket error: {sched.wsError}</p>}
                </div>
              </div>
            </>
          )}
        </SoftCard>

        {/* ══════════════ SESSION + PIPELINE ══════════════ */}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">

          <SoftCard accent="emerald" className="p-4 sm:p-5" index={1}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-md">
                  <Shield className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Session</h2>
                  <p className="text-[10px] text-muted-foreground">Broker login state &amp; expiry</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {sess.loginSource && (
                  <span className={cn('rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]',
                    String(sess.loginSource).toUpperCase() === 'MANUAL' ? TONE_PILL.info : TONE_PILL.neutral)}>
                    {String(sess.loginSource).toUpperCase()}
                  </span>
                )}
                <StatusBadge status={sess.active ? 'success' : 'info'} label={sess.active ? 'Active' : 'Inactive'} />
                <Link href="/data-saver/configuration" className="text-[10px] text-muted-foreground transition-colors hover:text-foreground">Configuration</Link>
              </div>
            </div>

            {!sess.state && !sess.active ? (
              <div className="mt-4"><EmptyState icon={Shield} title="Session unavailable" description="No session state reported by the backend" /></div>
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[auto_1fr]">
                <div className="flex items-center gap-4 rounded-2xl border border-border/40 bg-background/40 p-4">
                  <div className={cn('relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full',
                    sess.active ? 'bg-success/12 ring-1 ring-success/25' : 'bg-muted/40 ring-1 ring-border/60')}>
                    {sess.active && <span className="absolute inset-0 rounded-full bg-success/20 ds-breathe" />}
                    <div className="relative text-center">
                      <p className={cn('text-base font-semibold leading-none tracking-tight tabular-nums',
                        sess.active && typeof sess.remainingSeconds === 'number' ? 'text-success' : 'text-muted-foreground')}>
                        {sess.active && typeof sess.remainingSeconds === 'number' ? fmtCountdown(sess.remainingSeconds) : DASH}
                      </p>
                      <p className="mt-1 text-[8px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                        {sess.active ? 'expires in' : 'inactive'}
                      </p>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground/80">Status</p>
                    <p className="mt-0.5 truncate text-lg font-semibold tracking-tight">
                      {sess.state ? String(sess.state).toUpperCase() : sess.active ? 'SESSION ACTIVE' : 'SESSION INACTIVE'}
                    </p>
                    <p className="mt-1.5 truncate text-[10px] text-muted-foreground">
                      {sess.user ? <>User <span className="font-mono">{sess.user}</span></> : 'No display-safe user identifier reported'}
                    </p>
                    {sess.lastLoginAt && (
                      <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                        Since {fmtTs(sess.lastLoginAt)} · <span className="text-muted-foreground/70">{timeAgo(sess.lastLoginAt, now)}</span>
                      </p>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                  <div>
                    <DetailRow label="Login time" value={sess.lastLoginAt ? fmtTs(sess.lastLoginAt) : <span className="text-muted-foreground">No login recorded</span>} />
                    <DetailRow label="Validated at" value={sess.validatedAt ? fmtTs(sess.validatedAt) : <span className="text-muted-foreground">Not validated</span>} />
                    <DetailRow label="Expires at" value={sess.expiresAt ? fmtTs(sess.expiresAt) : <span className="text-muted-foreground">Until scheduled logout</span>}
                      valueClass={sess.active ? 'text-warning' : undefined} />
                    <DetailRow label="Duration" value={sess.sessionDurationSeconds != null ? fmtUptime(sess.sessionDurationSeconds) : <span className="text-muted-foreground">Until scheduled logout</span>} />
                  </div>
                  <div>
                    <DetailRow label="Login count" value={sess.loginCount != null ? fmtNum(num(sess.loginCount)) : <span className="text-muted-foreground">Not recorded</span>} />
                    <DetailRow label="Broker feed" value={sess.wsState ? String(sess.wsState).toUpperCase() : <span className="text-muted-foreground">Feed not connected</span>} />
                    <DetailRow label="Last logout" value={sess.lastLogoutAt ? fmtTs(sess.lastLogoutAt) : <span className="text-muted-foreground">No logout recorded</span>} />
                    <DetailRow label="Logout reason" value={sess.lastLogoutReason
                      ? <span className="font-medium">{String(sess.lastLogoutReason).replace(/_/g, ' ')}</span>
                      : sess.active ? <span className="text-muted-foreground">N/A — session active</span>
                        : <span className="text-muted-foreground">No logout recorded</span>} />
                  </div>

                  {!sess.active && (
                    <p className="col-span-full rounded-xl border border-border/40 bg-background/40 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
                      {st['session.status']?.reason ?? (sched.marketReasonMessage ?? 'No active broker session.')}
                    </p>
                  )}
                  {sess.lastLoginError && (
                    <p className="col-span-full rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
                      Login error: {sess.lastLoginError}
                    </p>
                  )}
                </div>
              </div>
            )}
          </SoftCard>

          <SoftCard accent={pipelineLive ? 'teal' : 'slate'} className="p-4 sm:p-5" index={2}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md',
                  pipelineLive ? 'from-teal-400 to-emerald-500' : 'from-slate-400 to-slate-500')}>
                  {pipelineLive ? <Activity className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
                </span>
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Tick Pipeline</h2>
                  <p className="max-w-xs truncate text-[10px] text-muted-foreground sm:max-w-md">{currentReason}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={pipelineLive ? 'success' : marketClosed ? 'info' : 'warning'} label={pipelineLive ? 'RUNNING' : 'STOPPED'} />
                <Link href="/data-saver/websocket" className="text-[10px] text-muted-foreground transition-colors hover:text-foreground">WebSocket</Link>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat label="Ticks received" value={fmtNum(num(pipe.totalReceived))} tone="info" hint="since process start" />
              <Stat label="Saved" value={fmtNum(num(pipe.totalWrites))} tone="success"
                hint={pipe.savedPerSec != null && pipelineLive ? `${fmtNum(num(pipe.savedPerSec))}/s now` : 'persisted to MongoDB'} />
              <Stat label="Failed" value={fmtNum(num(pipe.failed))} tone={num(pipe.failed) ? 'danger' : 'success'}
                hint={pipe.failed == null ? 'not measured' : num(pipe.failed) ? 'write failures recorded' : 'no write failures'} />
              <Stat label="Buffer pending" value={fmtNum(num(pipe.bufferLength))} hint="in-memory queue" />
            </div>

            <div className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              <DetailRow label="Save success rate" value={d.saveSuccessRate != null ? `${d.saveSuccessRate.toFixed(2)}%` : DASH}
                valueClass={d.saveSuccessRate == null ? undefined : d.saveSuccessRate >= 99 ? 'text-success' : 'text-warning'} />
              <DetailRow label="Feed latency" value={ws.latencyMs != null ? `${Math.round(num(ws.latencyMs)!)}ms` : DASH}
                hint={ws.latencyMs != null ? 'Exchange → backend measured latency' : 'Measured only while ticks flow'} />
            </div>

            <div className="mt-3 rounded-xl border border-border/40 bg-background/40 px-3 py-2.5">
              <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Lifecycle timeline</p>
              {[
                { label: 'Started', time: pipe.startedAt ?? str(st['pipeline.started']?.value), tone: 'text-info', live: false },
                { label: 'Last tick', time: pipe.lastTickAt, tone: 'text-foreground', live: pipelineLive },
                { label: 'Last save', time: pipe.lastSavedAt, tone: 'text-success', live: false },
                { label: 'Last failed write', time: pipe.lastFailedWriteAt, tone: 'text-destructive', live: false },
                { label: pipelineLive ? 'Still running' : 'Stopped / offline since', time: pipelineLive ? null : (str(st['pipeline.state']?.lastUpdated) ?? pipe.offlineSince ?? pipe.stoppedAt), tone: 'text-warning', live: !pipelineLive },
              ].map((row, i, arr) => (
                <div key={row.label} className="relative flex items-baseline gap-3 py-[3px]">
                  {i < arr.length - 1 && <span aria-hidden className="absolute left-[3px] top-4 h-full w-px bg-border/60" />}
                  <span className="relative z-10 bg-background px-[3px]">
                    <PulseDot tone={row.live ? (pipelineLive ? 'success' : 'warning') : 'neutral'} live={row.live} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{row.label}</span>
                  <span className={cn('shrink-0 text-[11px] font-medium tabular-nums', row.time ? row.tone : 'text-muted-foreground/50')}>
                    {row.time ? fmtTs(row.time) : (pipelineLive && row.label === 'Still running' ? 'connected now' : 'not yet recorded')}
                  </span>
                </div>
              ))}
            </div>

            {!pipelineLive && <p className="mt-2.5 text-[10px] text-muted-foreground">Rate metrics are not measured while the stream is stopped — no ticks are entering the pipeline.</p>}
          </SoftCard>
        </div>

        {/* ══════════════ STORAGE + QUALITY ══════════════ */}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">

          <SoftCard accent="violet" className="p-4 sm:p-5" index={0}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 to-purple-500 text-white shadow-md">
                  <HardDrive className="h-4 w-4" />
                </span>
                <h2 className="text-sm font-semibold tracking-tight">Storage</h2>
              </div>
              <StatusBadge status={storageUsedPct == null ? 'neutral' : storageUsedPct >= 90 ? 'warning' : 'success'}
                label={storageUsedPct == null ? 'NOT MEASURED' : `${storageUsedPct.toFixed(1)}% USED`} />
            </div>

            <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
              <Ring pct={storageUsedPct} label="used" size={132} colors={['#a78bfa', '#e2e8f0']}
                tone={storageUsedPct == null ? undefined : storageUsedPct >= 90 ? 'bad' : storageUsedPct >= 75 ? 'warn' : 'ok'}
                sub={stor.used != null ? fmtBytes(stor.used) : undefined} />
              <div className="grid w-full grid-cols-3 gap-2">
                <Stat label="Capacity" value={fmtBytes(stor.capacity)} />
                <Stat label="Used" value={fmtBytes(stor.used)} />
                <Stat label="Free" value={fmtBytes(stor.free)} tone="info" />
              </div>
            </div>

            <div className="mt-5">
              <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Categories</p>
              <div className="space-y-2.5">
                {storageCategories.map((cat) => (
                  <div key={cat.label} title={cat.tip} className="flex items-center gap-2.5">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', cat.dot)} />
                    <span className="w-[104px] shrink-0 truncate text-[11px] text-muted-foreground">{cat.label}</span>
                    {cat.value != null ? (
                      <>
                        <span className="w-16 shrink-0 text-right text-[11px] font-semibold tabular-nums">{fmtBytes(cat.value)}</span>
                        <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/60">
                          {stor.capacity != null && stor.capacity > 0 && (
                            <span className={cn('block h-full rounded-full bg-gradient-to-r transition-all duration-700', cat.color)}
                              style={{ width: `${Math.min(((cat.value ?? 0) / (stor.capacity ?? 1)) * 100, 100)}%` }} />
                          )}
                        </span>
                      </>
                    ) : (
                      <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">Not measured</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/75">
                {stor.rawData != null && stor.dbBytes != null
                  ? 'Category sizes are real MongoDB per-collection bytes; on-disk directories are measured on this machine.'
                  : 'Category sizes come from MongoDB per-collection stats when the database is reachable.'}
              </p>
            </div>

            <div className="mt-4 rounded-xl border border-border/40 bg-background/40 px-3 py-2">
              <p className="mb-1 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">
                <Server className="h-3 w-3" /> Database
              </p>
              <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                <DetailRow label="Engine" value="MongoDB" mono={false} />
                <DetailRow label="Database" value={mongo.dbName ? <span className="font-mono">{mongo.dbName}</span> : DASH} />
                <DetailRow label="Collections" value={fmtNum(num(mongo.collections?.length))} />
                <DetailRow label="Documents" value={fmtNum(num(mongo.totalObjects))} />
                <DetailRow label="On-disk total" value={fmtBytes(stor.dbBytes)} />
                <DetailRow label="Ping" value={mongo.pingMs != null ? `${num(mongo.pingMs)!.toFixed(1)}ms` : DASH} />
                <DetailRow label="Status" value={mongo.connected ? 'Connected' : 'Disconnected'} mono={false}
                  valueClass={mongo.connected ? 'text-success' : 'text-destructive'} />
                <DetailRow label="Measured" value={updatedAt ? <>{fmtTs(updatedAt)} <span className="text-muted-foreground/70">({timeAgo(updatedAt, now)})</span></> : <span className="text-muted-foreground">Not yet</span>} />
              </div>
            </div>
          </SoftCard>

          <SoftCard accent="emerald" className="p-4 sm:p-5" index={1}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-md">
                  <Shield className="h-4 w-4" />
                </span>
                <h2 className="text-sm font-semibold tracking-tight">Data Quality</h2>
              </div>
              <Link href="/data-saver/quality" className="text-[10px] text-muted-foreground transition-colors hover:text-foreground">Quality Report</Link>
            </div>

            <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
              <Ring pct={qualityScore} label="score" size={132} colors={['#34d399', '#e2e8f0']}
                tone={qualityScore == null ? undefined : qualityScore >= 90 ? 'ok' : qualityScore >= 80 ? 'warn' : 'bad'}
                sub={qual.total != null ? `${fmtNum(num(qual.total))} ticks` : undefined} />
              <div className="w-full space-y-1.5">
                {qualityDims.map((q) => (
                  <div key={q.label} className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5 transition-colors hover:border-border/70">
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">{q.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {q.count != null && <span className="text-[10px] tabular-nums text-muted-foreground/70">{fmtNum(q.count)}</span>}
                      <span className={cn('w-14 text-right text-[11px] font-semibold tabular-nums',
                        q.value == null ? 'text-muted-foreground' : q.good ? 'text-success' : 'text-destructive')}>
                        {q.value ?? DASH}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <details className="group mt-3 rounded-xl border border-border/40 bg-background/40 px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">
                <Sparkles className="h-3 w-3" /> Scoring formula
                <span className="ml-auto text-[9px] font-normal normal-case tracking-normal group-open:hidden">click to expand</span>
              </summary>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/85">
                {d.qualityScoreFormula ?? 'Score derived from real quality metrics; never fabricated.'}
              </p>
            </details>

            <div className="mt-3">
              <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Dimension breakdown</p>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                {['Validity', 'Completeness', 'Consistency', 'Ordering', 'Persistence'].map((dim) => (
                  <div key={dim} className="rounded-lg border border-dashed border-border/50 px-2 py-1.5 text-center">
                    <p className="truncate text-[10px] font-medium text-muted-foreground">{dim}</p>
                    <p className="text-[9px] text-muted-foreground/60">Not measured</p>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/75">
                Per-dimension sub-scores are not produced by the backend. Only measured metrics are shown — nothing is estimated.
              </p>
            </div>
          </SoftCard>
        </div>

        {/* ══════════════ ALERTS + EVENTS ══════════════ */}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">

          <SoftCard accent={alerts.length ? 'rose' : 'emerald'} className="p-4 sm:p-5" index={0}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md',
                  alerts.length ? 'from-rose-400 to-pink-500' : 'from-emerald-400 to-teal-500')}>
                  <AlertCircle className="h-4 w-4" />
                </span>
                <h2 className="text-sm font-semibold tracking-tight">Active Alerts</h2>
                {alerts.length > 0 && <span className="rounded-full bg-destructive/12 px-2 py-0.5 text-[10px] font-bold text-destructive">{alerts.length}</span>}
              </div>
              <Link href="/data-saver/alerts" className="text-[10px] text-muted-foreground transition-colors hover:text-foreground">Alert Center</Link>
            </div>

            {alerts.length === 0 ? (
              <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-success/25 bg-success/8 px-3.5 py-3 text-[11px] text-success">
                <CheckCircle2 className="h-4 w-4" />
                No active alerts — all monitored conditions are within thresholds.
              </div>
            ) : (
              <ul className="mt-4 max-h-[320px] space-y-2 overflow-auto pr-1">
                {alerts.map((a) => (
                  <li key={a.id}>
                    <Link href="/data-saver/alerts" className="block">
                      <div className="rounded-xl border border-border/40 bg-background/40 px-3 py-2.5 transition-all duration-300 hover:-translate-y-0.5 hover:border-border hover:shadow-md">
                        <div className="flex items-start gap-2.5">
                          <StatusBadge status={a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warning' : 'info'} label={String(a.severity ?? 'info')} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12px] font-semibold">{a.title ?? a.message}</p>
                            {a.reason && <p className="mt-0.5 text-[10px] text-muted-foreground">Reason: <span className="text-foreground/80">{String(a.reason).replace(/_/g, ' ')}</span></p>}
                            {a.detail && <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground/85">{a.detail}</p>}
                            <p className="mt-0.5 text-[9px] tabular-nums text-muted-foreground">
                              Created {fmtTs(a.created_at)}{a.status ? <span className="ml-1.5 font-bold uppercase text-warning">{a.status}</span> : null}
                            </p>
                          </div>
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SoftCard>

          <SoftCard accent="slate" className="p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-slate-400 to-slate-500 text-white shadow-md">
                  <Clock className="h-4 w-4" />
                </span>
                <h2 className="text-sm font-semibold tracking-tight">Recent Events</h2>
              </div>
              <Link href="/data-saver/insights" className="text-[10px] text-muted-foreground transition-colors hover:text-foreground">View all</Link>
            </div>

            {filteredEvents.length === 0 ? (
              <div className="mt-4">
                <EmptyState icon={Clock} title="No events recorded" description="Lifecycle events appear here as the backend records them (restart-safe audit trail)" />
              </div>
            ) : (
              <ul className="mt-4 max-h-[320px] space-y-1.5 overflow-auto pr-1">
                {filteredEvents.slice(0, 14).map((e, i) => (
                  <li key={`${e.eventId ?? ''}-${i}`}
                    className="flex items-start gap-2.5 rounded-lg border border-border/30 bg-background/30 px-2.5 py-1.5 transition-colors hover:border-border/60 hover:bg-background/50">
                    <PulseDot tone={eventTone(e.severity ?? e.status)} live={eventTone(e.severity ?? e.status) === 'danger'} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-[11px] font-semibold">
                        {String(e.event ?? 'unknown').replace(/_/g, ' ')}
                        {e.source && <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[8px] uppercase tracking-wide text-muted-foreground/70">{e.source}</span>}
                      </p>
                      {e.message && <p className="truncate text-[10px] text-muted-foreground">{e.message}</p>}
                      {e.reason && <p className="truncate text-[9px] text-muted-foreground/70">reason: {String(e.reason).replace(/_/g, ' ')}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      <StatusBadge status={eventTone(e.severity ?? e.status)} label={String(e.status ?? e.severity ?? 'info').replace(/_/g, ' ')} />
                      <span className="text-[9px] tabular-nums text-muted-foreground">{fmtTs(e.ts)}</span>
                      {e.resolvedAt && <span className="text-[9px] text-success">resolved {fmtTs(e.resolvedAt)}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {alertEvents.length > 0 && (
              <p className="mt-2.5 text-[10px] text-muted-foreground">{alertEvents.length} alert lifecycle event(s) recorded — see Alert Center for the full trail.</p>
            )}
          </SoftCard>
        </div>

        {/* ══════════════ QUICK LINKS ══════════════ */}
        <section aria-label="Quick links">
          <SectionHeading>Quick Insights</SectionHeading>
          <div className="mt-2 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {quickLinks.map((q, i) => {
              const a = ACCENT[q.accent] ?? ACCENT.slate;
              return (
                <Link key={q.href} href={q.href} style={{ '--ds-i': i } as React.CSSProperties}
                  className="group relative flex items-start gap-2.5 overflow-hidden rounded-2xl border border-border/40 bg-card/65 p-3.5 backdrop-blur-xl ds-rise ds-lift">
                  <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r opacity-50 transition-opacity duration-500 group-hover:opacity-100', a.rail)} />
                  <span className={cn('relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md transition-transform duration-300 group-hover:scale-110', a.chip)}>
                    <q.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className={cn('block text-[11px] font-semibold', a.text)}>{q.title}</span>
                    <span className="block text-[10px] leading-snug text-muted-foreground">{q.desc}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

        <TechDetails entries={techEntries} />

        <p className="pb-2 text-center text-[10px] text-muted-foreground/70">
          {transport === 'live'
            ? <>Live via WebSocket push (state + 6s telemetry) · full detail re-synced over REST every 25s</>
            : <>REST polling every 10s with exponential backoff · connect the WS gateway for instant pushes</>}
          {' · '}{String(socketState).toLowerCase()} socket
        </p>
      </div>

      {/* Floating live assistant — the chat sits above the page, above the
          bottom nav, and above any PWA prompt (never overlapping). */}
      <DashboardChat />
    </div>
  );
}

export default function Phase2DashboardPage() {
  return <DashboardView />;
}
