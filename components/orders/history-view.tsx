'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  History, Download, RefreshCw, Search, Trash2, ChevronDown, ChevronUp,
  Package, Filter, X, Calendar,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  getBaskets,
  type Basket,
} from '@/lib/api';
import { TradingService } from '@/lib/trading-service';
import { normalizeExecution } from '@/lib/charge-engine';
import { getChargeSnapshotStore } from '@/lib/charge-snapshot-store';
import { useToast } from '@/hooks/use-toast';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';
import {
  getRealtimeConnectionState, subscribeRealtime,
} from '@/lib/realtime-store';

type HistoryTab = 'trade' | 'basket';

type Props = {
  initialTab?: HistoryTab;
};

function formatINR(val: number): string {
  if (!Number.isFinite(val)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

const STATUS_COLORS: Record<string, string> = {
  complete: 'bg-success/15 text-success border-success/30',
  filled: 'bg-success/15 text-success border-success/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
  cancelled: 'bg-muted/20 text-muted-foreground border-muted/30',
  pending: 'bg-warning/15 text-warning border-warning/30',
  open: 'bg-warning/15 text-warning border-warning/30',
  trigger_pending: 'bg-warning/15 text-warning border-warning/30',
};

const BASKET_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-muted/20 text-muted-foreground',
  executed: 'bg-success/15 text-success',
  partially_executed: 'bg-warning/15 text-warning',
  failed: 'bg-destructive/15 text-destructive',
};

type QuickFilter = 'today' | 'yesterday' | '7d' | '30d' | 'all';

const QUICK_FILTERS: { value: QuickFilter; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: 'all', label: 'All' },
];

function getDateRange(filter: QuickFilter): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);

  switch (filter) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - 1);
      end.setHours(23, 59, 59, 999);
      break;
    case '7d':
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      start.setHours(0, 0, 0, 0);
      break;
    case 'all':
    default:
      start.setFullYear(2020);
      break;
  }
  return { start, end };
}

export default function HistoryView({ initialTab = 'trade' }: Props) {
  const [activeTab, setActiveTab] = useState<HistoryTab>(initialTab);
  const [orders, setOrders] = useState<any[]>([]);
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [expandedBasketId, setExpandedBasketId] = useState<string | null>(null);
  const { toast: _toast } = useToast();

  const fetchTradeHistory = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await TradingService.getOrderHistory();
      const list: any[] = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
      setOrders(list);

      // Record charge snapshots
      try {
        const executions = list
          .map((r) => normalizeExecution(r))
          .filter((e): e is NonNullable<typeof e> => e != null);
        if (executions.length > 0) {
          getChargeSnapshotStore().recordFromExecutions(executions);
        }
      } catch { /* snapshot recording is best-effort */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order history');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchBasketHistory = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getBaskets();
      setBaskets(data.baskets || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'trade') fetchTradeHistory();
    else fetchBasketHistory();
  }, [activeTab, fetchTradeHistory, fetchBasketHistory]);

  // ── Socket-aware refresh ────────────────────────────────────────
  // The `orders` WS document is re-pushed ONLY when the book actually changes
  // (signature-fingerprinted), so its revisions are the change signal: a fill
  // or a status flip refreshes the dated history with no timer involved. The
  // socket connection state drives the poll — fast 15 s cadence ONLY while the
  // socket is down (then REST is the only carrier).
  const { updatedAt: ordersDocAt } = useRealtimeChannel<Record<string, unknown>>('orders', {});
  const [socketUp, setSocketUp] = useState(() =>
    typeof window === 'undefined' ? false : getRealtimeConnectionState() === 'CONNECTED',
  );
  useEffect(() => (
    subscribeRealtime(() => setSocketUp(getRealtimeConnectionState() === 'CONNECTED'))
  ), []);

  const docAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeTab !== 'trade' || ordersDocAt == null) return;
    const first = docAtRef.current == null;
    const changed = docAtRef.current != null && docAtRef.current !== ordersDocAt;
    docAtRef.current = ordersDocAt;
    if (!first && changed) fetchTradeHistory();
  }, [ordersDocAt, activeTab, fetchTradeHistory]);

  // Auto-refresh trade history — fallback only.
  useEffect(() => {
    if (activeTab !== 'trade' || socketUp) return;
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchTradeHistory();
    }, 15000);
    return () => clearInterval(interval);
  }, [activeTab, socketUp, fetchTradeHistory]);

  // Filtered orders
  const filteredOrders = useMemo(() => {
    let filtered = orders;

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter((o) => o?.status === statusFilter);
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((o) => {
        const symbol = (o?.trading_symbol || o?.symbol || '').toLowerCase();
        const orderId = (o?.n_ord_no || o?.order_id || '').toLowerCase();
        return symbol.includes(q) || orderId.includes(q);
      });
    }

    // Date filter
    if (quickFilter !== 'all') {
      const { start, end } = getDateRange(quickFilter);
      filtered = filtered.filter((o) => {
        const dateStr = o?.order_date || o?.ts;
        if (!dateStr) return true;
        try {
          const d = new Date(dateStr);
          return d >= start && d <= end;
        } catch {
          return true;
        }
      });
    }

    return filtered;
  }, [orders, statusFilter, searchQuery, quickFilter]);

  // Filtered baskets
  const filteredBaskets = useMemo(() => {
    let filtered = baskets;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((b) => (b.name || '').toLowerCase().includes(q));
    }
    return filtered;
  }, [baskets, searchQuery]);

  const handleDownloadCSV = () => {
    const headers = ['Order ID', 'Symbol', 'Side', 'Product', 'Type', 'Qty', 'Filled', 'Price', 'Avg Price', 'Status', 'Date'];
    const rows = filteredOrders.map((o) => [
      o?.n_ord_no ?? o?.order_id ?? '', o?.trading_symbol ?? o?.symbol ?? '',
      o?.transaction_type ?? '', o?.product ?? '', o?.order_type ?? '',
      o?.quantity ?? '', o?.filled_quantity ?? o?.unfilled_quantity ?? '',
      o?.price ?? '', o?.average_traded_price ?? '',
      o?.status ?? '', o?.order_date ?? o?.ts ?? '',
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `order_history_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Tab Header */}
      <div className="flex items-center gap-1 p-1 rounded-xl bg-muted/50 border border-border/20 w-fit">
        <button
          onClick={() => setActiveTab('trade')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all',
            activeTab === 'trade'
              ? 'bg-teal/15 text-teal shadow-sm'
              : 'text-muted-foreground hover:text-foreground/80'
          )}
        >
          <History className="h-3.5 w-3.5" />
          Trade History
        </button>
        <button
          onClick={() => setActiveTab('basket')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all',
            activeTab === 'basket'
              ? 'bg-purple/15 text-purple shadow-sm'
              : 'text-muted-foreground hover:text-foreground/80'
          )}
        >
          <Package className="h-3.5 w-3.5" />
          Basket History
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={activeTab === 'trade' ? 'Search symbol or order ID...' : 'Search basket name...'}
            className="pl-9 pr-8 h-9 text-xs rounded-lg bg-muted/50 border-border/30"
          />
          {searchQuery && (
            <button
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground/80"
              onClick={() => setSearchQuery('')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {activeTab === 'trade' && (
          <>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-32 h-9 text-xs rounded-lg bg-muted/50 border-border/30">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="COMPLETE">Complete</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="OPEN">Open</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-muted/40 border border-border/20">
              {QUICK_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setQuickFilter(f.value)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all',
                    quickFilter === f.value
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground/80'
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="flex items-center gap-1.5 ml-auto">
          <Button
            size="sm"
            variant="ghost"
            className="h-9 w-9 p-0 rounded-lg"
            onClick={() => activeTab === 'trade' ? fetchTradeHistory() : fetchBasketHistory()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          {activeTab === 'trade' && (
            <Button size="sm" variant="outline" className="h-9 text-xs rounded-lg" onClick={handleDownloadCSV}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export
            </Button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-3 text-xs text-destructive font-medium">
          {error}
        </div>
      )}

      {/* ═══ Trade History ═══ */}
      {activeTab === 'trade' && (
        <div className="space-y-2">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border/20 bg-muted/40 p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="h-4 w-16 bg-muted/60 animate-pulse rounded" />
                    <div className="h-4 w-20 bg-muted/60 animate-pulse rounded" />
                    <div className="h-4 w-12 bg-muted/60 animate-pulse rounded ml-auto" />
                  </div>
                  <div className="h-3 w-40 bg-muted/60 animate-pulse rounded" />
                </div>
              ))}
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-center">
              <History className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No orders found</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Try adjusting your filters</p>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block border border-border/20 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/20 bg-muted/50 text-[10px] text-muted-foreground uppercase tracking-wider">
                        <th className="p-3 text-left font-semibold">Order ID</th>
                        <th className="p-3 text-left font-semibold">Symbol</th>
                        <th className="p-3 text-center font-semibold">Side</th>
                        <th className="p-3 text-center font-semibold">Prod</th>
                        <th className="p-3 text-center font-semibold">Type</th>
                        <th className="p-3 text-center font-semibold">Qty</th>
                        <th className="p-3 text-right font-semibold">Price</th>
                        <th className="p-3 text-center font-semibold">Status</th>
                        <th className="p-3 text-right font-semibold">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOrders.map((o, i) => {
                        const orderId = o?.n_ord_no || o?.order_id || '';
                        const isExpanded = expandedOrderId === orderId;
                        return (
                          <TradeRow key={orderId || i} order={o} expanded={isExpanded}
                            onToggle={() => setExpandedOrderId(isExpanded ? null : orderId)} />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden space-y-2">
                {filteredOrders.map((o, i) => {
                  const orderId = o?.n_ord_no || o?.order_id || '';
                  return (
                    <TradeCard key={orderId || i} order={o} />
                  );
                })}
              </div>

              <div className="text-[11px] text-muted-foreground/70 text-right font-medium">
                {filteredOrders.length} order{filteredOrders.length !== 1 ? 's' : ''}
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══ Basket History ═══ */}
      {activeTab === 'basket' && (
        <div className="space-y-2">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border/20 bg-muted/40 p-4 space-y-2">
                  <div className="h-4 w-32 bg-muted/60 animate-pulse rounded" />
                  <div className="h-3 w-48 bg-muted/60 animate-pulse rounded" />
                </div>
              ))}
            </div>
          ) : filteredBaskets.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-center">
              <Package className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No baskets found</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Create a basket in the Basket tab</p>
            </div>
          ) : (
            filteredBaskets.map((basket) => (
              <BasketHistoryCard
                key={basket._id}
                basket={basket}
                expanded={expandedBasketId === basket._id}
                onToggle={() => setExpandedBasketId(expandedBasketId === basket._id ? null : basket._id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TradeRow({ order: o, expanded, onToggle }: { order: any; expanded: boolean; onToggle: () => void }) {
  const statusKey = (o?.status || '').toLowerCase();
  const statusColor = STATUS_COLORS[statusKey] || 'bg-muted/20 text-muted-foreground';
  const orderId = o?.n_ord_no || o?.order_id || '';

  return (
    <>
      <tr
        className="border-b border-border/10 hover:bg-muted/40 transition-colors cursor-pointer"
        onClick={onToggle}
      >
        <td className="p-3 font-mono text-muted-foreground">{orderId || '—'}</td>
        <td className="p-3 font-semibold">{o?.trading_symbol || o?.symbol || '—'}</td>
        <td className="p-3 text-center">
          <Badge variant="outline" className={cn(
            'text-[9px] px-1.5 py-0 h-4 border-0 font-bold',
            o?.transaction_type === 'BUY' ? 'text-success' : 'text-destructive'
          )}>
            {o?.transaction_type || '—'}
          </Badge>
        </td>
        <td className="p-3 text-center text-muted-foreground font-mono">{o?.product || '—'}</td>
        <td className="p-3 text-center text-muted-foreground">{o?.order_type || '—'}</td>
        <td className="p-3 text-center font-mono font-semibold">{o?.quantity || '—'}</td>
        <td className="p-3 text-right font-mono font-semibold">{o?.price || '—'}</td>
        <td className="p-3 text-center">
          <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0 h-4 border-0 font-semibold', statusColor)}>
            {o?.status || '—'}
          </Badge>
        </td>
        <td className="p-3 text-right text-muted-foreground font-mono">{o?.order_date || o?.ts || '—'}</td>
      </tr>
      {expanded && (
        <tr className="bg-muted/40">
          <td colSpan={9} className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <DetailItem label="Avg Price" value={o?.average_traded_price || '—'} />
              <DetailItem label="Filled Qty" value={o?.filled_quantity || '—'} />
              <DetailItem label="Unfilled" value={o?.unfilled_quantity || '—'} />
              <DetailItem label="Trigger" value={o?.trigger_price || '—'} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TradeCard({ order: o }: { order: any }) {
  const statusKey = (o?.status || '').toLowerCase();
  const statusColor = STATUS_COLORS[statusKey] || 'bg-muted/20 text-muted-foreground';

  return (
    <div className="rounded-xl border border-border/20 bg-muted/40 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn(
            'text-[9px] px-1.5 py-0 h-4 border-0 font-bold',
            o?.transaction_type === 'BUY' ? 'text-success' : 'text-destructive'
          )}>
            {o?.transaction_type}
          </Badge>
          <span className="text-sm font-semibold">{o?.trading_symbol || o?.symbol}</span>
        </div>
        <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0 h-4 border-0 font-semibold', statusColor)}>
          {o?.status}
        </Badge>
      </div>
      <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
        <span>Qty: <span className="font-mono font-semibold text-foreground/80">{o?.quantity}</span></span>
        <span>Price: <span className="font-mono font-semibold text-foreground/80">{o?.price}</span></span>
        <span className="font-mono text-[10px]">{o?.order_date || '—'}</span>
      </div>
      <div className="mt-1.5 text-[10px] font-mono text-muted-foreground/70">ID: {o?.n_ord_no || o?.order_id || '—'}</div>
    </div>
  );
}

function BasketHistoryCard({ basket, expanded, onToggle }: { basket: Basket; expanded: boolean; onToggle: () => void }) {
  const orders = basket.orders || [];
  const executedCount = orders.filter((o) => o.status === 'executed' || o.status === 'success').length;
  const failedCount = orders.filter((o) => o.status === 'failed').length;
  const statusKey = (basket.status || 'draft').toLowerCase().replace(/\s+/g, '_');
  const statusColor = BASKET_STATUS_COLORS[statusKey] || BASKET_STATUS_COLORS.draft;

  let totalValue = 0;
  for (const o of orders) {
    totalValue += (parseInt(o.quantity) || 0) * (parseFloat(o.price) || 0);
  }

  return (
    <div className={cn(
      'rounded-xl border overflow-hidden transition-all cursor-pointer',
      expanded ? 'border-purple/30 bg-card/80' : 'border-border/20 bg-muted/40 hover:border-border/40',
    )} onClick={onToggle}>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{basket.name}</span>
              <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0 h-4 border-0 font-semibold', statusColor)}>
                {(basket.status || 'DRAFT').toUpperCase()}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
              <span>{orders.length} orders</span>
              <span>{formatINR(totalValue)}</span>
              {executedCount > 0 && <span className="text-success">{executedCount} done</span>}
              {failedCount > 0 && <span className="text-destructive">{failedCount} failed</span>}
            </div>
          </div>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-2 border-t border-border/20 pt-3">
          {orders.map((order, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-border/20 text-xs">
              <span className="font-mono text-muted-foreground w-5 text-right">{i + 1}</span>
              <Badge variant="outline" className={cn(
                'text-[9px] px-1.5 py-0 h-3.5 border-0 font-bold',
                order.transactionType === 'BUY' ? 'text-success' : 'text-destructive'
              )}>
                {order.transactionType}
              </Badge>
              <span className="font-semibold">{order.symbol}</span>
              <span className="text-muted-foreground">{order.product}</span>
              <span className="font-mono text-muted-foreground">×{order.quantity}</span>
              {order.orderId && <span className="font-mono text-muted-foreground/70 ml-auto text-[10px]">{order.orderId}</span>}
              <span className={cn('font-semibold text-[10px]', order.status === 'executed' ? 'text-success' : order.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                {order.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground/70 font-medium uppercase tracking-wider">{label}</div>
      <div className="text-xs font-mono font-semibold mt-0.5">{value}</div>
    </div>
  );
}
