'use client';

import { Loader2, XCircle } from 'lucide-react';
import { SectionCard, StatusBadge } from '@/components/design-system';
import type { BasketExecState } from '@/components/orders/basket/types';

function legTone(result: { accepted: boolean; status: string | null; error: string | null }) {
  if (result.accepted) return 'success' as const;
  if (result.error === 'cancelOnFill' || result.status === 'cancelled') return 'warning' as const;
  return 'danger' as const;
}

function legLabel(result: { accepted: boolean; status: string | null; error: string | null }) {
  if (result.accepted) return result.status ?? 'ACCEPTED';
  if (result.error === 'cancelOnFill' || result.status === 'cancelled') return 'CANCELLED';
  if (result.error) return 'REJECTED';
  return 'NOT ACCEPTED';
}

/** Per-leg outcome of a basket placed through /api/terminal/order/basket.
 *  Every leg is the real engine result (accepted + orderId, or the error the
 *  Risk Engine raised) — partial failures are shown leg-by-leg, never hidden. */
export function BasketExecutionState({ exec }: { exec: BasketExecState }) {
  if (exec.phase === 'idle') {
    return (
      <SectionCard title="Basket execution">
        <p className="text-xs text-muted-foreground">
          No basket placed. Compose legs and send them — each leg runs the Single Order choke point (Risk → Audit → Adapter).
        </p>
      </SectionCard>
    );
  }

  if (exec.phase === 'placing') {
    return (
      <SectionCard title="Basket execution">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Placing legs sequentially through the terminal pipeline…
        </div>
      </SectionCard>
    );
  }

  if (exec.phase === 'failed') {
    return (
      <SectionCard title="Basket execution">
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-destructive">Basket failed — nothing placed</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-destructive/80">{exec.message}</p>
          </div>
        </div>
      </SectionCard>
    );
  }

  const accepted = exec.results.filter((r) => r.accepted).length;
  const failed = exec.results.filter((r) => !r.accepted && !(r.error === 'cancelOnFill' || r.status === 'cancelled')).length;

  return (
    <SectionCard
      title="Basket execution"
      headerRight={
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {accepted}/{exec.results.length} accepted · {failed} failed
        </span>
      }
    >
      <ul className="divide-y divide-border/60">
        {exec.results.map((r) => {
          const tone = legTone(r);
          return (
            <li key={r.index} className="flex items-center justify-between gap-3 py-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-[10px] tabular-nums text-muted-foreground/60">#{r.index + 1}</span>
                <span className="truncate font-semibold">{r.symbol}</span>
                {r.orderId && <span className="hidden truncate text-[10px] tabular-nums text-muted-foreground sm:inline">· {r.orderId}</span>}
              </div>
              <div className="flex items-center gap-2">
                {r.error && r.error !== 'cancelOnFill' && (
                  <span className="max-w-40 truncate text-[10px] text-muted-foreground">{r.error}</span>
                )}
                <StatusBadge status={tone} label={legLabel(r)} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/70">
        Accepted legs hold a real orderId from the terminal book and can be re-checked on the Orders / History pages.
      </p>
    </SectionCard>
  );
}