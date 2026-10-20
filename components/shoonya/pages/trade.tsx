'use client';

import OrdersPage from '@/app/_pages/orders/page';
import { ShoonyaTradeGate } from '@/components/shoonya/status';

/**
 * Shoonya Trade — the Shoonya order desk. Reuses the canonical OrdersPage
 * (StockSearch → OrderEntry → BasketManager → HistoryView) when the broker
 * session is active. When not connected, the ShoonyaTradeGate renders the
 * connection-pending page with OAuth setup instructions.
 */
export default function ShoonyaTradePage() {
  return (
    <ShoonyaTradeGate>
      <OrdersPage />
    </ShoonyaTradeGate>
  );
}
