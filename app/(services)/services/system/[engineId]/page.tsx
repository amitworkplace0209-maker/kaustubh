'use client';

import { use } from 'react';
import ProfilePage from '@/app/_pages/system/profile';

/**
 * SERVICES → System → Engine Profile (canonical detail page).
 * One full profile/detail page per engine: hero, actions, stat cards,
 * chart cards, detail dropdowns, related engines + workspace links.
 */
export default function SystemEngineDetailPage({
  params,
}: {
  params: Promise<{ engineId: string }>;
}) {
  const { engineId } = use(params);
  return <ProfilePage engineId={decodeURIComponent(engineId)} />;
}
