import {
  LayoutDashboard,
  ShoppingCart,
  Briefcase,
  PieChart,
  Layers,
  User,
  History,
  Calculator as CalcIcon,
  BarChart3,
  Bell,
  Settings as SettingsIcon,
  Activity,
  Zap,
  TrendingUp,
  ScrollText,
  Shield,
  Boxes,
  Database,
  Cpu,
  Sparkles,
  BookOpen,
  Globe,
  Star,
  CalendarDays,
  ShieldAlert,
  Palette,
  CandlestickChart,
  Cable,
  HardDrive,
  Search,
  Clock4,
  RotateCcw,
  Building2,
  FileSearch,
  ListOrdered,
  Filter,
  Pin as PinIcon,
  CalendarClock,
  FileText,
} from 'lucide-react';
import { PHASE2_NAV } from '@/lib/phase2-nav';

export interface NavItem {
  id: string;
  href: string;
  label: string;
  icon: React.ElementType;
  /** Alternative search terms for the command palette (e.g. abbreviations). */
  keywords?: string[];
  /** Optional child pages rendered as a nested expandable section in the sidebar. */
  children?: NavItem[];
  /** Capability gate â€” future feature flags; undefined = always visible. */
  capability?: string;
  /** Static badge literal shown in the sidebar (e.g. 'NEW' | 'BETA'). */
  badge?: string;
  /** The KAUSTUBH phase this page belongs to (for the cross-phase search index). */
  phase?: ShellWorkspace;
  /** Show on mobile mini-views (More drawer / bottom tab). Default true. */
  mobileVisible?: boolean;
  order?: number;
  visible?: boolean;
  /** Optional live status key resolved to a real badge by the sidebar. */
  statusKey?: 'alert' | 'notification';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  id?: string;
  order?: number;
}

export interface ShellNav {
  label: string;
  groups: NavGroup[];
}

export type SessionMode = 'phase2-toggle' | 'kotak-dialog' | 'none';

export interface ShellConfig {
  id: string;
  wrapperClass: string;
  brand: string;
  tagline: string;
  monogram: string;
  version: string;
  nav: ShellNav;
  /** Primary page ids shown on the mobile/PWA bottom tab bar (max 4; falls
   *  back to the first group's first items when omitted). Registry-driven â€”
   *  never hardcoded in components. */
  mobilePrimary?: string[];
  statusEndpoints: string[];
  /** Where each topbar status indicator navigates when clicked. */
  statusLinks?: Partial<Record<'internet' | 'websocket' | 'database' | 'scheduler' | 'session', string>>;
  alertsRoute: string;
  /** Where the global Notifications bell navigates (per-phase page). */
  notificationsRoute: string;
  sessionMode: SessionMode;
  loginEndpoint: string;
  logoutEndpoint: string;
}

/* ---------------------------------------------------------------------------
 * Trading pages â€” the ONE canonical set of the four Trading sub-pages.
 *
 * "Trading" is a sidebar GROUP, never a page of its own: it has no route and
 * no standalone screen. Clicking the group row lands on Trade (the default
 * page) and the four pages are rendered as its nested rows:
 *
 *   Trading â”€â”¬â”€ Trade            /trading/trade
 *            â”œâ”€ Basket Orders    /trading/basket-orders
 *            â”œâ”€ Suggestion       /trading/suggestion
 *            â””â”€ History          /trading/history
 *
 * Every terminal shell (dummy / kotak-neo / shoonya / generic) shares this
 * exact list, so the sidebar can never drift between terminals.
 * -------------------------------------------------------------------------- */
export const TRADING_PAGES: NavItem[] = [
  { id: 'trading-trade', href: '/trading/trade', label: 'Trade', icon: Zap, keywords: ['buy', 'sell', 'place order', 'entry', 'orders'] },
  { id: 'trading-basket', href: '/trading/basket-orders', label: 'Basket Orders', icon: Boxes, keywords: ['basket', 'multi order', 'bundle'] },
  { id: 'trading-suggestion', href: '/trading/suggestion', label: 'Suggestion', icon: Sparkles, keywords: ['suggestion', 'recommendation', 'signal'] },
  { id: 'trading-history', href: '/trading/history', label: 'History', icon: History, keywords: ['history', 'executions', 'fills', 'audit'] },
];

/** The Trading group row. `href` is Trade â€” the group has no page of its own,
 *  so the row always resolves to the default (first) child page. */
const tradingGroup = (keywords?: string[]): NavItem => ({
  id: 'trading',
  href: TRADING_PAGES[0].href,
  label: 'Trading',
  icon: ShoppingCart,
  keywords: keywords ?? ['trade', 'basket', 'suggestion', 'history', 'buy', 'sell', 'orders'],
  children: TRADING_PAGES,
});

export const DATA_SAVER_SHELL: ShellConfig = {
  id: 'data-saver',
  wrapperClass: 'ws-phase2',
  brand: 'DATA SAVER',
  tagline: 'Data Saver',
  monogram: 'DS',
  version: 'DATA SAVER v1.0',
  nav: {
    label: 'DATA SAVER',
    groups: PHASE2_NAV.groups,
  },
  statusEndpoints: [
    '/api/phase2/websocket',
    '/api/phase2/alerts',
    '/api/phase2/system',
  ],
  statusLinks: {
    websocket: '/data-saver/websocket',
    database: '/data-saver/dashboard',
    scheduler: '/data-saver/schedules',
    session: '/data-saver/configuration',
    internet: '/services/system-indicators',
  },
  mobilePrimary: ['dashboard', 'subscription', 'ticks', 'downloads'],
  alertsRoute: '/data-saver/alerts',
  notificationsRoute: '/data-saver/notifications',
  sessionMode: 'phase2-toggle',
  loginEndpoint: '/api/phase2/login',
  logoutEndpoint: '/api/phase2/logout',
};

/** KOTAK NEO Trading Terminal â€” the real-broker trading terminal wired to the
 *  Kotak Neo SDK through the backend /api/trading + /api/terminal APIs. Every
 *  nav item maps to real data; the terminal renders honest empty/unavailable
 *  state whenever the broker cannot serve a value. No Calculator (it was a
 *  terminal-agnostic tool, not part of the Kotak registry). */
export const KOTAK_NEO_SHELL: ShellConfig = {
  id: 'trading-kotak',
  wrapperClass: 'ws-phase2',
  brand: 'KOTAK NEO TRADING TERMINAL',
  tagline: 'Kotak Neo',
  monogram: 'KN',
  version: 'KOTAK NEO TRADING TERMINAL v1.0',
  nav: {
    label: 'KOTAK NEO TRADING TERMINAL',
    groups: [
      {
        label: 'Main',
        items: [
          { id: 'dashboard', href: '/trading/dashboard', label: 'Dashboard', icon: LayoutDashboard, keywords: ['overview', 'home'] },
          { id: 'market-watch', href: '/trading/market-watch', label: 'Market Watch', icon: BarChart3, keywords: ['scanner', 'quotes', 'ltp'] },
          { id: 'watchlist', href: '/trading/watchlist', label: 'Watchlist', icon: Star, keywords: ['watch', 'favourites'] },
        ],
      },
      {
        label: 'Trading',
        items: [
          tradingGroup(),
          { id: 'positions', href: '/trading/positions', label: 'Positions', icon: Briefcase, keywords: ['open', 'pnl', 'live'] },
          { id: 'holdings', href: '/trading/holdings', label: 'Holdings', icon: PieChart },
          { id: 'portfolio', href: '/trading/portfolio', label: 'Portfolio', icon: Layers, keywords: ['p&l', 'summary'] },
          { id: 'account', href: '/trading/account', label: 'Account', icon: User },
        ],
      },
      {
        label: 'Analytics',
        items: [

          ],
      },
      {
        label: 'Utility',
        items: [
          { id: 'notifications', href: '/trading/notifications', label: 'Notifications', icon: Bell, statusKey: 'notification', keywords: ['alerts', 'bell'] },
        ],
      },
      {
        label: 'System',
        items: [
          { id: 'settings', href: '/trading/settings', label: 'Settings', icon: SettingsIcon, keywords: ['preferences', 'appearance'] },
          { id: 'theme', href: '/trading/theme', label: 'Theme', icon: Palette, keywords: ['appearance', 'dark', 'light', 'amoled', 'customize'] },
        ],
      },
    ],
  },
  statusEndpoints: [
    '/api/phase2/websocket',
    '/api/phase2/alerts',
    '/api/phase2/system',
  ],
  statusLinks: {
    websocket: '/trading/market-watch',
    database: '/trading/dashboard',
    scheduler: '/trading/dashboard',
    session: '/trading/account',
    internet: '/services/system-indicators',
  },
  mobilePrimary: ['dashboard', 'trading', 'positions', 'holdings'],
  alertsRoute: '/trading/notifications',
  notificationsRoute: '/trading/notifications',
  sessionMode: 'kotak-dialog',
  loginEndpoint: '/api/auth/manual-login',
  logoutEndpoint: '/api/auth/logout',
};

/** Generic trading terminal shell (legacy consumer for non-kotak workspaces);
 *  the kotak terminal uses its own KOTAK_NEO_SHELL above. */
export const TRADING_SHELL: ShellConfig = {
  id: 'trading',
  wrapperClass: 'ws-phase2',
  brand: 'TRADING TERMINAL',
  tagline: 'Trading',
  monogram: 'TT',
  version: 'TRADING TERMINAL v1.0',
  nav: {
    label: 'TRADING TERMINAL',
    groups: [
      {
        label: 'Main',
        items: [
          { id: 'dashboard', href: '/trading/dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { id: 'market-watch', href: '/trading/market-watch', label: 'Market Watch', icon: BarChart3 },
        ],
      },
      {
        label: 'Trading',
        items: [
          tradingGroup(),
          { id: 'positions', href: '/trading/positions', label: 'Positions', icon: Briefcase, keywords: ['open', 'pnl', 'live'] },
          { id: 'holdings', href: '/trading/holdings', label: 'Holdings', icon: PieChart },
          { id: 'portfolio', href: '/trading/portfolio', label: 'Portfolio', icon: Layers, keywords: ['p&l', 'summary'] },
          { id: 'account', href: '/trading/funds', label: 'Account', icon: User },
          { id: 'order-history', href: '/trading/order-history', label: 'Order History', icon: History },
          { id: 'calculator', href: '/trading/calculator', label: 'Calculator', icon: CalcIcon },
        ],
      },
      {
        label: 'Utility',
        items: [
          { id: 'notifications', href: '/trading/notifications', label: 'Notifications', icon: Bell, statusKey: 'notification', keywords: ['alerts', 'bell'] },
        ],
      },
      {
        label: 'System',
        items: [
          { id: 'settings', href: '/trading/settings', label: 'Settings', icon: SettingsIcon, keywords: ['preferences', 'appearance'] },
          { id: 'theme', href: '/trading/theme', label: 'Theme', icon: Palette, keywords: ['appearance', 'dark', 'light', 'amoled', 'customize'] },
        ],
      },
    ],
  },
  statusEndpoints: [
    '/api/phase2/websocket',
    '/api/phase2/alerts',
    '/api/phase2/system',
  ],
  statusLinks: {
    websocket: '/trading/market-watch',
    database: '/trading/dashboard',
    scheduler: '/trading/dashboard',
    session: '/trading/funds',
    internet: '/services/system-indicators',
  },
  mobilePrimary: ['dashboard', 'trading', 'positions', 'holdings'],
  alertsRoute: '/trading/notifications',
  notificationsRoute: '/trading/notifications',
  sessionMode: 'kotak-dialog',
  loginEndpoint: '/api/auth/manual-login',
  logoutEndpoint: '/api/auth/logout',
};

/** Dummy Trading Terminal â€” a full independent simulated terminal wired to the
 *  server-side /api/demo engine. Shares the single market-data pipeline, never
 *  fabricates data, and has its own terminal-scoped resources.
 *
 *  Orders is a nested submenu: Trade, Basket Orders, Suggestion and History
 *  render as child sidebar rows (route-driven, hover to temporarily expand).
 *  The Orders module page at /trading/orders keeps its inline module tabs for
 *  mobile/deep-link convenience. The standalone sub-routes remain registered
 *  in TERMINAL_ROUTES so deep links and direct URL access keep working. */
export const DUMMY_SHELL: ShellConfig = {
  id: 'trading-dummy',
  wrapperClass: 'ws-phase2',
  brand: 'DUMMY TRADING TERMINAL',
  tagline: 'Simulated',
  monogram: 'DM',
  version: 'DUMMY TRADING TERMINAL v1.0',
  nav: {
    label: 'DUMMY TRADING TERMINAL',
    groups: [
      {
        label: 'Main',
        items: [
          { id: 'dashboard', href: '/trading/dashboard', label: 'Dashboard', icon: LayoutDashboard, keywords: ['overview', 'home'] },
          { id: 'market-watch', href: '/trading/market-watch', label: 'Market Watch', icon: BarChart3, keywords: ['scanner', 'quotes', 'ltp'] },
          { id: 'watchlist', href: '/trading/watchlist', label: 'Watchlist', icon: Star, keywords: ['watch', 'favourites'] },
        ],
      },
      {
        label: 'Trading',
        items: [
          tradingGroup(),
          { id: 'positions', href: '/trading/positions', label: 'Positions', icon: Briefcase, keywords: ['open', 'pnl', 'live'] },
          { id: 'holdings', href: '/trading/holdings', label: 'Holdings', icon: PieChart },
          { id: 'portfolio', href: '/trading/portfolio', label: 'Portfolio', icon: Layers, keywords: ['p&l', 'summary'] },
          { id: 'account', href: '/trading/account', label: 'Account', icon: User },
        ],
      },
      {
        label: 'Analytics',
        items: [
          { id: 'risk', href: '/trading/risk', label: 'Risk', icon: ShieldAlert },
        ],
      },
      {
        label: 'Utility',
        items: [
          { id: 'notifications', href: '/trading/notifications', label: 'Notifications', icon: Bell, statusKey: 'notification', keywords: ['alerts', 'bell'] },
        ],
      },
      {
        label: 'System',
        items: [
          { id: 'settings', href: '/trading/settings', label: 'Settings', icon: SettingsIcon, keywords: ['preferences', 'simulation'] },
          { id: 'theme', href: '/trading/theme', label: 'Theme', icon: Palette, keywords: ['appearance', 'accent'] },
        ],
      },
    ],
  },
  statusEndpoints: [
    '/api/phase2/websocket',
    '/api/phase2/alerts',
    '/api/phase2/system',
  ],
  statusLinks: {
    websocket: '/trading/market-watch',
    database: '/trading/dashboard',
    scheduler: '/trading/dashboard',
    session: '/trading/account',
    internet: '/services/system-indicators',
  },
  mobilePrimary: ['dashboard', 'trading', 'positions', 'watchlist'],
  alertsRoute: '/trading/notifications',
  notificationsRoute: '/trading/notifications',
  sessionMode: 'kotak-dialog',
  loginEndpoint: '/api/demo/login',
  logoutEndpoint: '/api/demo/logout',
};

/** Shoonya Trading Terminal â€” connection/SDK architecture is real (verified
 *  against NorenRestApiOAuth 0.0.41), but a live broker session only exists
 *  once the user completes OAuth with backend secrets set. Trading pages are
 *  present in the nav (like Kotak) but render connection-required state when
 *  the OAuth session is not active â€” no fabricated data. */
export const SHOONYA_SHELL: ShellConfig = {
  id: 'trading-shoonya',
  wrapperClass: 'ws-phase2',
  brand: 'SHOONYA TRADING TERMINAL',
  tagline: 'Shoonya',
  monogram: 'SH',
  version: 'SHOONYA TRADING TERMINAL v1.0',
  nav: {
    label: 'SHOONYA TRADING TERMINAL',
    groups: [
      {
        label: 'Main',
        items: [
          { id: 'dashboard', href: '/trading/dashboard', label: 'Dashboard', icon: LayoutDashboard, keywords: ['overview', 'home'] },
          { id: 'market-watch', href: '/trading/market-watch', label: 'Market Watch', icon: BarChart3, keywords: ['scanner', 'quotes', 'ltp'] },
        ],
      },
      {
        label: 'Trading',
        items: [
          tradingGroup(['buy', 'sell', 'place order', 'trade']),
          { id: 'positions', href: '/trading/positions', label: 'Positions', icon: Briefcase, keywords: ['open', 'pnl', 'live'] },
          { id: 'holdings', href: '/trading/holdings', label: 'Holdings', icon: PieChart },
          { id: 'portfolio', href: '/trading/portfolio', label: 'Portfolio', icon: Layers, keywords: ['p&l', 'summary'] },
        ],
      },
      {
        label: 'Analytics',
        items: [
          { id: 'risk', href: '/trading/risk', label: 'Risk', icon: ShieldAlert },
        ],
      },
      {
        label: 'Utility',
        items: [
          { id: 'notifications', href: '/trading/notifications', label: 'Notifications', icon: Bell, statusKey: 'notification', keywords: ['alerts', 'bell'] },
        ],
      },
      {
        label: 'System',
        items: [
          { id: 'settings', href: '/trading/settings', label: 'Settings', icon: SettingsIcon, keywords: ['preferences', 'appearance'] },
          { id: 'theme', href: '/trading/theme', label: 'Theme', icon: Palette, keywords: ['appearance', 'dark', 'light', 'amoled', 'customize'] },
        ],
      },
    ],
  },
  statusEndpoints: [
    '/api/phase2/websocket',
    '/api/phase2/alerts',
    '/api/phase2/system',
  ],
  statusLinks: {
    websocket: '/trading/dashboard',
    database: '/trading/dashboard',
    scheduler: '/trading/dashboard',
    session: '/trading/dashboard',
    internet: '/services/system-indicators',
  },
  mobilePrimary: ['dashboard', 'trading', 'positions', 'holdings'],
  alertsRoute: '/trading/notifications',
  notificationsRoute: '/trading/notifications',
  sessionMode: 'kotak-dialog',
  loginEndpoint: '/api/auth/login',
  logoutEndpoint: '/api/auth/logout',
};

export const SERVICES_SHELL: ShellConfig = {
  id: 'services',
  wrapperClass: 'ws-phase2',
  brand: 'SERVICES',
  tagline: 'Services',
  monogram: 'SV',
  version: 'SERVICES v1.0',
  nav: {
    label: 'SERVICES',
    groups: [
      {
        label: 'System',
        items: [
          { id: 'system', href: '/services/system', label: 'System Status', icon: Activity, keywords: ['status', 'health', 'uptime', 'info'] },
          { id: 'session-manager', href: '/services/session-manager', label: 'Session Manager', icon: Database, keywords: ['session', 'manager', 'instruments', 'subscribe', 'pin', 'expiry', 'feed', 'revision', 'phase3'], children: [
            { id: 'session-manager-overview', href: '/services/session-manager', label: 'Overview', icon: Activity, keywords: ['session manager', 'overview', 'counts', 'health', 'summary'] },
            { id: 'session-manager-session', href: '/services/session-manager/session', label: 'Session', icon: Layers, keywords: ['session manager', 'session', 'identity', 'lifecycle', 'terminal', 'jwt'] },
            { id: 'session-manager-instruments', href: '/services/session-manager/instruments', label: 'Instruments', icon: Database, keywords: ['session manager', 'instruments', 'canonical', 'subscribe', 'expire', 'archive'] },
            { id: 'session-manager-sources', href: '/services/session-manager/sources', label: 'Sources', icon: Filter, keywords: ['session manager', 'sources', 'origins', 'instruments'] },
            { id: 'session-manager-connections', href: '/services/session-manager/connections', label: 'Connections', icon: Cable, keywords: ['session manager', 'connections', 'routing', 'revision', 'lag', 'heartbeat'] },
            { id: 'session-manager-history', href: '/services/session-manager/history', label: 'History', icon: History, keywords: ['session manager', 'history', 'events', 'audit', 'lifecycle'] },
            { id: 'session-manager-diagnostics', href: '/services/session-manager/diagnostics', label: 'Diagnostics', icon: Cpu, keywords: ['session manager', 'diagnostics', 'health', 'registry', 'mongo'] },
          ] },
          { id: 'websocket-engine', href: '/services/websocket-engine', label: 'WebSocket Engine', icon: CandlestickChart, keywords: ['websocket', 'sfeed', 'ticks', 'feed', 'field', 'verification', 'router'] },
          { id: 'scheduler', href: '/services/scheduler', label: 'Scheduler', icon: CalendarDays, keywords: ['schedule', 'job', 'ist', 'state', 'machine', 'controller', 'lifecycle', 'history', 'settings'], children: [
            { id: 'scheduler-overview', href: '/services/scheduler', label: 'Overview', icon: Activity, keywords: ['scheduler', 'overview', 'state machine', 'next event', 'readiness', 'ledger', 'history'] },
            { id: 'scheduler-lifecycle', href: '/services/scheduler/lifecycle', label: 'Lifecycle', icon: CalendarDays, keywords: ['scheduler', 'lifecycle', 'state machine', 'transitions', 'stage', 'events'] },
            { id: 'scheduler-timeline', href: '/services/scheduler/timeline', label: 'Timeline', icon: Clock4, keywords: ['scheduler', 'trading day', 'phase schedule', 'readiness'] },
            { id: 'scheduler-history', href: '/services/scheduler/history', label: 'History', icon: History, keywords: ['scheduler', 'history', 'runs', 'executions', 'job', 'status', 'trigger', 'retry', 'log', 'ledger'] },
            { id: 'scheduler-settings', href: '/services/scheduler/settings', label: 'Settings', icon: SettingsIcon, keywords: ['scheduler', 'settings', 'schedule', 'times', 'login', 'logout', 'square off'] },
          ] },
        ],
      },
      {
        label: 'Engines',
        items: [
          { id: 'feature-engine', href: '/services/feature-engine', label: 'Feature Engine', icon: Sparkles, keywords: ['features', 'vwap', 'sma', 'calculations', 'indicators'] },
          { id: 'search-engine', href: '/services/search', label: 'Search Engine', icon: Search, keywords: ['search', 'discovery', 'symbol', 'rank', 'suggest'] },
          { id: 'connection-manager', href: '/services/connection-manager', label: 'Connection Manager', icon: Cable, keywords: ['connection', 'gateway', 'sessions', 'routes', 'ws2'], children: [
            { id: 'connection-manager-overview', href: '/services/connection-manager', label: 'Overview', icon: Cable, keywords: ['connection', 'gateway', 'realtime', 'flow', 'channels', 'backpressure'] },
            { id: 'connection-manager-connections', href: '/services/connection-manager/connections', label: 'Connections', icon: Activity, keywords: ['connections', 'sessions', 'registry', 'live', 'delivery'] },
            { id: 'connection-manager-events', href: '/services/connection-manager/events', label: 'Events', icon: ScrollText, keywords: ['events', 'inspector', 'ring', 'log', 'audit'] },
            { id: 'connection-manager-configuration', href: '/services/connection-manager/configuration', label: 'Configuration', icon: SettingsIcon, keywords: ['config', 'channels', 'backpressure', 'fields', 'delivery'] },
          ] },
        ],
      },
      {
        label: 'Data & Storage',
        items: [
          { id: 'db-writer', href: '/services/db-writer', label: 'DB Writer', icon: Database, keywords: ['db', 'write', 'persistence', 'mongo', 'ticks', 'flush', 'buffer'] },
          { id: 'storage-engine', href: '/services/storage', label: 'Storage Engine', icon: HardDrive, keywords: ['storage', 'infrastructure', 'monitoring', 'db', 'health'] },
        ],
      },
      {
        label: 'Observability',
        items: [
          { id: 'system-indicators', href: '/services/system-indicators', label: 'System Indicators', icon: Zap, keywords: ['indicators', 'internet', 'connectivity', 'health'] },
          { id: 'logs', href: '/services/logs', label: 'Logs', icon: ScrollText, keywords: ['logs', 'log', 'app_logs', 'entries', 'query'] },
        ],
      },
      {
        label: 'Market',
        items: [
          { id: 'market-watch', href: '/services/market-watch', label: 'Market Watch', icon: BarChart3, keywords: ['market', 'watch', 'scanner', 'quotes', 'ltp', 'gainers', 'losers', 'movers', 'volume', 'rank', 'pin'], children: [
            { id: 'market-watch-overview', href: '/services/market-watch', label: 'Overview', icon: Activity, keywords: ['market watch', 'overview', 'summary', 'feed', 'engine', 'status'] },
            { id: 'market-watch-movers', href: '/services/market-watch/movers', label: 'Movers', icon: TrendingUp, keywords: ['market watch', 'gainers', 'losers', 'movers', 'turnover', 'strength', '5m', '10m', '1%', 'circuit'] },
            { id: 'market-watch-rank', href: '/services/market-watch/rank', label: 'Volume & Rank', icon: ListOrdered, keywords: ['market watch', 'rank', 'volume', 'turnover', 'universe', 'virtualized'] },
            { id: 'market-watch-filters', href: '/services/market-watch/filters', label: 'Filters', icon: Filter, keywords: ['market watch', 'filters', 'screener', 'criteria', 'save'] },
            { id: 'market-watch-pins', href: '/services/market-watch/pins', label: 'Pins', icon: PinIcon, keywords: ['market watch', 'pins', 'gainers', 'losers', 'manual', 'auto'] },
            { id: 'market-watch-symbol', href: '/services/market-watch/symbol', label: 'Stock Detail', icon: Search, keywords: ['market watch', 'symbol', 'depth', 'ladder', 'circuit', 'quote', 'margin'] },
            // doc Â§32 â€” the Saturday review is the only place membership changes.
            { id: 'market-watch-weekly', href: '/services/market-watch/weekly', label: 'Weekly Review', icon: CalendarClock, keywords: ['market watch', 'weekly', 'universe', 'lock', 'saturday', 'review', 'add', 'remove', 'keep', '800'] },
            // doc Â§26 â€” the stored end-of-day report.
            { id: 'market-watch-report', href: '/services/market-watch/report', label: 'Report', icon: FileText, keywords: ['market watch', 'report', 'eod', 'daily', 'end of day'] },
          ] },
        ],
      },
      {
        label: 'Trading',
        items: [
          { id: 'risk-engine', href: '/services/risk-engine', label: 'Risk Engine', icon: ShieldAlert, keywords: ['risk', 'rules', 'validate', 'position', 'pnl', 'decision', 'block', 'allow', 'warning'], children: [
            { id: 'risk-engine-overview', href: '/services/risk-engine', label: 'Overview', icon: ShieldAlert, keywords: ['risk', 'decision', 'position', 'pnl', 'block', 'allow'] },
            { id: 'risk-engine-configuration', href: '/services/risk-engine/configuration', label: 'Configuration', icon: SettingsIcon, keywords: ['risk', 'config', 'threshold', 'rule', 'policy'] },
          ] },

          { id: 'order-engine', href: '/services/order-engine', label: 'Order Engine', icon: ListOrdered, keywords: ['order', 'execution', 'basket', 'orchestration', 'reject', 'fill'], children: [
            { id: 'order-engine-overview', href: '/services/order-engine', label: 'Overview', icon: ListOrdered, keywords: ['order', 'engine', 'summary', 'execution'] },
            { id: 'order-engine-orders', href: '/services/order-engine/orders', label: 'Orders', icon: ListOrdered, keywords: ['order', 'book', 'live', 'reject', 'fill'] },
            { id: 'order-engine-history', href: '/services/order-engine/history', label: 'History', icon: History, keywords: ['order', 'history', 'executions', 'past'] },
            { id: 'order-engine-basket', href: '/services/order-engine/basket', label: 'Basket', icon: Boxes, keywords: ['basket', 'orders', 'push', 'multi'] },
          ] },
          { id: 'squareoff', href: '/services/squareoff', label: 'Squareoff', icon: RotateCcw, keywords: ['squareoff', 'position', 'close', 'freeze', 'retry', 'exit'] },
          { id: 'broker-terminal', href: '/services/broker-terminal', label: 'Broker Terminal', icon: Building2, keywords: ['terminal', 'broker', 'kotak', 'shoonya', 'dummy', 'adaptor'], children: [
            { id: 'broker-terminal-overview', href: '/services/broker-terminal', label: 'Overview', icon: Building2, keywords: ['terminal', 'broker', 'status', 'brokers'] },
            { id: 'broker-terminal-terminals', href: '/services/broker-terminal/terminals', label: 'Terminals', icon: Cable, keywords: ['terminals', 'kotak', 'shoonya', 'dummy', 'adaptor', 'login'] },
          ] },
        ],
      },
      {
        label: 'Security',
        items: [
          { id: 'security', href: '/services/security', label: 'Security', icon: Shield },
          { id: 'audit-engine', href: '/services/audit-engine', label: 'Audit Engine', icon: FileSearch, keywords: ['audit', 'trail', 'event', 'decision', 'trace', 'immutable'] },
        ],
      },
      {
        label: 'Monitoring',
        items: [
          { id: 'notifications', href: '/services/notifications', label: 'Notifications', icon: Bell, statusKey: 'notification', keywords: ['alerts', 'bell'] },
          { id: 'settings', href: '/services/settings', label: 'Settings', icon: SettingsIcon },
          { id: 'theme', href: '/services/theme', label: 'Theme', icon: Palette, keywords: ['appearance', 'dark', 'light', 'amoled', 'customize'] },
        ],
      },
    ],
  },
  statusEndpoints: [
    '/api/phase2/websocket',
    '/api/phase2/alerts',
    '/api/phase2/system',
  ],
  statusLinks: {
    websocket: '/services/system',
    database: '/services/system',
    scheduler: '/services/system',
    session: '/services/system',
    internet: '/services/system-indicators',
  },
  mobilePrimary: ['system', 'logs', 'notifications', 'settings'],
  alertsRoute: '/services/notifications',
  notificationsRoute: '/services/notifications',
  sessionMode: 'kotak-dialog',
  loginEndpoint: '/api/auth/manual-login',
  logoutEndpoint: '/api/auth/logout',
};

export const KHUMBHA_AI_SHELL: ShellConfig = {
  id: 'khumbha-ai',
  wrapperClass: 'ws-phase2',
  brand: 'KHUMBHA AI',
  tagline: 'Khumbha AI',
  monogram: 'KA',
  version: 'KHUMBHA AI v1.0',
  nav: {
    label: 'KHUMBHA AI',
    groups: [
      {
        label: 'Main',
        items: [
          { id: 'dashboard', href: '/ai/dashboard', label: 'Dashboard', icon: LayoutDashboard, keywords: ['overview', 'home'] },
          { id: 'models', href: '/ai/models', label: 'Models', icon: Boxes },
          { id: 'datasets', href: '/ai/datasets', label: 'Datasets', icon: Database },
          { id: 'training', href: '/ai/training', label: 'Training', icon: Cpu },
        ],
      },
      {
        label: 'Runtime',
        items: [
          { id: 'inference', href: '/ai/inference', label: 'Inference', icon: Sparkles },
          { id: 'agents', href: '/ai/agents', label: 'Agents', icon: Layers },
          { id: 'suggestions', href: '/ai/suggestions', label: 'Suggestions', icon: BookOpen },
        ],
      },
      {
        label: 'Infrastructure',
        items: [
          { id: 'infrastructure', href: '/ai/infrastructure', label: 'Infrastructure', icon: Globe },
          { id: 'jobs', href: '/ai/jobs', label: 'Jobs', icon: History },
          { id: 'logs', href: '/ai/logs', label: 'Logs', icon: ScrollText },
          { id: 'settings', href: '/ai/settings', label: 'Settings', icon: SettingsIcon, keywords: ['preferences', 'appearance'] },
          { id: 'theme', href: '/ai/theme', label: 'Theme', icon: Palette, keywords: ['appearance', 'dark', 'light', 'amoled', 'customize'] },
        ],
      },
    ],
  },
  statusEndpoints: [
    '/api/phase2/websocket',
    '/api/phase2/alerts',
    '/api/phase2/system',
  ],
  statusLinks: {
    websocket: '/ai/infrastructure',
    database: '/ai/infrastructure',
    scheduler: '/ai/infrastructure',
    session: '/ai/infrastructure',
    internet: '/ai/infrastructure',
  },
  mobilePrimary: ['dashboard', 'models', 'training', 'inference'],
  alertsRoute: '/ai/settings',
  notificationsRoute: '/ai/settings',
  sessionMode: 'none',
  loginEndpoint: '/api/auth/manual-login',
  logoutEndpoint: '/api/auth/logout',
};

export type ShellWorkspace = 'data-saver' | 'trading' | 'services' | 'khumbha-ai';

export const SHELL_CONFIGS: Record<ShellWorkspace, ShellConfig> = {
  'data-saver': DATA_SAVER_SHELL,
  trading: TRADING_SHELL,
  services: SERVICES_SHELL,
  'khumbha-ai': KHUMBHA_AI_SHELL,
};

export function getShellConfig(workspace: ShellWorkspace): ShellConfig {
  return SHELL_CONFIGS[workspace];
}

export type TerminalMode = 'dummy' | 'kotak-neo' | 'shoonya';

/** Mode-aware trading terminal config: each terminal has its OWN registry
 *  (never shares a shell's nav with another terminal). */
export function getTradingShellConfig(mode: TerminalMode): ShellConfig {
  if (mode === 'dummy') return DUMMY_SHELL;
  if (mode === 'kotak-neo') return KOTAK_NEO_SHELL;
  return SHOONYA_SHELL;
}

/** Routes every trading terminal renders (content adapts to the active mode).
 *  Terminal-exclusive pages are appended per mode below; anything not in the
 *  active mode's set redirects to that mode's dashboard (no render / reload). */
const COMMON_TERMINAL_ROUTES = [
  '/trading/dashboard',
  '/trading/positions',
  '/trading/holdings',
  '/trading/portfolio',
  '/trading/order-history',
  '/trading/settings',
  '/trading/notifications',
  '/trading/market-watch',
] as const;

const KOTAK_NEO_ROUTES = [
  ...COMMON_TERMINAL_ROUTES,
  '/trading/funds',
  '/trading/trade',
  '/trading/watchlist',
  '/trading/suggestion',
  '/trading/basket-orders',
  '/trading/risk',
  '/trading/account',
  '/trading/reports',
  '/trading/history',
  '/trading/audit',
  '/trading/theme',
] as const;

const DUMMY_ONLY_ROUTES = [
  ...COMMON_TERMINAL_ROUTES,
  '/trading/calculator',
  '/trading/trade',
  '/trading/basket-orders',
  '/trading/suggestion',
  '/trading/history',
  '/trading/watchlist',
  '/trading/risk',
  '/trading/calendar',
  '/trading/theme',
  '/trading/account',
  '/trading/audit',
] as const;

/** Per-terminal allowed route registry (single source of truth for the
 *  terminal-aware route scope). */
export const TERMINAL_ROUTES: Record<TerminalMode, readonly string[]> = {
  dummy: DUMMY_ONLY_ROUTES,
  'kotak-neo': KOTAK_NEO_ROUTES,
  shoonya: [
    ...COMMON_TERMINAL_ROUTES,
    '/trading/trade',
    '/trading/basket-orders',
    '/trading/suggestion',
    '/trading/history',
    '/trading/theme',
    '/trading/risk',
  ],
};

export function findNavByPath(
  nav: ShellNav,
  pathname: string,
): NavItem | undefined {
  let best: NavItem | undefined;
  const walk = (item: NavItem) => {
    if (pathname === item.href || pathname.startsWith(item.href + '/')) {
      if (!best || item.href.length > best.href.length) best = item;
    }
    item.children?.forEach(walk);
  };
  for (const group of nav.groups) {
    for (const item of group.items) walk(item);
  }
  return best;
}

const FLATTENED = (nav: ShellNav): NavItem[] => nav.groups.flatMap((g) => g.items);

/** Resolve the registry-driven primary items for the mobile/PWA bottom tab bar
 *  (at most `max`). No component hardcodes the tab list â€” it comes from each
 *  shell config's `mobilePrimary` (page ids) or the first group's items. */
export function getMobilePrimaryItems(config: ShellConfig, max = 4): NavItem[] {
  const flat = FLATTENED(config.nav);
  const wanted = config.mobilePrimary ?? config.nav.groups[0]?.items.map((i) => i.id) ?? [];
  const picked: NavItem[] = [];
  for (const id of wanted) {
    const item = flat.find((n) => n.id === id);
    if (item && !picked.some((p) => p.id === item.id)) picked.push(item);
    if (picked.length >= max) break;
  }
  if (picked.length === 0 && config.nav.groups[0]?.items.length) {
    return config.nav.groups[0].items.slice(0, max);
  }
  return picked;
}
