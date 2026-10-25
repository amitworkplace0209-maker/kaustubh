import {
  LayoutDashboard, Briefcase, ShoppingCart, User, Settings as SettingsIcon,
  Bell, TrendingUp, Calculator as CalcIcon, PieChart, History, BarChart3,
  IndianRupee, CandlestickChart, Table, Download, ScrollText, Server,
  Database, FileText, HardDrive, Activity, Shield, Wifi, RefreshCw,
  Package, Clock, Zap, Globe, Search, Layers, RadioTower, Brain,
  Cpu, Sparkles, BookOpen, Boxes,
} from 'lucide-react';

export type WorkspaceId = 'trading' | 'data' | 'services' | 'ai';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export interface WorkspaceNav {
  id: WorkspaceId;
  label: string;
  shortLabel: string;
  description: string;
  icon: React.ElementType;
  accentColor: string;
  accentHex: string;
  bgBase: string;
  bgCard: string;
  borderAccent: string;
  iconBg: string;
  groups: NavGroup[];
}

export const WORKSPACE_NAVS: Record<WorkspaceId, WorkspaceNav> = {
  trading: {
    id: 'trading',
    label: 'TRADING TERMINAL',
    shortLabel: 'Trading',
    description: 'Trade, orders, positions, holdings, P&L and account management',
    icon: TrendingUp,
    accentColor: 'emerald',
    accentHex: '#10b981',
    bgBase: 'bg-[#06120F]',
    bgCard: 'bg-[#0A1714]',
    borderAccent: 'border-emerald-500/30',
    iconBg: 'bg-gradient-to-br from-emerald-500 to-teal-600',
    groups: [
      {
        label: 'Main',
        items: [
          { href: '/trading/dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { href: '/trading/orders', label: 'Orders', icon: ShoppingCart },
          { href: '/trading/positions', label: 'Positions', icon: Briefcase },
          { href: '/trading/holdings', label: 'Holdings', icon: PieChart },
          { href: '/trading/portfolio', label: 'Portfolio', icon: Layers },
          { href: '/trading/funds', label: 'Account', icon: User },
        ],
      },
      {
        label: 'Trading',
        items: [
          { href: '/trading/order-history', label: 'Order History', icon: History },
          { href: '/trading/calculator', label: 'Calculator', icon: CalcIcon },
          { href: '/trading/market-watch', label: 'Market Watch', icon: BarChart3 },
        ],
      },
      {
        label: 'Other',
        items: [
          { href: '/trading/notifications', label: 'Notifications', icon: Bell },
          { href: '/trading/settings', label: 'Settings', icon: SettingsIcon },
        ],
      },
    ],
  },
  data: {
    id: 'data',
    label: 'DATA SAVER',
    shortLabel: 'Data Saver',
    description: 'Market data collection, storage, analytics and monitoring',
    icon: RadioTower,
    accentColor: 'amber',
    accentHex: '#F59E0B',
    bgBase: 'bg-[#FDFBF7]',
    bgCard: 'bg-white',
    borderAccent: 'border-amber-500/30',
    iconBg: 'bg-gradient-to-br from-amber-500 to-orange-600',
    groups: [
      {
        label: 'Main',
        items: [
          { href: '/data-saver/dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { href: '/data-saver/subscription', label: 'Stock Subscription', icon: RadioTower },
          { href: '/data-saver/ticks', label: 'Live Tick Table', icon: Table },
          { href: '/data-saver/watch', label: 'Market Watch', icon: BarChart3 },
        ],
      },
      {
        label: 'Data Management',
        items: [
          { href: '/data-saver/data-center', label: 'Data Center', icon: Database },
          { href: '/data-saver/formats', label: 'Formats', icon: FileText },
          { href: '/data-saver/schedules', label: 'Schedules', icon: Clock },
        ],
      },
      {
        label: 'Downloads',
        items: [
          { href: '/data-saver/downloads', label: 'Downloads', icon: Download },
          { href: '/data-saver/download-history', label: 'Download History', icon: History },
        ],
      },
      {
        label: 'Analytics',
        items: [
          { href: '/data-saver/quality', label: 'Data Quality', icon: Activity },
          { href: '/data-saver/analytics', label: 'Tick Analytics', icon: BarChart3 },
          { href: '/data-saver/insights', label: 'Data Insights', icon: Search },
        ],
      },
      {
        label: 'Settings',
        items: [
          { href: '/data-saver/configuration', label: 'Configuration', icon: SettingsIcon },
          { href: '/data-saver/alerts', label: 'Alerts', icon: Bell },
          { href: '/data-saver/websocket', label: 'WebSocket', icon: Wifi },
        ],
      },
    ],
  },
  services: {
    id: 'services',
    label: 'SERVICES',
    shortLabel: 'Services',
    description: 'System health, logs, security, backend services and infrastructure',
    icon: Server,
    accentColor: 'violet',
    accentHex: '#8b5cf6',
    bgBase: 'bg-[#100A19]',
    bgCard: 'bg-[#160D20]',
    borderAccent: 'border-violet-500/30',
    iconBg: 'bg-gradient-to-br from-violet-500 to-purple-600',
    groups: [
      {
        label: 'System',
        items: [
          { href: '/services/system', label: 'System Status', icon: Activity },
          { href: '/services/system-indicators', label: 'System Indicators', icon: Zap },
          { href: '/services/logs', label: 'Logs', icon: ScrollText },
        ],
      },
      {
        label: 'Security',
        items: [
          { href: '/services/security', label: 'Security', icon: Shield },
        ],
      },
      {
        label: 'Monitoring',
        items: [
          { href: '/services/notifications', label: 'Notifications', icon: Bell },
          { href: '/services/settings', label: 'Settings', icon: SettingsIcon },
        ],
      },
    ],
  },
  ai: {
    id: 'ai',
    label: 'KHUMBHA AI',
    shortLabel: 'Khumbha AI',
    description: 'Local AI engine: models, datasets, training, inference, agents and infrastructure',
    icon: Brain,
    accentColor: 'cyan',
    accentHex: '#06b6d4',
    bgBase: 'bg-[#051218]',
    bgCard: 'bg-[#0A1A22]',
    borderAccent: 'border-cyan-500/30',
    iconBg: 'bg-gradient-to-br from-cyan-500 to-sky-600',
    groups: [
      {
        label: 'Main',
        items: [
          { href: '/ai/dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { href: '/ai/models', label: 'Models', icon: Boxes },
          { href: '/ai/datasets', label: 'Datasets', icon: Database },
          { href: '/ai/training', label: 'Training', icon: Cpu },
        ],
      },
      {
        label: 'Runtime',
        items: [
          { href: '/ai/inference', label: 'Inference', icon: Sparkles },
          { href: '/ai/agents', label: 'Agents', icon: Layers },
          { href: '/ai/suggestions', label: 'Suggestions', icon: BookOpen },
        ],
      },
      {
        label: 'Infrastructure',
        items: [
          { href: '/ai/infrastructure', label: 'Infrastructure', icon: Globe },
          { href: '/ai/jobs', label: 'Jobs', icon: History },
          { href: '/ai/logs', label: 'Logs', icon: ScrollText },
          { href: '/ai/settings', label: 'Settings', icon: SettingsIcon },
        ],
      },
    ],
  },
};

export function getWorkspaceByPath(pathname: string): WorkspaceId {
  if (pathname.startsWith('/trading')) return 'trading';
  if (pathname.startsWith('/data-saver')) return 'data';
  if (pathname.startsWith('/data') || pathname.startsWith('/phase2')) return 'data';
  if (pathname.startsWith('/services')) return 'services';
  if (pathname.startsWith('/ai')) return 'ai';
  return 'trading';
}

export function getWorkspaceNav(id: WorkspaceId): WorkspaceNav {
  return WORKSPACE_NAVS[id];
}

export const WORKSPACE_LIST = Object.values(WORKSPACE_NAVS);
