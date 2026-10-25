'use client';

import { useMemo, useState } from 'react';
import { Activity, Boxes, CheckCircle2, Cpu, Database, Globe, Layers, PauseCircle, PlayCircle, Radio, Search, Server, Shield, Workflow, Zap, AlertTriangle, Clock3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard, StatusBadge } from '@/components/design-system';
import { useEngines } from '@/lib/engine-realtime';
import { Skeleton } from '@/components/ui/skeleton';

// Keys are the backend's `EngineCategory` values (core/engines/engine_base.py),
// lower-cased at lookup time — `MARKET_DATA` and `CONTROL` cover the two largest
// engine groups, so they must resolve or the cards fall back to a generic icon.
const CATEGORY_ICON: Record<string, any> = {
  storage: Server,
  events: Activity,
  scheduler: Clock3,
  telemetry: Zap,
  trading: Boxes,
  core: Cpu,
  system: Shield,
  data: Database,
  market: Radio,
  ai: Layers,
  connectivity: Globe,
  market_data: Radio,
  control: Shield,
};

const CATEGORY_COLOR: Record<string, string> = {
  storage: 'text-cyan-600',
  events: 'text-teal-600',
  scheduler: 'text-orange-600',
  telemetry: 'text-purple-600',
  trading: 'text-success',
  core: 'text-blue-600',
  data: 'text-teal-600',
  market_data: 'text-success',
  control: 'text-orange-600',
  ai: 'text-purple-600',
};

/** Normalise `MARKET_DATA` / `market_data` / `marketData` to one lookup key. */
function categoryKey(engine: any): string {
  const raw = String(engine?.engineCategory ?? engine?.category ?? 'core');
  return raw.toLowerCase().replace(/[\s-]+/g, '_');
}

function healthBadge(health?: string, state?: string) {
  const h = (health ?? '').toUpperCase();
  const s = (state ?? '').toUpperCase();
  if (h === 'HEALTHY' || s === 'RUNNING') return <StatusBadge status="success" label={h || s} />;
  if (h === 'DEGRADED' || s === 'DEGRADED' || s === 'IDLE') return <StatusBadge status="warning" label={h || s} />;
  if (h === 'UNHEALTHY' || h === 'ERROR' || s === 'ERROR' || s === 'STOPPED') return <StatusBadge status="danger" label={h || s} />;
  if (h === 'UNKNOWN' || s === 'UNKNOWN' || s === 'NOT_STARTED') return <StatusBadge status="neutral" label={h || s} />;
  return <StatusBadge status="neutral" label={h || s || 'UNKNOWN'} />;
}

function heartbeatAge(lastHeartbeat?: number | string | null): string {
  if (!lastHeartbeat) return '—';
  const t = typeof lastHeartbeat === 'string' ? new Date(lastHeartbeat).getTime() : (lastHeartbeat as number) * 1000 > 1e12 ? lastHeartbeat as number : (lastHeartbeat as number) * 1000;
  const ms = typeof lastHeartbeat === 'string' ? Date.now() - new Date(lastHeartbeat).getTime() : Date.now() - t;
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 5000) return 'just now';
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  return `${Math.round(ms / 3600000)}h ago`;
}

export function EnginesLiveGrid() {
  const { engines, connected, updatedAt } = useEngines();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [showAll, setShowAll] = useState(false);

  const list = useMemo(() => {
    const arr = Object.values(engines as Record<string, any>);
    // fallback: if realtime hasn't delivered yet, engines will be empty — show skeleton, not empty
    return arr.sort((a: any, b: any) => {
      // healthy first
      const ha = a.health ?? a.state ?? '';
      const hb = b.health ?? b.state ?? '';
      if (ha !== hb) return String(ha).localeCompare(String(hb));
      return String(a.engineId ?? '').localeCompare(String(b.engineId ?? ''));
    });
  }, [engines]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of list) if (e.engineCategory || e.category) set.add(categoryKey(e));
    return ['all', ...Array.from(set).sort()];
  }, [list]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter((e: any) => {
      const cat = categoryKey(e);
      if (category !== 'all' && cat !== category) return false;
      if (needle) {
        const hay = `${e.engineId} ${e.engineName} ${cat} ${e.state} ${e.health}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [list, q, category]);

  const visible = showAll ? filtered : filtered.slice(0, 12);
  const isEmptyRealtime = list.length === 0;

  return (
    <SectionCard
      title={`All Engines — Live (${filtered.length}/${list.length})`}
      icon={Workflow}
      headerRight={
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
          <span className={`hidden text-[10px] font-semibold uppercase tracking-wider sm:inline ${connected ? 'text-success' : 'text-muted-foreground'}`}>{connected ? 'Realtime WS#2' : 'Connecting...'}</span>
          {updatedAt && <span className="hidden text-[10px] tabular-nums text-muted-foreground sm:inline">{new Date(updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST</span>}
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search engines…" className="h-8 w-44 rounded-lg border border-border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/50 sm:w-56" />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {categories.map((c) => (
            <Button key={c} size="sm" variant={category === c ? 'default' : 'ghost'} className={`h-7 text-[11px] capitalize ${category === c ? '' : 'text-muted-foreground'}`} onClick={() => setCategory(c)}>
              {c}
            </Button>
          ))}
        </div>
        {filtered.length > 12 && (
          <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1 text-[11px]" onClick={() => setShowAll((v) => !v)}>
            {showAll ? <PauseCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
            {showAll ? 'Show top' : `Show all ${filtered.length}`}
          </Button>
        )}
      </div>

      {isEmptyRealtime ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[96px] rounded-xl" />
          ))}
          <p className="col-span-full py-2 text-center text-[11px] text-muted-foreground">Connecting to engine registry… realtime snapshot arrives within seconds via WS#2. Falls back to REST if gateway offline.</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">No engines match filters.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((e: any) => {
            const Icon = CATEGORY_ICON[categoryKey(e)] ?? Boxes;
            const cat = categoryKey(e) || 'core';
            const hb = e.lastHeartbeat ?? e.updatedAt ?? e.lastHeartbeatAt ?? null;
            return (
              <div key={e.engineId} className="flex flex-col justify-between gap-2 rounded-xl border border-border/60 bg-card/40 p-3 transition-colors hover:bg-card/70">
                <div className="flex items-start justify-between gap-2">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 ring-1 ring-border/40 ${CATEGORY_COLOR[cat] ?? 'text-muted-foreground'}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  {healthBadge(e.health, e.state)}
                </div>
                <div>
                  <p className="truncate text-[11px] font-semibold leading-4">{e.engineName ?? e.engineId}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{e.engineId}</p>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1 text-[10px]">
                  <span className="truncate capitalize text-muted-foreground">{cat.replace(/_/g, ' ')} · v{e.version ?? '—'}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground" title={String(hb ?? '')}>{heartbeatAge(hb)}</span>
                </div>
                {e.healthReason && <p className="truncate text-[10px] text-muted-foreground" title={e.healthReason}>{e.healthReason}</p>}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <AlertTriangle className="h-3 w-3" />
        Live via Connection Engine (WS#2) — single realtime socket for the whole session. One snapshot for all engines, no polling storm.
      </p>
    </SectionCard>
  );
}
