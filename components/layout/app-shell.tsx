'use client';

import { cn } from '@/lib/utils';
import type { ShellConfig } from '@/components/layout/nav';
import { GlobalTopBar } from '@/components/layout/global-topbar';
import { PhaseShell } from '@/components/layout/phase-shell';
import { PhaseMobileNavigation } from '@/components/layout/phase-mobile-navigation';
import { GlobalOverlays } from '@/components/layout/global-overlays';
import { OfflineBanner } from '@/components/layout/offline-banner';
import {
  MobileNavDrawer,
  MobileNavProvider,
} from '@/components/layout/mobile-nav-drawer';

/**
 * AppShell — the ONE canonical global shell for every KAUSTUBH phase.
 *
 *   AppShell
 *    ├── GlobalTopBar        (status, session, theme, phase switcher, search)
 *    ├── PhaseShell
 *    │    ├── PhaseSidebar   (single reusable sidebar; CSS-var widths)
 *    │    └── PhaseContent   (scrollable page area, flex remainder)
 *    ├── PhaseMobileNavigation (mobile bottom tab bar — MAIN pages only)
 *    ├── MobileNavDrawer     (mobile sidebar — INNER pages + full nav tree)
 *    └── GlobalOverlays      (toasts)
 *
 * Mobile navigation model:
 *   · the BOTTOM BAR owns the main pages (one tap, always visible);
 *   · the SIDEBAR DRAWER owns every inner page and the full navigation tree.
 *
 * Mounted once per workspace layout (stable within a phase; providers live
 * above it in the root AppProviders and never remount on route navigation).
 */
export function AppShell({
  config,
  children,
}: {
  config: ShellConfig;
  children: React.ReactNode;
}) {
  return (
    <MobileNavProvider>
      <div className={cn('ws-phase2 flex h-dvh flex-col', config.wrapperClass)}>
        <GlobalTopBar config={config} />
        <OfflineBanner />
        <PhaseShell config={config}>{children}</PhaseShell>
        <PhaseMobileNavigation config={config} />
        <MobileNavDrawer config={config} />
        <GlobalOverlays />
      </div>
    </MobileNavProvider>
  );
}
