/**
 * Data Center — the ONE authoritative snapshot contract (schema v2).
 *
 * This is the only wire contract the Data Center page's primary data comes
 * from. The backend (`python-service/services/data_center_snapshot.py`) owns
 * every value; this module only types it and normalises it defensively.
 *
 * The normalisation rules are the important part:
 *
 *  - `num()` returns `null` for anything that is not a finite number. A missing
 *    measurement is NEVER coerced to `0`, `''` or `false` — those are
 *    measurements, and showing one when we have none is a lie.
 *  - `str()` returns `null` rather than a placeholder string.
 *  - Every section keeps `available` and the real `error` the backend reported,
 *    so a broken section is visible as broken instead of silently empty.
 *  - `frontendRealtime` is the one field the backend cannot fill; it stays
 *    `measurable: false` here and is filled from the browser's own realtime
 *    client via `withFrontendRealtime()`.
 */

export const DC_SNAPSHOT_SCHEMA_VERSION = 2;

/** The nine sections the page renders, in render order. */
export const DC_SNAPSHOT_SECTIONS = [
  'runtime',
  'database',
  'storage',
  'realtime',
  'session',
  'scheduler',
  'persistence',
  'marketData',
  'health',
] as const;

export type DcSnapshotSection = (typeof DC_SNAPSHOT_SECTIONS)[number];

export const DC_HEALTH_CATEGORIES = [
  'database',
  'persistence',
  'realtime',
  'session',
  'scheduler',
  'marketData',
] as const;

export type DcHealthCategory = (typeof DC_HEALTH_CATEGORIES)[number];

/**
 * Every state the UI is allowed to render. `UNKNOWN` is a first-class value:
 * it means "the backend did not report this", which is different from
 * `OFFLINE`, `NOT_CONFIGURED` and `DISABLED`.
 */
export type DcState = 'OK' | 'DEGRADED' | 'DOWN' | 'WAITING' | 'UNKNOWN';

export type DcAvailability = 'OK' | 'DEGRADED' | 'NOT_CONFIGURED' | 'OFFLINE' | 'DISABLED';

interface DcSectionBase {
  available: boolean;
  /** The backend module that produced these numbers. */
  source: string;
  /** The real reason this section is unavailable, or `null`. */
  error: string | null;
  generatedAt: string | null;
}

export interface DcRuntimeSection extends DcSectionBase {
  terminalMode: string | null;
  terminalModeAvailable: boolean;
  isPaperTerminal: boolean | null;
  knownTerminals: string[];
  sessionMode: string | null;
  sessionBroker: string | null;
  sessionModeError: string | null;
  process: {
    pid: number | null;
    python: string | null;
    startedAt: string | null;
    uptimeSeconds: number | null;
    host: string | null;
    platform: string | null;
  };
}

export interface DcDatabaseSection extends DcSectionBase {
  connected: boolean | null;
  configured: boolean | null;
  provider: string | null;
  providerAvailable: boolean;
  providerDerivedFrom: 'active connection' | 'configuration' | null;
  configuredSource: string | null;
  activeSource: string | null;
  database: string | null;
  host: string | null;
  serverVersion: string | null;
  connectedAt: string | null;
  pool: { checkedOut?: number | null; maxPoolSize?: number | null } | Record<string, never>;
}

export interface DcStorageCollection {
  name: string;
  count: number | null;
  countIsApproximate: boolean;
  sizeBytes: number | null;
  storageBytes: number | null;
  avgObjSizeBytes: number | null;
  indexSizeBytes: number | null;
  indexes: number | null;
  health: string | null;
}

export interface DcStorageSection extends DcSectionBase {
  dbName: string | null;
  documents: number | null;
  dataSizeBytes: number | null;
  storageSizeBytes: number | null;
  indexSizeBytes: number | null;
  collectionsCount: number | null;
  indexesCount: number | null;
  pingMs: number | null;
  lastUpdatedAt: string | null;
  collections: DcStorageCollection[];
  collectionsAvailable: boolean;
}

export interface DcBrokerFeed {
  available: boolean;
  source?: string;
  error?: string | null;
  connected: boolean | null;
  state: string | null;
  lifecycleState: string | null;
  supervisorState: string | null;
  feedState: string | null;
  subscribedSymbols: number | null;
  subscriptionCount: number | null;
  connectCount: number | null;
  reconnectAttempts: number | null;
  disconnectReason: string | null;
  disconnectReasonCode: string | null;
  internetOk: boolean | null;
  ticksPerSecond: number | null;
  lastTickAt: string | null;
}

export interface DcBackendRealtime {
  available: boolean;
  source?: string;
  error?: string | null;
  started: boolean | null;
  startedAt: string | null;
  activeConnections: number | null;
  totalConnections: number | null;
  messagesDelivered: number | null;
  messagesDropped: number | null;
  framesRouted: number | null;
  queueDepthMax: number | null;
  queueLimit: number | null;
  feedFreshness: string | null;
  lastTickAgeSeconds: number | null;
  ticksPerSecond: number | null;
  health: string | null;
  healthReason: string | null;
}

/**
 * The browser measures its own socket, so this starts out unmeasurable and is
 * filled in by `withFrontendRealtime()`.
 */
export interface DcFrontendRealtime {
  measurable: false;
  reason: string;
  note: string | null;
}

export interface DcMeasuredFrontendRealtime {
  measurable: true;
  state: string;
  connected: boolean;
  /** Where the number came from, so it is never confused with backend data. */
  measuredBy: 'browser';
  lastMessageAt: string | null;
  reconnectAttempts: number | null;
  note: string | null;
}

export type DcRealtimeSection = DcSectionBase & {
  brokerFeed: DcBrokerFeed;
  backendRealtime: DcBackendRealtime;
  frontendRealtime: DcFrontendRealtime | DcMeasuredFrontendRealtime;
};

export interface DcSessionSection extends DcSectionBase {
  state: string | null;
  lifecycleState: string | null;
  active: boolean | null;
  expired: boolean | null;
  mode: string | null;
  broker: string | null;
  userId: string | null;
  loginSource: string | null;
  loginTime: string | null;
  expiresAt: string | null;
  remainingSeconds: number | null;
  lastActivityAt: string | null;
  lastAuthError: string | null;
  reconnectCount: number | null;
}

export interface DcMarketPhase {
  available: boolean;
  error?: string | null;
  marketState: string | null;
  marketSession: string | null;
  marketStatus: string | null;
  tradingDay: boolean | null;
  reasonCode: string | null;
  reasonMessage: string | null;
  closureReason: string | null;
  isWeekend: boolean | null;
  isExchangeHoliday: boolean | null;
  nextMarketOpen: string | null;
  nextMarketClose: string | null;
}

export interface DcSchedulerSection extends DcSectionBase {
  state: string | null;
  stateSince: string | null;
  phase: string | null;
  phaseSince: string | null;
  nextPhase: string | null;
  nextPhaseAt: string | null;
  isTradingDay: boolean | null;
  inLoginWindow: boolean | null;
  inWebSocketWindow: boolean | null;
  inTickCollectionWindow: boolean | null;
  sessionOwner: string | null;
  loginAttempts: number | null;
  loginError: string | null;
  webSocketAttempts: number | null;
  webSocketError: string | null;
  running: boolean | null;
  market: DcMarketPhase;
}

export interface DcPersistenceSection extends DcSectionBase {
  authoritative: boolean;
  engineId: string | null;
  state: string | null;
  health: string | null;
  healthReason: string | null;
  version: string | null;
  lastHeartbeat: string | null;
  ticksReceived: number | null;
  ticksPersisted: number | null;
  writeErrors: number | null;
  bufferLength: number | null;
  ticksPerSecond: number | null;
  lastTickAt: string | null;
  lastWriteAt: string | null;
  lastFlushAt: string | null;
  lastFlushDurationMs: number | null;
  pipelineRunning: boolean | null;
  feedLatencyMs: number | null;
  lastError: string | null;
}

export interface DcMarketDataSection extends DcSectionBase {
  engineId: string | null;
  state: string | null;
  health: string | null;
  healthReason: string | null;
  lifecycleState: string | null;
  feedState: string | null;
  eligibleSymbols: number | null;
  eligibleStateCount: number | null;
  subscribedSymbols: number | null;
  liveInstruments: number | null;
  staleInstruments: number | null;
  noDataInstruments: number | null;
  pendingInstruments: number | null;
  ticks: number | null;
  ticksPerSecond: number | null;
  lastTickAt: string | null;
  lastRankingAt: string | null;
  lastPublishAt: string | null;
}

export interface DcHealthEntry {
  category: DcHealthCategory;
  state: DcState;
  reason: string | null;
}

export interface DcHealthSection {
  source: string;
  generatedAt: string | null;
  overall: DcState;
  categories: DcHealthEntry[];
  marketPhase: string | null;
  marketStatus: string | null;
  /** `false` when the rollup itself could not be derived. */
  available: boolean;
  error: string | null;
}

export interface DcSnapshot {
  schemaVersion: number;
  generatedAt: string | null;
  buildMs: number | null;
  overall: DcState;
  runtime: DcRuntimeSection;
  database: DcDatabaseSection;
  storage: DcStorageSection;
  realtime: DcRealtimeSection;
  session: DcSessionSection;
  scheduler: DcSchedulerSection;
  persistence: DcPersistenceSection;
  marketData: DcMarketDataSection;
  health: DcHealthSection;
  /** Sections the backend could not read, with their real reasons. */
  unavailableSections: DcSnapshotSection[];
  /** True when the whole snapshot failed and nothing is real yet. */
  transportError: string | null;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------
type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite number, or `null`. Never `0` for "missing". */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A non-empty string, or `null`. Never a placeholder. */
export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A real boolean, or `null`. Never coerced from a truthy value. */
export function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function base(raw: unknown, fallbackSource: string): DcSectionBase & Rec {
  const r = isRec(raw) ? raw : {};
  return {
    ...r,
    available: r.available === true,
    source: str(r.source) ?? fallbackSource,
    error: str(r.error),
    generatedAt: str(r.generatedAt),
  };
}

const STATES: readonly string[] = ['OK', 'DEGRADED', 'DOWN', 'WAITING', 'UNKNOWN'];

function state(v: unknown): DcState {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return (STATES as readonly string[]).includes(s) ? (s as DcState) : 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// section normalisers
// ---------------------------------------------------------------------------
function normaliseRuntime(raw: unknown): DcRuntimeSection {
  const r = base(raw, 'services.data_center_snapshot');
  const p = isRec(r.process) ? r.process : {};
  return {
    available: r.available,
    source: r.source,
    error: r.error,
    generatedAt: r.generatedAt,
    terminalMode: str(r.terminalMode),
    terminalModeAvailable: r.terminalModeAvailable === true,
    isPaperTerminal: bool(r.isPaperTerminal),
    knownTerminals: strList(r.knownTerminals),
    sessionMode: str(r.sessionMode),
    sessionBroker: str(r.sessionBroker),
    sessionModeError: str(r.sessionModeError),
    process: {
      pid: num(p.pid),
      python: str(p.python),
      startedAt: str(p.startedAt),
      uptimeSeconds: num(p.uptimeSeconds),
      host: str(p.host),
      platform: str(p.platform),
    },
  };
}

function normaliseDatabase(raw: unknown): DcDatabaseSection {
  const r = base(raw, 'database.connection.get_mongo_info');
  const pool = isRec(r.pool) ? r.pool : {};
  const derived = r.providerDerivedFrom;
  return {
    available: r.available,
    source: r.source,
    error: r.error,
    generatedAt: r.generatedAt,
    connected: bool(r.connected),
    configured: bool(r.configured),
    provider: str(r.provider),
    providerAvailable: r.providerAvailable === true,
    providerDerivedFrom:
      derived === 'active connection' || derived === 'configuration' ? derived : null,
    configuredSource: str(r.configuredSource),
    activeSource: str(r.activeSource),
    database: str(r.database),
    host: str(r.host),
    serverVersion: str(r.serverVersion),
    connectedAt: str(r.connectedAt),
    pool: pool as DcDatabaseSection['pool'],
  };
}

function normaliseCollection(raw: unknown): DcStorageCollection | null {
  if (!isRec(raw)) return null;
  const name = str(raw.name);
  if (!name) return null;
  return {
    name,
    count: num(raw.count),
    countIsApproximate: raw.countIsApproximate === true,
    sizeBytes: num(raw.sizeBytes),
    storageBytes: num(raw.storageBytes),
    avgObjSizeBytes: num(raw.avgObjSizeBytes),
    indexSizeBytes: num(raw.indexSizeBytes),
    indexes: num(raw.indexes),
    health: str(raw.health),
  };
}

function normaliseStorage(raw: unknown): DcStorageSection {
  const r = base(raw, 'api.system.mongo_stats');
  const list = Array.isArray(r.collections) ? r.collections : null;
  return {
    available: r.available,
    source: r.source,
    error: r.error,
    generatedAt: r.generatedAt,
    dbName: str(r.dbName),
    documents: num(r.documents),
    dataSizeBytes: num(r.dataSizeBytes),
    storageSizeBytes: num(r.storageSizeBytes),
    indexSizeBytes: num(r.indexSizeBytes),
    collectionsCount: num(r.collectionsCount),
    indexesCount: num(r.indexesCount),
    pingMs: num(r.pingMs),
    lastUpdatedAt: str(r.lastUpdatedAt),
    collections: list ? list.map(normaliseCollection).filter((c): c is DcStorageCollection => c !== null) : [],
    collectionsAvailable: r.collectionsAvailable === true && list !== null,
  };
}

function normaliseBrokerFeed(raw: unknown): DcBrokerFeed {
  const r = isRec(raw) ? raw : {};
  return {
    available: r.available === true,
    source: str(r.source) ?? undefined,
    error: str(r.error),
    connected: bool(r.connected),
    state: str(r.state),
    lifecycleState: str(r.lifecycleState),
    supervisorState: str(r.supervisorState),
    feedState: str(r.feedState),
    subscribedSymbols: num(r.subscribedSymbols),
    subscriptionCount: num(r.subscriptionCount),
    connectCount: num(r.connectCount),
    reconnectAttempts: num(r.reconnectAttempts),
    disconnectReason: str(r.disconnectReason),
    disconnectReasonCode: str(r.disconnectReasonCode),
    internetOk: bool(r.internetOk),
    ticksPerSecond: num(r.ticksPerSecond),
    lastTickAt: str(r.lastTickAt),
  };
}

function normaliseBackendRealtime(raw: unknown): DcBackendRealtime {
  const r = isRec(raw) ? raw : {};
  return {
    available: r.available === true,
    source: str(r.source) ?? undefined,
    error: str(r.error),
    started: bool(r.started),
    startedAt: str(r.startedAt),
    activeConnections: num(r.activeConnections),
    totalConnections: num(r.totalConnections),
    messagesDelivered: num(r.messagesDelivered),
    messagesDropped: num(r.messagesDropped),
    framesRouted: num(r.framesRouted),
    queueDepthMax: num(r.queueDepthMax),
    queueLimit: num(r.queueLimit),
    feedFreshness: str(r.feedFreshness),
    lastTickAgeSeconds: num(r.lastTickAgeSeconds),
    ticksPerSecond: num(r.ticksPerSecond),
    health: str(r.health),
    healthReason: str(r.healthReason),
  };
}

function normaliseFrontendRealtime(raw: unknown): DcFrontendRealtime | DcMeasuredFrontendRealtime {
  const r = isRec(raw) ? raw : {};
  if (r.measurable === true && typeof r.state === 'string' && typeof r.connected === 'boolean') {
    return {
      measurable: true,
      state: r.state,
      connected: r.connected,
      measuredBy: 'browser',
      lastMessageAt: str(r.lastMessageAt),
      reconnectAttempts: num(r.reconnectAttempts),
      note: str(r.note),
    };
  }
  return {
    measurable: false,
    reason: str(r.reason) ?? 'not measured by the backend',
    note: str(r.note),
  };
}

function normaliseRealtime(raw: unknown): DcRealtimeSection {
  const r = base(raw, 'ws_manager.status + connection_engine.status');
  return {
    available: r.available,
    source: r.source,
    error: r.error,
    generatedAt: r.generatedAt,
    brokerFeed: normaliseBrokerFeed(r.brokerFeed),
    backendRealtime: normaliseBackendRealtime(r.backendRealtime),
    frontendRealtime: normaliseFrontendRealtime(r.frontendRealtime),
  };
}

function normaliseSession(raw: unknown): DcSessionSection {
  const r = base(raw, 'services.session.session_manager.snapshot');
  return {
    available: r.available,
    source: r.source,
    error: r.error,
    generatedAt: r.generatedAt,
    state: str(r.state),
    lifecycleState: str(r.lifecycleState),
    active: bool(r.active),
    expired: bool(r.expired),
    mode: str(r.mode),
    broker: str(r.broker),
    userId: str(r.userId),
    loginSource: str(r.loginSource),
    loginTime: str(r.loginTime),
    expiresAt: str(r.expiresAt),
    remainingSeconds: num(r.remainingSeconds),
    lastActivityAt: str(r.lastActivityAt),
    lastAuthError: str(r.lastAuthError),
    reconnectCount: num(r.reconnectCount),
  };
}

function normaliseMarketPhase(raw: unknown): DcMarketPhase {
  const r = isRec(raw) ? raw : {};
  return {
    available: r.available === true,
    error: str(r.error),
    marketState: str(r.marketState),
    marketSession: str(r.marketSession),
    marketStatus: str(r.marketStatus),
    tradingDay: bool(r.tradingDay),
    reasonCode: str(r.reasonCode),
    reasonMessage: str(r.reasonMessage),
    closureReason: str(r.closureReason),
    isWeekend: bool(r.isWeekend),
    isExchangeHoliday: bool(r.isExchangeHoliday),
    nextMarketOpen: str(r.nextMarketOpen),
    nextMarketClose: str(r.nextMarketClose),
  };
}

function normaliseScheduler(raw: unknown): DcSchedulerSection {
  const r = base(raw, 'scheduler.get_scheduler_state');
  return {
    available: r.available,
    source: r.source,
    error: r.error,
    generatedAt: r.generatedAt,
    state: str(r.state),
    stateSince: str(r.stateSince),
    phase: str(r.phase),
    phaseSince: str(r.phaseSince),
    nextPhase: str(r.nextPhase),
    nextPhaseAt: str(r.nextPhaseAt),
    isTradingDay: bool(r.isTradingDay),
    inLoginWindow: bool(r.inLoginWindow),
    inWebSocketWindow: bool(r.inWebSocketWindow),
    inTickCollectionWindow: bool(r.inTickCollectionWindow),
    sessionOwner: str(r.sessionOwner),
    loginAttempts: num(r.loginAttempts),
    loginError: str(r.loginError),
    webSocketAttempts: num(r.webSocketAttempts),
    webSocketError: str(r.webSocketError),
    running: bool(r.running),
    market: normaliseMarketPhase(r.market),
  };
}

function normalisePersistence(raw: unknown): DcPersistenceSection {
  const r = base(raw, 'services.db_writer_engine.status_snapshot');
  return {
    available: r.available,
    source: r.source,
    error: r.error,
    generatedAt: r.generatedAt,
    authoritative: r.authoritative === true,
    engineId: str(r.engineId),
    state: str(r.state),
    health: str(r.health),
    healthReason: str(r.healthReason),
    version: str(r.version),
    lastHeartbeat: str(r.lastHeartbeat),
    ticksReceived: num(r.ticksReceived),
    ticksPersisted: num(r.ticksPersisted),
    writeErrors: num(r.writeErrors),
    bufferLength: num(r.bufferLength),
    ticksPerSecond: num(r.ticksPerSecond),
    lastTickAt: str(r.lastTickAt),
    lastWriteAt: str(r.lastWriteAt),
    lastFlushAt: str(r.lastFlushAt),
    lastFlushDurationMs: num(r.lastFlushDurationMs),
    pipelineRunning: bool(r.pipelineRunning),
    feedLatencyMs: num(r.feedLatencyMs),
    lastError: str(r.lastError),
  };
}

function normaliseMarketData(raw: unknown): DcMarketDataSection {
  const r = base(raw, 'services.market_watch_engine.status_snapshot');
  return {
    available: r.available,
    source: r.source,
    error: r.error,
    generatedAt: r.generatedAt,
    engineId: str(r.engineId),
    state: str(r.state),
    health: str(r.health),
    healthReason: str(r.healthReason),
    lifecycleState: str(r.lifecycleState),
    feedState: str(r.feedState),
    eligibleSymbols: num(r.eligibleSymbols),
    eligibleStateCount: num(r.eligibleStateCount),
    subscribedSymbols: num(r.subscribedSymbols),
    liveInstruments: num(r.liveInstruments),
    staleInstruments: num(r.staleInstruments),
    noDataInstruments: num(r.noDataInstruments),
    pendingInstruments: num(r.pendingInstruments),
    ticks: num(r.ticks),
    ticksPerSecond: num(r.ticksPerSecond),
    lastTickAt: str(r.lastTickAt),
    lastRankingAt: str(r.lastRankingAt),
    lastPublishAt: str(r.lastPublishAt),
  };
}

/**
 * @param transportError
 *   Set when the envelope itself failed. The health rollup is derived from the
 *   other sections, so with no snapshot body there is nothing to roll up and the
 *   section is honestly unavailable rather than an empty-but-"available" report.
 */
function normaliseHealth(raw: unknown, transportError: string | null): DcHealthSection {
  // Health is DERIVED, not read from an engine, so it has no `available` flag of
  // its own: it is available unless the derivation itself failed.
  const envelope = isRec(raw) ? raw : {};
  const r = base(raw, 'derived from the sections above (no new measurement)');
  const failed = envelope.available === false;
  const hasBody = Object.keys(envelope).length > 0;
  const error = r.error ?? (transportError && !hasBody ? transportError : null);
  const rawCategories = Array.isArray(r.categories) ? r.categories : [];
  const categories: DcHealthEntry[] = [];
  for (const c of rawCategories) {
    if (!isRec(c)) continue;
    const category = str(c.category);
    // An unknown category is dropped, not rendered as a fake one.
    if (!category || !(DC_HEALTH_CATEGORIES as readonly string[]).includes(category)) continue;
    categories.push({
      category: category as DcHealthCategory,
      state: state(c.state),
      reason: str(c.reason),
    });
  }
  return {
    available: !failed && error === null,
    source: r.source,
    error,
    generatedAt: r.generatedAt,
    overall: state(r.overall),
    categories,
    marketPhase: str(r.marketPhase),
    marketStatus: str(r.marketStatus),
  };
}

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------
/**
 * Normalise the proxy response into a `DcSnapshot`.
 *
 * A malformed or partial payload still yields a renderable snapshot: every
 * section is present, and the ones with no real data are marked unavailable
 * with `transportError` set. Nothing is ever defaulted to a healthy-looking
 * value.
 */
export function normalizeSnapshot(raw: unknown): DcSnapshot {
  // Accept both the proxy envelope ({ ok, data }) and a bare snapshot.
  const envelope = isRec(raw) ? raw : {};
  const body = isRec(envelope.data) ? envelope.data : envelope;
  const transportError =
    envelope.ok === false
      ? str(envelope.error) ?? str(envelope.detail) ?? 'the data center endpoint reported a failure'
      : null;

  const snapshot: DcSnapshot = {
    schemaVersion: num(body.schemaVersion) ?? 0,
    generatedAt: str(body.generatedAt),
    buildMs: num(body.buildMs),
    overall: 'UNKNOWN',
    runtime: normaliseRuntime(body.runtime),
    database: normaliseDatabase(body.database),
    storage: normaliseStorage(body.storage),
    realtime: normaliseRealtime(body.realtime),
    session: normaliseSession(body.session),
    scheduler: normaliseScheduler(body.scheduler),
    persistence: normalisePersistence(body.persistence),
    marketData: normaliseMarketData(body.marketData),
    health: normaliseHealth(body.health, transportError),
    unavailableSections: [],
    transportError,
  };

  snapshot.unavailableSections = DC_SNAPSHOT_SECTIONS.filter((name) => {
    if (name === 'health') return !snapshot.health.available;
    return !snapshot[name].available;
  });

  // The overall verdict is the backend's. If the transport failed outright the
  // snapshot is not real at all, and the page must not claim otherwise.
  if (transportError && snapshot.unavailableSections.length === DC_SNAPSHOT_SECTIONS.length) {
    snapshot.overall = 'UNKNOWN';
  } else {
    snapshot.overall = state(body.overall) === 'UNKNOWN' ? snapshot.health.overall : state(body.overall);
  }

  return snapshot;
}

/**
 * Attach the browser's own realtime measurement to a snapshot.
 *
 * The backend cannot see the browser's socket, so this is the only way
 * `frontendRealtime` ever becomes measurable, and it is always stamped
 * `measuredBy: 'browser'` so the two are never confused.
 */
export function withFrontendRealtime(
  snapshot: DcSnapshot,
  measured: Omit<DcMeasuredFrontendRealtime, 'measurable' | 'measuredBy'> | null,
): DcSnapshot {
  if (!measured) return snapshot;
  return {
    ...snapshot,
    realtime: {
      ...snapshot.realtime,
      frontendRealtime: { measurable: true, measuredBy: 'browser', ...measured },
    },
  };
}

/** `true` when a schema we understand is talking to us. */
export function isCompatibleSchema(snapshot: DcSnapshot): boolean {
  return snapshot.schemaVersion === DC_SNAPSHOT_SCHEMA_VERSION;
}

// ---------------------------------------------------------------------------
// Deep scan job
//
// The backend owns a full-database scan as a bounded, read-only job so the
// request that starts it returns immediately. Progress, completion and failure
// are separate observable states - the page never has to guess whether a scan
// is still running.
// ---------------------------------------------------------------------------
export interface DcDeepScanProgress {
  phase: string | null;
  collectionsTotal: number | null;
  collectionsDone: number | null;
  currentCollection: string | null;
}

export interface DcDeepScanCollection {
  name: string;
  count: number | null;
  countIsApproximate: boolean;
  storageBytes: number | null;
  indexSizeBytes: number | null;
  health: string | null;
}

export interface DcDeepScanResult {
  db: string | null;
  collectionsCount: number | null;
  totalObjects: number | null;
  totalStorageBytes: number | null;
  totalIndexSizeBytes: number | null;
  collections: DcDeepScanCollection[];
}

export interface DcDeepScanJob {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  progress: DcDeepScanProgress | null;
  error: string | null;
  result: DcDeepScanResult | null;
}

export type DcDeepScanStartResponse =
  | { ok: true; jobId: string; status: 'running'; startedAt: string | null }
  | { ok: false; error: string };

/** Normalise a deep-scan job. Returns `null` for anything without a job id. */
export function normalizeDeepScanJob(raw: unknown): DcDeepScanJob | null {
  const envelope = isRec(raw) ? raw : {};
  if (envelope.ok === false) return null;
  // The proxy returns { ok, data } for status and { ok, jobId } for the start.
  const body = isRec(envelope.data) ? envelope.data : envelope;
  const jobId = str(body.jobId);
  if (!jobId) return null;

  const p = isRec(body.progress) ? body.progress : null;
  const result = isRec(body.result) ? body.result : null;
  const totals = result && isRec(result.totals) ? result.totals : null;
  const collections = result && Array.isArray(result.collections) ? result.collections : [];

  const status = body.status === 'completed' || body.status === 'failed' ? body.status : 'running';

  return {
    jobId,
    status,
    startedAt: str(body.startedAt),
    finishedAt: str(body.finishedAt),
    durationMs: num(body.durationMs),
    progress: p
      ? {
          phase: str(p.phase),
          collectionsTotal: num(p.collectionsTotal),
          collectionsDone: num(p.collectionsDone),
          currentCollection: str(p.currentCollection),
        }
      : null,
    error: str(body.error),
    result: result
      ? {
          db: str(result.db),
          collectionsCount: num(totals?.collectionsCount),
          totalObjects: num(totals?.totalObjects),
          totalStorageBytes: num(totals?.totalStorageBytes),
          totalIndexSizeBytes: num(totals?.totalIndexSizeBytes),
          collections: collections.map((c): DcDeepScanCollection => {
            const r = isRec(c) ? c : {};
            return {
              name: str(r.name) ?? '',
              count: num(r.count),
              countIsApproximate: r.countIsApproximate === true,
              storageBytes: num(r.storageBytes),
              indexSizeBytes: num(r.indexSizeBytes),
              health: str(r.health),
            };
          }),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// formatting helpers — the honest rendering primitives
// ---------------------------------------------------------------------------
export const DASH = '—';

/** A number, or an explicit "not measured" marker. Never a fake zero. */
export function fmtInt(value: number | null, unavailable = DASH): string {
  return value === null ? unavailable : value.toLocaleString('en-IN');
}

export function fmtDec(value: number | null, digits = 1, unavailable = DASH): string {
  if (value === null) return unavailable;
  if (!Number.isFinite(value)) return unavailable;
  return value.toFixed(digits);
}

export function fmtPct(value: number | null, unavailable = DASH): string {
  return value === null ? unavailable : `${value.toFixed(1)}%`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function fmtBytes(value: number | null, unavailable = DASH): string {
  if (value === null || !Number.isFinite(value) || value < 0) return unavailable;
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < BYTE_UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function fmtDuration(seconds: number | null, unavailable = DASH): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return unavailable;
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtAgo(iso: string | null, now: number, unavailable = DASH): string {
  if (!iso) return unavailable;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return unavailable;
  const delta = Math.max(0, Math.round((now - t) / 1000));
  return `${fmtDuration(delta)} ago`;
}

export function fmtClock(iso: string | null, unavailable = DASH): string {
  if (!iso) return unavailable;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return unavailable;
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
}

/** Turn a raw engine state string into a title-case label, unchanged otherwise. */
export function humanState(value: string | null, unavailable = 'UNKNOWN'): string {
  if (!value) return unavailable;
  return value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export type DcBadgeStatus = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

/**
 * Map a health state to its badge.
 *
 * `UNKNOWN` is deliberately `neutral`, not `warning`: "the backend did not
 * report this" must not look like a detected fault, and it must not look
 * healthy either.
 */
export function stateBadge(state: DcState | null | undefined): {
  status: DcBadgeStatus;
  label: string;
} {
  switch (state) {
    case 'OK':
      return { status: 'success', label: 'OK' };
    case 'DEGRADED':
      return { status: 'warning', label: 'DEGRADED' };
    case 'DOWN':
      return { status: 'danger', label: 'DOWN' };
    case 'WAITING':
      return { status: 'info', label: 'WAITING' };
    default:
      return { status: 'neutral', label: 'UNKNOWN' };
  }
}
