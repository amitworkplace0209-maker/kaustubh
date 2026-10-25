'use client';

// ---- Data Center: chart section (lazily loaded) ----
//
// recharts is by far the heaviest dependency this page pulls in, and the two
// charts sit far below the fold. Keeping them in their own module lets the page
// dynamic-import it, so the first paint ships without any charting code. The
// module is rendered behind the same skeletons the page already showed while the
// section was loading, so nothing changes visually — the chunk just arrives
// after the page is already interactive.

import { useMemo } from 'react';
import { HardDrive, History } from 'lucide-react';
import { EmptyState, SectionCard } from '@/components/design-system';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import { clockLabel, fmtBytes, shortDate, validSeries } from '@/lib/data-center';
import type { DcDailyRow, DcTrendPoint } from '@/lib/data-center';
import type { DcWindowDays } from '@/lib/data-center-store';
import { SectionError } from './dc-section-error';

function bytesTick(v: number) {
  return fmtBytes(Number.isFinite(v) ? v : null).replace(' N/A', '');
}

function DailyHistoryChart({ rows, days, error }: { rows: DcDailyRow[]; days: DcWindowDays; error: string | null }) {
  const { cleaned, dropped } = useMemo(
    () => validSeries(rows, 'date', ['ticksWritten', 'uniqueSymbols']),
    [rows],
  );
  const data = useMemo(() => cleaned.map((r) => ({
    label: shortDate(r.date),
    ticks: r.ticksWritten ?? 0,
    symbols: r.uniqueSymbols ?? 0,
  })), [cleaned]);

  return (
    <SectionCard
      title={`Daily ticks written (${days}d)`}
      icon={History}
      headerRight={
        <div className="flex items-center gap-2">
          {dropped > 0 && <span className="text-[10px] text-muted-foreground">{dropped} invalid points removed</span>}
          <SectionError error={error} />
        </div>
      }
      className="min-h-[260px]"
    >
      {data.length === 0 && !error ? (
        <EmptyState icon={History} title="No daily rows yet" description="The daily aggregation returns real per-day counts from MongoDB." />
      ) : (
        <ChartContainer config={{
          ticks: { label: 'Ticks written', color: 'hsl(var(--teal))' },
          symbols: { label: 'Unique symbols', color: 'hsl(var(--info))' },
        }} className="h-[220px]">
          <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={Math.max(0, Math.ceil(data.length / 7) - 1)} tick={{ fontSize: 10 }} />
            <YAxis tickLine={false} axisLine={false} width={48} tick={{ fontSize: 10 }} />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Bar dataKey="ticks" fill="var(--color-ticks)" radius={[2, 2, 0, 0]} />
            <Line dataKey="symbols" type="monotone" stroke="var(--color-symbols)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ChartContainer>
      )}
    </SectionCard>
  );
}

function StorageTrendChart({ points, error }: { points: DcTrendPoint[]; error: string | null }) {
  const { cleaned, dropped } = useMemo(
    () => validSeries(points, 'ts', ['dbTotalStorageBytes', 'dbTotalIndexBytes', 'diskUsedBytes']),
    [points],
  );
  const data = useMemo(() => cleaned.map((p) => ({
    label: clockLabel(p.ts),
    day: shortDate(p.ts),
    db: p.dbTotalStorageBytes ?? 0,
    indexes: p.dbTotalIndexBytes ?? 0,
    disk: p.diskUsedBytes ?? 0,
  })), [cleaned]);

  return (
    <SectionCard
      title="Storage growth (snapshots)"
      icon={HardDrive}
      headerRight={
        <div className="flex items-center gap-2">
          {dropped > 0 && <span className="text-[10px] text-muted-foreground">{dropped} invalid points removed</span>}
          <SectionError error={error} />
        </div>
      }
      className="min-h-[260px]"
    >
      {data.length === 0 && !error ? (
        <EmptyState icon={HardDrive} title="No snapshots recorded yet" description="The snapshot loop persists a point every 10 minutes — the trend fills in over time." />
      ) : (
        <ChartContainer config={{
          db: { label: 'DB storage', color: 'hsl(var(--teal))' },
          indexes: { label: 'DB indexes', color: 'hsl(var(--purple))' },
          disk: { label: 'Disk used', color: 'hsl(var(--info))' },
        }} className="h-[220px]">
          <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={Math.max(0, Math.ceil(data.length / 8) - 1)} tick={{ fontSize: 10 }} />
            <YAxis yAxisId="db" tickLine={false} axisLine={false} width={52} tickFormatter={bytesTick} tick={{ fontSize: 10 }} />
            <YAxis yAxisId="disk" orientation="right" tickLine={false} axisLine={false} width={52} tickFormatter={bytesTick} tick={{ fontSize: 10 }} />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Line yAxisId="db" dataKey="db" type="monotone" stroke="var(--color-db)" strokeWidth={2} dot={false} />
            <Line yAxisId="db" dataKey="indexes" type="monotone" stroke="var(--color-indexes)" strokeWidth={1.5} dot={false} />
            <Line yAxisId="disk" dataKey="disk" type="monotone" stroke="var(--color-disk)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
          </ComposedChart>
        </ChartContainer>
      )}
    </SectionCard>
  );
}

/**
 * The page's chart pair. Split into one component so the page can lazy-load the
 * whole section with a single dynamic import.
 */
export default function DataCenterCharts({
  rows,
  days,
  trend,
  historyError,
  trendError,
}: {
  rows: DcDailyRow[];
  days: DcWindowDays;
  trend: DcTrendPoint[];
  historyError: string | null;
  trendError: string | null;
}) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
      <DailyHistoryChart rows={rows} days={days} error={historyError} />
      <StorageTrendChart points={trend} error={trendError} />
    </div>
  );
}