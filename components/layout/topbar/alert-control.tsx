'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowUpRight, BellOff, Loader2 } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { useRealtime, type RealtimeAlert } from '@/components/realtime-provider';
import { getAlerts } from '@/lib/api';
import { dedupeFetch } from '@/lib/shared-request';
import { useActiveAlertBadge } from '@/lib/shared-notifications';
import { fmtAgo } from '@/lib/topbar-status';
import { cn } from '@/lib/utils';
import type { ShellConfig } from '@/components/layout/nav';

function severityTone(sev?: string): { dot: string; text: string } {
  const s = String(sev ?? '').toLowerCase();
  if (s.includes('critical')) return { dot: 'bg-destructive', text: 'text-destructive' };
  if (s.includes('warning') || s.includes('warn')) return { dot: 'bg-warning', text: 'text-warning' };
  return { dot: 'bg-info', text: 'text-info' };
}

export function AlertControl({ config }: { config: ShellConfig }) {
  const router = useRouter();
  const rt = useRealtime();
  const { count, tone } = useActiveAlertBadge();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RealtimeAlert[]>([]);
  const [loading, setLoading] = useState(false);

  const liveRows = useMemo(
    () => rt.notificationsState.latestAlerts,
    [rt.notificationsState.latestAlerts],
  );
  const alerts = useMemo(() => {
    const src = rt.hydrated && liveRows.length > 0 ? liveRows : rows;
    return src.slice(0, 12);
  }, [rt.hydrated, liveRows, rows]);

  useEffect(() => {
    if (!open || (rt.hydrated && liveRows.length > 0)) return;
    let alive = true;
    setLoading(true);
    dedupeFetch('topbar:alerts', () => getAlerts('?status=active&limit=20'), { ttlMs: 5000 })
      .then((r) => {
        if (alive) setRows(Array.isArray(r?.alerts) ? r.alerts : []);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, rt.hydrated, liveRows.length]);

  const iconTone =
    tone === 'critical' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : 'text-muted-foreground';

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={count > 0 ? `Active alerts (${count})` : 'Alerts'}
              className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:h-9 lg:w-9"
            >
              <AlertTriangle className={cn('size-[18px]', iconTone)} aria-hidden />
              {count > 0 && (
                <span
                  className={cn(
                    'absolute right-0.5 top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none',
                    tone === 'critical' ? 'bg-destructive text-destructive-foreground' : 'bg-warning text-warning-foreground',
                  )}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Alerts{count > 0 ? ` (${count} active)` : ''}
        </TooltipContent>

        <PopoverContent align="end" sideOffset={8} className="w-[min(94vw,360px)] p-0">
          <div className="rounded-lg border bg-popover/95 backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className={cn('size-4', iconTone)} aria-hidden />
                <p className="text-sm font-semibold tracking-tight">Active Alerts</p>
                {count > 0 && (
                  <span className="rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-bold text-warning">
                    {count} active
                  </span>
                )}
              </div>
            </div>

            <div className="max-h-[min(55vh,380px)] overflow-y-auto">
              {loading && alerts.length === 0 ? (
                <EmptyState icon={<Loader2 className="size-5 animate-spin opacity-40" />} label="Loading alerts…" />
              ) : alerts.length === 0 ? (
                <EmptyState icon={<BellOff className="size-5 opacity-40" />} label="No active alerts" />
              ) : (
                <ul className="divide-y divide-border/50">
                  {alerts.map((a) => {
                    const tone_ = severityTone(a.severity ?? a.category);
                    return (
                      <li key={String(a.alert_id ?? a._id ?? '')} className="px-3 py-2.5">
                        <div className="flex items-start gap-2.5">
                          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', tone_.dot)} aria-hidden />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">{a.title || a.message || 'Alert'}</p>
                            {a.message && a.title && (
                              <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{a.message}</p>
                            )}
                            <p className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/70">
                              {a.symbol && <span className="font-semibold uppercase text-muted-foreground">{a.symbol}</span>}
                              <span className="tabular-nums">{fmtAgo(a.triggered_at ?? a.last_seen_at ?? a.created_at ?? null)}</span>
                              {a.occurrence_count != null && Number(a.occurrence_count) > 1 && (
                                <span>× {a.occurrence_count}</span>
                              )}
                            </p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-border/60 p-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (config.alertsRoute) router.push(config.alertsRoute);
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
              >
                View all alerts <ArrowUpRight className="size-3.5" />
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </Tooltip>
  );
}

function EmptyState({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
      {icon}
      <p className="text-xs">{label}</p>
    </div>
  );
}