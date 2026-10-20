'use client';

import { TerminalRouteGate } from '@/components/terminal/route-scope';
import HoldingsPage from '@/app/_pages/holdings/page';
import { ShoonyaTradeGate } from '@/components/shoonya/status';
import { useTradingMode } from '@/lib/settings-store';

/**
 * Holdings is a real-broker page (Kotak / Shoonya). The Dummy terminal has no
 * Holdings page — in Dummy mode this route redirects to the Dummy dashboard
 * (TerminalRouteGate, registry-driven via TERMINAL_ROUTES).
 */
export default function TradingHoldingsPage() {
  return (
    <TerminalRouteGate path="/trading/holdings" allowed={['kotak-neo', 'shoonya']}>
      <HoldingsInner />
    </TerminalRouteGate>
  );
}

function HoldingsInner() {
  const mode = useTradingMode();
  if (mode === 'shoonya')
    return (
      <ShoonyaTradeGate>
        <HoldingsPage />
      </ShoonyaTradeGate>
    );
  return <HoldingsPage />;
}
