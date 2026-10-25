'use client';

import FundsPage from '@/app/_pages/funds/page';
import { TerminalRouteGate } from '@/components/terminal/route-scope';

/**
 * Account is a real-broker page (Kotak funds ledger). The Dummy terminal has
 * no Account page — in Dummy mode this route redirects to the Dummy dashboard
 * (TerminalRouteGate, registry-driven via TERMINAL_ROUTES).
 */
export default function TradingAccountPage() {
  return (
    <TerminalRouteGate path="/trading/account" allowed={['kotak-neo']}>
      <FundsPage />
    </TerminalRouteGate>
  );
}
