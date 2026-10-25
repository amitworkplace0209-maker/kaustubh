// ---- VM management presentation rules ----
//
// Pure-logic tests for the honesty rules behind the VM pages: a missing value
// is never rendered as zero/healthy, an unconfigured check is never a failure,
// a stale host is never shown as current, and a restart is only offered for a
// confirmed, allowlisted service incident.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ageSeconds,
  agentStateLabel,
  agentStateTone,
  canRequestRestart,
  checkLabel,
  checkTone,
  fmtAge,
  fmtDateTime,
  fmtDuration,
  fmtGb,
  fmtLatency,
  fmtMb,
  fmtMetric,
  fmtPct,
  historyPoints,
  hostNotice,
  hostStatusTone,
  isVmId,
  openIncidentLabel,
  serviceLabel,
  serviceTone,
  severityTone,
  sortIncidents,
  type VmIncident,
  type VmRecoveryPolicy,
} from '../lib/vm-management.ts';

test('missing measurements render n/a, never zero', () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(fmtMetric(value), 'n/a');
    assert.equal(fmtPct(value), 'n/a');
    assert.equal(fmtMb(value), 'n/a');
    assert.equal(fmtGb(value), 'n/a');
    assert.equal(fmtLatency(value), 'n/a');
    assert.equal(fmtDuration(value), 'n/a');
  }
  assert.equal(fmtMetric(0), '0.0');
  assert.equal(fmtPct(42.34, 1), '42.3%');
  assert.equal(fmtMb(512), '512 MB');
  assert.equal(fmtMb(1024), '1.00 GB');
  assert.equal(fmtGb(9.5), '9.5 GB');
  assert.equal(fmtLatency(42.6), '43 ms');
  assert.equal(fmtLatency(1500), '1.50 s');
  assert.equal(fmtDuration(59), '59s');
  assert.equal(fmtDuration(3661), '1h 1m');
  assert.equal(fmtDuration(90_000), '1d 1h');
});

test('agent state mapping keeps silence visibly unhealthy', () => {
  assert.equal(agentStateTone('CONNECTED'), 'success');
  assert.equal(agentStateTone('STALE'), 'warning');
  assert.equal(agentStateTone('DISCONNECTED'), 'danger');
  assert.equal(agentStateTone('NEVER_CONNECTED'), 'neutral');
  assert.equal(agentStateTone(null), 'neutral');

  assert.equal(agentStateLabel('STALE'), 'STALE DATA');
  assert.equal(agentStateLabel('NEVER_CONNECTED'), 'NEVER CONNECTED');
});

test('overall host status never upgrades a disconnected feed to healthy', () => {
  assert.equal(hostStatusTone('HEALTHY'), 'success');
  assert.equal(hostStatusTone('DEGRADED'), 'warning');
  assert.equal(hostStatusTone('CRITICAL'), 'danger');
  assert.equal(hostStatusTone('STALE'), 'warning');
  assert.equal(hostStatusTone('DISCONNECTED'), 'neutral');
  assert.equal(hostStatusTone(null), 'neutral');
});

test('check tri-state: unconfigured is neutral, not failing', () => {
  assert.equal(checkTone(undefined), 'neutral');
  assert.equal(checkTone({ configured: false }), 'neutral');
  assert.equal(checkTone({ configured: true, ok: null }), 'neutral');
  assert.equal(checkTone({ configured: true, ok: true }), 'success');
  assert.equal(checkTone({ configured: true, ok: false }), 'danger');

  assert.equal(checkLabel('backup', { configured: false }), 'NOT CONFIGURED');
  assert.equal(checkLabel('backup', { configured: true, ok: null }), 'UNKNOWN');
  assert.equal(checkLabel('backup', { configured: true, ok: true }), 'PASSING');
  assert.equal(checkLabel('backup', { configured: true, ok: false }), 'FAILING');
  assert.equal(
    checkLabel('mongo_ping', { configured: true, ok: true, authenticated: true }),
    'AUTHENTICATED',
  );
  assert.equal(
    checkLabel('mongo_ping', { configured: true, ok: false, error_kind: 'authentication' }),
    'AUTH FAILED',
  );
});

test('service state: absent unit is unknown, inactive is a failure', () => {
  assert.equal(serviceTone(null), 'neutral');
  assert.equal(serviceTone({ name: 'x', exists: false, active: '', sub: '' }), 'neutral');
  assert.equal(serviceTone({ name: 'x', exists: true, active: 'active', sub: 'running' }), 'success');
  assert.equal(serviceTone({ name: 'x', exists: true, active: 'failed', sub: 'failed' }), 'danger');
  assert.equal(serviceLabel({ name: 'x', exists: false, active: '', sub: '' }), 'NOT INSTALLED');
  assert.equal(serviceLabel({ name: 'x', exists: true, active: 'active', sub: 'running' }), 'active/running');
});

test('host notices never claim live data for a stale host', () => {
  assert.match(hostNotice({ agent_state: 'NEVER_CONNECTED', status: 'DISCONNECTED' }), /UNKNOWN/);
  assert.match(hostNotice({ agent_state: 'DISCONNECTED', status: 'DISCONNECTED' }), /not live/);
  assert.match(hostNotice({ agent_state: 'STALE', status: 'STALE' }), /STALE/);
  assert.match(hostNotice({ agent_state: 'CONNECTED', status: 'HEALTHY' }), /current/);
});

test('incident ordering: hardest first, newest next, input untouched', () => {
  const make = (id: string, severity: VmIncident['severity'], last: string): VmIncident => ({
    id,
    vm_id: 'vm1',
    dedupe_key: id,
    resource: 'cpu',
    service: null,
    severity,
    status: 'open',
    active: true,
    title: id,
    message: id,
    last_seen: last,
  });
  const input = [
    make('w-old', 'warning', '2026-10-25T01:00:00Z'),
    make('c-old', 'critical', '2026-10-25T02:00:00Z'),
    make('w-new', 'warning', '2026-10-25T03:00:00Z'),
    make('i-new', 'info', '2026-10-25T04:00:00Z'),
  ];
  const copy = [...input];
  assert.deepEqual(sortIncidents(input).map((i) => i.id), ['c-old', 'w-new', 'w-old', 'i-new']);
  assert.deepEqual(input, copy);
});

const POLICY: VmRecoveryPolicy = {
  enabled: true,
  allowlist: ['kds-backend', 'mongod'],
  cooldown_seconds: 600,
  max_per_incident: 2,
  max_per_hour: 2,
  automatic_restart_scope: 'allowlisted systemd services only; never a VM reboot',
};

function incident(overrides: Partial<VmIncident> = {}): VmIncident {
  return {
    id: 'abc',
    vm_id: 'vm1',
    dedupe_key: 'service:kds-backend',
    resource: 'service:kds-backend',
    service: 'kds-backend',
    severity: 'critical',
    status: 'open',
    active: true,
    title: 'kds-backend is not running',
    message: 'systemd reports failed',
    ...overrides,
  };
}

test('restart is only offered for an active, allowlisted service incident', () => {
  assert.equal(canRequestRestart(incident(), POLICY), true);
  assert.equal(canRequestRestart(incident(), { ...POLICY, allowlist: [] }), false);
  assert.equal(canRequestRestart(incident({ service: 'nginx' }), POLICY), false);
  assert.equal(canRequestRestart(incident({ service: null }), POLICY), false);
  assert.equal(canRequestRestart(incident({ active: false, status: 'resolved' }), POLICY), false);
  assert.equal(canRequestRestart(null, POLICY), false);
  assert.equal(canRequestRestart(incident(), null), false);
});

test('history points keep real numbers and leave holes as null', () => {
  const points = historyPoints([
    { vm_id: 'vm1', seq: 1, collected_at: '2026-10-25T00:00:00Z', metrics: { cpu_pct: 10, mem_available_pct: 50, disk_used_pct: 40 } },
    { vm_id: 'vm1', seq: 2, collected_at: '2026-10-25T00:01:00Z', metrics: { cpu_pct: null, mem_available_pct: 49 } },
    { vm_id: 'vm1', seq: 3, collected_at: 'not-a-date', metrics: { cpu_pct: 99 } },
    { vm_id: 'vm1', seq: 4, collected_at: '2026-10-25T00:02:00Z' },
  ]);
  assert.equal(points.length, 3);
  assert.deepEqual(points[0], { at: Date.parse('2026-10-25T00:00:00Z'), cpu: 10, ram: 50, disk: 40 });
  assert.deepEqual(points[1], { at: Date.parse('2026-10-25T00:01:00Z'), cpu: null, ram: 49, disk: null });
  assert.deepEqual(points[2], { at: Date.parse('2026-10-25T00:02:00Z'), cpu: null, ram: null, disk: null });
  assert.deepEqual(historyPoints(null), []);
});

test('ages and timestamps are honest about missing data', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  assert.equal(ageSeconds(null, now), null);
  assert.equal(ageSeconds('bad-date', now), null);
  assert.equal(ageSeconds('2026-10-25T09:59:00Z', now), 60);
  assert.equal(fmtAge('2026-10-25T09:59:00Z', now), '1m ago');
  assert.equal(fmtAge(null, now), 'n/a');
  assert.equal(fmtDateTime(null), 'n/a');
  assert.equal(fmtDateTime('bad-date'), 'n/a');
  assert.notEqual(fmtDateTime('2026-10-25T10:00:00Z'), 'n/a');
});

test('VM ids are validated before any request is made', () => {
  assert.equal(isVmId('vm1'), true);
  assert.equal(isVmId('vm2'), true);
  assert.equal(isVmId('vm3'), false);
  assert.equal(isVmId(''), false);
  assert.equal(isVmId(null), false);
});

test('severity and incident summary labels', () => {
  assert.equal(severityTone('critical'), 'danger');
  assert.equal(severityTone('error'), 'danger');
  assert.equal(severityTone('warning'), 'warning');
  assert.equal(severityTone('success'), 'success');
  assert.equal(severityTone('info'), 'info');
  assert.equal(severityTone('weird'), 'neutral');

  assert.equal(openIncidentLabel({ critical: 1, warning: 2 }), '1 critical · 2 warning');
  assert.equal(openIncidentLabel({ critical: 0, warning: 0 }), 'No open incidents');
  assert.equal(openIncidentLabel(null), 'UNKNOWN');
});
