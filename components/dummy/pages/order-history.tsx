'use client';

import { useMemo, useState } from 'react';
import { History, RefreshCw, Download, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MetricCard, StatusBadge, EmptyState, ErrorState } from '@/components/design-system';
import { useDummyState } from '@/hooks/use-dummy-state';
import { cancelDemoOrder } from '@/lib/api';
import { orderStatusTone, type DummyOrder } from '@/lib/dummy';
import { runDummyRetention } from '@/lib/dummy';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { formatISTDateTime } from '@/lib/ist';
import { istDateKey } from '@/lib/ist';

export default function DummyOrderHistory() {
  const { state, error, refresh } = useDummyState(5000);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [symbolFilter, setSymbolFilter] = useState('');
  const [retentionNote, setRetentionNote] = useState<string | null>(null);

  const orders = useMemo(() => {
    let list = state?.orders || [];
    if (statusFilter !== 'ALL') list = list.filter((o) => o.status === statusFilter);
    if (symbolFilter.trim()) list = list.filter((o) => o.symbol.toUpperCase().includes(symbolFilter.trim().toUpperCase()));
    return list;
  }, [state?.orders, statusFilter, symbolFilter]);

  const statuses = useMemo(() => {
    const s = new Set<string>();
    for (const o of state?.orders || []) s.add(o.status);
    return ['ALL', ...Array.from(s)];
  }, [state?.orders]);

  const downloadCsv = () => {
    const rows = orders;
    const header = 'orderId,symbol,transactionType,product,orderType,quantity,price,triggerPrice,status,averageTradedPrice,orderDate,errorMessage';
    const lines = rows.map((o: DummyOrder) =>
      [o.orderId, o.symbol, o.transactionType, o.product, o.orderType, o.quantity, o.price, o.triggerPrice, o.status, o.averageTradedPrice, o.orderDate, o.errorMessage ?? '']
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dummy-orders-${istDateKey()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runRetention = async () => {
    setRetentionNote(null);
    try {
      const res = await runDummyRetention(7);
      setRetentionNote(`Retention ran: ${res.purged} order(s) older than 7 days purged.`);
      void refresh();
    } catch (e) {
      setRetentionNote(e instanceof Error ? e.message : 'retention failed');
    }
  };

  if (error && !state) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void refresh()} /></DummyThemedPage>;
  }

  const complete = (state?.orders || []).filter((o) => o.status === 'COMPLETE').length;
  const cancelled = (state?.orders || []).filter((o) => o.status === 'CANCELLED').length;

  return (
    <DummyThemedPage>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Order History</h1>
          <DummyBadge />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void runRetention()}>
            <Filter className="h-4 w-4" /> 7-day retention
          </Button>
          <Button variant="outline" size="sm" onClick={downloadCsv}>
            <Download className="h-4 w-4" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {retentionNote && <p className="text-xs text-muted-foreground">{retentionNote}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MetricCard icon={History} title="Total orders" value={String(state?.orders.length ?? 0)} tone="neutral" />
        <MetricCard icon={History} title="Completed" value={String(complete)} tone="success" />
        <MetricCard icon={History} title="Cancelled" value={String(cancelled)} tone="warning" />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Orders</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="h-9 w-44" placeholder="Filter by symbol…" value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)} />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {statuses.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <EmptyState icon={History} title="No orders match" description="Try clearing the filters, or place a trade." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order ID</TableHead>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Avg fill</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Placed (IST)</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => (
                    <TableRow key={o.orderId}>
                      <TableCell className="font-mono text-xs">{o.orderId}</TableCell>
                      <TableCell className="font-medium">{o.symbol}</TableCell>
                      <TableCell className={o.transactionType === 'BUY' ? 'text-emerald-500' : 'text-red-500'}>
                        {o.transactionType}
                      </TableCell>
                      <TableCell>{o.orderType}</TableCell>
                      <TableCell>{o.product}</TableCell>
                      <TableCell className="text-right tabular-nums">{o.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">{o.price || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{o.averageTradedPrice || '—'}</TableCell>
                      <TableCell><StatusBadge status={orderStatusTone(o.status)} label={o.status} /></TableCell>
                      <TableCell className="tabular-nums">{formatISTDateTime(o.orderDate)}</TableCell>
                      <TableCell>
                        {['OPEN', 'TRIGGER_PENDING', 'PENDING'].includes(o.status) && (
                          <Button size="sm" variant="destructive" onClick={() => void cancelDemoOrder(o.orderId).then(() => refresh())}>
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </DummyThemedPage>
  );
}
