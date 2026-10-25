'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search, RefreshCw, Clock, AlertTriangle, CircleDollarSign, Eye, EyeOff,
  Zap, ShoppingCart, Shield, Loader2, CheckCircle2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MetricCard, SectionCard } from '@/components/design-system';
import StockSearch from '@/components/orders/stock-search';
import type { StockResult } from '@/components/orders/stock-search';
import OrderEntry from '@/components/orders/order-entry';
import { TradingService } from '@/lib/trading-service';
import { getQuote } from '@/lib/api';
import { KotakPage, KotakBadge } from '@/components/kotak/ui';
import { OrdersTabs } from '@/components/orders/orders-tabs';
import { useToast } from '@/hooks/use-toast';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { useRealtime } from '@/components/realtime-provider';
import { cn } from '@/lib/utils';

type KotakFunds = {
  availableMargin: number;
  usedMargin: number;
  totalBalance: number;
};

function fmtRs(v: number): string {
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatExchange(ex?: string): string {
  if (!ex) return 'NSE';
  return ex.replace('nse_', 'NSE ').replace('bse_', 'BSE ').replace('mcx_', 'MCX ').toUpperCase();
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

export default function KotakTrade() {
  const { latest, connected: tickConnected } = useLatestTicks(true);
  const { brokerWsState } = useRealtime();
  const { toast } = useToast();

  const [funds, setFunds] = useState<KotakFunds | null>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  const [selectedStock, setSelectedStock] = useState<StockResult | null>(null);
  const [selectedSide, setSelectedSide] = useState<'BUY' | 'SELL'>('BUY');
  const [selectedQuote, setSelectedQuote] = useState<{ ltp: number; change: number; changePct: number } | null>(null);
  const [orderPlaced, setOrderPlaced] = useState<{ orderId: string; message: string } | null>(null);

  const loadAccountData = useCallback(async () => {
    setLoadingData(true);
    try {
      const [fundsRes, orderBookRes] = await Promise.all([
        TradingService.getFunds().catch(() => null),
        TradingService.getOrderBook().catch(() => null),
      ]);
      if (fundsRes) {
        setFunds({
          availableMargin: fundsRes.availableMargin,
          usedMargin: fundsRes.usedMargin,
          totalBalance: fundsRes.totalBalance,
        });
      }
      const orderList = Array.isArray(orderBookRes?.data) ? orderBookRes.data : [];
      setOrders(orderList);
    } catch {
      /* keep */
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => { void loadAccountData(); }, [loadAccountData]);

  const handleStockSelect = useCallback((stock: StockResult, side: 'BUY' | 'SELL') => {
    setSelectedStock(stock);
    setSelectedSide(side);
    setOrderPlaced(null);
    setSelectedQuote(null);
    getQuote([{ symbol: stock.symbol }], 'ltp')
      .then((res) => {
        const d = Array.isArray(res?.data) ? res.data[0] : res?.data;
        const ltp = Number(d?.ltp ?? d?.last_price ?? 0);
        const change = Number(d?.change ?? 0);
        const changePct = Number(d?.changePct ?? d?.percentageChange ?? 0);
        if (ltp > 0) setSelectedQuote({ ltp, change, changePct });
      })
      .catch(() => setSelectedQuote(null));
  }, []);

  const handleOrderPlaced = useCallback((result: any) => {
    const orderId = result?.data?.n_ord_no || result?.data?.order_id || result?.n_ord_no || result?.order_id || '';
    setOrderPlaced({
      orderId,
      message: `Order placed${orderId ? ` (ID: ${orderId})` : ''}`,
    });
    toast({ title: 'Order placed', description: `Sent to Kotak Neo${orderId ? ` — ${orderId}` : ''}` });
    void loadAccountData();
  }, [toast, loadAccountData]);

  const handleBack = useCallback(() => {
    setSelectedStock(null);
    setSelectedQuote(null);
    setOrderPlaced(null);
  }, []);

  const resting = useMemo(
    () => orders.filter((o) => ['OPEN', 'TRIGGER_PENDING', 'PENDING'].includes(o.status)),
    [orders],
  );

  const isLive = tickConnected || brokerWsState === 'SUPERVISOR_CONNECTED' || brokerWsState === 'CONNECTED';

  const liveTick = selectedStock ? latest.get(selectedStock.symbol) : undefined;
  const displayedLtp = liveTick && typeof liveTick.ltp === 'number' && liveTick.ltp > 0
    ? liveTick.ltp
    : selectedQuote?.ltp;

  if (loadingData && !funds) {
    return (
      <KotakPage>
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading Kotak Neo account data…
        </div>
      </KotakPage>
    );
  }

  return (
    <KotakPage>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Trade</h1>
          <KotakBadge />
          <DataQualityBadge live={isLive} wsState={brokerWsState} />
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <Button asChild size="sm" variant="outline"><a href="/trading/trade">Orders</a></Button>
          <Button variant="outline" size="sm" onClick={() => void loadAccountData()}><RefreshCw className="h-4 w-4" /> Refresh</Button>
        </div>
      </div>

      <OrdersTabs />

      <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
        <Shield className="h-3.5 w-3.5 shrink-0" />
        Real broker orders routed through Kotak Neo API. Every order is live and executable.
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <MetricCard icon={CircleDollarSign} title="Available margin" value={fmtRs(funds?.availableMargin ?? 0)} tone="success" loading={!funds} />
        <MetricCard icon={AlertTriangle} title="Used margin" value={fmtRs(funds?.usedMargin ?? 0)} tone="warning" loading={!funds} />
        <MetricCard icon={Zap} title="Total balance" value={fmtRs(funds?.totalBalance ?? 0)} tone="neutral" loading={!funds} />
        <MetricCard icon={ShoppingCart} title="Open orders" value={String(resting.length)} tone="warning" />
        <MetricCard icon={Clock} title="Today's orders" value={String(orders.length)} tone="neutral" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* ===== LEFT: Enhanced StockSearch ===== */}
        <div className="space-y-4 lg:col-span-3">
          <SectionCard title="Instrument Search" icon={Search}>
            <StockSearch onSelect={handleStockSelect} />
          </SectionCard>

          {selectedStock && (
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl font-extrabold tracking-tight">{selectedStock.symbol}</span>
                    <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5">{formatExchange(selectedStock.exchange || selectedStock.exchangeSegment)}</Badge>
                    <Badge variant="secondary" className="text-[10px]">{selectedStock.instrumentType || 'EQ'}</Badge>
                  </div>
                  {selectedStock.companyName && (
                    <p className="mt-1 text-sm text-muted-foreground truncate max-w-md">{selectedStock.companyName}</p>
                  )}
                  {selectedStock.tradingSymbol && selectedStock.tradingSymbol !== selectedStock.symbol && (
                    <p className="text-[11px] text-muted-foreground/60">{selectedStock.tradingSymbol}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-3xl font-extrabold tabular-nums">
                      {displayedLtp ? fmtRs(displayedLtp) : '—'}
                    </span>
                  </div>
                  {selectedQuote ? (
                    <div className={cn('text-sm tabular-nums font-semibold', selectedQuote.change >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                      {selectedQuote.change >= 0 ? '+' : ''}{selectedQuote.change.toFixed(2)} ({selectedQuote.changePct >= 0 ? '+' : ''}{selectedQuote.changePct.toFixed(2)}%)
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">No quote data</div>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/50 pt-3">
                <Badge variant="outline" className="text-[10px]">Token {selectedStock.token || '—'}</Badge>
                <Badge variant="outline" className="text-[10px]">{selectedStock.series || 'EQ'}</Badge>
                <Badge variant="outline" className="text-[10px]">{selectedStock.exchangeSegment || selectedStock.exchange}</Badge>
              </div>
            </div>
          )}

          {!selectedStock && (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
              <Search className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">Search for an instrument to begin trading</p>
              <p className="mt-1 text-xs text-muted-foreground/60">Type a symbol like RELIANCE, INFY, or TCS — then BUY or SELL</p>
            </div>
          )}
        </div>

        {/* ===== RIGHT: Enhanced OrderEntry + Resting ===== */}
        <div className="space-y-4 lg:col-span-2">
          {selectedStock ? (
            <OrderEntry
              key={`${selectedStock.token}-${selectedStock.exchange}-${selectedSide}`}
              stock={selectedStock}
              initialSide={selectedSide}
              onOrderPlaced={handleOrderPlaced}
              onBack={handleBack}
            />
          ) : (
            <SectionCard title="Order Entry" icon={ShoppingCart}>
              <div className="py-10 text-center">
                <ShoppingCart className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm font-medium text-muted-foreground">Select an instrument to place an order</p>
                <p className="mt-1 text-xs text-muted-foreground/60">Choose a stock on the left — the Kotak Neo order form appears here</p>
              </div>
            </SectionCard>
          )}

          {orderPlaced && (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-500">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <div className="min-w-0">
                <div className="font-semibold">{orderPlaced.message}</div>
              </div>
              <Button size="sm" variant="outline" className="ml-auto shrink-0 text-xs" onClick={() => void loadAccountData()}>
                <RefreshCw className="h-3 w-3 mr-1" /> Refresh
              </Button>
            </div>
          )}

          <SectionCard title={`Resting Orders (${resting.length})`} icon={Clock}>
            {resting.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">No resting limit/stop orders.</p>
            ) : (
              <div className="space-y-2">
                {resting.slice(0, 5).map((o) => (
                  <div key={o.orderId || o.n_ord_no} className="rounded-md border p-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{o.symbol}</span>
                        <Badge variant={o.transactionType === 'BUY' ? 'default' : 'destructive'} className="text-[10px]">{o.transactionType}</Badge>
                        <Badge variant="outline" className="text-[10px]">{o.status}</Badge>
                      </div>
                      <span className="font-mono text-[10px] text-muted-foreground">{o.orderId || o.n_ord_no}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-end gap-1.5 text-[11px]">
                      <span className="text-muted-foreground">Qty {o.quantity}</span>
                      {o.price ? <span className="text-muted-foreground">Lmt {fmtRs(Number(o.price))}</span> : null}
                      {o.triggerPrice ? <span className="text-muted-foreground">Trg {fmtRs(Number(o.triggerPrice))}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </KotakPage>
  );
}