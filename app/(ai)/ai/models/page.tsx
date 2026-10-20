'use client';

import { Boxes, Play, Square, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader, SectionCard, StatusBadge, LoadingState, ErrorState, EmptyState } from '@/components/design-system';
import { useSharedPolling, invalidateCache } from '@/lib/shared-request';
import { aiModels, aiModelStart, aiModelStop } from '@/lib/ai-api';

export default function AiModelsPage() {
  const { data, loading, error, } = useSharedPolling('ai:models', aiModels, { intervalMs: 6000, ttlMs: 4000 });

  if (loading && !data) return <LoadingState text="Loading models..." />;
  if (error && !data) return <ErrorState message={error} />;

  const models = data?.models ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title="Models" subtitle="Registered local models and their runtime state" />
      <SectionCard title={`Models (${models.length})`} icon={Boxes}>
        {models.length === 0 ? (
          <EmptyState icon={Boxes} title="No models registered" description="Train a model to register it here" />
        ) : (
          <div className="space-y-3">
            {models.map((m: any) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{m.name}</p>
                    <StatusBadge status={m.status === 'running' ? 'success' : m.status === 'trained' ? 'info' : 'neutral'} label={m.status} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    v{m.version} · {m.artifact} · created {m.created ? new Date(m.created).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}
                  </p>
                  {m.metrics && Object.keys(m.metrics).length > 0 && (
                    <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">epochs={m.metrics.epochs} · points={m.metrics.points}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {m.id === 'reg-default' && (
                    <Button
                      size="sm" variant="outline" className="gap-1"
                      onClick={() => { void (m.status === 'running' ? aiModelStop(m.id) : aiModelStart(m.id)).then(() => invalidateCache('ai:models')); }}
                    >
                      {m.status === 'running' ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                      {m.status === 'running' ? 'Stop' : 'Start'}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost"><Cpu className="h-3 w-3" /> Details</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
