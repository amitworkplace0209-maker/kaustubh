'use client';
import ServiceControlCenter from '@/app/_pages/system/page';

/**
 * SERVICES → landing page.
 *
 * This IS the Service Control Center: every backend engine with its state,
 * lifecycle controls and its own settings. It used to redirect to
 * /services/system, which made the root URL render nothing of its own — opening
 * /services now lands directly on the fleet, and /services/system keeps working
 * as the same page for anyone who bookmarked it.
 */

export default function ServicesRootPage() {
  return <ServiceControlCenter />;
}