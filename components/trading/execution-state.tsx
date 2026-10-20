'use client';

import { cn } from '@/lib/utils';
import { Loader2, CheckCircle, AlertCircle, XCircle, Clock, TrendingUp, TrendingDown, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/design-system';
import type { ExecState } from '@/components/orders/trade/types';

interface ExecutionStateProps {
  exec: ExecState;
  execId: number;
  terminal: string;
  symbol: string;
  realtimeOrder: Record<string, any> | null;
  onAck: () => void;
}

const statusConfig = {
  idle: { icon: null, label: '', tone: 'neutral' as const },
  submitting: { icon: Loader2, label: 'Submitting…', tone: 'info' as const },
  filled: { icon: CheckCircle, label: 'FILLED', tone: 'success' as const },
  pending: { icon: Clock, label: 'PENDING', tone: 'warning' as const },
  failed: { icon: XCircle, label: 'FAILED', tone: 'danger' as const },
};

export function ExecutionState({ exec, execId, terminal, symbol, realtimeOrder, onAck }: ExecutionStateProps) {
  const cfg = statusConfig[exec.phase];
  if (exec.phase === 'idle') return null;

  const isPending = exec.phase === 'pending';
  const isFilled = exec.phase === 'filled';
  const isFailed = exec.phase === 'failed';

  return (
    <div className={cn('rounded-lg border p-2.5 text-[11px]', isFilled ? 'border-success/30 bg-success/5' : isPending ? 'border-warning/30 bg-warning/5' : isFailed ? 'border-destructive/30 bg-destructive/5' : 'border-info/30 bg-info/5')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {cfg.icon && <cfg.icon className={cn('h-3.5 w-3.5', exec.phase === 'submitting' && 'animate-spin', isFilled ? 'text-success' : isPending ? 'text-warning' : isFailed ? 'text-destructive' : 'text-info')} />}
          <span className={cn('font-bold uppercase tracking-wider', isFilled ? 'text-success' : isPending ? 'text-warning' : isFailed ? 'text-destructive' : 'text-info')}>
            {cfg.label}
          </span>
          {exec.phase === 'filled' && exec.status && (
            <StatusBadge status="success" label={exec.status} />
          )}
          {exec.phase === 'pending' && exec.status && (
            <StatusBadge status="warning" label={exec.status} />
          )}
          {exec.phase === 'failed' && (
            <StatusBadge status="danger" label="REJECTED" />
          )}
        </div>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={onAck}>Dismiss</Button>
      </div>

      {(exec.phase === 'filled' || exec.phase === 'pending') && 'orderId' in exec && exec.orderId && (
        <div className="mt-1 flex items-center gap-1"><span className="font-bold">Order:</span> <code className="font-mono bg-muted px-1 rounded">{exec.orderId}</code></div>
      )}

      {exec.phase === 'filled' && (
        <div className="mt-2 space-y-1 text-[10px] text-muted-foreground">
          {exec.filledQuantity != null && <div className="flex items-center gap-1"><span className="font-bold">Qty:</span> <span className="font-mono tabular-nums">{exec.filledQuantity}</span></div>}
          {exec.averagePrice != null && <div className="flex items-center gap-1"><span className="font-bold">Avg:</span> <span className="font-mono tabular-nums">₹{exec.averagePrice.toFixed(2)}</span></div>}
          {exec.status && <div className="flex items-center gap-1"><span className="font-bold">Status:</span> <span>{exec.status}</span></div>}
        </div>
      )}

      {exec.phase === 'pending' && (
        <div className="mt-2 space-y-1 text-[10px] text-muted-foreground">
          {'waitingFor' in exec && exec.waitingFor != null && <div className="flex items-center gap-1"><span className="font-bold">Waiting for:</span> <span className="font-mono tabular-nums">₹{exec.waitingFor.toFixed(2)}</span></div>}
          {'reason' in exec && exec.reason && <div className="flex items-center gap-1"><AlertCircle className="h-3 w-3 shrink-0" /><span className="truncate">{exec.reason}</span></div>}
        </div>
      )}

      {exec.phase === 'failed' && (
        <div className="mt-2 space-y-1 text-[10px] text-destructive">
          {exec.message && <div className="flex items-start gap-1"><XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" /><span className="truncate">{exec.message}</span></div>}
        </div>
      )}

      {realtimeOrder && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Live from broker</p>
          <div className="grid grid-cols-2 gap-1 text-[10px]">
            <div><span className="text-muted-foreground">Status:</span> <span className="font-mono ml-1">{String(realtimeOrder.status ?? '—')}</span></div>
            <div><span className="text-muted-foreground">Filled:</span> <span className="font-mono ml-1 tabular-nums">{String(realtimeOrder.filledQuantity ?? '—')}</span></div>
            <div><span className="text-muted-foreground">Avg:</span> <span className="font-mono ml-1 tabular-nums">{realtimeOrder.averageTradedPrice ? `₹${Number(realtimeOrder.averageTradedPrice).toFixed(2)}` : '—'}</span></div>
            <div><span className="text-muted-foreground">Order ID:</span> <span className="font-mono ml-1 truncate">{String(realtimeOrder.orderId ?? realtimeOrder.n_ord_no ?? '—')}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}