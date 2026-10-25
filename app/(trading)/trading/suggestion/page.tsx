'use client';

import { SuggestionPage } from '@/components/orders/suggestion/suggestion-page';
import { TerminalRouteGate } from '@/components/terminal/route-scope';
import { useTradingMode } from '@/lib/settings-store';

export default function TradingSuggestionPage() {
  const mode = useTradingMode();
  return (
    <TerminalRouteGate path="/trading/suggestion" allowed={['dummy', 'kotak-neo']}>
      <SuggestionPage mode={mode} />
    </TerminalRouteGate>
  );
}