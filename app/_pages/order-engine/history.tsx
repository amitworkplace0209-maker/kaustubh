'use client';

/**
 * SERVICES -> Order Engine -> History
 *
 * Executed-order history with filters. Every row is canonical, so history reads
 * the same whether it came from Kotak, Shoonya or the paper terminal.
 *
 * No background polling — mount-only fetch + manual refresh, so the page never
 * freezes on auto-refresh intervals or WebSocket subscriptions.
 */
import { useEffect, useMemo, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { OrderTable } from '@/components/order-engine/order-table';
import { isWorking } from '@/components/order-engine/status';
import { getOrderEngineHistory, type CanonicalOrder } from '@/lib/api';

const STATUS_FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'WORKING', label: 'Working' },
  { id: 'COMPLETE', label: 'Executed' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: 'REJECTED', label: 'Rejected' },
] as const;

const SIDES = ['ALL', 'BUY', 'SELL'] as const;

export default function OrderEngineHistoryPage() {
  const [rows, setRows] = useState<CanonicalOrder[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]['id']>('ALL');
  const [side, setSide] = useState<(typeof SIDES)[number]>('ALL');
  const [source, setSource] = useState('ALL');
  const [basket, setBasket] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await getOrderEngineHistory();
      setRows(res.orders ?? []);
      setError('');
    } catch (exc: any) {
      setError(exc?.message ?? String(exc));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const sources = useMemo(
    () => ['ALL', ...Array.from(new Set(rows.map((r) => r.source).filter(Boolean))).sort()],
    [rows],
  );

  const visible = useMemo(() => {
    const term = search.trim().toUpperCase();
    return rows.filter((order) => {
      if (status === 'WORKING' && !(isWorking(order.status) || order.status === 'PARTIALLY_FILLED')) {
        return false;
      }
      if (status !== 'ALL' && status !== 'WORKING' && order.status !== status) return false;
      if (side !== 'ALL' && order.side !== side) return false;
      if (source !== 'ALL' && order.source !== source) return false;
      if (basket.trim() && !String(order.basketId ?? '').toUpperCase().includes(basket.trim().toUpperCase())) {
        return false;
      }
      if (from && (order.placedAt ?? '') < new Date(from).toISOString()) return false;
      if (to && (order.placedAt ?? '') > new Date(`${to}T23:59:59`).toISOString()) return false;
      if (!term) return true;
      return (
        order.orderId?.toUpperCase().includes(term) ||
        order.symbol?.toUpperCase().includes(term) ||
        String(order.basketId ?? '').toUpperCase().includes(basket.trim().toUpperCase()) ||
        String(order.correlationId ?? '').toUpperCase().includes(term)
      );
    });
  }, [rows, status, side, source, basket, from, to, search]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <History className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Order Engine · History</h1>
            <p className="text-xs text-muted-foreground">
              Executed-order history across every terminal
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      <Card className="shadow-soft">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setStatus(f.id)}
                className={`rounded px-2 py-1 text-[11px] transition ${
                  status === f.id ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-white/5'
                }`}
              >
                {f.label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-white/10" />
            {SIDES.map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`rounded px-2 py-1 text-[11px] transition ${
                  side === s ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-white/5'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Source
            </label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="rounded-lg border border-input bg-background px-2 py-1 text-xs"
            >
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Basket ID
            </label>
            <Input
              value={basket}
              onChange={(e) => setBasket(e.target.value)}
              placeholder="basket id…"
              className="rounded-lg border border-input bg-background px-2 py-1 text-xs w-32"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              From date
            </label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-input bg-background px-2 py-1 text-xs w-32"
            />
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              To date
            </label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-input bg-background px-2 py-1 text-xs w-32"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Search
            </label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="order id / symbol / basket / correlation…"
              className="rounded-lg border border-input bg-background px-2 py-1 text-xs w-64"
            />
          </div>
        </CardContent>
      </Card>

      <div className="rounded-xl border border-border/50 bg-muted/30 shadow-sm p-3">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-3">
          {visible.length} orders
        </p>
        <OrderTable
          orders={visible}
          busyOrderId={null}
          emptyMessage={
            loading ? 'Loading history…'
              : visible.length === 0
                ? 'No matching orders (honest zero).'
                : 'No orders available.'
          }
        />
      </div>
    </div>
  );
}
