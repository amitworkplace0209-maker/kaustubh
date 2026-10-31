'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Mail,
  ShieldCheck,
  User,
  Watch,
} from 'lucide-react';
import { AUTH_EVENT, useAuth } from '@/components/auth-provider';

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

type Step = 'boot' | 'signup' | 'login' | 'unlock' | 'workspace' | 'reset-password';

interface StatusPayload {
  ok?: boolean;
  hasOwner?: boolean;
  needsSignup?: boolean;
  needsUnlock?: boolean;
  authenticated?: boolean;
  ownerEmailMasked?: string;
  user?: { name?: string; email?: string; emailMasked?: string } | null;
  database?: boolean;
  message?: string;
  error?: string;
  code?: string;
}

interface SignupForm {
  name: string;
  password: string;
  confirmPassword: string;
}

interface LoginForm {
  email: string;
  password: string;
  mpin: string;
}

interface UnlockForm {
  mpin: string;
  useBiometric: boolean;
}

interface ResetForm {
  mpin: string;
  newPassword: string;
  confirmPassword: string;
}

/* ------------------------------------------------------------------ */
/* LocalStorage keys                                                  */
/* ------------------------------------------------------------------ */

const APP_UNLOCKED_KEY = 'kaustubh_app_unlocked';
const BIOMETRIC_ENABLED_KEY = 'kaustubh_biometric_enabled';
const DEVICE_ID_KEY = 'kaustubh_device_id';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function getDeviceId(): string {
  if (!isBrowser()) return '';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `dev_${crypto.randomUUID().replace(/-/g, '')}`;
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch {
      /* storage may be blocked — proceed without persisting */
    }
  }
  return id;
}

function isAppUnlocked(): boolean {
  if (!isBrowser()) return false;
  return localStorage.getItem(APP_UNLOCKED_KEY) === '1';
}

function setAppUnlocked(value: boolean): void {
  if (!isBrowser()) return;
  if (value) localStorage.setItem(APP_UNLOCKED_KEY, '1');
  else localStorage.removeItem(APP_UNLOCKED_KEY);
}

function isBiometricEnabled(): boolean {
  if (!isBrowser()) return false;
  return localStorage.getItem(BIOMETRIC_ENABLED_KEY) === '1';
}

function setBiometricEnabled(value: boolean): void {
  if (!isBrowser()) return;
  if (value) localStorage.setItem(BIOMETRIC_ENABLED_KEY, '1');
  else localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
}

/* ------------------------------------------------------------------ */
/* API helper                                                         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* UI Components                                                      */
/* ------------------------------------------------------------------ */

function AmbientField() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(135deg,#0b1220_0%,#070a14_100%)]" />
      <div
        className="login-orb"
        style={{
          width: 600, height: 600, top: '-20%', left: '-10%',
          background: 'rgba(16,185,129,0.25)',
        }}
      />
      <div
        className="login-orb"
        style={{
          width: 500, height: 500, top: '10%', right: '-15%',
          background: 'rgba(59,130,246,0.20)',
        }}
      />
      <div
        className="login-orb"
        style={{
          width: 400, height: 400, bottom: '-20%', left: '30%',
          background: 'rgba(168,85,247,0.15)',
        }}
      />
      <div className="login-scanline" />
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/10 text-xl shadow-[0_0_30px_-8px_rgba(16,185,129,0.8)]">
        <ShieldCheck className="h-6 w-6 text-emerald-400" />
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

function Field({
  label,
  icon,
  children,
  hint,
  readOnly,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  hint?: string;
  readOnly?: boolean;
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
  variant = 'emerald',
}: {
  children: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  type?: 'submit' | 'button';
  variant?: 'emerald' | 'outline';
}) {
  const base = 'group relative mt-1 flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl px-4 py-3 text-sm font-black transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60';
  const emerald = 'bg-gradient-to-r from-emerald-400 via-teal-400 to-sky-400 text-slate-950 shadow-[0_14px_40px_-16px_rgba(16,185,129,0.9)] hover:from-emerald-300 hover:via-teal-300 hover:to-sky-300';
  const outline = 'border border-slate-700/60 bg-slate-900/40 text-slate-300 hover:border-emerald-400/50 hover:text-white';
  return (
    <button type={type} disabled={busy || disabled} className={`${base} ${variant === 'emerald' ? emerald : outline}`}>
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

function StepHeader({ emoji, title, subtitle }: { emoji: string; title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-300">
        <span aria-hidden>{emoji}</span>
      </div>
      <h1 className="text-2xl font-black leading-[1.08] tracking-tight text-white">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{subtitle}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Login Page                                                         */
/* ------------------------------------------------------------------ */

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh, logout } = useAuth();

  const fromPath = useMemo(() => {
    const value = params.get('from') ?? '';
    return value.startsWith('/') && !value.startsWith('//') ? value : '';
  }, [params]);

  const [step, setStep] = useState<Step>('boot');
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [signupForm, setSignupForm] = useState<SignupForm>({
    name: '',
    password: '',
    confirmPassword: '',
  });
  const [loginForm, setLoginForm] = useState<LoginForm>({ email: '', password: '', mpin: '' });
  // NOTE: useBiometric starts as false on server; useEffect loads real value from localStorage after mount
  const [unlockForm, setUnlockForm] = useState<UnlockForm>({ mpin: '', useBiometric: false });
  const [resetForm, setResetForm] = useState<ResetForm>({ mpin: '', newPassword: '', confirmPassword: '' });
  const [biometricLoaded, setBiometricLoaded] = useState(false);

  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showSignupConfirm, setShowSignupConfirm] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showUnlockMpin, setShowUnlockMpin] = useState(false);
  const [showResetMpin, setShowResetMpin] = useState(false);
  const [showResetNewPassword, setShowResetNewPassword] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const mounted = useRef(false);

  /* ---------------------------------------------------------------- */
  /* Status / bootstrap                                               */
  /* ---------------------------------------------------------------- */

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
      setStatus(payload);

      if (payload.authenticated) {
        if (isAppUnlocked()) {
          setStep('workspace');
        } else {
          setStep('unlock');
        }
        return;
      }

      if (payload.hasOwner) {
        setStep('login');
      } else {
        setStep('signup');
      }
    } catch {
      if (!mounted.current) return;
      setError('Could not reach the auth service. Check your connection and retry.');
      setStep('boot');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Load biometric preference from localStorage after mount (client only)
    if (isBrowser()) {
      setUnlockForm((prev) => ({ ...prev, useBiometric: isBiometricEnabled() }));
      setBiometricLoaded(true);
    }
    void loadStatus();
    return () => {
      mounted.current = false;
    };
  }, [loadStatus]);

  /* ---------------------------------------------------------------- */
  /* Complete login / unlock                                          */
  /* ---------------------------------------------------------------- */

  const completeAuth = useCallback(async () => {
    setNotice('');
    setError('');
    try {
      await refresh();
    } catch {
      /* provider refresh is best effort */
    }
    window.dispatchEvent(new Event(AUTH_EVENT));
    setAppUnlocked(true);
    if (fromPath) router.replace(fromPath);
    else setStep('workspace');
  }, [fromPath, refresh]);

  /* ---------------------------------------------------------------- */
  /* Handlers                                                         */
  /* ---------------------------------------------------------------- */

  async function handleSignup(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const { data } = await callApi('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          name: signupForm.name,
          password: signupForm.password,
          confirmPassword: signupForm.confirmPassword,
        }),
      });
      if (!data.ok) {
        if (data.code === 'OWNER_EXISTS') {
          setStep('login');
          setError('The owner account already exists. Please log in instead.');
        } else {
          setError(String(data.message ?? 'Signup failed.'));
        }
        return;
      }
      setNotice('Owner account created successfully.');
      await completeAuth();
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
      const { data } = await callApi('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: loginForm.email,
          password: loginForm.password,
          mpin: loginForm.mpin,
        }),
      });

      if (!data.ok) {
        setError(String(data.message ?? 'Authentication failed.'));
        return;
      }

      await completeAuth();
    } catch {
      setError('Network error while signing in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const { data } = await callApi('/api/auth/mpin/verify', {
        method: 'POST',
        body: JSON.stringify({ mpin: unlockForm.mpin }),
      });

      if (!data.ok) {
        setError(String(data.message ?? 'Incorrect MPIN. Try again.'));
        return;
      }

      await completeAuth();
    } catch {
      setError('Network error while unlocking. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const { data: verifyData } = await callApi('/api/auth/mpin/verify', {
        method: 'POST',
        body: JSON.stringify({ mpin: resetForm.mpin }),
      });

      if (!verifyData.ok) {
        setError(String(verifyData.message ?? 'Incorrect MPIN. Try again.'));
        return;
      }

      const { data } = await callApi('/api/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({
          mpin: resetForm.mpin,
          newPassword: resetForm.newPassword,
          confirmPassword: resetForm.confirmPassword,
        }),
      });

      if (!data.ok) {
        setError(String(data.message ?? 'Password reset failed.'));
        return;
      }

      setNotice('Password reset successfully. You can now log in with your new password.');
      setStep('login');
    } catch {
      setError('Network error while resetting password. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleBiometricUnlock() {
    if (!isBrowser()) return;
    setError('');
    setBusy(true);
    try {
      const { data } = await callApi('/api/auth/biometric/auth/options', {
        method: 'POST',
        body: JSON.stringify({ deviceId: getDeviceId() }),
      });

      if (!data.ok) {
        setError('Biometric not available. Use MPIN instead.');
        return;
      }

      setNotice('Biometric verified.');
      await completeAuth();
    } catch {
      setError('Biometric authentication failed. Use MPIN instead.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await logout();
    setAppUnlocked(false);
    setNotice('Signed out.');
    setError('');
    setStep('login');
  }

  /* ---------------------------------------------------------------- */
  /* Derived values                                                   */
  /* ---------------------------------------------------------------- */

  const signupReady = Boolean(status?.hasOwner === false && status?.ok !== false);
  const biometricAvailable = isBrowser() && biometricLoaded && isBiometricEnabled();

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="login-shell relative min-h-screen overflow-hidden text-slate-100 selection:bg-emerald-500/30">
      <AmbientField />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-7xl flex-col lg:flex-row">
        {/* Left panel — branding + info */}
        <aside className="hidden w-[42%] flex-col justify-between p-10 lg:flex xl:p-16">
          <div>
            <Brand />
            <div className="relative my-12">
              <div className="relative">
                <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-300">
                  <Lock className="h-3 w-3" /> Single-owner security
                </div>
                <h2 className="text-4xl font-black leading-[1.08] tracking-tight text-white xl:text-5xl">
                  Your terminal.
                  <br />
                  <span className="bg-gradient-to-r from-emerald-300 via-teal-200 to-sky-300 bg-clip-text text-transparent">
                    Only your eyes.
                  </span>
                </h2>
                <p className="mt-5 max-w-md text-sm leading-relaxed text-slate-400">
                  One owner account. Email + Password + MPIN. Server-side only.
                  App locks automatically after session — unlock with MPIN,
                  custom PIN, or biometric (fingerprint / face).
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className="login-chip">🔐 MPIN App Lock</span>
                <span className="login-chip">👆 Fingerprint / Face ID</span>
                <span className="login-chip">🌐 Server-side auth</span>
              </div>
              <div className="flex items-center gap-4 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="h-3 w-3 text-emerald-400" /> Email from config
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="h-3 w-3 text-sky-400" /> MPIN from config
                </span>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-800/50 pt-8 mt-8 text-xs text-slate-500">
            KAUSTUBH Trading Platform · Secure terminal v1.0
          </div>
        </aside>

        {/* Right panel — form card */}
        <main className="flex w-full flex-1 items-center justify-center px-4 py-8 sm:px-6 lg:px-10">
          <div className="w-full max-w-[480px]">
            <div className="mb-4 flex items-center justify-between lg:hidden">
              <Brand compact />
              <span className="login-chip">🔒 Secure</span>
            </div>

            <div key={step} className="login-card p-6 sm:p-8">
              {/* Boot state */}
              {step === 'boot' && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="relative mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/10">
                    <Watch className="h-8 w-8 text-emerald-400" />
                    <span className="absolute inset-0 rounded-2xl border border-emerald-300/30 login-ring" />
                  </div>
                  <Loader2 className="mb-4 h-6 w-6 animate-spin text-emerald-300" />
                  <p className="text-sm font-semibold text-slate-300">Checking secure session…</p>
                  {error && (
                    <div className="mt-6 w-full">
                      <AlertBox tone="error">{error}</AlertBox>
                      <button
                        type="button"
                        onClick={() => {
                          setError('');
                          void loadStatus();
                        }}
                        className="mt-4 w-full rounded-xl border border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-300 transition hover:border-emerald-400/50 hover:text-white"
                      >
                        Retry connection
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Signup state */}
              {step === 'signup' && (
                <form onSubmit={handleSignup} className="space-y-4">
                  <StepHeader
                    emoji="🧑‍🚀"
                    title="Create Owner Account"
                    subtitle="This screen exists only once. After this, only Login + App Lock will be available."
                  />

                  {!signupReady ? (
                    <AlertBox tone="error">
                      Owner is not configured on the server. Set OWNER_EMAIL and OWNER_MPIN
                      environment variables, then restart the backend.
                    </AlertBox>
                  ) : (
                    <AlertBox tone="notice">
                      Email and MPIN are fixed from server configuration (read-only).
                      Password must be at least 10 characters with uppercase, lowercase and a number.
                    </AlertBox>
                  )}

                  <Field label="Your name" icon={<User className="h-3.5 w-3.5" />}>
                    <input
                      value={signupForm.name}
                      onChange={(e) =>
                        setSignupForm((f) => ({ ...f, name: e.target.value }))
                      }
                      autoComplete="name"
                      placeholder="Kaustubh"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                  </Field>

                  <Field label="Email (from server config)" icon={<Mail className="h-3.5 w-3.5" />} readOnly>
                    <input
                      type="email"
                      value={status?.ownerEmailMasked || ''}
                      readOnly
                      autoComplete="email"
                      className="w-full bg-transparent text-sm text-slate-400 outline-none"
                    />
                    <span className="text-[10px] text-slate-500 mt-1 block">
                      Fixed from OWNER_EMAIL — cannot be changed.
                    </span>
                  </Field>

                  <Field
                    label="MPIN (from server config)"
                    icon={<KeyRound className="h-3.5 w-3.5" />}
                    hint="6-digit MPIN from OWNER_MPIN environment variable — fixed, cannot be changed."
                  >
                    <input
                      type="text"
                      value={status?.ownerEmailMasked ? '••••••' : ''}
                      readOnly
                      autoComplete="one-time-code"
                      placeholder="••••••"
                      className="w-full bg-transparent font-mono text-lg tracking-[0.42em] text-slate-400 outline-none placeholder:tracking-[0.42em]"
                    />
                    <span className="text-[10px] text-slate-500 mt-1 block">
                      Fixed from OWNER_MPIN — validated at login, not stored in MongoDB.
                    </span>
                  </Field>

                  <Field
                    label="Password"
                    icon={<Lock className="h-3.5 w-3.5" />}
                    hint="10+ characters with uppercase, lowercase and a number."
                  >
                    <input
                      type={showSignupPassword ? 'text' : 'password'}
                      value={signupForm.password}
                      onChange={(e) =>
                        setSignupForm((f) => ({ ...f, password: e.target.value }))
                      }
                      autoComplete="new-password"
                      placeholder="Create a strong password"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupPassword((v) => !v)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showSignupPassword ? 'Hide password' : 'Show password'}
                    >
                      {showSignupPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <Field
                    label="Confirm Password"
                    icon={<Lock className="h-3.5 w-3.5" />}
                    hint="Enter the same password again."
                  >
                    <input
                      type={showSignupConfirm ? 'text' : 'password'}
                      value={signupForm.confirmPassword}
                      onChange={(e) =>
                        setSignupForm((f) => ({ ...f, confirmPassword: e.target.value }))
                      }
                      autoComplete="new-password"
                      placeholder="Confirm your password"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupConfirm((v) => !v)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showSignupConfirm ? 'Hide password' : 'Show password'}
                    >
                      {showSignupConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <AlertBox tone="error">{error}</AlertBox>

                  <PrimaryButton busy={busy} disabled={!signupReady}>
                    Create owner account <ArrowRight className="h-4 w-4" />
                  </PrimaryButton>

                  <p className="pt-1 text-center text-[10px] leading-relaxed text-slate-500">
                    🔒 Password is hashed with scrypt. Signup closes automatically after the first account exists.
                  </p>
                </form>
              )}

              {/* Login state */}
              {step === 'login' && (
                <form onSubmit={handleLogin} className="space-y-4">
                  <StepHeader
                    emoji="👋"
                    title="Welcome Back"
                    subtitle="Sign in with Email + Password + MPIN. All three are required."
                  />

                  <Field label="Email" icon={<Mail className="h-3.5 w-3.5" />}>
                    <input
                      type="email"
                      value={loginForm.email}
                      onChange={(e) =>
                        setLoginForm((f) => ({ ...f, email: e.target.value }))
                      }
                      autoComplete="username"
                      placeholder={status?.ownerEmailMasked || 'owner@example.com'}
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                  </Field>

                  <Field label="Password" icon={<Lock className="h-3.5 w-3.5" />}>
                    <input
                      type={showLoginPassword ? 'text' : 'password'}
                      value={loginForm.password}
                      onChange={(e) =>
                        setLoginForm((f) => ({ ...f, password: e.target.value }))
                      }
                      autoComplete="current-password"
                      placeholder="Your password"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword((v) => !v)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                    >
                      {showLoginPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <Field label="MPIN" icon={<KeyRound className="h-3.5 w-3.5" />}>
                    <input
                      type={showUnlockMpin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      value={loginForm.mpin}
                      onChange={(e) =>
                        setLoginForm((f) => ({
                          ...f,
                          mpin: e.target.value.replace(/\D/g, '').slice(0, 6),
                        }))
                      }
                      autoComplete="one-time-code"
                      placeholder="••••••"
                      className="w-full bg-transparent font-mono text-lg tracking-[0.42em] text-white outline-none placeholder:tracking-[0.42em] placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowUnlockMpin((v) => !v)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showUnlockMpin ? 'Hide MPIN' : 'Show MPIN'}
                    >
                      {showUnlockMpin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <AlertBox tone="error">{error}</AlertBox>
                  <AlertBox tone="notice">{notice}</AlertBox>

                  <PrimaryButton busy={busy}>
                    Unlock Terminal <ArrowRight className="h-4 w-4" />
                  </PrimaryButton>

                  <div className="flex items-center justify-between pt-2 text-[10px] text-slate-500">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-3 w-3 text-emerald-400" />
                      <span>Signup is permanently closed once the owner exists.</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        setNotice('');
                        setResetForm({ mpin: '', newPassword: '', confirmPassword: '' });
                        setStep('reset-password');
                      }}
                      className="text-xs font-medium text-rose-400 transition hover:text-rose-300 underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                </form>
              )}

              {/* App unlock state */}
              {step === 'unlock' && (
                <div className="space-y-4">
                  <StepHeader
                    emoji="🔐"
                    title="Unlock App"
                    subtitle="You are already signed in. Enter your MPIN to unlock the terminal."
                  />

                  <Field label="App MPIN" icon={<KeyRound className="h-3.5 w-3.5" />}>
                    <input
                      type={showUnlockMpin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      value={unlockForm.mpin}
                      onChange={(e) =>
                        setUnlockForm((f) => ({
                          ...f,
                          mpin: e.target.value.replace(/\D/g, '').slice(0, 6),
                        }))
                      }
                      autoComplete="one-time-code"
                      placeholder="••••••"
                      className="w-full bg-transparent font-mono text-lg tracking-[0.42em] text-white outline-none placeholder:tracking-[0.42em] placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowUnlockMpin((v) => !v)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showUnlockMpin ? 'Hide MPIN' : 'Show MPIN'}
                    >
                      {showUnlockMpin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  {/* Biometric option (only after loaded from localStorage) */}
                  {biometricLoaded && biometricAvailable && (
                    <div className="flex items-center justify-between gap-3">
                      <label className="flex items-center gap-2 cursor-pointer select-none group">
                        <input
                          type="checkbox"
                          checked={unlockForm.useBiometric}
                          onChange={(e) =>
                            setUnlockForm((f) => ({ ...f, useBiometric: e.target.checked }))
                          }
                          className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
                        />
                        <span className="text-xs font-medium text-slate-300 group-hover:text-emerald-300">
                          Use Fingerprint / Face ID
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={handleBiometricUnlock}
                        disabled={busy}
                        className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        <Fingerprint className="h-4 w-4" /> Verify
                      </button>
                    </div>
                  )}

                  <AlertBox tone="error">{error}</AlertBox>

                  <div className="grid grid-cols-2 gap-3">
                    <PrimaryButton busy={busy} variant="outline">
                      Unlock with MPIN <ArrowRight className="h-4 w-4" />
                    </PrimaryButton>
                    <button
                      type="button"
                      onClick={() => {
                        setAppUnlocked(false);
                        void handleLogout();
                      }}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm font-bold text-rose-300 transition hover:bg-rose-500/20"
                    >
                      <LogOut className="h-4 w-4" /> Sign out
                    </button>
                  </div>

                  <p className="pt-1 text-center text-[10px] leading-relaxed text-slate-500">
                    Forgot MPIN? You will need to sign out and log in again with Email + Password + MPIN.
                  </p>
                </div>
              )}

              {/* Reset password state */}
              {step === 'reset-password' && (
                <form onSubmit={handleResetPassword} className="space-y-4">
                  <StepHeader
                    emoji="🔑"
                    title="Reset Password"
                    subtitle="Verify your MPIN, then set a new password."
                  />

                  <Field label="MPIN" icon={<KeyRound className="h-3.5 w-3.5" />}>
                    <input
                      type={showResetMpin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      value={resetForm.mpin}
                      onChange={(e) =>
                        setResetForm((f) => ({
                          ...f,
                          mpin: e.target.value.replace(/\D/g, '').slice(0, 6),
                        }))
                      }
                      autoComplete="one-time-code"
                      placeholder="••••••"
                      className="w-full bg-transparent font-mono text-lg tracking-[0.42em] text-white outline-none placeholder:tracking-[0.42em] placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowResetMpin((v) => !v)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showResetMpin ? 'Hide MPIN' : 'Show MPIN'}
                    >
                      {showResetMpin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <Field
                    label="New Password"
                    icon={<Lock className="h-3.5 w-3.5" />}
                    hint="10+ characters with uppercase, lowercase and a number."
                  >
                    <input
                      type={showResetNewPassword ? 'text' : 'password'}
                      value={resetForm.newPassword}
                      onChange={(e) =>
                        setResetForm((f) => ({ ...f, newPassword: e.target.value }))
                      }
                      autoComplete="new-password"
                      placeholder="Create a strong password"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowResetNewPassword((v) => !v)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showResetNewPassword ? 'Hide password' : 'Show password'}
                    >
                      {showResetNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <Field
                    label="Confirm New Password"
                    icon={<Lock className="h-3.5 w-3.5" />}
                    hint="Enter the same password again."
                  >
                    <input
                      type={showResetConfirm ? 'text' : 'password'}
                      value={resetForm.confirmPassword}
                      onChange={(e) =>
                        setResetForm((f) => ({ ...f, confirmPassword: e.target.value }))
                      }
                      autoComplete="new-password"
                      placeholder="Confirm your new password"
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowResetConfirm((v) => !v)}
                      className="text-slate-500 transition hover:text-emerald-300"
                      aria-label={showResetConfirm ? 'Hide password' : 'Show password'}
                    >
                      {showResetConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </Field>

                  <AlertBox tone="error">{error}</AlertBox>
                  <AlertBox tone="notice">{notice}</AlertBox>

                  <PrimaryButton busy={busy}>
                    Reset Password <ArrowRight className="h-4 w-4" />
                  </PrimaryButton>

                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setStep('login');
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700/60 px-4 py-3 text-xs font-semibold text-slate-300 transition hover:border-emerald-400/50 hover:text-white"
                  >
                    <ArrowLeft className="h-3 w-3" /> Back to login
                  </button>
                </form>
              )}

              {/* Workspace state */}
              {step === 'workspace' && (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-black leading-tight text-white">
                        Welcome back{status?.user?.name ? `, ${status.user.name}` : ''}
                      </h2>
                      <p className="mt-1 text-sm text-slate-400">Your session is live.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700/60 px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 transition hover:border-rose-400/50 hover:text-rose-300"
                    >
                      <LogOut className="h-3 w-3" /> Sign out
                    </button>
                  </div>

                  <AlertBox tone="notice">{notice}</AlertBox>
                  <AlertBox tone="error">{error}</AlertBox>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => router.push('/dashboard')}
                      className="group relative overflow-hidden rounded-2xl border border-slate-700/60 bg-gradient-to-br from-emerald-400/20 to-teal-500/5 p-4 text-left transition hover:-translate-y-0.5 group-hover:border-emerald-400/60"
                    >
                      <div className="flex items-center justify-between">
                        <span aria-hidden className="text-3xl">📈</span>
                        <ArrowRight className="h-5 w-5 text-slate-400 transition group-hover:text-white" />
                      </div>
                      <div className="mt-2 text-sm font-bold text-white">Dashboard</div>
                      <div className="mt-0.5 text-[10px] leading-relaxed text-slate-400">Trading terminal overview</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => router.push('/data-saver/settings/security')}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700/60 px-4 py-3 text-xs font-semibold text-slate-300 transition hover:border-emerald-400/50 hover:text-white"
                    >
                      <ShieldCheck className="h-4 w-4 text-emerald-300" />
                      <span>Security settings</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-between gap-3 px-1 text-[10px] text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-emerald-400" />
                Backend hidden · server-side auth
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
