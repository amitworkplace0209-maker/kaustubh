'use client';

/**
 * SERVICES → VM Management (overview)
 *
 * Two managed hosts — VM1 (backend) and VM2 (MongoDB). Every number on this
 * page comes from a stored agent heartbeat; the page never computes a health
 * verdict on its own, and never upgrades a stale or missing feed to "healthy".
 * Auto-recovery is summarised but not triggered here — a restart is only ever
 * requested from a confirmed incident on the VM detail page.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity, AlertTriangle, Bell, CheckCircle2, ChevronRight, Clock, Cpu,
  Database, HardDrive, MemoryStick, RefreshCw, Server, ShieldCheck, WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  EmptyState, ErrorState, LoadingState, PageHeader, SectionCard, StatCard, StatusBadge,
} from '@/components/design-system';
import { useVmPolling } from '@/hooks/use-vm-polling';
import { cn } from '@/lib/utils';
import { getVmOverview } from '@/lib/vm-management-client';
import {
  agentStateLabel, agentStateTone, checkLabel, checkTone, fmtAge, fmtDateTime,
  fmtGb, fmtMb, hostNotice, hostStatusTone, openIncidentLabel,
  serviceLabel, serviceTone, sortIncidents,
  type VmCheck, type VmHostSummary, type VmThresholds, type VmTone,
} from '@/lib/vm-management';
import { TONE_TEXT, VmNumber, VmMetric, statAccent } from './shared';

const CHECK_ORDER: Array<{ key: string; label: string }> = [
  { key: 'backend_health', label: 'Backend health' },
  { key: 'mongo_tcp', label: 'MongoDB TCP' },
  { key: 'mongo_ping', label: 'MongoDB ping' },
  { key: 'backup', label: 'Backup' },
  { key: 'disk', label: 'Disk check' },
];

function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Higher-is-worse percentage tone (disk, cpu, swap). */
function highTone(value: number | null | undefined, warn: number, critical: number): VmTone {
  if (value == null || !Number.isFinite(value)) return 'neutral';
  if (value >= critical) return 'danger';
  if (value >= warn) return 'warning';
  return 'success';
}

function HostCard({
  host,
  thresholds,
  now,
}: {
  host: VmHostSummary;
  thresholds: VmThresholds;
  now: number;
}) {
  const snap = host.snapshot;
  const m = snap?.metrics ?? {};
  const incidents = sortIncidents((host.incidents ?? []).filter((i) => i.active));
  const criticalServices = host.meta.criticalServices;
  const reported = new Set((snap?.services ?? []).map((s) => s.name));
  const checks = snap?.checks ?? {};

  return (
    <SectionCard
      className="h-full"
      title={host.meta.name}
      icon={Server}
      headerRight={
        <div className="flex items-center gap-1.5">
          <StatusBadge status={agentStateTone(host.agent_state)} label={agentStateLabel(host.agent_state)} />
          <StatusBadge status={hostStatusTone(host.status)} label={host.status} />
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Database className="h-3 w-3" /> {host.meta.privateIp}
          </span>
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="h-3 w-3" /> {host.meta.subnet} subnet
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {snap ? `collected ${fmtAge(snap.collected_at, now)}` : 'no heartbeat'}
          </span>
        </div>

        <p
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-[11px]',
            host.agent_state === 'CONNECTED'
              ? 'border-border/60 bg-muted/30 text-muted-foreground'
              : 'border-warning/40 bg-warning/10 text-warning',
          )}
        >
          {hostNotice(host)}
        </p>

        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <VmNumber
            icon={Cpu}
            label="CPU"
            value={m.cpu_pct}
            suffix="%"
            tone={highTone(m.cpu_pct, thresholds.cpu_warn_pct ?? 85, thresholds.cpu_critical_pct ?? 95)}
          />
          <VmNumber
            icon={MemoryStick}
            label="RAM available"
            value={m.mem_available_pct}
            suffix="%"
            sub={fmtMb(m.mem_available_mb)}
            // Low available RAM is the bad direction.
            tone={
              m.mem_available_pct == null
                ? 'neutral'
                : m.mem_available_pct < (thresholds.ram_critical_available_pct ?? 8)
                  ? 'danger'
                  : m.mem_available_pct < (thresholds.ram_warn_available_pct ?? 15)
                    ? 'warning'
                    : 'success'
            }
          />
          <VmNumber
            icon={HardDrive}
            label="Disk used"
            value={m.disk_used_pct}
            suffix="%"
            sub={`${fmtGb(m.disk_used_gb)} / ${fmtGb(m.disk_total_gb)}`}
            tone={highTone(m.disk_used_pct, thresholds.disk_warn_pct ?? 80, thresholds.disk_critical_pct ?? 90)}
          />
          <VmMetric
            icon={Activity}
            label="Load (1m)"
            value={m.load1 == null ? 'n/a' : m.load1.toFixed(2)}
            sub={snap?.uptime_seconds != null ? `up ${Math.floor(snap.uptime_seconds / 86400)}d` : 'not reported'}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Critical services
            </p>
            <ul className="space-y-1">
              {criticalServices.map((name) => {
                const svc = (snap?.services ?? []).find((s) => s.name === name);
                const missing = !reported.has(name);
                return (
                  <li key={name} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate font-mono">{name}</span>
                    <StatusBadge
                      status={missing ? 'neutral' : serviceTone(svc)}
                      label={missing ? 'NOT REPORTED' : serviceLabel(svc)}
                    />
                  </li>
                );
              })}
            </ul>
            {snap && (snap.failed_units?.length ?? 0) > 0 ? (
              <p className="mt-1.5 text-[10px] text-warning">
                {(snap.failed_units ?? []).length} failed systemd unit(s)
              </p>
            ) : null}
          </div>

          <div>
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Checks
            </p>
            <ul className="space-y-1">
              {CHECK_ORDER.map(({ key, label }) => {
                const check: VmCheck | undefined = checks[key];
                return (
                  <li key={key} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-muted-foreground">{label}</span>
                    <StatusBadge status={checkTone(check)} label={checkLabel(key, check)} />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div>
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            Active incidents
          </p>
          {incidents.length === 0 ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <CheckCircle2 className={cn('h-3.5 w-3.5', host.agent_state === 'CONNECTED' ? 'text-success' : 'text-muted-foreground')} />
              {host.agent_state === 'CONNECTED' ? 'No active incident reported.' : 'No incident can be evaluated while the agent is silent.'}
            </p>
          ) : (
            <ul className="space-y-1">
              {incidents.slice(0, 3).map((inc) => (
                <li key={inc.id} className="flex items-start justify-between gap-2 text-[11px]">
                  <span className="truncate">{inc.title}</span>
                  <span className={cn('shrink-0 font-semibold uppercase', TONE_TEXT[inc.severity === 'critical' ? 'danger' : inc.severity === 'warning' ? 'warning' : 'info'])}>
                    {inc.severity}
                  </span>
                </li>
              ))}
              {incidents.length > 3 ? (
                <li className="text-[10px] text-muted-foreground">+{incidents.length - 3} more on the detail page</li>
              ) : null}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/50 pt-2">
          <span className="text-[10px] text-muted-foreground">
            Last seen {fmtDateTime(host.last_seen)}
          </span>
          <Button asChild size="sm" variant="ghost" className="h-7 gap-1 text-[11px]">
            <Link href={`/services/vm/${host.vm}`}>
              Open {host.vm.toUpperCase()} <ChevronRight className="h-3 w-3" />
            </Link>
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

export default function VmOverviewPage() {
  const fetchOverview = useCallback((signal: AbortSignal) => getVmOverview(signal), []);
  const { data, error, loading, refreshing, lastUpdated, refresh } = useVmPolling(fetchOverview);
  const now = useNow();

  const lastUpdatedLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
    : 'n/a';

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <PageHeader title="VM Management" subtitle="Loading host telemetry…" />
        <LoadingState text="Reading VM telemetry" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-3">
        <PageHeader title="VM Management" subtitle="VM1 backend · VM2 MongoDB" />
        <ErrorState
          message={error?.message ?? 'VM telemetry is unavailable.'}
          onRetry={refresh}
        />
        <p className="text-center text-[11px] text-muted-foreground">
          No metric is shown while the API cannot confirm it. Nothing is inferred from a failed request.
        </p>
      </div>
    );
  }

  const overallTone = hostStatusTone(data.overall);

  return (
    <div className="space-y-3">
      <PageHeader title="VM Management" subtitle="VM1 backend · VM2 MongoDB · values come only from stored agent heartbeats">
        <StatusBadge status={refreshing ? 'info' : 'neutral'} label={refreshing ? 'Refreshing…' : `Updated ${lastUpdatedLabel} IST`} />
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11px]" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} /> Refresh
        </Button>
      </PageHeader>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            The latest refresh failed ({error.message}). The values below are the last payload the API
            delivered{lastUpdated ? ` at ${lastUpdatedLabel} IST` : ''} — they are not live.
          </span>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Activity}
          title="Overall"
          value={<span className={TONE_TEXT[overallTone]}>{data.overall}</span>}
          sub={openIncidentLabel({ critical: data.open_incidents.critical, warning: data.open_incidents.warning })}
          tone={statAccent(overallTone)}
        />
        <StatCard
          icon={WifiOff}
          title="Agents connected"
          value={`${data.connected_agents} / ${data.total_agents}`}
          sub={data.connected_agents < data.total_agents ? 'A silent agent cannot report its own outage' : 'Both agents report within the freshness window'}
          tone={data.connected_agents === data.total_agents ? 'success' : 'warning'}
        />
        <StatCard
          icon={Bell}
          title="Open critical"
          value={data.open_incidents.critical}
          sub={`${data.open_incidents.total} open incident${data.open_incidents.total === 1 ? '' : 's'} in total`}
          tone={data.open_incidents.critical > 0 ? 'danger' : 'neutral'}
        />
        <StatCard
          icon={Clock}
          title="Pending actions"
          value={data.pending_actions.length}
          sub={data.pending_actions.length > 0 ? 'Queued restarts wait for the agent heartbeat' : 'No restart queued'}
          tone={data.pending_actions.length > 0 ? 'warning' : 'neutral'}
        />
      </div>

      {data.hosts.length === 0 ? (
        <SectionCard title="Managed hosts" icon={Server}>
          <EmptyState
            icon={Server}
            title="No hosts configured"
            description="The backend defines VM1 and VM2; an empty list means the API is misconfigured."
          />
        </SectionCard>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.hosts.map((host) => (
            <HostCard key={host.vm} host={host} thresholds={data.thresholds} now={now} />
          ))}
        </div>
      )}

      <SectionCard title="Monitoring & recovery" icon={ShieldCheck}>
        <div className="grid gap-3 text-[11px] text-muted-foreground sm:grid-cols-2">
          <div className="space-y-1">
            <p className="font-semibold text-foreground">Staleness windows</p>
            <p>
              A heartbeat older than {data.thresholds.stale_seconds ?? 'n/a'}s renders STALE; older than{' '}
              {data.thresholds.disconnected_seconds ?? 'n/a'}s renders DISCONNECTED. The UI never
              re-dates a snapshot.
            </p>
            <p className="flex items-center gap-1">
              <Database className="h-3 w-3" /> Telemetry store: MongoDB (read-through API, no client cache).
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-foreground">Automatic recovery</p>
            <p>
              Configured server-side. Restarts are limited to allowlisted systemd units and only after
              a confirmed, consecutively-observed service failure. A VM is never rebooted automatically.
            </p>
            <p>
              Manual acknowledgement, resolution and restart requests live on each VM&apos;s detail page
              and require the operator credential.
            </p>
          </div>
        </div>
        {data.pending_actions.length > 0 ? (
          <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-warning">Queued restarts</p>
            <ul className="mt-1 space-y-0.5 text-[11px]">
              {data.pending_actions.map((action) => (
                <li key={action.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {action.vm_id.toUpperCase()} · {action.service} · {action.status}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{fmtAge(action.requested_at, now)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SectionCard>

      {data.generated_at ? (
        <p className="text-center text-[10px] text-muted-foreground">
          Server snapshot generated {fmtDateTime(data.generated_at)} · polled every 8s while this tab is visible.
        </p>
      ) : null}
    </div>
  );
}
