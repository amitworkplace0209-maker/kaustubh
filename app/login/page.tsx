'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Fingerprint,
  Globe2,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  LogOut,
  Mail,
  ScanFace,
  ShieldCheck,
  Smartphone,
  Sparkles,
  User,
  Eye,
  EyeOff,
  TrendingUp,
  Database,
  Wrench,
} from 'lucide-react';
import { AUTH_EVENT, useAuth, type AuthSessionSummary } from '@/components/auth-provider';
import { describeThisDevice, getDeviceId } from '@/lib/device-id';

type Step = 'boot' | 'signup' | 'login' | 'otp' | 'mpin-setup' | 'unlock' | 'workspace';

interface StatusPayload {
  ok?: boolean;
  hasOwner?: boolean;
  needsSignup?: boolean;
  authenticated?: boolean;
  needsMpinSetup?: boolean;
  needsUnlock?: boolean;
  signupConfigured?: boolean;
  signupEmailMasked?: string;
  mailerConfigured?: boolean;
  devOtp?: boolean;
  database?: boolean;
  message?: string;
  error?: string;
  code?: string;
  deviceCount?: number;
  maxDevices?: number;
  biometricCount?: number;
  sessions?: AuthSessionSummary[];
  user?: {
    name?: string;
    email?: string;
    emailMasked?: string;
    hasMpin?: boolean;
  } | null;
}

interface PendingOtp {
  pendingId: string;
  maskedEmail: string;
  devOtp?: string;
  email: string;
  password: string;
  channel?: string;
}

const WORKSPACES = [
  {
    emoji: '📈',
    title: 'Trading Terminal',
    description: 'Orders, positions, holdings and live P&L',
    href: '/trading/dashboard',
    accent: 'from-emerald-400/20 to-teal-500/5',
    ring: 'group-hover:border-emerald-400/60',
    icon: TrendingUp,
  },
  {
    emoji: '📊',
    title: 'Data Saver',
    description: 'Market data, ticks, downloads and exports',
    href: '/data-saver/dashboard',
    accent: 'from-sky-400/20 to-blue-500/5',
    ring: 'group-hover:border-sky-400/60',
    icon: Database,
  },
  {
    emoji: '🛠️',
    title: 'Services',
    description: 'Engines, schedulers and connection manager',
    href: '/services/system',
    accent: 'from-violet-400/20 to-purple-500/5',
    ring: 'group-hover:border-violet-400/60',
    icon: Wrench,
  },
  {
    emoji: '🔐',
    title: 'Security & Devices',
    description: 'MPIN, fingerprints, IP history and sessions',
    href: '/data-saver/settings/security',
    accent: 'from-amber-400/20 to-orange-500/5',
    ring: 'group-hover:border-amber-400/60',
    icon: ShieldCheck,
  },
];

const GLYPHS = [
  { emoji: '🛡️', top: '6%', left: '4%', size: 66, dur: '12s', delay: '0s', strong: true },
  { emoji: '📈', top: '16%', left: '78%', size: 46, dur: '9s', delay: '1.2s' },
  { emoji: '🔐', top: '66%', left: '8%', size: 40, dur: '10s', delay: '0.6s' },
  { emoji: '⚡', top: '32%', left: '90%', size: 34, dur: '7.5s', delay: '2s' },
  { emoji: '💹', top: '78%', left: '86%', size: 52, dur: '11s', delay: '0.3s' },
  { emoji: '🌐', top: '48%', left: '2%', size: 36, dur: '8.5s', delay: '1.8s' },
  { emoji: '🔎', top: '86%', left: '36%', size: 28, dur: '9.5s', delay: '0.9s' },
  { emoji: '🪙', top: '10%', left: '58%', size: 30, dur: '10.5s', delay: '2.4s' },
  { emoji: '🧠', top: '58%', left: '72%', size: 32, dur: '12.5s', delay: '1.4s' },
  { emoji: '🚀', top: '84%', left: '64%', size: 36, dur: '9s', delay: '0.2s' },
  { emoji: '🛰️', top: '24%', left: '30%', size: 26, dur: '13s', delay: '2.8s' },
  { emoji: '🧬', top: '70%', left: '48%', size: 24, dur: '10s', delay: '1.1s' },
  { emoji: '✨', top: '42%', left: '22%', size: 22, dur: '7s', delay: '0.7s' },
  { emoji: '🔔', top: '90%', left: '12%', size: 24, dur: '8s', delay: '2.1s' },
  { emoji: '📡', top: '4%', left: '38%', size: 28, dur: '11.5s', delay: '1.6s' },
];

async function callApi(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

function AmbientField() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 login-grid" />

      <div
        className="login-orb ds-drift-a"
        style={{ width: 520, height: 520, top: '-12%', left: '-8%', background: 'rgba(16,185,129,0.34)' }}
      />
      <div
        className="login-orb ds-drift-b"
        style={{ width: 460, height: 460, top: '18%', right: '-10%', background: 'rgba(59,130,246,0.30)' }}
      />
      <div
        className="login-orb ds-drift-c"
        style={{ width: 400, height: 400, bottom: '-16%', left: '32%', background: 'rgba(168,85,247,0.26)' }}
      />

      <div className="login-scanline" />

      {GLYPHS.map((glyph) => (
        <span
          key={`${glyph.emoji}-${glyph.top}-${glyph.left}`}
          className={`login-glyph ${glyph.strong ? 'login-glyph-strong' : ''}`}
          style={
            {
              top: glyph.top,
              left: glyph.left,
              fontSize: glyph.size,
              '--dur': glyph.dur,
              '--delay': glyph.delay,
            } as React.CSSProperties
          }
        >
          {glyph.emoji}
        </span>
      ))}

      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#04070f] to-transparent" />
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/10 text-xl shadow-[0_0_30px_-8px_rgba(16,185,129,0.8)]">
        <span aria-hidden>🛡️</span>
        <span className="absolute inset-0 rounded-2xl border border-emerald-300/20 login-ring" />
      </div>
      <div>
        <div className="text-lg font-black tracking-[0.16em] text-white">
          KAUSTUBH
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-emerald-300/80">
          {compact ? 'Secure terminal' : 'Private trading terminal'}
        </div>
      </div>
    </div>
  );
}

function DeviceMeter({
  deviceCount,
  maxDevices,
  sessions,
}: {
  deviceCount: number;
  maxDevices: number;
  sessions?: AuthSessionSummary[];
}) {
  const full = deviceCount >= maxDevices;
  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          <Smartphone className="h-3.5 w-3.5" /> Active devices
        </span>
        <span className={`font-mono text-xs font-bold ${full ? 'text-amber-300' : 'text-emerald-300'}`}>
          {deviceCount} / {maxDevices}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        {Array.from({ length: maxDevices }).map((_, index) => (
          <span
            key={index}
            className={`h-1.5 flex-1 rounded-full ${
              index < deviceCount
                ? full
                  ? 'bg-amber-400/80'
                  : 'bg-emerald-400/80'
                : 'bg-slate-700/70'
            }`}
          />
        ))}
      </div>
      {sessions?.length ? (
        <div className="mt-2.5 space-y-1">
          {sessions.slice(0, 2).map((session) => (
            <div key={session.id} className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {/Android|iOS|iPhone|iPad/.test(session.deviceLabel) ? (
                  <Smartphone className="h-3 w-3 shrink-0 text-slate-500" />
                ) : (
                  <Laptop className="h-3 w-3 shrink-0 text-slate-500" />
                )}
                <span className="truncate">{session.deviceLabel || 'Device'}</span>
                {session.current ? (
                  <span className="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-300">
                    this
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-slate-500">{session.ip}</span>
            </div>
          ))}
        </div>
      ) : null}
      {full ? (
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-300/90">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          2 devices are signed in. A third device is blocked until one is signed out.
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  icon,
  children,
  hint,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        {icon}
        {label}
      </span>
      <div className="login-input flex items-center gap-2 rounded-xl px-3.5 py-2.5">
        {children}
      </div>
      {hint ? <span className="mt-1.5 block text-[10px] leading-relaxed text-slate-500">{hint}</span> : null}
    </label>
  );
}

function PrimaryButton({
  children,
  busy,
  disabled,
  type = 'submit',
  onClick,
}: {
  children: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  type?: 'submit' | 'button';
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={busy || disabled}
      className="group relative mt-1 flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-emerald-400 via-teal-400 to-sky-400 px-4 py-3 text-sm font-black text-slate-950 shadow-[0_14px_40px_-16px_rgba(16,185,129,0.9)] transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : children}
      <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
    </button>
  );
}

function AlertBox({ tone, children }: { tone: 'error' | 'notice'; children: React.ReactNode }) {
  if (!children) return null;
  const error = tone === 'error';
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border px-3.5 py-3 text-xs leading-relaxed ${
        error
          ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      }`}
      role={error ? 'alert' : 'status'}
    >
      {error ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <span>{children}</span>
    </div>
  );
}

function StepHeader({
  emoji,
  title,
  subtitle,
}: {
  emoji: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-5">
      <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-slate-700/60 bg-slate-900/60 px-3 py-1 text-lg">
        <span aria-hidden>{emoji}</span>
        <Sparkles className="h-3.5 w-3.5 text-emerald-300" />
      </div>
      <h1 className="text-2xl font-black tracking-tight text-white">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{subtitle}</p>
    </div>
  );
}

function LoginSurface() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh, logout } = useAuth();
  const fromPath = useMemo(() => {
    const value = params.get('from') ?? '';
    return value.startsWith('/') && !value.startsWith('//') ? value : '';
  }, [params]);

  const [step, setStep] = useState<Step>('boot');
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('This device');
  const [deviceCount, setDeviceCount] = useState(0);
  const [maxDevices, setMaxDevices] = useState(2);
  const [biometricCount, setBiometricCount] = useState(0);
  const [hasMpin, setHasMpin] = useState(false);
  const [sessions, setSessions] = useState<AuthSessionSummary[]>([]);

  const [busy, setBusy] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [signupForm, setSignupForm] = useState({ name: '', email: '', password: '', mpin: '' });
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [otp, setOtp] = useState('');
  const [pending, setPending] = useState<PendingOtp | null>(null);
  const [mpin, setMpin] = useState('');
  const [mpinConfirm, setMpinConfirm] = useState('');
  const [unlockMpin, setUnlockMpin] = useState('');
  const [showMpin, setShowMpin] = useState(false);

  const otpRef = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const identifiers = useCallback(() => {
    const id = deviceId || getDeviceId();
    const label = deviceLabel === 'This device' ? describeThisDevice() : deviceLabel;
    return { deviceId: id, deviceLabel: label };
  }, [deviceId, deviceLabel]);

  const applyStatus = useCallback((data: StatusPayload) => {
    setStatus(data);
    setDeviceCount(Number(data.deviceCount ?? 0));
    setMaxDevices(Number(data.maxDevices ?? 2));
    setBiometricCount(Number(data.biometricCount ?? 0));
    setSessions(data.sessions ?? []);
    setHasMpin(Boolean(data.user?.hasMpin));
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const { data, status: httpStatus } = await callApi('/api/auth/status');
      if (!mounted.current) return;
      const payload = data as StatusPayload;
      if (httpStatus >= 500 || payload.database === false) {
        setStatus(payload);
        setError(payload.message || 'The auth database is unreachable.');
        setStep('boot');
        return;
      }
      applyStatus(payload);
      if (payload.authenticated) {
        if (payload.needsMpinSetup) setStep('mpin-setup');
        else if (payload.needsUnlock) setStep('unlock');
        else setStep('workspace');
      } else if (payload.hasOwner) {
        setStep('login');
        setLoginForm((current) => ({ ...current, email: current.email || '' }));
      } else {
        setStep('signup');
      }
    } catch {
      if (!mounted.current) return;
      setError('Could not reach the auth service. Check your connection and retry.');
      setStep('boot');
    }
  }, [applyStatus]);

  useEffect(() => {
    setDeviceId(getDeviceId());
    setDeviceLabel(describeThisDevice());
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (step === 'otp') otpRef.current?.focus();
  }, [step]);

  const completeLogin = useCallback(async () => {
    setNotice('');
    setError('');
    try {
      await fetch('/api/auth/status', { cache: 'no-store' });
      await refresh();
    } catch {
      /* provider refresh is best effort */
    }
    window.dispatchEvent(new Event(AUTH_EVENT));
    if (fromPath) router.replace(fromPath);
    else setStep('workspace');
  }, [fromPath, refresh, router]);

  const afterAuth = useCallback(
    async (data: StatusPayload) => {
      applyStatus({
        ...status,
        ...data,
        authenticated: true,
        hasOwner: true,
        needsSignup: false,
        user: data.user ?? status?.user,
      });
      setHasMpin(Boolean(data.user?.hasMpin ?? hasMpin));
      await refresh();
      window.dispatchEvent(new Event(AUTH_EVENT));
      if (data.needsMpinSetup) {
        setMpin('');
        setMpinConfirm('');
        setStep('mpin-setup');
        return;
      }
      if (data.needsUnlock) {
        setUnlockMpin('');
        setStep('unlock');
        return;
      }
      await completeLogin();
    },
    [applyStatus, completeLogin, hasMpin, refresh, status],
  );

  async function handleSignup(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!status?.signupConfigured) {
      setError('Signup is not configured on the server yet.');
      return;
    }
    setBusy(true);
    try {
      const ids = identifiers();
      const { data } = await callApi('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ ...signupForm, ...ids }),
      });
      if (!data.ok) {
        if (data.code === 'OWNER_EXISTS') {
          setStep('login');
          setError('The owner account already exists. Log in instead.');
        } else {
          setError(String(data.message ?? 'Signup failed.'));
        }
        return;
      }
      setDeviceCount(1);
      setHasMpin(false);
      await refresh();
      setMpin('');
      setMpinConfirm('');
      setStep('mpin-setup');
      setNotice('Owner account created. Set your MPIN to open the app.');
    } catch {
      setError('Network error while creating the account. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const ids = identifiers();
      const { data } = await callApi('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ ...loginForm, ...ids }),
      });

      if (data.needsOtp) {
        setPending({
          pendingId: String(data.pendingId ?? ''),
          maskedEmail: String(data.maskedEmail ?? ''),
          devOtp: typeof data.devOtp === 'string' ? data.devOtp : undefined,
          email: loginForm.email,
          password: loginForm.password,
          channel: typeof data.channel === 'string' ? data.channel : undefined,
        });
        setDeviceCount(Number(data.activeDevices ?? 1));
        setMaxDevices(Number(data.maxDevices ?? 2));
        setOtp('');
        setStep('otp');
        setNotice(String(data.message ?? 'Enter the code sent to your email.'));
        return;
      }

      if (!data.ok) {
        if (data.code === 'NO_OWNER') {
          setStep('signup');
          setError('No owner account exists yet. Create it once to continue.');
          return;
        }
        setError(String(data.message ?? 'Login failed.'));
        return;
      }

      await afterAuth(data as StatusPayload);
    } catch {
      setError('Network error while signing in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOtp(event: React.FormEvent) {
    event.preventDefault();
    if (!pending) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const ids = identifiers();
      const { data } = await callApi('/api/auth/login/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ pendingId: pending.pendingId, otp, ...ids }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'Incorrect code.'));
        return;
      }
      await afterAuth(data as StatusPayload);
    } catch {
      setError('Network error while verifying the code. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (!pending) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const ids = identifiers();
      const { data } = await callApi('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: pending.email, password: pending.password, ...ids }),
      });
      if (data.needsOtp) {
        setPending({
          ...pending,
          pendingId: String(data.pendingId ?? ''),
          maskedEmail: String(data.maskedEmail ?? pending.maskedEmail),
          devOtp: typeof data.devOtp === 'string' ? data.devOtp : undefined,
        });
        setOtp('');
        setNotice(String(data.message ?? 'A fresh code was sent.'));
      } else if (data.ok) {
        await afterAuth(data as StatusPayload);
      } else {
        setError(String(data.message ?? 'Could not resend the code.'));
      }
    } catch {
      setError('Network error while resending the code.');
    } finally {
      setBusy(false);
    }
  }

  async function handleMpinSetup(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!/^\d{6}$/.test(mpin)) {
      setError('Your MPIN must be exactly 6 digits.');
      return;
    }
    if (mpin !== mpinConfirm) {
      setError('The two MPIN entries do not match.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await callApi('/api/auth/mpin/setup', {
        method: 'POST',
        body: JSON.stringify({ mpin, confirm: mpinConfirm }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'Could not set the MPIN.'));
        return;
      }
      setHasMpin(true);
      setDeviceCount((count) => Math.max(count, 1));
      await completeLogin();
    } catch {
      setError('Network error while saving the MPIN. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlockMpin(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!/^\d{6}$/.test(unlockMpin)) {
      setError('Enter your 6-digit MPIN.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await callApi('/api/auth/mpin/verify', {
        method: 'POST',
        body: JSON.stringify({ mpin: unlockMpin }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'Incorrect MPIN.'));
        return;
      }
      setUnlockMpin('');
      await completeLogin();
    } catch {
      setError('Network error while unlocking. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleBiometric() {
    setError('');
    setNotice('');
    setBioBusy(true);
    try {
      const { data: optionsData } = await callApi('/api/auth/biometric/auth/options', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!optionsData.ok || !optionsData.options) {
        setError(String(optionsData.message ?? 'Biometric unlock is not available.'));
        return;
      }
      const assertion = await startAuthentication({
        optionsJSON: optionsData.options as never,
      });
      const { data } = await callApi('/api/auth/biometric/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ response: assertion }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'Biometric verification failed.'));
        return;
      }
      await completeLogin();
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(
        /cancel|abort|notallowed/i.test(message)
          ? 'Biometric prompt cancelled.'
          : 'Could not start biometric unlock on this device.',
      );
    } finally {
      setBioBusy(false);
    }
  }

  async function handleLogout() {
    await logout();
    setPending(null);
    setUnlockMpin('');
    setMpin('');
    setNotice('Signed out.');
    setError('');
    setDeviceCount(0);
    setStep('login');
  }

  const fullDevices = deviceCount >= maxDevices;
  const signupReady = Boolean(status?.signupConfigured);

  return (
    <div className="login-shell relative min-h-screen overflow-hidden text-slate-100">
      <AmbientField />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col lg:flex-row">
        <aside className="hidden w-[46%] flex-col justify-between p-10 lg:flex xl:p-14">
          <Brand />

          <div className="relative my-10">
            <div
              aria-hidden
              className="absolute -left-10 -top-14 h-64 w-64 rounded-full border border-emerald-400/15"
            />
            <div aria-hidden className="login-orbit -left-6 -top-10 h-72 w-72" />
            <div className="relative">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-300">
                <Lock className="h-3 w-3" /> Single-owner security
              </div>
              <h2 className="text-4xl font-black leading-[1.08] tracking-tight text-white xl:text-5xl">
                Your terminal.
                <br />
                <span className="bg-gradient-to-r from-emerald-300 via-teal-200 to-sky-300 bg-clip-text text-transparent">
                  Only your eyes.
                </span>
              </h2>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-400">
                One owner account, two device slots, a fresh email code for a second device,
                and every login IP written to MongoDB. The backend never appears in the browser.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <span className="login-emoji-chip">🔐 Password + MPIN</span>
              <span className="login-emoji-chip">📨 Email OTP</span>
              <span className="login-emoji-chip">👆 WebAuthn</span>
              <span className="login-emoji-chip">🌐 IP audit</span>
            </div>
            <DeviceMeter deviceCount={deviceCount} maxDevices={maxDevices} sessions={sessions} />
            <div className="flex items-center gap-4 text-[10px] uppercase tracking-[0.18em] text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-emerald-400" /> MongoDB
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Globe2 className="h-3 w-3 text-sky-400" /> Server-side only
              </span>
            </div>
          </div>
        </aside>

        <main className="flex w-full flex-1 items-center justify-center px-4 py-8 sm:px-6 lg:px-10">
          <div className="w-full max-w-[460px]">
            <div className="mb-4 flex items-center justify-between lg:hidden">
              <Brand compact />
              <span className="login-emoji-chip">🔒 Secure</span>
            </div>

            <div key={step} className="login-card login-pop p-5 sm:p-7">
              {step === 'boot' ? (
                <div className="flex flex-col items-center justify-center py-14 text-center">
                  <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/10 text-3xl">
                    <span aria-hidden>🛡️</span>
                    <span className="absolute inset-0 rounded-2xl border border-emerald-300/30 login-ring" />
                  </div>
                  <Loader2 className="mb-3 h-5 w-5 animate-spin text-emerald-300" />
                  <p className="text-sm font-semibold text-slate-300">Checking your secure session…</p>
                  <p className="mt-1 text-xs text-slate-500">MongoDB · session cookie · device slots</p>
                  {error ? (
                    <div className="mt-5 w-full">
                      <AlertBox tone="error">{error}</AlertBox>
                      <button
                        type="button"
                        onClick={() => {
                          setError('');
                          setStep('boot');
                          void loadStatus();
                        }}
                        className="mt-3 w-full rounded-xl border border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-300 transition hover:border-emerald-400/50 hover:text-white"
                      >
                        Retry connection
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {step === 'signup' ? (
                <form onSubmit={handleSignup} className="space-y-3.5">
                  <StepHeader
                    emoji="🧑‍🚀"
                    title="Create the owner account"
                    subtitle="This screen exists only once. After this, only Login will be available."
                  />

                  {!signupReady ? (
                    <AlertBox tone="error">
                      Signup is not configured. Add <code className="font-mono">AUTH_SIGNUP_EMAIL</code> and{' '}
                      <code className="font-mono">AUTH_SIGNUP_MPIN</code> to <code className="font-mono">.env</code>, then
                      restart the server.
                    </AlertBox>
                  ) : (
                    <AlertBox tone="notice">
                      Email and MPIN must match the values stored in your server <code className="font-mono">.env</code>.
                      {status?.signupEmailMasked ? ` Owner email: ${status.signupEmailMasked}.` : ''}
                    </AlertBox>
                  )}

                  <Field label="Your name" icon={<User className="h-3.5 w-3.5" />}>
                    <input
                      value={signupForm.name}
                      onChange={(event) => setSignupForm((form) => ({ ...form, name: event.target.value }))}
                      autoComplete="name"
                      placeholder="Kaustubh"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                  </Field>

                  <Field label="Email" icon={<Mail className="h-3.5 w-3.5" />}>
                    <input
                      type="email"
                      value={signupForm.email}
                      onChange={(event) => setSignupForm((form) => ({ ...form, email: event.target.value }))}
                      autoComplete="email"
                      placeholder={status?.signupEmailMasked || 'owner@example.com'}
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                  </Field>

                  <Field
                    label="Password"
                    icon={<Lock className="h-3.5 w-3.5" />}
                    hint="10+ characters with uppercase, lowercase and a number."
                  >
                    <input
                      type={showSignupPassword ? 'text' : 'password'}
                      value={signupForm.password}
                      onChange={(event) => setSignupForm((form) => ({ ...form, password: event.target.value }))}
                      autoComplete="new-password"
                      placeholder="Create a strong password"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupPassword((value) => !value)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showSignupPassword ? 'Hide password' : 'Show password'}
                    >
                      {showSignupPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <Field
                    label="Owner MPIN from .env"
                    icon={<KeyRound className="h-3.5 w-3.5" />}
                    hint="6 digits. This proves you hold the server configuration."
                  >
                    <input
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      value={signupForm.mpin}
                      onChange={(event) =>
                        setSignupForm((form) => ({ ...form, mpin: event.target.value.replace(/\D/g, '').slice(0, 6) }))
                      }
                      autoComplete="one-time-code"
                      placeholder="••••••"
                      className="w-full bg-transparent font-mono text-lg tracking-[0.42em] text-white outline-none placeholder:tracking-[0.42em] placeholder:text-slate-600"
                      required
                    />
                  </Field>

                  <AlertBox tone="error">{error}</AlertBox>

                  <PrimaryButton busy={busy} disabled={!signupReady}>
                    Create owner account <ArrowRight className="h-4 w-4" />
                  </PrimaryButton>

                  <p className="pt-1 text-center text-[10px] leading-relaxed text-slate-500">
                    🔒 The name and password are hashed with scrypt. The signup email and MPIN are never stored here.
                  </p>
                </form>
              ) : null}

              {step === 'login' ? (
                <form onSubmit={handleLogin} className="space-y-3.5">
                  <StepHeader
                    emoji="👋"
                    title="Welcome back"
                    subtitle="Sign in with your owner email and password. A second device needs a fresh email code."
                  />

                  <DeviceMeter deviceCount={deviceCount} maxDevices={maxDevices} sessions={sessions} />

                  <Field label="Email" icon={<Mail className="h-3.5 w-3.5" />}>
                    <input
                      type="email"
                      value={loginForm.email}
                      onChange={(event) => setLoginForm((form) => ({ ...form, email: event.target.value }))}
                      autoComplete="username"
                      placeholder={status?.signupEmailMasked || 'owner@example.com'}
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                  </Field>

                  <Field label="Password" icon={<Lock className="h-3.5 w-3.5" />}>
                    <input
                      type={showLoginPassword ? 'text' : 'password'}
                      value={loginForm.password}
                      onChange={(event) => setLoginForm((form) => ({ ...form, password: event.target.value }))}
                      autoComplete="current-password"
                      placeholder="Your password"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword((value) => !value)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                    >
                      {showLoginPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <AlertBox tone="error">{error}</AlertBox>
                  <AlertBox tone="notice">{notice}</AlertBox>

                  <PrimaryButton busy={busy}>
                    Unlock terminal <ArrowRight className="h-4 w-4" />
                  </PrimaryButton>

                  <div className="flex items-center gap-2 pt-1 text-[10px] text-slate-500">
                    <ShieldCheck className="h-3 w-3 text-emerald-400" />
                    Signup is permanently closed once the owner exists.
                  </div>
                </form>
              ) : null}

              {step === 'otp' ? (
                <form onSubmit={handleVerifyOtp} className="space-y-3.5">
                  <StepHeader
                    emoji="📨"
                    title="Verify this second device"
                    subtitle={`A fresh 6-digit code was sent to ${pending?.maskedEmail || 'your owner email'}. It expires in 10 minutes.`}
                  />

                  <DeviceMeter deviceCount={Math.max(deviceCount, 1)} maxDevices={maxDevices} sessions={sessions} />

                  <Field label="One-time code" icon={<KeyRound className="h-3.5 w-3.5" />}>
                    <input
                      ref={otpRef}
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      value={otp}
                      onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      onInput={(event) => {
                        const value = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
                        setOtp(value);
                        if (value.length === 6) {
                          (event.currentTarget.closest('form') as HTMLFormElement | null)?.requestSubmit();
                        }
                      }}
                      autoComplete="one-time-code"
                      placeholder="••••••"
                      className="w-full bg-transparent text-center font-mono text-2xl tracking-[0.55em] text-white outline-none placeholder:tracking-[0.55em] placeholder:text-slate-600"
                      required
                    />
                  </Field>

                  {pending?.devOtp ? (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                      🧪 Dev fallback OTP: <span className="font-mono font-bold tracking-[0.25em]">{pending.devOtp}</span>
                    </div>
                  ) : null}

                  <AlertBox tone="error">{error}</AlertBox>
                  <AlertBox tone="notice">{notice}</AlertBox>

                  <PrimaryButton busy={busy} disabled={otp.length !== 6}>
                    Verify & sign in <ArrowRight className="h-4 w-4" />
                  </PrimaryButton>

                  <div className="flex items-center justify-between gap-2 pt-1 text-[11px]">
                    <button
                      type="button"
                      onClick={() => {
                        setStep('login');
                        setError('');
                        setNotice('');
                      }}
                      className="font-semibold text-slate-400 transition hover:text-white"
                    >
                      ← Back to login
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleResend()}
                      disabled={busy}
                      className="font-semibold text-emerald-300 transition hover:text-emerald-200 disabled:opacity-50"
                    >
                      Resend fresh code
                    </button>
                  </div>
                </form>
              ) : null}

              {step === 'mpin-setup' ? (
                <form onSubmit={handleMpinSetup} className="space-y-3.5">
                  <StepHeader
                    emoji="🔢"
                    title="Set your MPIN"
                    subtitle="Mandatory after the first login. The app stays closed until this 6-digit MPIN is saved."
                  />

                  <AlertBox tone="notice">
                    🙅 You cannot skip this step. You can later switch to fingerprint / face in Settings → Security.
                  </AlertBox>

                  <Field label="New MPIN" icon={<KeyRound className="h-3.5 w-3.5" />}>
                    <input
                      type={showMpin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      value={mpin}
                      onChange={(event) => setMpin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      autoComplete="new-password"
                      placeholder="••••••"
                      className="w-full bg-transparent font-mono text-xl tracking-[0.5em] text-white outline-none placeholder:tracking-[0.5em] placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowMpin((value) => !value)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showMpin ? 'Hide MPIN' : 'Show MPIN'}
                    >
                      {showMpin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <Field label="Confirm MPIN" icon={<ShieldCheck className="h-3.5 w-3.5" />}>
                    <input
                      type={showMpin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      value={mpinConfirm}
                      onChange={(event) => setMpinConfirm(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      autoComplete="new-password"
                      placeholder="••••••"
                      className="w-full bg-transparent font-mono text-xl tracking-[0.5em] text-white outline-none placeholder:tracking-[0.5em] placeholder:text-slate-600"
                      required
                    />
                  </Field>

                  <AlertBox tone="error">{error}</AlertBox>
                  <AlertBox tone="notice">{notice}</AlertBox>

                  <PrimaryButton busy={busy} disabled={mpin.length !== 6 || mpinConfirm.length !== 6}>
                    Save MPIN & open app <ArrowRight className="h-4 w-4" />
                  </PrimaryButton>
                </form>
              ) : null}

              {step === 'unlock' ? (
                <form onSubmit={handleUnlockMpin} className="space-y-3.5">
                  <StepHeader
                    emoji="🔓"
                    title="Unlock your terminal"
                    subtitle="Use your MPIN, or a registered fingerprint / face. This is the app lock you configured."
                  />

                  <DeviceMeter deviceCount={Math.max(deviceCount, 1)} maxDevices={maxDevices} sessions={sessions} />

                  {hasMpin ? (
                    <Field label="MPIN" icon={<KeyRound className="h-3.5 w-3.5" />}>
                      <input
                        type={showMpin ? 'text' : 'password'}
                        inputMode="numeric"
                        pattern="\d{6}"
                        maxLength={6}
                        value={unlockMpin}
                        onChange={(event) => setUnlockMpin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                        autoComplete="one-time-code"
                        autoFocus
                        placeholder="••••••"
                        className="w-full bg-transparent text-center font-mono text-2xl tracking-[0.55em] text-white outline-none placeholder:tracking-[0.55em] placeholder:text-slate-600"
                      />
                      <button
                        type="button"
                        onClick={() => setShowMpin((value) => !value)}
                        className="text-slate-500 transition hover:text-emerald-300"
                        aria-label={showMpin ? 'Hide MPIN' : 'Show MPIN'}
                      >
                        {showMpin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </Field>
                  ) : null}

                  <AlertBox tone="error">{error}</AlertBox>
                  <AlertBox tone="notice">{notice}</AlertBox>

                  {hasMpin ? (
                    <PrimaryButton busy={busy} disabled={unlockMpin.length !== 6}>
                      Unlock <ArrowRight className="h-4 w-4" />
                    </PrimaryButton>
                  ) : null}

                  {biometricCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => void handleBiometric()}
                      disabled={bioBusy}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/35 bg-emerald-400/10 px-4 py-3 text-sm font-bold text-emerald-200 transition hover:bg-emerald-400/15 disabled:opacity-60"
                    >
                      {bioBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Fingerprint className="h-4 w-4" />
                      )}
                      Use fingerprint / face
                    </button>
                  ) : (
                    <div className="flex items-start gap-2 rounded-xl border border-slate-700/60 bg-slate-950/40 px-3.5 py-3 text-[11px] text-slate-400">
                      <ScanFace className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                      Register a fingerprint in Settings → Security to unlock without typing the MPIN.
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    className="flex w-full items-center justify-center gap-2 pt-1 text-[11px] font-semibold text-slate-500 transition hover:text-rose-300"
                  >
                    <LogOut className="h-3.5 w-3.5" /> Sign out instead
                  </button>
                </form>
              ) : null}

              {step === 'workspace' ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <StepHeader
                      emoji="🧭"
                      title={`Welcome${status?.user?.name ? `, ${status.user.name}` : ''}`}
                      subtitle="Your session is live. Choose where to go."
                    />
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700/60 px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 transition hover:border-rose-400/50 hover:text-rose-300"
                    >
                      <LogOut className="h-3 w-3" /> Sign out
                    </button>
                  </div>

                  <DeviceMeter
                    deviceCount={Math.max(deviceCount, 1)}
                    maxDevices={maxDevices}
                    sessions={sessions}
                  />

                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {WORKSPACES.map((workspace) => {
                      const Icon = workspace.icon;
                      return (
                        <button
                          key={workspace.href}
                          type="button"
                          onClick={() => router.push(workspace.href)}
                          className={`group relative overflow-hidden rounded-2xl border border-slate-700/60 bg-gradient-to-br ${workspace.accent} p-3.5 text-left transition hover:-translate-y-0.5 ${workspace.ring}`}
                        >
                          <div className="flex items-center justify-between">
                            <span aria-hidden className="text-2xl">{workspace.emoji}</span>
                            <Icon className="h-4 w-4 text-slate-400 transition group-hover:text-white" />
                          </div>
                          <div className="mt-2 text-sm font-bold text-white">{workspace.title}</div>
                          <div className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{workspace.description}</div>
                          <ChevronRight className="absolute bottom-3 right-3 h-4 w-4 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-emerald-300" />
                        </button>
                      );
                    })}
                  </div>

                  <AlertBox tone="notice">{notice}</AlertBox>
                  <AlertBox tone="error">{error}</AlertBox>

                  <button
                    type="button"
                    onClick={() => router.push('/data-saver/settings/security')}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700/60 px-4 py-2.5 text-xs font-semibold text-slate-300 transition hover:border-emerald-400/50 hover:text-white"
                  >
                    <ShieldCheck className="h-4 w-4 text-emerald-300" />
                    Manage MPIN, biometrics & devices
                  </button>
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 px-1 text-[10px] text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-emerald-400" /> Backend hidden · server-side auth
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className={fullDevices ? 'text-amber-300' : 'text-slate-400'}>
                  {deviceCount}/{maxDevices} devices
                </span>
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="login-shell flex min-h-screen items-center justify-center text-slate-300">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-300" />
        </div>
      }
    >
      <LoginSurface />
    </Suspense>
  );
}
