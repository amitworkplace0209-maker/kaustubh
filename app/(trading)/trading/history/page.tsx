'use client';

import { HistoryPage } from '@/components/orders/history/history-page';
import { TerminalRouteGate } from '@/components/terminal/route-scope';
import { useTradingMode } from '@/lib/settings-store';

export default function TradingHistoryPage() {
  const mode = useTradingMode();
  return (
    <TerminalRouteGate path="/trading/history" allowed={['dummy', 'kotak-neo']}>
      <HistoryPage mode={mode} />
    </TerminalRouteGate>
  );
}