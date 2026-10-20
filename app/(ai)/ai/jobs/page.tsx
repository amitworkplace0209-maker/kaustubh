'use client';

import { History } from 'lucide-react';
import { PageHeader, SectionCard, StatusBadge, LoadingState, ErrorState, EmptyState } from '@/components/design-system';
import { useSharedPolling } from '@/lib/shared-request';
import { aiJobs } from '@/lib/ai-api';

export default function AiJobsPage() {
  const { data, loading, error } = useSharedPolling('ai:jobs', aiJobs, { intervalMs: 4000, ttlMs: 3000 });

  if (loading && !data) return <LoadingState text="Loading jobs..." />;
  if (error && !data) return <ErrorState message={error} />;

  const jobs = data?.jobs ?? [];

  const statusTone = (s: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' =>
    s === 'done' ? 'success' : s === 'failed' ? 'danger' : s === 'cancelled' ? 'neutral' : 'info';

  return (
    <div className="space-y-5">
      <PageHeader title="Jobs" subtitle="Training and inference job history (real)" />
      <SectionCard title={`Jobs (${jobs.length})`} icon={History}>
        {jobs.length === 0 ? (
          <EmptyState icon={History} title="No jobs yet" description="Training and inference run here" />
        ) : (
          <div className="space-y-2">
            {[...jobs].reverse().map((j: any) => (
              <div key={j.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{j.kind}</span>
                    <StatusBadge status={statusTone(j.status)} label={j.status} />
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">#{j.id}</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-cyan-500 transition-all"
                    style={{ width: `${Math.min(100, j.progress ?? 0)}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                  <span>{j.progress ?? 0}%</span>
                  {j.result?.outputs ? (
                    <span>{j.result.outputs.length} outputs · {j.result.latencyMs}ms</span>
                  ) : j.result?.theta ? (
                    <span>theta: {j.result.theta.map((t: number) => t.toFixed(2)).join(', ')}</span>
                  ) : null}
                </div>
                {j.message ? <p className="mt-1 text-xs text-destructive">{j.message}</p> : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
