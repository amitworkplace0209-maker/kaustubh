'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Briefcase,
  History,
  RefreshCw,
  Target,
  Trash2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Sigma,
  Layers,
  TrendingUp,
  TrendingDown,
  Power,
  LayoutGrid,
  Table2,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  MetricCard,
  pnlTone,
  SectionCard,
  EmptyState,
  ErrorState,
  LiveIndicator,
} from '@/components/design-system';
import { useDummyState } from '@/hooks/use-dummy-state';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { squareOffDemoPosition } from '@/lib/api';
import { createDummyTarget, deleteDummyTarget, getDummyPositions, type ClosedPosition, type DummyPosition } from '@/lib/dummy';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { cn } from '@/lib/utils';
import { formatISTDateTime, formatISTTime } from '@/lib/ist';
import { fmtPnl, fmtRs, fmtQty, pnlClr } from '@/lib/formatters';

/* ------------------------------------------------------------------ */
/* Live display values — SSE tick (1s) wins, 2.5s poll is the fallback */
/* ------------------------------------------------------------------ */

type Disp = {
  ltp: number | null;
  live: boolean;
  avg: number;
  cur: number | null;
  unreal: number;
  gross: number;
  net: number;
  pnlPct: number | null;
};

function dispFor(p: DummyPosition, tickLtp: number | null): Disp {
  const tickLive = tickLtp != null && tickLtp > 0;
  const ltp = tickLive ? tickLtp : p.ltp > 0 ? p.ltp : null;
  const qty = Math.abs(p.netQuantity || 0);
  const avg = (p.netQuantity > 0 ? p.averageBuyPrice : p.averageSellPrice) || 0;
  const cur = ltp != null ? ltp * qty : null;
  const unreal = ltp != null && avg > 0 && qty > 0
    ? (p.netQuantity > 0 ? (ltp - avg) : (avg - ltp)) * qty
    : Number(p.unrealizedPnl || 0);
  const gross = Number(p.realizedPnl || 0) + unreal;
  const charges = Number(p.estimatedCharges || 0);
  const net = gross - charges;
  const invested = avg * qty;
  return { ltp, live: tickLive, avg, cur, unreal, gross, net, pnlPct: invested > 0 ? (gross / invested) * 100 : null };
}

/** Green/red flash on the LTP cell when the live price moves. */
function useLtpFlash(ltp: number | null): 'up' | 'down' | null {
  const prev = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = ltp;
    if (ltp == null || p == null || ltp === p) return;
    setDir(ltp > p ? 'up' : 'down');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDir(null), 700);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [ltp]);
  return dir;
}

function ago(now: number, ts: number | null): string {
  if (ts == null) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

/* ------------------------------------------------------------------ */
/* Open position card (mobile-first)                                    */
/* ------------------------------------------------------------------ */

function OpenCard({
  p, d, idx, targets, squaring, confirming, expanded, onToggle, onAskSquareOff, onSubmitTarget, onRemoveTarget, form, setForm,
}: {
  p: DummyPosition; d: Disp; idx: number;
  targets: { id: string; direction: string; targetType: string; value: number; status: string }[];
  squaring: boolean; confirming: boolean; expanded: boolean;
  onToggle: () => void; onAskSquareOff: () => void;
  onSubmitTarget: () => void; onRemoveTarget: (id: string) => void;
  form: { type: string; value: string; direction: string };
  setForm: (patch: Partial<{ type: string; value: string; direction: string }>) => void;
}) {
  const flash = useLtpFlash(d.ltp);
  const long = p.netQuantity > 0;
  return (
    <div
      data-verify={`position-card-${String(idx + 1).padStart(2, '0')}`}
      className={cn(
        'overflow-hidden rounded-2xl border bg-card shadow-lg transition-all duration-200 hover:shadow-xl',
        d.net > 0 ? 'border-success/40' : d.net < 0 ? 'border-destructive/40' : 'border-border/60',
      )}
    >
      <div className={cn('flex items-center justify-between gap-2 border-b border-border/50 px-4 py-3', long ? 'bg-gradient-to-r from-success/[0.08] to-transparent' : 'bg-gradient-to-r from-destructive/[0.08] to-transparent')}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn('flex h-8 w-8 items-center justify-center rounded-xl text-xs font-bold', long ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive')}>
            {p.symbol.charAt(0)}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold">{p.symbol}</span>
              {d.live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-success" title="Live tick" />}
            </div>
            <span className="text-[10px] font-medium text-muted-foreground">{p.product} · {long ? 'LONG' : 'SHORT'}</span>
          </div>
        </div>
        <button type="button" onClick={onToggle} className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Expand">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-xs tabular-nums">
        <div className="flex justify-between"><span className="text-muted-foreground">Qty</span><span className="font-bold">{fmtQty(p.netQuantity)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Buy Price</span><span className="font-semibold">{d.avg > 0 ? fmtRs(d.avg) : '—'}</span></div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">LTP {d.live ? <span className="text-[9px] font-bold uppercase text-success">live</span> : null}</span>
          <span className={cn('font-mono font-bold rounded-lg px-1.5 py-0.5', flash === 'up' && 'bg-success/20 text-success', flash === 'down' && 'bg-destructive/20 text-destructive')}>
            {d.ltp != null ? fmtRs(d.ltp) : '—'}
          </span>
        </div>
        <div className="flex justify-between"><span className="text-muted-foreground">Value</span><span className="font-semibold">{d.cur != null ? fmtRs(d.cur) : '—'}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">P&amp;L</span><span className={cn('font-bold', pnlClr(d.unreal))}>{fmtPnl(d.unreal)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">P&amp;L %</span><span className={cn('font-bold', pnlClr(d.unreal))}>{d.pnlPct != null ? `${d.pnlPct >= 0 ? '+' : ''}${d.pnlPct.toFixed(2)}%` : '—'}</span></div>
      </div>
      <div className={cn('mx-4 mb-3 flex items-center justify-between rounded-xl px-3 py-2', d.net >= 0 ? 'bg-success/[0.08]' : 'bg-destructive/[0.08]')}>
        <span className="text-xs font-semibold">Net P&amp;L</span>
        <span className={cn('text-sm font-bold', pnlClr(d.net))}>{fmtPnl(d.net)}</span>
      </div>
      <div className="flex gap-2 border-t border-border/50 px-4 py-3">
        <Button size="sm" className="flex-1 rounded-xl" variant={long ? 'default' : 'destructive'} disabled={squaring || confirming} onClick={onAskSquareOff}>
          <Power className="mr-1.5 h-3.5 w-3.5" /> {long ? 'EXIT' : 'SQUARE OFF'}
        </Button>
        <Button size="sm" variant="outline" className="rounded-xl" onClick={onToggle}>Targets{targets.length > 0 ? ` (${targets.length})` : ''}</Button>
      </div>
      {expanded && (
        <TargetEditor symbol={p.symbol} targets={targets} form={form} setForm={setForm} onSubmit={onSubmitTarget} onRemove={onRemoveTarget} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Open position table row                                              */
/* ------------------------------------------------------------------ */

function OpenRow({
  p, d, expanded, squaring, confirming, onToggle, onAskSquareOff,
}: {
  p: DummyPosition; d: Disp; expanded: boolean; squaring: boolean; confirming: boolean;
  onToggle: () => void; onAskSquareOff: () => void;
}) {
  const flash = useLtpFlash(d.ltp);
  const long = p.netQuantity > 0;
  return (
    <Fragment>
      <TableRow className="hover:bg-muted/40">
        <TableCell>
          <Button variant="ghost" size="icon" onClick={onToggle} aria-label="Expand">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </TableCell>
        <TableCell className="whitespace-nowrap font-medium">
          <div className="flex items-center gap-2">
            <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold', long ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive')}>
              {p.symbol.charAt(0)}
            </span>
            <div className="flex flex-col">
              <span className="flex items-center gap-1.5 font-semibold">{p.symbol}{d.live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" title="Live tick" />}</span>
              <span className="text-[10px] text-muted-foreground">{p.product}</span>
            </div>
          </div>
        </TableCell>
        <TableCell><Badge variant={long ? 'default' : 'destructive'} className="rounded-lg px-2 py-0.5 text-[10px] font-semibold">{long ? 'LONG' : 'SHORT'}</Badge></TableCell>
        <TableCell className="text-right font-semibold tabular-nums">{fmtQty(p.netQuantity)}</TableCell>
        <TableCell className="text-right tabular-nums">{d.avg > 0 ? fmtRs(d.avg) : '—'}</TableCell>
        <TableCell className={cn('text-right font-mono font-bold tabular-nums rounded-lg px-1.5 py-0.5', flash === 'up' && 'bg-success/15 text-success', flash === 'down' && 'bg-destructive/15 text-destructive')}>
          {d.ltp != null ? fmtRs(d.ltp) : '—'}
        </TableCell>
        <TableCell className="text-right tabular-nums">{d.cur != null ? fmtRs(d.cur) : '—'}</TableCell>
        <TableCell className={cn('text-right font-bold tabular-nums', pnlClr(d.unreal))}>{fmtPnl(d.unreal)}</TableCell>
        <TableCell className={cn('text-right text-xs font-semibold tabular-nums', pnlClr(d.unreal))}>{d.pnlPct != null ? `${d.pnlPct >= 0 ? '+' : ''}${d.pnlPct.toFixed(2)}%` : '—'}</TableCell>
        <TableCell className="text-right tabular-nums text-destructive">{p.estimatedCharges ? fmtRs(p.estimatedCharges) : '—'}</TableCell>
        <TableCell className={cn('text-right font-bold tabular-nums', pnlClr(d.net))}>{fmtPnl(d.net)}</TableCell>
        <TableCell className="text-right">
          <Button size="sm" variant={long ? 'default' : 'destructive'} className="rounded-lg" disabled={squaring || confirming} onClick={onAskSquareOff}>Square off</Button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={12} className="bg-muted/20">
            <div className="grid grid-cols-2 gap-2 p-2 text-xs tabular-nums md:grid-cols-4">
              <span className="text-muted-foreground">Buy qty <span className="font-semibold text-foreground">{p.buyQuantity}</span></span>
              <span className="text-muted-foreground">Sell qty <span className="font-semibold text-foreground">{p.sellQuantity}</span></span>
              <span className="text-muted-foreground">Gross P&amp;L <span className={cn('font-semibold', pnlClr(d.gross))}>{fmtPnl(d.gross)}</span></span>
              <span className="text-muted-foreground">Market value <span className="font-semibold text-foreground">{p.marketValue ? fmtRs(p.marketValue) : '—'}</span></span>
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

/* ------------------------------------------------------------------ */
/* Target editor (shared by card + table expansion)                     */
/* ------------------------------------------------------------------ */

function TargetEditor({
  symbol, targets, form, setForm, onSubmit, onRemove,
}: {
  symbol: string;
  targets: { id: string; direction: string; targetType: string; value: number; status: string }[];
  form: { type: string; value: string; direction: string };
  setForm: (patch: Partial<{ type: string; value: string; direction: string }>) => void;
  onSubmit: () => void; onRemove: (id: string) => void;
}) {
  return (
    <div className="border-t border-border/50 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold"><Target className="h-3.5 w-3.5" /> Targets</div>
      <div className="space-y-1.5">
        {targets.map((t) => (
          <div key={t.id} className="flex items-center justify-between rounded bg-muted/60 px-2 py-1 text-xs tabular-nums">
            <span>{t.direction} {t.targetType} {t.value} · {t.status}</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onRemove(t.id)} aria-label="Remove target">
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div className="space-y-1">
            <Label className="text-[11px]">Type</Label>
            <Select value={form.type} onValueChange={(v) => setForm({ type: v })}>
              <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PERCENT">Percent</SelectItem>
                <SelectItem value="FIXED">Fixed price</SelectItem>
                <SelectItem value="AMOUNT">Amount (₹)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Dir</Label>
            <Select value={form.direction} onValueChange={(v) => setForm({ direction: v })}>
              <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PROFIT">Profit</SelectItem>
                <SelectItem value="LOSS">Stop loss</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Value</Label>
            <Input type="number" min={0} step="0.05" className="h-8 w-24" value={form.value} onChange={(e) => setForm({ value: e.target.value })} />
          </div>
          <Button size="sm" variant="outline" onClick={onSubmit}>Set</Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function DummyPositions() {
  const { state, error, loading, refresh } = useDummyState(2500);
  const { latest, connected, lastMessageAt } = useLatestTicks(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [squaring, setSquaring] = useState<string | null>(null);
  const [confirmSq, setConfirmSq] = useState<DummyPosition | null>(null);
  const [targetForm, setTargetForm] = useState<Record<string, { type: string; value: string; direction: string }>>({});
  const [closed, setClosed] = useState<ClosedPosition[]>([]);
  const [closedLoading, setClosedLoading] = useState(true);
  const [view, setView] = useState<'CARDS' | 'TABLE'>('TABLE');
  const [now, setNow] = useState(() => Date.now());
  const [lastPollAt, setLastPollAt] = useState<number | null>(null);
  // Day partition (IST calendar date): the page shows exactly one trading date.
  // The backend resets clean at 12:00 AM IST and scopes closed to the date.
  const [tradingDate, setTradingDate] = useState<string | null>(null);
  const istDay = (ms: number) =>
    new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  // Open upar, Closed neeche — dono alag cards. Toggle se ek time pe
  // sirf ek section bhi dekha ja sakta hai (dono ek saath nahi).
  const [showOpen, setShowOpen] = useState(true);
  const [showClosed, setShowClosed] = useState(true);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (state) setLastPollAt(Date.now());
  }, [state]);

  const loadClosed = async () => {
    try {
      const res = await getDummyPositions();
      setClosed(Array.isArray(res?.closed) ? res.closed : []);
      if (res?.tradingDate) setTradingDate(res.tradingDate);
    } catch { /* keep previous */ } finally {
      setClosedLoading(false);
    }
  };

  // Day flip: when IST rolls to a new date, drop yesterday's rows immediately
  // and refetch — one day's positions never carry into the next.
  const dayRef = useRef<string>(istDay(Date.now()));
  useEffect(() => {
    const day = istDay(now);
    if (day !== dayRef.current) {
      dayRef.current = day;
      setClosed([]);
      setTradingDate(day);
      void refresh();
      void loadClosed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  useEffect(() => {
    void loadClosed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.positions.length]);

  // Open section = strictly non-zero net quantity. Fully-closed (net 0) rows
  // belong to the closed trail only — one order in exactly one place, so a
  // squared-off position can never inflate open counts or P&L twice.
  const positions = useMemo(
    () => (state?.positions || []).filter((p) => Number(p.netQuantity || 0) !== 0),
    [state?.positions],
  );

  // Push live ticks into the dummy engine so server MTM stays fresh too.
  const symbols = useMemo(() => new Set(positions.map((p) => p.symbol)), [positions]);
  useEffect(() => {
    for (const sym of symbols) {
      const t = latest.get(sym);
      if (t && typeof t.ltp === 'number' && t.ltp > 0) feedDummyLtp(sym, t.ltp);
    }
  }, [latest, symbols]);

  // Live LTP lookup across every identifier a position carries — bare symbol,
  // trading symbol (-EQ) and instrument token. The shared stream is now indexed
  // by all three (useLatestTicks), so a renamed/suffixed symbol can no longer
  // silently miss its live price.
  const tickLtp = (p: { symbol: string; tradingSymbol?: string; token?: string }): number | null => {
    const candidates = [p.symbol, p.tradingSymbol, p.token].filter(Boolean) as string[];
    for (const c of candidates) {
      const t = latest.get(c) ?? latest.get(c.toUpperCase());
      if (t && typeof t.ltp === 'number' && t.ltp > 0) return t.ltp;
    }
    return null;
  };

  // Live display values: SSE tick first, poll snapshot second.
  const disp = useMemo(() => {
    const m = new Map<string, Disp>();
    for (const p of positions) m.set(p.symbol + p.product, dispFor(p, tickLtp(p)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, latest]);
  const getDisp = (p: DummyPosition): Disp => disp.get(p.symbol + p.product) ?? dispFor(p, null);

  // ---- live summary (open leg ticks every second, closed leg is today's) ----
  const openUnreal = positions.reduce((s, p) => s + getDisp(p).unreal, 0);
  const openGrossLive = positions.reduce((s, p) => s + getDisp(p).gross, 0);
  const chargesOpen = positions.reduce((s, p) => s + Number(p.estimatedCharges || 0), 0);
  const closedGross = closed.reduce((s, c) => s + Number(c.realizedPnl || 0), 0);
  const chargesClosed = closed.reduce((s, c) => s + Number(c.charges || 0), 0);
  const closedRealized = closed.reduce((s, c) => s + Number(c.netPnl ?? c.realizedPnl ?? 0), 0);
  const chargesTotal = chargesOpen + chargesClosed;
  const grossTotal = openGrossLive + closedGross;
  const netTotal = grossTotal - chargesTotal;
  const openCount = positions.length;
  const totalCount = openCount + closed.length;

  const summary = useMemo(() => {
    const unrealized = positions.reduce((s, p) => s + Number(p.unrealizedPnl || 0), 0);
    const realized = positions.reduce((s, p) => s + Number(p.realizedPnl || 0), 0);
    const notional = positions.reduce((s, p) => s + Number(p.ltp || 0) * Math.abs(p.netQuantity || 0), 0);
    const totalCharges = positions.reduce((s, p) => s + Number(p.estimatedCharges || 0), 0);
    const gross = realized + unrealized;
    return { unrealized, realized, notional, totalCharges, gross, net: gross - totalCharges };
  }, [positions]);

  const streamLive = connected && lastMessageAt != null && now - lastMessageAt < 20000;
  const lastActivity = Math.max(lastPollAt ?? 0, lastMessageAt ?? 0) || null;
  const refreshing = loading && !state;

  const doSquareOff = async () => {
    if (!confirmSq) return;
    setSquaring(confirmSq.symbol);
    try {
      await squareOffDemoPosition(confirmSq.symbol, confirmSq.product);
      setConfirmSq(null);
      await refresh();
      await loadClosed();
    } finally {
      setSquaring(null);
    }
  };

  const submitTarget = async (symbol: string) => {
    const form = targetForm[symbol] || { type: 'PERCENT', value: '', direction: 'PROFIT' };
    if (!Number(form.value) || Number(form.value) <= 0) return;
    await createDummyTarget({ symbol, targetType: form.type, value: Number(form.value), direction: form.direction, autoExecute: true });
    setTargetForm((prev) => ({ ...prev, [symbol]: { type: 'PERCENT', value: '', direction: 'PROFIT' } }));
    void refresh();
  };

  const setForm = (symbol: string, patch: Partial<{ type: string; value: string; direction: string }>) => {
    setTargetForm((prev) => {
      const cur = prev[symbol] || { type: 'PERCENT', value: '', direction: 'PROFIT' };
      return { ...prev, [symbol]: { ...cur, ...patch } };
    });
  };

  const removeTarget = async (id: string) => {
    try {
      await deleteDummyTarget(id);
      void refresh();
    } catch { /* keep */ }
  };

  if (error && !state) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void refresh()} /></DummyThemedPage>;
  }

  const lastUpdated = state?.nowUtc ? formatISTTime(state.nowUtc) : '—';
  const targetsFor = (sym: string) => (state?.targets || []).filter((t) => t.symbol === sym);
  const formFor = (sym: string) => targetForm[sym] || { type: 'PERCENT', value: '', direction: 'PROFIT' };
  const confirmDisp = confirmSq ? getDisp(confirmSq) : null;

  return (
    <DummyThemedPage>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight">Positions</h1>
          <DummyBadge />
          <LiveIndicator live={streamLive} label={streamLive ? `Live · ${ago(now, lastMessageAt)}` : 'Stream idle'} />
          <span
            title="Day-scoped page — the book resets clean at 12:00 AM IST and prior dates never appear here"
            className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-sky-500"
          >
            Today · {tradingDate ?? istDay(now)} IST · resets 12:00 AM
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">Updated {ago(now, lastActivity)} IST</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      {/* Summary — 6 live cards: total · open · closed · charges · total P&L · net P&L */}
      {refreshing ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-[110px] rounded-2xl" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            <MetricCard
              icon={Layers}
              title="Total Positions"
              value={String(totalCount)}
              tone="neutral"
              sub={`${openCount} open · ${closed.length} closed today`}
            />
            <MetricCard
              icon={Briefcase}
              title="Open Positions"
              value={String(openCount)}
              tone={openCount > 0 ? 'teal' : 'neutral'}
              sub={openCount > 0
                ? <>{`${positions.filter((p) => p.netQuantity > 0).length}L / ${positions.filter((p) => p.netQuantity < 0).length}S · `}<span className={cn('font-semibold', pnlClr(openUnreal))}>{fmtPnl(openUnreal)}{streamLive ? ' live' : ''}</span></>
                : 'Nothing open'}
            />
            <MetricCard
              icon={History}
              title="Closed Positions"
              value={String(closed.length)}
              tone="neutral"
              sub={closed.length > 0
                ? <>Realized <span className={cn('font-semibold', pnlClr(closedGross))}>{fmtPnl(closedGross)}</span></>
                : 'Nothing settled yet'}
            />
            <MetricCard
              icon={Sigma}
              title="Charges"
              value={fmtRs(chargesTotal)}
              tone={chargesTotal > 0 ? 'warning' : 'neutral'}
              valueClass={chargesTotal > 0 ? 'text-destructive' : undefined}
              sub={`Open ${fmtRs(chargesOpen)} · Closed ${fmtRs(chargesClosed)}`}
            />
            <MetricCard
              icon={grossTotal >= 0 ? TrendingUp : TrendingDown}
              title="Total P&L"
              value={fmtPnl(grossTotal)}
              tone={pnlTone(grossTotal)}
              valueClass={pnlClr(grossTotal)}
              sub={`Open ${fmtPnl(openGrossLive)}${streamLive ? ' live' : ''} · Closed ${fmtPnl(closedGross)}`}
            />
            <MetricCard
              icon={Zap}
              title="Net P&L"
              value={fmtPnl(netTotal)}
              tone={pnlTone(netTotal)}
              valueClass={pnlClr(netTotal)}
              sub={`Gross ${fmtPnl(grossTotal)} · Charges ${fmtRs(chargesTotal)}`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 text-[11px] tabular-nums">
            <span className="text-muted-foreground">Realized P&amp;L <span className={cn('font-semibold', pnlClr(summary.realized))}>{fmtPnl(summary.realized)}</span></span>
            <span className="hidden text-muted-foreground/40 sm:inline">·</span>
            <span className="text-muted-foreground">Total Charges <span className="font-semibold text-destructive">{fmtRs(summary.totalCharges)}</span></span>
            <span className="hidden text-muted-foreground/40 sm:inline">·</span>
            <span className="text-muted-foreground">Last updated <span className="font-semibold text-foreground">{lastUpdated} IST</span></span>
          </div>
        </>
      )}

      {/* ═══ OPEN POSITIONS — upar, apna alag live card ═══ */}
      <SectionCard
        title="Open Positions"
        icon={Briefcase}
        className="border-success/30 shadow-[0_0_24px_-12px_hsl(var(--success)/0.35)]"
        headerRight={
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              aria-label={showOpen ? 'Collapse open positions' : 'Expand open positions'}
            >
              {showOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-bold tabular-nums text-success">
              {positions.length} OPEN · LIVE
            </span>
            {positions.length > 0 && (
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ring-1 ring-inset', openUnreal >= 0 ? 'bg-success/10 text-success ring-success/25' : 'bg-destructive/10 text-destructive ring-destructive/25')}>
                {fmtPnl(openUnreal)} live
              </span>
            )}
            <div className="ml-1 flex items-center gap-1">
              {(['TABLE', 'CARDS'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                    view === v ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {v === 'TABLE' ? <Table2 className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
                  {v === 'TABLE' ? 'Table' : 'Cards'}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {!showOpen ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">Collapsed — header toggle se wapas kholo.</p>
        ) : refreshing ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
          </div>
        ) : positions.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No open positions"
            description="Executed Dummy trades appear here with real LTP-driven mark-to-market."
            action={<Button asChild variant="outline" size="sm"><Link href="/trading/trade">Trade</Link></Button>}
          />
        ) : view === 'CARDS' ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {positions.map((p, idx) => {
              const id = p.symbol + p.product;
              return (
                <OpenCard
                  key={id} p={p} d={getDisp(p)} idx={idx}
                  targets={targetsFor(p.symbol)}
                  squaring={squaring === p.symbol} confirming={confirmSq?.symbol === p.symbol}
                  expanded={expanded === id}
                  onToggle={() => setExpanded(expanded === id ? null : id)}
                  onAskSquareOff={() => setConfirmSq(p)}
                  onSubmitTarget={() => void submitTarget(p.symbol)}
                  onRemoveTarget={(tid) => void removeTarget(tid)}
                  form={formFor(p.symbol)} setForm={(patch) => setForm(p.symbol, patch)}
                />
              );
            })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-muted/50">
                <TableRow>
                  <TableHead />
                  <TableHead>Symbol</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg Price</TableHead>
                  <TableHead className="text-right">LTP</TableHead>
                  <TableHead className="text-right">Current Value</TableHead>
                  <TableHead className="text-right">P&amp;L</TableHead>
                  <TableHead className="text-right">P&amp;L %</TableHead>
                  <TableHead className="text-right">Charges</TableHead>
                  <TableHead className="text-right">Net P&amp;L</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => {
                  const id = p.symbol + p.product;
                  const openRow = expanded === id;
                  return (
                    <Fragment key={id}>
                      <OpenRow
                        p={p} d={getDisp(p)} expanded={openRow}
                        squaring={squaring === p.symbol} confirming={confirmSq?.symbol === p.symbol}
                        onToggle={() => setExpanded(openRow ? null : id)}
                        onAskSquareOff={() => setConfirmSq(p)}
                      />
                      {openRow && (
                        <TableRow>
                          <TableCell colSpan={12} className="bg-muted/20">
                            <TargetEditor
                              symbol={p.symbol} targets={targetsFor(p.symbol)}
                              form={formFor(p.symbol)} setForm={(patch) => setForm(p.symbol, patch)}
                              onSubmit={() => void submitTarget(p.symbol)} onRemove={(tid) => void removeTarget(tid)}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* ═══ CLOSED POSITIONS — neeche, apna alag history card ═══ */}
      <SectionCard
        title="Closed Positions"
        icon={History}
        className="border-border/70 opacity-[0.98]"
        headerRight={
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowClosed((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              aria-label={showClosed ? 'Collapse closed positions' : 'Expand closed positions'}
            >
              {showClosed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-bold tabular-nums text-muted-foreground">
              {closed.length} CLOSED · HISTORY
            </span>
            {closed.length > 0 && (
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ring-1 ring-inset', closedRealized >= 0 ? 'bg-success/10 text-success ring-success/25' : 'bg-destructive/10 text-destructive ring-destructive/25')}>
                {fmtPnl(closedRealized)} realized
              </span>
            )}
          </div>
        }
      >
        {!showClosed ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">Collapsed — header toggle se wapas kholo.</p>
        ) : closedLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
          </div>
        ) : closed.length === 0 ? (
          <EmptyState
            icon={History}
            title="Nothing closed yet"
            description="When an open position returns to flat (trade, square-off or target auto-exit) it is recorded here with realized P&L."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg entry</TableHead>
                  <TableHead className="text-right">Avg exit</TableHead>
                  <TableHead className="text-right">Realized P&amp;L</TableHead>
                  <TableHead className="text-right">Charges</TableHead>
                  <TableHead className="text-right">Net P&amp;L</TableHead>
                  <TableHead>Closed (IST)</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closed.map((c) => {
                  const net = Number(c.netPnl ?? c.realizedPnl ?? 0);
                  const tone = pnlTone(net);
                  return (
                    <TableRow key={c.id} className="opacity-90 hover:bg-muted/40">
                      <TableCell className="font-semibold">{c.symbol}</TableCell>
                      <TableCell><Badge variant={c.side === 'BUY' ? 'default' : 'destructive'} className="rounded-lg px-2 py-0.5 text-[10px] font-semibold">{c.side}</Badge></TableCell>
                      <TableCell className="text-xs">{c.product}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{c.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.averagePrice != null ? fmtRs(c.averagePrice) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.exitPrice != null ? fmtRs(c.exitPrice) : '—'}</TableCell>
                      <TableCell className={cn('text-right font-bold tabular-nums', pnlClr(c.realizedPnl))}>{fmtPnl(c.realizedPnl)}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">{c.charges ? fmtRs(c.charges) : '—'}</TableCell>
                      <TableCell className={cn('text-right font-bold tabular-nums', tone === 'success' ? 'text-emerald-500' : tone === 'danger' ? 'text-red-500' : '')}>{fmtPnl(net)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatISTDateTime(c.closedAt)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{c.reason ?? 'EXECUTED'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* Square-off confirm */}
      <Dialog open={!!confirmSq} onOpenChange={(o) => { if (!o) setConfirmSq(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Square Off Position</DialogTitle></DialogHeader>
          {confirmSq && confirmDisp && (
            <div className="space-y-3 py-2">
              <div className="flex items-center justify-between rounded-lg bg-muted p-3">
                <div>
                  <p className="text-sm font-semibold">{confirmSq.tradingSymbol || confirmSq.symbol}</p>
                  <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                    {confirmSq.netQuantity > 0 ? 'LONG' : 'SHORT'} x {Math.abs(confirmSq.netQuantity)} @ {confirmDisp.avg > 0 ? fmtRs(confirmDisp.avg) : '—'}
                  </p>
                </div>
                <Badge variant={confirmSq.netQuantity > 0 ? 'default' : 'destructive'}>
                  {confirmSq.netQuantity > 0 ? 'SELL to exit' : 'BUY to exit'}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded bg-muted/50 p-2">
                  <p className="text-[10px] text-muted-foreground">Live LTP</p>
                  <p className="font-mono text-sm font-semibold tabular-nums">{confirmDisp.ltp != null ? fmtRs(confirmDisp.ltp) : '—'}</p>
                </div>
                <div className="rounded bg-muted/50 p-2">
                  <p className="text-[10px] text-muted-foreground">Est. Gross</p>
                  <p className={cn('font-mono text-sm font-semibold tabular-nums', pnlClr(confirmDisp.gross))}>{fmtPnl(confirmDisp.gross)}</p>
                </div>
                <div className="rounded bg-muted/50 p-2">
                  <p className="text-[10px] text-muted-foreground">Est. Net</p>
                  <p className={cn('font-mono text-sm font-semibold tabular-nums', pnlClr(confirmDisp.net))}>{fmtPnl(confirmDisp.net)}</p>
                </div>
              </div>
              <p className="text-center text-xs text-muted-foreground">
                Market order at live price — fills at the current LTP with ±0.1% slippage.
              </p>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmSq(null)} disabled={squaring != null}>Cancel</Button>
            <Button variant="destructive" onClick={() => void doSquareOff()} disabled={squaring != null}>
              {squaring != null ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Power className="mr-1 h-3 w-3" />}
              {squaring != null ? 'Placing Order...' : 'Confirm Square Off'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DummyThemedPage>
  );
}
