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
  tickOf, moverFlag, movementTone, toneClass,
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
  const [suggestions, setSuggestions] = useState<MWRow[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [quickPicks, setQuickPicks] = useState<MWRow[]>([]);
  const [quickLoading, setQuickLoading] = useState(true);

  const { ticks, connectionState, frames } = useMarketWatchRealtime(detail?.token ? [detail.token] : []);
  const live = useMemo(
    () => (detail
      ? { ...detail, record: overlayTick(detail.record, detail.token ? tickOf(ticks, detail.token) : undefined) }
      : null),
    [detail, ticks],
  );

  /**
   * Suggestions + quick picks. Only symbols in the active locked universe can
   * carry live ticks, so this is the honest way to make the page usable: show
   * the symbols that actually have data instead of silently returning an empty
   * quote for a symbol the engine is not subscribed to.
   */
  useEffect(() => {
    const q = query.trim();
    if (!q) { setSuggestions([]); return; }
    if (detail && q.toUpperCase() === String(detail.symbol ?? '').toUpperCase()) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetchJson<{ items: MWRow[] }>(
          `/api/market-watch/search?q=${encodeURIComponent(q)}&limit=8`,
        );
        if (!cancelled) setSuggestions(res.items ?? []);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, detail]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchJson<{ items: MWRow[] }>('/api/market-watch/page?section=top_gainers&limit=8');
        if (!cancelled) setQuickPicks(res.items ?? []);
      } catch {
        if (!cancelled) setQuickPicks([]);
      } finally {
        if (!cancelled) setQuickLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
    setSuggestOpen(false);
    setSuggestions([]);
    try {
      const res = await fetchJson<SymbolDetail>(`/api/market-watch/symbol/${encodeURIComponent(q)}`);
      if (!res.ok) {
        setDetail(null);
        setError(`Unknown symbol: ${q}`);
        return;
      }
      setDetail(res);
      setSearched(res.symbol ?? q);
      setQuery(res.symbol ?? q);
    } catch (err: any) {
      setDetail(null);
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
          body: JSON.stringify({ symbol: detail.record.symbol ?? detail.symbol }),
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
  const status = rec.status ?? live?.state?.status ?? 'PENDING';
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

  // Honest coverage explanation instead of an empty-looking page. The engine
  // only subscribes the locked weekly universe (doc §2/§16), so a symbol
  // outside it can never show live quote/depth values.
  const coverageMessage = status === 'LIVE'
    ? null
    : rec.locked === false
      ? `This symbol is not part of the active locked universe. Only locked symbols are subscribed for live ticks, so quote, depth and circuit fields are unavailable.`
      : status === 'NO_DATA'
        ? `The broker feed reports no data for this token. Quote and depth stay empty rather than being estimated.`
        : status === 'STALE'
          ? `The last tick is older than the freshness threshold. Values below are the backend's last real state, not a fresh quote.`
          : `The engine has not received a tick for this token yet. Quote and depth will fill in when the feed publishes it.`;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search a locked-universe symbol or token (e.g. KNACK-EQ or 763839)"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSuggestOpen(true); }}
            onFocus={() => setSuggestOpen(true)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(); if (e.key === 'Escape') setSuggestOpen(false); }}
            className="pl-9"
          />
          {suggestOpen && suggestions.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-card shadow-lg">
              {suggestions.map((s) => (
                <button
                  key={s.token}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 border-b px-3 py-1.5 text-left last:border-b-0 hover:bg-accent/50"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setQuery(s.symbol); load(s.symbol); }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{s.symbol}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{s.name}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-xs">{s.ltp != null ? `₹${fmtPrice(s.ltp)}` : '--'}</span>
                    <span className={cn('block font-mono text-[10px]', changeTone(s.changePercent))}>
                      {s.changePercent != null ? `${sign(s.changePercent)}${s.changePercent.toFixed(2)}%` : '--'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Button size="sm" onClick={() => load()} disabled={loading}>
          {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Load
        </Button>
      </div>

      {error && <ErrorState message={error} onRetry={() => load()} />}

      {!detail && !loading && (
        <SectionCard
          title="Quick Picks"
          icon={Search}
          headerRight={<Badge variant="outline" className="text-[10px]">active universe</Badge>}
        >
          {quickLoading ? (
            <LoadingState text="Loading symbols…" />
          ) : quickPicks.length === 0 ? (
            <EmptyState icon={Search} title="Search a symbol" description="Type a symbol above — suggestions come from the active locked universe." />
          ) : (
            <>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Top gainers in the locked universe. Only subscribed symbols have live quotes, depth and
                circuit data, so picking one of these always loads a working detail view.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {quickPicks.map((r) => (
                  <button
                    key={r.token}
                    type="button"
                    onClick={() => { setQuery(r.symbol); load(r.symbol); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] hover:border-primary/50"
                  >
                    <span className="font-medium">{r.symbol}</span>
                    <span className={cn('font-mono', changeTone(r.changePercent))}>
                      {r.changePercent != null ? `${sign(r.changePercent)}${r.changePercent.toFixed(2)}%` : '--'}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </SectionCard>
      )}

      {loading && <LoadingState text="Loading symbol detail…" />}

      {live && !loading && (
        <>
          {coverageMessage && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="font-semibold">{rec.symbol ?? searched}</span> — {coverageMessage}
            </div>
          )}
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