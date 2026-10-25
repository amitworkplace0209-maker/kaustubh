'use client';

// ---- Live/STALE/OFFLINE freshness chip (account surfaces) ----

import { cn } from '@/lib/utils';

export type LiveFreshness = 'live' | 'stale' | 'offline' | 'connecting';

const META: Record<LiveFreshness, { chip: string; dot: string; text: string; label: string }> = {
  live: {
    chip: 'border-success/25 bg-success/[0.07]',
    dot: 'bg-success animate-pulse [box-shadow:0_0_5px_hsl(var(--success)/0.7)]',
    text: 'text-success',
    label: 'LIVE',
  },
  stale: {
    chip: 'border-warning/40 bg-warning/[0.08]',
    dot: 'bg-warning animate-pulse',
    text: 'text-warning',
    label: 'STALE',
  },
  offline: {
    chip: 'border-destructive/30 bg-destructive/[0.07]',
    dot: 'bg-destructive',
    text: 'text-destructive',
    label: 'OFFLINE',
  },
  connecting: {
    chip: 'border-border/50 bg-muted/40',
    dot: 'bg-muted-foreground/60 animate-pulse',
    text: 'text-muted-foreground',
    label: 'SYNC',
  },
};

export function LiveStatus({ freshness, updatedLabel }: { freshness: LiveFreshness; updatedLabel?: string }) {
  const m = META[freshness];
  return (
    <span
      title={updatedLabel ? `${m.label} · ${updatedLabel}` : m.label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[2px] text-[10px] font-medium tabular-nums',
        m.chip,
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />
      <span className={cn('font-semibold tracking-wide', m.text)}>{m.label}</span>
      {updatedLabel && (
        <>
          <span aria-hidden className="opacity-40">{'\u2022'}</span>
          <span className="hidden text-muted-foreground sm:inline">{updatedLabel}</span>
        </>
      )}
    </span>
  );
}
