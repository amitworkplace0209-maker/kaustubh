'use client';

import VmOverviewPage from '@/app/_pages/vm/overview-page';

/**
 * SERVICES → VM Management (overview).
 * Canonical page lives in `app/_pages/vm/overview-page` — this route only
 * re-exports it, matching every other services screen.
 */
export default function ServicesVmOverviewRoute() {
  return <VmOverviewPage />;
}
