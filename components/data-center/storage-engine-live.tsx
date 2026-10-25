'use client';

import { useMemo } from 'react';
import {
  Activity, Cpu, Database, HardDrive, MemoryStick, Network, Server,
  Timer, Zap, AlertTriangle, Gauge,
} from 'lucide-react';
import { MetricCard, SectionCard, StatusBadge, StatCard } from '@/components/design-system';
import { useEngineStatus, useEngines } from '@/lib/engine-realtime';
import { fmtBytes, fmtUptime } from '@/lib/data-center';
import { Skeleton } from '@/components/ui/skeleton';

type StorageEngineData = {
  engine?: {
    health: string;
    state: string;
    version?: string;
    metrics?: { custom?: Record<string, any> };
    latest?: {
      environment?: { hostname?: string; type?: string; runtimeVersion?: string; os?: string };
      host?: {
        cpu?: { usagePct?: number; logicalCores?: number };
        memory?: { usagePct?: number; totalBytes?: number; usedBytes?: number };
        disk?: { usagePct?: number; totalBytes?: number; usedBytes?: number; freeBytes?: number };
        network?: { rxBytes?: number; txBytes?: number };
        uptimeSeconds?: number;
        load?: { load1m?: number; load5m?: number };
      };
      runtime?: { pid?: number; version?: string; memoryMb?: number; cpuPct?: number; threads?: number; uptimeSeconds?: number };
      database?: { connected?: boolean; readLatencyMs?: number; writeLatencyMs?: number; queueDepth?: number; pipelineRunning?: boolean; status?: string };
      application?: { state?: string; reasons?: string[] };
      thresholds?: Record<string, string>;
      updatedAt?: string;
    };
    configSummary?: Record<string, any>;
  };
  state?: Record<string, any>;
};

function LatencyTone(ms: number | null | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (ms == null) return 'neutral';
  if (ms >= 1000) return 'danger';
  if (ms >= 250) return 'warning';
  return 'success';
}

function PercentTone(pct: number | null | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (pct == null) return 'neutral';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warning';
  return 'success';
}

function AppHealthBadge({ state }: { state?: string }) {
  const s = (state ?? 'UNKNOWN').toUpperCase();
  if (s === 'HEALTHY') return <StatusBadge status="success" label="HEALTHY" />;
  if (s === 'DEGRADED') return <StatusBadge status="warning" label="DEGRADED" />;
  if (s === 'CRITICAL') return <StatusBadge status="danger" label="CRITICAL" />;
  return <StatusBadge status="neutral" label={s} />;
}

export function StorageEngineLivePanel() {
  const { data, error, source, connected } = useEngineStatus<StorageEngineData>('storage_engine', '/api/services/storage');
  const { engines } = useEngines();

  const latest = data?.engine?.latest ?? data?.state ?? null;
  const host = latest?.host;
  const runtime = latest?.runtime;
  const database = latest?.database;
  const application = latest?.application;

  const isLive = connected && source === 'realtime';
  const fallbackLoading = !data && !error;

  // Derive realtime storage engine from engines map if engine status hook hasn't yet pushed (covers initial render)
  const storageFromRegistry = (engines as Record<string, any>)?.['storage_engine'];
  const showLive = isLive || !!storageFromRegistry;

  if (fallbackLoading) {
    return (
      <SectionCard title="Storage Engine — Live Infrastructure" icon={Server}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      </SectionCard>
    );
  }

  if (error && !data) {
    return (
      <SectionCard title="Storage Engine — Live Infrastructure" icon={Server}>
        <p className="py-6 text-center text-xs text-destructive">Storage engine unreachable: {error}</p>
      </SectionCard>
    );
  }

  const cpuPct = host?.cpu?.usagePct ?? null;
  const memPct = host?.memory?.usagePct ?? null;
  const diskPct = host?.disk?.usagePct ?? null;
  const memUsed = host?.memory?.usedBytes ?? null;
  const diskUsed = host?.disk?.usedBytes ?? null;
  const diskTotal = host?.disk?.totalBytes ?? null;
  const netRx = host?.network?.rxBytes ?? null;
  const netTx = host?.network?.txBytes ?? null;
  const queueDepth = database?.queueDepth ?? null;
  const readLatency = database?.readLatencyMs ?? null;

  return (
    <SectionCard
      title="Storage Engine — Live Infrastructure"
      icon={Server}
      headerRight={
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${showLive ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${showLive ? 'text-success' : 'text-muted-foreground'}`}>
            {showLive ? (isLive ? 'Realtime' : 'Live') : 'Polling'}
          </span>
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            {source === 'realtime' ? 'WS#2' : source === 'api' ? 'REST fallback' : ''}
          </span>
          <StatusBadge status={application?.state === 'HEALTHY' ? 'success' : application?.state === 'DEGRADED' ? 'warning' : application?.state === 'CRITICAL' ? 'danger' : 'neutral'} label={application?.state ?? 'UNKNOWN'} />
        </div>
      }
    >
      <div className="space-y-3">
        {/* KPI row — fast glance */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard icon={Cpu} title="Host CPU" tone={PercentTone(cpuPct)} value={cpuPct != null ? `${cpuPct.toFixed(1)}%` : 'N/A'} sub={host?.cpu?.logicalCores ? `${host.cpu.logicalCores} cores` : undefined} />
          <StatCard icon={MemoryStick} title="Host Memory" tone={PercentTone(memPct)} value={memPct != null ? `${memPct.toFixed(1)}%` : 'N/A'} sub={memUsed ? fmtBytes(memUsed) : undefined} />
          <StatCard icon={HardDrive} title="Disk" tone={PercentTone(diskPct)} value={diskPct != null ? `${diskPct.toFixed(1)}%` : 'N/A'} sub={diskUsed && diskTotal ? `${fmtBytes(diskUsed)} / ${fmtBytes(diskTotal)}` : undefined} />
          <StatCard icon={Database} title="DB Queue" tone={queueDepth != null && queueDepth > 5000 ? 'warning' : queueDepth != null && queueDepth > 9000 ? 'danger' : 'neutral'} value={queueDepth != null ? queueDepth.toLocaleString('en-IN') : 'N/A'} sub={database?.pipelineRunning != null ? (database.pipelineRunning ? 'pipeline running' : 'idle') : undefined} />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {/* Host detail */}
          <div className="rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><Activity className="h-3 w-3" />Host</p>
            <div className="space-y-1.5 text-[11px]">
              <div className="flex justify-between"><span className="text-muted-foreground">Hostname</span><span className="font-mono font-medium">{latest?.environment?.hostname ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Uptime</span><span className="tabular-nums">{fmtUptime(host?.uptimeSeconds ?? null)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Load 1m/5m</span><span className="tabular-nums">{host?.load?.load1m ?? '—'} / {host?.load?.load5m ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Network RX/TX</span><span className="tabular-nums">{netRx != null ? fmtBytes(netRx) : '—'} / {netTx != null ? fmtBytes(netTx) : '—'}</span></div>
            </div>
          </div>

          {/* Runtime detail */}
          <div className="rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><Zap className="h-3 w-3" />Runtime</p>
            <div className="space-y-1.5 text-[11px]">
              <div className="flex justify-between"><span className="text-muted-foreground">PID</span><span className="font-mono">{runtime?.pid ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Python</span><span className="font-mono">{runtime?.version ?? latest?.environment?.runtimeVersion ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Process CPU/Mem</span><span className="tabular-nums">{runtime?.cpuPct != null ? `${runtime.cpuPct}%` : '—'} / {runtime?.memoryMb != null ? `${runtime.memoryMb} MB` : '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Threads / Uptime</span><span className="tabular-nums">{runtime?.threads ?? '—'} / {fmtUptime(runtime?.uptimeSeconds ?? null)}</span></div>
            </div>
          </div>

          {/* DB + Application */}
          <div className="rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><Gauge className="h-3 w-3" />Database & App</p>
            <div className="space-y-1.5 text-[11px]">
              <div className="flex justify-between"><span className="text-muted-foreground">DB Status</span><span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${database?.connected ? 'bg-success' : 'bg-destructive'}`} />{database?.status ?? (database?.connected ? 'CONNECTED' : 'DISCONNECTED')}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Read Latency</span><span className={`tabular-nums ${LatencyTone(readLatency) === 'danger' ? 'text-destructive' : LatencyTone(readLatency) === 'warning' ? 'text-warning' : 'text-success'}`}>{readLatency != null ? `${readLatency}ms` : '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Write Backlog</span><span className="tabular-nums">{queueDepth != null ? queueDepth.toLocaleString('en-IN') : '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">App Health</span><AppHealthBadge state={application?.state} /></div>
              {application?.reasons?.slice(0, 1).map((r: string, i: number) => (
                <p key={i} className="truncate pt-1 text-[10px] text-muted-foreground" title={r}>{r}</p>
              ))}
            </div>
          </div>
        </div>

        {/* Updated footer */}
        <p className="flex items-center gap-1.5 px-0.5 text-[10px] text-muted-foreground">
          <Timer className="h-3 w-3" />
          Updated {latest?.updatedAt ? new Date(latest.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '—'} IST
          <span className="ml-auto hidden items-center gap-1 sm:inline-flex"><Network className="h-3 w-3" />Sample every {data?.engine?.configSummary?.sampleIntervalSeconds ?? 5}s · history {data?.engine?.metrics?.custom?.historyLength ?? '—'} points</span>
        </p>
      </div>
    </SectionCard>
  );
}
