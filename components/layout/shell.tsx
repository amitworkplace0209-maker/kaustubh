'use client';

import { AppShell } from '@/components/layout/app-shell';
import { getShellConfig, getTradingShellConfig, type ShellWorkspace } from '@/components/layout/nav';
import { useTradingMode } from '@/lib/settings-store';

export { type ShellWorkspace };

/**
 * Shell — the canonical global frame for a phase workspace.
 *
 * Thin, config-only entry: resolves the active ShellConfig for the workspace
 * (trading becomes terminal-aware via getTradingShellConfig), then hands off to
 * AppShell (GlobalTopBar + PhaseShell + PhaseMobileNavigation + GlobalOverlays).
 *
 * The provider tree (Theme/Phase/Terminal/Realtime) lives ABOVE in the root
 * AppProviders and never remounts on route navigation.
 */
export function Shell({
  workspace = 'data-saver',
  children,
}: {
  workspace?: ShellWorkspace;
  children: React.ReactNode;
}) {
  const tradingMode = useTradingMode();
  const base = getShellConfig(workspace);
  const config = base.id === 'trading' ? getTradingShellConfig(tradingMode) : base;
  return <AppShell config={config}>{children}</AppShell>;
}