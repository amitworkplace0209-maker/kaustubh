'use client';

import { SettingsWorkbench } from '@/components/settings/workbench';

/**
 * Unified settings workbench for every terminal mode.
 *
 * The previous route branched between DummyGate/DummySettings, the legacy
 * trading settings page and a Shoonya-only theme card. All three now share the
 * same backend-driven catalogue, audit trail, staged bulk editor and security
 * controls — the active mode only changes which profile-specific panels are
 * highlighted.
 */
export default function TradingSettingsPage() {
  return <SettingsWorkbench />;
}
