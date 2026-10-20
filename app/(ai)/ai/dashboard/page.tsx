'use client';

import {
  Brain, Cpu, MemoryStick, HardDrive, Boxes, Activity, Zap, Layers,
} from 'lucide-react';
import { PageHeader, SectionCard, StatCard, StatusBadge, LoadingState, ErrorState, EmptyState } from '@/components/design-system';
import { useSharedPolling } from '@/lib/shared-request';
import { aiDashboard } from '@/lib/ai-api';
import { formatBytes } from '@/lib/format';

export default function AiDashboardPage() {
  const { data, loading, error } = useSharedPolling('ai:dashboard', aiDashboard, {
    intervalMs: 8000,
    ttlMs: 4000,
  });

  if (loading && !data) return <LoadingState text="Loading AI dashboard..." />;
  if (error && !data) return <ErrorState message={error} />;

  const hw = data?.cpu;
  const ram = data?.ram;
  const disk = data?.disk;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Khumbha AI Dashboard"
        subtitle="Local AI engine status, models, agents and infrastructure"
      >
        <StatusBadge status={data?.engineStatus === 'running' ? 'success' : 'danger'} label={data?.engineStatus ?? 'offline'} />
        <StatusBadge status="info" label={data?.gpu && data.gpu !== 'Unavailable' ? 'GPU Detected' : 'GPU Unavailable'} />
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Boxes} title="Models" value={data?.totalModels ?? '—'} sub={`${data?.activeModels ?? 0} active`} tone="blue" />
        <StatCard icon={Layers} title="Agents" value={data?.agents ?? '—'} sub="configured" tone="teal" />
        <StatCard icon={Activity} title="Running Jobs" value={data?.runningJobs ?? '—'} sub={`${data?.completedRuns ?? 0} completed runs`} tone="orange" />
        <StatCard icon={Zap} title="Engine Uptime" value={data?.uptimeSec != null ? `${Math.floor(data.uptimeSec / 60)}m` : '—'} sub="local runtime" tone="cyan" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <SectionCard title="Infrastructure" icon={Cpu}>
          <div className="space-y-3">
            <HardwareRow icon={Cpu} label="CPU" value={hw ? `${hw.cores} cores · ${hw.usagePct}%` : 'Unavailable'} />
            <HardwareRow icon={MemoryStick} label="RAM" value={ram ? `${formatBytes(ram.used)} / ${formatBytes(ram.total)} (${ram.usagePct}%)` : 'Unavailable'} />
            <HardwareRow icon={HardDrive} label="Disk" value={disk ? `${formatBytes(disk.used)} / ${formatBytes(disk.total)} (${disk.usagePct}%)` : 'Unavailable'} />
            <HardwareRow
              icon={Zap}
              label="GPU"
              value={
                data?.gpu && data.gpu !== 'Unavailable'
                  ? `${data.gpu}${data.vram ? ` · ${data.vram.used}/${data.vram.total}` : ''}`
                  : 'Unavailable'
              }
              tone={data?.gpu && data.gpu !== 'Unavailable' ? 'success' : 'neutral'}
            />
          </div>
        </SectionCard>

        <SectionCard title="AI Engine" icon={Brain}>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Engine status</span>
              <span className="font-medium">{data?.engineStatus ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Local runtime</span>
              <span className="font-medium">{data?.localRuntimeStatus ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Training jobs</span>
              <span className="font-medium tabular-nums">{data?.trainingJobs ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Inference jobs</span>
              <span className="font-medium tabular-nums">{data?.inferenceJobs ?? '—'}</span>
            </div>
          </div>
          {(!data?.models || data.models.length === 0) && (
            <div className="mt-3">
              <EmptyState icon={Boxes} title="No models registered" description="Train a model to see it here" />
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Recent Runs" icon={Activity}>
        {!data?.recentRuns || data.recentRuns.length === 0 ? (
          <EmptyState icon={Activity} title="No inference runs yet" description="Run an inference to record results" />
        ) : (
          <div className="space-y-2">
            {data.recentRuns.map((r: any) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                <span className="text-muted-foreground">Model {r.modelId}</span>
                <span className="tabular-nums">{r.n} inputs · {r.latencyMs}ms</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function HardwareRow({ icon: Icon, label, value, tone = 'neutral' }: {
  icon: React.ElementType; label: string; value: string; tone?: 'success' | 'neutral';
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset ${
        tone === 'success' ? 'bg-success/15 text-success ring-success/30' : 'bg-muted/70 text-muted-foreground ring-border/50'
      }`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="w-14 text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${tone === 'success' ? 'text-success' : ''}`}>{value}</span>
    </div>
  );
}
