'use client';

/**
 * SERVICES -> Order Engine -> Orders
 *
 * The order lifecycle surface. Places an order through the Order Engine and
 * shows its state honestly: a working order reads PENDING / WORKING, never
 * "executed", and it only becomes executed when a real market price matched it.
 *
 * Placement is intentionally the only write here besides cancel/modify — the
 * engine is the single choke point, so this page cannot reach a broker by any
 * other route (docs/engines/order-engine.md §2, §54).
 */
import { useMemo, useState } from 'react';
import { Activity, ListOrdered, Play, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { MarketDataBanner } from '@/components/order-engine/market-data-banner';
import { OrderEngineTicket } from '@/components/order-engine/order-ticket';
import { OrderTable } from '@/components/order-engine/order-table';
import { StateMachinePanel } from '@/components/order-engine/state-machine-panel';
import { isWorking } from '@/components/order-engine/status';
import { useOrderEngineLive } from '@/components/order-engine/use-order-engine-live';

const FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'WORKING', label: 'Working' },
  { id: 'COMPLETE', label: 'Executed' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: 'REJECTED', label: 'Rejected' },
] as const;

type FilterId = (typeof FILTERS)[number]['id'];

export default function OrderEngineOrdersPage() {
  const engine = useOrderEngineLive();
  const [filter, setFilter] = useState<FilterId>('ALL');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  const visible = useMemo(() => {
    const term = search.trim().toUpperCase();
    return engine.orders.filter((order) => {
      if (filter === 'WORKING' && !isWorking(order.status) && order.status !== 'PARTIALLY_FILLED') {
        return false;
      }
      if (filter !== 'ALL' && filter !== 'WORKING' && order.status !== filter) return false;
      if (!term) return true;
      return (
        order.symbol?.toUpperCase().includes(term) ||
        order.orderId?.toUpperCase().includes(term) ||
        order.basketId?.toUpperCase().includes(term)
      );
    });
  }, [engine.orders, filter, search]);

  const submit = async (intent: Parameters<typeof engine.place>[0]) => {
    setBusy(true);
    try {
      return await engine.place(intent);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (orderId: string) => {
    setBusyOrderId(orderId);
    await engine.cancel(orderId);
    setBusyOrderId(null);
  };

  const modify = async (orderId: string, price: number) => {
    setBusyOrderId(orderId);
    await engine.modify(orderId, { price });
    setBusyOrderId(null);
  };

  const isPaper = engine.state?.isPaper ?? false;
  const showDummyConnect = isPaper && !(engine.state?.connected || engine.dummyConnected) && !engine.dummyConnecting;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ListOrdered className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Order Engine · Orders</h1>
            <p className="text-xs text-muted-foreground">
              Live order book · validate → risk → audit → broker
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={(engine.state?.connected || engine.dummyConnected) ? 'border-emerald-500/30 text-emerald-300' : 'border-rose-500/30 text-rose-300'}
          >
            {engine.state?.broker ?? '\u2014'} · {(engine.state?.connected || engine.dummyConnected) ? 'CONNECTED' : 'NOT CONNECTED'}
          </Badge>
          <Button size="sm" variant="outline" onClick={() => void engine.refresh()}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
          {showDummyConnect && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void engine.connectDummy()}
              className="bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20"
            >
              <Play className="mr-1 h-3 w-3" /> Connect Dummy
            </Button>
          )}
          {engine.dummyConnecting && (
            <Button size="sm" variant="outline" disabled className="opacity-50">
              <Activity className="mr-1 h-3 w-3 animate-spin" /> Connecting…
            </Button>
          )}
        </div>
      </div>

      {engine.error && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {engine.error}
        </div>
      )}

      <MarketDataBanner marketData={engine.marketData} isPaper={isPaper} />

      <div className="grid gap-3 lg:grid-cols-4">
        <div className="lg:col-span-1">
          <OrderEngineTicket engine={engine} busy={busy} onSubmit={submit} />
        </div>

        <div className="space-y-3 lg:col-span-3">
          <StateMachinePanel counts={engine.counts} total={engine.counts.TOTAL ?? 0} />

          <Card className="shadow-soft">
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
              <div className="flex flex-wrap items-center gap-1">
                {FILTERS.map((f) => {
                  const count =
                    f.id === 'ALL'
                      ? engine.counts.TOTAL ?? 0
                      : f.id === 'WORKING'
                        ? engine.counts.WORKING ?? 0
                        : engine.counts[f.id] ?? 0;
                  return (
                    <button
                      key={f.id}
                      onClick={() => setFilter(f.id)}
                      className={`rounded px-2 py-1 text-[11px] transition ${
                        filter === f.id
                          ? 'bg-primary/20 text-primary'
                          : 'text-muted-foreground hover:bg-white/5'
                      }`}
                    >
                      {f.label}
                      <span className="ml-1 font-mono opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search symbol / order id…"
                className="h-8 w-full text-xs sm:w-56"
              />
            </CardHeader>
            <CardContent className="pt-0">
              <OrderTable
                orders={visible}
                ltp={engine.ltp}
                busyOrderId={busyOrderId}
                onCancel={(o) => void cancel(o.orderId)}
                emptyMessage={
                  engine.loading
                    ? 'Loading order book…'
                    : engine.orders.length > 0
                      ? 'No orders match this filter.'
                      : engine.state?.connected
                        ? 'No orders on this terminal yet (honest zero).'
                        : `${engine.state?.broker ?? 'Terminal'} is not connected — no order book available.`
                }
              />
            </CardContent>
          </Card>

          <ModifyPanel onModify={modify} busy={busyOrderId !== null} />
        </div>
      </div>
    </div>
  );
}

/** Modify a working order's limit/trigger price through the engine's risk gate. */
function ModifyPanel({
  onModify,
  busy,
}: {
  onModify: (orderId: string, price: number) => Promise<unknown>;
  busy: boolean;
}) {
  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Modify a working order</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Repicing a resting order goes through the engine&rsquo;s risk gate, so a modification that
          would leave the order invalid is refused before it reaches the broker.
        </p>
        <ModifyForm onModify={onModify} busy={busy} />
      </CardContent>
    </Card>
  );
}

function ModifyForm({
  onModify,
  busy,
}: {
  onModify: (orderId: string, price: number) => Promise<unknown>;
  busy: boolean;
}) {
  const [orderId, setOrderId] = useState('');
  const [price, setPrice] = useState('');

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!orderId.trim() || !(Number(price) > 0)) return;
        await onModify(orderId.trim(), Number(price));
        setPrice('');
      }}
    >
      <div className="min-w-[180px] flex-1 space-y-1">
        <label className="text-[11px] text-muted-foreground">Order id</label>
        <Input
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder="Working order id"
          className="h-9 text-xs"
        />
      </div>
      <div className="w-32 space-y-1">
        <label className="text-[11px] text-muted-foreground">New price</label>
        <Input
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0.00"
          className="h-9 text-xs"
          inputMode="decimal"
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={busy || !orderId.trim() || !(Number(price) > 0)}
      >
        Modify
      </Button>
    </form>
  );
}