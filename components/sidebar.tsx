'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Briefcase, ShoppingCart, User, Settings as SettingsIcon,
  MoreHorizontal, Bell, Moon, Sun, Wifi, WifiOff, TrendingUp, X,
  Activity, CandlestickChart, Table, Download, ScrollText, Server,
  PieChart, History, BarChart3,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

const phase2Nav = [
  { href: '/trading', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/positions', label: 'Position', icon: Briefcase },
  { href: '/orders', label: 'Order', icon: ShoppingCart },
  { href: '/funds', label: 'Account', icon: User },
  { href: '/market-watch', label: 'Stock', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

const phase1Nav = [
  { href: '/dashboard', label: 'System Indicators', icon: Activity },
  { href: '/stocks', label: 'Stock Subscription', icon: CandlestickChart },
  { href: '/live-ticks', label: 'Live Tick Table', icon: Table },
  { href: '/downloads', label: 'Custom Download', icon: Download },
  { href: '/holdings', label: 'Holdings', icon: PieChart },
  { href: '/portfolio', label: 'Portfolio', icon: PieChart },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/logs', label: 'Logs', icon: ScrollText },
  { href: '/system', label: 'System Status', icon: Server },
  { href: '/order-history', label: 'Order History', icon: History },
];

const bottomNav = [
  { href: '/trading', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/positions', label: 'Position', icon: Briefcase },
  { href: '/orders', label: 'Order', icon: ShoppingCart },
  { href: '/funds', label: 'Account', icon: User },
  { href: '/market-watch', label: 'Stock', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar() {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex h-screen w-64 flex-col border-r bg-card/95 backdrop-blur-sm">
        <div className="flex h-16 items-center gap-2.5 border-b px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-teal-600 shadow-soft">
            <TrendingUp className="h-5 w-5 text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-base font-bold tracking-tight">KAUSTUBH</span>
            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Trading Platform</span>
          </div>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto p-3">
          <div className="space-y-1">
            <p className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Trading Terminal</p>
            {phase2Nav.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200',
                    active ? 'bg-primary text-primary-foreground shadow-soft' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}>
                  <Icon className="h-4 w-4 shrink-0" />{item.label}
                </Link>
              );
            })}
          </div>
          <div className="space-y-1">
            <p className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">More</p>
            {phase1Nav.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200',
                    active ? 'bg-primary text-primary-foreground shadow-soft' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}>
                  <Icon className="h-4 w-4 shrink-0" />{item.label}
                </Link>
              );
            })}
          </div>
        </nav>
        <div className="border-t p-3">
          <Button variant="ghost" size="sm" className="w-full justify-start gap-3 rounded-lg"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun className="h-4 w-4 text-amber-500" /> : <Moon className="h-4 w-4 text-purple-500" />}
            Toggle Theme
          </Button>
        </div>
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-16">
          {bottomNav.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}
                className={cn('flex flex-col items-center gap-0.5 px-2 py-1 text-xs transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground')}>
                <Icon className="h-5 w-5" />
                <span className="text-[10px]">{item.label}</span>
              </Link>
            );
          })}
          <button
            className="flex flex-col items-center gap-0.5 px-2 py-1 text-xs text-muted-foreground"
            onClick={() => setMoreOpen(true)}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="text-[10px]">More</span>
          </button>
        </div>
      </nav>

      {/* Mobile More Sheet */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-black/50" onClick={() => setMoreOpen(false)}>
          <div className="absolute bottom-0 left-0 right-0 bg-card rounded-t-2xl border-t p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] max-h-[70vh] overflow-y-auto animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">More Pages</h3>
              <Button size="sm" variant="ghost" onClick={() => setMoreOpen(false)}><X className="h-5 w-5" /></Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {phase1Nav.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <Link key={item.href} href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className={cn('flex items-center gap-2 rounded-lg p-3 text-sm font-medium transition-colors',
                      active ? 'bg-primary text-primary-foreground' : 'bg-muted/50 hover:bg-muted')}>
                    <Icon className="h-4 w-4 shrink-0" />{item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [connected, setConnected] = useState(true);
  const { toast } = useToast();

  const tradingMode = 'API';

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b bg-card/95 px-4 backdrop-blur-sm md:px-6">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-green-500 to-teal-600 md:hidden">
          <TrendingUp className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-bold tracking-tight hidden md:inline">KAUSTUBH Trading Platform</span>
        <span className="text-sm font-bold tracking-tight md:hidden">KAUSTUBH</span>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="hidden sm:flex text-xs">
          <span className={cn('h-2 w-2 rounded-full mr-1.5', connected ? 'bg-success' : 'bg-destructive')} />
          {tradingMode} Mode
        </Badge>
        {connected ? (
          <Wifi className="h-4 w-4 text-success hidden sm:block" />
        ) : (
          <WifiOff className="h-4 w-4 text-destructive hidden sm:block" />
        )}
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => toast({ title: 'No new notifications' })}>
          <Bell className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
          K
        </div>
      </div>
    </header>
  );
}
