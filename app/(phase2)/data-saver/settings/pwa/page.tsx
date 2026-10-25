'use client';

import { useEffect, useState } from 'react';
import { Download, RefreshCw, Smartphone, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/design-system';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { DATA_SAVER_PHASE } from '@/lib/settings/phase-config';
import { useToast } from '@/hooks/use-toast';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export default function PwaPage() {
  const { toast } = useToast();
  const [standalone, setStandalone] = useState<boolean | null>(null);
  const [swStatus, setSwStatus] = useState<'unavailable' | 'unregistered' | 'controlling' | 'ready'>('unavailable');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [updateRunning, setUpdateRunning] = useState(false);

  useEffect(() => {
    setStandalone(
      typeof window !== 'undefined' &&
        window.matchMedia('(display-mode: standalone)').matches,
    );

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration('/sw.js').then((reg) => {
        if (!reg) {
          setSwStatus('unregistered');
          return;
        }
        navigator.serviceWorker.ready.then((ready) => {
          setSwStatus(ready.active?.state === 'activated' ? 'controlling' : 'ready');
        });
      }).catch(() => setSwStatus('unavailable'));
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
    toast({ title: 'Installed', description: `${DATA_SAVER_PHASE.phaseName} is now available as an app.` });
  };

  const checkUpdate = async () => {
    setUpdateRunning(true);
    try {
      const reg = await navigator.serviceWorker?.getRegistration('/sw.js');
      await reg?.update();
      toast({ title: 'Update check complete', description: 'The service worker is up to date.' });
    } catch {
      toast({ title: 'Update check failed', variant: 'destructive' });
    } finally {
      setUpdateRunning(false);
    }
  };

  return (
    <SettingsSectionBody
      sectionId="pwa"
      heroRight={
        standalone ? (
          <StatusBadge status="success" label="Running as installed app" />
        ) : (
          <StatusBadge status="neutral" label="Running in browser" />
        )
      }
      extra={
        <div className="mt-4 space-y-4">
          <section className="rounded-xl border border-border bg-card">
            <header className="border-b border-border/60 px-4 py-3">
              <p className="text-sm font-semibold">{DATA_SAVER_PHASE.phaseName} install</p>
            </header>
            <div className="divide-y divide-border/60 px-4">
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <Smartphone className="h-4 w-4 text-amber-500" />
                  <div>
                    <p className="text-sm font-medium">Install status</p>
                    <p className="text-[11px] text-muted-foreground">
                      Manifest <code className="rounded bg-muted px-1">/manifest-data.json</code> · standalone,
                      scope <code className="rounded bg-muted px-1">/data-saver/</code>
                    </p>
                  </div>
                </div>
                <StatusBadge
                  status={standalone ? 'success' : installPrompt ? 'info' : 'neutral'}
                  label={standalone ? 'Installed' : installPrompt ? 'Ready to install' : 'Not installed'}
                />
              </div>
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <RefreshCw className="h-4 w-4 text-amber-500" />
                  <div>
                    <p className="text-sm font-medium">Service worker</p>
                    <p className="text-[11px] text-muted-foreground">Network-first for assets · live APIs never cached</p>
                  </div>
                </div>
                <StatusBadge
                  status={swStatus === 'unavailable' ? 'neutral' : 'success'}
                  label={swStatus === 'unavailable' ? 'Not supported' : swStatus === 'controlling' ? 'Controlling' : swStatus === 'ready' ? 'Ready' : 'Not registered'}
                />
              </div>
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <WifiOff className="h-4 w-4 text-amber-500" />
                  <div>
                    <p className="text-sm font-medium">Offline</p>
                    <p className="text-[11px] text-muted-foreground">Cached UI shells load offline; live market data requires the network</p>
                  </div>
                </div>
                <StatusBadge status="success" label="Cached shell" />
              </div>
            </div>
          </section>

          <div className="flex flex-wrap gap-2">
            {!standalone && installPrompt ? (
              <Button onClick={install}>
                <Download className="h-4 w-4 mr-1.5" /> Install {DATA_SAVER_PHASE.phaseShortName}
              </Button>
            ) : (
              <Button disabled onClick={install}>
                <Download className="h-4 w-4 mr-1.5" /> Install
              </Button>
            )}
            <Button variant="outline" onClick={checkUpdate} disabled={updateRunning || swStatus === 'unavailable'}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${updateRunning ? 'animate-spin' : ''}`} /> Check for update
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {DATA_SAVER_PHASE.phaseName} installs as its own app — separate name, icon and splash from the main Trading
            Platform. Registering as an installed app is required for push/OS notifications.
          </p>
        </div>
      }
      footer={null}
    />
  );
}