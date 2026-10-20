'use client';

import DashboardPage from '@/app/_pages/dashboard/page';
import DummyDashboard from '@/components/dummy/pages/dashboard';
import { ShoonyaDashboardPage } from '@/components/shoonya/dashboard';
import { useTradingMode } from '@/lib/settings-store';

/**
 * /trading/dashboard — routes by the CANONICAL terminal identity.
 *
 * Routing is decided ONLY by the backend-synced mode (TerminalModeReconciler
 * keeps settings-store in lockstep with session_manager.mode), so a real broker
 * context can never render the dummy terminal:
 *   dummy   → DummyDashboard            (virtual engine — labelled SIMULATION)
 *   shoonya → ShoonyaDashboardPage      (real adapter + status context)
 *   kotak   → DashboardPage             (real Kotak Neo adapter)
 */
export default function TradingDashboardPage() {
  const mode = useTradingMode();
  if (mode === 'shoonya') return <ShoonyaDashboardPage />;
  if (mode === 'kotak-neo') return <DashboardPage />;
  return <DummyDashboard />;
}