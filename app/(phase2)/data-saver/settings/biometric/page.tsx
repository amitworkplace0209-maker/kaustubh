'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Fingerprint,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/design-system';
import { DangerZone } from '@/components/settings/settings-ui';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { useAuth } from '@/components/auth-provider';
import { describeThisDevice } from '@/lib/device-id';
import { useToast } from '@/hooks/use-toast';

interface CredentialSummary {
  id: string;
  deviceLabel: string;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

interface Overview {
  ok?: boolean;
  hasMpin?: boolean;
  biometricCount?: number;
  credentials?: CredentialSummary[];
  message?: string;
}

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

export default function BiometricPage() {
  return (
    <SettingsSectionBody
      sectionId="biometric"
      extra={<BiometricManager />}
    />
  );
}

function BiometricManager() {
  const { toast } = useToast();
  const { refresh } = useAuth();
  const [capable, setCapable] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { status, data } = await api('/api/auth/overview');
      if (status >= 400 || !data.ok) {
        setError(String(data.message ?? 'Could not load biometric settings.'));
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

  async function register() {
    setError('');
    if (capable === false) {
      setError('This device does not expose a fingerprint / face authenticator.');
      return;
    }
    setBusy(true);
    try {
      const { data: optionsData } = await api('/api/auth/biometric/register/options', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!optionsData.ok || !optionsData.options) {
        setError(String(optionsData.message ?? 'Could not start registration.'));
        return;
      }
      const response = await startRegistration({ optionsJSON: optionsData.options as never });
      const { data } = await api('/api/auth/biometric/register/verify', {
        method: 'POST',
        body: JSON.stringify({ response, deviceLabel: describeThisDevice() }),
      });
      if (!data.ok) {
        setError(String(data.message ?? 'That authenticator was rejected.'));
        return;
      }
      toast({ title: 'Biometric enabled', description: 'You can now unlock with fingerprint / face.' });
      await Promise.all([load(), refresh()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(
        /cancel|abort|notallowed/i.test(message)
          ? 'Biometric registration cancelled.'
          : message || 'Could not register this device.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(credentialId: string) {
    setError('');
    const credentials = overview?.credentials ?? [];
    if (credentials.length <= 1 && !overview?.hasMpin) {
      setError('This is your only unlock method. Set an MPIN first.');
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

  const credentials = overview?.credentials ?? [];
  const hasMpin = Boolean(overview?.hasMpin);
  const biometricCount = Number(overview?.biometricCount ?? 0);

  return (
    <section className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Fingerprint className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-medium">Device capability (live probe)</p>
            <p className="text-[11px] text-muted-foreground">
              {capable === null
                ? 'Asking the platform for a user-verifying authenticator…'
                : capable
                  ? 'WebAuthn fingerprint / face is available on this device.'
                  : 'This browser exposes no platform authenticator.'}
            </p>
          </div>
        </div>
        <StatusBadge
          status={capable === null ? 'neutral' : capable ? 'success' : 'warning'}
          label={capable === null ? 'Probing…' : capable ? 'Supported' : 'Unsupported'}
        />
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-card px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Registered credentials</p>
            <p className="text-[11px] text-muted-foreground">
              {loading ? 'Checking…' : `${biometricCount} credential${biometricCount === 1 ? '' : 's'} · ${hasMpin ? 'MPIN also active' : 'MPIN not set'}`}
            </p>
          </div>
          <StatusBadge status={biometricCount > 0 ? 'success' : 'neutral'} label={biometricCount > 0 ? 'Active' : 'None'} />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void register()} disabled={busy || capable === false}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5" />}
            Register this device
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
          {!hasMpin ? (
            <Link
              href="/data-saver/settings/app-lock"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              <KeyRound className="h-3.5 w-3.5" /> Set an MPIN too
            </Link>
          ) : null}
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
                  onClick={() => void remove(credential.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              A real WebAuthn credential is created locally by your device. Only its public key is stored in MongoDB —
              the fingerprint / face data never leaves the authenticator.
            </span>
          </div>
        )}
      </div>

      <DangerZone title="Keep a way back in">
        <p className="text-xs leading-relaxed text-muted-foreground">
          MPIN and biometric are alternatives. You cannot remove the last remaining unlock method. If you lose this
          device&apos;s biometric, use the MPIN (or set one from App lock) to regain access.
        </p>
      </DangerZone>
    </section>
  );
}
