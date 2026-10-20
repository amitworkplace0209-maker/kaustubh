'use client';

/**
 * Connection Manager — Connections.
 *
 * docs/engines/connection-manager.md
 *   §50 DIAGNOSTICS — the ten fields this page is built around:
 *        Connection / Consumer / Instrument / Source / Fields / Status /
 *        Last Data / Delivery Rate / Queue / Errors
 *   §7 CENTRAL CONNECTION REGISTRY, §17 multiple consumers per instrument,
 *   §23 connection states, §29 failure isolation, §10 field availability,
 *   §43 security.
 *
 * WHAT THIS PAGE ANSWERS, in the operator's words: **who** connected, **when**,
 * and **why** — with proper names, not machine tokens. A row reading `UI` /
 * `ws_engine` / `WEBSOCKET` answers none of those, so every backend enum is
 * resolved to a real label plus an explanation via `cm-identity`. The raw token
 * stays visible on expand for anyone auditing against the spec.
 *
 * Field-name contract: the registry row's status field is `status` (not
 * `state`) and it also carries `lifecycleState`. Both are shown because the
 * spec separates connection status from the consumer lifecycle — an earlier
 * revision read `state`, which the backend never sends, so every badge was a
 * permanent em-dash.
 *
 * Read-only by design (spec §13/§38): the gateway control plane exposes status,
 * metadata and diagnostics only, so this page reports rather than commands. No
 * pause/resume/delete control is offered, and none is invented here.
 *
 * Derived-vs-reported: `connectedAt` is computed from the backend's own
 * `upSeconds` and is always tagged `derived`. No other value is computed.
 */

import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  Bot,
  BrainCircuit,
  CalendarClock,
  Camera,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Copy,
  Database,
  HardDriveDownload,
  Layers,
  Lightbulb,
  ListChecks,
  MonitorSmartphone,
  Radio,
  RefreshCw,
  Search,
  Waypoints,
  X,
  Zap,
  Cpu,
  BellRing,
  BarChart3,
  Inbox,
  RadioTower,
} from 'lucide-react';
import {
  EmptyState,
  ErrorState,
  SectionCard,
  StatusBadge,
} from '@/components/design-system';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DASH,
  KV,
  KVGrid,
  downloadJson,
  fmtAgo,
  fmtDateTime,
  fmtNum,
  fmtRate,
  fmtUptime,
  isAlive,
  useAutoRefresh,
  useConnectionDetail,
  useConnectionManagerData,
  useCopy,
  useNow,
  useSortState,
  type CmConnection,
} from './cm-shared';
import {
  RadialGauge,
  StateBar,
  type GaugeTone,
} from './cm-visual';
import {
  ALL_CONSUMER_TYPES,
  avatarStyle,
  consumerTypeName,
  fieldStatusName,
  fieldStatusTone,
  groupByConsumerType,
  identityOf,
  lifecycleStateName,
  purposeOf,
  timelineOf,
  type ConnectionIdentity,
  type ProperName,
} from './cm-identity';

type Filter = 'all' | 'alive' | 'dead' | 'stale' | 'anonymous' | 'errors';
type SortKey = 'name' | 'status' | 'rate' | 'queue' | 'lastData' | 'errors' | 'uptime';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'alive', label: 'Alive' },
  { key: 'dead', label: 'Terminated' },
  { key: 'stale', label: 'Stale' },
  { key: 'anonymous', label: 'Anonymous' },
  { key: 'errors', label: 'With errors' },
];

/** Icon lookup for the proper names declared in `cm-identity`. */
const ICONS: Record<string, React.ElementType> = {
  MonitorSmartphone,
  Bot,
  BrainCircuit,
  Lightbulb,
  ListChecks,
  BellRing,
  BarChart3,
  HardDriveDownload,
  Radio,
  Cpu,
  Waypoints,
  Zap,
  Camera,
};

const TONE_TEXT: Record<GaugeTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-info',
  teal: 'text-teal',
  neutral: 'text-muted-foreground',
};

const TONE_CHIP: Record<GaugeTone, string> = {
  success: 'bg-success/15 ring-success/25',
  warning: 'bg-warning/15 ring-warning/25',
  danger: 'bg-destructive/15 ring-destructive/25',
  info: 'bg-info/15 ring-info/25',
  teal: 'bg-teal/15 ring-teal/25',
  neutral: 'bg-muted/70 ring-border/50',
};

/** Border counterpart to TONE_CHIP — Tailwind cannot put opacity on `current`. */
const TONE_BORDER: Record<GaugeTone, string> = {
  success: 'border-success/30',
  warning: 'border-warning/30',
  danger: 'border-destructive/30',
  info: 'border-info/30',
  teal: 'border-teal/30',
  neutral: 'border-border/70',
};

function toneOfStatus(status: string | null | undefined): GaugeTone {
  switch ((status ?? '').toUpperCase()) {
    case 'ACTIVE':
    case 'READY':
    case 'CONNECTED':
      return 'success';
    case 'CREATED':
    case 'CONNECTING':
    case 'WAITING_FOR_SOURCE':
    case 'WAITING_FOR_INSTRUMENT':
    case 'WAITING_FOR_FEATURES':
      return 'info';
    case 'PAUSED':
    case 'DEGRADED':
    case 'RECONNECTING':
    case 'EXPIRING':
    case 'DISCONNECTING':
      return 'warning';
    case 'FAILED':
    case 'EXPIRED':
    case 'TERMINATED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export default function ConnectionManagerConnections() {
  const data = useConnectionManagerData();
  const now = useNow(1000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const detail = useConnectionDetail(expandedId);
  const { copy, copied } = useCopy();
  const auto = useAutoRefresh(data.reload, 15000);
  const sort = useSortState<SortKey>('lastData', 'desc');

  const registry = useMemo(() => data.payload?.connectionRegistry ?? [], [data.payload]);
  const staleAfterS = data.config?.staleAfterS ?? null;

  const enriched = useMemo(
    () =>
      registry.map((c) => ({
        conn: c,
        id: identityOf(c),
        tl: timelineOf(c, now),
        purpose: purposeOf(c),
        stale: staleAfterS != null && (c.lastActivityAt ?? 0) < now - staleAfterS,
        alive: isAlive(c.status),
      })),
    [registry, now, staleAfterS],
  );

  const counts = useMemo(() => {
    const alive = enriched.filter((e) => e.alive).length;
    return {
      total: enriched.length,
      alive,
      dead: enriched.length - alive,
      stale: enriched.filter((e) => e.stale).length,
      anonymous: enriched.filter((e) => !e.id.authenticated).length,
      errors: enriched.filter((e) => (c_errors(e.conn) ?? 0) > 0 || Boolean(e.conn.lastError)).length,
      messages: enriched.reduce((a, e) => a + (e.conn.messagesDelivered ?? 0), 0),
      channels: new Set(enriched.flatMap((e) => e.conn.channels ?? [])).size,
      groups: groupByConsumerType(registry, isAlive),
    };
  }, [enriched, registry]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = enriched.filter((e) => {
      if (typeFilter !== 'all' && (e.conn.consumerType ?? '').toUpperCase() !== typeFilter) return false;
      switch (filter) {
        case 'alive':
          if (!e.alive) return false;
          break;
        case 'dead':
          if (e.alive) return false;
          break;
        case 'stale':
          if (!e.stale) return false;
          break;
        case 'anonymous':
          if (e.id.authenticated) return false;
          break;
        case 'errors':
          if (!((c_errors(e.conn) ?? 0) > 0 || e.conn.lastError)) return false;
          break;
        default:
          break;
      }
      if (!q) return true;
      const hay = [
        e.id.displayName,
        e.id.principal,
        e.id.roleLabel,
        e.id.fullId,
        e.conn.connectionId,
        ...(e.conn.channels ?? []),
        ...(e.conn.profiles ?? []),
        ...(e.conn.requestedFields ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    return sort.sort(rows, {
      name: (r) => r.id.displayName,
      status: (r) => r.conn.status ?? null,
      rate: (r) => r.conn.deliveryRatePerSec ?? null,
      queue: (r) => r.conn.queueDepth ?? null,
      lastData: (r) => r.conn.lastDeliveredAt ?? null,
      errors: (r) => c_errors(r.conn) ?? null,
      uptime: (r) => r.conn.upSeconds ?? null,
    });
  }, [enriched, query, filter, typeFilter, sort]);

  const isLive = Boolean(data.connected && data.source === 'realtime');

  if (data.loading) {
    return (
      <div className="space-y-4">
        <div className="cm-shimmer h-40 rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 to-transparent" />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="cm-shimmer h-28 rounded-xl border border-border/60 bg-card/40" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ============================ HERO ============================ */}
      <ConnectionsHero
        isLive={isLive}
        source={data.source}
        updatedAt={data.updatedAt}
        now={now}
        total={counts.total}
        alive={counts.alive}
        stale={counts.stale}
        anonymous={counts.anonymous}
        withErrors={counts.errors}
        messages={counts.messages}
        channels={counts.channels}
        groups={counts.groups}
        autoEnabled={auto.enabled}
        onToggleAuto={() => auto.setEnabled((v) => !v)}
        secondsLeft={auto.secondsLeft}
        onRefresh={data.reload}
        copied={copied}
        onCopy={() => void copy(JSON.stringify(filtered.map((e) => e.conn), null, 2))}
        onExport={() =>
          downloadJson(
            `connection-registry-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
            filtered.map((e) => e.conn),
          )
        }
      />

      {data.errors.length ? <ErrorState message={data.errors.join(' · ')} onRetry={data.reload} /> : null}

      {/* ============================ FILTERS ============================ */}
      <FilterBar
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
        typeFilter={typeFilter}
        onTypeFilter={setTypeFilter}
        counts={counts}
        staleAvailable={staleAfterS != null}
        shown={filtered.length}
        total={counts.total}
      />

      {/* ============================ REGISTRY ============================ */}
      {filtered.length ? (
        <div className="space-y-3">
          {filtered.map((row, i) => (
            <ConnectionCard
              key={row.conn.connectionId}
              row={row}
              now={now}
              staleAfterS={staleAfterS}
              index={i}
              expanded={expandedId === row.conn.connectionId}
              onToggle={() =>
                setExpandedId((prev) => (prev === row.conn.connectionId ? null : row.conn.connectionId))
              }
              liveDetail={expandedId === row.conn.connectionId ? detail : null}
              onCopy={() => void copy(JSON.stringify(row.conn, null, 2))}
            />
          ))}
        </div>
      ) : counts.total ? (
        <SectionCard>
          <EmptyState
            icon={Search}
            title="No connection matches"
            description="Clear the search box or switch the state / consumer filters to see the rest of the registry."
            action={
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                  setTypeFilter('all');
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Reset filters
              </Button>
            }
          />
        </SectionCard>
      ) : (
        <SectionCard>
          <EmptyState
            icon={Waypoints}
            title="No gateway sessions"
            description="Nothing is attached to WS#3. A session registers itself automatically the moment a frontend subscribes — this page never creates one (spec §13/§31)."
          />
        </SectionCard>
      )}

      <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
        Spec §50 diagnostics are read-only here. Pause, resume and delete are control-plane operations (spec §13/§14)
        and the gateway exposes no write endpoints for them, so no such control is offered rather than faking one.
        Values marked <span className="font-mono text-foreground/70">derived</span> are computed from a reported
        value (e.g. connected-at is derived from uptime); everything else is read straight from the backend.
      </p>
    </div>
  );
}

function c_errors(c: CmConnection): number | null {
  if (c.messagesDropped == null) return null;
  return c.messagesDropped;
}

// ===========================================================================
// HERO
// ===========================================================================

function ConnectionsHero({
  isLive,
  source,
  updatedAt,
  now,
  total,
  alive,
  stale,
  anonymous,
  withErrors,
  messages,
  channels,
  groups,
  autoEnabled,
  onToggleAuto,
  secondsLeft,
  onRefresh,
  copied,
  onCopy,
  onExport,
}: {
  isLive: boolean;
  source: 'api' | 'realtime' | null;
  updatedAt: number | null;
  now: number;
  total: number;
  alive: number;
  stale: number;
  anonymous: number;
  withErrors: number;
  messages: number;
  channels: number;
  groups: ReturnType<typeof groupByConsumerType>;
  autoEnabled: boolean;
  onToggleAuto: () => void;
  secondsLeft: number;
  onRefresh: () => void;
  copied: boolean;
  onCopy: () => void;
  onExport: () => void;
}) {
  const accent = total === 0 ? 'neutral' : alive === total ? 'success' : alive > 0 ? 'warning' : 'danger';
  const wash =
    accent === 'success'
      ? 'from-success/[0.13] via-success/[0.03] to-transparent'
      : accent === 'warning'
        ? 'from-warning/[0.13] via-warning/[0.03] to-transparent'
        : accent === 'danger'
          ? 'from-destructive/[0.13] via-destructive/[0.03] to-transparent'
          : 'from-muted/50 to-transparent';
  const border =
    accent === 'success'
      ? 'border-success/30'
      : accent === 'warning'
        ? 'border-warning/35'
        : accent === 'danger'
          ? 'border-destructive/35'
          : 'border-border';

  return (
    <div
      className={`cm-sweep relative overflow-hidden rounded-2xl border ${border} bg-gradient-to-br ${wash} p-5 shadow-soft-lg`}
    >
      <div className="relative flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/30">
              <Waypoints className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-display sm:text-2xl">Connections</h1>
              <p className="text-xs text-muted-foreground">
                Who is attached to the gateway, since when, and what they asked for
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
              <span className={isLive ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-success' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'} />
              {isLive ? 'LIVE' : source === 'api' ? 'SNAPSHOT' : 'OFFLINE'}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
              <CalendarClock className="h-3 w-3" aria-hidden />
              {source === 'realtime'
                ? `updated ${fmtAgo(updatedAt ? updatedAt / 1000 : null, now)}`
                : source === 'api'
                  ? 'REST snapshot'
                  : 'no data'}
            </span>
            {withErrors > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                {withErrors} with errors
              </span>
            ) : null}
          </div>
        </div>

        {/* Counters */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          <Counter label="Total" value={total} tone="text-foreground" />
          <Counter label="Alive" value={alive} tone={alive > 0 ? 'text-success' : 'text-muted-foreground'} />
          <Counter label="Stale" value={stale} tone={stale > 0 ? 'text-warning' : 'text-muted-foreground'} />
          <Counter label="Channels" value={channels} tone="text-info" />
          <Counter label="Msgs" value={messages} tone="text-teal" />
        </div>
      </div>

      {/* Consumer-type breakdown — "who" in one glance */}
      {groups.length ? (
        <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Consumers</span>
          {groups.map((g) => (
            <span
              key={g.key}
              title={g.blurb}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] backdrop-blur"
            >
              <span className="font-mono font-semibold tabular-nums">{g.count}</span>
              <span className="text-muted-foreground">{g.label}</span>
              <span className="text-muted-foreground/60">· {g.alive} live</span>
            </span>
          ))}
          {anonymous > 0 ? (
            <span
              title="Sessions whose username resolved to 'anonymous' — either no auth header was sent or security is disabled."
              className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning"
            >
              <Inbox className="h-3 w-3" aria-hidden />
              {anonymous} anonymous
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Controls */}
      <div className="relative mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
        <Button onClick={onRefresh} size="sm" className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </Button>
        <Button variant={autoEnabled ? 'secondary' : 'outline'} size="sm" onClick={onToggleAuto} className="gap-1.5">
          {autoEnabled ? `Auto ${secondsLeft}s` : 'Auto'}
        </Button>
        <Button variant="outline" size="sm" onClick={onCopy} className="gap-1.5">
          {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy JSON'}
        </Button>
        <Button variant="outline" size="sm" onClick={onExport} className="gap-1.5">
          <ArrowDownUp className="h-3.5 w-3.5 rotate-90" aria-hidden />
          Export
        </Button>
      </div>
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex min-w-[62px] flex-col items-center rounded-xl border border-border/50 bg-background/40 px-2.5 py-1.5 backdrop-blur">
      <span className={`font-mono text-lg font-semibold leading-none tabular-nums ${tone}`}>
        {value.toLocaleString('en-IN')}
      </span>
      <span className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

// ===========================================================================
// FILTER BAR
// ===========================================================================

function FilterBar({
  query,
  onQuery,
  filter,
  onFilter,
  typeFilter,
  onTypeFilter,
  counts,
  staleAvailable,
  shown,
  total,
}: {
  query: string;
  onQuery: (v: string) => void;
  filter: Filter;
  onFilter: (v: Filter) => void;
  typeFilter: string;
  onTypeFilter: (v: string) => void;
  counts: { alive: number; dead: number; stale: number; anonymous: number; errors: number; total: number };
  staleAvailable: boolean;
  shown: number;
  total: number;
}) {
  const filterCount = (k: Filter): number | null => {
    switch (k) {
      case 'all':
        return counts.total;
      case 'alive':
        return counts.alive;
      case 'dead':
        return counts.dead;
      case 'stale':
        return staleAvailable ? counts.stale : null;
      case 'anonymous':
        return counts.anonymous;
      case 'errors':
        return counts.errors;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/50 p-2.5 backdrop-blur">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search name, consumer id, channel, profile or field…"
          aria-label="Search connections"
          className="h-8 pl-8 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border/60 p-0.5">
        {FILTERS.map((f) => {
          const n = filterCount(f.key);
          const disabled = n === null;
          return (
            <button
              key={f.key}
              onClick={() => !disabled && onFilter(f.key)}
              disabled={disabled}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                filter === f.key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
              {n != null ? <span className="ml-1 font-mono text-[9px] tabular-nums opacity-70">{n}</span> : null}
            </button>
          );
        })}
      </div>

      <select
        value={typeFilter}
        onChange={(e) => onTypeFilter(e.target.value)}
        aria-label="Consumer type filter"
        className="h-8 rounded-lg border border-border/60 bg-background px-2 text-[11px]"
      >
        <option value="all">Every consumer type</option>
        {ALL_CONSUMER_TYPES.map((t) => (
          <option key={t} value={t}>
            {consumerTypeName(t)?.label ?? t}
          </option>
        ))}
      </select>

      <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
        {shown === total ? `${total} connections` : `${shown} of ${total}`}
      </span>
    </div>
  );
}

// ===========================================================================
// CONNECTION CARD
// ===========================================================================

type Row = {
  conn: CmConnection;
  id: ConnectionIdentity;
  tl: ReturnType<typeof timelineOf>;
  purpose: ReturnType<typeof purposeOf>;
  stale: boolean;
  alive: boolean;
};

function ConnectionCard({
  row,
  now,
  staleAfterS,
  index,
  expanded,
  onToggle,
  liveDetail,
  onCopy,
}: {
  row: Row;
  now: number;
  staleAfterS: number | null;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  liveDetail: { detail: CmConnection | null; error: string | null; loading: boolean } | null;
  onCopy: () => void;
}) {
  const { conn, id, tl, purpose, stale, alive } = row;
  const tone = row.stale ? 'warning' : toneOfStatus(conn.status);
  const RoleIcon = ICONS[consumerTypeName(conn.consumerType)?.icon ?? ''] ?? Waypoints;
  const SourceIcon = ICONS[purpose.feedSource?.icon ?? ''] ?? Database;
  const DeliveryIcon = ICONS[purpose.delivery?.icon ?? ''] ?? RadioTower;

  const dropped = conn.messagesDropped ?? null;
  const queuePct =
    conn.queueDepth != null && conn.queueLimit ? Math.min(100, (conn.queueDepth / conn.queueLimit) * 100) : null;

  // The detail endpoint may return a fresher row than the registry snapshot.
  const shown = liveDetail?.detail ?? conn;
  const shownId = liveDetail?.detail ? identityOf(liveDetail.detail) : id;
  const shownPurpose = liveDetail?.detail ? purposeOf(liveDetail.detail) : purpose;

  return (
    <div
      className={`cm-rise group overflow-hidden rounded-xl border bg-card/60 shadow-soft backdrop-blur transition-all ${
        expanded ? 'border-primary/40' : 'border-border/60 hover:border-border'
      }`}
      style={{ animationDelay: `${Math.min(index * 40, 320)}ms` }}
    >
      {/* ============ HEADER — who / status / when ============ */}
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3.5 p-4 text-left transition-colors hover:bg-muted/25"
      >
        {/* Avatar — colour is stable per consumer id */}
        <span className="relative shrink-0">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-xl border font-mono text-[13px] font-bold ring-1"
            style={avatarStyle(shownId.hueSeed)}
            title={shownId.displayName}
          >
            {shownId.initials}
          </span>
          <span
            title={alive ? 'Session is alive (non-terminal status)' : 'Session is in a terminal state'}
            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card ${
              alive ? 'bg-success' : 'bg-muted-foreground/50'
            } ${alive ? 'animate-pulse' : ''}`}
          />
        </span>

        {/* Who + what + why */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold text-foreground">{shownId.displayName}</span>
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-px text-[9px] font-medium text-muted-foreground"
              title={shownId.roleBlurb}
            >
              <RoleIcon className="h-2.5 w-2.5" aria-hidden />
              {shownId.roleLabel}
            </span>
            {!shownId.authenticated ? (
              <span
                title="No authenticated principal on this session — the username resolved to 'anonymous'."
                className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-[9px] font-medium text-warning"
              >
                anonymous
              </span>
            ) : null}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="font-mono" title={shownId.fullId}>
              {shownId.shortId || DASH}
            </span>
            <span className="inline-flex items-center gap-1">
              <SourceIcon className="h-3 w-3" aria-hidden />
              {purpose.feedSource?.label ?? DASH}
            </span>
            <span className="inline-flex items-center gap-1">
              <DeliveryIcon className="h-3 w-3" aria-hidden />
              {purpose.delivery?.label ?? DASH}
            </span>
          </div>

          {/* When */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3 w-3" aria-hidden />
              connected {tl.connectedAt != null ? fmtAgo(tl.connectedAt, now).replace(' ago', ' ago') : DASH}
              {tl.connectedAtDerived ? (
                <span className="font-mono text-[8px] uppercase text-muted-foreground/60">derived</span>
              ) : null}
            </span>
            <span className="text-muted-foreground">
              up {fmtUptime(conn.upSeconds)}
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Activity className="h-3 w-3" aria-hidden />
              last data {fmtAgo(conn.lastDeliveredAt, now)}
            </span>
          </div>
        </div>

        {/* Right: status + key numbers */}
        <div className="flex shrink-0 items-center gap-4">
          <div className="hidden flex-col items-end gap-1 sm:flex">
            <div className="flex items-center gap-1">
              <StatusBadge status={tone === 'teal' ? 'info' : tone} label={conn.status || 'UNKNOWN'} />
              {stale ? <StatusBadge status="warning" label="stale" /> : null}
            </div>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {fmtRate(conn.deliveryRatePerSec)}
            </span>
            <span
              className={`font-mono text-[10px] tabular-nums ${
                (dropped ?? 0) > 0 ? 'text-warning' : 'text-muted-foreground'
              }`}
            >
              {fmtNum(dropped)} dropped
            </span>
          </div>

          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
              expanded ? 'rotate-180' : ''
            }`}
            aria-hidden
          />
        </div>
      </button>

      {/* ============ ALWAYS-VISIBLE PURPOSE STRIP (why) ============ */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/40 px-4 py-2">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Subscribed</span>
        {(shownPurpose.channels ?? []).slice(0, 6).map((ch) => (
          <span
            key={ch.name}
            title={ch.purpose ?? 'Channel purpose not described by the backend.'}
            className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]"
          >
            {ch.name}
          </span>
        ))}
        {(shownPurpose.channels?.length ?? 0) > 6 ? (
          <span className="text-[10px] text-muted-foreground">+{(shownPurpose.channels?.length ?? 0) - 6} more</span>
        ) : null}
        {shownPurpose.instruments != null ? (
          <span className="ml-1 font-mono text-[10px] text-muted-foreground">
            {shownPurpose.instruments} instruments
          </span>
        ) : null}

        {shownPurpose.fieldRollup.length ? (
          <span className="ml-auto flex items-center gap-1.5">
            {shownPurpose.fieldRollup.map((f) => (
              <span
                key={f.status}
                title={`${f.label}: ${f.count} channel${f.count === 1 ? '' : 's'}`}
                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium ring-1 ${TONE_CHIP[f.tone]} ${TONE_TEXT[f.tone]}`}
              >
                {f.label} {f.count}
              </span>
            ))}
          </span>
        ) : null}
      </div>

      {/* ============ EXPANDED DETAIL (dropdown) ============ */}
      {expanded ? (
        <div className="border-t border-border/40 bg-background/25 p-4">
          {liveDetail?.error ? (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{liveDetail.error}</span>
            </div>
          ) : null}
          {liveDetail?.loading && !liveDetail.detail ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Loading connection…
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-3">
              {/* --- Col 1: WHO --- */}
              <DetailColumn icon={MonitorSmartphone} title="Who">
                <KV label="Display name" value={shownId.displayName} mono={false} />
                <KV
                  label="Principal"
                  value={
                    <span className="inline-flex items-center gap-1">
                      {shownId.principal}
                      {!shownId.authenticated ? (
                        <span className="text-[9px] text-warning">· unauthenticated</span>
                      ) : null}
                    </span>
                  }
                />
                <KV label="Consumer type" value={<ProperChip name={consumerTypeName(conn.consumerType)} />} mono={false} />
                <KV label="Role" value={shownId.roleLabel} mono={false} />
                <KV label="Delivery" value={<ProperChip name={purpose.delivery} />} mono={false} />
                <KV label="Feed source" value={<ProperChip name={purpose.feedSource} />} mono={false} />
                <div className="mt-2 border-t border-border/40 pt-2">
                  <KV label="Connection id" value={<span className="break-all text-[9px]">{shownId.fullId || DASH}</span>} />
                  <KV label="Session id" value={<span className="break-all text-[9px]">{shown.connectionId || DASH}</span>} />
                </div>
              </DetailColumn>

              {/* --- Col 2: WHEN --- */}
              <DetailColumn icon={CalendarClock} title="When">
                <KV
                  label="Connected at"
                  value={
                    <span className="inline-flex items-center gap-1">
                      {fmtDateTime(tl.connectedAt)}
                      <span className="text-[8px] uppercase text-muted-foreground/60">derived</span>
                    </span>
                  }
                />
                <KV label="Uptime" value={fmtUptime(shown.upSeconds)} />
                <KV label="Last activity" value={fmtAgo(shown.lastActivityAt, now)} />
                <KV label="Last delivered" value={fmtAgo(shown.lastDeliveredAt, now)} />
                <KV label="Last transition" value={fmtDateTime(shown.lastTransitionAt)} />
                <div className="mt-2 border-t border-border/40 pt-2">
                  <div className="mb-2 flex items-center gap-1.5">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Timeline</span>
                  </div>
                  <ol className="relative space-y-2.5 border-l border-border/60 pl-3.5">
                    {tl.steps.map((s, i) => (
                      <li key={i} className="relative">
                        <span
                          className={`absolute -left-[17px] top-1 h-2 w-2 rounded-full ring-2 ring-background ${
                            s.tone === 'success'
                              ? 'bg-success'
                              : s.tone === 'info'
                                ? 'bg-info'
                                : s.tone === 'warning'
                                  ? 'bg-warning'
                                  : s.tone === 'danger'
                                    ? 'bg-destructive'
                                    : 'bg-muted-foreground/50'
                          }`}
                        />
                        <p className="text-[11px] font-medium text-foreground">{s.title}</p>
                        <p className="font-mono text-[9px] tabular-nums text-muted-foreground">
                          {s.at != null ? fmtDateTime(s.at) : 'time not recorded'}
                        </p>
                        <p className="mt-0.5 break-words text-[10px] leading-snug text-muted-foreground">{s.detail}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              </DetailColumn>

              {/* --- Col 3: WHY + health --- */}
              <DetailColumn icon={Layers} title="Why & health">
                <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{shownPurpose.summary}</p>
                <KVGrid cols={1}>
                  <KV label="Instruments" value={fmtNum(shownPurpose.instruments)} />
                  <KV label="Status" value={<StatusBadge status={toneOfStatus(shown.status) as never} label={shown.status || 'UNKNOWN'} />} />
                  <KV label="Lifecycle" value={<ProperChip name={lifecycleStateName(shown.lifecycleState)} />} mono={false} />
                  <KV label="Messages delivered" value={fmtNum(shown.messagesDelivered)} />
                  <KV label="Delivery rate" value={fmtRate(shown.deliveryRatePerSec)} />
                  <KV
                    label="Queue"
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        <span>
                          {fmtNum(shown.queueDepth)} / {fmtNum(shown.queueLimit)}
                        </span>
                        {queuePct != null ? (
                          <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                            <span
                              className={`block h-full rounded-full ${
                                queuePct >= 90 ? 'bg-destructive' : queuePct >= 65 ? 'bg-warning' : 'bg-success'
                              }`}
                              style={{ width: `${queuePct}%` }}
                            />
                          </span>
                        ) : null}
                      </span>
                    }
                  />
                  <KV
                    label="Dropped"
                    value={`${fmtNum(shown.messagesDropped)} (mkt ${fmtNum(shown.droppedMarket)} / crit ${fmtNum(shown.droppedCritical)})`}
                    tone={(shown.messagesDropped ?? 0) > 0 ? 'text-warning' : undefined}
                  />
                </KVGrid>

                <div className="mt-3 flex items-center gap-3 border-t border-border/40 pt-3">
                  <RadialGauge
                    value={queuePct}
                    max={100}
                    label="queue used"
                    size={104}
                    thickness={8}
                    tone={
                      queuePct == null ? 'neutral' : queuePct >= 90 ? 'danger' : queuePct >= 65 ? 'warning' : 'success'
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                      <span>Channel mix</span>
                    </div>
                    <StateBar
                      states={{
                        market: (shown.channels ?? []).filter((ch) => ch === 'trading' || ch === 'watchlist' || ch === 'market_watch' || ch === 'ai').length,
                        state: (shown.channels ?? []).filter((ch) => !['trading', 'watchlist', 'market_watch', 'ai'].includes(ch)).length,
                      }}
                      total={(shown.channels ?? []).length || 1}
                    />
                    <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                      {shownPurpose.profiles.length ? `Profiles: ${shownPurpose.profiles.join(', ')}` : 'No delivery profile requested.'}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                      {shownPurpose.fields.length
                        ? `${shownPurpose.fields.length} field${shownPurpose.fields.length === 1 ? '' : 's'} requested`
                        : 'No fields requested.'}
                    </p>
                  </div>
                </div>
              </DetailColumn>
            </div>
          )}

          {/* Fields + channels raw */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {shownPurpose.channels.length ? (
              <div>
                <div className="mb-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                  Channels & what they are for
                </div>
                <ul className="space-y-1">
                  {shownPurpose.channels.map((ch) => (
                    <li key={ch.name} className="flex items-start gap-2 rounded border border-border/50 px-2 py-1">
                      <span className="shrink-0 font-mono text-[10px] text-primary">{ch.name}</span>
                      <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
                        {ch.purpose ?? 'Purpose not described by the backend.'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <div className="mb-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                Requested fields — spec §10
              </div>
              {shown.requestedFields?.length ? (
                <div className="flex flex-wrap gap-1">
                  {shown.requestedFields.map((f) => {
                    const status = shown.fieldStatus?.[f] ?? null;
                    const p = fieldStatusName(status);
                    return (
                      <span
                        key={f}
                        title={p ? p.blurb : 'No availability reported for this field.'}
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                          status
                            ? `${TONE_TEXT[fieldStatusTone(status)]} ${TONE_BORDER[fieldStatusTone(status)]}`
                            : 'border-border/70 text-muted-foreground'
                        }`}
                      >
                        {f}
                        {status ? <span className="text-[8px] opacity-70">{p?.label ?? status}</span> : null}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground">No fields requested.</p>
              )}

              {/* Field status per channel (backend sends channel→status) */}
              {shown.fieldStatus && Object.keys(shown.fieldStatus).length ? (
                <div className="mt-2.5">
                  <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                    Channel field availability
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(shown.fieldStatus).map(([ch, st]) => {
                      const p = fieldStatusName(st);
                      return (
                        <span
                          key={ch}
                          title={p?.blurb}
                          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${TONE_CHIP[fieldStatusTone(st)]} ${TONE_TEXT[fieldStatusTone(st)]}`}
                        >
                          <span className="font-mono">{ch}</span>
                          <span className="opacity-80">{p?.label ?? st}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Reason / error */}
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-border/60 px-3 py-2">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Last transition reason
              </div>
              <div className="mt-0.5 break-words font-mono text-[11px]">
                {shown.lastReason || DASH}
              </div>
            </div>
            {shown.lastError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
                  <CircleAlert className="h-3.5 w-3.5" aria-hidden />
                  Last error
                </div>
                <div className="mt-0.5 break-words font-mono text-[11px] text-destructive">{shown.lastError}</div>
              </div>
            ) : (
              <div className="rounded-lg border border-border/60 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-success">
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  No error recorded
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                  Spec §29 requires one consumer's failure to be isolated, so an error here would not by itself imply
                  other consumers are affected.
                </p>
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-3">
            <span className="text-[10px] text-muted-foreground">
              {staleAfterS != null
                ? `Stale when idle more than ${staleAfterS}s.`
                : 'No stale threshold configured by the backend.'}
            </span>
            <Button variant="ghost" size="sm" onClick={onCopy} className="gap-1.5">
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copy this record
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ===========================================================================
// DETAIL COLUMN + PROPER-NAME CHIP
// ===========================================================================

function DetailColumn({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3">
      <div className="mb-2.5 flex items-center gap-1.5 border-b border-border/40 pb-2">
        <Icon className="h-3.5 w-3.5 text-primary" aria-hidden />
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      </div>
      {children}
    </div>
  );
}

/**
 * Renders a resolved proper name with its explanation. An unknown token is
 * shown verbatim with a warning tint so a new backend enum is visible rather
 * than silently blank.
 */
function ProperChip({ name }: { name: ProperName | null }) {
  if (!name) return <span className="text-muted-foreground">{DASH}</span>;
  return (
    <span
      title={name.blurb}
      className={`inline-flex items-center gap-1 ${
        name.known ? 'text-foreground' : 'text-warning'
      }`}
    >
      {name.label}
      {!name.known ? <span className="text-[9px] opacity-80">· unmapped</span> : null}
    </span>
  );
}