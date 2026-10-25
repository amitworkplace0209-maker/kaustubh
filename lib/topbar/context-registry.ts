// Pure, testable context registry for the ONE shared GlobalTopBar.
//
// One visual shell, but the topbar content (indicators, actions, terminal
// session control, breadcrumb) is driven by Phase → Page → Terminal configs.
// Page content is defined in ONE place here (never per-page topbar JSX), and
// every action listed below maps to a REAL backend capability.
//
// This module is import-free (no lucide / react) so it stays unit-testable in
// node. ShellConfig objects are passed in at runtime.

import type { ShellConfig, TerminalMode } from '@/components/layout/nav';

// ---------------------------------------------------------------------------
// Indicator / action ids
// ---------------------------------------------------------------------------

export type TopbarIndicatorId =
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

/** Page actions that have a REAL backend or navigation target. Nothing that
 *  needs per-page local state (e.g. tick-stream pause) is listed here. */
export type TopbarActionKind = 'refresh' | 'runScan' | 'markAllRead' | 'wsDiagnostics';

export interface TopbarIndicatorConfig {
  id: TopbarIndicatorId;
  /** Show in the compact md–xl cluster (true) or only full xl+ cluster (false). */
  compact: boolean;
}

export interface PageContextConfig {
  /** The registry nav-page id this context belongs to. */
  pageId: string;
  /** Accurate page title for the breadcrumb. */
  title: string;
  /** Ordered, deduped indicator cluster for this page. */
  indicators: TopbarIndicatorConfig[];
  /** Only genuinely-supported actions. */
  actions: TopbarActionKind[];
}

export interface TerminalContextConfig {
  terminal: TerminalMode;
  label: string;
  monogram: string;
  simulation: boolean;
  /** Kotak/shoonya have a real central broker session; dummy is isolated. */
  requiresLogin: boolean;
  loginEndpoint: string;
  logoutEndpoint: string;
}

export type TopbarPhase = 'data-saver' | 'trading' | 'services';

export interface ResolvedPageContext {
  phase: TopbarPhase;
  pageId: string;
  title: string;
  indicators: TopbarIndicatorId[];
  compact: Set<TopbarIndicatorId>;
  actions: TopbarActionKind[];
}

// ---------------------------------------------------------------------------
// Terminal contexts
// ---------------------------------------------------------------------------

const TERMINAL_CONTEXTS: Record<TerminalMode, TerminalContextConfig> = {
  dummy: {
    terminal: 'dummy',
    label: 'DUMMY',
    monogram: 'DM',
    simulation: true,
    requiresLogin: false,
    loginEndpoint: '/api/demo/login',
    logoutEndpoint: '/api/demo/logout',
  },
  'kotak-neo': {
    terminal: 'kotak-neo',
    label: 'KOTAK NEO',
    monogram: 'KN',
    simulation: false,
    requiresLogin: true,
    loginEndpoint: '/api/auth/manual-login',
    logoutEndpoint: '/api/auth/logout',
  },
  shoonya: {
    terminal: 'shoonya',
    label: 'SHOONYA',
    monogram: 'SH',
    simulation: false,
    requiresLogin: false,
    loginEndpoint: '/api/auth/login',
    logoutEndpoint: '/api/auth/logout',
  },
};

export function getTerminalContext(terminal: TerminalMode): TerminalContextConfig {
  return TERMINAL_CONTEXTS[terminal] ?? TERMINAL_CONTEXTS.dummy;
}

/**
 * Backend terminal ids the realtime snapshot and the /api/system poll publish
 * (`state.session.mode`, `state.terminal`, `schedulerInfo.enabled_brokers`).
 */
const BACKEND_TERMINAL_IDS = ['kotak', 'shoonya', 'dummy'] as const;

type BackendTerminalId = (typeof BACKEND_TERMINAL_IDS)[number];

function asBackendTerminalId(value: unknown): BackendTerminalId | null {
  const s = String(value ?? '').trim().toLowerCase();
  return (BACKEND_TERMINAL_IDS as readonly string[]).includes(s) ? (s as BackendTerminalId) : null;
}

function backendIdToMode(id: BackendTerminalId): TerminalMode {
  if (id === 'kotak') return 'kotak-neo';
  if (id === 'shoonya') return 'shoonya';
  return 'dummy';
}

/**
 * THE effective trading-terminal mode for the topbar's session control.
 *
 * Backend-authoritative, mirroring `TerminalModeReconciler`'s trust order:
 *
 *   1. `sessionMode`  — `state.session.mode`, the live canonical context the
 *      backend publishes on every context switch (even with no session words
 *      changed). Observed live as `""` when no mode was ever set — falls through.
 *   2. `snapshotTerminal` — `state.terminal`, the backend's active terminal.
 *   3. `pollBroker` — the single entry of `schedulerInfo.enabled_brokers`
 *      from the existing /api/system poll, used while the SSE snapshot has not
 *      arrived yet. Null unless exactly one unambiguous broker.
 *   4. `uiMode` — the local settings-store choice, last resort only.
 *
 * Why backend-first: the reconciler pins the LOCAL mode to `dummy` whenever no
 * live broker session exists — which is precisely when the user needs the
 * Manual Login button. Resolving from the UI mode alone hides the button at
 * exactly the moment it is needed. The login endpoint itself switches the
 * backend terminal server-side when required, so offering the broker login here
 * never fabricates a session.
 */
export function resolveEffectiveTerminalMode(
  sessionMode: unknown,
  snapshotTerminal: unknown,
  pollBroker: unknown,
  uiMode: TerminalMode,
): TerminalMode {
  const backend =
    asBackendTerminalId(sessionMode)
    ?? asBackendTerminalId(snapshotTerminal)
    ?? asBackendTerminalId(pollBroker);
  if (backend) return backendIdToMode(backend);
  return uiMode === 'kotak-neo' || uiMode === 'shoonya' || uiMode === 'dummy' ? uiMode : 'dummy';
}

// ---------------------------------------------------------------------------
// Per-phase page contexts
// ---------------------------------------------------------------------------

const PAGE = (
  pageId: string,
  title: string,
  indicators: TopbarIndicatorConfig[],
  actions: TopbarActionKind[] = [],
): PageContextConfig => ({ pageId, title, indicators, actions });

const C = (id: TopbarIndicatorId): TopbarIndicatorConfig => ({ id, compact: true });
const T = (id: TopbarIndicatorId): TopbarIndicatorConfig => ({ id, compact: false });

/** DATA SAVER — real backend: system / market / websocket / db / scheduler /
 *  pipeline feed. Page families follow the actual /data-saver routes. */
const DATA_SAVER_PAGES: { route: string; page: PageContextConfig }[] = [
  { route: '/data-saver/dashboard', page: PAGE('dashboard', 'Dashboard', [C('net'), C('api'), C('market'), C('ws'), C('db'), T('sched'), T('pipeline'), T('feed'), T('sess')], ['refresh']) },
  { route: '/data-saver/analytics', page: PAGE('analytics', 'Tick Analytics', [C('net'), C('api'), C('feed'), C('ws'), T('pipeline'), T('db')], ['refresh']) },
  { route: '/data-saver/websocket', page: PAGE('websocket', 'WebSocket', [C('net'), C('api'), C('ws'), T('sched'), T('pipeline')], ['wsDiagnostics', 'refresh']) },
  { route: '/data-saver/quality', page: PAGE('quality', 'Data Quality', [C('net'), C('api'), C('db'), C('feed'), T('pipeline'), T('ws'), T('sched')], ['runScan', 'refresh']) },
  { route: '/data-saver/ticks', page: PAGE('ticks', 'Live Tick Table', [C('net'), C('api'), C('feed'), C('ws'), T('pipeline')], ['refresh']) },
  { route: '/data-saver/watch', page: PAGE('watch', 'Market Watch', [C('net'), C('api'), C('market'), C('ws'), T('feed')], ['refresh']) },
  { route: '/data-saver/watch-list', page: PAGE('watch-list', 'Watch List', [C('net'), C('api'), C('market'), C('ws')], ['refresh']) },
  { route: '/data-saver/downloads', page: PAGE('downloads', 'Downloads', [C('net'), C('api'), C('db'), T('sched')], []) },
  { route: '/data-saver/download-history', page: PAGE('download-history', 'Download History', [C('net'), C('api'), C('db')], []) },
  { route: '/data-saver/schedules', page: PAGE('schedules', 'Schedules', [C('net'), C('api'), C('sched'), C('db')], []) },
  { route: '/data-saver/formats', page: PAGE('formats', 'Formats & Fields', [C('net'), C('api'), C('db')], []) },
  { route: '/data-saver/subscription', page: PAGE('subscription', 'Stock Subscription', [C('net'), C('api'), C('market'), C('ws')], ['refresh']) },
  { route: '/data-saver/notifications', page: PAGE('notifications', 'Notifications', [C('net'), C('api'), C('db'), T('ws')], ['markAllRead']) },
  { route: '/data-saver/alerts', page: PAGE('alerts', 'Alerts', [C('net'), C('api'), C('db'), T('ws')], []) },
  { route: '/data-saver/configuration', page: PAGE('configuration', 'Configuration', [C('net'), C('api'), C('sched'), T('ws')], []) },
  { route: '/data-saver/settings', page: PAGE('settings', 'Settings', [C('net'), C('api'), C('sched'), T('ws')], []) },
  { route: '/data-saver/insights', page: PAGE('insights', 'Data Insights', [C('net'), C('api'), C('db'), T('feed')], []) },
];

/** SERVICES — api / websocket / database / scheduler / cpu / memory. No
 *  market, no broker session, no login on any services page. */
const SERVICES_PAGES: { route: string; page: PageContextConfig }[] = [
  { route: '/services/system', page: PAGE('system', 'System Status', [C('net'), C('api'), C('db'), C('ws'), T('sched'), T('cpu'), T('mem')], ['refresh', 'wsDiagnostics']) },
  { route: '/services/websocket-engine', page: PAGE('websocket-engine', 'WebSocket Engine', [C('net'), C('api'), C('ws'), T('sched'), T('pipeline')], ['refresh']) },
  { route: '/services/scheduler', page: PAGE('scheduler', 'Scheduler', [C('net'), C('api'), C('sched'), C('db'), T('ws')], ['refresh']) },
  { route: '/services/feature-engine', page: PAGE('feature-engine', 'Feature Engine', [C('net'), C('api'), C('feed'), T('pipeline')], ['refresh']) },
  { route: '/services/local-connect-engine', page: PAGE('local-connect-engine', 'Local Connect Engine', [C('net'), C('api')], ['refresh']) },
  { route: '/services/connection-manager', page: PAGE('connection-manager', 'Connection Manager', [C('net'), C('api'), C('ws'), T('feed')], ['refresh']) },
  { route: '/services/db-writer', page: PAGE('db-writer', 'DB Writer', [C('net'), C('api'), C('db'), T('pipeline')], ['refresh']) },
  { route: '/services/system-indicators', page: PAGE('system-indicators', 'System Indicators', [C('net'), C('api'), C('cpu'), C('mem'), T('db'), T('ws')], ['refresh']) },
  { route: '/services/notifications', page: PAGE('notifications', 'Notifications', [C('net'), C('api'), C('db'), T('ws')], ['markAllRead']) },
  { route: '/services/settings', page: PAGE('settings', 'Settings', [C('net'), C('api'), C('db'), T('ws')], ['refresh']) },
];

/** TRADING — every shell (kotak / shoonya / dummy). The broker session
 *  control ships with the phase; page clusters reflect live market + feed +
 *  open orders. Dummy strips the broker-session indicator (isolated). */
const TRADING_PAGES: { route: string; page: PageContextConfig }[] = [
  { route: '/trading/dashboard', page: PAGE('dashboard', 'Dashboard', [C('net'), C('market'), C('ws'), C('sess'), T('db'), T('sched'), T('orders')], ['refresh']) },
  { route: '/trading/market-watch', page: PAGE('market-watch', 'Market Watch', [C('net'), C('market'), C('ws'), C('sess'), T('feed'), T('orders')], ['refresh']) },
  { route: '/trading/watchlist', page: PAGE('watchlist', 'Watchlist', [C('net'), C('market'), C('ws'), C('sess'), T('orders')], ['refresh']) },
  { route: '/trading/trade', page: PAGE('trade', 'Trade', [C('net'), C('market'), C('ws'), C('sess'), T('orders')], []) },
  { route: '/trading/positions', page: PAGE('positions', 'Positions', [C('net'), C('market'), C('ws'), C('sess'), T('orders')], []) },
  { route: '/trading/holdings', page: PAGE('holdings', 'Holdings', [C('net'), C('market'), C('ws'), C('sess')], []) },
  { route: '/trading/portfolio', page: PAGE('portfolio', 'Portfolio', [C('net'), C('market'), C('ws'), C('sess')], []) },
  { route: '/trading/account', page: PAGE('account', 'Account', [C('net'), C('market'), C('ws'), C('sess')], []) },
  { route: '/trading/funds', page: PAGE('account', 'Account', [C('net'), C('market'), C('ws'), C('sess')], []) },
  { route: '/trading/order-history', page: PAGE('order-history', 'Order History', [C('net'), C('market'), C('ws'), C('sess'), T('orders')], []) },
  { route: '/trading/history', page: PAGE('order-history', 'Order History', [C('net'), C('market'), C('ws'), C('sess'), T('orders')], []) },
  { route: '/trading/notifications', page: PAGE('notifications', 'Notifications', [C('net'), C('api'), C('market'), C('ws')], ['markAllRead']) },
  { route: '/trading/settings', page: PAGE('settings', 'Settings', [C('net'), C('api'), C('db'), T('ws')], ['refresh']) },
  { route: '/trading/calculator', page: PAGE('calculator', 'Calculator', [C('net'), C('api'), C('market')], []) },
  { route: '/trading/calendar', page: PAGE('calendar', 'Calendar', [C('net'), C('api'), C('market')], []) },
  { route: '/trading/suggestion', page: PAGE('suggestion', 'Suggestion', [C('net'), C('market'), C('ws'), C('sess')], []) },
  { route: '/trading/audit', page: PAGE('audit', 'Audit Trail', [C('net'), C('api'), C('db')], []) },
];

const PHASE_DEFAULTS: Record<TopbarPhase, PageContextConfig> = {
  'data-saver': PAGE('dashboard', 'Dashboard', [C('net'), C('api'), C('market'), C('ws'), C('db'), T('sched'), T('pipeline'), T('feed'), T('sess')], ['refresh']),
  services: PAGE('system', 'System Status', [C('net'), C('api'), C('db'), C('ws'), T('sched'), T('cpu'), T('mem')], ['refresh']),
  trading: PAGE('dashboard', 'Dashboard', [C('net'), C('market'), C('ws'), C('sess'), T('db'), T('sched'), T('orders')], ['refresh']),
};

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export function getTopbarPhase(config: Pick<ShellConfig, 'id'>): TopbarPhase {
  const id = config.id;
  if (id.startsWith('trading')) return 'trading';
  if (id === 'data-saver') return 'data-saver';
  if (id === 'services') return 'services';
  return 'data-saver';
}

const PHASE_TABLES: Record<TopbarPhase, { route: string; page: PageContextConfig }[]> = {
  'data-saver': DATA_SAVER_PAGES,
  services: SERVICES_PAGES,
  trading: TRADING_PAGES,
};

export function findPageByPath(pages: { route: string; page: PageContextConfig }[], pathname: string): PageContextConfig | undefined {
  let best: PageContextConfig | undefined;
  let bestLen = -1;
  for (const row of pages) {
    if (pathname === row.route || pathname.startsWith(row.route + '/') || (row.route.endsWith('/*') && pathname.startsWith(row.route.slice(0, -2)))) {
      if (row.route.length > bestLen) {
        best = row.page;
        bestLen = row.route.length;
      }
    }
  }
  return best;
}

/** Resolve the page context for a phase + route. Trading is terminal-aware
 *  (dummy strips the broker-session indicator because it is isolated). */
export function resolvePageContext(
  config: Pick<ShellConfig, 'id'>,
  pathname: string,
  terminal?: TerminalMode,
): ResolvedPageContext {
  const phase = getTopbarPhase(config);
  const found = findPageByPath(PHASE_TABLES[phase], pathname);
  const page = found ?? PHASE_DEFAULTS[phase];

  let indicators = page.indicators.slice();
  if (phase === 'trading' && terminal === 'dummy') {
    indicators = indicators.filter((c) => c.id !== 'sess');
  }

  return {
    phase,
    pageId: page.pageId,
    title: page.title,
    indicators: indicators.map((c) => c.id),
    compact: new Set(indicators.filter((c) => c.compact).map((c) => c.id)),
    actions: page.actions,
  };
}

export function getPhaseLabel(phase: TopbarPhase): string {
  switch (phase) {
    case 'trading':
      return 'TRADING';
    case 'data-saver':
      return 'DATA SAVER';
    case 'services':
      return 'SERVICES';
  }
}

/** Resolve the accurate breadcrumb labels for the topbar header. */
export function getBreadcrumb(
  config: Pick<ShellConfig, 'id'>,
  pathname: string,
  terminal?: TerminalMode,
  fallbackTitle?: string,
): { phase: TopbarPhase; phaseLabel: string; title: string } {
  const page = resolvePageContext(config, pathname, terminal);
  return {
    phase: page.phase,
    phaseLabel: getPhaseLabel(page.phase),
    title: page.title ?? fallbackTitle ?? page.title,
  };
}

// ---------------------------------------------------------------------------
// Derived status links for a phase (config-driven, page-agnostic fallbacks)
// ---------------------------------------------------------------------------

export function buildStatusLinks(config: Pick<ShellConfig, 'statusLinks'>): Record<
  'internet' | 'websocket' | 'database' | 'scheduler' | 'session' | 'market' | 'api' | 'feed' | 'pipeline' | 'cpu' | 'mem' | 'orders',
  string
> {
  const s: Record<string, string | undefined> = config.statusLinks ?? {};
  const ws = s.websocket ?? '/services/websocket-engine';
  return {
    internet: s.internet ?? '/services/system-indicators',
    websocket: ws,
    database: s.database ?? '/services/system',
    scheduler: s.scheduler ?? '/services/system',
    session: s.session ?? '/trading/account',
    market: s.market ?? '/data-saver/dashboard',
    api: '/services/system',
    feed: ws,
    pipeline: ws,
    cpu: '/services/system',
    mem: '/services/system',
    orders: '/trading/positions',
  };
}

// ---------------------------------------------------------------------------
// Search ranking (context-aware)
// ---------------------------------------------------------------------------

export interface SearchCandidate {
  id: string;
  label: string;
  keywords: string[];
  phase: string;
}

/** Rank search results so the ACTIVE phase sorts first, then title matches,
 *  then keyword matches. Deterministic & testable. */
export function rankSearchResults<T extends SearchCandidate>(
  items: T[],
  query: string,
  activePhase?: string,
): T[] {
  return items
    .map((item, i) => {
      const q = query.toLowerCase();
      const label = item.label.toLowerCase();
      let score = 0;
      if (label === q) score += 100;
      else if (label.startsWith(q)) score += 80;
      else if (label.includes(q)) score += 60;
      if (item.keywords.some((k) => k.toLowerCase().includes(q))) score += 20;
      if (activePhase && item.phase === activePhase) score += 40;
      return { item, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}