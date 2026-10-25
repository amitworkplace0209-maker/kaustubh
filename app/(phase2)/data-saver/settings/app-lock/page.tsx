'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Fingerprint, KeyRound, Loader2, Lock, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/design-system';
import { DangerZone } from '@/components/settings/settings-ui';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { useAuth } from '@/components/auth-provider';
import { useToast } from '@/hooks/use-toast';

type MpinMode = 'idle' | 'setup' | 'change' | 'disable';

interface LockOverview {
  ok?: boolean;
  hasMpin?: boolean;
  biometricCount?: number;
  mpinUpdatedAt?: string | null;
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

export default function AppLockPage() {
  return <SettingsSectionBody sectionId="app-lock" extra={<AppLockManager />} />;
}

function AppLockManager() {
  const { toast } = useToast();
  const { refresh } = useAuth();
  const [overview, setOverview] = useState<LockOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<MpinMode>('idle');
  const [pin, setPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { status, data } = await api('/api/auth/overview');
      if (status >= 400 || !data.ok) {
        setError(String(data.message ?? 'Could not load the app-lock status.'));
        return;
      }
      setOverview(data as LockOverview);
    } catch {
      setError('Could not reach the auth service.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setMode('idle');
    setPin('');
    setCurrentPin('');
    setConfirm('');
    setError('');
  };

  async function run() {
    setError('');
    if ((mode === 'setup' || mode === 'change') && !/^\d{6}$/.test(pin)) {
      setError('The MPIN must be exactly 6 digits.');
      return;
    }
    if (mode === 'setup' && pin !== confirm) {
      setError('The two MPIN entries do not match.');
      return;
    }
    if (mode === 'change' && !/^\d{6}$/.test(currentPin)) {
      setError('Enter your current 6-digit MPIN.');
      return;
    }
    if (mode === 'change' && pin !== confirm) {
      setError('The two new MPIN entries do not match.');
      return;
    }
    if (mode === 'disable' && !/^\d{6}$/.test(currentPin)) {
      setError('Enter your current 6-digit MPIN.');
      return;
    }
    if (mode === 'disable' && Number(overview?.biometricCount ?? 0) === 0) {
      setError('Register a fingerprint / face credential first — removing both would lock you out.');
      return;
    }

    setBusy(true);
    try {
      const path =
        mode === 'setup'
          ? '/api/auth/mpin/setup'
          : mode === 'change'
            ? '/api/auth/mpin/change'
            : '/api/auth/mpin/disable';
      const body =
        mode === 'setup'
          ? { mpin: pin, confirm }
          : mode === 'change'
            ? { currentMpin: currentPin, newMpin: pin, confirm }
            : { mpin: currentPin };
      const { data } = await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (!data.ok) {
        setError(String(data.message ?? 'The auth service rejected the request.'));
        return;
      }
      toast({
        title: mode === 'setup' ? 'MPIN enabled' : mode === 'change' ? 'MPIN updated' : 'MPIN removed',
        description: String(data.message ?? ''),
      });
      reset();
      await Promise.all([load(), refresh()]);
    } catch {
      setError('Could not reach the auth service.');
    } finally {
      setBusy(false);
    }
  }

  const hasMpin = Boolean(overview?.hasMpin);
  const biometricCount = Number(overview?.biometricCount ?? 0);

  return (
    <section className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Lock className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-medium">App Lock</p>
            <p className="text-[11px] text-muted-foreground">
              {loading
                ? 'Checking…'
                : hasMpin
                  ? biometricCount > 0
                    ? `6-digit MPIN + ${biometricCount} biometric credential${biometricCount === 1 ? '' : 's'}`
                    : 'Protected by a 6-digit MPIN'
                  : biometricCount > 0
                    ? 'Protected by fingerprint / face only'
                    : 'No unlock method configured'}
            </p>
          </div>
        </div>
        <StatusBadge status={hasMpin || biometricCount > 0 ? 'success' : 'warning'} label={hasMpin ? 'MPIN active' : biometricCount > 0 ? 'Biometric only' : 'Not set'} />
      </div>

      {!hasMpin && biometricCount === 0 ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Set an MPIN or register a biometric credential from the Biometric page. One of them is required.</span>
        </div>
      ) : null}

      {mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          {!hasMpin ? (
            <Button
              size="sm"
              onClick={() => {
                setMode('setup');
                setPin('');
                setCurrentPin('');
                setConfirm('');
              }}
            >
              <KeyRound className="h-3.5 w-3.5" /> Set MPIN
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setMode('change');
                  setPin('');
                  setCurrentPin('');
                  setConfirm('');
                }}
              >
                Change MPIN
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={biometricCount === 0}
                title={biometricCount === 0 ? 'Register a biometric credential first.' : undefined}
                onClick={() => {
                  setMode('disable');
                  setCurrentPin('');
                }}
              >
                Remove MPIN
              </Button>
            </>
          )}
          <Link
            href="/data-saver/settings/biometric"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            <Fingerprint className="h-3.5 w-3.5" /> Manage biometric
          </Link>
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
          <p className="flex items-center gap-2 text-xs font-medium">
            <Shield className="h-3.5 w-3.5" />
            {mode === 'setup' && '🔢 Create a 6-digit MPIN'}
            {mode === 'change' && '🔁 Change your MPIN'}
            {mode === 'disable' && '🗑️ Remove the MPIN (fingerprint / face stays active)'}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {mode !== 'setup' ? (
              <Input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="Current MPIN"
                value={currentPin}
                onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                className="h-9 w-44 font-mono"
              />
            ) : null}
            {mode !== 'disable' ? (
              <>
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="New MPIN"
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="h-9 w-44 font-mono"
                />
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Confirm MPIN"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="h-9 w-44 font-mono"
                />
              </>
            ) : null}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void run()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {mode === 'setup' ? 'Enable MPIN' : mode === 'change' ? 'Update MPIN' : 'Remove MPIN'}
            </Button>
          </div>
        </div>
      )}

      {error && mode === 'idle' ? <p className="text-xs text-destructive">{error}</p> : null}

      <DangerZone title="How App Lock works">
        <p className="text-xs leading-relaxed text-muted-foreground">
          The MPIN is hashed with scrypt and verified server-side against MongoDB. It is never stored in the browser
          bundle or exported with settings. MPIN and biometric are alternatives: remove the MPIN only after registering
          a fingerprint / face credential.
        </p>
      </DangerZone>
    </section>
  );
}
