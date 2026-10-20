import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';
import { fmtBytes } from '@/lib/formatters';
import {
  REASON_TAXONOMY,
  reasonBreakdown,
} from '@/lib/reason-taxonomy';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Data Saver Dashboard.
 *
 * ONE aggregated dashboard endpoint. It fetches a single, cached + request-
 * deduped backend payload (`/api/system/dashboard`) and shapes it into the
 * dashboard envelope. Every metric is derived from REAL backend state.
 *
 * Every card on the page is driven by a `states.<card>` entry with a fixed
 * anatomy:
 *   value       – the actual number/string, or null when the backend genuinely
 *                 has no measurement to offer (the UI then renders an explicit
 *                 "not available" WITHOUT a fake number and always with a
 *                 real reason behind it).
 *   status      – ok | warn | err | idle | na  (idle = paused/expected-inactive,
 *                 na = no source of truth available)
 *   reason      – WHY the value is what it is right now (market closed,
 *                 scheduler state, measured age, next scheduled event, ...).
 *   lastUpdated – ISO timestamp of when that fact was last true/current.
 *   source      – the real backend component that produced the number.
 *   detail      – extra real facts (per-collection breakdown, thresholds, ...).
 *
 * Nothing is fabricated: if the backend cannot measure something, `value` is
 * null and the reason says exactly that.
 */

const DASH_TTL_MS = 30000;

// Proxy timeout for the cached backend dashboard build. The backend dashboard
// aggregation occasionally rebuilds its expensive quality-metrics component
// (cached 120s on backend + 30s on frontend), and that single cold build can
// take 12-18s under high RAM / Mongo load (server at 95% RAM). The timeout
// must be comfortably above worst case so a slow-but-SUCCESSFUL backend
// response is delivered instead of being dropped and mis-reported as
// "system offline" (502 spam). 25s gives headroom over the 20s quality
// aggregation timeout observed.
const DASH_BACKEND_TIMEOUT_MS = 25000;

let dashCache: { key: string; at: number; data: any } | null = null;
let dashInflight: Promise<any> | null = null;
let dashReqCounter = 0;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function isoFromEpochSec(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return new Date(v * 1000).toISOString();
}

function fmtUptime(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

type StateStatus = 'ok' | 'warn' | 'err' | 'idle' | 'na';

interface StateCard {
  value: number | string | null;
  status: StateStatus;
  reason: string;
  lastUpdated: string | null;
  source: string;
  detail?: string[] | null;
}

function card(
  value: number | string | null,
  status: StateStatus,
  reason: string,
  lastUpdated: string | null,
  source: string,
  detail?: string[] | null,
): StateCard {
  return { value, status, reason, lastUpdated, source, detail: detail ?? null };
}

// Upper bound for serving a stale payload while the backend is slow/down.
// The client already retains last-good-data, but serving stale from the Next
// layer keeps every poll fast (ms, not 5-25s) and stops the 502 error-flood
// that made the page look "stuck" until a restart.
const STALE_SERVE_MS = 5 * 60 * 1000;

async function refreshDashboard(key: string, hours: number): Promise<any> {
  const reqId = ++dashReqCounter;
  const res = await backendFetch(`/api/system/dashboard?hours=${hours}`, {
    timeoutMs: DASH_BACKEND_TIMEOUT_MS,
  });
  // A backend failure or timeout MUST NOT be flattened into a successful
  // empty payload: that would overwrite previously-good frontend data with
  // blanks (the "all offline" flap). Surface it as an error instead.
  if (!res.ok || res.data == null) {
    const err = new Error(
      `[DASHBOARD][req=${reqId}] backend unreachable: status=${res.status} error=${res.error || 'no data'}`,
    );
    (err as any).source = 'backend';
    (err as any).reqId = reqId;
    throw err;
  }
  const data = res.data as any;
  dashCache = { key, at: Date.now(), data };
  await new Promise((resolve) => setTimeout(resolve, 0));
  return data;
}

async function fetchDashboardData(hours: number, force = false): Promise<any> {
  const key = String(hours);
  const now = Date.now();
  // `?refresh=1` — an explicit user action (e.g. Manual Login) needs the
  // CURRENT backend state, not a payload cached up to DASH_TTL_MS ago.
  if (!force && dashCache && dashCache.key === key && now - dashCache.at < DASH_TTL_MS) {
    return dashCache.data;
  }
  // Stale-while-revalidate: when we hold a recent payload for this key, serve
  // it IMMEDIATELY and refresh in the background instead of blocking the
  // response for up to 25s on a slow backend (the 5-13s hangs + 502s in logs).
  // Only a true cold start (no cache) blocks on the backend fetch.
  if (!force && dashCache?.data && dashCache.key === key && now - dashCache.at < STALE_SERVE_MS) {
    if (!dashInflight) {
      const task = refreshDashboard(key, hours);
      dashInflight = task;
      void task
        .catch((err) => {
          console.warn(`[DASHBOARD] background revalidate failed (serving stale): ${(err as Error)?.message ?? err}`);
        })
        .finally(() => {
          if (dashInflight === task) dashInflight = null;
        });
    }
    return dashCache.data;
  }
  if (!dashInflight) {
    const task = refreshDashboard(key, hours);
    dashInflight = task;
    void task
      .catch(() => {
        // Cold-path callers await dashInflight and handle the rejection in the
        // GET catch below; this swallow only prevents an unhandled rejection
        // from the shared promise (the awaiting GET still sees the error).
      })
      .finally(() => {
        if (dashInflight === task) dashInflight = null;
      });
  }
  return dashInflight;
}

const STALE_TICK_SEC = 300; // 5 min without a tick => pipeline considered stopped

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const hoursParam = url.searchParams.get('hours');
  const hours = Math.max(1, Math.min(720, Number(hoursParam) || 168));
  // Explicit refresh from the client (a user-initiated action) — bypass this
  // module's payload cache so the response reflects backend state NOW.
  const force = url.searchParams.get('refresh') === '1';

  let agg: any;
  try {
    agg = await fetchDashboardData(hours, force);
  } catch (err) {
    const e = err as any;
    console.error(
      `[DASHBOARD req=${e?.reqId ?? '?'}] FAILED hours=${hours}: ${(e as Error).message}`,
    );
    // If we have a stale cached payload (even expired), serve it instead of 502.
    // The client already retains last-good-data, but serving stale avoids the
    // error-flood (console.error every 10s) and lets the page stay fast.
    if (dashCache?.data) {
      console.warn(`[DASHBOARD] serving stale cache after backend failure (age ${Math.round((Date.now() - dashCache.at)/1000)}s)`);
      agg = dashCache.data;
    } else {
      return Response.json(
        {
          error: 'backend-unavailable',
          message: 'The dashboard backend could not be reached. Last valid data was retained by the client.',
          hours,
          ok: false,
        },
        { status: 502 },
      );
    }
  }

  if (!agg || typeof agg !== 'object') {
    console.error(`[DASHBOARD] FAILED: backend returned non-object payload hours=${hours}`);
    return Response.json(
      {
        error: 'backend-invalid',
        message: 'The dashboard backend returned an unusable payload. Last valid data was retained by the client.',
        hours,
        ok: false,
      },
      { status: 502 },
    );
  }

  const sys: any = agg.system || {};
  const node: any = sys.node || {};
  const buffer: any = sys.buffer || {};
  const live: any = sys.liveData || {};
  const wsDetail: any = sys.websocketDetail || {};
  const quality: any = agg.quality || {};
  const mongoRes: any = agg.mongo || {};
  const mongoStats: any = mongoRes.stats || null;
  const mongoConnected = Boolean(sys.mongo?.connected === true || mongoRes.connected === true);
  const rawEvents: any[] = Array.isArray(agg.events) ? agg.events : [];
  const sessionSnap: any = agg.session || {};
  const alerts: any[] = Array.isArray(agg.alerts) ? agg.alerts : [];

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  // ------------------------------------------------------------------
  // Storage — real filesystem bytes; falls back to real MongoDB bytes.
  // ------------------------------------------------------------------
  let capacity = num(node.diskTotalBytes);
  let used = num(node.diskUsedBytes);
  if (capacity == null && mongoStats) {
    capacity = num(mongoStats.totalStorageBytes);
    used = num(mongoStats.totalSizeBytes);
  }
  const free = capacity != null && used != null ? capacity - used : null;

  // Storage categories — real per-collection measurements (bytes on disk).
  let rawDataBytes: number | null = null;   // ticks collection
  let metadataBytes: number | null = null;  // everything except ticks
  let indexBytes: number | null = null;     // real index sizes
  let dbBytes: number | null = null;        // whole database on-disk total
  if (mongoConnected && mongoStats?.collections) {
    const cols: any[] = mongoStats.collections;
    const ticks = cols.find((c) => c.name === 'ticks');
    rawDataBytes = ticks ? num(ticks.storageBytes) : null;
    const others = cols.filter((c) => c.name !== 'ticks');
    if (others.length) {
      metadataBytes = others.reduce((sum, c) => sum + (Number(c.storageBytes) || 0), 0);
    }
    const sumIndex = (arr: any[]) => arr.reduce((s, c) => s + (Number(c.indexSizeBytes) || 0), 0);
    indexBytes = num(sumIndex(cols));
    if (num(mongoStats.totalStorageBytes) != null) dbBytes = num(mongoStats.totalStorageBytes);
  }

  // Real on-disk directory sizes from the backend (exports + logs).
  const storageDirs = Array.isArray(agg.storage?.dirs) ? agg.storage.dirs : [];

  // ------------------------------------------------------------------
  // Tick pipeline — real buffer counters + real connection state.
  // ------------------------------------------------------------------
  const ticksPerSec = num(live.ticksPerSecond);
  const writesPerSec = num(live.writesPerSecond);
  const totalWrites = num(buffer.totalWritten ?? buffer.totalWrites);
  const totalWriteErrors = num(buffer.totalWriteErrors);
  const totalReceived = num(buffer.totalReceived);
  const lastTickAtEpoch = num(buffer.lastTickAt);
  const lastWriteAtEpoch = num(buffer.lastWriteAt);

  const connected = Boolean(sys.websocketConnected);
  const lastTickAgeSec =
    lastTickAtEpoch != null ? (nowMs / 1000 - lastTickAtEpoch) : null;

  const pipelineActive =
    connected ||
    (lastTickAgeSec != null && lastTickAgeSec <= STALE_TICK_SEC) ||
    (totalReceived ?? 0) > 0;

  const pipelineState = connected ? 'live' : (totalReceived ?? 0) > 0 ? 'stopped' : 'stopped';
  const lastSavedAt = lastWriteAtEpoch != null ? isoFromEpochSec(lastWriteAtEpoch) : null;

  // ------------------------------------------------------------------
  // Save success rate — REAL attempts/results. null when zero attempts.
  // ------------------------------------------------------------------
  let saveSuccessRate: number | null = null;
  const attempted = (totalWrites ?? 0) + (totalWriteErrors ?? 0);
  if (attempted > 0) {
    saveSuccessRate = Number(((totalWrites ?? 0) / attempted) * 100);
  } else {
    const summaryAttempted = (num(sys.todayInserts) ?? 0) + (num(sys.errorCount) ?? 0);
    if (summaryAttempted > 0) {
      saveSuccessRate = Number(((num(sys.todayInserts) ?? 0) / summaryAttempted) * 100);
    }
  }

  // ------------------------------------------------------------------
  // WebSocket uptime — real connection timestamp → now while connected.
  // ------------------------------------------------------------------
  const connectedAt = isoOrNull(wsDetail.connected_at ?? sys.wsConnectedAt);
  const disconnectedAt = isoOrNull(wsDetail.disconnected_at ?? sys.wsDisconnectedAt);
  const lastConnectionAt = isoOrNull(wsDetail.last_connection_at ?? sys.wsLastConnectionAt);
  const processStartedAt = isoOrNull(sys.wsProcessStartedAt);
  const wsLastMessageAt = isoOrNull(wsDetail.last_message_at);

  let wsUptimeSec: number | null = null;
  if (connected && connectedAt) {
    const startMs = new Date(connectedAt).getTime();
    if (Number.isFinite(startMs)) wsUptimeSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  }

  // Real "offline since" — last real disconnect (or, if none, process start).
  const offlineSince = disconnectedAt ?? processStartedAt ?? null;

  let lastMessageAgeSec: number | null = null;
  if (wsLastMessageAt) {
    const t = new Date(wsLastMessageAt).getTime();
    if (Number.isFinite(t)) lastMessageAgeSec = Math.max(0, Math.floor((nowMs - t) / 1000));
  }

  const latencyMs = num(buffer?.feedLatencyMs?.currentMs) ?? num(wsDetail?.metrics?.latencyMs) ?? null;

  const reconnectCount = num(wsDetail.reconnect_count);
  const lifecycleState = str(wsDetail.lifecycle_state);
  const wsDisconnectReasonRaw = str(wsDetail.disconnect_reason ?? sys.wsDisconnectReason);
  const wsDisconnectReasonCode = str(wsDetail.disconnect_reason_code);

  // ------------------------------------------------------------------
  // Scheduler + Session — real state from backend schedulerInfo/schedulerState,
  // the real market calendar snapshot, and the real daily schedule.
  // ------------------------------------------------------------------
  const schedInfo: any = sys.schedulerInfo || {};
  const schedState: any = sys.schedulerState || {};
  const python: any = sys.pythonStatus || {};
  const marketSnap: any = agg.market || {};
  const scheduleSnap: any = agg.schedule || {};
  const statsBlk: any = agg.stats || {};

  const isTradingDay = Boolean(schedState.is_trading_day ?? schedInfo.is_trading_day ?? marketSnap.trading_day);
  const schedulerEnabled = Boolean(sys.schedulerEnabled);
  const schedulerRunning = Boolean(schedInfo.running ?? schedState.running);

  const scheduler = {
    running: schedulerRunning,
    enabled: schedulerEnabled,
    state: str(schedState.state ?? schedInfo.state) ?? 'UNKNOWN',
    isTradingDay,
    inLoginWindow: Boolean(schedState.in_login_window),
    inWsWindow: Boolean(schedState.in_ws_window),
    loginWindowApplicable: Boolean(schedState.login_window_applicable ?? isTradingDay),
    wsWindowApplicable: Boolean(schedState.ws_window_applicable ?? isTradingDay),
    loginTime: str(schedState.login_time) ?? null,
    logoutTime: str(schedState.logout_time) ?? null,
    wsStartTime: str(schedState.ws_start_time) ?? null,
    wsStopTime: str(schedState.ws_stop_time) ?? null,
    nextLogin: isoOrNull(schedState.next_login) ?? null,
    nextLogout: isoOrNull(schedState.next_logout) ?? null,
    nextWsStart: isoOrNull(schedState.next_ws_start) ?? null,
    nextWsStop: isoOrNull(schedState.next_ws_stop) ?? null,
    nextEvent: str(schedState.next_event) ?? null,
    nextEventAt: isoOrNull(schedState.next_event_at) ?? null,
    remainingSeconds: num(schedState.remaining_seconds),
    loginAttempts: num(schedState.login_attempts),
    loginError: str(schedState.login_error),
    wsAttempts: num(schedState.ws_attempts),
    wsError: str(schedState.ws_error),
    stateSince: isoOrNull(schedState.state_since),
    sessionOwner: str(schedState.session_owner),
    // Real market-calendar truth (weekend/holiday/closure reason — never invented).
    marketStatus: str(marketSnap.market_status) ?? null,
    marketSession: str(marketSnap.market_session) ?? null,
    marketDate: str(marketSnap.market_date) ?? null,
    dayClass: str(marketSnap.day_class) ?? null,
    closureReason: str(marketSnap.closure_reason) ?? null,
    isWeekend: Boolean(marketSnap.is_weekend),
    isExchangeHoliday: Boolean(marketSnap.is_exchange_holiday),
    isSpecialClosure: Boolean(marketSnap.is_special_closure),
    nextMarketOpen: isoOrNull(marketSnap.next_market_open) ?? null,
    nextMarketClose: isoOrNull(marketSnap.next_market_close) ?? null,
    // Today's real schedule windows (09:00 / 09:13 / 15:31 / 16:00 IST).
    todayLogin: isoOrNull(scheduleSnap.today_login_time) ?? null,
    todayWsStart: isoOrNull(scheduleSnap.today_ws_connect_time) ?? null,
    todayWsStop: isoOrNull(scheduleSnap.today_ws_disconnect_time) ?? null,
    todayLogout: isoOrNull(scheduleSnap.today_logout_time) ?? null,
    windowTimes: scheduleSnap.schedule ?? null,
    // Real per-transition lifecycle (login / ws_connect / ws_disconnect /
    // logout) with scheduled + actual + status + source — backend-derived.
    lifecycle: Array.isArray(scheduleSnap.scheduler_events) ? scheduleSnap.scheduler_events : [],
    nowIst: isoOrNull(scheduleSnap.now_ist_ts) ?? null,
    // Authoritative market state from backend MarketStateService
    marketState: str(marketSnap.market_state) ?? null,
    marketReasonCode: str(marketSnap.reason_code) ?? null,
    marketReasonMessage: str(marketSnap.reason_message) ?? null,
    marketStateSource: str(marketSnap.market_state_source) ?? null,
    confirmationWindowActive: Boolean(marketSnap.confirmation_window_active),
    ticksInWindow: num(marketSnap.ticks_in_window),
    uniqueInstrumentsInWindow: num(marketSnap.unique_instruments_in_window),
    dailyDecision: marketSnap.daily_decision ?? null,
    // Real persisted scheduler-run ledger (missed/caught-up/waiting runs today,
    // last successful/failed run, timezone) — backend schedulerInfo.ledger.
    ledger: schedInfo.ledger ?? (schedState.ledger ?? null),
    ledgerJobsToday: schedInfo.ledger_jobs_today ?? (schedState.ledger_jobs_today ?? null),
  };

  // ------------------------------------------------------------------
  // Session — ONE authority, read in the documented order.
  //
  // `docs/engines/session-manager.md` §41: "Session Manager is the
  // authoritative manager for: 1. Broker session lifecycle". `sessionSnap` IS
  // that Session Manager snapshot (backend `/api/system/dashboard` ->
  // `_build_dashboard`), and it is exactly what `POST /api/login` and
  // `GET /api/session/status` mutate.
  //
  // `pythonStatus` is `kotak_session.session_info()` — the KOTAK SDK session
  // module. It is legitimately "not logged in" whenever the active terminal is
  // `dummy` or `shoonya`, because in those modes there is no Kotak broker
  // session to have. It used to be read FIRST (`python.session_active ??
  // sessionSnap.active`), so a successful Dummy-Mode manual login evaluated to
  // `false ?? true` -> `false` and the dashboard reported "session inactive"
  // immediately after a login that had genuinely succeeded.
  //
  // Session Manager first; the Kotak view only fills a field the Session
  // Manager genuinely does not publish. No engine responsibility moves — the
  // backend still owns and publishes both; only the read precedence in this
  // proxy is corrected to match the documented authority.
  // ------------------------------------------------------------------
  const smLastLogout = sessionSnap.lastLogout ?? null;
  const session = {
    active: Boolean(sessionSnap.active ?? python.session_active),
    loggedIn: Boolean(sessionSnap.active ?? python.logged_in ?? python.session_active),
    user: str(sessionSnap.userId ?? python.user_id),
    state: str(sessionSnap.state ?? python.state),
    stateMessage: str(sessionSnap.stateMessage ?? python.state_message),
    loginCount: num(sessionSnap.loginCount ?? python.login_count),
    lastLoginAt: isoOrNull(sessionSnap.loginTime ?? sessionSnap.lastLogin ?? python.last_login_at),
    lastLogoutAt: isoOrNull(smLastLogout?.at ?? python.last_logout_at),
    loginSource: str(sessionSnap.lastSource ?? python.login_source),
    lastLoginError: str(sessionSnap.lastAuthError ?? python.last_login_error),
    lastLogoutReason: str(sessionSnap.lastLogoutReason ?? smLastLogout?.logoutReason ?? python.last_logout_reason),
    nextScheduledLogin: isoOrNull(sessionSnap.nextScheduledLogin),
    wsState: str(sessionSnap.brokerFeedState ?? python.ws_state),
    viewTokenPresent: Boolean(sessionSnap.viewTokenPresent ?? python.view_token_present),
    expiresAt: isoOrNull(sessionSnap.expiresAt),
    validatedAt: isoOrNull(sessionSnap.validatedAt),
    remainingSeconds: num(sessionSnap.remainingSeconds),
    sessionDurationSeconds: num(sessionSnap.sessionDurationSeconds),
  };

  // ------------------------------------------------------------------
  // Truthful human reasons for the current state (never fabricated).
  // Use the backend's authoritative market state service data.
  // ------------------------------------------------------------------
  const backendMarketState: string | null = str(marketSnap.market_state) ?? null;
  const backendReasonCode: string | null = str(marketSnap.reason_code) ?? null;
  const backendReasonMessage: string | null = str(marketSnap.reason_message) ?? null;

  const dayClassLabel = scheduler.isWeekend
    ? 'weekend'
    : scheduler.isExchangeHoliday
    ? 'exchange holiday'
    : scheduler.isSpecialClosure
    ? 'special closure'
    : 'non-trading day';

  // Use the backend's authoritative reason_message when available;
  // fall back to constructing it from calendar data.
  const marketClosedReason = isTradingDay
    ? null
    : (backendReasonMessage
        ? `${backendReasonMessage}${scheduler.nextMarketOpen ? ` Next open ${scheduler.nextMarketOpen}` : ''}.`
        : `Market is closed — ${dayClassLabel}${
            scheduler.closureReason ? ` (${scheduler.closureReason})` : ''
          }. No pipeline activity is scheduled${
            scheduler.nextMarketOpen ? `; next open ${scheduler.nextMarketOpen}` : ''
          }.`);

  const subscribed = statsBlk.subscribed || {};
  const recordsToday = num(statsBlk.recordsToday) ?? num(sys.todayRecords) ?? num(summaryInserts(sys));
  const todayInserts = num(statsBlk.todayInserts) ?? num(summaryInserts(sys));
  const recordsInDb = num(statsBlk.recordsInDb) ?? num(agg.totals?.ticksAllTime);
  const uniqueInstrumentsToday = num(statsBlk.uniqueInstrumentsToday);
  const firstTickTodayAt = isoOrNull(statsBlk.firstTickTodayAt);

  // ---- reason strings shared by several cards ------------------------
  const noTicksTodayReason = marketClosedReason
    ? `${marketClosedReason} No ticks were captured today.`
    : 'No ticks captured today yet — the next scheduled login is later today.';

  const pipelineStoppedReason = marketClosedReason
    ? `Pipeline is not receiving data. ${marketClosedReason}`
    : connectedApology(wsDisconnectReasonRaw, wsDisconnectReasonCode, schedState)
      ? `Pipeline is not receiving data. ${connectedApology(wsDisconnectReasonRaw, wsDisconnectReasonCode, schedState)}`
      : 'Pipeline is not receiving data (WebSocket is not connected).';

  function connectedApology(
    reason: string | null,
    code: string | null,
    st: any,
  ): string | null {
    if (reason) return `Disconnect reason: ${reason}${code ? ` (${code})` : ''}.`;
    const stStr = str(st.state);
    if (stStr === 'MARKET_CLOSED') {
      return 'Scheduler is in MARKET_CLOSED state — no WebSocket is expected until the next trading day.';
    }
    if (stStr && /WAITING|STOPPED|LOG(O|G)ED_OUT/.test(stStr)) {
      return `Scheduler state is ${stStr} — the WebSocket is not active.`;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Explainable state cards — every UI card maps to exactly one entry.
  // ------------------------------------------------------------------
  const states: Record<string, StateCard> = {
    // -------- OVERVIEW --------
    'overview.ticksToday': card(
      recordsToday,
      recordsToday != null && recordsToday > 0
        ? 'ok'
        : mongoConnected
        ? 'idle'
        : 'na',
      recordsToday != null && recordsToday > 0
        ? `${recordsToday} tick documents persisted since UTC midnight (saved, not just received).`
        : noTicksTodayReason,
      nowIso,
      'system.status → mongo ticks (count since midnight UTC)',
    ),
    'overview.savedToday': card(
      todayInserts,
      todayInserts != null && todayInserts > 0 ? 'ok' : 'idle',
      todayInserts != null && todayInserts > 0
        ? `${todayInserts} ticks saved today per the daily summary.`
        : noTicksTodayReason,
      nowIso,
      'system.status → daily_summaries.totalWrites',
    ),
    'overview.totalRecordsInDb': card(
      recordsInDb,
      recordsInDb != null && recordsInDb > 0 ? 'ok' : recordsInDb == null ? 'na' : 'idle',
      recordsInDb != null ? `${recordsInDb} tick documents stored in the ticks collection (estimated count).` : 'MongoDB did not report a document count.',
      nowIso,
      'mongo estimated_document_count (ticks)',
    ),
    'overview.lastTickAt': card(
      lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : null,
      lastTickAgeSec == null
        ? 'na'
        : lastTickAgeSec <= STALE_TICK_SEC
        ? 'ok'
        : 'warn',
      lastTickAgeSec == null
        ? noTicksTodayReason
        : `Last tick received ${fmtUptime(lastTickAgeSec) ?? `${lastTickAgeSec}s`} ago at ${isoFromEpochSec(lastTickAtEpoch)}.`,
      lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : null,
      'tick-buffer.stats → lastTickAt',
    ),
    'overview.lastTickSymbol': card(
      str(sys.lastTickSymbol),
      sys.lastTickSymbol != null ? 'ok' : 'na',
      sys.lastTickSymbol != null
        ? `Last tick was ${sys.lastTickSymbol}.`
        : noTicksTodayReason,
      lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : null,
      'tick-buffer.stats → lastTickSymbol',
    ),
    'overview.rate': card(
      ticksPerSec,
      ticksPerSec != null && ticksPerSec > 0 ? 'ok' : connected ? 'idle' : 'idle',
      connected
        ? ticksPerSec != null && ticksPerSec > 0
          ? `Receiving ${ticksPerSec} tick/sec (rolling 10s window).`
          : 'Connected, but no ticks have been counted in the rolling window yet.'
        : marketClosedReason ?? 'WebSocket is not connected — rate is not measured.',
      lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : nowIso,
      'tick-buffer.stats → ticksPerSecond (10s window)',
    ),

    // -------- SYSTEM HEALTH --------
    'system.node': card(
      str(node.status) ?? 'ok',
      'ok',
      `Backend process up for ${fmtUptime(num(node.uptimeSeconds)) ?? '?'}; CPU ${fmt1(node.cpuPercent)}%, RAM ${fmt1(node.ramPercent)}%.`,
      nowIso,
      'system.node (psutil)',
      [`uptime ${fmtUptime(num(node.uptimeSeconds))}`, `memory rss ${roundMb(node?.memory?.rssMb)}`, `disk ${fmt1(node.diskPercent)}%`],
    ),
    'system.python': card(
      str(python.version ?? node.pythonVersion) ?? null,
      Boolean(sys.sdkLoaded ?? python.sdk_loaded) ? 'ok' : 'warn',
      Boolean(sys.sdkLoaded ?? python.sdk_loaded)
        ? `Python runtime running; Kotak SDK loaded (${str(sys.sdkVersion) ?? '?'}).`
        : 'Python is running but the Kotak SDK is NOT loaded — broker login / market feed are unavailable.',
      nowIso,
      'system.python (python status)',
    ),
    'system.mongo': card(
      mongoConnected ? 'connected' : 'disconnected',
      mongoConnected ? 'ok' : 'err',
      mongoConnected
        ? `MongoDB reachable${mongoStats?.dbName ? `; database "${mongoStats.dbName}"` : ''}${num(mongoStats?.pingMs) != null ? ` (ping ${num(mongoStats?.pingMs)}ms)` : ''}.`
        : 'MongoDB is not connected — ticks cannot be persisted and the pipeline counts are stale.',
      nowIso,
      'system.mongo (is_mongo_connected)',
    ),
    'system.buffer': card(
      num(buffer.bufferLength),
      'ok',
      `In-memory buffer holds ${num(buffer.bufferLength) ?? 0} pending ticks; since process start: ${totalReceived ?? 0} received, ${totalWrites ?? 0} saved, ${totalWriteErrors ?? 0} failed.`,
      nowIso,
      'tick-buffer.stats',
    ),
    'system.services': card(
      null,
      servicesHealth(sys.services).status,
      servicesHealth(sys.services).reason,
      nowIso,
      'system.services (status manager)',
      servicesHealth(sys.services).detail,
    ),
    'system.internet': card(
      Boolean(sys.internetConnected) ? 'Online' : 'Offline',
      Boolean(sys.internetConnected) ? 'ok' : 'err',
      Boolean(sys.internetConnected)
        ? 'Internet reachability check succeeded.'
        : 'Internet reachability check is failing — this is a common reason for WebSocket drops.',
      nowIso,
      'system.internet (60s cached reachability check)',
    ),

    // -------- SCHEDULER & SESSION --------
    'scheduler.enabled': card(
      schedulerEnabled ? 'Enabled' : 'Disabled',
      schedulerEnabled ? 'ok' : 'na',
      schedulerEnabled
        ? 'The scheduler daemon is enabled and in charge of login/WebSocket windows.'
        : 'The scheduler is disabled in settings — no automatic login or WebSocket schedules will run.',
      nowIso,
      'settings_service.scheduler_enabled',
    ),
    'scheduler.state': card(
      scheduler.state,
      schedulerEnabled ? (schedulerRunning ? 'ok' : 'warn') : 'na',
      schedulerEnabled
        ? schedulerRunning
          ? `Scheduler state ${scheduler.state} since ${scheduler.stateSince ?? 'unknown'}.`
          : 'The scheduler process is reported as not running.'
        : 'Scheduler disabled — state is not being advanced.',
      isoOrNull(scheduler.stateSince) ?? nowIso,
      'scheduler.get_scheduler_state',
    ),
    'scheduler.market': card(
      scheduler.marketStatus,
      (backendMarketState === 'EXCHANGE_HOLIDAY' || backendMarketState === 'WEEKEND' || backendMarketState === 'MARKET_CLOSED' || backendMarketState === 'NO_TICKS_AFTER_CONFIRMATION') ? 'idle' : 'ok',
      backendReasonMessage
        ? `${backendReasonMessage}${scheduler.nextMarketOpen ? ` Next close ${scheduler.nextMarketClose ?? 'scheduled'} IST.` : ''}`
        : (marketClosedReason ?? `Market is open (${scheduler.marketSession ?? 'regular'}) on ${scheduler.marketDate ?? 'today'}. Next close ${scheduler.nextMarketClose ?? 'scheduled'} IST.`),
      nowIso,
      'services/market_calendar.snapshot',
    ),
    'scheduler.next-event': card(
      scheduler.nextEvent ? `${scheduler.nextEvent} @ ${scheduler.nextEventAt}` : null,
      scheduler.nextEvent ? 'ok' : 'na',
      scheduler.nextEvent
        ? `Next scheduled event is ${scheduler.nextEvent} in ${fmtUptime(scheduler.remainingSeconds) ?? '?'} (at ${scheduler.nextEventAt} IST).`
        : 'The schedule does not define a next event.',
      nowIso,
      'scheduler.get_schedule',
    ),
    'scheduler.login-window': card(
      scheduler.loginWindowApplicable
        ? scheduler.inLoginWindow
          ? 'Open'
          : 'Closed'
        : 'Not applicable',
      scheduler.loginWindowApplicable
        ? scheduler.inLoginWindow
          ? 'ok'
          : 'idle'
        : 'na',
      !scheduler.loginWindowApplicable
        ? `${dayClassLabel} — the login window does not apply today (no scheduled login on a non-trading day).`
        : scheduler.inLoginWindow
        ? `Login window (${scheduler.loginTime}–${scheduler.logoutTime} IST) is open.`
        : `Login window (${scheduler.loginTime}–${scheduler.logoutTime} IST) is closed today.`,
      nowIso,
      'scheduler._market_slot',
    ),
    'scheduler.ws-window': card(
      scheduler.wsWindowApplicable
        ? scheduler.inWsWindow
          ? 'Open'
          : 'Closed'
        : 'Not applicable',
      scheduler.wsWindowApplicable
        ? scheduler.inWsWindow
          ? 'ok'
          : 'idle'
        : 'na',
      !scheduler.wsWindowApplicable
        ? `${dayClassLabel} — the WebSocket window does not apply today (no scheduled feed on a non-trading day).`
        : scheduler.inWsWindow
        ? `WebSocket window (${scheduler.wsStartTime}–${scheduler.wsStopTime} IST) is open.`
        : `WebSocket window (${scheduler.wsStartTime}–${scheduler.wsStopTime} IST) is closed today.`,
      nowIso,
      'scheduler._market_slot',
    ),
    'session.status': card(
      session.active ? 'Active' : 'Inactive',
      session.active ? 'ok' : (backendMarketState === 'EXCHANGE_HOLIDAY' || backendMarketState === 'WEEKEND' || backendMarketState === 'MARKET_CLOSED') ? 'idle' : 'warn',
      session.active
        ? `Broker session active since ${session.lastLoginAt ?? 'unknown'}${session.loginSource ? ` (source: ${session.loginSource})` : ''}.`
        : marketClosedReason
        ? `No broker session is required now. ${marketClosedReason}`
        : `No broker session.${session.lastLogoutReason ? ` Last logout reason: ${session.lastLogoutReason}.` : ''}${session.nextScheduledLogin ? ` Next scheduled login: ${session.nextScheduledLogin} IST.` : ''}`,
      session.active ? session.lastLoginAt : lastLogoutAtOf(sessionSnap) ?? nowIso,
      'services/session.session_manager.snapshot',
    ),
    'session.duration': card(
      num(session.sessionDurationSeconds),
      session.active ? 'ok' : 'idle',
      session.active
        ? `This session has been live for ${fmtUptime(session.sessionDurationSeconds) ?? '?'}.`
        : 'No active session — duration not applicable.',
      session.active ? session.lastLoginAt : null,
      'services/session.session_manager.snapshot',
    ),
    'session.expiry': card(
      isoOrNull(session.expiresAt),
      session.active ? 'ok' : 'na',
      session.active && session.expiresAt
        ? `Session expires ${session.expiresAt} IST (${fmtUptime(session.remainingSeconds) ?? '?'} remaining).`
        : 'No session to expire — auto-expiry is only relevant while a session is active.',
      session.active ? session.lastLoginAt : null,
      'services/session.session_manager.snapshot (60-min auto-expiry from real login time)',
    ),
    'session.last-login': card(
      isoOrNull(session.lastLoginAt),
      session.lastLoginAt ? 'ok' : 'na',
      session.lastLoginAt
        ? `Last successful broker login at ${session.lastLoginAt} IST${session.loginSource ? `, triggered by ${session.loginSource}` : ''}.`
        : 'No login recorded in this backend process or in the event trail.',
      isoOrNull(session.lastLoginAt),
      'kotak_session.session_info + system_events (login_ok)',
    ),
    'session.last-logout': card(
      isoOrNull(session.lastLogoutAt),
      session.lastLogoutAt ? 'ok' : 'na',
      session.lastLogoutAt
        ? `Last logout at ${session.lastLogoutAt} IST${session.lastLogoutReason ? ` — ${session.lastLogoutReason}` : ''}.`
        : 'No logout recorded in this backend process.',
      isoOrNull(session.lastLogoutAt),
      'kotak_session.session_info',
    ),

    // -------- TICK PIPELINE --------
    'pipeline.state': card(
      pipelineState === 'live' ? 'Live' : 'Stopped',
      pipelineState === 'live' ? 'ok' : (backendMarketState === 'EXCHANGE_HOLIDAY' || backendMarketState === 'WEEKEND' || backendMarketState === 'MARKET_CLOSED' || backendMarketState === 'NO_TICKS_AFTER_CONFIRMATION') ? 'idle' : 'warn',
      pipelineState === 'live'
        ? 'WebSocket streaming live — ticks are flowing into the buffer.'
        : pipelineStoppedReason,
      pipelineState === 'live' ? connectedAt : (offlineSince ?? statsBlk.pipeline?.stoppedAt ?? nowIso),
      'tick-buffer.stats + system.websocketDetail',
    ),
    'pipeline.rate': card(
      ticksPerSec,
      ticksPerSec != null && ticksPerSec > 0 ? 'ok' : 'idle',
      ticksPerSec != null && ticksPerSec > 0
        ? `Measured ${ticksPerSec} tick/sec over the rolling 10s window.`
        : pipelineState === 'live'
        ? 'Live but the rolling window shows 0 ticks/sec right now.'
        : 'Rate is not measured while the stream is stopped.',
      lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : nowIso,
      'tick-buffer.stats → ticksPerSecond',
    ),
    'pipeline.saved': card(
      writesPerSec,
      writesPerSec != null && writesPerSec > 0 ? 'ok' : 'idle',
      writesPerSec != null && writesPerSec > 0
        ? `${writesPerSec} ticks/sec being persisted to MongoDB.`
        : 'No tick documents currently being saved to MongoDB.',
      lastWriteAtEpoch != null ? isoFromEpochSec(lastWriteAtEpoch) : nowIso,
      'tick-buffer.stats → writesPerSecond',
    ),
    'pipeline.buffer': card(
      num(buffer.bufferLength),
      'ok',
      `${num(buffer.bufferLength) ?? 0} ticks currently queued in memory before the flush interval.`,
      nowIso,
      'tick-buffer.stats → bufferLength',
    ),
    'pipeline.latency': card(
      latencyMs,
      latencyMs != null ? 'ok' : 'na',
      latencyMs != null
        ? `Exchange → backend feed latency measured at ${Math.round(latencyMs)}ms on the last tick.`
        : 'Feed latency is only measured while ticks actually flow — none received to measure.',
      lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : null,
      'tick-buffer.stats → feedLatencyMs',
    ),
    'pipeline.started': card(
      isoOrNull(statsBlk.pipeline?.startedAt),
      Boolean(statsBlk.pipeline?.running) ? 'ok' : 'idle',
      statsBlk.pipeline?.running
        ? `Flush loop is running; started ${statsBlk.pipeline?.startedAt ?? '?'} IST${statsBlk.pipeline?.uptimeSeconds != null ? ` (uptime ${fmtUptime(num(statsBlk.pipeline?.uptimeSeconds))})` : ''}.`
        : statsBlk.pipeline?.startedAt
        ? `Pipeline is currently stopped (started earlier at ${statsBlk.pipeline?.startedAt} IST; stopped ${statsBlk.pipeline?.stoppedAt ?? '?'} IST).`
        : `The tick pipeline has never been started in this backend process (${statsBlk.pipeline?.stoppedAt ? `last stop ${statsBlk.pipeline?.stoppedAt}` : 'no lifecycle recorded'}).`,
      isoOrNull(statsBlk.pipeline?.startedAt) ?? nowIso,
      'tick-buffer.stats → pipelineStartedAt',
    ),
    'pipeline.last-saved': card(
      isoOrNull(statsBlk.pipeline?.lastSavedAt) ?? lastSavedAt,
      'ok',
      lastWriteAtEpoch != null
        ? `Last successful MongoDB bulk write at ${isoFromEpochSec(lastWriteAtEpoch)} IST.`
        : 'No tick documents saved in this backend process yet.',
      lastWriteAtEpoch != null ? isoFromEpochSec(lastWriteAtEpoch) : null,
      'tick-buffer.stats → lastWriteAt',
    ),
    'pipeline.last-error': card(
      str(statsBlk.pipeline?.lastError),
      totalWriteErrors != null && totalWriteErrors > 0 ? 'err' : 'ok',
      totalWriteErrors != null && totalWriteErrors > 0
        ? `${totalWriteErrors} write error(s) recorded${statsBlk.pipeline?.lastFailedWriteAt ? `; last failure at ${statsBlk.pipeline?.lastFailedWriteAt} IST` : ''}${statsBlk.pipeline?.lastError ? ` — ${statsBlk.pipeline?.lastError}` : ''}.`
        : 'No tick write failures recorded since process start.',
      isoOrNull(statsBlk.pipeline?.lastFailedWriteAt),
      'tick-buffer.stats → totalWriteErrors / lastError',
    ),

    // -------- TICKS TODAY --------
    'ticks.today-count': card(
      recordsToday,
      recordsToday != null && recordsToday > 0 ? 'ok' : 'idle',
      recordsToday != null && recordsToday > 0
        ? `${recordsToday} ticks captured today (persisted since midnight UTC).`
        : noTicksTodayReason,
      nowIso,
      'system.status → mongo ticks count (today)',
    ),
    'ticks.today-first': card(
      firstTickTodayAt,
      firstTickTodayAt ? 'ok' : 'na',
      firstTickTodayAt
        ? `First tick today at ${firstTickTodayAt} IST.`
        : 'No tick documents exist for today.',
      firstTickTodayAt,
      'mongo ticks (earliest ts today)',
    ),
    'ticks.today-last': card(
      lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : null,
      lastTickAgeSec == null ? 'na' : lastTickAgeSec <= STALE_TICK_SEC ? 'ok' : 'warn',
      lastTickAgeSec == null
        ? 'No tick received in this backend process yet.'
        : `Last tick ${fmtUptime(lastTickAgeSec) ?? `${lastTickAgeSec}s`} ago${sys.lastTickSymbol ? ` — ${sys.lastTickSymbol}` : ''}.`,
      lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : null,
      'tick-buffer.stats → lastTickAt',
    ),
    'ticks.today-unique': card(
      uniqueInstrumentsToday,
      uniqueInstrumentsToday != null && uniqueInstrumentsToday > 0 ? 'ok' : 'idle',
      uniqueInstrumentsToday != null
        ? `${uniqueInstrumentsToday} distinct instruments had at least one tick today.`
        : 'No unique-instrument measurement available.',
      nowIso,
      'mongo ticks distinct(symbol) today',
    ),

    // -------- STORAGE --------
    'storage.used': card(
      used,
      capacity != null && used != null ? (used / capacity) * 100 >= 90 ? 'warn' : 'ok' : 'na',
      capacity != null && used != null
        ? `Disk usage ${asPct(used, capacity)} — ${fmtBytes(used)} used of ${fmtBytes(capacity)}${free != null ? ` (${fmtBytes(free)} free)` : ''}.`
        : 'No storage capacity measurement available.',
      nowIso,
      node.diskTotalBytes != null ? 'system.node (psutil disk usage)' : 'mongo stats (totalSizeBytes)',
    ),
    'storage.free': card(
      free,
      capacity != null && free != null ? (free / capacity) * 100 <= 10 ? 'warn' : 'ok' : 'na',
      capacity != null && free != null
        ? `${fmtBytes(free)} free of ${fmtBytes(capacity)} — ${asPct(free, capacity)} remaining.`
        : 'Free space not measurable (no capacity reported).',
      nowIso,
      'derived (capacity − used)',
    ),
    'storage.categories': card(
      dbBytes,
      rawDataBytes != null || metadataBytes != null || indexBytes != null ? 'ok' : 'na',
      rawDataBytes != null || metadataBytes != null || indexBytes != null
        ? `Database on-disk total ${fmtBytes(dbBytes) ?? '?'}; raw ticks ${fmtBytes(rawDataBytes)}, other collections ${fmtBytes(metadataBytes)}, indexes ${fmtBytes(indexBytes)}.`
        : 'Per-collection byte measurements not reported (MongoDB offline or not yet measured).',
      nowIso,
      'mongo stats.collections (storageBytes + indexSizeBytes)',
      mongoConnected && Array.isArray(mongoStats?.collections)
        ? mongoStats.collections.map((c: any) => `${c.name}: ${fmtBytes(num(c.storageBytes))}${num(c.indexSizeBytes) != null ? ` (+${fmtBytes(num(c.indexSizeBytes))} indexes)` : ''} / ${num(c.count) ?? 0} docs`)
        : null,
    ),
    'storage.db-records': card(
      recordsInDb,
      recordsInDb != null && recordsInDb > 0 ? 'ok' : recordsInDb == null ? 'na' : 'idle',
      recordsInDb != null
        ? `${recordsInDb} documents in the ticks collection; today added ${recordsToday ?? 0} (this hour: ${statsBlk.recordsThisHour ?? 'n/a'}).`
        : 'MongoDB did not report the document count.',
      nowIso,
      'mongo estimated_document_count (ticks)',
    ),
    'storage.dirs': card(
      null,
      storageDirs.length > 0 ? 'ok' : 'na',
      storageDirs.length > 0
        ? `On-disk directories measured on this machine: ${storageDirs.map((d: any) => `${d.name}=${fmtBytes(num(d.bytes))}`).join(', ')}.`
        : 'No on-disk directory measurements reported by the backend.',
      nowIso,
      'system storage aggregation (os.scandir)',
      storageDirs.map((d: any) => `${d.name}: ${d.present ? fmtBytes(num(d.bytes)) : 'not present'}`),
    ),

    // -------- WEBSOCKET HEALTH --------
    'ws.connection': card(
      connected ? 'Connected' : 'Disconnected',
      connected ? 'ok' : 'err',
      connected
        ? `Connected since ${connectedAt ?? 'unknown'} IST${reconnectCount != null ? `; ${reconnectCount} reconnect(s) this process` : ''}.`
        : offlineSince
        ? `Disconnected since ${offlineSince} IST${wsDisconnectReasonRaw ? ` — ${wsDisconnectReasonRaw}` : ''}${wsDisconnectReasonCode ? ` (${wsDisconnectReasonCode})` : ''}.`
        : pipelineStoppedReason,
      connected ? connectedAt : offlineSince,
      'ws_socket/ws_manager.status + session_manager',
    ),
    'ws.uptime': card(
      wsUptimeSec != null ? fmtUptime(wsUptimeSec) : null,
      connected ? 'ok' : 'na',
      connected
        ? `Connected ${fmtUptime(wsUptimeSec) ?? '0s'} since ${connectedAt ?? '?'} IST.`
        : 'Uptime applies only while connected.',
      connected ? connectedAt : null,
      'derived (connectedAt → now)',
    ),
    'ws.reconnects': card(
      reconnectCount,
      reconnectCount == null ? 'na' : reconnectCount > 0 ? 'warn' : 'ok',
      reconnectCount != null
        ? `${reconnectCount} (re)connect attempt(s) recorded since the WebSocket process started (${processStartedAt ?? 'unknown'}).`
        : 'No reconnect counter reported.',
      nowIso,
      'ws_manager.status → reconnect_count (metrics.connects)',
    ),
    'ws.reason': card(
      wsDisconnectReasonRaw,
      connected ? 'ok' : wsDisconnectReasonRaw ? 'err' : ((backendMarketState === 'EXCHANGE_HOLIDAY' || backendMarketState === 'WEEKEND' || backendMarketState === 'MARKET_CLOSED') ? 'idle' : 'warn'),
      connected
        ? 'Currently connected — no active disconnect reason.'
        : wsDisconnectReasonRaw
        ? `Last disconnect reason: ${wsDisconnectReasonRaw}${wsDisconnectReasonCode ? ` (${wsDisconnectReasonCode})` : ''}.`
        : pipelineStoppedReason,
      connected ? null : (disconnectedAt ?? processStartedAt ?? nowIso),
      'ws_manager.status → disconnect_reason (+ reason_code)',
    ),
    'ws.last-message': card(
      lastMessageAgeSec != null ? `${fmtUptime(lastMessageAgeSec)} ago` : null,
      lastMessageAgeSec == null
        ? 'na'
        : lastMessageAgeSec <= STALE_TICK_SEC
        ? 'ok'
        : lastMessageAgeSec <= 1800
        ? 'warn'
        : 'err',
      lastMessageAgeSec != null
        ? connected
          ? `Last market message ${fmtUptime(lastMessageAgeSec) ?? `${lastMessageAgeSec}s`} ago (at ${wsLastMessageAt} IST).`
          : `Last message was ${fmtUptime(lastMessageAgeSec) ?? `${lastMessageAgeSec}s`} ago (at ${wsLastMessageAt} IST).`
        : wsLastMessageAt
        ? `Last message recorded at ${wsLastMessageAt} IST.`
        : 'No market message has been recorded by this WebSocket process.',
      wsLastMessageAt ?? (lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : null),
      'ws_manager.status → last_message_at',
    ),
    'ws.lifecycle': card(
      lifecycleState,
      lifecycleState ? 'ok' : 'na',
      lifecycleState
        ? `WebSocket lifecycle state: ${lifecycleState} (ws state ${str(wsDetail.state) ?? '?'}).`
        : 'WebSocket lifecycle state not reported.',
      nowIso,
      'ws_manager.status → lifecycle_state',
    ),

    // -------- DATA QUALITY --------
    'quality.score': card(
      num(quality.qualityScore),
      quality.qualityScore == null
        ? 'na'
        : quality.qualityScore >= 90
        ? 'ok'
        : quality.qualityScore >= 80
        ? 'warn'
        : 'err',
      quality.qualityScore != null
        ? `Score ${quality.qualityScore}/100 computed over ${num(quality.total) ?? 0} ticks in the inspected window (${hours}h). Formula documented on the page.`
        : 'No ticks in the inspected window — the score is not computed (never a fake 100).',
      nowIso,
      'mongo quality aggregation (last N hours)',
    ),
    'quality.duplicates': card(
      num(quality.duplicates),
      num(quality.duplicates) == null || num(quality.duplicates) === 0 ? 'ok' : 'warn',
      num(quality.duplicates) != null
        ? `${quality.duplicates} duplicate ticks (same symbol + timestamp) in the window.`
        : 'Duplicate count not computed in this window.',
      nowIso,
      'mongo quality aggregation → duplicates',
    ),
    'quality.missing': card(
      num(quality.missing),
      num(quality.missing) == null || num(quality.missing) === 0 ? 'ok' : 'warn',
      num(quality.missing) != null
        ? `${quality.missing} missing/gaps detected in the window.`
        : 'Missing-tick measurement not computed in this window.',
      nowIso,
      'mongo quality aggregation → missing',
    ),
    'quality.out-of-order': card(
      num(quality.outOfOrder),
      num(quality.outOfOrder) == null || num(quality.outOfOrder) === 0 ? 'ok' : 'warn',
      num(quality.outOfOrder) != null
        ? `${quality.outOfOrder} out-of-order ticks in the window.`
        : 'Out-of-order measurement not computed in this window.',
      nowIso,
      'mongo quality aggregation → outOfOrder',
    ),
    'quality.errors': card(
      num(quality.saveFailures) != null ? num(quality.saveFailures) : num(sys.errorCount),
      (num(quality.saveFailures) ?? num(sys.errorCount) ?? 0) === 0 ? 'ok' : 'err',
      num(quality.saveFailures) != null
        ? `${quality.saveFailures} save failures in the window (rate ${quality.saveFailureRate ?? 'n/a'}).`
        : `Write-errors tracked by the pipeline: ${num(sys.errorCount) ?? 0}.`,
      nowIso,
      'mongo quality aggregation → saveFailures / system.errorCount',
    ),
  };

  // Helpers used above (kept small and pure).
  function fmt1(v: unknown): string {
    const n = num(v);
    return n == null ? '?' : `${n.toFixed(1)}`;
  }
  function roundMb(v: unknown): string {
    const n = num(v);
    return n == null ? '?' : `${n}MB`;
  }
  function asPct(a: number, b: number): string {
    if (b <= 0) return '?';
    return `${((a / b) * 100).toFixed(1)}%`;
  }

  // Real on-disk dirs detail strings (for the storage card) come straight from
  // the backend — no fabrication.
  const dirsDetail = storageDirs.map((d: any) => `${d.name}: ${d.present ? fmtBytes(num(d.bytes)) : 'not present'}`);
  states['storage.dirs'] = card(
    null,
    storageDirs.length > 0 ? 'ok' : 'na',
    storageDirs.length > 0
      ? `On-disk directories measured on this machine: ${dirsDetail.join(', ')}.`
      : 'No on-disk directory measurements reported by the backend.',
    nowIso,
    'system storage aggregation (os.scandir)',
    dirsDetail,
  );

  states['ws.internet'] = card(
    Boolean(sys.internetConnected) ? 'Online' : 'Offline',
    Boolean(sys.internetConnected) ? 'ok' : 'err',
    Boolean(sys.internetConnected)
      ? 'Internet reachability check succeeded.'
      : 'Internet reachability check is failing — a common cause of WebSocket drops.',
    nowIso,
    'system.internet (60s cached reachability check)',
  );
  states['ws.latency'] = card(
    latencyMs,
    latencyMs != null ? 'ok' : 'na',
    latencyMs != null
      ? `Exchange → backend latency measured at ${Math.round(latencyMs)}ms on the last tick.`
      : 'Latency is only measured while ticks flow — none received to measure.',
    lastTickAtEpoch != null ? isoFromEpochSec(lastTickAtEpoch) : null,
    'tick-buffer.stats → feedLatencyMs',
  );

  // ------------------------------------------------------------------
  // Data insights — only real, derived facts. No speculation.
  // ------------------------------------------------------------------
  const busiestActive = connected && ticksPerSec != null && ticksPerSec > 0 ? ticksPerSec : null;
  const insights = [
    {
      key: 'capture-coverage',
      label: 'Capture coverage (today)',
      value:
        uniqueInstrumentsToday != null && num(subscribed.total) != null
          ? `${uniqueInstrumentsToday}/${subscribed.total} instruments producing ticks`
          : null,
      status:
        uniqueInstrumentsToday != null ? (uniqueInstrumentsToday > 0 ? 'ok' : 'idle') : 'na',
      reason:
        uniqueInstrumentsToday != null
          ? `${uniqueInstrumentsToday} distinct instrument(s) ticked today out of ${num(subscribed.total) ?? '?'} subscribed.`
          : 'No distinct-instrument measurement today.',
      lastUpdated: nowIso,
      source: 'mongo distinct(symbol) vs db.stocks active',
    },
    {
      key: 'save-efficiency',
      label: 'Save success rate',
      value: saveSuccessRate != null ? `${saveSuccessRate.toFixed(2)}%` : null,
      status: saveSuccessRate != null ? (saveSuccessRate >= 99 ? 'ok' : saveSuccessRate >= 90 ? 'warn' : 'err') : 'na',
      reason:
        saveSuccessRate != null
          ? `${saveSuccessRate.toFixed(2)}% of ${attempted} write attempts succeeded (${totalWrites ?? '?'} ok / ${totalWriteErrors ?? 0} failed).`
          : 'No write attempts to measure yet.',
      lastUpdated: nowIso,
      source: 'tick-buffer.stats',
    },
    {
      key: 'session-count',
      label: 'Broker sessions (process lifetime)',
      value: session.loginCount != null ? `${session.loginCount}` : null,
      status: session.loginCount != null ? 'ok' : 'na',
      reason:
        session.loginCount != null
          ? `${session.loginCount} broker session(s) started in this backend process (source: ${session.loginSource ?? 'n/a'}).`
          : 'No session history recorded.',
      lastUpdated: nowIso,
      source: 'services/session.session_manager.snapshot',
    },
    {
      key: 'ws-reconnect-rate',
      label: 'WebSocket reconnects (this process)',
      value: reconnectCount != null ? `${reconnectCount}` : null,
      status: reconnectCount != null ? (reconnectCount > 0 ? 'warn' : 'ok') : 'na',
      reason:
        reconnectCount != null
          ? `${reconnectCount} (re)connect attempt(s) since WebSocket process start${processStartedAt ? ` (${processStartedAt})` : ''}.`
          : 'Reconnect counter not reported.',
      lastUpdated: nowIso,
      source: 'ws_manager.status',
    },
    {
      key: 'db-write-vol',
      label: 'Pending & failed writes',
      value: null,
      status: totalWriteErrors != null && totalWriteErrors > 0 ? 'err' : 'ok',
      reason:
        totalWriteErrors != null && totalWriteErrors > 0
          ? `${totalWriteErrors} failed writes and ${num(buffer.bufferLength) ?? 0} buffered ticks since process start.`
          : `${num(buffer.bufferLength) ?? 0} ticks buffered, 0 failed writes since process start.`,
      lastUpdated: nowIso,
      source: 'tick-buffer.stats',
    },
  ];

  // ------------------------------------------------------------------
  // Reason registry — the centralized taxonomy. Occurrences are derived
  // from REAL backend events only (never fabricated).
  // ------------------------------------------------------------------
  const reasons = {
    registry: REASON_TAXONOMY,
    breakdown: reasonBreakdown(rawEvents),
  };

  const events = rawEvents.slice(0, 120).map((e: any) => ({
    eventId: str(e.event_id) ?? null,
    source: str(e.source) ?? null,
    event: str(e.event) ?? 'unknown',
    status: str(e.status) ?? 'info',
    severity: str(e.severity) ?? str(e.status) ?? 'info',
    component: str(e.component) ?? str(e.source) ?? null,
    reason: str(e.reason) ?? null,
    reasonCode: str(e.reason_code) ?? null,
    message: str(e.message) ?? null,
    details: str(e.details) ?? null,
    duration: typeof e.duration === 'number' ? e.duration : null,
    resolvedAt: isoOrNull(e.resolved_at) ?? null,
    meta: e.meta ?? null,
    ts: isoOrNull(e.ts) ?? null,
  }));

  const lastEvent =
    rawEvents.length > 0
      ? {
          event: str(rawEvents[0].event) ?? 'unknown',
          source: str(rawEvents[0].source) ?? null,
          ts: isoOrNull(rawEvents[0].ts) ?? null,
          message: str(rawEvents[0].message) ?? null,
        }
      : null;

  return Response.json({
    updatedAt: nowIso,
    states,
    insights,
    scheduler,
    session,
    reasons,
    events,
    lastEvent,
    market: marketSnap,
    stats: statsBlk,
    subscribedStocks:
      // {total, active, byWs} — real assembled counts; active is not "free".
      {
        total: num(subscribed.total) ?? null,
        active: num(subscribed.active) ?? null,
        byWs: num(subscribed.byWs) ?? null,
      },
    activeInstruments: num(live.activeTickStocks),
    ticksToday: recordsToday,
    dataSaved: todayInserts,
    totalRecordsInDb: recordsInDb,
    dataSavedUnit: 'ticks saved today',
    saveSuccessRate,
    saveSuccessAttempts: attempted > 0 ? attempted : (num(sys.todayInserts) ?? 0) + (num(sys.errorCount) ?? 0),
    saveSuccessDetails: {
      windowAttempted: attempted || 0,
      windowSucceeded: totalWrites ?? 0,
      windowFailed: totalWriteErrors ?? 0,
      todaySucceeded: num(sys.todayInserts),
      todayFailed: num(sys.errorCount),
    },
    qualityScore: num(quality.qualityScore),
    qualityScoreFormula:
      'score = 100 − (duplicateRate×2 + outOfOrderRate×3 + timestampErrorRate×2 + saveFailureRate×5), clamped 0–100. Scored only when real data exists.',
    quality,
    wsUptimeSec,
    wsConnectedSeconds: wsUptimeSec,
    pipeline: {
      state: pipelineState,
      active: pipelineActive,
      receiving: connected,
      ticksPerSec,
      avgPerSec: ticksPerSec,
      peakPerSec: null,
      savedPerSec: writesPerSec,
      failed: totalWriteErrors,
      totalReceived,
      totalWrites,
      skipped: null,
      duplicates: num(quality.duplicates),
      missing: num(quality.missing),
      outOfOrder: num(quality.outOfOrder),
      bufferLength: num(buffer.bufferLength),
      tickRateTrend: str(buffer.tickRateTrend),
      offlineSince,
      reason:
        wsDisconnectReasonRaw ??
        (connected
          ? ''
          : marketClosedReason ??
            'The WebSocket is not connected (see WebSocket Health for the reason).'),
      lastTickAt: isoFromEpochSec(lastTickAtEpoch) ?? sys.lastTickTime,
      lastTickSymbol: str(sys.lastTickSymbol),
      lastSavedAt,
      startedAt: isoOrNull(statsBlk.pipeline?.startedAt) ?? null,
      stoppedAt: isoOrNull(statsBlk.pipeline?.stoppedAt) ?? null,
      lastFailedWriteAt: isoOrNull(statsBlk.pipeline?.lastFailedWriteAt) ?? null,
    },
    storage: {
      capacity,
      used,
      free,
      usedPercent: storagePctFor(used, capacity),
      rawData: rawDataBytes,
      metadata: metadataBytes,
      cache: null,
      indexBytes,
      dbBytes,
      dirs: storageDirs,
      dbName: mongoStats?.dbName ?? null,
      source: node.diskTotalBytes != null ? 'filesystem' : 'database',
    },
    mongo: {
      connected: mongoConnected,
      dbName: mongoStats?.dbName ?? null,
      totalObjects: num(mongoStats?.totalObjects),
      pingMs: num(mongoStats?.pingMs),
      collections: mongoConnected && Array.isArray(mongoStats?.collections)
        ? mongoStats.collections.map((c: any) => ({
            name: str(c.name) ?? 'unknown',
            count: num(c.count),
            sizeBytes: num(c.storageBytes) ?? num(c.sizeBytes),
            indexSizeBytes: num(c.indexSizeBytes),
            indexes: num(c.indexes),
          }))
        : [],
    },
    ws: {
      connected,
      connectedAt,
      disconnectedAt,
      lastConnectionAt,
      reconnectCount,
      disconnectReason: wsDisconnectReasonRaw,
      lifecycleState,
      lastMessageAt: wsLastMessageAt,
      history: wsDetail.connection_history ?? [],
      internetOk: Boolean(sys.internetConnected),
      latencyMs,
      latencyLabel: latencyMs != null ? 'tick feed latency' : 'no measurement',
      heartbeatAgeSec: lastTickAgeSec,
    },
    alerts,
  });
}

/* eslint-disable no-use-before-define */
function lastLogoutAtOf(sessionSnap: any): string | null {
  const ll = sessionSnap?.lastLogout;
  if (typeof ll === 'string') return ll;
  return isoOrNull(ll?.at) ?? null;
}

function storagePctFor(used: number | null, capacity: number | null): number | null {
  if (used == null || capacity == null || capacity <= 0) return null;
  return Number(((used / capacity) * 100).toFixed(2));
}

function summaryInserts(sys: any): number | null {
  const v = num(sys.todayInserts);
  if (v != null) return v;
  if (sys.todayRecords != null) return num(sys.todayRecords);
  return null;
}

/** Aggregate the backend status-manager service list into one honest card. */
function servicesHealth(services: unknown[] | unknown): { status: StateStatus; reason: string; detail: string[] | null } {
  const list: any[] = Array.isArray(services) ? services : [];
  if (!list.length) {
    return { status: 'na', reason: 'The backend status manager reported no individual service entries.', detail: null };
  }
  const healthy = list.filter((s) => String(s?.status ?? '').toLowerCase() === 'online' || s?.healthy === true).length;
  const degraded = list
    .filter((s) => !(String(s?.status ?? '').toLowerCase() === 'online' || s?.healthy === true))
    .map((s) => `${s?.name ?? s?.service ?? '?'}: ${s?.status ?? 'unknown'}${s?.error ? ` (${s.error})` : ''}`);
  const status: StateStatus = degraded.length === 0 ? 'ok' : healthy > 0 ? 'warn' : 'err';
  const reason = degraded.length === 0
    ? `${healthy}/${list.length} backend services are online.`
    : `${healthy}/${list.length} online — not healthy: ${degraded.join('; ')}.`;
  return { status, reason, detail: degraded.length ? degraded : list.map((s) => `${s?.name ?? '?'}: ${s?.status ?? '?'}`) };
}

// Kept exported so tests can validate the card envelope shape without a server.
export type { StateCard, StateStatus };