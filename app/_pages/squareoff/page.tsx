'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity, RotateCcw, RefreshCw, Timer, Power, Layers, Clock, ShieldCheck,
  History, CalendarDays, Radio, ListOrdered, FileSearch, AlertTriangle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useEngineStatus } from '@/lib/engine-realtime';
import { useBackend } from '@/lib/use-backend';
import {
  squareOffTradingPosition, getPositions, getOrderBook,
  getSquareoffDetail, getSquareoffHistory, runSquareoffNow, getTerminalAudit,
} from '@/lib/api';
import {
  PageHeader,
  SectionCard,
  MetricCard,
  StatCard,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
  LiveIndicator,
} from '@/components/design-system';

/**
 * SERVICES -> Trading -> Squareoff Engine
 *
 * Redesign per docs/engines/squareoff-engine.md:
 *   §15 Squareoff Card · §16 UI statuses · §17 Live Progress Panel ·
 *   §18 Last Run Summary · §22 run/attempt data model + per-day history.
 *
 * Live contract (project honesty rule):
 *   - Engine snapshot arrives on WebSocket #2 (`squareoff_engine` registry id)
 *     via useEngineStatus, with a one-shot REST fallback — never interval
 *     polled. LiveIndicator shows which source is driving the header.
 *   - Detail (schedule + broker counts) + history load once via the new
 *     detail/history endpoints and refresh on demand or when the realtime
 *     engine state changes — never on a timer.
 *   - Positions / pending orders are broker reality (GET /api/trading/*).
 *     Unknown renders as —, never an invented 0.
 *   - History is the engine's own recent runs (in-memory, last 50) grouped by
 *     trading_date (IST). The permanent record is the audit trail
 *     (SQUARE_OFF_* events) — shown best-effort below.
 */
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

const STATE_STATUS: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  SQUAREOFF_COMPLETE: 'success',
  COMPLETED: 'success',
  COMPLETE: 'success',
  CLOSED: 'success',
  SQUAREOFF_IN_PROGRESS: 'warning',
  IN_PROGRESS: 'warning',
  VERIFYING: 'warning',
  WAITING_RETRY: 'warning',
  PLACING_EXIT: 'warning',
  SQUAREOFF_INCOMPLETE: 'danger',
  FAILED: 'danger',
  INCOMPLETE: 'danger',
  PARTIAL: 'warning',
  IDLE: 'neutral',
  SCHEDULED: 'info',
  NO_POSITIONS: 'neutral',
};

function stateTone(s?: string): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (!s) return 'neutral';
  return STATE_STATUS[String(s).toUpperCase()] ?? STATE_STATUS[String(s)] ?? 'neutral';
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
  const { data: engine, error: engineError, source, updatedAt, connected, refresh: refreshEngine } =
    useEngineStatus<any>('squareoff_engine', ENGINE);

  // One-shot detail (schedule + broker counts + runs) — refreshed on demand
  // and whenever the realtime engine state flips (event-driven, no timer).
  const [detail, setDetail] = useState<any>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const loadDetail = async () => {
    setDetailLoading(true);
    try {
      const r = await getSquareoffDetail();
      setDetail(r?.data ?? r);
      setDetailError(null);
    } catch (e: any) {
      setDetailError(e?.message ?? 'detail fetch failed');
    } finally {
      setDetailLoading(false);
    }
  };
  useEffect(() => { void loadDetail(); }, []);

  // Broker reality — positions + pending orders (one-shot + manual refresh).
  const { data: positionsRaw, error: posError, refresh: refreshPositions, loading: posLoading } =
    useBackend(async () => (await getPositions())?.data?.data ?? (await getPositions())?.data ?? []);
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

  // History (one-shot) + audit trail (best-effort permanent record).
  const [history, setHistory] = useState<any>(null);
  const loadHistory = async () => {
    try {
      const r = await getSquareoffHistory(20);
      setHistory(r?.data ?? r);
    } catch { /* honest empty below */ }
  };
  useEffect(() => { void loadHistory(); }, []);
  const { data: auditRaw } = useBackend(async () => {
    try {
      const r = await getTerminalAudit(100);
      return Array.isArray(r?.data) ? r.data : [];
    } catch { return []; }
  });

  // Realtime follow-up: when the engine pushes a new squareoff state, pull
  // the fresh detail/positions/history once (no interval).
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

  // ---- merged live model (realtime push wins, detail fills broker counts) ----
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
  const healthStatus: 'success' | 'warning' | 'danger' | 'neutral' =
    health === 'HEALTHY' ? 'success' : health === 'UNHEALTHY' ? 'danger' : health === 'DEGRADED' ? 'warning' : 'neutral';

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

  // ---- actions ----
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

  const ago = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null;
  const live = Boolean(connected && source === 'realtime');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Squareoff Engine"
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>End-of-trading safety · MARKET-exit &amp; 15s retry · squareoff_engine</span>
            <LiveIndicator live={live} label={source === 'realtime' ? `live · updated ${ago ?? '—'}s ago` : source === 'api' ? 'REST snapshot (no live frame yet)' : 'offline'} />
            <span className="font-mono text-[10px] text-muted-foreground">Today · {tradingDate} IST</span>
          </span>
        }
      >
        <StatusBadge status={stateTone(state)} label={state} />
        {health !== 'UNKNOWN' && <StatusBadge status={healthStatus} label={health} />}
        <Badge variant="outline" className="hidden sm:inline-flex font-mono text-[10px]">
          {engine?.engineName ?? 'Squareoff'} · v{engine?.version ?? '—'}
        </Badge>
        <Button size="sm" variant="outline" onClick={refreshAll}><RefreshCw className="mr-1 h-3 w-3" /> Refresh</Button>
      </PageHeader>

      {engineError && (
        <ErrorState message={String(engineError)} onRetry={refreshAll} />
      )}
      {detailError && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          Live detail unavailable ({detailError}) — showing engine snapshot. Restart the backend to load the new detail/history endpoints.
        </div>
      )}

      {/* Top metrics — live */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Activity}
          title="Squareoff state"
          value={state}
          sub={engine?.lastHeartbeat ? fmtClockIST(engine.lastHeartbeat) : `engine ${engine?.state ?? '—'}`}
          tone={stateTone(state) === 'success' ? 'success' : stateTone(state) === 'warning' ? 'warning' : stateTone(state) === 'danger' ? 'danger' : 'neutral'}
        />
        <StatCard
          icon={Clock}
          title="Schedule"
          value={`${squareoffTime} IST`}
          sub={`freeze ${freezeTime} · retry ${retrySec ?? '—'}s · scope ${scope}`}
          tone="teal"
        />
        <StatCard
          icon={ShieldCheck}
          title="Flow safety"
          value={activeRun ? 'RUNNING' : 'IDLE'}
          sub={`pending ${pendingCount ?? '—'} · remaining ${activeRun?.results?.length ?? detail?.remainingQuantity ?? '—'} · retries ${activeRun?.retryCount ?? detail?.retryCount ?? 0}`}
          tone={activeRun ? 'warning' : 'neutral'}
        />
        <StatCard
          icon={Layers}
          title="Residual positions"
          value={openCount != null ? String(openCount) : '—'}
          sub={`to close ${toCloseCount ?? '—'} (${scope}) · auto ${autoEnabled == null ? '—' : autoEnabled ? 'ON' : 'OFF'}`}
          tone={openCount != null && openCount > 0 ? 'warning' : 'success'}
        />
      </div>

      {/* Tabs: Live / History / Per-day */}
      <div className="flex flex-wrap items-center gap-2">
        {([
          { k: 'live', label: 'Live', icon: Radio },
          { k: 'history', label: 'History', icon: History },
          { k: 'perday', label: 'Per Day', icon: CalendarDays },
        ] as { k: Tab; label: string; icon: any }[]).map(({ k, label, icon: Icon }) => (
          <Button key={k} size="sm" variant={tab === k ? 'default' : 'outline'} onClick={() => setTab(k)}>
            <Icon className="mr-1 h-3 w-3" /> {label}
            {k === 'history' && recentRuns.length > 0 && <Badge variant="secondary" className="ml-1">{recentRuns.length}</Badge>}
          </Button>
        ))}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {source === 'realtime' ? 'driven by WS#2 engine.status' : 'driven by REST snapshot'} · {connected ? 'socket up' : 'socket down'}
        </span>
      </div>

      {tab === 'live' && (
        <div className="space-y-6">
          {/* §15 Squareoff Card */}
          <SectionCard
            title="Squareoff card — doc §15"
            icon={Timer}
            headerRight={<Badge variant="outline">Automatic Squareoff [{autoEnabled == null ? '—' : autoEnabled ? 'ON' : 'OFF'}]</Badge>}
            className="shadow-soft"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard icon={Clock} title="Squareoff Time" value={`${squareoffTime}`} sub="IST · Asia/Kolkata" />
              <MetricCard icon={ShieldCheck} title="Freeze Before" value="1 min" sub={`freeze ${freezeTime} IST`} />
              <MetricCard icon={Timer} title="Retry Interval" value={`${retrySec ?? '—'} sec`} sub={`max ${maxRetries ?? '—'} tries`} />
              <MetricCard icon={Layers} title="Position Scope" value={scope} sub="Intraday only — delivery never auto-closed" />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard icon={ListOrdered} title="Pending Orders" value={pendingCount != null ? String(pendingCount) : '—'} sub="broker open / trigger-pending" />
              <MetricCard icon={Layers} title="Open Positions" value={openCount != null ? String(openCount) : '—'} sub="net qty ≠ 0 (broker)" />
              <MetricCard icon={Activity} title="Positions To Close" value={toCloseCount != null ? String(toCloseCount) : '—'} sub={`eligible under ${scope}`} />
              <MetricCard
                icon={Power}
                title="Run"
                value={activeRun ? 'IN PROGRESS' : 'READY'}
                sub={activeRun ? (activeRun.runId ?? activeRun.requestId ?? '') : 'manual run needs confirmation'}
                tone={activeRun ? 'warning' : 'neutral'}
              />
            </div>
            <div className="mt-3 rounded-lg border border-border/50 bg-muted/20 p-3 text-xs space-y-2">
              <div className="font-medium">RUN SQUAREOFF NOW? (§20 — emergency, audited)</div>
              <p className="text-muted-foreground">This will: freeze new trading · cancel pending orders · place MARKET orders for eligible open positions · retry incomplete exits per policy.</p>
              {runAllNotice && (
                <div className={`rounded-md px-3 py-2 text-xs ${runAllNotice.kind === 'ok' ? 'bg-success/10 text-success border border-success/20' : 'bg-destructive/10 text-destructive border border-destructive/20'}`}>{runAllNotice.text}</div>
              )}
              {!confirmAll ? (
                <Button size="sm" variant="destructive" onClick={() => setConfirmAll(true)} disabled={!!activeRun}>
                  <RotateCcw className="mr-1 h-3 w-3" /> {activeRun ? 'Run in progress…' : 'RUN SQUAREOFF NOW'}
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="destructive" onClick={runAllNow} disabled={runAllBusy}>{runAllBusy ? 'Starting…' : 'CONFIRM SQUAREOFF'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>Cancel</Button>
                </div>
              )}
            </div>
          </SectionCard>

          {/* §17 Live Progress Panel */}
          <SectionCard
            title="Live progress — doc §17"
            icon={Radio}
            headerRight={<Badge variant="outline">{activeRun ? (activeRun.runId ?? activeRun.requestId ?? 'active') : 'no active run'}</Badge>}
            className="shadow-soft"
          >
            {!activeRun ? (
              <EmptyState icon={Radio} title="No active squareoff run" description="The live progress panel appears here during a run (run id, status, started, last check, next retry, remaining qty, per-position table). Engine is IDLE — honest idle, not a hidden run." />
            ) : (
              <div className="space-y-3 text-xs">
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <div><div className="text-muted-foreground">Run</div><div className="font-mono font-medium">{activeRun.runId ?? activeRun.requestId ?? '—'}</div></div>
                  <div><div className="text-muted-foreground">Status</div><StatusBadge status={stateTone(activeRun.status)} label={String(activeRun.status ?? '—')} /></div>
                  <div><div className="text-muted-foreground">Started</div><div className="font-mono">{fmtIST(activeRun.startedAtIST ?? activeRun.startedAt)}</div></div>
                  <div><div className="text-muted-foreground">Source</div><div className="font-mono">{activeRun.source ?? '—'} · {activeRun.terminal ?? '—'}</div></div>
                  <div><div className="text-muted-foreground">Retry</div><div className="font-mono">{activeRun.retryCount ?? (activeRun.results || []).length ?? 0} · every {retrySec ?? 15}s</div></div>
                  <div><div className="text-muted-foreground">Trading day</div><div className="font-mono">{activeRun.tradingDate ?? '—'}</div></div>
                </div>
                {(activeRun.results || []).length > 0 ? (
                  <div className="overflow-auto rounded-lg border">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted/60 text-muted-foreground">
                        <tr><th className="px-2 py-1.5">Symbol</th><th className="px-2 py-1.5">Side</th><th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5">Order</th><th className="px-2 py-1.5">Status</th><th className="px-2 py-1.5">Attempt</th></tr>
                      </thead>
                      <tbody>
                        {(activeRun.results || []).map((r: any, i: number) => (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-1.5 font-medium">{r.symbol ?? '—'}</td>
                            <td className="px-2 py-1.5 font-mono">{r.side ?? '—'}</td>
                            <td className="px-2 py-1.5 text-right font-mono">{fmtNum(r.requestedQty)}</td>
                            <td className="px-2 py-1.5 font-mono">{r.orderId ?? '—'}</td>
                            <td className="px-2 py-1.5"><StatusBadge status={stateTone(r.status)} label={String(r.status ?? '—')} /></td>
                            <td className="px-2 py-1.5 font-mono">{r.attemptId ?? r.attempt ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted-foreground">Collecting broker positions…</p>
                )}
              </div>
            )}
          </SectionCard>

          <div className="grid gap-3 lg:grid-cols-2">
            <SectionCard title="Open positions — real (broker)" icon={Layers} headerRight={<Badge variant="outline">{posError ? 'error' : `${openList.length} open · ${toCloseList.length} eligible`}</Badge>} className="shadow-soft">
              {detailLoading && posLoading && openList.length === 0 ? (
                <LoadingState text="Loading positions…" />
              ) : posError ? (
                <ErrorState message={String(posError)} onRetry={refreshPositions} />
              ) : openList.length === 0 ? (
                <EmptyState icon={Layers} title="No open positions" description="No open positions — nothing to close (§12). Positions are broker reality via /api/trading/positions; a zero here is honest, not a hidden book." />
              ) : (
                <div className="overflow-auto rounded-lg border">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                      <tr><th className="px-2 py-1.5"></th><th className="px-2 py-1.5">Symbol</th><th className="px-2 py-1.5">Qty</th><th className="px-2 py-1.5 text-right">Avg</th><th className="px-2 py-1.5 text-right">LTP</th><th className="px-2 py-1.5 text-right">P&amp;L</th><th className="px-2 py-1.5">Eligible</th></tr>
                    </thead>
                    <tbody>
                      {openList.map((p: any, i: number) => (
                        <tr key={i} className={`border-t hover:bg-muted/20 ${selected === p ? 'bg-primary/10' : ''}`} onClick={() => { setSelected(p); setConfirmOne(false); }}>
                          <td className="px-2 py-1.5"><input type="radio" name="pos" checked={selected === p} onChange={() => { setSelected(p); setConfirmOne(false); }} /></td>
                          <td className="px-2 py-1.5 font-medium">{posSymbol(p)}</td>
                          <td className="px-2 py-1.5 font-mono">{fmtNum(posQty(p))}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{fmtNum(p?.avgPrice ?? p?.netAveragePrice)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{fmtNum(p?.ltp)}</td>
                          <td className={`px-2 py-1.5 text-right font-mono ${(p?.pnl ?? p?.unrealizedPnl ?? 0) < 0 ? 'text-destructive' : 'text-success'}`}>{fmtNum(p?.pnl ?? p?.unrealizedPnl)}</td>
                          <td className="px-2 py-1.5">{eligibleForScope(p, scope) ? <StatusBadge status="success" label="yes" /> : <StatusBadge status="neutral" label="out of scope" />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            <SectionCard title="Square-off action" icon={Power} headerRight={<Badge variant="outline" className="border-primary/40 text-primary">POST /api/trading/positions/squareoff</Badge>} className="shadow-soft">
              {!selected ? (
                <EmptyState icon={Power} title="Select a position" description="Select a position on the left to square it off with a MARKET exit order. Same broker path as end-of-day squareoff (verified remaining qty, no blind duplicate — §10/§11)." />
              ) : (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs space-y-1.5">
                    <div className="flex justify-between"><span className="text-muted-foreground">Symbol</span><span className="font-mono font-medium">{posSymbol(selected)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Qty</span><span className="font-mono font-medium">{fmtNum(posQty(selected))}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Exits with</span><span className="font-mono">{posQty(selected) > 0 ? 'SELL' : 'BUY'} MARKET · {selected.product ?? 'MIS'}</span></div>
                    {notice && <div className={`rounded-md px-3 py-2 text-xs ${notice.kind === 'ok' ? 'bg-success/10 text-success border border-success/20' : 'bg-destructive/10 text-destructive border border-destructive/20'}`}>{notice.text}</div>}
                    {!confirmOne ? (
                      <Button size="sm" variant="destructive" onClick={() => setConfirmOne(true)} className="w-full sm:w-auto"><RotateCcw className="mr-1 h-3 w-3" /> Square off position</Button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Button size="sm" onClick={squareOffSelected} disabled={busy}>{busy ? 'Placing…' : 'Confirm MARKET exit'}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmOne(false)}>Cancel</Button>
                      </div>
                    )}
                  </div>
                  <details className="rounded-lg border border-border/50 bg-muted/10 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium">Raw engine JSON</summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/40 p-2 text-[10px] text-muted-foreground">{JSON.stringify(engine ?? detail, null, 2)}</pre>
                  </details>
                </div>
              )}
            </SectionCard>
          </div>

          {/* §18 Last Run Summary */}
          <SectionCard
            title="Last run summary — doc §18"
            icon={FileSearch}
            headerRight={lastRun ? <Badge variant="outline">{lastRun.runId ?? lastRun.requestId ?? ''}</Badge> : <Badge variant="outline">no runs yet</Badge>}
            className="shadow-soft"
          >
            {!lastRun ? (
              <EmptyState icon={FileSearch} title="No squareoff runs yet" description="History appears here after the first run (scheduler 15:16 IST or RUN SQUAREOFF NOW). The engine keeps the last 50 runs; the audit trail below is the permanent record." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard icon={Activity} title="Result" value={String(lastRun.status ?? '—')} sub={`${lastRun.source ?? '—'} · ${lastRun.tradingDate ?? ''}`} tone={stateTone(lastRun.status) === 'success' ? 'success' : stateTone(lastRun.status) === 'danger' ? 'danger' : 'warning'} />
                <MetricCard icon={Layers} title="Positions" value={`${lastRun.positionsClosed ?? (lastRun.results || []).filter((r: any) => ['COMPLETE', 'SUBMITTED'].includes(String(r.status))).length ?? '—'} closed`} sub={`found ${lastRun.positionsFound ?? (lastRun.results || []).length ?? '—'} · remaining ${lastRun.positionsRemaining ?? '—'}`} />
                <MetricCard icon={Timer} title="Attempts / retries" value={String((lastRun.results || []).length ?? '—')} sub={`retries ${lastRun.retryCount ?? 0} · every ${retrySec ?? 15}s`} />
                <MetricCard icon={Clock} title="Window" value={fmtClockIST(lastRun.startedAtIST ?? lastRun.startedAt)} sub={lastRun.completedAtIST ? `→ ${fmtClockIST(lastRun.completedAtIST)} IST` : '—'} />
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {tab === 'history' && (
        <SectionCard
          title="Run history — doc §22 (last 50, never rewritten)"
          icon={History}
          headerRight={<Badge variant="outline">{recentRuns.length} runs</Badge>}
          className="shadow-soft"
        >
          {recentRuns.length === 0 ? (
            <EmptyState icon={History} title="No history yet" description="Runs are recorded here with run id, trading date, per-position attempts and errors. History is append-only — a completed day is never overwritten to look clean." />
          ) : (
            <div className="space-y-2">
              {recentRuns.map((r: any, i: number) => (
                <details key={i} className="rounded-lg border border-border/50 bg-muted/10 px-3 py-2">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
                    <StatusBadge status={stateTone(r.status)} label={String(r.status ?? '—')} />
                    <span className="font-mono font-medium">{r.runId ?? r.requestId ?? '—'}</span>
                    <span className="font-mono text-muted-foreground">{r.tradingDate ?? ''} · {fmtClockIST(r.startedAtIST ?? r.startedAt)} IST</span>
                    <span className="text-muted-foreground">{r.source ?? ''} · found {r.positionsFound ?? (r.results || []).length ?? 0} · closed {r.positionsClosed ?? '—'}</span>
                  </summary>
                  <div className="mt-2 overflow-auto rounded border">
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
                            <td className="px-2 py-1 text-right font-mono">{fmtNum(a.requestedQty)}</td>
                            <td className="px-2 py-1 font-mono">{a.orderId ?? '—'}</td>
                            <td className="px-2 py-1"><StatusBadge status={stateTone(a.status)} label={String(a.status ?? '—')} /></td>
                            <td className="px-2 py-1 font-mono text-muted-foreground">{a.error ? String(a.error).slice(0, 80) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {r.error && <p className="mt-1 font-mono text-[11px] text-destructive">{String(r.error)}</p>}
                </details>
              ))}
            </div>
          )}
          {sqAudit.length > 0 && (
            <div className="mt-4 space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Permanent audit trail — SQUARE_OFF_* (GET /api/terminal/audit)</div>
              {sqAudit.map((e: any, i: number) => (
                <div key={i} className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-1.5 text-[11px]">
                  <time className="whitespace-nowrap font-mono text-muted-foreground">{fmtIST(e?.ts)}</time>
                  <span className="flex-1 truncate font-mono">{e?.action ?? e?.event_id ?? JSON.stringify(e).slice(0, 120)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {tab === 'perday' && (
        <div className="space-y-3">
          <SectionCard title="Per trading day — doc §22" icon={CalendarDays} headerRight={
            dayOptions.length ? (
              <select value={day} onChange={(e) => setDay(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-xs">
                {dayOptions.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : <Badge variant="outline">no days yet</Badge>
          } className="shadow-soft">
            {!daySummary ? (
              <EmptyState icon={CalendarDays} title="No runs for this day" description="Pick another trading date. Each day keeps its own runs, attempts and remaining quantities — one active run per day (§28 single-run lock)." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard icon={CalendarDays} title="Trading day" value={daySummary.tradingDate ?? day} sub={`${daySummary.runs ?? 0} runs`} />
                <MetricCard icon={Activity} title="Completed" value={String(daySummary.completed ?? 0)} sub={`partial ${daySummary.partial ?? 0} · failed ${daySummary.failed ?? 0}`} tone={(daySummary.failed ?? 0) > 0 ? 'danger' : 'success'} />
                <MetricCard icon={Layers} title="Positions closed" value={String(daySummary.positionsClosed ?? 0)} sub={`remaining ${daySummary.positionsRemaining ?? 0}`} />
                <MetricCard icon={Timer} title="Attempts" value={String(daySummary.attempts ?? (dayRuns.reduce((s: number, r: any) => s + ((r.results || []).length || 0), 0)))} sub={`retry every ${retrySec ?? 15}s`} />
              </div>
            )}
          </SectionCard>
          {dayRuns.length > 0 && (
            <SectionCard title={`Runs on ${day}`} icon={ListOrdered} headerRight={<Badge variant="outline">{dayRuns.length}</Badge>} className="shadow-soft">
              <div className="space-y-2">
                {dayRuns.map((r: any, i: number) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs">
                    <StatusBadge status={stateTone(r.status)} label={String(r.status ?? '—')} />
                    <span className="font-mono font-medium">{r.runId ?? r.requestId}</span>
                    <span className="font-mono text-muted-foreground">{fmtClockIST(r.startedAtIST ?? r.startedAt)}{r.completedAtIST ? ` → ${fmtClockIST(r.completedAtIST)}` : ''} IST</span>
                    <span className="text-muted-foreground">found {r.positionsFound ?? (r.results || []).length ?? 0} · closed {r.positionsClosed ?? '—'} · remaining {r.positionsRemaining ?? '—'}</span>
                    {r.error && <span className="font-mono text-destructive">{String(r.error).slice(0, 100)}</span>}
                  </div>
                ))}
              </div>
            </SectionCard>
          )}
          {(byDay || []).length > 1 && (
            <SectionCard title="All days" icon={CalendarDays} className="shadow-soft">
              <div className="overflow-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr><th className="px-2 py-1.5">Day</th><th className="px-2 py-1.5 text-right">Runs</th><th className="px-2 py-1.5 text-right">Done</th><th className="px-2 py-1.5 text-right">Partial</th><th className="px-2 py-1.5 text-right">Failed</th><th className="px-2 py-1.5 text-right">Closed</th><th className="px-2 py-1.5 text-right">Attempts</th></tr>
                  </thead>
                  <tbody>
                    {(byDay || []).map((d: any, i: number) => (
                      <tr key={i} className={`border-t hover:bg-muted/20 ${String(d.tradingDate) === day ? 'bg-primary/10' : ''}`} onClick={() => setDay(String(d.tradingDate))}>
                        <td className="px-2 py-1.5 font-mono font-medium">{d.tradingDate}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{d.runs ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-success">{d.completed ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-warning">{d.partial ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-destructive">{d.failed ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{d.positionsClosed ?? 0}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{d.attempts ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </div>
      )}

      <SectionCard title="Flow safety & schedule" icon={ShieldCheck} className="shadow-soft">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard icon={ShieldCheck} title="Freeze coordination" value={`${freezeTime} IST`} sub={autoEnabled ? 'auto squareoff armed' : 'manual only'} tone={autoEnabled ? 'warning' : 'neutral'} />
          <MetricCard icon={Timer} title="Pending-order cancel" value={pendingCount != null ? String(pendingCount) : '—'} sub="verified before each exit (§7)" />
          <MetricCard icon={Layers} title="Remaining qty" value={activeRun ? String((activeRun.results || []).length) : '—'} sub={`retry ${retrySec ?? 15}s · max ${maxRetries ?? 3}`} />
          <MetricCard icon={AlertTriangle} title="Incomplete policy" value="SQUAREOFF_INCOMPLETE" sub="deadline → notify, never silent success" tone="danger" />
        </div>
      </SectionCard>
    </div>
  );
}
