'use client';

import { Database, FileText } from 'lucide-react';
import { PageHeader, SectionCard, LoadingState, ErrorState, EmptyState } from '@/components/design-system';
import { useSharedPolling } from '@/lib/shared-request';
import { aiDatasets } from '@/lib/ai-api';

export default function AiDatasetsPage() {
  const { data, loading, error } = useSharedPolling('ai:datasets', aiDatasets, { intervalMs: 6000, ttlMs: 4000 });

  if (loading && !data) return <LoadingState text="Loading datasets..." />;
  if (error && !data) return <ErrorState message={error} />;

  const datasets = data?.datasets ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title="Datasets" subtitle="Numeric datasets registered during training (real input)" />
      <SectionCard title={`Datasets (${datasets.length})`} icon={Database}>
        {datasets.length === 0 ? (
          <EmptyState icon={Database} title="No datasets yet" description="Datasets are registered when you run a training job" />
        ) : (
          <div className="space-y-2">
            {datasets.map((d: any) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{d.name}</span>
                </span>
                <span className="text-muted-foreground tabular-nums">{d.points} points</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
