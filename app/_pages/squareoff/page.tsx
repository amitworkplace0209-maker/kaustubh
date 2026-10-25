'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity, RotateCcw, RefreshCw, Timer, Power, Layers, ShieldCheck,
  History, CalendarDays, Radio, FileSearch,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useEngineStatus } from '@/lib/engine-realtime';
import { useBackend } from '@/lib/use-backend';
import {
  squareOffTradingPosition, getPositions, getOrderBook,
  getSquareoffDetail, getSquareoffHistory, runSquareoffNow, getTerminalAudit,
} from '@/lib/api';

const ENGINE = '/api/services/engines/squareoff_engine';

type Tab = 'live' | 'history' | 'perday';

function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtIST(ts?: number | string | null): string {
  if (ts == null || ts === '') return '—';
  const d = typeof ts === 'number' ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function fmtClockIST(ts?: number | string | null): string {
  if (ts == null || ts === '') return '—';
  const d = typeof ts === 'number' ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

const STATE_TONE: Record<string, string> = {
  SQUAREOFF_COMPLETE: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  COMPLETED: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  COMPLETE: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  CLOSED: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  SQUAREOFF_IN_PROGRESS: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
  IN_PROGRESS: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
  VERIFYING: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
  WAITING_RETRY: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
  PLACING_EXIT: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
  SQUAREOFF_INCOMPLETE: 'border-rose-500/40 bg-rose-500/10 text-rose-700',
  FAILED: 'border-rose-500/40 bg-rose-500/10 text-rose-700',
  INCOMPLETE: 'border-rose-500/40 bg-rose-500/10 text-rose-700',
  PARTIAL: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
  IDLE: 'border-slate-500/40 bg-slate-500/10 text-slate-700',
  SCHEDULED: 'border-slate-500/40 bg-slate-500/10 text-slate-700',
  NO_POSITIONS: 'border-slate-500/40 bg-slate-500/10 text-slate-700',
};

function stateTone(s?: string): string {
  if (!s) return STATE_TONE.IDLE;
  return STATE_TONE[String(s).toUpperCase()] ?? STATE_TONE.IDLE;
}

function posQty(p: any): number {
  const v = p?.netQuantity ?? p?.quantity ?? p?.netQty ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function posSymbol(p: any): string {
  return p?.symbol ?? p?.tradingSymbol ?? p?.tradingsymbol ?? '—';
}

function eligibleForScope(p: any, scope: string): boolean {
  if (posQty(p) === 0) return false;
  const s = String(scope || 'MIS').toUpperCase();
  if (s === 'ALL') return true;
  const prod = String(p?.product || '').toUpperCase();
  if (s === 'INTRADAY') return prod === 'MIS' || prod === 'INTRADAY' || prod === '';
  return prod === s || (s === 'MIS' && prod === '');
}

export default function SquareoffPage() {
  const { data: engine, error: engineError, source, connected, refresh: refreshEngine } =
    useEngineStatus<any>('squareoff_engine', ENGINE);

  const [detail, setDetail] = useState<any>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const loadDetail = async () => {
    try {
      const r = await getSquareoffDetail();
      setDetail(r?.data ?? r);
      setDetailError(null);
    } catch (e: any) {
      setDetailError(e?.message ?? 'detail fetch failed');
    }
  };
  useEffect(() => { void loadDetail(); }, []);

  const { data: positionsRaw, error: posError, refresh: refreshPositions } =
    useBackend(async () => {
      const r = await getPositions();
      const d = r?.data;
      return d?.data ?? d ?? [];
    });
  const { data: ordersRaw, refresh: refreshOrders } =
    useBackend(async () => {
      try {
        const r = await getOrderBook();
        const d = r?.data;
        if (Array.isArray(d)) return d;
        if (Array.isArray(d?.data)) return d.data;
        if (Array.isArray(d?.orders)) return d.orders;
        return [];
      } catch { return []; }
    });

  const [history, setHistory] = useState<any>(null);
  const loadHistory = async () => {
    try {
      const r = await getSquareoffHistory(20);
      setHistory(r?.data ?? r);
    } catch { /* honest empty */ }
  };
  useEffect(() => { void loadHistory(); }, []);
  const { data: auditRaw } = useBackend(async () => {
    try {
      const r = await getTerminalAudit(100);
      return Array.isArray(r?.data) ? r.data : [];
    } catch { return []; }
  });

  const liveState: string | undefined = engine?.squareoffState ?? detail?.squareoffState;
  useEffect(() => {
    if (source !== 'realtime') return;
    void loadDetail();
    void loadHistory();
    refreshPositions();
    refreshOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveState, engine?.activeRun?.requestId]);

  const refreshAll = () => {
    refreshEngine();
    void loadDetail();
    void loadHistory();
    refreshPositions();
    refreshOrders();
  };

  const sched = engine?.schedule ?? engine?.config ?? detail?.schedule ?? {};
  const squareoffTime: string = sched?.squareoffTime ?? detail?.schedule?.squareoffTime ?? '15:16';
  const freezeTime: string = sched?.freezeTime ?? detail?.schedule?.freezeTime ?? '15:15';
  const retrySec: number | null = sched?.retryIntervalSec ?? detail?.schedule?.retryIntervalSec ?? 15;
  const maxRetries: number | null = sched?.maxRetries ?? detail?.schedule?.maxRetries ?? 3;
  const scope: string = String(sched?.positionScope ?? sched?.applyTo ?? detail?.schedule?.positionScope ?? 'MIS');
  const autoEnabled: boolean | null = sched?.autoEnabled ?? sched?.enabled ?? detail?.schedule?.autoEnabled ?? null;
  const tradingDate: string = engine?.tradingDate ?? detail?.tradingDate ?? history?.tradingDate ?? '—';

  const state: string = engine?.squareoffState ?? detail?.squareoffState ?? 'IDLE';
  const health: string = engine?.health ?? 'UNKNOWN';

  const activeRun = engine?.activeRun ?? detail?.activeRun ?? (history?.active?.[0] as any) ?? null;
  const lastRun = engine?.lastRun ?? detail?.lastRun ?? (history?.recent?.[0] as any) ?? null;
  const recentRuns: any[] = useMemo(
    () => engine?.recentRuns ?? engine?.recent ?? detail?.recent ?? history?.recent ?? [],
    [engine?.recentRuns, engine?.recent, detail?.recent, history?.recent],
  );
  const byDay: any[] = useMemo(
    () => engine?.runsByDay ?? detail?.byDay ?? history?.byDay ?? [],
    [engine?.runsByDay, detail?.byDay, history?.byDay],
  );

  const posList: any[] = Array.isArray(positionsRaw) ? positionsRaw : [];
  const openList = posList.filter((p) => posQty(p) !== 0);
  const toCloseList = posList.filter((p) => eligibleForScope(p, scope));
  const pendingCount: number | null =
    detail?.pendingOrders ?? (Array.isArray(ordersRaw)
      ? ordersRaw.filter((o: any) => ['PENDING', 'OPEN', 'TRIGGER_PENDING', 'PLACED', 'SUBMITTED'].includes(String(o?.status ?? o?.orderStatus ?? '').toUpperCase())).length
      : null);
  const openCount: number | null = detail?.openPositions ?? (posList.length ? openList.length : null);
  const toCloseCount: number | null = detail?.positionsToClose ?? (posList.length ? toCloseList.length : null);

  const [tab, setTab] = useState<Tab>('live');
  const [day, setDay] = useState<string>('');
  const dayOptions = useMemo(() => {
    const days = (byDay || []).map((d: any) => String(d.tradingDate)).filter(Boolean);
    const runs = (recentRuns || []).map((r: any) => String(r.tradingDate || '')).filter(Boolean);
    return Array.from(new Set([...days, ...runs])).sort().reverse();
  }, [byDay, recentRuns]);
  useEffect(() => {
    if (!day && dayOptions.length) setDay(dayOptions[0]);
  }, [dayOptions, day]);
  const dayRuns = useMemo(
    () => (recentRuns || []).filter((r: any) => !day || String(r.tradingDate) === day),
    [recentRuns, day],
  );
  const daySummary = useMemo(() => {
    const slot = (byDay || []).find((d: any) => String(d.tradingDate) === day);
    if (slot) return slot;
    if (!dayRuns.length) return null;
    return {
      tradingDate: day,
      runs: dayRuns.length,
      completed: dayRuns.filter((r: any) => String(r.status) === 'COMPLETED').length,
      partial: dayRuns.filter((r: any) => String(r.status) === 'PARTIAL').length,
      failed: dayRuns.filter((r: any) => String(r.status) === 'FAILED').length,
      positionsClosed: dayRuns.reduce((s: number, r: any) => s + (Number(r.positionsClosed) || (r.results || []).filter((x: any) => ['COMPLETE', 'SUBMITTED'].includes(String(x.status))).length), 0),
      attempts: dayRuns.reduce((s: number, r: any) => s + ((r.results || []).length || 0), 0),
    };
  }, [byDay, dayRuns, day]);

  const sqAudit = useMemo(() => {
    const rows = Array.isArray(auditRaw) ? auditRaw : [];
    return rows.filter((e: any) => {
      const blob = `${e?.action ?? ''} ${e?.reason ?? ''} ${e?.event_id ?? ''} ${e?.kind ?? ''}`.toUpperCase();
      return blob.includes('SQUARE') || blob.includes('SQO-') || blob.includes('SO_');
    }).slice(0, 30);
  }, [auditRaw]);

  const [selected, setSelected] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmOne, setConfirmOne] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [runAllBusy, setRunAllBusy] = useState(false);
  const [runAllNotice, setRunAllNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const squareOffSelected = async () => {
    if (!selected || !confirmOne) return;
    setBusy(true); setNotice(null);
    try {
      const res: any = await squareOffTradingPosition({
        exchange: selected.exchange || 'nse_cm',
        token: selected.token || selected.instrumentToken || '',
        product: selected.product || 'MIS',
        quantity: Math.abs(posQty(selected)),
        position_type: posQty(selected) > 0 ? 'POSITION_BUY' : 'POSITION_SELL',
      });
      const stat = res?.data?.stat ?? res?.stat;
      if (stat === 'Ok' || res?.ok) setNotice({ kind: 'ok', text: 'Square-off order placed with broker.' });
      else setNotice({ kind: 'err', text: res?.data?.remarks ?? res?.remarks ?? res?.error ?? 'square-off rejected' });
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message ?? String(e) });
    }
    setBusy(false);
    setConfirmOne(false);
    refreshPositions();
    void loadDetail();
  };

  const runAllNow = async () => {
    if (!confirmAll) return;
    setRunAllBusy(true); setRunAllNotice(null);
    try {
      const res: any = await runSquareoffNow(detail?.terminal || 'kotak', 'manual');
      const payload = res?.data ?? res;
      if (res?.ok || payload?.ok) {
        setRunAllNotice({ kind: 'ok', text: `Run ${payload?.runId ?? payload?.requestId ?? ''} · ${payload?.status ?? 'submitted'} · found ${payload?.total ?? '—'} · filled ${payload?.filled ?? '—'}` });
      } else {
        setRunAllNotice({ kind: 'err', text: res?.error ?? payload?.error ?? 'square-off run rejected' });
      }
    } catch (e: any) {
      setRunAllNotice({ kind: 'err', text: e?.message ?? String(e) });
    }
    setRunAllBusy(false);
    setConfirmAll(false);
    void loadDetail();
    void loadHistory();
    refreshPositions();
  };

  const live = Boolean(connected && source === 'realtime');

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <section className="relative overflow-hidden rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.07] via-orange-500/[0.04] to-rose-500/[0.07] shadow-sm">
        <div aria-hidden className="pointer-events-none absolute -left-10 -top-10 h-44 w-44 rounded-full bg-amber-500/12 blur-[80px]" />
        <div aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-rose-500/12 blur-[80px]" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 via-orange-500 to-rose-600 text-white shadow-sm">
            <RotateCcw className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Squareoff Engine</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              End-of-trading safety · MARKET-exit · 15s retry · squareoff_engine · Today {tradingDate} IST
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={`text-[10px] font-medium ${stateTone(state)}`}>{state}</Badge>
            {health !== 'UNKNOWN' && (
              <Badge variant="outline" className={`text-[10px] font-medium ${stateTone(health)}`}>{health}</Badge>
            )}
            <Badge variant="outline" className="hidden sm:inline-flex font-mono text-[10px]">
              {engine?.engineName ?? 'Squareoff'} · v{engine?.version ?? '—'}
            </Badge>
            <Badge variant="outline" className="text-[10px] font-mono">
              {live ? 'LIVE · WS#2' : 'REST snapshot'}
            </Badge>
            <Button size="sm" variant="outline" onClick={refreshAll} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" variant="outline" asChild className="gap-1.5">
              <Link href="/services/system/profile/squareoff_engine">
                <FileSearch className="h-3.5 w-3.5" /> Profile
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {engineError && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-700">
          Engine error: {engineError}
        </div>
      )}
      {detailError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700">
          Detail unavailable ({detailError}) — showing engine snapshot.
        </div>
      )}

      {/* METRICS */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Engine state</p>
          <p className="mt-1 font-mono font-bold tabular-nums">{state}</p>
          <p className="mt-1 text-xs text-muted-foreground">{`last beat ${engine?.lastHeartbeat ? fmtClockIST(engine.lastHeartbeat) : '—'}`}</p>
        </div>
        <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Schedule</p>
          <p className="mt-1 font-mono font-bold tabular-nums">{squareoffTime} IST</p>
          <p className="mt-1 text-xs text-muted-foreground">{`freeze ${freezeTime} · retry ${retrySec ?? '—'}s · scope ${scope}`}</p>
        </div>
        <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Flow safety</p>
          <p className="mt-1 font-mono font-bold tabular-nums">{activeRun ? 'RUNNING' : 'IDLE'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{`pending ${pendingCount ?? '—'} · remaining ${activeRun?.results?.length ?? detail?.remainingQuantity ?? '—'}`}</p>
        </div>
        <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Residual positions</p>
          <p className="mt-1 font-mono font-bold tabular-nums">{openCount != null ? String(openCount) : '—'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{`to close ${toCloseCount ?? '—'} · auto ${autoEnabled == null ? '—' : autoEnabled ? 'ON' : 'OFF'}`}</p>
        </div>
      </div>

      {/* TABS */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 pb-2">
        {([
          { k: 'live', label: 'Live', icon: Radio },
          { k: 'history', label: 'History', icon: History },
          { k: 'perday', label: 'Per Day', icon: CalendarDays },
        ] as const).map(({ k, label, icon: Icon }) => (
          <Button key={k} size="sm" variant={tab === k ? 'default' : 'outline'} onClick={() => setTab(k)}>
            <Icon className="mr-1 h-3 w-3" /> {label}
            {k === 'history' && recentRuns.length > 0 && <Badge variant="secondary" className="ml-1">{recentRuns.length}</Badge>}
          </Button>
        ))}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {connected ? 'socket up' : 'socket down'} · {source === 'realtime' ? 'WS#2' : 'REST'}
        </span>
      </div>

      {/* LIVE */}
      {tab === 'live' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Timer className="h-3.5 w-3.5 text-amber-700" />
              <h2 className="text-sm font-semibold text-foreground">Squareoff card</h2>
              <span className="ml-auto font-mono text-[10px]">Auto [{autoEnabled == null ? '—' : autoEnabled ? 'ON' : 'OFF'}]</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-border/60 bg-background p-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Squareoff time</p>
                <p className="font-mono tabular-nums">{squareoffTime}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">IST · Asia/Kolkata</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background p-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Freeze before</p>
                <p className="font-mono tabular-nums">1 min</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">freeze {freezeTime} IST</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background p-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Retry interval</p>
                <p className="font-mono tabular-nums">{retrySec ?? '—'} sec</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">max {maxRetries ?? '—'} tries</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background p-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Position scope</p>
                <p className="font-mono tabular-nums">{scope}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">intraday only</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-border/60 bg-background p-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Pending orders</p>
                <p className="font-mono tabular-nums">{pendingCount != null ? String(pendingCount) : '—'}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background p-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Open positions</p>
                <p className="font-mono tabular-nums">{openCount != null ? String(openCount) : '—'}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background p-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Positions to close</p>
                <p className="font-mono tabular-nums">{toCloseCount != null ? String(toCloseCount) : '—'}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background p-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Run</p>
                <p className="font-mono tabular-nums">{activeRun ? 'IN PROGRESS' : 'READY'}</p>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
              <div className="font-medium text-amber-700 text-sm">RUN SQUAREOFF NOW? (emergency, audited)</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Freezes new trading · cancels pending orders · places MARKET orders for eligible positions · retries incomplete exits.
              </p>
              {runAllNotice && (
                <div className={`mt-3 rounded-md px-3 py-2 text-xs ${runAllNotice.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-700 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-700 border border-rose-500/20'}`}>
                  {runAllNotice.text}
                </div>
              )}
              {!confirmAll ? (
                <Button size="sm" variant="destructive" onClick={() => setConfirmAll(true)} disabled={!!activeRun}>
                  <RotateCcw className="mr-1 h-3 w-3" /> {activeRun ? 'Run in progress…' : 'RUN SQUAREOFF NOW'}
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="destructive" onClick={runAllNow} disabled={runAllBusy}>
                    {runAllBusy ? 'Starting…' : 'CONFIRM SQUAREOFF'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>Cancel</Button>
                </div>
              )}
            </div>
          </div>

          {/* Live progress */}
          <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="h-3.5 w-3.5 text-amber-700" />
              <h2 className="text-sm font-semibold text-foreground">Live progress</h2>
              <span className="ml-auto font-mono text-[10px]">{activeRun ? (activeRun.runId ?? activeRun.requestId ?? 'active') : 'no active run'}</span>
            </div>
            {!activeRun ? (
              <div className="rounded-lg border border-border/60 bg-background p-4 text-center">
                <div className="text-xs text-muted-foreground">No active squareoff run</div>
                <p className="mt-1 text-[10px] text-muted-foreground">Engine is IDLE — honest idle, not a hidden run.</p>
              </div>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <div><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Run</p><p className="font-mono tabular-nums">{activeRun.runId ?? activeRun.requestId ?? '—'}</p></div>
                  <div><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Status</p><Badge variant="outline" className={`text-[10px] ${stateTone(String(activeRun.status ?? ''))}`}>{activeRun.status ?? '—'}</Badge></div>
                  <div><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Started</p><p className="font-mono tabular-nums">{fmtIST(activeRun.startedAtIST ?? activeRun.startedAt)}</p></div>
                  <div><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Source</p><p className="font-mono tabular-nums">{activeRun.source ?? '—'} · {activeRun.terminal ?? '—'}</p></div>
                  <div><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Retry</p><p className="font-mono tabular-nums">{activeRun.retryCount ?? (activeRun.results || []).length ?? 0} · every {retrySec ?? 15}s</p></div>
                  <div><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Trading day</p><p className="font-mono tabular-nums">{activeRun.tradingDate ?? '—'}</p></div>
                </div>
                {(activeRun.results || []).length > 0 ? (
                  <div className="overflow-auto rounded-lg border border-border/50">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted/60 text-muted-foreground">
                        <tr><th className="px-2 py-1.5">Symbol</th><th className="px-2 py-1.5">Side</th><th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5">Order</th><th className="px-2 py-1.5">Status</th><th className="px-2 py-1.5">Attempt</th></tr>
                      </thead>
                      <tbody>
                        {(activeRun.results || []).map((r: any, i: number) => (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-1.5 font-medium">{r.symbol ?? '—'}</td>
                            <td className="px-2 py-1.5 font-mono">{r.side ?? '—'}</td>
                            <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.requestedQty)}</td>
                            <td className="px-2 py-1.5 font-mono">{r.orderId ?? '—'}</td>
                            <td className="px-2 py-1.5"><Badge variant="outline" className={`text-[10px] ${stateTone(String(r.status ?? ''))}`}>{r.status ?? '—'}</Badge></td>
                            <td className="px-2 py-1.5 font-mono">{r.attemptId ?? r.attempt ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">Collecting broker positions…</p>
                )}
              </div>
            )}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {/* Open positions */}
            <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Layers className="h-3.5 w-3.5 text-amber-700" />
                <h2 className="text-sm font-semibold text-foreground">Open positions — broker reality</h2>
                <span className="ml-auto font-mono text-[10px]">{openList.length} open · {toCloseList.length} eligible</span>
              </div>
              {posError ? (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700">{String(posError)}</div>
              ) : openList.length === 0 ? (
                <div className="rounded-lg border border-border/60 bg-background p-4 text-center">
                  <p className="text-xs text-muted-foreground">No open positions</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">Broker reality — zero is honest.</p>
                </div>
              ) : (
                <div className="overflow-auto rounded-lg border border-border/50">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-muted/60 text-muted-foreground sticky top-0">
                      <tr><th className="px-2 py-1.5"></th><th className="px-2 py-1.5">Symbol</th><th className="px-2 py-1.5">Qty</th><th className="px-2 py-1.5 text-right">Avg</th><th className="px-2 py-1.5 text-right">LTP</th><th className="px-2 py-1.5 text-right">P&L</th><th className="px-2 py-1.5">Eligible</th></tr>
                    </thead>
                    <tbody>
                      {openList.map((p: any, i: number) => (
                        <tr key={i} className={`border-t hover:bg-muted/50 ${selected === p ? 'bg-amber-500/5' : ''}`} onClick={() => { setSelected(p); setConfirmOne(false); }}>
                          <td className="px-2 py-1.5"><input type="radio" name="pos" checked={selected === p} onChange={() => { setSelected(p); setConfirmOne(false); }} /></td>
                          <td className="px-2 py-1.5 font-medium">{posSymbol(p)}</td>
                          <td className="px-2 py-1.5 font-mono tabular-nums">{fmtNum(posQty(p))}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtNum(p?.avgPrice ?? p?.netAveragePrice)}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtNum(p?.ltp)}</td>
                          <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${(p?.pnl ?? p?.unrealizedPnl ?? 0) < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{fmtNum(p?.pnl ?? p?.unrealizedPnl)}</td>
                          <td className="px-2 py-1.5">
                            {eligibleForScope(p, scope) ? (
                              <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 text-[10px]">yes</Badge>
                            ) : (
                              <Badge variant="outline" className="border-slate-500/40 bg-slate-500/10 text-slate-700 text-[10px]">out of scope</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Square-off action */}
            <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Power className="h-3.5 w-3.5 text-amber-700" />
                <h2 className="text-sm font-semibold text-foreground">Square-off action</h2>
                <span className="ml-auto font-mono text-[10px]">POST /api/trading/positions/squareoff</span>
              </div>
              {!selected ? (
                <div className="rounded-lg border border-border/60 bg-background p-4 text-center">
                  <div className="text-xs text-muted-foreground">Select a position</div>
                  <p className="mt-1 text-[10px] text-muted-foreground">Select a position on the left to square it off with a MARKET exit order.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border/50 bg-background p-3">
                    <div className="flex justify-between text-xs"><span className="text-muted-foreground">Symbol</span><span className="font-mono font-medium">{posSymbol(selected)}</span></div>
                    <div className="flex justify-between text-xs"><span className="text-muted-foreground">Qty</span><span className="font-mono font-medium">{fmtNum(posQty(selected))}</span></div>
                    <div className="flex justify-between text-xs"><span className="text-muted-foreground">Exits with</span><span className="font-mono">{posQty(selected) > 0 ? 'SELL' : 'BUY'} MARKET · {selected.product ?? 'MIS'}</span></div>
                    {notice && (
                      <div className={`mt-2 rounded-md px-3 py-2 text-xs ${notice.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-700 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-700 border border-rose-500/20'}`}>{notice.text}</div>
                    )}
                    {!confirmOne ? (
                      <Button size="sm" variant="destructive" onClick={() => setConfirmOne(true)} className="w-full sm:w-auto">
                        <RotateCcw className="mr-1 h-3 w-3" /> Square off position
                      </Button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Button size="sm" onClick={squareOffSelected} disabled={busy}>
                          {busy ? 'Placing…' : 'Confirm MARKET exit'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmOne(false)}>Cancel</Button>
                      </div>
                    )}
                  </div>
                  <details className="rounded-lg border border-border/50 bg-muted/10 p-2">
                    <summary className="cursor-pointer text-xs font-medium">Raw engine JSON</summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded bg-[var(--chart-1)]/5 p-2 text-[10px] text-muted-foreground">{JSON.stringify(engine ?? detail, null, 2)}</pre>
                  </details>
                </div>
              )}
            </div>
          </div>

          {/* Last run summary */}
          <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <FileSearch className="h-3.5 w-3.5 text-amber-700" />
              <h2 className="text-sm font-semibold text-foreground">Last run summary</h2>
              <span className="ml-auto font-mono text-[10px]">{lastRun ? (lastRun.runId ?? lastRun.requestId ?? '') : 'no runs yet'}</span>
            </div>
            {!lastRun ? (
              <div className="rounded-lg border border-border/60 bg-background p-4 text-center">
                <p className="text-xs text-muted-foreground">No squareoff runs yet</p>
                <p className="mt-1 text-[10px] text-muted-foreground">History appears after the first run.</p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-border/60 bg-background p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Result</p>
                  <p className="font-mono tabular-nums">{String(lastRun.status ?? '—')}</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Positions</p>
                  <p className="font-mono tabular-nums">{lastRun.positionsClosed ?? '—'} closed</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Attempts</p>
                  <p className="font-mono tabular-nums">{String((lastRun.results || []).length ?? '—')}</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Window</p>
                  <p className="font-mono tabular-nums">{fmtClockIST(lastRun.startedAtIST ?? lastRun.startedAt)}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* HISTORY */}
      {tab === 'history' && (
        <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <History className="h-3.5 w-3.5 text-amber-700" />
            <h2 className="text-sm font-semibold text-foreground">Run history — last 50</h2>
            <span className="ml-auto font-mono text-[10px]">{recentRuns.length} runs</span>
          </div>
          {recentRuns.length === 0 ? (
            <div className="rounded-lg border border-border/60 bg-background p-4 text-center">
              <p className="text-xs text-muted-foreground">No history yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentRuns.map((r: any, i: number) => (
                <details key={i} className="rounded-lg border border-border/50 bg-background p-3">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline" className={`text-[10px] ${stateTone(String(r.status ?? ''))}`}>{r.status ?? '—'}</Badge>
                    <span className="font-mono font-medium">{r.runId ?? r.requestId ?? '—'}</span>
                    <span className="font-mono text-muted-foreground">{r.tradingDate ?? ''} · {fmtClockIST(r.startedAtIST ?? r.startedAt)} IST</span>
                    <span className="text-muted-foreground">{r.source ?? ''} · found {r.positionsFound ?? (r.results || []).length ?? 0}</span>
                  </summary>
                  <div className="mt-2 overflow-auto rounded border border-border/50">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-muted/60 text-muted-foreground">
                        <tr><th className="px-2 py-1">Attempt</th><th className="px-2 py-1">Symbol</th><th className="px-2 py-1">Side</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1">Order</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Error</th></tr>
                      </thead>
                      <tbody>
                        {(r.results || []).map((a: any, j: number) => (
                          <tr key={j} className="border-t">
                            <td className="px-2 py-1 font-mono">{a.attemptId ?? a.attempt ?? j + 1}</td>
                            <td className="px-2 py-1 font-medium">{a.symbol ?? '—'}</td>
                            <td className="px-2 py-1 font-mono">{a.side ?? '—'}</td>
                            <td className="px-2 py-1 text-right font-mono tabular-nums">{fmtNum(a.requestedQty)}</td>
                            <td className="px-2 py-1 font-mono">{a.orderId ?? '—'}</td>
                            <td className="px-2 py-1"><Badge variant="outline" className={`text-[10px] ${stateTone(String(a.status ?? ''))}`}>{a.status ?? '—'}</Badge></td>
                            <td className="px-2 py-1 font-mono text-muted-foreground">{a.error ? String(a.error).slice(0, 80) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {r.error && <p className="mt-1 font-mono text-[11px] text-rose-700">{String(r.error)}</p>}
                </details>
              ))}
            </div>
          )}
          {sqAudit.length > 0 && (
            <div className="mt-4 space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Permanent audit trail — SQUARE_OFF_*</div>
              {sqAudit.map((e: any, i: number) => (
                <div key={i} className="flex items-start gap-2 rounded-lg border border-border/50 bg-background px-3 py-1.5 text-[11px]">
                  <time className="whitespace-nowrap font-mono text-muted-foreground">{fmtIST(e?.ts)}</time>
                  <span className="flex-1 truncate font-mono">{e?.action ?? e?.event_id ?? JSON.stringify(e).slice(0, 120)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* PER DAY */}
      {tab === 'perday' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <CalendarDays className="h-3.5 w-3.5 text-amber-700" />
              <h2 className="text-sm font-semibold text-foreground">Per trading day</h2>
              <span className="ml-auto font-mono text-[10px]">{dayOptions.length ? dayOptions.length : 'no days yet'}</span>
            </div>
            {!daySummary ? (
              <div className="rounded-lg border border-border/60 bg-background p-4 text-center">
                <p className="text-xs text-muted-foreground">No runs for this day</p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-border/60 bg-background p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Trading day</p>
                  <p className="font-mono tabular-nums">{daySummary.tradingDate ?? day}</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Completed</p>
                  <p className="font-mono tabular-nums text-emerald-700">{daySummary.completed ?? 0}</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Positions closed</p>
                  <p className="font-mono tabular-nums">{daySummary.positionsClosed ?? 0}</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Attempts</p>
                  <p className="font-mono tabular-nums">{String(daySummary.attempts ?? (dayRuns.reduce((s: number, r: any) => s + ((r.results || []).length || 0), 0)))}</p>
                </div>
              </div>
            )}
          </div>
          {dayRuns.length > 0 && (
            <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground mb-3">Runs on {day}</h2>
              <div className="space-y-2">
                {dayRuns.map((r: any, i: number) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs">
                    <Badge variant="outline" className={`text-[10px] ${stateTone(String(r.status ?? ''))}`}>{r.status ?? '—'}</Badge>
                    <span className="font-mono font-medium">{r.runId ?? r.requestId}</span>
                    <span className="font-mono text-muted-foreground">{fmtClockIST(r.startedAtIST ?? r.startedAt)}{r.completedAtIST ? ` → ${fmtClockIST(r.completedAtIST)}` : ''} IST</span>
                    <span className="text-muted-foreground">found {r.positionsFound ?? (r.results || []).length ?? 0} · closed {r.positionsClosed ?? '—'}</span>
                    {r.error && <span className="font-mono text-rose-700">{String(r.error).slice(0, 100)}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(byDay || []).length > 1 && (
            <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground mb-3">All days</h2>
              <div className="overflow-auto rounded-lg border border-border/50">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr><th className="px-2 py-1.5">Day</th><th className="px-2 py-1.5 text-right">Runs</th><th className="px-2 py-1.5 text-right">Done</th><th className="px-2 py-1.5 text-right">Partial</th><th className="px-2 py-1.5 text-right">Failed</th><th className="px-2 py-1.5 text-right">Closed</th><th className="px-2 py-1.5 text-right">Attempts</th></tr>
                  </thead>
                  <tbody>
                    {(byDay || []).map((d: any, i: number) => (
                      <tr key={i} className={`border-t hover:bg-muted/50 ${String(d.tradingDate) === day ? 'bg-amber-500/5' : ''}`} onClick={() => setDay(String(d.tradingDate))}>
                        <td className="px-2 py-1.5 font-mono font-medium">{d.tradingDate}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{d.runs ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-emerald-700">{d.completed ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-amber-700">{d.partial ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-rose-700">{d.failed ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{d.positionsClosed ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{d.attempts ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* FLOW SAFETY */}
      <div className="rounded-xl border border-border/50 bg-muted/30 p-3 shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck className="h-3.5 w-3.5 text-amber-700" />
          <h2 className="text-sm font-semibold text-foreground">Flow safety & schedule</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border/60 bg-background p-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Freeze coordination</p>
            <p className="font-mono tabular-nums">{freezeTime} IST</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background p-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Pending-order cancel</p>
            <p className="font-mono tabular-nums">{pendingCount != null ? String(pendingCount) : '—'}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background p-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Remaining qty</p>
            <p className="font-mono tabular-nums">{activeRun ? String((activeRun.results || []).length) : '—'}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background p-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Incomplete policy</p>
            <p className="font-mono tabular-nums text-rose-700">SQUAREOFF_INCOMPLETE</p>
          </div>
        </div>
      </div>
    </div>
  );
}
