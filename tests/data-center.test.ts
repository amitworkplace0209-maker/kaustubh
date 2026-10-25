// ---- Data Center lib unit tests (Phase 24) ----
//
// Runs on plain node (>=22.6 runs .ts natively):  npm test
// Pure module only — imported via RELATIVE path so no tsconfig path
// aliasing is required outside Next.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LATENCY_BANDS,
  clockLabel,
  collectionHealthTone,
  fmtBytes,
  fmtCompact,
  fmtIst,
  fmtNumber,
  fmtUptime,
  int,
  iso,
  latencyTone,
  normalizeApiTelemetry,
  normalizeCollectionDetail,
  normalizeDcEnvelope,
  normalizeDcOverview,
  normalizeHistoryPayload,
  normalizeSnapshotsPayload,
  normalizeTicksPayload,
  normalizeTrendPayload,
  num,
  shortDate,
  str,
  sumRows,
  validSeries,
  workerTone,
  bool,
} from '../lib/data-center.ts';
import type { DcDailyRow } from '../lib/data-center.ts';

test('num/int/bool/str/iso coercers are null-safe and never throw', () => {
  assert.equal(num(12), 12);
  assert.equal(num('12.5'), 12.5);
  assert.equal(num('abc'), null);
  assert.equal(num(0), 0);
  assert.equal(num(undefined), null);
  assert.equal(num(null), null);

  assert.equal(int('12.9'), 12);
  assert.equal(int('abc'), null);
  assert.equal(int(Infinity), null);
  assert.equal(int(null), null);

  assert.equal(bool(true), true);
  assert.equal(bool(false), false);
  assert.equal(bool(0), false);
  assert.equal(bool(undefined), false);

  assert.equal(str('x'), 'x');
  assert.equal(str(''), null);
  assert.equal(str(5), null);

  assert.equal(iso('2024-12-01T10:00:00+05:30'), '2024-12-01T10:00:00+05:30');
  assert.equal(iso('not-a-date'), null);
  assert.equal(iso(''), null);
});

test('collectionHealthTone maps every documented status', () => {
  assert.equal(collectionHealthTone('HEALTHY'), 'ok');
  assert.equal(collectionHealthTone('INDEX_HEAVY'), 'warn');
  assert.equal(collectionHealthTone('HIGH_STORAGE'), 'warn');
  assert.equal(collectionHealthTone('STALE'), 'err');
  assert.equal(collectionHealthTone('ERROR'), 'err');
  assert.equal(collectionHealthTone('UNKNOWN'), 'na');
  assert.equal(collectionHealthTone(null), 'na');
  assert.equal(collectionHealthTone(undefined), 'na');
});

test('workerTone maps status to expected tone', () => {
  assert.equal(workerTone('RUNNING'), 'ok');
  assert.equal(workerTone('IDLE'), 'na');
  assert.equal(workerTone('NOT_STARTED'), 'na');
  assert.equal(workerTone('DEGRADED'), 'warn');
  assert.equal(workerTone('FAILED'), 'err');
  assert.equal(workerTone('STOPPED'), 'err');
});

test('latencyTone respects the shared band constants', () => {
  assert.equal(latencyTone(10), 'ok');
  assert.equal(latencyTone(100), 'ok');
  assert.equal(latencyTone(249.9), 'ok');
  assert.equal(latencyTone(250), 'warn');
  assert.equal(latencyTone(400), 'warn');
  assert.equal(latencyTone(600), 'err');
  assert.equal(latencyTone(900), 'err');
  assert.equal(latencyTone(null), 'na');
  assert.equal(LATENCY_BANDS.warningMs, 250);
  assert.equal(LATENCY_BANDS.criticalMs, 600);
});

test('sumRows adds a numeric column ignoring nulls', () => {
  const rows = [
    { date: 'a', ticksWritten: 10, uniqueSymbols: null, apiErrors: null },
    { date: 'b', ticksWritten: 15, uniqueSymbols: 12, apiErrors: 3 },
    { date: 'c', ticksWritten: null, uniqueSymbols: 8, apiErrors: 0 },
  ] as DcDailyRow[];
  assert.equal(sumRows(rows, 'ticksWritten'), 25);
  assert.equal(sumRows(rows, 'uniqueSymbols'), 20);
  assert.equal(sumRows(rows, 'apiErrors'), 3);
  assert.equal(sumRows(rows, 'schedulerFailed'), 0);
});

test('shortDate is IST-stable and tolerant of garbage', () => {
  assert.equal(shortDate('2024-12-01T18:30:00+05:30'), '2024-12-01');
  assert.equal(shortDate('2024-01-05T00:00:00Z'), '2024-01-05');
  assert.equal(shortDate(null), '—');
  assert.equal(shortDate('nope'), '—');
});

test('clockLabel renders HH:MM and returns empty for invalid', () => {
  assert.equal(clockLabel('2024-12-01T09:05:00+05:30'), '09:05');
  assert.equal(clockLabel('nope'), '');
  assert.equal(clockLabel(null), '');
});

test('fmtIst renders IST 24h timestamps and N/A for null', () => {
  const s = fmtIst('2024-12-01T18:30:00+05:30');
  assert.ok(s.includes('2024'), `fmtIst -> ${s}`);
  assert.ok(s.includes('18:30:00') || s.includes('18:30:'), `fmtIst -> ${s}`);
  assert.equal(fmtIst(null), 'N/A');
});

// ---------------------------------------------------------------------------
// Formatting — deterministic values (locale-independent inputs)
// ---------------------------------------------------------------------------

test('fmtBytes renders B/KB/MB/GB and nulls', () => {
  const cases: [number | null, string][] = [
    [null, 'N/A'],
    [0, 'N/A'],
    [512, '512 B'],
    [1500, '1.5 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [3.5 * 1024 * 1024 * 1024, '3.50 GB'],
  ];
  for (const [b, expected] of cases) {
    assert.equal(fmtBytes(b), expected, `fmtBytes(${b})`);
  }
});

test('fmtNumber renders Indian grouping and N/A', () => {
  assert.equal(fmtNumber(1_000_000), '10,00,000');
  assert.equal(fmtNumber(1234), '1,234');
  assert.equal(fmtNumber(0), '0');
  assert.equal(fmtNumber(null), 'N/A');
  assert.equal(fmtNumber(Infinity), 'N/A');
});

test('fmtCompact renders Cr/L/K and N/A', () => {
  assert.equal(fmtCompact(1e7), '1.00Cr');
  assert.equal(fmtCompact(150_000), '1.50L');
  assert.equal(fmtCompact(2_500), '2.50K');
  assert.equal(fmtCompact(42), '42');
  assert.equal(fmtCompact(null), 'N/A');
});

test('fmtUptime renders d/h/m/s durations', () => {
  assert.equal(fmtUptime(0), '0s');
  assert.equal(fmtUptime(59), '59s');
  assert.equal(fmtUptime(61), '1m 1s');
  assert.equal(fmtUptime(3723), '1h 2m');
  assert.equal(fmtUptime(90061), '1d 1h 1m');
  assert.equal(fmtUptime(null), 'N/A');
  assert.equal(fmtUptime(-5), 'N/A');
});

// ---------------------------------------------------------------------------
// Normalizers — every value maps straight from a REAL backend payload
// ---------------------------------------------------------------------------

const SAMPLE_OVERVIEW = {
  generatedAt: '2024-12-01T09:00:00+05:30',
  istNow: '2024-12-01T09:00:00+05:30',
  mongo: {
    connected: true,
    pingMs: 3.2,
    dbName: 'kaustubh',
    collectionsCount: 5,
    indexesCount: 9,
    totalObjects: 1200,
    totalDataSizeBytes: 5120,
    totalStorageBytes: 4096,
    totalIndexSizeBytes: 2048,
    lastUpdatedAt: '2024-12-01T09:00:00+05:30',
    collections: [
      {
        name: 'ticks',
        count: 1000,
        sizeBytes: 4000,
        storageBytes: 3500,
        indexSizeBytes: 1500,
        indexes: 2,
        ns: 'kaustubh.ticks',
        avgObjSizeBytes: 4,
        capped: false,
        hasTimeField: true,
        firstRecord: '2024-12-01T08:00:00+05:30',
        lastRecord: '2024-12-01T09:00:00+05:30',
        health: { status: 'HEALTHY', reasons: [] },
      },
      {
        name: 'heavy_coll',
        count: 10,
        sizeBytes: 100,
        storageBytes: 90000000, // HIGH_STORAGE territory
        indexSizeBytes: 50,
        indexes: 1,
        ns: 'kaustubh.heavy_coll',
        health: { status: 'HIGH_STORAGE', reasons: ['storage > 16MB'] },
      },
    ],
  },
  system: {
    runtimeState: 'RUNNING',
    uptimeSeconds: 3723,
    cpuPercent: 42.5,
    cpuLoad1m: 1.2,
    ramPercent: 63.0,
    ramTotalBytes: 8589934592,
    ramUsedBytes: 5411658792,
    diskPercent: 71.3,
    diskTotalBytes: 100000000000,
    diskUsedBytes: 71300000000,
    internet: true,
    processStartedAt: '2024-12-01T07:58:00+05:30',
  },
  pipeline: {
    running: true,
    totalReceived: 50000,
    totalWritten: 49900,
    totalWriteErrors: 12,
    bufferLength: 30,
    ticksPerSecond: 12.4,
    writesPerSecond: 11.9,
    activeTickStocks: 220,
    startedAt: '2024-12-01T08:00:00+05:30',
    lastWriteAt: '2024-12-01T09:00:00+05:30',
    lastError: null,
    feedLatencyMs: 8.5,
  },
  websocket: {
    connected: true,
    lifecycleState: 'CONNECTED',
    subscribedSymbols: 210,
    reconnectCount: 1,
    disconnectReason: null,
  },
  scheduler: {
    running: true,
    enabled: true,
    state: 'LOGGED_IN',
    nextAction: 'WS_CONNECT',
    loginAt: '2024-12-01T09:00:00',
    logoutAt: '2024-12-01T16:00:00',
    wsConnectAt: '2024-12-01T09:13:00',
    wsDisconnectAt: '2024-12-01T15:31:00',
    isTradingDay: true,
  },
  storage: {
    exportsBytes: 20480,
    logsBytes: 10240,
    exportDirPresent: true,
    dbStorageBytes: 4096,
    dbIndexBytes: 2048,
    diskPercent: 71.3,
  },
  api: {
    requests: 1220,
    errors: 4,
    clientErrors: 3,
    serverErrors: 1,
    avgLatencyMs: 45.6,
    health: 'HEALTHY',
  },
  dailyWriteHistory: [
    { date: '2024-12-01', ticksWritten: 49000, uniqueSymbols: 210, schedulerRuns: 4, schedulerCompleted: 4, schedulerFailed: 0, apiRequests: 1200, apiErrors: 4, apiClientErrors: 3, apiServerErrors: 1, apiAvgLatencyMs: 45.6, downloads: 3, auditEntries: 12, systemEvents: 8, summaryTotalWrites: 49001, summaryTotalTicks: 48999, summaryErrorCount: 0 },
    { date: '2024-12-02', ticksWritten: null, uniqueSymbols: null, schedulerRuns: 0, schedulerCompleted: 0, schedulerFailed: 0, apiRequests: 0, apiErrors: 0, apiClientErrors: 0, apiServerErrors: 0, apiAvgLatencyMs: null, downloads: 0, auditEntries: 0, systemEvents: 0, summaryTotalWrites: null, summaryTotalTicks: null, summaryErrorCount: null },
  ],
  ticks: { total: 49000, today: 30000 },
  workers: [
    { id: 'tick_pipeline', name: 'Tick pipeline', category: 'pipeline', status: 'RUNNING', running: true, lastHeartbeat: '2024-12-01T08:59:00+05:30', detail: { totalWritten: 49000 } },
    { id: 'ws_supervisor', name: 'WebSocket supervisor', category: 'websocket', status: 'IDLE', running: false, lastHeartbeat: null, detail: { connected: false } },
  ],
  events: {
    count: 2,
    rows: [
      { ts: '2024-12-01T09:00:00+05:30', source: 'scheduler', event: 'LOGIN', status: 'ok', message: 'Logged in' },
      { ts: '2024-12-01T09:13:00+05:30', source: 'ws', event: 'CONNECT', status: 'error', message: 'reconnect 1' },
    ],
  },
  alerts: { activeIncidents: 1, activeQualityIssues: 2 },
};

test('normalizeDcOverview maps a real payload with nulls preserved', () => {
  const o = normalizeDcOverview(SAMPLE_OVERVIEW);
  assert.ok(o);
  assert.equal(o!.mongo.connected, true);
  assert.equal(o!.mongo.dbName, 'kaustubh');
  assert.equal(o!.mongo.collections.length, 2);
  assert.equal(o!.mongo.collections[0].health.status, 'HEALTHY');
  assert.equal(o!.mongo.collections[1].health.reasons[0], 'storage > 16MB');
  assert.equal(o!.system.diskPercent, 71.3);
  assert.equal(o!.pipeline.feedLatencyMs, 8.5);
  assert.equal(o!.websocket.lifecycleState, 'CONNECTED');
  assert.equal(o!.scheduler.state, 'LOGGED_IN');
  assert.equal(o!.api!.requests, 1220);
  assert.equal(o!.ticks.total, 49000);
  assert.equal(o!.workers[1].status, 'IDLE');
  assert.equal(o!.events.rows[1].status, 'error');
  assert.equal(o!.alerts.activeIncidents, 1);
  assert.equal(o!.dailyWriteHistory[1].ticksWritten, null, 'missing value must stay null, not 0');
});

test('normalizeDcOverview rejects an empty payload (nothing fabricated)', () => {
  assert.equal(normalizeDcOverview({}), null);
  assert.equal(normalizeDcOverview(null), null);
});

test('normalizeDcOverview tolerates a disconnected-but-real payload', () => {
  const o = normalizeDcOverview({ generatedAt: '2024-12-01T09:00:00+05:30', mongo: { connected: false }, system: {}, storage: {}, ticks: {} });
  assert.ok(o);
  assert.equal(o!.mongo.connected, false);
  assert.equal(o!.system.diskPercent, null);
});

test('normalizeHistoryPayload keeps empty rows as valid', () => {
  assert.equal(normalizeHistoryPayload({ days: 0, rows: [] })!.rows.length, 0);
  assert.equal(normalizeHistoryPayload({}), null);
});

test('normalizeTicksPayload maps points and defaults resolution', () => {
  const t = normalizeTicksPayload({
    hours: 24,
    points: [{ timestamp: '2024-12-01T09:00:00+05:30', received: 100, written: 98, errors: 2 }],
  });
  assert.ok(t);
  assert.equal(t!.hours, 24);
  assert.equal(t!.resolutionMin, 1);
  assert.equal(t!.points[0].written, 98);
  assert.equal(normalizeTicksPayload({}), null);
});

test('normalizeTrendPayload maps bytes and nulls', () => {
  const t = normalizeTrendPayload({
    days: 14,
    points: [{ ts: '2024-12-01T09:00:00+05:30', istDay: '2024-12-01', dbTotalStorageBytes: 4096, dbTotalIndexBytes: 2048, diskUsedBytes: 100, diskPercent: 71.3 }],
  });
  assert.ok(t);
  assert.equal(t!.points[0].dbTotalStorageBytes, 4096);
  assert.equal(t!.points[0].istDay, '2024-12-01');
});

test('normalizeSnapshotsPayload unwraps nested db/storage', () => {
  const s = normalizeSnapshotsPayload({
    points: [
      { ts: '2024-12-01T09:00:00+05:30', istDay: '2024-12-01', mode: 'manual', db: { totalStorageBytes: 4096, totalIndexSizeBytes: 2048, totalObjects: 1200, pingMs: 3.2 }, storage: { diskUsedBytes: 100, diskPercent: 71.3 } },
    ],
  });
  assert.ok(s);
  assert.equal(s!.count, 1);
  assert.equal(s!.points[0].dbTotalStorageBytes, 4096);
  assert.equal(s!.points[0].mode, 'manual');
  assert.equal(s!.points[0].diskPercent, 71.3);
});

test('normalizeCollectionDetail pulls index names and sample rows', () => {
  const d = normalizeCollectionDetail({
    name: 'ticks',
    ns: 'kaustubh.ticks',
    count: 1000,
    sizeBytes: 4000,
    storageBytes: 3500,
    indexSizeBytes: 1500,
    indexes: 2,
    capped: false,
    indexNames: ['_id_', 'ts_1'],
    hasTimeField: true,
    firstRecord: '2024-12-01T08:00:00+05:30',
    lastRecord: '2024-12-01T09:00:00+05:30',
    sample: [{ ts: '2024-12-01T09:00:00+05:30', price: 100 }],
  });
  assert.ok(d);
  assert.equal(d!.indexNames.length, 2);
  assert.equal(d!.sample[0].price, 100);
  assert.equal(normalizeCollectionDetail({}), null);
});

test('normalizeDcEnvelope isolates per-section failures', () => {
  const raw = {
    generatedAt: '2024-12-01T09:00:00+05:30',
    overview: { ok: true, data: SAMPLE_OVERVIEW },
    history: { ok: true, data: { days: 14, rows: SAMPLE_OVERVIEW.dailyWriteHistory } },
    ticks: { ok: false, error: 'backend returned 502' },
    trend: { ok: true, data: { days: 14, points: [] } },
    snapshots: { ok: false, error: 'timeout' },
  };
  const n = normalizeDcEnvelope(raw);
  assert.ok(n.overview);
  assert.ok(n.history);
  assert.equal(n.ticks, null);
  assert.equal(n.ticksError, 'backend returned 502');
  assert.equal(n.trend!.points.length, 0);
  assert.equal(n.trendError, null);
  assert.equal(n.snapshots, null);
  assert.equal(n.snapshotsError, 'timeout');
  assert.equal(n.generatedAt, '2024-12-01T09:00:00+05:30');
});

test('normalizeDcEnvelope present lists only sections shipped in this payload', () => {
  const n = normalizeDcEnvelope({
    overview: { ok: true, data: SAMPLE_OVERVIEW },
    trend: { ok: true, data: { days: 14, points: [] } },
    apiTelemetry: { ok: true, data: { hasData: true, requests: 10, endpoints: [] } },
  });
  assert.deepEqual(n.present, ['overview', 'trend', 'apiTelemetry']);
  // Ticks/snapshots/history are NOT shipped -> must not be applied on merge.
  assert.ok(!n.present.includes('ticks'));
  assert.ok(!n.present.includes('snapshots'));
  assert.ok(!n.present.includes('history'));
});

test('normalizeApiTelemetry maps the real summary shape', () => {
  const t = normalizeApiTelemetry({
    hours: 24,
    hasData: true,
    requests: 11756,
    errors: 242,
    success: 11514,
    successPct: 97.94,
    errorPct: 2.06,
    avgLatencyMs: 400.91,
    p50Ms: 120,
    p95Ms: 980,
    p99Ms: 2400,
    clientErrors: 210,
    serverErrors: 32,
    dbRelatedFailures: 0,
    endpoints: [
      { route: '/api/system/overview', requests: 9000, errors: 10, clientErrors: 9, serverErrors: 1, success: 8990, successPct: 99.89, avgMs: 312.4 },
    ],
    recentErrors: [
      { ts: '2024-12-01T09:00:00+05:30', route: '/api/x', errors: 3, clientErrors: 3, serverErrors: 0, avgLatencyMs: 2100, dbRelated: true },
    ],
  });
  assert.ok(t);
  assert.equal(t!.hours, 24);
  assert.equal(t!.requests, 11756);
  assert.equal(t!.p95Ms, 980);
  assert.equal(t!.endpoints[0].successPct, 99.89);
  assert.equal(t!.recentErrors[0].errors, 3);
  assert.equal(t!.recentErrors[0].dbRelated, true);
});

test('normalizeApiTelemetry keeps hasData=false views valid and rejects non-views', () => {
  const empty = normalizeApiTelemetry({ hasData: false, requests: 0, errors: 0, endpoints: [] });
  assert.ok(empty);
  assert.equal(empty!.hasData, false);
  assert.equal(empty!.requests, 0);
  assert.equal(empty!.hours, 24);
  assert.equal(normalizeApiTelemetry({}), null);
  assert.equal(normalizeApiTelemetry(null), null);
});

test('validSeries drops bad/invalid points and sorts oldest first', () => {
  const { cleaned, dropped } = validSeries(
    [
      { date: '2024-12-03', ticksWritten: 40 },
      { date: '2024-12-01', ticksWritten: 20 },
      { date: 'garbage', ticksWritten: 999 },
      { date: '2024-12-02', ticksWritten: null },
      { date: '2024-12-01', ticksWritten: 25 },
    ],
    'date',
    ['ticksWritten'],
  );
  assert.equal(dropped, 2); // garbage ts + all-null row
  assert.deepEqual(cleaned.map((r) => r.date), ['2024-12-01', '2024-12-03']);
  assert.equal(cleaned[0].ticksWritten, 25); // duplicate kept the last value
});

test('validSeries empty input yields empty cleaned set', () => {
  const { cleaned, dropped } = validSeries([], 'ts', ['a']);
  assert.equal(cleaned.length, 0);
  assert.equal(dropped, 0);
});