'use client';

import { Suspense } from 'react';
import OriginalPage from '@/app/_pages/search/page';

export default function ServicesSearchPage() {
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