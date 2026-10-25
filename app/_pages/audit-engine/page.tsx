'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowLeft, Database, FileSearch,
  GitBranch, HeartPulse, History, Layers, ListFilter,
  PenLine, Play, Power, RefreshCw, RotateCw, Search, ShieldCheck, Siren,
  Timer, Wallet, X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useEngineStatus } from '@/lib/engine-realtime';
import { useBackend } from '@/lib/use-backend';
import { getTerminalAudit } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  CATEGORY_COLORS, EMPTY_FILTERS, SEVERITY_TONE, fetchAuditQuery, fetchAuditTrace,
  fmtAgo, fmtClockIST, fmtNum, fmtTs, postAuditFlush, postAuditRecord,
  useAuditSummary, useNow, type AuditFilters,
} from './audit-data';

/**
 * SERVICES -> Security -> Audit Engine (full redesign, advanced)
 *
 * Append-only, immutable decision + activity trail. Everything is real:
 *   engine    -> WS#2 engines channel + REST fallback (lifecycle controls)
 *   posture   -> GET .../audit_engine/summary (15s auto-refresh, real aggregations)
 *   explorer  -> GET .../audit_engine/query (source/event/category/severity/correlation/search)
 *   trace     -> GET .../audit_engine/trace/{id} (end-to-end correlation chain)
 *   record    -> POST .../audit_engine/record (manual append, fully working)
 *   trading   -> GET /api/terminal/audit (decision trail, separate collection)
 * Zero rows render honestly — nothing is fabricated.
 */
const ENGINES = '/api/services/engines';
const LIMITS = [25, 50, 100, 200];

export default function AuditEnginePage() {
  const now = useNow(1000);
  const { data, error, connected, refresh } = useEngineStatus<any>('audit_engine', `${ENGINES}/audit_engine`);
  const { data: summary, error: sumError, loading: sumLoading, lastUpdated, refresh: refreshSummary } = useAuditSummary();

  const refreshAll = () => { refresh(); refreshSummary(); refreshExplorer(); refreshTerminal(); };

  // ---- engine controls ----
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const runAction = async (name: string, path: string, body?: unknown) => {
    setBusy(name); setNotice(null);
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      const json = await res.json().catch(() => ({}));
      setNotice(json.ok && res.ok ? `${name} done.` : (json.error ?? json.reason ?? `HTTP ${res.status}`));
    } catch (e: any) {
      setNotice(e?.message ?? String(e));
    }
    setBusy(null); refresh(); refreshSummary();
  };

  // ---- explorer ----
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refreshExplorer = useCallback(() => {
    setSearching(true); setSearchError(null);
    fetchAuditQuery(applied)
      .then((events) => setRows(events))
      .catch((e: any) => setSearchError(e?.message ?? 'query failed'))
      .finally(() => setSearching(false));
  }, [applied]);

  // initial load + every applied-filter change
  useEffect(() => {
    setSearching(true); setSearchError(null);
    fetchAuditQuery(applied)
      .then((events) => setRows(events))
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

  // ---- record ----
  const [recSource, setRecSource] = useState('operator');
  const [recEvent, setRecEvent] = useState('NOTE');
  const [recStatus, setRecStatus] = useState('info');
  const [recMsg, setRecMsg] = useState('');
  const [recBusy, setRecBusy] = useState(false);
  const submitRecord = async () => {
    setRecBusy(true); setNotice(null);
    try {
      const entry = await postAuditRecord({ source: recSource, event: recEvent, status: recStatus, message: recMsg });
      setNotice(`Recorded ${(entry as any)?.event_id ?? 'entry'} — trail me sabse upar.`);
      setRecMsg('');
      refreshSummary(); refreshExplorer();
    } catch (e: any) {
      setNotice(e?.message ?? 'record failed');
    }
    setRecBusy(false);
  };

  // ---- trading decisions trail ----
  const [tLimit, setTLimit] = useState(50);
  const loadTerminal = useCallback(
    () => getTerminalAudit(tLimit).then((r) => (Array.isArray(r?.data) ? r.data : [])),
    [tLimit],
  );
  const { data: terminalRows, loading: tLoading, error: tError, refresh: refreshTerminal } = useBackend<any[]>(loadTerminal);
  const tEntries = Array.isArray(terminalRows) ? terminalRows : [];

  const health = data?.health ?? 'UNKNOWN';
  const byCat = summary?.byCategory ?? {};
  const bySev = summary?.bySeverity ?? {};
  const bySrc = summary?.bySource ?? {};
  const catEntries = Object.entries(byCat).sort((a: any, b: any) => b[1] - a[1]);
  const srcEntries = Object.entries(bySrc).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8);
  const maxCat = Math.max(1, ...(catEntries.map((c: any) => Number(c[1])) as number[]));
  const snapStale = lastUpdated != null && now - lastUpdated > 30_000;
  const latest = summary?.latestEvent ?? null;

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.14] via-violet-500/[0.08] to-emerald-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-indigo-500/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-emerald-500/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute left-1/3 -bottom-20 h-48 w-48 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-emerald-500 text-white shadow-xl">
            <FileSearch className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Audit Engine
            </h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground sm:text-sm">
              append-only trail · {fmtNum(summary?.totalEvents)} events · {fmtClockIST(new Date(now).toISOString())} IST
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn(connected ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300')}>
              <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', connected ? 'animate-pulse bg-emerald-400' : 'bg-amber-400')} />
              {connected ? 'LIVE' : 'REST'}
            </Badge>
            {snapStale && <Badge variant="outline" className="border-amber-500/40 text-amber-300">STALE</Badge>}
            {notice && <Badge variant="outline" className="max-w-72 truncate">{notice}</Badge>}
            <Button size="sm" onClick={refreshAll} className="gap-1.5 bg-gradient-to-r from-indigo-500 via-violet-500 to-emerald-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" variant="outline" asChild className="gap-1.5">
              <Link href="/services/system/profile/audit_engine">
                <FileSearch className="h-3.5 w-3.5" /> Engine Profile
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild className="gap-1.5">
              <Link href="/services/system">
                <Layers className="h-3.5 w-3.5" /> All engines
              </Link>
            </Button>
          </div>
        </div>
        <div className="relative flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-2.5 sm:px-5">
          <EngineBtn label="Start" icon={Play} busy={busy} onClick={() => void runAction('Start', `${ENGINES}/audit_engine/start`)} />
          <EngineBtn label="Stop" icon={Power} busy={busy} onClick={() => void runAction('Stop', `${ENGINES}/audit_engine/stop`, {})} />
          <EngineBtn label="Restart" icon={RotateCw} busy={busy} spin onClick={() => void runAction('Restart', `${ENGINES}/audit_engine/restart`)} />
          <EngineBtn label="Beat" icon={HeartPulse} busy={busy} onClick={() => void runAction('Heartbeat', `${ENGINES}/audit_engine/heartbeat`)} />
          <EngineBtn label="Flush" icon={Database} busy={busy} onClick={() => {
            setBusy('Flush'); setNotice(null);
            postAuditFlush()
              .then((r: any) => setNotice(`Flush done — ring ${r?.ringSize ?? '—'}, persist ${String(r?.persistEnabled ?? '—')}.`))
              .catch((e: any) => setNotice(e?.message ?? 'flush failed'))
              .finally(() => { setBusy(null); refresh(); refreshSummary(); });
          }} />
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {health} · {data?.state ?? '—'} · summary {lastUpdated ? fmtAgo(new Date(lastUpdated).toISOString(), now) : '—'}
          </span>
        </div>
        <div className="relative h-2 w-full overflow-hidden bg-muted/60">
          <span className="block h-full bg-gradient-to-r from-indigo-500 via-violet-500 to-emerald-500" style={{ width: '100%' }} />
        </div>
      </div>

      {(error || sumError) && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0">{error ? `Engine: ${error}` : ''}{error && sumError ? ' · ' : ''}{sumError ? `Summary: ${sumError}` : ''}</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={refreshAll}>Retry</Button>
        </div>
      )}

      {/* STATS */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <AuditStat bar="bg-indigo-400" chip="bg-gradient-to-br from-indigo-500 to-violet-600" icon={Database} label="Total events" value={fmtNum(summary?.totalEvents)} sub={sumLoading ? 'loading…' : 'system + legacy'} />
        <AuditStat bar="bg-amber-400" chip="bg-gradient-to-br from-amber-500 to-orange-600" icon={Siren} label="Blocks" value={fmtNum(summary?.blocks)} sub="warning + error" tone={Number(summary?.blocks) > 0 ? 'text-amber-300' : ''} />
        <AuditStat bar="bg-rose-400" chip="bg-gradient-to-br from-rose-500 to-red-600" icon={AlertTriangle} label="Critical" value={fmtNum(summary?.criticalEvents)} sub="critical + security" tone={Number(summary?.criticalEvents) > 0 ? 'text-rose-300' : ''} />
        <AuditStat bar="bg-emerald-400" chip="bg-gradient-to-br from-emerald-500 to-teal-600" icon={ShieldCheck} label="Trading" value={fmtNum(summary?.tradingEvents)} sub={`risk ${fmtNum(summary?.riskDecisions)}`} />
        <AuditStat bar="bg-cyan-400" chip="bg-gradient-to-br from-cyan-500 to-sky-600" icon={Layers} label="Sources" value={fmtNum(Object.keys(bySrc).length)} sub={`broker ${fmtNum(summary?.brokerErrors)} err`} />
        <AuditStat bar="bg-violet-400" chip="bg-gradient-to-br from-violet-500 to-purple-600" icon={History} label="Latest" value={latest ? fmtAgo(latest.ts, now) : '—'} sub={latest ? `${latest.source ?? ''} ${latest.event ?? ''}`.trim() || '—' : 'no events yet'} />
      </div>

      {/* BREAKDOWNS */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-indigo-500/10 to-violet-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
              By category
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3">
            {catEntries.length === 0 ? <EmptyMini text="No category data yet." /> : catEntries.slice(0, 8).map(([cat, n]: any, i: number) => (
              <div key={String(cat)}>
                <div className="flex justify-between gap-2 text-[11px]">
                  <button type="button" className="truncate font-mono hover:text-primary hover:underline" title={`Filter ${cat}`} onClick={() => { const f = { ...draft, category: String(cat) }; setDraft(f); setApplied(f); }}>{String(cat ?? '—')}</button>
                  <span className="shrink-0 font-mono font-bold tabular-nums">{fmtNum(Number(n))}</span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted/70">
                  <div className="h-full rounded-full" style={{ width: `${(Number(n) / maxCat) * 100}%`, background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-amber-500/10 to-orange-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><Siren className="h-3.5 w-3.5" /></span>
              By severity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-3">
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(SEVERITY_TONE).map((sev) => {
                const n = Number(bySev[sev] ?? 0);
                return (
                  <button key={sev} type="button" onClick={() => { const f = { ...draft, severity: sev }; setDraft(f); setApplied(f); }}
                    className={cn('rounded-full border px-2.5 py-1 font-mono text-[11px]', SEVERITY_TONE[sev], n === 0 && 'opacity-50')}>
                    {sev}: {fmtNum(n)}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">Chip dabao → explorer us severity par filter ho jayega.</p>
            <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2 text-[11px]">
              <p className="text-muted-foreground">Top sources</p>
              <div className="mt-1 space-y-0.5 font-mono">
                {srcEntries.length === 0 ? <span className="text-muted-foreground">—</span> : srcEntries.map(([s, n]: any) => (
                  <div key={String(s)} className="flex justify-between gap-2"><span className="truncate">{String(s)}</span><span className="tabular-nums">{fmtNum(Number(n))}</span></div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* RECORD FORM */}
        <Card className="overflow-hidden border-emerald-500/25 shadow-soft">
          <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-teal-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 p-1.5 text-white shadow"><PenLine className="h-3.5 w-3.5" /></span>
              Manual entry · append-only
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Source</span>
                <Input value={recSource} onChange={(e) => setRecSource(e.target.value)} className="h-8 font-mono text-xs" placeholder="operator" />
              </label>
              <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Event</span>
                <Input value={recEvent} onChange={(e) => setRecEvent(e.target.value)} className="h-8 font-mono text-xs" placeholder="NOTE" />
              </label>
            </div>
            <label className="block space-y-1 text-[11px]"><span className="text-muted-foreground">Status / severity</span>
              <Select value={recStatus} onValueChange={setRecStatus}>
                <SelectTrigger className="h-8 font-mono text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{['info', 'warning', 'error', 'critical', 'security'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="block space-y-1 text-[11px]"><span className="text-muted-foreground">Message</span>
              <Input value={recMsg} onChange={(e) => setRecMsg(e.target.value)} className="h-8 text-xs" placeholder="kya hua, ek line me…" />
            </label>
            <Button size="sm" onClick={submitRecord} disabled={recBusy || !recSource.trim() || !recEvent.trim()} className="w-full gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-600">
              <PenLine className="h-3.5 w-3.5" /> {recBusy ? 'Recording…' : 'Append to immutable trail'}
            </Button>
            <p className="text-[10px] text-muted-foreground">Har entry ko fresh event_id milta hai — purani entries kabhi rewrite nahi hoti.</p>
          </CardContent>
        </Card>
      </div>

      {/* EXPLORER */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-indigo-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 p-1.5 text-white shadow"><ListFilter className="h-3.5 w-3.5" /></span>
            Trail explorer · advanced filters
            <Badge variant="outline" className="ml-auto font-mono tabular-nums">{rows.length} rows</Badge>
            {searching && <Badge variant="outline">searching…</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <label className="col-span-2 space-y-1 text-[11px]"><span className="text-muted-foreground">Search (message / reason / symbol / id)</span>
              <span className="relative block">
                <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={draft.search} onChange={(e) => setDraft({ ...draft, search: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }} className="h-8 pl-7 text-xs" placeholder="RELIANCE, BLOCK, evt_…" />
              </span>
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Source</span>
              <Input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} className="h-8 font-mono text-xs" placeholder="risk" />
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Event</span>
              <Input value={draft.event} onChange={(e) => setDraft({ ...draft, event: e.target.value })} className="h-8 font-mono text-xs" placeholder="SCHEDULER_STARTED" />
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Category</span>
              <Input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="h-8 font-mono text-xs" placeholder="TRADING" />
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Severity</span>
              <Select value={draft.severity || '__all'} onValueChange={(v) => setDraft({ ...draft, severity: v === '__all' ? '' : v })}>
                <SelectTrigger className="h-8 font-mono text-xs"><SelectValue placeholder="all" /></SelectTrigger>
                <SelectContent><SelectItem value="__all">all</SelectItem>{Object.keys(SEVERITY_TONE).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Correlation ID</span>
              <Input value={draft.correlation_id} onChange={(e) => setDraft({ ...draft, correlation_id: e.target.value })} className="h-8 font-mono text-xs" placeholder="CORR-…" />
            </label>
            <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Limit</span>
              <Select value={String(draft.limit)} onValueChange={(v) => setDraft({ ...draft, limit: Number(v) })}>
                <SelectTrigger className="h-8 font-mono text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{LIMITS.map((l) => <SelectItem key={l} value={String(l)}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={runSearch} disabled={searching} className="gap-1.5 bg-gradient-to-r from-violet-500 to-indigo-600"><Search className="h-3.5 w-3.5" /> Search trail</Button>
            <Button size="sm" variant="outline" onClick={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); setExpanded(null); setTraceCorr(null); }} className="gap-1.5"><X className="h-3.5 w-3.5" /> Reset</Button>
          </div>

          {searchError && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{searchError}</div>}

          {traceCorr ? (
            <div className="rounded-xl border border-violet-500/30 bg-violet-500/[0.05] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <GitBranch className="h-4 w-4 text-violet-300" />
                <span className="font-mono text-xs font-semibold">Trace {traceCorr}</span>
                <Badge variant="outline" className="font-mono">{traceRows.length} links</Badge>
                <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1 text-xs" onClick={() => setTraceCorr(null)}><ArrowLeft className="h-3 w-3" /> Back to results</Button>
              </div>
              {traceBusy ? <p className="py-4 text-center text-xs text-muted-foreground">Loading chain…</p> : traceRows.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">Is correlation ID ki koi chain nahi mili.</p>
              ) : (
                <div className="relative mt-3 space-y-0">
                  {traceRows.map((e: any, i: number) => (
                    <div key={e.event_id ?? i} className="relative flex gap-3 pb-3 last:pb-0">
                      {i < traceRows.length - 1 && <div className="absolute bottom-0 left-[13px] top-8 w-px bg-violet-500/40" />}
                      <div className="z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-violet-500/40 bg-violet-500/15 font-mono text-[10px] text-violet-200">{traceRows.length - i}</div>
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
          ) : rows.length === 0 && !searching ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Koi entry nahi — filter badlo ya limit badhao. (Honest zero.)</p>
          ) : (
            <div className="max-h-[30rem] space-y-1.5 overflow-auto pr-1">
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
                    </button>
                    {open && (
                      <div className="mt-2 space-y-1.5 border-t border-border/50 pt-2 font-mono text-[11px]">
                        <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
                          <span><span className="text-muted-foreground">id: </span>{e.event_id ?? '—'}</span>
                          <span><span className="text-muted-foreground">category: </span>{e.category ?? '—'}</span>
                          <span><span className="text-muted-foreground">symbol: </span>{e.symbol ?? '—'}</span>
                          <span><span className="text-muted-foreground">component: </span>{e.component ?? '—'}</span>
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
        </CardContent>
      </Card>

      {/* TRADING DECISIONS */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-sky-500/10 to-blue-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 p-1.5 text-white shadow"><Wallet className="h-3.5 w-3.5" /></span>
            Trading decisions · terminal gateway
            <span className="ml-auto flex items-center gap-2">
              <Badge variant="outline" className="font-mono tabular-nums">{tEntries.length}</Badge>
              <Select value={String(tLimit)} onValueChange={(v) => setTLimit(Number(v))}>
                <SelectTrigger className="h-7 w-20 font-mono text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent>{LIMITS.map((l) => <SelectItem key={l} value={String(l)}>{l}</SelectItem>)}</SelectContent>
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
                    {e?.accepted != null && <Badge variant="outline" className={e.accepted ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}>{e.accepted ? 'accepted' : 'blocked'}</Badge>}
                  </div>
                ))}
              </div>
            )}
        </CardContent>
      </Card>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Timer className="h-3 w-3" />
        Engine live over WS#2 · summary auto-refresh 15s · explorer manual search · missing = '—', fake kabhi nahi.
      </p>
    </div>
  );
}

function EngineBtn({ label, icon: Icon, busy, spin, onClick }: { label: string; icon: any; busy: string | null; spin?: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={busy != null} onClick={onClick}>
      <Icon className={cn('h-3 w-3', spin && busy === label && 'animate-spin')} /> {busy === label ? '…' : label}
    </Button>
  );
}

function AuditStat({ bar, chip, icon: Icon, label, value, sub, tone }: {
  bar: string; chip: string; icon: any; label: string; value: string; sub: string; tone?: string;
}) {
  return (
    <Card className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-0.5">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', bar)} />
      <CardContent className="flex items-center gap-2.5 p-3">
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-lg', chip)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className={cn('truncate font-mono text-base font-bold tabular-nums leading-6', tone)}>{value}</p>
          <p className="truncate text-[10px] text-muted-foreground">{sub}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyMini({ text }: { text: string }) {
  return <p className="py-3 text-center text-[11px] text-muted-foreground">{text}</p>;
}
