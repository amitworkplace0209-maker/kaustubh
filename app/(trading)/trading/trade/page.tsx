'use client';

import { Suspense } from 'react';
import { TradePageClient } from '@/components/trading/trade-page-client';
import { TradePageSkeleton } from '@/components/trading/trade-page-skeleton';
import { TradeErrorBoundary } from '@/components/trading/trade-error-boundary';

/**
 * /trading/trade — the order ticket.
 *
 * The trade ticket is wrapped in an error boundary and a skeleton fallback so
 * a backend hiccup can never leave a blank screen on the one page where the
 * operator must keep working.
 */
export default function TradingTradePage() {
  return (
    <TradeErrorBoundary>
      <Suspense fallback={<TradePageSkeleton />}>
        <TradePageClient />
      </Suspense>
    </TradeErrorBoundary>
  );
}
