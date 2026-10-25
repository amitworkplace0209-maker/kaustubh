'use client';

import { use } from 'react';
import ProfilePage from '@/app/_pages/system/profile';

/**
 * SERVICES → System → Engine Profile (alias route).
 * Same full profile/detail page, reachable as
 * /services/system/profile/[engineId] as well.
 */
export default function SystemEngineProfileAliasPage({
  params,
}: {
  params: Promise<{ engineId: string }>;
}) {
  const { engineId } = use(params);
  return <ProfilePage engineId={decodeURIComponent(engineId)} />;
}
