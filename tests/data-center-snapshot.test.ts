// ---- Data Center snapshot contract tests (schema v2) ----
//
// Runs on plain node (>=22.6 runs .ts natively):  npm test
// Pure module only - imported via RELATIVE path so no tsconfig path aliasing is
// required outside Next.js.
//
// These tests exist to protect the page from the one failure mode that matters
// most in an observability UI: showing a plausible-looking value for something
// the backend never measured. Every "honest" assertion below fails if a
// normaliser ever starts defaulting a missing measurement to 0 / '' / false.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DC_HEALTH_CATEGORIES,
  DC_SNAPSHOT_SCHEMA_VERSION,
  DC_SNAPSHOT_SECTIONS,
  DASH,
  bool,
  fmtAgo,
  fmtBytes,
  fmtDec,
  fmtDuration,
  fmtInt,
  humanState,
  isCompatibleSchema,
  normalizeDeepScanJob,
  normalizeSnapshot,
  num,
  stateBadge,
  str,
  withFrontendRealtime,
} from '../lib/data-center-snapshot.ts';
import type { DcSnapshot } from '../lib/data-center-snapshot.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const HEALTHY_PAYLOAD = {
  schemaVersion: 2,
  generatedAt: '2026-01-01T10:00:00+00:00',
  buildMs: 12,
  overall: 'OK',
  runtime: {
    available: true,
    source: 'brokers.manager.active_terminal',
    error: null,
    generatedAt: '2026-01-01T10:00:00+00:00',
    terminalMode: 'kotak',
    terminalModeAvailable: true,
    isPaperTerminal: false,
    knownTerminals: ['kotak', 'shoonya', 'dummy'],
    sessionMode: 'live',
    sessionBroker: 'kotak',
    process: { pid: 42, python: '3.12.0', uptimeSeconds: 3600, host: 'app', platform: 'Windows' },
  },
  database: {
    available: true,
    source: 'database.connection.get_mongo_info',
    error: null,
    generatedAt: '2026-01-01T10:00:00+00:00',
    connected: true,
    configured: true,
    provider: 'atlas',
    providerAvailable: true,
    providerDerivedFrom: 'active connection',
    configuredSource: 'atlas',
    activeSource: 'atlas',
    database: 'trading',
    host: 'cluster.example',
    serverVersion: '7.0.0',
    pool: { checkedOut: 1, maxPoolSize: 50 },
  },
  storage: {
    available: true,
    source: 'api.system.mongo_stats',
    error: null,
    generatedAt: '2026-01-01T10:00:00+00:00',
    dbName: 'trading',
    documents: 1200,
    dataSizeBytes: 2048,
    storageSizeBytes: 4096,
    indexSizeBytes: 1024,
    collectionsCount: 2,
    indexesCount: 3,
    pingMs: 1.5,
    collections: [
      { name: 'ticks', count: 1000, countIsApproximate: false, storageBytes: 2048, indexSizeBytes: 512, health: 'OK' },
      { name: 'stocks', count: 200, countIsApproximate: true, storageBytes: 2048, indexSizeBytes: 512, health: 'WARN' },
    ],
    collectionsAvailable: true,
  },
  realtime: {
    available: true,
    source: 'ws_manager.status + connection_engine.status',
    error: null,
    generatedAt: '2026-01-01T10:00:00+00:00',
    brokerFeed: { available: true, connected: true, state: 'CONNECTED', subscriptionCount: 5, ticksPerSecond: 3.5 },
    backendRealtime: { available: true, health: 'HEALTHY', activeConnections: 1, messagesDelivered: 90 },
    frontendRealtime: { measurable: false, reason: 'measured in the browser, not by the backend', note: null },
  },
  session: {
    available: true,
    source: 'services.session.session_manager.snapshot',
    error: null,
    generatedAt: '2026-01-01T10:00:00+00:00',
    state: 'ACTIVE',
    active: true,
    expired: false,
    mode: 'live',
    broker: 'kotak',
    userId: 'u1',
    remainingSeconds: 3000,
  },
  scheduler: {
    available: true,
    source: 'scheduler.get_scheduler_state',
    error: null,
    generatedAt: '2026-01-01T10:00:00+00:00',
    state: 'RUNNING',
    running: true,
    isTradingDay: true,
    market: { available: true, marketState: 'OPEN', marketStatus: 'live', isWeekend: false },
  },
  persistence: {
    available: true,
    authoritative: true,
    source: 'services.db_writer_engine.status_snapshot',
    error: null,
    generatedAt: '2026-01-01T10:00:00+00:00',
    state: 'RUNNING',
    health: 'HEALTHY',
    ticksReceived: 100,
    ticksPersisted: 99,
    writeErrors: 1,
  },
  marketData: {
    available: true,
    source: 'services.market_watch_engine.status_snapshot',
    error: null,
    generatedAt: '2026-01-01T10:00:00+00:00',
    state: 'RUNNING',
    health: 'HEALTHY',
    eligibleSymbols: 30,
    subscribedSymbols: 10,
    liveInstruments: 8,
  },
  health: {
    source: 'derived from the sections above',
    generatedAt: '2026-01-01T10:00:00+00:00',
    overall: 'OK',
    marketPhase: 'OPEN',
    categories: [
      { category: 'database', state: 'OK', reason: null },
      { category: 'persistence', state: 'OK', reason: null },
      { category: 'realtime', state: 'OK', reason: null },
      { category: 'session', state: 'OK', reason: null },
      { category: 'scheduler', state: 'OK', reason: null },
      { category: 'marketData', state: 'OK', reason: null },
    ],
  },
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------
test('num/str/bool never invent a value', () => {
  assert.equal(num(0), 0, 'a measured zero is a real measurement');
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num('12'), null, 'a numeric string is not a number');
  assert.equal(num(Number.NaN), null);
  assert.equal(num(Number.POSITIVE_INFINITY), null);
  assert.equal(num(-0), -0);

  assert.equal(str('atlas'), 'atlas');
  assert.equal(str(''), null);
  assert.equal(str('   '), null);
  assert.equal(str(null), null);
  assert.equal(str(7), null);

  assert.equal(bool(false), false);
  assert.equal(bool(0), null, '0 is not a boolean');
  assert.equal(bool('true'), null);
});

test('fmt helpers render an explicit marker for an unmeasured value', () => {
  assert.equal(fmtInt(null), DASH);
  assert.equal(fmtInt(null, 'N/A'), 'N/A');
  assert.equal(fmtInt(0), '0');
  assert.equal(fmtDec(null), DASH);
  assert.equal(fmtDec(1.25, 1), '1.3');
  assert.equal(fmtDuration(null), DASH);
  assert.equal(fmtDuration(-5), DASH, 'a negative duration is not a measurement');
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(90), '1m 30s');
  assert.equal(fmtBytes(null), DASH);
  assert.equal(fmtBytes(-1), DASH);
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1024), '1.00 KB');
  assert.equal(fmtAgo(null, Date.now()), DASH);
  assert.equal(fmtAgo('not-a-date', Date.now()), DASH);
  assert.equal(
    fmtAgo('2026-01-01T10:00:00+00:00', Date.parse('2026-01-01T10:02:00+00:00')),
    '2m 0s ago',
  );
});

test('humanState never replaces a missing state with a word', () => {
  assert.equal(humanState(null), 'UNKNOWN');
  assert.equal(humanState('WAITING_FOR_LOGIN'), 'Waiting for login');
  assert.equal(humanState(''), 'UNKNOWN');
});

test('stateBadge maps UNKNOWN to neutral, not to a fault', () => {
  assert.deepEqual(stateBadge('OK'), { status: 'success', label: 'OK' });
  assert.deepEqual(stateBadge('DEGRADED'), { status: 'warning', label: 'DEGRADED' });
  assert.deepEqual(stateBadge('DOWN'), { status: 'danger', label: 'DOWN' });
  assert.deepEqual(stateBadge('WAITING'), { status: 'info', label: 'WAITING' });
  assert.deepEqual(stateBadge('UNKNOWN'), { status: 'neutral', label: 'UNKNOWN' });
  assert.deepEqual(stateBadge(null), { status: 'neutral', label: 'UNKNOWN' });
  assert.deepEqual(stateBadge('SOMETHING_NEW' as never), { status: 'neutral', label: 'UNKNOWN' });
});

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------
test('the contract declares exactly nine sections and six health categories', () => {
  assert.equal(DC_SNAPSHOT_SECTIONS.length, 9);
  assert.deepEqual(
    [...DC_SNAPSHOT_SECTIONS],
    ['runtime', 'database', 'storage', 'realtime', 'session', 'scheduler', 'persistence', 'marketData', 'health'],
  );
  assert.equal(DC_HEALTH_CATEGORIES.length, 6);
  for (const name of DC_SNAPSHOT_SECTIONS) {
    assert.ok(name, 'every section has a name');
  }
});

test('a healthy payload normalises to a fully available snapshot', () => {
  const snap = normalizeSnapshot({ ok: true, data: HEALTHY_PAYLOAD });
  assert.equal(snap.schemaVersion, DC_SNAPSHOT_SCHEMA_VERSION);
  assert.ok(isCompatibleSchema(snap));
  assert.equal(snap.transportError, null);
  assert.equal(snap.overall, 'OK');
  assert.deepEqual(snap.unavailableSections, []);
  assert.equal(snap.runtime.terminalMode, 'kotak');
  assert.equal(snap.persistence.authoritative, true);
});

test('normalizeSnapshot accepts both the proxy envelope and a bare snapshot', () => {
  const enveloped = normalizeSnapshot({ ok: true, data: HEALTHY_PAYLOAD });
  const bare = normalizeSnapshot(HEALTHY_PAYLOAD);
  assert.equal(enveloped.overall, bare.overall);
  assert.equal(enveloped.database.database, bare.database.database);
  assert.equal(bare.transportError, null);
});

test('every section in a healthy snapshot carries provenance', () => {
  const snap = normalizeSnapshot(HEALTHY_PAYLOAD);
  for (const name of DC_SNAPSHOT_SECTIONS) {
    if (name === 'health') continue;
    const section = snap[name] as { source?: string };
    assert.ok(section.source && section.source.length > 0, `${name} has no source`);
  }
  assert.ok(snap.health.source.length > 0);
});

// ---------------------------------------------------------------------------
// honesty
// ---------------------------------------------------------------------------
test('a missing section is marked unavailable and never zero-filled', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  delete (payload as Record<string, unknown>).storage;
  const snap = normalizeSnapshot(payload);
  assert.equal(snap.storage.available, false);
  assert.ok(snap.unavailableSections.includes('storage'));
  assert.equal(snap.storage.documents, null);
  assert.notEqual(snap.storage.documents, 0, 'an unmeasured count must not become 0');
  assert.equal(snap.storage.collectionsCount, null);
  assert.deepEqual(snap.storage.collections, []);
  assert.equal(snap.storage.collectionsAvailable, false);
});

test('a section error survives normalisation so the page can show the reason', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.storage = { available: false, source: 'api.system.mongo_stats', error: 'collStats not permitted' } as never;
  const snap = normalizeSnapshot(payload);
  assert.equal(snap.storage.available, false);
  assert.equal(snap.storage.error, 'collStats not permitted');
});

test('an explicitly reported zero is preserved (it is a measurement)', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.storage.documents = 0;
  payload.persistence.writeErrors = 0;
  const snap = normalizeSnapshot(payload);
  assert.equal(snap.storage.documents, 0);
  assert.equal(snap.persistence.writeErrors, 0);
  assert.equal(snap.overall, 'OK');
});

test('a write error count of zero does not become null', () => {
  const snap = normalizeSnapshot(HEALTHY_PAYLOAD);
  assert.equal(snap.persistence.writeErrors, 1);
  assert.equal(snap.persistence.ticksPersisted, 99);
});

test('a total transport failure is reported, not rendered as an empty page', () => {
  const snap = normalizeSnapshot({
    ok: false,
    error: 'backend: the data center snapshot is unavailable right now',
    data: null,
  });
  assert.equal(snap.transportError, 'backend: the data center snapshot is unavailable right now');
  assert.equal(snap.overall, 'UNKNOWN');
  assert.equal(snap.unavailableSections.length, DC_SNAPSHOT_SECTIONS.length);
  assert.equal(snap.database.connected, null);
  assert.equal(snap.storage.documents, null);
});

test('a malformed payload still yields every section rather than throwing', () => {
  for (const bad of [null, undefined, 0, '', [], 'nope', { data: 5 }]) {
    const snap = normalizeSnapshot(bad);
    assert.equal(snap.schemaVersion, 0);
    assert.equal(snap.overall, 'UNKNOWN');
    for (const name of DC_SNAPSHOT_SECTIONS) {
      assert.ok(name in snap, `${name} missing from a snapshot built from ${JSON.stringify(bad)}`);
    }
  }
});

test('a snapshot with a partial section still keeps the values it does have', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.persistence = { available: true, source: 'db_writer', error: null } as never;
  const snap = normalizeSnapshot(payload);
  assert.equal(snap.persistence.available, true);
  assert.equal(snap.persistence.ticksReceived, null, 'a missing counter is null, not 0');
  assert.equal(snap.persistence.writeErrors, null);
  assert.equal(snap.persistence.state, null);
});

// ---------------------------------------------------------------------------
// realtime surfaces
// ---------------------------------------------------------------------------
test('the three realtime surfaces stay separate and independently available', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.realtime.brokerFeed = { available: false, error: 'RuntimeError: ws down' } as never;
  const snap = normalizeSnapshot(payload);
  assert.equal(snap.realtime.brokerFeed.available, false);
  assert.equal(snap.realtime.brokerFeed.error, 'RuntimeError: ws down');
  assert.equal(snap.realtime.backendRealtime.available, true, 'one dead surface must not blank the other');
  assert.equal(snap.realtime.frontendRealtime.measurable, false);
});

test('the backend never claims to have measured the browser socket', () => {
  const snap = normalizeSnapshot(HEALTHY_PAYLOAD);
  const frontend = snap.realtime.frontendRealtime;
  assert.equal(frontend.measurable, false);
  assert.ok(frontend.reason.length > 0);
  if (frontend.measurable === false) {
    assert.equal('connected' in frontend, false);
  }
});

test('a browser measurement is attached only through withFrontendRealtime', () => {
  const snap = normalizeSnapshot(HEALTHY_PAYLOAD);
  const measured = withFrontendRealtime(snap, {
    state: 'CONNECTED',
    connected: true,
    lastMessageAt: '2026-01-01T10:00:00+00:00',
    reconnectAttempts: 0,
    note: null,
  });
  const frontend = measured.realtime.frontendRealtime;
  assert.equal(frontend.measurable, true);
  if (frontend.measurable) {
    assert.equal(frontend.state, 'CONNECTED');
    assert.equal(frontend.connected, true);
    assert.equal(frontend.measuredBy, 'browser');
  }
  // The original snapshot is untouched, so no other panel can claim the value.
  assert.equal(snap.realtime.frontendRealtime.measurable, false);
});

test('withFrontendRealtime is a no-op when the browser measured nothing', () => {
  const snap = normalizeSnapshot(HEALTHY_PAYLOAD);
  assert.equal(withFrontendRealtime(snap, null), snap);
});

test('a backend payload cannot forge a browser measurement without both fields', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.realtime.frontendRealtime = { measurable: true, state: 'CONNECTED' } as never;
  const snap = normalizeSnapshot(payload);
  assert.equal(
    snap.realtime.frontendRealtime.measurable,
    false,
    'a browser state must carry connected, not just measurable',
  );
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------
test('health categories are validated against the contract', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.health.categories = [
    { category: 'database', state: 'DOWN', reason: 'mongo down' },
    { category: 'imaginary', state: 'OK', reason: null },
    { category: 'realtime', state: 'NONSENSE', reason: null },
  ] as never;
  const snap = normalizeSnapshot(payload);
  const names = snap.health.categories.map((c) => c.category);
  assert.ok(names.includes('database'));
  assert.ok(!names.includes('imaginary' as never), 'an unknown category is dropped, not rendered');
  const realtime = snap.health.categories.find((c) => c.category === 'realtime');
  assert.equal(realtime?.state, 'UNKNOWN', 'an unrecognised state degrades to UNKNOWN');
});

test('the overall verdict follows the backend, and an unknown one falls back to health', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.overall = 'DEGRADED';
  payload.health.overall = 'DEGRADED';
  assert.equal(normalizeSnapshot(payload).overall, 'DEGRADED');

  delete (payload as Record<string, unknown>).overall;
  assert.equal(normalizeSnapshot(payload).overall, 'DEGRADED');
});

test('an unavailable health rollup is visible rather than silently healthy', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.health = { available: false, source: 'derived', error: 'rollup failed' } as never;
  const snap = normalizeSnapshot(payload);
  assert.equal(snap.health.available, false);
  assert.equal(snap.health.error, 'rollup failed');
  assert.ok(snap.unavailableSections.includes('health'));
});

// ---------------------------------------------------------------------------
// storage collections
// ---------------------------------------------------------------------------
test('collection rows without a name are dropped rather than rendered blank', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.storage.collections = [{ count: 5 }, { name: 'ok', count: 1 }] as never;
  const snap = normalizeSnapshot(payload);
  assert.equal(snap.storage.collections.length, 1);
  assert.equal(snap.storage.collections[0]!.name, 'ok');
});

test('a collection count marked approximate keeps that flag', () => {
  const snap = normalizeSnapshot(HEALTHY_PAYLOAD);
  const ticks = snap.storage.collections.find((c) => c.name === 'ticks');
  const stocks = snap.storage.collections.find((c) => c.name === 'stocks');
  assert.equal(ticks?.countIsApproximate, false);
  assert.equal(stocks?.countIsApproximate, true);
});

// ---------------------------------------------------------------------------
// deep scan job
// ---------------------------------------------------------------------------
test('a started job is running with no result yet', () => {
  const job = normalizeDeepScanJob({ ok: true, jobId: 'ds-1', status: 'running', startedAt: 'x' });
  assert.equal(job?.status, 'running');
  assert.equal(job?.result, null);
  assert.equal(job?.error, null);
});

test('a completed job carries its real totals', () => {
  const job = normalizeDeepScanJob({
    ok: true,
    data: {
      jobId: 'ds-2',
      status: 'completed',
      durationMs: 4200,
      finishedAt: 'y',
      progress: null,
      error: null,
      result: {
        db: 'trading',
        totals: { collectionsCount: 3, totalObjects: 900, totalStorageBytes: 2048, totalIndexSizeBytes: 512 },
        collections: [{ name: 'ticks', count: 800, countIsApproximate: false, health: 'OK' }],
      },
    },
  });
  assert.equal(job?.status, 'completed');
  assert.equal(job?.durationMs, 4200);
  assert.equal(job?.result?.collectionsCount, 3);
  assert.equal(job?.result?.totalObjects, 900);
  assert.equal(job?.result?.collections[0]!.name, 'ticks');
});

test('a running job exposes its real progress', () => {
  const job = normalizeDeepScanJob({
    ok: true,
    data: {
      jobId: 'ds-3',
      status: 'running',
      progress: { phase: 'counting', collectionsTotal: 4, collectionsDone: 2, currentCollection: 'ticks' },
    },
  });
  assert.equal(job?.progress?.phase, 'counting');
  assert.equal(job?.progress?.collectionsDone, 2);
  assert.equal(job?.progress?.collectionsTotal, 4);
  assert.equal(job?.progress?.currentCollection, 'ticks');
});

test('a failed job surfaces the real reason', () => {
  const job = normalizeDeepScanJob({
    ok: true,
    data: { jobId: 'ds-4', status: 'failed', error: 'Deep scan timed out', durationMs: 30000 },
  });
  assert.equal(job?.status, 'failed');
  assert.match(job!.error!, /timed out/);
});

test('an unrecognised job payload yields null instead of a fake job', () => {
  assert.equal(normalizeDeepScanJob(null), null);
  assert.equal(normalizeDeepScanJob({}), null);
  assert.equal(normalizeDeepScanJob({ ok: false, error: 'gone' }), null);
  assert.equal(normalizeDeepScanJob({ data: {} }), null);
});

test('an unrecognised status degrades to running, never to completed', () => {
  const job = normalizeDeepScanJob({ ok: true, data: { jobId: 'ds-5', status: 'weird' } });
  assert.equal(job?.status, 'running');
});

// ---------------------------------------------------------------------------
// schema drift
// ---------------------------------------------------------------------------
test('a different backend schema is detectable, not silently accepted', () => {
  const payload = clone(HEALTHY_PAYLOAD);
  payload.schemaVersion = 3;
  const snap = normalizeSnapshot(payload);
  assert.equal(isCompatibleSchema(snap), false);
  assert.equal(snap.schemaVersion, 3);
});

test('a snapshot typed as DcSnapshot exposes only contract fields', () => {
  const snap: DcSnapshot = normalizeSnapshot(HEALTHY_PAYLOAD);
  const topLevel = Object.keys(snap).sort();
  assert.deepEqual(topLevel, [
    'buildMs', 'database', 'generatedAt', 'health', 'marketData', 'overall',
    'persistence', 'realtime', 'runtime', 'scheduler', 'schemaVersion',
    'session', 'storage', 'transportError', 'unavailableSections',
  ]);
});
