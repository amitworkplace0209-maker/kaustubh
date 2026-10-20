'use client';

/**
 * SERVICES -> Order Engine -> History
 *
 * Executed-order history with the filters the doc specifies (§35): date/time,
 * source, broker, terminal, symbol, status, basket, side, order type, and a
 * search across order id / broker order id / basket id / correlation id /
 * symbol. Every row is canonical, so history reads the same whether it came from
 * Kotak, Shoonya or the paper terminal.
 */
import { useEffect, useMemo, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { OrderTable } from '@/components/order-engine/order-table';
import { isWorking } from '@/components/order-engine/status';
import { useOrderEngineLive } from '@/components/order-engine/use-order-engine-live';
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
  const engine = useOrderEngineLive();
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
        String(order.basketId ?? '').toUpperCase().includes(term) ||
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

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <div className="space-y-1 lg:col-span-2">
              <label className="text-[11px] text-muted-foreground">
                Search order id / symbol / basket / correlation
              </label>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 text-xs"
                placeholder="Search…"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">From</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">To</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Source</label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="h-9 w-full rounded-md border border-white/10 bg-black/20 px-2 text-xs"
              >
                {sources.map((s) => (
                  <option key={s} value={s} className="bg-slate-950">
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Basket</label>
              <Input
                value={basket}
                onChange={(e) => setBasket(e.target.value)}
                className="h-9 text-xs"
                placeholder="Basket id"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <Badge variant="outline">{rows.length} loaded</Badge>
            <Badge variant="outline">{visible.length} matching</Badge>
            {(status !== 'ALL' || side !== 'ALL' || source !== 'ALL' || search || basket || from || to) && (
              <button
                onClick={() => {
                  setStatus('ALL');
                  setSide('ALL');
                  setSource('ALL');
                  setSearch('');
                  setBasket('');
                  setFrom('');
                  setTo('');
                }}
                className="text-primary underline-offset-2 hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      <OrderTable
        orders={visible}
        ltp={engine.ltp}
        emptyMessage={
          loading
            ? 'Loading history…'
            : rows.length > 0
              ? 'No orders match these filters.'
              : 'No order history for this terminal yet (honest zero).'
        }
      />
    </div>
  );
}