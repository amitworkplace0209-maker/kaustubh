'use client';

/**
 * SERVICES → Order Engine → SHOONYA engine page.
 *
 * Shoonya orders go trade page → engine → ShoonyaAdapter → NorenRestApiPy
 * place_order → response back to the page. This page shows:
 *   · session state + OAuth availability (QuickAuth link builder)
 *   · live canonical order book for the shoonya terminal
 *   · SDK wiring facts
 */
import { useCallback, useEffect, useState } from 'react';
import { Cable, ExternalLink, RefreshCw, Sprout } from 'lucide-react';
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

export default function OrderEngineShoonyaPage() {
  const [detail, setDetail] = useState<OrderEngineTerminalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await getOrderEngineTerminalDetail('shoonya', { timeoutMs: 15000 });
      setDetail(d);
    } catch {
      setError('shoonya engine unavailable');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = detail?.connected ?? false;
  const oauth = detail?.oauth ?? null;
  const rows = detail?.orders ?? [];

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <section className="relative overflow-hidden rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/[0.07] via-purple-500/[0.04] to-fuchsia-500/[0.07] shadow-sm">
        <div className="relative flex items-center gap-3 p-4 sm:p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-600 text-white shadow-sm">
            <Sprout className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Shoonya Order Engine</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              Trade page → engine → Noren SDK — broker response seedha order page ko wapas
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnBadge connected={connected} />
            <Button size="sm" variant="outline" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-700">
          Shoonya engine unavailable: {error}
        </div>
      )}

      <MarketDataBanner marketData={detail?.marketData ?? null} isPaper={false} />

      {/* SDK PATH */}
      <Card className="border-violet-500/25 shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-2 py-3 text-[11px]">
          <span className="font-bold uppercase tracking-wider text-muted-foreground">SDK path</span>
          {(detail?.enginePath ?? '').split(' → ').map((step, i, all) => (
            <span key={i} className="flex items-center gap-1">
              <span className="rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono">{step}</span>
              {i < all.length - 1 && <span className="text-muted-foreground/60">→</span>}
            </span>
          ))}
          <Badge variant="outline" className={`${OENG_TONE.violet} ml-auto`}>
            {detail?.sdk?.sdk ?? '—'} · {detail?.sdk?.module ?? '—'}
          </Badge>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* SESSION + OAUTH */}
        <Card className={OENG_TONE.sky + ' shadow-sm'}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Cable className="h-3.5 w-3.5" /> Session + OAuth (QuickAuth)
              <Badge variant="outline" className={connected ? OENG_TONE.emerald : OENG_TONE.amber}>
                {connected ? 'LOGGED IN' : 'NEEDS LOGIN'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-3 text-[11px]">
            <p className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-1.5 py-1">
              <span className="text-muted-foreground">Adapter</span>
              <span className="font-mono font-semibold">{detail?.brokerName ?? '—'}</span>
            </p>
            <p className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-1.5 py-1">
              <span className="text-muted-foreground">Orders in book</span>
              <span className="font-mono font-semibold tabular-nums">{fmtN(detail?.total ?? 0)}</span>
            </p>
            {oauth?.error && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-700">{String(oauth.error)}</p>}
            {oauth?.url && (
              <a href={String(oauth.url)} target="_blank" rel="noreferrer"
                className="flex items-center justify-between rounded-lg border border-border bg-background px-2.5 py-1.5 font-semibold text-violet-700 hover:bg-muted/40">
                <span>OAuth link kholo (QuickAuth)</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              OAuth se token milne par return auth-code Broker Terminal page me accept hota hai (auto-login restore ke liye encrypted save hota hai). Engine turant session adopt karta hai.
            </p>
          </CardContent>
        </Card>

        {/* RESPONSE DISCIPLINE */}
        <Card className={OENG_TONE.emerald + ' shadow-sm'}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              Response discipline
              <Badge variant="outline" className="ml-auto font-mono">{detail?.sdk?.sdk ?? '—'}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3 text-[11px]">
            {Object.entries(detail?.capabilities ?? {}).map(([k, v]) => (
              Array.isArray(v)
                ? <Badge key={k} variant="outline" className={`${OENG_TONE.slate} mr-1.5`}>{k}: {v.length ? String(v.length) : '—'}</Badge>
                : (
                  <Badge
                    key={k}
                    variant="outline"
                    className={!Array.isArray(v) && typeof v === 'boolean' && (v as boolean) ? `${OENG_TONE.emerald} mr-1.5` : `${OENG_TONE.slate} mr-1.5`}>
                    {k}
                  </Badge>
                )
            ))}
            {Object.keys(detail?.capabilities ?? {}).length === 0 && <p className="text-muted-foreground">capabilities —</p>}
            <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground">
              Noren result me <span className="font-mono">norenordno</span> order number hota hai — engine wahi confirm manega; empty response par order ACCEPTED nahi bola jayega.
            </p>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Modify/cancel bhi isi adapter se Noren SDK par direct jate hain; square-off opposite market leg se execute hota hai (v3 discipline).
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ORDER BOOK */}
      <OrderTable
        orders={rows}
        busyOrderId={null}
        emptyMessage={
          loading ? 'Loading Shoonya order book…'
            : connected
              ? 'Shoonya order book khali — pehli order trade page ya orders page se place karo.'
              : 'Shoonya connect nahi — order book unavailable (connect Broker Terminal se).'
        }
      />

      {!connected && (
        <p className="text-[11px] text-muted-foreground">
          Connection lifecycle (login / OAuth accept / auto-login) owner page:{' '}
          <Link href="/services/broker-terminal/terminals" className="text-violet-700 hover:underline">
            Broker Terminal → Terminals
          </Link>
        </p>
      )}
    </div>
  );
}
