'use client';

import { useEffect, useState } from 'react';
import { ShoppingCart } from 'lucide-react';
import { useDummyState } from '@/hooks/use-dummy-state';
import { useRealtime } from '@/components/realtime-provider';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { OrdersModuleProvider } from '@/components/dummy/orders-context';
import { OrdersTabs, type OrderTabId } from '@/components/orders/orders-tabs';
import { StatusBadge } from '@/components/design-system';
import { sessionLabel, getDummySuggestions } from '@/lib/dummy';
import { cn } from '@/lib/utils';

import DummyTrade from '@/components/dummy/pages/trade';
import DummySuggestion from '@/components/dummy/pages/suggestion';
import DummyHistory from '@/components/dummy/pages/history';

/**
 * DummyOrdersModule — ONE professional Orders module for the Dummy terminal.
 * Trade / Suggestion / History are internal tabs rendered
 * inline (no separate sidebar pages). Every stat shown comes from the real
 * Dummy backend (/api/dummy/*) and the single market-data pipeline — nothing
 * is fabricated. The standalone sub-routes remain fully functional.
 */
export function DummyOrdersModule() {
  const [active, setActive] = useState<OrderTabId>('trade');
  const { state } = useDummyState(5000);
  const { brokerWsConnected } = useRealtime();

  const [suggestionCount, setSuggestionCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval>;

    const fetch = () => {
      getDummySuggestions('PENDING', 50)
        .then((res) => {
          if (mounted) setSuggestionCount(res?.data?.length ?? 0);
        })
        .catch(() => {
          /* keep stale */
        });
    };

    fetch();
    timer = setInterval(fetch, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const ordersToday = state?.session?.order_count ?? state?.orders?.length ?? 0;
  const openOrders = (state?.orders ?? []).filter((o) => {
    const s = (o.status || '').toUpperCase();
    return s === 'OPEN' || s === 'PENDING' || s === 'TRIGGER_PENDING' || s === 'PARTIALLY_FILLED' || s === 'EXECUTING';
  }).length;
  const market = state?.market?.market_session ?? null;
  const historyCount = state?.session?.order_count ?? (state?.orders?.length ?? 0);

  return (
    <DummyThemedPage className="space-y-4">
      {/* Module header with market session indicator */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Orders</h1>
          <DummyBadge />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {market ? (
            <StatusBadge
              status={market === 'OPEN' ? 'success' : market === 'PRE_OPEN' ? 'warning' : 'neutral'}
              label={`Market ${sessionLabel(market)}`}
            />
          ) : null}
          <StatusBadge
            status={brokerWsConnected === true ? 'success' : 'neutral'}
            label={
              brokerWsConnected === true
                ? 'WebSocket connected'
                : brokerWsConnected === false
                  ? 'WebSocket offline'
                  : 'WebSocket unknown'
            }
          />
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs tabular-nums text-muted-foreground">
            <ShoppingCart className="h-3.5 w-3.5" />
            <span className="font-semibold text-foreground">{ordersToday}</span> today ·{' '}
            <span className={cn('font-semibold', openOrders > 0 ? 'text-amber-500' : 'text-foreground')}>
              {openOrders}
            </span>{' '}
            open
          </span>
        </div>
      </div>

      <OrdersTabs
        value={active}
        onValueChange={setActive}
        counts={{
          trade: openOrders,
          suggestion: suggestionCount,
          history: historyCount,
        }}
      />

      <OrdersModuleProvider>
        {active === 'trade' ? <DummyTrade /> : null}
        {active === 'suggestion' ? <DummySuggestion /> : null}
        {active === 'history' ? <DummyHistory /> : null}
      </OrdersModuleProvider>
    </DummyThemedPage>
  );
}
