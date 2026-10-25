// ---- GlobalTopBar premium status model — pure unit tests ----
//
// Verifies the REAL-state derivation rules: the pills must never fabricate
// values — missing fields resolve to UNKNOWN / neutral, an inactive session is
// INACTIVE (never ACTIVE), market OPEN is only derived from the real calendar
// snapshot, and hard-coded "connected/online/120ms" values are impossible to
// produce from an empty snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalSessionState,
  deriveStatus,
  deriveApiEntry,
  deriveCpuEntry,
  deriveFeedEntry,
  deriveMemEntry,
  deriveOrdersEntry,
  derivePipelineEntry,
  fmtAgo,
  fmtCountdown,
  fmtDurationUntil,
  fmtLatency,
  fmtNextIn,
  fmtSeconds,
  fmtSpan,
  isManualLoginState,
  marketLoginGate,
  maskSession,
  maskUser,
  nextSchedulerAction,
  nextSessionAction,
  nextWebSocketAction,
  schedulerTimeline,
  sessionExpiryAnchor,
  summarize,
  systemPollBroker,
  systemPollSessionActive,
  type StatusInput,
} from '../lib/topbar-status.ts';

function baseInput(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    hydrated: true,
    appConnection: 'CONNECTED',
    internetConnected: null,
    brokerWsConnected: 'UNKNOWN',
    brokerWsState: 'UNKNOWN',
    wsRec: null,
    schedulerRec: null,
    dbRec: null,
    sessionRec: null,
    sessionActive: 'UNKNOWN',
    sessionStatus: 'UNKNOWN',
    marketRec: null,
    systemData: null,
    links: {},
    ...overrides,
  };
}

function byId(entries: ReturnType<typeof deriveStatus>, id: string) {
  return entries.find((e) => e.id === id)!;
}

test('empty snapshot → no service pill fabricates healthy (internet probe pending → amber, never a browser guess)', () => {
  const entries = deriveStatus(baseInput());
  const services = entries.filter((e) => e.id !== 'net');
  const levels = services.map((e) => e.level);
  assert.ok(!levels.includes('healthy'), `no fake healthy on empty state: ${levels.join(',')}`);
  assert.equal(byId(entries, 'net').state, 'CHECKING'); // backend probe has not answered — amber check in progress
  assert.equal(byId(entries, 'net').level, 'warning');
  assert.equal(byId(entries, 'ws').state, 'CHECKING'); // real check still in progress — amber
  assert.equal(byId(entries, 'ws').level, 'warning');
  assert.equal(byId(entries, 'sess').state, 'UNKNOWN'); // truly undeterminable — gray
  assert.equal(byId(entries, 'sess').level, 'unknown');
  assert.equal(byId(entries, 'db').state, 'UNKNOWN');
});

test('backend internet probe true → network ONLINE/healthy (backend-authoritative green)', () => {
  const entries = deriveStatus(baseInput({ internetConnected: true }));
  assert.equal(byId(entries, 'net').level, 'healthy');
  assert.equal(byId(entries, 'net').state, 'ONLINE');
});

test('browser offline (appConnection OFFLINE) → network OFFLINE/gray regardless of a stale backend probe', () => {
  const entries = deriveStatus(baseInput({ appConnection: 'OFFLINE', internetConnected: true }));
  assert.equal(byId(entries, 'net').level, 'offline');
  assert.equal(byId(entries, 'net').state, 'OFFLINE');
});

test('backend internet probe false → network error', () => {
  const entries = deriveStatus(baseInput({ internetConnected: false }));
  assert.equal(byId(entries, 'net').level, 'error');
  assert.equal(byId(entries, 'net').state, 'DOWN');
});

test('broker WS connected maps to healthy with real subscription counts', () => {
  const entries = deriveStatus(
    baseInput({
      brokerWsConnected: true,
      brokerWsState: 'CONNECTED',
      wsRec: { subscriptionCount: 42, metrics: { ticks_received: 1200 }, connectedAt: 1700000000000 },
    }),
  );
  const ws = byId(entries, 'ws');
  assert.equal(ws.level, 'healthy');
  assert.equal(ws.state, 'CONNECTED');
  assert.ok(ws.rows.some((r) => r.label === 'Subscriptions' && r.value === '42'));
  assert.ok(ws.rows.some((r) => r.label === 'Ticks received' && r.value === '1,200'));
});

test('WS reconnecting intermediate state → warning, not healthy', () => {
  const entries = deriveStatus(baseInput({ brokerWsConnected: false, brokerWsState: 'SUPERVISOR_RECONNECTING' }));
  assert.equal(byId(entries, 'ws').level, 'warning');
});

test('WS waiting for the market window → neutral standby, never red', () => {
  const entries = deriveStatus(
    baseInput({
      brokerWsConnected: false,
      brokerWsState: 'WAITING_FOR_MARKET_WINDOW',
      marketRec: { market_status: 'CLOSED', day_class: 'EXCHANGE_HOLIDAY', is_exchange_holiday: true },
    }),
  );
  const ws = byId(entries, 'ws');
  assert.equal(ws.level, 'neutral');
  assert.equal(ws.state, 'WAITING');
  assert.match(ws.detail, /Market closed/);
});

test('database connected=false is an error, never guessed online', () => {
  const entries = deriveStatus(baseInput({ dbRec: { connected: false, checkedAt: '2026-09-12T00:00:00+05:30' } }));
  assert.equal(byId(entries, 'db').level, 'error');
  assert.equal(byId(entries, 'db').state, 'DOWN');
});

test('database connected=true only from the real snapshot', () => {
  const entries = deriveStatus(baseInput({ dbRec: { connected: true, checkedAt: '2026-09-12T00:00:00+05:30' } }));
  assert.equal(byId(entries, 'db').level, 'healthy');
});

test('scheduler stopped with market closed → neutral (normal), not error', () => {
  const entries = deriveStatus(
    baseInput({ schedulerRec: { running: false, state: 'MARKET_CLOSED', info: { ws_start_time: '09:10', ws_stop_time: '16:00' } } }),
  );
  assert.equal(byId(entries, 'sched').level, 'neutral');
});

test('scheduler running → healthy', () => {
  const entries = deriveStatus(baseInput({ schedulerRec: { running: true, state: 'RUNNING' } }));
  assert.equal(byId(entries, 'sched').level, 'healthy');
  assert.equal(byId(entries, 'sched').state, 'RUNNING');
});

test('inactive/expired session → error (red) with real expiry row', () => {
  const entries = deriveStatus(
    baseInput({
      sessionRec: { status: 'SESSION_EXPIRED', expiresAt: '2026-09-12T00:00:00+05:30', remainingSeconds: 0 },
      sessionActive: false,
    }),
  );
  const sess = byId(entries, 'sess');
  assert.equal(sess.level, 'error');
  assert.equal(sess.state, 'EXPIRED');
  assert.ok(sess.rows.some((r) => r.label === 'Expires at'));
});

test('logged-out session state → error (red), never faked healthy', () => {
  const entries = deriveStatus(
    baseInput({ sessionRec: { status: 'LOGGED_OUT' }, sessionActive: false }),
  );
  assert.equal(byId(entries, 'sess').level, 'error');
  assert.equal(byId(entries, 'sess').state, 'LOGGED_OUT');
});

test('pre-hydration → all backend indicators CHECKING/amber, none red', () => {
  const entries = deriveStatus(baseInput({ hydrated: false }));
  assert.equal(byId(entries, 'ws').level, 'warning');
  assert.equal(byId(entries, 'ws').state, 'CHECKING');
  assert.equal(byId(entries, 'sched').level, 'warning');
  assert.equal(byId(entries, 'sched').state, 'CHECKING');
  assert.equal(byId(entries, 'sess').level, 'warning');
  assert.equal(byId(entries, 'sess').state, 'CHECKING');
});

test('scheduler starting (transitional state, running unknown) → warning', () => {
  const entries = deriveStatus(baseInput({ schedulerRec: { running: null, state: 'STARTING' } }));
  assert.equal(byId(entries, 'sched').level, 'warning');
  assert.equal(byId(entries, 'sched').state, 'STARTING');
});

test('active session → healthy ACTIVE with broker label', () => {
  const entries = deriveStatus(
    baseInput({
      sessionRec: { status: 'WS_ACTIVE', broker: 'KOTAK NEO', remainingSeconds: 3600 },
      sessionActive: true,
    }),
  );
  const sess = byId(entries, 'sess');
  assert.equal(sess.level, 'healthy');
  assert.equal(sess.state, 'ACTIVE');
  assert.ok(sess.rows.some((r) => r.label === 'Broker' && r.value === 'KOTAK NEO'));
  assert.ok(sess.rows.some((r) => r.label === 'Remaining' && r.value === '1h 00m'));
});

test('session Source row is the backend login owner (MANUAL vs SCHEDULER), never guessed', () => {
  const manual = byId(
    deriveStatus(baseInput({ sessionRec: { status: 'WS_ACTIVE', loginSource: 'MANUAL', sessionId: 'ses_ab12cd34ef' }, sessionActive: true })),
    'sess',
  );
  assert.ok(manual.rows.some((r) => r.label === 'Source' && r.value === 'MANUAL'));
  const scheduler = byId(
    deriveStatus(baseInput({ sessionRec: { status: 'WS_ACTIVE', loginSource: 'SCHEDULER', sessionId: 'ses_ab12cd34ef' }, sessionActive: true })),
    'sess',
  );
  assert.ok(scheduler.rows.some((r) => r.label === 'Source' && r.value === 'SCHEDULER'));
  assert.ok(scheduler.rows.some((r) => r.label === 'Session id' && r.value === 'ses_ab••ef'));
  // No loginSource in the snapshot → no fabricated source row.
  const unknown = byId(
    deriveStatus(baseInput({ sessionRec: { status: 'WS_ACTIVE' }, sessionActive: true })),
    'sess',
  );
  assert.ok(!unknown.rows.some((r) => r.label === 'Source'));
});

test('market: real calendar OPEN → healthy with close-time hint', () => {
  const entries = deriveStatus(
    baseInput({
      marketRec: {
        market_status: 'OPEN',
        market_date: '2026-09-12',
        trading_day: true,
        next_market_open: '2026-09-14T09:15:00+05:30',
        next_market_close: '2026-09-12T15:30:00+05:30',
      },
    }),
  );
  const mkt = byId(entries, 'market');
  assert.equal(mkt.level, 'healthy');
  assert.equal(mkt.state, 'OPEN');
  assert.ok(mkt.hint?.includes('closes'), 'open market hints its close time');
});

test('market: PRE_OPEN → warning', () => {
  const entries = deriveStatus(
    baseInput({ marketRec: { market_status: 'PRE_OPEN', trading_day: true } }),
  );
  assert.equal(byId(entries, 'market').level, 'warning');
});

test('market: holiday/weekend classification without a hard status', () => {
  const holiday = byId(deriveStatus(baseInput({ marketRec: { day_class: 'EXCHANGE_HOLIDAY' } })), 'market');
  assert.equal(holiday.level, 'neutral');
  assert.equal(holiday.state, 'HOLIDAY');
});

test('market: no snapshot at all → UNKNOWN, never OPEN', () => {
  const entries = deriveStatus(baseInput());
  assert.equal(byId(entries, 'market').state, 'UNKNOWN');
  assert.ok(!['healthy', 'warning'].includes(byId(entries, 'market').level));
});

test('fx latency: real numbers only, junk → null, negative → null', () => {
  assert.equal(fmtLatency(120), '120ms');
  assert.equal(fmtLatency('45'), '45ms');
  assert.equal(fmtLatency(undefined), null);
  assert.equal(fmtLatency(-5), null);
  assert.equal(fmtLatency('abc'), null);
});

test('session remaining seconds formatting', () => {
  assert.equal(fmtSeconds(3599), '59:59');
  assert.equal(fmtSeconds(7200), '2h 00m');
  assert.equal(fmtSeconds(-1), '—');
});

test('ago formatting degrades gracefully on junk', () => {
  assert.equal(fmtAgo(null), '—');
  assert.equal(fmtAgo('not-a-date'), '—');
  assert.equal(fmtAgo(Date.now()), 'just now');
});

test('summary aggregates degraded counts from real levels', () => {
  const entries = deriveStatus(
    baseInput({
      internetConnected: false,
      brokerWsConnected: false,
      brokerWsState: 'DISCONNECTED',
      dbRec: { connected: true },
      schedulerRec: { running: true },
      sessionActive: true,
      marketRec: { market_status: 'OPEN', next_market_close: '2026-09-12T15:30:00+05:30' },
    }),
  );
  const summary = summarize(entries);
  assert.ok(summary.degraded >= 1, 'summary reflects real degraded entries');
  assert.notEqual(summary.label, 'Healthy');
});

test('fully healthy snapshot → summary Healthy', () => {
  const entries = deriveStatus(
    baseInput({
      internetConnected: true,
      brokerWsConnected: true,
      brokerWsState: 'CONNECTED',
      wsRec: { connectedAt: 1700000000000 },
      dbRec: { connected: true },
      schedulerRec: { running: true },
      sessionActive: true,
      sessionRec: { status: 'WS_ACTIVE' },
      marketRec: { market_status: 'OPEN', next_market_close: '2026-09-12T15:30:00+05:30' },
    }),
  );
  const summary = summarize(entries);
  assert.equal(summary.label, 'Healthy');
});

// ---- Page-context indicator derives (services / trading / data-saver) ----

test('fmtCountdown formats the session countdown, flooring at 0', () => {
  assert.equal(fmtCountdown(60_000), '1:00');
  assert.equal(fmtCountdown(59_999), '0:59');
  assert.equal(fmtCountdown(3_600_000), '60:00');
  assert.equal(fmtCountdown(0), '0:00');
  assert.equal(fmtCountdown(-5), '0:00');
});

test('sessionExpiryAnchor is backend-authoritative (never resets to 60:00)', () => {
  const now = 1_700_000_000_000;
  // Not hydrated / not active → no countdown at all.
  assert.equal(sessionExpiryAnchor({ hydrated: false, active: true, expiresAt: now + 3_600_000, remainingSeconds: null, now }), null);
  assert.equal(sessionExpiryAnchor({ hydrated: true, active: false, expiresAt: now + 3_600_000, remainingSeconds: null, now }), null);
  assert.equal(sessionExpiryAnchor({ hydrated: true, active: 'UNKNOWN', expiresAt: now + 3_600_000, remainingSeconds: null, now }), null);
  // Absolute backend expiresAt is authoritative: a refresh 42s in must NOT show 60:00.
  assert.equal(sessionExpiryAnchor({ hydrated: true, active: true, expiresAt: now + 42_000, remainingSeconds: 3600, now }), now + 42_000);
  // No expiresAt yet → honest fallback seeded from backend remaining_seconds.
  assert.equal(sessionExpiryAnchor({ hydrated: true, active: true, expiresAt: null, remainingSeconds: 3587, now }), now + 3_587_000);
  // No expiry information at all → null (never fabricates a countdown).
  assert.equal(sessionExpiryAnchor({ hydrated: true, active: true, expiresAt: null, remainingSeconds: null, now }), null);
});

test('isManualLoginState gates the contextual action correctly', () => {
  assert.equal(isManualLoginState('ACTIVE'), false);
  assert.equal(isManualLoginState('AUTHENTICATING'), false);
  assert.equal(isManualLoginState('EXPIRING'), false);
  assert.equal(isManualLoginState('UNKNOWN'), false);
  assert.equal(isManualLoginState('INACTIVE'), true);
  assert.equal(isManualLoginState('LOGGED_OUT'), true);
  assert.equal(isManualLoginState('EXPIRED'), true);
  assert.equal(isManualLoginState('ERROR'), true);
});

test('canonical session state never invents ACTIVE', () => {
  assert.equal(canonicalSessionState('WS_ACTIVE'), 'ACTIVE');
  assert.equal(canonicalSessionState('session_active'), 'ACTIVE');
  assert.equal(canonicalSessionState('DISCONNECTED'), 'INACTIVE');
  assert.equal(canonicalSessionState('SESSION_EXPIRED'), 'EXPIRED');
  assert.equal(canonicalSessionState('AUTHENTICATING'), 'AUTHENTICATING');
  // AUTH_REQUIRED is a terminal "no session, log in" verdict, not a login in
  // progress, so it belongs to the INACTIVE group that surfaces [Manual Login]
  // — never AUTHENTICATING, which hides the action the user needs.
  assert.equal(canonicalSessionState('AUTH_REQUIRED'), 'INACTIVE');
  assert.equal(canonicalSessionState('NOT_AUTHENTICATED'), 'INACTIVE');
  assert.equal(canonicalSessionState('ERROR'), 'ERROR');
  assert.equal(canonicalSessionState(''), 'UNKNOWN');
  assert.equal(canonicalSessionState(undefined), 'UNKNOWN');
});

test('maskUser masks without leaking the full id', () => {
  assert.equal(maskUser('AU123456'), 'AU••56');
  assert.equal(maskUser('abc'), '••••');
  assert.equal(maskUser(null), '—');
});

test('maskSession masks internal session ids without leaking', () => {
  assert.equal(maskSession('ses_ab12cd34ef'), 'ses_ab••ef');
  assert.equal(maskSession('short'), '••••');
  assert.equal(maskSession(null), '—');
});

test('feed derives LIVE only from real live rates / feed state', () => {
  const live = deriveFeedEntry(true, { live: { feedState: 'LIVE', rates: { ticks_per_second: 12, messages_per_second: 30 }, ticksReceived: 1000 } });
  assert.equal(live.level, 'healthy');
  assert.equal(live.state, 'LIVE');
  const stale = deriveFeedEntry(true, { live: { feedState: 'STALE' } });
  assert.equal(stale.level, 'warning');
  const unknown = deriveFeedEntry(false, null);
  assert.equal(unknown.state, 'UNKNOWN');
});

test('pipeline reflects real persistence running/stopped', () => {
  const running = derivePipelineEntry({ buffer: { pipelineRunning: true, lastWriteAt: Date.now() } }, null);
  assert.equal(running.state, 'RUNNING');
  assert.equal(running.level, 'healthy');
  const stopped = derivePipelineEntry({ buffer: { pipelineRunning: false } }, null);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.level, 'error');
});

test('cpu/mem derive only from real node stats', () => {
  const data = { node: { cpuPercent: 12.4, ramPercent: 61, diskPercent: 47, diskTotalBytes: 5e11, memory: { rssMb: 180 } } };
  assert.equal(deriveCpuEntry(data).state, '12.4%');
  assert.equal(deriveCpuEntry(data).level, 'healthy');
  assert.equal(deriveMemEntry(data).level, 'healthy');
  assert.equal(deriveMemEntry(null).level, 'unknown');
  assert.equal(deriveCpuEntry(null).state, 'UNKNOWN');
});

test('api reachability follows the system provider outcome', () => {
  assert.equal(deriveApiEntry('ok', { python: { version: '3.12.10' } }).state, 'ONLINE');
  assert.equal(deriveApiEntry('error', null).state, 'DOWN');
  assert.equal(deriveApiEntry('loading', null).state, 'CHECKING');
});

test('orders show real count, never fabricated', () => {
  const withOrders = deriveOrdersEntry({ totalOrders: 3 });
  assert.equal(withOrders.state, '3 OPEN');
  assert.equal(withOrders.level, 'healthy');
  const missing = deriveOrdersEntry(null);
  assert.equal(missing.state, 'UNKNOWN');
});
// ---------------------------------------------------------------------------
// NEXT-ACTION MODEL — "what happens next, and when"
//
// Fixtures below are the REAL `get_scheduler_info()` / `session_manager.snapshot()`
// shapes pushed by the backend in the SSE `state_snapshot` frame
// (`python-service/api/websocket.py`), not invented shapes.
// ---------------------------------------------------------------------------

/** 2026-10-13 08:50:00 +05:30 — the scheduler's own configured login instant. */
const DAY = '2026-10-13';
const AT = (hhmm: string, day = DAY) => `${day}T${hhmm}:00+05:30`;
const MS = (iso: string) => Date.parse(iso);

/** A `scheduler.info` block as the Scheduler Engine emits it at 10:42 IST
 *  (mid LIVE_FEED), copied from `get_scheduler_info()`. */
function liveSchedulerInfo() {
  return {
    running: true,
    state: 'TICK_COLLECTION',
    phase: 'LIVE_FEED',
    next_phase: 'square_off',
    next_phase_at: AT('15:16'),
    session_owner: 'scheduler',
    login_time: '08:50',
    tick_collection_time: '08:59',
    logout_time: '16:00',
    ws_start_time: '08:55',
    ws_stop_time: '15:31',
    is_trading_day: true,
    market_status: 'OPEN',
    market_session: 'OPEN',
    session_active: true,
    websocket_connected: true,
    next_login: AT('08:50'),
    next_tick_collection: AT('08:59'),
    next_logout: AT('16:00'),
    next_ws_start: AT('08:55'),
    next_ws_stop: AT('15:31'),
    schedule: {
      next_event: 'ws_disconnect',
      next_event_at: AT('15:31'),
      remaining_seconds: 17340,
      next_phase: 'square_off',
      next_phase_at: AT('15:16'),
      next_phase_remaining_seconds: 16440,
      timezone: 'Asia/Kolkata (IST, +05:30)',
      today_phase_times: {
        readiness: AT('08:55'),
        live_feed: AT('09:15'),
        square_off: AT('15:16'),
        websocket_close: AT('15:31'),
        logout: AT('16:00'),
      },
    },
  };
}

test('schedulerTimeline reads the backend instants, never hardcoded times', () => {
  const tl = schedulerTimeline(liveSchedulerInfo(), MS(AT('10:42')));
  assert.equal(tl.nextPhase, 'square_off');
  assert.equal(tl.nextPhaseAtMs, MS(AT('15:16')));
  assert.equal(tl.nextEvent, 'ws_disconnect');
  assert.equal(tl.nextEventAtMs, MS(AT('15:31')));
  assert.equal(tl.nextEventRemainingSeconds, 17340);
  assert.equal(tl.loginAtMs, MS(AT('08:50')));
  assert.equal(tl.wsStartAtMs, MS(AT('08:55')));
  assert.equal(tl.wsStopAtMs, MS(AT('15:31')));
  assert.equal(tl.logoutAtMs, MS(AT('16:00')));
  assert.equal(tl.logoutTime, '16:00');
  assert.equal(tl.isTradingDay, true);
  assert.equal(tl.timezone, 'Asia/Kolkata (IST, +05:30)');
});

test('schedulerTimeline prefers the absolute ISO instant over the HH:MM label', () => {
  // A schedule override moved ws_start to 09:20 but the HH:MM label still says
  // 08:55. The absolute instant must win, or the tooltip would lie.
  const tl = schedulerTimeline(
    { next_ws_start: AT('09:20'), ws_start_time: '08:55' },
    MS(AT('08:00')),
  );
  assert.equal(tl.wsStartAtMs, MS(AT('09:20')));
  assert.equal(tl.wsStartTime, '08:55');
});

test('schedulerTimeline resolves a bare HH:MM against TODAY in IST', () => {
  const tl = schedulerTimeline({ logout_time: '16:00' }, MS(AT('10:42')));
  assert.equal(tl.logoutAtMs, MS(AT('16:00')));
  // And it really is 16:00 IST, not 16:00 UTC (5h30m earlier than a naive parse).
  assert.equal(new Date(tl.logoutAtMs!).toISOString(), '2026-10-13T10:30:00.000Z');
});

test('schedulerTimeline returns nulls — never guesses — for an empty payload', () => {
  const tl = schedulerTimeline(null, MS(AT('10:42')));
  assert.equal(tl.nextPhase, null);
  assert.equal(tl.nextPhaseAtMs, null);
  assert.equal(tl.loginAtMs, null);
  assert.equal(tl.logoutAtMs, null);
  assert.equal(tl.nextEvent, null);
});

test('nextSchedulerAction prefers the phase over the event (square_off is phase-only)', () => {
  const now = MS(AT('10:42'));
  const next = nextSchedulerAction(schedulerTimeline(liveSchedulerInfo(), now), now);
  assert.ok(next);
  // The backend's 5-event list skips square_off (15:16) and feed_stop (15:30);
  // the phase machine knows about them, so it must win.
  assert.equal(next.key, 'square_off');
  assert.equal(next.label, 'Square-off');
  assert.equal(next.atMs, MS(AT('15:16')));
  assert.equal(next.inText, 'in 4h 34m');
  assert.equal(next.passed, false);
});

test('nextSchedulerAction degrades to the lifecycle event when no phase exists', () => {
  const now = MS(AT('07:30'));
  const tl = schedulerTimeline({
    next_phase: null,
    schedule: { next_event: 'login', next_event_at: AT('08:50'), remaining_seconds: 4800 },
  }, now);
  const next = nextSchedulerAction(tl, now);
  assert.equal(next?.key, 'login');
  assert.equal(next?.label, 'Broker login');
  assert.equal(next?.inText, 'in 1h 20m');
});

test('nextSchedulerAction is null when the backend publishes no plan at all', () => {
  assert.equal(nextSchedulerAction(schedulerTimeline(null, 1), 1), null);
  // An unmapped key still reports honestly instead of becoming invented prose.
  const weird = nextSchedulerAction(
    schedulerTimeline({ next_phase: 'quantum_realign', next_phase_at: AT('12:00') }, MS(AT('11:00'))),
    MS(AT('11:00')),
  );
  assert.equal(weird?.label, 'quantum realign');
});

test('nextWebSocketAction answers connect-when-down and disconnect-when-up', () => {
  const now = MS(AT('10:42'));
  const tl = schedulerTimeline(liveSchedulerInfo(), now);
  const up = nextWebSocketAction(tl, true, now);
  assert.equal(up?.key, 'ws_disconnect');
  assert.equal(up?.label, 'WebSocket disconnect');
  assert.equal(up?.atMs, MS(AT('15:31')));

  const down = nextWebSocketAction(tl, false, now);
  assert.equal(down?.key, 'ws_connect');
  assert.equal(down?.label, 'WebSocket connect');
  assert.equal(down?.atMs, MS(AT('08:55')));

  // Unknown connection state still reports the plan rather than hiding it.
  assert.equal(nextWebSocketAction(tl, 'UNKNOWN', now)?.key, 'ws_connect');
});

test('nextSessionAction: an active session ends at its REAL expiresAt', () => {
  const now = MS(AT('08:50'));
  const next = nextSessionAction(
    { status: 'SESSION_ACTIVE', active: true, expiresAt: AT('16:00'), remainingSeconds: 25800 },
    schedulerTimeline(liveSchedulerInfo(), now),
    now,
  );
  assert.equal(next?.key, 'session_expiry');
  assert.equal(next?.label, 'Session expires');
  assert.equal(next?.atMs, MS(AT('16:00')));
  assert.equal(next?.inText, 'in 7h 10m');
});

test('nextSessionAction: a manual session falls back to the scheduled logout', () => {
  const now = MS(AT('10:42'));
  // expiresAt absent — the backend's honest "no wall-clock expiry" case.
  const next = nextSessionAction(
    { status: 'SESSION_ACTIVE', active: true, expiresAt: null, remainingSeconds: null },
    schedulerTimeline(liveSchedulerInfo(), now),
    now,
  );
  assert.equal(next?.key, 'logout');
  assert.equal(next?.label, 'Scheduled logout');
  assert.equal(next?.atMs, MS(AT('16:00')));
});

test('nextSessionAction: no active session reports the next scheduled login', () => {
  const now = MS(AT('16:20'));
  const tl = schedulerTimeline(
    {
      market_session: 'CLOSED',
      login_time: '08:50',
      logout_time: '16:00',
      // After today's logout ran, the backend rolls these to the next trading day.
      next_login: AT('08:50', '2026-10-14'),
      next_logout: AT('16:00', '2026-10-14'),
    },
    now,
  );
  const next = nextSessionAction({ status: 'DISCONNECTED', active: false }, tl, now);
  assert.equal(next?.key, 'login');
  assert.equal(next?.label, 'Broker login');
  assert.equal(next?.atMs, MS(AT('08:50', '2026-10-14')));
});

test('marketLoginGate reports CLOSED after 16:00 and names the configured logout', () => {
  const now = MS(AT('16:20'));
  const tl = schedulerTimeline({
    market_status: 'CLOSED',
    market_session: 'CLOSED',
    logout_time: '16:00',
    next_logout: AT('16:00', '2026-10-14'),
  }, now);
  const gate = marketLoginGate({ hydrated: true, timeline: tl, marketRec: { trading_day: true }, nowMs: now });
  assert.equal(gate.closed, true);
  assert.equal(gate.logoutTime, '16:00');
  assert.match(gate.reason, /Market closed/);
  // Today's logout has already run — the wording must not claim it is upcoming.
  assert.match(gate.reason, /already run/);
  assert.doesNotMatch(gate.reason, /has already run.*\bin /);
});

test('marketLoginGate treats the 15:30–16:00 post-close window as closed too', () => {
  const now = MS(AT('15:45'));
  const tl = schedulerTimeline({
    market_status: 'OPEN',
    market_session: 'POST_CLOSE',
    logout_time: '16:00',
    next_logout: AT('16:00'),
  }, now);
  const gate = marketLoginGate({ hydrated: true, timeline: tl, marketRec: { trading_day: true }, nowMs: now });
  assert.equal(gate.closed, true);
  assert.match(gate.reason, /Market closed/);
  assert.match(gate.reason, /16:00 IST/);
  assert.match(gate.reason, /in 15m/);
});

test('marketLoginGate is NOT closed while the market is open', () => {
  const now = MS(AT('10:42'));
  const tl = schedulerTimeline(liveSchedulerInfo(), now);
  const gate = marketLoginGate({ hydrated: true, timeline: tl, marketRec: { trading_day: true }, nowMs: now });
  assert.equal(gate.closed, false);
  assert.match(gate.reason, /Market open/);
});

test('marketLoginGate: weekend and holiday are closed, unhydrated is not decided', () => {
  const now = MS(AT('10:42'));
  const tl = schedulerTimeline(liveSchedulerInfo(), now);
  const weekend = marketLoginGate({ hydrated: true, timeline: tl, marketRec: { day_class: 'WEEKEND' }, nowMs: now });
  assert.equal(weekend.closed, true);
  assert.match(weekend.reason, /Weekend/);

  const holiday = marketLoginGate({ hydrated: true, timeline: tl, marketRec: { day_class: 'EXCHANGE_HOLIDAY' }, nowMs: now });
  assert.equal(holiday.closed, true);
  assert.match(holiday.reason, /holiday/i);

  // Pre-hydration is an unknown, NOT a closed verdict.
  const unknown = marketLoginGate({ hydrated: false, timeline: tl, marketRec: null, nowMs: now });
  assert.equal(unknown.closed, false);
  assert.match(unknown.reason, /Checking/);
});

test('fmtSpan / fmtDurationUntil / fmtNextIn never fabricate an interval', () => {
  assert.equal(fmtSpan(3600), '1h 00m');
  assert.equal(fmtSpan(600), '10m 00s');
  assert.equal(fmtSpan(45), '45s');
  assert.equal(fmtSpan(null), '—');
  assert.equal(fmtSpan(NaN), '—');
  assert.equal(fmtDurationUntil(0, 0), 'now');
  assert.equal(fmtDurationUntil(1000, 0), 'in 1s');
  assert.equal(fmtDurationUntil(7000, 0), 'in 7s');
  // No tick + no backend countdown -> explicit unknown, never a made-up number.
  assert.equal(fmtDurationUntil(7000, null), '—');
  assert.equal(fmtNextIn({ key: 'x', label: 'x', atMs: 7000, remainingSeconds: null, inText: '', passed: false }, null), '—');
  // No tick, but the backend's own remaining_seconds is real — use it.
  assert.equal(
    fmtNextIn({ key: 'x', label: 'x', atMs: null, remainingSeconds: 4800, inText: '', passed: false }, null),
    'in 1h 20m',
  );
  assert.equal(fmtNextIn(null, 1), '—');
});

test('a real post-close snapshot produces a closed gate AND a next-action plan', () => {
  const now = MS(AT('16:20'));
  const entries = deriveStatus(
    baseInput({
      nowMs: now,
      brokerWsConnected: false,
      brokerWsState: 'SUPERVISOR_STOPPED',
      sessionRec: { status: 'DISCONNECTED', active: false, broker: 'Kotak Neo' },
      sessionActive: false,
      schedulerRec: {
        running: true,
        state: 'MARKET_CLOSED',
        info: {
          market_status: 'CLOSED',
          market_session: 'CLOSED',
          is_trading_day: true,
          logout_time: '16:00',
          ws_start_time: '08:55',
          ws_stop_time: '15:31',
          // Rolled to the next trading day by the backend itself.
          next_login: AT('08:50', '2026-10-14'),
          next_ws_start: AT('08:55', '2026-10-14'),
          next_ws_stop: AT('15:31', '2026-10-14'),
          next_logout: AT('16:00', '2026-10-14'),
          next_phase: 'readiness',
          next_phase_at: AT('08:55', '2026-10-14'),
        },
      },
      marketRec: { market_status: 'CLOSED', day_class: 'TRADING', trading_day: true },
    }),
  );

  const gate = marketLoginGate({
    hydrated: true,
    timeline: schedulerTimeline((entries.length && ({})) || null, now),
    marketRec: { market_status: 'CLOSED', trading_day: true },
    nowMs: now,
  });
  assert.equal(gate.closed, true);

  // Session is NOT active -> a login action is genuinely warranted.
  assert.equal(isManualLoginState(canonicalSessionState('DISCONNECTED')), true);

  const sess = byId(entries, 'sess');
  assert.equal(sess.state, 'INACTIVE');
  assert.equal(sess.next?.key, 'login', 'session indicator must name the next login');
  assert.equal(sess.after?.key, 'logout', 'and the scheduled logout for completeness');

  const ws = byId(entries, 'ws');
  assert.equal(ws.next?.key, 'ws_connect');
  assert.equal(ws.after?.key, 'ws_disconnect');

  const sched = byId(entries, 'sched');
  assert.equal(sched.next?.key, 'readiness');
  assert.ok(sched.rows.some((r) => r.label === 'Next logout' && r.value.includes('16:00')));
  assert.ok(sched.rows.some((r) => r.label === 'Trading day' && r.value === 'Yes'));
});

test('the scheduler rows never render an event NAME as if it were a timestamp', () => {
  // Regression guard: the old chain read `info.schedule.next_event`, which is a
  // NAME ("ws_disconnect"), and fed it to the clock formatter.
  const entries = deriveStatus(
    baseInput({
      schedulerRec: {
        running: true,
        state: 'RUNNING',
        info: {
          schedule: {
            next_event: 'ws_disconnect',
            next_event_at: AT('15:31'),
            schedule: { timezone: 'Asia/Kolkata (IST, +05:30)' },
          },
        },
      },
    }),
  );
  const sched = byId(entries, 'sched');
  for (const row of sched.rows) {
    assert.doesNotMatch(row.value, /ws_disconnect/, `row "${row.label}" leaked an event name: ${row.value}`);
  }
});

test('systemPollBroker reads enabled_brokers only when unambiguous', () => {
  // Live shape: schedulerInfo.enabled_brokers === ["kotak"].
  assert.equal(systemPollBroker({ schedulerInfo: { enabled_brokers: ['kotak'] } }), 'kotak');
  assert.equal(systemPollBroker({ schedulerInfo: { enabled_brokers: ['shoonya'] } }), 'shoonya');
  // Zero brokers, several brokers, garbage, or no poll at all -> null, never a guess.
  assert.equal(systemPollBroker({ schedulerInfo: { enabled_brokers: [] } }), null);
  assert.equal(systemPollBroker({ schedulerInfo: { enabled_brokers: ['kotak', 'shoonya'] } }), null);
  assert.equal(systemPollBroker({ schedulerInfo: { enabled_brokers: ['zerodha'] } }), null);
  assert.equal(systemPollBroker({ schedulerInfo: {} }), null);
  assert.equal(systemPollBroker(null), null);
  assert.equal(systemPollBroker(undefined), null);
});

test('systemPollSessionActive reflects the polled broker sessions', () => {
  // Live shape: brokers.kotak.session.active === false while logged out.
  assert.equal(systemPollSessionActive({ schedulerInfo: { brokers: { kotak: { session: { active: false } } } } }), false);
  assert.equal(systemPollSessionActive({ schedulerInfo: { brokers: { kotak: { session: { active: true } } } } }), true);
  // Absent block -> false (realtime path decides), never a fabricated true.
  assert.equal(systemPollSessionActive({ schedulerInfo: {} }), false);
  assert.equal(systemPollSessionActive(null), false);
});
