'use client';

import { useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  History,
  RefreshCw,
  CheckCircle2,
  Loader2,
  Clock,
  Pencil,
  XCircle,
  Ban,
  CalendarDays,
  ChevronDown,
  Search,
  Download,
  ChevronRight,
  Eye,
  RotateCcw,
  TrendingUp,
  TrendingDown,
  Activity,
  Edit,
  Trash,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MetricCard, StatusBadge, EmptyState, ErrorState, SectionCard } from '@/components/design-system';
import { useDummyState } from '@/hooks/use-dummy-state';
import { orderStatusTone, type DummyOrder } from '@/lib/dummy';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { OrdersTabs } from '@/components/orders/orders-tabs';
import { cn } from '@/lib/utils';
import { formatISTDateTime, getISTNow } from '@/lib/ist';

function chargeEstimate(o: DummyOrder): number {
  const price = Number(o.averageTradedPrice || o.price || 0);
  const value = price * Number(o.quantity || 0);
  if (value <= 0) return 0;
  const brokerage = value * 0.0003;
  const stt = value * (o.transactionType === 'BUY' ? 0.001 : 0.00025);
  const exch = value * 0.0000345;
  const gst = (brokerage + exch) * 0.18;
  const sebi = value * 0.00001;
  const stamp = value * 0.000015;
  return Math.round((brokerage + stt + exch + gst + sebi + stamp) * 100) / 100;
}

function marginEstimate(o: DummyOrder): number {
  const price = Number(o.averageTradedPrice || o.price || 0);
  const factor = o.product === 'MIS' ? 0.2 : 1.0;
  return Math.round(price * Number(o.quantity || 0) * factor * 100) / 100;
}

const LIFECYCLE = [
  { id: 'ALL', label: 'All', icon: History, tone: 'neutral' as const },
  { id: 'COMPLETE', label: 'Complete', icon: CheckCircle2, tone: 'success' as const },
  { id: 'PENDING', label: 'Pending', icon: Clock, tone: 'warning' as const },
  { id: 'MODIFIED', label: 'Modified', icon: Pencil, tone: 'info' as const },
  { id: 'CANCELLED', label: 'Cancelled', icon: Ban, tone: 'neutral' as const },
  { id: 'REJECTED', label: 'Rejected', icon: XCircle, tone: 'danger' as const },
] as const;

type Bucket = (typeof LIFECYCLE)[number]['id'];

function bucketOf(o: DummyOrder): Bucket {
  const s = (o.status || '').toUpperCase();
  if (s === 'COMPLETE' || s === 'FILLED') return 'COMPLETE';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'REJECTED') return 'REJECTED';
  if ('modifiedAt' in o && o.modifiedAt) return 'MODIFIED';
  if (s === 'OPEN' || s === 'PENDING' || s === 'TRIGGER_PENDING' || s === 'PARTIALLY_FILLED' || s === 'EXECUTING') return 'PENDING';
  return 'PENDING';
}

type DateRange = 'today' | 'yesterday' | '7d' | 'custom';

function toISTDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
}

function orderISTDate(o: DummyOrder): string {
  if (o.orderDate) {
    const d = new Date(o.orderDate);
    if (!isNaN(d.getTime())) return toISTDate(d);
  }
  return toISTDate(getISTNow());
}

function dateRangeToInterval(range: DateRange): { start: Date; end: Date } {
  const now = getISTNow();
  const todayStr = toISTDate(now);
  if (range === 'today') {
    const start = new Date(todayStr + 'T00:00:00+05:30');
    return { start, end: now };
  }
  if (range === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const ds = toISTDate(yesterday);
    const start = new Date(ds + 'T00:00:00+05:30');
    const end = new Date(ds + 'T23:59:59+05:30');
    return { start, end };
  }
  if (range === '7d') {
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return { start: sevenDaysAgo, end: now };
  }
  return { start: now, end: now };
}

const TIMELINE_STAGES = ['Created', 'Submitted', 'Acknowledged', 'Filled'] as const;

function getTimelineStages(o: DummyOrder) {
  const stages: { label: string; time: string; done: boolean }[] = [];
  const created = o.orderDate ? formatISTDateTime(o.orderDate) : null;
  stages.push({ label: 'Created', time: created || '—', done: true });
  stages.push({ label: 'Submitted', time: created || '—', done: true });

  const s = (o.status || '').toUpperCase();
  if (s === 'OPEN' || s === 'PENDING' || s === 'TRIGGER_PENDING') {
    stages.push({ label: 'Acknowledged', time: '—', done: false });
    stages.push({ label: 'Pending', time: '—', done: false });
  } else if (s === 'COMPLETE' || s === 'FILLED') {
    stages.push({ label: 'Acknowledged', time: created || '—', done: true });
    stages.push({ label: 'Filled', time: o.averageTradedPrice ? created || '—' : '—', done: !!o.averageTradedPrice });
  } else if (s === 'CANCELLED') {
    stages.push({ label: 'Cancelled', time: created || '—', done: true });
  } else if (s === 'REJECTED') {
    stages.push({ label: 'Rejected', time: o.errorMessage ? created || '—' : '—', done: true });
  } else if (o.modifiedAt) {
    stages.push({ label: 'Acknowledged', time: created || '—', done: true });
    stages.push({ label: 'Modified', time: formatISTDateTime(o.modifiedAt), done: true });
  } else {
    stages.push({ label: 'Acknowledged', time: '—', done: false });
    stages.push({ label: 'Pending', time: '—', done: false });
  }
  return stages;
}

export default function DummyHistory() {
  const { state, error, refresh } = useDummyState(5000);

  const [bucket, setBucket] = useState<Bucket>('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>('today');
  const [symbolSearch, setSymbolSearch] = useState('');
  const [sideFilter, setSideFilter] = useState<string>('ALL');
  const [productFilter, setProductFilter] = useState<string>('ALL');
  const [showFilters, setShowFilters] = useState(false);

  const [modifyOrder, setModifyOrder] = useState<DummyOrder | null>(null);
  const [modifyQty, setModifyQty] = useState('');
  const [modifyPrice, setModifyPrice] = useState('');
  const [modifyTrigger, setModifyTrigger] = useState('');
  const [cancelConfirm, setCancelConfirm] = useState<DummyOrder | null>(null);

  const orders = useMemo(() => state?.orders || [], [state?.orders]);

  const buckets = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of orders) {
      const b = bucketOf(o);
      counts[b] = (counts[b] || 0) + 1;
    }
    return counts;
  }, [orders]);

  const filtered = useMemo(() => {
    let result = orders;

    if (dateRange !== 'custom') {
      const { start } = dateRangeToInterval(dateRange);
      const startStr = toISTDate(start);
      result = result.filter((o) => orderISTDate(o) >= startStr);
    }

    if (bucket !== 'ALL') {
      result = result.filter((o) => bucketOf(o) === bucket);
    }

    if (symbolSearch) {
      const q = symbolSearch.toUpperCase();
      result = result.filter((o) => (o.symbol || '').toUpperCase().includes(q));
    }

    if (sideFilter !== 'ALL') {
      result = result.filter((o) => (o.transactionType || '').toUpperCase() === sideFilter);
    }

    if (productFilter !== 'ALL') {
      result = result.filter((o) => (o.product || '').toUpperCase() === productFilter);
    }

    return result;
  }, [orders, bucket, dateRange, symbolSearch, sideFilter, productFilter]);

  const summary = useMemo(() => {
    const todayStr = toISTDate(getISTNow());
    const todayOrders = orders.filter((o) => orderISTDate(o) === todayStr);
    const totalValue = todayOrders.reduce((acc, o) => {
      const price = Number(o.averageTradedPrice || o.price || 0);
      return acc + price * Number(o.quantity || 0);
    }, 0);
    const charges = todayOrders.reduce((acc, o) => acc + chargeEstimate(o), 0);
    const completeCount = todayOrders.filter((o) => bucketOf(o) === 'COMPLETE').length;
    const pendingCount = todayOrders.filter((o) => bucketOf(o) === 'PENDING').length;
    const cancelledCount = todayOrders.filter((o) => bucketOf(o) === 'CANCELLED').length;
    return {
      total: todayOrders.length,
      complete: completeCount,
      pending: pendingCount,
      cancelled: cancelledCount,
      totalValue: Math.round(totalValue * 100) / 100,
      netPnL: Math.round((totalValue * 0.001 - charges) * 100) / 100,
    };
  }, [orders]);

  const groupedByDate = useMemo(() => {
    const groups: Record<string, { orders: DummyOrder[]; totalValue: number; complete: number; pending: number; cancelled: number }> = {};
    for (const o of filtered) {
      const d = orderISTDate(o);
      if (!groups[d]) {
        groups[d] = { orders: [], totalValue: 0, complete: 0, pending: 0, cancelled: 0 };
      }
      groups[d].orders.push(o);
      const price = Number(o.averageTradedPrice || o.price || 0);
      groups[d].totalValue += price * Number(o.quantity || 0);
      const b = bucketOf(o);
      if (b === 'COMPLETE') groups[d].complete++;
      else if (b === 'PENDING') groups[d].pending++;
      else if (b === 'CANCELLED') groups[d].cancelled++;
    }
    const sorted = Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
    return sorted;
  }, [filtered]);

  const tradingDate = state?.market?.tradingDate ?? '—';
  const nowIst = formatISTDateTime(getISTNow());

  const openModify = useCallback((o: DummyOrder) => {
    setModifyOrder(o);
    setModifyQty(String(o.quantity || ''));
    setModifyPrice(String(o.price || ''));
    setModifyTrigger(String(o.triggerPrice || ''));
  }, []);

  const handleModifySubmit = useCallback(() => {
    if (!modifyOrder) return;
    setModifyOrder(null);
  }, [modifyOrder]);

  const handleCancelOrder = useCallback(() => {
    if (!cancelConfirm) return;
    setCancelConfirm(null);
  }, [cancelConfirm]);

  const handleReorder = useCallback((o: DummyOrder) => {
    setModifyOrder(o);
    setModifyQty(String(o.quantity || ''));
    setModifyPrice(String(o.price || ''));
    setModifyTrigger(String(o.triggerPrice || ''));
  }, []);

  const handleExport = useCallback(() => {
    const header = 'Date,Order ID,Symbol,Side,Product,Type,Qty,Price,Status\n';
    const rows = filtered
      .map((o) =>
        [
          orderISTDate(o),
          o.orderId,
          o.symbol,
          o.transactionType,
          o.product,
          o.orderType,
          o.quantity,
          o.averageTradedPrice || o.price || '',
          o.status,
        ].join(',')
      )
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `order-history-${toISTDate(getISTNow())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  if (error && !state) {
    return (
      <DummyThemedPage>
        <OrdersTabs />
        <ErrorState message={error} onRetry={() => void refresh()} />
      </DummyThemedPage>
    );
  }

  return (
    <DummyThemedPage>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Order History</h1>
          <DummyBadge />
        </div>
        <div className="flex items-center gap-2">
          <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
            <SelectTrigger className="w-[160px]">
              <CalendarDays className="mr-1 h-3.5 w-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="yesterday">Yesterday</SelectItem>
              <SelectItem value="7d">Last 7 Days</SelectItem>
              <SelectItem value="custom">Custom Range</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-4 w-4" /> Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      <OrdersTabs />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard icon={History} title="Total Orders" value={String(summary.total)} tone="blue" />
        <MetricCard icon={CheckCircle2} title="Completed" value={String(summary.complete)} tone="success" />
        <MetricCard icon={Clock} title="Pending" value={String(summary.pending)} tone="warning" />
        <MetricCard icon={Ban} title="Cancelled" value={String(summary.cancelled)} tone="neutral" />
        <MetricCard
          icon={summary.netPnL >= 0 ? TrendingUp : TrendingDown}
          title="Net P&L"
          value={`${summary.netPnL >= 0 ? '+' : ''}${summary.netPnL.toFixed(2)}`}
          tone={summary.netPnL >= 0 ? 'success' : 'danger'}
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search symbol..."
            className="pl-8"
            value={symbolSearch}
            onChange={(e) => setSymbolSearch(e.target.value)}
          />
        </div>
        <Select value={sideFilter} onValueChange={setSideFilter}>
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="Side" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Sides</SelectItem>
            <SelectItem value="BUY">BUY</SelectItem>
            <SelectItem value="SELL">SELL</SelectItem>
          </SelectContent>
        </Select>
        <Select value={productFilter} onValueChange={setProductFilter}>
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="Product" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Products</SelectItem>
            <SelectItem value="MIS">MIS</SelectItem>
            <SelectItem value="CNC">CNC</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {LIFECYCLE.map((l) => {
          const count = l.id === 'ALL' ? filtered.length : filtered.filter((o) => bucketOf(o) === l.id).length;
          const active = bucket === l.id;
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => setBucket(l.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                active ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <l.icon className="h-3.5 w-3.5" />
              {l.label}
              <span className="tabular-nums opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      <SectionCard title="Daily lifecycle" icon={CalendarDays}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Trading date (IST)</span>{' '}
            <span className="font-semibold tabular-nums">{tradingDate}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Now (IST)</span>{' '}
            <span className="font-semibold tabular-nums">{nowIst}</span>
          </div>
          <div>
            <span className="text-muted-foreground">New-day reset</span>{' '}
            <span className="font-medium">08:30 IST</span>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Today's run is scoped to the current trading day. At the 08:30 IST daily task the previous day&apos;s temporary
          history is expired/archived and today&apos;s history starts clean. The 7-day Order History is a separate system and the
          Audit Trail is never affected by daily cleanup.
        </p>
      </SectionCard>

      <div className="space-y-4">
        {groupedByDate.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                icon={History}
                title="No orders found"
                description="No orders match your current filters. Try adjusting the date range or clearing filters."
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/trading/trade">Place a trade</Link>
                  </Button>
                }
              />
            </CardContent>
          </Card>
        ) : (
          groupedByDate.map(([dateStr, group]) => (
            <div key={dateStr} className="space-y-2">
              <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                <div className="flex items-center gap-3">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">{dateStr}</span>
                  <Badge variant="outline" className="text-xs">{group.orders.length} orders</Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>Value: <span className="font-medium text-foreground">{group.totalValue.toFixed(2)}</span></span>
                  <span className="text-success">{group.complete} filled</span>
                  <span className="text-warning">{group.pending} pending</span>
                  <span className="text-muted-foreground">{group.cancelled} cancelled</span>
                </div>
              </div>

              {group.orders.map((o) => {
                const open = expanded === o.orderId;
                const bs = bucketOf(o);
                const timeline = getTimelineStages(o);

                return (
                  <div key={o.orderId} className="rounded-md border bg-background">
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                      onClick={() => setExpanded(open ? null : o.orderId)}
                    >
                      <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />

                      <span className="font-medium">{o.symbol}</span>

                      <Badge variant={o.transactionType === 'BUY' ? 'default' : 'destructive'} className="text-[10px] px-1.5 py-0">
                        {o.transactionType}
                      </Badge>

                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {o.product}
                      </Badge>

                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {o.orderType}
                      </Badge>

                      <span className="text-xs text-muted-foreground tabular-nums">
                        {o.quantity} × {o.averageTradedPrice || o.price || '—'}
                      </span>

                      <span className="ml-auto flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {o.orderDate ? formatISTDateTime(o.orderDate) : '—'}
                        </span>
                        <StatusBadge status={orderStatusTone(o.status)} label={o.status} />
                        <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">{o.orderId}</span>
                      </span>
                    </button>

                    {open && (
                      <div className="border-t border-border px-3 py-3 space-y-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          {bs === 'PENDING' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={(e) => { e.stopPropagation(); openModify(o); }}
                            >
                              <Edit className="mr-1 h-3 w-3" /> Modify
                            </Button>
                          )}
                          {(bs === 'PENDING' || bs === 'MODIFIED') && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs text-destructive hover:text-destructive"
                              onClick={(e) => { e.stopPropagation(); setCancelConfirm(o); }}
                            >
                              <Trash className="mr-1 h-3 w-3" /> Cancel
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={(e) => { e.stopPropagation(); handleReorder(o); }}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" /> Re-Order
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Eye className="mr-1 h-3 w-3" /> View Details
                          </Button>
                        </div>

                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs tabular-nums sm:grid-cols-4">
                          <div>
                            <span className="text-muted-foreground">Placed (IST)</span>{' '}
                            <span className="float-right font-medium">{o.orderDate ? formatISTDateTime(o.orderDate) : '—'}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Requested price</span>{' '}
                            <span className="float-right font-medium">{o.price || '—'}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Executed price</span>{' '}
                            <span className="float-right font-medium">{o.averageTradedPrice || '—'}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Filled / qty</span>{' '}
                            <span className="float-right font-medium">{o.filledQuantity ?? '—'} / {o.quantity}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Unfilled</span>{' '}
                            <span className="float-right font-medium">{o.unfilledQuantity ?? 0}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Trigger</span>{' '}
                            <span className="float-right font-medium">{o.triggerPrice || '—'}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Order ID</span>{' '}
                            <span className="float-right font-mono font-medium">{o.orderId}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Fill (avg)</span>{' '}
                            <span className="float-right font-medium">{o.averageTradedPrice || 'pending'}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Source</span>{' '}
                            <span className="float-right font-medium">{o.source || 'MANUAL'}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Est. charges</span>{' '}
                            <span className="float-right font-medium">{chargeEstimate(o).toFixed(2)} Coins</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Margin</span>{' '}
                            <span className="float-right font-medium">{marginEstimate(o).toFixed(2)} Coins</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Modification</span>{' '}
                            <span className="float-right font-medium">{o.modifiedAt ? formatISTDateTime(o.modifiedAt) : '—'}</span>
                          </div>
                          <div className="col-span-2">
                            <span className="text-muted-foreground">Reason / note</span>{' '}
                            <span className="float-right font-medium text-muted-foreground">{o.errorMessage || '—'}</span>
                          </div>
                        </div>

                        <div className="border-t border-border pt-2">
                          <p className="text-xs font-medium text-muted-foreground mb-2">Lifecycle Timeline</p>
                          <div className="flex items-center gap-1 overflow-x-auto pb-1">
                            {timeline.map((stage, i) => (
                              <div key={stage.label} className="flex items-center">
                                <div className="flex flex-col items-center min-w-[64px]">
                                  <div
                                    className={cn(
                                      'h-2.5 w-2.5 rounded-full border-2',
                                      stage.done
                                        ? 'bg-primary border-primary'
                                        : 'bg-muted border-border',
                                    )}
                                  />
                                  <span className="text-[10px] mt-1 text-center leading-tight text-muted-foreground">
                                    {stage.label}
                                  </span>
                                  <span className="text-[9px] tabular-nums text-muted-foreground/60">
                                    {stage.time !== '—' ? stage.time.split(' ').slice(-1)[0] || stage.time : '—'}
                                  </span>
                                </div>
                                {i < timeline.length - 1 && (
                                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40 -mx-1" />
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <Dialog open={!!modifyOrder} onOpenChange={(open) => { if (!open) setModifyOrder(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {modifyOrder?.transactionType === 'SELL' ? 'Re-Order' : 'Modify Order'} — {modifyOrder?.symbol}
            </DialogTitle>
          </DialogHeader>
          {modifyOrder && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <Badge variant={modifyOrder.transactionType === 'BUY' ? 'default' : 'destructive'}>
                  {modifyOrder.transactionType}
                </Badge>
                <Badge variant="outline">{modifyOrder.product}</Badge>
                <Badge variant="secondary">{modifyOrder.orderType}</Badge>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Quantity</label>
                <Input
                  type="number"
                  value={modifyQty}
                  onChange={(e) => setModifyQty(e.target.value)}
                  className="mt-1"
                />
              </div>
              {modifyOrder.orderType !== 'MKT' && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Limit Price</label>
                  <Input
                    type="number"
                    value={modifyPrice}
                    onChange={(e) => setModifyPrice(e.target.value)}
                    className="mt-1"
                  />
                </div>
              )}
              {(modifyOrder.orderType === 'SL' || modifyOrder.orderType === 'SL-M') && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Trigger Price</label>
                  <Input
                    type="number"
                    value={modifyTrigger}
                    onChange={(e) => setModifyTrigger(e.target.value)}
                    className="mt-1"
                  />
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Estimated value: <span className="font-medium">{(Number(modifyQty || 0) * Number(modifyPrice || modifyOrder.price || 0)).toFixed(2)}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setModifyOrder(null)}>Cancel</Button>
            <Button onClick={handleModifySubmit}>
              {modifyOrder?.transactionType === 'SELL' ? 'Place Sell Order' : 'Modify Order'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelConfirm} onOpenChange={(open) => { if (!open) setCancelConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Order</DialogTitle>
          </DialogHeader>
          {cancelConfirm && (
            <div className="space-y-2 py-2 text-sm">
              <p>
                Are you sure you want to cancel the order for{' '}
                <span className="font-semibold">{cancelConfirm.symbol}</span>?
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <span>Order ID: <span className="font-mono">{cancelConfirm.orderId}</span></span>
                <span>Qty: {cancelConfirm.quantity}</span>
                <span>Price: {cancelConfirm.price || 'MKT'}</span>
                <span>Side: {cancelConfirm.transactionType}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelConfirm(null)}>Keep Order</Button>
            <Button variant="destructive" onClick={handleCancelOrder}>Confirm Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DummyThemedPage>
  );
}
