'use client';

import OrderHistoryPage from '@/app/_pages/order-history/page';
import DummyOrderHistory from '@/components/dummy/pages/order-history';
import { DummyGate } from '@/components/dummy/gate';
import { ShoonyaTradeGate } from '@/components/shoonya/status';
import { useTradingMode } from '@/lib/settings-store';

export default function TradingOrderHistoryPage() {
  const mode = useTradingMode();
  if (mode === 'shoonya') return <ShoonyaTradeGate><OrderHistoryPage /></ShoonyaTradeGate>;
  return <DummyGate dummy={<DummyOrderHistory />} standard={<OrderHistoryPage />} />;
}