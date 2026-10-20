'use client';

// ---- Account health card ----
// Safe connection indicators ONLY (never credentials).

import { Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { AccountStatus } from '@/lib/account-service';

type RowState = 'ok' | 'warn' | 'bad' | 'na';

const STATE_DOT: Record<RowState, string> = {
  ok: 'bg-success [box-shadow:0_0_5px_hsl(var(--success)/0.7)]',
  warn: 'bg-warning animate-pulse',
  bad: 'bg-destructive',
  na: 'bg-muted-foreground/50',
};

function HealthRow({ label, state, value }: { label: string; state: RowState; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[7px]">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATE_DOT[state])} />
        {label}
      </span>
      <span
        className={cn(
          'text-xs font-semibold tabular-nums',
          state === 'ok' ? 'text-success'
            : state === 'warn' ? 'text-warning'
              : state === 'bad' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function AccountHealthCard({
  status, mode, fundsLastSuccessAt,
}: {
  status: AccountStatus | null;
  mode: 'demo' | 'api';
  /** Local timestamp (ms) of the last successful funds refresh. */
  fundsLastSuccessAt: number | null;
}) {
  const lastSync = fundsLastSuccessAt != null
    ? new Date(fundsLastSuccessAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
    : 'N/A';

  return (
    <Card className="shadow-soft">
      <CardContent className="px-4 py-3.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
            <Activity className="h-3.5 w-3.5" />
          </span>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Account Health
          </h3>
        </div>
        <div className="divide-y divide-border/40">
          {mode === 'api' ? (
            <>
              <HealthRow
                label="Kotak Neo"
                state={status == null ? 'na' : status.kotakConnected ? 'ok' : 'bad'}
                value={status == null ? 'N/A' : status.kotakConnected ? 'Connected' : 'Disconnected'}
              />
              <HealthRow label="Funds Sync" state={fundsLastSuccessAt != null ? 'ok' : 'bad'} value={fundsLastSuccessAt != null ? 'Live' : 'No data'} />
              <HealthRow
                label="Market Data"
                state={status?.marketDataLive == null ? 'na' : status.marketDataLive ? 'ok' : 'warn'}
                value={status?.marketDataLive == null ? 'N/A' : status.marketDataLive ? 'Live' : 'Down'}
              />
              <HealthRow label="Last Sync" state={fundsLastSuccessAt != null ? 'ok' : 'warn'} value={lastSync} />
            </>
          ) : (
            <>
              <HealthRow label="Demo Engine" state="ok" value="Connected" />
              <HealthRow label="Funds Sync" state="ok" value="Live" />
              <HealthRow label="Kotak Neo" state="na" value="Not used in demo" />
              <HealthRow label="Last Sync" state="ok" value={lastSync} />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
