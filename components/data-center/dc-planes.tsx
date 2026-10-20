'use client';

// ---- Data Center: observability plane components (read-only) ----
//
// One component per backend plane in services/data_center_planes.py. Every
// panel follows the same three-state contract so the page can never imply a
// value it does not have:
//
//   1. loading            -> skeleton (never a placeholder number)
//   2. plane unavailable  -> the real reason, verbatim
//   3. available          -> the measured values, each labelled with its source
//
// Provenance is part of the UI, not a comment: `PlaneSource` prints the
// backend's own `source` string under the section header, and every "unknown"
// field renders N/A / NOT AVAILABLE / UNKNOWN instead of 0.

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleSlash,
  Database,
  Fingerprint,
  HardDrive,
  Info,
  Layers,
  Network,
  Search,
  Server,
  Shield,
  Timer,
  Workflow,
} from 'lucide-react';
import { SectionCard, StatCard, StatusBadge } from '@/components/design-system';
import { Skeleton } from '@/components/ui/skeleton';
import { useDataCenterStore } from '@/lib/data-center-store';
import {
  fmtBytes,
  fmtIst,
  fmtNumber,
  fmtUptime,
  type DcDatabasePlane,
  type DcDbWriterPlane,
  type DcHealthTone,
  type DcPlaneMeta,
  type DcRegistrySummary,
} from '@/lib/data-center';

// ---------------------------------------------------------------------------
// Shared plane primitives
// ---------------------------------------------------------------------------

/** Print the backend's provenance string so every value on the page is attributable. */
function PlaneSource({ meta }: { meta: DcPlaneMeta | null }) {
  if (!meta) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
      <Info className="h-3 w-3 shrink-0" />
      <span>Source:</span>
      <code className="break-all font-mono">{meta.source}</code>
      {meta.generatedAt && <span className="tabular-nums">· {fmtIst(meta.generatedAt)} IST</span>}
    </p>
  );
}

/** Uniform unavailable state: the real backend reason, never a fabricated value. */
function PlaneUnavailable({
  title,
  reason,
  meta,
}: {
  title: string;
  reason: string | null | undefined;
  meta: DcPlaneMeta | null;
}) {
  return (
    <SectionCard title={title} icon={CircleSlash}>
      <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-warning">NOT AVAILABLE</p>
          <p className="break-words text-[11px] text-muted-foreground">
            {reason || 'the backend did not report a value for this plane'}
          </p>
        </div>
      </div>
      <PlaneSource meta={meta} />
    </SectionCard>
  );
}

function PlaneSkeleton({ title, icon, rows = 3 }: { title: string; icon: React.ElementType; rows?: number }) {
  return (
    <SectionCard title={title} icon={icon}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-[86px] rounded-xl" />
        ))}
      </div>
    </SectionCard>
  );
}

function Row({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: React.ReactNode;
  tone?: DcHealthTone;
  title?: string;
}) {
  const toneClass =
    tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : tone === 'err' ? 'text-destructive' : 'text-foreground';
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-[11px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-right font-mono tabular-nums ${toneClass}`} title={title}>
        {value}
      </span>
    </div>
  );
}

function healthTone(health: string | null | undefined, state: string | null | undefined): DcHealthTone {
  const h = (health ?? '').toUpperCase();
  const s = (state ?? '').toUpperCase();
  if (h === 'HEALTHY' || s === 'RUNNING' || s === 'REGISTERED') return 'ok';
  if (h === 'DEGRADED' || s === 'DEGRADED' || s === 'IDLE' || s === 'STARTING') return 'warn';
  if (h === 'UNHEALTHY' || h === 'ERROR' || s === 'ERROR' || s === 'STOPPED' || s === 'FAILED') return 'err';
  return 'na';
}

function healthBadge(health: string | null, state: string | null) {
  const tone = healthTone(health, state);
  const label = (health || state || 'UNKNOWN').toUpperCase();
  const status = tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : tone === 'err' ? 'danger' : 'neutral';
  return <StatusBadge status={status} label={label} />;
}

function pctTone(pct: number | null | undefined): DcHealthTone {
  if (pct == null) return 'na';
  if (pct >= 90) return 'err';
  if (pct >= 75) return 'warn';
  return 'ok';
}

function latencyTone(ms: number | null | undefined): DcHealthTone {
  if (ms == null) return 'na';
  if (ms >= 600) return 'err';
  if (ms >= 250) return 'warn';
  return 'ok';
}

/** Horizontal scroller for wide tables: keeps the table inside its own box. */
function TableScroller({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="max-w-full overflow-x-auto overscroll-x-contain" role="region" aria-label={label} tabIndex={0}>
      <div className="min-w-[640px]">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plane 1 — Active database identity
// ---------------------------------------------------------------------------

function DatabaseIdentityCard({ plane }: { plane: DcDatabasePlane }) {
  const { identity, storage, pool, serverStatus } = plane;
  const ss = serverStatus.available;
  const conn = serverStatus.connections;

  return (
    <SectionCard
      title="Active Database — Live Identity"
      icon={Fingerprint}
      headerRight={
        <div className="flex items-center gap-2">
          <StatusBadge
            status={identity.connected ? 'success' : 'danger'}
            label={identity.connected ? 'CONNECTED' : 'DISCONNECTED'}
          />
          <span className="hidden text-[10px] uppercase tracking-wider text-muted-foreground sm:inline">
            {identity.sourceLabel ?? 'SOURCE UNKNOWN'}
          </span>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatCard
            icon={Database}
            title="Database"
            tone={identity.database ? 'cyan' : 'neutral'}
            value={identity.database ?? 'N/A'}
            sub={identity.connected ? 'configured' : identity.configured ? 'NOT CONNECTED' : 'NOT CONFIGURED'}
          />
          <StatCard
            icon={Server}
            title="Source"
            tone={identity.source === 'atlas' ? 'purple' : identity.source === 'local' ? 'blue' : 'neutral'}
            value={(identity.source ?? 'unknown').toUpperCase()}
            sub={identity.source === 'atlas' ? 'managed cluster' : identity.source === 'local' ? 'self-hosted' : 'NOT REPORTED'}
          />
          <StatCard
            icon={HardDrive}
            title="DB Storage"
            tone="teal"
            value={fmtBytes(storage?.totalStorageBytes ?? null)}
            sub={`${fmtBytes(storage?.totalIndexSizeBytes ?? null)} index`}
          />
          <StatCard
            icon={Timer}
            title="Ping"
            tone={latencyTone(storage?.pingMs ?? null) === 'ok' ? 'success' : latencyTone(storage?.pingMs ?? null) === 'err' ? 'danger' : 'neutral'}
            value={storage?.pingMs != null ? `${storage.pingMs.toFixed(1)}ms` : 'N/A'}
            sub={`server ${identity.serverVersion ?? 'N/A'}`}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Fingerprint className="h-3 w-3" />Connection
            </p>
            <Row label="Cluster host" value={identity.host ?? 'NOT AVAILABLE'} title={identity.host ?? undefined} />
            <Row label="Database" value={identity.database ?? 'N/A'} />
            <Row label="Server version" value={identity.serverVersion ?? 'N/A'} />
            <Row label="Connected at" value={identity.connectedAt ? fmtIst(identity.connectedAt) : 'N/A'} />
            <Row label="Uptime" value={fmtUptime(serverStatus.uptimeSeconds)} />
            {identity.error && (
              <p className="mt-1 break-words text-[10px] text-destructive">{identity.error}</p>
            )}
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Host is credential-free (userinfo stripped server-side). No URI, user, password or token is ever exposed.
            </p>
          </div>

          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Network className="h-3 w-3" />Connections
            </p>
            {ss ? (
              <>
                <Row label="Current" value={fmtNumber(conn?.current ?? null)} tone={pctTone(connectionUsePct(conn))} />
                <Row label="Available" value={fmtNumber(conn?.available ?? null)} />
                <Row label="Total created" value={fmtNumber(conn?.totalCreated ?? null)} />
                <Row
                  label="In use"
                  value={
                    connectionUsePct(conn) != null
                      ? `${connectionUsePct(conn)!.toFixed(1)}%`
                      : 'N/A'
                  }
                  tone={pctTone(connectionUsePct(conn))}
                />
                <Row label="Global lock queue" value={fmtNumber(serverStatus.globalLock?.currentQueue ?? null)} />
                <Row label="Clients waiting" value={fmtNumber(serverStatus.globalLock?.clientsWaiting ?? null)} />
              </>
            ) : (
              <p className="py-1 text-[11px] text-warning">
                NOT AVAILABLE — {serverStatus.error ?? 'serverStatus not readable on this deployment'}
              </p>
            )}
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Pool counters come from the driver's own connection pool listeners.
            </p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              {(['created', 'ready', 'closed', 'cleared', 'checkout_failed'] as const).map((k) => (
                <span key={k} className="tabular-nums">
                  {k.replace('_', ' ')}: <span className="font-mono">{fmtNumber(pool[k] ?? null)}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Boxes className="h-3 w-3" />Storage
            </p>
            {storage ? (
              <>
                <Row label="Objects" value={fmtNumber(storage.totalObjects)} />
                <Row label="Data size" value={fmtBytes(storage.totalSizeBytes)} />
                <Row label="Storage size" value={fmtBytes(storage.totalStorageBytes)} />
                <Row label="Index size" value={fmtBytes(storage.totalIndexSizeBytes)} />
                <Row label="Collections" value={fmtNumber(storage.collectionsCount)} />
                <Row label="Indexes" value={fmtNumber(storage.indexesCount)} />
                <Row label="Stats updated" value={storage.lastUpdatedAt ? fmtIst(storage.lastUpdatedAt) : 'N/A'} />
              </>
            ) : (
              <p className="py-1 text-[11px] text-warning">
                NOT AVAILABLE — {plane.storageError ?? 'collection statistics unavailable'}
              </p>
            )}
          </div>
        </div>

        {ss && serverStatus.network && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            <Network className="h-3 w-3 shrink-0" />
            <span>Server network in: <span className="font-mono tabular-nums">{fmtBytes(serverStatus.network.bytesIn ?? null)}</span></span>
            <span>out: <span className="font-mono tabular-nums">{fmtBytes(serverStatus.network.bytesOut ?? null)}</span></span>
            <span>requests: <span className="font-mono tabular-nums">{fmtNumber(serverStatus.network.numRequests ?? null)}</span></span>
          </p>
        )}
      </div>
      <PlaneSource meta={plane} />
    </SectionCard>
  );
}

function connectionUsePct(conn: Record<string, number> | undefined): number | null {
  const current = conn?.current;
  const available = conn?.available;
  if (current == null || available == null) return null;
  const total = current + available;
  if (total <= 0) return null;
  return (current / total) * 100;
}

export function DatabaseIdentityPanel() {
  const { database, databaseError } = useDataCenterStore();
  if (!database) {
    return databaseError ? (
      <PlaneUnavailable title="Active Database — Live Identity" reason={databaseError} meta={null} />
    ) : (
      <PlaneSkeleton title="Active Database — Live Identity" icon={Fingerprint} />
    );
  }
  if (!database.available) {
    return (
      <PlaneUnavailable
        title="Active Database — Live Identity"
        reason={database.error ?? database.identity.error ?? 'MongoDB is not connected'}
        meta={database}
      />
    );
  }
  return <DatabaseIdentityCard plane={database} />;
}

// ---------------------------------------------------------------------------
// Plane 2 — Engine ownership
// ---------------------------------------------------------------------------

function RegistrySummaryStrip({ summary }: { summary: DcRegistrySummary | null }) {
  if (!summary) return null;
  const states = Object.entries(summary.states);
  const healths = Object.entries(summary.healths);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <StatusBadge
        status={
          summary.overall === 'HEALTHY' ? 'success' : summary.overall === 'DEGRADED' ? 'warning' : summary.overall === 'ERROR' ? 'danger' : 'neutral'
        }
        label={`REGISTRY ${(summary.overall ?? 'UNKNOWN').toUpperCase()}`}
      />
      <span className="text-[10px] text-muted-foreground">{fmtNumber(summary.total)} engines registered</span>
      {states.map(([k, v]) => (
        <span key={`s-${k}`} className="rounded border border-border px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {k} <span className="font-mono text-foreground">{v}</span>
        </span>
      ))}
      {healths.map(([k, v]) => (
        <span key={`h-${k}`} className="rounded border border-border px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {k} <span className="font-mono text-foreground">{v}</span>
        </span>
      ))}
    </div>
  );
}

export function EngineOwnershipPanel() {
  const { engines, enginesError } = useDataCenterStore();
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const list = engines?.documented ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((e) =>
      `${e.engineId} ${e.engineName ?? ''} ${e.owner} ${e.category ?? ''} ${e.state ?? ''} ${e.health ?? ''}`
        .toLowerCase()
        .includes(needle),
    );
  }, [engines, q]);

  if (!engines) {
    return enginesError ? (
      <PlaneUnavailable title="Engine Ownership — Documented Set" reason={enginesError} meta={null} />
    ) : (
      <PlaneSkeleton title="Engine Ownership — Documented Set" icon={Layers} />
    );
  }
  if (!engines.available) {
    return (
      <PlaneUnavailable
        title="Engine Ownership — Documented Set"
        reason={engines.error ?? 'the engine registry is not reachable'}
        meta={engines}
      />
    );
  }

  return (
    <SectionCard
      title={`Engine Ownership — Documented Set (${rows.length}/${engines.documented.length})`}
      icon={Layers}
      headerRight={
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search engines…"
            aria-label="Search documented engines"
            className="h-8 w-40 rounded-lg border border-border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/50 sm:w-56"
          />
        </div>
      }
    >
      <RegistrySummaryStrip summary={engines.summary} />

      {rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">No engines match “{q}”.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((e) => {
            const tone = healthTone(e.health, e.state);
            return (
              <div
                key={e.engineId}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card/40 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold">{e.engineName ?? e.engineId}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{e.engineId}</p>
                  </div>
                  {healthBadge(e.health, e.state)}
                </div>
                <div className="min-w-0 space-y-0.5 text-[10px]">
                  <p className="truncate text-muted-foreground">
                    <span className="text-foreground">Owner:</span> {e.owner}
                  </p>
                  <p className="truncate text-muted-foreground" title={e.plane}>
                    <span className="text-foreground">Plane:</span> {e.plane}
                  </p>
                  <p className="truncate text-muted-foreground">
                    <span className="text-foreground">Deps:</span>{' '}
                    {e.dependencies.length ? e.dependencies.join(', ') : 'none'}
                  </p>
                  <p className="truncate text-muted-foreground">
                    <span className="text-foreground">Uptime:</span> {fmtUptime(e.uptimeSeconds)}
                    {e.lastHeartbeat ? ` · hb ${fmtIst(e.lastHeartbeat)}` : ''}
                  </p>
                </div>
                {!e.documented && (
                  <span className="self-start">
                    <StatusBadge status="warning" label="UNDOCUMENTED ENGINE" />
                  </span>
                )}
                {!e.registered && (
                  <span className="self-start">
                    <StatusBadge status="neutral" label="NOT REGISTERED" />
                  </span>
                )}
                {e.healthReason && (
                  <p className="break-words text-[10px] text-warning" title={e.healthReason}>
                    {e.healthReason}
                  </p>
                )}
                <span className="sr-only">{tone}</span>
              </div>
            );
          })}
        </div>
      )}

      <PlaneSource meta={engines} />
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Plane 3 — Engine topology
// ---------------------------------------------------------------------------

export function EngineTopologyPanel() {
  const { topology, topologyError } = useDataCenterStore();

  if (!topology) {
    return topologyError ? (
      <PlaneUnavailable title="Engine Topology — Dependency Graph" reason={topologyError} meta={null} />
    ) : (
      <PlaneSkeleton title="Engine Topology — Dependency Graph" icon={Workflow} />
    );
  }
  if (!topology.available) {
    return (
      <PlaneUnavailable
        title="Engine Topology — Dependency Graph"
        reason={topology.error ?? 'the engine registry dependency graph is not readable'}
        meta={topology}
      />
    );
  }

  return (
    <SectionCard
      title="Engine Topology — Dependency Graph"
      icon={Workflow}
      headerRight={
        <div className="flex items-center gap-1.5">
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {topology.nodeCount} nodes
          </span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {topology.edgeCount} edges
          </span>
        </div>
      }
    >
      <RegistrySummaryStrip summary={topology.summary} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Layers className="h-3 w-3" />Nodes
          </p>
          <TableScroller label="Engine topology nodes">
            <table className="w-full text-left text-[11px]">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="py-1.5 pr-2 font-medium">Engine</th>
                  <th className="py-1.5 pr-2 font-medium">Owner</th>
                  <th className="py-1.5 pr-2 font-medium">In</th>
                  <th className="py-1.5 pr-2 font-medium">Out</th>
                  <th className="py-1.5 font-medium">Health</th>
                </tr>
              </thead>
              <tbody>
                {topology.nodes.map((n) => (
                  <tr key={n.id} className="border-b border-border/30 last:border-0">
                    <td className="py-1.5 pr-2">
                      <span className="font-mono">{n.id}</span>
                      {!n.documented && (
                        <span className="ml-1 text-[9px] uppercase text-warning">undoc</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{n.owner}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">{n.dependentCount}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">{n.dependencyCount}</td>
                    <td className="py-1.5">{healthBadge(n.health, n.state)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </div>

        <div className="min-w-0">
          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Network className="h-3 w-3" />Dependencies
          </p>
          {topology.edges.length === 0 ? (
            <p className="py-4 text-[11px] text-muted-foreground">
              No dependency edges are declared between the registered engines.
            </p>
          ) : (
            <TableScroller label="Engine dependency edges">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="py-1.5 pr-2 font-medium">Dependent</th>
                    <th className="py-1.5 pr-2 font-medium">Requires</th>
                    <th className="py-1.5 font-medium">Required state</th>
                  </tr>
                </thead>
                <tbody>
                  {topology.edges.map((e, i) => (
                    <tr key={`${e.to}-${e.from}-${i}`} className="border-b border-border/30 last:border-0">
                      <td className="py-1.5 pr-2 font-mono">{e.to}</td>
                      <td className="py-1.5 pr-2 font-mono">{e.from}</td>
                      <td className="py-1.5">
                        <span
                          className={
                            e.fromHealth === 'HEALTHY'
                              ? 'text-success'
                              : e.fromHealth === 'UNKNOWN' || e.fromHealth === 'NOT_REGISTERED'
                                ? 'text-muted-foreground'
                                : 'text-warning'
                          }
                        >
                          {e.fromHealth ?? 'UNKNOWN'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          )}
          {topology.orphans.length > 0 && (
            <p className="mt-2 break-words text-[10px] text-muted-foreground">
              <span className="text-foreground">Isolated (no declared edges):</span>{' '}
              {topology.orphans.join(', ')}
            </p>
          )}
        </div>
      </div>

      <PlaneSource meta={topology} />
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Plane 4 — DB Writer authoritative pipeline
// ---------------------------------------------------------------------------

function DbWriterCard({ plane }: { plane: DcDbWriterPlane }) {
  const pipe = (plane.pipeline ?? {}) as Record<string, any>;
  const loss = (plane.dataLoss ?? {}) as Record<string, any>;
  const recon = (loss.reconciliation ?? {}) as Record<string, any>;
  const latency = (plane.pipelineLatency ?? {}) as Record<string, any>;
  const marketWatch = (plane.marketWatch ?? {}) as Record<string, any>;

  return (
    <SectionCard
      title="DB Writer — Authoritative Tick Pipeline"
      icon={Shield}
      headerRight={
        <div className="flex items-center gap-2">
          <StatusBadge status="info" label="AUTHORITATIVE WRITER" />
          {healthBadge(plane.health, plane.state)}
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatCard
            icon={CheckCircle2}
            title="Ticks written"
            tone="success"
            value={fmtNumber(pipe.totalWritten ?? null)}
            sub={`${fmtNumber(pipe.writesPerSecond ?? null)} writes/s`}
          />
          <StatCard
            icon={Timer}
            title="Buffer depth"
            tone={(pipe.bufferLength ?? 0) > 5000 ? 'warning' : 'neutral'}
            value={fmtNumber(pipe.bufferLength ?? null)}
            sub={pipe.pipelineRunning === true ? 'pipeline running' : pipe.pipelineRunning === false ? 'pipeline idle' : 'pipeline N/A'}
          />
          <StatCard
            icon={AlertTriangle}
            title="Write errors"
            tone={(pipe.totalWriteErrors ?? 0) > 0 ? 'danger' : 'success'}
            value={fmtNumber(pipe.totalWriteErrors ?? null)}
            sub={pipe.lastError ? String(pipe.lastError).slice(0, 60) : 'no last error'}
          />
          <StatCard
            icon={Timer}
            title="Feed latency"
            tone={latencyTone(pipe.feedLatencyMs ?? null) === 'ok' ? 'success' : latencyTone(pipe.feedLatencyMs ?? null) === 'err' ? 'danger' : 'neutral'}
            value={pipe.feedLatencyMs != null ? `${Number(pipe.feedLatencyMs).toFixed(0)}ms` : 'N/A'}
            sub={`${fmtNumber(pipe.activeTickStocks ?? null)} stocks`}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Shield className="h-3 w-3" />Data-loss reconciliation
            </p>
            {plane.dataLoss ? (
              <>
                <Row label="Received" value={fmtNumber(loss.received ?? null)} />
                <Row label="Duplicates" value={fmtNumber(loss.duplicates ?? null)} />
                <Row label="Invalid" value={fmtNumber(loss.invalid ?? null)} />
                <Row label="Accepted" value={fmtNumber(loss.accepted ?? null)} />
                <Row label="Written" value={fmtNumber(loss.written ?? null)} />
                <Row label="Write failed" value={fmtNumber(loss.writeFailed ?? null)} tone={(loss.writeFailed ?? 0) > 0 ? 'err' : undefined} />
                <Row label="Pending" value={fmtNumber(loss.pending ?? null)} />
                <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                  <StatusBadge
                    status={recon.receivedEqualsSum ? 'success' : 'danger'}
                    label={`RECEIVED = DUP + INV + ACC: ${recon.receivedEqualsSum ? 'HOLDS' : 'BROKEN'}`}
                  />
                  <StatusBadge
                    status={recon.acceptedEqualsSum ? 'success' : 'danger'}
                    label={`ACCEPTED = WRITTEN + FAILED + PENDING: ${recon.acceptedEqualsSum ? 'HOLDS' : 'BROKEN'}`}
                  />
                </p>
              </>
            ) : (
              <p className="py-1 text-[11px] text-warning">
                NOT AVAILABLE — DB Writer did not report its reconciliation counters
              </p>
            )}
          </div>

          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Server className="h-3 w-3" />Pipeline timings
            </p>
            <Row label="Pipeline started" value={pipe.pipelineStartedAt ? fmtIst(pipe.pipelineStartedAt) : 'N/A'} />
            <Row label="Last write" value={pipe.lastWriteAt ? fmtIst(pipe.lastWriteAt) : 'N/A'} />
            <Row label="Last flush" value={pipe.lastFlushAt ? fmtIst(pipe.lastFlushAt) : 'N/A'} />
            <Row
              label="Flush duration"
              value={pipe.lastFlushDurationMs != null ? `${Number(pipe.lastFlushDurationMs).toFixed(0)}ms` : 'N/A'}
              tone={latencyTone(pipe.lastFlushDurationMs ?? null)}
            />
            <Row label="Ticks received" value={fmtNumber(pipe.totalReceived ?? null)} />
            <Row label="Ticks/s" value={pipe.ticksPerSecond != null ? Number(pipe.ticksPerSecond).toFixed(2) : 'N/A'} />
            {plane.audit ? (
              <Row
                label="Audit queue"
                value={fmtNumber((plane.audit as Record<string, any>).queueSize ?? null)}
              />
            ) : null}
            {Object.keys(latency).length > 0 && (
              <p className="mt-1 break-words text-[10px] text-muted-foreground">
                Pipeline latency: {JSON.stringify(latency).slice(0, 160)}
              </p>
            )}
          </div>

          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Workflow className="h-3 w-3" />Market Watch buffer
            </p>
            {plane.marketWatch ? (
              <>
                <Row label="Buffered docs" value={fmtNumber(marketWatch.bufferLength ?? marketWatch.buffered ?? null)} />
                <Row label="Total written" value={fmtNumber(marketWatch.totalWritten ?? null)} />
                <Row label="Write errors" value={fmtNumber(marketWatch.writeErrors ?? null)} />
                <Row label="Last flush" value={marketWatch.lastFlushAt ? fmtIst(marketWatch.lastFlushAt) : 'N/A'} />
              </>
            ) : (
              <p className="py-1 text-[11px] text-warning">NOT AVAILABLE — market watch buffer stats unavailable</p>
            )}
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              DB Writer is the only writer of tick documents. The Data Center reads these counters; it never
              recomputes or overrides them.
            </p>
          </div>
        </div>

        <div className="min-w-0">
          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Shield className="h-3 w-3" />Tick persistence permissions
          </p>
          {plane.permissions.length === 0 ? (
            <p className="py-2 text-[11px] text-warning">NOT AVAILABLE — no permission settings reported</p>
          ) : (
            <TableScroller label="DB Writer tick persistence permissions">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="py-1.5 pr-2 font-medium">Permission</th>
                    <th className="py-1.5 pr-2 font-medium">Collection</th>
                    <th className="py-1.5 pr-2 font-medium">State</th>
                    <th className="py-1.5 font-medium">Storage cap</th>
                  </tr>
                </thead>
                <tbody>
                  {plane.permissions.map((p) => (
                    <tr key={p.key} className="border-b border-border/30 last:border-0">
                      <td className="py-1.5 pr-2">{p.label}</td>
                      <td className="py-1.5 pr-2 font-mono text-[10px] text-muted-foreground">{p.collection}</td>
                      <td className="py-1.5 pr-2">
                        <StatusBadge status={p.enabled ? 'success' : 'neutral'} label={p.enabled ? 'ENABLED' : 'DISABLED'} />
                      </td>
                      <td className="py-1.5">
                        <StatusBadge
                          status={p.hardCapped ? 'danger' : p.storageCap ? 'warning' : 'neutral'}
                          label={p.hardCapped ? 'HARD CAPPED' : p.storageCap ? 'CAPPED' : 'UNCAPPED'}
                        />
                        {p.capReason && (
                          <p className="mt-0.5 break-words text-[10px] text-muted-foreground">{p.capReason}</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          )}
          {plane.capReason && !plane.permissions.some((p) => p.capReason) && (
            <p className="mt-1 break-words text-[10px] text-muted-foreground">Cap reason: {plane.capReason}</p>
          )}
        </div>
      </div>
      <PlaneSource meta={plane} />
    </SectionCard>
  );
}

export function DbWriterPipelinePanel() {
  const { dbWriter, dbWriterError } = useDataCenterStore();
  if (!dbWriter) {
    return dbWriterError ? (
      <PlaneUnavailable title="DB Writer — Authoritative Tick Pipeline" reason={dbWriterError} meta={null} />
    ) : (
      <PlaneSkeleton title="DB Writer — Authoritative Tick Pipeline" icon={Shield} />
    );
  }
  if (!dbWriter.available) {
    return (
      <PlaneUnavailable
        title="DB Writer — Authoritative Tick Pipeline"
        reason={dbWriter.error ?? 'DB Writer did not report a status snapshot'}
        meta={dbWriter}
      />
    );
  }
  return <DbWriterCard plane={dbWriter} />;
}

// ---------------------------------------------------------------------------
// Plane 5 — Collection ownership
// ---------------------------------------------------------------------------

export function CollectionOwnershipPanel() {
  const { ownership, ownershipError } = useDataCenterStore();
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const list = ownership?.collections ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((c) =>
      `${c.name} ${c.owner} ${c.module ?? ''} ${c.retention}`.toLowerCase().includes(needle),
    );
  }, [ownership, q]);

  if (!ownership) {
    return ownershipError ? (
      <PlaneUnavailable title="Collection Ownership — Who Writes What" reason={ownershipError} meta={null} />
    ) : (
      <PlaneSkeleton title="Collection Ownership — Who Writes What" icon={Database} />
    );
  }
  if (!ownership.available) {
    return (
      <PlaneUnavailable
        title="Collection Ownership — Who Writes What"
        reason={ownership.error ?? 'the live collection inventory is unavailable'}
        meta={ownership}
      />
    );
  }

  return (
    <SectionCard
      title={`Collection Ownership — Who Writes What (${rows.length}/${ownership.count})`}
      icon={Database}
      headerRight={
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search collections or owners…"
            aria-label="Search collections or owners"
            className="h-8 w-40 rounded-lg border border-border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/50 sm:w-64"
          />
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <StatusBadge status="info" label={`${ownership.liveCount} LIVE`} />
        <StatusBadge
          status={ownership.undocumented.length === 0 ? 'success' : 'warning'}
          label={`${ownership.undocumented.length} UNMAPPED`}
        />
        <span className="tabular-nums">{fmtBytes(ownership.totalStorageBytes)} total storage</span>
      </div>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">No collections match “{q}”.</p>
      ) : (
        <TableScroller label="Collection ownership table">
          <table className="w-full text-left text-[11px]">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="py-1.5 pr-2 font-medium">Collection</th>
                <th className="py-1.5 pr-2 font-medium">Owner</th>
                <th className="py-1.5 pr-2 font-medium">Retention</th>
                <th className="py-1.5 pr-2 text-right font-medium">Docs</th>
                <th className="py-1.5 pr-2 text-right font-medium">Storage</th>
                <th className="py-1.5 pr-2 text-right font-medium">Index</th>
                <th className="py-1.5 font-medium">Last record</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.name} className="border-b border-border/30 last:border-0">
                  <td className="py-1.5 pr-2 font-mono">
                    {c.name}
                    {!c.present && (
                      <span className="ml-1 text-[9px] uppercase text-muted-foreground">absent</span>
                    )}
                    {c.capped && <span className="ml-1 text-[9px] uppercase text-info">capped</span>}
                  </td>
                  <td className="py-1.5 pr-2">
                    <span className={c.owner === 'UNMAPPED' ? 'text-warning' : ''}>{c.owner}</span>
                    {c.module && (
                      <p className="truncate font-mono text-[9px] text-muted-foreground" title={c.module}>
                        {c.module}
                      </p>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-muted-foreground">{c.retention}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNumber(c.documents)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtBytes(c.storageBytes)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtBytes(c.indexSizeBytes)}</td>
                  <td className="py-1.5 tabular-nums text-muted-foreground">{c.lastRecord ? fmtIst(c.lastRecord) : 'N/A'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}

      {ownership.undocumented.length > 0 && (
        <p className="mt-2 break-words text-[10px] text-warning">
          No documented write path found for: {ownership.undocumented.join(', ')} — owners are shown as UNMAPPED
          and are NOT VERIFIED.
        </p>
      )}

      <PlaneSource meta={ownership} />
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Plane 6 — Retention
// ---------------------------------------------------------------------------

export function RetentionPlanePanel() {
  const { retention, retentionError } = useDataCenterStore();

  if (!retention) {
    return retentionError ? (
      <PlaneUnavailable title="Retention — TTL Indexes & Cleanup" reason={retentionError} meta={null} />
    ) : (
      <PlaneSkeleton title="Retention — TTL Indexes & Cleanup" icon={Timer} />
    );
  }

  const cleanup = (retention.cleanup ?? {}) as Record<string, any>;
  const last = (cleanup.last ?? {}) as Record<string, any>;
  const snapshots = (retention.snapshots ?? {}) as Record<string, any>;

  return (
    <SectionCard
      title="Retention — TTL Indexes & Cleanup"
      icon={Timer}
      headerRight={
        <div className="flex items-center gap-1.5">
          <StatusBadge
            status={retention.available ? 'success' : 'warning'}
            label={retention.available ? `${retention.ttlIndexCount} TTL INDEXES` : 'INDEXES N/A'}
          />
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">TTL indexes</p>
            {retention.ttlIndexes.length === 0 ? (
              <p className="py-1 text-[11px] text-warning">
                NOT AVAILABLE —{' '}
                {retention.available
                  ? `no TTL index found across ${retention.scannedCollections ?? 0} scanned collections`
                  : retention.error ?? 'index scan unavailable'}
              </p>
            ) : (
              <div className="space-y-0.5">
                {retention.ttlIndexes.map((t, i) => (
                  <Row
                    key={`${t.collection}-${t.index}-${i}`}
                    label={`${t.collection} · ${t.field ?? t.index}`}
                    value={t.expireAfterSeconds != null ? fmtUptime(t.expireAfterSeconds) : 'N/A'}
                    title={`owner: ${t.owner}`}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              06:00 IST cleanup
            </p>
            <Row
              label="Enabled"
              value={cleanup.enabled == null ? 'N/A' : cleanup.enabled ? 'YES' : 'NO'}
              tone={cleanup.enabled ? 'ok' : 'warn'}
            />
            <Row label="Schedule" value={String(cleanup.schedule ?? 'N/A')} />
            <Row label="Timezone" value={String(cleanup.timezone ?? 'N/A')} />
            <Row label="Next run" value={cleanup.nextCleanup ? fmtIst(cleanup.nextCleanup) : 'N/A'} />
            <Row label="Last run" value={last.finishedAt ? fmtIst(last.finishedAt) : 'NOT RUN YET'} />
            <Row label="Last status" value={String(last.status ?? 'N/A')} />
            <Row label="Records deleted" value={fmtNumber(last.totalDeleted ?? null)} />
            <p className="mt-1.5 break-words text-[10px] text-muted-foreground">
              Source: <code className="font-mono">services/atlas_cleanup.py</code> — the same code path the
              scheduled job uses.
            </p>
          </div>

          <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Data Center snapshots
            </p>
            <Row label="Collection" value={String(snapshots.collection ?? 'N/A')} />
            <Row
              label="Capture interval"
              value={snapshots.intervalSeconds != null ? fmtUptime(Number(snapshots.intervalSeconds)) : 'N/A'}
            />
            <Row
              label="Background loop"
              value={snapshots.running == null ? 'N/A' : snapshots.running ? 'RUNNING' : 'STOPPED'}
              tone={snapshots.running ? 'ok' : 'warn'}
            />
            <Row label="Last captured" value={snapshots.lastCapturedAt ? fmtIst(snapshots.lastCapturedAt) : 'N/A'} />
            <Row
              label="Last run ok"
              value={snapshots.lastRunOk == null ? 'N/A' : snapshots.lastRunOk ? 'YES' : 'NO'}
              tone={snapshots.lastRunOk == null ? undefined : snapshots.lastRunOk ? 'ok' : 'err'}
            />
            <Row
              label="Default trend"
              value={snapshots.trendDaysDefault != null ? `${snapshots.trendDaysDefault}d` : 'N/A'}
            />
          </div>
        </div>
      </div>
      <PlaneSource meta={retention} />
    </SectionCard>
  );
}
