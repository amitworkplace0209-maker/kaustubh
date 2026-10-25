'use client';

// Compact engine + backend indicator chips shown at the top of every
// dashboard page. Fetches engine statuses from /api/services/engines and
// backend health from SystemProvider — never fabricates state.

import { useEffect, useState } from 'react';
import { Cpu, Server } from 'lucide-react';
import { useSystem } from '@/components/system-provider';
import { cn } from '@/lib/utils';

type EngineStatus = {
  engineId: string;
  engineName: string;
  state: string;
  health: string;
};

const DOT: Record<string, string> = {
  healthy: 'bg-success',
  running: 'bg-success',
  started: 'bg-success',
  active: 'bg-success',
  degraded: 'bg-warning',
  unhealthy: 'bg-destructive',
  stopped: 'bg-muted-foreground/40',
  idle: 'bg-muted-foreground/40',
  unknown: 'bg-muted-foreground/40',
};

function chipDot(engine: EngineStatus) {
  const key = (engine.health || engine.state || 'unknown').toLowerCase();
  return DOT[key] ?? DOT.unknown;
}

function chipTitle(e: EngineStatus) {
  return `${e.engineName}: ${e.health || e.state || 'unknown'}`;
}

/** Backend + engine indicator chips — compact row at page top. */
export function EngineIndicatorChips({ className }: { className?: string }) {
  const { state: sysState } = useSystem();
  const [engines, setEngines] = useState<EngineStatus[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/services/engines', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const list: EngineStatus[] = json?.data ?? [];
        setEngines(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const backendOk = sysState === 'ok';

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {/* Backend chip */}
      <span
        className="inline-flex items-center gap-1 rounded-full border border-border bg-card/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums shadow-sm"
        title={`Backend: ${backendOk ? 'reachable' : sysState}`}
      >
        <Server className="h-3 w-3 shrink-0" />
        <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', backendOk ? 'bg-success' : sysState === 'loading' ? 'bg-warning animate-pulse' : 'bg-destructive')} />
        Backend
      </span>

      {/* Engine chips */}
      {engines.map((e) => (
        <span
          key={e.engineId}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-card/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums shadow-sm"
          title={chipTitle(e)}
        >
          <Cpu className="h-3 w-3 shrink-0" />
          <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', chipDot(e))} />
          {e.engineName || e.engineId}
        </span>
      ))}
    </div>
  );
}
