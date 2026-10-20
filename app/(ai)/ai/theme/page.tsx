'use client';

import { ThemeStudio } from '@/components/theme/theme-studio';
import { PageHeader } from '@/components/design-system';

export default function AiThemePage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Theme Studio" subtitle="Universal theme customization for Khumbha AI" />
      <ThemeStudio
        scope={{
          appId: 'khumbha-ai',
          scope: null,
          label: 'Khumbha AI',
        }}
      />
    </div>
  );
}