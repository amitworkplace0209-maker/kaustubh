'use client';

/**
 * Connection Manager — Overview (redesigned).
 *
 * docs/engines/connection-manager.md
 *   §47 DATA OWNERSHIP RULES  → the transport topology + ownership panel
 *   §51 HEALTH DASHBOARD INFORMATION → the 13 mandated aggregate metrics
 *   §27 CONNECTION HEALTH / §28 DATA QUALITY vs HEALTH / §56 STALE DATA
 *   §26 BACKPRESSURE / §24 DATA DELIVERY FILTERING / §23 CONNECTION STATES
 *   RULE 22 lifecycle must be observable and diagnosable
 *
 * Design brief: a modern, dark-glass "mission control" surface. It stays a
 * control-plane/diagnostic view (spec §13) — it never creates, pauses or
 * deletes a connection, because the gateway control endpoints are read-only.
 *
 * Every number is rendered from a backend payload. Nothing is recalculated in
 * the browser and no value is invented: where the backend has no number, the
 * tile says so explicitly (spec §10, RULE 14, the project's honesty rule).
 * Derived/absent metrics are tagged so a derived number never reads as a
 * directly reported one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Cable,
  Check,
  Copy,
  Database,
  Gauge,
  HardDrive,
  History,
  Info,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  ShieldCheck,
  Timer,
  Waypoints,
  Zap,
} from 'lucide-react';
import {
  EmptyState,
  ErrorState,
  LiveIndicator,
  SectionCard,
  StatusBadge,
} from '@/components/design-system';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChannelThroughputChart } from './cm-charts';
import { ChannelSplitDonut } from './cm-charts';
import { BackpressureChart } from './cm-charts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DASH,
  NOT_PROVIDED,
  KV,
  KVGrid,
  TokenList,
  connectionTone,
  downloadJson,
  fmtAgo,
  fmtBytes,
  fmtClock,
  fmtCompact,
  fmtDateTime,
  fmtIso,
  fmtMs,
  fmtNum,
  fmtSeconds,
  fmtUptime,
  freshnessTone,
  healthTone,
  isAlive,
  levelTone,
  readHistorySeries,
  useAutoRefresh,
  useConnectionManagerData,
  useCopy,
  useDebounced,
  useNow,
  useSortState,
  type CmArchitectureEntry,
  type CmHealth,
  type CmHistoryEvent,
} from './cm-shared';
import {
  RadialGauge,
  Sparkline,
  StateBar,
  TransportTopology,
  stateBarColor,
  type GaugeTone,
  type TopologyNode,
} from './cm-visual';

const TRANSPORT_ORDER = ['WS#1', 'WS#2', 'WS#3', 'WS#4', 'REST', 'Broker REST', 'Event Bus'];
/** The only transports this engine owns (spec §47). */
const GATEWAY_IDS = ['WS#3', 'WS#4'];

const HEALTH_ACCENT: Record<string, { tone: GaugeTone; glow: string; ring: string; wash: string }> = {
  HEALTHY: {
    tone: 'success',
    glow: 'hsl(var(--success) / 0.28)',
    ring: 'border-success/35',
    wash: 'from-success/[0.14] via-success/[0.04] to-transparent',
  },
  DEGRADED: {
    tone: 'warning',
    glow: 'hsl(var(--warning) / 0.3)',
    ring: 'border-warning/40',
    wash: 'from-warning/[0.14] via-warning/[0.04] to-transparent',
  },
  OVERLOADED: {
    tone: 'danger',
    glow: 'hsl(var(--destructive) / 0.3)',
    ring: 'border-destructive/40',
    wash: 'from-destructive/[0.14] via-destructive/[0.04] to-transparent',
  },
  ERROR: {
    tone: 'danger',
    glow: 'hsl(var(--destructive) / 0.32)',
    ring: 'border-destructive/50',
    wash: 'from-destructive/[0.16] via-destructive/[0.05] to-transparent',
  },
  NO_DATA: {
    tone: 'info',
    glow: 'hsl(var(--info) / 0.26)',
    ring: 'border-info/35',
    wash: 'from-info/[0.13] via-info/[0.04] to-transparent',
  },
  STOPPED: {
    tone: 'neutral',
    glow: 'hsl(var(--muted-foreground) / 0.18)',
    ring: 'border-border',
    wash: 'from-muted/60 to-transparent',
  },
};

export default function ConnectionManagerOverview() {
  const data = useConnectionManagerData();
  const now = useNow(1000);
  const historyRef = useRef<Record<string, number[]>>({});

  const [channelQuery, setChannelQuery] = useState('');
  const [channelKind, setChannelKind] = useState<'all' | 'market' | 'state'>('all');
  const [expandedEvents, setExpandedEvents] = useState(false);
  const debouncedQuery = useDebounced(channelQuery, 250);
  const { copy, copied } = useCopy();
  const auto = useAutoRefresh(data.reload, 15000);

  const health: CmHealth | null = data.health ?? data.payload?.health ?? null;
  const engineState = data.payload?.lifecycle?.engineState ?? data.engine?.state ?? null;
  const registry = useMemo(() => data.payload?.connectionRegistry ?? [], [data.payload]);
  const allChannels = useMemo(() => Object.entries(data.payload?.channelMetrics ?? {}), [data.payload]);
  const events = useMemo(() => data.payload?.lastEvents ?? [], [data.payload]);
  const lifecycle = useMemo(
    () => data.payload?.lifecycle?.connections ?? {},
    [data.payload],
  );

  const queues = data.payload?.backpressure;
  const queueLimit = queues?.queueLimit ?? data.config?.backpressure?.queueLimit ?? null;
  const queueMax = queues?.queueDepthMax ?? null;
  const liveConns = registry.filter((c) => isAlive(c.status)).length;

  // Record each realtime push into the bounded client-side rings so headline
  // tiles can show a real trend of what the backend reported.
  useEffect(() => {
    const push = (k: string, v: number | null | undefined) => {
      if (v == null || !Number.isFinite(v)) return;
      const list = historyRef.current[k] ?? [];
      const next = [...list, v];
      historyRef.current[k] = next.length > 24 ? next.slice(next.length - 24) : next;
    };
    push('active', data.payload?.stats?.activeConnections ?? null);
    push('frames', data.payload?.framesRouted ?? null);
    push('queue', queueMax);
    push('rate', registry.reduce((a, c) => a + (c.deliveryRatePerSec ?? 0), 0) || null);
    push('bytes', data.payload?.stats?.bytesPerSec ?? null);
    push('latency', data.payload?.stats?.avgDeliveryLatencyMs ?? null);
  }, [data.payload, data.updatedAt, registry, queueMax]);

  const filteredChannels = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    return allChannels.filter(([name, m]) => {
      if (channelKind === 'market' && !m.kind?.includes('market')) return false;
      if (channelKind === 'state' && m.kind?.includes('market')) return false;
      if (!q) return true;
      return `${name} ${m.kind ?? ''} ${m.profileId ?? ''} ${m.priority ?? ''}`.toLowerCase().includes(q);
    });
  }, [allChannels, debouncedQuery, channelKind]);

  const throughputRows = useMemo(
    () =>
      filteredChannels.map(([name, m]) => ({
        name,
        delivered: m.delivered ?? 0,
        subscribers: m.subscribers ?? null,
        kind: m.kind ?? '',
      })),
    [filteredChannels],
  );

  const snapshot = useMemo(
    () => ({
      generatedAt: new Date().toISOString(),
      engine: data.engine?.engineName ?? 'connection_manager',
      state: engineState,
      health: health?.state ?? null,
      reason: health?.reason ?? null,
      connections: {
        alive: liveConns,
        total: registry.length,
        lifecycle,
      },
      channels: filteredChannels.map(([name, m]) => ({ name, ...m })),
      backpressure: queues ?? null,
      architecture: data.architecture ?? null,
    }),
    [data.engine, engineState, health, liveConns, registry.length, lifecycle, filteredChannels, queues, data.architecture],
  );

  if (data.loading) {
    return (
      <div className="space-y-4">
        <HeroSkeleton />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 cm-shimmer rounded-xl border border-border/60 bg-card/40" />
          ))}
        </div>
      </div>
    );
  }

  const accent = HEALTH_ACCENT[(health?.state ?? '').toUpperCase()] ?? HEALTH_ACCENT.STOPPED;
  const isLive = Boolean(data.connected && data.source === 'realtime');

  return (
    <div className="space-y-5">
      {/* ================= HERO — live identity + controls ================= */}
      <Hero
        healthState={health?.state ?? 'UNKNOWN'}
        engineState={engineState}
        isLive={isLive}
        source={data.source}
        updatedAt={data.updatedAt}
        now={now}
        uptime={uptimeFrom(data.payload?.startedAt, now)}
        sessions={data.payload?.sessions ?? null}
        liveConns={liveConns}
        totalConns={registry.length}
        frameRate={registry.length ? registry.reduce((a, c) => a + (c.deliveryRatePerSec ?? 0), 0) : null}
        frameRateSeries={readHistorySeries(historyRef, 'rate')}
        accent={accent}
        autoEnabled={auto.enabled}
        onToggleAuto={() => auto.setEnabled((v) => !v)}
        secondsLeft={auto.secondsLeft}
        onRefresh={data.reload}
        onCopy={() => void copy(JSON.stringify(snapshot, null, 2))}
        onExport={() => downloadJson('connection-manager-snapshot.json', snapshot)}
        copied={copied}
      />

      {data.errors.length ? <ErrorState message={data.errors.join(' · ')} onRetry={data.reload} /> : null}

      {/* ================= HEALTH GAUGES (spec §27 / §28 / §56) ================= */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HealthGaugeCard
          title="Connection health"
          icon={Gauge}
          tone={accent.tone}
          state={health?.state ?? 'UNKNOWN'}
          caption={health?.reason ?? 'Backend reported no reason'}
          gauge={
            <RadialGauge
              value={health ? healthScore(health.state) : null}
              max={100}
              label="health score"
              tone={accent.tone}
              unit="%"
              live={isLive}
            />
          }
          footer={
            <KVGrid cols={1}>
              <KV label="Checked at" value={fmtDateTime(health?.checkedAt)} />
              <KV label="Active / total" value={`${fmtNum(health?.activeConnections ?? null)} / ${fmtNum(health?.totalConnections ?? null)}`} />
            </KVGrid>
          }
        />

        <HealthGaugeCard
          title="Feed freshness"
          icon={Radio}
          tone={freshnessTone(data.payload?.freshness?.state) as GaugeTone}
          state={data.payload?.freshness?.state ?? 'UNKNOWN'}
          caption="Spec §56 — data quality, separate from health"
          gauge={
            <RadialGauge
              value={freshnessPct(data.payload?.freshness?.lastTickAgeSeconds, data.config)}
              max={100}
              label="freshness used"
              tone={freshnessTone(data.payload?.freshness?.state) as GaugeTone}
              unit="%"
            />
          }
          footer={
            <KVGrid cols={1}>
              <KV label="Tick age" value={fmtSeconds(data.payload?.freshness?.lastTickAgeSeconds)} />
              <KV label="Stale after" value={fmtSeconds(data.config?.staleAfterS)} />
              <KV label="Fresh ≤" value={fmtSeconds(data.config?.freshnessThresholds?.freshMaxAgeS)} />
            </KVGrid>
          }
        />

        <HealthGaugeCard
          title="Backpressure"
          icon={HardDrive}
          tone={queueTone(queueMax, queueLimit)}
          state={(queues?.policy ?? 'UNKNOWN').toUpperCase()}
          caption="Spec §26 — bounded queue, counted overflow"
          body={
            <BackpressureChart
              total={queues?.queueDepthTotal ?? null}
              max={queueMax}
              limit={queueLimit}
              droppedMarket={queues?.droppedMarket ?? null}
              droppedCritical={queues?.droppedCritical ?? null}
            />
          }
          footer={
            <KVGrid cols={1}>
              <KV label="Queue limit" value={fmtNum(queueLimit)} />
              <KV
                label="Dropped market"
                value={fmtNum(queues?.droppedMarket ?? null)}
                tone={(queues?.droppedMarket ?? 0) > 0 ? 'text-warning' : undefined}
              />
            </KVGrid>
          }
        />

        <HealthGaugeCard
          title="Gateway"
          icon={Cable}
          tone={connectionTone(engineState) as GaugeTone}
          state={engineState ?? 'UNKNOWN'}
          caption="Frames routed since start"
          gauge={
            <RadialGauge
              value={data.payload?.framesRouted ?? null}
              max={Math.max(100, data.payload?.framesRouted ?? 100)}
              label="frames routed"
              tone="info"
              unit=""
              live={isLive}
            />
          }
          footer={
            <KVGrid cols={1}>
              <KV label="Sessions" value={fmtNum(data.payload?.sessions)} />
              <KV label="Frames routed" value={fmtCompact(data.payload?.framesRouted)} />
              <KV label="Started" value={data.payload?.started ? 'yes' : 'no'} />
            </KVGrid>
          }
        />
      </div>

      {/* ================= SPEC §51 — the 13 mandated aggregate metrics ================= */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-primary" aria-hidden />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Health dashboard
            </h2>
            <span className="rounded-full border border-border/60 px-1.5 py-px font-mono text-[9px] text-muted-foreground">
              spec §51
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            <span className="font-mono text-foreground/70">derived</span> = computed from reported values
            <span className="mx-1.5">·</span>
            <span className="font-mono text-foreground/70">absent</span> = not provided by backend
          </p>
        </div>
        <AggregateGrid historyRef={historyRef} payload={data.payload} health={health} config={data.config} />
      </section>

      {/* ================= TRANSPORT TOPOLOGY (spec §47) ================= */}
      <SectionCard
        title="Transport topology"
        icon={ShieldCheck}
        className="overflow-hidden"
        headerRight={
          <div className="flex items-center gap-3">
            <LegendDot color="hsl(var(--primary))" label="Owned by this engine" />
            <LegendDot color="hsl(var(--success))" label="Connected" />
            <LegendDot color="hsl(var(--border))" label="Idle / unknown" />
          </div>
        }
      >
        {data.architecture ? (
          <TransportTopology
            nodes={topologyNodes(data.architecture)}
            gatewayIds={GATEWAY_IDS}
            consumerCount={liveConns}
          />
        ) : (
          <EmptyState
            icon={Waypoints}
            title="Transport map unavailable"
            description="GET /api/realtime/architecture did not return data. Ownership cannot be inferred, so nothing is shown."
          />
        )}
        {data.architecture ? (
          <div className="mt-3 grid gap-2 border-t border-border/50 pt-3 sm:grid-cols-2 lg:grid-cols-4">
            {TRANSPORT_ORDER.filter((k) => data.architecture?.[k]).map((key) => (
              <TransportCard key={key} name={key} entry={data.architecture![key]} />
            ))}
          </div>
        ) : null}
      </SectionCard>

      {/* ================= CHANNELS — chart + table ================= */}
      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard
          title="Channel throughput"
          icon={Zap}
          className="xl:col-span-2"
          headerRight={
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={channelQuery}
                  onChange={(e) => setChannelQuery(e.target.value)}
                  placeholder="Filter channels…"
                  aria-label="Filter channels"
                  className="h-8 w-40 pl-7 text-xs"
                />
              </div>
              <div className="flex rounded-md border border-border/60 p-0.5">
                {(['all', 'market', 'state'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setChannelKind(k)}
                    className={`rounded px-2 py-1 text-[10px] font-medium capitalize transition-colors ${
                      channelKind === k
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          {throughputRows.length ? (
            <ChannelThroughputChart rows={throughputRows} />
          ) : (
            <EmptyState
              icon={Zap}
              title="No channel metrics"
              description="The gateway reported no per-channel counters yet."
            />
          )}
        </SectionCard>

        <SectionCard title="Channel mix & sessions" icon={Activity}>
          {allChannels.length ? (
            <div className="space-y-4">
              <ChannelSplitDonut
                market={data.payload?.marketChannels?.length ?? 0}
                state={data.payload?.stateChannels?.length ?? 0}
              />
              <KVGrid cols={1}>
                <KV label="Market channels" value={fmtNum(data.payload?.marketChannels?.length ?? null)} />
                <KV label="State channels" value={fmtNum(data.payload?.stateChannels?.length ?? null)} />
                <KV label="Profiles" value={fmtNum(Object.keys(data.config?.channels?.market ?? {}).length || null)} />
                <KV label="Envelope v" value={String(data.config?.envelopeVersion ?? DASH)} />
              </KVGrid>
            </div>
          ) : (
            <EmptyState icon={Activity} title="No channels yet" description="Nothing subscribed." />
          )}
        </SectionCard>
      </div>

      <ChannelTable
        rows={filteredChannels}
        totalChannels={allChannels.length}
      />

      {/* ================= CONNECTIONS + PERSISTENCE ================= */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={`Live connections (${liveConns})`}
          icon={Waypoints}
          headerRight={
            <a
              href="/services/connection-manager/connections"
              className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
            >
              Diagnostics <ArrowUpRight className="h-3 w-3" aria-hidden />
            </a>
          }
        >
          {registry.length ? (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Alive vs terminated</span>
                    <span className="font-mono tabular-nums">
                      {liveConns}/{registry.length}
                    </span>
                  </div>
                  <StateBar
                    states={{ ALIVE: liveConns, TERMINATED: Math.max(0, registry.length - liveConns) }}
                    total={registry.length}
                  />
                </div>
              </div>
              <KVGrid>
                <KV label="Messages delivered" value={fmtCompact(data.payload?.stats?.messagesDelivered)} />
                <KV label="Messages routed" value={fmtCompact(data.payload?.stats?.messagesRouted)} />
                <KV
                  label="Dropped"
                  value={fmtNum(data.payload?.stats?.messagesDropped ?? null)}
                  tone={(data.payload?.stats?.messagesDropped ?? 0) > 0 ? 'text-warning' : undefined}
                />
                <KV label="Lifecycle map" value={<LifecyclePills lifecycle={lifecycle} />} mono={false} />
              </KVGrid>
              <KV
                label="Consumer types"
                value={<TokenList values={[...new Set(registry.map((c) => c.consumerType))]} />}
                mono={false}
              />
            </div>
          ) : (
            <EmptyState
              icon={Waypoints}
              title="No gateway sessions"
              description="No consumer is currently attached to WS#3. Registration happens automatically when a frontend subscribes."
            />
          )}
        </SectionCard>

        <SectionCard title="Persistence & order feed" icon={Database}>
          <div className="space-y-3">
            <KVGrid>
              <KV label="Persistence consumer" value={data.payload?.persistence?.consumerId ?? DASH} />
              <KV label="Ticks persisted" value={fmtCompact(data.payload?.persistence?.ticksPersisted)} />
              <KV
                label="Persist errors"
                value={fmtNum(data.payload?.persistence?.errors)}
                tone={(data.payload?.persistence?.errors ?? 0) > 0 ? 'text-destructive' : undefined}
              />
              <KV label="Health persist errors" value={fmtNum(health?.persistErrors)} />
            </KVGrid>
            <div className="border-t border-border/50 pt-3">
              <div className="mb-2 flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  WS#2 order feed
                </span>
                <span className="rounded-full border border-border/60 px-1 text-[8px] uppercase text-muted-foreground">
                  observed · not owned
                </span>
              </div>
              {data.orderFeed ? (
                <KVGrid>
                  <KV label="State" value={String(data.orderFeed.state ?? DASH)} />
                  <KV label="Connected" value={data.orderFeed.connected ? 'yes' : 'no'} />
                  <KV label="Feed id" value={String(data.orderFeed.feedId ?? DASH)} />
                  <KV label="Order updates" value={fmtNum(data.orderFeed.totalOrderUpdates as number)} />
                  <KV label="Position updates" value={fmtNum(data.orderFeed.totalPositionUpdates as number)} />
                  <KV label="Messages" value={fmtNum(data.orderFeed.totalMessages as number)} />
                  <KV
                    label="Reconnects"
                    value={fmtNum(data.orderFeed.reconnectAttempt as number)}
                    tone={(data.orderFeed.reconnectAttempt as number) > 0 ? 'text-warning' : undefined}
                  />
                </KVGrid>
              ) : (
                <p className="text-[11px] text-muted-foreground">Order feed state unavailable.</p>
              )}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* ================= EVENT STREAM (spec §65) ================= */}
      <SectionCard
        title={`Event stream (${events.length})`}
        icon={ScrollText}
        headerRight={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpandedEvents((v) => !v)}
            className="gap-1"
          >
            {expandedEvents ? 'Collapse' : `Show all (${events.length})`}
          </Button>
        }
      >
        {events.length ? (
          <EventStream events={events} expanded={expandedEvents} now={now} />
        ) : (
          <EmptyState
            icon={ScrollText}
            title="No events recorded"
            description="The bounded event ring is empty for this process."
          />
        )}
      </SectionCard>

      {/* ================= §29 CONNECTION HISTORY (real persisted ledger) ================= */}
      <SectionCard
        title="Connection history (spec §29)"
        icon={History}
        headerRight={
          <span className="text-[10px] text-muted-foreground">
            persisted attach/detach ledger · bounded {data.history?.summary?.bound ?? '—'}
          </span>
        }
      >
        {data.history ? (
          <div className="space-y-3">
            <KVGrid cols={4}>
              <KV label="Sessions 24h" value={fmtNum(data.history.summary?.sessionsLast24h ?? null)} />
              <KV label="Avg session" value={data.history.summary?.avgSessionSeconds == null ? DASH : fmtSeconds(data.history.summary.avgSessionSeconds)} />
              <KV label="Rows stored" value={fmtNum(data.history.summary?.rowsStored ?? null)} />
              <KV label="Fresh rows" value={fmtNum(data.history.summary?.rowsLoaded ?? null)} />
            </KVGrid>
            {data.history.events.length ? (
              <div className="space-y-1">
                {data.history.events.slice(0, 8).map((e: CmHistoryEvent, i: number) => (
                  <div
                    key={`${e.connectionId}-${e.event}-${e.epoch}`}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border/40 bg-background/30 px-2.5 py-1 font-mono text-[10px]"
                    style={{ animation: 'cm-rise 0.4s ease-out both', animationDelay: `${Math.min(i * 24, 200)}ms` }}
                  >
                    <span className="w-32 shrink-0 tabular-nums text-muted-foreground">{fmtIso(e.ts)}</span>
                    <span className="w-20 shrink-0">
                      <StatusBadge
                        status={e.event === 'ATTACHED' ? 'success' : e.event === 'DETACHED' ? 'neutral' : 'info'}
                        label={e.event.slice(0, 5)}
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={e.connectionId}>{e.connectionId.slice(0, 10)}</span>
                    <span className="truncate text-muted-foreground" title={e.reason ?? ''}>{e.reason || DASH}</span>
                    {e.durationSeconds != null ? <span className="shrink-0 tabular-nums">{fmtSeconds(e.durationSeconds)}</span> : null}
                    {e.framesDelivered != null ? <span className="shrink-0 tabular-nums text-muted-foreground">{fmtCompact(e.framesDelivered)} frames</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Ledger khali hai — pehla session attach hote hi rows yahan aayenge.
              </p>
            )}
          </div>
        ) : (
          <EmptyState
            icon={ScrollText}
            title="History unavailable"
            description="GET /api/realtime/connections/history did not return data — nothing is shown rather than guessed."
          />
        )}
      </SectionCard>

      {/* ================= HONEST GAPS (spec §20) ================= */}
      <div className="rounded-xl border border-dashed border-warning/40 bg-warning/[0.04] px-4 py-3">
        <div className="flex items-start gap-2.5">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="text-xs font-semibold text-foreground">Not measured by this engine</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Spec §20 expiry history has no backend endpoint yet — session attach/detach history{' '}
              (§29) aur wire <span className="font-mono text-foreground/80">bytes/sec</span> +{' '}
              <span className="font-mono text-foreground/80">avg delivery latency</span> ab REAL measured ledger me
              hain. Jo abhi bhi nahi naapa jata wo gap hi dikhaya jata hai, placeholder nahi.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// HERO
// ===========================================================================

function Hero({
  healthState,
  engineState,
  isLive,
  source,
  updatedAt,
  now,
  uptime,
  sessions,
  liveConns,
  totalConns,
  frameRate,
  frameRateSeries,
  accent,
  autoEnabled,
  onToggleAuto,
  secondsLeft,
  onRefresh,
  onCopy,
  onExport,
  copied,
}: {
  healthState: string;
  engineState: string | null;
  isLive: boolean;
  source: 'api' | 'realtime' | null;
  updatedAt: number | null;
  now: number;
  uptime: number | null;
  sessions: number | null;
  liveConns: number;
  totalConns: number;
  frameRate: number | null;
  frameRateSeries: number[];
  accent: { tone: GaugeTone; glow: string; ring: string; wash: string };
  autoEnabled: boolean;
  onToggleAuto: () => void;
  secondsLeft: number;
  onRefresh: () => void;
  onCopy: () => void;
  onExport: () => void;
  copied: boolean;
}) {
  return (
    <div
      className={`cm-sweep relative overflow-hidden rounded-2xl border ${accent.ring} bg-gradient-to-br ${accent.wash} p-5 shadow-soft-lg`}
      style={{ boxShadow: `0 0 0 1px transparent, 0 18px 48px -24px ${accent.glow}` }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full blur-3xl"
        style={{ background: accent.glow }}
      />
      <div className="relative flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/30">
              <Waypoints className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-display sm:text-2xl">Connection Manager</h1>
              <p className="text-xs text-muted-foreground">
                Realtime gateway control plane <span className="font-mono">·</span> WS#3/WS#4 ownership
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusBadge status={healthTone(healthState)} label={healthState} />
            <StatusBadge status={connectionTone(engineState)} label={engineState ?? 'UNKNOWN'} />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
              <span className={isLive ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-success' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'} />
              {isLive ? 'LIVE' : source === 'api' ? 'SNAPSHOT' : 'OFFLINE'}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <LiveIndicator
              live={isLive}
              label={
                source === 'realtime'
                  ? `updated ${fmtAgo(updatedAt ? updatedAt / 1000 : null, now)}`
                  : source === 'api'
                    ? 'REST snapshot (no live frame yet)'
                    : 'offline'
              }
            />
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" aria-hidden /> uptime {fmtUptime(uptime)}
            </span>
            {frameRate != null ? (
              <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                <Zap className="h-3 w-3" aria-hidden /> {frameRate.toFixed(2)} msg/s
              </span>
            ) : null}
          </div>
        </div>

        {/* Live numbers strip */}
        <div className="flex items-stretch gap-3">
          <div className="flex flex-col items-center justify-center rounded-xl border border-border/50 bg-background/40 px-4 py-2 backdrop-blur">
            <span className="font-mono text-2xl font-semibold leading-none tabular-nums">{liveConns}</span>
            <span className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">live conns</span>
          </div>
          <div className="flex flex-col items-center justify-center rounded-xl border border-border/50 bg-background/40 px-4 py-2 backdrop-blur">
            <span className="font-mono text-2xl font-semibold leading-none tabular-nums">{totalConns}</span>
            <span className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">registry</span>
          </div>
          <div className="hidden flex-col items-center justify-center rounded-xl border border-border/50 bg-background/40 px-4 py-2 backdrop-blur sm:flex">
            <Sparkline points={frameRateSeries.length > 1 ? frameRateSeries : [0, 0]} tone="teal" width={74} height={30} />
            <span className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">
              {sessions == null ? 'sessions n/a' : `${sessions} sess`}
            </span>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
        <Button onClick={onRefresh} size="sm" className="gap-1.5 shadow-soft">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </Button>
        <Button
          variant={autoEnabled ? 'secondary' : 'outline'}
          size="sm"
          onClick={onToggleAuto}
          className="gap-1.5"
          title="Poll the read-only REST surfaces on an interval (off by default; realtime frames are the primary source)"
        >
          {autoEnabled ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          {autoEnabled ? `Auto ${secondsLeft}s` : 'Auto'}
        </Button>
        <Button variant="outline" size="sm" onClick={onCopy} className="gap-1.5">
          {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy JSON'}
        </Button>
        <Button variant="outline" size="sm" onClick={onExport} className="gap-1.5">
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          Export
        </Button>
        <div className="ml-auto hidden items-center gap-2 text-[10px] text-muted-foreground lg:flex">
          <a href="/services/connection-manager/connections" className="hover:text-primary hover:underline">
            Connections
          </a>
          <span className="text-border">/</span>
          <a href="/services/connection-manager/events" className="hover:text-primary hover:underline">
            Events
          </a>
          <span className="text-border">/</span>
          <a href="/services/connection-manager/configuration" className="hover:text-primary hover:underline">
            Configuration
          </a>
        </div>
      </div>
    </div>
  );
}

function HeroSkeleton() {
  return (
    <div className="cm-shimmer h-52 rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 to-transparent" />
  );
}

// ===========================================================================
// HEALTH GAUGE CARD
// ===========================================================================

function HealthGaugeCard({
  title,
  icon: Icon,
  tone,
  state,
  caption,
  gauge,
  body,
  footer,
}: {
  title: string;
  icon: React.ElementType;
  tone: GaugeTone;
  state: string;
  caption: string;
  gauge?: React.ReactNode;
  body?: React.ReactNode;
  footer?: React.ReactNode;
}) {
const border =
    tone === 'danger'
      ? 'border-destructive/30'
      : tone === 'warning'
        ? 'border-warning/30'
        : tone === 'success'
          ? 'border-success/25'
          : tone === 'info'
            ? 'border-info/25'
            : tone === 'teal'
              ? 'border-teal/30'
              : 'border-border';
  const text =
    tone === 'danger'
      ? 'text-destructive'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'success'
          ? 'text-success'
          : tone === 'info'
            ? 'text-info'
            : tone === 'teal'
              ? 'text-teal'
              : 'text-muted-foreground';
  const chip =
    tone === 'danger'
      ? 'bg-destructive/15 ring-destructive/25'
      : tone === 'warning'
        ? 'bg-warning/15 ring-warning/25'
        : tone === 'success'
          ? 'bg-success/15 ring-success/25'
          : tone === 'info'
            ? 'bg-info/15 ring-info/25'
            : tone === 'teal'
              ? 'bg-teal/15 ring-teal/25'
              : 'bg-muted/70 ring-border/50';

  return (
    <div className={`group relative flex flex-col overflow-hidden rounded-xl border ${border} bg-card/60 p-4 shadow-soft backdrop-blur transition-transform hover:-translate-y-0.5`}>
      <span aria-hidden className="cm-sheen absolute inset-0" />
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${chip} ${text}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className={`truncate font-mono text-sm font-semibold ${text}`}>{state}</p>
          </div>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center">
        {body ?? gauge}
      </div>
      {footer ? <div className="mt-3 border-t border-border/40 pt-2">{footer}</div> : null}
      {caption ? (
        <p className="mt-2 text-center text-[9px] leading-tight text-muted-foreground/70" title={caption}>
          {caption}
        </p>
      ) : null}
    </div>
  );
}

// ===========================================================================
// AGGREGATE TILES (spec §51)
// ===========================================================================

function AggregateGrid({
  historyRef,
  payload,
  health,
  config,
}: {
  historyRef: React.MutableRefObject<Record<string, number[]>>;
  payload: ReturnType<typeof useConnectionManagerData>['payload'];
  health: CmHealth | null;
  config: ReturnType<typeof useConnectionManagerData>['config'];
}) {
  const items = useMemo(() => {
    const stats = payload?.stats;
    const life = payload?.lifecycle?.connections ?? {};
    const registry = payload?.connectionRegistry ?? [];
    const staleAfterS = config?.staleAfterS ?? null;
    const now = Date.now() / 1000;
    const inState = (s: string) => life[s] ?? 0;

    const msgPerSec = registry.reduce(
      (acc, c) =>
        acc + (typeof c.deliveryRatePerSec === 'number' && Number.isFinite(c.deliveryRatePerSec) ? c.deliveryRatePerSec : 0),
      0,
    );
    const consumers = new Set(registry.map((c) => c.consumerId).filter(Boolean));
    const staleCount =
      staleAfterS == null ? null : registry.filter((c) => (c.lastActivityAt ?? 0) < now - staleAfterS).length;

    return [
      { key: 'total', label: 'Total connections', value: fmtNum(stats?.totalConnections ?? health?.totalConnections ?? null), source: 'reported' as const, spark: null as string | null, tone: 'info' as GaugeTone },
      { key: 'active', label: 'Active connections', value: fmtNum(stats?.activeConnections ?? health?.activeConnections ?? null), source: 'reported' as const, spark: 'active', tone: 'success' as GaugeTone },
      { key: 'paused', label: 'Paused', value: fmtNum(inState('PAUSED')), source: 'derived' as const, detail: 'lifecycle map', spark: null, tone: 'warning' as GaugeTone },
      { key: 'failed', label: 'Failed', value: fmtNum(inState('FAILED')), source: 'derived' as const, detail: 'lifecycle map', spark: null, tone: 'danger' as GaugeTone },
      { key: 'expired', label: 'Expired', value: fmtNum(inState('EXPIRED')), source: 'derived' as const, detail: 'lifecycle map', spark: null, tone: 'neutral' as GaugeTone },
      { key: 'reconnecting', label: 'Reconnecting', value: fmtNum(inState('RECONNECTING')), source: 'derived' as const, detail: 'lifecycle map', spark: null, tone: 'warning' as GaugeTone },
      { key: 'consumers', label: 'Consumers', value: fmtNum(consumers.size), source: 'derived' as const, detail: 'distinct consumerId', spark: null, tone: 'info' as GaugeTone },
      { key: 'msgRate', label: 'Messages / sec', value: registry.length ? msgPerSec.toFixed(2) : DASH, source: 'derived' as const, detail: 'sum of deliveryRatePerSec', spark: 'rate', tone: 'teal' as GaugeTone },
      {
        key: 'bytesRate',
        label: 'Bytes / sec',
        // Real wire bytes measured on the WS writer path; on pre-metric
        // backends the field is absent → explicit NOT_PROVIDED, never a zero.
        value: payload?.stats?.bytesPerSec === undefined
          ? NOT_PROVIDED
          : payload?.stats?.bytesPerSec == null ? DASH : `${fmtBytes(payload.stats.bytesPerSec)}/s`,
        source: payload?.stats?.bytesPerSec === undefined ? ('not-provided' as const) : ('reported' as const),
        detail: 'WS writer bytes (30 s window)',
        spark: 'bytes',
        tone: 'teal' as GaugeTone,
      },
      {
        key: 'deliveryLatency',
        label: 'Avg delivery latency',
        value: payload?.stats?.avgDeliveryLatencyMs === undefined
          ? NOT_PROVIDED
          : payload?.stats?.avgDeliveryLatencyMs == null ? DASH : fmtMs(payload.stats.avgDeliveryLatencyMs),
        source: payload?.stats?.avgDeliveryLatencyMs === undefined ? ('not-provided' as const) : ('reported' as const),
        detail: 'enqueue → delivery (WS writer)',
        spark: 'latency',
        tone: 'info' as GaugeTone,
      },
      { key: 'queueDepthMax', label: 'Max queue depth', value: fmtNum(payload?.backpressure?.queueDepthMax ?? health?.queueDepthMax ?? null), source: 'reported' as const, spark: 'queue', tone: 'warning' as GaugeTone },
      { key: 'dropped', label: 'Dropped messages', value: fmtNum(stats?.messagesDropped ?? health?.messagesDropped ?? null), source: 'reported' as const, spark: null, tone: 'warning' as GaugeTone },
      {
        key: 'stale',
        label: 'Stale connections',
        value: staleCount === null ? NOT_PROVIDED : fmtNum(staleCount),
        source: staleCount === null ? ('not-provided' as const) : ('derived' as const),
        detail: staleAfterS == null ? 'no staleAfterS' : `idle > ${staleAfterS}s`,
        spark: null,
        tone: 'danger' as GaugeTone,
      },
    ];
  }, [payload, health, config]);

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {items.map((item, idx) => {
        const notProvided = item.source === 'not-provided';
        const numeric = item.value !== DASH && item.value !== NOT_PROVIDED;
        const isZero = numeric && Number(String(item.value).replace(/,/g, '')) === 0;
        const alarming = numeric && (item.tone === 'danger' || item.tone === 'warning') && !isZero;
        const series = item.spark ? readHistorySeries(historyRef, item.spark) : [];

        return (
          <div
            key={item.key}
            className="cm-rise group relative overflow-hidden rounded-lg border border-border/60 bg-card/50 p-3 transition-all hover:-translate-y-0.5 hover:border-border hover:shadow-soft"
            style={{ animationDelay: `${Math.min(idx * 28, 280)}ms` }}
          >
            <span aria-hidden className="cm-sheen absolute inset-0" />
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 truncate text-[10px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
                {item.label}
              </span>
              {!notProvided && item.source !== 'reported' ? (
                <span
                  title={item.detail}
                  className="shrink-0 rounded border border-border/70 px-1 text-[8px] uppercase tracking-wide text-muted-foreground"
                >
                  {item.source}
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 flex items-end justify-between gap-2">
              <span
                className={`font-mono text-[15px] font-semibold leading-none tabular-nums ${
                  notProvided
                    ? 'text-[11px] text-muted-foreground/60'
                    : alarming
                      ? 'text-warning'
                      : item.tone === 'success' && numeric && !isZero
                        ? 'text-success'
                        : 'text-foreground'
                }`}
              >
                {item.value}
              </span>
              {series.length > 1 ? <Sparkline points={series} tone={item.tone} width={56} height={22} /> : null}
            </div>
            {item.source !== 'reported' && item.detail ? (
              <p className="mt-1 truncate text-[9px] text-muted-foreground/60" title={item.detail}>
                {item.detail}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ===========================================================================
// CHANNEL TABLE
// ===========================================================================

function ChannelTable({
  rows,
  totalChannels,
}: {
  rows: [string, import('./cm-shared').CmChannelMetric][];
  totalChannels: number;
}) {
  type Key = 'name' | 'kind' | 'profile' | 'priority' | 'minInterval' | 'subscribers' | 'delivered';
  const s = useSortState<Key>('delivered', 'desc');

  const sorted = useMemo(
    () =>
      s.sort(rows, {
        name: ([n]) => n,
        kind: ([, m]) => m.kind ?? '',
        profile: ([, m]) => m.profileId ?? '',
        priority: ([, m]) => m.priority ?? '',
        minInterval: ([, m]) => m.minIntervalS ?? null,
        subscribers: ([, m]) => m.subscribers ?? null,
        delivered: ([, m]) => m.delivered ?? null,
      }),
    [rows, s],
  );

  const cols: { key: Key; label: string; align?: 'right' }[] = [
    { key: 'name', label: 'Channel' },
    { key: 'kind', label: 'Kind' },
    { key: 'profile', label: 'Profile' },
    { key: 'priority', label: 'Priority' },
    { key: 'minInterval', label: 'Min intv', align: 'right' },
    { key: 'subscribers', label: 'Subs', align: 'right' },
    { key: 'delivered', label: 'Delivered', align: 'right' },
  ];

  const maxDelivered = useMemo(
    () => Math.max(1, ...rows.map(([, m]) => m.delivered ?? 0)),
    [rows],
  );

  return (
    <SectionCard
      title={`Delivery channels (${rows.length}${rows.length !== totalChannels ? ` of ${totalChannels}` : ''})`}
      icon={Activity}
      headerRight={
        <span className="text-[10px] text-muted-foreground">
          market channels are throttled per profile · state channels are event-shaped
        </span>
      }
    >
      {rows.length ? (
        <div className="cm-scroll max-h-[420px] overflow-auto rounded-lg border border-border/60">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <TableRow className="hover:bg-transparent">
                {cols.map((c) => (
                  <TableHead
                    key={c.key}
                    onClick={() => s.toggle(c.key)}
                    className={`cursor-pointer select-none whitespace-nowrap transition-colors hover:text-foreground ${
                      c.align === 'right' ? 'text-right' : ''
                    } ${s.key === c.key ? 'text-primary' : ''}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      {s.indicator(c.key) ? <span className="text-[8px]">{s.indicator(c.key)}</span> : null}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map(([name, m]) => {
                const isMarket = m.kind?.includes('market');
                const pct = m.delivered == null ? 0 : ((m.delivered / maxDelivered) * 100).toFixed(1);
                return (
                  <TableRow key={name} className="group/row border-border/40 transition-colors hover:bg-muted/40">
                    <TableCell className="font-mono text-xs font-medium">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isMarket ? 'bg-primary' : 'bg-teal'}`}
                        />
                        {name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={isMarket ? 'info' : 'neutral'} label={m.kind ?? DASH} />
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{m.profileId || DASH}</TableCell>
                    <TableCell className="font-mono text-[11px]">{m.priority || DASH}</TableCell>
                    <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                      {fmtSeconds(m.minIntervalS)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] tabular-nums">
                      {fmtNum(m.subscribers)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
                          <span
                            className={`block h-full rounded-full ${isMarket ? 'bg-primary' : 'bg-teal'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className="w-14 text-right font-mono text-[11px] tabular-nums">
                          {fmtCompact(m.delivered)}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          icon={Activity}
          title="No channels match"
          description="Adjust the filter or clear the search to see all channels reported by the gateway."
        />
      )}
    </SectionCard>
  );
}

// ===========================================================================
// EVENT STREAM
// ===========================================================================

function EventStream({
  events,
  expanded,
  now,
}: {
  events: import('./cm-shared').CmEvent[];
  expanded: boolean;
  now: number;
}) {
  const shown = expanded ? events : events.slice(0, 8);
  return (
    <div className="space-y-1.5">
      {shown.map((e, i) => (
        <div
          key={`${e.seq}-${e.epoch}`}
          className="group flex items-center gap-3 rounded-lg border border-border/40 bg-background/30 px-3 py-1.5 transition-colors hover:border-border hover:bg-muted/30"
          style={{ animation: 'cm-rise 0.4s ease-out both', animationDelay: `${Math.min(i * 24, 240)}ms` }}
        >
          <span className="w-16 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {fmtClock(e.epoch)}
          </span>
          <span className="w-14 shrink-0">
            <StatusBadge status={levelTone(e.level)} label={(e.level || '?').slice(0, 4)} />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={e.eventType}>
            {e.eventType || DASH}
          </span>
          <span className="hidden min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground sm:block" title={e.detail}>
            {e.detail || DASH}
          </span>
          <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground md:block">
            {e.channel || DASH}
          </span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {e.epoch ? fmtAgo(e.epoch, now) : DASH}
          </span>
        </div>
      ))}
    </div>
  );
}

// ===========================================================================
// SMALL PARTS
// ===========================================================================

function TransportCard({ name, entry }: { name: string; entry: CmArchitectureEntry }) {
  const isGateway = GATEWAY_IDS.includes(name);
  const connected = entry.connected;
  return (
    <div
      className={`rounded-lg border px-3 py-2 transition-colors ${
        isGateway ? 'border-primary/40 bg-primary/[0.07]' : 'border-border/60 bg-background/40'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold">{name}</span>
        <div className="flex gap-1">
          {connected === undefined ? null : (
            <StatusBadge status={connected ? 'success' : 'neutral'} label={connected ? 'up' : 'idle'} />
          )}
          {entry.state ? <StatusBadge status={healthTone(entry.state)} label={entry.state} /> : null}
        </div>
      </div>
      {entry.owner ? (
        <div className="mt-1 truncate text-[10px]" title={entry.owner}>
          {isGateway ? <span className="text-primary">▸ owned</span> : null}{' '}
          {entry.owner}
        </div>
      ) : null}
      <div className="truncate text-[10px] text-muted-foreground" title={entry.purpose}>
        {entry.purpose ?? DASH}
      </div>
      {entry.endpoint ? (
        <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/70">{entry.endpoint}</div>
      ) : null}
      {typeof entry.sessions === 'number' || typeof entry.framesRouted === 'number' ? (
        <div className="mt-1 flex gap-2 font-mono text-[9px] tabular-nums text-muted-foreground">
          {typeof entry.sessions === 'number' ? <span>sess {entry.sessions}</span> : null}
          {typeof entry.framesRouted === 'number' ? <span>fr {fmtCompact(entry.framesRouted)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function LifecyclePills({ lifecycle }: { lifecycle: Record<string, number> }) {
  const entries = Object.entries(lifecycle).filter(([, n]) => n > 0);
  if (!entries.length) return <span className="text-[11px] text-muted-foreground">none</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className={`inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 font-mono text-[9px] ${stateBarColor(k).replace('bg-', 'text-')}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${stateBarColor(k)}`} />
          {k} {v}
        </span>
      ))}
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// ===========================================================================
// DERIVED HELPERS
// ===========================================================================

function uptimeFrom(startedAt: number | null | undefined, now: number): number | null {
  if (startedAt == null || !Number.isFinite(startedAt)) return null;
  return Math.max(0, now - startedAt);
}

/** Maps the backend's health enumeration onto a 0-100 display score. */
function healthScore(state: string | null | undefined): number | null {
  switch ((state ?? '').toUpperCase()) {
    case 'HEALTHY':
      return 100;
    case 'DEGRADED':
      return 65;
    case 'OVERLOADED':
      return 35;
    case 'NO_DATA':
      return 45;
    case 'ERROR':
      return 10;
    case 'STOPPED':
      return 0;
    default:
      return null;
  }
}

/**
 * How much of the "fresh" budget the last tick consumed. Null when the backend
 * reported neither an age nor a threshold — no invented percentage.
 */
function freshnessPct(
  ageS: number | null | undefined,
  config: ReturnType<typeof useConnectionManagerData>['config'],
): number | null {
  const fresh = config?.freshnessThresholds?.freshMaxAgeS ?? null;
  if (ageS == null || fresh == null || fresh <= 0) return null;
  return Math.min(100, (ageS / fresh) * 100);
}

function queueTone(depth: number | null, limit: number | null | undefined): GaugeTone {
  if (depth == null) return 'neutral';
  if (!limit || limit <= 0) return 'info';
  const pct = depth / limit;
  if (pct >= 0.9) return 'danger';
  if (pct >= 0.65) return 'warning';
  return 'success';
}

function topologyNodes(architecture: Record<string, CmArchitectureEntry>): TopologyNode[] {
  return TRANSPORT_ORDER.filter((k) => architecture[k]).map((id) => {
    const e = architecture[id];
    return {
      id,
      label: id,
      owner: e.owner ?? null,
      connected: e.connected === undefined ? null : e.connected,
      state: e.state ?? null,
      sessions: e.sessions ?? null,
      endpoint: e.endpoint ?? null,
    };
  });
}