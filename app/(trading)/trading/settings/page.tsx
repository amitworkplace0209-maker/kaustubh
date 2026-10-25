'use client';

import SettingsPage from '@/app/_pages/settings/page';
import DummySettings from '@/components/dummy/pages/settings';
import { DummyGate } from '@/components/dummy/gate';
import { ShoonyaPending } from '@/components/shoonya/status';
import { ThemeStudio } from '@/components/theme/theme-studio';
import { useTradingMode } from '@/lib/settings-store';

export default function TradingSettingsPage() {
  const mode = useTradingMode();
  if (mode === 'shoonya') return <ShoonyaSettings />;
  return <DummyGate dummy={<DummySettings />} standard={<SettingsPage />} />;
}

/** Shoonya has no broker-backed settings form (OAuth-gated), but appearance
 *  is local — so the Theme studio stays available above the connection card. */
function ShoonyaSettings() {
  return (
    <div className="space-y-6">
      <ThemeStudio
        scope={{
          appId: 'trading',
          scope: 'shoonya',
          label: 'Shoonya Terminal',
        }}
      />
      <ShoonyaPending />
    </div>
  );
}
