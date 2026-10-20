'use client';

import { useEffect, useState, useCallback } from 'react';
import { History, RefreshCw, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { getOrderHistory } from '@/lib/api';

export default function OrderHistoryPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');

  const fetch = useCallback(async () => {
    try {
      const data = await getOrderHistory('orders', '');
      const list = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
      setOrders(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [fetch]);

  const filtered = orders.filter((o) => {
    if (statusFilter !== 'all' && o?.status !== statusFilter) return false;
    if (dateFilter !== 'all') {
      const orderDate = o?.order_date ?? o?.ts ?? '';
      if (dateFilter === 'today' && !new Date(orderDate).toDateString().match(new Date().toDateString())) return false;
    }
    return true;
  });

  const handleDownload = () => {
    const headers = ['Order ID', 'Symbol', 'Type', 'Product', 'Quantity', 'Price', 'Status', 'Date'];
    const rows = filtered.map((o) => [
      o?.n_ord_no ?? o?.order_id ?? '',
      o?.trading_symbol ?? o?.symbol ?? '',
      o?.transaction_type ?? '',
      o?.product ?? '',
      o?.quantity ?? '',
      o?.price ?? '',
      o?.status ?? '',
      o?.order_date ?? o?.ts ?? '',
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Order History</h1>
          <p className="text-sm text-muted-foreground">Today&apos;s and past orders</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handleDownload}>
            <Download className="h-4 w-4 mr-2" /> Download
          </Button>
          <Button size="sm" variant="ghost" onClick={fetch}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="complete">Complete</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
        <Select value={dateFilter} onValueChange={setDateFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Date" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Dates</SelectItem>
            <SelectItem value="today">Today</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="shadow-soft">
        <CardHeader>
          <CardTitle className="text-base">Orders ({filtered.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  <th className="p-3 text-left font-medium">Order ID</th>
                  <th className="p-3 text-left font-medium">Symbol</th>
                  <th className="p-3 text-left font-medium">Type</th>
                  <th className="p-3 text-left font-medium">Product</th>
                  <th className="p-3 text-right font-medium">Qty</th>
                  <th className="p-3 text-right font-medium">Price</th>
                  <th className="p-3 text-left font-medium">Status</th>
                  <th className="p-3 text-left font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">Loading...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">No orders found</td></tr>
                ) : (
                  filtered.map((o, i) => (
                    <tr key={i} className="border-b hover:bg-muted/50 transition-colors text-sm">
                      <td className="p-3 text-muted-foreground">{o?.n_ord_no ?? o?.order_id ?? '—'}</td>
                      <td className="p-3 font-medium">{o?.trading_symbol ?? o?.symbol ?? '—'}</td>
                      <td className="p-3">
                        <Badge variant={o?.transaction_type === 'BUY' ? 'default' : 'destructive'} className={o?.transaction_type === 'BUY' ? 'bg-success text-success-foreground' : ''}>
                          {o?.transaction_type ?? '—'}
                        </Badge>
                      </td>
                      <td className="p-3 text-muted-foreground">{o?.product ?? '—'}</td>
                      <td className="p-3 text-right">{o?.quantity ?? '—'}</td>
                      <td className="p-3 text-right">{o?.price ?? '—'}</td>
                      <td className="p-3">
                        <Badge variant={o?.status === 'complete' ? 'default' : o?.status === 'rejected' ? 'destructive' : 'secondary'}
                          className={o?.status === 'complete' ? 'bg-success text-success-foreground' : ''}>
                          {o?.status ?? '—'}
                        </Badge>
                      </td>
                      <td className="p-3 text-muted-foreground text-xs">{o?.order_date ?? o?.ts ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
