'use client';

// ---- Data Center: ONE canonical store for the Downloads data-management page ----
//
// The page's PRIMARY data is the single backend-owned snapshot
// (`GET /api/phase2/data-center/snapshot`). One request, one document, one
// source of truth for every engine. Everything else in this store is an
// on-demand deep view (history, trend, per-collection detail) or a manual
// action, so a normal page view issues exactly one backend call.
//
// Cadences:
//   SNAPSHOT  15s  one request -> every primary panel. The backend serves it
//                    from its own 10s cache, so polls never fan out.
//   SLOW      60s  history/trend/telemetry/cleanup + the four registry/index
//                    scan planes, which are heavy and not needed for first paint.
//
// Initial load runs in TWO rounds so the page paints fast without dropping any
// connection: round 1 is the snapshot alone and clears `loading`; round 2
// fetches the deep views in the background. Each later cadence only refreshes
// its own group and merges in place, so a slow section that did not make it
// into a live round is never blanked by that round.
//
// Timers start when the first subscriber attaches and STOP when the last one
// leaves (page navigation), aborting any in-flight request and keeping the last
// valid payload so a remount shows data instantly. Auto-refresh can be paused
// while the tab keeps ticking `now` for freshness labels.

import { useSyncExternalStore } from 'react';
import { realtimeClient } from './realtime-ws';
import {
  DC_WIRE_SECTIONS,
  normalizeCollectionDetail,
  normalizeDcEnvelope,
} from './data-center';
import {
  DC_SNAPSHOT_SCHEMA_VERSION,
  isCompatibleSchema,
  normalizeDeepScanJob,
  normalizeSnapshot,
} from './data-center-snapshot';
import type {
  DcDeepScanJob,
  DcDeepScanStartResponse,
  DcSnapshot,
} from './data-center-snapshot';
import type {
  DcApiTelemetry,
  DcCleanupPayload,
  DcCollectionDetail,
  DcDatabasePlane,
  DcDbWriterPlane,
  DcEnginesPlane,
  DcHistoryPayload,
  DcOverview,
  DcOwnershipPlane,
  DcRetentionPlane,
  DcSectionKey,
  DcSnapshotsPayload,
  DcTicksPayload,
  DcTopologyPlane,
  DcTrendPayload,
  DcWireSection,
} from './data-center';

const POLL_LIVE_MS = 15_000; // backend snapshot cache TTL is 10s -> polls hit it
const POLL_SLOW_MS = 60_000;
const HEARTBEAT_MS = 5_000;
/** How often a running deep-scan job reports its progress. */
const DEEP_SCAN_POLL_MS = 1_500;
/** Safety net so a lost status response can never leave the button stuck. */
const DEEP_SCAN_MAX_WATCH_MS = 60_000;
/**
 * WS#2 pushes the data-center document every ~5 s while the page is open.
 * If no push has landed for this long the 15s REST fallback takes over, so a
 * silently dead socket degrades instead of leaving the page on stale data.
 */
const REALTIME_STALE_MS = 20_000;

export type DcAction = 'capture' | 'deep-scan' | 'cleanup';

interface DcDetailEntry {
  loading: boolean;
  data: DcCollectionDetail | null;
  error: string | null;
}

export type DcWindowDays = 7 | 14 | 30;

export interface DcStoreState {
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
  /** Active MongoDB identity / server facts / storage totals. */
  database: DcDatabasePlane | null;
  databaseError: string | null;
  /** Engine Registry status for the documented engine set. */
  engines: DcEnginesPlane | null;
  enginesError: string | null;
  /** Real engine dependency graph. */
  topology: DcTopologyPlane | null;
  topologyError: string | null;
  /** DB Writer authoritative tick pipeline. */
  dbWriter: DcDbWriterPlane | null;
  dbWriterError: string | null;
  /** Live collection inventory joined to the documented owner map. */
  ownership: DcOwnershipPlane | null;
  ownershipError: string | null;
  /** Real TTL indexes + 06:00 IST cleanup contract. */
  retention: DcRetentionPlane | null;
  retentionError: string | null;
  generatedAt: string | null;
  days: DcWindowDays;
  /** First-load in progress (nothing rendered yet). */
  loading: boolean;
  /** A poll is currently in flight. */
  refreshing: boolean;
  lastSuccessAt: number | null;
  /** Fatal transport error (route unreachable). */
  error: string | null;
  /** Auto-refresh timers running. */
  autoRefresh: boolean;
  now: number;
  detail: Record<string, DcDetailEntry>;
  actionBusy: DcAction | null;
  /**
   * THE primary data set: one backend-owned document covering every engine.
   * `null` only before the very first response lands.
   */
  dcSnapshot: DcSnapshot | null;
  /** Transport/envelope failure for the snapshot request. */
  dcSnapshotError: string | null;
  /**
   * Set when the backend speaks a different snapshot schema than the client
   * understands. Non-null means the page is showing a contract it was not
   * written for, which must be visible rather than silently rendered.
   */
  schemaWarning: string | null;
  /**
   * Where the currently displayed snapshot came from: the 15s REST poll
   * (fallback) or a realtime WS#2 push. The page labels the source so a pushed
   * document is never mistaken for a polled one.
   */
  snapshotSource: 'poll' | 'realtime';
  /** Epoch ms of the last accepted realtime snapshot push (WS#2), or null. */
  realtimeUpdatedAt: number | null;
  /** True while the shared WS#2 socket is connected (drives the live badge). */
  realtimeConnected: boolean;
  /** Live deep-scan job state, including real progress. */
  deepScan: DcDeepScanJob | null;
}

const EMPTY_STATE: DcStoreState = {
  overview: null,
  overviewError: null,
  history: null,
  historyError: null,
  ticks: null,
  ticksError: null,
  trend: null,
  trendError: null,
  snapshots: null,
  snapshotsError: null,
  apiTelemetry: null,
  apiTelemetryError: null,
  cleanup: null,
  cleanupError: null,
  database: null,
  databaseError: null,
  engines: null,
  enginesError: null,
  topology: null,
  topologyError: null,
  dbWriter: null,
  dbWriterError: null,
  ownership: null,
  ownershipError: null,
  retention: null,
  retentionError: null,
  generatedAt: null,
  days: 14,
  loading: true,
  refreshing: false,
  lastSuccessAt: null,
  error: null,
  autoRefresh: true,
  now: Date.now(),
  detail: {},
  actionBusy: null,
  dcSnapshot: null,
  dcSnapshotError: null,
  schemaWarning: null,
  snapshotSource: 'poll',
  realtimeUpdatedAt: null,
  realtimeConnected: false,
  deepScan: null,
};

type Listener = () => void;

type SecKey = DcSectionKey;

// Section groups are derived from the single typed wire-name list in
// ./data-center, so a name can never drift from what the proxy accepts.
const ALL_SECTIONS = DC_WIRE_SECTIONS;

// Sections the page actually needs. Keeping ALL_SECTIONS as the superset lets
// urlFor() add the `sections` param so the proxy never returns a section the
// page does not render, and so a new plane can be requested without touching
// the others. `ticks` is the intra-day activity aggregate: it is fetched, but
// only in the background round (see BACKGROUND_SECTIONS), so it can never gate
// first paint.
const FETCH_SECTIONS = [
  'overview',
  'history',
  'ticks',
  'trend',
  'api-telemetry',
  'cleanup',
  'database',
  'engines',
  'topology',
  'dbWriter',
  'ownership',
  'retention',
] as const satisfies readonly DcWireSection[];

// Live plane (cheap in-process snapshot, 10s backend TTL) vs slow plane
// (registry / index scan, 30s backend TTL) so the 15s poll never hammers Mongo.
const LIVE_PLANES = ['database', 'dbWriter'] as const satisfies readonly DcWireSection[];
const SLOW_PLANES = ['engines', 'topology', 'ownership', 'retention'] as const satisfies readonly DcWireSection[];

// FIRST PAINT — the page must render as soon as these land, so they are the only
// sections that gate `loading`. Everything else (history/trend/telemetry/cleanup
// and the four registry/index-scan planes) streams in immediately afterwards and
// fills its own skeleton, so a slow Mongo aggregate can never hold the page back.
const CRITICAL_SECTIONS = [
  'overview',
  ...LIVE_PLANES,
] as const satisfies readonly DcWireSection[];

// Everything that is NOT first paint. Fetched in the background right after the
// critical round so every engine/plane is still connected, just never awaited
// before the page is visible.
//
// NOTE: `overview` carries the host-disk probe (diskTotal/Used/%) that the
// Database card renders as Total/Full/Free. The snapshot alone does NOT include
// host disk, so overview MUST be part of the background round — otherwise the
// space section stays dashed forever.
const BACKGROUND_SECTIONS: readonly DcWireSection[] = [
  'overview',
  ...FETCH_SECTIONS.filter(
    (s) => !(CRITICAL_SECTIONS as readonly DcWireSection[]).includes(s),
  ),
];

function urlFor(days: number, sections: readonly DcWireSection[]): string {
  const q = new URLSearchParams({
    days: String(days),
    hours: '24',
    resolution_min: '5',
    limit: '60',
  });
  if (sections.length < ALL_SECTIONS.length) q.set('sections', sections.join(','));
  return `/api/phase2/data-center?${q.toString()}`;
}

class DataCenterStore {
  private state: DcStoreState = { ...EMPTY_STATE };
  private listeners = new Set<Listener>();
  private snapshot: DcStoreState = this.state;
  private started = false;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private slowTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private inflight: AbortController | null = null;
  /** In-flight background round (non-critical planes) — aborted on unmount. */
  private backgroundInFlight: AbortController | null = null;
  /** WS#2 realtime wiring for the snapshot push (attached while subscribed). */
  private realtimeFrameOff: (() => void) | null = null;
  private realtimeStateOff: (() => void) | null = null;

  // -- subscription ------------------------------------------------------
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    if (!this.started && typeof window !== 'undefined') {
      this.startTimers();
    }
    return () => {
      this.listeners.delete(listener);
      // Page left / last consumer unmounted -> stop polling and abort in-flight.
      if (this.listeners.size === 0) this.stopTimers();
    };
  };

  getSnapshot = (): DcStoreState => this.snapshot;

  private setState(patch: Partial<DcStoreState>): void {
    this.state = { ...this.state, ...patch };
    this.snapshot = this.state;
    this.listeners.forEach((l) => l());
  }

  private startTimers(): void {
    if (this.started) return;
    this.started = true;
    void this.refreshAll();
    this.attachRealtime();
    if (this.state.autoRefresh) {
      this.startIntervals();
    }
    this.heartbeatTimer = setInterval(() => {
      this.setState({ now: Date.now() });
    }, HEARTBEAT_MS);
  }

  private startIntervals(): void {
    if (this.liveTimer) clearInterval(this.liveTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.liveTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.hidden) return;
      // The WS#2 `data_center` push is the primary path for the primary
      // panels; REST only re-synchronises when the socket cannot deliver
      // (backend down, or no push for PUSH_STALE_MS).
      const stale =
        !this.state.realtimeConnected ||
        this.state.snapshotSource !== 'realtime' ||
        (this.state.realtimeUpdatedAt != null &&
          Date.now() - this.state.realtimeUpdatedAt > REALTIME_STALE_MS);
      if (stale) void this.refreshLive();
    }, POLL_LIVE_MS);
    this.slowTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.hidden) return;
      void this.refreshSlow();
    }, POLL_SLOW_MS);
  }

  private stopTimers(): void {
    this.inflight?.abort();
    this.inflight = null;
    this.backgroundInFlight?.abort();
    this.backgroundInFlight = null;
    this.detachRealtime();
    if (this.liveTimer) clearInterval(this.liveTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.liveTimer = null;
    this.slowTimer = null;
    this.heartbeatTimer = null;
    this.started = false;
  }

  // -- realtime (WS#2 snapshot push) -------------------------------------
  /**
   * Subscribe to the `data_center` state channel on the ONE shared WS#2 socket.
   *
   * Driven from the store rather than a React hook on purpose: the realtime
   * provider re-renders its consumers on every market tick (~4Hz), and making
   * this very long page a consumer would re-render all of it at tick rate. The
   * store only reacts to `data_center.snapshot` frames, and re-subscribes on
   * reconnect so the push survives a dropped socket. The 15s REST poll keeps
   * running regardless and remains the fallback.
   */
  private attachRealtime(): void {
    if (this.realtimeFrameOff) return;
    this.realtimeFrameOff = realtimeClient.onFrame((frame) => {
      if (frame.type !== 'data_center.snapshot') return;
      const envelope = frame.data as { data?: unknown } | undefined;
      const body = envelope?.data ?? frame.data;
      if (!body || typeof body !== 'object') return;
      this.applyRealtimeSnapshot(body);
    });
    this.realtimeStateOff = realtimeClient.onStateChange((state) => {
      const connected = state === 'CONNECTED';
      if (connected !== this.state.realtimeConnected) {
        this.setState({ realtimeConnected: connected });
      }
      if (connected) {
        void realtimeClient.subscribe([{ channel: 'data_center' }]).catch(() => {});
      }
    });
    void realtimeClient.subscribe([{ channel: 'data_center' }]).catch(() => {});
  }

  private detachRealtime(): void {
    this.realtimeFrameOff?.();
    this.realtimeStateOff?.();
    this.realtimeFrameOff = null;
    this.realtimeStateOff = null;
    // Stop the backend building/pushing snapshots for a page that is gone.
    void realtimeClient.unsubscribe([{ channel: 'data_center' }]).catch(() => {});
    this.setState({ realtimeConnected: false });
  }

  // -- data --------------------------------------------------------------
  /**
   * Fetch and normalise the one authoritative snapshot.
   *
   * This is the only request the primary panels depend on. On failure the last
   * valid snapshot is KEPT (so a transient network blip does not blank the
   * page) and the error is surfaced separately, because a stale-but-real value
   * and a failed-to-load value are different things.
   */
  private async refreshSnapshot(): Promise<boolean> {
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    try {
      const res = await fetch('/api/phase2/data-center/snapshot', {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      const snapshot = normalizeSnapshot(await res.json());
      this.setState({
        dcSnapshot: snapshot,
        dcSnapshotError: snapshot.transportError,
        schemaWarning: isCompatibleSchema(snapshot)
          ? null
          : `backend speaks snapshot schema v${snapshot.schemaVersion}; this page expects v${DC_SNAPSHOT_SCHEMA_VERSION}`,
        snapshotSource: 'poll',
        loading: false,
        error: null,
        lastSuccessAt: Date.now(),
      });
      return true;
    } catch (e) {
      if (controller.signal.aborted) return false;
      this.setState({
        loading: false,
        // Keep `dcSnapshot` as-is: a stale real value beats a blank page, and
        // `refreshing`/`dcSnapshotError` tell the reader how old it is.
        error: e instanceof Error ? e.message : 'Failed to reach the data center',
        refreshing: false,
      });
      return false;
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }

  /**
   * Apply a snapshot pushed over WS#2 (`data_center` channel).
   *
   * This is the realtime path for the primary panels; the 15s REST poll remains
   * the fallback. The pushed document is the SAME backend aggregation the REST
   * endpoint serves, so it is normalised and validated exactly the same way. A
   * push is ignored when it is a schema we do not understand, carries a
   * transport error, or is older than what is already displayed — realtime must
   * never regress the page to a worse or stale document.
   */
  applyRealtimeSnapshot(raw: unknown): void {
    const snapshot = normalizeSnapshot(raw);
    if (!isCompatibleSchema(snapshot) || snapshot.transportError) return;
    const incoming = snapshot.generatedAt ? Date.parse(snapshot.generatedAt) : NaN;
    const current = this.state.dcSnapshot?.generatedAt
      ? Date.parse(this.state.dcSnapshot.generatedAt)
      : NaN;
    if (Number.isFinite(incoming) && Number.isFinite(current) && incoming < current) return;
    this.setState({
      dcSnapshot: snapshot,
      dcSnapshotError: null,
      schemaWarning: null,
      snapshotSource: 'realtime',
      realtimeUpdatedAt: Date.now(),
      loading: false,
      error: null,
      lastSuccessAt: Date.now(),
    });
  }

  private async fetchRaw(days: number, sections: readonly DcWireSection[]): Promise<unknown> {
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    try {
      const res = await fetch(urlFor(days, sections), { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      return res.json();
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }

  /** Merge a normalized envelope in place — only sections present are applied. */
  private applyEnvelope(raw: unknown): void {
    const n = normalizeDcEnvelope(raw);
    const patch: Partial<DcStoreState> = {
      loading: false,
      error: null,
      lastSuccessAt: Date.now(),
      generatedAt: n.generatedAt ?? this.state.generatedAt,
    };
    const apply: Record<SecKey, Partial<DcStoreState>> = {
      overview: { overview: n.overview, overviewError: n.overviewError },
      history: { history: n.history, historyError: n.historyError },
      ticks: { ticks: n.ticks, ticksError: n.ticksError },
      trend: { trend: n.trend, trendError: n.trendError },
      snapshots: { snapshots: n.snapshots, snapshotsError: n.snapshotsError },
      apiTelemetry: { apiTelemetry: n.apiTelemetry, apiTelemetryError: n.apiTelemetryError },
      cleanup: { cleanup: n.cleanup, cleanupError: n.cleanupError },
      database: { database: n.database, databaseError: n.databaseError },
      engines: { engines: n.engines, enginesError: n.enginesError },
      topology: { topology: n.topology, topologyError: n.topologyError },
      dbWriter: { dbWriter: n.dbWriter, dbWriterError: n.dbWriterError },
      ownership: { ownership: n.ownership, ownershipError: n.ownershipError },
      retention: { retention: n.retention, retentionError: n.retentionError },
    };
    for (const key of n.present) {
      Object.assign(patch, apply[key]);
    }
    this.setState(patch);
  }

  async refreshAll(_force = false): Promise<void> {
    if (this.state.actionBusy) return;
    if (!this.started && typeof window !== 'undefined') {
      this.startTimers();
      return;
    }
    this.setState({ refreshing: true });
    // Round 1 gates the first paint and is ONE request: the snapshot.
    const ok = await this.refreshSnapshot();
    this.setState({ refreshing: false });
    if (!ok) {
      // A failed first round must not leave the deep views blank until the 60s
      // cadence: the background round is independent, so it still gets its turn.
      void this.fetchBackground();
      return;
    }
    // Round 2 connects the deep views in the background. Deliberately NOT
    // awaited: the page is already fully rendered from the snapshot, and
    // holding it on a 12s registry/index scan is what made this page feel slow.
    void this.fetchBackground();
  }

  /**
   * Second half of the first load. Keeps the last valid payload per section, so
   * if this round is aborted by the next poll the slow planes simply keep their
   * previous value instead of flashing empty.
   */
  private async fetchBackground(): Promise<void> {
    if (this.backgroundInFlight) return;
    const controller = new AbortController();
    this.backgroundInFlight = controller;
    try {
      const res = await fetch(urlFor(this.state.days, BACKGROUND_SECTIONS), {
        signal: controller.signal,
      });
      if (!res.ok) return;
      this.applyEnvelope(await res.json());
    } catch {
      // aborted by a newer poll, or the backend is down — the live poll retries.
    } finally {
      if (this.backgroundInFlight === controller) this.backgroundInFlight = null;
    }
  }

  /**
   * The live cadence. One request, one document, every primary panel.
   *
   * This deliberately does NOT also refetch the section envelope: the snapshot
   * already carries storage, database, realtime, session, scheduler,
   * persistence and market data, so re-requesting them would be a second
   * opinion about the same facts.
   */
  async refreshLive(force = false): Promise<void> {
    if (!this.started) return;
    if (!force && this.state.refreshing) return;
    this.setState({ refreshing: true });
    await this.refreshSnapshot();
    this.setState({ refreshing: false });
  }

  async refreshSlow(force = false): Promise<void> {
    if (!this.started) return;
    if (!force && this.state.refreshing) return;
    this.setState({ refreshing: true });
    try {
      const raw = await this.fetchRaw(this.state.days, [
        'overview',
        'history',
        'trend',
        'api-telemetry',
        'cleanup',
        ...SLOW_PLANES,
      ]);
      this.applyEnvelope(raw);
    } catch {
      this.setState({ refreshing: false });
      return;
    }
    this.setState({ refreshing: false });
  }

  // -- actions -----------------------------------------------------------
  async captureSnapshot(): Promise<{ ok: boolean; message?: string }> {
    if (this.state.actionBusy) return { ok: false, message: 'Another action is running.' };
    this.setState({ actionBusy: 'capture' });
    try {
      const res = await fetch('/api/phase2/data-center', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'capture' }),
      });
      const data = await res.json().catch(() => ({}));
      this.setState({ actionBusy: null });
      if (!res.ok) {
        return { ok: false, message: (data as { detail?: string }).detail ?? `Capture failed (${res.status})` };
      }
      await this.refreshAll(true);
      return { ok: Boolean(data?.ok), message: (data as { message?: string }).message };
    } finally {
      this.setState({ actionBusy: null });
    }
  }

  /**
   * Start a deep scan and follow it to completion.
   *
   * The backend runs the scan as a bounded read-only job, so this only starts
   * it and then polls its real status. `deepScan.status` is the single source
   * of truth for "running / completed / failed" — the UI never decides that
   * itself, and there is no state in which the button is stuck on "running".
   */
  async runDeepScan(): Promise<{ ok: boolean; message?: string }> {
    if (this.state.actionBusy) return { ok: false, message: 'Another action is running.' };
    this.setState({ actionBusy: 'deep-scan', deepScan: null });

    let jobId: string;
    try {
      const res = await fetch('/api/phase2/data-center', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deep-scan' }),
      });
      const data = (await res.json().catch(() => ({}))) as DcDeepScanStartResponse & {
        detail?: string;
      };
      if (!res.ok || !data?.ok || !data.jobId) {
        const message =
          (data as { error?: string; detail?: string })?.error ??
          (data as { detail?: string })?.detail ??
          `Deep scan could not start (${res.status})`;
        this.setState({ actionBusy: null });
        return { ok: false, message };
      }
      jobId = data.jobId;
    } catch (e) {
      this.setState({ actionBusy: null });
      return {
        ok: false,
        message: e instanceof Error ? e.message : 'Could not reach the data center',
      };
    }

    this.setState({
      deepScan: {
        jobId,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        progress: { phase: 'starting', collectionsTotal: null, collectionsDone: 0, currentCollection: null },
        error: null,
        result: null,
      },
    });

    const watched = await this.watchDeepScan(jobId);
    this.setState({ actionBusy: null });
    if (!watched.ok) {
      return { ok: false, message: watched.message };
    }
    await this.refreshSnapshot();
    return { ok: true, message: 'Deep scan finished.' };
  }

  /** Poll one job until it reports completion or failure. */
  private async watchDeepScan(
    jobId: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const deadline = Date.now() + DEEP_SCAN_MAX_WATCH_MS;
    while (Date.now() < deadline) {
      if (!this.started && this.listeners.size === 0) {
        // The user left the page mid-scan. Report it honestly rather than
        // pretending the scan finished.
        this.setState({
          deepScan: {
            jobId,
            status: 'failed',
            startedAt: null,
            finishedAt: new Date().toISOString(),
            durationMs: null,
            progress: null,
            error: 'You left the page before the scan finished. The backend scan was still running.',
            result: null,
          },
        });
        return { ok: false, message: 'You left the page before the scan finished.' };
      }
      try {
        const res = await fetch('/api/phase2/data-center', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deep-scan-status', jobId }),
        });
        const job = normalizeDeepScanJob(await res.json().catch(() => null));
        if (!job) {
          return { ok: false, message: `The backend no longer knows this scan (${res.status}).` };
        }
        this.setState({ deepScan: job });
        if (job.status === 'completed') return { ok: true };
        if (job.status === 'failed') {
          return { ok: false, message: job.error ?? 'Deep scan failed.' };
        }
      } catch {
        // A dropped status poll is not a failed scan — the next tick retries.
      }
      await new Promise((resolve) => setTimeout(resolve, DEEP_SCAN_POLL_MS));
    }
    this.setState({
      deepScan: this.state.deepScan
        ? {
            ...this.state.deepScan,
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: 'The backend stopped reporting progress for this scan.',
          }
        : null,
    });
    return { ok: false, message: 'The backend stopped reporting progress for this scan.' };
  }

  /**
   * 1-click cleanup: backend `/api/system/cleanup/run` removes data and keeps
   * config. `mode: 'safe'` wipes temporary market data + telemetry only;
   * `mode: 'full'` additionally wipes ticks history, notifications, alerts,
   * events and reports. Afterwards BOTH the snapshot (space numbers) and the
   * slow planes (cleanup status) refresh, so one click visibly frees space.
   */
  async runCleanup(mode: 'safe' | 'full' = 'safe'): Promise<{ ok: boolean; message?: string; deleted?: number | null }> {
    if (this.state.actionBusy) return { ok: false, message: 'Another action is running.' };
    this.setState({ actionBusy: 'cleanup' });
    try {
      const res = await fetch('/api/phase2/data-center', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cleanup-run', mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, message: (data as { detail?: string; message?: string }).message ?? (data as { detail?: string }).detail ?? `Cleanup failed (${res.status})` };
      }
      // Refresh space numbers FIRST so the DB card updates immediately, then
      // the cleanup status planes. Both are awaited — one click = visible result.
      await this.refreshSnapshot();
      await this.refreshSlow(true);
      const body = data as { ok?: boolean; message?: string; data?: { totalDeleted?: number } };
      const deleted =
        typeof body?.data?.totalDeleted === 'number'
          ? body.data.totalDeleted
          : typeof (body as unknown as { totalDeleted?: unknown })?.totalDeleted === 'number'
            ? (body as unknown as { totalDeleted: number }).totalDeleted
            : null;
      return {
        ok: body?.ok ?? true,
        message: body?.message ?? (deleted != null ? `${deleted} records cleaned.` : 'Cleanup pass finished.'),
        deleted,
      };
    } finally {
      this.setState({ actionBusy: null });
    }
  }

  async loadCollection(name: string): Promise<void> {
    const existing = this.state.detail[name];
    if (existing?.data || (existing && existing.loading)) return;
    this.setState({
      detail: { ...this.state.detail, [name]: { loading: true, data: null, error: null } },
    });
    try {
      const res = await fetch(`/api/phase2/data-center/collections/${encodeURIComponent(name)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { detail?: string }).detail ?? `Request failed (${res.status})`);
      }
      const data = await res.json();
      const normalized = normalizeCollectionDetail((data as { data?: unknown })?.data ?? data);
      this.setState({
        detail: {
          ...this.state.detail,
          [name]: { loading: false, data: normalized, error: null },
        },
      });
    } catch (e) {
      this.setState({
        detail: {
          ...this.state.detail,
          [name]: { loading: false, data: null, error: e instanceof Error ? e.message : 'Failed' },
        },
      });
    }
  }

  /** Change the history window (days) and refetch every section immediately. */
  setWindow(days: DcWindowDays): void {
    if (days === this.state.days) return;
    this.setState({ days });
    void this.refreshAll(true);
  }

  /** Pause/resume the live + slow poll timers. */
  setAutoRefresh(on: boolean): void {
    if (on === this.state.autoRefresh) return;
    this.setState({ autoRefresh: on });
    if (this.started) {
      if (on) {
        this.startIntervals();
        void this.refreshLive();
      } else {
        if (this.liveTimer) clearInterval(this.liveTimer);
        if (this.slowTimer) clearInterval(this.slowTimer);
        this.liveTimer = null;
        this.slowTimer = null;
      }
    }
  }

  /** Trigger a browser download of a real Data Center view. */
  openExport(format: 'csv' | 'json'): void {
    if (typeof window === 'undefined') return;
    const a = document.createElement('a');
    a.href = `/api/phase2/data-center/export?kind=daily&format=${format}&days=${this.state.days}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

const store = new DataCenterStore();

/** Shared snapshot for Data Center store consumers. */
export function useDataCenterStore(): DcStoreState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Imperative actions for the page (share the same store instance). */
export const dataCenterActions = {
  refresh: () => store.refreshAll(true),
  captureSnapshot: () => store.captureSnapshot(),
  runDeepScan: () => store.runDeepScan(),
  runCleanup: (mode: 'safe' | 'full' = 'safe') => store.runCleanup(mode),
  loadCollection: (name: string) => store.loadCollection(name),
  openExport: (format: 'csv' | 'json') => store.openExport(format),
  setWindow: (days: DcWindowDays) => store.setWindow(days),
  setAutoRefresh: (on: boolean) => store.setAutoRefresh(on),
};