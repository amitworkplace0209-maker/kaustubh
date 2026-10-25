'use client';

/**
 * Data Center — snapshot-driven panels.
 *
 * Every value in this file comes from the ONE backend snapshot
 * (`DcSnapshot`). Nothing here computes a fact, infers a state, or substitutes a
 * default for a measurement the backend did not take. The rendering rules are:
 *
 *  - a number the backend did not report renders as an em dash, never `0`;
 *  - a section the backend could not read renders its real reason;
 *  - the three realtime surfaces are three cards, because they are three
 *    genuinely different connections;
 *  - the browser's own socket state is measured in the browser and labelled as
 *    such, so it can never be mistaken for a backend measurement.
 */
import { useEffect, useState } from 'react';
import {
  Activity, Cpu, Database, HardDrive, Radio, Server, Timer, Workflow,
} from 'lucide-react';
import { SectionCard } from '@/components/design-system';
import { StatusBadge } from '@/components/design-system';
import { realtimeClient } from '@/lib/realtime-ws';
import {
  DASH, fmtAgo, fmtBytes, fmtClock, fmtDec, fmtDuration, fmtInt,
  humanState, stateBadge, withFrontendRealtime,
} from '@/lib/data-center-snapshot';
import type {
  DcBadgeStatus, DcBrokerFeed, DcBackendRealtime, DcHealthCategory, DcHealthEntry,
  DcMeasuredFrontendRealtime, DcSnapshot,
} from '@/lib/data-center-snapshot';

// ---------------------------------------------------------------------------
// shared primitives
// ---------------------------------------------------------------------------
type BadgeStatus = DcBadgeStatus;

const TONE_TEXT: Partial<Record<BadgeStatus, string>> = {
  success: 'text-foreground',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  neutral: 'text-foreground',
};

/** A labelled number. `null` renders the em dash — never a zero. */
function Stat({
  label, value, hint, tone,
}: {
  label: string;
  value: string;
  hint?: string | null;
  tone?: BadgeStatus;
}) {
  const missing = value === DASH || value === 'UNKNOWN' || value === 'NOT CONFIGURED';
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card/40 px-2.5 py-2">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 truncate text-sm font-semibold tabular-nums ${
          missing ? 'text-muted-foreground/70' : (TONE_TEXT[tone ?? 'neutral'] ?? 'text-foreground')
        }`}
        title={value}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={hint}>{hint}</div> : null}
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1 last:border-0">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[11px] tabular-nums ${
          value === DASH ? 'text-muted-foreground/70' : 'text-foreground'
        }`}
        title={hint ? `${value} — ${hint}` : value}
      >
        {value}
      </span>
    </div>
  );
}

/** Shown in place of a section the backend could not read. */
function Unavailable({ error, source }: { error: string | null; source: string }) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
      <StatusBadge status="warning" label="NOT AVAILABLE" />
      <p className="mt-1.5 text-[11px] text-warning">
        {error ?? 'The backend did not report this section.'}
      </p>
      <p className="mt-1 break-all text-[10px] text-muted-foreground">source: {source}</p>
    </div>
  );
}

function SourceLine({ source, generatedAt, now }: { source: string; generatedAt: string | null; now: number }) {
  return (
    <p className="break-words px-0.5 text-[10px] text-muted-foreground">
      source: {source} · measured {fmtAgo(generatedAt, now)}
      {generatedAt ? ` (${fmtClock(generatedAt)})` : ''}
    </p>
  );
}

// ---------------------------------------------------------------------------
// health strip
// ---------------------------------------------------------------------------
const CATEGORY_LABELS: Record<DcHealthCategory, string> = {
  database: 'Database',
  persistence: 'Persistence',
  realtime: 'Realtime',
  session: 'Session',
  scheduler: 'Scheduler',
  marketData: 'Market data',
};

export function SnapshotHealthStrip({ snapshot, now }: { snapshot: DcSnapshot; now: number }) {
  const overall = stateBadge(snapshot.overall);
  const byCategory = new Map(snapshot.health.categories.map((c) => [c.category, c]));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">System</span>
        <StatusBadge status={overall.status} label={overall.label} />
        <span className="text-[10px] text-muted-foreground">
          {snapshot.health.available
            ? `${snapshot.health.categories.length} areas · rolled up from the engines above`
            : 'health rollup unavailable'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {(Object.keys(CATEGORY_LABELS) as DcHealthCategory[]).map((key) => {
          const entry: DcHealthEntry | undefined = byCategory.get(key);
          const badge = stateBadge(entry?.state);
          return (
            <div
              key={key}
              className="min-w-0 rounded-lg border border-border/60 bg-card/40 px-2.5 py-2"
              title={entry?.reason ?? undefined}
            >
              <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABELS[key]}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <StatusBadge status={badge.status} label={entry ? badge.label : 'UNKNOWN'} />
              </div>
              <div className="mt-1 line-clamp-2 text-[10px] leading-tight text-muted-foreground">
                {entry?.reason ?? (entry ? 'no issues reported' : 'not reported')}
              </div>
            </div>
          );
        })}
      </div>
      {snapshot.health.marketPhase ? (
        <p className="px-0.5 text-[10px] text-muted-foreground">
          Market phase: {humanState(snapshot.health.marketPhase)}
          {snapshot.health.marketStatus ? ` · ${snapshot.health.marketStatus}` : ''}
        </p>
      ) : null}
      <SourceLine source={snapshot.health.source} generatedAt={snapshot.generatedAt} now={now} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------
export function RuntimePanel({ snapshot, now }: { snapshot: DcSnapshot; now: number }) {
  const r = snapshot.runtime;
  const paper = r.isPaperTerminal === true;
  return (
    <SectionCard title="Runtime" icon={Server}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="Terminal mode"
            value={r.terminalMode ? r.terminalMode.toUpperCase() : r.available ? DASH : 'UNKNOWN'}
            hint={r.available ? 'resolved by brokers.manager' : (r.error ?? undefined)}
          />
          <Stat
            label="Session mode"
            value={r.sessionMode ? r.sessionMode.toUpperCase() : DASH}
            hint={r.sessionBroker ? `broker: ${r.sessionBroker}` : r.sessionModeError ?? undefined}
          />
          <Stat label="Process uptime" value={fmtDuration(r.process.uptimeSeconds)} />
          <Stat label="Python" value={r.process.python ?? DASH} hint={r.process.platform ?? undefined} />
        </div>
        {paper ? (
          <p className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[11px] text-info">
            This backend is configured for the <strong>paper</strong> terminal. That is a real
            configuration value reported by the broker manager, not a placeholder.
          </p>
        ) : null}
        {!r.terminalModeAvailable && r.available ? (
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            No trading terminal is configured. The backend reports no terminal mode rather than
            defaulting to one. Known terminals: {r.knownTerminals.join(', ') || 'none reported'}.
          </p>
        ) : null}
        <div>
          <Row label="Host" value={r.process.host ?? DASH} />
          <Row label="Process id" value={r.process.pid === null ? DASH : String(r.process.pid)} />
          <Row label="Process started" value={r.process.startedAt ? fmtClock(r.process.startedAt) : DASH} />
          <Row label="Page loaded" value={fmtAgo(snapshot.generatedAt, now)} />
        </div>
        <SourceLine source={r.source} generatedAt={r.generatedAt} now={now} />
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// database + storage
// ---------------------------------------------------------------------------
export function DatabasePanel({ snapshot, now }: { snapshot: DcSnapshot; now: number }) {
  const d = snapshot.database;
  const connected = d.connected === true;
  return (
    <SectionCard title="Database connection" icon={Database}>
      {d.available ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Connection"
              value={connected ? 'CONNECTED' : 'DISCONNECTED'}
              tone={connected ? 'success' : 'danger'}
              hint={connected ? (d.serverVersion ?? undefined) : (d.error ?? undefined)}
            />
            <Stat
              label="Provider"
              value={d.provider ? d.provider.toUpperCase() : DASH}
              hint={d.provider ? `derived from ${d.providerDerivedFrom}` : 'not reported'}
            />
            <Stat label="Database" value={d.database ?? DASH} />
            <Stat label="Host" value={d.host ?? DASH} />
          </div>
          <div>
            <Row label="Configured source" value={d.configuredSource ?? 'NOT CONFIGURED'} />
            <Row label="Active source" value={d.activeSource ?? DASH} />
            <Row label="Connected at" value={d.connectedAt ? fmtClock(d.connectedAt) : DASH} />
            <Row
              label="Pool"
              value={
                typeof d.pool === 'object' && d.pool !== null && 'maxPoolSize' in d.pool
                  ? `${fmtInt((d.pool as { checkedOut?: number | null }).checkedOut ?? null)} / ${fmtInt(
                      (d.pool as { maxPoolSize?: number | null }).maxPoolSize ?? null,
                    )} in use`
                  : DASH
              }
            />
          </div>
          {!connected && d.configured ? (
            <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
              Configured for <strong>{d.configuredSource ?? 'an unknown source'}</strong> but not
              connected. {d.error ?? ''}
            </p>
          ) : null}
          {!d.configured ? (
            <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              No MongoDB connection is configured in this backend. The Data Center shows the real
              state instead of an empty-looking database.
            </p>
          ) : null}
          <SourceLine source={d.source} generatedAt={d.generatedAt} now={now} />
        </div>
      ) : (
        <Unavailable error={d.error} source={d.source} />
      )}
    </SectionCard>
  );
}

export function StoragePanel({
  snapshot, now, query = '', onSelect,
}: {
  snapshot: DcSnapshot;
  now: number;
  query?: string;
  onSelect?: (name: string) => void;
}) {
  const s = snapshot.storage;
  if (!s.available) {
    return (
      <SectionCard title="Storage" icon={HardDrive}>
        <Unavailable error={s.error} source={s.source} />
      </SectionCard>
    );
  }
  const needle = query.trim().toLowerCase();
  const collections = needle
    ? s.collections.filter((c) => c.name.toLowerCase().includes(needle))
    : s.collections;
  return (
    <SectionCard title="Storage" icon={HardDrive}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Documents" value={fmtInt(s.documents)} />
          <Stat label="Collections" value={fmtInt(s.collectionsCount)} />
          <Stat label="Storage" value={fmtBytes(s.storageSizeBytes)} hint={s.dbName ?? undefined} />
          <Stat label="Indexes" value={fmtBytes(s.indexSizeBytes)} hint={`${fmtInt(s.indexesCount)} indexes`} />
          <Stat label="Data size" value={fmtBytes(s.dataSizeBytes)} />
          <Stat label="Server ping" value={s.pingMs === null ? DASH : `${fmtDec(s.pingMs, 1)} ms`} />
        </div>
        {s.collectionsAvailable && s.collections.length > 0 ? (
          <div className="overflow-x-clip">
            <p className="mb-1 text-[10px] text-muted-foreground">
              {needle
                ? `${fmtInt(collections.length)} of ${fmtInt(s.collections.length)} collections match “${query.trim()}”`
                : `${fmtInt(s.collections.length)} collections${onSelect ? ' · select one for its detail' : ''}`}
            </p>
            <table className="w-full min-w-[420px] text-[11px]">
              <thead>
                <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">Collection</th>
                  <th className="py-1 pr-2 text-right font-medium">Documents</th>
                  <th className="py-1 pr-2 text-right font-medium">Storage</th>
                  <th className="py-1 pr-2 text-right font-medium">Indexes</th>
                  <th className="py-1 text-right font-medium">Health</th>
                </tr>
              </thead>
              <tbody>
                {collections.map((c) => (
                  <tr
                    key={c.name}
                    className="border-b border-border/30 last:border-0"
                    onClick={onSelect ? () => onSelect(c.name) : undefined}
                    style={onSelect ? { cursor: 'pointer' } : undefined}
                  >
                    <td className="truncate py-1 pr-2 font-mono text-[10px]" title={c.name}>{c.name}</td>
                    <td className="py-1 pr-2 text-right tabular-nums" title={c.countIsApproximate ? 'approximate (server estimate)' : 'exact count'}>
                      {fmtInt(c.count)}
                      {c.countIsApproximate ? <span className="ml-1 text-muted-foreground">~</span> : null}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmtBytes(c.storageBytes)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmtBytes(c.indexSizeBytes)}</td>
                    <td className="py-1 text-right">
                      {c.health ? (
                        <StatusBadge
                          status={c.health.toUpperCase() === 'OK' ? 'success' : c.health.toUpperCase() === 'WARN' ? 'warning' : 'danger'}
                          label={c.health}
                        />
                      ) : (
                        <span className="text-muted-foreground">{DASH}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {collections.length === 0 ? (
              <p className="py-2 text-[11px] text-muted-foreground">
                No collection name matches this filter. {fmtInt(s.collections.length)} collections exist.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {s.collectionsAvailable
              ? 'The backend reported an empty collection inventory for this database.'
              : 'Per-collection statistics were not included in this response.'}
          </p>
        )}
        <SourceLine source={s.source} generatedAt={s.lastUpdatedAt ?? s.generatedAt} now={now} />
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// realtime — THREE separate surfaces
// ---------------------------------------------------------------------------
function BrokerFeedCard({ feed, now }: { feed: DcBrokerFeed; now: number }) {
  const up = feed.connected === true;
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card/40 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Radio className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium">Broker feed</span>
        <StatusBadge
          status={!feed.available ? 'neutral' : up ? 'success' : 'danger'}
          label={!feed.available ? 'UNKNOWN' : up ? 'CONNECTED' : 'DISCONNECTED'}
        />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        WS#1 · measured by the WebSocket engine
      </p>
      {feed.available ? (
        <div className="mt-1.5">
          <Row label="State" value={humanState(feed.state)} />
          <Row label="Lifecycle" value={humanState(feed.lifecycleState)} />
          <Row label="Feed" value={humanState(feed.feedState)} />
          <Row label="Subscriptions" value={fmtInt(feed.subscriptionCount)} />
          <Row label="Tick rate" value={feed.ticksPerSecond === null ? DASH : `${fmtDec(feed.ticksPerSecond, 2)}/s`} />
          <Row label="Last tick" value={feed.lastTickAt ? fmtAgo(feed.lastTickAt, now) : DASH} />
          <Row label="Connect attempts" value={fmtInt(feed.reconnectAttempts)} />
          <Row label="Internet" value={feed.internetOk === null ? DASH : feed.internetOk ? 'reachable' : 'unreachable'} />
          {!up && feed.disconnectReason ? (
            <p className="mt-1.5 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-[10px] text-danger">
              {feed.disconnectReason}
              {feed.disconnectReasonCode ? ` (${feed.disconnectReasonCode})` : ''}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-1.5 text-[10px] text-warning">{feed.error ?? 'not reported'}</p>
      )}
    </div>
  );
}

function BackendRealtimeCard({ rt }: { rt: DcBackendRealtime }) {
  const healthy = rt.health === 'HEALTHY' || (rt.health === null && rt.available);
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card/40 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium">Backend fan-out</span>
        <StatusBadge
          status={!rt.available ? 'neutral' : healthy ? 'success' : 'warning'}
          label={!rt.available ? 'UNKNOWN' : rt.health ?? 'UNKNOWN'}
        />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        WS#3 · backend → browser, measured by the connection manager
      </p>
      {rt.available ? (
        <div className="mt-1.5">
          <Row label="Started" value={rt.started === null ? DASH : rt.started ? 'yes' : 'no'} />
          <Row label="Clients" value={fmtInt(rt.activeConnections)} hint={rt.totalConnections === null ? undefined : `${fmtInt(rt.totalConnections)} total`} />
          <Row label="Delivered" value={fmtInt(rt.messagesDelivered)} />
          <Row label="Dropped" value={fmtInt(rt.messagesDropped)} />
          <Row label="Queue" value={rt.queueDepthMax === null ? DASH : `${fmtInt(rt.queueDepthMax)} / ${fmtInt(rt.queueLimit)}`} />
          <Row label="Feed freshness" value={humanState(rt.feedFreshness)} />
          <Row label="Last tick age" value={rt.lastTickAgeSeconds === null ? DASH : fmtDuration(rt.lastTickAgeSeconds)} />
          {rt.healthReason ? (
            <p className="mt-1.5 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] text-warning">
              {rt.healthReason}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-1.5 text-[10px] text-warning">{rt.error ?? 'not reported'}</p>
      )}
    </div>
  );
}

function FrontendRealtimeCard({ snapshot }: { snapshot: DcSnapshot }) {
  // The browser measures its own socket. The backend cannot, and says so.
  const measured = useFrontendRealtime();
  const state = measured.state;
  const up = state === 'CONNECTED';
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card/40 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Workflow className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium">This browser</span>
        <StatusBadge
          status={up ? 'success' : state === 'CONNECTING' || state === 'RECONNECTING' || state === 'AUTHENTICATING' ? 'warning' : 'danger'}
          label={state}
        />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        measured in the browser, not by the backend
      </p>
      <div className="mt-1.5">
        <Row label="State" value={humanState(state.toLowerCase())} />
        <Row label="Connection id" value={measured.connectionId ?? DASH} />
        <Row label="Last frame" value={measured.lastMessageAt ? fmtAgo(measured.lastMessageAt, Date.now()) : DASH} />
        <Row label="Failure" value={measured.failureReason ?? 'none'} />
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {snapshot.realtime.frontendRealtime.measurable
            ? 'Reported by the Data Center client.'
            : `Backend reason: ${snapshot.realtime.frontendRealtime.reason}`}
        </p>
      </div>
    </div>
  );
}

interface FrontendMeasurement {
  state: string;
  connectionId: string | null;
  lastMessageAt: string | null;
  failureReason: string | null;
}

const readFrontendMeasurement = (): FrontendMeasurement => ({
  state: realtimeClient.getState(),
  connectionId: realtimeClient.getConnectionId() || null,
  lastMessageAt: null,
  failureReason: realtimeClient.getFailureReason() || null,
});

const FRONTEND_POLL_MS = 3_000;

/**
 * Read this browser's own realtime socket state.
 *
 * Polled on a short interval because the realtime client is not a React store;
 * this is the only place the browser's own connection is read, so it cannot be
 * confused with a backend measurement.
 */
function useFrontendRealtime(intervalMs = FRONTEND_POLL_MS): FrontendMeasurement {
  const [value, setValue] = useState<FrontendMeasurement>(readFrontendMeasurement);

  useEffect(() => {
    setValue(readFrontendMeasurement());
    const timer = setInterval(() => setValue(readFrontendMeasurement()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return value;
}

export function RealtimePanel({ snapshot, now }: { snapshot: DcSnapshot; now: number }) {
  // Fold the browser measurement into the snapshot copy so every consumer of
  // this page sees the same, clearly attributed value.
  const withBrowser = withFrontendRealtime(snapshot, browserMeasurement(snapshot));
  return (
    <SectionCard title="Realtime" icon={Activity}>
      <div className="space-y-2">
        <p className="text-[10px] text-muted-foreground">
          Three independent connections. A healthy backend does not imply a live broker feed, and a
          live broker feed does not imply this browser is receiving.
        </p>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
          <BrokerFeedCard feed={withBrowser.realtime.brokerFeed} now={now} />
          <BackendRealtimeCard rt={withBrowser.realtime.backendRealtime} />
          <FrontendRealtimeCard snapshot={withBrowser} />
        </div>
        <SourceLine source={snapshot.realtime.source} generatedAt={snapshot.realtime.generatedAt} now={now} />
      </div>
    </SectionCard>
  );
}

/** Attach the browser's own socket measurement to a snapshot copy. */
function browserMeasurement(
  _snapshot: DcSnapshot,
): Omit<DcMeasuredFrontendRealtime, 'measurable' | 'measuredBy'> | null {
  const state = realtimeClient.getState();
  if (!state) return null;
  return {
    state,
    connected: state === 'CONNECTED',
    lastMessageAt: null,
    reconnectAttempts: null,
    note: 'measured in the browser',
  };
}

// ---------------------------------------------------------------------------
// session + scheduler
// ---------------------------------------------------------------------------
export function SessionPanel({ snapshot, now }: { snapshot: DcSnapshot; now: number }) {
  const s = snapshot.session;
  return (
    <SectionCard title="Session" icon={Cpu}>
      {s.available ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="State"
              value={humanState(s.state)}
              tone={s.active ? 'success' : s.expired ? 'danger' : 'neutral'}
              hint={s.active ? 'active session' : s.expired ? 'expired' : 'not logged in'}
            />
            <Stat label="Mode" value={s.mode ? s.mode.toUpperCase() : DASH} />
            <Stat label="Broker" value={s.broker ?? DASH} />
            <Stat label="Expires in" value={fmtDuration(s.remainingSeconds)} />
          </div>
          <div>
            <Row label="Lifecycle" value={humanState(s.lifecycleState)} />
            <Row label="User" value={s.userId ?? DASH} />
            <Row label="Login source" value={s.loginSource ?? DASH} />
            <Row label="Logged in" value={s.loginTime ? `${fmtClock(s.loginTime)} (${fmtAgo(s.loginTime, now)})` : DASH} />
            <Row label="Expires" value={s.expiresAt ? fmtClock(s.expiresAt) : DASH} />
            <Row label="Reconnects" value={fmtInt(s.reconnectCount)} />
          </div>
          {s.lastAuthError ? (
            <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
              Last authentication error: {s.lastAuthError}
            </p>
          ) : null}
          <SourceLine source={s.source} generatedAt={s.generatedAt} now={now} />
        </div>
      ) : (
        <Unavailable error={s.error} source={s.source} />
      )}
    </SectionCard>
  );
}

export function SchedulerPanel({ snapshot, now }: { snapshot: DcSnapshot; now: number }) {
  const sc = snapshot.scheduler;
  if (!sc.available) {
    return (
      <SectionCard title="Scheduler" icon={Timer}>
        <Unavailable error={sc.error} source={sc.source} />
      </SectionCard>
    );
  }
  const waiting = sc.state === 'WAITING_FOR_LOGIN';
  return (
    <SectionCard title="Scheduler" icon={Timer}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="State"
            value={humanState(sc.state)}
            tone={sc.running ? (waiting ? 'warning' : 'success') : 'neutral'}
            hint={sc.stateSince ? `since ${fmtClock(sc.stateSince)}` : undefined}
          />
          <Stat label="Engine" value={sc.running === null ? DASH : sc.running ? 'RUNNING' : 'STOPPED'} tone={sc.running ? 'success' : 'warning'} />
          <Stat label="Trading day" value={sc.isTradingDay === null ? DASH : sc.isTradingDay ? 'yes' : 'no'} />
          <Stat label="Session owner" value={sc.sessionOwner ? sc.sessionOwner.toUpperCase() : DASH} />
        </div>
        <div>
          <Row label="Market phase" value={humanState(sc.market.marketState)} hint={sc.market.marketStatus ?? undefined} />
          <Row label="Next phase" value={sc.nextPhase ? `${humanState(sc.nextPhase)} ${sc.nextPhaseAt ? `(${fmtAgo(sc.nextPhaseAt, now)})` : ''}` : DASH} />
          <Row label="Login window" value={sc.inLoginWindow === null ? DASH : sc.inLoginWindow ? 'open' : 'closed'} />
          <Row label="WebSocket window" value={sc.inWebSocketWindow === null ? DASH : sc.inWebSocketWindow ? 'open' : 'closed'} />
          <Row label="Tick collection" value={sc.inTickCollectionWindow === null ? DASH : sc.inTickCollectionWindow ? 'collecting' : 'idle'} />
          <Row label="Login attempts" value={fmtInt(sc.loginAttempts)} />
          <Row label="WebSocket attempts" value={fmtInt(sc.webSocketAttempts)} />
        </div>
        {waiting ? (
          <p className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[11px] text-info">
            The scheduler is running and waiting for its login window. This is a real scheduler
            state, not a failure.
          </p>
        ) : null}
        {sc.market.available ? (
          <div>
            <Row label="Market session" value={humanState(sc.market.marketSession)} />
            <Row label="Reason" value={sc.market.reasonMessage ?? sc.market.reasonCode ?? DASH} />
            <Row label="Weekend" value={sc.market.isWeekend === null ? DASH : sc.market.isWeekend ? 'yes' : 'no'} />
            <Row label="Exchange holiday" value={sc.market.isExchangeHoliday === null ? DASH : sc.market.isExchangeHoliday ? 'yes' : 'no'} />
            <Row label="Next open" value={sc.market.nextMarketOpen ? `${fmtClock(sc.market.nextMarketOpen)} (${fmtAgo(sc.market.nextMarketOpen, now)})` : DASH} />
            <Row label="Next close" value={sc.market.nextMarketClose ? `${fmtClock(sc.market.nextMarketClose)} (${fmtAgo(sc.market.nextMarketClose, now)})` : DASH} />
          </div>
        ) : (
          <p className="text-[10px] text-warning">Market phase unavailable: {sc.market.error ?? 'not reported'}</p>
        )}
        {sc.loginError ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            Login error: {sc.loginError}
          </p>
        ) : null}
        {sc.webSocketError ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            WebSocket error: {sc.webSocketError}
          </p>
        ) : null}
        <SourceLine source={sc.source} generatedAt={sc.generatedAt} now={now} />
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// persistence + market data
// ---------------------------------------------------------------------------
export function PersistencePanel({ snapshot, now }: { snapshot: DcSnapshot; now: number }) {
  const p = snapshot.persistence;
  if (!p.available) {
    return (
      <SectionCard title="Tick persistence" icon={Workflow}>
        <Unavailable error={p.error} source={p.source} />
      </SectionCard>
    );
  }
  const errors = p.writeErrors ?? 0;
  return (
    <SectionCard title="Tick persistence" icon={Workflow}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="Engine"
            value={humanState(p.state)}
            tone={p.health === 'HEALTHY' ? 'success' : p.health ? 'warning' : 'neutral'}
            hint={p.authoritative ? 'DB Writer is the only tick writer' : undefined}
          />
          <Stat label="Ticks received" value={fmtInt(p.ticksReceived)} />
          <Stat label="Ticks persisted" value={fmtInt(p.ticksPersisted)} />
          <Stat
            label="Write errors"
            value={p.writeErrors === null ? DASH : fmtInt(p.writeErrors)}
            tone={errors > 0 ? 'danger' : undefined}
            hint={errors > 0 ? (p.healthReason ?? undefined) : undefined}
          />
          <Stat label="Buffer" value={fmtInt(p.bufferLength)} />
          <Stat label="Write rate" value={p.ticksPerSecond === null ? DASH : `${fmtDec(p.ticksPerSecond, 2)}/s`} />
          <Stat label="Feed latency" value={p.feedLatencyMs === null ? DASH : `${fmtInt(p.feedLatencyMs)} ms`} />
          <Stat label="Last write" value={p.lastWriteAt ? fmtAgo(p.lastWriteAt, now) : DASH} />
        </div>
        <div>
          <Row label="Pipeline" value={p.pipelineRunning === null ? DASH : p.pipelineRunning ? 'running' : 'stopped'} />
          <Row label="Last flush" value={p.lastFlushAt ? fmtAgo(p.lastFlushAt, now) : DASH} />
          <Row label="Flush duration" value={p.lastFlushDurationMs === null ? DASH : `${fmtInt(p.lastFlushDurationMs)} ms`} />
          <Row label="Last heartbeat" value={p.lastHeartbeat ? fmtAgo(p.lastHeartbeat, now) : DASH} />
          <Row label="Version" value={p.version ?? DASH} />
        </div>
        {p.lastError ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            Last write error: {p.lastError}
          </p>
        ) : null}
        <SourceLine source={p.source} generatedAt={p.generatedAt} now={now} />
      </div>
    </SectionCard>
  );
}

export function MarketDataPanel({ snapshot, now }: { snapshot: DcSnapshot; now: number }) {
  const m = snapshot.marketData;
  if (!m.available) {
    return (
      <SectionCard title="Market data" icon={Activity}>
        <Unavailable error={m.error} source={m.source} />
      </SectionCard>
    );
  }
  return (
    <SectionCard title="Market data" icon={Activity}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="Market Watch"
            value={humanState(m.state)}
            tone={m.health === 'HEALTHY' ? 'success' : m.health ? 'warning' : 'neutral'}
            hint={m.healthReason ?? undefined}
          />
          <Stat label="Eligible symbols" value={fmtInt(m.eligibleSymbols)} />
          <Stat label="Subscribed" value={fmtInt(m.subscribedSymbols)} />
          <Stat label="Tick rate" value={m.ticksPerSecond === null ? DASH : `${fmtDec(m.ticksPerSecond, 2)}/s`} />
          <Stat label="Live" value={fmtInt(m.liveInstruments)} />
          <Stat label="Stale" value={fmtInt(m.staleInstruments)} tone={(m.staleInstruments ?? 0) > 0 ? 'warning' : undefined} />
          <Stat label="No data" value={fmtInt(m.noDataInstruments)} />
          <Stat label="Ticks tracked" value={fmtInt(m.ticks)} />
        </div>
        <div>
          <Row label="Lifecycle" value={humanState(m.lifecycleState)} />
          <Row label="Feed" value={humanState(m.feedState)} />
          <Row label="Last tick" value={m.lastTickAt ? fmtAgo(m.lastTickAt, now) : DASH} />
          <Row label="Last ranking" value={m.lastRankingAt ? fmtAgo(m.lastRankingAt, now) : DASH} />
          <Row label="Last publish" value={m.lastPublishAt ? fmtAgo(m.lastPublishAt, now) : DASH} />
          <Row label="Pending" value={fmtInt(m.pendingInstruments)} />
        </div>
        <SourceLine source={m.source} generatedAt={m.generatedAt} now={now} />
      </div>
    </SectionCard>
  );
}
