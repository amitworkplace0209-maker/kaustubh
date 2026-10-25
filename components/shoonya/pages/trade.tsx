'use client';

import { TradePage } from '@/components/trading/trade-page';
import { ShoonyaTradeGate } from '@/components/shoonya/status';

/**
 * Shoonya Trade — the Shoonya order desk.
 *
 * It renders the ONE canonical trade page. The page is terminal-aware: it
 * reads the active trading mode and routes a real broker order through the
 * Common Trading Core (`/api/terminal/order`, terminal `shoonya`), so the
 * Shoonya desk and the Kotak desk are the same surface with a different
 * adapter behind it — not two implementations of the same screen.
 *
 * When the Shoonya session is not connected, the gate renders the
 * connection-pending page with the OAuth setup instructions.
 */
export default function ShoonyaTradePage() {
  return (
    <ShoonyaTradeGate>
      <TradePage />
    </ShoonyaTradeGate>
  );
}
