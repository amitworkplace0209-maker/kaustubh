'use client';

import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { getTerminalOrders, type TerminalId } from '@/lib/terminal-service';
import { canonicalOrderStatus, execTone, PRE_EXEC_STAGES } from '@/components/orders/trade/lifecycle';
import type { ExecState } from '@/components/orders/trade/types';

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fromToNow(at: string): string {
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms)) return '';
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function readOrderFields(o: Record<string, any>): { status: string | null; filled: number | null; qty: number | null; avg: number | null } {
  const rawStatus: unknown = (o as any).status ?? (o as any).st ?? null;
  return {
    status:
      typeof (o as any).status === 'string' && (o as any).status !== ''
        ? (o as any).status
        : ((o as any).st === 'OA' ? 'OPEN' : rawStatus != null ? String(rawStatus) : null),
    filled: numOrNull((o as any).filledQuantity ?? (o as any).fill_qty),
    qty: numOrNull((o as any).quantity ?? (o as any).qty),
    avg: numOrNull((o as any).averagePrice ?? (o as any).avg_price),
  };
}

const TONE_CLS: Record<string, string> = {
  success: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  info: 'border-info/40 bg-info/10 text-info',
  neutral: 'border-border bg-muted/40 text-muted-foreground',
};

/**
 * Compact execution banner.
 *
 * Truth contract: an order is only shown as COMPLETE when the engine reports a
 * real execution. A limit/stop order the live LTP has not reached stays
 * PENDING — the engine is holding it, not failing and not filling it.
 */
export function ExecutionState({
  exec,
  execId,
  terminal,
  symbol,
  realtimeOrder,
  onAck,
}: {
  exec: ExecState;
  execId: number;
  terminal: TerminalId;
  symbol: string;
  realtimeOrder?: Record<string, any> | null;
  onAck: () => void;
}) {
  const [polling, setPolling] = useState(false);
  const [polled, setPolled] = useState<{ status: string | null; filled: number | null; qty: number | null; avg: number | null } | null>(null);

  async function pollOnce() {
    setPolling(true);
    try {
      const res = await getTerminalOrders(terminal);
      const rows = res?.data?.orders ?? res?.data ?? [];
      const mine = (Array.isArray(rows) ? rows : []).filter(
        (o: any) => String(o.symbol ?? o.tradingSymbol ?? o.scripname ?? '').toUpperCase() === symbol.toUpperCase(),
      );
      setPolled(mine[0] ? readOrderFields(mine[0]) : null);
    } catch {
      setPolled(null);
    } finally {
      setPolling(false);
    }
  }

  // Live order.update frame (WS#3) is the freshest server truth — it wins over
  // a manual book poll, which in turn wins over the settled snapshot.
  const rtStatus: string | null = realtimeOrder?.status ?? null;
  const rtFilled = realtimeOrder?.filledQuantity != null ? Number(realtimeOrder.filledQuantity) : null;
  const rtQty = realtimeOrder?.quantity != null ? Number(realtimeOrder.quantity) : null;
  const rtAvg = realtimeOrder?.averageTradedPrice != null ? Number(realtimeOrder.averageTradedPrice) : null;
  const rtOrdId = realtimeOrder?.orderId ?? realtimeOrder?.order?.orderId ?? null;

  const settled = exec.phase === 'filled' || exec.phase === 'pending';
  const liveStatus: string | null =
    rtStatus ?? polled?.status ?? (settled ? (exec.status ?? 'UNKNOWN') : null);
  const liveFilled = rtFilled ?? polled?.filled ?? (exec.phase === 'filled' ? exec.filledQuantity ?? null : null);
  const liveQty = rtQty ?? polled?.qty ?? null;
  const liveAvg = rtAvg ?? polled?.avg ?? null;
  const status = canonicalOrderStatus(liveStatus);
  const orderId = (exec.phase === 'filled' || exec.phase === 'pending' ? exec.orderId : null) ?? rtOrdId;
  const tone = execTone(status);
  const filled = status === 'FILLED';

  const body = () => {
    if (exec.phase === 'idle') return null;
    if (exec.phase === 'submitting') {
      return (
        <div className="rounded-lg border border-info/30 bg-info/10 px-2.5 py-1.5">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-info">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending · {PRE_EXEC_STAGES.length} stages
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {PRE_EXEC_STAGES.map((s) => s.label).join(' → ')} · {fromToNow(exec.at)}
          </p>
        </div>
      );
    }
    if (exec.phase === 'failed') {
      return (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2">
          <XCircle className="mt-px h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-wide text-destructive">Rejected — nothing was placed</p>
            <p className="mt-0.5 text-[11px] leading-snug text-destructive/85">{exec.message}</p>
          </div>
          <button onClick={onAck} className="shrink-0 rounded border border-destructive/40 px-2 py-1 text-[10px] font-semibold text-destructive hover:bg-destructive/10">
            ✕
          </button>
        </div>
      );
    }

    const waiting = exec.phase === 'pending' ? exec.waitingFor ?? null : null;
    const reason = exec.phase === 'pending' ? exec.reason ?? null : null;
    const explain = filled
      ? liveAvg ? `Filled at avg ${liveAvg.toFixed(2)}.` : 'Fully executed by the engine.'
      : status === 'PARTIALLY_FILLED'
        ? `Partially filled: ${liveFilled ?? 0}${liveQty ? ` / ${liveQty}` : ''} — the rest rests with the exchange.`
        : status === 'OPEN'
          ? `Resting with the exchange.${liveFilled ? ` ${liveFilled}${liveQty ? ` / ${liveQty}` : ''} filled so far.` : ''}`
          : `Order accepted, status ${status}.`;

    return (
      <div className={cn('rounded-lg border px-2.5 py-2', TONE_CLS[tone])}>
        <div className="flex items-center gap-1.5">
          {filled ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <Clock className="h-4 w-4 shrink-0 animate-pulse" />}
          <span className="text-[12px] font-extrabold uppercase tracking-wide">
            {filled ? 'Order Complete' : status === 'PARTIALLY_FILLED' ? 'Partially Filled' : 'Pending Fill'}
          </span>
          {orderId && <span className="ml-auto font-mono text-[10px] tabular-nums opacity-80">#{orderId}</span>}
        </div>
        <p className="mt-1 text-[11px] leading-snug">
          {explain}
        </p>
        {reason && <p className="mt-0.5 text-[10px] opacity-85">{reason}</p>}
        {!filled && waiting != null && (
          <p className="mt-1 rounded border border-foreground/15 bg-background/50 px-2 py-1 font-mono text-[10px] tabular-nums">
            Waiting for the live LTP to reach {Number(waiting).toFixed(2)}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] font-semibold">
          <button
            type="button"
            onClick={pollOnce}
            disabled={polling}
            className="inline-flex items-center gap-1 rounded border border-foreground/20 px-2 py-1 opacity-90 transition-opacity hover:opacity-100 disabled:opacity-50"
          >
            {polling ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <CheckCircle2 className="h-2.5 w-2.5" />}
            {polling ? 'checking…' : 're-check book'}
          </button>
          <Link href="/trading/positions" className="underline underline-offset-2">Positions</Link>
          <Link href="/trading/orders" className="underline underline-offset-2">Orders</Link>
          <button onClick={onAck} className="ml-auto shrink-0 rounded border border-foreground/20 px-2 py-1 text-[10px] font-semibold opacity-80 transition-opacity hover:opacity-100">dismiss</button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-1">
      {body()}
      {execId > 0 && exec.phase !== 'idle' && (
        <p className="flex items-center justify-end gap-1 text-[9px] text-muted-foreground/60">
          source: {rtStatus != null ? 'live order.update frame' : polled ? 'live orders book' : 'engine snapshot'}
        </p>
      )}
    </div>
  );
}