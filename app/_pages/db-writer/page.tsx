'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, Copy, Database, Download, Gauge,
  HardDrive, HeartPulse, Layers, Play, Power, RefreshCw, RotateCw, SendHorizontal,
  Server, Settings, Stethoscope, Timer, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useEngineStatus } from '@/lib/engine-realtime';
import { updateSetting } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * SERVICES → DB Writer Engine — redesigned from zero (buttons + advance).
 *
 * Persistence layer: tick pipeline (bounded buffer → MongoDB bulk writes) +
 * audit pipeline. Live status over WS#2 (`engines` channel), REST fallback
 * once. Nothing fabricated — missing renders as '—'.
 *
 * Buttons (all real backend calls):
 *  Flush · Restart · Start · Stop (2-click confirm) · Heartbeat ping ·
 *  Health-check · Enable-all/Disable-all permissions · Copy snapshot · CSV.
 */

const ENGINE = '/api/services/engines/db_writer_engine';
const ENGINES = '/api/services/engines';
const TICK_PERSISTENCE = `${ENGINE}/tick-persistence`;

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

type PermissionKey = (typeof PERMISSIONS)[number]['key'];

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
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

export default function DbWriterPage() {
  const { data, error, refresh } = useEngineStatus<any>('db_writer_engine', ENGINE);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [permissions, setPermissions] = useState<Record<string, PermissionState> | null>(null);
  const [permError, setPermError] = useState<string | null>(null);
  const [permUnavailable, setPermUnavailable] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [storageCapReason, setStorageCapReason] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [savingCap, setSavingCap] = useState<string | null>(null);
  const [capReasonDraft, setCapReasonDraft] = useState<string | null>(null);

  const say = useCallback((kind: 'ok' | 'err', text: string) => setNotice({ kind, text }), []);

  const loadPermissions = useCallback(async (
    preserveError = false,
  ): Promise<Record<string, PermissionState> | null> => {
    try {
      const res = await fetch(TICK_PERSISTENCE, { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) {
        setPermError(json.error ?? `HTTP ${res.status}`);
        setPermUnavailable(/unavailable|could not persist/i.test(String(json.error ?? '')));
        return null;
      }
      setPermissions(json.data?.permissions ?? null);
      setStorageCapReason(json.data?.storageCapReason ?? null);
      if (!preserveError) setPermError(null);
      return json.data?.permissions ?? null;
    } catch (e: unknown) {
      setPermError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  const toggleSettings = () => {
    if (!settingsOpen) void loadPermissions();
    setSettingsOpen((v) => !v);
  };

  const applyPermissions = useCallback(async (patch: Record<string, boolean>, label: string) => {
    setSavingKey('__all__');
    setPermError(null);
    setPermUnavailable(false);
    try {
      const res = await fetch(TICK_PERSISTENCE, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!json.ok) {
        const message = json.error ?? `HTTP ${res.status}`;
        setPermError(message);
        setPermUnavailable(/unavailable|could not persist|storage cap/i.test(message));
        await loadPermissions(true);
      } else {
        setPermissions(json.data?.permissions ?? null);
        setStorageCapReason(json.data?.storageCapReason ?? null);
        say('ok', label);
      }
    } catch (e: unknown) {
      setPermError(e instanceof Error ? e.message : String(e));
      setPermUnavailable(true);
      await loadPermissions(true);
    }
    setSavingKey(null);
    refresh();
  }, [loadPermissions, say, refresh]);

  const togglePermission = (key: PermissionKey, next: boolean) => {
    setSavingKey(key);
    void applyPermissions({ [key]: next }, `${PERMISSIONS.find((p) => p.key === key)?.label} ${next ? 'enabled' : 'disabled'}.`)
      .finally(() => setSavingKey((k) => (k === key ? null : k)));
  };

  /** Master switch: DB me tick save karna hai ya nahi (real backend kill-switch). */
  const toggleMaster = (next: boolean) => {
    setSavingKey('master');
    void applyPermissions({ master: next }, next ? 'Master ON — tick saving allowed (permissions decide).' : 'Master OFF — koi tick DB me save nahi hoga.')
      .finally(() => setSavingKey((k) => (k === 'master' ? null : k)));
  };

  /** Storage-cap brake per stream: ON = us stream ko rok do (permission ON ho tab bhi). */
  const toggleCap = (settingKey: string, label: string, next: boolean) => {
    setSavingCap(settingKey);
    setPermError(null);
    setPermUnavailable(false);
    void (async () => {
      try {
        await updateSetting(settingKey, next);
        say('ok', `${label} cap ${next ? 'lagaya — stream rok diya' : 'hataya — permission wapas effective'}.`);
        await loadPermissions();
      } catch (e: unknown) {
        setPermError(e instanceof Error ? e.message : String(e));
      } finally {
        setSavingCap(null);
        refresh();
      }
    })();
  };

  const saveCapReason = () => {
    if (capReasonDraft == null) return;
    setSavingCap('reason');
    setPermError(null);
    void (async () => {
      try {
        await updateSetting('dbw_storage_cap_reason', capReasonDraft);
        say('ok', 'Cap reason save ho gaya.');
        await loadPermissions();
      } catch (e: unknown) {
        setPermError(e instanceof Error ? e.message : String(e));
      } finally {
        setSavingCap(null);
        refresh();
      }
    })();
  };

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

  const flush = () => runAction('Flush', `${ENGINE}/flush`, {},
    'Flush done.');
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
  const capsLive = ((data?.tickPersistence as any)?.storageCaps ?? {}) as Record<string, boolean>;

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
              <Badge className={healthOk ? 'border border-emerald-500/40 bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 text-emerald-200' : healthBad ? 'border border-rose-500/40 bg-rose-500/15 text-rose-200' : 'border border-amber-500/40 bg-amber-500/10 text-amber-200'}>
                <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', healthOk ? 'animate-pulse bg-emerald-400' : healthBad ? 'bg-rose-400' : 'bg-amber-400')} />
                {health}
              </Badge>
            )}
            <Badge variant="outline" className={cn('tabular-nums', running ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300')}>
              {running ? '● RUNNING' : '○ STOPPED'}
            </Badge>
            <Badge variant="outline" className={cn('tabular-nums font-mono', effectiveSaving ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300')}>
              {effectiveSaving ? 'SAVING ON — DB me write ho raha' : 'SAVING OFF — DB write rukha hai'}
            </Badge>
            {notice && <Badge variant="outline" className={notice.kind === 'ok' ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}>{notice.text}</Badge>}
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
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
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
              <Button size="sm" variant="outline" onClick={toggleSettings} className="gap-1.5">
                <Settings className="h-3.5 w-3.5" /> {settingsOpen ? 'Hide settings' : 'Permissions'}
              </Button>
              <Button size="sm" variant="ghost" onClick={copySnapshot} className="ml-auto gap-1.5">
                {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy snapshot'}
              </Button>
            </CardContent>
          </Card>

          {/* PERMISSIONS STRIP */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {PERMISSIONS.map(({ key, label }, i) => {
              const perm = perms[key] ?? {};
              const on = perm.enabled === true;
              const bar = ['bg-emerald-400', 'bg-cyan-400', 'bg-violet-400'][i];
              return (
                <Card key={key} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-0.5">
                  <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', on ? bar : 'bg-muted-foreground/30')} />
                  <CardContent className="flex items-center gap-3 p-3.5">
                    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', on ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg' : 'bg-muted/70 text-muted-foreground')}>
                      {on ? <CheckCircle2 className="h-5 w-5" /> : <X className="h-5 w-5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                      <p className={cn('font-mono text-lg font-bold tabular-nums leading-7', on ? 'text-emerald-300' : 'text-muted-foreground')}>{on ? 'ON' : 'OFF'}</p>
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
            <Button size="sm" variant="outline" disabled={savingKey != null} onClick={() => void applyPermissions({ master: true, personalNoExpiry: true, personalOneDay: true, marketWatchOneDay: true }, 'Master ON + all three streams enabled.')}>
              Enable all
            </Button>
            <Button size="sm" variant="outline" disabled={savingKey != null} onClick={() => void applyPermissions({ personalNoExpiry: false, personalOneDay: false, marketWatchOneDay: false }, 'All three permissions disabled.')}>
              Disable all
            </Button>
            <span className="text-[11px] text-muted-foreground">{onCount}/3 ON · toggles neeche Settings me (backend-confirmed, capped lock respected)</span>
            {data?.tickPersistence?.storageCapActive && (
              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300">STORAGE CAP ACTIVE</Badge>
            )}
          </div>

          {/* KPI STRIP */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {([
              { icon: Activity, label: 'Pipeline', value: running ? 'RUNNING' : 'STOPPED', sub: `since ${fmtTs(p.pipelineStartedAt)}`, tone: running ? 'text-emerald-300' : 'text-amber-300', bar: running ? 'bg-emerald-400' : 'bg-amber-400', chip: running ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg' : 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg' },
              { icon: Gauge, label: 'Throughput', value: `${fmtNum(p.ticksPerSecond)}/s`, sub: `${fmtNum(p.totalReceived)} recv · ${fmtNum(p.totalWritten)} written`, tone: 'text-teal-300', bar: 'bg-teal-400', chip: 'bg-gradient-to-br from-teal-500 to-cyan-600 text-white shadow-lg' },
              { icon: HardDrive, label: 'Buffer', value: `${pct.toFixed(0)}%`, sub: `${fmtNum(bufferLen)} / ${fmtNum(hardCap)}`, tone: pct > 80 ? 'text-rose-300' : pct > 50 ? 'text-amber-300' : '', bar: pct > 80 ? 'bg-rose-400' : pct > 50 ? 'bg-amber-400' : 'bg-emerald-400', chip: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-lg' },
              { icon: AlertTriangle, label: 'Write errors', value: fmtNum(writeErrors), sub: p.feedLatencyMs?.currentMs != null ? `${Number(p.feedLatencyMs.currentMs).toFixed(1)} ms feed` : health, tone: writeErrors > 0 ? 'text-rose-300' : '', bar: writeErrors > 0 ? 'bg-rose-400' : 'bg-emerald-400', chip: 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-lg' },
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
              </CardContent>
            </Card>
          </div>

          {/* AUDIT + CONFIG */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-sky-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg bg-gradient-to-br from-cyan-500 to-sky-600 p-1.5 text-white shadow"><CheckCircle2 className="h-3.5 w-3.5" /></span>
                  Audit pipeline · storage engine
                  <Badge variant="outline" className={cn('ml-auto tabular-nums', Number(data.audit?.writeErrors) > 0 ? 'border-rose-500/40 text-rose-300' : 'border-emerald-500/40 text-emerald-300')}>
                    {fmtNum(data.audit?.queueSize)} queued
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {data?.audit ? (
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {([['Queue', data.audit.queueSize, Number(data.audit.queueSize) > 100 ? 'text-amber-300' : ''], ['Writes', data.audit.totalWrites, 'text-teal-300'], ['Errors', data.audit.writeErrors, Number(data.audit.writeErrors) > 0 ? 'text-rose-300' : '']] as const).map(([l, v, tone]) => (
                      <div key={l} className="rounded-xl border border-border/50 bg-white/[0.02] px-2 py-2.5">
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
                  <div key={l} className="rounded-xl border border-border/50 bg-white/[0.02] px-2.5 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                    <p className="truncate font-mono font-semibold" title={v}>{v}</p>
                  </div>
                ))}
                <div className="col-span-2 rounded-xl border border-border/50 bg-white/[0.02] px-2.5 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Dependencies</p>
                  <p className="font-mono text-[11px]">{(data?.dependencies ?? []).join(', ') || '—'}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {data?.tickPersistence?.storageCapActive && (
            <p className="flex items-start gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
              <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{data.tickPersistence.storageCapReason}</span>
            </p>
          )}
        </>
      )}

      {/* SETTINGS — authoritative permissions */}
      {settingsOpen && (
        <Card className="overflow-hidden border-teal-500/25 shadow-soft">
          <CardHeader className="bg-gradient-to-r from-teal-500/10 to-emerald-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 p-1.5 text-white shadow"><Settings className="h-3.5 w-3.5" /></span>
              Settings · tick persistence permissions
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                <X className="h-3.5 w-3.5" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            {permError && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                <span className="font-medium text-destructive">{permUnavailable ? 'Settings store unavailable' : 'Change rejected'}</span>
                <span className="text-muted-foreground">{permError}</span>
              </div>
            )}
            {!permissions ? (
              !permError && (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/60" />)}
                  <p className="py-1 text-center text-xs text-muted-foreground">Reading tick persistence permissions…</p>
                </div>
              )
            ) : (
              <div className="space-y-3">
                {/* A — MASTER: DB me tick save karna hai ya nahi */}
                <div className={cn('rounded-xl border px-3 py-2.5', masterOn ? 'border-emerald-500/40 bg-emerald-500/[0.06]' : 'border-rose-500/40 bg-rose-500/[0.06]')}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold">DB me tick save karna hai? (Master)</span>
                        <Badge variant={masterOn ? 'default' : 'outline'} className="font-mono text-[10px]">{masterOn ? 'MASTER ON' : 'MASTER OFF'}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {masterOn
                          ? 'ON hai — neeche wale per-stream switches decide karenge kaunsa tick save hoga.'
                          : 'OFF hai — koi bhi tick DB me save NAHI hoga, chahe neeche wale switches ON hi kyun na hon.'}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {master?.settingKey ?? 'dbw_ticks_enabled'} · real backend kill-switch, next tick se effective
                      </p>
                    </div>
                    <Switch checked={masterOn} disabled={savingKey === 'master' || savingKey === '__all__'} aria-label="Tick saving master switch" onCheckedChange={(checked) => toggleMaster(checked)} />
                  </div>
                </div>

                {/* B — KAUN-KAUN SE tick save honge (per-stream permissions) */}
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Kaun-kaun se tick save honge {!masterOn && <span className="text-rose-400">(master OFF — ye sab effective OFF)</span>}
                </p>
                {storageCapReason && (
                  <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">{storageCapReason}</p>
                )}
                <div className={cn(!masterOn && 'pointer-events-none opacity-60')}>
                  {PERMISSIONS.map(({ key, label, description }) => {
                    const perm = permissions[key] ?? {};
                    const on = perm.enabled === true;
                    const saving = savingKey === key || savingKey === '__all__';
                    const locked = perm.hardCapped === true;
                    return (
                      <div key={key} className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{label}</span>
                            <Badge variant={on ? 'default' : 'outline'} className="font-mono text-[10px]">{on ? 'ON' : 'OFF'}</Badge>
                            {locked && <Badge variant="outline" className="border-amber-500/50 font-mono text-[10px] text-amber-600">CAPPED — rok laga hai</Badge>}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            {perm.settingKey ?? '—'} · {fmtNum(perm.accepted)} accepted · {fmtNum(perm.skipped)} skipped
                          </p>
                        </div>
                        <Switch checked={on} disabled={saving || locked} aria-label={`${label} tick persistence`} onCheckedChange={(checked) => togglePermission(key, checked)} />
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Switches show backend-confirmed state only. “1-day” session classification hai, MongoDB TTL nahi.
                </p>

                {/* C — ROK / blocks: storage-cap brake per stream (real working) */}
                <p className="pt-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Rok (blocks) — storage-cap brake per stream
                </p>
                <p className="text-xs text-muted-foreground">
                  Cap ON = us stream ko rok do, permission ON ho tab bhi koi write nahi hoga. Cap OFF = permission wapas effective.
                </p>
                {PERMISSIONS.map(({ key, label }) => {
                  const perm = permissions[key] ?? {};
                  const capKey = (perm as any).capSettingKey as string | undefined;
                  const capped = (perm as any).hardCapped === true || capsLive[key] === true;
                  if (!capKey) return null;
                  return (
                    <div key={capKey} className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.04] px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium">{label} — rok</span>
                          <Badge variant="outline" className={cn('font-mono text-[10px]', capped ? 'border-amber-500/50 text-amber-600' : '')}>{capped ? 'ROK LAGA HAI' : 'KHULA HAI'}</Badge>
                        </div>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{capKey}</p>
                      </div>
                      <Switch checked={capped} disabled={savingCap === capKey} aria-label={`${label} storage cap`} onCheckedChange={(checked) => toggleCap(capKey, label, checked)} />
                    </div>
                  );
                })}
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/50 bg-muted/20 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">Rok ki wajah (reason)</p>
                    <p className="font-mono text-[10px] text-muted-foreground">dbw_storage_cap_reason · panel + API me verbatim dikhega</p>
                  </div>
                  <Input
                    value={capReasonDraft ?? storageCapReason ?? ''}
                    placeholder="jaise: Atlas 512MB quota full"
                    onChange={(e) => setCapReasonDraft(e.target.value)}
                    className="h-8 w-56 text-xs"
                  />
                  <Button size="sm" variant="outline" className="h-8" disabled={savingCap === 'reason' || (capReasonDraft ?? storageCapReason ?? '') === (storageCapReason ?? '')} onClick={saveCapReason}>
                    Save reason
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Automatic rok (expiry / inactive / duplicate / invalid / unknown source) backend khud lagata hai — wo neeche “Save / drop decisions” chart me read-only dikhte hain.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Timer className="h-3 w-3" />
        Live over WS#2 engines channel · REST fallback once. Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
