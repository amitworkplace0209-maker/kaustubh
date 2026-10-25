'use client';

import { memo } from 'react';
import { AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { canonicalOrderStatus, execTone } from '@/components/orders/trade/lifecycle';
import type { ExecState } from '@/components/orders/trade/types';

export interface ExecutionPanelProps {
  exec: ExecState;
  /** Bumped after every placement so the panel can re-announce a new result. */
  execNonce: number;
  onAck: () => void;
}

/**
 * The order result panel.
 *
 * It shows the status the BROKER (or the paper engine) actually reported —
 * never a guess. A working order is presented as working, not as filled.
 */
export const ExecutionPanel = memo(function ExecutionPanel({ exec, execNonce, onAck }: ExecutionPanelProps) {
  if (exec.phase === 'idle') return null;

  if (exec.phase === 'submitting') {
    return (
      <div className="flex items-center gap-2 border-t border-border/50 bg-info/[0.07] px-3 py-2.5 text-[13px] font-medium text-info">
        <Loader2 className="h-4 w-4 animate-spin" />
        Sending the order to the engine…
      </div>
    );
  }

  if (exec.phase === 'failed') {
    return (
      <div
        key={execNonce}
        role="alert"
        className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/[0.07] px-3 py-2.5 text-[13px] text-destructive"
      >
        <XCircle className="mt-px h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Order not placed</p>
          <p className="mt-0.5 break-words text-[12px] opacity-90">{exec.message}</p>
        </div>
        <button
          type="button"
          onClick={onAck}
          className="shrink-0 rounded-md border border-destructive/30 px-2 py-1 text-[11px] font-bold uppercase tracking-wider hover:bg-destructive/10"
        >
          dismiss
        </button>
      </div>
    );
  }

  const status = canonicalOrderStatus(exec.status);
  const tone = execTone(status);

  if (exec.phase === 'filled') {
    return (
      <div
        key={execNonce}
        role="status"
        className={cn(
          'flex items-start gap-2 border-t px-3 py-2.5 text-[13px]',
          tone === 'success' ? 'border-success/30 bg-success/[0.07] text-success' : 'border-border/50 bg-muted/20',
        )}
      >
        <CheckCircle2 className="mt-px h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Filled · {status}</p>
          <p className="mt-0.5 text-[12px] opacity-90">
            {exec.filledQuantity != null && <span>Qty {exec.filledQuantity} · </span>}
            {exec.averagePrice != null && <span>avg {exec.averagePrice.toFixed(2)} · </span>}
            {exec.orderId && <span>id {exec.orderId}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={onAck}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-bold uppercase tracking-wider hover:bg-muted/40"
        >
          close
        </button>
      </div>
    );
  }

  return (
    <div
      key={execNonce}
      role="status"
      className={cn(
        'flex items-start gap-2 border-t px-3 py-2.5 text-[13px]',
        tone === 'danger' ? 'border-destructive/30 bg-destructive/[0.07] text-destructive' : 'border-warning/30 bg-warning/[0.07] text-warning',
      )}
    >
      {tone === 'danger' ? (
        <AlertCircle className="mt-px h-4 w-4 shrink-0" />
      ) : (
        <Clock className="mt-px h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Working · {status}</p>
        <p className="mt-0.5 break-words text-[12px] opacity-90">
          {exec.reason}
          {exec.waitingFor != null && <span> Waiting for {exec.waitingFor.toFixed(2)}.</span>}
          {exec.orderId && <span> id {exec.orderId}.</span>}
        </p>
      </div>
      <button
        type="button"
        onClick={onAck}
        className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-bold uppercase tracking-wider hover:bg-muted/40"
      >
        close
      </button>
    </div>
  );
});
