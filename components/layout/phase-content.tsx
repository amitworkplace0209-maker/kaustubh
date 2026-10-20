'use client';

import { Suspense } from 'react';
import { LoadingFallback } from '@/components/layout/loading-fallback';

/** PhaseContent — the scrollable page area. Flex-1 with min-w-0 so the sidebar
 *  width (expanded/collapsed CSS vars) never overlaps or squashes the content.
 *  The bottom padding reserves EXACTLY the space the fixed mobile bottom bar
 *  occupies (bar height + device safe-area inset), so the last row of a page
 *  can never end up hidden behind the navigation bar. */
export function PhaseContent({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 min-w-0 overflow-auto p-3 pb-bottom-nav md:p-6 md:pb-6">
      <Suspense fallback={<LoadingFallback />}>{children}</Suspense>
    </main>
  );
}