'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight, Building2, FlaskConical, ListOrdered,
  RefreshCw, Sprout,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OrderTable } from '@/components/order-engine/order-table';
import { StateLegend, StateMachinePanel } from '@/components/order-engine/state-machine-panel';
import {
  ConnBadge, OENG_TONE, fmtN,
} from '@/components/order-engine/oeng-shared';
import {
  getOrderEngineState,
  getOrderEngineOrders,
  getOrderEngineTerminalDetail,
  type OrderEngineTerminalDetail,
} from '@/lib/api';

const BROKER_CARDS = [
  { key: 'dummy' as const, label: 'Dummy Engine', href: '/services/order-engine/dummy', kind: 'PAPER', icon: FlaskConical, accent: 'border-amber-500/40 bg-amber-500/10 text-amber-700', header: 'border-amber-500/25' },
  { key: 'kotak' as const, label: 'Kotak Engine', href: '/services/order-engine/kotak', kind: 'SDK', icon: Building2, accent: 'border-sky-500/40 bg-sky-500/10 text-sky-700', header: 'border-sky-500/25' },
  { key: 'shoonya' as const, label: 'Shoonya Engine', href: '/services/order-engine/shoonya', kind: 'SDK', icon: Sprout, accent: 'border-violet-500/40 bg-violet-500/10 text-violet-700', header: 'border-violet-500/25' },
];

export default function OrderEngineOverviewPage() {
  const [state, setState] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [cards, setCards] = useState<Record<'dummy' | 'kotak' | 'shoonya', OrderEngineTerminalDetail | null>>({
    dummy: null,
    kotak: null,
    shoonya: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [engineRes, ordersRes] = await Promise.all([
        getOrderEngineState({ timeoutMs: 15000 }),
        getOrderEngineOrders(undefined, { timeoutMs: 15000 }),
      ]);
      setState(engineRes);
      setOrders(ordersRes.orders ?? []);
    } catch (exc: any) {
      setError(exc?.message ?? 'engine load failed');
    }

    try {
      const [d, k, s] = await Promise.all([
        getOrderEngineTerminalDetail('dummy', { timeoutMs: 15000 }),
        getOrderEngineTerminalDetail('kotak', { timeoutMs: 15000 }),
        getOrderEngineTerminalDetail('shoonya', { timeoutMs: 15000 }),
      ]);
      setCards({ dummy: d, kotak: k, shoonya: s });
    } catch {
      // cards are optional — don't block the page
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const connected = state?.connected ?? false;
  const isPaper = state?.isPaper ?? false;
  const broker = state?.broker ?? '—';
  const counts = state?.counts ?? {};

  const recent = useMemo(
    () => [...orders]
      .sort((a, b) => String(b.placedAt ?? '').localeCompare(String(a.placedAt ?? '')))
      .slice(0, 12),
    [orders],
  );

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <section className="relative overflow-hidden rounded-2xl border border-border/50 p-0 shadow-sm">
        <div className="relative flex items-center gap-3 p-4 sm:p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-700 border border-emerald-500/20">
            <ListOrdered className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Order Engine</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              Single order choke-point · har broker engine ka apna page — Dummy, Kotak, Shoonya
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnBadge connected={connected} />
            <Badge variant="outline" className={`text-[10px] font-medium ${isPaper ? 'border-amber-500/40 bg-amber-500/10 text-amber-700' : 'border-sky-500/40 bg-sky-500/10 text-sky-700'}`}>
              {isPaper ? 'PAPER' : 'SDK'}
            </Badge>
            <Button size="sm" variant="outline" onClick={() => void loadAll()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-700">
          Engine unavailable: {error}
        </div>
      )}

      {/* BROKER CARDS */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {BROKER_CARDS.map((c) => {
          const d = cards[c.key];
          const cardCounts = d?.counts ?? {};
          return (
            <Card key={c.key} className={`overflow-hidden border ${c.header} shadow-sm`}>
              <CardHeader className={`bg-gradient-to-r pb-2 ${c.key === 'dummy' ? 'from-amber-500/10 to-orange-500/5' : c.key === 'kotak' ? 'from-sky-500/10 to-blue-500/5' : 'from-violet-500/10 to-purple-500/5'}`}>
                <CardTitle className="flex items-center gap-2 text-xs">
                  <span className={`rounded-lg border p-1.5 ${c.accent}`}>
                    <c.icon className="h-3.5 w-3.5" />
                  </span>
                  {c.label}
                  <Badge variant="outline" className="ml-auto font-mono text-[10px]">{c.kind}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Connection</span>
                  <Badge variant="outline" className={d?.connected ? OENG_TONE.emerald : OENG_TONE.rose}>
                    {d == null ? '—' : d.connected ? 'CONNECTED' : 'NOT CONNECTED'}
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['Orders', cardCounts.TOTAL ?? d?.total],
                    ['Working', cardCounts.WORKING],
                    ['Executed', cardCounts.COMPLETE],
                  ] as [string, number | undefined][]).map(([label, v]) => (
                    <div key={label} className="rounded-lg border border-border/60 bg-background px-2 py-1.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                      <p className="font-mono text-sm font-bold tabular-nums">{fmtN(v ?? NaN, 0)}</p>
                    </div>
                  ))}
                </div>
                <p className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{d?.engineKind === 'paper' ? 'LTP-matched paper fills' : `SDK: ${d?.sdk?.sdk ?? '—'}`}</span>
                  <span className="font-mono">{(d?.marketData?.ticksPerSecond ?? 0).toFixed(1)} t/s</span>
                </p>
                <Link href={c.href} className="flex items-center justify-between rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-[11px] font-semibold hover:bg-muted/40">
                  {c.label} page kholo <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* STATE MACHINE */}
      <StateMachinePanel counts={counts} total={counts.TOTAL ?? 0} />

      {/* ORDERS TABLE */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Recent Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderTable
                orders={recent}
                busyOrderId={null}
                emptyMessage={
                  loading ? 'Loading…'
                    : connected || isPaper
                      ? 'No orders on this terminal yet (honest zero).'
                      : `${broker} is not connected — no order book available.`
                }
              />
            </CardContent>
          </Card>
        </div>
        <StateLegend />
      </div>
    </div>
  );
}
