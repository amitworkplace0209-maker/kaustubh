'use client';

import { Settings2, Brain } from 'lucide-react';
import { PageHeader, SectionCard } from '@/components/design-system';
import { Badge } from '@/components/ui/badge';

export default function AiSettingsPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Khumbha AI local runtime configuration" />
      <SectionCard title="Local Runtime" icon={Brain}>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Endpoint</span>
            <span className="font-mono text-xs">{process.env.NEXT_PUBLIC_AI_API_BASE || 'http://127.0.0.1:8001'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Engine</span>
            <Badge variant="outline">numpy least-squares</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Autonomy</span>
            <span>Independent of trading backend</span>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
