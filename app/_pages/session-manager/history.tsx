'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight,
  Download, History as HistoryIcon, RefreshCw, Search, SlidersHorizontal, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { SM, TONE, fmtNum, fmtTs, fmtDuration } from '@/app/_pages/session-manager/sm-shared';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → History — redesigned from zero, full features.
 *
 * Two real ledgers merged (never fabricated):
 *  1. Lifecycle audit  GET /events?limit=N (instrument subscribe/unsubscribe/
 *     pin/expire/remove + session/config/reconcile events).
 *  2. Session ledger   GET /session/history?limit=N (login → logout rows).
 *
 * Features: text search, event-type chips, severity filter, day grouping,
 * pagination, CSV export (real rows), live-follow toggle (default OFF —
 * history kabhi auto-refresh nahi hota), copy-row.
 */

type Norm = {
  key: string;
  ts: string | null;
  day: string;
  event: string;
  instrument: string | null;
  revision: number | null;
  detail: string;
  severity: string | null;
  kind: 'lifecycle' | 'session';
  raw: any;
};

function normLifecycle(e: any, i: number): Norm {
  const ts = e.ts ?? e.timestamp ?? e.created_at ?? e.at ?? null;
  const d = ts ? new Date(ts) : null;
  return {
    key: `lc-${e._id ?? i}`,
    ts: ts ? String(ts) : null,
    day: d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : 'unknown',
    event: String(e.event ?? e.event_type ?? 'event'),
    instrument: e.instrument_id ?? e.instrument_key ?? null,
    revision: e.revision ?? null,
    detail: String(e.message ?? e.details ?? '—'),
    severity: e.severity ? String(e.severity) : null,
    kind: 'lifecycle',
    raw: e,
  };
}

function normSession(h: any, i: number): Norm {
  const ts = h.login_time ?? h.ts ?? h.loginTime ?? null;
  return {
    key: `ss-${i}`,
    ts: ts ? String(ts) : null,
    day: ts && !isNaN(Date.parse(ts)) ? new Date(ts).toISOString().slice(0, 10) : 'unknown',
    event: 'SESSION',
    instrument: null,
    revision: null,
    detail: `${fmtTs(h.login_time)} → ${fmtTs(h.logout_time)} · ${fmtDuration(h.session_duration)} · ${h.logout_reason ?? '—'} · ${h.mode ?? '—'} · ${h.broker ?? '—'}`,
    severity: null,
    kind: 'session',
    raw: h,
  };
}

function categoryOf(ev: string): string {
  const e = ev.toUpperCase();
  if (e.includes('UNSUBSCR')) return 'Unsubscribe';
  if (e.includes('SUBSCR')) return 'Subscribe';
  if (e.startsWith('STOCK_')) return 'Stock';
  if (e.startsWith('SESSION') || e === 'LOGIN' || e === 'LOGOUT') return 'Session';
  if (e.includes('PIN')) return 'Pin';
  if (e.includes('EXPIR')) return 'Expiry';
  if (e.includes('FAIL') || e.includes('ERROR')) return 'Error';
  if (e.includes('CONFIG') || e.includes('RECONCILE') || e.startsWith('MANUAL_')) return 'Config';
  return 'Other';
}

const CHIPS = ['All', 'Subscribe', 'Unsubscribe', 'Stock', 'Session', 'Pin', 'Expiry', 'Error', 'Config', 'Other'] as const;

function chipTone(ev: string): string {
  const c = categoryOf(ev);
  if (c === 'Error') return 'border-rose-500/40 bg-rose-500/10 text-rose-300';
  if (c === 'Unsubscribe' || c === 'Expiry') return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  if (c === 'Subscribe') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
  if (c === 'Session') return 'border-sky-500/40 bg-sky-500/10 text-sky-300';
  if (c === 'Stock') return 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300';
  return '';
}

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

const PAGE_SIZE = 50;

export default function SessionManagerHistoryPage() {
  const [limit, setLimit] = useState(200);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<(typeof CHIPS)[number]>('All');
  const [sev, setSev] = useState<'all' | 'err' | 'ok'>('all');
  const [ledger, setLedger] = useState<'all' | 'lifecycle' | 'session'>('all');
  const [page, setPage] = useState(0);
  const [live, setLive] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const lc = useOneShot<any[]>(`${SM}/events?limit=${limit}`);
  const ss = useOneShot<any[]>(`${SM}/session/history?limit=${limit}`);
  const { onFrame } = useFrontendRealtime();

  // live-follow: optional, throttled 30s, default OFF
  const last = useRef(0);
  const lcFn = useRef(lc.refresh);
  const ssFn = useRef(ss.refresh);
  lcFn.current = lc.refresh;
  ssFn.current = ss.refresh;
  useEffect(() => {
    if (!live) return;
    return onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - last.current < 30000) return;
      last.current = t;
      lcFn.current();
      ssFn.current();
    });
  }, [onFrame, live]);

  useEffect(() => { setPage(0); }, [q, chip, sev, ledger, limit]);

  const rows = useMemo<Norm[]>(() => {
    const a = (Array.isArray(lc.data) ? lc.data : []).map(normLifecycle);
    const b = (Array.isArray(ss.data) ? ss.data : []).map(normSession);
    const all = [...a, ...b];
    all.sort((x, y) => String(y.ts ?? '').localeCompare(String(x.ts ?? '')));
    return all;
  }, [lc.data, ss.data]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (ledger !== 'all' && r.kind !== ledger) return false;
      if (chip !== 'All' && categoryOf(r.event) !== chip) return false;
      if (sev === 'err' && !(categoryOf(r.event) === 'Error' || (r.severity ?? '').toUpperCase().includes('ERROR'))) return false;
      if (sev === 'ok' && (categoryOf(r.event) === 'Error')) return false;
      if (!qq) return true;
      return r.event.toLowerCase().includes(qq) || (r.instrument ?? '').toLowerCase().includes(qq) || r.detail.toLowerCase().includes(qq);
    });
  }, [rows, q, chip, sev, ledger]);

  const errCount = rows.filter((r) => categoryOf(r.event) === 'Error').length;
  const instruments = new Set(rows.map((r) => r.instrument).filter(Boolean)).size;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  // day grouping inside the visible page
  let lastDay = '';
  const withDayBreak = pageRows.map((r) => {
    const brk = r.day !== lastDay;
    lastDay = r.day;
    return { r, brk };
  });

  const loading = (!lc.data && !lc.error) || (!ss.data && !ss.error);
  const error = lc.error ?? ss.error;

  const refreshAll = () => { lc.refresh(); ss.refresh(); };

  const exportCsv = () => {
    if (!filtered.length) return;
    const head = 'time,ledger,event,instrument,revision,detail\n';
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = filtered.map((r) => [r.ts ?? '', r.kind, r.event, r.instrument ?? '', r.revision ?? '', r.detail].map(esc).join(',')).join('\n');
    const blob = new Blob([head + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyRow = async (r: Norm) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(r.raw));
      setCopied(r.key);
      setTimeout(() => setCopied(null), 1200);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-slate-500/[0.12] via-primary/[0.06] to-cyan-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-slate-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-cyan-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Link href="/services/session-manager" aria-label="Back to overview" className="rounded-xl border border-border bg-muted/50 p-2 text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-500 via-primary to-cyan-500 text-white shadow-xl">
            <HistoryIcon className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">History</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground sm:text-sm">
              Lifecycle audit + session ledger · <span className="font-mono font-semibold text-foreground">{fmtNum(filtered.length)}</span> of {fmtNum(rows.length)} rows
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn('tabular-nums', errCount > 0 && 'border-rose-500/40 bg-rose-500/10 text-rose-300')}>{fmtNum(errCount)} errors</Badge>
            <Badge variant="outline" className="tabular-nums">{fmtNum(instruments)} instruments</Badge>
            <button onClick={() => setLive((v) => !v)} title="Live-follow (30s throttle)" className={cn('rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors', live ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-border text-muted-foreground')}>
              {live ? '● LIVE' : '○ LIVE OFF'}
            </button>
            <IstClock />
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!filtered.length} className="gap-1.5"><Download className="h-3.5 w-3.5" /> CSV</Button>
            <Button size="sm" onClick={refreshAll} className="gap-1.5 bg-gradient-to-r from-slate-500 to-cyan-500 shadow-md"><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <span className="min-w-0">History load failed: {error} — retry karo, fake rows nahi dikhayenge.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={refreshAll}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          { label: 'Audit rows', value: fmtNum(rows.filter((r) => r.kind === 'lifecycle').length), bar: 'bg-cyan-400' },
          { label: 'Sessions', value: fmtNum(rows.filter((r) => r.kind === 'session').length), bar: 'bg-sky-400' },
          { label: 'Errors', value: fmtNum(errCount), bar: errCount > 0 ? 'bg-rose-400' : 'bg-emerald-400' },
          { label: 'Instruments touched', value: fmtNum(instruments), bar: 'bg-violet-400' },
        ] as const).map((k) => (
          <Card key={k.label} className="relative overflow-hidden shadow-soft">
            <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', k.bar)} />
            <CardContent className="p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.label}</p>
              {loading ? <div className="mt-1 h-7 w-20 animate-pulse rounded bg-muted/70" /> : <p className="font-mono text-xl font-bold tabular-nums leading-7">{k.value}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* FILTERS */}
      <Card className="shadow-soft">
        <CardContent className="space-y-2.5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-sm">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search event / instrument / detail…" className="h-9 pl-8 pr-8 text-xs" />
              {q && <button onClick={() => setQ('')} aria-label="Clear" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/40 p-1">
              {(['all', 'lifecycle', 'session'] as const).map((l) => (
                <button key={l} onClick={() => setLedger(l)} className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold capitalize transition-colors', ledger === l ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground')}>{l === 'all' ? 'Both ledgers' : l}</button>
              ))}
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/40 p-1">
              {(['all', 'err', 'ok'] as const).map((s) => (
                <button key={s} onClick={() => setSev(s)} className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors', sev === s ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground')}>{s === 'all' ? 'All' : s === 'err' ? 'Errors' : 'Non-error'}</button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {([100, 200, 500] as const).map((n) => (
                <button key={n} onClick={() => setLimit(n)} className={cn('rounded-lg border px-2 py-1.5 font-mono text-[11px] tabular-nums', limit === n ? 'border-primary/40 bg-primary/10' : 'border-border text-muted-foreground')}>{n}</button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            {CHIPS.map((c) => (
              <button key={c} onClick={() => setChip(c)} className={cn('rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors', chip === c ? 'border-primary/50 bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>{c}</button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* TABLE */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="flex flex-row items-center gap-2 border-b border-border/50 bg-muted/30 py-2.5">
          <CardTitle className="flex items-center gap-2 text-xs">
            <CalendarDays className="h-3.5 w-3.5" /> Audit trail · day-grouped
          </CardTitle>
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{safePage + 1} / {totalPages}</span>
            <Button size="sm" variant="ghost" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/80 text-left text-muted-foreground backdrop-blur">
                <tr>
                  <th className="px-3 py-2">Time</th><th className="px-3 py-2">Event</th><th className="px-3 py-2">Instrument</th>
                  <th className="px-3 py-2">Rev</th><th className="px-3 py-2">Details</th><th className="w-10 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [0, 1, 2, 3, 4].map((i) => <tr key={i} className="border-b border-border/40"><td colSpan={6} className="px-3 py-2"><div className="h-7 animate-pulse rounded bg-muted/60" /></td></tr>)
                ) : withDayBreak.map(({ r, brk }) => (
                  <Fragment key={r.key}>
                    {brk && <tr className="bg-primary/[0.06]"><td colSpan={6} className="px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-primary">{r.day}</td></tr>}
                    <tr className="border-b border-border/40 transition-colors hover:bg-white/[0.03]">
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">{fmtTs(r.ts)}</td>
                      <td className="px-3 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <Badge variant="outline" className={cn('font-mono text-[10px]', r.severity ? (TONE[r.severity] ?? '') : chipTone(r.event))}>{r.event.toUpperCase().slice(0, 24)}</Badge>
                          {r.kind === 'session' && <Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 font-mono text-[9px] text-sky-300">LEDGER</Badge>}
                        </span>
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-1.5 font-mono" title={r.instrument ?? undefined}>{r.instrument ?? '—'}</td>
                      <td className="px-3 py-1.5 font-mono tabular-nums">{r.revision != null ? fmtNum(r.revision) : '—'}</td>
                      <td className="max-w-[380px] truncate px-3 py-1.5 text-muted-foreground" title={r.detail}>{r.detail}</td>
                      <td className="px-2 py-1.5">
                        <button onClick={() => void copyRow(r)} title="Copy raw JSON" className="rounded p-1 text-muted-foreground/50 hover:bg-muted hover:text-foreground">
                          {copied === r.key ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> : <span className="font-mono text-[10px]">⧉</span>}
                        </button>
                      </td>
                    </tr>
                  </Fragment>
                ))}
                {!loading && !filtered.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No history rows match — filter badlo ya limit badhao.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Sources: <span className="font-mono">GET /events · GET /session/history</span> — dono real ledgers merged, time-sorted. Default manual refresh (live-follow optional, 30s throttle). Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
