'use client';

// ---- Selectable account-mode card (DEMO / API) ----

import { CheckCircle2, Coins, IndianRupee, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ModeCardKind = 'demo' | 'api';

export type AccountModeCardProps = {
  kind: ModeCardKind;
  active: boolean;
  /** null = connection state unknown (still checking). */
  connected?: boolean | null;
  checking?: boolean;
  onSelect: () => void;
};

export function AccountModeCard({ kind, active, connected, checking, onSelect }: AccountModeCardProps) {
  const isDemo = kind === 'demo';
  const Icon = isDemo ? Coins : IndianRupee;
  const title = isDemo ? 'Demo Mode' : 'API Mode';
  const desc = isDemo
    ? 'Virtual demo account · practice trading'
    : 'Real Kotak Neo account · live funds';

  return (
    <button
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'group relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-200 shadow-soft hover:-translate-y-px',
        active
          ? isDemo
            ? 'border-purple bg-purple/[0.06] shadow-[0_0_18px_-8px_hsl(var(--purple)/0.5)]'
            : 'border-success bg-success/[0.05] shadow-[0_0_18px_-8px_hsl(var(--success)/0.55)]'
          : 'border-border/40 hover:border-border hover:shadow-soft-lg',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-x-0 top-0 h-[2px] transition-opacity',
          active ? (isDemo ? 'bg-purple' : 'bg-success') : 'bg-transparent',
        )}
      />
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-colors',
            active
              ? isDemo
                ? 'bg-purple/15 text-purple ring-purple/30'
                : 'bg-success/15 text-success ring-success/30'
              : 'bg-muted text-muted-foreground ring-border/50',
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold leading-tight">{title}</div>
          <div className="truncate text-[11px] text-muted-foreground">{desc}</div>
        </div>
        {active && !isDemo && (
          <span className="shrink-0 text-right">
            {checking ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-warning">
                <Loader2 className="h-2.5 w-2.5 animate-spin" /> SYNC
              </span>
            ) : connected === true ? (
              <>
                <span className="block text-[10px] font-bold tracking-wider text-success">LIVE</span>
                <span className="block text-[9px] text-muted-foreground">KOTAK NEO CONNECTED</span>
              </>
            ) : connected === false ? (
              <>
                <span className="block text-[10px] font-bold tracking-wider text-destructive">OFFLINE</span>
                <span className="block text-[9px] text-muted-foreground">LOGIN REQUIRED</span>
              </>
            ) : null}
          </span>
        )}
        {active && isDemo && (
          <span className="shrink-0 text-right">
            <span className="block text-[10px] font-bold tracking-wider text-purple">ACTIVE</span>
            <span className="block text-[9px] text-muted-foreground">DEMO ENGINE</span>
          </span>
        )}
        {active && <CheckCircle2 className={cn('ml-1 h-5 w-5 shrink-0', isDemo ? 'text-purple' : 'text-success')} />}
      </div>
    </button>
  );
}
