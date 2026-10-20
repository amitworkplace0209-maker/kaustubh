'use client';

// ---- Margin utilisation ring ----
// Thresholds come from MARGIN_UTILISATION_THRESHOLDS (configurable in
// lib/account-service.ts) — never hard-coded here.

import { Gauge } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { fmtRs } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import {
  marginUtilisationState, type AccountFunds,
} from '@/lib/account-service';

const STATE_COLOR = {
  LOW: { stroke: 'hsl(var(--success))', text: 'text-success', label: 'LOW', chip: 'border-success/30 bg-success/10 text-success' },
  MEDIUM: { stroke: 'hsl(var(--warning))', text: 'text-warning', label: 'MEDIUM', chip: 'border-warning/40 bg-warning/10 text-warning' },
  HIGH: { stroke: 'hsl(var(--destructive))', text: 'text-destructive', label: 'HIGH', chip: 'border-destructive/30 bg-destructive/10 text-destructive' },
} as const;

export function MarginUtilisation({ funds }: { funds: AccountFunds | null }) {
  const pct = funds?.marginUtilisation ?? null;
  const state = marginUtilisationState(pct);
  const c = STATE_COLOR[state];
  const known = pct != null;

  // SVG ring geometry (r=44 keeps the math simple: circumference ~276.5).
  const R = 44;
  const CIRC = 2 * Math.PI * R;
  const dash = known ? (Math.min(100, Math.max(0, pct)) / 100) * CIRC : 0;

  return (
    <Card className="shadow-soft">
      <CardContent className="px-4 py-3.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple/10 text-purple ring-1 ring-inset ring-purple/25">
            <Gauge className="h-3.5 w-3.5" />
          </span>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Margin Utilisation
          </h3>
          <span className={cn('ml-auto rounded-full border px-1.5 py-0 text-[9px] font-bold tracking-wider', c.chip)}>
            {known ? c.label : 'N/A'}
          </span>
        </div>

        <div className="flex items-center gap-4">
          {/* Ring */}
          <div className="relative h-[104px] w-[104px] shrink-0">
            <svg viewBox="0 0 104 104" className="h-full w-full -rotate-90">
              <circle cx="52" cy="52" r={R} fill="none" strokeWidth="9" className="stroke-muted" />
              <circle
                cx="52" cy="52" r={R} fill="none" strokeWidth="9"
                stroke={known ? c.stroke : 'transparent'}
                strokeLinecap="round"
                strokeDasharray={`${dash} ${CIRC - dash}`}
                className="transition-all duration-500 ease-out"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {known ? (
                <>
                  <span className={cn('font-mono text-xl font-semibold tabular-nums leading-none', c.text)}>
                    {pct!.toFixed(1)}%
                  </span>
                  <span className="mt-1 text-[9px] uppercase tracking-wider text-muted-foreground">utilised</span>
                </>
              ) : (
                <span className="text-sm font-medium text-muted-foreground">N/A</span>
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className="h-2 w-2 rounded-full bg-warning" /> Used Margin
              </span>
              <span className="font-mono text-xs font-semibold tabular-nums">{fmtRs(funds?.utilisedMargin ?? null)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className="h-2 w-2 rounded-full bg-success" /> Available Margin
              </span>
              <span className="font-mono text-xs font-semibold tabular-nums">{fmtRs(funds?.availableMargin ?? null)}</span>
            </div>
            <div className="border-t border-border/40 pt-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span aria-hidden className="h-2 w-2 rounded-full bg-primary" /> Total Margin
                </span>
                <span className="font-mono text-xs font-semibold tabular-nums">{fmtRs(funds?.totalBalance ?? null)}</span>
              </div>
              <p className="mt-1 text-right text-[10px] text-muted-foreground">
                {funds?.derivedFields.includes('marginUtilisation') ? 'Calculated' : '\u00A0'}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
