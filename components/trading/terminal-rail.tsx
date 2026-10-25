'use client';

import { Activity, CircleDot, Radio, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';

export interface TerminalRailProps {
  caps: TradeCapabilities;
  /** 'backend' when the live capability registry answered. */
  capsSource: 'backend' | 'mirror';
  sessionActive: boolean;
  marketStatus: string;
  marketClosed: boolean;
  feedState: 'OFFLINE' | 'WAITING' | 'LIVE' | 'STALE';
  engineOk: number;
  engineTotal: number;
  enginesConnected: boolean;
}

/**
 * The status rail — one honest line about the state of the trade path.
 *
 * Every pill states a REAL observed value. A closed exchange is a scheduled
 * standby, not a failure: the broker socket is deliberately not connected then,
 * so a red "OFFLINE" would blame the operator for market hours.
 */
export function TerminalRail({
  caps,
  capsSource,
  sessionActive,
  marketStatus,
  marketClosed,
  feedState,
  engineOk,
  engineTotal,
  enginesConnected,
}: TerminalRailProps) {
  const marketOpen = marketStatus === 'OPEN';
  const feedLabel =
    marketClosed && feedState === 'OFFLINE' ? 'NO FEED' : feedState;
  const feedTone =
    feedLabel === 'LIVE'
      ? 'success'
      : feedLabel === 'OFFLINE'
        ? 'danger'
        : feedLabel === 'NO FEED'
          ? 'neutral'
          : 'warning';

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px]">
      <span className="flex items-center gap-1.5">
        <span className="text-[13px] font-bold tracking-tight">{caps.name}</span>
        <span className="rounded border border-border/70 px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {caps.modeLabel}
        </span>
        {capsSource === 'mirror' && (
          <span
            className="rounded border border-warning/30 bg-warning/10 px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-warning"
            title="The live capability registry has not answered yet — the built-in mirror is in use."
          >
            caps mirror
          </span>
        )}
      </span>

      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        <Pill
          tone={sessionActive ? 'success' : 'warning'}
          icon={sessionActive ? <CircleDot className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          label={sessionActive ? 'Session live' : 'No session'}
        />
        <Pill
          tone={marketOpen ? 'success' : marketClosed ? 'neutral' : 'warning'}
          icon={<Radio className="h-3 w-3" />}
          label={marketStatus ? `Market ${marketStatus.toLowerCase()}` : 'Market unknown'}
        />
        <Pill
          tone={feedTone}
          icon={<Wifi className="h-3 w-3" />}
          label={feedLabel}
        />
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-2 py-0.5 font-semibold tabular-nums text-muted-foreground',
          )}
          title={`Engines healthy: ${engineOk}/${engineTotal}`}
        >
          <Activity className="h-3 w-3" />
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              enginesConnected ? 'bg-success animate-pulse' : 'bg-muted-foreground/30',
            )}
          />
          {engineOk}/{engineTotal}
        </span>
      </span>
    </div>
  );
}

function Pill({
  tone,
  icon,
  label,
}: {
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  icon: React.ReactNode;
  label: string;
}) {
  const toneClass = {
    success: 'border-success/30 bg-success/10 text-success',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    danger: 'border-destructive/30 bg-destructive/10 text-destructive',
    info: 'border-info/30 bg-info/10 text-info',
    neutral: 'border-border/70 bg-muted/40 text-muted-foreground',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold uppercase tracking-wide',
        toneClass,
      )}
    >
      {icon}
      {label}
    </span>
  );
}
