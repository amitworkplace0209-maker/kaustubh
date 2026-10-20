'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { History, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader, StatusBadge } from '@/components/design-system';
import { TradePage } from '@/components/orders/trade/trade-page';
import { ORDER_ROUTES } from '@/lib/order-workspace';
import { useTradingMode } from '@/lib/settings-store';
import { useRealtime } from '@/components/realtime-provider';

/** Orders — the order workspace.
 *
 *  The sidebar is the primary navigation: Suggestion / History live
 *  on their own routes. This page owns no in-page Trade/Basket/History tabs —
 *  it starts directly with status + search + quote + order entry, reusing the
 *  real Trade engine components (Search Engine, adapter quotes, Risk Engine,
 *  broker margin API, Dummy server preview). */
export default function OrdersPage() {
  const router = useRouter();
  const mode = useTradingMode();
  const rt = useRealtime();
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const marketRaw = String(
    (rt.marketState as Record<string, any> | null)?.market_state ??
      (rt.marketState as Record<string, any> | null)?.state ??
      'UNKNOWN',
  ).toUpperCase();
  const marketOpen = marketRaw === 'OPEN';
  const marketTone = marketRaw === 'UNKNOWN' ? 'neutral' : marketOpen ? 'success' : 'warning';

  const sessionLabel =
    rt.sessionStatus && rt.sessionStatus !== 'UNKNOWN'
      ? rt.sessionStatus.replace(/_/g, ' ').toLowerCase()
      : rt.sessionActive === true
        ? 'session active'
        : rt.sessionActive === false
          ? 'no session'
          : 'session unknown';
  const sessionTone =
    rt.sessionActive === true ? 'success' : rt.sessionActive === false ? 'warning' : 'neutral';

  const accountLabel =
    mode === 'dummy' ? 'Dummy' : mode === 'shoonya' ? 'Shoonya' : 'Kotak Neo';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Orders"
        subtitle={`${accountLabel} · order workspace`}
      >
        <StatusBadge status={sessionTone} label={sessionLabel} />
        <StatusBadge status={marketTone} label={marketOpen ? 'Market open' : `Market ${marketRaw.toLowerCase()}`} />
        <span className="hidden sm:inline-flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={refresh} aria-label="Refresh workspace">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push(ORDER_ROUTES.history)}>
            <History className="h-3.5 w-3.5" />
            Order History
          </Button>
        </span>
      </PageHeader>

      <div className="sm:hidden flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={refresh} aria-label="Refresh workspace">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={() => router.push(ORDER_ROUTES.history)}>
          <History className="h-3.5 w-3.5" />
          Order History
        </Button>
      </div>

      <TradePage key={refreshKey} mode={mode} embedded />
    </div>
  );
}
