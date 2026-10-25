'use client';

/**
 * Order status state machine panel (docs/engines/order-engine.md §24).
 *
 * Counts come from the live order book, never from a hard-coded list, and
 * working states are visually separated from terminal ones so "pending" can
 * never be mistaken for "executed".
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TONE_CLASS, fmtNum } from './status';

const WORKING_STATES = ['PENDING', 'OPEN', 'TRIGGER_PENDING', 'PARTIALLY_FILLED'];
const TERMINAL_STATES = ['COMPLETE', 'REJECTED', 'CANCELLED'];

const STATE_HELP: Record<string, string> = {
  PENDING: 'Accepted by the broker, awaiting execution',
  OPEN: 'Resting in the book until the price matches',
  TRIGGER_PENDING: 'Waiting for the trigger price',
  PARTIALLY_FILLED: 'Partially executed, remainder still working',
  COMPLETE: 'Fully executed against the real market',
  REJECTED: 'Refused by validation, risk, or the broker',
  CANCELLED: 'Withdrawn on request',
};

export function StateMachinePanel({
  counts,
  total,
}: {
  counts: Record<string, number>;
  total: number;
}) {
  const working = WORKING_STATES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);

  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Order state machine</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-amber-300">
            Working — accepted, not yet executed
          </div>
          <div className="mt-1 font-mono text-2xl text-amber-200">{working}</div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
            {WORKING_STATES.map((s) => (
              <div key={s} className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{s.replace(/_/g, ' ')}</span>
                <span className="font-mono">{counts[s] ?? 0}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Terminal — final
          </div>
          <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1">
            {TERMINAL_STATES.map((s) => (
              <div key={s} className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{s}</span>
                <span className="font-mono">{counts[s] ?? 0}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-white/5 pt-2 text-xs">
          <span className="text-muted-foreground">Total orders</span>
          <span className="font-mono">{fmtNum(total ?? counts.TOTAL ?? 0, 0)}</span>
        </div>

        {total > 0 && working > 0 && (
          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
            {working} order{working === 1 ? '' : 's'} accepted but not executed. Each one fills only
            when the live market price actually matches its terms.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function StateLegend() {
  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">What the states mean</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {[...WORKING_STATES, ...TERMINAL_STATES].map((s) => (
          <div key={s} className="flex items-start gap-2 text-[11px]">
            <span
              className={`mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full ${
                TERMINAL_STATES.includes(s) ? 'bg-slate-400' : 'bg-amber-400'
              }`}
            />
            <span className="font-mono text-muted-foreground">{s.replace(/_/g, ' ')}</span>
            <span className="text-muted-foreground/80">{STATE_HELP[s]}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function StateBadge({ status }: { status: string }) {
  const tone = TERMINAL_STATES.includes(status)
    ? status === 'COMPLETE'
      ? 'emerald'
      : status === 'REJECTED'
        ? 'rose'
        : 'slate'
    : status === 'PARTIALLY_FILLED'
      ? 'sky'
      : 'amber';
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${TONE_CLASS[tone]}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}