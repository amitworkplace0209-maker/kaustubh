'use client';

import dynamic from 'next/dynamic';

const OriginalPage = dynamic(() => import('@/app/_pages/downloads/schedules/new/page'), {
  loading: () => (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 bg-white/5 rounded w-48" />
      <div className="h-96 bg-white/5 rounded-xl" />
    </div>
  ),
});

export default function DataSchedulesNewPage() {
  return <OriginalPage />;
}
