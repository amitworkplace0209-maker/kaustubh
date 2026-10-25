'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity, AlertTriangle, ArrowUpRight, CheckCircle2, Copy, Database, Download, Gauge,
  HardDrive, HeartPulse, Layers, Play, Power, RefreshCw, RotateCw, SendHorizontal,
  Server, Stethoscope, Timer, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useEngineStatus } from '@/lib/engine-realtime';
import { cn } from '@/lib/utils';

/**
 * SERVICES → DB Writer — OVERVIEW (engine controls + snapshot cards).
 *
 * This is FOUR pages now: overview (this file, WS#2 engine channel) ·
 * storage (day-wise + all-time, /db_writer_engine/storage) · permissions
 * (GET/PUT tick-persistence) · settings (/api/settings explorer). Every page
 * keeps its OWN data connection; this page only READS the engine snapshot and
 * the DB monitoring plane — permission switches live on the Permissions page.
 *
 * Persistence layer: tick pipeline (bounded buffer → MongoDB bulk writes) +
 * audit pipeline. Live status over WS#2 (`engines` channel), REST fallback
 * once. Nothing fabricated — missing renders as '—'.
 *
 * Buttons (all real backend calls):
 *  Flush · Restart · Start · Stop (2-click confirm) · Heartbeat ping ·
 *  Health-check · Copy snapshot · CSV.
 */

const ENGINE = '/api/services/engines/db_writer_engine';
const ENGINES = '/api/services/engines';

const PERMISSIONS = [
  {
    key: 'personalNoExpiry',
    label: 'Personal Stocks — No Expiry',
    description: 'Ticks for personally subscribed instruments with a permanent, non-expiring subscription.',
  },
  {
    key: 'personalOneDay',
    label: 'Personal Stocks — 1-Day Expiry',
    description: 'Ticks for personally subscribed instruments whose subscription expires (1-day lifecycle).',
  },
  {
    key: 'marketWatchOneDay',
    label: 'Market Watch Stocks — 1-Day',
    description: 'Ticks for the Market Watch active universe. Market Watch offers the tick; the DB Writer alone decides to store it.',
  },
] as const;

type PermissionState = {
  label?: string;
  settingKey?: string;
  enabled?: boolean;
  configuredEnabled?: boolean;
  hardCapped?: boolean;
  capSettingKey?: string;
  capEnvKey?: string;
  accepted?: number;
  skipped?: number;
};

const DROP_REASON_LABELS: Record<string, string> = {
  PERMISSION_GRANTED: 'saved (permission granted)',
  NOT_ALLOWED_SOURCE: 'not in the active stock registry',
  EXPIRED_STOCK: 'subscription expired',
  INACTIVE_STOCK: 'instrument deactivated',
  INVALID_TICK: 'malformed tick from the feed',
  PERSISTENCE_DISABLED: 'permission is off',
  STORAGE_CAPPED: 'blocked by the storage cap',
  DUPLICATE: 'duplicate tick',
  QUEUE_REJECTED: 'buffer full, tick not queued',
  DATABASE_ERROR: 'MongoDB write error',
};

const DROP_REASON_ORDER = [
  'NOT_ALLOWED_SOURCE',
  'EXPIRED_STOCK',
  'INACTIVE_STOCK',
  'INVALID_TICK',
  'PERSISTENCE_DISABLED',
  'STORAGE_CAPPED',
  'DUPLICATE',
  'QUEUE_REJECTED',
  'DATABASE_ERROR',
  'PERMISSION_GRANTED',
] as const;

const DROP_BAR: Record<string, string> = {
  PERMISSION_GRANTED: '#34d399',
  NOT_ALLOWED_SOURCE: '#94a3b8',
  EXPIRED_STOCK: '#fbbf24',
  INACTIVE_STOCK: '#71717a',
  INVALID_TICK: '#fb7185',
  PERSISTENCE_DISABLED: '#64748b',
  STORAGE_CAPPED: '#f59e0b',
  DUPLICATE: '#22d3ee',
  QUEUE_REJECTED: '#f97316',
  DATABASE_ERROR: '#ef4444',
};

function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN');
}

function fmtTs(iso?: string | number | null): string {
  if (iso == null || iso === '') return '—';
  // Backend stamps are epoch SECONDS (time.time()); a number < 1e12 is
  // seconds, >= is milliseconds. Both render as real IST wall-clock time.
  const ms = typeof iso === 'number' ? (iso < 1e12 ? iso * 1000 : iso) : new Date(iso).getTime();
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })
    : '—';
}

/** Full date+time IST (for persisted ledger rows that can be older than today). */
function fmtDayTs(iso?: string | number | null): string {
  if (iso == null || iso === '') return '—';
  const ms = typeof iso === 'number' ? (iso < 1e12 ? iso * 1000 : iso) : new Date(iso).getTime();
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })
    : '—';
}

/** Tiny SVG trend line of REAL backend-reported values (no client math). */
function Spark({ values, tone = '#0d9488', width = 64, height = 20 }: { values: number[]; tone?: string; width?: number; height?: number }) {
  if (values.length < 2) return <span style={{ width, height }} className="inline-block shrink-0" aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  return (
    <svg width={width} height={height} className="shrink-0" aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke={tone} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="1.8" fill={tone} />
    </svg>
  );
}

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

export default function DbWriterOverviewPage() {
  const { data, error, refresh } = useEngineStatus<any>('db_writer_engine', ENGINE);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [copied, setCopied] = useState(false);
  const [collections, setCollections] = useState<any>(null);
  const [ping, setPing] = useState<any>(null);
  const [pinging, setPinging] = useState(false);
  // Bounded client rings of REAL pushed engine values → KPI sparklines.
  const historyRef = useRef<Record<string, number[]>>({ tps: [], writes: [], buffer: [] });
  const [sparks, setSparks] = useState<Record<string, number[]>>({ tps: [], writes: [], buffer: [] });

  const say = useCallback((kind: 'ok' | 'err', text: string) => setNotice({ kind, text }), []);

  const loadCollections = useCallback(async () => {
    try {
      const r = await fetch('/api/database/collections', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setCollections(j.data);
    } catch {
      /* ignore */
    }
  }, []);

  // collStats runs one Mongo command per collection — heavy..refreshing on
  // every WS push would hammer the database, so: mount + 30 s interval +
  // explicitly after flush/actions instead of on every engine snapshot.
  useEffect(() => {
    void loadCollections();
    const t = setInterval(() => void loadCollections(), 30000);
    return () => clearInterval(t);
  }, [loadCollections]);

  /** Real MongoDB reachability probe (ping + collection count, server-side). */
  const dbPing = useCallback(async () => {
    setPinging(true);
    try {
      const r = await fetch('/api/database/ping', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      setPing(j?.ok ? j.data : { ok: false, error: j?.error ?? `HTTP ${r.status}` });
    } catch (e: unknown) {
      setPing({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setPinging(false);
    }
  }, []);

  /** Generic engine POST button helper (flush/restart/start/stop/heartbeat/health-check). */
  const runAction = useCallback(async (name: string, path: string, body?: unknown, okText?: string) => {
    setBusy(name);
    setNotice(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const json = await res.json().catch(() => ({}));
      if (json.ok && res.ok) say('ok', okText ?? `${name} done.`);
      else if (json.requiresConfirmation) {
        setConfirmStop(true);
        say('err', `${name}: confirmation required — dobara dabao.`);
      } else say('err', json.error ?? `HTTP ${res.status}`);
    } catch (e: unknown) {
      say('err', e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
    refresh();
  }, [say, refresh]);

  const flush = () => { void runAction('Flush', `${ENGINE}/flush`, {}, 'Flush done.').then(() => void loadCollections()); };
  const restart = () => runAction('Restart', `${ENGINES}/db_writer_engine/restart`, {}, 'Restart requested.');
  const start = () => runAction('Start', `${ENGINES}/db_writer_engine/start`, {}, 'Start requested.');
  const stop = () => {
    if (!confirmStop) {
      void runAction('Stop', `${ENGINES}/db_writer_engine/stop`, {});
      return;
    }
    setConfirmStop(false);
    void runAction('Stop', `${ENGINES}/db_writer_engine/stop`, { confirm: true }, 'Stop confirmed.');
  };
  const heartbeat = () => runAction('Heartbeat', `${ENGINES}/db_writer_engine/heartbeat`, {}, 'Heartbeat OK.');
  const healthCheck = async () => {
    setBusy('Health-check');
    setNotice(null);
    try {
      const res = await fetch(`${ENGINES}/health-check`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (json.ok && res.ok) {
        const n = Object.keys(json.data ?? {}).length;
        say('ok', `Health-check: ${n} engines reported.`);
      } else say('err', json.error ?? `HTTP ${res.status}`);
    } catch (e: unknown) {
      say('err', e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const copySnapshot = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const exportDrops = () => {
    const reasons = (data?.tickPersistence?.dropReasons ?? {}) as Record<string, number>;
    const rows = DROP_REASON_ORDER.filter((c) => (reasons[c] ?? 0) > 0);
    if (!rows.length) return;
    const csv = `code,label,count\n${rows.map((c) => `${c},"${DROP_REASON_LABELS[c]}",${reasons[c]}`).join('\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'db-writer-drop-reasons.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const p = data?.pipeline ?? {};
  const bufferLen = Number(p.bufferLength ?? 0);
  const hardCap = Number(data?.configSummary?.bufferHardCap ?? p.bufferHardCap ?? 0);
  const pct = hardCap > 0 ? Math.min(100, (bufferLen / hardCap) * 100) : 0;
  const running = p.pipelineRunning === true;
  const writeErrors = Number(p.totalWriteErrors ?? 0);
  const health = data?.health ?? 'UNKNOWN';
  const healthOk = health === 'HEALTHY';
  const healthBad = health === 'UNHEALTHY';
  const reasons = (data?.tickPersistence?.dropReasons ?? {}) as Record<string, number>;
  const decided = DROP_REASON_ORDER.map((c) => ({ code: c, n: Number(reasons[c] ?? 0) })).filter((r) => r.n > 0);
  const maxDrop = Math.max(1, ...decided.map((r) => r.n));
  const perms = (data?.tickPersistence?.permissions ?? {}) as Record<string, PermissionState>;
  const onCount = PERMISSIONS.filter(({ key }) => perms[key]?.enabled === true).length;
  // Master kill-switch (backend-reported; fallback ON for old snapshots).
  const master = (data?.tickPersistence as any)?.master as { enabled?: boolean; configuredEnabled?: boolean; settingKey?: string } | undefined;
  const masterOn = master ? master.enabled !== false : true;
  const effectiveSaving = (data?.tickPersistence as any)?.effectiveSaving ?? (masterOn && onCount > 0);

  // Sparkline rings: every WS#2 engine snapshot pushes REAL reported values
  // into bounded rings; the KPI tiles render those — nothing is computed
  // client-side beyond plotting what the backend actually said.
  useEffect(() => {
    if (!data) return;
    const push = (k: string, v: number | null | undefined) => {
      if (v == null || !Number.isFinite(v)) return;
      const ring = historyRef.current[k] ?? [];
      ring.push(Number(v));
      if (ring.length > 24) ring.splice(0, ring.length - 24);
      historyRef.current[k] = ring;
    };
    push('tps', Number(p.ticksPerSecond ?? NaN));
    push('writes', Number(p.writesPerSecond ?? NaN));
    push('buffer', hardCap > 0 ? (bufferLen / hardCap) * 100 : null);
    setSparks({
      tps: [...(historyRef.current.tps ?? [])],
      writes: [...(historyRef.current.writes ?? [])],
      buffer: [...(historyRef.current.buffer ?? [])],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ---- real payload slices for the detail cards (all optional-honest) ----
  const flushHistory = (Array.isArray(data?.flushHistory) ? data.flushHistory : []) as any[];
  const lastDecision = (data?.lastDecision ?? null) as any;
  const loss = (data?.dataLossAccounting ?? null) as any;
  const latency = (data?.pipelineLatency ?? null) as any;
  const latencyStages = Object.entries(((latency?.stages ?? {}) as Record<string, any>))
    .sort((a, b) => String(a[1]?.bucket ?? '').localeCompare(String(b[1]?.bucket ?? '')));
  const latencyRejected = Object.values(((latency?.rejectedSamples ?? {}) as Record<string, number>))
    .reduce((s: number, n) => s + (Number(n) || 0), 0);
  const mw = (data?.marketWatch ?? null) as any;
  const instr = Object.entries(((data?.instruments ?? {}) as Record<string, any>))
    .map(([token, t]) => ({ token, ...(t as any) }))
    .sort((a, b) => (Number.isFinite(Number(a.lastTickAgeSec)) ? Number(a.lastTickAgeSec) : Infinity)
      - (Number.isFinite(Number(b.lastTickAgeSec)) ? Number(b.lastTickAgeSec) : Infinity));

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-teal-500/[0.12] via-primary/[0.06] to-emerald-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-teal-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-emerald-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 via-primary to-emerald-500 text-white shadow-xl">
            <Database className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">DB Writer Engine</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground sm:text-sm">
              {data?.engineName ?? 'db_writer_engine'} · v{data?.version ?? '—'} · tick pipeline → MongoDB bulk writes
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data?.health && (
              <Badge className={healthOk ? 'border border-emerald-500/40 bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 text-emerald-700' : healthBad ? 'border border-rose-500/40 bg-rose-500/15 text-rose-700' : 'border border-amber-500/40 bg-amber-500/10 text-amber-700'}>
                <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', healthOk ? 'animate-pulse bg-emerald-500' : healthBad ? 'bg-rose-500' : 'bg-amber-500')} />
                {health}
              </Badge>
            )}
            <Badge variant="outline" className={cn('tabular-nums', running ? 'border-emerald-500/40 text-emerald-700' : 'border-amber-500/40 text-amber-700')}>
              {running ? '● RUNNING' : '○ STOPPED'}
            </Badge>
            <Badge variant="outline" className={cn('tabular-nums font-mono', effectiveSaving ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/40 bg-rose-500/10 text-rose-700')}>
              {effectiveSaving ? 'SAVING ON — DB me write ho raha' : 'SAVING OFF — DB write rukha hai'}
            </Badge>
            {notice && <Badge variant="outline" className={notice.kind === 'ok' ? 'border-emerald-500/40 text-emerald-700' : 'border-rose-500/40 text-rose-700'}>{notice.text}</Badge>}
            <IstClock />
            <Button size="sm" onClick={() => refresh()} className="gap-1.5 bg-gradient-to-r from-teal-500 to-emerald-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
        {/* buffer breadth bar */}
        <div className="relative h-2 w-full overflow-hidden bg-muted/60">
          <span className={cn('block h-full bg-gradient-to-r transition-all', pct > 80 ? 'from-rose-500 to-rose-400' : pct > 50 ? 'from-amber-500 to-amber-400' : 'from-emerald-500 to-teal-400')} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
          <span className="min-w-0">Engine reachable: {error}</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => refresh()}>Retry</Button>
        </div>
      )}
      {!data && !error && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-muted/60" />)}
          <p className="py-1 text-center text-xs text-muted-foreground">Loading DB Writer Engine…</p>
        </div>
      )}

      {data && (
        <>
          {/* CONTROL BUTTONS */}
          <Card className="overflow-hidden border-teal-500/25 shadow-soft">
            <CardHeader className="bg-gradient-to-r from-teal-500/10 to-emerald-500/5 pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 p-1.5 text-white shadow"><Power className="h-3.5 w-3.5" /></span>
                Engine controls · real actions
                <span className="ml-auto text-[11px] font-normal text-muted-foreground">stop needs 2-click confirm</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2 pt-3">
              <Button size="sm" onClick={flush} disabled={busy != null} className="gap-1.5 bg-gradient-to-r from-teal-500 to-emerald-600">
                <SendHorizontal className="h-3.5 w-3.5" /> {busy === 'Flush' ? 'Flushing…' : 'Flush now'}
              </Button>
              <Button size="sm" variant="outline" onClick={restart} disabled={busy != null} className="gap-1.5">
                <RotateCw className={cn('h-3.5 w-3.5', busy === 'Restart' && 'animate-spin')} /> {busy === 'Restart' ? 'Restarting…' : 'Restart'}
              </Button>
              <Button size="sm" variant="outline" onClick={start} disabled={busy != null} className="gap-1.5">
                <Play className="h-3.5 w-3.5" /> Start
              </Button>
              <Button size="sm" variant={confirmStop ? 'destructive' : 'outline'} onClick={stop} disabled={busy != null} className="gap-1.5">
                <Power className="h-3.5 w-3.5" /> {confirmStop ? 'Confirm stop?' : 'Stop'}
              </Button>
              <Button size="sm" variant="outline" onClick={heartbeat} disabled={busy != null} className="gap-1.5">
                <HeartPulse className="h-3.5 w-3.5" /> Heartbeat
              </Button>
              <Button size="sm" variant="outline" onClick={healthCheck} disabled={busy != null} className="gap-1.5">
                <Stethoscope className="h-3.5 w-3.5" /> {busy === 'Health-check' ? 'Checking…' : 'Health-check'}
              </Button>
              <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
              <Link
                href="/services/db-writer/permissions"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted/60"
              >
                <ArrowUpRight className="h-3.5 w-3.5" /> Permission desk (read-only yahan)
              </Link>
              <Button size="sm" variant="ghost" onClick={copySnapshot} className="ml-auto gap-1.5">
                {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy snapshot'}
              </Button>
            </CardContent>
          </Card>

          {/* PERMISSIONS STRIP — READ-ONLY preview (control: Permissions page) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {PERMISSIONS.map(({ key, label }, i) => {
              const perm = perms[key] ?? {};
              const on = perm.enabled === true;
              const bar = ['bg-emerald-500', 'bg-cyan-500', 'bg-violet-500'][i];
              return (
                <Card key={key} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-0.5">
                  <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', on ? bar : 'bg-muted-foreground/30')} />
                  <CardContent className="flex items-center gap-3 p-3.5">
                    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', on ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg' : 'bg-muted/70 text-muted-foreground')}>
                      {on ? <CheckCircle2 className="h-5 w-5" /> : <X className="h-5 w-5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                      <p className={cn('font-mono text-lg font-bold tabular-nums leading-7', on ? 'text-emerald-700' : 'text-muted-foreground')}>{on ? 'ON' : 'OFF'}</p>
                      <p className="truncate font-mono text-[10px] tabular-nums text-muted-foreground">
                        {fmtNum(perm.accepted)} accepted · {fmtNum(perm.skipped)} skipped{perm.hardCapped ? ' · CAPPED' : ''}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/services/db-writer/permissions"
              className="inline-flex items-center gap-1 rounded-lg border border-teal-500/40 bg-teal-500/10 px-2.5 py-1 text-xs font-semibold text-teal-700 transition-colors hover:bg-teal-500/20"
            >
              <ArrowUpRight className="h-3 w-3" /> Master + stream switches Permissions page par (apna connection)
            </Link>
            <span className="text-[11px] text-muted-foreground">{onCount}/3 ON · ye strip WS#2 snapshot ka read-only preview hai</span>
            {data?.tickPersistence?.storageCapActive && (
              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700">STORAGE CAP ACTIVE</Badge>
            )}
          </div>

          {/* KPI STRIP */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {([
              { icon: Activity, label: 'Pipeline', value: running ? 'RUNNING' : 'STOPPED', sub: `since ${fmtTs(p.pipelineStartedAt)}`, tone: running ? 'text-emerald-700' : 'text-amber-700', bar: running ? 'bg-emerald-500' : 'bg-amber-500', chip: running ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg' : 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg', spark: null as string | null, color: '#059669' },
              { icon: Gauge, label: 'Throughput', value: `${fmtNum(p.ticksPerSecond)}/s`, sub: `${fmtNum(p.totalReceived)} recv · ${fmtNum(p.totalWritten)} written`, tone: 'text-teal-700', bar: 'bg-teal-500', chip: 'bg-gradient-to-br from-teal-500 to-cyan-600 text-white shadow-lg', spark: 'writes', color: '#0d9488' },
              { icon: HardDrive, label: 'Buffer', value: `${pct.toFixed(0)}%`, sub: `${fmtNum(bufferLen)} / ${fmtNum(hardCap)}`, tone: pct > 80 ? 'text-rose-700' : pct > 50 ? 'text-amber-700' : '', bar: pct > 80 ? 'bg-rose-500' : pct > 50 ? 'bg-amber-500' : 'bg-emerald-500', chip: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-lg', spark: 'buffer', color: '#0284c7' },
              { icon: AlertTriangle, label: 'Write errors', value: fmtNum(writeErrors), sub: p.feedLatencyMs?.currentMs != null ? `${Number(p.feedLatencyMs.currentMs).toFixed(1)} ms feed` : health, tone: writeErrors > 0 ? 'text-rose-700' : '', bar: writeErrors > 0 ? 'bg-rose-500' : 'bg-emerald-500', chip: 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-lg', spark: null, color: '#dc2626' },
            ] as const).map((k) => (
              <Card key={k.label} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-0.5">
                <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', k.bar)} />
                <CardContent className="flex items-center gap-3 p-3.5">
                  <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', k.chip)}><k.icon className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.label}</p>
                    <p className={cn('truncate font-mono text-lg font-bold tabular-nums leading-7', k.tone)}>{k.value}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{k.sub}</p>
                  </div>
                  <Spark values={k.spark ? (sparks[k.spark] ?? []) : []} tone={k.color} />
                </CardContent>
              </Card>
            ))}
          </div>

          {/* PIPELINE DETAIL + SAVE/DROP CHART */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-teal-500/10 to-emerald-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
                  Pipeline & throughput · real
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 pt-3 text-xs">
                {([
                  ['Pipeline', running ? 'RUNNING' : 'STOPPED'],
                  ['Started', fmtTs(p.pipelineStartedAt)],
                  ['Last tick', fmtTs(p.lastTickAt)],
                  ['Last write', fmtTs(p.lastWriteAt)],
                  ['Total received', fmtNum(p.totalReceived)],
                  ['Total written', fmtNum(p.totalWritten)],
                  ['Ticks/s', fmtNum(p.ticksPerSecond)],
                  ['Writes/s', fmtNum(p.writesPerSecond)],
                  ['Active instruments', fmtNum(p.activeTickStocks)],
                  ['Last error', p.lastError ?? 'none'],
                ] as [string, string][]).map(([k, v]) => (
                  <p key={k} className="flex items-center justify-between gap-3 rounded-lg border-b border-border/40 px-2 py-1.5">
                    <span className="text-muted-foreground">{k}</span>
                    <span className="truncate text-right font-mono" title={v}>{v}</span>
                  </p>
                ))}
                {data?.lastFlushResult && (
                  <p className="rounded-lg border border-teal-500/25 bg-teal-500/[0.05] px-2.5 py-1.5 font-mono text-[11px]">
                    last flush: written={fmtNum(data.lastFlushResult.written)} · {data.lastFlushResult.durationMs != null ? `${Number(data.lastFlushResult.durationMs).toFixed(1)}ms` : '—'}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-violet-500/10 to-purple-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
                  Save / drop decisions · engine counters
                  <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 px-2 text-[11px]" onClick={exportDrops} disabled={!decided.length}>
                    <Download className="h-3 w-3" /> CSV
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 pt-3">
                {!decided.length ? (
                  <p className="py-4 text-center text-[11px] text-muted-foreground">No tick decided yet — feed ne start ke baad koi tick offer nahi kiya.</p>
                ) : decided.map((r) => (
                  <div key={r.code} title={DROP_REASON_LABELS[r.code]}>
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate"><code className="font-mono text-[10px]">{r.code}</code> <span className="text-muted-foreground">— {DROP_REASON_LABELS[r.code]}</span></span>
                      <span className="shrink-0 font-mono font-bold tabular-nums">{fmtNum(r.n)}</span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted/70">
                      <div className="h-full rounded-full" style={{ width: `${(r.n / maxDrop) * 100}%`, background: DROP_BAR[r.code] ?? '#38bdf8' }} />
                    </div>
                  </div>
                ))}
                <p className="pt-1 text-[11px] text-muted-foreground">
                  Overlapping deduped: {fmtNum(data.tickPersistence.overlappingSourcesDeduped)} · unknown source rejected: {fmtNum(data.tickPersistence.unknownSourceSkipped)}
                </p>
                {lastDecision && (
                  <p className="rounded-lg border border-border/40 bg-muted/30 px-2.5 py-1.5 font-mono text-[10px] tabular-nums">
                    last decision: <span className={cn('font-bold', lastDecision.persist ? 'text-emerald-700' : 'text-amber-700')}>{lastDecision.persist ? 'SAVE' : 'DROP'} · {lastDecision.reasonCode}</span>
                    {lastDecision.symbol ? ` · ${lastDecision.symbol}` : ''} @ {fmtDayTs(lastDecision.at)}
                    {lastDecision.overlapping ? ' (overlapping → ek hi document)' : ''}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* FLUSH HISTORY + TRUE PIPELINE LATENCY (real ledgers) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-teal-500/10 to-cyan-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-teal-500 to-cyan-600 p-1.5 text-white shadow"><Timer className="h-3.5 w-3.5" /></span>
                  Flush history · actual MongoDB writes (bounded ledger)
                  <Badge variant="outline" className="ml-auto font-mono">{fmtNum(flushHistory.length)} entries</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {flushHistory.length ? (
                  <div className="space-y-1">
                    {flushHistory.slice(0, 12).map((row: any, i: number) => (
                      <div key={`${row.at}-${i}`} className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-2 py-1 font-mono text-[10px] tabular-nums">
                        <span className="shrink-0 text-muted-foreground">{fmtDayTs(row.at)}</span>
                        <span className={cn('font-bold', Number(row.failed) > 0 ? 'text-rose-600' : 'text-emerald-700')}>{fmtNum(row.written)} written{Number(row.failed) > 0 ? ` · ${fmtNum(row.failed)} failed` : ''}</span>
                        <span className="text-muted-foreground">batch {fmtNum(row.batch)} · {row.durationMs != null ? `${Number(row.durationMs).toFixed(1)} ms` : '—'}</span>
                      </div>
                    ))}
                    <p className="pt-1 text-[10px] text-muted-foreground">
                      Naya ledger: har real bulk-write ka outcome bounded ring (25) me. Purane lifetime totals ke saath reconcile: {fmtNum(p.totalWritten)} total.
                    </p>
                  </div>
                ) : (
                  <p className="py-4 text-center text-[11px] text-muted-foreground">
                    Abhi koi write hua hi nahi (buffer khali tha). Flush karke dekho — turant ek real row aayegi.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-sky-500/10 to-indigo-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 p-1.5 text-white shadow"><Gauge className="h-3.5 w-3.5" /></span>
                  True pipeline latency · A→G hop percentiles (ms)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {latencyStages.length ? (
                  <div className="space-y-1">
                    {latencyStages.map(([stage, b]: [string, any]) => (
                      <div key={stage} className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-2 py-1 font-mono text-[10px] tabular-nums">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {b.bucket && <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">{b.bucket}</Badge>}
                          <span className="truncate" title={b.label}>{b.label ?? stage}</span>
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          p50 <span className="font-bold text-foreground">{fmtNum(b.p50_ms)}</span> · p95 <span className="font-bold text-foreground">{fmtNum(b.p95_ms)}</span> · {fmtNum(b.samples)} samples
                        </span>
                      </div>
                    ))}
                    <p className="pt-1 text-[11px] text-muted-foreground">
                      F = WS engine → DB Writer ingest · G = → Mongo write complete. Backend clock, broker skew se free.
                      {latencyRejected > 0 && <> · <span className="text-amber-700">{fmtNum(latencyRejected)} implausible samples rejected</span></>}
                    </p>
                  </div>
                ) : (
                  <p className="py-4 text-center text-[11px] text-muted-foreground">
                    No latency samples yet — is process me abhi tak market tick flow nahi hua. Tick aate hi real percentiles yahan.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* DATA-LOSS ACCOUNTING + MARKET WATCH DOC PIPELINE */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-teal-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 p-1.5 text-white shadow"><CheckCircle2 className="h-3.5 w-3.5" /></span>
                  Data-loss accounting · reconciliation
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {loss ? (
                  <div className="space-y-2 text-xs">
                    <div className="grid grid-cols-4 gap-2">
                      {([['Received', loss.received, 'text-foreground'], ['Duplicates', loss.duplicates, 'text-sky-700'], ['Invalid', loss.invalid, 'text-amber-700'], ['Accepted', loss.accepted, 'text-emerald-700']] as const).map(([l, v, tone]) => (
                        <div key={l} className="rounded-xl border border-border/50 bg-muted/30 px-2 py-2 text-center">
                          <p className={cn('font-mono text-base font-bold tabular-nums', tone)}>{fmtNum(v as number)}</p>
                          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {([['Written', loss.written, 'text-teal-700'], ['Write failed', loss.writeFailed, loss.writeFailed > 0 ? 'text-rose-700' : 'text-muted-foreground'], ['Pending (buffer)', loss.pending, 'text-amber-700']] as const).map(([l, v, tone]) => (
                        <div key={l} className="rounded-xl border border-border/50 bg-muted/30 px-2 py-2 text-center">
                          <p className={cn('font-mono text-base font-bold tabular-nums', tone)}>{fmtNum(v as number)}</p>
                          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/40 px-2.5 py-1.5 font-mono text-[10px]">
                      <p className="text-muted-foreground">RECEIVED = DUPLICATES + INVALID + ACCEPTED</p>
                      <p className="text-muted-foreground">ACCEPTED = WRITTEN + WRITE_FAILED + PENDING</p>
                      <p className="flex gap-2 pt-0.5">
                        <Badge variant="outline" className={loss.reconciliation?.receivedEqualsSum ? 'border-emerald-500/40 text-emerald-700' : 'border-rose-500/40 text-rose-700'}>{loss.reconciliation?.receivedEqualsSum ? '✓ balanced' : '✗ MISMATCH'}</Badge>
                        <Badge variant="outline" className={loss.reconciliation?.acceptedEqualsSum ? 'border-emerald-500/40 text-emerald-700' : 'border-rose-500/40 text-rose-700'}>{loss.reconciliation?.acceptedEqualsSum ? '✓ balanced' : '✗ MISMATCH'}</Badge>
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="py-4 text-center text-xs text-muted-foreground">Accounting unavailable — pipeline snapshot me nahi aaya.</p>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-violet-500/10 to-fuchsia-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
                  Market Watch document pipeline · candles/decisions
                  <Badge variant="outline" className={cn('ml-auto tabular-nums', mw?.pipelineRunning ? 'border-emerald-500/40 text-emerald-700' : 'border-amber-500/40 text-amber-700')}>{mw?.pipelineRunning ? 'RUNNING' : 'IDLE'}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {mw ? (
                  <div className="space-y-2 text-xs">
                    <div className="grid grid-cols-4 gap-2">
                      {([['Pending', mw.pendingTotal, ''], ['Received', mw.totalReceived, ''], ['Written', mw.totalWritten, 'text-teal-700'], ['Errors', mw.totalWriteErrors, Number(mw.totalWriteErrors) > 0 ? 'text-rose-700' : '']] as const).map(([l, v, tone]) => (
                        <div key={l} className="rounded-xl border border-border/50 bg-muted/30 px-2 py-2 text-center">
                          <p className={cn('font-mono text-base font-bold tabular-nums', tone)}>{fmtNum(v as number)}</p>
                          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                      <span>gated drops: <span className="font-bold text-foreground">{fmtNum(mw.totalGatedDrops)}</span></span>
                      <span>· dup skips: <span className="font-bold text-foreground">{fmtNum(mw.totalDuplicateSkips)}</span></span>
                      <span>· unidentifiable: <span className={cn('font-bold', Number(mw.totalUnidentifiableDrops) > 0 ? 'text-rose-700' : 'text-emerald-700')}>{fmtNum(mw.totalUnidentifiableDrops)}</span></span>
                      <span>· cap: <span className="font-bold text-foreground">{fmtNum(mw.hardCap)} docs</span></span>
                    </div>
                    {Object.keys(mw.byCollection ?? {}).length > 0 && (
                      <div className="max-h-28 overflow-auto">
                        {Object.entries(mw.byCollection as Record<string, any>).map(([name, s]) => (
                          <div key={name} className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-2 py-1 font-mono text-[10px]">
                            <span className="truncate">{name}</span>
                            <span className="shrink-0 text-muted-foreground">{fmtNum(s.received)} recv · {fmtNum(s.pending)} pending · {s.enabled ? 'ON' : 'OFF'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {mw.lastError && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 font-mono text-[10px] text-rose-700" title={mw.lastError}>last error: {mw.lastError}</p>}
                  </div>
                ) : (
                  <p className="py-4 text-center text-xs text-muted-foreground">Market Watch doc pipeline snapshot unavailable — engine start hote hi aayega.</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* STORAGE & DAILY TOTALS */}
          <Card className="overflow-hidden shadow-soft">
            <CardHeader className="bg-gradient-to-r from-sky-500/10 to-blue-500/5 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <span className="rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 p-1.5 text-white shadow"><HardDrive className="h-3.5 w-3.5" /></span>
                Storage & daily totals · MongoDB
                <Button size="sm" variant="outline" className="ml-auto h-6 gap-1 px-2 text-[11px]" onClick={() => void dbPing()} disabled={pinging}>
                  <Stethoscope className={cn('h-3 w-3', pinging && 'animate-pulse')} /> DB ping
                </Button>
                {ping && (
                  <Badge variant="outline" className={cn('font-mono', ping.ok ? 'border-emerald-500/40 text-emerald-700' : 'border-rose-500/40 text-rose-700')}>
                    {ping.ok ? `${ping.pingMs != null ? Number(ping.pingMs).toFixed(1) : '—'} ms · ${fmtNum(ping.collections)} collections` : 'ping failed'}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
              {collections ? (
                <div className="space-y-2 text-xs">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-xl border border-border/50 bg-muted/30 px-2.5 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Collections</p>
                      <p className="font-mono font-semibold">{fmtNum(collections.summary?.total_collections)}</p>
                    </div>
                    <div className="rounded-xl border border-border/50 bg-muted/30 px-2.5 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Total storage</p>
                      <p className="font-mono font-semibold">{fmtNum(collections.summary?.total_storage_mb)} MB</p>
                    </div>
                    <div className="rounded-xl border border-border/50 bg-muted/30 px-2.5 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Total docs</p>
                      <p className="font-mono font-semibold">{fmtNum(collections.summary?.total_documents)}</p>
                    </div>
                    <div className="rounded-xl border border-border/50 bg-muted/30 px-2.5 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Tick writes</p>
                      <p className="font-mono font-semibold">{fmtNum(data?.pipeline?.totalWritten)}</p>
                    </div>
                  </div>
                  <div className="max-h-48 overflow-auto">
                    {(collections.collections || []).map((c: any) => (
                      <div key={c.name} className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-2 py-1.5">
                        <span className="truncate font-mono text-[11px]">{c.name}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{fmtNum(c.count)} docs · {c.size_mb} MB</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="py-4 text-center text-xs text-muted-foreground">Loading storage stats…</p>
              )}
            </CardContent>
          </Card>

          {/* LATEST TICKS BY INSTRUMENT (real live store) */}
          <Card className="overflow-hidden shadow-soft">
            <CardHeader className="bg-gradient-to-r from-amber-500/10 to-yellow-500/5 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <span className="rounded-lg bg-gradient-to-br from-amber-500 to-yellow-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
                Latest ticks by instrument · live store
                <Badge variant="outline" className="ml-auto font-mono">{fmtNum(instr.length)} instruments</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
              {instr.length ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 px-2 font-mono text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                    <span className="w-20 shrink-0">Token</span>
                    <span className="min-w-0 flex-1">Symbol</span>
                    <span className="w-20 shrink-0 text-right">LTP</span>
                    <span className="w-16 shrink-0 text-right">Age</span>
                    <span className="w-20 shrink-0 text-right">5m move</span>
                  </div>
                  {instr.slice(0, 10).map((t: any) => {
                    const m5 = Number(t.momentum?.['5m']);
                    const up = Number.isFinite(m5) && m5 > 0;
                    const down = Number.isFinite(m5) && m5 < 0;
                    return (
                      <div key={t.token} className="flex items-center gap-2 rounded-lg border-b border-border/40 px-2 py-1 font-mono text-[10px] tabular-nums">
                        <span className="w-20 shrink-0 truncate text-muted-foreground" title={t.token}>{t.token}</span>
                        <span className="min-w-0 flex-1 truncate">{t.symbol ?? '—'}</span>
                        <span className="w-20 shrink-0 text-right font-bold">{fmtNum(t.ltp)}</span>
                        <span className="w-16 shrink-0 text-right text-muted-foreground">{Number.isFinite(Number(t.lastTickAgeSec)) ? `${Number(t.lastTickAgeSec).toFixed(0)}s` : '—'}</span>
                        <span className={cn('w-20 shrink-0 text-right font-bold', up ? 'text-emerald-700' : down ? 'text-rose-700' : 'text-muted-foreground')}>
                          {Number.isFinite(m5) ? `${m5 > 0 ? '+' : ''}${m5.toFixed(2)}%` : '—'}
                        </span>
                      </div>
                    );
                  })}
                  <p className="pt-1 text-[10px] text-muted-foreground">
                    DB Writer ka live store — MongoDB persistence categories se alag, sirf live UI ke liye (save/drop decision alag hota hai).
                  </p>
                </div>
              ) : (
                <p className="py-4 text-center text-[11px] text-muted-foreground">
                  Live store khali — market hours me subscribed instruments ke latest ticks yahan dikhte hain.
                </p>
              )}
            </CardContent>
          </Card>

          {/* AUDIT + CONFIG */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-sky-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-cyan-500 to-sky-600 p-1.5 text-white shadow"><CheckCircle2 className="h-3.5 w-3.5" /></span>
                  Audit pipeline · storage engine
                  <Badge variant="outline" className={cn('ml-auto tabular-nums', Number(data.audit?.writeErrors) > 0 ? 'border-rose-500/40 text-rose-700' : 'border-emerald-500/40 text-emerald-700')}>
                    {fmtNum(data.audit?.queueSize)} queued
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {data?.audit ? (
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {([['Queue', data.audit.queueSize, Number(data.audit.queueSize) > 100 ? 'text-amber-700' : ''], ['Writes', data.audit.totalWrites, 'text-teal-700'], ['Errors', data.audit.writeErrors, Number(data.audit.writeErrors) > 0 ? 'text-rose-700' : '']] as const).map(([l, v, tone]) => (
                      <div key={l} className="rounded-xl border border-border/50 bg-muted/30 px-2 py-2.5">
                        <p className={cn('font-mono text-lg font-bold tabular-nums', tone)}>{fmtNum(v as number | undefined)}</p>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-4 text-center text-xs text-muted-foreground">Audit pipeline unavailable — DB Writer running hote hi resumega.</p>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-amber-500/10 to-orange-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><Server className="h-3.5 w-3.5" /></span>
                  Configuration · read-only
                  <Badge variant="outline" className="ml-auto font-mono">{data?.configSummary?.mode ?? '—'}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 pt-3 text-xs">
                {([
                  ['Collection', data?.configSummary?.collection],
                  ['Flush interval', data?.configSummary?.flushIntervalMs != null ? `${fmtNum(data.configSummary.flushIntervalMs)} ms` : '—'],
                  ['Buffer max', fmtNum(data?.configSummary?.bufferMaxSize)],
                  ['Bulk insert', fmtNum(data?.configSummary?.bulkInsertSize)],
                ] as [string, string][]).map(([l, v]) => (
                  <div key={l} className="rounded-xl border border-border/50 bg-muted/30 px-2.5 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                    <p className="truncate font-mono font-semibold" title={v}>{v}</p>
                  </div>
                ))}
                <div className="col-span-2 rounded-xl border border-border/50 bg-muted/30 px-2.5 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Dependencies</p>
                  <p className="font-mono text-[11px]">{(data?.dependencies ?? []).join(', ') || '—'}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {data?.tickPersistence?.storageCapActive && (
            <p className="flex items-start gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700">
              <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{data.tickPersistence.storageCapReason}</span>
            </p>
          )}
        </>
      )}

      {/* Settings + permission CONTROL: /services/db-writer/permissions (apna connection) */}
      {/* Runtime settings explorer: /services/db-writer/settings (apna connection) */}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Timer className="h-3 w-3" />
        Live over WS#2 engines channel · REST fallback once. Missing = ‘—’, fake kabhi nahi.
        Pages: overview · storage · permissions · settings — har page ka apna connection.
      </p>
    </div>
  );
}
