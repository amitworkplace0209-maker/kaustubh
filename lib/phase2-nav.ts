import {
  LayoutDashboard,
  RadioTower,
  TableProperties,
  Eye,
  ListPlus,
  FileOutput,
  CalendarClock,
  Download,
  History,
  ShieldCheck,
  BrainCircuit,
  Settings,
  BellRing,
  Wifi,
  Palette,
  AlertTriangle,
  SlidersHorizontal,
  PlusCircle,
  Sun,
  Activity,
  XCircle,
  FileText,
  Smartphone,
  Lock,
  HardDrive,
  Accessibility,
  LockKeyhole,
  Fingerprint,
  Info,
} from 'lucide-react';

export type Phase2NavId =
  | 'dashboard'
  | 'subscription'
  | 'ticks'
  | 'watch'
  | 'watch-list'
  | 'formats'
  | 'formats-settings'
  | 'schedules'
  | 'schedules-new'
  | 'downloads'
  | 'download-history'
  | 'quality'
  | 'insights'
  | 'insights-attention'
  | 'insights-activity'
  | 'insights-errors'
  | 'insights-today'
  | 'insights-reports'
  | 'configuration'
  | 'settings'
  | 'theme'
  | 'settings-privacy'
  | 'settings-security'
  | 'settings-storage'
  | 'settings-accessibility'
  | 'settings-app-lock'
  | 'settings-biometric'
  | 'settings-pwa'
  | 'settings-about'
  | 'notifications'
  | 'alerts'
  | 'websocket';

export interface NavItem {
  id: Phase2NavId;
  href: string;
  label: string;
  icon: React.ElementType;
  /** Inner pages — the pages that live INSIDE this one. They are listed in
   *  the sidebar (never in the bottom bar) and the branch that owns the
   *  current route is expanded automatically. */
  children?: NavItem[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export interface Phase2Nav {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  accentHex: string;
  groups: NavGroup[];
}

export const PHASE2_ROUTES: Record<Phase2NavId, string> = {
  dashboard: '/data-saver/dashboard',
  subscription: '/data-saver/subscription',
  ticks: '/data-saver/ticks',
  watch: '/data-saver/watch',
  'watch-list': '/data-saver/watch-list',
  formats: '/data-saver/formats',
  'formats-settings': '/data-saver/formats/settings',
  schedules: '/data-saver/schedules',
  'schedules-new': '/data-saver/schedules/new',
  downloads: '/data-saver/downloads',
  'download-history': '/data-saver/download-history',
  quality: '/data-saver/quality',
  insights: '/data-saver/insights',
  'insights-attention': '/data-saver/insights/attention',
  'insights-activity': '/data-saver/insights/activity',
  'insights-errors': '/data-saver/insights/errors',
  'insights-today': '/data-saver/insights/today',
  'insights-reports': '/data-saver/insights/reports',
  configuration: '/data-saver/configuration',
  settings: '/data-saver/settings',
  theme: '/data-saver/settings/theme',
  'settings-privacy': '/data-saver/settings/privacy',
  'settings-security': '/data-saver/settings/security',
  'settings-storage': '/data-saver/settings/storage',
  'settings-accessibility': '/data-saver/settings/accessibility',
  'settings-app-lock': '/data-saver/settings/app-lock',
  'settings-biometric': '/data-saver/settings/biometric',
  'settings-pwa': '/data-saver/settings/pwa',
  'settings-about': '/data-saver/settings/about',
  notifications: '/data-saver/notifications',
  alerts: '/data-saver/alerts',
  websocket: '/data-saver/websocket',
};

export const PHASE2_NAV: Phase2Nav = {
  id: 'phase2',
  label: 'DATA SAVER',
  shortLabel: 'Phase 2',
  description: 'Stock subscriptions, live ticks, data management, downloads and analytics',
  accentHex: '#F59E0B',
  groups: [
    {
      label: 'MAIN',
      items: [
        { id: 'dashboard', href: '/data-saver/dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'subscription', href: '/data-saver/subscription', label: 'Stock Subscription', icon: RadioTower },
        { id: 'ticks', href: '/data-saver/ticks', label: 'Live Tick Table', icon: TableProperties },
        { id: 'watch', href: '/data-saver/watch', label: 'Market Watch', icon: Eye },
        { id: 'watch-list', href: '/data-saver/watch-list', label: 'Watch List', icon: ListPlus },
      ],
    },
    {
      label: 'DATA MANAGEMENT',
      items: [
        {
          id: 'formats',
          href: '/data-saver/formats',
          label: 'Formats & Fields',
          icon: FileOutput,
          children: [
            { id: 'formats-settings', href: '/data-saver/formats/settings', label: 'Format Settings', icon: SlidersHorizontal },
          ],
        },
        {
          id: 'schedules',
          href: '/data-saver/schedules',
          label: 'Schedules',
          icon: CalendarClock,
          children: [
            { id: 'schedules-new', href: '/data-saver/schedules/new', label: 'New Schedule', icon: PlusCircle },
          ],
        },
      ],
    },
    {
      label: 'DOWNLOADS',
      items: [
        { id: 'downloads', href: '/data-saver/downloads', label: 'Downloads', icon: Download },
        { id: 'download-history', href: '/data-saver/download-history', label: 'Download History', icon: History },
      ],
    },
    {
      label: 'ANALYTICS',
      items: [
        { id: 'quality', href: '/data-saver/quality', label: 'Data Quality', icon: ShieldCheck },
        {
          id: 'insights',
          href: '/data-saver/insights',
          label: 'Data Insights',
          icon: BrainCircuit,
          children: [
            { id: 'insights-today', href: '/data-saver/insights/today', label: 'Today', icon: Sun },
            { id: 'insights-activity', href: '/data-saver/insights/activity', label: 'Activity', icon: Activity },
            { id: 'insights-attention', href: '/data-saver/insights/attention', label: 'Needs Attention', icon: AlertTriangle },
            { id: 'insights-errors', href: '/data-saver/insights/errors', label: 'Errors', icon: XCircle },
            { id: 'insights-reports', href: '/data-saver/insights/reports', label: 'Reports', icon: FileText },
          ],
        },
      ],
    },
    {
      label: 'SETTINGS',
      items: [
        {
          id: 'settings',
          href: '/data-saver/settings',
          label: 'Settings',
          icon: Settings,
          children: [
            { id: 'theme', href: '/data-saver/settings/theme', label: 'Theme', icon: Palette },
            { id: 'settings-pwa', href: '/data-saver/settings/pwa', label: 'PWA & Install', icon: Smartphone },
            { id: 'settings-security', href: '/data-saver/settings/security', label: 'Security', icon: ShieldCheck },
            { id: 'settings-privacy', href: '/data-saver/settings/privacy', label: 'Privacy', icon: Lock },
            { id: 'settings-storage', href: '/data-saver/settings/storage', label: 'Storage', icon: HardDrive },
            { id: 'settings-accessibility', href: '/data-saver/settings/accessibility', label: 'Accessibility', icon: Accessibility },
            { id: 'settings-app-lock', href: '/data-saver/settings/app-lock', label: 'App Lock', icon: LockKeyhole },
            { id: 'settings-biometric', href: '/data-saver/settings/biometric', label: 'Biometric Unlock', icon: Fingerprint },
            { id: 'settings-about', href: '/data-saver/settings/about', label: 'About', icon: Info },
          ],
        },
        { id: 'notifications', href: '/data-saver/notifications', label: 'Notifications', icon: BellRing },
        { id: 'websocket', href: '/data-saver/websocket', label: 'WebSocket', icon: Wifi },
        { id: 'alerts', href: '/data-saver/alerts', label: 'Alerts', icon: AlertTriangle },
      ],
    },
  ],
};

export function getPhase2Nav(): Phase2Nav {
  return PHASE2_NAV;
}

export function getPhase2NavByPath(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const group of PHASE2_NAV.groups) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(item.href + '/')) {
        if (!best || item.href.length > best.href.length) best = item;
      }
    }
  }
  return best;
}
