'use client';

import { useCallback, useEffect, useState } from 'react';
import { Lock, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/design-system';
import { DangerZone } from '@/components/settings/settings-ui';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { useToast } from '@/hooks/use-toast';

type PinMode = 'none' | 'setup' | 'change' | 'disable';

export default function AppLockPage() {
  return (
    <SettingsSectionBody
      sectionId="app-lock"
      extra={<AppLockManager />}
    />
  );
}

function AppLockManager() {
  const { toast } = useToast();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<PinMode>('none');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/setup');
      const d = await res.json();
      setConfigured(Boolean(d.configured));
    } catch {
      setConfigured(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const run = async () => {
    setError('');
    if (!/^\d{6}$/.test(pin)) {
      setError('PIN must be exactly 6 digits.');
      return;
    }
    if (mode === 'setup' && pin !== confirm) {
      setError('PINs do not match.');
      return;
    }
    setBusy(true);
    try {
      let ok = false;
      let message = '';
      if (mode === 'setup') {
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: 'create-pin', pin }),
        });
        const d = await res.json();
        ok = Boolean(d.ok);
        message = d.message ?? '';
        if (ok) {
          setConfigured(true);
          toast({ title: 'App Lock enabled', description: 'The data-saver UI is now protected by a 6-digit PIN.' });
        }
      } else if (mode === 'change') {
        const res = await fetch('/api/auth/pin/change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPin: confirm || '', newPin: pin }),
        });
        const d = await res.json();
        ok = Boolean(d.ok);
        message = d.message ?? '';
        if (ok) toast({ title: 'PIN updated' });
      } else if (mode === 'disable') {
        const res = await fetch('/api/auth/pin/disable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const d = await res.json();
        ok = Boolean(d.ok);
        message = d.message ?? '';
        if (ok) {
          setConfigured(false);
          toast({ title: 'App Lock disabled' });
        }
      }
      if (!ok) setError(message || 'The backend rejected the request.');
      if (ok) setMode('none');
      setPin('');
      setConfirm('');
    } catch {
      setError('Could not reach the backend.');
    } finally {
      setBusy(false);
    }
  };

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
                : configured
                  ? 'Protected by a 6-digit PIN'
                  : 'No PIN set — lock is inactive'}
            </p>
          </div>
        </div>
        <StatusBadge status={configured ? 'success' : 'neutral'} label={configured ? 'Active' : 'Inactive'} />
      </div>

      {mode === 'none' && (
        <div className="flex flex-wrap gap-2">
          {!configured ? (
            <Button onClick={() => { setMode('setup'); setPin(''); setConfirm(''); }}>
              Set App Lock PIN
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => { setMode('change'); setPin(''); setConfirm(''); }}>
                Change PIN
              </Button>
              <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => { setMode('disable'); setPin(''); setConfirm(''); }}>
                Disable
              </Button>
            </>
          )}
        </div>
      )}

      {mode !== 'none' && (
        <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
          <p className="flex items-center gap-2 text-xs font-medium">
            <Shield className="h-3.5 w-3.5" />
            {mode === 'setup' && 'Create a new 6-digit PIN'}
            {mode === 'change' && 'Change your PIN (enter current PIN to verify)'}
            {mode === 'disable' && 'Enter your current PIN to disable'}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="password"
              inputMode="numeric"
              maxLength={6}
              placeholder={mode === 'change' ? 'New PIN ••••••' : 'PIN ••••••'}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="h-9 w-44 font-mono"
            />
            {mode === 'setup' && (
              <Input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="Confirm PIN ••••••"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="h-9 w-44 font-mono"
              />
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { setMode('none'); setError(''); }}>Cancel</Button>
            <Button onClick={run} disabled={busy || pin.length !== 6 || (mode === 'setup' && confirm.length !== 6)}>
              {busy ? 'Working…' : mode === 'setup' ? 'Enable App Lock' : mode === 'change' ? 'Update PIN' : 'Disable App Lock'}
            </Button>
          </div>
        </div>
      )}

      <DangerZone title="Caution">
        <p className="text-xs text-muted-foreground">
          App Lock PIN is stored securely by the backend and verified against
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[10px]">/api/auth</code> — it is never written into the
          exported settings bundle or the browser cache. If you forget the PIN, reset it from the backend.
        </p>
      </DangerZone>
    </section>
  );
}