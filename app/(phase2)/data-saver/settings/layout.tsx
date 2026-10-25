import type { Metadata } from 'next';
import { SettingsProvider } from '@/components/settings/settings-provider';
import {
  SettingsDesktopNav,
  SettingsMobileNav,
} from '@/components/settings/settings-navigation';

export const metadata: Metadata = {
  title: 'Settings · Data Saver',
};

const SETTINGS_PATH = '/data-saver/settings';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SettingsProvider>
      <div className="min-h-full">
        <SettingsMobileNav settingsPath={SETTINGS_PATH} />
        <div className="mx-auto grid max-w-[1480px] gap-6 px-3 py-4 md:grid-cols-[13rem_1fr] md:px-5 md:py-6">
          <SettingsDesktopNav settingsPath={SETTINGS_PATH} />
          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </SettingsProvider>
  );
}