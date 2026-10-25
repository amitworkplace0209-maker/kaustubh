// ---- Scheduler sidebar contextual submenu ----
//
// Pure-logic tests for the route/hover submenu state machine in lib/nav-utils.
// Route is the authoritative state: there is no persisted "open" flag, so a
// browser refresh restores the correct state purely from the URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { NavItem } from '../components/layout/nav';
import {
  childActive,
  findNavItemByPath,
  SUBMENU_HOVER_DELAY_MS,
  submenuOpen,
  submenuRouteOpen,
  subtreeActive,
} from '../lib/nav-utils.ts';

const icon = () => null;

const SCHEDULER: NavItem = {
  id: 'scheduler',
  href: '/services/scheduler',
  label: 'Scheduler',
  icon,
  children: [
    { id: 'scheduler-overview', href: '/services/scheduler', label: 'Overview', icon },
    { id: 'scheduler-lifecycle', href: '/services/scheduler/lifecycle', label: 'Lifecycle', icon },
    { id: 'scheduler-timeline', href: '/services/scheduler/timeline', label: 'Timeline', icon },
    { id: 'scheduler-history', href: '/services/scheduler/history', label: 'History', icon },
    { id: 'scheduler-settings', href: '/services/scheduler/settings', label: 'Settings', icon },
  ],
};

const SESSION_MANAGER: NavItem = {
  id: 'session-manager',
  href: '/services/session-manager',
  label: 'Session Manager',
  icon,
  children: [
    { id: 'session-manager-overview', href: '/services/session-manager', label: 'Overview', icon },
    { id: 'session-manager-session', href: '/services/session-manager/session', label: 'Session', icon },
    { id: 'session-manager-instruments', href: '/services/session-manager/instruments', label: 'Instruments', icon },
    { id: 'session-manager-subscriptions', href: '/services/session-manager/subscriptions', label: 'Subscriptions', icon },
    { id: 'session-manager-sources', href: '/services/session-manager/sources', label: 'Sources', icon },
    { id: 'session-manager-pins', href: '/services/session-manager/pins', label: 'Pins', icon },
    { id: 'session-manager-expiry', href: '/services/session-manager/expiry', label: 'Expiry', icon },
    { id: 'session-manager-connections', href: '/services/session-manager/connections', label: 'Connections', icon },
    { id: 'session-manager-live', href: '/services/session-manager/live-feed', label: 'Live Feed', icon },
    { id: 'session-manager-history', href: '/services/session-manager/history', label: 'History', icon },
    { id: 'session-manager-reconcile', href: '/services/session-manager/reconcile', label: 'Reconcile', icon },
    { id: 'session-manager-configuration', href: '/services/session-manager/configuration', label: 'Configuration', icon },
    { id: 'session-manager-diagnostics', href: '/services/session-manager/diagnostics', label: 'Diagnostics', icon },
    { id: 'session-manager-manual', href: '/services/session-manager/manual-add', label: 'Manual Add', icon },
  ],
};

const OTHERS: NavItem[] = [
  { id: 'connection-manager', href: '/services/connection-manager', label: 'Connection Manager', icon },
  { id: 'websocket-engine', href: '/services/websocket-engine', label: 'WebSocket Engine', icon },
  { id: 'feature-engine', href: '/services/feature-engine', label: 'Feature Engine', icon },
];

const ALL: NavItem[] = [SCHEDULER, SESSION_MANAGER, ...OTHERS];

const activeFor = (pathname: string) => findNavItemByPath(ALL, pathname);

test('Session Manager route -> Session Manager submenu is open', () => {
  const active = activeFor('/services/session-manager');
  assert.equal(active?.id, 'session-manager');
  assert.equal(subtreeActive(SESSION_MANAGER, active), true);
  assert.equal(submenuRouteOpen(SESSION_MANAGER, active), true);
  assert.equal(submenuOpen(SESSION_MANAGER, active, false), true);
});

test('Session Manager child routes -> submenu open + matching child active (direct URL)', () => {
  for (const [url, childId] of [
    ['/services/session-manager/session', 'session-manager-session'],
    ['/services/session-manager/instruments', 'session-manager-instruments'],
    ['/services/session-manager/subscriptions', 'session-manager-subscriptions'],
    ['/services/session-manager/sources', 'session-manager-sources'],
    ['/services/session-manager/pins', 'session-manager-pins'],
    ['/services/session-manager/expiry', 'session-manager-expiry'],
    ['/services/session-manager/connections', 'session-manager-connections'],
    ['/services/session-manager/live-feed', 'session-manager-live'],
    ['/services/session-manager/history', 'session-manager-history'],
    ['/services/session-manager/reconcile', 'session-manager-reconcile'],
    ['/services/session-manager/configuration', 'session-manager-configuration'],
    ['/services/session-manager/diagnostics', 'session-manager-diagnostics'],
    ['/services/session-manager/manual-add', 'session-manager-manual'],
  ] as const) {
    const active = activeFor(url);
    assert.equal(active?.id, childId, `deepest match for ${url}`);
    assert.equal(subtreeActive(SESSION_MANAGER, active), true, `parent subtree active for ${url}`);
    assert.equal(submenuOpen(SESSION_MANAGER, active, false), true, `submenu open for ${url}`);
    const child = SESSION_MANAGER.children!.find((c) => c.id === childId);
    assert.equal(childActive(child!, active), true, `child ${childId} highlighted`);
  }
});

test('Session Manager Overview child shares the parent route -> parent row active, child not separately highlighted', () => {
  const active = activeFor('/services/session-manager');
  assert.equal(active?.id, 'session-manager');
  assert.equal(submenuRouteOpen(SESSION_MANAGER, active), true);
  const overview = SESSION_MANAGER.children![0];
  assert.equal(childActive(overview, active), false);
});

test('Other services routes -> Session Manager submenu closed', () => {
  for (const url of ['/services/connection-manager', '/services/websocket-engine', '/services/feature-engine']) {
    const active = activeFor(url);
    assert.equal(subtreeActive(SESSION_MANAGER, active), false, `closed for ${url}`);
    assert.equal(submenuOpen(SESSION_MANAGER, active, false), false, `closed for ${url}`);
  }
});

test('browser refresh -> Session Manager state restores from URL alone', () => {
  assert.equal(submenuOpen(SESSION_MANAGER, activeFor('/services/session-manager'), false), true);
  assert.equal(submenuOpen(SESSION_MANAGER, activeFor('/services/session-manager/session'), false), true);
  assert.equal(submenuOpen(SESSION_MANAGER, activeFor('/services/session-manager/manual-add'), false), true);
  assert.equal(submenuOpen(SESSION_MANAGER, activeFor('/services/scheduler'), false), false);
});

test('Scheduler route -> Scheduler submenu is open (no hover)', () => {
  const active = activeFor('/services/scheduler');
  assert.equal(active?.id, 'scheduler');
  assert.equal(subtreeActive(SCHEDULER, active), true);
  assert.equal(submenuRouteOpen(SCHEDULER, active), true);
  assert.equal(submenuOpen(SCHEDULER, active, false), true);
});

test('Scheduler child route -> submenu open + matching child active', () => {
  for (const [url, childId] of [
    ['/services/scheduler/lifecycle', 'scheduler-lifecycle'],
    ['/services/scheduler/timeline', 'scheduler-timeline'],
    ['/services/scheduler/history', 'scheduler-history'],
    ['/services/scheduler/settings', 'scheduler-settings'],
  ] as const) {
    const active = activeFor(url);
    assert.equal(active?.id, childId, `deepest match for ${url}`);
    assert.equal(subtreeActive(SCHEDULER, active), true, `parent subtree active for ${url}`);
    assert.equal(submenuOpen(SCHEDULER, active, false), true, `submenu open for ${url}`);
    const child = SCHEDULER.children!.find((c) => c.id === childId);
    assert.equal(childActive(child!, active), true, `child ${childId} highlighted`);
  }
});

test('Scheduler Overview child shares the parent route -> parent row is active, child not separately highlighted', () => {
  const active = activeFor('/services/scheduler');
  assert.equal(active?.id, 'scheduler');
  // The Overview child points at the same URL as its parent; the parent is
  // the matched (active) item and the submenu is open.
  assert.equal(submenuRouteOpen(SCHEDULER, active), true);
  const overview = SCHEDULER.children![0];
  assert.equal(childActive(overview, active), false);
});

test('Connection Manager route -> Scheduler submenu closed', () => {
  const active = activeFor('/services/connection-manager');
  assert.equal(active?.id, 'connection-manager');
  assert.equal(subtreeActive(SCHEDULER, active), false);
  assert.equal(submenuOpen(SCHEDULER, active, false), false);
});

test('WebSocket Engine route -> Scheduler submenu closed', () => {
  const active = activeFor('/services/websocket-engine');
  assert.equal(subtreeActive(SCHEDULER, active), false);
  assert.equal(submenuOpen(SCHEDULER, active, false), false);
});

test('Session Manager + Feature Engine routes -> Scheduler submenu closed', () => {
  for (const url of ['/services/session-manager', '/services/feature-engine']) {
    const active = activeFor(url);
    assert.equal(subtreeActive(SCHEDULER, active), false, `closed for ${url}`);
    assert.equal(submenuOpen(SCHEDULER, active, false), false, `closed for ${url}`);
  }
});

test('hover Scheduler -> submenu opens', () => {
  assert.equal(submenuOpen(SCHEDULER, undefined, true), true);
});

test('mouse leaves Scheduler area -> submenu closes', () => {
  assert.equal(submenuOpen(SCHEDULER, activeFor('/services/connection-manager'), false), false);
  assert.equal(submenuOpen(SCHEDULER, activeFor('/services/scheduler'), true), true);
});

test('hover is only temporary: non-active route + hover=false -> collapsed', () => {
  assert.equal(submenuOpen(SCHEDULER, activeFor('/services/connection-manager'), false), false);
});

test('browser refresh -> route-based state restores from URL alone', () => {
  // No persisted state: the open/closed result depends only on the pathname.
  assert.equal(submenuOpen(SCHEDULER, activeFor('/services/scheduler'), false), true);
  assert.equal(submenuOpen(SCHEDULER, activeFor('/services/scheduler/history'), false), true);
  assert.equal(submenuOpen(SCHEDULER, activeFor('/services/scheduler/settings'), false), true);
  assert.equal(submenuOpen(SCHEDULER, activeFor('/services/websocket-engine'), false), false);
});

test('other Service items are unaffected (no children)', () => {
  for (const item of OTHERS) {
    assert.equal(item.children, undefined);
    // A row without children is only ever active when it is the match itself.
    assert.equal(subtreeActive(item, item), true);
    assert.equal(subtreeActive(item, undefined), false);
    assert.equal(submenuOpen(item, SCHEDULER, false), false);
  }
});

test('findNavItemByPath descends into children arrays', () => {
  assert.equal(activeFor('/services/scheduler/timeline')?.id, 'scheduler-timeline');
  assert.equal(activeFor('/services/scheduler/history')?.id, 'scheduler-history');
  assert.equal(activeFor('/services/scheduler/settings')?.id, 'scheduler-settings');
  assert.equal(activeFor('/services/scheduler/lifecycle')?.id, 'scheduler-lifecycle');
  assert.equal(activeFor('/services/scheduler')?.id, 'scheduler');
});

test('hover delay constant is a small positive number', () => {
  assert.equal(typeof SUBMENU_HOVER_DELAY_MS, 'number');
  assert.ok(SUBMENU_HOVER_DELAY_MS > 0);
  assert.ok(SUBMENU_HOVER_DELAY_MS <= 1000);
});