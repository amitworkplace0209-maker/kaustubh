// ---- GlobalTopBar context-registry — pure unit tests ----
//
// Verifies the ONE shared topbar is context-aware by construction: every
// phase/page/terminal resolves to the CORRECT page config (indicators are only
// the ones that exist on the active page), per-page actions are only real
// capabilities, the Kotak terminal always carries the manual-login wiring, the
// dummy terminal is isolated (no broker session indicator), and search results
// rank the active phase first.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStatusLinks,
  findPageByPath,
  getTerminalContext,
  getTopbarPhase,
  rankSearchResults,
  resolveEffectiveTerminalMode,
  resolvePageContext,
} from '../lib/topbar/context-registry.ts';

const configs = {
  'data-saver': { id: 'data-saver', nav: { label: 'DATA SAVER', groups: [] }, statusLinks: {} } as const,
  services: { id: 'services', nav: { label: 'SERVICES', groups: [] }, statusLinks: {} } as const,
  tradingKotak: { id: 'trading-kotak', nav: { label: 'KOTAK NEO', groups: [] }, statusLinks: {} } as const,
  tradingDummy: { id: 'trading-dummy', nav: { label: 'DUMMY', groups: [] }, statusLinks: {} } as const,
  // khumbha removed (standalone app)
} as const;

function resolve(config: (typeof configs)[keyof typeof configs], pathname: string, terminal?: string) {
  return resolvePageContext(config as never, pathname, terminal as never);
}

test('phase resolver maps shell ids to phases', () => {
  assert.equal(getTopbarPhase(configs['data-saver']), 'data-saver');
  assert.equal(getTopbarPhase(configs.services), 'services');
  assert.equal(getTopbarPhase(configs.tradingKotak), 'trading');
  assert.equal(getTopbarPhase(configs.tradingDummy), 'trading');
});

test('data-saver dashboard carries the full spec cluster', () => {
  const page = resolve(configs['data-saver'], '/data-saver/dashboard');
  assert.equal(page.pageId, 'dashboard');
  assert.equal(page.title, 'Dashboard');
  assert.ok(page.indicators.includes('market'));
  assert.ok(page.indicators.includes('ws'));
  assert.ok(page.indicators.includes('db'));
  assert.ok(page.indicators.includes('sched'));
  assert.ok(page.indicators.includes('pipeline'));
  assert.ok(page.actions.includes('refresh'));
});

test('data-saver quality page has the Run Scan action (real endpoint)', () => {
  const page = resolve(configs['data-saver'], '/data-saver/quality');
  assert.equal(page.title, 'Data Quality');
  assert.ok(page.actions.includes('runScan'));
  assert.ok(page.indicators.includes('feed'));
});

test('websocket page gains diagnostics nav (only where supported)', () => {
  const page = resolve(configs['data-saver'], '/data-saver/websocket');
  assert.ok(page.actions.includes('wsDiagnostics'));
  const trade = resolve(configs.tradingKotak, '/trading/trade', 'kotak-neo');
  assert.ok(!trade.actions.includes('wsDiagnostics'), 'trade page has no fake diagnostics');
});

test('tick-analytics has no fake Live/Pause action (page-local state)', () => {
  const page = resolve(configs['data-saver'], '/data-saver/analytics');
  assert.deepEqual(page.actions, ['refresh']);
});

test('services system shows cpu/memory and NO market/session/login', () => {
  const page = resolve(configs.services, '/services/system');
  assert.ok(page.indicators.includes('cpu'));
  assert.ok(page.indicators.includes('mem'));
  assert.ok(!page.indicators.includes('market'));
  assert.ok(!page.indicators.includes('sess'));
});

test('services notifications can mark all read', () => {
  const page = resolve(configs.services, '/services/notifications');
  assert.ok(page.actions.includes('markAllRead'));
});

test('trading dashboard includes session + market + orders', () => {
  const page = resolve(configs.tradingKotak, '/trading/dashboard', 'kotak-neo');
  assert.ok(page.indicators.includes('sess'));
  assert.ok(page.indicators.includes('market'));
  assert.ok(page.indicators.includes('orders'));
  assert.equal(page.title, 'Dashboard');
});

test('trade page shows open orders but no scan (trading does not scan quality)', () => {
  const page = resolve(configs.tradingKotak, '/trading/trade', 'kotak-neo');
  assert.ok(page.indicators.includes('orders'));
  assert.ok(!page.actions.includes('runScan'));
});

test('dummy terminal strips the broker-session indicator (isolated)', () => {
  const page = resolve(configs.tradingDummy, '/trading/dashboard', 'dummy');
  assert.ok(!page.indicators.includes('sess'), 'dummy never shows a broker session');
  assert.ok(page.indicators.includes('market'), 'real market calendar stays');
});

test('terminal context: kotak manual login wiring is real', () => {
  const kotak = getTerminalContext('kotak-neo');
  assert.equal(kotak.label, 'KOTAK NEO');
  assert.ok(kotak.requiresLogin);
  assert.equal(kotak.loginEndpoint, '/api/auth/manual-login');
  assert.equal(kotak.logoutEndpoint, '/api/auth/logout');
  assert.ok(!kotak.simulation);
});

test('terminal context: dummy is isolated simulation with demo endpoints', () => {
  const dummy = getTerminalContext('dummy');
  assert.ok(dummy.simulation);
  assert.ok(!dummy.requiresLogin);
  assert.equal(dummy.loginEndpoint, '/api/demo/login');
});

test('unknown route falls back to the phase default', () => {
  const page = resolve(configs['data-saver'], '/data-saver/something-else');
  assert.equal(page.pageId, 'dashboard');
  const service = resolve(configs.services, '/services/nope');
  assert.equal(service.pageId, 'system');
});

test('longest route prefix wins for nested pages', () => {
  const nested = findPageByPath(
    [
      { route: '/data-saver/insights', page: { pageId: 'insights', title: 'Data Insights', indicators: [], actions: [] } },
      { route: '/data-saver/insights/activity', page: { pageId: 'insights-activity', title: 'Activity', indicators: [], actions: [] } },
    ],
    '/data-saver/insights/activity',
  );
  assert.equal(nested?.pageId, 'insights-activity');
});

test('buildStatusLinks: phase-agnostic fallbacks + config overrides', () => {
  const links = buildStatusLinks({
    statusLinks: { websocket: '/services/websocket-engine' } as never,
  });
  assert.equal(links.websocket, '/services/websocket-engine');
  assert.equal(links.feed, '/services/websocket-engine');
  assert.equal(links.api, '/services/system');
  assert.equal(links.orders, '/trading/positions');
});

test('search ranks the active phase first, then title match', () => {
  const items = [
    { id: 'a', label: 'Orders', keywords: ['book'], phase: 'data-saver' },
    { id: 'b', label: 'Order History', keywords: ['history'], phase: 'trading' },
    { id: 'c', label: 'Orders', keywords: [], phase: 'trading' },
  ];
  const ranked = rankSearchResults(items, 'order', 'trading');
  const ids = ranked.map((i) => i.id);
  assert.deepEqual([...ids.slice(0, 2)].sort(), ['b', 'c'], 'both active-phase matches lead');
  assert.equal(ids[2], 'a', 'non-active phase sorts last');
});

test('resolveEffectiveTerminalMode: live session.mode wins over a dummy UI mode', () => {
  // The exact production case: reconciler pins local mode to dummy while no
  // live session exists, yet the backend serves kotak and needs a login.
  assert.equal(resolveEffectiveTerminalMode('kotak', 'kotak', 'kotak', 'dummy'), 'kotak-neo');
  assert.equal(resolveEffectiveTerminalMode('shoonya', 'shoonya', 'shoonya', 'dummy'), 'shoonya');
});

test('resolveEffectiveTerminalMode: snapshot terminal used when session.mode is empty', () => {
  // Observed live: session.mode === "" with terminal === "kotak".
  assert.equal(resolveEffectiveTerminalMode('', 'kotak', null, 'dummy'), 'kotak-neo');
  assert.equal(resolveEffectiveTerminalMode(null, 'shoonya', null, 'dummy'), 'shoonya');
  assert.equal(resolveEffectiveTerminalMode(undefined, 'dummy', null, 'kotak-neo'), 'dummy');
});

test('resolveEffectiveTerminalMode: system-poll broker covers the pre-hydration window', () => {
  // SSE snapshot not arrived yet; the /api/system poll already declares kotak.
  assert.equal(resolveEffectiveTerminalMode(null, null, 'kotak', 'dummy'), 'kotak-neo');
  assert.equal(resolveEffectiveTerminalMode('', '', 'shoonya', 'dummy'), 'shoonya');
});

test('resolveEffectiveTerminalMode: local UI mode is only the last resort', () => {
  assert.equal(resolveEffectiveTerminalMode(null, null, null, 'kotak-neo'), 'kotak-neo');
  assert.equal(resolveEffectiveTerminalMode(null, null, null, 'dummy'), 'dummy');
});

test('resolveEffectiveTerminalMode: garbage never invents a broker', () => {
  assert.equal(resolveEffectiveTerminalMode('zerodha', 'unknown', ['kotak', 'shoonya'], 'dummy'), 'dummy');
  assert.equal(resolveEffectiveTerminalMode(null, null, 'KOTAK', 'dummy'), 'kotak-neo');
});

test('resolved kotak mode carries the REAL broker login endpoint (never demo)', () => {
  const mode = resolveEffectiveTerminalMode('', 'kotak', 'kotak', 'dummy');
  const ctx = getTerminalContext(mode);
  assert.equal(ctx.loginEndpoint, '/api/auth/manual-login');
  assert.equal(ctx.logoutEndpoint, '/api/auth/logout');
  assert.ok(!ctx.simulation);
});
