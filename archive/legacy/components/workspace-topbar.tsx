'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, LogOut, LogIn, Loader2, CheckCircle2, AlertCircle, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { getSettingsStore } from '@/lib/settings-store';
import { triggerLogin } from '@/lib/api';
import { useWorkspace } from '@/components/workspace-provider';
import { WORKSPACE_LIST, type WorkspaceId } from '@/lib/workspace-nav';
import { useSystem, type SystemData } from '@/components/system-provider';
import NotificationBell from '@/components/orders/notification-bell';

const WORKSPACE_COLORS: Record<WorkspaceId, { accent: string; dot: string }> = {
  trading: { accent: 'text-emerald-400', dot: 'bg-emerald-400' },
  data: { accent: 'text-amber-400', dot: 'bg-amber-400' },
  services: { accent: 'text-violet-400', dot: 'bg-violet-400' },
  ai: { accent: 'text-cyan-400', dot: 'bg-cyan-400' },
};

export function WorkspaceTopBar() {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
  const router = useRouter();
  const { workspace, switchWorkspace } = useWorkspace();
  const { data: systemData, refresh: refreshSystem } = useSystem();
  const { toast } = useToast();
  const [mounted, setMounted] = useState(false);
  const [accountMode, setAccountMode] = useState<'demo' | 'api'>('demo');
  const [loginOpen, setLoginOpen] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginResult, setLoginResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const kotakLoggedIn = Boolean((systemData as SystemData)?.pythonStatus?.logged_in);

  const currentNav = WORKSPACE_LIST.find((w) => w.id === workspace);
  const wsColors = WORKSPACE_COLORS[workspace];

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

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/login', { method: 'DELETE' });
      router.push('/login');
    } catch {
      toast({ title: 'Logout failed', description: 'Could not end session' });
    }
  };

  const handleLockApp = async () => {
    try { await fetch('/api/auth/login', { method: 'DELETE' }); } catch { /* ignore */ }
    window.location.href = '/login';
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border px-4 backdrop-blur-sm md:px-6 bg-background/95">
      <div className="flex items-center gap-3">
        {/* Workspace Switcher */}
        <div className="relative">
          <button
            onClick={() => setSwitcherOpen(!switcherOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold text-white hover:bg-white/[0.06] transition-colors"
          >
            <span className="hidden md:inline">KAUSTUBH</span>
            <span className="h-1 w-1 rounded-full bg-white/20 hidden md:block" />
            <span className={cn('text-xs font-bold uppercase tracking-wider', wsColors?.accent)}>
              {currentNav?.shortLabel || 'Trading'}
            </span>
            <ChevronDown className={cn(
              'h-3 w-3 text-white/40 transition-transform duration-200',
              switcherOpen && 'rotate-180'
            )} />
          </button>
          {switcherOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSwitcherOpen(false)} />
              <div className="absolute left-0 top-full mt-1 z-50 w-60 rounded-xl border border-border shadow-2xl p-1.5 bg-popover">
                {WORKSPACE_LIST.map((ws) => {
                  const Icon = ws.icon;
                  const active = workspace === ws.id;
                  const colors = WORKSPACE_COLORS[ws.id];
                  return (
                    <button
                      key={ws.id}
                      onClick={() => {
                        switchWorkspace(ws.id);
                        setSwitcherOpen(false);
                      }}
                      className={cn(
                        'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left',
                        active ? 'bg-white/[0.08] text-white' : 'text-white/50 hover:bg-white/[0.04] hover:text-white/80'
                      )}
                    >
                      <div className={cn('h-7 w-7 rounded-lg flex items-center justify-center', ws.iconBg)}>
                        <Icon className="h-3.5 w-3.5 text-white" />
                      </div>
                      <div className="flex-1">
                        <p className="text-xs font-semibold">{ws.label}</p>
                      </div>
                      {active && <div className={cn('h-1.5 w-1.5 rounded-full', colors?.dot)} />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {mounted && systemData != null && (
          <Badge
            variant="outline"
            className={cn(
              'hidden sm:flex text-xs gap-1.5 cursor-default border-white/[0.1]',
              kotakLoggedIn
                ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30'
                : 'text-red-400 bg-red-400/10 border-red-400/30'
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', kotakLoggedIn ? 'bg-emerald-400' : 'bg-red-400')} />
            {kotakLoggedIn ? 'Kotak' : 'Offline'}
          </Badge>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs font-medium border-white/[0.1] text-white/60 hover:text-white hover:bg-white/[0.06]"
          onClick={() => { setLoginResult(null); setLoginOpen(true); }}
        >
          <LogIn className="h-3.5 w-3.5 mr-1.5" />
          <span className="hidden sm:inline">Kotak Login</span>
        </Button>
        <Badge
          variant="outline"
          className={cn(
            'hidden sm:flex text-xs gap-1.5 cursor-default border-white/[0.1]',
            accountMode === 'demo'
              ? 'text-violet-400 bg-violet-400/10'
              : 'text-emerald-400 bg-emerald-400/10'
          )}
        >
          <span className={cn('h-2 w-2 rounded-full', accountMode === 'demo' ? 'bg-violet-400 animate-pulse' : 'bg-emerald-400 animate-pulse')} />
          {accountMode === 'demo' ? 'DEMO' : 'LIVE'}
        </Badge>
        {mounted && (
          <Wifi className="h-4 w-4 text-emerald-400 hidden sm:block" />
        )}
        <NotificationBell />
        <ThemeSwitcher />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-white/40 hover:text-red-400"
          onClick={handleLockApp}
          aria-label="Lock App"
          title="Lock application"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-white/40 hover:text-red-400"
          onClick={handleLogout}
          aria-label="Logout"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      {/* Manual Kotak Login Dialog */}
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="max-w-md bg-popover border-border">
          <DialogHeader>
            <DialogTitle className="text-white">Kotak Manual Login</DialogTitle>
            <DialogDescription className="text-white/50">
              Establish a broker session using the credentials stored securely on the server.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
              <span className="text-sm text-white/60">Broker session</span>
              {mounted && kotakLoggedIn != null ? (
                <Badge variant="outline" className={cn(
                  'text-xs gap-1.5 border-white/10',
                  kotakLoggedIn ? 'text-emerald-400 bg-emerald-400/10' : 'text-red-400 bg-red-400/10'
                )}>
                  <span className={cn('h-2 w-2 rounded-full', kotakLoggedIn ? 'bg-emerald-400' : 'bg-red-400')} />
                  {kotakLoggedIn ? 'Logged In' : 'Not logged in'}
                </Badge>
              ) : (
                <span className="text-xs text-white/40">Checking...</span>
              )}
            </div>
            {loginResult && (
              <div className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
                loginResult.ok
                  ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-400'
                  : 'border-red-400/30 bg-red-400/10 text-red-400'
              )}>
                {loginResult.ok
                  ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                  : <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
                <span className="font-medium break-words">{loginResult.message}</span>
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setLoginOpen(false)} disabled={loggingIn}
                className="border-white/10 text-white/60 hover:text-white hover:bg-white/5">
                Close
              </Button>
              <Button onClick={handleManualLogin} disabled={loggingIn}
                className="bg-emerald-600 hover:bg-emerald-500 text-white">
                {loggingIn ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Logging in...</>
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
