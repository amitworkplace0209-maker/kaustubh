// ---- Data Center: normalized state for the Downloads data-management page ----
//
// ONE set of pure normalizers for the consolidated Data Center API
// (GET /api/system/data-center/*, proxied by app/api/phase2/data-center).
// Every value maps straight from a REAL backend measurement; a missing value
// normalizes to null so the UI can render "not available" WITHOUT fabricating
// a number. The store hook lives in lib/data-center-store.ts — this module is
// intentionally React-free so it can be unit-tested with `node --test`.

// ---------------------------------------------------------------------------
// Threshold semantics (kept out of JSX)
// ---------------------------------------------------------------------------

/** Collection health states as returned by the backend. */
export type DcHealthStatus =
  | 'HEALTHY'
  | 'INDEX_HEAVY'
  | 'HIGH_STORAGE'
  | 'STALE'
  | 'ERROR'
  | 'UNKNOWN';

export type DcHealthTone = 'ok' | 'warn' | 'err' | 'na';

/** Semantic tone for a collection health status (presentation only). */
export function collectionHealthTone(status: string | null | undefined): DcHealthTone {
  switch (status) {
    case 'HEALTHY':
      return 'ok';
    case 'INDEX_HEAVY':
    case 'HIGH_STORAGE':
      return 'warn';
    case 'STALE':
    case 'ERROR':
      return 'err';
    default:
      return 'na';
  }
}

export type WorkerTone = 'ok' | 'warn' | 'err' | 'na';

export function workerTone(status: string | null | undefined): WorkerTone {
  switch (status) {
    case 'RUNNING':
      return 'ok';
    case 'IDLE':
    case 'NOT_STARTED':
      return 'na';
    case 'DEGRADED':
      return 'warn';
    default:
      return 'err';
  }
}

/** Latency band semantics shared by cards (ms). */
export const LATENCY_BANDS = { warningMs: 250, criticalMs: 600 } as const;

// ---------------------------------------------------------------------------
// Types (strong — the UI boundary never sees `any`)
// ---------------------------------------------------------------------------

export interface DcCollection {
  name: string;
  count: number | null;
  sizeBytes: number | null;
  storageBytes: number | null;
  indexSizeBytes: number | null;
  indexes: number | null;
  ns: string | null;
  avgObjSizeBytes: number | null;
  capped: boolean;
  max: number | null;
  maxSizeBytes: number | null;
  firstRecord: string | null;
  lastRecord: string | null;
  hasTimeField: boolean;
  health: { status: DcHealthStatus | 'UNKNOWN'; reasons: string[] };
}

export interface DcMultiBar {
  totalWrites: number | null;
  totalErrors: number | null;
  ticksToday: number | null;
}

export interface DcMongoInfo {
  connected: boolean;
  /** 'atlas' | 'local' | null — active database source (never a URI). */
  source: string | null;
  pingMs: number | null;
  dbName: string | null;
  collectionsCount: number | null;
  indexesCount: number | null;
  totalObjects: number | null;
  totalDataSizeBytes: number | null;
  totalStorageBytes: number | null;
  totalIndexSizeBytes: number | null;
  lastUpdatedAt: string | null;
  collections: DcCollection[];
}

export interface DcSystemInfo {
  runtimeState: string | null;
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  cpuLoad1m: number | null;
  ramPercent: number | null;
  ramTotalBytes: number | null;
  ramUsedBytes: number | null;
  diskPercent: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  internet: boolean | null;
  processStartedAt: string | null;
}

export interface DcPipelineInfo {
  running: boolean;
  totalReceived: number | null;
  totalWritten: number | null;
  totalWriteErrors: number | null;
  bufferLength: number | null;
  ticksPerSecond: number | null;
  writesPerSecond: number | null;
  activeTickStocks: number | null;
  startedAt: string | null;
  lastWriteAt: string | null;
  lastError: string | null;
  feedLatencyMs: number | null;
}

export interface DcWebsocketInfo {
  connected: boolean;
  lifecycleState: string | null;
  subscribedSymbols: number | null;
  reconnectCount: number | null;
  disconnectReason: string | null;
}

export interface DcSchedulerInfo {
  running: boolean;
  enabled: boolean | null;
  state: string | null;
  nextAction: string | null;
  loginAt: string | null;
  tickCollectionAt: string | null;
  logoutAt: string | null;
  wsConnectAt: string | null;
  wsDisconnectAt: string | null;
  isTradingDay: boolean;
  schedule: Record<string, any> | null;
  windowTimes: Record<string, any> | null;
  todayLogin: string | null;
  todayWsStart: string | null;
  todayTickCollection: string | null;
  todayLogout: string | null;
}

export interface DcStorageInfo {
  exportsBytes: number | null;
  logsBytes: number | null;
  exportDirPresent: boolean | null;
  dbStorageBytes: number | null;
  dbIndexBytes: number | null;
  diskPercent: number | null;
}

export interface DcApiSummary {
  requests: number | null;
  errors: number | null;
  clientErrors: number | null;
  serverErrors: number | null;
  avgLatencyMs: number | null;
  health: string | null;
}

export interface DcDailyRow {
  date: string;
  ticksWritten: number | null;
  uniqueSymbols: number | null;
  schedulerRuns: number | null;
  schedulerCompleted: number | null;
  schedulerFailed: number | null;
  apiRequests: number | null;
  apiErrors: number | null;
  apiClientErrors: number | null;
  apiServerErrors: number | null;
  apiAvgLatencyMs: number | null;
  downloads: number | null;
  auditEntries: number | null;
  systemEvents: number | null;
  summaryTotalWrites: number | null;
  summaryTotalTicks: number | null;
  summaryErrorCount: number | null;
  summarySubscribedStocks: number | null;
  approxSizeBytes: number | null;
}

export interface DcTickPoint {
  timestamp: string | null;
  received: number | null;
  written: number | null;
  errors: number | null;
  ticksPerSecond: number | null;
  writesPerSecond: number | null;
  activeSymbols: number | null;
  bufferLength: number | null;
  feedLatencyMs: number | null;
  wsConnected: boolean | null;
  pipelineRunning: boolean | null;
}

export interface DcTrendPoint {
  ts: string | null;
  istDay: string | null;
  dbTotalStorageBytes: number | null;
  dbTotalIndexBytes: number | null;
  diskUsedBytes: number | null;
  diskPercent: number | null;
}

export interface DcSnapshotPoint {
  ts: string | null;
  istDay: string | null;
  mode: string | null;
  dbTotalStorageBytes: number | null;
  dbTotalIndexBytes: number | null;
  dbTotalObjects: number | null;
  dbPingMs: number | null;
  diskUsedBytes: number | null;
  diskPercent: number | null;
}

export interface DcWorker {
  id: string;
  name: string;
  category: string | null;
  status: string;
  running: boolean;
  lastHeartbeat: string | null;
  detail: Record<string, unknown>;
}

export interface DcEventRow {
  ts: string | null;
  source: string | null;
  event: string | null;
  status: string | null;
  message: string | null;
}

export interface DcAlerts {
  activeIncidents: number | null;
  activeQualityIssues: number | null;
}

export interface DcApiEndpoint {
  route: string | null;
  requests: number | null;
  errors: number | null;
  clientErrors: number | null;
  serverErrors: number | null;
  success: number | null;
  successPct: number | null;
  avgMs: number | null;
}

export interface DcApiErrorRow {
  ts: string | null;
  route: string | null;
  errors: number | null;
  clientErrors: number | null;
  serverErrors: number | null;
  avgLatencyMs: number | null;
  dbRelated: boolean | null;
}

/** Real API telemetry (backend histogram-derived, never fabricated). */
export interface DcApiTelemetry {
  hours: number;
  hasData: boolean;
  requests: number | null;
  errors: number | null;
  success: number | null;
  successPct: number | null;
  errorPct: number | null;
  avgLatencyMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  clientErrors: number | null;
  serverErrors: number | null;
  dbRelatedFailures: number | null;
  endpoints: DcApiEndpoint[];
  recentErrors: DcApiErrorRow[];
}

/** Canonical status labels used by the live system status strip. */
export type DcCanonicalStatus =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'DEGRADED'
  | 'RUNNING'
  | 'STOPPED'
  | 'ERROR'
  | 'UNKNOWN';

export function canonicalTone(status: DcCanonicalStatus): DcHealthTone {
  switch (status) {
    case 'CONNECTED':
    case 'RUNNING':
      return 'ok';
    case 'DEGRADED':
    case 'STOPPED':
      return 'warn';
    case 'DISCONNECTED':
    case 'ERROR':
      return 'err';
    default:
      return 'na';
  }
}

/** Normalized payload of GET /api/system/data-center/overview. */
export interface DcOverview {
  generatedAt: string | null;
  istNow: string | null;
  mongo: DcMongoInfo;
  system: DcSystemInfo;
  pipeline: DcPipelineInfo;
  websocket: DcWebsocketInfo;
  scheduler: DcSchedulerInfo;
  storage: DcStorageInfo;
  api: DcApiSummary | null;
  dailyWriteHistory: DcDailyRow[];
  ticks: { total: number | null; today: number | null };
  workers: DcWorker[];
  events: { count: number; rows: DcEventRow[] };
  alerts: DcAlerts;
}

export interface DcHistoryPayload {
  days: number;
  rows: DcDailyRow[];
}

export interface DcTicksPayload {
  hours: number;
  resolutionMin: number;
  points: DcTickPoint[];
}

export interface DcTrendPayload {
  days: number;
  points: DcTrendPoint[];
}

export interface DcSnapshotsPayload {
  points: DcSnapshotPoint[];
  count: number;
}

export interface DcCleanupCollection {
  name: string;
  deleted: number | null;
  error: string | null;
}

export interface DcCleanupRun {
  trigger: string | null;
  /** 'safe' (temp data only) or 'full' (ticks + notifications + history). */
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: string | null;
  totalDeleted: number | null;
  collectionsCleaned: number | null;
  error: string | null;
  collections: DcCleanupCollection[];
}

export interface DcCleanupStorage {
  ok: boolean;
  enabled: boolean | null;
  usedMb: number | null;
  capacityMb: number | null;
  /** Real usage vs the configured cluster capacity (Atlas M0 = 512 MB). */
  usagePct: number | null;
  thresholdPct: number | null;
  overThreshold: boolean | null;
  autoArmed: boolean | null;
  lastAutoCleanAt: string | null;
}

export interface DcCleanupPayload {
  enabled: boolean | null;
  timezone: string | null;
  schedule: string | null;
  nextCleanup: string | null;
  last: DcCleanupRun | null;
  storage: DcCleanupStorage | null;
}

// ---------------------------------------------------------------------------
// Observability planes (read-only) — backend services/data_center_planes.py
//
// Each plane re-publishes an EXISTING authoritative source with its provenance
// instead of recomputing anything, and carries an `available`/`error` pair so a
// plane that cannot be measured renders as unavailable rather than as zero.
// ---------------------------------------------------------------------------

export interface DcPlaneMeta {
  plane: string;
  /** Human-readable provenance string (module / command the values come from). */
  source: string;
  generatedAt: string | null;
  available: boolean;
  error: string | null;
}

/** Active MongoDB identity. Never contains a URI, user, password or token. */
export interface DcDatabaseIdentity {
  connected: boolean;
  source: string | null;
  sourceLabel: string | null;
  database: string | null;
  /** Credential-free cluster host (userinfo already stripped server-side). */
  host: string | null;
  serverVersion: string | null;
  connectedAt: string | null;
  configured: boolean | null;
  error: string | null;
}

export interface DcServerStatus {
  available: boolean;
  error: string | null;
  uptimeSeconds: number | null;
  connections?: Record<string, number>;
  network?: Record<string, number>;
  opcounters?: Record<string, number>;
  opcountersRepl?: Record<string, number>;
  extra_info?: Record<string, number>;
  mem?: Record<string, number>;
  globalLock?: Record<string, number>;
}

export interface DcDatabaseStorage {
  dbName: string | null;
  collectionsCount: number | null;
  indexesCount: number | null;
  totalObjects: number | null;
  totalSizeBytes: number | null;
  totalStorageBytes: number | null;
  totalIndexSizeBytes: number | null;
  pingMs: number | null;
  lastUpdatedAt: string | null;
}

export interface DcDatabasePlane extends DcPlaneMeta {
  identity: DcDatabaseIdentity;
  pool: Record<string, number>;
  serverStatus: DcServerStatus;
  storage: DcDatabaseStorage | null;
  storageError: string | null;
}

export interface DcEngineNode {
  engineId: string;
  engineName: string | null;
  category: string | null;
  version: string | null;
  state: string | null;
  health: string | null;
  healthReason: string | null;
  lastHeartbeat: string | null;
  lastHeartbeatAt: string | null;
  uptimeSeconds: number | null;
  dependencies: string[];
  dependents: string[];
  registered: boolean;
  /** Authoritative owning subsystem for this engine's plane. */
  owner: string;
  /** What this engine is responsible for, as documented. */
  plane: string;
  endpoint: string | null;
  /** False when the registry holds an engine the Data Center has not documented. */
  documented: boolean;
}

export interface DcRegistrySummary {
  overall: string | null;
  total: number | null;
  states: Record<string, number>;
  healths: Record<string, number>;
  registeredAt: number | null;
}

export interface DcEnginesPlane extends DcPlaneMeta {
  documented: DcEngineNode[];
  summary: DcRegistrySummary | null;
  undocumentedCount: number;
}

export interface DcTopologyNode {
  id: string;
  name: string | null;
  category: string | null;
  state: string | null;
  health: string | null;
  documented: boolean;
  owner: string;
  dependencyCount: number;
  dependentCount: number;
}

export interface DcTopologyEdge {
  from: string;
  to: string;
  kind: 'depends_on';
  fromHealth: string | null;
  toHealth: string | null;
}

export interface DcTopologyPlane extends DcPlaneMeta {
  nodes: DcTopologyNode[];
  edges: DcTopologyEdge[];
  nodeCount: number;
  edgeCount: number;
  orphans: string[];
  summary: DcRegistrySummary | null;
}

export interface DcDbWriterPermission {
  key: string;
  label: string;
  collection: string;
  enabled: boolean;
  storageCap: boolean;
  hardCapped: boolean;
  capReason: string | null;
}

export interface DcDbWriterPlane extends DcPlaneMeta {
  engineId: string;
  /** Always true: DB Writer is the single authoritative writer of tick documents. */
  authoritative: boolean;
  state: string | null;
  health: string | null;
  healthReason: string | null;
  version: string | null;
  lastHeartbeat: string | null;
  pipeline: Record<string, unknown> | null;
  dataLoss: Record<string, unknown> | null;
  instruments: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
  marketWatch: Record<string, unknown> | null;
  pipelineLatency: Record<string, unknown> | null;
  lastFlushResult: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  permissions: DcDbWriterPermission[];
  capReason: string | null;
}

export interface DcOwnedCollection {
  name: string;
  namespace: string | null;
  documents: number | null;
  storageBytes: number | null;
  dataSizeBytes: number | null;
  indexSizeBytes: number | null;
  indexes: number | null;
  capped: boolean | null;
  firstRecord: string | null;
  lastRecord: string | null;
  /** Owning subsystem, or 'UNMAPPED' when no documented write path was found. */
  owner: string;
  module: string | null;
  retention: string;
  basis: string | null;
  documented: boolean;
  /** False when documented but not currently present in the live database. */
  present: boolean;
}

export interface DcOwnershipPlane extends DcPlaneMeta {
  collections: DcOwnedCollection[];
  count: number;
  liveCount: number;
  undocumented: string[];
  totalStorageBytes: number;
}

export interface DcTtlIndex {
  collection: string;
  index: string;
  field: string | null;
  expireAfterSeconds: number | null;
  owner: string;
}

export interface DcRetentionPlane extends DcPlaneMeta {
  ttlIndexes: DcTtlIndex[];
  ttlIndexCount: number;
  scannedCollections: number | null;
  cleanup: Record<string, unknown> | null;
  snapshots: Record<string, unknown> | null;
}

export interface DcCollectionDetail {
  name: string;
  ns: string | null;
  count: number | null;
  sizeBytes: number | null;
  storageBytes: number | null;
  indexSizeBytes: number | null;
  indexes: number | null;
  avgObjSizeBytes: number | null;
  capped: boolean;
  maxSizeBytes: number | null;
  freeStorageBytes: number | null;
  wiredTiger: Record<string, unknown> | null;
  indexNames: string[];
  hasTimeField: boolean;
  firstRecord: string | null;
  lastRecord: string | null;
  sample: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Primitive coercers (null-safe, never throw)
// ---------------------------------------------------------------------------

export function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

export function bool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : Boolean(v);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export function iso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return Number.isNaN(new Date(s).getTime()) ? null : s;
}

function toObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function toArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeCollection(c: unknown, health: unknown): DcCollection {
  const o = toObj(c);
  const h = toObj(health);
  return {
    name: str(o.name) ?? 'unknown',
    count: int(o.count),
    sizeBytes: int(o.sizeBytes ?? o.dataSizeBytes ?? o.size),
    storageBytes: int(o.storageBytes ?? o.storageSize),
    indexSizeBytes: int(o.indexSizeBytes ?? o.totalIndexSize),
    indexes: int(o.indexes ?? o.nindexes),
    ns: str(o.ns),
    avgObjSizeBytes: num(o.avgObjSizeBytes ?? o.avgObjSize),
    capped: Boolean(o.capped),
    max: int(o.max),
    maxSizeBytes: int(o.maxSizeBytes ?? o.maxSize),
    firstRecord: iso(o.firstRecord ?? o.first_ts ?? o.firstRecordTs),
    lastRecord: iso(o.lastRecord ?? o.last_ts ?? o.lastRecordTs),
    hasTimeField: Boolean(o.hasTimeField),
    health: {
      status: (str(h.status) as DcHealthStatus) ?? 'UNKNOWN',
      reasons: toArr(h.reasons).map((r) => String(r)),
    },
  };
}

export function normalizeCollectionHealth(c: unknown): { status: DcHealthStatus; reasons: string[] } | null {
  const h = toObj((toObj(c).health));
  const status = str(h.status) as DcHealthStatus;
  if (!status) return null;
  return { status, reasons: toArr(h.reasons).map((r) => String(r)) };
}

export function normalizeDailyRow(r: unknown): DcDailyRow {
  const o = toObj(r);
  return {
    date: str(o.date) ?? '',
    ticksWritten: int(o.ticksWritten),
    uniqueSymbols: int(o.uniqueSymbols),
    schedulerRuns: int(o.schedulerRuns),
    schedulerCompleted: int(o.schedulerCompleted),
    schedulerFailed: int(o.schedulerFailed),
    apiRequests: int(o.apiRequests),
    apiErrors: int(o.apiErrors),
    apiClientErrors: int(o.apiClientErrors),
    apiServerErrors: int(o.apiServerErrors),
    apiAvgLatencyMs: num(o.apiAvgLatencyMs),
    downloads: int(o.downloads),
    auditEntries: int(o.auditEntries),
    systemEvents: int(o.systemEvents),
    summaryTotalWrites: int(o.summaryTotalWrites),
    summaryTotalTicks: int(o.summaryTotalTicks),
    summaryErrorCount: int(o.summaryErrorCount),
    summarySubscribedStocks: int(o.summarySubscribedStocks),
    approxSizeBytes: int(o.approxSizeBytes),
  };
}

export function normalizeTickPoint(p: unknown): DcTickPoint {
  const o = toObj(p);
  return {
    timestamp: iso(o.timestamp ?? o.ts),
    received: int(o.received),
    written: int(o.written),
    errors: int(o.errors),
    ticksPerSecond: num(o.ticksPerSecond),
    writesPerSecond: num(o.writesPerSecond),
    activeSymbols: int(o.activeSymbols),
    bufferLength: int(o.bufferLength),
    feedLatencyMs: num(o.feedLatencyMs),
    wsConnected: o.wsConnected == null ? null : bool(o.wsConnected),
    pipelineRunning: o.pipelineRunning == null ? null : bool(o.pipelineRunning),
  };
}

export function normalizeTrendPoint(p: unknown): DcTrendPoint {
  const o = toObj(p);
  return {
    ts: iso(o.ts ?? o.timestamp),
    istDay: str(o.istDay),
    dbTotalStorageBytes: int(o.dbTotalStorageBytes),
    dbTotalIndexBytes: int(o.dbTotalIndexBytes),
    diskUsedBytes: int(o.diskUsedBytes),
    diskPercent: num(o.diskPercent),
  };
}

export function normalizeSnapshotPoint(p: unknown): DcSnapshotPoint {
  const o = toObj(p);
  const db = toObj(o.db);
  const storage = toObj(o.storage);
  return {
    ts: iso(o.ts ?? o.timestamp),
    istDay: str(o.istDay),
    mode: str(o.mode),
    dbTotalStorageBytes: int(db.totalStorageBytes),
    dbTotalIndexBytes: int(db.totalIndexSizeBytes),
    dbTotalObjects: int(db.totalObjects),
    dbPingMs: num(db.pingMs),
    diskUsedBytes: int(storage.diskUsedBytes),
    diskPercent: num(storage.diskPercent),
  };
}

export function normalizeWorker(w: unknown): DcWorker {
  const o = toObj(w);
  const detail = toObj(o.detail);
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) d[k] = v;
  return {
    id: str(o.id) ?? 'unknown',
    name: str(o.name) ?? str(o.id) ?? 'unknown',
    category: str(o.category),
    status: str(o.status) ?? 'UNKNOWN',
    running: Boolean(o.running),
    lastHeartbeat: iso(o.lastHeartbeat),
    detail: d,
  };
}

export function normalizeEventRow(r: unknown): DcEventRow {
  const o = toObj(r);
  return {
    ts: iso(o.ts),
    source: str(o.source),
    event: str(o.event),
    status: str(o.status),
    message: str(o.message),
  };
}

/** Normalize the raw `/overview` payload into a strongly-typed snapshot. */
export function normalizeDcOverview(raw: unknown): DcOverview | null {
  const o = toObj(raw);
  if (!o.generatedAt && !toObj(o.mongo).connected && (toObj(o.mongo).connected as boolean | undefined) === undefined) {
    // The overview endpoint always returns generatedAt; treat any payload that
    // carries neither as empty so the UI can show a truthful "unavailable".
    if (o.generatedAt == null) return null;
  }
  const mongo = toObj(o.mongo);
  const system = toObj(o.system);
  const pipeline = toObj(o.pipeline);
  const websocket = toObj(o.websocket);
  const scheduler = toObj(o.scheduler);
  const storage = toObj(o.storage);
  const api = toObj(o.api);
  const ticksRaw = toObj(o.ticks);
  const alerts = toObj(o.alerts);
  const events = toObj(o.events);

  const collections = toArr(mongo.collections).map((c) =>
    normalizeCollection(c, normalizeCollectionHealth(c) ?? null),
  );

  return {
    generatedAt: iso(o.generatedAt),
    istNow: iso(o.istNow),
    mongo: {
      connected: Boolean(mongo.connected),
      source: str(mongo.source),
      pingMs: num(mongo.pingMs),
      dbName: str(mongo.dbName),
      collectionsCount: int(mongo.collectionsCount),
      indexesCount: int(mongo.indexesCount),
      totalObjects: int(mongo.totalObjects),
      totalDataSizeBytes: int(mongo.totalDataSizeBytes),
      totalStorageBytes: int(mongo.totalStorageBytes),
      totalIndexSizeBytes: int(mongo.totalIndexSizeBytes),
      lastUpdatedAt: iso(mongo.lastUpdatedAt),
      collections,
    },
    system: {
      runtimeState: str(system.runtimeState),
      uptimeSeconds: num(system.uptimeSeconds),
      cpuPercent: num(system.cpuPercent),
      cpuLoad1m: num(system.cpuLoad1m),
      ramPercent: num(system.ramPercent),
      ramTotalBytes: int(system.ramTotalBytes),
      ramUsedBytes: int(system.ramUsedBytes),
      diskPercent: num(system.diskPercent),
      diskTotalBytes: int(system.diskTotalBytes),
      diskUsedBytes: int(system.diskUsedBytes),
      internet: system.internet == null ? null : bool(system.internet),
      processStartedAt: iso(system.processStartedAt),
    },
    pipeline: {
      running: Boolean(pipeline.running),
      totalReceived: int(pipeline.totalReceived),
      totalWritten: int(pipeline.totalWritten),
      totalWriteErrors: int(pipeline.totalWriteErrors),
      bufferLength: int(pipeline.bufferLength),
      ticksPerSecond: num(pipeline.ticksPerSecond),
      writesPerSecond: num(pipeline.writesPerSecond),
      activeTickStocks: int(pipeline.activeTickStocks),
      startedAt: iso(pipeline.startedAt),
      lastWriteAt: iso(pipeline.lastWriteAt),
      lastError: str(pipeline.lastError),
      feedLatencyMs: num(pipeline.feedLatencyMs),
    },
    websocket: {
      connected: Boolean(websocket.connected),
      lifecycleState: str(websocket.lifecycleState),
      subscribedSymbols: int(websocket.subscribedSymbols),
      reconnectCount: int(websocket.reconnectCount),
      disconnectReason: str(websocket.disconnectReason),
    },
    scheduler: {
      running: Boolean(scheduler.running),
      enabled: scheduler.enabled == null ? null : bool(scheduler.enabled),
      state: str(scheduler.state),
      nextAction: str(scheduler.nextAction),
      loginAt: str(scheduler.loginAt),
      tickCollectionAt: str(scheduler.tickCollectionAt),
      logoutAt: str(scheduler.logoutAt),
      wsConnectAt: str(scheduler.wsConnectAt),
      wsDisconnectAt: str(scheduler.wsDisconnectAt),
      isTradingDay: Boolean(scheduler.isTradingDay),
      schedule: (scheduler.schedule as Record<string, any>) ?? null,
      windowTimes: ((scheduler.schedule as Record<string, any>) ?? null) && {
        login: (scheduler.schedule as Record<string, any>)?.login ?? null,
        ws_connect: (scheduler.schedule as Record<string, any>)?.ws_connect ?? null,
        tick_collection_start: (scheduler.schedule as Record<string, any>)?.tick_collection_start ?? null,
        ws_disconnect: (scheduler.schedule as Record<string, any>)?.ws_disconnect ?? null,
        logout: (scheduler.schedule as Record<string, any>)?.logout ?? null,
      },
      todayLogin: ((scheduler.schedule as Record<string, any>)?.today_login_time as string) ?? null,
      todayWsStart: ((scheduler.schedule as Record<string, any>)?.today_ws_connect_time as string) ?? null,
      todayTickCollection: ((scheduler.schedule as Record<string, any>)?.today_tick_collection_time as string) ?? null,
      todayLogout: ((scheduler.schedule as Record<string, any>)?.today_logout_time as string) ?? null,
    },
    storage: {
      exportsBytes: int(storage.exportsBytes),
      logsBytes: int(storage.logsBytes),
      exportDirPresent: storage.exportDirPresent == null ? null : bool(storage.exportDirPresent),
      dbStorageBytes: int(storage.dbStorageBytes),
      dbIndexBytes: int(storage.dbIndexBytes),
      diskPercent: num(storage.diskPercent),
    },
    api: o.api == null
      ? null
      : {
        requests: int(api.requests),
        errors: int(api.errors),
        clientErrors: int(api.clientErrors),
        serverErrors: int(api.serverErrors),
        avgLatencyMs: num(api.avgLatencyMs),
        health: str(api.health),
      },
    dailyWriteHistory: toArr(o.dailyWriteHistory).map(normalizeDailyRow),
    ticks: {
      total: int(ticksRaw.total),
      today: int(ticksRaw.today),
    },
    workers: toArr(o.workers).map(normalizeWorker),
    events: {
      count: int(events.count) ?? toArr(events.rows).length,
      rows: toArr(events.rows).map(normalizeEventRow),
    },
    alerts: {
      activeIncidents: int(alerts.activeIncidents),
      activeQualityIssues: int(alerts.activeQualityIssues),
    },
  };
}

export function normalizeHistoryPayload(raw: unknown): DcHistoryPayload | null {
  const o = toObj(raw);
  if (o.rows === undefined) return null; // absent rows -> no history source at all
  return {
    days: int(o.days) ?? 0,
    rows: toArr(o.rows).map(normalizeDailyRow),
  };
}

export function normalizeTicksPayload(raw: unknown): DcTicksPayload | null {
  const o = toObj(raw);
  if (o.points === undefined) return null;
  return {
    hours: int(o.hours) ?? 0,
    resolutionMin: int(o.resolutionMin) ?? 1,
    points: toArr(o.points).map(normalizeTickPoint),
  };
}

export function normalizeTrendPayload(raw: unknown): DcTrendPayload | null {
  const o = toObj(raw);
  if (o.points === undefined) return null;
  return {
    days: int(o.days) ?? 0,
    points: toArr(o.points).map(normalizeTrendPoint),
  };
}

export function normalizeSnapshotsPayload(raw: unknown): DcSnapshotsPayload | null {
  const o = toObj(raw);
  if (o.points === undefined) return null;
  const points = toArr(o.points).map(normalizeSnapshotPoint);
  return { points, count: points.length };
}

/** Normalize the real Atlas cleanup status (null when the view is absent). */
export function normalizeCleanupPayload(raw: unknown): DcCleanupPayload | null {
  const o = toObj(raw);
  if (o.nextCleanup === undefined && o.last === undefined && o.enabled === undefined && o.storage === undefined) return null;
  const last = toObj(o.last);
  const st = toObj(o.storage);
  return {
    enabled: o.enabled == null ? null : bool(o.enabled),
    timezone: str(o.timezone),
    schedule: str(o.schedule),
    nextCleanup: iso(o.nextCleanup),
    storage: o.storage == null ? null : {
      ok: bool(st.ok),
      enabled: st.enabled == null ? null : bool(st.enabled),
      usedMb: num(st.usedMb),
      capacityMb: num(st.capacityMb),
      usagePct: num(st.usagePct),
      thresholdPct: num(st.thresholdPct),
      overThreshold: st.overThreshold == null ? null : bool(st.overThreshold),
      autoArmed: st.autoArmed == null ? null : bool(st.autoArmed),
      lastAutoCleanAt: iso(st.lastAutoCleanAt),
    },
    last: o.last == null
      ? null
      : {
        trigger: str(last.trigger),
        mode: str(last.mode),
        startedAt: iso(last.startedAt),
        finishedAt: iso(last.finishedAt),
        status: str(last.status),
        totalDeleted: int(last.totalDeleted),
        collectionsCleaned: int(last.collectionsCleaned),
        error: str(last.error),
        collections: toArr(last.collections).map((c) => {
          const co = toObj(c);
          return {
            name: str(co.name) ?? 'unknown',
            deleted: int(co.deleted),
            error: str(co.error),
          };
        }),
      },
  };
}

export function normalizeApiEndpoint(e: unknown): DcApiEndpoint {
  const o = toObj(e);
  return {
    route: str(o.route),
    requests: int(o.requests),
    errors: int(o.errors),
    clientErrors: int(o.clientErrors),
    serverErrors: int(o.serverErrors),
    success: int(o.success),
    successPct: num(o.successPct),
    avgMs: num(o.avgMs),
  };
}

export function normalizeApiErrorRow(r: unknown): DcApiErrorRow {
  const o = toObj(r);
  return {
    ts: iso(o.ts),
    route: str(o.route),
    errors: int(o.errors),
    clientErrors: int(o.clientErrors),
    serverErrors: int(o.serverErrors),
    avgLatencyMs: num(o.avgLatencyMs),
    dbRelated: o.dbRelated == null ? null : bool(o.dbRelated),
  };
}

/** Normalize the real API telemetry payload (null when not a telemetry view). */
export function normalizeApiTelemetry(raw: unknown): DcApiTelemetry | null {
  const o = toObj(raw);
  if (o.hasData === undefined && o.requests === undefined) return null;
  return {
    hours: int(o.hours) ?? 24,
    hasData: Boolean(o.hasData),
    requests: int(o.requests),
    errors: int(o.errors),
    success: int(o.success),
    successPct: num(o.successPct),
    errorPct: num(o.errorPct),
    avgLatencyMs: num(o.avgLatencyMs),
    p50Ms: num(o.p50Ms),
    p95Ms: num(o.p95Ms),
    p99Ms: num(o.p99Ms),
    clientErrors: int(o.clientErrors),
    serverErrors: int(o.serverErrors),
    dbRelatedFailures: int(o.dbRelatedFailures),
    endpoints: toArr(o.endpoints).map(normalizeApiEndpoint),
    recentErrors: toArr(o.recentErrors).map(normalizeApiErrorRow),
  };
}

// ---------------------------------------------------------------------------
// Plane normalizers — every field maps from a REAL backend measurement; a
// missing value normalizes to null / 'N/A' so the UI can say "not available"
// instead of rendering a fabricated number.
// ---------------------------------------------------------------------------

function planeMeta(o: Record<string, unknown>, plane: string): DcPlaneMeta {
  return {
    plane: str(o.plane) ?? plane,
    source: str(o.source) ?? 'source not reported',
    generatedAt: iso(o.generatedAt),
    available: bool(o.available),
    error: str(o.error),
  };
}

function countMap(v: unknown): Record<string, number> {
  const o = toObj(v);
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(o)) {
    const n = int(val);
    if (n != null) out[k] = n;
  }
  return out;
}

function numberMap(v: unknown): Record<string, number> | undefined {
  const m = countMap(v);
  return Object.keys(m).length ? m : undefined;
}

export function normalizeDatabasePlane(raw: unknown): DcDatabasePlane | null {
  const o = toObj(raw);
  if (!o.plane && !o.identity) return null;
  const id = toObj(o.identity);
  const storage = o.storage == null ? null : toObj(o.storage);
  const ss = toObj(o.serverStatus);
  return {
    ...planeMeta(o, 'database'),
    identity: {
      connected: bool(id.connected),
      source: str(id.source),
      sourceLabel: str(id.sourceLabel),
      database: str(id.database),
      host: str(id.host),
      serverVersion: str(id.serverVersion),
      connectedAt: iso(id.connectedAt),
      configured: id.configured == null ? null : bool(id.configured),
      error: str(id.error),
    },
    pool: countMap(o.pool),
    serverStatus: {
      available: bool(ss.available),
      error: str(ss.error),
      uptimeSeconds: num(ss.uptimeSeconds),
      connections: numberMap(ss.connections),
      network: numberMap(ss.network),
      opcounters: numberMap(ss.opcounters),
      opcountersRepl: numberMap(ss.opcountersRepl),
      extra_info: numberMap(ss.extra_info),
      mem: numberMap(ss.mem),
      globalLock: numberMap(ss.globalLock),
    },
    storage: storage
      ? {
          dbName: str(storage.dbName),
          collectionsCount: int(storage.collectionsCount),
          indexesCount: int(storage.indexesCount),
          totalObjects: int(storage.totalObjects),
          totalSizeBytes: int(storage.totalSizeBytes),
          totalStorageBytes: int(storage.totalStorageBytes),
          totalIndexSizeBytes: int(storage.totalIndexSizeBytes),
          pingMs: num(storage.pingMs),
          lastUpdatedAt: iso(storage.lastUpdatedAt),
        }
      : null,
    storageError: str(o.storageError),
  };
}

function normalizeRegistrySummary(raw: unknown): DcRegistrySummary | null {
  if (raw == null) return null;
  const o = toObj(raw);
  if (Object.keys(o).length === 0) return null;
  return {
    overall: str(o.overall),
    total: int(o.total),
    states: countMap(o.states),
    healths: countMap(o.healths),
    registeredAt: num(o.registeredAt),
  };
}

function stringList(v: unknown): string[] {
  return toArr(v).map((x) => String(x));
}

function normalizeEngineNode(e: unknown): DcEngineNode {
  const o = toObj(e);
  return {
    engineId: str(o.engineId) ?? 'unknown',
    engineName: str(o.engineName),
    category: str(o.category),
    version: str(o.version),
    state: str(o.state),
    health: str(o.health),
    healthReason: str(o.healthReason),
    lastHeartbeat: iso(o.lastHeartbeat),
    lastHeartbeatAt: iso(o.lastHeartbeatAt),
    uptimeSeconds: num(o.uptimeSeconds),
    dependencies: stringList(o.dependencies),
    dependents: stringList(o.dependents),
    registered: bool(o.registered),
    owner: str(o.owner) ?? 'UNMAPPED',
    plane: str(o.plane) ?? 'NOT DOCUMENTED',
    endpoint: str(o.endpoint),
    documented: o.documented == null ? true : bool(o.documented),
  };
}

export function normalizeEnginesPlane(raw: unknown): DcEnginesPlane | null {
  const o = toObj(raw);
  if (!o.plane && o.documented === undefined) return null;
  return {
    ...planeMeta(o, 'engines'),
    documented: toArr(o.documented).map(normalizeEngineNode),
    summary: normalizeRegistrySummary(o.summary),
    undocumentedCount: int(o.undocumentedCount) ?? 0,
  };
}

export function normalizeTopologyPlane(raw: unknown): DcTopologyPlane | null {
  const o = toObj(raw);
  if (!o.plane && o.nodes === undefined) return null;
  return {
    ...planeMeta(o, 'topology'),
    nodes: toArr(o.nodes).map((n) => {
      const no = toObj(n);
      return {
        id: str(no.id) ?? 'unknown',
        name: str(no.name),
        category: str(no.category),
        state: str(no.state),
        health: str(no.health),
        documented: bool(no.documented),
        owner: str(no.owner) ?? 'UNMAPPED',
        dependencyCount: int(no.dependencyCount) ?? 0,
        dependentCount: int(no.dependentCount) ?? 0,
      };
    }),
    edges: toArr(o.edges).map((e) => {
      const eo = toObj(e);
      return {
        from: str(eo.from) ?? 'unknown',
        to: str(eo.to) ?? 'unknown',
        kind: 'depends_on' as const,
        fromHealth: str(eo.fromHealth),
        toHealth: str(eo.toHealth),
      };
    }),
    nodeCount: int(o.nodeCount) ?? 0,
    edgeCount: int(o.edgeCount) ?? 0,
    orphans: stringList(o.orphans),
    summary: normalizeRegistrySummary(o.summary),
  };
}

export function normalizeDbWriterPlane(raw: unknown): DcDbWriterPlane | null {
  const o = toObj(raw);
  if (!o.plane && o.permissions === undefined) return null;
  return {
    ...planeMeta(o, 'dbwriter'),
    engineId: str(o.engineId) ?? 'db_writer_engine',
    authoritative: bool(o.authoritative),
    state: str(o.state),
    health: str(o.health),
    healthReason: str(o.healthReason),
    version: str(o.version),
    lastHeartbeat: iso(o.lastHeartbeat),
    pipeline: o.pipeline == null ? null : toObj(o.pipeline),
    dataLoss: o.dataLoss == null ? null : toObj(o.dataLoss),
    instruments: o.instruments == null ? null : toObj(o.instruments),
    audit: o.audit == null ? null : toObj(o.audit),
    marketWatch: o.marketWatch == null ? null : toObj(o.marketWatch),
    pipelineLatency: o.pipelineLatency == null ? null : toObj(o.pipelineLatency),
    lastFlushResult: o.lastFlushResult == null ? null : toObj(o.lastFlushResult),
    settings: o.settings == null ? null : toObj(o.settings),
    permissions: toArr(o.permissions).map((p) => {
      const po = toObj(p);
      return {
        key: str(po.key) ?? 'unknown',
        label: str(po.label) ?? str(po.key) ?? 'unknown',
        collection: str(po.collection) ?? 'N/A',
        enabled: bool(po.enabled),
        storageCap: bool(po.storageCap),
        hardCapped: bool(po.hardCapped),
        capReason: str(po.capReason),
      };
    }),
    capReason: str(o.capReason),
  };
}

export function normalizeOwnershipPlane(raw: unknown): DcOwnershipPlane | null {
  const o = toObj(raw);
  if (!o.plane && o.collections === undefined) return null;
  return {
    ...planeMeta(o, 'ownership'),
    collections: toArr(o.collections).map((c) => {
      const co = toObj(c);
      return {
        name: str(co.name) ?? 'unknown',
        namespace: str(co.namespace),
        documents: int(co.documents),
        storageBytes: int(co.storageBytes),
        dataSizeBytes: int(co.dataSizeBytes),
        indexSizeBytes: int(co.indexSizeBytes),
        indexes: int(co.indexes),
        capped: co.capped == null ? null : bool(co.capped),
        firstRecord: iso(co.firstRecord),
        lastRecord: iso(co.lastRecord),
        owner: str(co.owner) ?? 'UNMAPPED',
        module: str(co.module),
        retention: str(co.retention) ?? 'NOT VERIFIED',
        basis: str(co.basis),
        documented: bool(co.documented),
        present: co.present == null ? true : bool(co.present),
      };
    }),
    count: int(o.count) ?? 0,
    liveCount: int(o.liveCount) ?? 0,
    undocumented: stringList(o.undocumented),
    totalStorageBytes: int(o.totalStorageBytes) ?? 0,
  };
}

export function normalizeRetentionPlane(raw: unknown): DcRetentionPlane | null {
  const o = toObj(raw);
  if (!o.plane && o.ttlIndexes === undefined) return null;
  return {
    ...planeMeta(o, 'retention'),
    ttlIndexes: toArr(o.ttlIndexes).map((t) => {
      const to = toObj(t);
      return {
        collection: str(to.collection) ?? 'unknown',
        index: str(to.index) ?? 'unknown',
        field: str(to.field),
        expireAfterSeconds: num(to.expireAfterSeconds),
        owner: str(to.owner) ?? 'UNMAPPED',
      };
    }),
    ttlIndexCount: int(o.ttlIndexCount) ?? 0,
    scannedCollections: int(o.scannedCollections),
    cleanup: o.cleanup == null ? null : toObj(o.cleanup),
    snapshots: o.snapshots == null ? null : toObj(o.snapshots),
  };
}

export function normalizeCollectionDetail(raw: unknown): DcCollectionDetail | null {
  const o = toObj(raw);
  if (!o.name && !o.ns) return null;
  return {
    name: str(o.name) ?? 'unknown',
    ns: str(o.ns),
    count: int(o.count),
    sizeBytes: int(o.sizeBytes),
    storageBytes: int(o.storageBytes),
    indexSizeBytes: int(o.indexSizeBytes),
    indexes: int(o.indexes),
    avgObjSizeBytes: num(o.avgObjSizeBytes),
    capped: Boolean(o.capped),
    maxSizeBytes: int(o.maxSizeBytes),
    freeStorageBytes: int(o.freeStorageBytes),
    wiredTiger: toObj(o.wiredTiger) as Record<string, unknown> | null,
    indexNames: toArr(o.indexNames).map((n) => String(n)),
    hasTimeField: Boolean(o.hasTimeField),
    firstRecord: iso(o.firstRecord),
    lastRecord: iso(o.lastRecord),
    sample: toArr(o.sample).map((r) => toObj(r)),
  };
}

/** Normalize the whole aggregated route envelope into per-section payloads. */
export function normalizeDcEnvelope(
  raw: unknown,
): {
  overview: DcOverview | null;
  overviewError: string | null;
  history: DcHistoryPayload | null;
  historyError: string | null;
  ticks: DcTicksPayload | null;
  ticksError: string | null;
  trend: DcTrendPayload | null;
  trendError: string | null;
  snapshots: DcSnapshotsPayload | null;
  snapshotsError: string | null;
  apiTelemetry: DcApiTelemetry | null;
  apiTelemetryError: string | null;
  cleanup: DcCleanupPayload | null;
  cleanupError: string | null;
  database: DcDatabasePlane | null;
  databaseError: string | null;
  engines: DcEnginesPlane | null;
  enginesError: string | null;
  topology: DcTopologyPlane | null;
  topologyError: string | null;
  dbWriter: DcDbWriterPlane | null;
  dbWriterError: string | null;
  ownership: DcOwnershipPlane | null;
  ownershipError: string | null;
  retention: DcRetentionPlane | null;
  retentionError: string | null;
  generatedAt: string | null;
  /** Sections actually present in THIS payload (for merge-in-place). */
  present: DcSectionKey[];
} {
  const o = toObj(raw);
  // A section that is ABSENT from this payload was simply not requested in this
  // poll — that is not an error, and must not be reported as one, or a targeted
  // refresh would paint a "section unavailable" badge over healthy data.
  const pick = (key: string) => {
    if (o[key] == null) return { data: null, error: null, ok: true, present: false };
    const sec = toObj(o[key]);
    return { data: sec.ok ? sec.data : null, error: str(sec.error) ?? null, ok: Boolean(sec.ok), present: true };
  };
  const present = (
    [
      'overview',
      'history',
      'ticks',
      'trend',
      'snapshots',
      'apiTelemetry',
      'cleanup',
      'database',
      'engines',
      'topology',
      'dbWriter',
      'ownership',
      'retention',
    ] as const
  ).filter((k) => o[k] != null);
  const ov = pick('overview');
  const hist = pick('history');
  const tick = pick('ticks');
  const tr = pick('trend');
  const snap = pick('snapshots');
  const api = pick('apiTelemetry');
  const cln = pick('cleanup');
  const dbp = pick('database');
  const eng = pick('engines');
  const topo = pick('topology');
  const dwr = pick('dbWriter');
  const own = pick('ownership');
  const ret = pick('retention');
  return {
    overview: ov.data != null ? normalizeDcOverview(ov.data) : null,
    overviewError: ov.ok ? null : ov.error ?? 'overview unavailable',
    history: hist.data != null ? normalizeHistoryPayload(hist.data) : null,
    historyError: hist.ok ? null : hist.error ?? 'history unavailable',
    ticks: tick.data != null ? normalizeTicksPayload(tick.data) : null,
    ticksError: tick.ok ? null : tick.error ?? 'tick history unavailable',
    trend: tr.data != null ? normalizeTrendPayload(tr.data) : null,
    trendError: tr.ok ? null : tr.error ?? 'storage trend unavailable',
    snapshots: snap.data != null ? normalizeSnapshotsPayload(snap.data) : null,
    snapshotsError: snap.ok ? null : snap.error ?? 'snapshots unavailable',
    apiTelemetry: api.data != null ? normalizeApiTelemetry(api.data) : null,
    apiTelemetryError: api.ok ? null : api.error ?? 'api telemetry unavailable',
    cleanup: cln.data != null ? normalizeCleanupPayload(cln.data) : null,
    cleanupError: cln.ok ? null : cln.error ?? 'cleanup status unavailable',
    database: dbp.data != null ? normalizeDatabasePlane(dbp.data) : null,
    databaseError: dbp.ok ? null : dbp.error ?? 'database plane unavailable',
    engines: eng.data != null ? normalizeEnginesPlane(eng.data) : null,
    enginesError: eng.ok ? null : eng.error ?? 'engines plane unavailable',
    topology: topo.data != null ? normalizeTopologyPlane(topo.data) : null,
    topologyError: topo.ok ? null : topo.error ?? 'topology plane unavailable',
    dbWriter: dwr.data != null ? normalizeDbWriterPlane(dwr.data) : null,
    dbWriterError: dwr.ok ? null : dwr.error ?? 'DB Writer plane unavailable',
    ownership: own.data != null ? normalizeOwnershipPlane(own.data) : null,
    ownershipError: own.ok ? null : own.error ?? 'ownership plane unavailable',
    retention: ret.data != null ? normalizeRetentionPlane(ret.data) : null,
    retentionError: ret.ok ? null : ret.error ?? 'retention plane unavailable',
    generatedAt: iso(o.generatedAt),
    present,
  };
}

export type DcSectionKey =
  | 'overview'
  | 'history'
  | 'ticks'
  | 'trend'
  | 'snapshots'
  | 'apiTelemetry'
  | 'cleanup'
  | 'database'
  | 'engines'
  | 'topology'
  | 'dbWriter'
  | 'ownership'
  | 'retention';

// ---------------------------------------------------------------------------
// Wire section names (`?sections=` query param on /api/phase2/data-center)
// ---------------------------------------------------------------------------
// The proxy silently DROPS any name it does not recognise, so a typo here does
// not throw — it just quietly freezes that panel at its last value. These names
// therefore live in one typed list that the store derives its fetch groups
// from, and `satisfies` makes a mismatch a compile error instead.
export const DC_WIRE_SECTIONS = [
  'overview',
  'history',
  'ticks',
  'trend',
  'snapshots',
  'api-telemetry',
  'cleanup',
  'database',
  'engines',
  'topology',
  'dbWriter',
  'ownership',
  'retention',
] as const;

export type DcWireSection = (typeof DC_WIRE_SECTIONS)[number];

/** Wire name for a state key — e.g. `apiTelemetry` -> `api-telemetry`. */
export function dcWireSection(key: DcSectionKey): DcWireSection {
  const found = DC_WIRE_SECTIONS.find((w) => w.toLowerCase().replace(/-/g, '') === key.toLowerCase());
  if (!found) throw new Error(`unknown data-center section key: ${key}`);
  return found;
}

// ---------------------------------------------------------------------------
// Derived aggregates (pure, used by the page + tests)
// ---------------------------------------------------------------------------

/** Sum a numeric column across daily rows, ignoring nulls. */
export function sumRows(rows: DcDailyRow[], key: keyof DcDailyRow): number {
  let total = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Chart data validation — drop anything that would render an untruthful point
// ---------------------------------------------------------------------------

export interface ValidSeriesResult<T> {
  /** Points with a parseable timestamp, at least one finite value, sorted asc. */
  cleaned: T[];
  /** Number of points dropped (bad ts / all values invalid / duplicate ts). */
  dropped: number;
}

/**
 * Validate a series for charting: every point must have a parseable timestamp,
 * at least one finite numeric value among ``valueKeys``, and a unique timestamp.
 * Bad points are REMOVED (never rendered as 0), duplicates keep the last value,
 * and the result is sorted oldest -> newest so lines/paths draw left-to-right.
 */
export function validSeries<T extends object>(
  points: T[],
  tsKey: keyof T,
  valueKeys: (keyof T)[],
): ValidSeriesResult<T> {
  const cleaned: T[] = [];
  let dropped = 0;
  const seen = new Set<number>();
  for (const p of points) {
    const raw = p?.[tsKey];
    const t = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw).getTime() : NaN;
    if (!Number.isFinite(t)) {
      dropped += 1;
      continue;
    }
    let hasValue = false;
    for (const k of valueKeys) {
      const v = p?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        hasValue = true;
        break;
      }
    }
    if (!hasValue) {
      dropped += 1;
      continue;
    }
    if (seen.has(t)) {
      // keep last occurrence; replace the earlier point in place
      const idx = cleaned.findIndex((q) => new Date(q?.[tsKey] as never).getTime() === t);
      if (idx >= 0) cleaned[idx] = p;
      continue;
    }
    seen.add(t);
    cleaned.push(p);
  }
  cleaned.sort((a, b) => {
    const ta = new Date(a?.[tsKey] as never).getTime();
    const tb = new Date(b?.[tsKey] as never).getTime();
    return ta - tb;
  });
  return { cleaned, dropped };
}

// ---------------------------------------------------------------------------
// Live system status strip — canonical states derived from real backend data
// ---------------------------------------------------------------------------

export interface DcStatusTile {
  kind: string;
  label: string;
  status: DcCanonicalStatus;
  detail: string;
  /** Absolute path when a real destination page exists (null = no page). */
  href: string | null;
}

/**
 * Derive the 8-tile live system status strip from a REAL overview payload.
 * States never guess: null inputs map to UNKNOWN, only measured conditions
 * map to ERROR/DEGRADED/CONNECTED/RUNNING.
 */
export function deriveStatusStrip(ov: DcOverview): DcStatusTile[] {
  const tiles: DcStatusTile[] = [];
  const m = ov.mongo;
  const sys = ov.system;
  const ws = ov.websocket;
  const p = ov.pipeline;
  const s = ov.scheduler;
  const api = ov.api;
  const st = ov.storage;

  // Internet
  tiles.push({
    kind: 'internet',
    label: 'Internet',
    status: sys.internet == null ? 'UNKNOWN' : sys.internet ? 'CONNECTED' : 'DISCONNECTED',
    detail: sys.internet == null ? 'not measured' : sys.internet ? 'reachable' : 'offline',
    href: null,
  });

  // Backend (this process answered -> RUNNING)
  tiles.push({
    kind: 'backend',
    label: 'Backend',
    status: ov.generatedAt ? 'RUNNING' : 'UNKNOWN',
    detail: ov.generatedAt ? `uptime ${fmtUptime(sys.uptimeSeconds)}` : 'no response',
    href: null,
  });

  // MongoDB
  const mongoStatus: DcCanonicalStatus = m.connected
    ? m.pingMs != null && m.pingMs >= LATENCY_BANDS.criticalMs
      ? 'DEGRADED'
      : 'CONNECTED'
    : 'DISCONNECTED';
  tiles.push({
    kind: 'mongo',
    label: 'MongoDB',
    status: mongoStatus,
    detail: m.connected
      ? `${m.dbName ?? 'DB'} · ${m.pingMs != null ? `${Math.round(m.pingMs)}ms` : 'ping n/a'}`
      : 'disconnected',
    href: '#collections',
  });

  // WebSocket (canonical ws_manager)
  const wsStatus: DcCanonicalStatus = ws.connected
    ? ws.reconnectCount != null && ws.reconnectCount > 0
      ? 'DEGRADED'
      : 'CONNECTED'
    : 'DISCONNECTED';
  tiles.push({
    kind: 'websocket',
    label: 'WebSocket',
    status: wsStatus,
    detail: ws.connected
      ? `${ws.lifecycleState ?? 'connected'} · ${fmtNumber(ws.subscribedSymbols)} subscribed`
      : ws.disconnectReason ?? 'disconnected',
    href: '/data-saver/websocket',
  });

  // Tick pipeline (canonical tick_buffer)
  const pipelineStatus: DcCanonicalStatus = p.running
    ? (p.totalWriteErrors != null && p.totalWriteErrors > 0) || p.lastError
      ? 'DEGRADED'
      : 'RUNNING'
    : 'STOPPED';
  tiles.push({
    kind: 'pipeline',
    label: 'Tick pipeline',
    status: pipelineStatus,
    detail: p.running
      ? p.ticksPerSecond != null
        ? `${p.ticksPerSecond.toFixed(1)} tps · ${fmtNumber(p.totalWritten)} written`
        : 'running'
      : 'idle',
    href: '/data-saver/ticks',
  });

  // Scheduler
  const schedStatus: DcCanonicalStatus = s.running
    ? 'RUNNING'
    : s.isTradingDay
      ? 'DEGRADED'
      : 'STOPPED';
  tiles.push({
    kind: 'scheduler',
    label: 'Scheduler',
    status: schedStatus,
    detail: s.state ?? (s.running ? 'running' : 'stopped'),
    href: '/data-saver/schedules',
  });

  // API telemetry (24h)
  const apiStatus: DcCanonicalStatus =
    api == null || api.requests == null || api.requests === 0
      ? 'UNKNOWN'
      : (api.serverErrors ?? 0) > 0
        ? 'ERROR'
        : (api.errors ?? 0) > 0
          ? 'DEGRADED'
          : 'RUNNING';
  tiles.push({
    kind: 'api',
    label: 'API (24h)',
    status: apiStatus,
    detail: api == null
      ? 'not measured'
      : `${fmtNumber(api.requests)} req · ${api.errors != null ? fmtNumber(api.errors) : '–'} err${api.avgLatencyMs != null ? ` · ${api.avgLatencyMs.toFixed(1)}ms avg` : ''}`,
    href: '/data-saver/insights/activity',
  });

  // Storage (host disk)
  const storageStatus: DcCanonicalStatus =
    st.diskPercent == null
      ? 'UNKNOWN'
      : st.diskPercent >= 90
        ? 'ERROR'
        : st.diskPercent >= 75
          ? 'DEGRADED'
          : 'CONNECTED';
  tiles.push({
    kind: 'storage',
    label: 'Storage',
    status: storageStatus,
    detail: st.diskPercent != null ? `${st.diskPercent.toFixed(1)}% used` : 'not measured',
    href: '/data-saver/settings/storage',
  });

  return tiles;
}

/** A date used for chart keys: 'YYYY-MM-DD' (IST-safe, backend-aligned). */
export function shortDate(isoStr: string | null | undefined): string {
  const s = iso(isoStr);
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Time-only label for chart axes ('HH:MM' IST). */
export function clockLabel(isoStr: string | null | undefined): string {
  const s = iso(isoStr);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b) || b <= 0) return 'N/A';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b < 1024 * 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(b / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB`;
}

export function fmtNumber(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'N/A';
  return v.toLocaleString('en-IN');
}

export function fmtCompact(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return 'N/A';
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(n);
}

/** IST clock/date label for a backend ISO timestamp. */
export function fmtIst(isoStr: string | null | undefined): string {
  const s = iso(isoStr);
  if (!s) return 'N/A';
  return new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

export function fmtUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'N/A';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Latency status tone from real ms measurement. */
export function latencyTone(ms: number | null | undefined): DcHealthTone {
  if (ms == null || !Number.isFinite(ms)) return 'na';
  if (ms >= LATENCY_BANDS.criticalMs) return 'err';
  if (ms >= LATENCY_BANDS.warningMs) return 'warn';
  return 'ok';
}