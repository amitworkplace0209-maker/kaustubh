'use client';

/**
 * Canonical order table — one shape for Kotak, Shoonya and Dummy.
 *
 * The status column is the point of this component: a working order reads
 * "pending / working", an executed order reads "executed", and the two are
 * never conflated. Cancel is offered only while the broker still owes a fill,
 * because a cancel request on a terminal order is meaningless.
 */
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CanonicalOrder } from '@/lib/api';
import {
  STATUS_LABEL,
  TONE_CLASS,
  canCancel,
  fmtNum,
  fmtTime,
  statusTone,
  workingReason,
} from './status';

export function OrderTable({
  orders,
  ltp,
  onCancel,
  busyOrderId,
  emptyMessage = 'No orders (honest zero).',
}: {
  orders: CanonicalOrder[];
  ltp?: Record<string, number>;
  onCancel?: (order: CanonicalOrder) => void;
  busyOrderId?: string | null;
  emptyMessage?: string;
}) {
  if (orders.length === 0) {
    return (
      <Card className="shadow-soft">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-soft">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">Orders ({orders.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-2">Order</th>
                <th className="pb-2">Instrument</th>
                <th className="pb-2">Side</th>
                <th className="pb-2">Type</th>
                <th className="pb-2 text-right">Qty</th>
                <th className="pb-2 text-right">Filled</th>
                <th className="pb-2 text-right">Price</th>
                <th className="pb-2 text-right">Avg</th>
                <th className="pb-2 text-right">LTP</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Source</th>
                <th className="pb-2 text-right">Placed</th>
                <th className="pb-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const live = ltp?.[order.symbol?.toUpperCase()];
                const tone = statusTone(order.status);
                const cancellable = onCancel ? canCancel(order) : false;
                return (
                  <tr key={order.orderId} className="border-t border-white/5 align-top">
                    <td className="py-2 font-mono text-[10px]">{order.orderId || '\u2014'}</td>
                    <td className="py-2 font-medium">{order.symbol || '\u2014'}</td>
                    <td
                      className={
                        order.side === 'SELL'
                          ? 'py-2 text-rose-300'
                          : order.side === 'BUY'
                            ? 'py-2 text-emerald-300'
                            : 'py-2'
                      }
                    >
                      {order.side || '\u2014'}
                    </td>
                    <td className="py-2">
                      {order.orderType || '\u2014'}
                      <span className="block text-[10px] text-muted-foreground">
                        {order.product || ''}
                      </span>
                    </td>
                    <td className="py-2 text-right font-mono">{fmtNum(order.quantity, 0)}</td>
                    <td className="py-2 text-right font-mono">
                      {fmtNum(order.filledQuantity, 0)}
                      {order.pendingQuantity > 0 && (
                        <span className="block text-[10px] text-muted-foreground">
                          {fmtNum(order.pendingQuantity, 0)} left
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {order.orderType === 'MKT' ? 'MARKET' : fmtNum(order.price)}
                      {order.triggerPrice > 0 && (
                        <span className="block text-[10px] text-muted-foreground">
                          trig {fmtNum(order.triggerPrice)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono">{fmtNum(order.averagePrice)}</td>
                    <td className="py-2 text-right font-mono text-muted-foreground">
                      {live != null ? fmtNum(live) : '\u2014'}
                    </td>
                    <td className="py-2">
                      <Badge variant="outline" className={TONE_CLASS[tone]}>
                        {STATUS_LABEL[order.status] ?? order.status}
                      </Badge>
                      <span className="mt-1 block max-w-[220px] text-[10px] leading-tight text-muted-foreground">
                        {workingReason(order)}
                      </span>
                      {order.rawStatus && order.rawStatus !== order.status && (
                        <span className="block text-[10px] text-muted-foreground/70">
                          broker: {order.rawStatus}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-[10px] text-muted-foreground">
                      {order.source || '\u2014'}
                      {order.isPaper && (
                        <span className="block text-[10px] text-muted-foreground/70">paper</span>
                      )}
                    </td>
                    <td className="py-2 text-right text-[10px] text-muted-foreground">
                      {fmtTime(order.placedAt)}
                    </td>
                    <td className="py-2 text-right">
                      {onCancel && cancellable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-rose-300 hover:text-rose-200"
                          disabled={busyOrderId === order.orderId}
                          onClick={() => onCancel(order)}
                        >
                          <X className="mr-1 h-3 w-3" />
                          Cancel
                        </Button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/60">\u2014</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}