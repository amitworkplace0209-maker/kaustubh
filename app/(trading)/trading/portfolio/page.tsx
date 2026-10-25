'use client';

import PortfolioPage from '@/app/_pages/portfolio/page';
import DummyPortfolio from '@/components/dummy/pages/portfolio';
import { DummyGate } from '@/components/dummy/gate';
import { ShoonyaTradeGate } from '@/components/shoonya/status';
import { useTradingMode } from '@/lib/settings-store';

export default function TradingPortfolioPage() {
  const mode = useTradingMode();
  if (mode === 'shoonya') return <ShoonyaTradeGate><PortfolioPage /></ShoonyaTradeGate>;
  return <DummyGate dummy={<DummyPortfolio />} standard={<PortfolioPage />} />;
}