'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  RefreshCw, ListChecks, Zap, ArrowRight, Eye, EyeOff, Shield, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/design-system';
import BasketManager from '@/components/orders/basket-manager';
import { TradingService } from '@/lib/trading-service';
import { KotakPage, KotakBadge } from '@/components/kotak/ui';
import { OrdersTabs } from '@/components/orders/orders-tabs';
import { useRealtime } from '@/components/realtime-provider';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { cn } from '@/lib/utils';

function fmtRs(v: number): string {
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function DataQualityBadge({ live, wsState }: { live: boolean; wsState: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
      live ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-amber-500/40 bg-amber-500/10 text-amber-500',
    )}>
      {live ? <Eye className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
      {live ? 'LIVE' : wsState ? wsState : 'STALE'}
    </span>
  );
}

export default function KotakBasketOrders() {
  const router = useRouter();
  const { brokerWsState } = useRealtime();
  const { connected: tickConnected } = useLatestTicks(true);
  const [funds, setFunds] = useState<{ availableMargin: number; usedMargin: number } | null>(null);
  const [loadingFunds, setLoadingFunds] = useState(true);

  const loadFunds = useCallback(async () => {
    setLoadingFunds(true);
    try {
      const fundsRes = await TradingService.getFunds();
      if (fundsRes) {
        setFunds({ availableMargin: fundsRes.availableMargin, usedMargin: fundsRes.usedMargin });
      }
    } catch {
      /* keep */
    } finally {
      setLoadingFunds(false);
    }
  }, []);

  useEffect(() => { void loadFunds(); }, [loadFunds]);

  const isLive = tickConnected || brokerWsState === 'SUPERVISOR_CONNECTED' || brokerWsState === 'CONNECTED';

  return (
    <KotakPage>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Basket Orders</h1>
          <KotakBadge />
          <DataQualityBadge live={isLive} wsState={brokerWsState} />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadFunds()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      <OrdersTabs />

      <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
        <Shield className="h-3.5 w-3.5 shrink-0" />
        Baskets execute through the real Kotak Neo broker. Every leg is a live order.
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard icon={Zap} title="Available margin" value={funds ? fmtRs(funds.availableMargin) : '—'} tone="success" loading={loadingFunds} />
        <MetricCard icon={ListChecks} title="Used margin" value={funds ? fmtRs(funds.usedMargin) : '—'} tone="warning" loading={loadingFunds} />
        <Button
          variant="outline"
          className="flex items-center justify-center gap-2 rounded-lg border-dashed py-4 text-sm font-semibold text-muted-foreground hover:text-foreground"
          onClick={() => router.push('/trading/trade')}
        >
          {loadingFunds ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <span className="text-xs tabular-nums">
              Remaining: {funds ? fmtRs(funds.availableMargin - funds.usedMargin) : '—'}
            </span>
          )}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      <BasketManager
        onStockSelect={(symbol) => {
          try {
            localStorage.setItem('kotak.trade.draft', JSON.stringify({
              symbol,
              side: 'BUY',
              quantity: '1',
              source: 'basket',
              savedAt: new Date().toISOString(),
            }));
          } catch { /* storage unavailable */ }
          router.push('/trading/trade');
        }}
      />
    </KotakPage>
  );
}