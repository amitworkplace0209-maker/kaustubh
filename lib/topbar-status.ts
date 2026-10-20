// Pure, testable model for the premium GlobalTopBar status cluster.
//
// Every value is derived from REAL backend state (realtime provider snapshot,
// system provider payload, market calendar). The model never fabricates a
// value; missing fields resolve to UNKNOWN / "—" so the UI renders honest
// state instead of fake greens.

export type PillLevel = 'healthy' | 'warning' | 'error' | 'offline' | 'unknown' | 'neutral' | 'info';

export interface DiagnosticRow {
  label: string;
  value: string;
}

export interface StatusEvent {
  at: string;
  status: string;
  detail: string;
}

/**
 * ONE honest description of "what this system does next, and when".
 *
 * Every field is backend-derived. `atMs` is an absolute instant the backend
 * emitted (scheduler `next_phase_at` / `next_*` ISO strings, session `expiresAt`);
 * `remainingSeconds` is the backend's own server-computed countdown; `inText` is
 * the browser's rendering of the gap between them and is ONLY produced when the
 * caller supplies a tick (`nowMs`). Nothing here is ever guessed — an absent
 * instant yields `null`, which the UI renders as an explicit unknown.
 */
export interface NextActionInfo {
  /** Backend action key (scheduler phase or lifecycle event name). */
  key: string;
  /** Human label for the action; falls back to the raw key when unmapped. */
  label: string;
  /** Absolute epoch-ms the action fires, or null when the backend gave none. */
  atMs: number | null;
  /** Backend-computed seconds remaining, or null when the backend gave none. */
  remainingSeconds: number | null;
  /** "in 4h 12m" / "in 9m 40s" / "now" — only when a tick was supplied. */
  inText: string;
  /** True when this instant is already in the past (backend is behind). */
  passed: boolean;
}

export interface StatusEntry {
  id:
    | 'net'
    | 'ws'
    | 'db'
    | 'sched'
    | 'sess'
    | 'market'
    | 'api'
    | 'feed'
    | 'pipeline'
    | 'cpu'
    | 'mem'
    | 'orders';
  label: string;
  short: string;
  icon:
    | 'network'
    | 'webhook'
    | 'database'
    | 'calendarClock'
    | 'user'
    | 'landmark'
    | 'activity'
    | 'gauge'
    | 'layers'
    | 'chip'
    | 'memoryStick'
    | 'receiptText';
  level: PillLevel;
  state: string;
  hint?: string;
  detail: string;
  href?: string;
  rows: DiagnosticRow[];
  /** What happens next + when. Absent when the backend reports no plan. */
  next?: NextActionInfo;
  /** Secondary plan line (e.g. the next WebSocket connect AFTER the disconnect). */
  after?: NextActionInfo;
}

export type StatusLinkKey =
  | 'internet'
  | 'websocket'
  | 'database'
  | 'scheduler'
  | 'session'
  | 'market'
  | 'api'
  | 'feed'
  | 'pipeline'
  | 'cpu'
  | 'mem'
  | 'orders';

export type StatusLinks = Partial<Record<StatusLinkKey, string>>;

export interface StatusInput {
  hydrated: boolean;
  /** Application ↔ backend SSE connection state (CONNECTING/CONNECTED/
   *  RECONNECTING/DISCONNECTED/OFFLINE). OFFLINE = the browser itself lost
   *  its network — a real, instant signal for the neuron indicator. */
  appConnection: string;
  internetConnected: boolean | null;
  brokerWsConnected: boolean | 'UNKNOWN';
  brokerWsState: string;
  wsRec: Record<string, any> | null;
  schedulerRec: Record<string, any> | null;
  dbRec: Record<string, any> | null;
  sessionRec: Record<string, any> | null;
  sessionActive: boolean | 'UNKNOWN';
  sessionStatus: string;
  marketRec: Record<string, any> | null;
  systemData: Record<string, any> | null;
  links: StatusLinks;
  /**
   * Browser clock (epoch ms) used ONLY to interpolate "what happens next"
   * countdowns between two backend pushes. `null` means "no tick" — the UI then
   * shows the backend's own `remaining_seconds` instead of a browser guess.
   * Optional so the pure model stays callable from plain unit tests.
   */
  nowMs?: number | null;
}

const DASH = '—';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Number → "120ms" (real latency only; null when the value does not exist). */
export function fmtLatency(n: unknown): string | null {
  const num = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN;
  if (!Number.isFinite(num) || num < 0) return null;
  return `${Math.round(num)}ms`;
}

/** Epoch seconds / ISO → "HH:MM:SS"; null when unparseable. */
export function fmtHMS(v: unknown): string | null {
  if (v == null) return null;
  let ms: number;
  if (typeof v === 'number') ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string') {
    const n = Date.parse(v);
    if (!Number.isFinite(n)) return null;
    ms = n;
  } else return null;
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

/** ISO string / Date → "HH:MM:SS IST" label for business timestamps. */
export function fmtISTClock(v: unknown): string {
  const hms = fmtHMS(v);
  return hms ? `${hms} IST` : DASH;
}

/** Count with thousands separators; "—" for missing values. */
export function fmtCount(n: unknown): string {
  const num = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN;
  if (!Number.isFinite(num)) return DASH;
  return num.toLocaleString('en-IN');
}

/** "2 sec ago" from a numeric/ISO timestamp. */
export function fmtAgo(v: unknown): string {
  const ms = toMs(v);
  if (ms == null) return DASH;
  const diff = Date.now() - ms;
  if (diff < 0) return 'now';
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} sec ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Level classification
// ---------------------------------------------------------------------------

const WS_INTERMEDIATE = new Set(['SUPERVISOR_CONNECTING', 'SUPERVISOR_RECONNECTING', 'RECONNECTING', 'CONNECTING', 'WAITING', 'WS_CONNECTING', 'WS_RECONNECTING']);

/**
 * Scheduler states that mean "the engine is up and intentionally idle because
 * today's trading day is over", not "actively working". The backend really does
 * report `running: true` in these, so they are separated from RUNNING here to
 * keep the indicator honest.
 */
const IDLE_BY_DESIGN = [
  'MARKET_CLOSED',
  'WAITING_FOR_NEXT_TRADING_DAY',
  'WAITING_FOR_MARKET_WINDOW',
  'LOGGED_OUT',
  'DAY_COMPLETE',
  'STOPPED',
];

// ---------------------------------------------------------------------------
// NEXT-ACTION MODEL — "what happens next, and when", backend-authoritative
// ---------------------------------------------------------------------------

/**
 * Human labels for the Scheduler Engine's PHASE boundaries.
 *
 * The backend emits lowercase snake keys from `SchedulerController`'s
 * `build_phase_times()` (`python-service/scheduler/__init__.py`) and the
 * projection carries them verbatim in `info.next_phase`. An unmapped key falls
 * back to the raw backend string — never to invented prose.
 */
export const PHASE_LABELS: Record<string, string> = {
  readiness: 'Readiness check',
  pre_market: 'Pre-market',
  limit_order: 'Limit-order window',
  equilibrium: 'Equilibrium',
  buffer: 'Buffer / pre-open',
  live_feed: 'Live market feed',
  square_off: 'Square-off',
  feed_stop: 'Feed stop',
  websocket_close: 'WebSocket close',
  logout: 'Logout · day complete',
  closed: 'Market closed',
  day_complete: 'Day complete',
};

/**
 * Human labels for the Scheduler Engine's LIFECYCLE EVENTS (`build(d)` in
 * `get_schedule()`): login / ws_connect / tick_collection_start /
 * ws_disconnect / logout. Note the backend deliberately omits `square_off`
 * (15:16) and `feed_stop` (15:30) from this list — those only appear as
 * phases, which is why `nextSchedulerAction` prefers the phase machine.
 */
export const EVENT_LABELS: Record<string, string> = {
  login: 'Broker login',
  ws_connect: 'WebSocket connect',
  tick_collection_start: 'Tick collection start',
  ws_disconnect: 'WebSocket disconnect',
  logout: 'Broker logout',
};

/** IST is a fixed +05:30 with no DST (backend: `core/timezones.py`). */
const IST_OFFSET_MS = 5.5 * 3_600_000;

/**
 * "HH:MM" (the backend's configured wall-clock times, e.g. "16:00") resolved
 * against TODAY in IST → absolute epoch ms. Returns null when the value is not
 * a plain HH:MM string, so an unconfigured/missing time is never invented.
 *
 * Used ONLY as a fallback: the backend also publishes absolute ISO instants
 * (`schedule.today_phase_times`, `next_*`), and those are always preferred.
 */
function todayIstInstant(hhmm: unknown, nowMs: number): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  const ist = new Date(nowMs + IST_OFFSET_MS);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, min) - IST_OFFSET_MS;
}

/** "4h 12m" / "9m 40s" / "40s" from a positive second count. Unknown input →
 *  the explicit unknown dash (never a fabricated zero). */
export function fmtSpan(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return DASH;
  const t = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Compact "in 4h 12m" / "in 9m 40s" / "now" for a real future instant.
 *  Requires a tick; without one it honestly returns the unknown dash rather
 *  than a browser-guessed interval. */
export function fmtDurationUntil(atMs: number | null, nowMs: number | null): string {
  if (atMs == null || nowMs == null) return DASH;
  const diff = atMs - nowMs;
  if (diff <= 0) return 'now';
  return `in ${fmtSpan(diff / 1000)}`;
}

/**
 * "in 4h 12m" for a NextActionInfo.
 *
 * Prefers the browser tick when the caller has one (live interpolation between
 * two backend pushes), and otherwise falls back to the backend's OWN
 * server-computed `remaining_seconds` — so a countdown is always either real or
 * an explicit unknown, never a frontend fiction.
 */
export function fmtNextIn(next: NextActionInfo | null | undefined, nowMs: number | null): string {
  if (!next) return DASH;
  if (nowMs != null && next.atMs != null) return fmtDurationUntil(next.atMs, nowMs);
  if (next.remainingSeconds != null && Number.isFinite(next.remainingSeconds)) {
    return next.remainingSeconds <= 0 ? 'now' : `in ${fmtSpan(next.remainingSeconds)}`;
  }
  return DASH;
}

/** "15:31:00 IST" for a NextActionInfo instant (explicit unknown when absent).
 *  Already carries the IST suffix — callers must not append it again. */
export function fmtNextAt(next: NextActionInfo | null | undefined): string {
  if (!next || next.atMs == null) return DASH;
  return fmtISTClock(next.atMs);
}

/** Normalized, fully backend-sourced view of the Scheduler Engine's plan. */
export interface SchedulerTimeline {
  nextPhase: string | null;
  nextPhaseAtMs: number | null;
  nextPhaseRemainingSeconds: number | null;
  nextEvent: string | null;
  nextEventAtMs: number | null;
  nextEventRemainingSeconds: number | null;
  loginAtMs: number | null;
  logoutAtMs: number | null;
  wsStartAtMs: number | null;
  wsStopAtMs: number | null;
  tickCollectionAtMs: number | null;
  loginTime: string | null;
  logoutTime: string | null;
  wsStartTime: string | null;
  wsStopTime: string | null;
  tickCollectionTime: string | null;
  timezone: string | null;
  isTradingDay: boolean | null;
  marketStatus: string | null;
  marketSession: string | null;
  phase: string | null;
  state: string | null;
  sessionOwner: string | null;
}

function firstNonNull(...values: unknown[]): unknown {
  for (const v of values) if (v != null) return v;
  return null;
}

/**
 * Flatten the Scheduler Engine's `get_scheduler_info()` payload into a plain,
 * unit-testable timeline.
 *
 * Resolution order per instant — the ABSOLUTE backend value always wins:
 *   1. `info.<field>`           — the canonical `next_*` ISO instant
 *   2. `info.schedule.<field>`  — the same instant inside the schedule block
 *   3. `info.schedule.today_phase_times.<phase>` — today's absolute phase ISO
 *   4. `info.<hhmm field>` + `nowMs` — configured "HH:MM" resolved to today IST
 *
 * Nothing is hardcoded: 08:50 / 08:55 / 16:00 / 15:31 are live Mongo settings
 * re-read by the backend every tick, so the UI must read them, never assume.
 */
export function schedulerTimeline(
  info: Record<string, any> | null | undefined,
  nowMs: number | null = null,
): SchedulerTimeline {
  const i = (info ?? {}) as Record<string, any>;
  const sched = (i.schedule ?? {}) as Record<string, any>;
  const todayPhases = (sched.today_phase_times ?? {}) as Record<string, any>;

  const resolve = (
    keys: string[],
    hhmmKey: string | null,
    todayPhaseKey: string | null,
  ): number | null => {
    for (const k of keys) {
      const ms = toMs(firstNonNull(i[k], sched[k]));
      if (ms != null) return ms;
    }
    if (todayPhaseKey) {
      const ms = toMs(todayPhases[todayPhaseKey]);
      if (ms != null) return ms;
    }
    if (hhmmKey && nowMs != null) {
      const ms = todayIstInstant(i[hhmmKey], nowMs);
      if (ms != null) return ms;
    }
    return null;
  };

  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };

  return {
    nextPhase: String(firstNonNull(i.next_phase, sched.next_phase) ?? '') || null,
    nextPhaseAtMs: toMs(firstNonNull(i.next_phase_at, sched.next_phase_at)),
    nextPhaseRemainingSeconds: num(firstNonNull(sched.next_phase_remaining_seconds, i.next_phase_remaining_seconds)),
    nextEvent: String(firstNonNull(i.next_event, sched.next_event) ?? '') || null,
    nextEventAtMs: toMs(firstNonNull(i.next_event_at, sched.next_event_at)),
    nextEventRemainingSeconds: num(firstNonNull(sched.remaining_seconds, i.remaining_seconds)),
    loginAtMs: resolve(['next_login', 'next_login_time'], 'login_time', 'login'),
    logoutAtMs: resolve(['next_logout', 'next_logout_time'], 'logout_time', 'logout'),
    wsStartAtMs: resolve(['next_ws_start', 'next_ws_connect_time'], 'ws_start_time', 'websocket_close'),
    wsStopAtMs: resolve(['next_ws_stop', 'next_ws_disconnect_time'], 'ws_stop_time', 'websocket_close'),
    tickCollectionAtMs: resolve(['next_tick_collection', 'next_tick_collection_time'], 'tick_collection_time', 'buffer'),
    loginTime: str(firstNonNull(i.login_time, sched.schedule?.login, sched.login)),
    logoutTime: str(firstNonNull(i.logout_time, sched.schedule?.logout, sched.logout)),
    wsStartTime: str(firstNonNull(i.ws_start_time, sched.schedule?.ws_connect, sched.ws_connect)),
    wsStopTime: str(firstNonNull(i.ws_stop_time, sched.schedule?.ws_disconnect, sched.ws_disconnect)),
    tickCollectionTime: str(firstNonNull(i.tick_collection_time, sched.schedule?.tick_collection_start, sched.tick_collection_start)),
    timezone: str(sched.schedule?.timezone ?? sched.timezone),
    isTradingDay: typeof i.is_trading_day === 'boolean' ? i.is_trading_day : null,
    marketStatus: str(i.market_status),
    marketSession: str(i.market_session),
    phase: str(i.phase),
    state: str(i.state),
    sessionOwner: str(i.session_owner),
  };
}

function str(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function mkNext(
  key: string | null,
  labels: Record<string, string>,
  atMs: number | null,
  remainingSeconds: number | null,
  nowMs: number | null,
): NextActionInfo | null {
  if (!key && atMs == null) return null;
  const k = key ?? '';
  return {
    key: k,
    label: labels[k] ?? (k ? k.replace(/_/g, ' ') : 'Next action'),
    atMs,
    remainingSeconds,
    inText: fmtDurationUntil(atMs, nowMs),
    passed: atMs != null && nowMs != null && atMs <= nowMs,
  };
}

/**
 * THE "what happens next" for the whole Scheduler Engine.
 *
 * Prefers the PHASE machine (`next_phase`/`next_phase_at`) because it covers
 * every boundary the backend emits — including square_off (15:16) and
 * feed_stop (15:30), which the 5-event `next_event` list deliberately omits.
 * Falls back to the lifecycle event when the backend published no phase.
 */
export function nextSchedulerAction(
  tl: SchedulerTimeline,
  nowMs: number | null = null,
): NextActionInfo | null {
  const candidates: (NextActionInfo | null)[] = [
    mkNext(tl.nextPhase, PHASE_LABELS, tl.nextPhaseAtMs, tl.nextPhaseRemainingSeconds, nowMs),
    mkNext(tl.nextEvent, EVENT_LABELS, tl.nextEventAtMs, tl.nextEventRemainingSeconds, nowMs),
  ];
  const real = candidates.filter((c): c is NextActionInfo => c != null && c.atMs != null);
  if (real.length) {
    // Stable sort: the phase wins ties (it is the fuller description).
    return real.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))[0];
  }
  return candidates.find((c): c is NextActionInfo => c != null) ?? null;
}

/**
 * THE WebSocket plan: when the broker socket next goes UP or comes DOWN.
 *
 * The connect/disconnect instants come from the Scheduler Engine (it owns the
 * socket lifecycle — `start_ws`/`stop_ws` at 08:55 / 15:31 by default), so the
 * indicator can tell the user what is coming instead of only what is.
 */
export function nextWebSocketAction(
  tl: SchedulerTimeline,
  connected: boolean | 'UNKNOWN',
  nowMs: number | null = null,
): NextActionInfo | null {
  if (connected === true) {
    return mkNext('ws_disconnect', EVENT_LABELS, tl.wsStopAtMs, null, nowMs);
  }
  return mkNext('ws_connect', EVENT_LABELS, tl.wsStartAtMs, null, nowMs);
}

/**
 * THE Session plan: when the authenticated broker session ends, or when the
 * next one is scheduled to start.
 *
 *   • ACTIVE with a real `expiresAt` → that instant is authoritative and is
 *     exactly what the visible countdown ticks down to (survives refresh).
 *   • ACTIVE without `expiresAt`     → fall back to the scheduler's logout
 *     instant; when that is also absent, report UNKNOWN rather than invent a
 *     60-minute window (the backend treats a null expiry as "no countdown").
 *   • Not ACTIVE                    → the next scheduler-owned login instant.
 */
export function nextSessionAction(
  sessionRec: Record<string, any> | null,
  tl: SchedulerTimeline,
  nowMs: number | null = null,
): NextActionInfo | null {
  const s = (sessionRec ?? {}) as Record<string, any>;
  const active = s.active === true || s.status === 'SESSION_ACTIVE' || s.status === 'WS_ACTIVE';
  const expiresAtMs = toMs(s.expiresAt);
  if (active) {
    if (expiresAtMs != null) {
      return {
        key: 'session_expiry',
        label: 'Session expires',
        atMs: expiresAtMs,
        remainingSeconds: typeof s.remainingSeconds === 'number' ? s.remainingSeconds : null,
        inText: fmtDurationUntil(expiresAtMs, nowMs),
        passed: nowMs != null && expiresAtMs <= nowMs,
      };
    }
    if (tl.logoutAtMs != null) {
      return {
        key: 'logout',
        label: 'Scheduled logout',
        atMs: tl.logoutAtMs,
        remainingSeconds: null,
        inText: fmtDurationUntil(tl.logoutAtMs, nowMs),
        passed: nowMs != null && tl.logoutAtMs <= nowMs,
      };
    }
    return null;
  }
  return mkNext('login', EVENT_LABELS, tl.loginAtMs, null, nowMs);
}

/**
 * Honest "is the market closed right now?" verdict used to decide whether the
 * SESSION indicator offers a Manual Login action.
 *
 * Derived from the backend's own calendar buckets
 * (`python-service/services/market_calendar.py`): POST_CLOSE is 15:30–16:00 and
 * CLOSED is everything after 16:00 — the same 16:00 boundary the Scheduler
 * Engine uses as its logout time — so the post-close window and the post-16:00
 * window are both honestly "closed". Weekend / exchange-holiday day classes
 * count as closed. Times are never hardcoded: the configured logout instant is
 * read from the scheduler payload.
 */
export interface MarketLoginGate {
  /** Market genuinely closed right now (or not a trading day). */
  closed: boolean;
  /** One honest line explaining the verdict. */
  reason: string;
  /** Today's configured scheduler logout instant (IST), when known. */
  logoutAtMs: number | null;
  /** Configured logout wall-clock label, e.g. "16:00". */
  logoutTime: string | null;
}

export function marketLoginGate(input: {
  hydrated: boolean;
  timeline: SchedulerTimeline;
  marketRec?: Record<string, any> | null;
  nowMs: number;
}): MarketLoginGate {
  const { hydrated, timeline: tl, nowMs } = input;
  const m = (input.marketRec ?? {}) as Record<string, any>;
  const logoutAtMs = tl.logoutAtMs;
  const logoutTime = tl.logoutTime;

  if (!hydrated) {
    return { closed: false, reason: 'Checking market state…', logoutAtMs, logoutTime };
  }

  const session = String(firstNonNull(tl.marketSession, m.market_session) ?? '').toUpperCase();
  const status = String(firstNonNull(tl.marketStatus, m.market_status) ?? '').toUpperCase();
  const dayClass = String(m.day_class ?? '').toUpperCase();
  const tradingDay = typeof m.trading_day === 'boolean' ? m.trading_day : tl.isTradingDay;
  const holiday = dayClass === 'EXCHANGE_HOLIDAY' || Boolean(m.is_exchange_holiday);
  const weekend = dayClass === 'WEEKEND' || Boolean(m.is_weekend);

  if (holiday) return { closed: true, reason: 'Exchange holiday — no trading session.', logoutAtMs, logoutTime };
  if (weekend) return { closed: true, reason: 'Weekend — no trading session.', logoutAtMs, logoutTime };
  if (tradingDay === false) {
    return { closed: true, reason: 'Not a trading day — no trading session.', logoutAtMs, logoutTime };
  }

  const postClose = session === 'POST_CLOSE' || status === 'POST_CLOSE';
  const closed = postClose || session === 'CLOSED' || status === 'CLOSED' || status === 'MARKET_CLOSED';

  if (closed) {
    const when = logoutTime ?? (logoutAtMs != null ? fmtHMS(logoutAtMs) : null);
    if (when == null) {
      return { closed: true, reason: 'Market closed — broker login is manual from here.', logoutAtMs, logoutTime };
    }
    /*
     * Which of the two closed buckets we are in decides the wording, NOT a
     * comparison against `next_logout`:
     *
     *   POST_CLOSE (15:30 → 16:00) — the scheduled logout is still ahead.
     *   CLOSED      (after 16:00)    — the logout instant has passed. The
     *     backend's `POST_CLOSE_TIME` IS the 16:00 logout boundary, so a CLOSED
     *     session is proof today's logout ran; and by then `next_logout` has
     *     already rolled forward to the NEXT trading day, which is why an
     *     instant comparison would wrongly report "logout in 23h".
     */
    if (session === 'CLOSED' || status === 'CLOSED' || status === 'MARKET_CLOSED') {
      return {
        closed: true,
        reason: `Market closed · the scheduled logout (${when} IST) has already run — broker login is manual.`,
        logoutAtMs,
        logoutTime,
      };
    }
    return {
      closed: true,
      reason: `Market closed · scheduler logout at ${when} IST (${fmtDurationUntil(logoutAtMs, nowMs)}).`,
      logoutAtMs,
      logoutTime,
    };
  }
  return {
    closed: false,
    reason: 'Market open — the scheduler owns login for this session.',
    logoutAtMs,
    logoutTime,
  };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export function deriveStatus(input: StatusInput): StatusEntry[] {
  const { links } = input;

  // ONE timeline per derivation pass — every indicator reads the same
  // backend plan, so the four pills can never disagree about "what's next".
  const timeline = schedulerTimeline(input.schedulerRec?.info, input.nowMs ?? null);

  const net = deriveNetwork(input);
  const ws = deriveWebSocket(input, timeline);
  const db = deriveDatabase(input);
  const sched = deriveScheduler(input, timeline);
  const sess = deriveSession(input, timeline);
  const market = deriveMarket(input);

  return [net, ws, db, sched, sess, market].map((e) => ({
    ...e,
    href: e.href ?? links[e.id === 'net' ? 'internet' : e.id === 'ws' ? 'websocket' : e.id === 'db' ? 'database' : e.id === 'sched' ? 'scheduler' : e.id === 'sess' ? 'session' : 'market'],
  }));
}

function deriveNetwork(input: StatusInput): StatusEntry {
  const { hydrated, internetConnected, appConnection } = input;
  // Backend-authoritative internet status.
  //   GREEN  ← backend probe answered true (never a browser guess).
  //   AMBER  ← a real check is still in progress / probe hasn't answered yet.
  //   GRAY   ← the browser itself reports no network (data genuinely
  //            unavailable locally) — the only frontend signal used, and only
  //            to turn the indicator RED/GRAY, never to invent a green.
  //   RED    ← backend probe answered false (backend reports no internet).
  const browserOffline = appConnection === 'OFFLINE';

  let level: PillLevel;
  let state: string;
  let detail: string;
  if (!hydrated && internetConnected == null && !browserOffline) {
    level = 'warning';
    state = 'CHECKING';
    detail = 'Checking connection…';
  } else if (browserOffline) {
    level = 'offline';
    state = 'OFFLINE';
    detail = 'Browser offline';
  } else if (internetConnected === false) {
    level = 'error';
    state = 'DOWN';
    detail = 'Backend reports no internet';
  } else if (internetConnected === true) {
    level = 'healthy';
    state = 'ONLINE';
    detail = 'Connected';
  } else {
    // Hydrated but the backend probe hasn't produced a value yet — the check
    // is genuinely in flight (never a permanent gray).
    level = 'warning';
    state = 'CHECKING';
    detail = 'Internet probe pending…';
  }
  return {
    id: 'net',
    label: 'Network',
    short: 'NET',
    icon: 'network',
    level,
    state,
    detail,
    rows: [
      { label: 'Backend probe', value: internetConnected == null ? '—' : internetConnected ? 'Connected' : 'Failed' },
      { label: 'Connection', value: appConnection || '—' },
      { label: 'Source', value: 'Backend internet probe' },
    ],
  };
}

function deriveWebSocket(input: StatusInput, tl: SchedulerTimeline): StatusEntry {
  const { hydrated, brokerWsConnected, brokerWsState, wsRec } = input;
  const connAt = wsRec?.connectedAt ?? wsRec?.connected_at ?? (input.sessionRec as any)?.websocket?.connectedAt;
  const subs = wsRec?.subscriptionCount ?? wsRec?.subscriptionRegistryCount;
  const ticks = wsRec?.metrics?.ticks_received ?? (wsRec?.live as any)?.ticksReceived;
  const lastTick = wsRec?.lastTickAt ?? (wsRec?.live as any)?.lastTickAt;
  const reconnects = wsRec?.reconnectCount ?? (wsRec?.live as any)?.reconnectCount;
  const lastMsg = wsRec?.lastMessageAt ?? (wsRec?.live as any)?.lastMessageAt;
  const reason = wsRec?.disconnectReason ?? (wsRec?.live as any)?.disconnectReason;

  const stateClean = String(brokerWsState ?? '').toUpperCase();
  const checking = !hydrated || brokerWsConnected === 'UNKNOWN';
  const intermediate = WS_INTERMEDIATE.has(stateClean);

  let level: PillLevel;
  if (!hydrated) level = 'warning'; // pre-hydration — nothing painted as red yet
  else if (brokerWsConnected === true) level = 'healthy';
  else if (checking || intermediate) level = 'warning'; // connecting/reconnecting still in progress — amber
  else level = 'error';

  const state = brokerWsConnected === true
    ? 'CONNECTED'
    : brokerWsConnected === false
      ? 'DISCONNECTED'
      : intermediate
        ? stateClean.replace(/^(SUPERVISOR_|WS_)/, '')
        : 'CHECKING';

  const nowMs = input.nowMs ?? null;
  const next = nextWebSocketAction(tl, brokerWsConnected, nowMs);
  // The plan AFTER the next one — e.g. connected → disconnect, then reconnect
  // at tomorrow's ws_start. Gives the user the full picture in one hover.
  const after = next
    ? next.key === 'ws_disconnect'
      ? mkNext('ws_connect', EVENT_LABELS, tl.wsStartAtMs, null, nowMs) ?? undefined
      : mkNext('ws_disconnect', EVENT_LABELS, tl.wsStopAtMs, null, nowMs) ?? undefined
    : undefined;

  return {
    id: 'ws',
    label: 'WebSocket',
    short: 'WS',
    icon: 'webhook',
    level,
    state,
    detail: level === 'healthy' ? `${fmtCount(subs)} subs · ${fmtValue(ticks, 'ticks')} · ${fmtAgo(lastTick)}` : checking ? 'Checking live feed…' : level === 'warning' ? 'Reconnecting…' : 'Disconnected',
    next: next ?? undefined,
    after,
    rows: [
      { label: 'Latency', value: fmtLatency(input.systemData?.feedLatencyMs) ?? DASH },
      { label: 'State', value: String(brokerWsState || '—') },
      { label: 'Subscriptions', value: fmtCount(subs) },
      { label: 'Ticks received', value: fmtCount(ticks) },
      { label: 'Last tick', value: fmtISTClock(lastTick) },
      { label: 'Last message', value: fmtISTClock(lastMsg) },
      { label: 'Connected since', value: fmtISTClock(connAt) },
      { label: 'Reconnects', value: fmtCount(reconnects) },
      ...(tl.wsStartAtMs ? [{ label: 'Scheduled connect', value: `${fmtISTClock(tl.wsStartAtMs)}${tl.wsStartTime ? ` (${tl.wsStartTime})` : ''}` }] : []),
      ...(tl.wsStopAtMs ? [{ label: 'Scheduled disconnect', value: `${fmtISTClock(tl.wsStopAtMs)}${tl.wsStopTime ? ` (${tl.wsStopTime})` : ''}` }] : []),
      ...(reason ? [{ label: 'Disconnect reason', value: String(reason) }] : []),
    ],
  };
}

function deriveDatabase(input: StatusInput): StatusEntry {
  const { dbRec, systemData } = input;
  const conn = dbRec?.connected ?? systemData?.mongo?.connected;
  const level: PillLevel = conn === true ? 'healthy' : conn === false ? 'error' : 'unknown';
  const ping = input.systemData?.mongoPingMs ?? undefined;
  return {
    id: 'db',
    label: 'Database',
    short: 'DB',
    icon: 'database',
    level,
    state: conn === true ? 'ONLINE' : conn === false ? 'DOWN' : 'UNKNOWN',
    detail: conn === true ? 'Connected' : conn === false ? 'Unavailable' : 'Not verified',
    rows: [
      { label: 'Status', value: conn === true ? 'Connected' : conn === false ? 'Unavailable' : DASH },
      { label: 'Checked at', value: fmtISTClock(dbRec?.checkedAt) },
      { label: 'Ping', value: fmtLatency(ping) ?? DASH },
      { label: 'Source', value: 'Backend database health' },
    ],
  };
}

function deriveScheduler(input: StatusInput, tl: SchedulerTimeline): StatusEntry {
  const { schedulerRec, hydrated } = input;
  const running = schedulerRec?.running;
  const state = String(schedulerRec?.state ?? 'UNKNOWN');
  const stateClean = state.toUpperCase();
  const transitional =
    stateClean.includes('START') || stateClean.includes('INIT') || stateClean.includes('RECONCIL') ||
    stateClean.includes('LOADING') || stateClean.includes('WARMING') || stateClean.includes('WAKING');
  const marketClosed = stateClean.includes('MARKET_CLOSED') || stateClean.includes('STOPPED');

  /*
   * The engine process is genuinely `running: true` after the trading day ends
   * (observed live at 23:59 IST: state `WAITING_FOR_NEXT_TRADING_DAY`,
   * running `true`). Painting that healthy-green reads as "actively trading" to
   * a user at midnight, so an idle-by-design state is reported NEUTRAL and the
   * real state string is surfaced instead of the generic word RUNNING.
   */
  const idleByDesign = IDLE_BY_DESIGN.some((s) => stateClean.includes(s));

  let level: PillLevel;
  if (!hydrated) level = 'warning'; // real check in progress — amber
  else if (idleByDesign) level = 'neutral';
  else if (running === true) level = 'healthy';
  else if (running === false) level = 'error';
  else if (transitional) level = 'warning';
  else level = 'unknown';

  const nowMs = input.nowMs ?? null;
  // "What happens next" for the WHOLE scheduler: the phase machine first (it
  // covers square_off 15:16 + feed_stop 15:30, which next_event omits).
  const next = nextSchedulerAction(tl, nowMs);

  return {
    id: 'sched',
    label: 'Scheduler',
    short: 'SCHED',
    icon: 'calendarClock',
    level,
    state: !hydrated
      ? 'CHECKING'
      : idleByDesign
        ? stateClean
        : running === true
          ? 'RUNNING'
          : running === false
            ? (marketClosed ? (stateClean || 'STOPPED') : 'STOPPED')
            : stateClean || 'UNKNOWN',
    detail: idleByDesign
      ? 'Trading day over — idle until the next session'
      : running === true
        ? `State: ${stateClean}`
        : running === false
          ? (level === 'neutral' ? 'Market closed' : 'Stopped')
          : level === 'warning'
            ? 'Starting…'
            : 'Not verified',
    next: next ?? undefined,
    // The complementary boundary, so hovering SCHEDULER answers both "when does
    // it log in" and "when does it log out" without a second lookup.
    after:
      next?.key === 'login'
        ? mkNext('logout', EVENT_LABELS, tl.logoutAtMs, null, nowMs) ?? undefined
        : next?.key === 'logout'
          ? mkNext('login', EVENT_LABELS, tl.loginAtMs, null, nowMs) ?? undefined
          : undefined,
    rows: [
      { label: 'State', value: String(schedulerRec?.state ?? DASH) },
      { label: 'Running', value: running == null ? DASH : running ? 'Yes' : 'No' },
      ...(tl.phase ? [{ label: 'Phase', value: `${PHASE_LABELS[tl.phase] ?? tl.phase.replace(/_/g, ' ')}` }] : []),
      ...(tl.sessionOwner ? [{ label: 'Session owner', value: tl.sessionOwner.toUpperCase() }] : []),
      // Real plan rows. The backend publishes ABSOLUTE ISO instants for these;
      // the previous `info.nextRunAt ?? info.schedule.next_event` chain resolved
      // to an event NAME and rendered it as a timestamp, which is why the
      // "Next run" row was previously meaningless.
      ...(tl.nextPhaseAtMs ? [{ label: 'Next phase', value: `${PHASE_LABELS[tl.nextPhase ?? ''] ?? tl.nextPhase} · ${fmtISTClock(tl.nextPhaseAtMs)}` }] : []),
      ...(tl.loginAtMs ? [{ label: 'Next login', value: `${fmtISTClock(tl.loginAtMs)}${tl.loginTime ? ` (${tl.loginTime})` : ''}` }] : []),
      ...(tl.wsStartAtMs ? [{ label: 'WS connect', value: `${fmtISTClock(tl.wsStartAtMs)}${tl.wsStartTime ? ` (${tl.wsStartTime})` : ''}` }] : []),
      ...(tl.tickCollectionAtMs ? [{ label: 'Tick collection', value: fmtISTClock(tl.tickCollectionAtMs) }] : []),
      ...(tl.wsStopAtMs ? [{ label: 'WS disconnect', value: `${fmtISTClock(tl.wsStopAtMs)}${tl.wsStopTime ? ` (${tl.wsStopTime})` : ''}` }] : []),
      ...(tl.logoutAtMs ? [{ label: 'Next logout', value: `${fmtISTClock(tl.logoutAtMs)}${tl.logoutTime ? ` (${tl.logoutTime})` : ''}` }] : []),
      ...(tl.isTradingDay != null ? [{ label: 'Trading day', value: tl.isTradingDay ? 'Yes' : 'No' }] : []),
      ...(tl.marketSession ? [{ label: 'Market session', value: tl.marketSession.replace(/_/g, ' ') }] : []),
      ...(tl.timezone ? [{ label: 'Timezone', value: tl.timezone }] : []),
    ],
  };
}

function deriveSession(input: StatusInput, tl: SchedulerTimeline): StatusEntry {
  const { hydrated, sessionActive, sessionStatus, sessionRec } = input;
  const rawStatus = String(sessionRec?.status ?? sessionStatus ?? 'UNKNOWN').toUpperCase();
  const canonical = canonicalSessionState(rawStatus);
  const broker = sessionRec?.broker;
  const loginSource = String(sessionRec?.loginSource ?? '').toUpperCase();
  const sessionId = String(sessionRec?.sessionId ?? '');
  const loginAt = sessionRec?.loginTime;
  const expiresAt = sessionRec?.expiresAt;
  const validatedAt = sessionRec?.validatedAt;
  const stateMessage = sessionRec?.stateMessage;
  const lastError = sessionRec?.lastRestError ?? sessionRec?.lastAuthError ?? stateMessage;
  const remaining = sessionRec?.remainingSeconds;
  const duration = sessionRec?.sessionDurationSeconds;
  const wsState = String(sessionRec?.websocket?.state ?? '');

  let level: PillLevel;
  let state: string;
  if (!hydrated) {
    level = 'warning'; // real check in progress — amber
    state = 'CHECKING';
  } else if (sessionActive === true) {
    level = 'healthy';
    state = 'ACTIVE';
  } else if (canonical === 'ACTIVE' || canonical === 'AUTHENTICATING') {
    level = 'warning';
    state = canonical;
  } else if (canonical === 'UNKNOWN') {
    level = 'unknown'; // genuinely undeterminable — gray
    state = 'UNKNOWN';
  } else {
    level = 'error'; // INACTIVE / EXPIRED / LOGGED_OUT / ERROR — red
    state = canonical;
  }

  const nowMs = input.nowMs ?? null;
  const sessRec = sessionRec ?? {};
  // When this session ends (real expiry), or when the next one is scheduled.
  const next = nextSessionAction(sessRec, tl, nowMs);
  // The complementary plan line, so a hover always answers BOTH questions.
  const after =
    sessionActive === true
      ? mkNext('login', EVENT_LABELS, tl.loginAtMs, null, nowMs) ?? undefined
      : mkNext('logout', EVENT_LABELS, tl.logoutAtMs, null, nowMs) ?? undefined;

  return {
    id: 'sess',
    label: 'Session',
    short: 'SESS',
    icon: 'user',
    level,
    state,
    detail: level === 'healthy' ? `Broker: ${String(broker ?? '—')}` : level === 'unknown' ? 'Not verified' : level === 'warning' ? (state === 'AUTHENTICATING' ? 'Signing in…' : 'No active session') : (lastError ? String(lastError) : 'No active session'),
    next: next ?? undefined,
    after,
    rows: [
      ...(broker ? [{ label: 'Broker', value: String(broker) }] : []),
      ...(loginSource ? [{ label: 'Source', value: loginSource === 'SCHEDULER' ? 'SCHEDULER' : 'MANUAL' }] : []),
      ...(sessionId ? [{ label: 'Session id', value: maskSession(sessionId) }] : []),
      { label: 'State', value: String(sessRec.status ?? sessionStatus ?? DASH) },
      ...(String(sessRec.lifecycleState || '') ? [{ label: 'Lifecycle', value: String(sessRec.lifecycleState) }] : []),
      ...(String(sessRec.stateMessage || '') ? [{ label: 'Detail', value: String(sessRec.stateMessage) }] : []),
      { label: 'Login time', value: fmtISTClock(loginAt) },
      { label: 'Validated at', value: fmtISTClock(validatedAt) },
      { label: 'Expires at', value: fmtISTClock(expiresAt) },
      ...(remaining != null ? [{ label: 'Remaining', value: fmtSeconds(Number(remaining)) }] : []),
      // A null sessionDurationSeconds is the backend's honest "scheduler-owned
      // session, no fixed lifetime" marker — surfaced rather than hidden.
      ...(duration != null ? [{ label: 'Session lifetime', value: fmtSeconds(Number(duration)) }] : []),
      ...(wsState ? [{ label: 'Broker feed', value: wsState }] : []),
      ...(tl.loginAtMs && sessionActive !== true ? [{ label: 'Next scheduled login', value: `${fmtISTClock(tl.loginAtMs)}${tl.loginTime ? ` (${tl.loginTime})` : ''}` }] : []),
      ...(tl.logoutAtMs ? [{ label: 'Scheduled logout', value: `${fmtISTClock(tl.logoutAtMs)}${tl.logoutTime ? ` (${tl.logoutTime})` : ''}` }] : []),
      ...(lastError ? [{ label: 'Last error', value: String(lastError) }] : []),
    ],
  };
}

function deriveMarket(input: StatusInput): StatusEntry {
  const { marketRec, hydrated } = input;
  const status = String(marketRec?.market_status ?? '').toUpperCase();
  const dayClass = String(marketRec?.day_class ?? '').toUpperCase();
  const nextOpen = marketRec?.next_market_open;
  const nextClose = marketRec?.next_market_close;
  const tradingDay = marketRec?.trading_day;
  const isWeekend = Boolean(marketRec?.is_weekend) || dayClass === 'WEEKEND';
  const isHoliday = Boolean(marketRec?.is_exchange_holiday) || dayClass === 'EXCHANGE_HOLIDAY';

  let level: PillLevel;
  if (status === 'OPEN' || status === 'MARKET_OPEN') level = 'healthy';
  else if (status === 'PRE_OPEN' || status === 'PRE_MARKET' || status === 'ARMED') level = 'warning';
  else if (status === 'CLOSED' || status === 'MARKET_CLOSED' || isWeekend || isHoliday) level = 'neutral';
  else if (hydrated && marketRec) level = 'neutral';
  else level = 'unknown';

  let state: string;
  if (status) state = status;
  else if (isHoliday) state = 'HOLIDAY';
  else if (isWeekend) state = 'WEEKEND';
  else if (marketRec) state = 'CLOSED';
  else state = 'UNKNOWN';

  const hint =
    level === 'healthy'
      ? (fmtHMS(nextClose) ? `closes ${fmtHMS(nextClose)}` : undefined)
      : (fmtHMS(nextOpen) ? `opens ${fmtHMS(nextOpen)}` : undefined);

  return {
    id: 'market',
    label: 'Market',
    short: 'MKT',
    icon: 'landmark',
    level,
    state,
    hint,
    detail: level === 'healthy' ? 'Market open' : level === 'warning' ? 'Pre-market' : isHoliday ? 'Exchange holiday' : isWeekend ? 'Weekend' : 'Market closed',
    rows: [
      { label: 'State', value: String(marketRec?.market_status ?? DASH) },
      { label: 'Trading day', value: tradingDay == null ? DASH : tradingDay ? 'Yes' : 'No' },
      ...(String(marketRec?.closure_reason ?? '') ? [{ label: 'Reason', value: String(marketRec?.closure_reason ?? '') }] : []),
      { label: 'Next open', value: fmtISTClock(nextOpen) },
      { label: 'Next close', value: fmtISTClock(nextClose) },
      { label: 'Trading date', value: String(marketRec?.market_date ?? DASH) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Extra indicator derives (page-context clusters)
// ---------------------------------------------------------------------------

export type CanonicalSessionState =
  | 'UNKNOWN'
  | 'INACTIVE'
  | 'AUTHENTICATING'
  | 'ACTIVE'
  | 'EXPIRING'
  | 'EXPIRED'
  | 'LOGGED_OUT'
  | 'ERROR';

/** Map any real backend session status onto the canonical topbar vocabulary.
 *  Honest: uncounted/missing statuses resolve to INACTIVE or UNKNOWN, never to
 *  ACTIVE. */
export function canonicalSessionState(status: unknown): CanonicalSessionState {
  const s = String(status ?? '').toUpperCase();
  if (!s || s === 'UNKNOWN' || s === 'NONE' || s === 'NULL') return 'UNKNOWN';
  if (s.includes('EXPIRED') || s.includes('EXPIRING') || s.includes('SESSION_EXPIRED')) return 'EXPIRED';
  // Order matters: the "not authenticated" family is checked BEFORE the
  // AUTHENTICAT substring rule below, because NOT_AUTHENTICATED /
  // UNAUTHENTICATED both CONTAIN "AUTHENTICAT". Testing them after made this
  // branch unreachable, and a status that means "log in" was reported as a
  // login in progress — which hides the [Manual Login] action the user needs.
  if (s.includes('AUTH_REQUIRED') || s.includes('NOT_AUTHENTICATED') || s.includes('UNAUTHENTICATED')) {
    return 'INACTIVE';
  }
  if (s.includes('AUTHENTICAT') || s.includes('CONNECTING') || s.includes('LOGGING')) {
    return 'AUTHENTICATING';
  }
  if (s.includes('ACTIVE') || s === 'SESSION_ACTIVE' || s === 'WS_ACTIVE') return 'ACTIVE';
  if (s.includes('LOGGED_OUT') || s.includes('LOGOUT')) return 'LOGGED_OUT';
  if (s.includes('ERROR') || s.includes('FAILED')) return 'ERROR';
  return 'INACTIVE';
}

/** True when the canonical session state is one that warrants a [Manual Login]
 *  action: inactive / logged out / expired / error. Never true for ACTIVE,
 *  AUTHENTICATING, EXPIRING, or an undetermined UNKNOWN. */
export function isManualLoginState(canonical: CanonicalSessionState): boolean {
  return canonical === 'INACTIVE' || canonical === 'LOGGED_OUT' || canonical === 'EXPIRED' || canonical === 'ERROR';
}

/**
 * The backend-declared broker from the existing /api/system poll
 * (`schedulerInfo.enabled_brokers`, e.g. `["kotak"]` observed live).
 *
 * Returns the broker id only when exactly ONE unambiguous entry exists —
 * zero means "no broker served", several means "ambiguous, don't guess".
 * Either way the caller falls back to another source instead of inventing one.
 */
export function systemPollBroker(systemData: Record<string, any> | null | undefined): string | null {
  const list = (systemData as any)?.schedulerInfo?.enabled_brokers;
  if (!Array.isArray(list) || list.length !== 1) return null;
  const s = String(list[0] ?? '').trim().toLowerCase();
  return s === 'kotak' || s === 'shoonya' || s === 'dummy' ? s : null;
}

/**
 * True when the /api/system poll shows ANY live broker session
 * (`schedulerInfo.brokers.*.session.active === true`).
 *
 * Used ONLY as a fallback while the realtime snapshot has not arrived: it lets
 * the topbar hide the Manual Login button when a session is already live
 * instead of offering a login nobody needs. Never used to claim ACTIVE — an
 * absent `brokers` block simply yields false and the realtime path decides.
 */
export function systemPollSessionActive(systemData: Record<string, any> | null | undefined): boolean {
  const brokers = (systemData as any)?.schedulerInfo?.brokers;
  if (brokers == null || typeof brokers !== 'object') return false;
  return Object.values(brokers).some(
    (b) => (b as any)?.session?.active === true,
  );
}

/** Mask a broker user id for the session popover ("AU12••34"). */
export function maskUser(user: unknown): string {
  const id = String(user ?? '');
  if (!id) return DASH;
  if (id.length <= 4) return '••••';
  return `${id.slice(0, 2)}••${id.slice(-2)}`;
}

/** Mask an internal session id for the session popover ("ses_ab••ff"). */
export function maskSession(id: unknown): string {
  const s = String(id ?? '');
  if (!s) return DASH;
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 6)}••${s.slice(-2)}`;
}

/** Percent with one decimal; '—' for missing. */
export function fmtPercent(n: unknown): string {
  const num = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN;
  if (!Number.isFinite(num)) return DASH;
  return `${num.toFixed(1)}%`;
}

/** Backend /api/system reachability (SystemProvider poll outcome). */
export function deriveApiEntry(
  state: 'loading' | 'ok' | 'error',
  data: Record<string, any> | null,
): StatusEntry {
  const level: PillLevel = state === 'ok' ? 'healthy' : state === 'error' ? 'error' : 'unknown';
  return {
    id: 'api',
    label: 'API',
    short: 'API',
    icon: 'activity',
    level,
    state: level === 'healthy' ? 'ONLINE' : level === 'error' ? 'DOWN' : 'CHECKING',
    detail:
      level === 'healthy'
        ? `Backend reachable · ${String(data?.python?.version ?? '')}`
        : level === 'error'
          ? 'Backend unreachable'
          : 'Not verified',
    rows: [
      { label: 'Status', value: level === 'healthy' ? 'OK' : level === 'error' ? 'Unreachable' : DASH },
      { label: 'Python', value: String(data?.python?.version ?? DASH) },
      { label: 'SDK loaded', value: data?.python?.sdk_loaded == null ? DASH : data.python.sdk_loaded ? 'Yes' : 'No' },
      { label: 'Instrument count', value: fmtCount(data?.instrumentCount ?? data?.instrumentCache?.instrument_count) },
    ],
  };
}

/** Broker feed health + live rates from the supervisor live frame. */
export function deriveFeedEntry(hydrated: boolean, wsRec: Record<string, any> | null): StatusEntry {
  const live = (wsRec?.live ?? {}) as Record<string, any>;
  const feedState = String(live.feedState ?? '').toUpperCase();
  const rates = (live.rates ?? {}) as Record<string, any>;
  const ticksPerSec = Number(rates.ticks_per_second ?? NaN);
  const msgsPerSec = Number(rates.messages_per_second ?? NaN);
  const liveTicks = live.ticksReceived != null ? Number(live.ticksReceived) : NaN;

  let level: PillLevel;
  if (!hydrated && wsRec == null && !feedState) level = 'unknown';
  else if (feedState === 'LIVE' || ticksPerSec > 0 || msgsPerSec > 0) level = 'healthy';
  else if (feedState === 'STALE' || feedState === 'DEGRADED') level = 'warning';
  else if (hydrated && feedState) level = 'neutral';
  else level = 'unknown';

  const state = !hydrated && !feedState ? 'UNKNOWN' : feedState || (ticksPerSec > 0 || msgsPerSec > 0 ? 'LIVE' : 'UNKNOWN');
  return {
    id: 'feed',
    label: 'Feed',
    short: 'FEED',
    icon: 'gauge',
    level,
    state: state || 'NO_FEED',
    detail:
      level === 'healthy'
        ? `${fmtValue(isFiniteValue(ticksPerSec) ? ticksPerSec : liveTicks, 'ticks/s')} · ${fmtCount(msgsPerSec)} msgs/s`
        : level === 'warning'
          ? 'Feed degraded'
          : feedState
            ? String(feedState)
            : 'No feed',
    rows: [
      { label: 'Feed state', value: feedState || DASH },
      { label: 'Ticks / sec', value: fmtCount(isFiniteValue(ticksPerSec) ? ticksPerSec : DASH) },
      { label: 'Messages / sec', value: fmtCount(isFiniteValue(msgsPerSec) ? msgsPerSec : DASH) },
      { label: 'Ticks received', value: fmtCount(live.ticksReceived) },
      { label: 'Last tick', value: fmtISTClock(live.lastTickAt) },
      ...(live.feedStateSince ? [{ label: 'Feed state since', value: fmtISTClock(live.feedStateSince) }] : []),
    ],
  };
}

/** Tick-persistence pipeline state (from the /api/system buffer record). */
export function derivePipelineEntry(
  systemData: Record<string, any> | null,
  wsRec: Record<string, any> | null,
): StatusEntry {
  const buffer = systemData?.buffer ?? {};
  const pipelineRec = (wsRec?.pipeline ?? {}) as Record<string, any>;
  const running = pipelineRec.connected ?? buffer.pipelineRunning;
  const lastWriteAt = buffer.lastWriteAt ?? pipelineRec.lastWriteAt;
  const writesPerSec = Number(buffer.writesPerSecond ?? NaN);
  const error = buffer.lastError ?? buffer.lastFailedWriteAt;

  let level: PillLevel;
  if (running == null && !lastWriteAt) level = 'unknown';
  else if (running === false) level = 'error';
  else if (running === true || lastWriteAt) level = 'healthy';
  else level = 'unknown';

  return {
    id: 'pipeline',
    label: 'Pipeline',
    short: 'PIPE',
    icon: 'layers',
    level,
    state: running === false ? 'STOPPED' : running === true || lastWriteAt ? 'RUNNING' : 'UNKNOWN',
    detail: running === false ? 'Persistence stopped' : lastWriteAt ? `Last write ${fmtAgo(lastWriteAt)}` : 'No writes yet',
    rows: [
      { label: 'Running', value: running == null ? DASH : running ? 'Yes' : 'No' },
      { label: 'Writes / sec', value: fmtCount(isFiniteValue(writesPerSec) ? writesPerSec : DASH) },
      { label: 'Last write', value: fmtISTClock(lastWriteAt) },
      { label: 'Last flush', value: fmtISTClock(buffer.lastFlushAt) },
      ...(buffer.lastFlushDurationMs != null ? [{ label: 'Last flush ms', value: fmtCount(buffer.lastFlushDurationMs) }] : []),
      ...(error ? [{ label: 'Last error', value: String(error) }] : []),
      { label: 'Buffer used', value: `${fmtCount(buffer.bufferLength ?? DASH)} / ${fmtCount(buffer.bufferMaxSize ?? DASH)}` },
    ],
  };
}

/** Node CPU load (real /api/system node record). */
export function deriveCpuEntry(data: Record<string, any> | null): StatusEntry {
  const node = data?.node ?? {};
  const pct = Number(node.cpuPercent ?? NaN);
  const load = Number(node.cpuLoad1m ?? NaN);
  const level: PillLevel = data == null ? 'unknown' : !isFiniteValue(pct) || pct > 80 ? 'warning' : 'healthy';
  return {
    id: 'cpu',
    label: 'CPU',
    short: 'CPU',
    icon: 'chip',
    level,
    state: level === 'unknown' ? 'UNKNOWN' : `${fmtCount(pct)}%`,
    detail: level === 'unknown' ? 'Not measured' : isFiniteValue(pct) ? `Load: ${fmtCount(pct)}%` : 'Idle',
    rows: [
      { label: 'CPU %', value: fmtPercent(pct) },
      { label: 'Load 1m', value: fmtCount(load) },
      { label: 'Load 15m', value: fmtCount(node.cpuLoad15m ?? DASH) },
      { label: 'Source', value: 'Node process stats' },
    ],
  };
}

/** Node RAM (and disk, in the diagnostics) from the real /api/system record. */
export function deriveMemEntry(data: Record<string, any> | null): StatusEntry {
  const node = data?.node ?? {};
  const ram = Number(node.ramPercent ?? NaN);
  const level: PillLevel = data == null ? 'unknown' : !isFiniteValue(ram) || ram > 80 ? 'warning' : 'healthy';
  return {
    id: 'mem',
    label: 'Memory',
    short: 'MEM',
    icon: 'memoryStick',
    level,
    state: level === 'unknown' ? 'UNKNOWN' : `${fmtCount(ram)}%`,
    detail: level === 'unknown' ? 'Not measured' : isFiniteValue(ram) ? 'Node RAM' : 'Idle',
    rows: [
      { label: 'RAM used', value: fmtPercent(ram) },
      { label: 'RSS', value: `${fmtCount(node.memory?.rssMb ?? DASH)} MB` },
      { label: 'Disk used', value: fmtPercent(node.diskPercent) },
      { label: 'Disk total', value: fmtGigabytes(node.diskTotalBytes) },
    ],
  };
}

/** Open-order count from the real backend (/api/system totals). */
export function deriveOrdersEntry(data: Record<string, any> | null): StatusEntry {
  const total = data?.totalOrders;
  const has = typeof total === 'number' && Number.isFinite(total);
  const level: PillLevel = data == null ? 'unknown' : has ? 'healthy' : 'unknown';
  return {
    id: 'orders',
    label: 'Orders',
    short: 'ORD',
    icon: 'receiptText',
    level,
    state: has ? `${fmtCount(total)} OPEN` : 'UNKNOWN',
    detail: has ? `${fmtCount(total)} open order${total === 1 ? '' : 's'}` : 'Order count not available',
    rows: [
      { label: 'Open orders', value: has ? fmtCount(total) : DASH },
      { label: 'Total positions', value: fmtCount(data?.totalPositions) },
      { label: 'Holdings', value: fmtCount(data?.holdingsCount) },
      { label: 'Source', value: 'Backend trading totals' },
    ],
  };
}

function isFiniteValue(n: number): boolean {
  return Number.isFinite(n);
}

function fmtGigabytes(bytes: unknown): string {
  const num = typeof bytes === 'number' ? bytes : typeof bytes === 'string' ? Number(bytes) : NaN;
  if (!Number.isFinite(num) || num <= 0) return DASH;
  return `${(num / 1024 ** 3).toFixed(1)} GB`;
}

function fmtValue(v: unknown, unit: string): string {
  const c = fmtCount(v);
  return c === DASH ? DASH : `${c} ${unit}`;
}

export function fmtSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return DASH;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** Live session countdown text — "59:42". Minutes fold into an unbounded mm
 *  (so a full one-hour session renders "60:00", never a negative or zero-padded
 *  rollover). Always ≥ 0; floors at 0. */
export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/** The ONE central session expiry anchor — an absolute epoch-ms instant the
 *  frontend countdown ticks down to. Backend-authoritative only:
 *
 *  • Not hydrated → null (real check still in progress).
 *  • Not ACTIVE → null (logged out / expired / error — never count down).
 *  • Backend `expiresAt` present → that absolute instant (survives refresh;
 *    the browser never resets it to 60:00).
 *  • Only fallback (no expiresAt yet): seed from the backend
 *    `remainingSeconds`, itself a wall-clock derivation on the server.
 */
export function sessionExpiryAnchor(input: {
  hydrated: boolean;
  active: boolean | 'UNKNOWN';
  expiresAt: number | null;
  remainingSeconds: number | null;
  now: number;
}): number | null {
  if (!input.hydrated || input.active !== true) return null;
  if (input.expiresAt != null) return input.expiresAt;
  if (typeof input.remainingSeconds === 'number' && input.remainingSeconds > 0) {
    return input.now + input.remainingSeconds * 1000;
  }
  return null;
}

/** Summary for the System Health control. */
export function summarize(entries: StatusEntry[]): { level: PillLevel; label: string; degraded: number } {
  const degraded = entries.filter((e) => e.level === 'error' || e.level === 'offline' || e.level === 'warning').length;
  if (!entries.length) return { level: 'unknown', label: 'Unknown', degraded: 0 };
  const hasError = entries.some((e) => e.level === 'error' || e.level === 'offline');
  const hasWarning = entries.some((e) => e.level === 'warning');
  return {
    level: hasError ? 'error' : hasWarning ? 'warning' : 'healthy',
    label: hasError ? `${degraded} issue${degraded === 1 ? '' : 's'}` : hasWarning ? `${degraded} degraded` : 'Healthy',
    degraded,
  };
}

/** Semantic styling tokens for a level (UI layer, pure mapping for testability).
 *  `card` tints the WHOLE indicator card (border + background) so color is the
 *  primary state signal on the topbar, not just the dot. */
export function levelTone(level: PillLevel): {
  dot: string;
  text: string;
  bg: string;
  ring: string;
  glint: string;
  card: string;
} {
  switch (level) {
    case 'healthy':
      return { dot: 'bg-success', text: 'text-success', bg: 'bg-success/10', ring: 'border-success/25', glint: 'from-success/15', card: 'border-success/25 bg-success/[0.06]' };
    case 'warning':
      return { dot: 'bg-warning', text: 'text-warning', bg: 'bg-warning/10', ring: 'border-warning/25', glint: 'from-warning/15', card: 'border-warning/30 bg-warning/[0.07]' };
    case 'error':
      return { dot: 'bg-destructive', text: 'text-destructive', bg: 'bg-destructive/10', ring: 'border-destructive/25', glint: 'from-destructive/15', card: 'border-destructive/30 bg-destructive/[0.07]' };
    case 'offline':
      return { dot: 'bg-muted-foreground', text: 'text-muted-foreground', bg: 'bg-muted/60', ring: 'border-muted/30', glint: 'from-muted', card: 'border-muted bg-muted/50' };
    case 'info':
      return { dot: 'bg-info', text: 'text-info', bg: 'bg-info/10', ring: 'border-info/25', glint: 'from-info/15', card: 'border-info/25 bg-info/5' };
    case 'neutral':
      return { dot: 'bg-muted-foreground', text: 'text-muted-foreground', bg: 'bg-muted/40', ring: 'border-muted/30', glint: 'from-muted', card: 'border-muted/60 bg-muted/30' };
    default:
      return { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground', bg: 'bg-muted/40', ring: 'border-muted/30', glint: 'from-muted', card: 'border-muted/50 bg-muted/20' };
  }
}