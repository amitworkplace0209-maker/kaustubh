export type SystemId = 'trading' | 'data' | 'services';

export type SystemTheme = {
  id: SystemId;
  label: string;
  accent: string;
  accentHex: string;
  gradient: string;
  glow: string;
  border: string;
  iconBg: string;
};

const SYSTEM_THEMES: Record<SystemId, SystemTheme> = {
  trading: {
    id: 'trading',
    label: 'TRADING TERMINAL',
    accent: 'text-emerald-400',
    accentHex: '#10b981',
    gradient: 'from-emerald-600 to-teal-700',
    glow: 'shadow-emerald-500/25',
    border: 'border-emerald-500/30',
    iconBg: 'bg-gradient-to-br from-emerald-500 to-teal-600',
  },
  data: {
    id: 'data',
    label: 'DATA SERVER',
    accent: 'text-blue-400',
    accentHex: '#3b82f6',
    gradient: 'from-blue-600 to-cyan-700',
    glow: 'shadow-blue-500/25',
    border: 'border-blue-500/30',
    iconBg: 'bg-gradient-to-br from-blue-500 to-cyan-600',
  },
  services: {
    id: 'services',
    label: 'SERVICES',
    accent: 'text-violet-400',
    accentHex: '#8b5cf6',
    gradient: 'from-violet-600 to-purple-700',
    glow: 'shadow-violet-500/25',
    border: 'border-violet-500/30',
    iconBg: 'bg-gradient-to-br from-violet-500 to-purple-600',
  },
};

const TRADING_PATHS = ['/dashboard', '/positions', '/orders', '/calculator', '/funds', '/market-watch', '/order-history', '/notifications'];
const DATA_PATHS = ['/stocks', '/live-ticks', '/downloads', '/holdings', '/portfolio'];
const SERVICES_PATHS = ['/system', '/system-indicators', '/logs', '/settings'];

export function detectSystem(pathname: string): SystemId {
  if (TRADING_PATHS.some(p => pathname.startsWith(p))) return 'trading';
  if (DATA_PATHS.some(p => pathname.startsWith(p))) return 'data';
  if (SERVICES_PATHS.some(p => pathname.startsWith(p))) return 'services';
  return 'trading';
}

export function getSystemTheme(system: SystemId): SystemTheme {
  return SYSTEM_THEMES[system];
}

export function getSystemThemeByPath(pathname: string): SystemTheme {
  return getSystemTheme(detectSystem(pathname));
}
