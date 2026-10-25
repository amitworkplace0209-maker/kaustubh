'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Download, History, Package, RefreshCw, Search, Trash2, Pencil, ChevronDown, Loader2, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, MetricCard, PageHeader, StatusBadge, fmtNumber } from '@/components/design-system';
import { cancelTerminalOrder, ensureTerminalAuth, getTerminalOrderHistory, getTerminalOrders, isAuthenticated, modifyTerminalOrder, toTerminalId } from '@/lib/terminal-service';
import { type TradingMode } from '@/lib/settings-store';
import { canonicalOrderStatus, execTone } from '@/components/orders/trade/lifecycle';
import { SIDE_CLASS, capsFor, fmtMoney } from '@/components/orders/trade/capabilities';
import {
  canCancel,
  canModify,
  historyRowBucket,
  istDateOf,
  normalizeOrderRow,
  HISTORY_BUCKETS,
  type HistoryBucket,
  type HistoryOrderRow,
} from './types';

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/25';

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

function todayIstDate(): string {
  return new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
}

function detailString(err: any): string {
  const raw = err?.rawDetail ?? err?.body?.detail ?? err?.message ?? 'unknown error';
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return raw.message ?? JSON.stringify(raw);
  return String(raw);
}

export function HistoryPage({ mode }: { mode: TradingMode }) {
  const terminal = toTerminalId(mode);
  return <HistoryWorkspace terminal={terminal} mode={mode} />;
}

type PerOrderBusy = { fetchingHistory: boolean; cancelling: boolean; modifying: boolean };

function HistoryWorkspace({ terminal, mode }: { terminal: ReturnType<typeof toTerminalId>; mode: TradingMode }) {
  const router = useRouter();
  // Cancel / modify are JWT-gated on the backend and the token lives in memory
  // only, so hydrate it the same way the trade page does — otherwise the row
  // actions were permanently disabled after any reload ("sign in" with no door).
  const [loggedIn, setLoggedIn] = useState<boolean>(() => isAuthenticated());
  useEffect(() => {
    if (mode === 'dummy' || loggedIn) return;
    let cancelled = false;
    void ensureTerminalAuth().then((ok) => { if (!cancelled && ok) setLoggedIn(true); });
    return () => { cancelled = true; };
  }, [mode, loggedIn]);
  const currency = capsFor(terminal).virtualCurrency ? 'Coin' : '₹';

  const [rows, setRows] = useState<HistoryOrderRow[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<Record<string, any[]>>({});
  const [busy, setBusy] = useState<Record<string, Partial<PerOrderBusy>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [bucket, setBucket] = useState<HistoryBucket>('ALL');
  const [dateRange, setDateRange] = useState<'today' | '7d' | 'all'>('today');
  const [symbolSearch, setSymbolSearch] = useState('');
  const [sideFilter, setSideFilter] = useState('ALL');
  const [productFilter, setProductFilter] = useState('ALL');

  const [cancelTarget, setCancelTarget] = useState<HistoryOrderRow | null>(null);
  const [modifyTarget, setModifyTarget] = useState<HistoryOrderRow | null>(null);
  const [modifyQty, setModifyQty] = useState<string>('');
  const [modifyPrice, setModifyPrice] = useState<string>('');
  const [modifyTrigger, setModifyTrigger] = useState<string>('');
  const busyRef = useRef(false);

  const termRef = useRef(terminal);
  termRef.current = terminal;

  const load = useCallback(async () => {
    const term = terminal;
    busyRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getTerminalOrders(term);
      // A terminal switch can happen while the request is in flight (the first
      // render still uses the hydrated-local mode until the reconciler pins the
      // backend one). A stale answer — usually a 409 for the wrong terminal —
      // must never overwrite the ACTIVE terminal's book state.
      if (term !== termRef.current) return;
      setConnected(Boolean(res?.isLoggedIn));
      const data = Array.isArray(res?.data) ? (res.data as Record<string, any>[]) : [];
      setRows(data.map(normalizeOrderRow));
    } catch (e: any) {
      if (term !== termRef.current) return;
      setConnected(null);
      setRows([]);
      setLoadError(detailString(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [terminal]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => {
      if (!busyRef.current) void load();
    }, 6000);
    return () => window.clearInterval(t);
  }, [load]);

  const openDetail = useCallback(
    async (id: string) => {
      setExpanded((cur) => (cur === id ? null : id));
      if (expanded !== id && !historyRows[id]) {
        setBusy((p) => ({ ...p, [id]: { ...(p[id] || {}), fetchingHistory: true } }));
        try {
          const res = await getTerminalOrderHistory(terminal, id);
          setHistoryRows((p) => ({ ...p, [id]: Array.isArray(res?.data) ? res.data : [] }));
        } catch (e: any) {
          setHistoryRows((p) => ({ ...p, [id]: [] }));
          setErrors((p) => ({ ...p, [id]: `order history: ${detailString(e)}` }));
        } finally {
          setBusy((p) => ({ ...p, [id]: { ...(p[id] || {}), fetchingHistory: false } }));
        }
      }
    },
    [expanded, historyRows, terminal],
  );

  const counts = useMemo(() => {
    const c: Record<HistoryBucket, number> = { ALL: rows.length, FILLED: 0, OPEN: 0, PARTIALLY_FILLED: 0, CANCELLED: 0, REJECTED: 0 };
    for (const r of rows) c[historyRowBucket(canonicalOrderStatus(r.rawStatus))]++;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    const today = todayIstDate();
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (dateRange === 'today') out = out.filter((r) => istDateOf(r.orderDate ? new Date(r.orderDate).getTime() : null) === today);
    else if (dateRange === '7d') out = out.filter((r) => new Date(r.orderDate ?? NaN * 0).getTime() >= weekAgo);
    if (bucket !== 'ALL') out = out.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === bucket);
    if (symbolSearch) {
      const q = symbolSearch.toUpperCase().trim();
      out = out.filter((r) => r.symbol.toUpperCase().includes(q) || r.tradingSymbol.toUpperCase().includes(q));
    }
    if (sideFilter !== 'ALL') out = out.filter((r) => r.transactionType.toUpperCase() === sideFilter);
    if (productFilter !== 'ALL') out = out.filter((r) => r.product.toUpperCase() === productFilter);
    return out;
  }, [rows, bucket, dateRange, symbolSearch, sideFilter, productFilter]);

  const todayRows = useMemo(() => rows.filter((r) => istDateOf(r.orderDate ? new Date(r.orderDate).getTime() : null) === todayIstDate()), [rows]);
  const todayValue = useMemo(
    () => todayRows.reduce((acc, r) => acc + (r.averageTradedPrice ?? r.price ?? 0) * r.quantity, 0),
    [todayRows],
  );

  const grouped = useMemo(() => {
    const g = new Map<string, HistoryOrderRow[]>();
    for (const r of filtered) {
      const d = istDateOf(r.orderDate ? new Date(r.orderDate).getTime() : null);
      if (!g.has(d)) g.set(d, []);
      g.get(d)!.push(r);
    }
    return [...g.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [filtered]);

  const exportCsv = useCallback(() => {
    const header = 'Date,Order ID,Symbol,Side,Product,Type,Qty,Price,Filled,Avg Fill,Status\n';
    const body = filtered
      .map((r) =>
        [
          istDateOf(r.orderDate ? new Date(r.orderDate).getTime() : null),
          r.orderId,
          r.symbol,
          r.transactionType,
          r.product,
          r.orderType,
          r.quantity,
          r.price ?? '',
          r.filledQuantity ?? '',
          r.averageTradedPrice ?? '',
          canonicalOrderStatus(r.rawStatus),
        ].join(','),
      )
      .join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `order-history-${terminal}-${todayIstDate()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, terminal]);

  const runCancel = useCallback(async () => {
    if (!cancelTarget || !loggedIn) return;
    const id = cancelTarget.orderId;
    setBusy((p) => ({ ...p, [id]: { ...(p[id] || {}), cancelling: true } }));
    setErrors((p) => ({ ...p, [id]: '' }));
    busyRef.current = true;
    try {
      await cancelTerminalOrder(mode, id);
      setCancelTarget(null);
      void load();
    } catch (e: any) {
      setErrors((p) => ({ ...p, [id]: `cancel: ${detailString(e)}` }));
    } finally {
      setBusy((p) => ({ ...p, [id]: { ...(p[id] || {}), cancelling: false } }));
      busyRef.current = false;
    }
  }, [cancelTarget, loggedIn, mode, load]);

  const runModify = useCallback(async () => {
    if (!modifyTarget || !loggedIn) return;
    const id = modifyTarget.orderId;
    const quantity = parseInt(modifyQty, 10) || 0;
    const price = parseFloat(modifyPrice) || 0;
    const trigger = parseFloat(modifyTrigger) || 0;
    if (quantity <= 0) {
      setErrors((p) => ({ ...p, [id]: 'modify: quantity must be positive' }));
      return;
    }
    setBusy((p) => ({ ...p, [id]: { ...(p[id] || {}), modifying: true } }));
    setErrors((p) => ({ ...p, [id]: '' }));
    busyRef.current = true;
    try {
      await modifyTerminalOrder(
        mode,
        {
          symbol: modifyTarget.symbol,
          exchange: modifyTarget.exchange || 'nse_cm',
          product: modifyTarget.product || 'MIS',
          transaction_type: modifyTarget.transactionType,
          order_type: modifyTarget.orderType || 'MKT',
          quantity,
          price,
          trigger_price: trigger,
        },
        id,
      );
      setModifyTarget(null);
      void load();
    } catch (e: any) {
      setErrors((p) => ({ ...p, [id]: `modify: ${detailString(e)}` }));
    } finally {
      setBusy((p) => ({ ...p, [id]: { ...(p[id] || {}), modifying: false } }));
      busyRef.current = false;
    }
  }, [modifyTarget, loggedIn, modifyQty, modifyPrice, modifyTrigger, mode, load]);

  return (
    <div className="space-y-4">
      <PageHeader title="Order History" subtitle={`${mode} ${terminal === 'dummy' ? 'paper' : ''} order book — real fills from the adapter`}>
        <Button type="button" variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
          <Download className="h-3.5 w-3.5" /> Export
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
        </Button>
      </PageHeader>

      {/* Dummy Mode — replaces Session required card */}
      {(capsFor(terminal).virtualCurrency || terminal === 'dummy') && (
        <div className="rounded-xl border border-purple/30 bg-gradient-to-br from-purple/10 via-purple/[0.04] to-transparent px-4 py-3.5 flex items-center gap-3 shadow-sm">
          <div className="h-9 w-9 rounded-xl bg-purple/15 border border-purple/20 flex items-center justify-center shrink-0">
            <Activity className="h-4 w-4 text-purple" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold tracking-tight text-purple flex items-center gap-2">● Dummy Mode — Paper History <Badge className="bg-purple/15 text-purple border-purple/30 text-[9px] h-4 px-1.5">VIRTUAL</Badge></div>
            <p className="text-xs font-medium text-muted-foreground">Paper order book · Real adapter fills · Virtual coins · No broker settlement</p>
          </div>
          <div className="hidden sm:flex items-center gap-2 shrink-0">
            <span className="h-2 w-2 rounded-full bg-purple animate-pulse" />
            <span className="text-[11px] font-bold text-purple tracking-wider">PAPER</span>
          </div>
        </div>
      )}

      {/* Order History Details */}
      <section className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5 bg-muted/10">
          <h3 className="text-xs font-bold uppercase tracking-widest text-foreground flex items-center gap-2"><Package className="h-3.5 w-3.5 text-primary" /> History Details</h3>
          <span className="text-[10px] font-semibold text-muted-foreground tabular-nums">{rows.length} total · {filtered.length} filtered · {todayRows.length} today</span>
        </div>
        <div className="p-4 grid gap-4 md:grid-cols-3 text-xs leading-relaxed">
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Book</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Terminal</span><span className="font-bold text-foreground">{terminal}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Mode</span><span className="font-bold">{capsFor(terminal).modeLabel ?? mode}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Currency</span><span className="font-bold">{currency}</span></div>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Today</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Orders</span><span className="font-bold text-foreground">{todayRows.length}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Filled / Open</span><span className="font-bold"><span className="text-success">{todayRows.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'FILLED').length}</span> / <span className="text-warning">{todayRows.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'OPEN').length}</span></span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Notional</span><span className="font-mono font-bold">{fmtMoney(todayValue, currency)}</span></div>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Selection</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Bucket</span><span className="font-bold">{bucket}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Date Range</span><span className="font-bold">{dateRange}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Filtered</span><span className="font-bold text-foreground">{filtered.length}</span></div>
            </div>
          </div>
        </div>
      </section>

      {connected === false && (
        <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-foreground/90">
          {terminal} is not connected — the order book is empty until the broker session is live. Recent history may still
          be visible after reconnecting.
        </p>
      )}
      {loadError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {loadError}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard icon={History} title="Orders today" value={String(todayRows.length)} tone="blue" />
        <MetricCard icon={History} title="Filled" value={String(todayRows.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'FILLED').length)} tone="success" />
        <MetricCard icon={History} title="Open" value={String(todayRows.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'OPEN').length)} tone="warning" />
        <MetricCard icon={History} title="Cancelled" value={String(todayRows.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'CANCELLED').length)} tone="neutral" />
        <MetricCard icon={History} title="Rejected" value={String(todayRows.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'REJECTED').length)} tone="danger" />
        <MetricCard icon={History} title="Notional value" value={fmtMoney(todayValue, currency)} tone="blue" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className={cn(inputCls, 'pl-8')}
            placeholder="Search symbol…"
            value={symbolSearch}
            onChange={(e) => setSymbolSearch(e.target.value)}
          />
        </div>
        <select className={cn(inputCls, 'w-[120px]')} value={dateRange} onChange={(e) => setDateRange(e.target.value as 'today' | '7d' | 'all')}>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="all">All</option>
        </select>
        <select className={cn(inputCls, 'w-[110px]')} value={sideFilter} onChange={(e) => setSideFilter(e.target.value)}>
          <option value="ALL">All sides</option>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
        <select className={cn(inputCls, 'w-[110px]')} value={productFilter} onChange={(e) => setProductFilter(e.target.value)}>
          <option value="ALL">All products</option>
          <option value="MIS">MIS</option>
          <option value="CNC">CNC</option>
          <option value="NRML">NRML</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {HISTORY_BUCKETS.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setBucket(b.id)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
              bucket === b.id
                ? 'border-primary/60 bg-primary/15 text-primary'
                : 'border-border bg-card text-muted-foreground hover:text-foreground',
            )}
          >
            {b.label}
            <span className="ml-1 tabular-nums opacity-70">{counts[b.id]}</span>
          </button>
        ))}
      </div>

      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={History}
          title="No orders match"
          description="Nothing in the order book for these filters. Place a trade to see real fills here."
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => router.push('/trading/trade')}>
              Go to Trade
            </Button>
          }
        />
      )}

      <div className="space-y-4">
        {grouped.map(([dateStr, group]) => (
          <div key={dateStr} className="space-y-2">
            <DividerRow dateStr={dateStr} group={group} />
            {group.map((r) => {
              const canon = canonicalOrderStatus(r.rawStatus);
              const open = expanded === r.orderId;
              return (
                <div key={r.orderId} className="rounded-md border border-border bg-card">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                    onClick={() => void openDetail(r.orderId)}
                  >
                    <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{r.symbol || r.tradingSymbol}</span>
                      <span className="block font-mono text-[9px] text-muted-foreground/70">{r.orderId}</span>
                    </span>
                    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', (r.transactionType.toUpperCase() in SIDE_CLASS ? (SIDE_CLASS as Record<string, string>)[r.transactionType.toUpperCase()] : undefined) ?? 'bg-muted text-foreground')}>
                      {r.transactionType}
                    </span>
                    <span className="hidden rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground sm:inline">
                      {r.product} · {r.orderType}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {r.quantity} × {fmtNumber(r.averageTradedPrice ?? r.price)}
                    </span>
                    <span className="hidden text-[11px] tabular-nums text-muted-foreground lg:inline">{fmtTime(r.orderDate)}</span>
                    <StatusBadge status={execTone(canon)} label={canon} />
                  </button>

                  {open && (
                    <div className="space-y-3 border-t border-border px-3 py-3">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
                        {[
                          ['Placed (IST)', fmtTime(r.orderDate)],
                          ['Requested price', fmtNumber(r.price)],
                          ['Avg fill', fmtNumber(r.averageTradedPrice)],
                          ['Filled / qty', `${r.filledQuantity ?? '—'} / ${r.quantity}`],
                          ['Unfilled', fmtNumber(r.unfilledQuantity)],
                          ['Trigger', fmtNumber(r.triggerPrice)],
                          ['Exchange', r.exchange || '—'],
                          ['Modified', fmtTime(r.modifiedAt)],
                        ].map(([k, v]) => (
                          <div key={k}>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{k}</p>
                            <p className="truncate font-medium text-foreground/90">{v}</p>
                          </div>
                        ))}
                      </div>
                      {r.errorMessage && (
                        <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-[10px] text-foreground/80">
                          {r.errorMessage}
                        </p>
                      )}

                      {errors[r.orderId] && (
                        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[10px] text-destructive">
                          {errors[r.orderId]}
                        </p>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        {canModify(canon) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!loggedIn || Boolean(busy[r.orderId]?.cancelling || busy[r.orderId]?.modifying)}
                            onClick={() => {
                              setModifyTarget(r);
                              setModifyQty(String(r.quantity));
                              setModifyPrice(String(r.price ?? ''));
                              setModifyTrigger(String(r.triggerPrice ?? ''));
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" /> Modify
                          </Button>
                        )}
                        {canCancel(canon) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!loggedIn || Boolean(busy[r.orderId]?.cancelling || busy[r.orderId]?.modifying)}
                            onClick={() => setCancelTarget(r)}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Cancel
                          </Button>
                        )}
                        {!loggedIn && (canModify(canon) || canCancel(canon)) && (
                          <span className="text-[10px] text-muted-foreground">sign in above to modify or cancel</span>
                        )}
                      </div>

                      <div className="border-t border-border/60 pt-2">
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Adapter order history
                        </p>
                        {busy[r.orderId]?.fetchingHistory ? (
                          <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Loading from {terminal}…
                          </p>
                        ) : (historyRows[r.orderId] ?? []).length === 0 ? (
                          <p className="text-[10px] text-muted-foreground/70">No attempt rows returned by the adapter.</p>
                        ) : (
                          <div className="space-y-1">
                            {(historyRows[r.orderId] ?? []).map((h, i) => (
                              <div key={i} className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[10px]">
                                <StatusBadge status={execTone(canonicalOrderStatus(h?.status))} label={canonicalOrderStatus(h?.status)} />
                                <span className="tabular-nums text-muted-foreground">
                                  {h?.quantity ?? ''} × {fmtNumber(h?.price)} @ {fmtNumber(h?.averageTradedPrice)}
                                </span>
                                <span className="ml-auto tabular-nums text-muted-foreground/70">
                                  {fmtTime(h?.orderDate ?? h?.timestamp ?? null)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <Dialog open={cancelTarget !== null} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel order {cancelTarget?.orderId}</DialogTitle>
            <DialogDescription>
              Sends a real cancel through the Common Trading Core (Risk → Audit → Adapter). Only the broker decides
              whether the order can still be cancelled.
            </DialogDescription>
          </DialogHeader>
          {cancelTarget && (
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span>Symbol: <span className="font-semibold text-foreground">{cancelTarget.symbol}</span></span>
              <span>Side: {cancelTarget.transactionType}</span>
              <span>Qty: {cancelTarget.quantity}</span>
              <span>Status: {canonicalOrderStatus(cancelTarget.rawStatus)}</span>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCancelTarget(null)} disabled={busy[cancelTarget?.orderId || '']?.cancelling}>
              Keep order
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy[cancelTarget?.orderId || '']?.cancelling}
              onClick={() => void runCancel()}
            >
              {busy[cancelTarget?.orderId || '']?.cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Confirm cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modifyTarget !== null} onOpenChange={(open) => !open && setModifyTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modify order {modifyTarget?.orderId}</DialogTitle>
            <DialogDescription>
              Sends a real modify request (risk-checked server-side). Fields left at zero are sent unchanged.
            </DialogDescription>
          </DialogHeader>
          {modifyTarget && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Quantity
                </label>
                <input className={inputCls} inputMode="numeric" value={modifyQty} onChange={(e) => setModifyQty(e.target.value)} />
              </div>
              {modifyTarget.orderType !== 'MKT' && (
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Limit price
                  </label>
                  <input className={inputCls} inputMode="decimal" value={modifyPrice} onChange={(e) => setModifyPrice(e.target.value)} />
                </div>
              )}
              {(modifyTarget.orderType === 'SL' || modifyTarget.orderType === 'SL-M') && (
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Trigger price
                  </label>
                  <input className={inputCls} inputMode="decimal" value={modifyTrigger} onChange={(e) => setModifyTrigger(e.target.value)} />
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setModifyTarget(null)} disabled={busy[modifyTarget?.orderId || '']?.modifying}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy[modifyTarget?.orderId || '']?.modifying}
              onClick={() => void runModify()}
            >
              {busy[modifyTarget?.orderId || '']?.modifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
              Submit modify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        Rows come from <code>GET /api/terminal/orders/{terminal}</code> (adapter order book). Expand an order to load its
        per-attempt history via <code>{`/orders/${terminal}/${'{orderId}'}/history`}</code> — both are server-authoritative.
        Notional value is price × quantity of today&apos;s rows; no P&amp;L is invented client-side.
      </p>
    </div>
  );
}

function DividerRow({ dateStr, group }: { dateStr: string; group: HistoryOrderRow[] }) {
  const filled = group.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'FILLED').length;
  const open = group.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'OPEN').length;
  const cancelled = group.filter((r) => historyRowBucket(canonicalOrderStatus(r.rawStatus)) === 'CANCELLED').length;
  return (
    <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{dateStr}</span>
        <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {group.length} orders
        </span>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="text-success">{filled} filled</span>
        <span className="text-warning">{open} open</span>
        <span className="text-muted-foreground">{cancelled} cancelled</span>
      </div>
    </div>
  );
}