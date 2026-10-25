'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Runs was renamed to History — keep the old URL working via redirect.
export default function ServicesSchedulerRunsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/services/scheduler/history');
  }, [router]);
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 bg-white/5 rounded w-48" />
      <div className="h-96 bg-white/5 rounded-xl" />
    </div>
  );
}
