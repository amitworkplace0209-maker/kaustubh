'use client';

import { useEffect, useState } from 'react';
import { Database, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DangerZone } from '@/components/settings/settings-ui';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { clearLocalSettingsCache, useSettings } from '@/lib/settings/store';
import { useToast } from '@/hooks/use-toast';

export default function StoragePage() {
  const { settings } = useSettings();
  const { toast } = useToast();
  const [cacheEntries, setCacheEntries] = useState<number>(0);

  useEffect(() => {
    let count = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('kaustubh-') || k.startsWith('kaustubh.theme') || k.startsWith('ds-'))) count += 1;
    }
    setCacheEntries(count);
  }, []);

  const purgeCache = () => {
    clearLocalSettingsCache();
    setCacheEntries(0);
    toast({ title: 'Local cache purged', description: 'Settings caches were cleared — the store re-syncs from the backend on demand.' });
  };

  const rows: { label: string; value: string; hint?: string }[] = [
    { label: 'Database name', value: String(settings.mongodb_database ?? 'kaustubh'), hint: 'MongoDB database' },
    { label: 'Tick collection', value: String(settings.mongodb_collection ?? 'ticks'), hint: 'Collection holding ticks' },
    {
      label: 'Tick data retention',
      value: String(settings.ds_data_retention_days ?? '—'),
      hint: 'days · settings controlled',
    },
    {
      label: 'WS history retention',
      value: String(settings.ws_history_retention_days ?? '—'),
      hint: 'days',
    },
    { label: 'Buffer capacity', value: String(settings.buffer_size ?? '—'), hint: 'ticks in memory' },
  ];

  return (
    <SettingsSectionBody
      sectionId="storage"
      extra={
        <div className="mt-4 space-y-4">
          <section className="rounded-xl border border-border bg-card">
            <header className="border-b border-border/60 px-4 py-3">
              <p className="text-sm font-semibold">Backend footprint</p>
            </header>
            <div className="divide-y divide-border/60 px-4">
              {rows.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-amber-500" />
                    <div>
                      <p className="text-sm font-medium">{r.label}</p>
                      {r.hint ? <p className="text-[11px] text-muted-foreground">{r.hint}</p> : null}
                    </div>
                  </div>
                  <code className="rounded bg-muted px-2 py-1 font-mono text-[11px]">{r.value}</code>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card">
            <header className="border-b border-border/60 px-4 py-3">
              <p className="text-sm font-semibold">Browser caches</p>
            </header>
            <div className="divide-y divide-border/60 px-4">
              <div className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">Local settings cache</p>
                  <p className="text-[11px] text-muted-foreground">
                    Versioned mirror of backend settings — used only for instant first paint, re-validated against the backend.
                  </p>
                </div>
                <code className="rounded bg-muted px-2 py-1 font-mono text-[11px]">{cacheEntries} entries</code>
              </div>
            </div>
          </section>

          <DangerZone title="Local cache">
            <p className="text-xs text-muted-foreground">
              Purging removes the local mirror and re-fetches from the backend on the next visit. It never touches
              MongoDB or your saved settings.
            </p>
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={purgeCache}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Purge local settings cache
            </Button>
          </DangerZone>
        </div>
      }
    />
  );
}