'use client';

/**
 * Connection Manager — visual primitives.
 *
 * Pure SVG / CSS so the diagnostic surface keeps its theme tokens, stays in the
 * first paint (no recharts payload) and honours `prefers-reduced-motion`.
 *
 * Honesty rule carried over from `cm-shared`: these components DRAW what the
 * backend reported. When the value is missing they render an explicit
 * "not measured" state — never a 0%, an empty ring or a flat zero line, which
 * would read as a real measurement.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Mirrors `StatusBadge`'s status prop; exported here for local reuse. */
export type BadgeStatus = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

// ---------------------------------------------------------------------------
// Radial gauge — health / freshness / queue pressure
// ---------------------------------------------------------------------------

export type GaugeTone = 'success' | 'warning' | 'danger' | 'info' | 'teal' | 'neutral';

const GAUGE_STROKE: Record<GaugeTone, string> = {
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  danger: 'hsl(var(--destructive))',
  info: 'hsl(var(--info))',
  teal: 'hsl(var(--teal))',
  neutral: 'hsl(var(--muted-foreground))',
};

const GAUGE_FILL = 'hsl(var(--card))';

/**
 * Donut gauge. `value`/`max` are null-safe: a null value renders the empty
 * ring plus the `unavailable` caption, never a full or half-filled arc.
 */
export function RadialGauge({
  value,
  max = 100,
  label,
  caption,
  tone = 'neutral',
  size = 132,
  thickness = 9,
  unit = '%',
  live = false,
  children,
}: {
  value: number | null | undefined;
  max?: number;
  label?: string;
  caption?: string;
  tone?: GaugeTone;
  size?: number;
  thickness?: number;
  unit?: string;
  live?: boolean;
  children?: ReactNode;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const measurable =
    value != null && Number.isFinite(value) && max != null && Number.isFinite(max) && max > 0;
  const pct = measurable ? Math.min(1, Math.max(0, value! / max!)) : 0;
  const dash = c * pct;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={thickness}
          opacity={0.55}
        />
        {measurable ? (
          <>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={GAUGE_STROKE[tone]}
              strokeWidth={thickness}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${c - dash}`}
              className="transition-[stroke-dasharray] duration-700 ease-out"
              style={live ? { filter: `drop-shadow(0 0 6px ${GAUGE_STROKE[tone]}66)` } : undefined}
            />
          </>
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {measurable ? (
          <span
            className="font-mono text-[22px] font-semibold leading-none tabular-nums"
            style={{ color: GAUGE_STROKE[tone] }}
          >
            {formatGaugeValue(pct)}
            <span className="text-[12px] opacity-70">{unit}</span>
          </span>
        ) : (
          <span className="font-mono text-sm font-medium leading-none text-muted-foreground">
            n/a
          </span>
        )}
        {label ? (
          <span className="mt-1 max-w-[86%] text-[10px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
            {label}
          </span>
        ) : null}
        {caption ? (
          <span className="mt-0.5 max-w-[88%] truncate text-[9px] text-muted-foreground/70" title={caption}>
            {caption}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function formatGaugeValue(pct: number): string {
  const v = pct * 100;
  if (v >= 99.5 && v <= 100) return '100';
  if (v < 1) return '0';
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

// ---------------------------------------------------------------------------
// Sparkline — pure SVG trend of an already-measured series
// ---------------------------------------------------------------------------

/**
 * Inline trend for a backend-provided number list. Fewer than two points
 * renders a flat baseline (the honest "no series yet" shape), not a fake rise.
 */
export function Sparkline({
  points,
  tone = 'info',
  width = 88,
  height = 28,
  filled = true,
}: {
  points: number[];
  tone?: GaugeTone;
  width?: number;
  height?: number;
  filled?: boolean;
}) {
  const color = GAUGE_STROKE[tone];
  const usable = points.filter((p) => typeof p === 'number' && Number.isFinite(p));

  if (usable.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden className="overflow-visible">
        <line
          x1={0}
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="hsl(var(--border))"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const span = max - min || 1;
  const step = width / (usable.length - 1);
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 5);

  const d = usable
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(p).toFixed(2)}`)
    .join(' ');

  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <defs>
        <linearGradient id={`cm-spark-${tone}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.38} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {filled ? (
        <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#cm-spark-${tone})`} />
      ) : null}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={width} cy={y(usable[usable.length - 1])} r={2.25} fill={color} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Topology map — spec §47 transport ownership at a glance
// ---------------------------------------------------------------------------

export interface TopologyNode {
  id: string;
  label: string;
  owner?: string | null;
  connected: boolean | null;
  state?: string | null;
  sessions?: number | null;
  endpoint?: string | null;
}

const COLUMNS = [
  { key: 'feeds', label: 'Upstream feeds', sub: 'broker / event bus' },
  { key: 'transport', label: 'Transport', sub: 'the 4 WebSockets' },
  { key: 'fanout', label: 'Fan-out', sub: 'session + channel routing' },
  { key: 'consumers', label: 'Consumers', sub: 'frontend terminals' },
] as const;

const LANE_X = [58, 246, 434, 622];

/**
 * Three-stage pipeline: feeds → WebSockets → fan-out → consumers.
 * Ownership is the point of this map (spec §47): the gateway engine's own
 * transports are highlighted, everything borrowed from another engine is not.
 */
export function TransportTopology({
  nodes,
  gatewayIds,
  consumerCount,
}: {
  nodes: TopologyNode[];
  gatewayIds: string[];
  consumerCount: number | null;
}) {
  const byLane = (lane: string) => nodes.filter((n) => laneOf(n.id) === lane);

  return (
    <div className="cm-scroll overflow-x-auto pb-1">
      <svg
        viewBox="0 0 720 214"
        className="h-auto w-full min-w-[680px]"
        role="img"
        aria-label="Transport topology: upstream feeds, transport layer, fan-out and consumers"
      >
        <defs>
          <linearGradient id="cm-link" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="hsl(var(--info))" stopOpacity="0.5" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="cm-link-idle" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="hsl(var(--muted-foreground))" stopOpacity="0.3" />
            <stop offset="100%" stopColor="hsl(var(--muted-foreground))" stopOpacity="0.18" />
          </linearGradient>
        </defs>

        {COLUMNS.map((col, i) => (
          <g key={col.key}>
            <text
              x={LANE_X[i]}
              y={16}
              textAnchor="middle"
              className="fill-muted-foreground text-[9px] font-semibold uppercase"
              style={{ letterSpacing: '0.09em' }}
            >
              {col.label}
            </text>
            <text x={LANE_X[i]} y={30} textAnchor="middle" className="fill-muted-foreground text-[8px] opacity-70">
              {col.sub}
            </text>
            <line
              x1={LANE_X[i] - 74}
              y1={40}
              x2={LANE_X[i] + 74}
              y2={40}
              stroke="hsl(var(--border))"
              strokeWidth={1}
            />
          </g>
        ))}

        {connections(nodes).map((c) => (
          <path
            key={`${c.from}->${c.to}`}
            d={c.d}
            fill="none"
            stroke={c.active ? 'url(#cm-link)' : 'url(#cm-link-idle)'}
            strokeWidth={c.active ? 2 : 1.25}
            strokeLinecap="round"
            strokeDasharray={c.active ? '5 11' : undefined}
            className={c.active ? 'cm-flow' : undefined}
          />
        ))}

        {COLUMNS.map((col, i) =>
          byLane(col.key).map((n, j) => (
            <TopologyNodeBox
              key={n.id}
              node={n}
              x={LANE_X[i]}
              y={nodeY(i, j, byLane(col.key).length)}
              isGateway={gatewayIds.includes(n.id)}
            />
          )),
        )}

        <TopologyNodeBox
          node={{
            id: 'consumers',
            label: 'Frontend consumers',
            connected: consumerCount == null ? null : consumerCount > 0,
            sessions: consumerCount,
          }}
          x={LANE_X[3]}
          y={104}
          isGateway={false}
        />
      </svg>
    </div>
  );
}

function laneOf(id: string): string {
  if (id === 'REST' || id === 'Broker REST' || id === 'Event Bus') return 'feeds';
  if (id.startsWith('WS#')) return 'transport';
  return 'fanout';
}

function nodeY(laneIndex: number, index: number, total: number): number {
  const blockH = total * 34;
  const top = 56;
  return top + Math.max(0, (104 - blockH) / 2) + index * 34 + 15;
}

function connections(nodes: TopologyNode[]): { from: string; to: string; d: string; active: boolean }[] {
  const feeds = nodes.filter((n) => laneOf(n.id) === 'feeds');
  const transports = nodes.filter((n) => n.id.startsWith('WS#'));
  const out: { from: string; to: string; d: string; active: boolean }[] = [];

  const yOf = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    if (!n) return 100;
    const lane = COLUMNS.findIndex((c) => laneOf(n.id) === c.key);
    const list = nodes.filter((x) => laneOf(x.id) === COLUMNS[lane]?.key);
    return nodeY(Math.max(0, lane), list.indexOf(n), list.length);
  };

  for (const f of feeds) {
    for (const t of transports) {
      const y1 = yOf(f.id);
      const y2 = yOf(t.id);
      const x1 = LANE_X[0] + 62;
      const x2 = LANE_X[1] - 62;
      const mx = (x1 + x2) / 2;
      out.push({
        from: f.id,
        to: t.id,
        d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        active: Boolean(f.connected && t.connected),
      });
    }
  }

  for (const t of transports) {
    const y1 = yOf(t.id);
    const x1 = LANE_X[1] + 62;
    const x2 = LANE_X[3] - 62;
    const mx = (x1 + x2) / 2;
    out.push({
      from: t.id,
      to: 'consumers',
      d: `M${x1},${y1} C${mx},${y1} ${mx},104 ${x2},104`,
      active: Boolean(t.connected),
    });
  }

  return out;
}

function TopologyNodeBox({
  node,
  x,
  y,
  isGateway,
}: {
  node: TopologyNode;
  x: number;
  y: number;
  isGateway: boolean;
}) {
  const w = 124;
  const h = 28;
  const connected = node.connected === true;
  const unknown = node.connected === null || node.connected === undefined;
  const stroke = connected
    ? isGateway
      ? 'hsl(var(--primary))'
      : 'hsl(var(--success))'
    : 'hsl(var(--border))';

  return (
    <g transform={`translate(${x - w / 2}, ${y - h / 2})`}>
      {connected ? (
        <rect x={1.5} y={1.5} width={w - 3} height={h - 3} rx={8} fill="none" stroke={stroke} strokeWidth={1.5} className="cm-ping" opacity={0.7} style={{ transformOrigin: `${w / 2}px ${h / 2}px` }} />
      ) : null}
      <rect
        width={w}
        height={h}
        rx={8}
        fill={isGateway ? 'hsl(var(--primary) / 0.09)' : GAUGE_FILL}
        stroke={stroke}
        strokeWidth={connected || isGateway ? 1.5 : 1}
        strokeDasharray={unknown ? '4 3' : undefined}
      />
      <circle cx={13} cy={h / 2} r={3.5} fill={connected ? stroke : 'hsl(var(--muted-foreground) / 0.45)'} />
      <text
        x={23}
        y={h / 2 + 3.5}
        className="fill-foreground font-mono"
        style={{ fontSize: 10, fontWeight: 600 }}
      >
        {node.label.length > 12 ? `${node.label.slice(0, 11)}…` : node.label}
      </text>
      {node.sessions != null ? (
        <text x={w - 8} y={h / 2 + 3.5} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 9 }}>
          {node.sessions}
        </text>
      ) : null}
      <title>
        {`${node.label}${node.owner ? ` · ${node.owner}` : ''}${
          node.connected === true ? ' · connected' : node.connected === false ? ' · idle' : ' · unknown'
        }${node.endpoint ? `\n${node.endpoint}` : ''}`}
      </title>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Connection state distribution bar (spec §23)
// ---------------------------------------------------------------------------

/**
 * Stacked proportion bar for the lifecycle state map. Rendered only from counts
 * the backend reported; an all-zero map renders the empty track.
 */
export function StateBar({ states, total }: { states: Record<string, number>; total: number }) {
  const entries = Object.entries(states).filter(([, n]) => Number(n) > 0);
  const sum = total || entries.reduce((a, [, n]) => a + n, 0);

  if (!entries.length) {
    return (
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted/70">
        <div className="h-full w-full rounded-full border border-dashed border-border" />
      </div>
    );
  }

  return (
    <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted/60">
      {entries.map(([name, n]) => {
        const pct = ((n / sum) * 100).toFixed(2);
        return (
          <div
            key={name}
            className={cn('h-full transition-all duration-500', STATE_BAR_COLOR[name] ?? 'bg-muted-foreground/40')}
            style={{ width: `${pct}%` }}
            title={`${name}: ${n}`}
          />
        );
      })}
    </div>
  );
}

const STATE_BAR_COLOR: Record<string, string> = {
  ACTIVE: 'bg-success',
  READY: 'bg-success',
  CONNECTED: 'bg-success',
  CREATED: 'bg-info',
  VALIDATING: 'bg-info',
  WAITING_FOR_SOURCE: 'bg-info',
  WAITING_FOR_INSTRUMENT: 'bg-info',
  WAITING_FOR_FEATURES: 'bg-info',
  PAUSED: 'bg-warning',
  DEGRADED: 'bg-warning',
  RECONNECTING: 'bg-warning',
  CONNECTING: 'bg-warning',
  EXPIRING: 'bg-warning',
  DISCONNECTING: 'bg-warning',
  FAILED: 'bg-destructive',
  EXPIRED: 'bg-destructive',
  TERMINATED: 'bg-destructive',
  DISCONNECTED: 'bg-muted-foreground/50',
};

export const stateBarColor = (state: string): string =>
  STATE_BAR_COLOR[(state ?? '').toUpperCase()] ?? 'bg-muted-foreground/40';