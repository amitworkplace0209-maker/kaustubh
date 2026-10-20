'use client';

// Unified page — SAME component as /data-saver/watch-list.
// Single source: components/watchlist/unified-watchlist.tsx
import UnifiedWatchlist from '@/components/watchlist/unified-watchlist';
import { TerminalRouteGate } from '@/components/terminal/route-scope';

export default function TradingWatchlistPage() {
  return (
    <TerminalRouteGate path="/trading/watchlist" allowed={['dummy', 'kotak-neo']}>
      <UnifiedWatchlist />
    </TerminalRouteGate>
  );
}
