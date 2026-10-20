'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Rows3, ChevronDown, Pin, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SectionCard, LoadingState, ErrorState, EmptyState, fmtCompact, changeTone,
} from '@/components/design-system';
import { cn } from '@/lib/utils';
import {
  rankQuery, fetchJson, SORT_FIELDS,
  useMarketWatchRealtime, overlayRows, RankResponse, MWRow,
  movementTone, toneClass,
} from './mw-shared';
import { StockStatus } from './mw-table';

const PAGE_SIZE = 250;
const ROW_H = 48;
const VIEW_H = 560;

export default function RankTab({ onOpenSymbol, prefiltered, prefilterTotal, onClearPrefilter }: {
  onOpenSymbol: (row: MWRow) => void;
  prefiltered?: MWRow[];
  prefilterTotal?: number;
  onClearPrefilter?: () => void;
}) {
  const [rows, setRows] = useState<MWRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState('changePercent');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [scrollTop, setScrollTop] = useState(0);
  const [pins, setPins] = useState<{ gainers: MWRow[]; losers: MWRow[] }>({ gainers: [], losers: [] });

  // Any pre-filtered result set (e.g. from a saved filter) wins over the
  // default ranked universe.
  const external = prefiltered != null;
  const items = useMemo(() => (external ? (prefiltered ?? []) : rows), [external, prefiltered, rows]);
  const totalCount = external ? (prefilterTotal ?? items.length) : total;

  // doc §26 — the browser gets raw ticks for the rows it is actually showing,
  // not for the whole table. The index window is derived from `items` (the REST
  // snapshot) rather than from the overlaid rows, so the subscription set does
  // not depend on the ticks it is trying to receive. ~28 rows here instead of
  // the previous 400, and scrolling now releases what left the window instead
  // of accumulating.
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const endIdx = Math.min(items.length, startIdx + Math.ceil(VIEW_H / ROW_H) + 16);
  const visibleRows = useMemo(() => items.slice(startIdx, endIdx), [items, startIdx, endIdx]);
  const tokens = useMemo(() => visibleRows.map((r) => r.token), [visibleRows]);

  const { ticks, connectionState, frames } = useMarketWatchRealtime(tokens);
  const liveItem = useMemo(() => overlayRows(items, ticks), [items, ticks]);
  const windowRows = liveItem.slice(startIdx, endIdx);

  const fetchRank = useCallback(async (offset: number, append: boolean) => {
    if (append) setPaging(true); else setLoading(true);
    try {
      const res = await fetchJson<RankResponse>(rankQuery({ offset, limit: PAGE_SIZE, sortBy, sortDir }));
      if (!res.ok) throw new Error('rank unavailable');
      setRows((prev) => (append ? [...prev, ...res.items] : res.items));
      setTotal(res.total);
      setHasMore(res.hasMore);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load ranked universe');
    } finally {
      setLoading(false);
      setPaging(false);
    }
  }, [sortBy, sortDir]);

  useEffect(() => {
    if (!external) void fetchRank(0, false);
  }, [fetchRank, external]);

  // Realtime pins/ranking frame overlay refreshes the pin sets + status counts.
  useEffect(() => {
    const frame = frames['market_watch.pins'];
    const pinsData = (frame?.data?.pins ?? frame?.data) as any;
    if (pinsData && pinsData.gainers) {
      setPins({ gainers: pinsData.gainers ?? [], losers: pinsData.losers ?? [] });
    }
  }, [frames]);

  const changeSort = (by: string) => {
    setSortBy(by);
  };
  const toggleDir = () => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));

  return (
    <SectionCard
      title={external ? 'Filter Results — Full Ranking' : 'Full Universe — Ranked Table'}
      icon={Rows3}
      headerRight={
        <div className="flex items-center gap-2">
          {external ? (
            <Button size="sm" variant="outline" onClick={onClearPrefilter} disabled={!onClearPrefilter}>
              <X className="h-3.5 w-3.5" /> Back to full universe
            </Button>
          ) : null}
          <Badge variant="outline" className="tabular-nums">{totalCount.toLocaleString()} rows</Badge>
          <Badge variant={connectionState === 'CONNECTED' ? 'secondary' : 'outline'} className="tabular-nums">
            {connectionState}
          </Badge>
          {!external && <Button size="sm" variant="ghost" onClick={() => fetchRank(0, false)} aria-label="Refresh"><RefreshCw className="h-3.5 w-3.5" /></Button>}
        </div>
      }
    >
      {!external && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={sortBy} onValueChange={changeSort}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_FIELDS.map((f) => (
                <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={toggleDir}>
            {sortDir === 'desc' ? 'Desc ↓' : 'Asc ↑'}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Rows without a value sort last · tick-rate overlay on the {windowRows.length} visible rows
          </span>
        </div>
      )}

      {loading && !external ? (
        <LoadingState text="Loading full universe…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => fetchRank(0, false)} />
      ) : liveItem.length === 0 ? (
        <EmptyState icon={Rows3} title="No rows" description="Universe is empty — engine may still be warming up." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div
            className="overflow-y-auto"
            style={{ height: VIEW_H }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div style={{ height: liveItem.length * ROW_H, position: 'relative' }}>
              {/* stable sticky header inside the scroll viewport.
                  doc §19/§21/§23 — the extra columns are backend-owned values
                  (1m/30m movement, circuit distance, classification), read
                  straight off the row. The grid template below must stay in
                  sync with the cell count. */}
              <div className="sticky top-0 z-10 grid grid-cols-[3rem_minmax(9rem,1.4fr)_repeat(6,minmax(4.5rem,1fr))_4.5rem_6rem] gap-2 border-b bg-card px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <span>#</span>
                <span>Symbol</span>
                <span className="text-right">LTP</span>
                <span className="text-right">Δ%</span>
                <span className="text-right">1m%</span>
                <span className="text-right">30m%</span>
                <span className="text-right" title="doc §14 — minimum valid circuit distance">Circ</span>
                <span className="text-right" title="doc §17 — authoritative broker leverage">Mult</span>
                <span className="text-right" title="doc §20 — backend classification">Class</span>
                <span className="text-right">Vol</span>
                <span className="text-right">Status</span>
              </div>
              {windowRows.map((row) => {
                const idx = startIdx + windowRows.indexOf(row);
                return (
                  <div
                    key={row.token}
                    className="absolute left-0 right-0 grid grid-cols-[3rem_minmax(9rem,1.4fr)_repeat(6,minmax(4.5rem,1fr))_4.5rem_6rem] items-center gap-2 border-b px-3 text-sm hover:bg-accent/40"
                    style={{ top: idx * ROW_H, height: ROW_H }}
                    onClick={() => onOpenSymbol(row)}
                  >
                    <span className="text-xs text-muted-foreground">{idx + 1}</span>
                    <span className="truncate font-medium">{row.symbol}</span>
                    <span className={cn('text-right font-mono text-xs', row.ltp != null ? '' : 'text-muted-foreground')}>
                      {row.ltp != null ? `₹${row.ltp}` : '--'}
                    </span>
                    <span className={cn('text-right font-mono text-xs font-medium', changeTone(row.changePercent))}>
                      {row.changePercent != null ? `${row.changePercent.toFixed(2)}%` : '--'}
                    </span>
                    <span className={cn('text-right font-mono text-xs', toneClass(movementTone(row.change_1m_pct) === 'up' ? 'GAINER' : movementTone(row.change_1m_pct) === 'down' ? 'LOSER' : 'NORMAL'))}>
                      {row.change_1m_pct != null ? `${row.change_1m_pct.toFixed(2)}%` : '--'}
                    </span>
                    <span className={cn('text-right font-mono text-xs', toneClass(movementTone(row.change_30m_pct) === 'up' ? 'GAINER' : movementTone(row.change_30m_pct) === 'down' ? 'LOSER' : 'NORMAL'))}>
                      {row.change_30m_pct != null ? `${row.change_30m_pct.toFixed(2)}%` : '--'}
                    </span>
                    <span className={cn('text-right font-mono text-[10px]', toneClass(row.circuitStatus))}>
                      {row.circuitDistancePct != null ? `${row.circuitDistancePct.toFixed(2)}%` : '--'}
                    </span>
                    <span className="text-right font-mono text-[10px] text-muted-foreground">
                      {row.marginMultiplier != null ? `${row.marginMultiplier.toFixed(2)}x` : '--'}
                    </span>
                    <span className={cn('text-right text-[10px] uppercase', toneClass(row.classification))}>
                      {row.classification ?? '--'}
                    </span>
                    <span className="text-right font-mono text-xs">{row.volume != null ? fmtCompact(row.volume) : '--'}</span>
                    <span className="flex justify-end"><StockStatus status={row.status} /></span>
                  </div>
                );
              })}
            </div>
          </div>
          {!external && hasMore && (
            <div className="flex justify-center border-t py-2">
              <Button size="sm" variant="outline" onClick={() => fetchRank(rows.length, true)} disabled={paging}>
                {paging ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Load next page ({rows.length.toLocaleString()}/{total.toLocaleString()})
              </Button>
            </div>
          )}
        </div>
      )}
      {pins.gainers.length + pins.losers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-medium">Pinned rows:</span>
          {[...pins.gainers, ...pins.losers].map((p) => (
            <Badge key={p.token} variant="outline" className="tabular-nums"><Pin className="h-2.5 w-2.5" /> {p.symbol}</Badge>
          ))}
        </div>
      )}
    </SectionCard>
  );
}