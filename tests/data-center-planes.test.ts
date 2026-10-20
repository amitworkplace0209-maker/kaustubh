// ---- Data Center observability-plane unit tests ----
//
// Runs on plain node (>=22.6 runs .ts natively):  npm test
// Pure module only — imported via RELATIVE path so no tsconfig path aliasing is
// required outside Next.js.
//
// The contract under test: a plane either reports real values WITH provenance,
// or reports that it is unavailable. It must never coerce a missing measurement
// into a 0, an empty list that implies "nothing exists", or a fabricated owner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DC_WIRE_SECTIONS,
  dcWireSection,
  normalizeDatabasePlane,
  normalizeDbWriterPlane,
  normalizeDcEnvelope,
  normalizeEnginesPlane,
  normalizeOwnershipPlane,
  normalizeRetentionPlane,
  normalizeTopologyPlane,
} from '../lib/data-center.ts';

// ---------------------------------------------------------------------------
// database plane
// ---------------------------------------------------------------------------

test('database plane normalizes identity, storage and pool counters', () => {
  const p = normalizeDatabasePlane({
    plane: 'database',
    source: 'database.connection.get_mongo_info + api.system.mongo_stats + serverStatus whitelist',
    generatedAt: '2024-12-01T10:00:00+05:30',
    available: true,
    error: null,
    identity: {
      connected: true,
      source: 'atlas',
      sourceLabel: 'mongodb-atlas',
      database: 'kaustubh',
      host: 'cluster0.example.mongodb.net',
      serverVersion: '7.0.14',
      connectedAt: '2024-12-01T09:00:00+05:30',
      configured: true,
      error: null,
    },
    pool: { created: 4, ready: 3, closed: 1, cleared: 0, checkout_failed: 0 },
    serverStatus: {
      available: true,
      error: null,
      uptimeSeconds: 98765,
      connections: { current: 12, available: 88, totalCreated: 140 },
      network: { bytesIn: 2048, bytesOut: 4096, numRequests: 77 },
    },
    storage: {
      dbName: 'kaustubh',
      collectionsCount: 36,
      indexesCount: 91,
      totalObjects: 1234,
      totalSizeBytes: 1048576,
      totalStorageBytes: 2097152,
      totalIndexSizeBytes: 524288,
      pingMs: 3.2,
      lastUpdatedAt: '2024-12-01T09:59:00+05:30',
    },
  });

  assert.ok(p);
  assert.equal(p.plane, 'database');
  assert.equal(p.available, true);
  assert.equal(p.identity.source, 'atlas');
  assert.equal(p.identity.database, 'kaustubh');
  assert.equal(p.pool.ready, 3);
  assert.equal(p.serverStatus.connections?.current, 12);
  assert.equal(p.storage?.totalObjects, 1234);
});

test('database plane reports NOT AVAILABLE instead of zeros when Mongo is down', () => {
  const p = normalizeDatabasePlane({
    plane: 'database',
    source: 'database.connection.get_mongo_info',
    available: false,
    error: 'MongoDB is not connected',
    identity: { connected: false, source: 'unknown', database: null, configured: false },
    pool: {},
    serverStatus: { available: false, error: 'MongoDB is not connected' },
    storage: null,
  });

  assert.ok(p);
  assert.equal(p.available, false);
  assert.equal(p.error, 'MongoDB is not connected');
  // The absence must stay an absence — never 0 objects or an empty host string.
  assert.equal(p.storage, null);
  assert.equal(p.identity.database, null);
  assert.equal(p.identity.host, null);
  assert.equal(p.serverStatus.connections, undefined);
  assert.equal(p.serverStatus.uptimeSeconds, null);
});

test('database plane rejects a payload that is not a plane at all', () => {
  assert.equal(normalizeDatabasePlane(null), null);
  assert.equal(normalizeDatabasePlane({}), null);
});

// ---------------------------------------------------------------------------
// engines + topology planes
// ---------------------------------------------------------------------------

test('engines plane keeps the authoritative owner and documents undocumented engines', () => {
  const p = normalizeEnginesPlane({
    plane: 'engines',
    source: 'services.engine_registry.EngineRegistry',
    available: true,
    error: null,
    summary: { overall: 'DEGRADED', total: 18, states: { RUNNING: 17 }, healths: { HEALTHY: 17, DEGRADED: 1 } },
    undocumentedCount: 1,
    documented: [
      {
        engineId: 'db_writer_engine',
        engineName: 'DB Writer Engine',
        category: 'storage',
        version: '1.0.0',
        state: 'RUNNING',
        health: 'HEALTHY',
        healthReason: null,
        lastHeartbeat: '2024-12-01T10:00:00+05:30',
        lastHeartbeatAt: '2024-12-01T10:00:00+05:30',
        uptimeSeconds: 3600,
        dependencies: ['storage_engine'],
        dependents: [],
        registered: true,
        owner: 'DB Writer Engine',
        plane: 'tick persistence pipeline (authoritative writer)',
        endpoint: '/api/services/engines/db_writer_engine',
        documented: true,
      },
      {
        engineId: 'mystery_engine',
        state: 'UNKNOWN',
        health: 'UNKNOWN',
        dependencies: [],
        dependents: [],
        registered: true,
        owner: 'UNMAPPED',
        plane: 'NOT DOCUMENTED',
        documented: false,
      },
    ],
  });

  assert.ok(p);
  assert.equal(p.documented.length, 2);
  assert.equal(p.documented[0]!.owner, 'DB Writer Engine');
  assert.deepEqual(p.documented[0]!.dependencies, ['storage_engine']);
  assert.equal(p.documented[1]!.documented, false);
  assert.equal(p.documented[1]!.owner, 'UNMAPPED');
  assert.equal(p.undocumentedCount, 1);
  assert.equal(p.summary?.overall, 'DEGRADED');
});

test('topology plane maps nodes and dependency edges', () => {
  const p = normalizeTopologyPlane({
    plane: 'topology',
    source: 'services.engine_registry.EngineRegistry',
    available: true,
    nodeCount: 2,
    edgeCount: 1,
    nodes: [
      { id: 'storage_engine', name: 'Storage Engine', category: 'storage', state: 'RUNNING', health: 'HEALTHY', documented: true, owner: 'Storage Engine', dependencyCount: 0, dependentCount: 1 },
      { id: 'db_writer_engine', name: 'DB Writer Engine', category: 'storage', state: 'RUNNING', health: 'HEALTHY', documented: true, owner: 'DB Writer Engine', dependencyCount: 1, dependentCount: 0 },
    ],
    edges: [{ from: 'storage_engine', to: 'db_writer_engine', kind: 'depends_on', fromHealth: 'HEALTHY', toHealth: 'HEALTHY' }],
    orphans: [],
  });

  assert.ok(p);
  assert.equal(p.nodes.length, 2);
  assert.equal(p.edges.length, 1);
  assert.equal(p.edges[0]!.kind, 'depends_on');
  assert.equal(p.nodeCount, 2);
  assert.deepEqual(p.orphans, []);
});

// ---------------------------------------------------------------------------
// db writer plane
// ---------------------------------------------------------------------------

test('db writer plane republishes the writer own counters and permissions', () => {
  const p = normalizeDbWriterPlane({
    plane: 'dbwriter',
    source: 'services.db_writer_engine.DBWriterEngine.status_snapshot',
    available: true,
    authoritative: true,
    engineId: 'db_writer_engine',
    state: 'RUNNING',
    health: 'HEALTHY',
    pipeline: { totalWritten: 5000, bufferLength: 12, ticksPerSecond: 3.5, totalWriteErrors: 0 },
    dataLoss: {
      received: 100,
      duplicates: 5,
      invalid: 5,
      accepted: 90,
      written: 80,
      writeFailed: 0,
      pending: 10,
      reconciliation: { receivedEqualsSum: true, acceptedEqualsSum: true },
    },
    permissions: [
      {
        key: 'personalOneDay',
        label: 'Personal Stocks — 1-Day Expiry',
        collection: 'dbw_personal_expiry_ticks',
        enabled: true,
        storageCap: true,
        hardCapped: false,
        capReason: 'operator cap',
      },
    ],
    capReason: 'operator cap',
  });

  assert.ok(p);
  assert.equal(p.available, true);
  assert.equal(p.authoritative, true);
  assert.equal(p.engineId, 'db_writer_engine');
  assert.equal(p.permissions.length, 1);
  assert.equal(p.permissions[0]!.enabled, true);
  assert.equal(p.permissions[0]!.storageCap, true);
  assert.equal(p.permissions[0]!.capReason, 'operator cap');
});

test('db writer plane stays null-safe when the writer reported nothing', () => {
  const p = normalizeDbWriterPlane({
    plane: 'dbwriter',
    available: false,
    error: 'DB Writer did not report a status snapshot',
    permissions: [],
  });

  assert.ok(p);
  assert.equal(p.available, false);
  assert.equal(p.pipeline, null);
  assert.equal(p.dataLoss, null);
  assert.deepEqual(p.permissions, []);
});

// ---------------------------------------------------------------------------
// ownership + retention planes
// ---------------------------------------------------------------------------

test('ownership plane marks unowned collections UNMAPPED rather than guessing', () => {
  const p = normalizeOwnershipPlane({
    plane: 'ownership',
    source: 'static write-path audit',
    available: true,
    count: 2,
    liveCount: 1,
    totalStorageBytes: 2048,
    undocumented: ['mystery_collection'],
    collections: [
      {
        name: 'ticks',
        namespace: 'kaustubh.ticks',
        documents: 1000,
        storageBytes: 2048,
        owner: 'DB Writer Engine',
        module: 'services/db_writer_engine.py',
        retention: 'TTL index',
        basis: 'db.ticks.bulk_write in DBWriterEngine',
        documented: true,
        present: true,
      },
      {
        name: 'mystery_collection',
        namespace: 'kaustubh.mystery_collection',
        documents: 5,
        storageBytes: 16,
        owner: 'UNMAPPED',
        retention: 'NOT VERIFIED',
        documented: false,
        present: true,
      },
    ],
  });

  assert.ok(p);
  assert.equal(p.collections[0]!.owner, 'DB Writer Engine');
  assert.equal(p.collections[1]!.owner, 'UNMAPPED');
  assert.equal(p.collections[1]!.retention, 'NOT VERIFIED');
  assert.deepEqual(p.undocumented, ['mystery_collection']);
});

test('retention plane lists real TTL indexes and the cleanup contract', () => {
  const p = normalizeRetentionPlane({
    plane: 'retention',
    source: 'MongoDB index_information() expireAfterSeconds',
    available: true,
    ttlIndexCount: 1,
    scannedCollections: 36,
    ttlIndexes: [
      {
        collection: 'dbw_personal_expiry_ticks',
        index: 'expiry_1',
        field: 'expiry',
        expireAfterSeconds: 86400,
        owner: 'DB Writer Engine',
      },
    ],
    cleanup: { enabled: true, schedule: '06:00 IST daily', nextCleanup: '2024-12-02T06:00:00+05:30', last: { status: 'COMPLETED', totalDeleted: 42 } },
    snapshots: { collection: 'data_center_snapshots', intervalSeconds: 600, running: true },
  });

  assert.ok(p);
  assert.equal(p.ttlIndexCount, 1);
  assert.equal(p.ttlIndexes[0]!.expireAfterSeconds, 86400);
  assert.equal(p.cleanup?.enabled, true);
});

test('retention plane reports no TTL indexes honestly when none exist', () => {
  const p = normalizeRetentionPlane({
    plane: 'retention',
    available: true,
    ttlIndexCount: 0,
    scannedCollections: 12,
    ttlIndexes: [],
    cleanup: null,
    snapshots: null,
  });

  assert.ok(p);
  assert.deepEqual(p.ttlIndexes, []);
  assert.equal(p.ttlIndexCount, 0);
  // A missing cleanup status must stay null, not become an empty object.
  assert.equal(p.cleanup, null);
});

// ---------------------------------------------------------------------------
// envelope integration — the store's merge-in-place contract
// ---------------------------------------------------------------------------

test('envelope carries every plane independently so one failure never blanks the rest', () => {
  const n = normalizeDcEnvelope({
    ok: true,
    generatedAt: '2024-12-01T10:00:00Z',
    overview: { ok: true, data: { generatedAt: '2024-12-01T10:00:00Z', mongo: { connected: true } } },
    database: { ok: true, data: { plane: 'database', available: true, identity: { connected: true } } },
    // ownership failed — everything else must survive
    ownership: { ok: false, error: 'backend returned 503' },
    retention: { ok: true, data: { plane: 'retention', available: true, ttlIndexes: [] } },
  });

  assert.equal(n.databaseError, null);
  assert.ok(n.database);
  assert.equal(n.ownership, null);
  assert.equal(n.ownershipError, 'backend returned 503');
  assert.equal(n.retentionError, null);
  assert.ok(n.retention);
  assert.ok(n.present.includes('database'));
  assert.ok(n.present.includes('ownership'));
  assert.ok(n.present.includes('retention'));
  // Sections absent from this payload are simply not "present", so the store
  // keeps its last valid value instead of blanking it.
  assert.equal(n.present.includes('topology'), false);
  assert.equal(n.topology, null);
  assert.equal(n.topologyError, null);
});

// ---------------------------------------------------------------------------
// wire-name contract — the proxy SILENTLY drops names it does not know, so a
// typo freezes a panel at its last value with no error anywhere.
// ---------------------------------------------------------------------------

test('every wire section name is actually served by the proxy route', () => {
  const src = readFileSync(
    new URL('../app/api/phase2/data-center/route.ts', import.meta.url),
    'utf8',
  );
  const block = src.slice(src.indexOf('const SECTIONS'), src.indexOf('type SectionName'));
  // Keys are either bare identifiers or quoted (`'api-telemetry'`).
  const served = new Set(
    [...block.matchAll(/^\s{2}(?:([A-Za-z][\w-]*)|'([\w-]+)'):\s*\{/gm)].map((m) => m[1] ?? m[2]),
  );
  assert.ok(served.size >= DC_WIRE_SECTIONS.length, `only found ${served.size} section keys`);

  for (const wire of DC_WIRE_SECTIONS) {
    assert.ok(served.has(wire), `proxy does not serve section "${wire}" — it would be silently dropped`);
  }
  for (const servedName of served) {
    assert.ok(
      (DC_WIRE_SECTIONS as readonly string[]).includes(servedName),
      `proxy serves "${servedName}" but it is not in DC_WIRE_SECTIONS`,
    );
  }
});

test('wire section names map 1:1 onto state keys', () => {
  for (const key of [
    'overview', 'history', 'ticks', 'trend', 'snapshots', 'apiTelemetry',
    'cleanup', 'database', 'engines', 'topology', 'dbWriter', 'ownership', 'retention',
  ] as const) {
    assert.equal(typeof dcWireSection(key), 'string');
  }
  // The bug this guards: 'dbwriter' (state) vs 'dbWriter' (wire) are NOT the
  // same string, so a case-insensitive match is required for the lookup to work.
  assert.equal(dcWireSection('dbWriter'), 'dbWriter');
  assert.equal(dcWireSection('apiTelemetry'), 'api-telemetry');
  assert.equal(DC_WIRE_SECTIONS.includes('dbwriter' as never), false);
});
