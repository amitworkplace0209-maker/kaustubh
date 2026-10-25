'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Database, GitBranch, HeartPulse,
  Layers, RefreshCw, Search, ShieldCheck, Siren, Timer, Wallet, X, Activity, BarChart3,
  Monitor, Clock, Settings,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { useBackend } from '@/lib/use-backend';
import { getTerminalAudit } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  EMPTY_FILTERS, SEVERITY_TONE, fetchAuditQuery, fetchAuditTrace,
  fmtAgo, fmtClockIST, fmtNum, fmtTs, postAuditRecord,
  useAuditSummary, useNow, type AuditFilters,
} from '../../../_pages/audit-engine/audit-data';

/**
 * SERVICES -> Security -> Audit Engine (enterprise redesign)
 *
 * Single pane of glass for the entire service fleet:
 *   1. Fleet overview — every engine's live status/health (WS `engines` channel +
 *      one-shot REST fallback per engine, never polled).
 *   2. Cross-engine event trail — what happened, when, how, by which engine/actor.
 *   3. Status-change & danger monitor — auto-generates a signed report (what / who
 *      / how / when) whenever an engine's state or health flips into danger.
 *   4. Saved reports log — every generated report persists to localStorage and is
 *      appended to the immutable audit trail via POST /audit_engine/record.
 *
 * Performance: single WS subscription for the fleet, parallel one-shot REST
 * fallbacks, memoized engine cards, debounced search, fixed-height virtual
 * feel via CSS scroll container (no heavy list libs).
 */
const ENGINES_LIST = '/api/services/engines';
const REPORT_STORAGE_KEY = 'kaustubh.audit.reports';
const DANGER_HEALTH = new Set(['critical', 'emergency', 'unhealthy']);
const DANGER_STATE = new Set(['stopped', 'error', 'failed', 'unhealthy']);

type EngineStatus = {
  engineId: string;
  engineName: string;
  engineCategory?: string;
  version?: string;
  state?: string;
  health?: string;
  healthReason?: string;
  startedAt?: number | string;
  startedAtAgo?: string;
  lastHeartbeat?: number | string;
  heartbeatAge?: number;
  connectionState?: string;
  dependencies?: string[];
  dependents?: string[];
  recentErrors?: any[];
  [key: string]: any;
};

type ReportRecord = {
  id: string;
  engineId: string;
  engineName: string;
  type: 'status_change' | 'danger' | 'health_drop';
  what: string;
  who: string;
  how: string;
  when: string;
  oldStatus?: string;
  newStatus?: string;
  oldHealth?: string;
  newHealth?: string;
  healthReason?: string;
};

const HEALTH_TONE: Record<string, string> = {
  healthy: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  degraded: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  critical: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  emergency: 'bg-rose-500/25 text-rose-200 border-rose-500/50',
  unhealthy: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  unknown: 'bg-muted/40 text-muted-foreground border-border/60',
};

const STATE_TONE: Record<string, string> = {
  started: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  running: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  stopped: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  error: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  failed: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  initializing: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  // `REGISTERED` ships from the backend for engines that are wired up but not
  // started yet — without this key `stateTone` was `undefined` and
  // `stateTone.includes(...)` crashed the whole fleet grid.
  registered: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  idle: 'bg-muted/40 text-muted-foreground border-border/60',
  unknown: 'bg-muted/40 text-muted-foreground border-border/60',
};

const ICON_FOR_CATEGORY: Record<string, any> = {
  control: Settings,
  market_data: BarChart3,
  trading: Activity,
  risk: ShieldCheck,
  connection: Monitor,
  storage: Database,
  scheduler: Clock,
  execution: HeartPulse,
};

export default function EnterpriseAuditEnginePage() {
  const now = useNow(1000);

  // ---- fleet (realtime WS + one-shot REST fallback per engine) ----
  const { engines: fleet, updatedAt: fleetUpdated, connected: fleetConnected } = useEnginesWithFallback();

  // ---- per-engine REST detail (lazy, on-demand per card expand) ----
  const [detailCache, setDetailCache] = useState<Record<string, any>>({});

  const engineIds = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const e of fleet) {
      const id = e?.engineId;
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids.sort();
  }, [fleet]);

  /** O(1) lookup for the grid + detail cards (never `undefined`-crashes a map). */
  const fleetById = useMemo(() => {
    const m = new Map<string, EngineStatus>();
    for (const e of fleet) if (e?.engineId) m.set(e.engineId, e);
    return m;
  }, [fleet]);

  // fleet health rollup
  const healthyCount = fleet.filter((e) => e.health === 'healthy').length;
  const degradedCount = fleet.filter((e) => e.health === 'degraded').length;
  const dangerCount = fleet.filter((e) => DANGER_HEALTH.has(e.health) || DANGER_STATE.has(e.state)).length;

  // ---- summary (audit trail aggregates) ----
  const { data: summary, error: sumError, loading: sumLoading, lastUpdated, refresh: refreshSummary } = useAuditSummary();

  // ---- event explorer (cross-engine) ----
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refreshExplorer = useCallback(() => {
    setSearching(true); setSearchError(null);
    fetchAuditQuery(applied)
      .then((events: any[]) => setRows(events))
      .catch((e: any) => setSearchError(e?.message ?? 'query failed'))
      .finally(() => setSearching(false));
  }, [applied]);

  useEffect(() => {
    setSearching(true); setSearchError(null);
    fetchAuditQuery(applied)
      .then((events: any[]) => setRows(events))
      .catch((e: any) => setSearchError(e?.message ?? 'query failed'))
      .finally(() => setSearching(false));
  }, [applied]);

  const runSearch = () => { setApplied(draft); setExpanded(null); setTraceCorr(null); };

  // ---- trace ----
  const [traceCorr, setTraceCorr] = useState<string | null>(null);
  const [traceRows, setTraceRows] = useState<any[]>([]);
  const [traceBusy, setTraceBusy] = useState(false);
  const openTrace = (corrId: string) => {
    if (!corrId) return;
    setTraceCorr(corrId); setTraceBusy(true);
    fetchAuditTrace(corrId).then(setTraceRows).catch(() => setTraceRows([])).finally(() => setTraceBusy(false));
  };

  // ---- reports (status change / danger) ----
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [reportBusy, setReportBusy] = useState(false);
  const prevStatus = useRef<Record<string, { state?: string; health?: string }>>({});

  const loadSavedReports = useCallback(() => {
    try {
      const raw = localStorage.getItem(REPORT_STORAGE_KEY);
      if (raw) setReports(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadSavedReports();
    // seed previous status from current fleet so we don't fire false changes on mount
    const seed: Record<string, { state?: string; health?: string }> = {};
    for (const e of fleet) seed[e.engineId] = { state: e.state, health: e.health };
    prevStatus.current = seed;
  }, [fleet, loadSavedReports]);

  // ---- status change / danger detection ----
  useEffect(() => {
    if (fleet.length === 0) return;
    const seed: Record<string, { state?: string; health?: string }> = {};
    const newReports: ReportRecord[] = [];
    let changed = false;

    for (const e of fleet) {
      const id = e.engineId;
      const prev = prevStatus.current[id];
      seed[id] = { state: e.state, health: e.health };
      if (!prev) continue;

      const stateChanged = prev.state !== null && prev.state !== undefined && prev.state !== e.state;
      const healthChanged = prev.health !== null && prev.health !== undefined && prev.health !== e.health;
      const nowDanger = DANGER_HEALTH.has(e.health) || DANGER_STATE.has(e.state);
      const wasDanger = DANGER_HEALTH.has(prev.health ?? '') || DANGER_STATE.has(prev.state ?? '');

      if (stateChanged || healthChanged) {
        changed = true;
        const type: ReportRecord['type'] =
          nowDanger && !wasDanger ? 'danger' :
          healthChanged ? 'health_drop' : 'status_change';
        const when = fmtClockIST(new Date().toISOString()) + ' IST';
        newReports.push({
          id: `rep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          engineId: id,
          engineName: e.engineName || id,
          type,
          what: `${e.engineName || id} — ${stateChanged ? `state ${prev.state ?? '—'} → ${e.state ?? '—'}` : ''}${stateChanged && healthChanged ? ' · ' : ''}${healthChanged ? `health ${prev.health ?? '—'} → ${e.health ?? '—'}` : ''}`.trim() || 'status updated',
          who: 'system',
          how: stateChanged ? 'engine state change detected (realtime WS)' : 'engine health change detected (realtime WS)',
          when,
          oldStatus: prev.state,
          newStatus: e.state,
          oldHealth: prev.health,
          newHealth: e.health,
          healthReason: e.healthReason,
        });
        if (nowDanger && !wasDanger) {
          // persist danger report to immutable audit trail
          void postAuditRecord({
            source: 'audit_engine',
            event: 'ENGINE_DANGER',
            status: 'critical',
            message: `${e.engineName || id} entered danger state (state=${e.state ?? '—'}, health=${e.health ?? '—'})${e.healthReason ? ` — ${e.healthReason}` : ''}`,
            meta: { category: 'SECURITY', severity: 'critical', engineId: id, actor_type: 'system', correlation_id: `rep_${id}` },
          });
        }
      }
    }

    if (changed) {
      prevStatus.current = seed;
      const merged = [...newReports, ...reports].slice(0, 200);
      setReports(merged);
      try {
        localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(merged));
      } catch { /* ignore */ }
      // also append each new report to the audit trail as a system event
      for (const r of newReports) {
        void postAuditRecord({
          source: 'audit_engine',
          event: 'AUDIT_REPORT_GENERATED',
          status: r.type === 'danger' ? 'critical' : 'info',
          message: `${r.what} (${r.how})`,
          meta: { category: 'SYSTEM', severity: r.type === 'danger' ? 'critical' : 'info', actor_type: 'system', report_id: r.id, engine_id: r.engineId },
        });
      }
    }
  }, [fleet, reports]);

  // ---- trading decisions trail ----
  const [tLimit, setTLimit] = useState(50);
  const loadTerminal = useCallback(
    () => getTerminalAudit(tLimit).then((r) => (Array.isArray(r?.data) ? r.data : [])),
    [tLimit],
  );
  const { data: terminalRows, loading: tLoading, error: tError, refresh: refreshTerminal } = useBackend<any[]>(loadTerminal);
  const tEntries = Array.isArray(terminalRows) ? terminalRows : [];

  const health = fleet.length ? rollupHealth(fleet) : 'UNKNOWN';
  const byCat = summary?.byCategory ?? {};
  const bySev = summary?.bySeverity ?? {};
  const bySrc = summary?.bySource ?? {};
  const catEntries = Object.entries(byCat).sort((a: any, b: any) => b[1] - a[1]);
  const maxCat = Math.max(1, ...(catEntries.map((c: any) => Number(c[1])) as number[]));
  const latest = summary?.latestEvent ?? null;

  const allHealthy = fleet.length > 0 && healthyCount === fleet.length;

  const refreshAll = () => {
    refreshSummary();
    refreshExplorer();
    refreshTerminal();
  };

  return (
    <div className="space-y-5 pb-8">
      {/* ================= HERO ================= */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.12] via-violet-500/[0.06] to-emerald-500/[0.10]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-indigo-500/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-emerald-500 text-white shadow-xl">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate bg-gradient-to-r from-indigo-300 via-violet-200 to-emerald-200 bg-clip-text text-xl font-bold tracking-tight text-transparent sm:text-2xl">
              Audit Engine — Enterprise
            </h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground sm:text-sm">
              Fleet-wide engine status · cross-engine event trail · auto danger reports · {fmtClockIST(new Date(now).toISOString())} IST
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn(fleetConnected ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300')}>
              <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', fleetConnected ? 'animate-pulse bg-emerald-400' : 'bg-amber-400')} />
              {fleetConnected ? 'FLEET LIVE' : 'FLEET REST'}
            </Badge>
            <Badge variant={dangerCount > 0 ? 'destructive' : 'outline'} className={cn(dangerCount > 0 ? 'border-rose-500/40 text-rose-300' : 'border-emerald-500/40 text-emerald-300')}>
              {dangerCount === 0 ? 'ALL HEALTHY' : `${dangerCount} IN DANGER`}
            </Badge>
            {sumLoading && <Badge variant="outline">loading…</Badge>}
            {noticeBadge(sumError) && <Badge variant="outline" className="max-w-72 truncate border-rose-500/30 text-rose-300">{sumError}</Badge>}
            <Button size="sm" onClick={refreshAll} className="gap-1.5 bg-gradient-to-r from-indigo-500 via-violet-500 to-emerald-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh All
            </Button>
          </div>
        </div>

        {/* fleet rollup stats */}
        <div className="relative flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-2.5 sm:px-5">
          <FleetChip label="Engines" value={fmtNum(fleet.length)} icon={Monitor} tone="bg-indigo-500/15 text-indigo-300 border-indigo-500/30" />
          <FleetChip label="Healthy" value={fmtNum(healthyCount)} icon={HeartPulse} tone={healthyCount === fleet.length && fleet.length > 0 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'} />
          <FleetChip label="Degraded" value={fmtNum(degradedCount)} icon={AlertTriangle} tone="bg-amber-500/15 text-amber-300 border-amber-500/30" />
          <FleetChip label="Danger" value={fmtNum(dangerCount)} icon={Siren} tone={dangerCount > 0 ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'} />
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            fleet {fleetUpdated ? fmtAgo(fleetUpdated, now) : '—'} · summary {lastUpdated ? fmtAgo(new Date(lastUpdated).toISOString(), now) : '—'}
          </span>
        </div>
      </div>

      {sumError && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0">Summary: {sumError}</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={refreshAll}>Retry</Button>
        </div>
      )}

      {/* ================= FLEET GRID ================= */}
      <section className="grid gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {engineIds.length === 0 ? (
          <div className="col-span-full py-12 text-center text-xs text-muted-foreground">
            No engines registered yet — fleet snapshot will appear once the WS `engines`
            channel pushes a snapshot or REST fallback resolves.
          </div>
        ) : (
          engineIds.map((id) => {
            const e = fleetById.get(id);
            if (!e) return null;
            const isDanger = DANGER_HEALTH.has(e.health ?? '') || DANGER_STATE.has(e.state ?? '');
            return (
              <EngineCard key={id} engine={e} isDanger={isDanger} onOpenDetail={() => setDetailCache((d) => ({ ...d, [id]: true }))} />
            );
          })
        )}
      </section>

      {/* detail sheet (inline expanded card) - rendered as a row under grid via a portal-like section */}
      {detailCacheShown(detailCache, engineIds).length > 0 && (
        <section className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {detailCacheShown(detailCache, engineIds).map((id) => {
            const e = fleetById.get(id);
            if (!e) return null;
            return <EngineDetailCard key={id} engine={e} onClose={() => setDetailCache((d) => { const { [id]: _, ...rest } = d; return rest; })} />;
          })}
        </section>
      )}

      {/* ================= EVENT TRAIL ================= */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-semibold">Cross-Engine Event Trail</span>
            <Badge variant="outline" className="font-mono tabular-nums">{rows.length} rows</Badge>
          </div>
          <div className="flex items-center gap-2">
            {searching && <Badge variant="outline">searching…</Badge>}
            <Button size="sm" onClick={runSearch} disabled={searching} className="gap-1.5 bg-gradient-to-r from-violet-500 to-indigo-600">
              <Search className="h-3.5 w-3.5" /> Search trail
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); setExpanded(null); setTraceCorr(null); }} className="gap-1.5">
              <X className="h-3.5 w-3.5" /> Reset
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 mb-3">
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground block">Search (message / reason / symbol / id)</span>
              <span className="relative block">
                <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={draft.search} onChange={(e) => setDraft({ ...draft, search: e.target.value })} onKeyDown={(ev) => { if (ev.key === 'Enter') runSearch(); }} className="h-8 pl-7 text-xs" placeholder="RISK, BLOCK, engine…" />
              </span>
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground block">Source engine</span>
              <Input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} className="h-8 font-mono text-xs" placeholder="risk_engine" />
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground block">Event</span>
              <Input value={draft.event} onChange={(e) => setDraft({ ...draft, event: e.target.value })} className="h-8 font-mono text-xs" placeholder="ENGINE_STARTED" />
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground block">Category</span>
              <Input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="h-8 font-mono text-xs" placeholder="TRADING" />
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground block">Severity</span>
              <Select value={draft.severity || '__all'} onValueChange={(v) => setDraft({ ...draft, severity: v === '__all' ? '' : v })}>
                <SelectTrigger className="h-8 font-mono text-xs"><SelectValue placeholder="all" /></SelectTrigger>
                <SelectContent><SelectItem value="__all">all</SelectItem>{Object.keys(SEVERITY_TONE).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground block">Correlation ID</span>
              <Input value={draft.correlation_id} onChange={(e) => setDraft({ ...draft, correlation_id: e.target.value })} className="h-8 font-mono text-xs" placeholder="CORR-…" />
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground block">Limit</span>
              <Select value={String(draft.limit)} onValueChange={(v) => setDraft({ ...draft, limit: Number(v) })}>
                <SelectTrigger className="h-8 font-mono text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{[25, 50, 100, 200].map((l) => <SelectItem key={l} value={String(l)}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          </div>

          {searchError && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 mb-3">{searchError}</div>}

          {traceCorr ? (
            <TracePanel corrId={traceCorr} rows={traceRows} busy={traceBusy} onBack={() => setTraceCorr(null)} />
          ) : rows.length === 0 && !searching ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Koi entry nahi — filter badlo ya limit badhao. (Honest zero.)</p>
          ) : (
            <div className="max-h-[34rem] overflow-y-auto pr-2 space-y-1">
              {rows.map((e: any) => {
                const id = String(e.event_id ?? `${e.ts}-${e.event}`);
                const open = expanded === id;
                const corr = e.meta?.correlation_id ?? e.correlation_id ?? '';
                return (
                  <div key={id} className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs">
                    <button type="button" onClick={() => setExpanded(open ? null : id)} className="flex w-full items-start gap-2 text-left">
                      <time className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground">{fmtTs(e.ts)}</time>
                      <Badge variant="outline" className={cn('shrink-0 font-mono text-[10px]', SEVERITY_TONE[String(e.severity ?? e.status)] ?? '')}>{e.event ?? '—'}</Badge>
                      <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{e.source ?? ''}</span>
                      <span className="min-w-0 flex-1 truncate">{e.message || e.reason || e.details || e.event_id}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{e.category ?? ''}</span>
                    </button>
                    {open && (
                      <div className="mt-2 space-y-1.5 border-t border-border/50 pt-2 font-mono text-[11px]">
                        <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
                          <span><span className="text-muted-foreground">id: </span>{e.event_id ?? '—'}</span>
                          <span><span className="text-muted-foreground">category: </span>{e.category ?? '—'}</span>
                          <span><span className="text-muted-foreground">source: </span>{e.source ?? '—'}</span>
                          <span><span className="text-muted-foreground">actor: </span>{e.meta?.actor_type ?? '—'}</span>
                          {corr && <span><span className="text-muted-foreground">correlation: </span>{corr}</span>}
                          {e.related_event_id && <span><span className="text-muted-foreground">related: </span>{e.related_event_id}</span>}
                        </div>
                        {e.meta && Object.keys(e.meta).length > 0 && (
                          <pre className="max-h-32 overflow-auto rounded bg-black/40 p-2 text-[10px] text-muted-foreground">{JSON.stringify(e.meta, null, 2)}</pre>
                        )}
                        {corr && (
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => openTrace(corr)}>
                            <GitBranch className="h-3 w-3" /> Full trace dekho
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ================= STATUS CHANGE & DANGER REPORTS ================= */}
      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <Siren className="h-4 w-4 text-rose-300 shrink-0" />
            <span className="text-sm font-semibold">Auto Danger & Status-Change Reports</span>
            <Badge variant="outline" className="font-mono tabular-nums">{reports.length} generated</Badge>
          </div>
          <div className="flex items-center gap-2">
            {reportBusy && <Badge variant="outline">recording…</Badge>}
            <Button size="sm" onClick={refreshAll} disabled={reportBusy} className="gap-1.5">
              <RefreshCw className="h-3 w-3" /> Refresh
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-[11px] text-muted-foreground mb-3">
            Har engine ki state ya health change hone par (dard/status danger), ek report auto-ban ke
            <strong>saved</strong> kiya jata hai — <strong>kya hua (what), kon ne (who), kaise (how), kab (when)</strong> —
            aur use immutable audit trail mein bhi append kiya jata hai.
          </p>
          {reports.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              <Activity className="h-6 w-6 mx-auto mb-2 opacity-30" />
              <div>Abhi koi status-change ya danger report nahi bani. Engine status change hone par yahan aa jayega.</div>
            </div>
          ) : (
            <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-2">
              {reports.map((r) => (
                <div key={r.id} className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <Badge variant={r.type === 'danger' ? 'destructive' : 'outline'} className="font-mono text-[10px]">
                      {r.type === 'danger' ? 'DANGER' : r.type === 'health_drop' ? 'HEALTH DROP' : 'STATUS CHANGE'}
                    </Badge>
                    <Badge variant="outline" className={cn('font-mono text-[10px]', HEALTH_TONE[r.newHealth ?? 'unknown'] ?? HEALTH_TONE.unknown)}>
                      {r.newHealth ?? '—'}
                    </Badge>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">{r.when}</span>
                  </div>
                  <div className="font-mono text-[10.5px] truncate">{r.what}</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-1.5 border-t border-border/50 pt-1.5">
                    <span><span className="text-muted-foreground">engine: </span>{r.engineName}</span>
                    <span><span className="text-muted-foreground">by (who): </span>{r.who}</span>
                    <span><span className="text-muted-foreground">how: </span>{r.how}</span>
                    <span><span className="text-muted-foreground">when: </span>{r.when}</span>
                    {r.oldStatus != null && <span><span className="text-muted-foreground">old state: </span>{r.oldStatus}</span>}
                    {r.newStatus != null && <span><span className="text-muted-foreground">new state: </span>{r.newStatus}</span>}
                    {r.oldHealth != null && <span><span className="text-muted-foreground">old health: </span>{r.oldHealth}</span>}
                    {r.newHealth != null && <span><span className="text-muted-foreground">new health: </span>{r.newHealth}</span>}
                    {r.healthReason && <span><span className="text-muted-foreground">reason: </span>{r.healthReason}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ================= TRADING DECISIONS ================= */}
      <section>
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-sky-500/10 to-blue-500/5 pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 p-1.5 text-white shadow"><Wallet className="h-3.5 w-3.5" /></span>
              Trading Decisions · terminal gateway
              <span className="ml-auto flex items-center gap-2">
                <Badge variant="outline" className="font-mono tabular-nums">{tEntries.length}</Badge>
                <Select value={String(tLimit)} onValueChange={(v) => setTLimit(Number(v))}>
                  <SelectTrigger className="h-7 w-20 font-mono text-[11px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{[25, 50, 100, 200].map((l) => <SelectItem key={l} value={String(l)}>{l}</SelectItem>)}</SelectContent>
                </Select>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            {tLoading && tEntries.length === 0 ? <p className="py-4 text-center text-xs text-muted-foreground">Loading decisions…</p>
              : tError ? <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{String(tError)}</p>
              : tEntries.length === 0 ? <p className="py-4 text-center text-xs text-muted-foreground">No trading decisions yet — honest zero.</p>
              : (
                <div className="max-h-72 space-y-1.5 overflow-auto pr-1">
                  {tEntries.map((e: any, i: number) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs">
                      <time className="whitespace-nowrap font-mono text-muted-foreground">{fmtTs(e?.ts)}</time>
                      <Badge variant="outline" className="font-mono text-[10px]">{e?.kind ?? e?.action ?? '—'}</Badge>
                      <span className="flex-1 truncate">{e?.action ?? e?.reason ?? e?.event_id ?? '—'}</span>
                      {e?.accepted != null && <Badge variant={e.accepted ? 'outline' : 'outline'} className={cn('font-mono text-[10px]', e.accepted ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300')}>{e.accepted ? 'accepted' : 'blocked'}</Badge>}
                    </div>
                  ))}
                </div>
              )}
          </CardContent>
        </Card>
      </section>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Timer className="h-3 w-3" />
        Fleet live over WS#2 · summary auto-refresh 15s · explorer manual search · status-change reports auto-saved · missing = '—', fake kabhi nahi.
      </p>
    </div>
  );
}

/* ---------- helpers ---------- */

function noticeBadge(sumError: string | null) {
  return Boolean(sumError);
}

function rollupHealth(fleet: any[]): string {
  if (fleet.some((e) => DANGER_HEALTH.has(e.health) || DANGER_STATE.has(e.state))) return 'DANGER';
  if (fleet.some((e) => e.health === 'degraded')) return 'DEGRADED';
  if (fleet.every((e) => e.health === 'healthy')) return 'HEALTHY';
  return 'UNKNOWN';
}

function detailCacheShown(cache: Record<string, boolean>, ids: string[]): string[] {
  return ids.filter((id) => Boolean(cache[id]));
}

/**
 * The fleet arrives in two shapes:
 *   * `GET /api/services/engines` → `data` is an ARRAY of engine objects that
 *     already carry their real `engineId`.
 *   * WS `engine.status` frames → `data.engines` is an OBJECT keyed by engineId.
 *
 * Normalizing both to a plain array (always with a real `engineId`) is what
 * keeps `engineIds`/`fleet.find(...)` coherent — mapping an array through
 * `Object.entries` used to replace every engineId with its array index, which
 * then made `fleet.find(...)` return `undefined` and crashed the grid with
 * "Cannot read properties of undefined (reading 'health')".
 *
 * `state`/`health` are lower-cased to match the tone maps / DANGER_* sets —
 * the REST payload ships them upper-case (`RUNNING` / `HEALTHY`).
 */
function normalizeEngines(payload: any): EngineStatus[] {
  const list: any[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? Object.entries(payload).map(([id, v]: any) => ({ ...(v ?? {}), engineId: v?.engineId ?? id }))
      : [];
  const seen = new Set<string>();
  const out: EngineStatus[] = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== 'object') continue;
    const engineId = String(raw.engineId ?? raw.engine_id ?? `engine_${i}`);
    if (seen.has(engineId)) continue;
    seen.add(engineId);
    out.push({
      ...raw,
      engineId,
      state: typeof raw.state === 'string' ? raw.state.toLowerCase() : raw.state,
      health: typeof raw.health === 'string' ? raw.health.toLowerCase() : raw.health,
    });
  }
  return out;
}

/* ---------- fleet hook with one-shot REST fallback ---------- */

function useEnginesWithFallback() {
  const { subscribe, onFrame, connected } = useFrontendRealtime();
  const [engines, setEngines] = useState<any[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // realtime snapshot — one WS subscription for the whole fleet
  useEffect(() => {
    let mounted = true;
    (async () => {
      await subscribe([{ channel: 'engines' }]).catch(() => {});
    })();
    const off = onFrame((frame: any) => {
      if (!mounted || frame.type !== 'engine.status') return;
      const snap = frame.data?.engines;
      if (!snap || typeof snap !== 'object') return;
      setEngines(normalizeEngines(snap));
      setUpdatedAt(Date.now());
    });
    return () => { mounted = false; off(); };
  }, [subscribe, onFrame]);

  // one-shot REST fallback (list-all) on mount — never polled
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    fetch(`${ENGINES_LIST}`, { signal: controller.signal, cache: 'no-store' })
      .then((res) => res.json().catch(() => ({})))
      .then((body) => {
        if (!mounted) return;
        const arr = normalizeEngines(body?.data ?? body);
        setEngines((prev) => (prev.length ? prev : arr));
        if (arr.length) setUpdatedAt(Date.now());
      })
      .catch(() => {});
    return () => { mounted = false; controller.abort(); };
  }, []);

  return { engines, updatedAt: updatedAt ?? null, connected };
}

/* ---------- components ---------- */

function FleetChip({ label, value, icon: Icon, tone }: { label: string; value: string; icon: any; tone: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
      <Icon className={cn('h-3 w-3 shrink-0', tone)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-xs font-bold tabular-nums">{value}</p>
      </div>
    </div>
  );
}

const EngineCard = function EngineCard({ engine, isDanger, onOpenDetail }: { engine: any; isDanger: boolean; onOpenDetail: () => void }) {
  const healthTone = HEALTH_TONE[engine.health ?? 'unknown'] ?? HEALTH_TONE.unknown;
  const stateTone = STATE_TONE[engine.state ?? 'unknown'] ?? STATE_TONE.unknown;
  const Icon = ICON_FOR_CATEGORY[engine.engineCategory ?? 'control'] || Monitor;
  return (
    <Card className={cn('relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-0.5', isDanger ? 'border-rose-500/50 bg-rose-500/[0.02]' : 'border-border')}>
      {isDanger && <span className="absolute -top-1 -right-1 h-6 w-6 rounded-full bg-rose-500 text-xs flex items-center justify-center text-rose-100 shadow">!</span>}
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', stateTone.includes('emerald') ? 'bg-emerald-400' : isDanger ? 'bg-rose-500' : 'bg-amber-500')} />
      <CardContent className="p-3 pt-2.5">
        <div className="flex items-center gap-2 mb-1">
          <Icon className="h-3 w-3 shrink-0" />
          <span className="truncate text-xs font-semibold">{engine.engineName || engine.engineId}</span>
        </div>
        <div className="space-y-1 text-[10px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">State</span>
            <Badge variant="outline" className={cn('font-mono text-[9px]', stateTone)}>{engine.state ?? '—'}</Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Health</span>
            <Badge variant="outline" className={cn('font-mono text-[9px]', healthTone)}>{engine.health ?? '—'}</Badge>
          </div>
          {engine.heartbeatAge != null && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Heartbeat</span>
              <span className="font-mono">{engine.heartbeatAge}s ago</span>
            </div>
          )}
          {engine.subscription_count != null && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subs</span>
              <span className="font-mono tabular-nums">{engine.subscription_count}</span>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onOpenDetail} className="h-7 text-[10px] gap-1 w-full">
            <Activity className="h-3 w-3" /> Details
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

function EngineDetailCard({ engine, onClose }: { engine: any; onClose: () => void }) {
  return (
    <Card className="relative overflow-hidden shadow-soft border-border">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-muted/30">
        <Button size="sm" variant="ghost" onClick={onClose} className="h-6 text-xs">
          <ArrowLeft className="h-3 w-3" /> Back
        </Button>
        <span className="ml-auto text-xs font-semibold truncate max-w-xs">{engine.engineName || engine.engineId}</span>
        <Badge variant="outline" className={cn('font-mono text-[9px]', HEALTH_TONE[engine.health ?? 'unknown'] ?? HEALTH_TONE.unknown)}>{engine.health ?? '—'}</Badge>
      </div>
      <CardContent className="p-3">
        <div className="grid gap-2 sm:grid-cols-2 text-[10px]">
          <div className="space-y-1">
            <span className="text-muted-foreground">Engine ID</span>
            <span className="font-mono truncate">{engine.engineId}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Category</span>
            <span>{engine.engineCategory ?? '—'}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono">{engine.version ?? '—'}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">State</span>
            <Badge variant="outline" className={cn('font-mono text-[9px]', STATE_TONE[engine.state ?? 'unknown'] ?? STATE_TONE.unknown)}>{engine.state ?? '—'}</Badge>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Health</span>
            <Badge variant="outline" className={cn('font-mono text-[9px]', HEALTH_TONE[engine.health ?? 'unknown'] ?? HEALTH_TONE.unknown)}>{engine.health ?? '—'}</Badge>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Health Reason</span>
            <span className="font-mono text-[9px] truncate">{engine.healthReason ?? '—'}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Started At</span>
            <span className="font-mono">{fmtTs(engine.startedAt)}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Started Ago</span>
            <span>{engine.startedAtAgo ?? '—'}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Last Heartbeat</span>
            <span className="font-mono">{fmtTs(engine.lastHeartbeat)}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Heartbeat Age</span>
            <span>{engine.heartbeatAge != null ? engine.heartbeatAge + 's ago' : '—'}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Connection</span>
            <span className="font-mono text-[9px]">{engine.connectionState ?? '—'}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Active Consumers</span>
            <span className="font-mono tabular-nums">{engine.active_consumers ?? '—'}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Pins</span>
            <span className="font-mono tabular-nums">{engine.pins ?? '—'}</span>
          </div>
        </div>
        {engine.recentErrors && engine.recentErrors.length > 0 && (
          <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-3 w-3 text-rose-400 shrink-0" />
              <span className="font-bold text-[10px] text-rose-300">Recent Errors</span>
            </div>
            <div className="space-y-1 text-[9px] text-rose-200 font-mono">
              {engine.recentErrors.slice(0, 8).map((err: any, i: number) => (
                <div key={i} className="truncate">{String(err)}</div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TracePanel({ corrId, rows, busy, onBack }: { corrId: string; rows: any[]; busy: boolean; onBack: () => void }) {
  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-500/[0.05] p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <GitBranch className="h-4 w-4 text-violet-300" />
        <span className="font-mono text-xs font-semibold">Trace {corrId}</span>
        <Badge variant="outline" className="font-mono">{rows.length} links</Badge>
        <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1 text-xs" onClick={onBack}><ArrowLeft className="h-3 w-3" /> Back to results</Button>
      </div>
      {busy ? <p className="py-4 text-center text-xs text-muted-foreground">Loading chain…</p> : rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">Is correlation ID ki koi chain nahi mili.</p>
      ) : (
        <div className="relative mt-3 space-y-0">
          {rows.map((e: any, i: number) => (
            <div key={e.event_id ?? i} className="relative flex gap-3 pb-3 last:pb-0">
              {i < rows.length - 1 && <div className="absolute bottom-0 left-[13px] top-8 w-px bg-violet-500/40" />}
              <div className="z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-violet-500/40 bg-violet-500/15 font-mono text-[10px] text-violet-200">{rows.length - i}</div>
              <div className="flex-1 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Badge variant="outline" className={cn('font-mono text-[10px]', SEVERITY_TONE[String(e.severity ?? e.status)] ?? '')}>{e.event ?? '—'}</Badge>
                  <span className="font-mono text-muted-foreground">{fmtTs(e.ts)}</span>
                </div>
                <p className="mt-0.5 text-[11px]">{e.message || e.reason || '—'}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
