'use client';

/**
 * SERVICES → VM Management → one host.
 *
 * The page is a faithful render of the last accepted agent snapshot plus the
 * incident/event/action ledger. It never derives a metric, never hides a stale
 * feed, and never presents an unconfigured check as a failure.
 *
 * Mutations (acknowledge / resolve / restart) are operator-only: they are sent
 * with the backend operator JWT obtained server-side by
 * `/api/auth/trading-token`. A restart is additionally confirmation-gated here
 * and re-validated against the server-side allowlist and cooldown.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity, AlertTriangle, ArrowLeft, ArrowUpDown, Bell, CheckCircle2, Clock,
  Cpu, HardDrive, HeartPulse, ListOrdered, MemoryStick, RefreshCw,
  RotateCcw, Server, ShieldCheck, Terminal, XCircle,
} from 'lucide-react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  EmptyState, ErrorState, LoadingState, PageHeader, SectionCard, StatCard, StatusBadge,
} from '@/components/design-system';
import { useVmPolling } from '@/hooks/use-vm-polling';
import { cn } from '@/lib/utils';
import {
  acknowledgeIncident, getVmDetail, requestRestart, resolveIncident,
} from '@/lib/vm-management-client';
import {
  actionTone, ageSeconds, agentStateLabel, agentStateTone,
  canRequestRestart, checkLabel, checkTone, fmtAge, fmtDateTime, fmtDuration, fmtGb,
  fmtLatency, fmtMb, fmtPct, historyPoints, hostNotice, hostStatusTone,
  isVmId, serviceLabel, serviceTone, severityTone, sortIncidents,
  type VmCheck, type VmIncident, type VmId, type VmTone,
} from '@/lib/vm-management';
import { NoTelemetry, Sparkline, TONE_TEXT, VmMetric, VmNumber, statAccent } from './shared';

const CHECK_ORDER: Array<{ key: string; label: string }> = [
  { key: 'backend_health', label: 'Backend health' },
  { key: 'mongo_tcp', label: 'MongoDB TCP (VM1 → VM2)' },
  { key: 'mongo_ping', label: 'MongoDB authenticated ping' },
  { key: 'backup', label: 'Backup freshness' },
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

function highTone(value: number | null | undefined, warn: number, critical: number): VmTone {
  if (value == null || !Number.isFinite(value)) return 'neutral';
  if (value >= critical) return 'danger';
  if (value >= warn) return 'warning';
  return 'success';
}

function CheckRow({ name, label, check }: { name: string; label: string; check: VmCheck | undefined }) {
  return (
    <div className="rounded-md border border-border/60 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium">{label}</p>
        <StatusBadge status={checkTone(check)} label={checkLabel(name, check)} />
      </div>
      <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
        {!check?.configured ? (
          <p>The agent has no configuration for this check on this host. It is UNKNOWN, not failing.</p>
        ) : (
          <>
            {check.target ? <p className="truncate">target {check.target}</p> : null}
            {check.status_code != null ? <p>HTTP {check.status_code}</p> : null}
            {check.latency_ms != null ? <p>latency {fmtLatency(check.latency_ms)}</p> : null}
            {check.authenticated != null ? <p>authenticated: {check.authenticated ? 'yes' : 'no'}</p> : null}
            {check.age_hours != null ? <p>last backup {check.age_hours.toFixed(1)}h old</p> : null}
            {check.last_backup_at ? <p>last backup at {fmtDateTime(check.last_backup_at)}</p> : null}
            {check.error ? <p className="break-words text-destructive">{check.error}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

export default function VmDetailPage({ vmId }: { vmId: string }) {
  const valid = isVmId(vmId);
  const fetchDetail = useCallback(
    (signal: AbortSignal) => getVmDetail(vmId as VmId, signal),
    [vmId],
  );
  const { data, error, loading, refreshing, lastUpdated, refresh } = useVmPolling(fetchDetail, { enabled: valid });
  const now = useNow();

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [restartTarget, setRestartTarget] = useState<VmIncident | null>(null);

  const lastUpdatedLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
    : 'n/a';

  const act = useCallback(
    async (key: string, fn: () => Promise<unknown>, successText: string) => {
      setBusy(key);
      setNotice(null);
      try {
        await fn();
        setNotice({ kind: 'ok', text: successText });
        refresh();
      } catch (cause) {
        setNotice({
          kind: 'err',
          text: cause instanceof Error ? cause.message : 'The request failed.',
        });
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  if (!valid) {
    return (
      <div className="space-y-3">
        <PageHeader title="Unknown VM" subtitle={`"${vmId}" is not a managed host.`} />
        <ErrorState message="VM Management only tracks vm1 and vm2." />
        <div className="text-center">
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link href="/services/vm"><ArrowLeft className="h-3 w-3" /> Back to overview</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <PageHeader title={`VM ${vmId.toUpperCase()}`} subtitle="Loading host telemetry…" />
        <LoadingState text="Reading VM telemetry" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-3">
        <PageHeader title={`VM ${vmId.toUpperCase()}`} subtitle="VM Management" />
        <ErrorState message={error?.message ?? 'VM telemetry is unavailable.'} onRetry={refresh} />
        <div className="text-center">
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link href="/services/vm"><ArrowLeft className="h-3 w-3" /> Back to overview</Link>
          </Button>
        </div>
      </div>
    );
  }

  const snap = data.snapshot;
  const m = snap?.metrics ?? {};
  const checks = snap?.checks ?? {};
  const incidents = sortIncidents(data.incidents ?? []);
  const activeIncidents = incidents.filter((i) => i.active);
  const series = historyPoints(data.history);
  const cpuSeries = series.map((p) => p.cpu);
  const ramSeries = series.map((p) => p.ram);
  const diskSeries = series.map((p) => p.disk);
  const agentAge = ageSeconds(snap?.collected_at ?? null, now);
  const st = data.thresholds;

  return (
    <div className="space-y-3">
      <PageHeader title={data.meta.name} subtitle={`${data.meta.os} · ${data.meta.shape} · ${data.meta.privateIp}${data.meta.publicIp ? ` · public ${data.meta.publicIp}` : ' · private subnet'}`}>
        <StatusBadge status={agentStateTone(data.agent_state)} label={agentStateLabel(data.agent_state)} />
        <StatusBadge status={hostStatusTone(data.status)} label={data.status} />
        <Button asChild size="sm" variant="ghost" className="h-7 gap-1 text-[11px]">
          <Link href="/services/vm"><ArrowLeft className="h-3 w-3" /> All VMs</Link>
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11px]" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} /> Refresh
        </Button>
      </PageHeader>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            The latest refresh failed ({error.message}). Values below are the last payload received
            {lastUpdated ? ` at ${lastUpdatedLabel} IST` : ''} and are not live.
          </span>
        </div>
      ) : null}

      {notice ? (
        <div
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px]',
            notice.kind === 'ok'
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-destructive/40 bg-destructive/10 text-destructive',
          )}
        >
          {notice.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      ) : null}

      <div
        className={cn(
          'flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px]',
          data.agent_state === 'CONNECTED'
            ? 'border-border/60 bg-muted/30 text-muted-foreground'
            : 'border-warning/40 bg-warning/10 text-warning',
        )}
      >
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {hostNotice(data)}
          {snap?.collected_at ? (
            <> Last heartbeat {fmtAge(snap.collected_at, now)} ({fmtDateTime(snap.collected_at)}).</>
          ) : null}
          {agentAge != null && agentAge > (st.stale_seconds ?? 180) ? (
            <> Age exceeds the {st.stale_seconds}s freshness window.</>
          ) : null}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Activity}
          title="Host status"
          value={<span className={TONE_TEXT[hostStatusTone(data.status)]}>{data.status}</span>}
          sub={`${activeIncidents.length} active incident${activeIncidents.length === 1 ? '' : 's'}`}
          tone={statAccent(hostStatusTone(data.status))}
        />
        <StatCard
          icon={Bell}
          title="Incidents (all time)"
          value={incidents.length}
          sub={incidents.length > 0 ? `${incidents.filter((i) => i.severity === 'critical').length} critical in the last 80` : 'None recorded'}
          tone={incidents.some((i) => i.active && i.severity === 'critical') ? 'danger' : 'neutral'}
        />
        <StatCard
          icon={RotateCcw}
          title="Recent actions"
          value={data.actions.length}
          sub={data.actions.some((a) => a.status === 'pending' || a.status === 'queued') ? 'A restart is queued' : 'No queued restart'}
          tone={data.actions.some((a) => a.status === 'failed') ? 'warning' : 'neutral'}
        />
        <StatCard
          icon={Server}
          title="Uptime"
          value={fmtDuration(snap?.uptime_seconds)}
          sub={snap?.agent_version ? `agent ${snap.agent_version}` : 'agent version not reported'}
          tone="neutral"
        />
      </div>

      {!snap ? (
        <SectionCard title="Current metrics" icon={Cpu}>
          <NoTelemetry text="No heartbeat has been accepted for this host. Every metric is UNKNOWN; nothing is estimated or back-filled." />
        </SectionCard>
      ) : (
        <>
          <SectionCard
            title="Current metrics"
            icon={Cpu}
            headerRight={<span className="text-[10px] text-muted-foreground">seq {snap.seq} · collected {fmtDateTime(snap.collected_at)}</span>}
          >
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
              <VmNumber icon={Cpu} label="CPU" value={m.cpu_pct} suffix="%" tone={highTone(m.cpu_pct, st.cpu_warn_pct ?? 85, st.cpu_critical_pct ?? 95)} />
              <VmNumber icon={MemoryStick} label="RAM available" value={m.mem_available_pct} suffix="%" sub={`${fmtMb(m.mem_available_mb)} of ${fmtMb(m.mem_total_mb)}`} tone={m.mem_available_pct == null ? 'neutral' : m.mem_available_pct < (st.ram_critical_available_pct ?? 8) ? 'danger' : m.mem_available_pct < (st.ram_warn_available_pct ?? 15) ? 'warning' : 'success'} />
              <VmNumber icon={HardDrive} label="Disk used" value={m.disk_used_pct} suffix="%" sub={`${fmtGb(m.disk_used_gb)} / ${fmtGb(m.disk_total_gb)}`} tone={highTone(m.disk_used_pct, st.disk_warn_pct ?? 80, st.disk_critical_pct ?? 90)} />
              <VmNumber icon={ArrowUpDown} label="Inodes used" value={m.inode_used_pct} suffix="%" sub={m.inode_used != null ? `${m.inode_used.toLocaleString('en-IN')} inodes` : 'not reported'} tone={highTone(m.inode_used_pct, 80, 90)} />
              <VmNumber icon={MemoryStick} label="Swap used" value={m.swap_used_pct} suffix="%" sub={`${fmtMb(m.swap_used_mb)} of ${fmtMb(m.swap_total_mb)}`} tone={highTone(m.swap_used_pct, 80, 95)} />
              <VmMetric icon={Activity} label="Load 1 / 5 / 15" value={m.load1 == null ? 'n/a' : `${m.load1.toFixed(2)} / ${m.load5?.toFixed(2) ?? 'n/a'} / ${m.load15?.toFixed(2) ?? 'n/a'}`} sub={m.boot_time ? `booted ${fmtDateTime(m.boot_time)}` : 'boot time not reported'} />
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Page load is shown for context only; it is not used to open incidents. CPU and available-RAM
              incidents require sustained samples server-side.
            </p>
          </SectionCard>

          <div className="grid gap-3 lg:grid-cols-3">
            <SectionCard title="CPU trend (stored history)" icon={Cpu}>
              <Sparkline values={cpuSeries} label="CPU %" tone="info" format={(v) => `${v.toFixed(1)}%`} />
            </SectionCard>
            <SectionCard title="Available RAM trend" icon={MemoryStick}>
              <Sparkline values={ramSeries} label="Available RAM %" tone="success" format={(v) => `${v.toFixed(1)}%`} />
            </SectionCard>
            <SectionCard title="Disk usage trend" icon={HardDrive}>
              <Sparkline values={diskSeries} label="Disk used %" tone="warning" format={(v) => `${v.toFixed(1)}%`} />
            </SectionCard>
          </div>
        </>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <SectionCard title="Host checks" icon={HeartPulse}>
          <div className="space-y-1.5">
            {CHECK_ORDER.map(({ key, label }) => (
              <CheckRow key={key} name={key} label={label} check={checks[key]} />
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Services" icon={Terminal}>
          {!snap ? (
            <NoTelemetry text="No service state has been reported." />
          ) : (snap.services ?? []).length === 0 ? (
            <NoTelemetry text="The agent reported no monitored services for this host." />
          ) : (
            <ul className="space-y-1.5">
              {(snap.services ?? []).map((svc) => (
                <li key={svc.name} className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px]">{svc.name}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {svc.exists === false ? 'unit not found on host' : `restarts ${svc.restarts ?? 'n/a'} · since ${fmtDateTime(svc.since)}`}
                    </p>
                  </div>
                  <StatusBadge status={serviceTone(svc)} label={serviceLabel(svc)} />
                </li>
              ))}
            </ul>
          )}
          {snap && (snap.failed_units?.length ?? 0) > 0 ? (
            <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-warning">
                Failed units ({snap.failed_units!.length})
              </p>
              <ul className="mt-0.5 list-inside list-disc text-[10px] text-warning">
                {snap.failed_units!.map((unit) => <li key={unit} className="truncate font-mono">{unit}</li>)}
              </ul>
            </div>
          ) : null}
          <p className="mt-2 text-[10px] text-muted-foreground">
            A unit that is not installed is shown as NOT INSTALLED — not as a failure.
          </p>
        </SectionCard>
      </div>

      <SectionCard
        title="Incidents"
        icon={Bell}
        headerRight={<span className="text-[10px] text-muted-foreground">{incidents.length} recorded</span>}
      >
        {incidents.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No incidents recorded" description="No threshold breach or agent gap has been stored for this host." />
        ) : (
          <ul className="space-y-2">
            {incidents.map((inc) => {
              const ackKey = `${inc.id}:ack`;
              const resKey = `${inc.id}:resolve`;
              const restartKey = `${inc.id}:restart`;
              return (
                <li key={inc.id} className="rounded-lg border border-border/60 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={severityTone(inc.severity)} label={inc.severity.toUpperCase()} />
                    <span className="text-[11px] font-semibold">{inc.title}</span>
                    <StatusBadge status={inc.status === 'resolved' ? 'success' : inc.status === 'acknowledged' ? 'info' : 'warning'} label={inc.status.toUpperCase()} />
                    {inc.occurrences != null ? (
                      <span className="text-[10px] text-muted-foreground">×{inc.occurrences}</span>
                    ) : null}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      last seen {fmtAge(inc.last_seen, now)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{inc.message}</p>
                  <div className="mt-1 grid gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground sm:grid-cols-2">
                    {inc.observed ? <p><span className="font-medium text-foreground/80">Observed:</span> {inc.observed}</p> : null}
                    {inc.threshold ? <p><span className="font-medium text-foreground/80">Threshold:</span> {inc.threshold}</p> : null}
                    {inc.probable_cause ? <p><span className="font-medium text-foreground/80">Cause:</span> {inc.probable_cause}</p> : null}
                    {inc.remediation ? <p><span className="font-medium text-foreground/80">Remediation:</span> {inc.remediation}</p> : null}
                    {inc.acknowledged_by ? <p><span className="font-medium text-foreground/80">Acknowledged:</span> {inc.acknowledged_by} · {fmtDateTime(inc.acknowledged_at)}</p> : null}
                    {inc.recovery_status ? <p><span className="font-medium text-foreground/80">Recovery:</span> {inc.recovery_status}{inc.recovery_result ? ` — ${inc.recovery_result}` : ''}</p> : null}
                    {inc.resolution ? <p><span className="font-medium text-foreground/80">Resolution:</span> {inc.resolution}</p> : null}
                  </div>
                  {inc.active ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {inc.status === 'open' ? (
                        <Button
                          size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px]"
                          disabled={busy === ackKey}
                          onClick={() => act(ackKey, () => acknowledgeIncident(inc.id), 'Incident acknowledged.')}
                        >
                          {busy === ackKey ? <RefreshCw className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Acknowledge
                        </Button>
                      ) : null}
                      <Button
                        size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px]"
                        disabled={busy === resKey}
                        onClick={() => act(resKey, () => resolveIncident(inc.id), 'Incident resolved.')}
                      >
                        {busy === resKey ? <RefreshCw className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Resolve
                      </Button>
                      {canRequestRestart(inc, data.recovery) ? (
                        <Button
                          size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px] text-warning"
                          disabled={busy === restartKey}
                          onClick={() => setRestartTarget(inc)}
                        >
                          <RotateCcw className="h-3 w-3" /> Restart {inc.service}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <div className="grid gap-3 lg:grid-cols-2">
        <SectionCard title="Events" icon={ListOrdered}>
          {data.events.length === 0 ? (
            <NoTelemetry text="No service, reboot, agent or recovery event has been stored for this host." />
          ) : (
            <ul className="space-y-1">
              {data.events.map((event, index) => (
                <li key={event.id ?? `${event.ts}-${index}`} className="flex items-start gap-2 text-[11px]">
                  <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', event.severity === 'critical' || event.severity === 'error' ? 'bg-destructive' : event.severity === 'warning' ? 'bg-warning' : event.severity === 'success' ? 'bg-success' : 'bg-info')} />
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{event.message}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {fmtDateTime(event.ts)} · {event.source} · {event.severity}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Remediation audit" icon={ShieldCheck}>
          {data.actions.length === 0 ? (
            <NoTelemetry text="No restart has been requested for this host. Nothing is hidden: the audit starts empty." />
          ) : (
            <ul className="space-y-1.5">
              {data.actions.map((action) => (
                <li key={action.id} className="rounded-md border border-border/60 px-2.5 py-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px]">{action.service}</span>
                    <StatusBadge status={actionTone(action.status)} label={action.status.toUpperCase()} />
                    <span className="text-[10px] text-muted-foreground">{action.trigger} · {action.requested_by ?? 'n/a'}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{fmtDateTime(action.requested_at)}</span>
                  </div>
                  {action.reason ? <p className="mt-0.5 text-[10px] text-muted-foreground">reason: {action.reason}</p> : null}
                  {action.result ? <p className="mt-0.5 break-words text-[10px] text-muted-foreground">result: {action.result}</p> : null}
                  {action.duration_ms != null ? (
                    <p className="text-[10px] text-muted-foreground">duration {fmtLatency(action.duration_ms)} · verified {action.verified ? 'yes' : 'no'}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <SectionCard title="Automatic recovery policy" icon={ShieldCheck}>
          <div className="space-y-1 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Enabled</span>
              <StatusBadge status={data.recovery.enabled ? 'success' : 'neutral'} label={data.recovery.enabled ? 'ON' : 'OFF'} />
            </div>
            <div className="flex items-start justify-between gap-2">
              <span className="text-muted-foreground">Allowlist</span>
              <span className="text-right font-mono text-[10px]">{data.recovery.allowlist.length ? data.recovery.allowlist.join(', ') : 'empty'}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Cooldown</span>
              <span className="font-mono text-[10px]">{fmtDuration(data.recovery.cooldown_seconds)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Caps</span>
              <span className="font-mono text-[10px]">{data.recovery.max_per_incident}/incident · {data.recovery.max_per_hour}/hour</span>
            </div>
            <p className="pt-1 text-[10px] text-muted-foreground">{data.recovery.automatic_restart_scope}</p>
            <p className="text-[10px] text-muted-foreground">
              Auto-recovery can only restart a confirmed service failure. It never reboots a VM, changes
              firewall rules, edits MongoDB auth, or touches data.
            </p>
          </div>
        </SectionCard>

        <SectionCard title="Alert thresholds (server-side)" icon={Activity}>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-muted-foreground">CPU warn / critical</dt>
            <dd className="text-right font-mono">{fmtPct(st.cpu_warn_pct, 0)} / {fmtPct(st.cpu_critical_pct, 0)}</dd>
            <dt className="text-muted-foreground">RAM available warn</dt>
            <dd className="text-right font-mono">&lt; {fmtPct(st.ram_warn_available_pct, 0)}</dd>
            <dt className="text-muted-foreground">RAM available critical</dt>
            <dd className="text-right font-mono">&lt; {fmtPct(st.ram_critical_available_pct, 0)}</dd>
            <dt className="text-muted-foreground">Disk warn / critical</dt>
            <dd className="text-right font-mono">{fmtPct(st.disk_warn_pct, 0)} / {fmtPct(st.disk_critical_pct, 0)}</dd>
            <dt className="text-muted-foreground">Backup max age</dt>
            <dd className="text-right font-mono">{st.backup_max_age_hours != null ? `${st.backup_max_age_hours}h` : 'n/a'}</dd>
            <dt className="text-muted-foreground">Stale / disconnected</dt>
            <dd className="text-right font-mono">{st.stale_seconds ?? 'n/a'}s / {st.disconnected_seconds ?? 'n/a'}s</dd>
          </dl>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Thresholds are reported by the API. The page does not re-evaluate them; an operator changing
            the backend environment changes this list on the next poll.
          </p>
        </SectionCard>
      </div>

      <p className="text-center text-[10px] text-muted-foreground">
        {data.meta.dependency ? `Dependency: ${data.meta.dependency}` : 'No host dependency declared'} · polled every 8s while this tab is visible.
      </p>

      <AlertDialog open={restartTarget != null} onOpenChange={(open) => { if (!open) setRestartTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart {restartTarget?.service} on {data.vm.toUpperCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              This queues one <span className="font-mono">systemctl restart {restartTarget?.service}</span> for the
              next agent heartbeat. The server re-checks the allowlist, cooldown and hourly cap before the agent
              executes anything. The VM is not rebooted and no data is touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-warning text-warning-foreground hover:bg-warning/90"
              onClick={() => {
                const target = restartTarget;
                setRestartTarget(null);
                if (!target) return;
                const key = `${target.id}:restart`;
                void act(
                  key,
                  () => requestRestart(data.vm, target.service as string, `operator confirmed from VM detail (${target.id})`),
                  `Restart of ${target.service} queued. It runs on the next agent heartbeat and is recorded in the audit.`,
                );
              }}
            >
              Queue restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
