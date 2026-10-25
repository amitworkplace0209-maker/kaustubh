'use client';

import dynamic from 'next/dynamic';

const DashboardPage = dynamic(() => import('@/app/_pages/dashboard/page'), {
  loading: () => (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 bg-white/5 rounded w-48" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-32 bg-white/5 rounded-xl" />
        ))}
      </div>
    </div>
  ),
});

export default function DataDashboardPage() {
  return <DashboardPage />;
}
