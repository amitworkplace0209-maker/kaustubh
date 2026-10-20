'use client';

import { useRef, useState } from 'react';
import { Download, ShieldCheck, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/design-system';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { exportSettingsBundle, importSettingsBundle, parseSettingsBundle } from '@/lib/settings/store';
import { useToast } from '@/hooks/use-toast';
import { istDateKey } from '@/lib/ist';

export default function PrivacyPage() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [lastImport, setLastImport] = useState<string | null>(null);

  const download = () => {
    const blob = new Blob([exportSettingsBundle()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kaustubh-data-saver-settings-${istDateKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Settings exported', description: 'Sensitive values are excluded from the bundle.' });
  };

  const onFile = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    const check = parseSettingsBundle(text);
    if (!check.ok) {
      setLastImport(null);
      toast({ title: 'Import rejected', description: check.error ?? 'Invalid bundle', variant: 'destructive' });
      return;
    }
    setImporting(true);
    try {
      const res = await importSettingsBundle(text);
      setLastImport(`${res.applied} applied${res.failed ? `, ${res.failed} failed` : ''}`);
      toast({
        title: res.ok ? 'Settings imported' : 'Partial import',
        description: `${res.applied} applied${res.failed ? `, ${res.failed} failed` : ''}`,
        variant: res.ok ? 'default' : 'destructive',
      });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <SettingsSectionBody
      sectionId="privacy"
      extra={
        <div className="mt-4 space-y-4">
          <section className="rounded-xl border border-border bg-card">
            <header className="border-b border-border/60 px-4 py-3">
              <p className="text-sm font-semibold">Export / import settings</p>
            </header>
            <div className="space-y-3 px-4 py-4">
              <div className="flex items-start gap-3 rounded-lg bg-success/5 px-3 py-2.5">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The bundle contains only the plain-value settings you manage here. Secrets tagged as sensitive
                  (connection URIs, PIN, biometric toggles) are excluded both on export and import.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={download}>
                  <Download className="h-4 w-4 mr-1.5" /> Export settings
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
                />
                <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={importing}>
                  <Upload className="h-4 w-4 mr-1.5" /> {importing ? 'Importing…' : 'Import settings'}
                </Button>
              </div>
              {lastImport ? (
                <div className="flex items-center gap-2 text-xs">
                  <StatusBadge status="success" label="Imported" />
                  <span className="text-muted-foreground">{lastImport}</span>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      }
    />
  );
}