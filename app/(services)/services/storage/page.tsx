'use client';

import { Suspense } from 'react';
import OriginalPage from '@/app/_pages/storage/page';

export default function ServicesStoragePage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4 animate-pulse">
          <div className="h-8 w-56 rounded bg-white/5" />
          <div className="h-96 rounded-xl bg-white/5" />
        </div>
      }
    >
      <OriginalPage />
    </Suspense>
  );
}