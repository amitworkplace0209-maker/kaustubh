'use client';

// Engine Status — ultra-compact modern colorful card
// Size reduced ~35% vs previous, colorful donut chart, premium drawer

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSystem } from '@/components/system-provider';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Cpu, ExternalLink, Activity, Timer } from 'lucide-react';
import { useServerNow, ageLabel } from '@/lib/time-engine';

type EngineStatus = {
  engineId: string;
  engineName: string;
  engineCategory: string;
  state: string;
  health: string;
  healthReason: string;
  startedAt: number;
  lastHeartbeat: number;
  heartbeatAge: number | null;
  connectionState: string;
  metrics: {
    eventCount: number;
    errorCount: number;
    warningCount: number;
    queueSize: number;
    workload: number;
  };
};

const STATE_DOT: Record<string, string> = {
  RUNNING: 'bg-success [box-shadow:0_0_6px_hsl(var(--success)/0.7)]',
  REGISTERED: 'bg-sky-500',
  DISCONNECTED: 'bg-warning animate-pulse',
  STOPPED: 'bg-destructive',
  UNKNOWN: 'bg-muted-foreground/30',
};

function stateKey(s: string): string {
  const u = (s || 'UNKNOWN').toUpperCase();
  return u in STATE_DOT ? u : 'UNKNOWN';
}

function healthLabel(h: string): { text: string; cls: string } {
  const u = (h || '').toUpperCase();
  if (u === 'HEALTHY') return { text: 'HEALTHY', cls: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20 dark:text-emerald-400' };
  if (u === 'DEGRADED') return { text: 'DEGRADED', cls: 'text-amber-600 bg-amber-500/10 border-amber-500/20 dark:text-amber-400' };
  if (u === 'UNHEALTHY') return { text: 'UNHEALTHY', cls: 'text-red-600 bg-red-500/10 border-red-500/20 dark:text-red-400' };
  return { text: h || 'UNKNOWN', cls: 'text-muted-foreground bg-muted border-border' };
}

function MiniDonut({
  value,
  total,
  size = 48,
  stroke = 5,
  color,
  bg = 'hsl(var(--muted))',
  label,
}: {
  value: number;
  total: number;
  size?: number;
  stroke?: number;
  color: string;
  bg?: string;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? value / total : 0;
  const dash = c * pct;
  const empty = c - dash;
  return (
    <div className="relative flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke={bg} strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${empty}`}
          className="transition-all duration-700 ease-out"
          style={{ filter: `drop-shadow(0 0 4px ${color}66)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[11px] font-bold leading-none tabular-nums">{value}</span>
        <span className="text-[8px] font-medium leading-none text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

function CompactBar({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full transition-all duration-500', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function EngineStatusCard({ className }: { className?: string }) {
  const { state: sysState } = useSystem();
  const serverNow = useServerNow();
  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [expanded, setExpanded] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/services/engines', { cache: 'no-store' });
      const json = await res.json();
      if (mountedRef.current) setEngines(json?.data ?? []);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    pollRef.current = setInterval(() => {
      if (typeof document !== 'undefined' && !document.hidden) void load();
    }, 10000);
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const total = engines.length;
  const running = engines.filter((e) => (e.state || '').toUpperCase() === 'RUNNING').length;
  const healthy = engines.filter((e) => (e.health || '').toUpperCase() === 'HEALTHY').length;
  const degraded = engines.filter((e) => (e.health || '').toUpperCase() === 'DEGRADED').length;
  const unhealthy = engines.filter((e) => (e.health || '').toUpperCase() === 'UNHEALTHY').length;
  const issues = degraded + unhealthy;
  const connected = sysState === 'ok';
  const avgEvents = total > 0 ? Math.round(engines.reduce((s, e) => s + (e.metrics?.eventCount ?? 0), 0) / total) : 0;
  const totalQueue = engines.reduce((s, e) => s + (e.metrics?.queueSize ?? 0), 0);

  return (
    <Card className={cn('group relative overflow-hidden border-border/60 bg-gradient-to-br from-card via-card to-muted/20', className)}>
      {/* Accent top line - colorful */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-[2.5px] bg-gradient-to-r from-emerald-500 via-sky-500 to-violet-500 opacity-80" />
      {/* Subtle colorful wash */}
      <span aria-hidden className="pointer-events-none absolute -right-8 -top-8 h-20 w-20 rounded-full bg-gradient-to-br from-emerald-500/10 via-sky-500/10 to-violet-500/10 blur-2xl" />

      <CardContent className="relative px-3 py-2.5">
        {/* Header — ultra compact */}
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-emerald-500 to-sky-600 text-white shadow-sm">
              <Cpu className="h-3 w-3" />
            </span>
            Engine Status
          </h2>
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
            connected ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-red-500/20 bg-red-500/10 text-red-600'
          )}>
            <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-500 [box-shadow:0_0_6px_hsl(var(--success)/0.7)] animate-pulse' : 'bg-red-500')} />
            {connected ? 'Backend OK' : 'Down'}
          </span>
        </div>

        {/* Main compact row — numbers + colorful donuts */}
        <div className="mt-2 flex items-center gap-3">
          {/* Numbers */}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-[15px] font-bold tabular-nums leading-none">{total}</span>
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Engines</span>
              <span className="ml-1 h-3 w-px bg-border" />
              <span className="text-sm font-bold tabular-nums leading-none text-emerald-600 dark:text-emerald-400">{running}</span>
              <span className="text-[10px] text-muted-foreground">Run</span>
              <span className="text-[10px] text-muted-foreground/40">·</span>
              <span className="text-sm font-bold tabular-nums leading-none text-sky-600 dark:text-sky-400">{healthy}</span>
              <span className="text-[10px] text-muted-foreground">OK</span>
              {issues > 0 && (
                <>
                  <span className="text-[10px] text-muted-foreground/40">·</span>
                  <span className="text-sm font-bold tabular-nums leading-none text-amber-600">{issues}</span>
                  <span className="text-[10px] text-amber-600">Issue</span>
                </>
              )}
            </div>

            {/* Bars — ultra compact */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <div className="flex items-center justify-between text-[9px]">
                  <span className="font-semibold uppercase tracking-wide text-muted-foreground">Running</span>
                  <span className="font-bold tabular-nums text-emerald-600">{total ? `${Math.round((running / total) * 100)}%` : '—'}</span>
                </div>
                <CompactBar value={running} total={total} color="bg-gradient-to-r from-emerald-500 to-emerald-400" />
              </div>
              <div>
                <div className="flex items-center justify-between text-[9px]">
                  <span className="font-semibold uppercase tracking-wide text-muted-foreground">Healthy</span>
                  <span className="font-bold tabular-nums text-sky-600">{total ? `${Math.round((healthy / total) * 100)}%` : '—'}</span>
                </div>
                <CompactBar value={healthy} total={total} color="bg-gradient-to-r from-sky-500 to-violet-500" />
              </div>
            </div>
          </div>

          {/* Colorful donuts */}
          <div className="flex shrink-0 items-center gap-1.5">
            <MiniDonut value={running} total={total} color="hsl(142 71% 45%)" label="RUN" />
            <MiniDonut value={healthy} total={total} color="hsl(199 89% 48%)" label="OK" />
          </div>
        </div>

        {/* Tiny latency/queue line */}
        <div className="mt-2 flex items-center gap-3 text-[10px] tabular-nums">
          <span className="flex items-center gap-1 text-muted-foreground">
            <Activity className="h-3 w-3 text-emerald-500" /> {avgEvents} ev
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <Timer className="h-3 w-3 text-sky-500" /> Q {totalQueue}
          </span>
          {issues > 0 && <span className="ml-auto rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">{issues} needs attention</span>}
        </div>

        {/* View details — compact */}
        {total > 0 && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-6 w-full justify-between rounded-md bg-muted/40 px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              <span className="flex items-center gap-1">
                <Cpu className="h-3 w-3" />
                {expanded ? 'Hide engines' : 'View details'}
                <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] font-bold shadow-sm">{total}</span>
              </span>
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </Button>

            {expanded && (
              <div className="mt-2 overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm">
                <div className="max-h-[280px] overflow-auto">
                  <table className="w-full text-left">
                    <thead className="sticky top-0 z-10 bg-gradient-to-r from-muted to-muted/60 backdrop-blur">
                      <tr className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                        <th className="px-2 py-1.5">Engine</th>
                        <th className="px-2 py-1.5 text-center">Status</th>
                        <th className="px-2 py-1.5 text-center">Health</th>
                        <th className="px-2 py-1.5 text-right">Q</th>
                        <th className="px-2 py-1.5 text-right">Ev</th>
                        <th className="px-2 py-1.5 text-right">Age</th>
                        <th className="px-2 py-1.5"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {engines.map((e) => {
                        const hl = healthLabel(e.health);
                        const sk = stateKey(e.state);
                        const isRunning = (e.state || '').toUpperCase() === 'RUNNING';
                        const isHealthy = (e.health || '').toUpperCase() === 'HEALTHY';
                        return (
                          <tr key={e.engineId} className={cn('group/row transition-colors hover:bg-gradient-to-r hover:from-muted/50 hover:to-transparent', !isHealthy && 'bg-amber-500/[0.04]', !isRunning && 'opacity-60')}>
                            <td className="px-2 py-1.5">
                              <span className="flex items-center gap-1.5">
                                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATE_DOT[sk])} />
                                <span className="max-w-[110px] truncate text-xs font-semibold leading-none">{e.engineName || e.engineId}</span>
                              </span>
                              <span className="text-[9px] leading-none text-muted-foreground">{e.engineCategory}</span>
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <span className={cn('inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none', isRunning ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/15' : 'bg-muted text-muted-foreground border border-border')}>
                                {e.state}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <span className={cn('inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-bold leading-none', hl.cls)}>
                                {hl.text}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-right text-xs tabular-nums">
                              <span className={cn('rounded px-1 py-0.5 font-medium', (e.metrics?.queueSize ?? 0) > 5 ? 'bg-amber-500/10 text-amber-600' : 'text-muted-foreground')}>{e.metrics?.queueSize ?? 0}</span>
                            </td>
                            <td className="px-2 py-1.5 text-right text-xs tabular-nums text-muted-foreground">{e.metrics?.eventCount ?? 0}</td>
                            <td className="px-2 py-1.5 text-right text-[11px] tabular-nums text-muted-foreground">
                              {ageLabel(e.lastHeartbeat ? e.lastHeartbeat * 1000 : null, serverNow) ?? '—'}
                            </td>
                            <td className="px-2 py-1.5">
                              <Link href={`/services/engines/${e.engineId}`} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {issues > 0 && (
                  <div className="flex items-center gap-2 border-t border-amber-500/20 bg-gradient-to-r from-amber-500/10 to-orange-500/5 px-2.5 py-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                    {issues} engine{issues > 1 ? 's' : ''} need attention
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {total === 0 && (
          <p className="mt-2 rounded-md bg-gradient-to-r from-muted/60 to-muted/30 px-2.5 py-2 text-center text-xs text-muted-foreground">
            No engines yet — backend starting…
          </p>
        )}
      </CardContent>
    </Card>
  );
}
