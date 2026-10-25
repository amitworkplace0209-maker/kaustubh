'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  Globe2,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/design-system';
import { DangerZone } from '@/components/settings/settings-ui';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { useAuth, type AuthSessionSummary } from '@/components/auth-provider';
import { describeThisDevice } from '@/lib/device-id';
import { useToast } from '@/hooks/use-toast';

interface CredentialSummary {
  id: string;
  deviceLabel: string;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

interface EventSummary {
  id: string;
  type: string;
  ip: string;
  deviceLabel: string;
  success: boolean;
  detail: string;
  at: string;
}

interface Overview {
  ok?: boolean;
  hasMpin?: boolean;
  mpinUpdatedAt?: string | null;
  biometricCount?: number;
  credentials?: CredentialSummary[];
  deviceCount?: number;
  maxDevices?: number;
  sessions?: AuthSessionSummary[];
  events?: EventSummary[];
  message?: string;
}

type MpinMode = 'idle' | 'setup' | 'change' | 'remove';

async function api(path: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
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

function formatWhen(value: string | null | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString();
}

function eventEmoji(type: string): string {
  if (type.includes('otp')) return '📨';
  if (type.includes('biometric')) return '👆';
  if (type.includes('mpin')) return '🔢';
  if (type.includes('device')) return '📱';
  if (type.includes('logout')) return '👋';
  if (type.includes('signup')) return '🧑‍🚀';
  return '🔐';
}

export default function SecurityPage() {
  return <SettingsSectionBody sectionId="security" extra={<SecurityManager />} />;
}

function SecurityManager() {
  const { toast } = useToast();
  const { refresh } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [capable, setCapable] = useState<boolean | null>(null);

  const [mpinMode, setMpinMode] = useState<MpinMode>('idle');
  const [currentMpin, setCurrentMpin] = useState('');
  const [newMpin, setNewMpin] = useState('');
  const [confirmMpin, setConfirmMpin] = useState('');
  const [removeMpin, setRemoveMpin] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const { status, data } = await api('/api/auth/overview');
      if (status >= 400 || !data.ok) {
        setError(String(data.message ?? 'Could not load security settings.'));
        return;
      }
      setOverview(data as Overview);
    } catch {
      setError('Could not reach the auth service.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const PublicKeyCredentialCtor = window.PublicKeyCredential as
          | (typeof PublicKeyCredential & {
              isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
            })
          | undefined;
        if (!PublicKeyCredentialCtor?.isUserVerifyingPlatformAuthenticatorAvailable) {
          if (alive) setCapable(false);
          return;
        }
        const ok = await PublicKeyCredentialCtor.isUserVerifyingPlatformAuthenticatorAvailable();
        if (alive) setCapable(ok);
      } catch {
        if (alive) setCapable(false);
      }
    };
    void probe();
    return () => {
      alive = false;
    };
  }, []);

  const resetMpinForm = () => {
    setCurrentMpin('');
    setNewMpin('');
    setConfirmMpin('');
    setRemoveMpin('');
    setMpinMode('idle');
  };

  async function saveMpin() {
    setError('');
    if (mpinMode === 'setup') {
      if (!/^\d{6}$/.test(newMpin)) return setError('The MPIN must be exactly 6 digits.');
      if (newMpin !== confirmMpin) return setError('The two MPIN entries do not match.');
    }
    if (mpinMode === 'change') {
      if (!/^\d{6}$/.test(currentMpin)) return setError('Enter your current 6-digit MPIN.');
      if (!/^\d{6}$/.test(newMpin)) return setError('The new MPIN must be exactly 6 digits.');
      if (newMpin !== confirmMpin) return setError('The two new MPIN entries do not match.');
    }
    if (mpinMode === 'remove') {
      if (!/^\d{6}$/.test(removeMpin)) return setError('Enter your current 6-digit MPIN.');
      if ((overview?.biometricCount ?? 0) === 0) {
        return setError('Register a fingerprint / face credential before removing the MPIN.');
      }
    }

    setBusy(true);
    try {
      const path =
        mpinMode === 'setup'
          ? '/api/auth/mpin/setup'
          : mpinMode === 'change'
            ? '/api/auth/mpin/change'
            : '/api/auth/mpin/disable';
      const body =
        mpinMode === 'setup'
          ? { mpin: newMpin, confirm: confirmMpin }
          : mpinMode === 'change'
            ? { currentMpin, newMpin, confirm: confirmMpin }
            : { mpin: removeMpin };
      const { data } = await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (!data.ok) {
        setError(String(data.message ?? 'Could not update the MPIN.'));
        return;
      }
      toast({
        title:
          mpinMode === 'setup' ? 'MPIN enabled' : mpinMode === 'change' ? 'MPIN updated' : 'MPIN removed',
        description: String(data.message ?? ''),
      });
      resetMpinForm();
      await Promise.all([load(), refresh()]);
    } catch {
      setError('Could not reach the auth service.');
    } finally {
      setBusy(false);
    }
  }

  async function registerBiometric() {
    setError('');
    if (capable === false) {
      setError('This device does not expose a fingerprint / face authenticator.');
      return;
    }
    setBioBusy(true);
    try {
      const { data: optionsData } = await api('/api/auth/biometric/register/options', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!optionsData.ok || !optionsData.options) {
        setError(String(optionsData.message ?? 'Could not start biometric registration.'));
        return;
      }
      const response = await startRegistration({ optionsJSON: optionsData.options as never });
      const { data } = await api('/api/auth/biometric/register/verify', {
        method: 'POST',
        body: JSON.stringify({ response, deviceLabel: describeThisDevice() }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'The biometric credential was rejected.'));
        return;
      }
      toast({ title: 'Biometric unlock enabled', description: 'Fingerprint / face is now registered.' });
      await Promise.all([load(), refresh()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(
        /cancel|abort|notallowed/i.test(message)
          ? 'Biometric registration cancelled.'
          : message || 'Could not register this authenticator.',
      );
    } finally {
      setBioBusy(false);
    }
  }

  async function removeBiometric(credentialId: string) {
    setError('');
    if ((overview?.biometricCount ?? 0) <= 1 && !overview?.hasMpin) {
      setError('This is your only unlock method. Set an MPIN before removing it.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api('/api/auth/biometric/credentials', {
        method: 'DELETE',
        body: JSON.stringify({ credentialId }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'Could not remove the credential.'));
        return;
      }
      toast({ title: 'Biometric removed' });
      await Promise.all([load(), refresh()]);
    } catch {
      setError('Could not reach the auth service.');
    } finally {
      setBusy(false);
    }
  }

  async function revokeSession(sessionId: string, self: boolean) {
    setError('');
    setBusy(true);
    try {
      const { data } = await api('/api/auth/devices/revoke', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'Could not revoke the session.'));
        return;
      }
      toast({ title: 'Session revoked' });
      if (self) {
        window.location.href = '/login';
        return;
      }
      await Promise.all([load(), refresh()]);
    } catch {
      setError('Could not reach the auth service.');
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers() {
    setError('');
    setBusy(true);
    try {
      const { data } = await api('/api/auth/devices/revoke', {
        method: 'POST',
        body: JSON.stringify({ all: true }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'Could not sign the other devices out.'));
        return;
      }
      toast({ title: 'Other devices signed out' });
      await Promise.all([load(), refresh()]);
    } catch {
      setError('Could not reach the auth service.');
    } finally {
      setBusy(false);
    }
  }

  const sessions = overview?.sessions ?? [];
  const credentials = overview?.credentials ?? [];
  const events = overview?.events ?? [];
  const hasMpin = Boolean(overview?.hasMpin);
  const biometricCount = Number(overview?.biometricCount ?? 0);
  const deviceCount = Number(overview?.deviceCount ?? 0);
  const maxDevices = Number(overview?.maxDevices ?? 2);
  const devicesFull = deviceCount >= maxDevices;

  return (
    <section className="mt-4 space-y-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- MPIN */}
      <div className="rounded-xl border border-border bg-card px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-medium">MPIN</p>
              <p className="text-[11px] text-muted-foreground">
                {loading ? 'Checking…' : hasMpin ? `Active · updated ${formatWhen(overview?.mpinUpdatedAt)}` : 'Not configured'}
              </p>
            </div>
          </div>
          <StatusBadge status={hasMpin ? 'success' : 'neutral'} label={hasMpin ? 'Active' : 'Not set'} />
        </div>

        {!hasMpin ? (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            🚨 An MPIN is required unless a fingerprint / face credential is registered. Set one so you never lock
            yourself out.
          </p>
        ) : null}

        {mpinMode === 'idle' ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {!hasMpin ? (
              <Button size="sm" onClick={() => setMpinMode('setup')}>
                Set MPIN
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => setMpinMode('change')}>
                  Change MPIN
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={biometricCount === 0}
                  title={
                    biometricCount === 0
                      ? 'Register a fingerprint / face first — removing both would lock you out.'
                      : undefined
                  }
                  onClick={() => setMpinMode('remove')}
                >
                  Remove MPIN
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="mt-3 space-y-2 rounded-lg border border-border bg-background/40 px-3 py-3">
            <p className="text-xs font-medium">
              {mpinMode === 'setup' && '🔢 Choose a 6-digit MPIN'}
              {mpinMode === 'change' && '🔁 Change your MPIN'}
              {mpinMode === 'remove' && '🗑️ Remove the MPIN (biometric stays active)'}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              {mpinMode !== 'setup' ? (
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={mpinMode === 'remove' ? 'Current MPIN' : 'Current MPIN'}
                  value={mpinMode === 'remove' ? removeMpin : currentMpin}
                  onChange={(event) => {
                    const value = event.target.value.replace(/\D/g, '').slice(0, 6);
                    if (mpinMode === 'remove') setRemoveMpin(value);
                    else setCurrentMpin(value);
                  }}
                  className="h-9 w-40 font-mono"
                />
              ) : null}
              {mpinMode !== 'remove' ? (
                <>
                  <Input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="New MPIN"
                    value={newMpin}
                    onChange={(event) => setNewMpin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="h-9 w-40 font-mono"
                  />
                  <Input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="Confirm MPIN"
                    value={confirmMpin}
                    onChange={(event) => setConfirmMpin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="h-9 w-40 font-mono"
                  />
                </>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={resetMpinForm} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void saveMpin()} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {mpinMode === 'setup' ? 'Enable MPIN' : mpinMode === 'change' ? 'Update MPIN' : 'Remove MPIN'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------- Biometric */}
      <div className="rounded-xl border border-border bg-card px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Fingerprint className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-medium">Fingerprint / face</p>
              <p className="text-[11px] text-muted-foreground">
                {capable === null
                  ? 'Probing this device…'
                  : capable
                    ? `${biometricCount} credential${biometricCount === 1 ? '' : 's'} registered`
                    : 'No platform authenticator on this browser'}
              </p>
            </div>
          </div>
          <StatusBadge
            status={biometricCount > 0 ? 'success' : capable ? 'neutral' : 'warning'}
            label={biometricCount > 0 ? 'Active' : capable ? 'Available' : 'Unsupported'}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void registerBiometric()} disabled={bioBusy || busy || capable === false}>
            {bioBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5" />}
            Register this device
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy || bioBusy}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>

        {credentials.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {credentials.map((credential) => (
              <li
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{credential.deviceLabel || 'Authenticator'}</p>
                  <p className="text-[10px] text-muted-foreground">
                    Added {formatWhen(credential.createdAt)} · last used {formatWhen(credential.lastUsedAt)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => void removeBiometric(credential.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            👆 Biometric is a real WebAuthn credential — it stays on this device and is never sent to the server.
            {capable === false
              ? ' Use a device with a fingerprint reader or face unlock, or keep using the MPIN.'
              : ' Register it once, then unlock the app without typing the MPIN.'}
          </p>
        )}

        {biometricCount === 0 && !hasMpin ? (
          <p className="mt-2 text-[11px] text-destructive">
            Keep at least one unlock method — set an MPIN or register a biometric credential.
          </p>
        ) : null}
      </div>

      {/* -------------------------------------------------------- Devices */}
      <div className="rounded-xl border border-border bg-card px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Smartphone className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-medium">Active devices</p>
              <p className="text-[11px] text-muted-foreground">
                {deviceCount} of {maxDevices} slots in use · the real login IP is stored per device
              </p>
            </div>
          </div>
          <StatusBadge status={devicesFull ? 'warning' : 'success'} label={`${deviceCount} / ${maxDevices}`} />
        </div>

        <ul className="mt-3 space-y-2">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background/40 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                  {/Android|iOS|iPhone|iPad/.test(session.deviceLabel) ? (
                    <Smartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Laptop className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  {session.deviceLabel || 'Unknown device'}
                  {session.current ? (
                    <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">
                      this device
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 font-mono">
                    <Globe2 className="h-3 w-3" /> {session.ip}
                  </span>
                  <span>{session.kind === 'primary' ? 'Primary' : 'Second device'}</span>
                  <span>signed in {formatWhen(session.createdAt)}</span>
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => void revokeSession(session.id, session.current)}
              >
                <LogOut className="h-3.5 w-3.5" /> {session.current ? 'Sign out' : 'Revoke'}
              </Button>
            </li>
          ))}
          {!loading && sessions.length === 0 ? (
            <li className="rounded-lg border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
              No live sessions — this page would not be reachable without one.
            </li>
          ) : null}
        </ul>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy || sessions.length <= 1} onClick={() => void revokeOthers()}>
            <UserCheck className="h-3.5 w-3.5" /> Sign out all other devices
          </Button>
          {devicesFull ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3" /> A third device is blocked until one is signed out.
            </span>
          ) : null}
        </div>
      </div>

      {/* ----------------------------------------------------- IP history */}
      <div className="rounded-xl border border-border bg-card px-4 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-medium">Login &amp; IP history</p>
            <p className="text-[11px] text-muted-foreground">Every signup, login and security action is recorded.</p>
          </div>
        </div>
        <ul className="mt-3 divide-y divide-border/60">
          {events.map((event) => (
            <li key={event.id || `${event.type}-${event.at}`} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <span aria-hidden>{eventEmoji(event.type)}</span>
                  <span className="truncate">{event.type.replace(/_/g, ' ')}</span>
                  {event.success ? (
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
                  )}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {event.detail || '—'} · {event.deviceLabel || 'Unknown device'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono text-[10px] text-muted-foreground">{event.ip}</p>
                <p className="text-[10px] text-muted-foreground">{formatWhen(event.at)}</p>
              </div>
            </li>
          ))}
          {!loading && events.length === 0 ? (
            <li className="py-2 text-xs text-muted-foreground">No events recorded yet.</li>
          ) : null}
        </ul>
      </div>

      <DangerZone title="How the lock works">
        <div className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          <p className="flex items-start gap-2">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            MongoDB is the source of truth. Password and MPIN are hashed with scrypt; the session cookie is
            HMAC-signed and backed by a database record that can be revoked instantly.
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Only one owner account can exist. Signup disappears permanently once it is created, and a second
            device always needs a fresh email code.
          </p>
        </div>
      </DangerZone>
    </section>
  );
}
