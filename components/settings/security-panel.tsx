'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Fingerprint,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Unlock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { getModeLockStatus, securityCall, type ModeLockStatus } from '@/lib/terminal-service';
import { Callout, FieldRow, Panel, Pill, SectionIntro, ToggleRow } from './settings-primitives';

type PinDialog =
  | 'app-setup'
  | 'app-change'
  | 'app-disable'
  | 'mode-set'
  | 'mode-change'
  | 'mode-disable'
  | null;

const isModeDialog = (dialog: PinDialog) => dialog?.startsWith('mode-') ?? false;
const isDisableDialog = (dialog: PinDialog) => dialog?.endsWith('-disable') ?? false;

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export function SecurityPanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [appLocked, setAppLocked] = useState(false);
  const [modeLock, setModeLock] = useState<ModeLockStatus | null>(null);
  const [modeLockBusy, setModeLockBusy] = useState(false);
  const [dialog, setDialog] = useState<PinDialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      fetch('/api/auth/setup', { cache: 'no-store' }).then(readJson),
      getModeLockStatus(),
    ]);
    if (results[0].status === 'fulfilled') setAppLocked(Boolean(results[0].value.configured));
    if (results[1].status === 'fulfilled') setModeLock(results[1].value);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setCurrentPin('');
    setNewPin('');
    setConfirmPin('');
    setError('');
  };

  const openDialog = (next: PinDialog) => {
    resetForm();
    setDialog(next);
  };

  const submitPin = async () => {
    setError('');
    if (!/^\d{6}$/.test(newPin)) {
      setError('PIN must be exactly 6 digits');
      return;
    }
    if (newPin !== confirmPin) {
      setError('PINs do not match');
      return;
    }
    if (dialog === 'app-change' && currentPin === newPin) {
      setError('New PIN must be different from the current PIN');
      return;
    }
    setBusy(true);
    try {
      if (dialog === 'app-setup') {
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: 'create-pin', pin: newPin }),
        });
        const data = await readJson(res);
        if (!res.ok || !data.ok) throw new Error(data.message || 'Failed to enable App Lock');
        setAppLocked(true);
        toast({ title: 'App Lock enabled', description: 'Your next login will ask for this PIN.' });
      } else {
        const res = await fetch('/api/auth/pin/change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPin, newPin }),
        });
        const data = await readJson(res);
        if (!res.ok || !data.ok) throw new Error(data.message || 'Failed to change PIN');
        toast({ title: 'PIN updated' });
      }
      setDialog(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const disableAppPin = async () => {
    setError('');
    if (!/^\d{6}$/.test(currentPin)) {
      setError('Enter your 6-digit PIN');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/pin/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: currentPin }),
      });
      const data = await readJson(res);
      if (!res.ok || !data.ok) throw new Error(data.message || 'Failed to disable App Lock');
      setAppLocked(false);
      toast({ title: 'App Lock disabled' });
      setDialog(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const submitModePin = async () => {
    setError('');
    if (!/^\d{6}$/.test(newPin)) {
      setError('PIN must be exactly 6 digits');
      return;
    }
    if (newPin !== confirmPin) {
      setError('PINs do not match');
      return;
    }
    setBusy(true);
    try {
      const configured = Boolean(modeLock?.configured);
      const data = await securityCall('/pin', dialog === 'mode-set' || !configured
        ? { action: 'set', pin: newPin }
        : { action: 'change', currentPin, newPin });
      if (data?.ok === false) throw new Error(data.error || data.message || 'Mode Lock PIN update failed');
      toast({ title: dialog === 'mode-set' ? 'Mode Lock PIN created' : 'Mode Lock PIN updated' });
      setDialog(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleModeLock = async (enabled: boolean) => {
    setModeLockBusy(true);
    try {
      const data = await securityCall('/lock', { enabled });
      if (data?.ok === false) throw new Error(data.error || data.message || 'Mode Lock update failed');
      setModeLock((prev) => (prev ? { ...prev, lockEnabled: enabled } : prev));
      toast({ title: enabled ? 'Mode Lock enabled' : 'Mode Lock disabled' });
    } catch (err) {
      toast({
        title: 'Mode Lock update failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setModeLockBusy(false);
    }
  };

  const disableModePin = async () => {
    setError('');
    if (!/^\d{6}$/.test(currentPin)) {
      setError('Enter your 6-digit Mode Lock PIN');
      return;
    }
    setBusy(true);
    try {
      const data = await securityCall('/pin', { action: 'disable', pin: currentPin });
      if (data?.ok === false) throw new Error(data.error || data.message || 'Could not disable Mode Lock PIN');
      toast({ title: 'Mode Lock PIN removed' });
      setDialog(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const lockNow = async () => {
    try {
      await fetch('/api/auth/login', { method: 'DELETE' });
    } catch {
      /* ignore */
    }
    window.location.href = '/login';
  };

  const modePinConfigured = Boolean(modeLock?.configured);
  const methods = Array.isArray(modeLock?.methods) ? modeLock!.methods : [];

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Access control"
        title="Security"
        description="Protect the app session and the per-browser terminal mode switch. Credentials never leave the backend in plain text."
        actions={
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={lockNow}>
            <LogOut className="h-3.5 w-3.5" /> Lock now
          </Button>
        }
      />

      {loading ? (
        <Panel>
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading security state…
          </div>
        </Panel>
      ) : (
        <>
          <Panel
            title="App Lock"
            description="A 6-digit PIN is required before the terminal unlocks after a browser restart."
            icon={Lock}
            actions={
              <Pill tone={appLocked ? 'success' : 'neutral'} dot>
                {appLocked ? 'Active' : 'Inactive'}
              </Pill>
            }
          >
            <FieldRow
              label="PIN protection"
              description={
                appLocked
                  ? 'This browser session is protected by an App Lock PIN.'
                  : 'No PIN is configured — the terminal opens without a prompt.'
              }
            >
              {appLocked ? (
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => openDialog('app-change')}>
                    <KeyRound className="mr-1 h-3.5 w-3.5" /> Change PIN
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs text-destructive hover:text-destructive"
                    onClick={() => openDialog('app-disable')}
                  >
                    Disable
                  </Button>
                </div>
              ) : (
                <Button size="sm" className="h-8 text-xs" onClick={() => openDialog('app-setup')}>
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Enable App Lock
                </Button>
              )}
            </FieldRow>
            <div className="border-t border-border/40 pt-3">
              <Callout tone={appLocked ? 'success' : 'warning'} title={appLocked ? 'Session protected' : 'Session unprotected'}>
                {appLocked
                  ? 'Forgot the PIN? Reset it from the login screen using the recovery flow.'
                  : 'Enable App Lock before using the terminal on a shared device.'}
              </Callout>
            </div>
          </Panel>

          <Panel
            title="Mode Lock"
            description="Require a PIN or biometric check before switching between Dummy, Kotak Neo and Shoonya."
            icon={Fingerprint}
            actions={
              <Pill tone={modeLock?.lockEnabled ? 'success' : 'neutral'} dot>
                {modeLock?.lockEnabled ? 'Enforced' : 'Off'}
              </Pill>
            }
          >
            <ToggleRow
              label="Require unlock on mode switch"
              description="A short-lived unlock token is issued for this browser only; the operator session is never reused."
              checked={Boolean(modeLock?.lockEnabled)}
              onChange={toggleModeLock}
              disabled={modeLockBusy || (!modePinConfigured && !modeLock?.webauthnRegistered)}
            />

            <div className="border-t border-border/40 pt-2.5">
              <FieldRow
                label="Mode Lock PIN"
                description={
                  modePinConfigured
                    ? 'A PIN is configured for this terminal.'
                    : 'Create a PIN to enable Mode Lock.'
                }
              >
                <div className="flex items-center gap-1.5">
                  <Pill tone={modePinConfigured ? 'success' : 'neutral'} dot>
                    {modePinConfigured ? 'Configured' : 'Not set'}
                  </Pill>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => openDialog(modePinConfigured ? 'mode-change' : 'mode-set')}
                  >
                    {modePinConfigured ? 'Change' : 'Create'}
                  </Button>
                  {modePinConfigured && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs text-destructive hover:text-destructive"
                      onClick={() => openDialog('mode-disable')}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </FieldRow>
              <FieldRow
                label="Biometric unlock"
                description="Platform authenticator registered for quick mode switches."
              >
                <Pill tone={modeLock?.webauthnRegistered ? 'info' : 'neutral'} dot>
                  <Fingerprint className="h-3 w-3" />
                  {modeLock?.webauthnRegistered ? 'Registered' : 'Not registered'}
                </Pill>
              </FieldRow>
              <FieldRow label="Unlock methods" description="Methods the mode switcher will accept.">
                <div className="flex flex-wrap items-center gap-1">
                  {methods.length === 0 && <Pill tone="neutral">None</Pill>}
                  {methods.map((method) => (
                    <Pill key={method} tone="info">
                      {method}
                    </Pill>
                  ))}
                </div>
              </FieldRow>
            </div>
          </Panel>

          <div className="grid gap-3 sm:grid-cols-2">
            <Callout tone="info" icon={Smartphone} title="Shared device?">
              Lock the terminal when you step away. The lock screen never exposes account or order data.
            </Callout>
            <Callout tone="neutral" icon={Unlock} title="Recovery">
              If a mode PIN is lost, an operator with backend access can clear the Mode Lock configuration
              from the terminal security settings — this requires re-authentication.
            </Callout>
          </div>
        </>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {isDisableDialog(dialog) ? <ShieldOff className="h-4 w-4 text-destructive" /> : <Lock className="h-4 w-4" />}
              {dialog === 'app-setup' && 'Enable App Lock'}
              {dialog === 'app-change' && 'Change App Lock PIN'}
              {dialog === 'app-disable' && 'Disable App Lock'}
              {dialog === 'mode-set' && 'Create Mode Lock PIN'}
              {dialog === 'mode-change' && 'Change Mode Lock PIN'}
              {dialog === 'mode-disable' && 'Remove Mode Lock PIN'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {isDisableDialog(dialog)
                ? 'Enter the current PIN to remove protection. You can set it up again at any time.'
                : 'Use a 6-digit PIN you can remember. It is hashed on the backend and never stored in the browser.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {(dialog === 'app-change' || dialog === 'app-disable' || dialog === 'mode-change' || dialog === 'mode-disable') && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Current PIN</Label>
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="current-password"
                  value={currentPin}
                  onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="h-9 font-mono tracking-[0.35em]"
                />
              </div>
            )}
            {!isDisableDialog(dialog) && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">New PIN</Label>
                  <Input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="new-password"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="••••••"
                    className="h-9 font-mono tracking-[0.35em]"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Confirm PIN</Label>
                  <Input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="new-password"
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="••••••"
                    className="h-9 font-mono tracking-[0.35em]"
                  />
                </div>
              </>
            )}
            {error && <p className="text-[11px] font-medium text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={isDisableDialog(dialog) ? 'destructive' : 'default'}
              onClick={() => {
                if (dialog === 'app-disable') void disableAppPin();
                else if (dialog === 'mode-disable') void disableModePin();
                else if (isModeDialog(dialog)) void submitModePin();
                else void submitPin();
              }}
              disabled={busy}
            >
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {isDisableDialog(dialog) ? 'Remove PIN' : dialog === 'app-setup' ? 'Enable' : 'Save PIN'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
