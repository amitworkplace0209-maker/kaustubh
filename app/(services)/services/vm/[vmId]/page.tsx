'use client';

import { use } from 'react';
import VmDetailPage from '@/app/_pages/vm/detail-page';

/** SERVICES → VM Management → VM1 / VM2 detail. */
export default function ServicesVmDetailRoute({
  params,
}: {
  params: Promise<{ vmId: string }>;
}) {
  const { vmId } = use(params);
  return <VmDetailPage vmId={decodeURIComponent(vmId)} />;
}
