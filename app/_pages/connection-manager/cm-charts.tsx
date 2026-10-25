'use client';

/**
 * Connection Manager — recharts surfaces.
 *
 * Isolated in its own module and loaded with `next/dynamic` (`ssr: false`) by
 * the page, so recharts never lands in the first payload — the rest of the
 * page is hand-rolled SVG/CSS and renders instantly.
 *
 * Colours read the runtime theme tokens (`hsl(var(--teal))` etc.) rather than
 * the `ChartConfig.theme` light/dark map: this app's theme engine writes the
 * tokens onto `:root` at runtime, so the CSS-var form is the one that tracks
 * the user's selected theme.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  RadialBar,
  RadialBarChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtCompact } from './cm-shared';

const TOOLTIP = {
  background: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 10,
  fontSize: 11,
  fontFamily: 'var(--font-mono-tech)',
  boxShadow: '0 8px 28px -8px hsl(var(--foreground) / 0.25)',
};

const AXIS = {
  fontSize: 9,
  fill: 'hsl(var(--muted-foreground))',
  fontFamily: 'var(--font-mono-tech)',
} as const;

/**
 * Delivered messages per channel, sorted so the busiest channel reads first.
 * Only channels whose backend counter is a real number are plotted.
 */
export function ChannelThroughputChart({
  rows,
  height = 260,
}: {
  rows: { name: string; delivered: number; subscribers: number | null; kind: string }[];
  height?: number;
}) {
  const data = rows
    .filter((r) => Number.isFinite(r.delivered))
    .sort((a, b) => b.delivered - a.delivered)
    .slice(0, 12);

  if (!data.length) return null;

  return (
    <div style={{ height }} className="w-full">
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -8 }} barCategoryGap="22%">
        <defs>
          <linearGradient id="cm-bar-delivered" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--teal))" stopOpacity={1} />
            <stop offset="100%" stopColor="hsl(var(--teal))" stopOpacity={0.35} />
          </linearGradient>
          <linearGradient id="cm-bar-primary" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={1} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="name"
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          interval={0}
          angle={-28}
          textAnchor="end"
          height={58}
          tickFormatter={(v: string) => (v.length > 13 ? `${v.slice(0, 12)}…` : v)}
        />
        <YAxis
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v: number) => fmtCompact(v)}
        />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
          contentStyle={TOOLTIP}
          formatter={(v: number, name: string) => [fmtCompact(v as number), name]}
          labelStyle={{ color: 'hsl(var(--foreground))', fontWeight: 600, marginBottom: 4 }}
        />
        <Bar dataKey="delivered" name="Delivered" radius={[4, 4, 0, 0]} maxBarSize={34}>
          {data.map((d) => (
            <Cell
              key={d.name}
              fill={d.kind?.includes('market') ? 'url(#cm-bar-primary)' : 'url(#cm-bar-delivered)'}
            />
          ))}
        </Bar>
      </BarChart>
    </div>
  );
}

/**
 * Market vs state channel split. Only rendered when the backend actually
 * reported both counts; otherwise the page shows its empty state instead.
 */
export function ChannelSplitDonut({
  market,
  state,
  marketColor = 'hsl(var(--primary))',
  stateColor = 'hsl(var(--teal))',
}: {
  market: number;
  state: number;
  marketColor?: string;
  stateColor?: string;
}) {
  const total = market + state;
  if (total <= 0) return null;

  const data = [
    { name: 'Market', value: market, fill: marketColor },
    { name: 'State', value: state, fill: stateColor },
  ];

  return (
    <div className="flex items-center gap-3">
      <div className="relative h-[104px] w-[104px] shrink-0">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={32}
            outerRadius={48}
            paddingAngle={2.5}
            stroke="none"
            startAngle={90}
            endAngle={-270}
          >
            {data.map((d) => (
              <Cell key={d.name} fill={d.fill} />
            ))}
          </Pie>
          <Tooltip contentStyle={TOOLTIP} formatter={(v: number, n: string) => [fmtCompact(v), n]} />
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-lg font-semibold leading-none tabular-nums">
            {fmtCompact(total)}
          </span>
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground">channels</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.fill }} />
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{d.name}</span>
            <span className="font-mono text-[11px] tabular-nums">{d.value}</span>
            <span className="w-9 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
              {total ? `${Math.round((d.value / total) * 100)}%` : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Event volume over time, bucketed from the real ring. Buckets are derived
 * from `epoch` values the backend recorded — no synthetic timestamps, and a
 * ring that fits in one bucket renders a single bar rather than a fake ramp.
 */
export function EventVolumeChart({
  points,
  height = 190,
}: {
  points: { label: string; count: number; errors: number }[];
  height?: number;
}) {
  if (points.length < 2) return null;

  return (
    <div style={{ height }} className="w-full">
      <BarChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -18 }} barCategoryGap="18%">
        <defs>
          <linearGradient id="cm-ev-ok" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--info))" stopOpacity={0.95} />
            <stop offset="100%" stopColor="hsl(var(--info))" stopOpacity={0.3} />
          </linearGradient>
          <linearGradient id="cm-ev-err" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--destructive))" stopOpacity={0.95} />
            <stop offset="100%" stopColor="hsl(var(--destructive))" stopOpacity={0.3} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={34} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
          contentStyle={TOOLTIP}
          formatter={(v: number, name: string) => [fmtCompact(v as number), name]}
          labelStyle={{ color: 'hsl(var(--foreground))', fontWeight: 600, marginBottom: 4 }}
        />
        <Bar dataKey="count" name="Events" stackId="a" fill="url(#cm-ev-ok)" radius={[3, 3, 0, 0]} maxBarSize={26} />
        <Bar dataKey="errors" name="Warn / Error" stackId="a" fill="url(#cm-ev-err)" radius={[3, 3, 0, 0]} maxBarSize={26} />
      </BarChart>
    </div>
  );
}

/**
 * Backpressure: queue fill against the configured limit. `depth`/`limit` come
 * straight from the backend; a null limit renders nothing rather than
 * normalising against a guessed ceiling.
 */
export function BackpressureChart({
  total,
  max,
  limit,
  droppedMarket,
  droppedCritical,
}: {
  total: number | null;
  max: number | null;
  limit: number | null;
  droppedMarket: number | null;
  droppedCritical: number | null;
}) {
  if (limit == null || limit <= 0) return null;

  const pct = Math.min(100, max == null ? 0 : (max / limit) * 100);
  const tone = pct >= 90 ? 'hsl(var(--destructive))' : pct >= 65 ? 'hsl(var(--warning))' : 'hsl(var(--success))';

  const data = [{ name: 'peak', fill: tone, value: pct }];

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[118px] w-[118px] shrink-0">
        <RadialBarChart
          data={data}
          innerRadius="72%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarGrid stroke="hsl(var(--border))" strokeDasharray="3 4" />
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar dataKey="value" cornerRadius={8} background={{ fill: 'hsl(var(--muted) / 0.7)' }} />
          <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`${v.toFixed(1)}%`, 'queue fill']} />
        </RadialBarChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-lg font-semibold leading-none tabular-nums" style={{ color: tone }}>
            {pct.toFixed(0)}%
          </span>
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground">of limit</span>
        </div>
      </div>
      <dl className="min-w-0 flex-1 space-y-1.5 text-[11px]">
        <Row label="Limit" value={limit.toLocaleString('en-IN')} />
        <Row label="Peak depth" value={max == null ? '—' : max.toLocaleString('en-IN')} tone={pct >= 90 ? 'text-destructive' : undefined} />
        <Row label="Total depth" value={total == null ? '—' : total.toLocaleString('en-IN')} />
        <Row label="Dropped (market)" value={droppedMarket == null ? '—' : String(droppedMarket)} tone={(droppedMarket ?? 0) > 0 ? 'text-warning' : undefined} />
        <Row label="Dropped (critical)" value={droppedCritical == null ? '—' : String(droppedCritical)} tone={(droppedCritical ?? 0) > 0 ? 'text-destructive' : undefined} />
      </dl>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-mono tabular-nums ${tone ?? 'text-foreground'}`}>{value}</dd>
    </div>
  );
}