'use client';

import { PhaseSidebar } from '@/components/layout/phase-sidebar';
import { PhaseContent } from '@/components/layout/phase-content';
import type { ShellConfig } from '@/components/layout/nav';

/** PhaseShell — the desktop two-column frame (sidebar + content) for one phase.
 *  Flex-based; the sidebar width comes from --sidebar-width-* CSS vars and the
 *  content automatically occupies the remaining space (no absolute offsets). */
export function PhaseShell({
  config,
  children,
}: {
  config: ShellConfig;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 min-h-0">
      <PhaseSidebar config={config} />
      <PhaseContent>{children}</PhaseContent>
    </div>
  );
}