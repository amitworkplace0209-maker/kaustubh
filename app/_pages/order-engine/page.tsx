'use client';

/**
 * SERVICES -> Order Engine (Overview)
 *
 * Implements docs/engines/order-engine.md §1–§3 and §24–§26: Order Engine is the
 * single authoritative order-orchestration engine, and every order — manual, AI,
 * basket — passes through one controlled path before reaching a broker.
 *
 * This page therefore does three things and nothing else:
 *   1. shows which terminal the engine is acting on, and whether that terminal
 *      is a paper or a live broker;
 *   2. shows the order state machine split into WORKING (accepted, not executed)
 *      and TERMINAL, because those are different facts;
 *   3. shows whether real market data is actually arriving, since an order that
 *      cannot be priced must sit pending rather than fill at an invented price.
 *
 * There is no place to enter an order here: placement is a single action on the
 * Orders page, which is the page that owns the order lifecycle.
 */
import { useMemo, useState } from 'react';
import { Activity, ListOrdered, Play, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MarketDataBanner } from '@/components/order-engine/market-data-banner';
import { OrderTable } from '@/components/order-engine/order-table';
import { StateLegend, StateMachinePanel } from '@/components/order-engine/state-machine-panel';
import { TONE_CLASS, fmtNum } from '@/components/order-engine/status';
import { useOrderEngineLive } from '@/components/order-engine/use-order-engine-live';

export default function OrderEngineOverviewPage() {
  const engine = useOrderEngineLive();
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  const recent = useMemo(
    () =>
      [...engine.orders]
        .sort((a, b) => String(b.placedAt ?? '').localeCompare(String(a.placedAt ?? '')))
        .slice(0, 12),
    [engine.orders],
  );

  const cancel = async (orderId: string) => {
    setBusyOrderId(orderId);
    await engine.cancel(orderId);
    setBusyOrderId(null);
  };

  const connected = engine.state?.connected ?? false;
  const isPaper = engine.state?.isPaper ?? false;
  const broker = engine.state?.broker ?? '\u2014';
  const showDummyConnect = isPaper && !connected && !engine.dummyConnecting;

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ListOrdered className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Order Engine</h1>
            <p className="text-xs text-muted-foreground">
              Single order choke-point · manual, AI and basket orders all pass through here
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void engine.refresh()}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
          {showDummyConnect && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void engine.connectDummy()}
              className="bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20"
            >
              <Play className="mr-1 h-3 w-3" /> Connect Dummy
            </Button>
          )}
          {engine.dummyConnecting && (
            <Button size="sm" variant="outline" disabled className="opacity-50">
              <Activity className="mr-1 h-3 w-3 animate-spin" /> Connecting…
            </Button>
          )}
        </div>
      </div>

      {engine.error && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          Order Engine unavailable: {engine.error}
        </div>
      )}

      <MarketDataBanner marketData={engine.marketData} isPaper={isPaper} />

      {/* terminal + engine */}
      <div className="grid gap-3 lg:grid-cols-4">
        <Card className="shadow-soft">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Execution path</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Terminal</span>
              <Badge variant="outline" className={TONE_CLASS[isPaper ? 'amber' : 'sky']}>
                {broker}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Mode</span>
              <span className="font-mono">{isPaper ? 'PAPER' : 'LIVE BROKER'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Session</span>
              <Badge
                variant="outline"
                className={TONE_CLASS[(connected || engine.dummyConnected) ? 'emerald' : 'rose']}
              >
                {connected || engine.dummyConnected ? 'CONNECTED' : 'NOT CONNECTED'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Realtime link</span>
              <Badge variant="outline" className={TONE_CLASS[engine.live ? 'emerald' : 'slate']}>
                {engine.live ? 'STREAMING' : 'POLLING'}
              </Badge>
            </div>
            <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground/80">
              {isPaper
                ? 'Paper orders fill from the real market feed at the live LTP, driven by the backend’s own tick pipeline — never from a generated price.'
                : 'Orders are submitted directly to the broker and its own execution status is authoritative.'}
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-soft">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Engine health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Engine</span>
              <span className="font-mono">order_engine</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Registered</span>
              <Badge variant="outline" className={TONE_CLASS.emerald}>
                ACTIVE
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Risk gate</span>
              <Badge variant="outline" className={TONE_CLASS.emerald}>
                ENFORCED
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Orders tracked</span>
              <span className="font-mono">{fmtNum(engine.counts.TOTAL ?? 0, 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Working now</span>
              <span className="font-mono text-amber-300">{engine.counts.WORKING ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-soft">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Market data</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Feed</span>
              <Badge
                variant="outline"
                className={TONE_CLASS[engine.marketData?.liveFeedReceiving ? 'emerald' : 'amber']}
              >
                {engine.marketData?.liveFeedReceiving ? 'RECEIVING' : 'IDLE'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Ticks / sec</span>
              <span className="font-mono">{(engine.marketData?.ticksPerSecond ?? 0).toFixed(1)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Instruments</span>
              <span className="font-mono">{engine.marketData?.latestTickCount ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Source</span>
              <span className="truncate font-mono text-[10px]">WS#1 tick buffer</span>
            </div>
            <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground/80">
              Prices come from the broker’s own market feed on the server. The browser only
              displays them.
            </p>
          </CardContent>
        </Card>

        <StateMachinePanel counts={engine.counts} total={engine.counts.TOTAL ?? 0} />
      </div>

      {/* how the engine processes an order */}
      <Card className="shadow-soft">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Order path</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {[
              'Request',
              'Normalize',
              'Validate',
              'Risk check',
              'Prepare',
              'Broker adapter',
              'Broker',
              'Execution response',
              'State + audit + UI',
            ].map((step, i, all) => (
              <span key={step} className="flex items-center gap-1.5">
                <Badge variant="outline" className="font-normal">
                  {step}
                </Badge>
                {i < all.length - 1 && <span className="text-muted-foreground/60">→</span>}
              </span>
            ))}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {[
              {
                icon: ShieldCheck,
                title: 'Validation and risk happen before submission',
                body: 'An invalid quantity or a risk breach never reaches the broker, so it is reported as a local rejection — clearly separate from a broker rejection.',
              },
              {
                icon: Server,
                title: 'The broker response is authoritative',
                body: 'Order number, status and rejection reason are preserved exactly as the broker returned them, including the raw message.',
              },
              {
                icon: Activity,
                title: 'State arrives in realtime',
                body: 'Fills, partial fills and cancellations push incremental updates to this page without a full reload or a poll loop.',
              },
            ].map((item) => (
              <div key={item.title} className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11px] font-medium">
                  <item.icon className="h-3.5 w-3.5 text-primary" />
                  {item.title}
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* recent orders */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <OrderTable
            orders={recent}
            ltp={engine.ltp}
            busyOrderId={busyOrderId}
            onCancel={(o) => void cancel(o.orderId)}
            emptyMessage={
              engine.loading
                ? 'Loading order book…'
                : connected || engine.dummyConnected
                  ? 'No orders on this terminal yet (honest zero).'
                  : `${broker} is not connected — no order book available.`
            }
          />
        </div>
        <StateLegend />
      </div>
    </div>
  );
}