'use client';

/**
 * System Indicators — engine fleet.
 *
 * One indicator per backend engine, so "everything in the project" is covered
 * on a single screen: every engine the Python service registers gets its own
 * card with its real state, health, version, heartbeat age and the metrics it
 * actually publishes through `metrics.custom`.
 *
 * Two rules drive the metric mapping:
 *
 *  1. HONESTY — a card shows a number only when the engine reported that exact
 *     key. The highlight list is per-engine and keyed by the real metric names;
 *     anything the engine does not publish is simply absent (the chip is not
 *     rendered). When an engine publishes no `custom` metrics at all, its
 *     `configSummary` is flattened into chips instead of faking counters.
 *  2. COLOUR MEANS SOMETHING — `tone` is chosen per metric so a red chip is
 *     always a real problem (errors, drops, stale instruments) and a green one
 *     is always a real success. Decorative colour never encodes a state.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Activity, Bot, Brain, Database, Gauge, HardDrive, HeartPulse, Layers,
  Radio, Search, Server, ShieldCheck, ShoppingCart, Sparkles, Wifi, Workflow,
  Zap, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtBytes, fmtMs, fmtQty } from '@/lib/formatters';
import { engineProfileHref, type EngineStatus } from '@/lib/system-engines';
import {
  AnimatedNumber, LiveHalo, Meter, MetricChip, Panel, Trend, stagger,
  type Accent, type SysState,
} from './visuals';

/* ------------------------------------------------------------------ */
/* Category identity — icon + accent per engine category                */
/* ------------------------------------------------------------------ */

const CATEGORY_ACCENT: Record<string, Accent> = {
  CORE: 'info',
  TRADING: 'warning',
  MARKET_DATA: 'teal',
  DATA: 'purple',
  CONTROL: 'success',
  STORAGE: 'primary',
  AI: 'purple',
};

const CATEGORY_ICON: Record<string, LucideIcon> = {
  CORE: Server,
  TRADING: ShoppingCart,
  MARKET_DATA: Radio,
  DATA: Database,
  CONTROL: Activity,
  STORAGE: HardDrive,
  AI: Brain,
};

/* ------------------------------------------------------------------ */
/* Metric formatting                                                    */
/* ------------------------------------------------------------------ */

type Kind = 'qty' | 'ms' | 'num' | 'bytes' | 'text' | 'bool' | 'secs';

function fmtByKind(kind: Kind, v: unknown): string {
  if (v == null) return 'n/a';
  switch (kind) {
    case 'bool':
      return v === true ? 'Yes' : v === false ? 'No' : String(v);
    case 'ms':
      return typeof v === 'number' ? fmtMs(v) : String(v);
    case 'secs':
      return typeof v === 'number' ? fmtAgoSec(v) : String(v);
    case 'bytes':
      return typeof v === 'number' ? fmtBytes(v) : String(v);
    case 'qty':
      return typeof v === 'number' ? fmtQty(v) : String(v);
    case 'num':
      return typeof v === 'number'
        ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
        : String(v);
    default:
      return String(v);
  }
}

/** A metric can invert its own colour: 0 errors is green, >0 is red. */
function resolveAccent(spec: { accent: Accent; goodWhenZero?: boolean }, v: unknown): Accent {
  if (!spec.goodWhenZero) return spec.accent;
  if (typeof v !== 'number') return 'neutral';
  return v > 0 ? 'danger' : 'success';
}

type MetricSpec = {
  key: string;
  label: string;
  kind: Kind;
  accent: Accent;
  /** Colour flips to `danger` above zero (errors, drops, rejects). */
  goodWhenZero?: boolean;
  icon?: LucideIcon;
};

/**
 * Per-engine highlight metrics, in display order.
 *
 * These are the keys each engine genuinely publishes today (verified against
 * the live `/api/services/engines` snapshot). A key the engine stops
 * publishing disappears from its card on its own — nothing here invents a zero.
 */
const HIGHLIGHTS: Record<string, MetricSpec[]> = {
  feature_engine: [
    { key: 'totalCalculations', label: 'Calculations', kind: 'num', accent: 'info', icon: Zap },
    { key: 'activeTokens', label: 'Active tokens', kind: 'qty', accent: 'teal', icon: Layers },
    { key: 'calculationLatencyP95Ms', label: 'Calc p95', kind: 'ms', accent: 'purple', icon: Gauge },
    { key: 'calculationLatencyP99Ms', label: 'Calc p99', kind: 'ms', accent: 'purple', icon: Gauge },
    { key: 'calculationErrors', label: 'Errors', kind: 'qty', accent: 'neutral', goodWhenZero: true },
    { key: 'invalidInputs', label: 'Invalid', kind: 'qty', accent: 'warning', goodWhenZero: true },
    { key: 'calculatorCount', label: 'Calculators', kind: 'num', accent: 'primary', icon: Sparkles },
    { key: 'warmupCount', label: 'Warmups', kind: 'num', accent: 'neutral' },
  ],
  search_engine: [
    { key: 'totalSearches', label: 'Searches', kind: 'qty', accent: 'info', icon: Search },
    { key: 'lastSearchTookMs', label: 'Last took', kind: 'ms', accent: 'purple', icon: Gauge },
    { key: 'instrumentCount', label: 'Instruments', kind: 'qty', accent: 'teal', icon: Database },
    { key: 'indexedTerms', label: 'Indexed', kind: 'qty', accent: 'purple', icon: Search },
    { key: 'ltpCacheSize', label: 'LTP cache', kind: 'qty', accent: 'primary' },
    { key: 'zeroResultCount', label: 'No results', kind: 'qty', accent: 'warning', goodWhenZero: true },
    { key: 'staleRejected', label: 'Stale rejected', kind: 'qty', accent: 'warning', goodWhenZero: true },
  ],
  squareoff_engine: [
    { key: 'totalSquareoffs', label: 'Square-offs', kind: 'qty', accent: 'warning', icon: ShieldCheck },
    { key: 'successful', label: 'Succeeded', kind: 'qty', accent: 'success', icon: HeartPulse },
    { key: 'failed', label: 'Failed', kind: 'qty', accent: 'neutral', goodWhenZero: true },
    { key: 'activeRequests', label: 'Active req', kind: 'num', accent: 'info' },
  ],
  risk_engine: [],
  watchlist_engine: [
    { key: 'watchlistCount', label: 'Watchlists', kind: 'qty', accent: 'info', icon: Layers },
    { key: 'totalStocks', label: 'Stocks', kind: 'qty', accent: 'teal', icon: Database },
    { key: 'tickCount', label: 'Ticks', kind: 'qty', accent: 'purple', icon: Activity },
    { key: 'activeTokens', label: 'Active tokens', kind: 'qty', accent: 'primary' },
    { key: 'ltpCacheSize', label: 'LTP cache', kind: 'qty', accent: 'teal' },
  ],
  market_watch: [
    { key: 'ticksPerSecond', label: 'Ticks/s', kind: 'num', accent: 'teal', icon: Activity },
    { key: 'eligibleUniverseCount', label: 'Universe', kind: 'qty', accent: 'info', icon: Layers },
    { key: 'subscribedTokenCount', label: 'Subscribed', kind: 'qty', accent: 'primary' },
    { key: 'liveInstrumentCount', label: 'Live', kind: 'qty', accent: 'success', icon: HeartPulse },
    { key: 'staleInstrumentCount', label: 'Stale', kind: 'qty', accent: 'neutral', goodWhenZero: true },
    { key: 'noDataInstrumentCount', label: 'No data', kind: 'qty', accent: 'neutral', goodWhenZero: true },
    { key: 'rankingDurationMs', label: 'Ranking', kind: 'ms', accent: 'purple', icon: Gauge },
    { key: 'publish_latency_ms', label: 'Publish', kind: 'ms', accent: 'purple', icon: Gauge },
    { key: 'processing_latency_ms', label: 'Processing', kind: 'ms', accent: 'warning', icon: Gauge },
    { key: 'priceCappedCount', label: 'Price capped', kind: 'qty', accent: 'warning', goodWhenZero: true },
    { key: 'recoveryCandles', label: 'Recovery', kind: 'num', accent: 'warning' },
    { key: 'gainerPinChanges', label: 'Gainer pins', kind: 'num', accent: 'success' },
    { key: 'loserPinChanges', label: 'Loser pins', kind: 'num', accent: 'danger' },
    { key: 'persistedTicks', label: 'Persisted', kind: 'qty', accent: 'purple', icon: HardDrive },
    { key: 'ticksSuppressed', label: 'Suppressed', kind: 'qty', accent: 'neutral', goodWhenZero: true },
  ],
  market_coach: [
    { key: 'universeSize', label: 'Universe', kind: 'qty', accent: 'purple', icon: Brain },
    { key: 'topStocksCount', label: 'Top stocks', kind: 'qty', accent: 'teal', icon: Sparkles },
    { key: 'lastRefreshAge', label: 'Refresh age', kind: 'num', accent: 'info', icon: Gauge },
  ],
  storage_engine: [
    { key: 'historyLength', label: 'History', kind: 'qty', accent: 'info', icon: Layers },
    { key: 'lastSampleDurationMs', label: 'Sample took', kind: 'ms', accent: 'purple', icon: Gauge },
    { key: 'eventsCount', label: 'Events', kind: 'qty', accent: 'teal', icon: Activity },
    { key: 'sampleErrors', label: 'Sample errors', kind: 'qty', accent: 'neutral', goodWhenZero: true },
  ],
  db_writer_engine: [
    { key: 'ticksPerSecond', label: 'Ticks/s', kind: 'num', accent: 'teal', icon: Activity },
    { key: 'writesPerSecond', label: 'Writes/s', kind: 'num', accent: 'info', icon: HardDrive },
    { key: 'bufferLength', label: 'Buffered', kind: 'qty', accent: 'primary', icon: Layers },
    { key: 'totalWritten', label: 'Written', kind: 'qty', accent: 'success', icon: HardDrive },
    { key: 'totalReceived', label: 'Received', kind: 'qty', accent: 'info', icon: Radio },
    { key: 'activeTickStocks', label: 'Tick stocks', kind: 'qty', accent: 'purple', icon: Database },
    { key: 'feedLatencyMs', label: 'Feed lag', kind: 'ms', accent: 'warning', icon: Gauge },
    { key: 'totalWriteErrors', label: 'Write errors', kind: 'qty', accent: 'neutral', goodWhenZero: true },
    { key: 'rejectedByValidation', label: 'Rejected', kind: 'qty', accent: 'neutral', goodWhenZero: true },
    { key: 'duplicatesRejected', label: 'Duplicates', kind: 'qty', accent: 'neutral', goodWhenZero: true },
    { key: 'mwDocumentsWritten', label: 'MW written', kind: 'qty', accent: 'purple' },
    { key: 'mwDocumentsPending', label: 'MW pending', kind: 'qty', accent: 'warning' },
  ],
  notification_engine: [
    { key: 'activeAlerts', label: 'Active alerts', kind: 'qty', accent: 'warning', icon: Activity },
    { key: 'unreadNotifications', label: 'Unread', kind: 'qty', accent: 'info', icon: Bot },
  ],
  audit_engine: [{ key: 'totalEvents', label: 'Events', kind: 'qty', accent: 'purple', icon: ShieldCheck }],
  session_manager: [],
  connection_manager: [
    { key: 'activeConnections', label: 'Connections', kind: 'qty', accent: 'teal', icon: Wifi },
    { key: 'sessions', label: 'Sessions', kind: 'qty', accent: 'info', icon: Server },
    { key: 'framesRouted', label: 'Frames routed', kind: 'qty', accent: 'primary', icon: Workflow },
    { key: 'messagesDelivered', label: 'Delivered', kind: 'qty', accent: 'success', icon: HeartPulse },
    { key: 'messagesDropped', label: 'Dropped', kind: 'qty', accent: 'neutral', goodWhenZero: true },
    { key: 'feedFreshness', label: 'Freshness', kind: 'text', accent: 'warning' },
    { key: 'feedLastTickAgeSeconds', label: 'Last tick', kind: 'secs', accent: 'warning', icon: Gauge },
  ],
  websocket_engine: [],
  scheduler_engine: [
    { key: 'marketStatus', label: 'Market', kind: 'text', accent: 'teal' },
    { key: 'state', label: 'State', kind: 'text', accent: 'info' },
    { key: 'sessionActive', label: 'Session', kind: 'bool', accent: 'success' },
    { key: 'websocketConnected', label: 'Socket', kind: 'bool', accent: 'teal' },
    { key: 'jobsCheckerRunning', label: 'Jobs checker', kind: 'bool', accent: 'purple' },
    { key: 'jobsTaskActive', label: 'Jobs active', kind: 'bool', accent: 'warning' },
    { key: 'inWsPrepWindow', label: 'WS prep', kind: 'bool', accent: 'primary' },
    { key: 'jobsCheckerIntervalSeconds', label: 'Check every', kind: 'num', accent: 'neutral' },
  ],
  order_engine: [
    { key: 'broker', label: 'Broker', kind: 'text', accent: 'warning' },
    { key: 'loggedIn', label: 'Logged in', kind: 'bool', accent: 'success' },
  ],
  position_engine: [
    { key: 'broker', label: 'Broker', kind: 'text', accent: 'warning' },
    { key: 'loggedIn', label: 'Logged in', kind: 'bool', accent: 'success' },
  ],
  target_engine: [{ key: 'targetCount', label: 'Targets', kind: 'qty', accent: 'teal', icon: Sparkles }],
};

/**
 * Engines that publish no `custom` metrics still have something worth showing:
 * their effective configuration. Flatten one level of `configSummary` and keep
 * only primitive leaves, so a nested object never renders as `[object Object]`.
 */
function flattenSummary(summary: Record<string, unknown> | undefined, limit = 6) {
  if (!summary) return [];
  const out: { key: string; label: string; value: unknown; kind: Kind }[] = [];
  for (const [key, value] of Object.entries(summary)) {
    if (out.length >= limit) break;
    if (value == null || typeof value === 'object') continue;
    const kind: Kind =
      typeof value === 'boolean'
        ? 'bool'
        : typeof value === 'number'
          ? Number.isInteger(value)
            ? 'qty'
            : 'num'
          : 'text';
    out.push({
      key,
      label: key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/^\w/, (c) => c.toUpperCase()),
      value,
      kind,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* State mapping                                                        */
/* ------------------------------------------------------------------ */

const HEALTHY_STATES = new Set(['RUNNING', 'HEALTHY']);

/** Engine `state` + `health` → the shared ok/bad/warn/unknown vocabulary. */
export function engineStateTone(engine: Pick<EngineStatus, 'state' | 'health'>): SysState {
  if (engine.health === 'DEGRADED') return 'warn';
  if (engine.health === 'UNHEALTHY') return 'bad';
  if (HEALTHY_STATES.has(engine.state) && engine.health === 'HEALTHY') return 'ok';
  if (engine.state === 'STARTING' || engine.state === 'RESTARTING') return 'warn';
  if (engine.state === 'ERROR' || engine.state === 'DISCONNECTED' || engine.state === 'DEPENDENCY_ERROR') {
    return 'bad';
  }
  if (engine.state === 'RUNNING' || engine.state === 'HEALTHY' || engine.state === 'DEGRADED') return 'warn';
  return 'unknown';
}

/** Title-cased state for display — `DEPENDENCY_ERROR` → `Dependency error`. */
function prettyState(state: string): string {
  return state
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/* ------------------------------------------------------------------ */
/* Card                                                                 */
/* ------------------------------------------------------------------ */

function EngineCard({
  engine,
  series,
  index,
}: {
  engine: EngineStatus;
  /** Rolling event-rate history for this engine, oldest first. */
  series: number[];
  index: number;
}) {
  const tone = engineStateTone(engine);
  const accent = tone === 'unknown' ? CATEGORY_ACCENT[engine.engineCategory] ?? 'neutral' : null;
  const baseAccent: Accent = tone === 'ok' ? 'success' : tone === 'bad' ? 'danger' : tone === 'warn' ? 'warning' : accent ?? 'neutral';
  const CategoryIcon = CATEGORY_ICON[engine.engineCategory] ?? Bot;
  const CatAccent = CATEGORY_ACCENT[engine.engineCategory] ?? 'neutral';

  const metrics = engine.metrics ?? ({} as EngineStatus['metrics']);
  const custom = (metrics.custom ?? {}) as Record<string, unknown>;

  // Prefer the engine's own curated highlight list; fall back to the largest
  // numeric counters it reports so an engine we have not mapped yet still shows
  // something real rather than an empty card.
  const specs = HIGHLIGHTS[engine.engineId];
  const resolved: { spec: MetricSpec; value: unknown }[] =
    specs != null
      ? specs.filter((s) => custom[s.key] != null).map((spec) => ({ spec, value: custom[spec.key] }))
      : Object.entries(custom)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
          .slice(0, 5)
          .map(([key, value]) => ({
            spec: { key, label: key, kind: 'num' as Kind, accent: 'info' as Accent },
            value,
          }));

  const summaryChips = resolved.length === 0 ? flattenSummary(engine.configSummary) : [];

  const errors = metrics.errorCount ?? 0;
  const warnings = metrics.warningCount ?? 0;
  const eventCount = metrics.eventCount ?? 0;
  const queueSize = metrics.queueSize ?? 0;

  // `workload` is a real 0-1 reading, so an idle engine legitimately reports 0%.
  // Only a missing/non-numeric field renders as "n/a" — collapsing a genuine
  // zero into "no data" would hide the fact that the engine is simply idle.
  const workloadRaw = metrics.workload;
  const workloadPct =
    typeof workloadRaw === 'number' && Number.isFinite(workloadRaw)
      ? Math.min(100, Math.max(0, workloadRaw * 100))
      : null;

  return (
    <Panel
      className={cn('ds-rise group flex flex-col p-0 relative transition-all duration-200', tone === 'ok' ? 'border-success/50 ring-1 ring-success/20 shadow-[0_0_20px_-12px_hsl(var(--success)/0.15)] hover:border-success/80 hover:ring-success/40 hover:shadow-[0_0_24px_-10px_hsl(var(--success)/0.25)]' : tone === 'bad' ? 'border-destructive/60 ring-1 ring-destructive/20 shadow-[0_0_20px_-12px_hsl(var(--destructive)/0.15)] hover:border-destructive/90 hover:ring-destructive/40 hover:shadow-[0_0_24px_-10px_hsl(var(--destructive)/0.25)]' : tone === 'warn' ? 'border-warning/50 ring-1 ring-warning/20 shadow-[0_0_20px_-12px_hsl(var(--warning)/0.15)] hover:border-warning/90 hover:ring-warning/40 hover:shadow-[0_0_24px_-10px_hsl(var(--warning)/0.25)]' : 'border-border/60 ring-1 ring-border/10 hover:border-border/80 hover:ring-border/20')}
      style={stagger(index % 12)}
    >
      {/* Category accent rail — the fleet's colour key. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{
          backgroundImage: `linear-gradient(90deg, hsl(var(--${catVar(CatAccent)})), transparent)`,
        }}
      />
      <span
        aria-hidden
        className="absolute -right-10 -top-12 h-28 w-28 rounded-full blur-2xl transition-opacity duration-500 group-hover:opacity-100"
        style={{ backgroundImage: `radial-gradient(circle, hsl(var(--${catVar(CatAccent)}) / 0.22), transparent 70%)` }}
      />

      <div className="relative flex items-start gap-1 p-3 pb-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-background/70 to-background/20 ring-1 ring-border/60">
          <CategoryIcon className={cn('h-4 w-4', catTextClass(CatAccent))} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[13px] font-bold leading-tight">{engine.engineName}</p>
            {tone === 'ok' ? <LiveHalo accent="success" size={7} /> : null}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className={cn('font-semibold uppercase tracking-wide', catTextClass(CatAccent))}>
              {prettyState(engine.engineCategory)}
            </span>
            <span className="text-border">·</span>
            <span className="font-mono">v{engine.version}</span>
          </p>
        </div>

        <Trend
          points={series}
          accent={baseAccent}
          gradientId={`fleet-trend-${engine.engineId}`}
          width={54}
          height={22}
        />
      </div>

      {/* State + health */}
      <div className="relative flex flex-wrap items-center gap-1.5 px-3 pb-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1',
            tone === 'ok' && 'bg-success/12 text-success ring-success/25',
            tone === 'bad' && 'bg-destructive/12 text-destructive ring-destructive/25',
            tone === 'warn' && 'bg-warning/12 text-warning ring-warning/25',
            tone === 'unknown' && 'bg-muted text-muted-foreground ring-border',
          )}
        >
          <LiveHalo
            accent={tone === 'ok' ? 'success' : tone === 'bad' ? 'danger' : tone === 'warn' ? 'warning' : 'neutral'}
            size={6}
            live={tone === 'ok'}
          />
          {prettyState(engine.state)}
        </span>

        {engine.health && engine.health !== 'UNKNOWN' ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1',
              engine.health === 'HEALTHY' && 'text-success/80 ring-success/15',
              engine.health === 'DEGRADED' && 'text-warning/80 ring-warning/15',
              engine.health === 'UNHEALTHY' && 'text-destructive/80 ring-destructive/15',
            )}
          >
            {engine.health.toLowerCase()}
          </span>
        ) : null}

        {engine.connectionState && engine.connectionState !== 'UNKNOWN' ? (
          <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground ring-1 ring-border/50">
            {engine.connectionState}
          </span>
        ) : null}
      </div>

      {/* Engine metrics */}
      <div className="relative grid grid-cols-2 gap-1 px-3">
        <MetricChip
          label="Events"
          value={<AnimatedNumber value={eventCount} format={(n) => fmtQty(Math.round(n))} />}
          accent="info"
          icon={Activity}
        />
        <MetricChip
          label="Errors"
          value={<AnimatedNumber value={errors} format={(n) => fmtQty(Math.round(n))} />}
          accent={errors > 0 ? 'danger' : 'success'}
          icon={ShieldCheck}
        />
        <MetricChip label="Queue" value={fmtQty(queueSize)} accent={queueSize > 0 ? 'warning' : 'neutral'} icon={Layers} />
        <MetricChip
          label="Warnings"
          value={fmtQty(warnings)}
          accent={warnings > 0 ? 'warning' : 'neutral'}
          icon={Activity}
        />
      </div>

      {/* Engine-specific metrics */}
      {resolved.length > 0 ? (
        <div className="relative mt-1 grid grid-cols-2 gap-1 px-3">
          {resolved.slice(0, 6).map(({ spec, value }) => (
            <MetricChip
              key={spec.key}
              label={spec.label}
              value={fmtByKind(spec.kind, value)}
              accent={resolveAccent(spec, value)}
              icon={spec.icon}
            />
          ))}
        </div>
      ) : summaryChips.length > 0 ? (
        <div className="relative mt-1 grid grid-cols-2 gap-1 px-3">
          {summaryChips.slice(0, 6).map((c) => (
            <MetricChip
              key={c.key}
              label={c.label}
              value={fmtByKind(c.kind, c.value)}
              accent={c.kind === 'bool' ? (c.value === true ? 'success' : 'neutral') : 'info'}
            />
          ))}
        </div>
      ) : null}

      {/* Workload meter */}
      <div className="relative mt-2 px-3">
        <div className="mb-1 flex items-center justify-between text-[9px] text-muted-foreground">
          <span>Workload</span>
          <span className="font-mono tabular-nums">
            {workloadPct != null ? `${workloadPct.toFixed(0)}%` : 'n/a'}
          </span>
        </div>
        <Meter
          pct={workloadPct}
          accent={CatAccent}
          height={4}
          flow={false}
          label={workloadPct != null ? `Engine workload ${workloadPct.toFixed(0)}%` : 'Engine did not report a workload'}
        />
      </div>

      {/* Footer — `mt-auto` pins it to the card bottom so a card with fewer
          metric chips than its neighbour still ends on the same line. */}
      <div className="relative mt-auto flex items-center justify-between gap-2 border-t border-border/40 px-3 py-1.5 text-[9px] text-muted-foreground">
        <span className="truncate" title={engine.healthReason || undefined}>
          {engine.healthReason || (engine.heartbeatAge != null ? `hb ${fmtAgoSec(engine.heartbeatAge)}` : 'no heartbeat')}
        </span>
        <Link
          href={engineProfileHref(engine.engineId)}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 font-semibold transition-colors hover:bg-primary/10 hover:text-primary"
        >
          Open <span aria-hidden>→</span>
        </Link>
      </div>
    </Panel>
  );
}

/** CSS variable name for an accent, used inside inline `hsl(var(--x))` values. */
function catVar(a: Accent): string {
  const map: Record<Accent, string> = {
    primary: 'primary',
    info: 'info',
    purple: 'purple',
    teal: 'teal',
    success: 'success',
    warning: 'warning',
    danger: 'destructive',
    neutral: 'muted-foreground',
  };
  return map[a];
}

function catTextClass(a: Accent): string {
  const map: Record<Accent, string> = {
    primary: 'text-primary',
    info: 'text-info',
    purple: 'text-purple',
    teal: 'text-teal',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-destructive',
    neutral: 'text-muted-foreground',
  };
  return map[a];
}

/** Compact "x ago" for a heartbeat age in seconds. */
function fmtAgoSec(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'n/a';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Grid                                                                 */
/* ------------------------------------------------------------------ */

/** Category order — core planes first, then the leaves that depend on them. */
const CATEGORY_ORDER = ['CORE', 'CONTROL', 'MARKET_DATA', 'DATA', 'STORAGE', 'TRADING', 'AI'];

export function EngineFleet({
  engines,
  series,
}: {
  engines: EngineStatus[];
  /** Per-engine event-rate history, keyed by engineId, oldest first. */
  series: Record<string, number[]>;
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, EngineStatus[]>();
    for (const e of engines) {
      const key = e.engineCategory || 'OTHER';
      const list = map.get(key);
      if (list) list.push(e);
      else map.set(key, [e]);
    }
    return [...map.entries()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a[0]);
      const ib = CATEGORY_ORDER.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [engines]);

  if (engines.length === 0) return null;

  return (
    <div className="space-y-4">
      {grouped.map(([category, list]) => {
        const accent = CATEGORY_ACCENT[category] ?? 'neutral';
        const Icon = CATEGORY_ICON[category] ?? Bot;
        const healthy = list.filter((e) => engineStateTone(e) === 'ok').length;

        return (
          <div key={category}>
            <div className="mb-2 flex items-center gap-2">
              <Icon className={cn('h-3.5 w-3.5', catTextClass(accent))} />
              <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">
                {prettyState(category)}
              </h3>
              <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                <span className={healthy === list.length ? 'text-success' : 'text-warning'}>{healthy}</span>
                <span className="text-muted-foreground/60">/{list.length}</span>
              </span>
            </div>

            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {list.map((e, i) => (
                <EngineCard key={e.engineId} engine={e} series={series[e.engineId] ?? []} index={i} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { CATEGORY_ACCENT, CATEGORY_ICON, catTextClass, catVar, fmtAgoSec, prettyState };
