'use client';

import FundsPage from '@/app/_pages/funds/page';
import { TerminalRouteGate } from '@/components/terminal/route-scope';

export default function TradingFundsPage() {
  return (
    <TerminalRouteGate path="/trading/funds" allowed={['kotak-neo']}>
      <FundsPage />
    </TerminalRouteGate>
  );
}