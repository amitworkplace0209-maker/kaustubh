'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Pin, PinOff, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  PageHeader, SectionCard, LoadingState, EmptyState, ErrorState,
  StatusBadge, fmtPrice, fmtCompact, changeTone, sign,
} from '@/components/design-system';
import { cn } from '@/lib/utils';
import {
  SymbolDetail, DepthLevel, MWRow, fetchJson, useMarketWatchRealtime, overlayTick,
  moverFlag, movementTone, toneClass,
} from './mw-shared';

export default function SymbolTab({ initialSymbol, onPinChange }: {
  initialSymbol?: string;
  onPinChange?: () => void;
}) {
  const [query, setQuery] = useState(initialSymbol ?? '');
  const [detail, setDetail] = useState<SymbolDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [searched, setSearched] = useState('');

  const { ticks, connectionState, frames } = useMarketWatchRealtime(detail?.token ? [detail.token] : []);
  const live = useMemo(() => (detail ? { ...detail, record: overlayTick(detail.record, detail.token ? ticks.get(`nse_cm|${detail.token}`) : undefined) } : null), [detail, ticks]);

  // The market_watch.pins frame may flip manualPinned after external changes.
  useEffect(() => {
    const frame = frames['market_watch.pins'];
    if (!detail || !frame) return;
    const data = (frame as any)?.data;
    const list = (data?.pins as any) ?? null;
    if (list && Array.isArray(list.manual)) {
      const pinned = list.manual.some((p: any) => String(p?.token) === String(detail.token));
      if (pinned !== Boolean(detail.manualPinned)) setDetail((d) => (d ? { ...d, manualPinned: pinned } : d));
    }
  }, [frames, detail]);

  const load = useCallback(async (value?: string) => {
    const q = (value ?? query).trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<SymbolDetail>(`/api/market-watch/symbol/${encodeURIComponent(q)}`);
      if (!res.ok) {
        setError(`Unknown symbol: ${q}`);
        return;
      }
      setDetail(res);
      setSearched(q);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load symbol');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (initialSymbol) load(initialSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSymbol]);

  const togglePin = useCallback(async () => {
    if (!detail) return;
    setPinning(true);
    try {
      if (detail.manualPinned) {
        await fetchJson(`/api/market-watch/pins/${encodeURIComponent(detail.token)}`, { method: 'DELETE' });
      } else {
        await fetchJson('/api/market-watch/pins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: detail.record.symbol }),
        });
      }
      setDetail((d) => (d ? { ...d, manualPinned: !d.manualPinned } : d));
      onPinChange?.();
    } catch {
      setError('Pin action failed — backend unavailable');
    } finally {
      setPinning(false);
    }
  }, [detail, onPinChange]);

  const rec: MWRow = live?.record ?? ({} as MWRow);
  const status = rec.status ?? 'PENDING';
  const statusMeta: Record<string, { tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }> = {
    LIVE: { tone: 'success', label: 'LIVE' },
    STALE: { tone: 'warning', label: 'STALE' },
    PENDING: { tone: 'info', label: 'PENDING' },
    NO_DATA: { tone: 'danger', label: 'NO DATA' },
    INACTIVE: { tone: 'neutral', label: 'INACTIVE' },
  };
  const sm = statusMeta[status] ?? { tone: 'neutral' as const, label: status };

  const maxBuy = live?.depth?.buy?.length ?? 0;
  const maxSell = live?.depth?.sell?.length ?? 0;
  const depthRows = Math.max(maxBuy, maxSell, 1);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          placeholder="Enter symbol or token (e.g. RELIANCE or 2885)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
        />
        <Button size="sm" onClick={() => load()} disabled={loading}>
          {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Load
        </Button>
      </div>

      {error && <ErrorState message={error} onRetry={() => load()} />}

      {!detail && !loading && !error && (
        <EmptyState icon={Search} title="No symbol loaded" description="Search any NSE symbol to see its combined quote, depth ladder and circuit." />
      )}

      {loading && <LoadingState text="Loading symbol detail…" />}

      {live && !loading && (
        <>
          <PageHeader
            title={rec.symbol ?? searched}
            subtitle={rec.name}
          >
            <Badge variant="outline" className="font-mono text-[10px]">{live.token}</Badge>
            <Badge variant="outline">{connectionState}</Badge>
            <StatusBadge status={sm.tone} label={sm.label} />
            <Badge variant={live.state?.priceSource === 'live' ? 'secondary' : 'outline'} className="tabular-nums">
              source: {live.state?.priceSource ?? '—'}
            </Badge>
            {live.state?.dataAgeSec != null && (
              <Badge variant="outline" className="tabular-nums">{live.state.dataAgeSec}s old</Badge>
            )}
            <Button size="sm" variant={live.manualPinned ? 'default' : 'outline'} onClick={togglePin} disabled={pinning}>
              {pinning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : live.manualPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              {live.manualPinned ? 'Unpin' : 'Pin'}
            </Button>
          </PageHeader>

          {/* Big quote */}
          <div className="grid gap-3 md:grid-cols-3">
            <SectionCard title="Quote" className="md:col-span-1 shadow-soft">
              <div className="flex items-end gap-3">
                <span className="font-mono text-3xl font-semibold tabular-nums">
                  {rec.ltp != null ? `₹${fmtPrice(rec.ltp)}` : '--'}
                </span>
                <span className={cn('pb-1 font-mono text-sm font-medium', changeTone(rec.changePercent))}>
                  {rec.changePercent != null ? `${sign(rec.changePercent)}${rec.changePercent.toFixed(2)}%` : ''}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <span className="text-muted-foreground">Day range</span>
                <span className="font-mono text-right">{rec.low != null && rec.high != null ? `₹${fmtPrice(rec.low)} – ₹${fmtPrice(rec.high)}` : '--'}</span>
                <span className="text-muted-foreground">Open</span>
                <span className="font-mono text-right">{rec.open != null ? `₹${fmtPrice(rec.open)}` : '--'}</span>
                <span className="text-muted-foreground">Prev. close</span>
                <span className="font-mono text-right">{rec.prevClose != null ? `₹${fmtPrice(rec.prevClose)}` : '--'}</span>
                <span className="text-muted-foreground">Avg price</span>
                <span className="font-mono text-right">{rec.avgPrice != null ? `₹${fmtPrice(rec.avgPrice)}` : '--'}</span>
                <span className="text-muted-foreground">Last trade</span>
                <span className="font-mono text-right text-[10px]">{rec.lastTradeTime ?? '--'}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge variant="outline" className="tabular-nums">Vol {rec.volume != null ? fmtCompact(rec.volume) : '--'}</Badge>
                <Badge variant="outline" className="tabular-nums">Turnover {rec.tradedValue != null ? fmtCompact(rec.tradedValue) : '--'}</Badge>
                <Badge variant="outline" className="tabular-nums">OI {rec.oi != null ? fmtCompact(rec.oi) : '--'}</Badge>
                <Badge variant="outline" className="tabular-nums">B/S {rec.buySellRatio != null ? rec.buySellRatio.toFixed(2) : '--'}</Badge>
                <Badge variant="outline" className="tabular-nums">Spread {rec.spread != null ? fmtPrice(rec.spread) : '--'}</Badge>
              </div>
            </SectionCard>

            {/* Depth ladder */}
            <SectionCard
              title="Depth Ladder"
              className="md:col-span-1 shadow-soft"
              headerRight={<Badge variant="outline" className="tabular-nums">{live?.depth?.source === 'ws' ? 'live' : 'REST'}</Badge>}
            >
              {live?.depth?.available ? (
                <DepthLadder buy={live.depth.buy} sell={live.depth.sell} rows={depthRows} />
              ) : (
                <EmptyState icon={Search} title="Depth unavailable" description="Broker feed did not include an order book for this token." />
              )}
            </SectionCard>

            {/* Circuits + reference */}
            <SectionCard title="Circuit & Reference" className="md:col-span-1 shadow-soft">
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Upper circuit</span>
                  <span className="font-mono">{rec.upperCircuit != null ? `₹${fmtPrice(rec.upperCircuit)}` : '--'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Lower circuit</span>
                  <span className="font-mono">{rec.lowerCircuit != null ? `₹${fmtPrice(rec.lowerCircuit)}` : '--'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">52-week high</span>
                  <span className="font-mono">{rec.yearlyHigh != null ? `₹${fmtPrice(rec.yearlyHigh)}` : '--'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">52-week low</span>
                  <span className="font-mono">{rec.yearlyLow != null ? `₹${fmtPrice(rec.yearlyLow)}` : '--'}</span>
                </div>
                <div className="mt-1 flex items-center justify-between border-t pt-2">
                  <span className="text-muted-foreground">Exchange</span>
                  <span className="font-mono uppercase">{rec.exchange ?? '--'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Segment</span>
                  <span className="font-mono uppercase">{rec.segment ?? '--'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Intraday eligible</span>
                  <span>{rec.intradayEligible == null ? '--' : rec.intradayEligible ? 'Yes' : 'No'}</span>
                </div>
                {/* doc §15 — the three-value eligibility status. */}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Intraday status</span>
                  <span className={toneClass(rec.intradayStatus)}>{rec.intradayStatus ?? '--'}</span>
                </div>
                {/* doc §14 — real circuit prices AND the distances derived from
                    them. Never derived here; `UNKNOWN` means the broker sent no
                    circuit and safety is deliberately not claimed. */}
                <div className="mt-1 flex items-center justify-between border-t pt-2">
                  <span className="text-muted-foreground">Circuit status</span>
                  <span className={toneClass(rec.circuitStatus)}>{rec.circuitStatus ?? 'UNKNOWN'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Distance to upper</span>
                  <span className="font-mono">
                    {rec.circuitDistanceUpperPct != null ? `${rec.circuitDistanceUpperPct.toFixed(2)}%` : '--'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Distance to lower</span>
                  <span className="font-mono">
                    {rec.circuitDistanceLowerPct != null ? `${rec.circuitDistanceLowerPct.toFixed(2)}%` : '--'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Minimum distance</span>
                  <span className={toneClass(rec.circuitStatus)}>
                    {rec.circuitDistancePct != null ? `${rec.circuitDistancePct.toFixed(2)}%` : '--'}
                  </span>
                </div>
                {/* doc §17 — authoritative broker margin. Never invented. */}
                <div className="mt-1 flex items-center justify-between border-t pt-2">
                  <span className="text-muted-foreground">Margin status</span>
                  <span className={toneClass(rec.marginStatus)}>{rec.marginStatus ?? '--'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Required margin</span>
                  <span className="font-mono">{rec.marginValue != null ? `₹${fmtPrice(rec.marginValue)}` : '--'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Leverage / multiplier</span>
                  <span className="font-mono">
                    {rec.marginMultiplier != null ? `${rec.marginMultiplier.toFixed(2)}x` : '--'}
                  </span>
                </div>
                {/* doc §19 — all four timeframes. 1m and 30m were never rendered. */}
                <div className="mt-1 border-t pt-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Timeframe change (backend)
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                    {(['1m', '5m', '10m', '30m'] as const).map((tf) => (
                      <div key={tf} className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {tf}
                          {moverFlag(rec, tf) ? (
                            <span className="ml-1 rounded border border-border/60 px-0.5 text-[8px]">1%</span>
                          ) : null}
                        </span>
                        <span className={toneClass(movementTone(rec[`change_${tf}_pct`]) === 'up' ? 'GAINER' : movementTone(rec[`change_${tf}_pct`]) === 'down' ? 'LOSER' : 'NORMAL')}>
                          {rec[`change_${tf}_pct`] != null
                            ? `${sign(rec[`change_${tf}_pct`]!)}${rec[`change_${tf}_pct`]!.toFixed(2)}%`
                            : '--'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                {/* doc §20/§27 */}
                <div className="mt-1 flex items-center justify-between border-t pt-2">
                  <span className="text-muted-foreground">Classification</span>
                  <span className={toneClass(rec.classification)}>{rec.classification ?? '--'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Stock state</span>
                  <span className={toneClass(rec.stockState)}>{rec.stockState ?? '--'}</span>
                </div>
                {/* doc §16 — ₹800 observation counters for the weekly review. */}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">≥ threshold / ≤ threshold</span>
                  <span className="font-mono">
                    {rec.observationsAboveThreshold ?? '--'} / {rec.observationsAtOrBelowThreshold ?? '--'}
                  </span>
                </div>
                {/* doc §12 */}
                <div className="mt-1 flex items-center justify-between border-t pt-2">
                  <span className="text-muted-foreground">Data quality</span>
                  <span className="font-mono">
                    {rec.dataQuality ?? '--'}
                    {rec.dataAgeSec != null ? ` · ${rec.dataAgeSec.toFixed(0)}s old` : ''}
                  </span>
                </div>
              </div>
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}

function DepthLadder({ buy, sell, rows }: { buy: DepthLevel[]; sell: DepthLevel[]; rows: number }) {
  const bestBid = buy[0]?.price;
  const bestAsk = sell[0]?.price;
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_1fr] gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Buy (bid)</span>
        <span className="text-right">Sell (ask)</span>
      </div>
      {Array.from({ length: rows }).map((_, i) => {
        const b = buy[i];
        const s = sell[i];
        return (
          <div key={i} className="grid grid-cols-[1fr_1fr] gap-2">
            <div className={cn('rounded-md border px-2 py-1.5 text-xs', b?.price === bestBid && b?.price != null && 'border-emerald-500/40 bg-emerald-500/5')}>
              {b ? (
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono font-medium text-emerald-600 dark:text-emerald-400">₹{fmtPrice(b.price)}</span>
                  <span className="font-mono tabular-nums">{fmtCompact(b.quantity)}</span>
                  {b.orders != null && <span className="text-muted-foreground">×{b.orders}</span>}
                </div>
              ) : <span className="text-muted-foreground">—</span>}
            </div>
            <div className={cn('rounded-md border px-2 py-1.5 text-xs', s?.price === bestAsk && s?.price != null && 'border-red-500/40 bg-red-500/5')}>
              {s ? (
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono tabular-nums">{fmtCompact(s.quantity)}</span>
                  {s.orders != null && <span className="text-muted-foreground">×{s.orders}</span>}
                  <span className="font-mono font-medium text-red-600 dark:text-red-400">₹{fmtPrice(s.price)}</span>
                </div>
              ) : <span className="text-muted-foreground">—</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}