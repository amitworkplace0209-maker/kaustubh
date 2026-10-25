'use client';

/**
 * SERVICES → Order Engine → DUMMY (paper) engine page.
 *
 * This page shows the Dummy Order Engine end-to-end:
 *   · VERIFICATION — orders placed from trade page / order page reach the
 *     engine (producers per source, fill sources, last fill / last resting).
 *   · LIVE STATE — resting orders, paper feed health, account + fill model.
 *
 * Every number is computed by the backend from the stored order book —
 * nothing is invented.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight, CircleDollarSign, FlaskConical, Layers,
  Radio, RefreshCw, Wallet,
} from 'lucide-react';import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MarketDataBanner } from '@/components/order-engine/market-data-banner';
import { OrderTable } from '@/components/order-engine/order-table';
import {
  ConnBadge, OENG_TONE, fmtN,
} from '@/components/order-engine/oeng-shared';
import {
  connectDummyTerminal,
  getOrderEngineTerminalDetail,
  type OrderEngineTerminalDetail,
} from '@/lib/api';

export default function OrderEngineDummyPage() {
  const [detail, setDetail] = useState<OrderEngineTerminalDetail | null>(null);
  const [_loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await getOrderEngineTerminalDetail('dummy', { timeoutMs: 15000 });
      setDetail(d);
    } catch {
      setError('dummy engine unavailable');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setConnecting(true);
    try {
      await connectDummyTerminal();
      await load();
    } finally {
      setConnecting(false);
    }
  };

  const connected = detail?.connected ?? false;
  const paper = detail?.paper ?? null;
  const feed = paper?.feed ?? null;
  const prefs = paper?.prefs ?? {};
  const account = paper?.account ?? {};
  const restingRows = (detail?.orders ?? []).filter((o) => o.working || o.status === 'PARTIALLY_FILLED');
  const producers = paper?.producers ?? {};
  const fillSources = paper?.fillSources ?? {};

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <section className="relative overflow-hidden rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.07] via-orange-500/[0.04] to-rose-500/[0.07] shadow-sm">
        <div className="relative flex items-center gap-3 p-4 sm:p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 via-orange-500 to-rose-600 text-white shadow-sm">
            <FlaskConical className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Dummy Order Engine</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              Paper engine · LTP-matched fills, exactly like a real broker
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnBadge connected={connected} />
            {connected ? (
              <Badge variant="outline" className={OENG_TONE.emerald}>Paper engine ready</Badge>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void connect()} disabled={connecting} className={OENG_TONE.amber}>
                {connecting ? 'Connecting…' : 'Connect Dummy'}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-700">
          Order Engine unavailable: {error}
        </div>
      )}

      <MarketDataBanner marketData={detail?.marketData ?? null} isPaper />

      {/* ENGINE PATH */}
      <Card className="border-amber-500/25 shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-2 py-3 text-[11px]">
          <span className="font-bold uppercase tracking-wider text-muted-foreground">Order flow</span>
          {(detail?.enginePath ?? '').split(' → ').map((step, i, all) => (
            <span key={i} className="flex items-center gap-1">
              <span className="rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono">{step}</span>
              {i < all.length - 1 && <span className="text-muted-foreground/60">→</span>}
            </span>
          ))}
        </CardContent>
      </Card>

      {/* VERIFICATION + FEED + ACCOUNT */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* VERIFICATION */}
        <Card className={OENG_TONE.emerald + ' shadow-sm lg:col-span-3'}>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
              Verification — har placed order engine me pahunchi hai
              <Badge variant="outline" className="ml-auto font-mono">
                {fmtN(paper?.totalDistinct ?? 0)} stored orders
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-3 text-[11px]">
            <div>
              <p className="mb-1 font-semibold text-muted-foreground">Producers (jis surface se order aayi)</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(producers).length === 0 ? (
                  <span className="text-muted-foreground">Abhi koi order store me nahi — trade page ya orders page se pehli order place karke dikho.</span>
                ) : (
                  Object.entries(producers).map(([src, n]) => (
                    <Badge key={src} variant="outline" className={OENG_TONE.emerald}>
                      {src} · {fmtN(n)}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {([
                ['Placed (24h)', paper?.placedLast24h],
                ['Filled (24h)', paper?.filledLast24h],
                ['Resting now', paper?.restingNow],
              ] as [string, number | undefined][]).map(([label, v]) => (
                <div key={label} className="rounded-lg border border-border/60 bg-background px-2 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <p className="font-mono text-base font-bold tabular-nums">{fmtN(v)}</p>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-1 font-semibold text-muted-foreground">Status split</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(paper?.byStatus ?? {}).map(([st, n]) => (
                  <Badge key={st} variant="outline" className={OENG_TONE.slate}>
                    {st} · {fmtN(n)}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 font-semibold text-muted-foreground">Fill source (LTP funnels)</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(fillSources).map(([fs, n]) => (
                  <Badge key={fs} variant="outline" className={OENG_TONE.amber}>
                    {fs} · {fmtN(n)}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          {/* FEED */}
          <Card className={OENG_TONE.sky + ' shadow-sm'}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <Radio className="h-3.5 w-3.5" /> Paper feed (server-side)
                <Badge variant="outline" className={feed?.running ? OENG_TONE.emerald : OENG_TONE.rose}>
                  {feed?.running ? 'RUNNING' : 'STOPPED'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-3 text-[11px]">
              <div className="grid grid-cols-2 gap-2">
                {([
                  ['Upstream ticks/s', feed?.upstreamTicksPerSecond],
                  ['Subscribed tokens', feed?.subscribedTokens],
                  ['Pending instruments', feed?.pendingInstruments],
                  ['Batches pushed', feed?.counters?.batchesPushed],
                  ['Ticks forwarded', feed?.counters?.ticksForwarded],
                  ['Engine errors', feed?.counters?.engineErrors],
                ] as [string, unknown][]).map(([label, v]) => (
                  <div key={label} className="rounded-lg border border-border/60 bg-background px-2 py-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                    <p className="font-mono tabular-nums">{fmtN(Number(v ?? NaN))}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* ACCOUNT */}
          <Card className={OENG_TONE.violet + ' shadow-sm'}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
                <Wallet className="h-3.5 w-3.5" /> Paper account + fill model
                <Link href="/services/order-engine/settings" className="ml-auto text-violet-700 hover:underline">
                  Settings <ArrowUpRight className="inline h-3 w-3" />
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 pt-3 text-[11px]">
              {([
                ['Available funds', account.availableFunds ?? account.balance],
                ['Used margin', account.usedMargin],
                ['Realized P&L', account.realizedPnl],
                ['Orders today', account.dailyOrders],
              ] as [string, unknown][]).map(([label, v]) => (
                <p key={label} className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-1.5 py-1">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <CircleDollarSign className="h-3 w-3" /> {label}
                  </span>
                  <span className="font-mono font-semibold tabular-nums">{fmtN(Number(v ?? NaN))}</span>
                </p>
              ))}
              <p className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-2 py-1.5">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Layers className="h-3 w-3" /> MKT slippage
                </span>
                <span className="font-mono">{fmtN(Number(prefs.slippageBps ?? NaN))} bps</span>
              </p>
              <p className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-2 py-1.5">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Layers className="h-3 w-3" /> Order caps
                </span>
                <span className="font-mono">
                  daily {fmtN(Number(prefs.maxDailyOrders ?? NaN))} · value {fmtN(Number(prefs.maxOrderValue ?? NaN))}
                </span>
              </p>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Fill model: MKT real LTP ± slippage · LMT marketable hone par · SL trigger cross par — LTP na hone par order park, invented price se fill kabhi nahi.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* RESTING + LAST FILL */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <OrderTable
            orders={restingRows}
            busyOrderId={null}
            emptyMessage={
              connected
                ? 'Koi working order nahi — sab normalized (honest zero).'
                : 'Dummy engine connect nahi — order book unavailable.'
            }
          />
        </div>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Last fill + last resting</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0 text-[11px]">
            {paper?.lastFill ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2">
                <p className="font-mono font-semibold">{String(paper.lastFill.symbol ?? '—')} · {String(paper.lastFill.transactionType ?? '')}</p>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {fmtN(Number(paper.lastFill.filledQuantity ?? NaN))} @ {fmtN(Number(paper.lastFill.averageTradedPrice ?? NaN))} · {String(paper.lastFill.fillSource ?? '')}
                </p>
              </div>
            ) : (
              <p className="rounded-lg border border-border/60 bg-background px-2.5 py-2 text-muted-foreground">Koi fill record nahi (missing ≠ zero).</p>
            )}
            {paper?.lastResting ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
                <p className="font-mono font-semibold">{String(paper.lastResting.symbol ?? '—')} · {String(paper.lastResting.status ?? '')}</p>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {String(paper.lastResting.waitingReason ?? 'waiting for LTP to match')}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">Koi resting order nahi.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
