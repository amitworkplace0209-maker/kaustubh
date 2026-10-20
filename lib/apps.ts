// Canonical KAUSTUBH application registry.
//
// Single source of truth for the four application experiences:
//   Trading Terminal, Data Saver, Services, Khumbha AI
//
// This module must stay free of imports from the theme engine (lib/phase2-theme)
// to avoid a runtime import cycle. The theme engine imports the AppId type only.

import type { LucideIcon } from 'lucide-react';
import {
  CandlestickChart,
  Database,
  Server,
  BrainCircuit,
} from 'lucide-react';

export type AppId = 'trading' | 'data-saver' | 'services' | 'khumbha-ai';

export interface KaustubhApp {
  id: AppId;
  /** Human friendly application name (used in the KAUSTUBH switcher). */
  name: string;
  /** Compact label for tight layouts / mobile. */
  shortName: string;
  /** Uppercased brand line shown under the monogram. */
  brand: string;
  /** Short one-line description shown in the phase switcher menu. */
  description: string;
  /** Icon shown in the GlobalTopBar phase selector. */
  icon: LucideIcon;
  /** Two-letter monogram shown in the sidebar header. */
  monogram: string;
  /** Default landing route when switching to this application. */
  defaultRoute: string;
  /** PWA manifest + start_url identity. */
  manifest: string;
  pwaName: string;
}

export const KAUSTUBH_APPS: KaustubhApp[] = [
  {
    id: 'trading',
    name: 'Trading Terminal',
    shortName: 'Trading',
    brand: 'TRADING TERMINAL',
    description: 'Live market watch, orders, positions and portfolio management',
    icon: CandlestickChart,
    monogram: 'TT',
    defaultRoute: '/trading/dashboard',
    manifest: '/manifest-trading.json',
    pwaName: 'KAUSTUBH Trading',
  },
  {
    id: 'data-saver',
    name: 'Data Saver',
    shortName: 'Data Saver',
    brand: 'DATA SAVER',
    description: 'Stock subscriptions, live ticks, downloads and market data analytics',
    icon: Database,
    monogram: 'DS',
    defaultRoute: '/data-saver/dashboard',
    manifest: '/manifest-data.json',
    pwaName: 'KAUSTUBH Data Saver',
  },
  {
    id: 'services',
    name: 'Services',
    shortName: 'Services',
    brand: 'SERVICES',
    description: 'System status, security and infrastructure monitoring',
    icon: Server,
    monogram: 'SV',
    defaultRoute: '/services/system',
    manifest: '/manifest-services.json',
    pwaName: 'KAUSTUBH Services',
  },
  {
    id: 'khumbha-ai',
    name: 'Khumbha AI',
    shortName: 'Khumbha AI',
    brand: 'KHUMBHA AI',
    description: 'Models, datasets, training, inference and agents',
    icon: BrainCircuit,
    monogram: 'KA',
    defaultRoute: '/ai/dashboard',
    manifest: '/manifest-ai.json',
    pwaName: 'KAUSTUBH Khumbha AI',
  },
];

const APP_BY_ID = Object.fromEntries(KAUSTUBH_APPS.map((a) => [a.id, a])) as Record<AppId, KaustubhApp>;

export function getAppById(id: AppId): KaustubhApp {
  return APP_BY_ID[id];
}

/** Detect which application a pathname belongs to. */
export function getAppByPath(pathname: string): AppId {
  if (pathname.startsWith('/trading')) return 'trading';
  if (pathname.startsWith('/data-saver')) return 'data-saver';
  if (pathname.startsWith('/services')) return 'services';
  if (pathname.startsWith('/ai')) return 'khumbha-ai';
  return 'trading';
}

export function isAppId(value: string): value is AppId {
  return value in APP_BY_ID;
}

/** The ideal accent preset per application (used only until the user overrides). */
export const APP_DEFAULT_PRESET: Record<AppId, string> = {
  trading: 'emerald',
  'data-saver': 'saffron',
  services: 'ocean',
  'khumbha-ai': 'purple',
};