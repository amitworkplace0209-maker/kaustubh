'use client';

import MarketWatchLivePage from '@/components/market-watch/market-watch-live';
import { ShoonyaTradeGate } from '@/components/shoonya/status';
import { useTradingMode } from '@/lib/settings-store';

/**
 * /trading/market-watch — read-only LIVE terminal view.
 *
 * All engine control (lifecycle, settings, filters, pins, ranking) lives on the
 * Service Phase Market Watch page. This route only renders what the shared
 * realtime socket delivers and shows "No data" when nothing has arrived, so it
 * can never block or hang the shell.
 */
export default function TradingMarketWatchPage() {
  const mode = useTradingMode();
  if (mode === 'shoonya') {
    return (
      <ShoonyaTradeGate>
        <MarketWatchLivePage />
      </ShoonyaTradeGate>
    );
  }
  return <MarketWatchLivePage />;
}