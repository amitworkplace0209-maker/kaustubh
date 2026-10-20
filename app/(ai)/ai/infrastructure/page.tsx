'use client';

import { Cpu, MemoryStick, HardDrive, Zap, MonitorCheck } from 'lucide-react';
import { PageHeader, SectionCard, StatusBadge, LoadingState, ErrorState } from '@/components/design-system';
import { useSharedPolling } from '@/lib/shared-request';
import { aiHardware } from '@/lib/ai-api';
import { formatBytes } from '@/lib/format';

export default function AiInfrastructurePage() {
  const { data, loading, error } = useSharedPolling('ai:hardware', aiHardware, { intervalMs: 6000, ttlMs: 5000 });

  if (loading && !data) return <LoadingState text="Reading infrastructure..." />;
  if (error && !data) return <ErrorState message={error} />;

  const cpu = data?.cpu;
  const ram = data?.ram;
  const disk = data?.disk;
  const gpuUnavailable = !data?.gpu || data.gpu === 'Unavailable';

  return (
    <div className="space-y-5">
      <PageHeader title="Infrastructure" subtitle="Live local hardware resources (real metrics)">
        <StatusBadge status={gpuUnavailable ? 'neutral' : 'success'} label={gpuUnavailable ? 'GPU Unavailable' : 'GPU Detected'} />
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          icon={Cpu} label="CPU" value={cpu ? `${cpu.cores} cores` : 'Unavailable'}
          sub={cpu ? `usage ${cpu.usagePct}%` : 'no data'}
        />
        <MetricCard icon={Zap} label="Uptime" value={data?.uptimeSec != null ? `${Math.floor(data.uptimeSec / 60)}m ${Math.floor(data.uptimeSec % 60)}s` : '—'} sub="local runtime" />
        <MetricCard
          icon={MemoryStick} label="RAM" value={ram ? formatBytes(ram.total) : 'Unavailable'}
          sub={ram ? `${formatBytes(ram.used)} used · ${ram.usagePct}%` : 'no data'}
        />
        <MetricCard
          icon={HardDrive} label="Disk" value={disk ? formatBytes(disk.total) : 'Unavailable'}
          sub={disk ? `${formatBytes(disk.free)} free · ${disk.usagePct}%` : 'no data'}
        />
        <MetricCard
          icon={MonitorCheck} label="GPU" value={gpuUnavailable ? 'Unavailable' : data.gpu}
          sub={data?.vram ? `VRAM ${data.vram.used}/${data.vram.total}` : 'no GPU detected'}
          tone={gpuUnavailable ? 'neutral' : 'success'}
        />
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, sub, tone = 'neutral' }: {
  icon: React.ElementType; label: string; value: string; sub: string; tone?: 'success' | 'neutral';
}) {
  return (
    <SectionCard>
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ring-inset ${
          tone === 'success' ? 'bg-success/15 text-success ring-success/30' : 'bg-muted/70 text-muted-foreground ring-border/50'
        }`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
          <p className={`truncate text-base font-semibold tabular-nums ${tone === 'success' ? 'text-success' : ''}`}>{value}</p>
          <p className="truncate text-[10px] text-muted-foreground tabular-nums">{sub}</p>
        </div>
      </div>
    </SectionCard>
  );
}
