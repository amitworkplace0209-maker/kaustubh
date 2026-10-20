'use client';

/**
 * System → chart cards (recharts, client-only).
 *
 * Fleet-level charts for the Control Center main page + per-engine charts for
 * the profile/detail page. All series are derived from REAL Engine Registry
 * snapshots — empty inputs render honest empty states, never synthetic data.
 */

import { useMemo } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  bucketActivityPerMinute, fmtInt, numericCustomMetrics,
  type EngineActivityEntry, type EngineStatus, type SystemSummary,
} from '@/lib/system-engines';

const TOOLTIP_STYLE = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  fontSize: 12,
  borderRadius: 8,
} as const;
const AXIS_TICK = { fontSize: 10, fill: 'var(--muted-foreground)' } as const;

const HEALTH_SLICES = [
  { key: 'HEALTHY', color: '#22c55e' },
  { key: 'DEGRADED', color: '#f59e0b' },
  { key: 'UNHEALTHY', color: '#ef4444' },
  { key: 'UNKNOWN', color: '#6b7280' },
];

const STATE_BAR_COLOR: Record<string, string> = {
  RUNNING: '#22c55e',
  HEALTHY: '#22c55e',
  REGISTERED: '#6b7280',
  STARTING: '#f59e0b',
  STOPPED: '#6b7280',
  STOPPING: '#f59e0b',
  DEGRADED: '#f59e0b',
  ERROR: '#ef4444',
  DISCONNECTED: '#ef4444',
  RESTARTING: '#38bdf8',
  UNKNOWN: '#6b7280',
};

function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-[190px] items-center justify-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fleet status donut — ONE chart: kitne chalu, kitne band (main page)   */
/* ------------------------------------------------------------------ */

export function FleetStatusDonut({
  running,
  stopped,
  attention,
}: {
  running: number;
  stopped: number;
  attention: number;
}) {
  const total = running + stopped + attention;
  const data = useMemo(() => ([
    { name: 'Running', value: running, color: '#22c55e' },
    { name: 'Stopped', value: stopped, color: '#6b7280' },
    { name: 'Attention', value: attention, color: '#f59e0b' },
  ].filter((d) => d.value > 0)), [running, stopped, attention]);

  if (total === 0) {
    return <ChartEmpty label="No engine data yet" />;
  }
  return (
    <div className="relative h-[210px]">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data} dataKey="value" nameKey="name"
            innerRadius={64} outerRadius={92} paddingAngle={3}
            strokeWidth={0}
          >
            {data.map((d) => (
              <Cell key={d.name} fill={d.color} />
            ))}
          </Pie>
          <Tooltip contentStyle={TOOLTIP_STYLE} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums">{total}</span>
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">engines</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fleet charts (main Control Center page)                             */
/* ------------------------------------------------------------------ */

export function FleetHealthDonut({ summary }: { summary: SystemSummary | null }) {
  const data = useMemo(() => {
    if (!summary?.healths) return [];
    return HEALTH_SLICES.map((s) => ({
      name: s.key,
      value: summary.healths[s.key] ?? 0,
      color: s.color,
    })).filter((d) => d.value > 0);
  }, [summary]);

  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Fleet Health</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label="No health data yet" />
        ) : (
          <div className="h-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={3}>
                  {data.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={TOOLTIP_STYLE} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {HEALTH_SLICES.map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.key}: {fmtInt(summary?.healths?.[s.key] ?? 0)}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function FleetStatesBar({ summary }: { summary: SystemSummary | null }) {
  const data = useMemo(() => {
    if (!summary?.states) return [];
    return Object.entries(summary.states).map(([name, value]) => ({
      name,
      value,
      color: STATE_BAR_COLOR[name] ?? '#6b7280',
    }));
  }, [summary]);

  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Engine States</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label="No state data yet" />
        ) : (
          <div className="h-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} angle={-18} dy={8} height={44} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--muted)' }} />
                <Bar dataKey="value" name="Engines" radius={[4, 4, 0, 0]}>
                  {data.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FleetEventsChart({ engines }: { engines: EngineStatus[] | null }) {
  const data = useMemo(() => {
    if (!engines) return [];
    return [...engines]
      .sort((a, b) => (b.metrics?.eventCount ?? 0) - (a.metrics?.eventCount ?? 0))
      .slice(0, 8)
      .map((e) => ({
        name: e.engineId.length > 14 ? e.engineId.slice(0, 13) + '…' : e.engineId,
        events: e.metrics?.eventCount ?? 0,
        errors: e.metrics?.errorCount ?? 0,
      }));
  }, [engines]);

  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Events vs Errors · Top 8 engines</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label="No engine metrics yet" />
        ) : (
          <div className="h-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} angle={-18} dy={8} height={44} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--muted)' }} />
                <Bar dataKey="events" name="Events" fill="#14b8a6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="errors" name="Errors" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FleetHeartbeatChart({ engines }: { engines: EngineStatus[] | null }) {
  const data = useMemo(() => {
    if (!engines) return [];
    return engines
      .filter((e) => e.heartbeatAge != null && Number.isFinite(e.heartbeatAge))
      .sort((a, b) => (b.heartbeatAge ?? 0) - (a.heartbeatAge ?? 0))
      .slice(0, 8)
      .map((e) => ({
        name: e.engineId.length > 14 ? e.engineId.slice(0, 13) + '…' : e.engineId,
        age: Math.round((e.heartbeatAge ?? 0) * 10) / 10,
        stale: (e.heartbeatAge ?? 0) > 60,
      }));
  }, [engines]);

  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Heartbeat Age (sec) · Stalest 8</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label="No heartbeat data yet" />
        ) : (
          <div className="h-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} angle={-18} dy={8} height={44} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--muted)' }} />
                <Bar dataKey="age" name="Heartbeat age (s)" radius={[4, 4, 0, 0]}>
                  {data.map((d) => (
                    <Cell key={d.name} fill={d.stale ? '#ef4444' : '#38bdf8'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">Red bars = heartbeat older than 60s. Missing values are excluded, never zero-filled.</p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Per-engine charts (profile/detail page)                             */
/* ------------------------------------------------------------------ */

export function EngineActivityChart({ entries }: { entries: EngineActivityEntry[] | null }) {
  const data = useMemo(() => bucketActivityPerMinute(entries ?? []), [entries]);

  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Activity Timeline · ops per minute</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label="No recent activity recorded by this engine yet" />
        ) : (
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="eng-activity" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#14b8a6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={48} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ stroke: 'var(--muted-foreground)' }} />
                <Area type="monotone" dataKey="ops" name="Operations" stroke="#14b8a6" fill="url(#eng-activity)" strokeWidth={2} dot={false} connectNulls={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function EngineCountersDonut({ engine }: { engine: EngineStatus | null }) {
  const data = useMemo(() => {
    if (!engine) return [];
    const rows = [
      { name: 'Events', value: engine.metrics?.eventCount ?? 0, color: '#14b8a6' },
      { name: 'Warnings', value: engine.metrics?.warningCount ?? 0, color: '#f59e0b' },
      { name: 'Errors', value: engine.metrics?.errorCount ?? 0, color: '#ef4444' },
    ];
    return rows.filter((r) => r.value > 0);
  }, [engine]);

  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Events · Warnings · Errors</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label={engine ? 'No counters recorded yet' : 'Loading…'} />
        ) : (
          <>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={3}>
                    {data.map((d) => (
                      <Cell key={d.name} fill={d.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {data.map((d) => (
                <span key={d.name} className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                  {d.name}: {fmtInt(d.value)}
                </span>
              ))}
              <span className="ml-auto font-mono">total {fmtInt(total)}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function EngineCustomMetricsChart({ engine }: { engine: EngineStatus | null }) {
  const data = useMemo(() => numericCustomMetrics(engine?.metrics?.custom), [engine]);

  return (
    <Card className="shadow-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Custom Metrics · live values</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label={engine ? 'This engine exposes no numeric custom metrics' : 'Loading…'} />
        ) : (
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} width={110} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--muted)' }} />
                <Bar dataKey="value" name="Value" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
