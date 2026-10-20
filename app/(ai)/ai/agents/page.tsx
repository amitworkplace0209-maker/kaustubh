'use client';

import { Layers, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader, SectionCard, StatusBadge, LoadingState, ErrorState, EmptyState } from '@/components/design-system';
import { useSharedPolling, invalidateCache } from '@/lib/shared-request';
import { aiAgents, aiAgentStart, aiAgentStop } from '@/lib/ai-api';

export default function AiAgentsPage() {
  const { data, loading, error } = useSharedPolling('ai:agents', aiAgents, { intervalMs: 6000, ttlMs: 4000 });

  if (loading && !data) return <LoadingState text="Loading agents..." />;
  if (error && !data) return <ErrorState message={error} />;

  const agents = data?.agents ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title="Agents" subtitle="Local AI agents and their live state" />
      <SectionCard title={`Agents (${agents.length})`} icon={Layers}>
        {agents.length === 0 ? (
          <EmptyState icon={Layers} title="No agents configured" />
        ) : (
          <div className="space-y-3">
            {agents.map((a: any) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{a.name}</p>
                    <StatusBadge status={a.status === 'running' ? 'success' : 'neutral'} label={a.status} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {a.config?.kind ?? a.config?.description ?? '—'}
                    {a.last_run ? ` · last run ${new Date(a.last_run).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}
                  </p>
                </div>
                <Button
                  size="sm" variant="outline" className="gap-1"
                  onClick={() => { void (a.status === 'running' ? aiAgentStop(a.id) : aiAgentStart(a.id)).then(() => invalidateCache('ai:agents')); }}
                >
                  {a.status === 'running' ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                  {a.status === 'running' ? 'Stop' : 'Start'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
