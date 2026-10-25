'use client';

/**
 * System Indicators — the project's observatory.
 *
 * Every subsystem this project has, on one screen: the Python/FastAPI
 * infrastructure, host resources, all 18 backend engines (each with the
 * metrics it really publishes), the tick persistence pipeline, the market-data
 * plane, broker/trading endpoints and the alerting plane.
 *
 * DATA HONESTY (unchanged and load-bearing): every value here comes live from
 * the backend. A metric the backend does not expose renders as an explicit
 * "n/a" — it is never estimated, defaulted to zero or filled in with a guess,
 * because on a health page a fabricated number is worse than a blank one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, AlertTriangle, BellRing, Blocks, Bot, Briefcase,
  CheckCircle2, Clock, Cpu, Database, Gauge, HardDrive, HeartPulse, KeyRound,
  Layers, LifeBuoy, MemoryStick, Radio, RefreshCw, ScrollText, Server,
  ShieldCheck, ShoppingCart, Signal, Target, Terminal, TrendingUp, Wallet,
  Wifi, Workflow, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  getSystemStatus, getMongoStats,
  getOrderBook, getFunds, getPositions, getHoldings,
} from '@/lib/api';
import { fmtBytes, fmtDateTime, fmtMs, fmtPct1, fmtQty, fmtUptime } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import type { EngineStatus } from '@/lib/system-engines';
import {
  AnimatedNumber, Gauge as Ring, LiveHalo, Meter, MetricChip, Panel, Pill,
  Readout, SectionHead, SplitBar, Trend, fmtMsSmart, loadAccent, skin, stagger,
  type Accent, type SysState,
} from './visuals';
import { EngineFleet, engineStateTone, fmtAgoSec, prettyState } from './fleet';

/* ------------------------------------------------------------------ */
/* Rolling history for the sparklines                                   */
/* ------------------------------------------------------------------ */

const SERIES_CAP = 40;

/**
 * Keep a short rolling window per metric key so every readout can show its own
 * trend. Only values that actually CHANGED are appended, so a stalled backend
 * draws a flat line rather than a fake mountain of repeats.
 */
function useRollingSeries(values: Record<string, number | null | undefined>, cap = SERIES_CAP) {
  const storeRef = useRef<Record<string, number[]>>({});
  const [, bump] = useState(0);

  // Serialising the current readings into a string gives the effect a stable,
  // primitive dependency — the object itself is a fresh literal every render.
  const signature = Object.entries(values)
    .map(([k, v]) => `${k}=${v == null || !Number.isFinite(v) ? '' : v}`)
    .join('&');

  useEffect(() => {
    let dirty = false;
    for (const [key, raw] of Object.entries(values)) {
      if (raw == null || !Number.isFinite(raw)) continue;
      const series = storeRef.current[key];
      if (series?.[series.length - 1] === raw) continue;
      storeRef.current[key] = [...(series ?? []), raw].slice(-cap);
      dirty = true;
    }
    if (dirty) bump((n) => n + 1);
    // `values` is a fresh object literal each render; `signature` is the real
    // dependency and always describes the same object this closure captured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, cap]);

  return storeRef.current;
}

/** Tracks seconds until the next automatic poll, for the refresh countdown. */
function useCountdown(target: number | null, intervalMs: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (target == null) return null;
  return Math.max(0, Math.ceil((target + intervalMs - now) / 1000));
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                          */
/* ------------------------------------------------------------------ */

const STATE_ACCENT_MAP: Record<SysState, Accent> = {
  ok: 'success',
  bad: 'danger',
  warn: 'warning',
  unknown: 'neutral',
};

/** Button that answers "is this state good?" without leaving a colour behind. */
function StateDot({ state, size = 7 }: { state: SysState; size?: number }) {
  return <LiveHalo accent={STATE_ACCENT_MAP[state]} size={size} live={state === 'ok' || state === 'warn'} />;
}

function N({ v }: { v: React.ReactNode }) {
  return <span className="font-sans font-normal text-muted-foreground">{v ?? 'n/a'}</span>;
}

/* ------------------------------------------------------------------ */
/* Live KPI tile                                                        */
/* ------------------------------------------------------------------ */

function KpiTile({
  icon: Icon,
  label,
  value,
  unit,
  accent,
  series,
  trendId,
  sub,
  caption,
  flashKey,
}: {
  icon: React.ElementType;
  label: string;
  value: number | null | undefined;
  unit?: string;
  accent: Accent;
  series?: number[];
  trendId?: string;
  sub?: string;
  caption?: string;
  flashKey?: string | number | null;
}) {
  const s = skin(accent);
  return (
    <Panel
      className={cn('group p-0', s.border)}
      style={{ backgroundImage: `linear-gradient(160deg, hsl(var(--${varOf(accent)}) / 0.13), transparent 62%)` }}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{ backgroundImage: `linear-gradient(90deg, hsl(var(--${varOf(accent)})), transparent 85%)` }}
      />
      <div className="relative flex items-start gap-1 p-3">
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1', s.chip)}>
          <Icon className="h-3.5 w-3.5" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="mt-0.5 flex items-baseline gap-1">
            <span
              key={flashKey}
              className="si-flash rounded font-mono text-lg font-bold leading-none tabular-nums"
              style={{ color: `hsl(var(--${varOf(accent)}))` }}
            >
              {value == null ? (
                <span className="text-sm text-muted-foreground">n/a</span>
              ) : (
                <AnimatedNumber value={value} format={(n) => Math.round(n).toLocaleString('en-IN')} />
              )}
            </span>
            {unit ? <span className="text-[10px] font-medium text-muted-foreground">{unit}</span> : null}
          </p>
          {sub ? <p className="mt-1 truncate text-[10px] text-muted-foreground/80">{sub}</p> : null}
        </div>

        {series && series.length > 0 && trendId ? (
          <Trend points={series} accent={accent} gradientId={trendId} width={64} height={26} />
        ) : null}
      </div>
      {caption ? (
        <p className="relative border-t border-border/40 px-3 py-1 text-[9px] text-muted-foreground/70">
          {caption}
        </p>
      ) : null}
    </Panel>
  );
}

const ACCENT_VAR_NAME: Record<Accent, string> = {
  primary: 'primary',
  info: 'info',
  purple: 'purple',
  teal: 'teal',
  success: 'success',
  warning: 'warning',
  danger: 'destructive',
  neutral: 'muted-foreground',
};

function varOf(a: Accent): string {
  return ACCENT_VAR_NAME[a];
}

/* ------------------------------------------------------------------ */
/* Infrastructure card                                                  */
/* ------------------------------------------------------------------ */

type Detail = { label: string; value: React.ReactNode };

type InfraCardDef = {
  icon: React.ElementType;
  name: string;
  accent: Accent;
  state: SysState;
  statusLabel: string;
  primaryLabel?: string;
  primaryValue?: React.ReactNode;
  progress?: number | null;
  series?: number[];
  trendId?: string;
  meta?: string;
  details: Detail[];
  loading?: boolean;
};

function InfraCard(def: InfraCardDef) {
  const {
    icon: Icon, name, accent, state, statusLabel, primaryLabel, primaryValue,
    progress, series, trendId, meta, details, loading,
  } = def;
  const [open, setOpen] = useState(false);
  const s = skin(accent);
  const effective = state === 'unknown' ? 'neutral' : STATE_ACCENT_MAP[state];

  return (
    <Panel className={cn('p-0 relative transition-all duration-200', state === 'ok' && 'border-success/50 ring-1 ring-success/10 hover:border-success/80 hover:ring-success/30', state === 'bad' && 'border-destructive/60 ring-1 ring-destructive/10 hover:border-destructive/90 hover:ring-destructive/30', state === 'warn' && 'border-warning/50 ring-1 ring-warning/10 hover:border-warning/90 hover:ring-warning/30')}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full text-left" disabled={loading}>
          <div className="flex items-center gap-1 px-3.5 py-3">
            <span className={cn('relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1', s.chip)}>
              <Icon className="h-4 w-4" />
              {state === 'ok' ? (
                <span
                  aria-hidden
                  className="si-halo absolute inset-0 rounded-xl"
                  style={{ background: `hsl(var(--${varOf(accent)}))`, opacity: 0.5 }}
                />
              ) : null}
            </span>

            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold leading-tight">{name}</p>
              <p className={cn('mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide', skin(effective).text)}>
                <StateDot state={state} size={6} />
                <span className="truncate">{loading ? 'Checking…' : statusLabel}</span>
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {series && series.length > 1 && trendId ? (
                <Trend points={series} accent={effective} gradientId={trendId} width={58} height={24} />
              ) : null}
              {!loading && primaryValue != null && (
                <div className="text-right">
                  {primaryLabel ? (
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {primaryLabel}
                    </p>
                  ) : null}
                  <p className="font-mono text-sm font-bold leading-tight tabular-nums">{primaryValue}</p>
                </div>
              )}
              <span className={cn('text-muted-foreground transition-transform duration-200', open && 'rotate-180')}>
                ▾
              </span>
            </div>
          </div>
        </CollapsibleTrigger>

        {progress != null && Number.isFinite(progress) && (
          <div className="px-3.5 pb-2.5">
            <Meter pct={progress} accent={STATE_ACCENT_MAP[loadAccent(progress)]} threshold={85} />
          </div>
        )}

        {meta ? (
          <p className="border-t border-border/40 px-3.5 py-1.5 text-[9px] text-muted-foreground">
            {meta}
          </p>
        ) : null}

        <CollapsibleContent>
          <div className="grid grid-cols-1 gap-x-5 border-t border-border/40 px-3.5 py-2 sm:grid-cols-2">
            {details.map((d) => (
              <Readout key={d.label} label={d.label} value={d.value} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Trading API probes                                                   */
/* ------------------------------------------------------------------ */

type ProbeKey = 'orders' | 'funds' | 'positions' | 'holdings';
type ProbeState = Record<ProbeKey, { state: 'loading' | 'ok' | 'error'; ms: number | null }>;

const INITIAL_PROBES: ProbeState = {
  orders: { state: 'loading', ms: null },
  funds: { state: 'loading', ms: null },
  positions: { state: 'loading', ms: null },
  holdings: { state: 'loading', ms: null },
};

async function timedProbe(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number | null }> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    await fn();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { ok: true, ms: t1 - t0 };
  } catch {
    return { ok: false, ms: null };
  }
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

const SYSTEM_POLL_MS = 10_000;
const ENGINES_POLL_MS = 10_000;
const MONGO_POLL_MS = 20_000;
const PROBE_POLL_MS = 30_000;

export default function SystemIndicatorsPage() {
  const [system, setSystem] = useState<any>(null);
  const [systemState, setSystemState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [apiLatency, setApiLatency] = useState<number | null>(null);

  const [mongoStats, setMongoStats] = useState<any>(null);
  const [mongoFetch, setMongoFetch] = useState<'loading' | 'ok' | 'error'>('loading');

  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [fleetSummary, setFleetSummary] = useState<{
    overall: string;
    total: number;
    states: Record<string, number>;
    healths: Record<string, number>;
  } | null>(null);
  const [fleetError, setFleetError] = useState<string | null>(null);

  const [probes, setProbes] = useState<ProbeState>(INITIAL_PROBES);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const mountedRef = useRef(true);
  const sysBusyRef = useRef(false);
  const mongoBusyRef = useRef(false);
  const enginesBusyRef = useRef(false);
  const probeBusyRef = useRef(false);
  const autoRef = useRef(autoRefresh);
  autoRef.current = autoRefresh;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ---- fetchers ---- */

  const fetchSystem = useCallback(async () => {
    if (sysBusyRef.current) return;
    sysBusyRef.current = true;
    try {
      const t0 = performance.now();
      const d = await getSystemStatus();
      if (!mountedRef.current) return;
      setApiLatency(performance.now() - t0);
      setSystem(d);
      setSystemState('ok');
      setLastUpdated(Date.now());
    } catch {
      if (!mountedRef.current) return;
      setSystemState('error');
    } finally {
      sysBusyRef.current = false;
    }
  }, []);

  const fetchMongo = useCallback(async () => {
    if (mongoBusyRef.current) return;
    mongoBusyRef.current = true;
    try {
      const d = await getMongoStats();
      if (!mountedRef.current) return;
      setMongoStats(d);
      setMongoFetch('ok');
    } catch {
      if (!mountedRef.current) return;
      setMongoFetch('error');
    } finally {
      mongoBusyRef.current = false;
    }
  }, []);

  /**
   * The engine fleet is the one source that answers "is every part of the
   * project alive", so a failure here is surfaced as its own banner rather than
   * being silently folded into the overall verdict.
   */
  const fetchEngines = useCallback(async () => {
    if (enginesBusyRef.current) return;
    enginesBusyRef.current = true;
    try {
      const res = await fetch('/api/services/engines', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!mountedRef.current) return;
      if (!res.ok || body?.ok === false) {
        setFleetError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setFleetError(null);
      setEngines(Array.isArray(body?.data) ? (body.data as EngineStatus[]) : []);
      if (body?.summary && typeof body.summary === 'object') setFleetSummary(body.summary);
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      setFleetError(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      enginesBusyRef.current = false;
    }
  }, []);

  const runProbes = useCallback(async () => {
    if (probeBusyRef.current) return;
    probeBusyRef.current = true;
    try {
      const targets: { key: ProbeKey; fn: () => Promise<unknown> }[] = [
        { key: 'orders', fn: getOrderBook },
        { key: 'funds', fn: getFunds },
        { key: 'positions', fn: getPositions },
        { key: 'holdings', fn: getHoldings },
      ];
      const results = await Promise.all(
        targets.map(async (t) => ({ key: t.key, ...(await timedProbe(t.fn)) })),
      );
      if (!mountedRef.current) return;
      setProbes((prev) => {
        const next: ProbeState = { ...prev };
        for (const r of results) next[r.key] = { state: r.ok ? 'ok' : 'error', ms: r.ms };
        return next;
      });
    } finally {
      probeBusyRef.current = false;
    }
  }, []);

  const refreshAll = useCallback(() => {
    setRefreshing(true);
    fetchSystem();
    fetchMongo();
    fetchEngines();
    runProbes();
    window.setTimeout(() => setRefreshing(false), 600);
  }, [fetchSystem, fetchMongo, fetchEngines, runProbes]);

  /* ---- initial load + polling ---- */

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden || !autoRef.current) return;
      fetchSystem();
    }, SYSTEM_POLL_MS);
    const onVisible = () => {
      if (!document.hidden && autoRef.current) fetchSystem();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchSystem]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden || !autoRef.current) return;
      fetchEngines();
    }, ENGINES_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchEngines]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden || !autoRef.current) return;
      fetchMongo();
    }, MONGO_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchMongo]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden || !autoRef.current) return;
      runProbes();
    }, PROBE_POLL_MS);
    return () => clearInterval(interval);
  }, [runProbes]);

  /* ---- derived ---- */

  const node = system?.node ?? null;
  const python = system?.python ?? null;
  const kotak = system?.pythonStatus ?? null;
  const wsDetail = system?.websocketDetail ?? null;
  const wsMetrics = wsDetail?.metrics ?? null;
  const buffer = system?.buffer ?? null;
  const liveData = system?.liveData ?? null;
  const schedInfo = system?.schedulerInfo ?? null;
  const services = system?.services ?? null;

  const svc = useCallback(
    (name: string): { lastChecked: string | null; latencyMs: number | null; error: string | null; status: string | null } => {
      const s = services?.[name];
      return {
        lastChecked: s?.lastChecked ?? null,
        latencyMs: s?.latencyMs ?? null,
        error: s?.error ?? null,
        status: s?.status ?? null,
      };
    },
    [services],
  );

  const mongoPing = mongoStats?.stats?.pingMs ?? null;
  const mongoConnected = system?.mongo?.connected === true;
  const wsConnected = system?.websocketConnected === true;
  const kotakLoggedIn = kotak?.logged_in === true;
  const schedRunning = system?.schedulerRunning === true;
  const internetOk = system?.internetConnected === true;

  const anyProbeError =
    probes.orders.state === 'error' ||
    probes.funds.state === 'error' ||
    probes.positions.state === 'error' ||
    probes.holdings.state === 'error';

  /* Engine helpers */
  const engineById = useCallback(
    (id: string): EngineStatus | undefined => engines.find((e) => e.engineId === id),
    [engines],
  );
  const customOf = useCallback(
    (id: string): Record<string, unknown> => {
      const c = engineById(id)?.metrics?.custom;
      return (c ?? {}) as Record<string, unknown>;
    },
    [engineById],
  );

  const cpuPct = node?.cpuPercent ?? null;
  const ramPct = node?.ramPercent ?? null;
  const diskPct = node?.diskPercent ?? null;
  const tickRate = buffer?.ticksPerSecond ?? liveData?.ticksPerSecond ?? null;

  /* Rolling histories for every sparkline on the page. */
  const series = useRollingSeries({
    api: apiLatency,
    mongo: mongoPing,
    cpu: cpuPct,
    ram: ramPct,
    disk: diskPct,
    ticks: tickRate,
    bufferLen: buffer?.bufferLength ?? null,
    bufferMs: buffer?.lastFlushDurationMs ?? null,
    orders: probes.orders.ms,
    funds: probes.funds.ms,
    positions: probes.positions.ms,
    holdings: probes.holdings.ms,
    ...Object.fromEntries(
      engines.map((e) => [`ev:${e.engineId}`, e.metrics?.eventCount ?? null]),
    ),
  });

  const fleetSeries = useMemo(() => {
    const out: Record<string, number[]> = {};
    for (const e of engines) out[`ev:${e.engineId}`] = series[`ev:${e.engineId}`] ?? [];
    return out;
  }, [engines, series]);

  const overall = useMemo((): { label: string; state: SysState; note: string } => {
    if (systemState === 'loading' && !system && engines.length === 0) {
      return { label: 'Checking', state: 'unknown', note: 'Fetching backend health' };
    }
    if (systemState === 'error') {
      return { label: 'Critical', state: 'bad', note: 'FastAPI backend unreachable — unable to verify any service' };
    }
    if (fleetError && engines.length === 0) {
      return { label: 'Critical', state: 'bad', note: `Engine registry unreachable — ${fleetError}` };
    }
    if (!mongoConnected && system != null) {
      return { label: 'Critical', state: 'bad', note: 'MongoDB disconnected — data persistence unavailable' };
    }

    const issues: string[] = [];
    const unhealthyEngines = engines.filter((e) => engineStateTone(e) === 'bad');
    if (unhealthyEngines.length > 0) {
      issues.push(`${unhealthyEngines.length} engine${unhealthyEngines.length > 1 ? 's' : ''} in error`);
    }
    const degradedEngines = engines.filter((e) => engineStateTone(e) === 'warn');
    if (degradedEngines.length > 0) issues.push(`${degradedEngines.length} engine${degradedEngines.length > 1 ? 's' : ''} degraded`);

    if (!kotakLoggedIn) issues.push('Kotak logged out');
    if (!wsConnected) issues.push('WebSocket offline');
    if (!schedRunning) issues.push('Scheduler stopped');
    if (internetOk === false) issues.push('Internet unreachable');
    if (anyProbeError) issues.push('Trading API failures');
    if (system != null && (python?.status ?? 'ok') !== 'ok') issues.push('Python SDK degraded');
    if (buffer?.totalWriteErrors > 0) issues.push('DB writer errors');

    if (issues.length > 0) return { label: 'Degraded', state: 'warn', note: issues.join(' · ') };
    if (systemState === 'loading') return { label: 'Checking', state: 'unknown', note: 'Fetching backend health' };
    return { label: 'Healthy', state: 'ok', note: 'All monitored subsystems operational' };
  }, [
    systemState, system, engines, fleetError, mongoConnected, kotakLoggedIn, wsConnected,
    schedRunning, internetOk, anyProbeError, python, buffer,
  ]);

  const lastUpdatedLabel =
    lastUpdated != null
      ? new Date(lastUpdated).toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        })
      : 'n/a';

  const countdown = useCountdown(lastUpdated, SYSTEM_POLL_MS);

  const loading = systemState === 'loading' && !system && engines.length === 0;

  const fleetCounts = useMemo(() => {
    const states = engines.map((e) => engineStateTone(e));
    return {
      healthy: states.filter((s) => s === 'ok').length,
      attention: states.filter((s) => s === 'warn').length,
      down: states.filter((s) => s === 'bad').length,
      total: states.length,
    };
  }, [engines]);

  /* ---- card definitions ---- */

  const infraCards = useMemo((): InfraCardDef[] => {
    const mongoSvc = svc('mongo');
    const fastapiSvc = svc('fastapi');
    const wsSvc = svc('websocket');
    const schSvc = svc('scheduler');
    const pySvc = svc('fastapi');

    // Mongo is reachable if EITHER the system snapshot reports the connection or
    // the stats call itself came back — one source can be stale while the other
    // is current, and reporting a false outage on that basis would be wrong.
    const mongoReachable = mongoConnected || mongoFetch === 'ok';
    const mongoState: SysState = loading ? 'unknown' : mongoReachable ? 'ok' : 'bad';
    const pythonOk = python?.status === 'ok' || python?.sdk_loaded === true;
    const pythonState: SysState = loading ? 'unknown' : pythonOk ? 'ok' : 'warn';

    return [
      {
        icon: Database,
        name: 'MongoDB',
        accent: 'purple',
        state: mongoState,
        statusLabel: mongoReachable ? 'Connected' : loading ? 'Checking…' : 'Disconnected',
        primaryLabel: 'Ping',
        primaryValue: mongoReachable ? fmtMs(mongoPing ?? mongoSvc.latencyMs) : undefined,
        series: series.mongo,
        trendId: 'inf-mongo',
        meta: `Last checked ${fmtDateTime(mongoSvc.lastChecked, 'no data')}`,
        details: [
          { label: 'Connection', value: mongoReachable ? 'Connected' : 'Not connected' },
          { label: 'Stats endpoint', value: mongoFetch === 'ok' ? 'Responding' : mongoFetch === 'error' ? 'Unreachable' : 'Checking' },
          { label: 'Database name', value: mongoStats?.stats?.dbName ?? <N v="no data" /> },
          { label: 'Ping response', value: fmtMs(mongoPing) },
          { label: 'Collections', value: mongoStats?.stats?.collections?.length ?? <N v="no data" /> },
          { label: 'Total objects', value: mongoStats?.stats?.totalObjects != null ? fmtQty(mongoStats.stats.totalObjects) : <N v="no data" /> },
          { label: 'Data size', value: fmtBytes(mongoStats?.stats?.totalSizeBytes) },
          { label: 'Storage size', value: fmtBytes(mongoStats?.stats?.totalStorageBytes) },
          { label: 'Index size', value: fmtBytes(mongoStats?.stats?.totalIndexSizeBytes) },
          { label: 'Service monitor', value: mongoSvc.status ?? <N v="no data" /> },
          { label: 'Last error', value: mongoSvc.error ?? <N v="none recorded" /> },
        ],
        loading,
      },
      {
        icon: Terminal,
        name: 'Python',
        accent: 'info',
        state: pythonState,
        statusLabel: pythonOk ? 'Running' : loading ? 'Checking…' : 'Degraded',
        primaryLabel: 'Version',
        primaryValue: python?.version ?? undefined,
        meta: `Last checked ${fmtDateTime(pySvc.lastChecked, lastUpdatedLabel)}`,
        details: [
          { label: 'Process status', value: pythonOk ? 'Healthy' : 'SDK unavailable — running degraded' },
          { label: 'Python version', value: python?.version ?? <N v="no data" /> },
          { label: 'Kotak SDK loaded', value: python?.sdk_loaded == null ? <N v="no data" /> : python.sdk_loaded ? 'Yes' : 'No' },
          { label: 'SDK version', value: system?.sdkVersion ?? <N v="no data" /> },
          { label: 'Process CPU usage', value: fmtPct1(cpuPct) },
          { label: 'Process memory (RSS)', value: node?.memory?.rssMb != null ? `${node.memory.rssMb} MB` : 'n/a' },
          { label: 'Process uptime', value: fmtUptime(node?.uptimeSeconds) },
          { label: 'Backend errors today', value: system?.errorCount != null ? fmtQty(system.errorCount) : 'n/a' },
        ],
        loading,
      },
      {
        icon: Zap,
        name: 'FastAPI',
        accent: 'primary',
        state: systemState === 'ok' ? 'ok' : systemState === 'error' ? 'bad' : 'unknown',
        statusLabel: systemState === 'ok' ? 'Running' : systemState === 'error' ? 'Unreachable' : 'Checking…',
        primaryLabel: 'Latency',
        primaryValue: apiLatency != null ? fmtMs(apiLatency) : undefined,
        series: series.api,
        trendId: 'inf-api',
        meta: `GET /api/system · measured in-browser`,
        details: [
          { label: 'Endpoint', value: '/api/system' },
          { label: 'Response time (measured)', value: fmtMs(apiLatency) },
          { label: 'Requests served', value: <N v="not exposed by backend" /> },
          { label: 'Backend errors today', value: system?.errorCount != null ? fmtQty(system.errorCount) : 'n/a' },
          { label: 'Service monitor', value: fastapiSvc.status ?? <N v="no data" /> },
          { label: 'Monitor latency', value: fmtMs(fastapiSvc.latencyMs) },
          { label: 'Last checked', value: fmtDateTime(fastapiSvc.lastChecked, 'no data') },
          { label: 'Last error', value: fastapiSvc.error ?? <N v="none recorded" /> },
        ],
        loading,
      },
      {
        icon: Wifi,
        name: 'WebSocket',
        accent: 'teal',
        state: loading ? 'unknown' : wsConnected ? 'ok' : 'bad',
        statusLabel: wsConnected ? 'Connected' : loading ? 'Checking…' : 'Disconnected',
        primaryLabel: 'Subscribed',
        primaryValue: wsDetail?.subscribed_symbols != null ? fmtQty(wsDetail.subscribed_symbols) : undefined,
        meta: `Last tick ${fmtDateTime(wsDetail?.last_tick_at, 'no ticks yet')}`,
        details: [
          { label: 'Connection state', value: wsConnected ? 'Connected' : 'Disconnected' },
          { label: 'Subscribed symbols', value: wsDetail?.subscribed_symbols != null ? fmtQty(wsDetail.subscribed_symbols) : <N v="no data" /> },
          { label: 'Ticks received', value: wsDetail?.tick_count != null ? fmtQty(wsDetail.tick_count) : <N v="no data" /> },
          { label: 'Connect count', value: wsMetrics?.connects != null ? fmtQty(wsMetrics.connects) : 'n/a' },
          { label: 'Disconnect count', value: wsMetrics?.disconnects != null ? fmtQty(wsMetrics.disconnects) : 'n/a' },
          { label: 'Connection errors', value: wsMetrics?.errors != null ? fmtQty(wsMetrics.errors) : 'n/a' },
          { label: 'Ticks validated', value: wsMetrics?.ticks_validated != null ? fmtQty(wsMetrics.ticks_validated) : 'n/a' },
          { label: 'Ticks rejected', value: wsMetrics?.ticks_rejected != null ? fmtQty(wsMetrics.ticks_rejected) : 'n/a' },
          { label: 'Last tick message', value: fmtDateTime(wsDetail?.last_tick_at, 'no ticks received') },
          { label: 'Last connection event', value: fmtDateTime(system?.lastWebSocketConnection, 'no data') },
          { label: 'Monitor latency', value: fmtMs(wsSvc.latencyMs) },
          { label: 'Last error', value: wsSvc.error ?? <N v="none recorded" /> },
        ],
        loading,
      },
      {
        icon: Clock,
        name: 'Scheduler',
        accent: 'warning',
        state: loading ? 'unknown' : schedRunning ? 'ok' : 'bad',
        statusLabel: schedRunning ? 'Running' : loading ? 'Checking…' : 'Stopped',
        primaryLabel: 'Auto-login',
        primaryValue: schedInfo?.login_time ?? undefined,
        meta: `Last checked ${fmtDateTime(schSvc.lastChecked, 'no data')}`,
        details: [
          { label: 'Scheduler running', value: schedRunning ? 'Yes' : 'No' },
          { label: 'Scheduler enabled', value: system?.schedulerEnabled == null ? <N v="no data" /> : system.schedulerEnabled ? 'Yes' : 'No' },
          { label: 'Auto-login time', value: schedInfo?.login_time ?? 'n/a' },
          { label: 'Auto-logout time', value: schedInfo?.logout_time ?? 'n/a' },
          { label: 'Next login run', value: fmtDateTime(schedInfo?.next_login, 'n/a') },
          { label: 'Next logout run', value: fmtDateTime(schedInfo?.next_logout, 'n/a') },
          { label: 'Trading day today', value: schedInfo?.is_trading_day == null ? 'n/a' : schedInfo.is_trading_day ? 'Yes' : 'No' },
          { label: 'Failed jobs', value: schSvc.error ?? <N v="none recorded" /> },
        ],
        loading,
      },
    ];
  }, [
    system, systemState, loading, mongoConnected, mongoFetch, mongoPing, mongoStats, apiLatency,
    wsDetail, wsMetrics, python, node, cpuPct, schedInfo, schedRunning, wsConnected, lastUpdatedLabel,
    svc, series,
  ]);

  const perfCards = useMemo((): InfraCardDef[] => [
    {
      icon: Gauge,
      name: 'API Response Time',
      accent: 'info',
      state: apiLatency == null ? (systemState === 'error' ? 'bad' : 'unknown') : apiLatency > 1000 ? 'warn' : 'ok',
      statusLabel: systemState === 'error' ? 'Unavailable' : apiLatency == null ? 'Measuring…' : apiLatency > 1000 ? 'Slow' : 'Fast',
      primaryValue: apiLatency != null ? fmtMs(apiLatency) : undefined,
      series: series.api,
      trendId: 'perf-api',
      meta: 'GET /api/system · sampled every 10s',
      details: [
        { label: 'Endpoint', value: '/api/system' },
        { label: 'Method', value: 'GET' },
        { label: 'Round-trip time', value: fmtMs(apiLatency) },
        { label: 'Sampled every', value: '10 seconds' },
      ],
    },
    {
      icon: Database,
      name: 'Database Response Time',
      accent: 'purple',
      state: mongoConnected ? (mongoPing == null ? 'unknown' : mongoPing > 250 ? 'warn' : 'ok') : 'bad',
      statusLabel: !mongoConnected ? 'Not connected' : mongoPing == null ? 'Measuring…' : mongoPing > 250 ? 'Slow' : 'Fast',
      primaryValue: mongoConnected && mongoPing != null ? fmtMs(mongoPing) : undefined,
      series: series.mongo,
      trendId: 'perf-mongo',
      meta: 'MongoDB ping measured server-side',
      details: [
        { label: 'Endpoint', value: '/api/system/mongo-stats' },
        { label: 'Ping round-trip', value: fmtMs(mongoPing) },
        { label: 'Database', value: mongoStats?.stats?.dbName ?? 'n/a' },
        { label: 'Collections', value: mongoStats?.stats?.collections?.length ?? 'n/a' },
      ],
    },
    {
      icon: HardDrive,
      name: 'Background Worker',
      accent: 'primary',
      state: buffer ? (buffer.totalWriteErrors > 0 ? 'warn' : 'ok') : 'unknown',
      statusLabel: !buffer ? 'No data' : buffer.totalWriteErrors > 0 ? 'Write errors detected' : 'Processing',
      primaryLabel: 'Tick rate',
      primaryValue: buffer?.ticksPerSecond != null ? `${buffer.ticksPerSecond}/s` : undefined,
      series: series.bufferLen,
      trendId: 'perf-worker',
      meta: `Buffer ${buffer?.bufferLength ?? 'n/a'} ticks pending`,
      details: [
        { label: 'Worker', value: 'Tick buffer writer' },
        { label: 'Buffer length', value: buffer?.bufferLength != null ? fmtQty(buffer.bufferLength) : 'n/a' },
        { label: 'Ticks received', value: buffer?.totalReceived != null ? fmtQty(buffer.totalReceived) : 'n/a' },
        { label: 'Total written', value: buffer?.totalWritten != null ? fmtQty(buffer.totalWritten) : 'n/a' },
        { label: 'Write errors', value: buffer?.totalWriteErrors != null ? fmtQty(buffer.totalWriteErrors) : 'n/a' },
        { label: 'Writes per second', value: buffer?.writesPerSecond != null ? String(buffer.writesPerSecond) : 'n/a' },
        { label: 'Active tick stocks', value: buffer?.activeTickStocks != null ? fmtQty(buffer.activeTickStocks) : 'n/a' },
        { label: 'Last flush duration', value: fmtMs(buffer?.lastFlushDurationMs) },
        { label: 'Last write', value: fmtDateTime(buffer?.lastWriteAt, 'no writes yet') },
        { label: 'Last error', value: buffer?.lastError ?? <N v="none recorded" /> },
      ],
    },
  ], [apiLatency, systemState, mongoConnected, mongoPing, mongoStats, buffer, series]);

  const serviceCards = useMemo((): InfraCardDef[] => {
    const kotakSvc = svc('kotak');

    const probeCard = (key: ProbeKey, name: string, endpoint: string, icon: React.ElementType, accent: Accent): InfraCardDef => {
      const p = probes[key];
      return {
        icon,
        name,
        accent,
        state: p.state === 'ok' ? 'ok' : p.state === 'error' ? 'bad' : 'unknown',
        statusLabel: p.state === 'ok' ? 'Operational' : p.state === 'error' ? 'Unavailable' : 'Checking…',
        primaryLabel: 'Latency',
        primaryValue: p.state === 'ok' && p.ms != null ? fmtMs(p.ms) : undefined,
        series: series[key],
        trendId: `svc-${key}`,
        meta: p.state === 'error' ? 'Unable to fetch current value' : `GET ${endpoint}`,
        details: [
          { label: 'Endpoint', value: endpoint },
          { label: 'Latency (measured)', value: p.ms != null ? fmtMs(p.ms) : 'n/a' },
          { label: 'Availability', value: p.state === 'ok' ? 'Reachable' : p.state === 'error' ? 'Unable to fetch current value' : 'Checking' },
          { label: 'Probed every', value: '30 seconds' },
        ],
      };
    };

    return [
      {
        icon: KeyRound,
        name: 'Kotak Login',
        accent: 'warning',
        state: loading ? 'unknown' : kotakLoggedIn ? 'ok' : 'bad',
        statusLabel: kotakLoggedIn ? 'Logged In' : loading ? 'Checking…' : 'Logged Out',
        primaryLabel: 'Session',
        primaryValue: kotak?.session_active == null ? undefined : kotak.session_active ? 'Active' : 'Inactive',
        meta: `Last login ${fmtDateTime(system?.lastLogin, 'never')}`,
        details: [
          { label: 'Login state', value: kotakLoggedIn ? 'Logged in' : 'Not logged in' },
          { label: 'Session active', value: kotak?.session_active == null ? 'n/a' : kotak.session_active ? 'Yes' : 'No' },
          { label: 'View token present', value: kotak?.view_token_present == null ? 'n/a' : kotak.view_token_present ? 'Yes' : 'No' },
          { label: 'Trade token present', value: kotak?.trade_token_present == null ? 'n/a' : kotak.trade_token_present ? 'Yes' : 'No' },
          { label: 'Login count (process)', value: kotak?.login_count != null ? fmtQty(kotak.login_count) : 'n/a' },
          { label: 'Exchanges', value: Array.isArray(kotak?.exchanges) && kotak.exchanges.length > 0 ? kotak.exchanges.join(', ') : 'n/a' },
          { label: 'Products', value: Array.isArray(kotak?.products) && kotak.products.length > 0 ? kotak.products.join(', ') : 'n/a' },
          { label: 'Last login', value: fmtDateTime(system?.lastLogin, 'never') },
          { label: 'Last logout', value: fmtDateTime(system?.lastLogout, 'never') },
          { label: 'Last error', value: kotakSvc.error ?? <N v="none recorded" /> },
        ],
        loading,
      },
      {
        icon: Radio,
        name: 'Market Data Feed',
        accent: 'teal',
        state: loading ? 'unknown' : wsConnected ? ((liveData?.ticksPerSecond ?? 0) > 0 ? 'ok' : 'warn') : 'bad',
        statusLabel: !wsConnected ? 'Offline' : (liveData?.ticksPerSecond ?? 0) > 0 ? 'Streaming' : 'Connected — idle',
        primaryLabel: 'Tick rate',
        primaryValue: liveData?.ticksPerSecond != null ? `${liveData.ticksPerSecond}/s` : undefined,
        series: series.ticks,
        trendId: 'svc-feed',
        meta: `Last tick ${fmtDateTime(liveData?.lastTickAt, 'none yet')}`,
        details: [
          { label: 'Feed state', value: wsConnected ? 'Subscribed' : 'Not connected' },
          { label: 'Ticks per second', value: liveData?.ticksPerSecond != null ? String(liveData.ticksPerSecond) : 'n/a' },
          { label: 'Writes per second', value: liveData?.writesPerSecond != null ? String(liveData.writesPerSecond) : 'n/a' },
          { label: 'Active tick stocks', value: liveData?.activeTickStocks != null ? fmtQty(liveData.activeTickStocks) : 'n/a' },
          { label: 'Last tick symbol', value: system?.lastTickSymbol ?? 'n/a' },
          { label: 'Last tick at', value: fmtDateTime(system?.lastTickTime, 'no ticks received') },
          { label: 'Records saved today', value: system?.todayRecords != null ? fmtQty(system.todayRecords) : 'n/a' },
          { label: 'Internet reachable', value: internetOk === null || internetOk === undefined ? 'Unknown' : internetOk ? 'Yes' : 'No' },
        ],
        loading,
      },
      probeCard('orders', 'Order API', '/api/trading/orders', ShoppingCart, 'primary'),
      probeCard('funds', 'Funds API', '/api/trading/funds', Wallet, 'success'),
      probeCard('positions', 'Positions API', '/api/trading/positions', Briefcase, 'info'),
      probeCard('holdings', 'Holdings API', '/api/trading/holdings', TrendingUp, 'purple'),
    ];
  }, [probes, kotak, kotakLoggedIn, system, loading, wsConnected, liveData, internetOk, svc, series]);

  /* ---- DB writer pipeline ---- */

  const pipeline = useMemo(() => {
    const c = customOf('db_writer_engine');
    const num = (k: string) => {
      const v = c[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    return {
      received: num('totalReceived'),
      ingested: num('ingestedFromRouter'),
      written: num('totalWritten'),
      errors: num('totalWriteErrors'),
      rejected: num('rejectedByValidation'),
      duplicates: num('duplicatesRejected'),
      accepted: num('acceptedForPersistence'),
      bufferLength: num('bufferLength'),
      ticksPerSecond: num('ticksPerSecond'),
      writesPerSecond: num('writesPerSecond'),
      activeStocks: num('activeTickStocks'),
      feedLatencyMs: num('feedLatencyMs'),
      pipelineRunning: c['pipelineRunning'],
      storageCapActive: c['storageCapActive'],
      cappedStreams: num('storageCappedStreams'),
      mwWritten: num('mwDocumentsWritten'),
      mwRejected: num('mwDocumentsRejected'),
      mwPending: num('mwDocumentsPending'),
      mwAccepted: num('mwDocumentsAccepted'),
      mwWriteErrors: num('mwDocumentWriteErrors'),
      queueRejected: num('queueRejected'),
      registryCacheEntries: num('registryCacheEntries'),
      registryCacheRefreshes: num('registryCacheRefreshes'),
      // Skip reasons — these explain where the rejected ticks actually went.
      skippedNoExpiry: num('personalNoExpirySkipped'),
      skippedExpiry: num('personalExpirySkipped'),
      skippedMarketWatch: num('marketWatchSkipped'),
      skippedUnknownSource: num('unknownSourceSkipped'),
      overlappingDeduped: num('overlappingSourcesDeduped'),
    };
  }, [customOf]);

  /* ---- market watch plane ---- */

  const marketPlane = useMemo(() => {
    const c = customOf('market_watch');
    const num = (k: string) => {
      const v = c[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : null);
    return {
      feedState: str('feedState'),
      lifecycleState: str('lifecycleState'),
      lifecyclePrevious: str('lifecyclePrevious'),
      universeState: str('universeState'),
      websocketStatus: str('websocket_status'),
      universe: num('eligibleUniverseCount'),
      eligibleStates: num('eligibleStateCount'),
      eligibleTarget: num('eligibleTarget'),
      lowUniverseWarning: num('lowUniverseWarning'),
      subscribed: num('subscribedTokenCount'),
      watchable: num('watchableCount'),
      priceCap: num('priceCap'),
      indexVersion: num('indexVersion'),
      blocksRecorded: num('blocksRecorded'),
      live: num('liveInstrumentCount'),
      stale: num('staleInstrumentCount'),
      noData: num('noDataInstrumentCount'),
      pending: num('pendingInstrumentCount'),
      rankingMs: num('rankingDurationMs'),
      publishMs: num('publish_latency_ms'),
      processingMs: num('processing_latency_ms'),
      recoveryCandles: num('recoveryCandles'),
      recoveryIncomplete: c['recoveryIncomplete'],
      priceCapped: num('priceCappedCount'),
      gainerPins: num('gainerPinChanges'),
      loserPins: num('loserPinChanges'),
      persisted: num('persistedTicks'),
      suppressed: num('ticksSuppressed'),
      tickCount: num('tickCount'),
      receivedTicks: num('received_tick_count'),
      validatedTicks: num('validated_tick_count'),
      invalidTicks: num('invalid_tick_count'),
      outOfUniverse: num('out_of_universe_tick_count'),
      rankingEvery: num('rankingIntervalSeconds'),
      staleThreshold: num('staleThresholdSeconds'),
    };
  }, [customOf]);

  /* ---- connection manager plane ---- */

  const connectionPlane = useMemo(() => {
    const c = customOf('connection_manager');
    const num = (k: string) => {
      const v = c[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    return {
      sessions: num('sessions'),
      connections: num('activeConnections'),
      framesRouted: num('framesRouted'),
      delivered: num('messagesDelivered'),
      dropped: num('messagesDropped'),
      freshness: typeof c['feedFreshness'] === 'string' ? (c['feedFreshness'] as string) : null,
      feedAgeSec: num('feedLastTickAgeSeconds'),
    };
  }, [customOf]);

  /* ---- alerting / audit plane ---- */

  const alertPlane = useMemo(() => {
    const notif = customOf('notification_engine');
    const audit = customOf('audit_engine');
    const storage = customOf('storage_engine');
    const target = customOf('target_engine');
    const num = (src: Record<string, unknown>, k: string) => {
      const v = src[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    return {
      activeAlerts: num(notif, 'activeAlerts'),
      unread: num(notif, 'unreadNotifications'),
      auditEvents: num(audit, 'totalEvents'),
      historyLength: num(storage, 'historyLength'),
      sampleErrors: num(storage, 'sampleErrors'),
      sampleMs: num(storage, 'lastSampleDurationMs'),
      targets: num(target, 'targetCount'),
    };
  }, [customOf]);

  const renderCount = (n: number | null) => (n == null ? 'n/a' : fmtQty(n));

  const healthScore =
    fleetCounts.total > 0 ? Math.round((fleetCounts.healthy / fleetCounts.total) * 100) : null;

  return (
    <div className="space-y-3">
      {/* ================= HERO ================= */}
      <Panel
        className="si-sweep si-grid relative overflow-hidden rounded-3xl border-border/60 p-0 shadow-soft-lg"
        sheen={false}
        lift={false}
        style={{
          backgroundImage: `linear-gradient(140deg, hsl(var(--${varOf(STATE_ACCENT_MAP[overall.state])})) / 0.14, transparent 55%), linear-gradient(200deg, hsl(var(--info)) / 0.1, transparent 45%)`,
        }}
      >
        {/* ambient aurora */}
        <span aria-hidden className="ds-drift-a pointer-events-none absolute -left-24 -top-28 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
        <span aria-hidden className="ds-drift-b pointer-events-none absolute -right-20 top-10 h-80 w-80 rounded-full bg-info/15 blur-3xl" />
        <span aria-hidden className="ds-drift-c pointer-events-none absolute bottom-[-6rem] left-1/3 h-64 w-64 rounded-full bg-purple/15 blur-3xl" />

        <div className="relative flex flex-wrap items-center gap-x-6 gap-y-5 p-5">
          {/* Overall verdict ring */}
          <div className="relative">
            {/* Rotating accent ring, tinted to the verdict. It runs for every
                real verdict (ok / degraded / critical) and holds still while
                the very first check is still in flight. */}
            <span
              aria-hidden
              className={cn('si-orbit-ring absolute -inset-1.5 rounded-[1.15rem] opacity-80', overall.state !== 'unknown' && 'si-orbit')}
              style={
                overall.state === 'unknown'
                  ? undefined
                  : {
                      background: `conic-gradient(from 0deg, transparent 0deg, hsl(var(--${varOf(STATE_ACCENT_MAP[overall.state])}) / 0.95) 70deg, transparent 150deg, hsl(var(--${varOf(STATE_ACCENT_MAP[overall.state])}) / 0.5) 250deg, transparent 340deg)`,
                    }
              }
            />
            <Ring
              value={
                healthScore != null
                  ? healthScore
                  : overall.state === 'ok'
                    ? 100
                    : overall.state === 'bad'
                      ? 0
                      : null
              }
              accent={STATE_ACCENT_MAP[overall.state]}
              size={116}
              thickness={10}
              label="Fleet health"
              caption={`${fleetCounts.healthy}/${fleetCounts.total} engines`}
              live={overall.state === 'ok'}
            />
          </div>

          {/* Verdict text */}
          <div className="min-w-[240px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">System Indicators</h1>
              <Pill
                label={overall.label}
                accent={STATE_ACCENT_MAP[overall.state]}
                icon={overall.state === 'ok' ? CheckCircle2 : overall.state === 'bad' ? AlertCircle : Activity}
                live={overall.state === 'ok'}
              />
              {autoRefresh ? (
                <Pill label={`Auto ${countdown != null ? `· ${countdown}s` : ''}`} accent="info" live />
              ) : (
                <Pill label="Paused" accent="neutral" />
              )}
            </div>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{overall.note}</p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <StateDot state="ok" size={7} />
                <span className="font-semibold text-success">{fleetCounts.healthy}</span> healthy
              </span>
              {fleetCounts.attention > 0 && (
                <span className="flex items-center gap-1.5">
                  <StateDot state="warn" size={7} />
                  <span className="font-semibold text-warning">{fleetCounts.attention}</span> attention
                </span>
              )}
              {fleetCounts.down > 0 && (
                <span className="flex items-center gap-1.5">
                  <StateDot state="bad" size={7} />
                  <span className="font-semibold text-destructive">{fleetCounts.down}</span> down
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Layers className="h-3 w-3" />
                {fleetCounts.total} engines tracked
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                Updated {lastUpdatedLabel}
              </span>
            </div>
          </div>

          {/* Hero readouts + controls */}
          <div className="flex flex-col items-stretch gap-1">
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-center rounded-xl border border-border/50 bg-background/50 px-3 py-1.5 backdrop-blur">
                <span className="font-mono text-base font-bold leading-none tabular-nums">
                  {node?.uptimeSeconds != null ? fmtUptime(node.uptimeSeconds) : 'n/a'}
                </span>
                <span className="mt-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">Uptime</span>
              </div>
              <div className="flex flex-col items-center rounded-xl border border-border/50 bg-background/50 px-3 py-1.5 backdrop-blur">
                <span className="font-mono text-base font-bold leading-none tabular-nums">
                  {fmtMs(apiLatency)}
                </span>
                <span className="mt-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">API</span>
              </div>
              <div className="flex flex-col items-center rounded-xl border border-border/50 bg-background/50 px-3 py-1.5 backdrop-blur">
                <span className="font-mono text-base font-bold leading-none tabular-nums">
                  {tickRate != null ? `${Math.round(tickRate)}/s` : 'n/a'}
                </span>
                <span className="mt-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">Ticks</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              {series.api && series.api.length > 1 ? (
                <Trend points={series.api} accent={STATE_ACCENT_MAP[overall.state]} gradientId="hero-latency" width={110} height={34} />
              ) : null}
              <Button size="sm" variant={autoRefresh ? 'default' : 'outline'} onClick={() => setAutoRefresh((v) => !v)}>
                {autoRefresh ? 'Auto' : 'Paused'}
              </Button>
              <Button size="sm" variant="ghost" onClick={refreshAll} aria-label="Refresh all" disabled={refreshing}>
                <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      {/* Registry failure gets its own banner — the fleet is the whole point. */}
      {fleetError && (
        <Panel className="border-destructive/35 p-3" style={{ backgroundImage: 'linear-gradient(120deg, hsl(var(--destructive) / 0.12), transparent 60%)' }}>
          <div className="flex items-start gap-1">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-destructive/12 text-destructive ring-1 ring-destructive/25">
              <LifeBuoy className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-destructive">Engine registry unreachable</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <span className="font-mono">{fleetError}</span> — the per-engine indicators below could not be refreshed.
              </p>
            </div>
          </div>
        </Panel>
      )}

      {/* ================= LIVE KPI RAIL ================= */}
      <section aria-label="Live vitals" className="space-y-1">
        <SectionHead
          icon={Activity}
          title="Live Vitals"
          caption="Everything that changes second to second, sampled live"
          accent="info"
          aside={
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <LiveHalo accent={systemState === 'ok' ? 'success' : systemState === 'error' ? 'danger' : 'neutral'} size={7} live={systemState === 'ok'} />
              {systemState === 'ok' ? 'streaming' : systemState === 'error' ? 'backend down' : 'connecting'}
            </span>
          }
        />
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          <KpiTile
            icon={Cpu}
            label="CPU"
            value={cpuPct}
            unit="%"
            accent={loadAccent(cpuPct) === 'ok' ? 'teal' : loadAccent(cpuPct) === 'warn' ? 'warning' : loadAccent(cpuPct) === 'bad' ? 'danger' : 'neutral'}
            series={series.cpu}
            trendId="kpi-cpu"
            sub={node?.cpuLoad1m != null ? `load ${node.cpuLoad1m.toFixed(2)}` : undefined}
            caption="psutil · backend process"
            flashKey={cpuPct}
          />
          <KpiTile
            icon={MemoryStick}
            label="Memory"
            value={ramPct}
            unit="%"
            accent={loadAccent(ramPct) === 'ok' ? 'info' : loadAccent(ramPct) === 'warn' ? 'warning' : loadAccent(ramPct) === 'bad' ? 'danger' : 'neutral'}
            series={series.ram}
            trendId="kpi-ram"
            sub={node?.memory?.rssMb != null ? `rss ${node.memory.rssMb} MB` : undefined}
            caption="psutil · host"
            flashKey={ramPct}
          />
          <KpiTile
            icon={HardDrive}
            label="Disk"
            value={diskPct}
            unit="%"
            accent={loadAccent(diskPct) === 'ok' ? 'purple' : loadAccent(diskPct) === 'warn' ? 'warning' : loadAccent(diskPct) === 'bad' ? 'danger' : 'neutral'}
            series={series.disk}
            trendId="kpi-disk"
            sub={node?.diskUsedBytes != null ? `${fmtBytes(node.diskUsedBytes)} used` : undefined}
            caption="workspace volume"
            flashKey={diskPct}
          />
          <KpiTile
            icon={Signal}
            label="Tick rate"
            value={tickRate}
            unit="/s"
            accent="teal"
            series={series.ticks}
            trendId="kpi-ticks"
            sub={wsConnected ? 'websocket live' : 'ws offline'}
            caption="feed throughput"
            flashKey={tickRate}
          />
          <KpiTile
            icon={Gauge}
            label="API latency"
            value={apiLatency}
            unit="ms"
            accent={apiLatency == null ? 'neutral' : apiLatency > 1000 ? 'warning' : 'success'}
            series={series.api}
            trendId="kpi-api"
            caption="GET /api/system"
            flashKey={apiLatency}
          />
          <KpiTile
            icon={Database}
            label="Records today"
            value={system?.todayRecords ?? null}
            accent="primary"
            sub={system?.errorCount != null ? `${fmtQty(system.errorCount)} errors` : undefined}
            caption="ticks persisted today"
            flashKey={system?.todayRecords}
          />
        </div>
      </section>

      {/* ================= RESOURCE GAUGES ================= */}
      <section aria-label="Resource utilisation" className="space-y-1">
        <SectionHead
          icon={Cpu}
          title="Resource Utilisation"
          caption="Host pressure with the 60% / 85% alert ladder marked on every meter"
          accent="purple"
        />
        <div className="grid grid-cols-2 gap-1 lg:grid-cols-4">
          {[
            { icon: Cpu, label: 'CPU', pct: cpuPct, accent: 'teal' as Accent, sub: node?.cpuLoad1m != null ? `load avg ${node.cpuLoad1m.toFixed(2)} / ${node.cpuLoad5m?.toFixed(2) ?? '—'} / ${node.cpuLoad15m?.toFixed(2) ?? '—'}` : 'no load average' },
            { icon: MemoryStick, label: 'Memory', pct: ramPct, accent: 'info' as Accent, sub: node?.ramTotalBytes != null ? `${fmtBytes(node.ramUsedBytes)} of ${fmtBytes(node.ramTotalBytes)}` : 'no reading' },
            { icon: HardDrive, label: 'Storage', pct: diskPct, accent: 'purple' as Accent, sub: node?.diskTotalBytes != null ? `${fmtBytes(node.diskUsedBytes)} of ${fmtBytes(node.diskTotalBytes)}` : 'no reading' },
            { icon: Layers, label: 'Tick buffer', pct: buffer?.bufferLength != null ? Math.min(100, (buffer.bufferLength / 10_000) * 100) : null, accent: 'primary' as Accent, sub: buffer?.bufferLength != null ? `${fmtQty(buffer.bufferLength)} queued · ${fmtMs(buffer.lastFlushDurationMs)} last flush` : 'no reading' },
          ].map((r, i) => (
            <Panel key={r.label} className="ds-rise flex flex-col items-center gap-2 p-4" style={stagger(i)}>
              <Ring
                value={r.pct}
                accent={r.pct != null && r.pct >= 85 ? 'danger' : r.pct != null && r.pct >= 60 ? 'warning' : r.accent}
                size={104}
                thickness={9}
                label={r.label}
                live={r.pct != null}
              />
              <p className="text-center text-[10px] leading-tight text-muted-foreground">{r.sub}</p>
            </Panel>
          ))}
        </div>
      </section>

      {/* ================= ENGINE FLEET ================= */}
      <section aria-label="Engine fleet" className="space-y-1">
        <SectionHead
          icon={Blocks}
          title="Engine Fleet"
          caption="Every backend engine this project runs, with the metrics it actually publishes"
          accent="primary"
          count={`${fleetCounts.total} engines`}
          aside={
            fleetSummary ? (
              <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                {Object.entries(fleetSummary.states ?? {}).map(([state, n]) => (
                  <span key={state} className="flex items-center gap-1">
                    <span className="font-mono font-semibold tabular-nums text-foreground">{n}</span>
                    {prettyState(state).toLowerCase()}
                  </span>
                ))}
              </span>
            ) : null
          }
        />

        {engines.length === 0 ? (
          <Panel className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            {fleetError ? 'Engine registry unavailable' : 'Loading engine registry…'}
          </Panel>
        ) : (
          <EngineFleet engines={engines} series={fleetSeries} />
        )}
      </section>

      {/* ================= DATA PIPELINE ================= */}
      <section aria-label="Data pipeline" className="space-y-1">
        <SectionHead
          icon={Workflow}
          title="Data Pipeline"
          caption="Tick ingestion → validation → persistence, stage by stage"
          accent="teal"
        />
        <div className="grid grid-cols-1 items-start gap-1 xl:grid-cols-3">
          <Panel className="p-3.5">
            <div className="mb-2.5 flex items-center justify-between">
              <p className="text-xs font-bold">Pipeline flow</p>
              <Pill
                label={pipeline.pipelineRunning === true ? 'Running' : pipeline.pipelineRunning === false ? 'Halted' : 'n/a'}
                accent={pipeline.pipelineRunning === true ? 'success' : pipeline.pipelineRunning === false ? 'danger' : 'neutral'}
                live={pipeline.pipelineRunning === true}
              />
            </div>

            <div className="space-y-2">
              {[
                { label: 'Ingested from router', value: pipeline.ingested, accent: 'info' as Accent, icon: Radio },
                { label: 'Rejected by validation', value: pipeline.rejected, accent: 'warning' as Accent, icon: ShieldCheck },
                { label: 'Duplicates removed', value: pipeline.duplicates, accent: 'purple' as Accent, icon: ScrollText },
                { label: 'Accepted for persistence', value: pipeline.accepted, accent: 'success' as Accent, icon: CheckCircle2 },
                { label: 'Written to MongoDB', value: pipeline.written, accent: 'teal' as Accent, icon: HardDrive },
                { label: 'Write errors', value: pipeline.errors, accent: 'danger' as Accent, icon: AlertTriangle },
              ].map((stage, i) => {
                /* A negative counter is a real (if broken) reading from the
                   engine, not something to clamp away — clamping would assert a
                   number the backend never sent. Show it, flagged, so the
                   anomaly is visible instead of quietly hidden. */
                const negative = stage.value != null && stage.value < 0;
                return (
                  <div key={stage.label} className="ds-rise" style={stagger(i)}>
                    <div className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <stage.icon className={cn('h-3 w-3 shrink-0', negative ? 'text-destructive' : skin(stage.accent).text)} />
                        <span className="truncate">{stage.label}</span>
                      </span>
                      <span
                        className={cn(
                          'shrink-0 font-mono font-bold tabular-nums',
                          negative
                            ? 'text-destructive'
                            : stage.value != null && stage.value > 0
                              ? skin(stage.accent).text
                              : 'text-muted-foreground',
                        )}
                        title={negative ? 'The engine reported a negative counter for this stage.' : undefined}
                      >
                        {renderCount(stage.value)}
                        {negative ? ' ⚠' : ''}
                      </span>
                    </div>
                    {i < 5 ? (
                      <div className="ml-[5px] h-2 w-px bg-gradient-to-b from-border to-transparent" />
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* Where every ingested tick ended up. Negatives cannot be a share
                of anything, so they are excluded from the bar (and stay visible,
                flagged, in the stage list above). */}
            <div className="mt-3 border-t border-border/40 pt-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Outcome split · {renderCount(pipeline.ingested)} ingested
              </p>
              <SplitBar
                parts={[
                  { id: 'written', label: 'Written', value: pipeline.written ?? 0, accent: 'success' },
                  { id: 'unwritten', label: 'Accepted, not yet written', value: Math.max(0, (pipeline.accepted ?? 0) - (pipeline.written ?? 0)), accent: 'info' },
                  { id: 'dupes', label: 'Duplicates', value: pipeline.duplicates ?? 0, accent: 'purple' },
                  { id: 'rejected', label: 'Rejected', value: pipeline.rejected ?? 0, accent: 'warning' },
                  { id: 'errors', label: 'Write errors', value: pipeline.errors ?? 0, accent: 'danger' },
                ]}
                height={9}
              />
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
                {[
                  { l: 'Written', v: pipeline.written, a: 'success' as Accent },
                  { l: 'Accepted', v: pipeline.accepted, a: 'info' as Accent },
                  { l: 'Duplicates', v: pipeline.duplicates, a: 'purple' as Accent },
                  { l: 'Rejected', v: pipeline.rejected, a: 'warning' as Accent },
                  { l: 'Errors', v: pipeline.errors, a: 'danger' as Accent },
                ].map((x) => (
                  <span key={x.l} className="flex items-center gap-1">
                    <span className={cn('h-1.5 w-1.5 rounded-full', skin(x.a).bar)} />
                    {x.l} <span className="font-mono tabular-nums text-foreground">{renderCount(x.v)}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* The counters that actually explain where the rejected ticks go. */}
            <div className="mt-3 border-t border-border/40 pt-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Skip reasons
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <MetricChip label="Market watch" value={renderCount(pipeline.skippedMarketWatch)} accent="warning" />
                <MetricChip label="No-expiry personal" value={renderCount(pipeline.skippedNoExpiry)} accent="neutral" />
                <MetricChip label="Expiry personal" value={renderCount(pipeline.skippedExpiry)} accent="neutral" />
                <MetricChip label="Unknown source" value={renderCount(pipeline.skippedUnknownSource)} accent={(pipeline.skippedUnknownSource ?? 0) > 0 ? 'warning' : 'neutral'} />
                <MetricChip label="Overlap deduped" value={renderCount(pipeline.overlappingDeduped)} accent="purple" />
                <MetricChip label="Queue rejects" value={renderCount(pipeline.queueRejected)} accent={(pipeline.queueRejected ?? 0) > 0 ? 'danger' : 'neutral'} />
              </div>
            </div>
          </Panel>

          <Panel className="p-3.5">
            <div className="mb-2.5 flex items-center justify-between">
              <p className="text-xs font-bold">Writer throughput</p>
              {pipeline.storageCapActive === true ? (
                <Pill label={`${renderCount(pipeline.cappedStreams)} capped streams`} accent="warning" />
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MetricChip label="Ticks/s" value={renderCount(pipeline.ticksPerSecond)} accent="teal" icon={Activity} />
              <MetricChip label="Writes/s" value={renderCount(pipeline.writesPerSecond)} accent="info" icon={HardDrive} />
              <MetricChip label="Buffer" value={renderCount(pipeline.bufferLength)} accent="primary" icon={Layers} />
              <MetricChip label="Tick stocks" value={renderCount(pipeline.activeStocks)} accent="purple" icon={Database} />
              <MetricChip
                label="Feed lag"
                value={fmtMsSmart(pipeline.feedLatencyMs)}
                accent={(pipeline.feedLatencyMs ?? 0) > 60_000 ? 'danger' : (pipeline.feedLatencyMs ?? 0) > 500 ? 'warning' : 'success'}
                icon={Clock}
              />
              <MetricChip label="Queue rejects" value={renderCount(pipeline.queueRejected)} accent={(pipeline.queueRejected ?? 0) > 0 ? 'warning' : 'neutral'} icon={ShieldCheck} />
            </div>

            <div className="mt-3 border-t border-border/40 pt-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Market Watch documents
              </p>
              <div className="grid grid-cols-2 gap-2">
                <MetricChip label="Accepted" value={renderCount(pipeline.mwAccepted)} accent="teal" />
                <MetricChip label="Written" value={renderCount(pipeline.mwWritten)} accent="success" />
                <MetricChip label="Pending" value={renderCount(pipeline.mwPending)} accent="warning" />
                <MetricChip label="Rejected" value={renderCount(pipeline.mwRejected)} accent={(pipeline.mwRejected ?? 0) > 0 ? 'danger' : 'neutral'} />
              </div>
              <div className="mt-1.5">
                <Readout label="Document write errors" value={renderCount(pipeline.mwWriteErrors)} accent={(pipeline.mwWriteErrors ?? 0) > 0 ? 'danger' : undefined} />
                <Readout label="Storage cap active" value={pipeline.storageCapActive == null ? 'n/a' : pipeline.storageCapActive ? 'Yes' : 'No'} accent={pipeline.storageCapActive === true ? 'warning' : undefined} />
              </div>
            </div>

            <div className="mt-3 border-t border-border/40 pt-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Instrument registry cache
              </p>
              <div className="grid grid-cols-2 gap-2">
                <MetricChip label="Entries" value={renderCount(pipeline.registryCacheEntries)} accent="purple" icon={Database} />
                <MetricChip label="Refreshes" value={renderCount(pipeline.registryCacheRefreshes)} accent="info" icon={RefreshCw} />
              </div>
            </div>
          </Panel>

          <Panel className="p-3.5">
            <p className="mb-2.5 text-xs font-bold">Buffer &amp; flush</p>
            <Ring
              value={buffer?.bufferLength != null ? Math.min(100, (buffer.bufferLength / 10_000) * 100) : null}
              accent="primary"
              size={124}
              thickness={11}
              label="Buffered"
              live={true}
            />
            <div className="mt-2 space-y-0.5">
              <Readout label="Buffer length" value={buffer?.bufferLength != null ? fmtQty(buffer.bufferLength) : 'n/a'} />
              <Readout label="Ticks received" value={buffer?.totalReceived != null ? fmtQty(buffer.totalReceived) : 'n/a'} />
              <Readout label="Total written" value={buffer?.totalWritten != null ? fmtQty(buffer.totalWritten) : 'n/a'} />
              <Readout label="Write errors" value={buffer?.totalWriteErrors != null ? fmtQty(buffer.totalWriteErrors) : 'n/a'} accent={(buffer?.totalWriteErrors ?? 0) > 0 ? 'danger' : undefined} />
              <Readout label="Writes per second" value={buffer?.writesPerSecond != null ? String(buffer.writesPerSecond) : 'n/a'} />
              <Readout label="Last flush took" value={fmtMs(buffer?.lastFlushDurationMs)} />
              <Readout label="Last write" value={fmtDateTime(buffer?.lastWriteAt, 'no writes yet')} />
            </div>
          </Panel>
        </div>
      </section>

      {/* ================= MARKET DATA PLANE ================= */}
      <section aria-label="Market data plane" className="space-y-1">
        <SectionHead
          icon={TrendingUp}
          title="Market Data Plane"
          caption="Universe coverage, ranking cadence and instrument freshness"
          accent="teal"
        />
        <div className="grid grid-cols-1 items-start gap-1 lg:grid-cols-3">
          <Panel className="p-3.5">
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
              <Pill label={marketPlane.feedState ?? 'feed n/a'} accent={marketPlane.feedState === 'CONNECTED' || marketPlane.feedState === 'SUBSCRIBED' ? 'success' : marketPlane.feedState ? 'warning' : 'neutral'} live={marketPlane.feedState === 'CONNECTED'} />
              <Pill label={marketPlane.lifecycleState ?? 'lifecycle n/a'} accent="info" />
              {marketPlane.websocketStatus ? <Pill label={marketPlane.websocketStatus} accent="teal" /> : null}
            </div>

            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Instrument freshness
            </p>
            <SplitBar
              parts={[
                { id: 'live', label: 'Live', value: marketPlane.live ?? 0, accent: 'success' },
                { id: 'pending', label: 'Pending', value: marketPlane.pending ?? 0, accent: 'info' },
                { id: 'stale', label: 'Stale', value: marketPlane.stale ?? 0, accent: 'warning' },
                { id: 'nodata', label: 'No data', value: marketPlane.noData ?? 0, accent: 'danger' },
              ]}
              height={10}
            />
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <MetricChip label="Live" value={renderCount(marketPlane.live)} accent="success" icon={HeartPulse} />
              <MetricChip label="Stale" value={renderCount(marketPlane.stale)} accent={(marketPlane.stale ?? 0) > 0 ? 'warning' : 'neutral'} icon={Clock} />
              <MetricChip label="No data" value={renderCount(marketPlane.noData)} accent={(marketPlane.noData ?? 0) > 0 ? 'danger' : 'neutral'} icon={AlertTriangle} />
              <MetricChip label="Pending" value={renderCount(marketPlane.pending)} accent="info" icon={Layers} />
            </div>

            {/* The market watch engine's own ingress counters — the numbers that
                explain where its received ticks ended up. */}
            <div className="mt-3 border-t border-border/40 pt-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Tick validation
              </p>
              <div className="grid grid-cols-2 gap-2">
                <MetricChip label="Received" value={renderCount(marketPlane.receivedTicks)} accent="info" icon={Radio} />
                <MetricChip label="Validated" value={renderCount(marketPlane.validatedTicks)} accent="success" icon={CheckCircle2} />
                <MetricChip label="Invalid" value={renderCount(marketPlane.invalidTicks)} accent={(marketPlane.invalidTicks ?? 0) > 0 ? 'warning' : 'neutral'} icon={ShieldCheck} />
                <MetricChip label="Out of universe" value={renderCount(marketPlane.outOfUniverse)} accent="purple" icon={Layers} />
              </div>
            </div>
          </Panel>

          <Panel className="p-3.5">
            <p className="mb-2.5 text-xs font-bold">Universe &amp; subscriptions</p>

            {/* Universe coverage measured against the engine's OWN target — the
                one number that says whether it is doing its job. */}
            <div className="mb-2.5 flex items-center gap-3 rounded-xl border border-border/50 bg-background/40 p-2.5">
              <Ring
                value={marketPlane.eligibleStates}
                max={marketPlane.eligibleTarget}
                accent={
                  marketPlane.eligibleStates == null || marketPlane.eligibleTarget == null
                    ? 'neutral'
                    : marketPlane.eligibleStates < (marketPlane.lowUniverseWarning ?? 0)
                      ? 'danger'
                      : marketPlane.eligibleStates < (marketPlane.eligibleTarget ?? 0)
                        ? 'warning'
                        : 'success'
                }
                size={92}
                thickness={9}
                label="Coverage"
                live={true}
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  <span className="font-mono font-bold text-foreground">{renderCount(marketPlane.eligibleStates)}</span>{' '}
                  eligible against a target of{' '}
                  <span className="font-mono font-bold text-foreground">{renderCount(marketPlane.eligibleTarget)}</span>
                </p>
                {marketPlane.universeState ? (
                  <Pill
                    label={prettyState(marketPlane.universeState)}
                    accent={
                      marketPlane.universeState.includes('CRITICAL')
                        ? 'danger'
                        : marketPlane.universeState.includes('LOW')
                          ? 'warning'
                          : 'success'
                    }
                  />
                ) : null}
                <p className="text-[9px] text-muted-foreground/80">
                  Warn below {renderCount(marketPlane.lowUniverseWarning)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <MetricChip label="Eligible" value={renderCount(marketPlane.universe)} accent="teal" icon={Layers} />
              <MetricChip label="Subscribed" value={renderCount(marketPlane.subscribed)} accent="info" icon={Radio} />
              <MetricChip label="Watchable" value={renderCount(marketPlane.watchable)} accent="primary" icon={Target} />
              <MetricChip label="Ticks seen" value={renderCount(marketPlane.tickCount)} accent="primary" icon={Activity} />
              <MetricChip label="Persisted" value={renderCount(marketPlane.persisted)} accent="purple" icon={HardDrive} />
              <MetricChip label="Suppressed" value={renderCount(marketPlane.suppressed)} accent={(marketPlane.suppressed ?? 0) > 0 ? 'warning' : 'neutral'} icon={ShieldCheck} />
              <MetricChip label="Price capped" value={renderCount(marketPlane.priceCapped)} accent={(marketPlane.priceCapped ?? 0) > 0 ? 'warning' : 'neutral'} icon={Target} />
              <MetricChip label="Ranking blocks" value={renderCount(marketPlane.blocksRecorded)} accent="teal" icon={Layers} />
            </div>

            <div className="mt-3 border-t border-border/40 pt-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Pin changes
              </p>
              <div className="grid grid-cols-2 gap-2">
                <MetricChip label="Gainers" value={renderCount(marketPlane.gainerPins)} accent="success" icon={TrendingUp} />
                <MetricChip label="Losers" value={renderCount(marketPlane.loserPins)} accent="danger" icon={TrendingUp} />
              </div>
            </div>

            <div className="mt-3 border-t border-border/40 pt-2.5">
              <Readout label="Price cap" value={marketPlane.priceCap != null ? `\u20B9${fmtQty(marketPlane.priceCap)}` : 'n/a'} />
              <Readout label="Index version" value={marketPlane.indexVersion != null ? String(marketPlane.indexVersion) : 'n/a'} />
              <Readout label="Ranking interval" value={marketPlane.rankingEvery != null ? `${marketPlane.rankingEvery}s` : 'n/a'} />
              <Readout label="Stale threshold" value={marketPlane.staleThreshold != null ? `${marketPlane.staleThreshold}s` : 'n/a'} />
            </div>
          </Panel>

          <Panel className="p-3.5">
            <p className="mb-2.5 text-xs font-bold">Latency budget</p>
            <div className="grid grid-cols-3 gap-2">
              <MetricChip label="Ranking" value={marketPlane.rankingMs != null ? fmtMs(marketPlane.rankingMs) : 'n/a'} accent={(marketPlane.rankingMs ?? 0) > 2000 ? 'warning' : 'success'} icon={Gauge} />
              <MetricChip label="Processing" value={marketPlane.processingMs != null ? fmtMs(marketPlane.processingMs) : 'n/a'} accent="info" icon={Zap} />
              <MetricChip label="Publish" value={marketPlane.publishMs != null ? fmtMs(marketPlane.publishMs) : 'n/a'} accent="purple" icon={Signal} />
            </div>

            <div className="mt-3 flex items-center gap-3 rounded-xl border border-border/50 bg-background/40 p-2.5">
              <Ring
                value={marketPlane.recoveryCandles}
                max={Math.max(10, (marketPlane.recoveryCandles ?? 0) * 2)}
                accent={(marketPlane.recoveryIncomplete as boolean) === true ? 'warning' : 'success'}
                size={84}
                thickness={8}
                label="Recovery"
              />
              <div className="min-w-0 text-[10px] leading-relaxed text-muted-foreground">
                <p>
                  Recovery candles backfilled:{' '}
                  <span className="font-mono font-bold text-foreground">{renderCount(marketPlane.recoveryCandles)}</span>
                </p>
                <p className="mt-0.5">
                  Backfill{' '}
                  <span className={(marketPlane.recoveryIncomplete as boolean) === true ? 'font-semibold text-warning' : 'font-semibold text-success'}>
                    {(marketPlane.recoveryIncomplete as boolean) === true ? 'incomplete' : 'complete'}
                  </span>
                </p>
              </div>
            </div>
          </Panel>
        </div>
      </section>

      {/* ================= CONNECTION & ALERTING ================= */}
      <section aria-label="Connections and alerting" className="space-y-1">
        <SectionHead
          icon={BellRing}
          title="Connections and alerting"
          caption="Message routing, session broker reachability and the alerting plane"
          accent="warning"
        />
        <div className="grid grid-cols-1 items-start gap-1 lg:grid-cols-3">
          <Panel className="p-3.5">
            <div className="mb-2.5 flex items-center justify-between">
              <p className="text-xs font-bold">Connection Manager</p>
              <Pill
                label={connectionPlane.freshness ?? 'freshness n/a'}
                accent={connectionPlane.freshness === 'FRESH' || connectionPlane.freshness === 'LIVE' ? 'success' : connectionPlane.freshness ? 'warning' : 'neutral'}
                live={connectionPlane.freshness === 'FRESH' || connectionPlane.freshness === 'LIVE'}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MetricChip label="Sessions" value={renderCount(connectionPlane.sessions)} accent="info" icon={Server} />
              <MetricChip label="Connections" value={renderCount(connectionPlane.connections)} accent="teal" icon={Wifi} />
              <MetricChip label="Frames routed" value={renderCount(connectionPlane.framesRouted)} accent="primary" icon={Workflow} />
              <MetricChip label="Delivered" value={renderCount(connectionPlane.delivered)} accent="success" icon={CheckCircle2} />
              <MetricChip label="Dropped" value={renderCount(connectionPlane.dropped)} accent={(connectionPlane.dropped ?? 0) > 0 ? 'danger' : 'neutral'} icon={AlertTriangle} />
              <MetricChip label="Last tick" value={fmtAgoSec(connectionPlane.feedAgeSec)} accent={(connectionPlane.feedAgeSec ?? 0) > 30 ? 'warning' : 'success'} icon={Clock} />
            </div>
          </Panel>

          <Panel className="p-3.5">
            <p className="mb-2.5 text-xs font-bold">Alerts &amp; notifications</p>
            <div className="flex items-center justify-around gap-2">
              <Ring
                value={alertPlane.activeAlerts}
                max={Math.max(5, (alertPlane.activeAlerts ?? 0) * 2)}
                accent={(alertPlane.activeAlerts ?? 0) > 0 ? 'warning' : 'success'}
                size={104}
                thickness={9}
                label="Active alerts"
                live={(alertPlane.activeAlerts ?? 0) > 0}
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <MetricChip label="Unread" value={renderCount(alertPlane.unread)} accent="info" icon={Bot} />
                <MetricChip label="Audit events" value={renderCount(alertPlane.auditEvents)} accent="purple" icon={ShieldCheck} />
                <MetricChip label="Storage history" value={renderCount(alertPlane.historyLength)} accent="primary" icon={Layers} />
              </div>
            </div>
            <div className="mt-2.5 border-t border-border/40 pt-2">
              <Readout label="Storage sample took" value={alertPlane.sampleMs != null ? fmtMs(alertPlane.sampleMs) : 'n/a'} />
              <Readout label="Storage sample errors" value={renderCount(alertPlane.sampleErrors)} accent={(alertPlane.sampleErrors ?? 0) > 0 ? 'warning' : undefined} />
              <Readout label="Price targets tracked" value={renderCount(alertPlane.targets)} />
            </div>
          </Panel>

          <Panel className="p-3.5">
            <p className="mb-2.5 text-xs font-bold">Host pressure</p>
            <div className="space-y-1">
              {[
                { label: 'CPU', pct: cpuPct, accent: 'teal' as Accent },
                { label: 'Memory', pct: ramPct, accent: 'info' as Accent },
                { label: 'Storage', pct: diskPct, accent: 'purple' as Accent },
              ].map((r) => (
                <div key={r.label}>
                  <div className="mb-1 flex items-center justify-between text-[10px]">
                    <span className="font-semibold text-muted-foreground">{r.label}</span>
                    <span className="font-mono font-bold tabular-nums">{fmtPct1(r.pct)}</span>
                  </div>
                  <Meter pct={r.pct} accent={loadAccent(r.pct) === 'bad' ? 'danger' : loadAccent(r.pct) === 'warn' ? 'warning' : r.accent} threshold={85} label={`${r.label} — warn at 85%`} />
                </div>
              ))}
            </div>

            <div className="mt-3 border-t border-border/40 pt-2">
              <Readout label="Load average 1m" value={node?.cpuLoad1m != null ? node.cpuLoad1m.toFixed(2) : 'n/a'} />
              <Readout label="Load average 5m" value={node?.cpuLoad5m != null ? node.cpuLoad5m.toFixed(2) : 'n/a'} />
              <Readout label="Load average 15m" value={node?.cpuLoad15m != null ? node.cpuLoad15m.toFixed(2) : 'n/a'} />
              <Readout label="Free memory" value={fmtBytes(node?.ramFreeBytes)} />
            </div>
          </Panel>
        </div>
      </section>

      {/* ================= INFRASTRUCTURE ================= */}
      <section aria-label="Infrastructure" className="space-y-1">
        <SectionHead
          icon={Server}
          title="Infrastructure"
          caption="The runtime each backend service sits on"
          accent="info"
          count={`${infraCards.length} services`}
        />
        <div className="grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
          {infraCards.map((c) => (
            <InfraCard key={c.name} {...c} />
          ))}
        </div>
      </section>

      {/* ================= PERFORMANCE ================= */}
      <section aria-label="Performance" className="space-y-1">
        <SectionHead
          icon={Gauge}
          title="Performance"
          caption="Round-trip timings and the background tick writer"
          accent="purple"
        />
        <div className="grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
          {perfCards.map((c) => (
            <InfraCard key={c.name} {...c} />
          ))}
        </div>
      </section>

      {/* ================= APPLICATION SERVICES ================= */}
      <section aria-label="Application services" className="space-y-1">
        <SectionHead
          icon={Bot}
          title="Application Services"
          caption="Broker session and the four live trading endpoints"
          accent="warning"
          count={`${serviceCards.length} endpoints`}
        />
        <div className="grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
          {serviceCards.map((c) => (
            <InfraCard key={c.name} {...c} />
          ))}
        </div>
      </section>

      <Panel className="p-3" style={{ backgroundImage: 'linear-gradient(120deg, hsl(var(--info) / 0.08), transparent 55%)' }}>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">Live data.</span> Every readout on this page is
          sourced from the Python/FastAPI backend and the engine registry in real time — nothing is cached,
          simulated or estimated. Metrics the backend does not expose are shown as{' '}
          <span className="font-mono font-semibold text-foreground">n/a</span> rather than filled in with a
          guess, because on a health page a fabricated number is worse than a blank one.
        </p>
      </Panel>
    </div>
  );
}
