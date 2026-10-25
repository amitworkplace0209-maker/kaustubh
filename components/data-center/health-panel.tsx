'use client';

// ---- Data Center system health panel ----
// Six services with semantic states:
//   GREEN ok · AMBER degraded/stale · RED failed · GRAY unavailable.
// Rows derive from the normalized DataCenterStatus + the page's shared SSE
// connection state — no independent health checks.

import {
  Database, RadioTower, Save, Layers, Wifi, CalendarClock,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { HealthRow } from '@/lib/data-center-status';

const ROW_META: Record<HealthRow['key'], { title: string; Icon: React.ElementType; accent: string }> = {
  database: { title: 'Database', Icon: Database, accent: 'text-purple' },
  'tick-stream': { title: 'Live Tick Stream', Icon: RadioTower, accent: 'text-success' },
  'tick-storage': { title: 'Tick Storage', Icon: Save, accent: 'text-primary' },
  'tick-buffer': { title: 'Tick Buffer', Icon: Layers, accent: 'text-warning' },
  websocket: { title: 'WebSocket', Icon: Wifi, accent: 'text-primary' },
  scheduler: { title: 'Scheduler', Icon: CalendarClock, accent: 'text-info' },
};

const STATE_DOT: Record<HealthRow['state'], string> = {
  ok: 'bg-success [box-shadow:0_0_5px_hsl(var(--success)/0.7)]',
  degraded: 'bg-warning animate-pulse',
  failed: 'bg-destructive',
  unavailable: 'bg-muted-foreground/50',
};

const STATE_VALUE_CLS: Record<HealthRow['state'], string> = {
  ok: 'text-success',
  degraded: 'text-warning',
  failed: 'text-destructive',
  unavailable: 'text-muted-foreground',
};

function HealthRowView({ row }: { row: HealthRow }) {
  const meta = ROW_META[row.key];
  const isBuffer = row.key === 'tick-buffer';
  let utilPct: number | null = null;
  if (isBuffer) {
    const m = row.value.match(/^([\d,]+)\s*\/\s*([\d,]+)$/);
    if (m) {
      const cur = Number(m[1].replace(/,/g, ''));
      const max = Number(m[2].replace(/,/g, ''));
      if (Number.isFinite(cur) && Number.isFinite(max) && max > 0) utilPct = (cur / max) * 100;
    }
  }
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/40 bg-background/40 p-3 transition-colors hover:border-border">
      <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 ring-1 ring-inset ring-border/40', meta.accent)}>
        <meta.Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATE_DOT[row.state])} />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{meta.title}</span>
          <span className={cn('ml-auto text-xs font-bold tabular-nums', STATE_VALUE_CLS[row.state])}>{row.value}</span>
        </div>
        <p className="mt-1 truncate pl-3.5 text-[11px] text-muted-foreground" title={row.detail || undefined}>
          {row.detail || '\u2014'}
        </p>
        {isBuffer && utilPct != null && (
          <span className="mt-1.5 ml-3.5 block h-1 w-full max-w-[180px] overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                'block h-full rounded-full transition-all',
                utilPct >= 80 ? 'bg-destructive' : utilPct >= 60 ? 'bg-warning' : 'bg-success',
              )}
              style={{ width: `${Math.min(utilPct, 100)}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}

export default function HealthPanel({ rows, loading }: { rows: HealthRow[]; loading: boolean }) {
  return (
    <Card className="shadow-soft">
      <CardContent className="px-4 py-3.5">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">System Health</h2>
          <div className="flex items-center gap-3 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="flex items-center gap-1"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" /> OK</span>
            <span className="flex items-center gap-1"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" /> Stale</span>
            <span className="flex items-center gap-1"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-destructive" /> Down</span>
            <span className="flex items-center gap-1"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" /> N/A</span>
          </div>
        </div>
        {/* No animate-pulse on refresh — rows update in place so the panel
            never blinks (#25/#28). Skeletons only when there is no data yet. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {loading && rows.length === 0
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-[64px] rounded-lg border border-border/40 bg-muted/30" />
              ))
            : rows.map((row) => <HealthRowView key={row.key} row={row} />)}
        </div>
      </CardContent>
    </Card>
  );
}
