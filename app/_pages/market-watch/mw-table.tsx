'use client';

import { TrendingUp, TrendingDown, ChevronDown, RefreshCw, Pin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  SectionCard,
  StatusBadge,
  EmptyState,
  LoadingState,
  fmtPrice,
  fmtCompact,
  changeTone,
  sign,
} from '@/components/design-system';
import { cn } from '@/lib/utils';
import {
  MWRow,
  STATUSES,
  DASH,
  classificationOf,
  moverFlag,
  movementTone,
  toneClass,
} from './mw-shared';

/** Optional columns per table renderer. */
export interface RowCols {
  momentum?: boolean; // 5m% column
  volume?: boolean;   // volume column
  turnover?: boolean; // traded value column
  oi?: boolean;       // open interest column
  rank?: number;      // leading # column
  /** doc §19 — render all timeframe change columns (1m/2m/5m/10m/30m). */
  timeframes?: boolean;
  /** doc §14/§17 — circuit distance + margin columns. */
  circuit?: boolean;
  /** doc §20/§21 — classification + mover flags. */
  classification?: boolean;
  /** doc §12/§27 — data quality and last tick age. */
  quality?: boolean;
}

export function StockStatus({ status }: { status?: string | null }) {
  const meta = STATUSES[status ?? 'PENDING'] ?? { tone: 'neutral' as const, label: status ?? 'PENDING' };
  return <StatusBadge status={meta.tone} label={meta.label} />;
}

/** doc §20 — the backend classification label, rendered verbatim. */
function ClassificationCell({ row }: { row: MWRow }) {
  const classification = classificationOf(row);
  if (!classification) return <span className="text-xs text-muted-foreground">{DASH}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('text-[10px] uppercase', toneClass(classification))}>{classification}</span>
      {(['1m', '2m', '5m', '10m', '30m'] as const)
        .filter((tf) => moverFlag(row, tf))
        .map((tf) => (
          <span
            key={tf}
            title={`doc §21: ${tf} moved ≥ 1% (backend-flagged)`}
            className="rounded border border-border/60 px-1 text-[9px] text-muted-foreground"
          >
            {tf}
          </span>
        ))}
    </span>
  );
}

/** doc §14 — circuit distance + status as the backend computed them. */
function CircuitCell({ row }: { row: MWRow }) {
  const distance = row.circuitDistancePct;
  const status = row.circuitStatus ?? null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px]">
      <span className={toneClass(status)}>{status ?? DASH}</span>
      <span className="text-muted-foreground">
        {typeof distance === 'number' ? `${distance.toFixed(2)}%` : DASH}
      </span>
    </span>
  );
}

/** doc §17 — margin is authoritative or explicitly unavailable. */
function MarginCell({ row }: { row: MWRow }) {
  return (
    <span className="font-mono text-[11px]">
      {typeof row.marginMultiplier === 'number' ? `${row.marginMultiplier.toFixed(2)}x` : DASH}
      {row.marginStatus && row.marginStatus !== 'AUTHORITATIVE' ? (
        <span className={cn('ml-1 text-[9px] uppercase', toneClass(row.marginStatus))}>{row.marginStatus}</span>
      ) : null}
    </span>
  );
}

/** doc §12 — data quality + how old the last tick is. */
function QualityCell({ row }: { row: MWRow }) {
  const quality = typeof row.dataQuality === 'string' ? row.dataQuality : null;
  const age = typeof row.dataAgeSec === 'number' ? row.dataAgeSec : null;
  return (
    <span className="font-mono text-[10px] text-muted-foreground">
      {quality ?? DASH}
      {age != null ? <span className="ml-1">· {age.toFixed(0)}s</span> : null}
    </span>
  );
}

/** doc §19 — one flat per-timeframe change cell, read not derived. */
function TimeframeCell({ row, tf }: { row: MWRow; tf: '1m' | '2m' | '5m' | '10m' | '30m' }) {
  const pct = row[`change_${tf}_pct`];
  const abs = row[`change_${tf}`];
  return (
    <span className={cn('font-mono text-xs', toneClass(movementTone(pct) === 'up' ? 'GAINER' : movementTone(pct) === 'down' ? 'LOSER' : 'NORMAL'))}>
      {typeof pct === 'number' ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : DASH}
      {typeof abs === 'number' ? (
        <span className="ml-0.5 text-[9px] text-muted-foreground">({abs >= 0 ? '+' : ''}{abs.toFixed(2)})</span>
      ) : null}
    </span>
  );
}

export function MwRowRow({
  row, index, cols = {}, pinned, top5, onClick,
}: {
  row: MWRow;
  index: number;
  cols?: RowCols;
  pinned?: boolean;
  top5?: boolean;
  onClick?: () => void;
}) {
  const rankNo = cols.rank != null ? index + 1 + (cols.rank - 1) : index + 1;
  return (
    <TableRow key={row.token} className={onClick ? 'cursor-pointer' : undefined} onClick={onClick}>
      <TableCell className={cn('text-xs text-muted-foreground', !cols.rank && 'w-8')}>{rankNo}</TableCell>
      <TableCell className="max-w-[190px]">
        <div className="flex items-center gap-1.5">
          <span className="font-medium truncate">{row.symbol}</span>
          {row.intradayEligible === false && (
            <Badge variant="outline" className="text-[9px] px-1.5">no-intraday</Badge>
          )}
          {row.eligibilityStatus === 'BLOCKED' && row.blockReason && (
            <Badge variant="outline" className="border-amber-500/50 px-1.5 text-[9px] text-amber-500" title={row.blockReason}>
              {row.blockReason}
            </Badge>
          )}
        </div>
        {row.name && <div className="text-[10px] text-muted-foreground truncate max-w-[160px]">{row.name}</div>}
      </TableCell>
      <TableCell className={cn('text-right font-mono text-sm', row.ltp != null ? '' : 'text-muted-foreground')}>
        {row.ltp != null ? `₹${fmtPrice(row.ltp)}` : '--'}
      </TableCell>
      <TableCell className={cn('text-right font-mono text-sm font-medium', changeTone(row.changePercent))}>
        {row.changePercent != null ? `${sign(row.changePercent)}${row.changePercent.toFixed(2)}%` : '--'}
      </TableCell>
      {cols.momentum && (
        <TableCell className="text-right font-mono text-xs hidden md:table-cell">
          {row.fiveMinPercent != null ? (
            <span className={cn(changeTone(row.fiveMinPercent))}>
              {sign(row.fiveMinPercent)}{row.fiveMinPercent.toFixed(2)}%
            </span>
          ) : '--'}
        </TableCell>
      )}
      {/* doc §19 — 1m and 30m were previously not rendered at all. */}
      {cols.timeframes && (
        <>
          {(['1m', '2m', '5m', '10m', '30m'] as const).map((tf) => (
            <TableCell key={tf} className="hidden text-right lg:table-cell">
              <TimeframeCell row={row} tf={tf} />
            </TableCell>
          ))}
        </>
      )}
      {cols.circuit && (
        <>
          <TableCell className="hidden lg:table-cell"><CircuitCell row={row} /></TableCell>
          <TableCell className="hidden xl:table-cell"><MarginCell row={row} /></TableCell>
        </>
      )}
      {cols.classification && (
        <TableCell className="hidden md:table-cell"><ClassificationCell row={row} /></TableCell>
      )}
      {cols.quality && (
        <TableCell className="hidden xl:table-cell"><QualityCell row={row} /></TableCell>
      )}
      {cols.volume && (
        <TableCell className={cn('text-right font-mono text-xs hidden sm:table-cell', row.volume == null && 'text-muted-foreground')}>
          {row.volume != null ? fmtCompact(row.volume) : '--'}
        </TableCell>
      )}
      {cols.turnover && (
        <TableCell className={cn('text-right font-mono text-xs hidden lg:table-cell', row.tradedValue == null && 'text-muted-foreground')}>
          {row.tradedValue != null ? fmtCompact(row.tradedValue) : '--'}
        </TableCell>
      )}
      {cols.oi && (
        <TableCell className={cn('text-right font-mono text-xs hidden xl:table-cell', row.oi == null && 'text-muted-foreground')}>
          {row.oi != null ? fmtCompact(row.oi) : '--'}
        </TableCell>
      )}
      <TableCell>
        {pinned ? (
          <Badge variant="secondary" className="text-[10px]">
            <Pin className="h-2.5 w-2.5" /> Pin
          </Badge>
        ) : top5 ? (
          <Badge variant="outline" className="text-[10px]">Top5</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell><StockStatus status={row.status} /></TableCell>
    </TableRow>
  );
}

export function MwTableShell({
  children, empty, loading,
  headerCells, onLoadMore, hasMore, paging,
}: {
  children: React.ReactNode[];
  empty?: boolean;
  loading?: boolean;
  headerCells: string[];
  onLoadMore?: () => void;
  hasMore?: boolean;
  paging?: boolean;
}) {
  if (loading) return <LoadingState text="Loading…" />;
  if (empty) return null;
  return (
    <>
      <div className="max-h-[420px] overflow-y-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {headerCells.map((h) => (
                <TableHead key={h}>
                  <span className="capitalize">{h}</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>{children}</TableBody>
        </Table>
      </div>
      {hasMore && (
        <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onLoadMore} disabled={paging}>
          {paging ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Load more
        </Button>
      )}
    </>
  );
}

export function SectionListCard({
  title, icon: Icon, stocks, loading, emptyMessage,
  pinnedTokens, currentTop5, hasMore, onLoadMore, paging,
  cols = { momentum: true, volume: true, classification: true },
}: {
  title: string;
  icon: React.ElementType;
  stocks: MWRow[];
  loading: boolean;
  emptyMessage: string;
  pinnedTokens?: Set<string>;
  currentTop5?: Set<string>;
  hasMore?: boolean;
  onLoadMore?: () => void;
  paging?: boolean;
  cols?: RowCols;
}) {
  // Header must mirror the enabled columns exactly or the table reads shifted.
  const headers = ['#', 'Symbol', 'LTP', 'Δ%'];
  if (cols.momentum) headers.push('5m%');
  if (cols.timeframes) headers.push('1m', '2m', '5m', '10m', '30m');
  if (cols.circuit) headers.push('Circuit', 'Margin');
  if (cols.classification) headers.push('Class');
  if (cols.quality) headers.push('Quality');
  if (cols.volume) headers.push('Vol');
  if (cols.turnover) headers.push('Value');
  if (cols.oi) headers.push('OI');
  headers.push('Pin', 'Status');

  return (
    <SectionCard
      title={title}
      icon={Icon}
      headerRight={<Badge variant="outline" className="tabular-nums">{stocks.length}</Badge>}
      className="shadow-soft"
    >
      {loading ? (
        <LoadingState text="Loading…" />
      ) : stocks.length === 0 ? (
        <EmptyState icon={Icon} title={emptyMessage} />
      ) : (
        <MwTableShell
          headerCells={headers}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          paging={paging}
        >
          {stocks.map((s, i) => (
            <MwRowRow
              key={s.token}
              row={s}
              index={i}
              cols={cols}
              pinned={pinnedTokens?.has(s.token)}
              top5={currentTop5?.has(s.token)}
            />
          ))}
        </MwTableShell>
      )}
    </SectionCard>
  );
}

export function PinBadges({
  gainers, losers,
}: {
  gainers: MWRow[];
  losers: MWRow[];
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <PinList icon={TrendingUp} title="Gainer Pins" pins={gainers} accentClass="text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/15 dark:border-emerald-500/30" empty="No gainer pins yet — Top-5 frequency pins appear as the engine warms up." />
      <PinList icon={TrendingDown} title="Loser Pins" pins={losers} accentClass="text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/15 dark:border-red-500/30" empty="No loser pins yet — Top-5 frequency pins appear as the engine warms up." />
    </div>
  );
}

function PinList({
  icon: Icon, title, pins, accentClass, empty,
}: {
  icon: React.ElementType;
  title: string;
  pins: MWRow[];
  accentClass: string;
  empty: string;
}) {
  return (
    <SectionCard title={title} icon={Icon} headerRight={<Badge variant="outline">{pins.length}</Badge>} className="shadow-soft">
      {pins.length ? (
        <div className="flex flex-wrap gap-2">
          {pins.map((p) => (
            <Badge key={p.token} variant="secondary" title={`Rank #${String(p.lastRank ?? '—')} · seen ${String(p.lastSeen ?? '—')}`} className={cn('gap-1', accentClass)}>
              <Pin className="h-3 w-3" /> {p.symbol}
              {p.appearances != null && <span className="opacity-70">({String(p.appearances)})</span>}
            </Badge>
          ))}
        </div>
      ) : (
        <EmptyState icon={Icon} title={empty} />
      )}
    </SectionCard>
  );
}