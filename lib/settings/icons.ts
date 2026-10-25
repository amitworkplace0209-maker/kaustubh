import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Database,
  Fingerprint,
  Gauge,
  Globe,
  HardDrive,
  Info,
  LayoutGrid,
  Lock,
  Palette,
  PlugZap,
  Printer,
  Radar,
  Save,
  Shield,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
} from 'lucide-react';

export const ICONS: Record<string, LucideIcon> = {
  Activity,
  Bell,
  Database,
  Fingerprint,
  Gauge,
  Globe,
  HardDrive,
  Info,
  LayoutGrid,
  Lock,
  Palette,
  PlugZap,
  Printer,
  Radar,
  Save,
  Shield,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
};

export function iconFor(name: string): LucideIcon {
  return ICONS[name] ?? LayoutGrid;
}