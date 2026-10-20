'use client';
import { useEffect, useState, useCallback } from 'react';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard, Briefcase, ShoppingCart, User, Settings as SettingsIcon,
  MoreHorizontal, Bell, Moon, Sun, Wifi, WifiOff, TrendingUp, X,
  CandlestickChart, Table, Download, ScrollText, Server,
  PieChart, History, BarChart3, Coins, IndianRupee, LogIn, LogOut, Loader2, CheckCircle2, AlertCircle,
  Calculator as CalcIcon, ChevronDown, Database, ArrowUpRight,
} from 'lucide-react';
import NotificationBell from '@/components/orders/notification-bell';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { getSettingsStore } from '@/lib/settings-store';
import { triggerLogin } from '@/lib/api';
import { detectSystem, getSystemTheme, type SystemId } from '@/lib/systems';
import { useSystem } from '@/components/system-provider';

const phase2Nav = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/positions', label: 'Position', icon: Briefcase },
  { href: '/orders', label: 'Order', icon: ShoppingCart },
  { href: '/calculator', label: 'Calculator', icon: CalcIcon },
  { href: '/funds', label: 'Account', icon: User },
  { href: '/market-watch', label: 'Stock', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

const phase1Nav = [
  { href: '/system-indicators', label: 'System Indicators', icon: Server },
  { href: '/stocks', label: 'Stock Subscription', icon: CandlestickChart },
  { href: '/live-ticks', label: 'Live Tick Table', icon: Table },
  { href: '/downloads', label: 'Data Center', icon: Download },
  { href: '/holdings', label: 'Holdings', icon: PieChart },
  { href: '/portfolio', label: 'Portfolio', icon: PieChart },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/logs', label: 'Logs', icon: ScrollText },
  { href: '/system', label: 'System Status', icon: Server },
  { href: '/order-history', label: 'Order History', icon: History },
];

const bottomNav = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/positions', label: 'Position', icon: Briefcase },
  { href: '/orders', label: 'Order', icon: ShoppingCart },
  { href: '/funds', label: 'Account', icon: User },
  { href: '/market-watch', label: 'Stock', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

const isActive = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

export function Sidebar() {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);
  const systemTheme = getSystemTheme(detectSystem(pathname));

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex h-screen w-64 flex-col border-r bg-card/95 backdrop-blur-sm">
        <div className="flex h-16 items-center gap-2.5 border-b px-5">
          <div className={cn('flex h-9 w-9 items-center justify-center rounded-xl shadow-soft', systemTheme.iconBg)}>
            <TrendingUp className="h-5 w-5 text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-base font-bold tracking-tight">KAUSTUBH</span>
            <span className={cn('text-[10px] font-medium uppercase tracking-wider', systemTheme.accent)}>
              {systemTheme.label}
            </span>
          </div>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto p-3">
          <div className="space-y-1">
            <p className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Main</p>
            {phase2Nav.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
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
              const active = isActive(pathname, item.href);
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
           
            Toggle Theme
          </Button>
        </div>
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-16">
          {bottomNav.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
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
              <Link href="/calculator" onClick={() => setMoreOpen(false)}
                className={cn('flex items-center gap-2 rounded-lg p-3 text-sm font-medium transition-colors',
                  isActive(pathname, '/calculator') ? 'bg-primary text-primary-foreground' : 'bg-muted/50 hover:bg-muted')}>
                <CalcIcon className="h-4 w-4 shrink-0" />Calculator
              </Link>
              {phase1Nav.map((item) => {
                const Icon = item.icon;
                const active = isActive(pathname, item.href);
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
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { data: systemData, refresh: refreshSystem } = useSystem();
  const [connected, setConnected] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [accountMode, setAccountMode] = useState<'demo' | 'api'>('demo');
  const [loginOpen, setLoginOpen] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginResult, setLoginResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [systemMenuOpen, setSystemMenuOpen] = useState(false);
  const { toast } = useToast();
  const kotakLoggedIn = Boolean((systemData as { pythonStatus?: { logged_in?: boolean } } | null)?.pythonStatus?.logged_in);

  const currentSystem = (() => {
    if (['/stocks', '/live-ticks', '/downloads', '/downloads/formats', '/downloads/schedules', '/market-watch'].some(p => pathname.startsWith(p))) return 'DATA SERVER';
    if (['/system', '/system-indicators', '/logs', '/settings'].some(p => pathname.startsWith(p))) return 'SERVICES';
    return 'TRADING TERMINAL';
  })();

  const systemTheme = getSystemTheme(detectSystem(pathname));

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/login', { method: 'DELETE' });
      router.push('/login');
    } catch {
      toast({ title: 'Logout failed', description: 'Could not end session' });
    }
  };

  useEffect(() => {
    setMounted(true);
    const store = getSettingsStore();
    setAccountMode(store.getMode());
    const unsub = store.subscribe(() => setAccountMode(store.getMode()));
    return unsub;
  }, []);

  const refreshKotakStatus = useCallback(() => {
    refreshSystem();
  }, [refreshSystem]);

  useEffect(() => {
    refreshKotakStatus();
    const onSessionChange = () => { refreshKotakStatus(); };
    window.addEventListener('kotak-session-changed', onSessionChange);
    return () => {
      window.removeEventListener('kotak-session-changed', onSessionChange);
    };
  }, [refreshKotakStatus]);

  const handleManualLogin = async () => {
    setLoggingIn(true);
    setLoginResult(null);
    try {
      const res = await triggerLogin();
      const ok = Boolean(res?.ok);
      setLoginResult({ ok, message: String(res?.message ?? (ok ? 'Login successful' : 'Login failed')) });
      if (ok) toast({ title: 'Kotak Logged In', description: 'Broker session established' });
      window.dispatchEvent(new Event('kotak-session-changed'));
    } catch (err) {
      setLoginResult({ ok: false, message: err instanceof Error ? err.message : 'Login request failed' });
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b bg-card/95 px-4 backdrop-blur-sm md:px-6">
      <div className="flex items-center gap-2">
        <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg md:hidden', systemTheme.iconBg)}>
          <TrendingUp className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-bold tracking-tight hidden md:inline">KAUSTUBH</span>
        <span className="text-sm font-bold tracking-tight md:hidden">KAUSTUBH</span>

        {/* System Switcher */}
        {mounted && pathname !== '/workspace' && (
          <div className="relative ml-2 hidden md:block">
            <button
              onClick={() => setSystemMenuOpen(!systemMenuOpen)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{currentSystem}</span>
              <ChevronDown className="h-3 w-3" />
            </button>
            {systemMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSystemMenuOpen(false)} />
                <div className="absolute left-0 top-full mt-1 z-50 w-56 bg-card border border-border rounded-xl shadow-xl p-1.5">
                  <Link href="/dashboard" onClick={() => setSystemMenuOpen(false)}
                    className={cn('flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      currentSystem === 'TRADING TERMINAL' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                    <TrendingUp className="h-4 w-4" />
                    Trading Terminal
                  </Link>
                  <Link href="/stocks" onClick={() => setSystemMenuOpen(false)}
                    className={cn('flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      currentSystem === 'DATA SERVER' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                    <Database className="h-4 w-4" />
                    Data Server
                  </Link>
                  <Link href="/system" onClick={() => setSystemMenuOpen(false)}
                    className={cn('flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      currentSystem === 'SERVICES' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                    <Server className="h-4 w-4" />
                    Services
                  </Link>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {mounted && systemData != null && kotakLoggedIn != null && (
          <Badge
            variant="outline"
            className={cn(
              'hidden sm:flex text-xs gap-1.5 cursor-default',
              kotakLoggedIn
                ? 'border-success/40 text-success bg-success/5'
                : 'border-destructive/40 text-destructive bg-destructive/5'
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', kotakLoggedIn ? 'bg-success' : 'bg-destructive')} />
            {kotakLoggedIn ? 'Kotak Logged In' : 'Kotak Offline'}
          </Badge>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs font-medium"
          onClick={() => { setLoginResult(null); setLoginOpen(true); }}
        >
          <LogIn className="h-3.5 w-3.5 mr-1.5" />
          Manual Login
        </Button>
        <Badge
          variant="outline"
          className={cn(
            'hidden sm:flex text-xs gap-1.5 cursor-default',
            accountMode === 'demo'
              ? 'border-purple/40 text-purple bg-purple/5'
              : 'border-success/40 text-success bg-success/5'
          )}
        >
          <span className={cn(
            'h-2 w-2 rounded-full',
            accountMode === 'demo' ? 'bg-purple animate-pulse' : 'bg-success animate-pulse'
          )} />
          {accountMode === 'demo' ? 'DEMO' : 'API'}
          <span className="text-[10px] opacity-70">
            {accountMode === 'demo' ? 'Coins' : 'Kotak'}
          </span>
        </Badge>
        {connected ? (
          <Wifi className="h-4 w-4 text-success hidden sm:block" />
        ) : (
          <WifiOff className="h-4 w-4 text-destructive hidden sm:block" />
        )}
        <NotificationBell />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          {mounted && (theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />)}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
          onClick={handleLogout}
          aria-label="Logout"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      {/* Manual Kotak Login Dialog */}
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Kotak Manual Login</DialogTitle>
            <DialogDescription>
              Establish a broker session using the credentials stored securely on the server. No passwords are handled by the browser.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
              <span className="text-sm text-muted-foreground">Current session</span>
              {mounted && systemData != null ? (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-xs gap-1.5',
                    kotakLoggedIn
                      ? 'border-success/40 text-success bg-success/5'
                      : 'border-destructive/40 text-destructive bg-destructive/5'
                  )}
                >
                  <span className={cn('h-2 w-2 rounded-full', kotakLoggedIn ? 'bg-success' : 'bg-destructive')} />
                  {kotakLoggedIn ? 'Logged In' : 'Not logged in'}
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground">Checking…</span>
              )}
            </div>

            {loginResult && (
              <div
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
                  loginResult.ok
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-destructive/30 bg-destructive/10 text-destructive'
                )}
              >
                {loginResult.ok
                  ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                  : <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
                <span className="font-medium break-words">{loginResult.message}</span>
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setLoginOpen(false)} disabled={loggingIn}>
                Close
              </Button>
              <Button onClick={handleManualLogin} disabled={loggingIn}>
                {loggingIn ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Logging in…</>
                ) : (
                  <><LogIn className="h-4 w-4 mr-2" /> Login to Kotak</>
                )}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
