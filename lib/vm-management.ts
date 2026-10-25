/**
 * VM management — shared types and pure presentation rules.
 *
 * DATA HONESTY: the backend only ever stores values the agent actually
 * collected. Nothing here derives, estimates or defaults a measurement. A
 * missing field stays missing and is rendered as `n/a`/`UNKNOWN`, and a stale
 * heartbeat stays visibly STALE instead of being refreshed by the UI clock.
 *
 * This module is deliberately free of React and fetch so the rules below can
 * be unit tested with plain `node --test`. The thin browser client lives in
 * `lib/vm-management-client.ts`.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type VmId = 'vm1' | 'vm2';

/** Reported by the backend from the real heartbeat age. */
export type AgentState = 'CONNECTED' | 'STALE' | 'DISCONNECTED' | 'NEVER_CONNECTED';

/** Overall host verdict computed server-side from real findings + agent state. */
export type HostStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'STALE' | 'DISCONNECTED';

export type Severity = 'info' | 'warning' | 'critical' | 'error' | 'success';

/** Tone names shared with `components/design-system` StatusBadge. */
export type VmTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface VmMeta {
  id: VmId;
  name: string;
  role: string;
  privateIp: string;
  publicIp: string | null;
  os: string;
  shape: string;
  subnet: string;
  criticalServices: string[];
  dependency: string | null;
}

export interface VmMetrics {
  cpu_pct?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  mem_total_mb?: number | null;
  mem_available_mb?: number | null;
  mem_available_pct?: number | null;
  swap_total_mb?: number | null;
  swap_used_mb?: number | null;
  swap_used_pct?: number | null;
  disk_total_gb?: number | null;
  disk_used_gb?: number | null;
  disk_used_pct?: number | null;
  inode_total?: number | null;
  inode_used?: number | null;
  inode_used_pct?: number | null;
  boot_time?: string | null;
}

export interface VmService {
  name: string;
  exists: boolean;
  active: string;
  sub: string;
  restarts?: number | null;
  since?: string | null;
}

export interface VmCheck {
  configured: boolean;
  ok?: boolean | null;
  authenticated?: boolean | null;
  status_code?: number | null;
  latency_ms?: number | null;
  target?: string | null;
  error?: string | null;
  error_kind?: string | null;
  last_backup_at?: string | null;
  age_hours?: number | null;
}

export interface VmSnapshot {
  id?: string;
  vm_id: VmId;
  seq: number;
  collected_at: string;
  received_at?: string | null;
  boot_id?: string | null;
  uptime_seconds?: number | null;
  agent_version?: string;
  metrics?: VmMetrics;
  services?: VmService[];
  failed_units?: string[];
  checks?: Record<string, VmCheck>;
  events?: VmAgentEvent[];
}

export interface VmAgentEvent {
  ts?: string | null;
  severity?: Severity;
  source?: string;
  message: string;
}

export interface VmIncident {
  id: string;
  vm_id: VmId;
  dedupe_key: string;
  resource: string;
  service: string | null;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  active: boolean;
  title: string;
  message: string;
  observed?: string;
  threshold?: string;
  probable_cause?: string;
  remediation?: string;
  first_seen?: string | null;
  last_seen?: string | null;
  occurrences?: number;
  acknowledged_by?: string | null;
  acknowledged_at?: string | null;
  recovery_status?: string | null;
  recovery_result?: string | null;
  resolved_at?: string | null;
  resolution?: string | null;
}

export interface VmEvent {
  id?: string;
  vm_id: VmId;
  ts: string;
  severity: Severity;
  source: string;
  message: string;
}

export interface VmAction {
  id: string;
  vm_id: VmId;
  incident_id?: string | null;
  service: string;
  action: string;
  trigger: 'automatic' | 'manual' | string;
  requested_by?: string;
  requested_at?: string | null;
  claimed_at?: string | null;
  finished_at?: string | null;
  status: 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | string;
  reason?: string | null;
  result?: string | null;
  verified?: boolean | null;
  duration_ms?: number | null;
}

export interface VmThresholds {
  cpu_warn_pct?: number;
  cpu_critical_pct?: number;
  cpu_warn_sustain_s?: number;
  ram_warn_available_pct?: number;
  ram_critical_available_pct?: number;
  disk_warn_pct?: number;
  disk_critical_pct?: number;
  backup_max_age_hours?: number;
  stale_seconds?: number;
  disconnected_seconds?: number;
}

export interface VmHostSummary {
  vm: VmId;
  agent_state: AgentState;
  last_seen: string | null;
  snapshot: VmSnapshot | null;
  incidents: VmIncident[];
  recent_events: VmEvent[];
  meta: VmMeta;
  status: HostStatus;
  incident_counts: { critical: number; warning: number; info: number; total: number };
  highest_severity: 'info' | 'warning' | 'critical';
}

export interface VmOverviewData {
  overall: HostStatus;
  connected_agents: number;
  total_agents: number;
  open_incidents: { critical: number; warning: number; total: number };
  hosts: VmHostSummary[];
  pending_actions: VmAction[];
  generated_at: string | null;
  thresholds: VmThresholds;
}

export interface VmRecoveryPolicy {
  enabled: boolean;
  allowlist: string[];
  cooldown_seconds: number;
  max_per_incident: number;
  max_per_hour: number;
  automatic_restart_scope: string;
}

export interface VmDetailData {
  vm: VmId;
  meta: VmMeta;
  agent_state: AgentState;
  status: HostStatus;
  snapshot: VmSnapshot | null;
  history: VmSnapshot[];
  incidents: VmIncident[];
  events: VmEvent[];
  actions: VmAction[];
  thresholds: VmThresholds;
  recovery: VmRecoveryPolicy;
}

/* ------------------------------------------------------------------ */
/* Pure presentation rules                                             */
/* ------------------------------------------------------------------ */

export const VM_IDS: readonly VmId[] = ['vm1', 'vm2'];

export function isVmId(value: unknown): value is VmId {
  return value === 'vm1' || value === 'vm2';
}

export function agentStateTone(state: AgentState | null | undefined): VmTone {
  switch (state) {
    case 'CONNECTED': return 'success';
    case 'STALE': return 'warning';
    case 'DISCONNECTED': return 'danger';
    default: return 'neutral';
  }
}

export function hostStatusTone(status: HostStatus | null | undefined): VmTone {
  switch (status) {
    case 'HEALTHY': return 'success';
    case 'DEGRADED': return 'warning';
    case 'CRITICAL': return 'danger';
    case 'STALE': return 'warning';
    case 'DISCONNECTED': return 'neutral';
    default: return 'neutral';
  }
}

export function severityTone(severity: string | null | undefined): VmTone {
  switch (severity) {
    case 'critical':
    case 'error': return 'danger';
    case 'warning': return 'warning';
    case 'success': return 'success';
    case 'info': return 'info';
    default: return 'neutral';
  }
}

/**
 * A check is tri-state. `configured: false` means the agent was never asked to
 * perform it — that is NOT a failure and must never render as one.
 */
export function checkTone(check: VmCheck | null | undefined): VmTone {
  if (!check || !check.configured) return 'neutral';
  if (check.ok === true) return 'success';
  if (check.ok === false) return 'danger';
  return 'neutral';
}

export function checkLabel(name: string, check: VmCheck | null | undefined): string {
  if (!check || !check.configured) return 'NOT CONFIGURED';
  if (check.ok === true) {
    if (name === 'mongo_ping' && check.authenticated === true) return 'AUTHENTICATED';
    return 'PASSING';
  }
  if (check.ok === false) return check.error_kind === 'authentication' ? 'AUTH FAILED' : 'FAILING';
  return 'UNKNOWN';
}

/** Human label that never hides a stale/disconnected feed behind "Online". */
export function agentStateLabel(state: AgentState | null | undefined): string {
  switch (state) {
    case 'CONNECTED': return 'CONNECTED';
    case 'STALE': return 'STALE DATA';
    case 'DISCONNECTED': return 'DISCONNECTED';
    default: return 'NEVER CONNECTED';
  }
}

export function overallLabel(status: HostStatus | null | undefined): string {
  return status ?? 'UNKNOWN';
}

/** `n/a` (never a zero) for a measurement the agent did not report. */
export function fmtMetric(value: number | null | undefined, digits = 1, suffix = ''): string {
  if (value == null || typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(digits)}${suffix}`;
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  return fmtMetric(value, digits, '%');
}

export function fmtMb(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (value >= 1024) return `${(value / 1024).toFixed(2)} GB`;
  return `${Math.round(value)} MB`;
}

export function fmtGb(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(value >= 100 ? 0 : 1)} GB`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'n/a';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  return `${secs}s`;
}

/** Age of a timestamp; null when the timestamp is missing or unparseable. */
export function ageSeconds(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((now - ts) / 1000));
}

export function fmtAge(iso: string | null | undefined, now: number = Date.now()): string {
  const age = ageSeconds(iso, now);
  return age == null ? 'n/a' : `${fmtDuration(age)} ago`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return 'n/a';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'n/a';
  return new Date(ts).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

export function fmtLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** Service state from systemd; `exists: false` is UNKNOWN, never "down". */
export function serviceTone(service: VmService | null | undefined): VmTone {
  if (!service || service.exists === false) return 'neutral';
  return service.active === 'active' ? 'success' : 'danger';
}

export function serviceLabel(service: VmService | null | undefined): string {
  if (!service || service.exists === false) return 'NOT INSTALLED';
  const active = service.active || 'unknown';
  return service.sub ? `${active}/${service.sub}` : active;
}

export function actionTone(status: string | null | undefined): VmTone {
  switch (status) {
    case 'succeeded': return 'success';
    case 'failed': return 'danger';
    case 'pending':
    case 'queued':
    case 'running': return 'warning';
    default: return 'neutral';
  }
}

/**
 * The honest banner text for one host. Only CONNECTED hosts may show live
 * numbers; every other state says what it is and why.
 */
export function hostNotice(host: Pick<VmHostSummary, 'agent_state' | 'status'>): string {
  if (host.agent_state === 'NEVER_CONNECTED') {
    return 'No heartbeat has ever been received. Every metric below is UNKNOWN — nothing is inferred.';
  }
  if (host.agent_state === 'DISCONNECTED') {
    return 'The monitoring agent has stopped reporting. Values shown are the last received snapshot, not live readings.';
  }
  if (host.agent_state === 'STALE') {
    return 'The last heartbeat is older than the freshness window. Values shown are STALE.';
  }
  if (host.status === 'CRITICAL') return 'Active critical incidents were reported by the host.';
  if (host.status === 'DEGRADED') return 'Active warning incidents were reported by the host.';
  return 'Heartbeat is current and no active incident is open.';
}

/** Compact alert summary used in the page header. */
export function openIncidentLabel(counts: { critical: number; warning: number } | null | undefined): string {
  if (!counts) return 'UNKNOWN';
  const { critical, warning } = counts;
  if (critical === 0 && warning === 0) return 'No open incidents';
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warning > 0) parts.push(`${warning} warning`);
  return parts.join(' · ');
}

/** Sort incidents hardest-first, then newest-first. Never mutates input. */
export function sortIncidents(incidents: VmIncident[]): VmIncident[] {
  const rank: Record<string, number> = { critical: 3, warning: 2, info: 1 };
  return [...incidents].sort((a, b) => {
    const bySeverity = (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    const at = Date.parse(a.last_seen ?? a.first_seen ?? '') || 0;
    const bt = Date.parse(b.last_seen ?? b.first_seen ?? '') || 0;
    return bt - at;
  });
}

/** True only for a service incident that may be restarted under the policy. */
export function canRequestRestart(
  incident: VmIncident | null | undefined,
  policy: VmRecoveryPolicy | null | undefined,
): boolean {
  if (!incident || !policy) return false;
  if (!incident.active || incident.status === 'resolved') return false;
  if (!incident.service) return false;
  return policy.allowlist.includes(incident.service);
}

export interface HistoryPoint {
  at: number;
  cpu: number | null;
  ram: number | null;
  disk: number | null;
}

/** Extract only real numeric history points (used for the sparklines). */
export function historyPoints(history: VmSnapshot[] | null | undefined): HistoryPoint[] {
  if (!Array.isArray(history)) return [];
  const out: HistoryPoint[] = [];
  for (const row of history) {
    const at = Date.parse(row.collected_at);
    if (!Number.isFinite(at)) continue;
    const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out.push({
      at,
      cpu: num(row.metrics?.cpu_pct),
      ram: num(row.metrics?.mem_available_pct),
      disk: num(row.metrics?.disk_used_pct),
    });
  }
  return out;
}

export interface VmApiError {
  code: string;
  message: string;
  status: number;
}
