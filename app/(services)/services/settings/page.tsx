'use client';

import { ThemeStudio } from '@/components/theme/theme-studio';
import { PageHeader } from '@/components/design-system';
import OriginalPage from '@/app/_pages/settings/page';

export default function ServicesSettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Services Settings" subtitle="Universal settings and theme customization for Services" />
      <OriginalPage />
      <div className="rounded-xl border border-border bg-card p-5 md:p-6">
        <PageHeader title="Theme Studio" subtitle="Appearance customization for Services workspace" />
        <ThemeStudio
          scope={{
            appId: 'services',
            scope: null,
            label: 'Services',
          }}
        />
      </div>
    </div>
  );
}
