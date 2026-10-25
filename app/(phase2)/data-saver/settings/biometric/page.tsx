'use client';

import { useEffect, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { StatusBadge } from '@/components/design-system';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';

/**
 * Biometric unlock — the "Platform biometric available" row reflects the value
 * the backend recorded; this live check asks the device right now.
 */
export default function BiometricPage() {
  const [capable, setCapable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        if (
          typeof window === 'undefined' ||
          !window.PublicKeyCredential ||
          typeof (window.PublicKeyCredential as unknown as { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> })
            .isUserVerifyingPlatformAuthenticatorAvailable !== 'function'
        ) {
          if (alive) setCapable(false);
          return;
        }
        const ok = await (window.PublicKeyCredential as unknown as {
          isUserVerifyingPlatformAuthenticatorAvailable: () => Promise<boolean>;
        }).isUserVerifyingPlatformAuthenticatorAvailable();
        if (alive) setCapable(ok);
      } catch {
        if (alive) setCapable(false);
      } finally {
        if (alive) setChecking(false);
      }
    };
    void probe();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <SettingsSectionBody
      sectionId="biometric"
      heroRight={
        checking ? (
          <StatusBadge status="neutral" label="Probing…" />
        ) : capable ? (
          <StatusBadge status="success" label="Supported on this device" />
        ) : (
          <StatusBadge status="neutral" label="No platform authenticator" />
        )
      }
      extra={
        <section className="mt-4 space-y-2 rounded-xl border border-border bg-card px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Fingerprint className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">Device capability (live probe)</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {checking
                  ? 'Asking the platform for a user-verifying authenticator…'
                  : capable
                    ? 'Fingerprint / face unlock is available. Flip “Biometric unlock” above to enable it — WebAuthn handles the actual verification.'
                    : 'This device does not expose a user-verifying platform authenticator (WebAuthn), so biometric unlock cannot be offered here.'}
              </p>
            </div>
          </div>
        </section>
      }
    />
  );
}