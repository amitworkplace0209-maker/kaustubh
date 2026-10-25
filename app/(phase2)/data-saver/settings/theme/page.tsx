'use client';

import { ThemeStudio } from '@/components/theme/theme-studio';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { StatusBadge } from '@/components/design-system';
import { TOTAL_THEME_COUNT } from '@/lib/phase2-theme';

export default function ThemeSettingsPage() {
  return (
    <SettingsSectionBody
      sectionId="theme"
      heroRight={<StatusBadge status="info" label={`${TOTAL_THEME_COUNT} presets`} />}
      extra={
        <ThemeStudio
          scope={{
            appId: 'data-saver',
            scope: null,
            label: 'Data Saver',
          }}
        />
      }
      footer={null}
    />
  );
}