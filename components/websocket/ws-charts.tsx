'use client';

/**
 * WebSocket charts — lazily loaded so recharts never blocks first paint.
 * All data is real persisted telemetry; gaps stay gaps (connectNulls=false).
 */

import { useMemo } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

export interface TelemetryPoint {
  bucket?: string;
  timestamp?: string;
  received?: number;
  written?: number;
  errors?: number;
  ticksPerSecond?: number | null;
  writesPerSecond?: number | null;
}

function fmtShort(ts?: string | null): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return String(ts); }
}

function fmtFull(ts?: string | null): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return String(ts); }
}

const TOOLTIP_STYLE = { background: 'var(--card)', border: '1px solid var(--border)', fontSize: 12, borderRadius: 8 };
const AXIS_TICK = { fontSize: 10, fill: 'var(--muted-foreground)' };

export function ThroughputChart({ series }: { series: TelemetryPoint[] }) {
  if (series.length === 0) {
    return <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">No telemetry buckets in this window yet</div>;
  }
  return (
    <div className="h-[200px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="ws-tps" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#14b8a6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="ws-wps" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="timestamp" tickFormatter={fmtShort} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={48} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: 'var(--card-foreground)' }}
            itemStyle={{ color: 'var(--card-foreground)' }}
            labelFormatter={(v) => fmtFull(String(v))}
            cursor={{ stroke: 'var(--muted-foreground)' }}
          />
          <Area type="monotone" dataKey="ticksPerSecond" name="Ticks/s" stroke="#14b8a6" fill="url(#ws-tps)" strokeWidth={2} dot={false} connectNulls={false} />
          <Area type="monotone" dataKey="writesPerSecond" name="Writes/s" stroke="#38bdf8" fill="url(#ws-wps)" strokeWidth={2} dot={false} connectNulls={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BucketsChart({ series }: { series: TelemetryPoint[] }) {
  if (series.length === 0) {
    return <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">No telemetry buckets in this window yet</div>;
  }
  return (
    <div className="h-[200px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} margin={{ top: 4, right: 8, left: -16, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="timestamp" tickFormatter={fmtShort} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={48} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: 'var(--card-foreground)' }}
            itemStyle={{ color: 'var(--card-foreground)' }}
            labelFormatter={(v) => fmtFull(String(v))}
            cursor={{ fill: 'var(--muted)' }}
          />
          <Bar dataKey="received" name="Received" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
          <Bar dataKey="written" name="Written" fill="#f59e0b" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const DAILY_COLORS = ['#14b8a6', '#38bdf8', '#8b5cf6', '#f43f5e', '#f59e0b'];

export function DailyChart({ data }: { data: { name: string; value: number }[] }) {
  if (data.length === 0) {
    return <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">No daily history yet</div>;
  }
  return (
    <div className="h-[180px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--card-foreground)' }} itemStyle={{ color: 'var(--card-foreground)' }} cursor={{ fill: 'var(--muted)' }} />
          <Bar dataKey="value" radius={[5, 5, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill={DAILY_COLORS[i % DAILY_COLORS.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HealthDonut({
  uptimeSec, downtimeSec, availability,
}: {
  uptimeSec: number; downtimeSec: number; availability: number | null;
}) {
  const data = useMemo(() => [
    { name: 'Uptime', value: Math.round(uptimeSec) },
    { name: 'Downtime', value: Math.round(downtimeSec) },
  ], [uptimeSec, downtimeSec]);
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-[120px] w-[120px] flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={34} outerRadius={54} dataKey="value" strokeWidth={0} cornerRadius={4}>
              <Cell fill="#10b981" />
              <Cell fill="#f43f5e" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold tabular-nums leading-none">
            {availability == null || Number.isNaN(availability) ? '—' : `${Math.round(availability * 10) / 10}%`}
          </span>
        </div>
      </div>
      <div className="space-y-1.5 text-xs">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Availability</p>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-[10px] text-muted-foreground">uptime</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-rose-500" />
          <span className="text-[10px] text-muted-foreground">downtime</span>
        </div>
      </div>
    </div>
  );
}
