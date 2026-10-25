'use client';

/**
 * SERVICES → Order Engine → KOTAK engine page.
 *
 * Kotak orders go trade page → engine → KotakAdapter → neo_api_client
 * place_order → response back to the page. This page shows that engine:
 *   · session state + capabilities
 *   · WS#2 order-feed supervisor (realtime status)
 *   · SDK wiring facts + live canonical order book
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Building2, Cable, RefreshCw, Zap } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MarketDataBanner } from '@/components/order-engine/market-data-banner';
import { OrderTable } from '@/components/order-engine/order-table';
import {
  ConnBadge, OENG_TONE, fmtN,
} from '@/components/order-engine/oeng-shared';
import { getOrderEngineTerminalDetail, type OrderEngineTerminalDetail } from '@/lib/api';

function fmtT(value: unknown): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function OrderEngineKotakPage() {
  const [detail, setDetail] = useState<OrderEngineTerminalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await getOrderEngineTerminalDetail('kotak', { timeoutMs: 15000 });
      setDetail(d);
    } catch {
      setError('kotak engine unavailable');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = detail?.connected ?? false;
  const feed = detail?.orderFeed ?? null;
  const rows = detail?.orders ?? [];

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <section className="relative overflow-hidden rounded-2xl border border-sky-500/25 bg-gradient-to-br from-sky-500/[0.07] via-blue-500/[0.04] to-indigo-500/[0.07] shadow-sm">
        <div className="relative flex items-center gap-3 p-4 sm:p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 via-blue-500 to-indigo-600 text-white shadow-sm">
            <Building2 className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Kotak Order Engine</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              Trade page → engine → Kotak Neo SDK — order sidha broker ko jata hai
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnBadge connected={connected} />
            {!connected && (
              <Link href="/services/broker-terminal" className="text-xs font-semibold text-sky-700 hover:underline">
                Broker Terminal me connect karo <ArrowUpRight className="inline h-3 w-3" />
              </Link>
            )}
            <Button size="sm" variant="outline" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-700">
          Kotak engine unavailable: {error}
        </div>
      )}

      <MarketDataBanner marketData={detail?.marketData ?? null} isPaper={false} />

      {/* SDK PATH */}
      <Card className="border-sky-500/25 shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-2 py-3 text-[11px]">
          <span className="font-bold uppercase tracking-wider text-muted-foreground">SDK path</span>
          {(detail?.enginePath ?? '').split(' → ').map((step, i, all) => (
            <span key={i} className="flex items-center gap-1">
              <span className="rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono">{step}</span>
              {i < all.length - 1 && <span className="text-muted-foreground/60">→</span>}
            </span>
          ))}
          <Badge variant="outline" className={`${OENG_TONE.sky} ml-auto`}>
            {detail?.sdk?.sdk ?? '—'} · {detail?.sdk?.module ?? '—'}
          </Badge>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* WS#2 ORDER FEED */}
        <Card className={OENG_TONE.sky + ' shadow-sm'}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Cable className="h-3.5 w-3.5" /> WS#2 order feed (realtime status)
              <Badge variant="outline" className={feed?.connected ? OENG_TONE.emerald : OENG_TONE.rose}>
                {feed?.connected ? 'CONNECTED' : (feed?.state ?? 'UNKNOWN')}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 text-[11px]">
            {feed == null ? (
              <p className="text-muted-foreground">Feed status abhi load nahi hua.</p>
            ) : feed.error ? (
              <p className="text-rose-700">{String(feed.error)}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['Supervisor state', feed.state],
                    ['Messages', feed.totalMessages],
                    ['Order updates', feed.totalOrderUpdates],
                    ['Position updates', feed.totalPositionUpdates],
                    ['Errors', feed.totalErrors],
                    ['Reconnect attempt', feed.reconnectAttempt],
                  ] as [string, unknown][]).map(([label, v]) => (
                    <div key={label} className="rounded-lg border border-border/60 bg-background px-2 py-1.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                      <p className="font-mono tabular-nums">{typeof v === 'number' ? fmtN(v) : String(v ?? '—')}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                  <span>connected {fmtT(feed.connectedAt)}</span>
                  <span>last order {fmtT(feed.lastOrderAt)}</span>
                </p>
                {Array.isArray(feed.connectionHistory) && feed.connectionHistory.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {feed.connectionHistory.slice(-3).reverse().map((row: any, i: number) => (
                      <p key={i} className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {fmtT(row?.at ?? row?.ts ?? '')} · {String(row?.state ?? row?.event ?? '')}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* SESSION */}
        <Card className={OENG_TONE.emerald + ' shadow-sm'}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Zap className="h-3.5 w-3.5" /> Session + capabilities
              <Badge variant="outline" className="ml-auto font-mono">
                {fmtN(detail?.total ?? 0)} orders in book
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3 text-[11px]">
            <p className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-1.5 py-1">
              <span className="text-muted-foreground">Adapter</span>
              <span className="font-mono font-semibold">{detail?.brokerName ?? '—'}</span>
            </p>
            <p className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-1.5 py-1">
              <span className="text-muted-foreground">Broker</span>
              <span className="font-mono">{detail?.broker ?? '—'}</span>
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {Object.entries(detail?.capabilities ?? {}).map(([k, v]) => (
                Array.isArray(v)
                  ? <Badge key={k} variant="outline" className={OENG_TONE.slate}>{k}: {v.length ? String(v.length) : '—'}</Badge>
                  : (
                    <Badge
                      key={k}
                      variant="outline"
                      className={typeof v === 'boolean' ? (v ? OENG_TONE.emerald : OENG_TONE.slate) : OENG_TONE.slate}
                    >
                      {k}{typeof v === 'boolean' ? (v ? ' ✓' : ' ✗') : String(v)}
                    </Badge>
                  )
              ))}
              {Object.keys(detail?.capabilities ?? {}).length === 0 && <span className="text-muted-foreground">capabilities —</span>}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ORDER BOOK */}
      <OrderTable
        orders={rows}
        busyOrderId={null}
        emptyMessage={
          loading ? 'Loading Kotak order book…'
            : connected
              ? 'Kotak order book khali — pehli order trade page ya orders page se place karo.'
              : 'Kotak connect nahi — order book unavailable (connect Broker Terminal se).'
        }
      />
    </div>
  );
}
