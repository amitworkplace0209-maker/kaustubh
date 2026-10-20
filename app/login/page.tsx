'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { AUTH_EVENT } from '@/components/auth-provider';
import {
  TrendingUp, Lock, Eye, EyeOff, Loader2,
  Database, Server, AlertCircle, ChevronRight, Brain,
} from 'lucide-react';

type AppState = 'loading' | 'welcome' | 'locked' | 'unlocking' | 'workspace';

const WORKSPACE_DATA = [
  {
    id: 'trading',
    title: 'TRADING TERMINAL',
    description: 'Trade, orders, positions, holdings, P&L and account management',
    icon: TrendingUp,
    modules: 10,
    href: '/trading/dashboard',
    gradient: 'from-success to-teal',
    glow: 'shadow-success/25',
    border: 'border-success/30',
    hoverBorder: 'hover:border-success/60',
    bgTint: 'bg-success/5',
    textAccent: 'text-success',
    dotColor: 'bg-success',
    status: 'Broker Connected',
  },
  {
    id: 'data',
    title: 'DATA SAVER',
    description: 'Market data, stock subscriptions, live ticks, downloads and exports',
    icon: Database,
    modules: 6,
    href: '/data-saver/subscription',
    gradient: 'from-info to-teal',
    glow: 'shadow-info/25',
    border: 'border-info/30',
    hoverBorder: 'hover:border-info/60',
    bgTint: 'bg-info/5',
    textAccent: 'text-info',
    dotColor: 'bg-info',
    status: 'WebSocket Active',
  },
  {
    id: 'services',
    title: 'SERVICES',
    description: 'System health, logs, security, backend services and infrastructure',
    icon: Server,
    modules: 6,
    href: '/services/system',
    gradient: 'from-purple to-purple',
    glow: 'shadow-purple/25',
    border: 'border-purple/30',
    hoverBorder: 'hover:border-purple/60',
    bgTint: 'bg-purple/5',
    textAccent: 'text-purple',
    dotColor: 'bg-purple',
    status: 'Services Running',
  },
  {
    id: 'ai',
    title: 'KHUMBHA AI',
    description: 'Local AI engine: models, datasets, training, inference, agents and infrastructure',
    icon: Brain,
    modules: 8,
    href: '/ai/dashboard',
    gradient: 'from-teal to-info',
    glow: 'shadow-info/25',
    border: 'border-info/30',
    hoverBorder: 'hover:border-info/60',
    bgTint: 'bg-info/5',
    textAccent: 'text-info',
    dotColor: 'bg-info',
    status: 'AI Runtime Running',
  },
];

function PinInput({
  value, onChange, onComplete, disabled, error, autoFocus = true, length = 6,
}: {
  value: string[];
  onChange: (pin: string[]) => void;
  onComplete: (pin: string) => void;
  disabled?: boolean;
  error?: boolean;
  autoFocus?: boolean;
  length?: number;
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [showPin, setShowPin] = useState(false);

  useEffect(() => {
    if (autoFocus && !disabled) inputRefs.current[0]?.focus();
  }, [autoFocus, disabled]);

  const handleChange = (index: number, val: string) => {
    if (val.length > 1) return;
    if (val && !/^\d$/.test(val)) return;
    const newPin = [...value];
    newPin[index] = val;
    onChange(newPin);
    if (val && index < length - 1) inputRefs.current[index + 1]?.focus();
    if (val && index === length - 1) {
      const fullPin = newPin.join('');
      if (fullPin.length === length) onComplete(fullPin);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !value[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (pasted) {
      const newPin = pasted.split('').concat(Array(length).fill('')).slice(0, length);
      onChange(newPin);
      const focusIndex = Math.min(pasted.length, length - 1);
      inputRefs.current[focusIndex]?.focus();
      if (pasted.length === length) onComplete(pasted);
    }
  };

  return (
    <div className="relative">
      <div className="flex justify-center gap-2.5 sm:gap-3" onPaste={handlePaste}>
        {value.map((digit, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el; }}
            type={showPin ? 'text' : 'password'}
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            disabled={disabled}
            aria-label={`PIN digit ${i + 1}`}
            className={`w-11 h-13 sm:w-13 sm:h-15 text-center text-xl font-bold rounded-xl transition-all duration-200 outline-none
              ${error
? 'bg-destructive/20 border-2 border-destructive/60 text-destructive focus:border-destructive focus:ring-1 focus:ring-destructive/30'
                : error
                  ? 'bg-white/[0.07] border-2 border-white/20 text-white focus:border-success focus:ring-1 focus:ring-success/30'
                  : 'bg-white/[0.04] border-2 border-white/10 text-white focus:border-success/60 focus:ring-1 focus:ring-success/20'
              }
              disabled:opacity-40 disabled:cursor-not-allowed`}
          />
        ))}
      </div>
      <div className="flex justify-center mt-3">
        <button type="button" onClick={() => setShowPin(!showPin)}
          className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/60 transition-colors" tabIndex={-1}>
          {showPin ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          {showPin ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

function AnimatedBackground() {
  return (
    <div className="fixed inset-0 z-0">
      <div className="absolute inset-0 bg-[#060a08]" />
      <div className="absolute inset-0" style={{
        background: 'radial-gradient(ellipse at 20% 50%, rgba(16,185,129,0.06) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(20,184,166,0.04) 0%, transparent 50%), radial-gradient(ellipse at 50% 80%, rgba(139,92,246,0.03) 0%, transparent 50%)',
      }} />
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full opacity-[0.04] blur-[120px] bg-success animate-[drift_20s_ease-in-out_infinite]" />
      <div className="absolute bottom-[-15%] right-[-10%] w-[40%] h-[40%] rounded-full opacity-[0.03] blur-[100px] bg-purple animate-[drift_25s_ease-in-out_infinite_reverse]" />
    </div>
  );
}

function LoginPageInner() {
  const router = useRouter();

  /**
   * The `?from=` deep link the proxy attached before redirecting here (e.g.
   * `/login?from=%2Ftrading%2Ftrade`). Previously it was read but never used,
   * so a signed-in user was always dropped on the workspace picker and had to
   * re-navigate by hand.
   *
   * Only same-origin, single-slash paths are accepted — `//evil.com` and
   * `/\evil.com` are protocol-relative URLs and would be an open redirect.
   *
   * It is read from `window.location` in an effect instead of through
   * `useSearchParams()`: that hook forces the whole prerendered tree ABOVE
   * its Suspense boundary — which here is the entire root layout — to be
   * client-side rendered, so the login screen arrived as an empty spinner
   * instead of a real page. The value is only needed for the post-login
   * redirect, which is a client-side concern anyway.
   */
  const [from, setFrom] = useState<string | null>(null);

  useEffect(() => {
    try {
      setFrom(new URLSearchParams(window.location.search).get('from'));
    } catch {
      setFrom(null);
    }
  }, []);

  const safeFrom = (() => {
    if (!from) return null;
    if (!from.startsWith('/')) return null;
    if (from.startsWith('//') || from.startsWith('/\\')) return null;
    if (from.startsWith('/login')) return null;
    return from;
  })();

  const [appState, setAppState] = useState<AppState>('loading');
  const [pin, setPin] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [mounted, setMounted] = useState(false);
  const [shake, setShake] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);

  const triggerShake = useCallback(() => {
    setShake(true);
    setTimeout(() => setShake(false), 500);
  }, []);

  useEffect(() => { setMounted(true); }, []);

  // Check if app lock is configured
  useEffect(() => {
    if (!mounted) return;
    const checkSetup = async () => {
      try {
        const res = await fetch('/api/auth/setup');
        const data = await res.json();
        setAppState(data.configured ? 'locked' : 'welcome');
      } catch {
        setAppState('welcome');
      }
    };
    checkSetup();
  }, [mounted]);

  // Direct login (no app lock)
  const handleDirectLogin = async () => {
    setLoggingIn(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direct: true }),
      });
      const data = await res.json();
      if (data.ok) {
        window.dispatchEvent(new Event(AUTH_EVENT));
        if (safeFrom) {
          router.replace(safeFrom);
          return;
        }
        setAppState('workspace');
      } else {
        setError(data.message || 'Login failed');
        triggerShake();
      }
    } catch {
      setError('Connection failed');
      triggerShake();
    }
    setLoggingIn(false);
  };

  // Unlock with PIN
  const handleUnlock = async (unlockPin: string) => {
    setAppState('unlocking');
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: unlockPin }),
      });
      const data = await res.json();
      if (data.ok) {
        window.dispatchEvent(new Event(AUTH_EVENT));
        if (safeFrom) {
          router.replace(safeFrom);
          return;
        }
        setAppState('workspace');
      } else {
        setAppState('locked');
        setError(data.message || 'Incorrect PIN');
        triggerShake();
        setPin(['', '', '', '', '', '']);
      }
    } catch {
      setAppState('locked');
      setError('Connection failed');
      triggerShake();
      setPin(['', '', '', '', '', '']);
    }
  };

  const handleWorkspaceSelect = (href: string) => {
    router.push(href);
  };

  if (!mounted) return null;

  // Loading
  if (appState === 'loading') {
    return (
      <>
        <AnimatedBackground />
        <div className="relative z-10 min-h-screen flex items-center justify-center p-4">
          <div className="text-center animate-fade-in">
            <div className="flex justify-center mb-5">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
                <TrendingUp className="h-8 w-8 text-white" />
              </div>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">KAUSTUBH</h1>
            <p className="text-xs text-white/30 mt-1.5 tracking-[0.2em] uppercase">Trading Platform</p>
            <div className="mt-8 flex items-center justify-center gap-2 text-white/40 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading...
            </div>
          </div>
        </div>
      </>
    );
  }

  // Workspace Selector
  if (appState === 'workspace') {
    return (
      <>
        <AnimatedBackground />
        <div className="relative z-10 min-h-screen flex items-center justify-center p-4">
          <div className="w-full max-w-4xl mx-auto animate-fade-in">
            <div className="text-center mb-8">
              <div className="flex justify-center mb-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
                  <TrendingUp className="h-8 w-8 text-white" />
                </div>
              </div>
              <h1 className="text-2xl font-bold text-white tracking-tight">KAUSTUBH</h1>
              <p className="text-xs text-white/30 mt-1.5 tracking-[0.2em] uppercase">Trading Platform</p>
              <h2 className="text-xl font-bold text-white tracking-tight mt-6">Choose Workspace</h2>
              <p className="text-sm text-white/40 mt-1.5">Select a system to begin</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5">
              {WORKSPACE_DATA.map((ws) => {
                const Icon = ws.icon;
                return (
                  <button key={ws.id} onClick={() => handleWorkspaceSelect(ws.href)}
                    className={`group relative text-left rounded-2xl p-5 sm:p-6 transition-all duration-300 border ${ws.border} ${ws.hoverBorder} ${ws.bgTint} backdrop-blur-sm hover:shadow-xl ${ws.glow} hover:scale-[1.02] active:scale-[0.98]`}>
                    <div className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${ws.gradient} shadow-lg ${ws.glow} mb-4 transition-transform duration-300 group-hover:scale-110`}>
                      <Icon className="h-5 w-5 text-white" />
                    </div>
                    <h3 className="text-base font-bold text-white mb-0.5 tracking-tight">{ws.title}</h3>
                    <p className="text-xs text-white/40 mb-1">{ws.description}</p>
                    <div className="flex items-center gap-2 mb-4">
                      <span className={`inline-flex items-center gap-1.5 text-[11px] ${ws.textAccent}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${ws.dotColor} animate-pulse`} />
                        {ws.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-white/30">{ws.modules} modules</span>
                      <span className={`flex items-center gap-1 text-xs font-medium ${ws.textAccent} group-hover:gap-2 transition-all`}>
                        Enter
                        <ChevronRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </>
    );
  }

  // Welcome (no app lock) / Locked / Unlocking
  return (
    <>
      <AnimatedBackground />
      <div className="relative z-10 min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="flex justify-center mb-5">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
                <TrendingUp className="h-8 w-8 text-white" />
              </div>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">KAUSTUBH</h1>
            <p className="text-xs text-white/30 mt-1.5 tracking-[0.2em] uppercase">Trading Platform</p>
          </div>

          <div className={`bg-white/[0.03] backdrop-blur-xl border border-white/[0.08] rounded-2xl p-6 sm:p-8 shadow-2xl transition-all duration-300 ${shake ? 'animate-[shake_0.5s_ease-in-out]' : ''}`}>
            {/* Welcome — no app lock */}
            {appState === 'welcome' && (
              <div className="text-center animate-fade-in">
                <h2 className="text-lg font-bold text-white mb-1">Welcome back</h2>
                <p className="text-sm text-white/40 mb-8">Open the trading platform</p>
                <button onClick={handleDirectLogin} disabled={loggingIn}
                  className="w-full h-12 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-sm transition-all duration-200 flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/30 active:scale-[0.98] disabled:opacity-50">
                  {loggingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Login'}
                </button>
                {error && (
                  <div className="flex items-center justify-center gap-2 text-destructive text-sm mt-4 animate-fade-in">
                    <AlertCircle className="h-4 w-4" /> {error}
                  </div>
                )}
              </div>
            )}

            {/* Locked — PIN required */}
            {(appState === 'locked' || appState === 'unlocking') && (
              <div className="text-center animate-fade-in">
                <div className="flex justify-center mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.06] border border-white/[0.1]">
                    <Lock className="h-5 w-5 text-white/50" />
                  </div>
                </div>
                <h2 className="text-lg font-bold text-white mb-1">Application Locked</h2>
                <p className="text-sm text-white/40 mb-6">Enter your App Lock PIN</p>
                <div className="mb-6">
                  <PinInput value={pin} onChange={setPin} onComplete={handleUnlock}
                    disabled={appState === 'unlocking'} error={!!error} autoFocus={appState === 'locked'} />
                </div>
                {error && (
                  <div className="flex items-center justify-center gap-2 text-destructive text-sm mb-4 animate-fade-in">
                    <AlertCircle className="h-4 w-4" /> {error}
                  </div>
                )}
                {appState === 'unlocking' && (
                  <div className="flex items-center justify-center gap-2 text-white/40 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Verifying...
                  </div>
                )}
              </div>
            )}
          </div>

          <p className="text-center text-[11px] text-white/20 mt-6">Secure local access only</p>
        </div>
      </div>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#060a08] flex items-center justify-center">
        <Loader2 className="h-6 w-6 text-white/40 animate-spin" />
      </div>
    }>
      <LoginPageInner />
    </Suspense>
  );
}
