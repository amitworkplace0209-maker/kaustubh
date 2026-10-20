/**
 * Phase identity — the single place that defines what "this phase" is, so the
 * Settings system (and any other consumers) render the correct name, colour,
 * PWA identity and home path without hard-coding "Data Saver" strings.
 *
 * This module provides a typed PhaseConfig registry that drives the
 * GlobalTopBar, sidebar, phase switcher, and PWA identity across all
 * KAUSTUBH phases. New phases register here without touching any component.
 */

import { Database, CandlestickChart, Server, BrainCircuit } from 'lucide-react';

export type PhaseStatus = 'healthy' | 'warning' | 'error' | 'offline' | 'unknown' | 'neutral';

export interface PhaseSearchScopes {
  stocks: boolean;
  instruments: boolean;
  ticks: boolean;
  subscriptions: boolean;
  dataCenter: boolean;
  dataQuality: boolean;
  tickAnalytics: boolean;
  alerts: boolean;
  notifications: boolean;
  schedules: boolean;
  downloads: boolean;
  settings: boolean;
  symbols: boolean;
  watchlist: boolean;
  orders: boolean;
  positions: boolean;
  holdings: boolean;
  portfolio: boolean;
  trades: boolean;
  brokers: boolean;
  terminal: boolean;
  market: boolean;
  system: boolean;
  documentation: boolean;
}

export interface PhaseStatusIndicator {
  id: string;
  label: string;
  shortLabel: string;
  source: string;
  eventType: string;
}

export interface PhaseConfig {
  readonly phaseId: string;
  readonly group: string;
  readonly appId: string;
  readonly phaseName: string;
  readonly phaseShortName: string;
  readonly phaseFullName: string;
  readonly phaseTagline: string;
  readonly phaseDescription: string;
  readonly phaseThemeColor: string;
  readonly phaseAltThemeColor: string;
  readonly phaseHomePath: string;
  readonly phaseSettingsPath: string;
  readonly groupLabel: string;
  readonly groupDescription: string;
  readonly icon: typeof Database;
  readonly monogram: string;
  readonly defaultBrightness: 'light' | 'dark' | 'system' | 'amoled';
  readonly defaultAccent: string;
  readonly statusIndicators: PhaseStatusIndicator[];
  readonly searchScopes: PhaseSearchScopes;
  readonly available: boolean;
  readonly availabilityNote?: string;
}

export const DATA_SAVER_PHASE: PhaseConfig = {
  phaseId: 'data-saver',
  group: 'data-saver',
  appId: 'data-saver',
  phaseName: 'Data Saver',
  phaseShortName: 'Data Saver',
  phaseFullName: 'KAUSTUBH Data Saver',
  phaseTagline: 'Live NSE market data collection & analysis',
  phaseDescription:
    'Streams live NSE ticks from the Kotak Neo feed, persists them to MongoDB and scans moving stocks — all under your control.',
  phaseThemeColor: '#F59E0B',
  phaseAltThemeColor: '#F28C28',
  phaseHomePath: '/data-saver/dashboard',
  phaseSettingsPath: '/data-saver/settings',
  groupLabel: 'Data Saver',
  groupDescription:
    'Data collection, storage, scheduling, real-time feed and platform behaviour.',
  icon: Database,
  monogram: 'DS',
  defaultBrightness: 'light',
  defaultAccent: 'saffron',
  statusIndicators: [
    { id: 'net', label: 'Network', shortLabel: 'NET', source: 'backend health/realtime state', eventType: 'network.updated' },
    { id: 'ws', label: 'WebSocket', shortLabel: 'WS', source: 'canonical WebSocket supervisor', eventType: 'websocket.connected' },
    { id: 'db', label: 'Database', shortLabel: 'DB', source: 'backend database health', eventType: 'database.connected' },
    { id: 'sched', label: 'Scheduler', shortLabel: 'SCHED', source: 'canonical scheduler service', eventType: 'scheduler.started' },
    { id: 'sess', label: 'Session', shortLabel: 'SESS', source: 'canonical session service', eventType: 'session.logged_in' },
  ],
  searchScopes: {
    stocks: true, instruments: true, ticks: true, subscriptions: true,
    dataCenter: true, dataQuality: true, tickAnalytics: true,
    alerts: true, notifications: true, schedules: true, downloads: true, settings: true,
    symbols: false, watchlist: false, orders: false, positions: false,
    holdings: false, portfolio: false, trades: false, brokers: false,
    terminal: false, market: false, system: false, documentation: true,
  },
  available: true,
};

export const TRADING_PHASE: PhaseConfig = {
  phaseId: 'trading',
  group: 'trading',
  appId: 'trading',
  phaseName: 'Trading Terminal',
  phaseShortName: 'Trading',
  phaseFullName: 'KAUSTUBH Trading Terminal',
  phaseTagline: 'Execution and portfolio management',
  phaseDescription:
    'Live market watch, orders, positions and portfolio management with Kotak Neo, Shoonya, or Dummy terminals.',
  phaseThemeColor: '#10B981',
  phaseAltThemeColor: '#059669',
  phaseHomePath: '/trading/dashboard',
  phaseSettingsPath: '/trading/settings',
  groupLabel: 'Trading Terminal',
  groupDescription:
    'Market execution, portfolio tracking, order management and broker connectivity.',
  icon: CandlestickChart,
  monogram: 'TT',
  defaultBrightness: 'light',
  defaultAccent: 'emerald',
  statusIndicators: [
    { id: 'net', label: 'Network', shortLabel: 'NET', source: 'backend health/realtime state', eventType: 'network.updated' },
    { id: 'ws', label: 'WebSocket', shortLabel: 'WS', source: 'broker WebSocket supervisor', eventType: 'websocket.connected' },
    { id: 'db', label: 'Database', shortLabel: 'DB', source: 'backend database health', eventType: 'database.connected' },
    { id: 'sched', label: 'Scheduler', shortLabel: 'SCHED', source: 'canonical scheduler service', eventType: 'scheduler.started' },
    { id: 'sess', label: 'Session', shortLabel: 'SESS', source: 'canonical session service', eventType: 'session.logged_in' },
    { id: 'market', label: 'Market', shortLabel: 'MKT', source: 'backend market state', eventType: 'market.updated' },
  ],
  searchScopes: {
    stocks: false, instruments: false, ticks: false, subscriptions: false,
    dataCenter: false, dataQuality: false, tickAnalytics: false,
    alerts: true, notifications: true, schedules: false, downloads: false, settings: true,
    symbols: true, watchlist: true, orders: true, positions: true,
    holdings: true, portfolio: true, trades: true, brokers: true,
    terminal: true, market: true, system: true, documentation: false,
  },
  available: true,
};

export const SERVICES_PHASE: PhaseConfig = {
  phaseId: 'services',
  group: 'services',
  appId: 'services',
  phaseName: 'Services',
  phaseShortName: 'Services',
  phaseFullName: 'KAUSTUBH Services',
  phaseTagline: 'System status, security and infrastructure',
  phaseDescription:
    'System status monitoring, WebSocket engine, security controls and infrastructure management.',
  phaseThemeColor: '#8B5CF6',
  phaseAltThemeColor: '#7C3AED',
  phaseHomePath: '/services/system',
  phaseSettingsPath: '/services/settings',
  groupLabel: 'Services',
  groupDescription:
    'System health, security, monitoring and platform infrastructure.',
  icon: Server,
  monogram: 'SV',
  defaultBrightness: 'system',
  defaultAccent: 'ocean',
  statusIndicators: [
    { id: 'net', label: 'Network', shortLabel: 'NET', source: 'backend health/realtime state', eventType: 'network.updated' },
    { id: 'ws', label: 'WebSocket', shortLabel: 'WS', source: 'WebSocket engine', eventType: 'websocket.connected' },
    { id: 'db', label: 'Database', shortLabel: 'DB', source: 'backend database health', eventType: 'database.connected' },
    { id: 'sched', label: 'Scheduler', shortLabel: 'SCHED', source: 'scheduler service', eventType: 'scheduler.started' },
    { id: 'sess', label: 'Session', shortLabel: 'SESS', source: 'session service', eventType: 'session.logged_in' },
  ],
  searchScopes: {
    stocks: false, instruments: false, ticks: false, subscriptions: false,
    dataCenter: false, dataQuality: false, tickAnalytics: false,
    alerts: true, notifications: true, schedules: false, downloads: false, settings: true,
    symbols: false, watchlist: false, orders: false, positions: false,
    holdings: false, portfolio: false, trades: false, brokers: false,
    terminal: false, market: false, system: true, documentation: false,
  },
  available: true,
};

export const KHUMBHA_AI_PHASE: PhaseConfig = {
  phaseId: 'khumbha-ai',
  group: 'khumbha-ai',
  appId: 'khumbha-ai',
  phaseName: 'Khumbha AI',
  phaseShortName: 'Khumbha AI',
  phaseFullName: 'KAUSTUBH Khumbha AI',
  phaseTagline: 'Models, datasets, training, inference and agents',
  phaseDescription:
    'AI model training, inference, dataset management and agent orchestration for the KAUSTUBH platform.',
  phaseThemeColor: '#06B6D4',
  phaseAltThemeColor: '#0891B2',
  phaseHomePath: '/ai/dashboard',
  phaseSettingsPath: '/ai/settings',
  groupLabel: 'Khumbha AI',
  groupDescription:
    'Artificial intelligence models, training pipelines and inference runtime.',
  icon: BrainCircuit,
  monogram: 'KA',
  defaultBrightness: 'dark',
  defaultAccent: 'purple',
  statusIndicators: [
    { id: 'net', label: 'Network', shortLabel: 'NET', source: 'backend health/realtime state', eventType: 'network.updated' },
    { id: 'db', label: 'Database', shortLabel: 'DB', source: 'backend database health', eventType: 'database.connected' },
    { id: 'sched', label: 'Scheduler', shortLabel: 'SCHED', source: 'scheduler service', eventType: 'scheduler.started' },
  ],
  searchScopes: {
    stocks: false, instruments: false, ticks: false, subscriptions: false,
    dataCenter: false, dataQuality: false, tickAnalytics: false,
    alerts: false, notifications: false, schedules: false, downloads: false, settings: true,
    symbols: false, watchlist: false, orders: false, positions: false,
    holdings: false, portfolio: false, trades: false, brokers: false,
    terminal: false, market: false, system: true, documentation: true,
  },
  available: true,
};

/** Canonical phase registry — single source of truth for all phases. */
export const PHASE_REGISTRY: Record<string, PhaseConfig> = {
  'data-saver': DATA_SAVER_PHASE,
  trading: TRADING_PHASE,
  services: SERVICES_PHASE,
  'khumbha-ai': KHUMBHA_AI_PHASE,
};

/** Get phase config by app ID. */
export function getPhaseConfig(appId: string): PhaseConfig {
  return PHASE_REGISTRY[appId] ?? DATA_SAVER_PHASE;
}

/** Get all available phases (ordered). */
export function getAvailablePhases(): PhaseConfig[] {
  return [DATA_SAVER_PHASE, TRADING_PHASE, SERVICES_PHASE, KHUMBHA_AI_PHASE];
}

export type PhaseConfigMap = Record<string, PhaseConfig>;

/** PWA manifest identity for the phase (mirrors public/manifest-data.json). */
export const PHASE_MANIFEST = {
  name: 'KAUSTUBH Data Saver',
  shortName: 'Data Saver',
  id: 'kaustubh-data-saver',
  startUrl: '/data-saver/dashboard',
  scope: '/data-saver/',
  display: 'standalone' as const,
  themeColor: DATA_SAVER_PHASE.phaseThemeColor,
  backgroundColor: '#FDFBF7',
  icon192: '/icon-192.png',
  icon512: '/icon-512.png',
  maskable: '/icon-512-maskable.png',
};