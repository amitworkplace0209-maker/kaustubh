'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Rows3, ChevronDown, Pin, X, Search, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SectionCard, LoadingState, ErrorState, EmptyState, fmtCompact, changeTone,
} from '@/components/design-system';
import { cn } from '@/lib/utils';
import {
  rankQuery, fetchJson, SORT_FIELDS,
  useMarketWatchRealtime, overlayRows, RankResponse, MWRow,
  toneClass,
} from './mw-shared';
import { StockStatus } from './mw-table';

const PAGE_SIZE = 250;
const ROW_H = 48;
const VIEW_H = 560;

/**
 * One source of truth for the ranked-row grid. The header and every body row
 * render exactly twelve cells into this template — the previous template had
 * ten tracks for eleven cells, so the trailing Status cell wrapped onto the
 * next line and overlapped the row below it.
 *
 * # | Symbol | LTP | Δ% | 1m% | 5m% | 30m% | Circ | Mult | Class | Vol | Status
 */
const GRID_COLS =
  'grid-cols-[3rem_minmax(9rem,1.4fr)_5rem_4.5rem_4rem_4rem_4.5rem_4.5rem_4rem_5rem_5rem_6rem]';
const MIN_WIDTH = 980;

function pctTone(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return 'text-muted-foreground';
  return changeTone(value);
}

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
  const [search, setSearch] = useState('');
  const [meta, setMeta] = useState<{ tradingDate?: string; generatedAt?: string; feedState?: string }>({});
  const [pins, setPins] = useState<{ gainers: MWRow[]; losers: MWRow[] }>({ gainers: [], losers: [] });

  // Any pre-filtered result set (e.g. from a saved filter) wins over the
  // default ranked universe.
  const external = prefiltered != null;
  const baseItems = useMemo(() => (external ? (prefiltered ?? []) : rows), [external, prefiltered, rows]);
  const totalCount = external ? (prefilterTotal ?? baseItems.length) : total;

  // Symbol search over the rows already loaded. The backend owns membership
  // and values; searching only narrows the rendered set, it never re-ranks.
  const items = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return baseItems;
    return baseItems.filter((r) =>
      String(r.symbol ?? '').toUpperCase().includes(q) ||
      String(r.name ?? '').toUpperCase().includes(q),
    );
  }, [baseItems, search]);

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
      setMeta({ tradingDate: res.tradingDate, generatedAt: res.generatedAt, feedState: res.feedState });
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

  const exportCsv = () => {
    const header = [
      'rank', 'symbol', 'name', 'ltp', 'change_pct', 'change_1m_pct', 'change_5m_pct',
      'change_30m_pct', 'circuit_distance_pct', 'circuit_status', 'margin_multiplier',
      'margin_status', 'classification', 'volume', 'turnover', 'status',
    ];
    const rowsCsv = liveItem.map((r, i) => [
      i + 1, r.symbol, r.name, r.ltp, r.changePercent, r.change_1m_pct, r.change_5m_pct,
      r.change_30m_pct, r.circuitDistancePct, r.circuitStatus, r.marginMultiplier,
      r.marginStatus, r.classification, r.volume, r.turnover, r.status,
    ].map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
    const blob = new Blob([[header.join(','), ...rowsCsv].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `market-watch-rank-${meta.tradingDate ?? 'today'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
          <Badge variant="outline" className="tabular-nums">
            {search ? `${items.length.toLocaleString()} / ${totalCount.toLocaleString()}` : totalCount.toLocaleString()} rows
          </Badge>
          <Badge variant={connectionState === 'CONNECTED' ? 'secondary' : 'outline'} className="tabular-nums">
            {connectionState}
          </Badge>
          <Button size="sm" variant="ghost" onClick={exportCsv} aria-label="Export visible rows as CSV" title="Export visible rows (CSV)">
            <Download className="h-3.5 w-3.5" />
          </Button>
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
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter loaded rows by symbol / name"
              className="h-8 w-64 pl-8 text-xs"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <span className="text-[11px] text-muted-foreground">
            Rows without a value sort last · live overlay on {windowRows.length} visible rows
            {meta.generatedAt ? ` · snapshot ${new Date(meta.generatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}
          </span>
        </div>
      )}

      {loading && !external ? (
        <LoadingState text="Loading full universe…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => fetchRank(0, false)} />
      ) : liveItem.length === 0 ? (
        <EmptyState
          icon={Rows3}
          title={search ? 'No matching rows' : 'No rows'}
          description={search
            ? `No loaded symbol matches “${search}”. Clear the search or load more rows.`
            : 'Universe is empty — engine may still be warming up.'}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div
            className="overflow-auto"
            style={{ height: VIEW_H }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div style={{ height: liveItem.length * ROW_H, position: 'relative', minWidth: MIN_WIDTH }}>
              {/* Stable sticky header inside the scroll viewport. doc
                  §19/§21/§23 — the extra columns are backend-owned values
                  (1m/5m/30m movement, circuit distance, margin multiplier,
                  classification), read straight off the row. */}
              <div className={cn('sticky top-0 z-10 grid gap-2 border-b bg-card px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground', GRID_COLS)}>
                <span>#</span>
                <span>Symbol</span>
                <span className="text-right">LTP</span>
                <span className="text-right">Δ%</span>
                <span className="text-right">1m%</span>
                <span className="text-right">5m%</span>
                <span className="text-right">30m%</span>
                <span className="text-right" title="doc §14 — minimum valid circuit distance">Circ</span>
                <span className="text-right" title="doc §17 — authoritative broker leverage">Mult</span>
                <span className="text-right" title="doc §20 — backend classification">Class</span>
                <span className="text-right">Vol</span>
                <span className="text-right">Status</span>
              </div>
              {windowRows.map((row, i) => {
                const idx = startIdx + i;
                return (
                  <div
                    key={row.token}
                    className={cn('absolute left-0 right-0 grid cursor-pointer items-center gap-2 border-b px-3 text-sm hover:bg-accent/40', GRID_COLS)}
                    style={{ top: idx * ROW_H, height: ROW_H }}
                    onClick={() => onOpenSymbol(row)}
                    title={row.name ? `${row.symbol} — ${row.name}` : row.symbol}
                  >
                    <span className="text-xs text-muted-foreground">{idx + 1}</span>
                    <span className="truncate font-medium">{row.symbol}</span>
                    <span className={cn('text-right font-mono text-xs', row.ltp != null ? '' : 'text-muted-foreground')}>
                      {row.ltp != null ? `₹${row.ltp}` : '--'}
                    </span>
                    <span className={cn('text-right font-mono text-xs font-medium', changeTone(row.changePercent))}>
                      {row.changePercent != null ? `${row.changePercent.toFixed(2)}%` : '--'}
                    </span>
                    <span className={cn('text-right font-mono text-xs', pctTone(row.change_1m_pct))}>
                      {row.change_1m_pct != null ? `${row.change_1m_pct.toFixed(2)}%` : '--'}
                    </span>
                    <span className={cn('text-right font-mono text-xs', pctTone(row.change_5m_pct))}>
                      {row.change_5m_pct != null ? `${row.change_5m_pct.toFixed(2)}%` : '--'}
                    </span>
                    <span className={cn('text-right font-mono text-xs', pctTone(row.change_30m_pct))}>
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
          {!external && hasMore && !search && (
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
