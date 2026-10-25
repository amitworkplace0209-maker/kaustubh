'use client';

import PositionsPage from '@/app/_pages/positions/page';
import DummyPositions from '@/components/dummy/pages/positions';
import { DummyGate } from '@/components/dummy/gate';
import { ShoonyaTradeGate } from '@/components/shoonya/status';
import { useTradingMode } from '@/lib/settings-store';

export default function TradingPositionsPage() {
  const mode = useTradingMode();
  if (mode === 'shoonya') return <ShoonyaTradeGate><PositionsPage /></ShoonyaTradeGate>;
  return <DummyGate dummy={<DummyPositions />} standard={<PositionsPage />} />;
}